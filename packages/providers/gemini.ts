// `gemini` — the third product adapter, for the family that differs in its streaming shape and its safety metadata
// (the reason D-100 named for keeping the door shut until a caller appeared). The `generateContent` wire differs in
// four ways that are not cosmetic, and each is a line here rather than a caveat:
//
//   - **Content is `parts`, and roles are `user`/`model`.** The contract's `assistant` maps to the family's `model`; a
//     system turn becomes the top-level `systemInstruction`; a tool call rides a `functionCall` part and its result a
//     `functionResponse` part — which needs the tool's **name**, so the adapter resolves the contract's `toolCallId`
//     against the assistant turn that proposed it, and a result with no matching call is a parse failure here rather
//     than a 400 from the endpoint.
//   - **The key rides `x-goog-api-key`, never the URL.** The family's own documentation puts a `?key=` on the query
//     string, and a credential in a URL is a credential in access logs — G1-03's rule is not family-specific, so the
//     header form wins even though the quickstart says otherwise.
//   - **`finishReason` names safety explicitly** — `SAFETY` and `RECITATION` map to `content-filter`, `MAX_TOKENS` to
//     `length`, `STOP` to `done`; a value outside the table is `invalid-response`, on the same rule as `anthropic`'s
//     `stop_reason`: a terminal state this adapter cannot name is one it will not guess.
//   - **Streaming is SSE where every frame is a whole `GenerateContentResponse`** — text arrives as complete `text`
//     parts (never fragments), tool calls arrive as complete `functionCall` parts, and `usageMetadata` rides the last
//     frame. There is nothing to accumulate, so nothing is.
//
// What is deliberately the same as the other two adapters: the static user-declared model list with §3.2 descriptors,
// `cancellation: best-effort`, no retry of its own, the shared `wire.ts` machinery, and the construction-time refusal
// of unusable configuration.

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

export const GEMINI_PROVIDER_ID = "gemini";
/** The API root the family's documentation names; the adapter appends `/v1beta/models/{model}:generateContent`. */
export const GEMINI_API_ROOT_PATH = "/v1beta/models";
/** The header form of the credential. The family's quickstart puts `?key=` on the URL, and a credential in a URL is a
 *  credential in every access log between here and the endpoint (G1-03) — the header form is the same API's own
 *  supported alternative and the only one this adapter offers. */
export const GEMINI_API_KEY_HEADER = "x-goog-api-key";

export interface GeminiModelSpec {
  readonly id: string;
  readonly descriptor: unknown;
}

export interface GeminiProviderOptions {
  readonly config: ProviderConfig;
  readonly models: readonly GeminiModelSpec[];
  readonly id?: string;
  readonly deadlines?: Partial<WireDeadlines>;
  readonly fetch?: typeof globalThis.fetch;
  readonly overrides?: Readonly<Record<string, OverrideProvenance>> | undefined;
}

const FINISH_REASONS: Readonly<Record<string, FinishReason>> = {
  STOP: "done",
  MAX_TOKENS: "length",
  SAFETY: "content-filter",
  RECITATION: "content-filter",
  BLOCKLIST: "content-filter",
  PROHIBITED_CONTENT: "content-filter",
};

function endpointFor(config: ProviderConfig, modelId: string, streaming: boolean): string {
  const base = config.baseUrl.replace(/\/+$/, "");
  const verb = streaming ? "streamGenerateContent?alt=sse" : "generateContent";
  return `${base}${GEMINI_API_ROOT_PATH}/${encodeURIComponent(modelId)}:${verb}`;
}

function headersFor(config: ProviderConfig, streaming: boolean): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: streaming ? "text/event-stream" : "application/json",
    ...(config.apiKey === undefined ? {} : { [GEMINI_API_KEY_HEADER]: config.apiKey }),
    ...(config.headers ?? {}),
  };
}

/** The flat contract list → the family's grammar: system hoisted to `systemInstruction`, assistant tool calls as
 *  `functionCall` parts in a `model` turn, a tool's result as a `functionResponse` part whose **name** is resolved
 *  from the assistant turn that proposed the call id. */
function prepare(request: ProviderRequest): {
  readonly systemInstruction: Record<string, unknown> | undefined;
  readonly contents: readonly Record<string, unknown>[];
} {
  const systemParts: string[] = [];
  const contents: Record<string, unknown>[] = [];
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
      const parts: Record<string, unknown>[] = [];
      if (message.content !== "") parts.push({ text: message.content });
      for (const call of message.toolCalls) {
        parts.push({ functionCall: { name: call.name, args: call.arguments } });
      }
      contents.push({ role: "model", parts });
      continue;
    }
    if (message.role === "tool") {
      if (message.toolCallId === undefined) {
        throw new ProviderError(
          "invalid-response",
          "a tool result message carries no 'toolCallId', so the call it answers cannot be found",
        );
      }
      // The family wants the tool's *name* on the response; the contract carries the call's id. Resolve it against the
      // assistant turn that proposed it — a result for a call nobody proposed has no name to give and fails here.
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
      let parsed: Record<string, unknown>;
      try {
        const value: unknown = JSON.parse(message.content);
        parsed = isRecord(value) ? value : { result: message.content };
      } catch {
        parsed = { result: message.content };
      }
      contents.push({
        role: "user",
        parts: [{ functionResponse: { name, response: parsed } }],
      });
      continue;
    }
    contents.push({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }],
    });
  }
  return {
    systemInstruction:
      systemParts.length === 0 ? undefined : { parts: [{ text: systemParts.join("\n\n") }] },
    contents,
  };
}

