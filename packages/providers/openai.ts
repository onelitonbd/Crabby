// `openai-compatible` — the first product adapter, and deliberately §3.3's widest row rather than its most famous one:
// one adapter serves OpenAI-compatible endpoints (Groq, OpenRouter, Together, Fireworks, LM Studio, vLLM, Ollama's
// compatibility layer, GitHub Models) *and* D-041's user-defined endpoint, which is the same adapter with a base URL, a
// key and a model name. §3.3's own reasoning is why this came first — "implement families, not N vendors" — and why a
// vendor-specific adapter is only justified where the API genuinely differs (`anthropic`'s tool blocks, `gemini`'s
// streaming metadata). It implements §3.1's contract, declares §3.2's descriptors per model, translates every failure
// into §3.5's taxonomy through the shared table in `errors.ts`, and refuses unusable configuration by §3.3's rules via
// `config.ts` (D-100).
//
// Four things here are decisions rather than details, and each has the sentence that forced it:
//
//   - **The model list is static, and that is §3.1's permission rather than a shortcut.** "MAY be a static list for
//     providers without a discovery endpoint" — an OpenAI-compatible endpoint does have `GET /models`, but it returns
//     ids and nothing else, and §3.2's descriptor (context window, max output, the ten capability flags, cancellation,
//     rate limits, cost) is not served by any endpoint in this family. Discovery would therefore produce exactly the
//     failure the conformance suite checks for: a model `listModels()` names with no descriptor behind it, whose limits
//     are unknowable. A user-declared model list with a user-declared descriptor is the honest shape, and §3.8 is where
//     a user corrects a claim.
//   - **Three deadlines are the adapter's and one is the runtime's.** §3.5 requires that connect, first-token and stall be
//     distinguishable, and only the party holding the socket can tell them apart, so this file arms those three (D-074's
//     `providerConnectMs`, `providerFirstTokenMs`, `providerIdleStreamMs`). The absolute deadline is armed from
//     `ctx.timeoutMs` when the runtime supplies one, because §3.1 makes timeouts the runtime wrapper's job — the adapter
//     honours the number it is given instead of deciding its own, and labels the two kinds differently so a ladder can
//     tell "the endpoint never answered" from "the model went quiet mid-answer".
//   - **`cancellation` is `best-effort`, not `supported`.** Aborting the request closes this side of the socket and stops
//     the task waiting, which is real; it does not stop a remote server generating tokens it will bill for, and claiming
//     `supported` would tell §6.2's evidence something the adapter cannot know. `cancel(handle)` aborts by request id, so
//     the loop's own cancellation and an adapter-side one produce the same `cancelled` class.
//   - **Usage a stream does not carry is reported as zero, never estimated.** `stream_options.include_usage` asks for it
//     and every endpoint that implements streaming usage answers; one that does not leaves `Usage` unfillable, and
//     `Usage` has no "unknown" — so the adapter reports zeros rather than dressing a character-count guess as a
//     measurement, because §3.4's budget spends against these numbers. D-100 records that the honest fix is a
//     `reported` flag on `Usage`, which is §3.4's owner's decision and not an adapter's.
//
// What is deliberately absent: `countTokens`, because an estimator that looks like a count is worse than §3.4's own
// estimation, which is what the contract says absence means; a vault handle for the key, because this build has no vault
// (`docs/CONSISTENCY_REVIEW.md` F-56), so `config.apiKey` is a plain string and the party that composes the adapter is
// the one that must keep it out of a log and out of model context; and any retry logic, because D-043's ladder is the
// loop's and an adapter that retried would double it.

import { LIMITS_DEFAULTS } from "@crabby/core";
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

export const OPENAI_COMPATIBLE_PROVIDER_ID = "openai-compatible";
/** Appended to the configured base URL, which §3.3 makes the user's responsibility: "Base URL + key + model name". The
 *  base is the API root the endpoint's own documentation names (`https://api.groq.com/openai/v1`), not a bare host, so
 *  the adapter appends a path and never guesses a version segment. */
export const CHAT_COMPLETIONS_PATH = "/chat/completions";

/** One model the user attached, with the §3.2 descriptor that makes its limits knowable. `descriptor` is `unknown`
 *  because §3.2's rule is fail-closed parsing: an unparsable descriptor disables the provider rather than defaulting
 *  everything on, and a typed field would erase whatever the object actually carries before `parseDescriptor` saw it. */
