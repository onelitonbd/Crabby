// `mock/fake`, the reference provider §7 names: "one shared test set every adapter must pass … `mock/fake` implements
// it too, as the reference". It is the provider the whole test suite runs against, which makes it load-bearing in a way
// a normal mock is not — a fake that quietly ignores `ctx.signal` would let a cancellation test pass forever, and then
// the first real adapter would be the first code ever to prove the rule.
//
// So the fake is deliberately *complete* rather than minimal: it streams, it aborts mid-flight, it maps raw responses
// through the shared translator instead of throwing convenient errors, and it refuses its own unusable configuration.
// Everything a test wants to happen is scripted, and nothing else is invented — there is no default reply text, no
// simulated latency unless asked for, and no model that was not declared.

import type {
  CancellationHandle,
  GenerateResult,
  Provider,
  ProviderConfig,
  ProviderContext,
  ProviderRequest,
  StreamEvent,
  Usage,
} from "./contract.ts";
import { type ModelDescriptor, parseDescriptor } from "./descriptor.ts";
import { ProviderError, type ProviderErrorClass, translateProviderError } from "./errors.ts";

export const FAKE_MODEL_ID = "fake-small";
export const FAKE_TOOL_MODEL_ID = "fake-tools";

const BASE_DESCRIPTOR = {
  contextWindow: 8192,
  maxOutputTokens: 1024,
  supports: {
    streaming: true,
    toolCalling: false,
    parallelToolCalls: false,
    systemRole: true,
    structuredOutput: false,
    imageInput: false,
    audioInput: false,
    reasoning: false,
    promptCaching: false,
    jsonSchemaValidation: false,
  },
  cancellation: "supported",
  rateLimits: { rpm: 60, tpm: 20_000 },
  cost: "free-tier",
  batching: null,
} as const;

export type FakeStep =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "tool-call";
      readonly id?: string;
      readonly name: string;
      readonly arguments: Record<string, unknown>;
    }
  /** Thrown as a mapped error, from a class name, without pretending to know the provider's HTTP shape. */
  | { readonly kind: "fail"; readonly class: ProviderErrorClass; readonly message?: string }
  /** Run through `translateProviderError`, so an error-mapping test checks the translator and the adapter together. */
  | {
      readonly kind: "raw";
      readonly status: number;
      readonly body?: string;
      readonly retryAfterMs?: number;
    }
  /** A response body that cannot be parsed: the §3.5 `invalid-response` case, produced by shape and not by name. */
  | { readonly kind: "malformed"; readonly body: string }
  /** Yield this many deltas, then sit on the abort signal. Used by the cancellation tests. */
  | { readonly kind: "hang"; readonly afterText?: string }
  /** Truncate the stream after N deltas, ending it without a terminal event: the case a consumer must not read as done. */
  | { readonly kind: "truncate"; readonly afterText: string };

export interface FakeProviderOptions {
  readonly script?: readonly FakeStep[];
  readonly models?: readonly string[];
  readonly descriptors?: Readonly<Record<string, ModelDescriptor>>;
  /** Whether `cancel` exists at all, and what the descriptor claims about it. §3.1's "presence is not enough" rule is
   *  only testable if a fixture can be built that breaks it in each direction. */
  readonly cancellation?: ModelDescriptor["cancellation"];
  readonly id?: string;
  /** A per-tick delay, so a timeout test can make the fake slower than a deadline without `setTimeout(0)` races. */
  readonly tickMs?: number;
}

/**
 * How each §3.5 class is *produced* by the fake: a raw status and body, run through the shared translator, rather than
 * a thrown error assembled by hand. The difference is what the error-mapping area of the conformance suite is able to
 * see — if the fixture fabricated a `ProviderError("billing")` directly, the suite would test the fixture's
 * constructor instead of the mapping every real adapter depends on.
 */
export const FAILURE_PROJECTION: Readonly<
  Record<
    ProviderErrorClass,
    {
      status?: number;
      body?: string;
      retryAfterMs?: number;
      deadline?: "connect" | "first-token" | "stall";
    }
  >
