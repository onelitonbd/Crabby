// The wire machinery every adapter shares, extracted from `openai.ts` when the second adapter was written — the same
// reason `packages/platform` owns `clip`: two copies of the deadline grammar would be two answers to §3.5's
// "connect, first-token and stall are distinguishable", and the day one copy learned something the other did not, a
// task would time out on one provider and hang on another. What lives here is exactly the part that is *not* a
// family's wire shape: the deadline guard, the in-flight table that lets `cancel(handle)` reach a socket, §3.8's
// override-note on a failed capability, and the failure translation that turns an abort, a tripped deadline, an HTTP
// status or a dead connection into §3.5's classes. What stays in each adapter is its body builder, its SSE/NDJSON
// parse, and its `finish_reason` table — the parts that genuinely differ.
//
// The decisions recorded in D-100 about this machinery carry over unchanged: three deadlines belong to the adapter
// (armed from D-074's numbers, read out of `packages/core`, never retyped), the absolute one belongs to the runtime
// (`ctx.timeoutMs`), and `cancellation` is `best-effort` because closing our side of a socket is all an adapter can
// honestly do.

import { LIMITS_DEFAULTS } from "@crabby/core";
import type { ProviderContext, ProviderRequest } from "./contract.ts";
import type { ModelDescriptor, SupportedFeature } from "./descriptor.ts";
import { ProviderError, translateProviderError } from "./errors.ts";
import type { OverrideProvenance } from "./override.ts";

export type DeadlineName = "connect" | "first-token" | "stall" | "absolute";

export interface WireDeadlines {
  readonly connectMs: number;
  readonly firstTokenMs: number;
  readonly idleStreamMs: number;
}

/** D-074's three adapter-observable provider deadlines, read from `packages/core` rather than copied: a second copy of
 *  a decided number is a number that drifts from the one `crabby config get limits` prints. */
export const WIRE_DEADLINE_DEFAULTS: WireDeadlines = {
  connectMs: LIMITS_DEFAULTS.providerConnectMs,
  firstTokenMs: LIMITS_DEFAULTS.providerFirstTokenMs,
  idleStreamMs: LIMITS_DEFAULTS.providerIdleStreamMs,
};

export interface InFlight {
  readonly controller: AbortController;
  /** Set by `cancel(handle)`, and the only way an adapter can tell its own abort from a deadline that tripped: both
   *  arrive as an aborted signal, but §3.5 gives them different classes and different retry stories. */
  cancelledByAdapter: boolean;
}

