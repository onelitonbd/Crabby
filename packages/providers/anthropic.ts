// `anthropic` — the second product adapter, and the first that exists because the family genuinely differs (D-100 named
// the reason the door stays shut until a caller appears: "anthropic's message format and tool blocks"). The Messages
// API differs in five ways that are not cosmetic, and each is a line in this file rather than a caveat:
//
//   - **`system` is a top-level field, not a message.** Hoisting it out of `messages` is the adapter's job, because the
//     contract's messages are a flat list and the family's grammar is not. Multiple system turns join with a blank
//     line — they are one instruction stream to this family.
//   - **`max_tokens` is required.** The wire refuses a request without it, and the contract makes it optional; the
//     default is the descriptor's own `maxOutputTokens`, which §3.2 makes knowable — the one number the user already
//     declared for exactly this purpose.
//   - **Tool calls are content blocks, not a side list.** An assistant turn proposing tools carries `tool_use` blocks
//     inside `content`, and the tool's *result* comes back as a `tool_result` block in a **user** turn — the family's
//     grammar, not ours, so `wireMessage` does the translation both ways.
//   - **Streaming is a sequence of typed events**, not deltas of one object: `message_start` carries the input usage,
//     `content_block_delta` the text and tool fragments, `message_delta` the stop reason, `message_stop` the end. The
//     adapter reads the `data:` frames' own `type` field, so a keep-alive or an unknown event line is skipped, not a
//     parse failure.
//   - **`stop_reason` names the finish** — `end_turn`/`stop_sequence` → `done`, `max_tokens` → `length`,
//     `tool_use` → `tool-calls`. A value outside the table is `invalid-response`, because guessing a terminal state is
//     how a truncated answer is read as a finished one.
//
// What is deliberately the same as `openai-compatible`: the static, user-declared model list with §3.2 descriptors
// (no endpoint in this family serves a descriptor, so discovery would produce the "limits are unknowable" failure the
// conformance suite exists to catch); `cancellation: best-effort`; no retry (D-043's ladder is the loop's); the shared
// deadline guard, in-flight table and failure translation (`wire.ts`); and the key on a header (`x-api-key`), never in
// a URL — G1-03's rule is not family-specific.

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

export const ANTHROPIC_PROVIDER_ID = "anthropic";
/** Appended to the configured base URL (`https://api.anthropic.com`), on the same rule as the first adapter: the base
 *  is the API root the vendor's own documentation names, and the adapter appends a path, never a version guess. */
export const ANTHROPIC_MESSAGES_PATH = "/v1/messages";
/** The header version the Messages API requires. A constant, not configuration: a wire protocol version is not a
 *  user's decision, and a second copy of it in a config file would be a second opinion about the API. */
export const ANTHROPIC_VERSION = "2023-06-01";

export interface AnthropicModelSpec {
  readonly id: string;
  readonly descriptor: unknown;
}

export interface AnthropicProviderOptions {
  readonly config: ProviderConfig;
  readonly models: readonly AnthropicModelSpec[];
  readonly id?: string;
  readonly deadlines?: Partial<WireDeadlines>;
  readonly fetch?: typeof globalThis.fetch;
  readonly overrides?: Readonly<Record<string, OverrideProvenance>> | undefined;
}

const STOP_REASONS: Readonly<Record<string, FinishReason>> = {
  end_turn: "done",
  stop_sequence: "done",
  max_tokens: "length",
  tool_use: "tool-calls",
  refusal: "content-filter",
};

function endpointFor(config: ProviderConfig): string {
  return `${config.baseUrl.replace(/\/+$/, "")}${ANTHROPIC_MESSAGES_PATH}`;
}

function headersFor(config: ProviderConfig, streaming: boolean): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: streaming ? "text/event-stream" : "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
    ...(config.apiKey === undefined ? {} : { "x-api-key": config.apiKey }),
    ...(config.headers ?? {}),
  };
}

interface Prepared {
  readonly system: string | undefined;
  readonly messages: readonly Record<string, unknown>[];
}

/** The flat contract list → the family's grammar: system hoisted, assistant tool calls as `tool_use` blocks, a tool's
 *  result as a `tool_result` block inside a **user** turn. A tool result with no call id is a contract violation and
 *  fails here, before the wire — the endpoint could never match it to anything. */
function prepare(request: ProviderRequest): Prepared {
  const systemParts: string[] = [];
  const messages: Record<string, unknown>[] = [];
  for (const message of request.messages) {
    if (message.role === "system") {
      if (message.content !== "") systemParts.push(message.content);
      continue;
    }
    if (
      message.role === "assistant" &&
      message.toolCalls !== undefined &&
      message.toolCalls.length > 0
    ) {
      const content: Record<string, unknown>[] = [];
      if (message.content !== "") content.push({ type: "text", text: message.content });
      for (const call of message.toolCalls) {
        content.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments });
      }
      messages.push({ role: "assistant", content });
      continue;
    }
    if (message.role === "tool") {
      if (message.toolCallId === undefined) {
        throw new ProviderError(
          "invalid-response",
          "a tool result message carries no 'toolCallId', so the endpoint cannot match it to the call it answers",
        );
      }
      messages.push({
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: message.toolCallId, content: message.content },
        ],
      });
      continue;
    }
    messages.push({ role: message.role, content: [{ type: "text", text: message.content }] });
  }
  return {
    system: systemParts.length === 0 ? undefined : systemParts.join("\n\n"),
    messages,
  };
}