> = {
  auth: { status: 401, body: "invalid api key" },
  "rate-limit": { status: 429, body: "quota window exceeded", retryAfterMs: 250 },
  overloaded: { status: 503, body: "upstream capacity" },
  timeout: { deadline: "first-token", body: "no first token" },
  "context-overflow": {
    status: 400,
    body: "this request exceeds the model maximum context length",
  },
  "unsupported-capability": { status: 400, body: "this endpoint does not support response_format" },
  "invalid-response": { body: "<html>502 bad gateway</html>" },
  "content-filter": { status: 400, body: "your input was blocked by the content filter" },
  billing: { status: 402, body: "insufficient credits" },
  cancelled: {},
};

export interface FakeCall {
  readonly requestId: string;
  readonly modelId: string;
  readonly messages: readonly unknown[];
  readonly tools?: readonly string[];
  readonly attempt?: number;
  /** Mutable on purpose: the record starts as "in flight" and a cancellation marks it, so a test can assert the
   *  adapter noticed the abort rather than asserting it returned something. */
  aborted: boolean;
}

function usageFor(text: string, input: readonly unknown[]): Usage {
  return {
    inputTokens: Math.ceil(JSON.stringify(input).length / 4),
    outputTokens: Math.ceil(text.length / 4),
  };
}

export class FakeProvider implements Provider {
  readonly id: string;
  readonly calls: FakeCall[] = [];
  readonly cancellations: string[] = [];
  private readonly script: readonly FakeStep[];
  private readonly models: readonly string[];
  private readonly descriptors: Readonly<Record<string, ModelDescriptor>>;
  private readonly options: FakeProviderOptions;
  private readonly controllers = new Map<string, AbortController>();
  private failure: ProviderErrorClass | undefined;
  /** Set once per request id; a second call must not inherit an abort from the first. */
  private readonly aborted = new Set<string>();

  constructor(options: FakeProviderOptions = {}) {
    this.options = options;
    this.id = options.id ?? "fake";
    this.script = options.script ?? [{ kind: "text", text: "" }];
    this.models = options.models ?? [FAKE_MODEL_ID, FAKE_TOOL_MODEL_ID];
    this.descriptors =
      options.descriptors ??
      Object.fromEntries(
        this.models.map((modelId) => {
          const descriptor = {
            ...BASE_DESCRIPTOR,
            supports: {
              ...BASE_DESCRIPTOR.supports,
              // The tool-capable model is the one a tool-calling test uses, so the claim follows the script rather
              // than the fixture's name.
              toolCalling: modelId === FAKE_TOOL_MODEL_ID,
              parallelToolCalls: modelId === FAKE_TOOL_MODEL_ID,
            },
            cancellation: options.cancellation ?? BASE_DESCRIPTOR.cancellation,
          };
          const parsed = parseDescriptor(descriptor);
          if (!parsed.ok)
            throw new Error(`the fixture's own descriptor is invalid: ${parsed.reason}`);
          return [modelId, parsed.descriptor];
        }),
      );
  }

  describe(): Readonly<Record<string, ModelDescriptor>> {
    return this.descriptors;
  }

  listModels(): readonly string[] {
    return this.models;
  }