export interface OpenAiModelSpec {
  readonly id: string;
  readonly descriptor: unknown;
}

export interface OpenAiDeadlines {
  readonly connectMs: number;
  readonly firstTokenMs: number;
  readonly idleStreamMs: number;
}

/** D-074's three adapter-observable provider deadlines, read from `packages/core` rather than copied: a second copy of a
 *  decided number is a number that drifts from the one `crabby config get limits` prints. */
export const OPENAI_DEADLINE_DEFAULTS: OpenAiDeadlines = {
  connectMs: LIMITS_DEFAULTS.providerConnectMs,
  firstTokenMs: LIMITS_DEFAULTS.providerFirstTokenMs,
  idleStreamMs: LIMITS_DEFAULTS.providerIdleStreamMs,
};

export interface OpenAiProviderOptions {
  readonly config: ProviderConfig;
  readonly models: readonly OpenAiModelSpec[];
  /** Defaults to `openai-compatible`. A preset (§3.3's `groq`, `openrouter`, …) is this adapter with a name, a base URL
   *  and a model list — "presets carry no privileged behavior", so a name is all that differs. */
  readonly id?: string;
  readonly deadlines?: Partial<OpenAiDeadlines>;
  /** Injectable for the same reason policy injects `now` and the ladder injects `random`: a wire protocol nobody can
   *  drive in a test is a wire protocol nobody has tested. Defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
}

type DeadlineName = "connect" | "first-token" | "stall" | "absolute";

interface InFlight {
  readonly controller: AbortController;
  /** Set by `cancel(handle)`, and the only way this adapter can tell its own abort from a deadline that tripped: both
   *  arrive as an aborted signal, but §3.5 gives them different classes and different retry stories. */
  cancelledByAdapter: boolean;
}

interface Guard {
  readonly signal: AbortSignal;
  /** Which deadline tripped, when one did — as distinct from the caller's own abort, which is a cancellation. */
  readonly tripped: () => DeadlineName | undefined;
  readonly connected: () => void;
  readonly firstToken: () => void;
  readonly progress: () => void;
  readonly dispose: () => void;
}

/** One abort controller per request, armed with the deadlines that only the socket can observe. A timer that fires
 *  records *which* deadline it was before aborting, so the resulting `ProviderError` carries §3.5's distinction instead
 *  of a generic timeout, and a caller's abort is never mistaken for one. */