function wireTools(tools: readonly ProviderToolSpec[]): Record<string, unknown>[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

function bodyFor(
  request: ProviderRequest,
  descriptor: ModelDescriptor,
  streaming: boolean,
): Record<string, unknown> {
  const prepared = prepare(request);
  return {
    model: request.modelId,
    // Required by the wire; the descriptor is the number the user already declared for this model (§3.2), so absence
    // from the request costs nothing and invents nothing.
    max_tokens: request.maxTokens ?? descriptor.maxOutputTokens,
    messages: prepared.messages,
    stream: streaming,
    ...(prepared.system === undefined ? {} : { system: prepared.system }),
    ...(request.tools === undefined || request.tools.length === 0
      ? {}
      : { tools: wireTools(request.tools) }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
  };
}

function usageFrom(input: unknown): Usage {
  const record = isRecord(input) ? input : {};
  return {
    inputTokens: asNumber(record.input_tokens) ?? 0,
    outputTokens: asNumber(record.output_tokens) ?? 0,
  };
}

function finishFrom(stopReason: unknown, sawToolUse: boolean): FinishReason {
  const key = asString(stopReason);
  if (key === undefined) return sawToolUse ? "tool-calls" : "done";
  const mapped = STOP_REASONS[key];
  if (mapped === undefined) {
    throw new ProviderError(
      "invalid-response",
      `the endpoint answered with stop_reason '${key}', which is not in the family's table — a terminal state this ` +
        "adapter cannot name is one it will not guess",
      { raw: key },
    );
  }
  return mapped;
}

function toolCallsFrom(content: readonly unknown[]): ProviderToolCall[] {
  const calls: ProviderToolCall[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== "tool_use") continue;
    const id = asString(block.id);
    const name = asString(block.name);
    if (id === undefined || name === undefined) {
      throw new ProviderError(
        "invalid-response",
        "a tool_use block arrived with no id or no name",
        {
          raw: JSON.stringify(block).slice(0, 300),
        },
      );
    }
    const input = block.input;
    calls.push({
      id,
      name,
      arguments: isRecord(input) ? input : {},
    });
  }
  return calls;
}

function completionFrom(body: unknown): GenerateResult {
  if (!isRecord(body)) {
    throw translateProviderError({ body: JSON.stringify(body)?.slice(0, 500), attempt: undefined });
  }
  const privileged = assertNoPrivilegedFields(body);
  if (!privileged.ok) {
    throw new ProviderError(
      "invalid-response",
      `the response carried '${privileged.field}', which §3.1 forbids a provider to send`,
      { raw: privileged.field },
    );
  }
  const content = Array.isArray(body.content) ? body.content : [];
  let text = "";
  let sawToolUse = false;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text") text += asString(block.text) ?? "";
    if (block.type === "tool_use") sawToolUse = true;
  }
  return {
    text,
    usage: usageFrom(body.usage),
    toolCalls: toolCallsFrom(content),
    finishReason: finishFrom(body.stop_reason, sawToolUse),
  };
}

/** The accumulated `input_json_delta` fragments → tool calls, run at `message_stop` because the arguments are only
 *  JSON once the last piece has landed. The same honesty rule as the first adapter's stream: a call that never named
 *  itself is an error, not an empty arguments object. */
function toolCallsFromFragments(
  partial: ReadonlyMap<number, { id: string; name: string | undefined; arguments: string }>,
): ProviderToolCall[] {
  const calls: ProviderToolCall[] = [];
  for (const key of [...partial.keys()].sort((a, b) => a - b)) {
    const fragment = partial.get(key);
    if (fragment === undefined) continue;
    if (fragment.name === undefined) {
      throw new ProviderError(
        "invalid-response",
        `a streamed tool call never named its function (block ${String(key)})`,
        { raw: fragment.arguments.slice(0, 200) },
      );
    }
    let args: Record<string, unknown> = {};
    if (fragment.arguments !== "") {
      try {
        const parsed: unknown = JSON.parse(fragment.arguments);
        if (!isRecord(parsed)) {
          throw new ProviderError(
            "invalid-response",
            `a streamed tool call's arguments parsed to ${typeof parsed}, not an object`,
            { raw: fragment.arguments.slice(0, 200) },
          );
        }
        args = parsed;
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError(
          "invalid-response",
          `a streamed tool call's arguments were not JSON: ${fragment.arguments.slice(0, 200)}`,
          { raw: fragment.arguments.slice(0, 500) },
        );
      }
    }
    calls.push({ id: fragment.id, name: fragment.name, arguments: args });
  }
  return calls;
}