  validateConfig(config: ProviderConfig): { ok: true } | { ok: false; reason: string } {
    // Not "anything goes because it is a fake": §3.1 requires rejection of unusable configuration with an actionable
    // reason, and the fake is the reference implementation of that requirement.
    if (typeof config?.baseUrl !== "string" || config.baseUrl === "") {
      return {
        ok: false,
        reason: "'baseUrl' is required: without it there is no endpoint to call",
      };
    }
    let url: URL;
    try {
      url = new URL(config.baseUrl);
    } catch {
      return { ok: false, reason: `'baseUrl' is not a URL (${config.baseUrl})` };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { ok: false, reason: `'baseUrl' must be http(s), got '${url.protocol}'` };
    }
    if (config.apiKey !== undefined && typeof config.apiKey !== "string") {
      return { ok: false, reason: "'apiKey' must be a string when present" };
    }
    if (config.headers !== undefined) {
      const bad = Object.entries(config.headers).filter(([, value]) => typeof value !== "string");
      if (bad.length > 0)
        return {
          ok: false,
          reason: `'headers' values must be strings (${bad.map(([k]) => k).join(", ")})`,
        };
    }
    const unknown = Object.keys(config).filter(
      (key) => !["baseUrl", "apiKey", "headers"].includes(key),
    );
    if (unknown.length > 0) {
      return { ok: false, reason: `unknown configuration field(s): ${unknown.join(", ")}` };
    }
    return { ok: true };
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /** Swap the script for the next calls. Only the conformance suite's declared-failure-mode path needs this, and it
   *  is a method rather than a constructor option so one fixture instance can walk all ten classes. */
  setFailure(errorClass: ProviderErrorClass | undefined): void {
    this.failure = errorClass;
  }

  async cancel(handle: CancellationHandle): Promise<void> {
    this.cancellations.push(handle.requestId);
    this.aborted.add(handle.requestId);
    this.controllers.get(handle.requestId)?.abort();
  }

  async generate(request: ProviderRequest, ctx: ProviderContext): Promise<GenerateResult> {
    const events: StreamEvent[] = [];
    for await (const event of this.#run(request, ctx)) {
      events.push(event);
    }
    const terminal = events.at(-1);
    if (terminal?.type === "error") throw terminal.error;
    if (terminal?.type === "cancelled") {
      throw new ProviderError("cancelled", "the request was cancelled", { attempt: ctx.attempt });
    }
    if (terminal?.type !== "done") {
      // A stream that ends without a terminal event is the truncated-response case, and §4.4's rule that "a tool must
      // not pretend a partial result is complete" applies to completions too.
      throw new ProviderError("invalid-response", "the response ended without a terminal state", {
        raw: terminal,
      });
    }
    return {
      text: events
        .filter((event) => event.type === "delta")
        .map((event) => (event as { text: string }).text)
        .join(""),
      usage: terminal.usage,
      toolCalls: events
        .filter((event) => event.type === "tool-call")
        .map((event) => ({
          id: (event as { id: string }).id,
          name: (event as { name: string }).name,
          arguments: (event as { arguments: Record<string, unknown> }).arguments,
        })),
      finishReason: terminal.finishReason,
    };
  }

  stream(request: ProviderRequest, ctx: ProviderContext): AsyncIterable<StreamEvent> {
    return {
      [Symbol.asyncIterator]: () => this.#run(request, ctx)[Symbol.asyncIterator](),
    };
  }

  /** The single place the script becomes events, so `generate` and `stream` cannot disagree about a terminal state —
   *  which is exactly the property §3.1 requires of every adapter ("MUST surface the same terminal states"). */
  async *#run(request: ProviderRequest, ctx: ProviderContext): AsyncGenerator<StreamEvent> {
    const controller = new AbortController();
    this.controllers.set(ctx.requestId, controller);
    const signal = mergeSignals(ctx.signal, controller.signal);
    const call: FakeCall = {
      requestId: ctx.requestId,
      modelId: request.modelId,
      messages: request.messages,
      ...(request.tools ? { tools: request.tools.map((tool) => tool.name) } : {}),
      ...(ctx.attempt !== undefined ? { attempt: ctx.attempt } : {}),
      aborted: false,
    };
    this.calls.push(call);

    let text = "";
    let finishReason: "done" | "length" | "tool-calls" | "content-filter" = "done";
    const descriptor = this.descriptors[request.modelId];
    if (!descriptor) {
      // An unknown model is a discovery failure, not a completion: §4.3 requires re-validation of a newly seen model's
      // descriptor, and refusing here is where that lands for the fake.
      throw new ProviderError(
        "unsupported-capability",
        `'${request.modelId}' is not a model this provider declares`,
      );
    }
    if (request.tools && request.tools.length > 0 && !descriptor.supports.toolCalling) {
      throw new ProviderError(
        "unsupported-capability",
        `'${request.modelId}' does not declare toolCalling, so tools cannot be offered to it`,
      );
    }

    if (this.failure !== undefined) {
      const projection = FAILURE_PROJECTION[this.failure];
      if (this.failure === "cancelled") {
        call.aborted = true;
        yield { type: "cancelled" };
        return;
      }
      yield {
        type: "error",
        error: translateProviderError({ ...projection, attempt: ctx.attempt }),
      };
      return;
    }
    for (const step of this.script) {
      if (signal.aborted || this.aborted.has(ctx.requestId)) {
        call.aborted = true;
        yield { type: "cancelled" };
        return;
      }
      switch (step.kind) {
        case "text": {
          for (const piece of chunk(step.text)) {
            if (signal.aborted) {
              call.aborted = true;
              yield { type: "cancelled" };
              return;
            }
            await tick(this.options.tickMs ?? 0, signal);
            text += piece;
            yield { type: "delta", text: piece };
          }
          break;
        }
        case "tool-call": {
          if (!descriptor.supports.toolCalling) {
            throw new ProviderError(
              "unsupported-capability",
              "the model produced a tool call without declaring toolCalling",
            );
          }
          finishReason = "tool-calls";
          yield {
            type: "tool-call",
            id: step.id ?? `call_${this.calls.length}`,
            name: step.name,
            arguments: step.arguments,
          };
          break;
        }
        case "fail":
          yield {
            type: "error",
            error: new ProviderError(
              step.class,
              step.message ?? `the fake failed with ${step.class}`,
            ),
          };
          return;
        case "raw":
          yield {
            type: "error",
            error: translateProviderError({
              status: step.status,
              ...(step.body === undefined ? {} : { body: step.body }),
              ...(step.retryAfterMs === undefined ? {} : { retryAfterMs: step.retryAfterMs }),
            }),
          };
          return;
        // A body that cannot be parsed, mapped the way an adapter would map it: through the translator, with no
        // status. An empty scripted reply, by contrast, is a legitimate `done` with no deltas.
        case "malformed":
          yield { type: "error", error: translateProviderError({ body: step.body }) };
          return;
        case "hang": {
          if (step.afterText !== undefined) {
            text += step.afterText;
            yield { type: "delta", text: step.afterText };
          }
          // A signal that is *already* aborted never fires a listener, so the wait has to look before it sleeps. This
          // is the mistake a real adapter makes too, and it costs a task that never settles: the timeout wrapper would
          // be the only thing to notice, 60 s later.
          if (!signal.aborted) {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 60_000);
              const stop = () => {
                clearTimeout(timer);
                resolve();
              };
              signal.addEventListener("abort", stop, { once: true });
            });
          }
          if (signal.aborted || this.aborted.has(ctx.requestId)) {
            call.aborted = true;
            yield { type: "cancelled" };
            return;
          }
          break;
        }
        case "truncate": {
          text += step.afterText;
          yield { type: "delta", text: step.afterText };
          return;
        }
      }
    }
    yield { type: "done", usage: usageFor(text, request.messages), finishReason };
    this.controllers.delete(ctx.requestId);
  }
}