function guardFor(
  ctx: ProviderContext,
  deadlines: OpenAiDeadlines,
  mode: "generate" | "stream",
): Guard {
  const controller = new AbortController();
  const phases: Partial<Record<DeadlineName, ReturnType<typeof setTimeout>>> = {};
  let tripped: DeadlineName | undefined;

  const disarm = (name: DeadlineName): void => {
    const timer = phases[name];
    if (timer !== undefined) clearTimeout(timer);
    delete phases[name];
  };
  const arm = (ms: number, name: DeadlineName): void => {
    disarm(name);
    phases[name] = setTimeout(() => {
      tripped = name;
      controller.abort();
    }, ms);
  };
  const onOuterAbort = (): void => {
    controller.abort();
  };

  if (ctx.signal.aborted) controller.abort();
  else ctx.signal.addEventListener("abort", onOuterAbort, { once: true });
  arm(deadlines.connectMs, "connect");
  // §3.1: "Timeouts are enforced by the runtime wrapper". The runtime supplies the absolute number and the loop wraps the
  // call with it as well; arming it here too means the adapter stops reading a socket the runtime has already given up
  // on, and the label says which of the two fired.
  if (ctx.timeoutMs !== undefined) arm(ctx.timeoutMs, "absolute");

  return {
    signal: controller.signal,
    tripped: () => tripped,
    connected: () => {
      disarm("connect");
      // A non-streaming answer arrives as one body, so "first token" and "response complete" are the same instant and
      // arming a first-token deadline would only ever measure the connect deadline twice.
      if (mode === "stream") arm(deadlines.firstTokenMs, "first-token");
    },
    firstToken: () => {
      disarm("first-token");
      arm(deadlines.idleStreamMs, "stall");
    },
    progress: () => {
      // Re-armed rather than extended: §3.5's stall is silence *between* deltas, so a stream that keeps talking is a
      // stream that is not stalling, however long it runs.
      if (phases.stall !== undefined) arm(deadlines.idleStreamMs, "stall");
    },
    dispose: () => {
      for (const name of Object.keys(phases) as DeadlineName[]) disarm(name);
      ctx.signal.removeEventListener("abort", onOuterAbort);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** `finish_reason` → §3.1's four terminal states. The mapping is a table because the family is not perfectly uniform
 *  (`function_call` predates `tool_calls`, and some servers send `stop` for a filtered answer), and a table is the shape
 *  where a missing row is visible. */
const FINISH_REASONS: Readonly<Record<string, FinishReason>> = {
  stop: "done",
  end_turn: "done",
  length: "length",
  max_tokens: "length",
  tool_calls: "tool-calls",
  function_call: "tool-calls",
  content_filter: "content-filter",
};

function endpointFor(config: ProviderConfig): string {
  return `${config.baseUrl.replace(/\/+$/, "")}${CHAT_COMPLETIONS_PATH}`;
}

function headersFor(config: ProviderConfig, streaming: boolean): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: streaming ? "text/event-stream" : "application/json",
    ...(config.apiKey === undefined ? {} : { authorization: `Bearer ${config.apiKey}` }),
    // The user's headers win, on purpose: §3.3 says a custom endpoint gains no exemption from validation, tier policy or
    // credential handling, and none of those live in a header — but a proxy or a gateway model may need one the adapter
    // cannot predict, and an override the user cannot make is a configuration dead end.
    ...(config.headers ?? {}),
  };
}

function wireMessage(message: ProviderMessage): Record<string, unknown> {
  const base: Record<string, unknown> = { role: message.role };
  if (
    message.role === "assistant" &&
    message.toolCalls !== undefined &&
    message.toolCalls.length > 0
  ) {
    // An assistant turn that proposed tool calls carries them as the wire's own list; `content` is sent as null when
    // empty because several servers reject `""` beside `tool_calls` and none reject null.
    return {
      ...base,
      content: message.content === "" ? null : message.content,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
    };
  }
  if (message.role === "tool") {
    if (message.toolCallId === undefined) {
      throw new ProviderError(
        "invalid-response",
        "a tool result message carries no 'toolCallId', so the endpoint cannot match it to the call it answers",
      );
    }
    return { ...base, tool_call_id: message.toolCallId, content: message.content };
  }
  return { ...base, content: message.content };
}

function wireTools(tools: readonly ProviderToolSpec[]): Record<string, unknown>[] {
  return tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

function bodyFor(request: ProviderRequest, streaming: boolean): Record<string, unknown> {
  return {
    model: request.modelId,
    messages: request.messages.map(wireMessage),
    stream: streaming,
    // Asked for explicitly: a streaming answer without usage is a stream §3.4 cannot budget, and the field is the
    // documented way to get one. Servers that do not implement it ignore it, which is the zero-usage case above.
    ...(streaming ? { stream_options: { include_usage: true } } : {}),
    ...(request.tools === undefined || request.tools.length === 0
      ? {}
      : { tools: wireTools(request.tools), tool_choice: "auto" }),
    ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
  };
}

function usageFrom(wire: unknown): Usage {
  const usage = isRecord(wire) ? wire : undefined;
  const cached = isRecord(usage?.prompt_tokens_details)
    ? asNumber(usage.prompt_tokens_details.cached_tokens)
    : undefined;
  return {
    inputTokens: asNumber(usage?.prompt_tokens) ?? 0,
    outputTokens: asNumber(usage?.completion_tokens) ?? 0,
    ...(cached === undefined ? {} : { cachedInputTokens: cached }),
  };
}

/** One tool call off the wire. `arguments` arrives as a JSON *string* in this family, which is the single most common
 *  place a completion turns out to be malformed, so a parse failure keeps the raw fragment for the audit record —
 *  §3.5's note for `invalid-response` is "keep the raw fragment in the audit record, redacted", and redaction is the
 *  caller's job, not this function's. */
function toolCallsFrom(wire: unknown): ProviderToolCall[] {
  if (!Array.isArray(wire)) return [];
  const calls: ProviderToolCall[] = [];
  for (const entry of wire) {
    const record = isRecord(entry) ? entry : undefined;
    const fn = isRecord(record?.function) ? record.function : undefined;
    const name = asString(fn?.name);
    if (record === undefined || fn === undefined || name === undefined) {
      throw new ProviderError(
        "invalid-response",
        `a tool call arrived without a function name: ${JSON.stringify(entry)?.slice(0, 200) ?? "?"}`,
        { raw: entry },
      );
    }
    const id = asString(record.id) ?? "";
    const rawArguments = fn.arguments;
    let args: Record<string, unknown>;
    if (rawArguments === undefined || rawArguments === null || rawArguments === "") args = {};
    else if (isRecord(rawArguments)) args = rawArguments;
    else if (typeof rawArguments === "string") {
      try {
        const parsed: unknown = JSON.parse(rawArguments);
        if (!isRecord(parsed)) {
          throw new ProviderError(
            "invalid-response",
            `a tool call's arguments parsed to ${typeof parsed}, not an object: ${rawArguments.slice(0, 200)}`,
            { raw: rawArguments },
          );
        }
        args = parsed;
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError(
          "invalid-response",
          `a tool call's arguments were not JSON: ${rawArguments.slice(0, 200)}`,
          { raw: rawArguments },
        );
      }
    } else {
      throw new ProviderError(
        "invalid-response",
        "a tool call's arguments were neither a JSON string nor an object",
        {
          raw: rawArguments,
        },
      );
    }
    calls.push({ id, name, arguments: args });
  }
  return calls;
}

function finishReasonFrom(wire: unknown, toolCalls: readonly ProviderToolCall[]): FinishReason {
  const reason = asString(wire);
  if (reason === undefined) {
    // `null` and absent both happen; deriving the answer from what the completion contains is not a guess, because a
    // turn that proposed tool calls is by definition waiting on them.
    return toolCalls.length > 0 ? "tool-calls" : "done";
  }
  const mapped = FINISH_REASONS[reason];
  if (mapped === undefined) {
    throw new ProviderError(
      "invalid-response",
      `'${reason}' is not a finish_reason this adapter knows (${Object.keys(FINISH_REASONS).join(", ")}), and §3.2 says a ` +
        "broken capability is a bug to fix in the adapter rather than something the runtime papers over",
      { raw: reason },
    );
  }
  return mapped;
}

/** The response body → §3.1's `GenerateResult`, with §3.1's third rule enforced on both the body and the message inside
 *  it: a completion that could widen a task's permissions through a `capabilities` or `systemPrompt` field would not
 *  need a bug in Crabby to do it, so the field is refused rather than ignored. */
function completionFrom(body: unknown): GenerateResult {
  if (!isRecord(body)) {
    throw new ProviderError("invalid-response", "the provider response was not a JSON object", {
      raw: body,
    });
  }
  const privileged = assertNoPrivilegedFields(body);
  if (!privileged.ok) {
    throw new ProviderError(
      "invalid-response",
      `the completion carried '${privileged.field}', which §3.1 forbids a provider to send: a response may propose tool ` +
        "calls and nothing else that touches permission",
      { raw: privileged.field },
    );
  }
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const first = choices[0];
  if (!isRecord(first)) {
    throw new ProviderError("invalid-response", "the completion carried no first choice", {
      raw: body,
    });
  }
  const message = isRecord(first.message) ? first.message : undefined;
  if (message === undefined) {
    throw new ProviderError(
      "invalid-response",
      "the completion's first choice carried no message",
      { raw: first },
    );
  }
  const innerPrivileged = assertNoPrivilegedFields(message);
  if (!innerPrivileged.ok) {
    throw new ProviderError(
      "invalid-response",
      `the completion's message carried '${innerPrivileged.field}', which §3.1 forbids a provider to send`,
      { raw: innerPrivileged.field },
    );
  }
  const toolCalls = toolCallsFrom(message.tool_calls);
  return {
    text: asString(message.content) ?? "",
    usage: usageFrom(body.usage),
    toolCalls,
    finishReason: finishReasonFrom(first.finish_reason, toolCalls),
  };
}

export function createOpenAiCompatibleProvider(options: OpenAiProviderOptions): Provider {
  const id = options.id ?? OPENAI_COMPATIBLE_PROVIDER_ID;
  const validation = validateProviderConfig(options.config);
  if (!validation.ok) {
    // Thrown at construction rather than returned, because §3.1's rule is that unusable configuration is rejected
    // *before any call*, and an adapter that constructs successfully and then fails every call has not rejected it.
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
      // §3.2: "an unparsable descriptor disables the provider rather than defaulting everything on".
      throw new Error(`${id}: '${model.id}' has an unparsable descriptor — ${parsed.reason}`);
    }
    descriptors[model.id] = parsed.descriptor;
  }
  const deadlines: OpenAiDeadlines = { ...OPENAI_DEADLINE_DEFAULTS, ...options.deadlines };
  const doFetch = options.fetch ?? globalThis.fetch;
  const endpoint = endpointFor(options.config);

  /** Requests this adapter has in flight, by the runtime's request id, so `cancel(handle)` can reach one. A map rather
   *  than a flag because §4.2's controlled parallelism means more than one call can be open at once. */
  const inFlight = new Map<string, InFlight>();

  /** Tie one request's socket to its guard and remember it under the runtime's request id. The propagation lives for the
   *  *whole* request rather than only for the wait on headers, and that is the difference between a deadline and a hang:
   *  a stall or an absolute deadline fires while the body is still streaming, and if the guard's abort stopped reaching
   *  the socket at that point the read would wait forever on a server that has gone quiet. */
  function beginRequest(
    ctx: ProviderContext,
    guard: Guard,
  ): { readonly entry: InFlight; readonly dispose: () => void } {
    const entry: InFlight = { controller: new AbortController(), cancelledByAdapter: false };
    inFlight.set(ctx.requestId, entry);
    const onGuardAbort = (): void => entry.controller.abort();
    if (guard.signal.aborted) entry.controller.abort();
    else guard.signal.addEventListener("abort", onGuardAbort, { once: true });
    return {
      entry,
      dispose: () => {
        guard.signal.removeEventListener("abort", onGuardAbort);
        // Compared by identity before deleting: a late `dispose` must not remove the entry a *later* request under the
        // same id just registered, which would leave that one unreachable to `cancel()`.
        if (inFlight.get(ctx.requestId) === entry) inFlight.delete(ctx.requestId);
      },
    };
  }

  function descriptorFor(modelId: string): ModelDescriptor {
    const descriptor = descriptors[modelId];
    if (descriptor === undefined) {
      throw new ProviderError(
        "unsupported-capability",
        `'${modelId}' is not one of this endpoint's declared models (${Object.keys(descriptors).join(", ")}); §3.8 is ` +
          "where a user adds or corrects one, and the runtime may not invent a descriptor for a model nobody priced",
      );
    }
    return descriptor;
  }

  function refuseUndeclared(request: ProviderRequest, descriptor: ModelDescriptor): void {
    if (
      request.tools !== undefined &&
      request.tools.length > 0 &&
      descriptor.supports.toolCalling !== true
    ) {
      // §3.1: "Presence of a method is not enough; the capability must be declared in describe()". Sending tools to a
      // model that does not declare them would produce a completion that silently ignored them, which the loop would
      // read as "the model chose not to call a tool" — the most expensive kind of wrong answer.
      throw new ProviderError(
        "unsupported-capability",
        `'${request.modelId}' does not declare toolCalling, so ${request.tools.length} tool(s) were refused rather than ` +
          "sent to be ignored (§3.2: a declared-but-broken capability is a bug, and an undeclared one is a refusal)",
      );
    }
  }

  /** The shared failure translation: an abort is a cancellation, a tripped deadline names itself, a transport error is
   *  `overloaded` because §3.5 has no "unreachable" class and a refused connection is the retryable-and-escalating kind
   *  of failure — D-043's ladder bounds it, and `invalid-response` would put a dead endpoint in the same bucket as a
   *  malformed body, which the ladder treats differently. */
  function failure(input: {
    ctx: ProviderContext;
    guard: Guard;
    error: unknown;
    adapterCancelled: boolean;
    status?: number | undefined;
    body?: string | undefined;
    retryAfterMs?: number | undefined;
  }): ProviderError {
    if (input.adapterCancelled || input.ctx.signal.aborted) {
      return translateProviderError({ aborted: true, attempt: input.ctx.attempt });
    }
    const tripped = input.guard.tripped();
    if (tripped !== undefined) {
      return translateProviderError({ deadline: tripped, attempt: input.ctx.attempt });
    }
    if (input.status !== undefined) {
      return translateProviderError({
        status: input.status,
        ...(input.body === undefined ? {} : { body: input.body }),
        ...(input.retryAfterMs === undefined ? {} : { retryAfterMs: input.retryAfterMs }),
        attempt: input.ctx.attempt,
      });
    }
    const message = input.error instanceof Error ? input.error.message : String(input.error);
    return new ProviderError(
      "overloaded",
      `the endpoint at ${endpoint} could not be reached: ${message}`,
      { raw: message, attempt: input.ctx.attempt },
    );
  }

  function retryAfterFrom(response: Response): number | undefined {
    const header = response.headers.get("retry-after");
    if (header === null) return undefined;
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
    const date = Date.parse(header);
    return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
  }

  /** Both aborts reach this one socket: the runtime's signal and every deadline, through the guard, and an adapter-side
   *  `cancel()`, through the entry's own controller. */
  async function post(
    request: ProviderRequest,
    streaming: boolean,
    entry: InFlight,
  ): Promise<Response> {
    return await doFetch(endpoint, {
      method: "POST",
      headers: headersFor(options.config, streaming),
      body: JSON.stringify(bodyFor(request, streaming)),
      signal: entry.controller.signal,
    });
  }

  async function readBody(response: Response): Promise<string> {
    return await response.text();
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
      const descriptor = descriptorFor(request.modelId);
      refuseUndeclared(request, descriptor);
      if (ctx.signal.aborted) {
        throw translateProviderError({ aborted: true, attempt: ctx.attempt });
      }
      const guard = guardFor(ctx, deadlines, "generate");
      // Registered before the fetch and read at every failure site, because the case that needs the flag most is a
      // rejection *during* the fetch — an adapter-side `cancel()` that lands before any header arrived. Reading it only
      // after the response would report that cancellation as a transport failure, which is what it is not.
      const flight = beginRequest(ctx, guard);
      const entry = flight.entry;
      try {
        const response = await post(request, false, entry);
        guard.connected();
        if (!response.ok) {
          const text = await readBody(response);
          throw failure({
            ctx,
            guard,
            error: text,
            adapterCancelled: entry.cancelledByAdapter,
            status: response.status,
            body: text,
            retryAfterMs: retryAfterFrom(response),
          });
        }
        const text = await readBody(response);
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          // The endpoint answered and the answer was not JSON: §3.5's `invalid-response`, with the raw fragment kept for
          // the audit record. This deliberately does not go through `failure()`, whose no-status branch means "the
          // endpoint could not be reached" and answers `overloaded` — a different fact with a different retry story.
          throw translateProviderError({ body: text.slice(0, 500), attempt: ctx.attempt });
        }
        return completionFrom(body);
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw failure({ ctx, guard, error, adapterCancelled: entry.cancelledByAdapter });
      } finally {
        flight.dispose();
        guard.dispose();
      }
    },

    async *stream(request: ProviderRequest, ctx: ProviderContext): AsyncIterable<StreamEvent> {
      const descriptor = descriptorFor(request.modelId);
      // A model that does not declare streaming still gets a `stream()` that honours §3.1's terminal states, because the
      // contract requires the method and the flag describes the endpoint rather than the adapter: one delta, then done.
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

      refuseUndeclared(request, descriptor);
      if (ctx.signal.aborted) {
        yield { type: "cancelled" };
        return;
      }
      const guard = guardFor(ctx, deadlines, "stream");
      // Accumulated per index, because this family streams a tool call in fragments: the id and name arrive once and the
      // arguments arrive in pieces that are only JSON when the last one lands.
      const partial = new Map<
        number,
        { id: string; name: string | undefined; arguments: string }
      >();
      let sawFirstToken = false;
      let usage: Usage | undefined;
      let finishReason: FinishReason | undefined;
      // Exactly one terminal event reaches the consumer, which is what the conformance suite counts: two would let a
      // reader take a truncated answer for a finished one. Every path below therefore returns after yielding one.
      const flight = beginRequest(ctx, guard);
      const entry = flight.entry;

      try {
        const response = await post(request, true, entry);
        guard.connected();
        if (!response.ok) {
          const body = await readBody(response);
          yield {
            type: "error",
            error: failure({
              ctx,
              guard,
              error: body,
              adapterCancelled: entry.cancelledByAdapter,
              status: response.status,
              body,
              retryAfterMs: retryAfterFrom(response),
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
          if (ctx.signal.aborted || entry.cancelledByAdapter || guard.signal.aborted) {
            await reader.cancel().catch(() => undefined);
            break;
          }
          buffer += decoder.decode(chunk.value, { stream: true });
          // SSE frames end at a blank line; `\r\n` is legal and common behind proxies, so the split normalises first.
          const frames = buffer.replace(/\r\n/g, "\n").split("\n\n");
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            const data = frame
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");
            if (data === "") continue; // a comment or a keep-alive, which §5.1 of the API doc requires of a stream
            if (data === "[DONE]") {
              buffer = "";
              break;
            }
            let event: unknown;
            try {
              event = JSON.parse(data);
            } catch {
              yield {
                type: "error",
                error: new ProviderError(
                  "invalid-response",
                  `a stream frame was not JSON: ${data.slice(0, 200)}`,
                  { raw: data.slice(0, 500), attempt: ctx.attempt },
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
            if (isRecord(event.usage)) usage = usageFrom(event.usage);
            const choices = Array.isArray(event.choices) ? event.choices : [];
            const first = choices[0];
            if (!isRecord(first)) continue; // the usage-only frame this family sends last has an empty choices list
            const delta = isRecord(first.delta) ? first.delta : undefined;
            const fragment = asString(delta?.content);
            if (fragment !== undefined && fragment !== "") {
              if (!sawFirstToken) {
                sawFirstToken = true;
                guard.firstToken();
              } else guard.progress();
              yield { type: "delta", text: fragment };
              if (ctx.signal.aborted || entry.cancelledByAdapter || guard.signal.aborted) break;
            }
            if (Array.isArray(delta?.tool_calls)) {
              if (!sawFirstToken) {
                sawFirstToken = true;
                guard.firstToken();
              } else guard.progress();
              for (const item of delta.tool_calls) {
                if (!isRecord(item)) continue;
                const index = asNumber(item.index) ?? 0;
                const existing = partial.get(index) ?? { id: "", name: undefined, arguments: "" };
                const fn = isRecord(item.function) ? item.function : undefined;
                partial.set(index, {
                  id: asString(item.id) ?? existing.id,
                  name: asString(fn?.name) ?? existing.name,
                  arguments: existing.arguments + (asString(fn?.arguments) ?? ""),
                });
              }
            }
            const reason = first.finish_reason;
            if (reason !== undefined && reason !== null) {
              finishReason = finishReasonFrom(reason, []);
            }
          }
          if (ctx.signal.aborted || entry.cancelledByAdapter || guard.signal.aborted) {
            await reader.cancel().catch(() => undefined);
            break;
          }
        }

        if (ctx.signal.aborted || entry.cancelledByAdapter) {
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
        const toolCalls = toolCallsFromAccumulated(partial);
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
          finishReason: finishReason ?? (toolCalls.length > 0 ? "tool-calls" : "done"),
        };
      } catch (error) {
        if (ctx.signal.aborted || entry.cancelledByAdapter) {
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
                : failure({ ctx, guard, error, adapterCancelled: entry.cancelledByAdapter }),
        };
      } finally {
        flight.dispose();
        guard.dispose();
      }
    },

    cancel(handle: { requestId: string }): void {
      // Best-effort by declaration: this closes our side of the socket and stops the task waiting. It cannot stop a
      // remote server generating the tokens it has already been asked for, which is why the descriptor says
      // `best-effort` rather than `supported`.
      const entry = inFlight.get(handle.requestId);
      if (entry === undefined) return;
      entry.cancelledByAdapter = true;
      entry.controller.abort();
    },
  };
}

/** The accumulated fragments → §3.1's tool calls. Run at the end of a stream rather than per fragment, because
 *  `arguments` is only JSON once the last piece has landed. */
function toolCallsFromAccumulated(
  partial: ReadonlyMap<number, { id: string; name: string | undefined; arguments: string }>,
): ProviderToolCall[] {
  const calls: ProviderToolCall[] = [];
  for (const index of [...partial.keys()].sort((a, b) => a - b)) {
    const fragment = partial.get(index);
    if (fragment === undefined) continue;
    if (fragment.name === undefined) {
      throw new ProviderError(
        "invalid-response",
        `a streamed tool call never named its function (fragment ${index})`,
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