function wireTools(tools: readonly ProviderToolSpec[]): Record<string, unknown>[] {
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    },
  ];
}

function bodyFor(
  request: ProviderRequest,
  descriptor: ModelDescriptor,
  streaming: boolean,
): Record<string, unknown> {
  const prepared = prepare(request);
  return {
    contents: prepared.contents,
    ...(prepared.systemInstruction === undefined
      ? {}
      : { systemInstruction: prepared.systemInstruction }),
    ...(request.tools === undefined || request.tools.length === 0
      ? {}
      : { tools: wireTools(request.tools) }),
    generationConfig: {
      maxOutputTokens: request.maxTokens ?? descriptor.maxOutputTokens,
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    },
    ...(streaming ? {} : {}),
  };
}

function usageFrom(input: unknown): Usage {
  const record = isRecord(input) ? input : {};
  return {
    inputTokens: asNumber(record.promptTokenCount) ?? 0,
    outputTokens: asNumber(record.candidatesTokenCount) ?? 0,
  };
}

function finishFrom(value: unknown): FinishReason {
  const key = asString(value);
  if (key === undefined) return "done";
  const mapped = FINISH_REASONS[key];
  if (mapped === undefined) {
    throw new ProviderError(
      "invalid-response",
      `the endpoint answered with finishReason '${key}', which is not in the family's table — a terminal state this ` +
        "adapter cannot name is one it will not guess",
      { raw: key },
    );
  }
  return mapped;
}

/** One candidate's parts → text and tool calls. Tool arguments arrive complete (the family fragments nothing here), so
 *  there is nothing to accumulate. */
function partsOf(candidate: unknown): {
  readonly text: string;
  readonly toolCalls: readonly ProviderToolCall[];
} {
  const record = isRecord(candidate) ? candidate : {};
  const content = isRecord(record.content) ? record.content : {};
  const parts = Array.isArray(content.parts) ? content.parts : [];
  let text = "";
  const toolCalls: ProviderToolCall[] = [];
  for (const part of parts) {
    if (!isRecord(part)) continue;
    const fragment = asString(part.text);
    if (fragment !== undefined) text += fragment;
    const call = isRecord(part.functionCall) ? part.functionCall : undefined;
    const name = asString(call?.name);
    if (call !== undefined && name !== undefined) {
      toolCalls.push({
        id: `call_${toolCalls.length + 1}`,
        name,
        arguments: isRecord(call.args) ? call.args : {},
      });
    }
  }
  return { text, toolCalls };
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
  const candidates = Array.isArray(body.candidates) ? body.candidates : [];
  const first = candidates[0];
  const { text, toolCalls } = partsOf(first);
  return {
    text,
    usage: usageFrom(body.usageMetadata),
    toolCalls,
    finishReason: finishFrom(isRecord(first) ? first.finishReason : undefined),
  };
}

export function createGeminiProvider(options: GeminiProviderOptions): Provider {
  const id = options.id ?? GEMINI_PROVIDER_ID;
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
  const flights = createInFlightTable();

  function post(
    request: ProviderRequest,
    descriptor: ModelDescriptor,
    streaming: boolean,
    entry: { readonly controller: AbortController },
  ): Promise<Response> {
    return doFetch(endpointFor(options.config, request.modelId, streaming), {
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
      endpoint: options.config.baseUrl,
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
            // Every frame is a whole GenerateContentResponse: text parts arrive complete, so each one is a delta of
            // itself, and there is nothing to accumulate across frames.
            const { text, toolCalls } = partsOf(
              Array.isArray(event.candidates) ? event.candidates[0] : undefined,
            );
            if (text !== "") {
              if (!sawFirstToken) {
                sawFirstToken = true;
                guard.firstToken();
              } else guard.progress();
              yield { type: "delta", text };
            }
            for (const call of toolCalls) {
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
            if (event.usageMetadata !== undefined) usage = usageFrom(event.usageMetadata);
            const candidate = Array.isArray(event.candidates) ? event.candidates[0] : undefined;
            if (isRecord(candidate) && candidate.finishReason !== undefined) {
              finishReason = finishFrom(candidate.finishReason);
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