function chunk(text: string, size = 8): string[] {
  if (text === "") return [];
  const pieces: string[] = [];
  for (let at = 0; at < text.length; at += size) pieces.push(text.slice(at, at + size));
  return pieces;
}

async function tick(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) {
    await Promise.resolve();
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    const stop = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", stop, { once: true });
  });
}

function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const merged = new AbortController();
  for (const source of [a, b]) {
    if (source.aborted) merged.abort();
    else source.addEventListener("abort", () => merged.abort(), { once: true });
  }
  return merged.signal;
}

/**
 * Build a copy of an adapter with one member removed, or with members replaced. Both helpers copy inherited methods
 * as well as own fields — a class instance's `generate` lives on the prototype, so `{ ...provider }` would silently
 * produce an adapter that is missing *everything*, and a fixture meant to be wrong in one way would be wrong in six.
 */
function memberNames(target: object): string[] {
  const names = new Set<string>();
  let current: object | null = target;
  while (current !== null && current !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(current)) {
      if (name !== "constructor") names.add(name);
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return [...names];
}

export function withOverrides<T extends keyof Provider>(
  provider: Provider,
  overrides: Partial<Pick<Provider, T>>,
): Provider {
  const copy: Record<string, unknown> = {};
  for (const name of memberNames(provider)) {
    const value = (provider as unknown as Record<string, unknown>)[name];
    copy[name] =
      typeof value === "function" ? (value as (...args: never[]) => unknown).bind(provider) : value;
  }
  for (const [name, value] of Object.entries(overrides)) copy[name] = value;
  return copy as unknown as Provider;
}

export function withoutMethod(provider: Provider, member: string): Provider {
  const copy: Record<string, unknown> = {};
  for (const name of memberNames(provider)) {
    if (name === member) continue;
    const value = (provider as unknown as Record<string, unknown>)[name];
    copy[name] =
      typeof value === "function" ? (value as (...args: never[]) => unknown).bind(provider) : value;
  }
  return copy as unknown as Provider;
}

export const FAKE_CONFIG: ProviderConfig = { baseUrl: "http://127.0.0.1:1/v1", apiKey: "fake-key" };
