// `ollama` — the fourth adapter: the family's native inference wire (`/api/chat` with NDJSON streaming, `done_reason`,
// `prompt_eval_count`/`eval_count`, a `tool_name` riding each tool result), which genuinely differs from the
// OpenAI-compatible layer that `openai-compatible` already serves — an adapter that just re-pointed that one would be a
// second name for the same bytes.
//
// **The native listing is a named non-goal, and the conformance suite is the reason.** §7's own case is D-100's
// sentence made executable: a model `listModels()` names with no descriptor behind it has unknowable limits, and
// `/api/tags` names models without pricing them. The first draft returned installed-but-undeclared models and the suite
// refused it — which is the suite doing its job, not a fixture bug. So `listModels()` is the declared, priced set, and
// bringing the machine's installed names into a screen is a **contract change with its own slice** (a discovery row on
// `Provider`, or a screen that reads `/api/tags` beside the descriptor store) — recorded in D-133's remainder rather
// than bolted onto one adapter here. The same holds for pull state (`/api/pull`, `/api/ps`): the `Provider` contract
// has no row for install progress, and a fifth method on one adapter is a second opinion about what the boundary is.
//
// `cancellation` is `best-effort`: aborting closes our side of the socket, and `cancel(handle)` reaches the request by
// id. `countTokens` stays absent — ollama reports usage after the fact, and an estimator dressed as a count is worse
// than §3.4's own estimation. No retry of its own (D-043's ladder is the loop's), shared `wire.ts` machinery throughout.

import { validateProviderConfig } from "./config.ts";
import {
  assertNoPrivilegedFields,
  type ConfigValidation,
  type FinishReason,
  type GenerateResult,
  type Provider,
  type ProviderConfig,
  type ProviderContext,
  type ProviderMessage,
  type ProviderRequest,
  type ProviderToolCall,
  type ProviderToolSpec,
  type StreamEvent,
  type Usage,
} from "./contract.ts";
import { type ModelDescriptor, parseDescriptor } from "./descriptor.ts";
import { ProviderError, translateProviderError } from "./errors.ts";
import type { OverrideProvenance } from "./override.ts";
import {
  asNumber,
  asString,
  createInFlightTable,
  guardFor,
  isRecord,
  refuseUndeclaredTools,
  requireDescriptor,
  retryAfterFrom,
  translateFailure,
  WIRE_DEADLINE_DEFAULTS,
  type WireDeadlines,
} from "./wire.ts";

export const OLLAMA_PROVIDER_ID = "ollama";
/** The native API root (`http://127.0.0.1:11434` for a default install); the adapter appends `/api/chat`. */
export const OLLAMA_CHAT_PATH = "/api/chat";

export interface OllamaModelSpec {
  readonly id: string;
  readonly descriptor: unknown;
}

export interface OllamaProviderOptions {
  readonly config: ProviderConfig;
  readonly models: readonly OllamaModelSpec[];
  readonly id?: string;
  readonly deadlines?: Partial<WireDeadlines>;
  readonly fetch?: typeof globalThis.fetch;
  readonly overrides?: Readonly<Record<string, OverrideProvenance>> | undefined;
}

const DONE_REASONS: Readonly<Record<string, FinishReason>> = {
  stop: "done",
  load: "done",
  unload: "done",
  length: "length",
};

function chatEndpoint(config: ProviderConfig): string {
  return `${config.baseUrl.replace(/\/+$/, "")}${OLLAMA_CHAT_PATH}`;
}

function headersFor(config: ProviderConfig, streaming: boolean): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: streaming ? "application/x-ndjson" : "application/json",
    ...(config.apiKey === undefined ? {} : { authorization: `Bearer ${config.apiKey}` }),
    ...(config.headers ?? {}),
  };
}

/** The flat contract list → the family's grammar. A tool result rides a `tool` message; the family carries the tool's
 *  name on it, resolved from the assistant turn that proposed the call id. */