export function createAnthropicProvider(options: AnthropicProviderOptions): Provider {
  const id = options.id ?? ANTHROPIC_PROVIDER_ID;
  const validation = validateProviderConfig(options.config);
  if (!validation.ok) {
    throw new Error(`${id}: the configuration is unusable — ${validation.reason}`);
  }
  if (options.models.length === 0) {
    throw new Error(
      `${id}: no models were declared, so there is nothing to route a request to (§3.2)`,
    );
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
  const endpoint = endpointFor(options.config);
  const flights = createInFlightTable();

  function post(
    request: ProviderRequest,
    descriptor: ModelDescriptor,
    streaming: boolean,
    entry: { readonly controller: AbortController },
  ): Promise<Response> {
    return doFetch(endpoint, {
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
    return translateFailure({ ...input, endpoint, overrides: options.overrides });
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
        // One delta, then done — the flag describes the endpoint, not the adapter (§3.1), and the terminal states must
        // hold either way.
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
      const partial = new Map<
        number,
        { id: string; name: string | undefined; arguments: string }
      >();
      let text = "";
      let sawFirstToken = false;
      let usage: Usage | undefined;
      let stopReason: unknown;
      let sawToolUse = false;
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
          const frames = buffer.replace(/\r\n/g, "\n").split("\n\n");
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            // The family's SSE frames carry an `event:` line and a `data:` line; the data's own `type` field is the
            // authority (a frame with neither is a keep-alive, which §5.1 of the API doc requires of a stream).
            const data = frame
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");
            if (data === "") continue;
            let event: unknown;
            try {
              event = JSON.parse(data);
            } catch {
              yield {
                type: "error",
                error: new ProviderError(
                  "invalid-response",
                  `a stream frame was not JSON: ${data.slice(0, 200)}`,
                  {
                    raw: data.slice(0, 500),
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
                  `a stream frame carried '${privileged.field}', which §3.1 forbids a provider to send`,
                  { raw: privileged.field, attempt: ctx.attempt },
                ),
              };
              return;
            }
            const kind = asString(event.type);
            if (kind === "message_start") {
              usage = usageFrom(isRecord(event.message) ? event.message.usage : undefined) ?? usage;
              if (usage !== undefined && usage.inputTokens === 0 && usage.outputTokens === 0)
                usage = undefined;
              continue;
            }
            if (kind === "content_block_start") {
              const block = isRecord(event.content_block) ? event.content_block : undefined;
              if (block?.type === "tool_use") {
                sawToolUse = true;
                if (!sawFirstToken) {
                  sawFirstToken = true;
                  guard.firstToken();
                } else guard.progress();
                const index = asNumber(event.index) ?? partial.size;
                partial.set(index, {
                  id: asString(block.id) ?? "",
                  name: asString(block.name),
                  arguments: "",
                });
              }
              continue;
            }
            if (kind === "content_block_delta") {
              const delta = isRecord(event.delta) ? event.delta : undefined;
              const fragment = asString(delta?.text);
              const json = asString(delta?.partial_json);
              if (fragment !== undefined && fragment !== "") {
                if (!sawFirstToken) {
                  sawFirstToken = true;
                  guard.firstToken();
                } else guard.progress();
                text += fragment;
                yield { type: "delta", text: fragment };
              }
              if (json !== undefined && json !== "") {
                const index = asNumber(event.index) ?? 0;
                const existing = partial.get(index) ?? { id: "", name: undefined, arguments: "" };
                partial.set(index, { ...existing, arguments: existing.arguments + json });
                if (!sawFirstToken) {
                  sawFirstToken = true;
                  guard.firstToken();
                } else guard.progress();
              }
              continue;
            }
            if (kind === "message_delta") {
              const delta = isRecord(event.delta) ? event.delta : undefined;
              if (delta?.stop_reason !== undefined) stopReason = delta.stop_reason;
              const more = usageFrom(event.usage);
              if (more.outputTokens !== 0) {
                usage = { inputTokens: usage?.inputTokens ?? 0, outputTokens: more.outputTokens };
              }
            }
            // `message_stop`, `ping`, and anything new: a terminal frame needs no data of its own, and an unknown
            // event is skipped rather than fatal — the family adds event kinds more often than it breaks them.
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
        const toolCalls = toolCallsFromFragments(partial);
        for (const call of toolCalls) {
          yield {
            type: "tool-call",
            id: call.id,
            name: call.name,
            arguments: { ...call.arguments },
          };
        }
        yield {
          type: "done",
          usage: usage ?? { inputTokens: 0, outputTokens: 0 },
          finishReason:
            stopReason !== undefined
              ? finishFrom(stopReason, sawToolUse)
              : sawToolUse
                ? "tool-calls"
                : "done",
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
      // Best-effort by declaration: this closes our side of the socket; it cannot stop a remote server generating the
      // tokens it has already been asked for.
      flights.cancel(handle.requestId);
    },
  };
}