export interface Guard {
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
export function guardFor(
  ctx: ProviderContext,
  deadlines: WireDeadlines,
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

/** The in-flight table behind `cancel(handle)`: requests by the runtime's request id, so §4.2's controlled parallelism
 *  can have more than one open at once and an adapter-side cancellation still reaches the right socket. */
export function createInFlightTable() {
  const table = new Map<string, InFlight>();
  return {
    /** Registered before the fetch and read at every failure site, because the case that needs the flag most is a
     *  rejection *during* the fetch — an adapter-side `cancel()` that lands before any header arrived. Reading it only
     *  after the response would report that cancellation as a transport failure, which is what it is not. */
    begin(
      ctx: ProviderContext,
      guard: Guard,
    ): { readonly entry: InFlight; readonly dispose: () => void } {
      const entry: InFlight = { controller: new AbortController(), cancelledByAdapter: false };
      table.set(ctx.requestId, entry);
      const onGuardAbort = (): void => entry.controller.abort();
      if (guard.signal.aborted) entry.controller.abort();
      else guard.signal.addEventListener("abort", onGuardAbort, { once: true });
      return {
        entry,
        dispose: () => {
          guard.signal.removeEventListener("abort", onGuardAbort);
          // Compared by identity before deleting: a late `dispose` must not remove the entry a *later* request under the
          // same id just registered, which would leave that one unreachable to `cancel()`.
          if (table.get(ctx.requestId) === entry) table.delete(ctx.requestId);
        },
      };
    },
    cancel(requestId: string): boolean {
      const entry = table.get(requestId);
      if (entry === undefined) return false;
      entry.cancelledByAdapter = true;
      entry.controller.abort();
      return true;
    },
  };
}

/** The classes that mean *the endpoint answered and the answer was not usable* — see `withOverrideNote` for why this is
 *  an allow-list and why `overloaded`, `timeout`, `context-overflow` and `cancelled` are not in it. */
export const CAPABILITY_FAILURE_CLASSES: ReadonlySet<string> = new Set([
  "unsupported-capability",
  "invalid-response",
  "content-filter",
  "billing",
  "auth",
]);

/** What this request exercised, in §3.2's vocabulary, read off the request rather than kept in a list beside the wire
 *  builder — a capability list that can drift from the code that sends the request is the same second-opinion problem
 *  as a parallel descriptor. **It covers the capabilities `ProviderRequest` can currently express**, which is tools and
 *  the system role: the contract's `content` is a string and it has no `responseFormat`, so image input and structured
 *  output are not expressible yet and this function does not pretend to know about them. When they arrive, this is the
 *  one place that learns it. */
export function featuresUsedBy(request: ProviderRequest): readonly SupportedFeature[] {
  const used: SupportedFeature[] = [];
  if (request.tools !== undefined && request.tools.length > 0) used.push("toolCalling");
  if (request.messages.some((message) => message.role === "system")) used.push("systemRole");
  return used;
}

/** §3.8: "when a forced-on capability fails, Crabby must report `toolCalling` was declared by override and failed
 *  rather than fall back silently". Two conditions, and the second is the one that keeps the sentence honest.
 *
 *  **Only for a capability the call actually used** — the adapter knows what it sent, and attributing a failure to a
 *  capability the request never exercised would blame an override for something else entirely.
 *
 *  **Only for a non-retryable class.** `overloaded` and `timeout` are the endpoint being busy, which is no evidence at
 *  all about whether a declared capability works; printing the sentence there would report a broken capability on every
 *  slow Tuesday, and a sentence that fires often enough to be ignored is worse than none. §3.5's retry table is the
 *  authority on which classes are transient.
 *
 *  The original error's class, `raw` and attempt are carried through, so the ladder's retry decision and the audit
 *  record are unchanged — this is a message about *why*, added to the same failure rather than a new failure. */
export function withOverrideNote(
  error: ProviderError,
  request: ProviderRequest | undefined,
  overrides: Readonly<Record<string, OverrideProvenance>> | undefined,
): ProviderError {
  if (request === undefined) return error;
  // An **allow-list**, because the question is not "is this retryable" but "does this class mean the endpoint answered
  // and the answer was not usable" (see `CAPABILITY_FAILURE_CLASSES`).
  if (!CAPABILITY_FAILURE_CLASSES.has(error.class)) return error;
  const provenance = overrides?.[request.modelId];
  if (provenance === undefined) return error;
  for (const feature of featuresUsedBy(request)) {
    const move = provenance.supports?.[feature];
    // `to: true` is the forced-on half. A capability the user forced **off** cannot be the reason a request failed,
    // because nothing was sent that needed it — and §3.8 is explicit that forcing off is never argued about.
    if (move === undefined || move.to !== true) continue;
    return new ProviderError(
      error.class,
      `${error.message} — \`${feature}\` was declared by override and failed (§3.8: the endpoint reported ${String(
        move.from,
      )}, the user declared true, and the call that used it did not succeed); that feeds §3.5's \`unsupported-capability\``,
      { ...(error.raw === undefined ? {} : { raw: error.raw }), attempt: error.attempt },
    );
  }
  return error;
}

/** The shared failure translation: an abort is a cancellation, a tripped deadline names itself, an HTTP status goes
 *  through `errors.ts`'s table (with §3.8's note when an override forced the capability on), and a transport error is
 *  `overloaded` because §3.5 has no "unreachable" class and a refused connection is the retryable-and-escalating kind
 *  of failure — D-043's ladder bounds it, and `invalid-response` would put a dead endpoint in the same bucket as a
 *  malformed body, which the ladder treats differently. */
export function translateFailure(input: {
  ctx: ProviderContext;
  guard: Guard;
  error: unknown;
  adapterCancelled: boolean;
  endpoint: string;
  overrides?: Readonly<Record<string, OverrideProvenance>> | undefined;
  status?: number | undefined;
  body?: string | undefined;
  retryAfterMs?: number | undefined;
  request?: ProviderRequest | undefined;
}): ProviderError {
  if (input.adapterCancelled || input.ctx.signal.aborted) {
    return translateProviderError({ aborted: true, attempt: input.ctx.attempt });
  }
  const tripped = input.guard.tripped();
  if (tripped !== undefined) {
    return translateProviderError({ deadline: tripped, attempt: input.ctx.attempt });
  }
  if (input.status !== undefined) {
    return withOverrideNote(
      translateProviderError({
        status: input.status,
        ...(input.body === undefined ? {} : { body: input.body }),
        ...(input.retryAfterMs === undefined ? {} : { retryAfterMs: input.retryAfterMs }),
        attempt: input.ctx.attempt,
      }),
      input.request,
      input.overrides,
    );
  }
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  return new ProviderError(
    "overloaded",
    `the endpoint at ${input.endpoint} could not be reached: ${message}`,
    { raw: message, attempt: input.ctx.attempt },
  );
}

export function retryAfterFrom(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (header === null) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** §3.1: "the capability must be declared in describe()" — and a request for a model with no descriptor at all is the
 *  same refusal in a different voice: the runtime may not invent a descriptor for a model nobody priced (§3.2), and
 *  §3.8 is where a user adds or corrects one. Shared because the sentence is the conformance suite's expectation in
 *  every family, not this or that wire's. */
export function requireDescriptor(
  descriptors: Readonly<Record<string, ModelDescriptor>>,
  modelId: string,
): ModelDescriptor {
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

/** The tools half of the same rule: sending tools to a model that does not declare them would produce a completion that
 *  silently ignored them, which the loop would read as "the model chose not to call a tool" — the most expensive kind
 *  of wrong answer. */
export function refuseUndeclaredTools(request: ProviderRequest, descriptor: ModelDescriptor): void {
  if (
    request.tools !== undefined &&
    request.tools.length > 0 &&
    descriptor.supports.toolCalling !== true
  ) {
    throw new ProviderError(
      "unsupported-capability",
      `'${request.modelId}' does not declare toolCalling, so ${String(request.tools.length)} tool(s) were refused ` +
        "rather than sent to be ignored (§3.2: a declared-but-broken capability is a bug, and an undeclared one is a refusal)",
    );
  }
}