function wireMessages(request: ProviderRequest): readonly Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  for (const message of request.messages) {
    if (
      message.role === "assistant" &&
      message.toolCalls !== undefined &&
      message.toolCalls.length > 0
    ) {
      messages.push({
        role: "assistant",
        content: message.content,
        tool_calls: message.toolCalls.map((call) => ({
          function: { name: call.name, arguments: call.arguments },
        })),
      });
      continue;
    }
    if (message.role === "tool") {
      if (message.toolCallId === undefined) {
        throw new ProviderError(
          "invalid-response",
          "a tool result message carries no 'toolCallId', so the call it answers cannot be found",
        );
      }
      let name: string | undefined;
      for (const candidate of request.messages) {
        for (const call of candidate.toolCalls ?? []) {
          if (call.id === message.toolCallId) name = call.name;
        }
      }
      if (name === undefined) {
        throw new ProviderError(
          "invalid-response",
          `a tool result names call '${message.toolCallId}', which no assistant turn in this request proposed — the ` +
            "family carries the tool's name on a result, and inventing one is not an option",
        );
      }
      messages.push({ role: "tool", content: message.content, tool_name: name });
      continue;
    }
    messages.push({ role: message.role, content: message.content });
  }
  return messages;
}

function wireTools(tools: readonly ProviderToolSpec[]): Record<string, unknown>[] {
  return tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

function bodyFor(
  request: ProviderRequest,
  descriptor: ModelDescriptor,
  streaming: boolean,
): Record<string, unknown> {
  return {
    model: request.modelId,
    messages: wireMessages(request),
    stream: streaming,
    ...(request.tools === undefined || request.tools.length === 0
      ? {}
      : { tools: wireTools(request.tools) }),
    options: {
      num_predict: request.maxTokens ?? descriptor.maxOutputTokens,
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    },
  };
}

function usageFrom(input: Record<string, unknown>): Usage {
  return {
    inputTokens: asNumber(input.prompt_eval_count) ?? 0,
    outputTokens: asNumber(input.eval_count) ?? 0,
  };
}

function finishFrom(value: unknown): FinishReason {
  const key = asString(value);
  if (key === undefined) return "done";
  const mapped = DONE_REASONS[key];
  if (mapped === undefined) {
    throw new ProviderError(
      "invalid-response",
      `the endpoint answered with done_reason '${key}', which is not in the family's table — a terminal state this ` +
        "adapter cannot name is one it will not guess",
      { raw: key },
    );
  }
  return mapped;
}

function callsFrom(message: Record<string, unknown>): ProviderToolCall[] {
  const raw = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const calls: ProviderToolCall[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const fn = isRecord(entry.function) ? entry.function : undefined;
    const name = asString(fn?.name);
    if (name === undefined) {
      throw new ProviderError("invalid-response", "a tool call arrived with no function name", {
        raw: JSON.stringify(entry).slice(0, 300),
      });
    }
    calls.push({
      id: `call_${calls.length + 1}`,
      name,
      arguments: isRecord(fn?.arguments) ? fn.arguments : {},
    });
  }
  return calls;
}

function completionFrom(body: unknown): GenerateResult {
  if (!isRecord(body)) {
    throw translateProviderError({ body: JSON.stringify(body)?.slice(0, 500) });
  }
  const privileged = assertNoPrivilegedFields(body);
  if (!privileged.ok) {
    throw new ProviderError(
      "invalid-response",
      `the response carried '${privileged.field}', which §3.1 forbids a provider to send`,
      { raw: privileged.field },
    );
  }
  const message = isRecord(body.message) ? body.message : {};
  const content = asString(message.content) ?? "";
  const toolCalls = callsFrom(message);
  return {
    text: content,
    usage: usageFrom(body),
    toolCalls,
    finishReason: finishFrom(body.done_reason ?? (toolCalls.length > 0 ? "stop" : undefined)),
  };
}

export function createOllamaProvider(options: OllamaProviderOptions): Provider {
  const id = options.id ?? OLLAMA_PROVIDER_ID;
  const validation = validateProviderConfig(options.config);
  if (!validation.ok) {
    throw new Error(`${id}: the configuration is unusable — ${validation.reason}`);
  }
  const descriptors: Record<string, ModelDescriptor> = {};
  for (const model of options.models) {
    if (model.id === "") throw new Error(`${id}: a model id may not be empty`);
    if (descriptors[model.id] !== undefined) {
      throw new Error(
        `${id}: '${model.id}' was declared twice, and §3.2 declares one descriptor per model`,
      );
    }
    const parsed = parseDescriptor(model.descriptor);
    if (!parsed.ok) {
      throw new Error(`${id}: '${model.id}' has an unparsable descriptor — ${parsed.reason}`);
    }
    descriptors[model.id] = parsed.descriptor;
  }
  const deadlines: WireDeadlines = { ...WIRE_DEADLINE_DEFAULTS, ...options.deadlines };
  const doFetch = options.fetch ?? globalThis.fetch;
  const flights = createInFlightTable();

  function post(
    request: ProviderRequest,
    descriptor: ModelDescriptor,
    streaming: boolean,
    entry: { readonly controller: AbortController },
  ): Promise<Response> {
    return doFetch(chatEndpoint(options.config), {
      method: "POST",
      headers: headersFor(options.config, streaming),
      body: JSON.stringify(bodyFor(request, descriptor, streaming)),
      signal: entry.controller.signal,
    });
  }

  function failure(input: {
    ctx: ProviderContext;
    guard: ReturnType<typeof guardFor>;
    error: unknown;
    adapterCancelled: boolean;
    status?: number | undefined;
    body?: string | undefined;
    retryAfterMs?: number | undefined;
    request?: ProviderRequest | undefined;
  }): ProviderError {
    return translateFailure({
      ...input,
      endpoint: chatEndpoint(options.config),
      overrides: options.overrides,
    });
  }

  return {
    id,

    describe(): Readonly<Record<string, ModelDescriptor>> {
      return descriptors;
    },

    listModels(): readonly string[] {
      return Object.keys(descriptors);
    },

    validateConfig(config: ProviderConfig): ConfigValidation {
      return validateProviderConfig(config);
    },

    async generate(request: ProviderRequest, ctx: ProviderContext): Promise<GenerateResult> {
      const descriptor = requireDescriptor(descriptors, request.modelId);
      refuseUndeclaredTools(request, descriptor);
      if (ctx.signal.aborted) {
        throw translateProviderError({ aborted: true, attempt: ctx.attempt });
      }
      const guard = guardFor(ctx, deadlines, "generate");
      const flight = flights.begin(ctx, guard);
      try {
        const response = await post(request, descriptor, false, flight.entry);
        guard.connected();
        if (!response.ok) {
          const body = await response.text();
          throw failure({
            ctx,
            guard,
            error: body,
            adapterCancelled: flight.entry.cancelledByAdapter,
            status: response.status,
            body,
            retryAfterMs: retryAfterFrom(response),
            request,
          });
        }
        const body = await response.text();
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          throw translateProviderError({ body: body.slice(0, 500), attempt: ctx.attempt });
        }
        return completionFrom(parsed);
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw failure({
          ctx,
          guard,
          error,
          adapterCancelled: flight.entry.cancelledByAdapter,
          request,
        });
      } finally {
        flight.dispose();
        guard.dispose();
      }
    },

    async *stream(request: ProviderRequest, ctx: ProviderContext): AsyncIterable<StreamEvent> {
      const descriptor = requireDescriptor(descriptors, request.modelId);
      const onTheWire = descriptor.supports.streaming === true;
      if (!onTheWire) {
        try {
          const result = await this.generate(request, ctx);
          if (ctx.signal.aborted) {
            yield { type: "cancelled" };
            return;
          }
          if (result.text !== "") yield { type: "delta", text: result.text };
          for (const call of result.toolCalls) {
            yield {
              type: "tool-call",
              id: call.id,
              name: call.name,
              arguments: { ...call.arguments },
            };
          }
          yield { type: "done", usage: result.usage, finishReason: result.finishReason };
        } catch (error) {
          yield {
            type: "error",
            error:
              error instanceof ProviderError
                ? error
                : translateProviderError({ aborted: ctx.signal.aborted, attempt: ctx.attempt }),
          };
        }
        return;
      }
      refuseUndeclaredTools(request, descriptor);
      if (ctx.signal.aborted) {
        yield { type: "cancelled" };
        return;
      }
      const guard = guardFor(ctx, deadlines, "stream");
      let sawFirstToken = false;
      let usage: Usage | undefined;
      let finishReason: FinishReason | undefined;
      let sawToolCall = false;
      const flight = flights.begin(ctx, guard);
      try {
        const response = await post(request, descriptor, true, flight.entry);
        guard.connected();
        if (!response.ok) {
          const body = await response.text();
          yield {
            type: "error",
            error: failure({
              ctx,
              guard,
              error: body,
              adapterCancelled: flight.entry.cancelledByAdapter,
              status: response.status,
              body,
              retryAfterMs: retryAfterFrom(response),
              request,
            }),
          };
          return;
        }
        if (response.body === null) {
          yield {
            type: "error",
            error: new ProviderError(
              "invalid-response",
              "the endpoint answered with no body to stream",
              {
                attempt: ctx.attempt,
              },
            ),
          };
          return;
        }
        // The family's stream is NDJSON — one JSON object per line, no `data:` prefix, the final line the one with
        // `done: true`.
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (ctx.signal.aborted || flight.entry.cancelledByAdapter || guard.signal.aborted) {
            await reader.cancel().catch(() => undefined);
            break;
          }
          buffer += decoder.decode(chunk.value, { stream: true });
          const lines = buffer.replace(/\r\n/g, "\n").split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (line.trim() === "") continue;
            let event: unknown;
            try {
              event = JSON.parse(line);
            } catch {
              yield {
                type: "error",
                error: new ProviderError(
                  "invalid-response",
                  `a stream line was not JSON: ${line.slice(0, 200)}`,
                  {
                    raw: line.slice(0, 500),
                    attempt: ctx.attempt,
                  },
                ),
              };
              return;
            }
            if (!isRecord(event)) continue;
            const privileged = assertNoPrivilegedFields(event);
            if (!privileged.ok) {
              yield {
                type: "error",
                error: new ProviderError(
                  "invalid-response",
                  `a stream line carried '${privileged.field}', which §3.1 forbids a provider to send`,
                  { raw: privileged.field, attempt: ctx.attempt },
                ),
              };
              return;
            }
            const message = isRecord(event.message) ? event.message : {};
            const fragment = asString(message.content);
            if (fragment !== undefined && fragment !== "") {
              if (!sawFirstToken) {
                sawFirstToken = true;
                guard.firstToken();
              } else guard.progress();
              yield { type: "delta", text: fragment };
            }
            for (const call of callsFrom(message)) {
              sawToolCall = true;
              if (!sawFirstToken) {
                sawFirstToken = true;
                guard.firstToken();
              } else guard.progress();
              yield {
                type: "tool-call",
                id: call.id,
                name: call.name,
                arguments: { ...call.arguments },
              };
            }
            if (event.done === true) {
              usage = usageFrom(event);
              if (event.done_reason !== undefined) finishReason = finishFrom(event.done_reason);
            }
          }
          if (ctx.signal.aborted || flight.entry.cancelledByAdapter || guard.signal.aborted) {
            await reader.cancel().catch(() => undefined);
            break;
          }
        }
        if (ctx.signal.aborted || flight.entry.cancelledByAdapter) {
          yield { type: "cancelled" };
          return;
        }
        const tripped = guard.tripped();
        if (tripped !== undefined) {
          yield {
            type: "error",
            error: translateProviderError({ deadline: tripped, attempt: ctx.attempt }),
          };
          return;
        }
        yield {
          type: "done",
          usage: usage ?? { inputTokens: 0, outputTokens: 0 },
          finishReason: finishReason ?? (sawToolCall ? "tool-calls" : "done"),
        };
      } catch (error) {
        if (ctx.signal.aborted || flight.entry.cancelledByAdapter) {
          yield { type: "cancelled" };
          return;
        }
        const tripped = guard.tripped();
        yield {
          type: "error",
          error:
            tripped !== undefined
              ? translateProviderError({ deadline: tripped, attempt: ctx.attempt })
              : error instanceof ProviderError
                ? error
                : failure({
                    ctx,
                    guard,
                    error,
                    request,
                    adapterCancelled: flight.entry.cancelledByAdapter,
                  }),
        };
      } finally {
        flight.dispose();
        guard.dispose();
      }
    },

    cancel(handle: { requestId: string }): void {
      flights.cancel(handle.requestId);
    },
  };
}
