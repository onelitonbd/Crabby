// §3.5's taxonomy, as the single place a raw provider response becomes one of these ten classes, plus D-064's retry
// schedule. Adapters share this file rather than each mapping their own status codes, because the classes are
// "provider-independent" by the section's own title: a `429` from Groq and a `429` from OpenRouter must produce the
// same behaviour downstream, and the divergence would be invisible until a phone stopped retrying.
//
// Two properties the taxonomy depends on and that the exports keep close to the data:
//
//   - Retryability is a *class* property, not a caller preference. `context-overflow` is retryable only after
//     compaction, and `invalid-response` "sometimes"; both are encoded as `'after'` / `'sometimes'` rather than
//     collapsed into `true`, so a retry loop has to say what it is doing.
//   - `cancelled` is terminal, "not an error worth retrying", so it is `false` here and the conformance suite asserts
//     that no amount of backoff is scheduled for it.

export const PROVIDER_ERROR_CLASSES = [
  "auth",
  "rate-limit",
  "overloaded",
  "timeout",
  "context-overflow",
  "unsupported-capability",
  "invalid-response",
  "content-filter",
  "billing",
  "cancelled",
] as const;

export type ProviderErrorClass = (typeof PROVIDER_ERROR_CLASSES)[number];

/** §3.5's "Retryable" column. `after` names the condition the row states, so a caller cannot read it as a plain yes. */
export const RETRYABILITY: Record<ProviderErrorClass, false | true | "after" | "sometimes"> = {
  auth: false,
  "rate-limit": true,
  overloaded: true,
  timeout: true,
  "context-overflow": "after",
  "unsupported-capability": false,
  "invalid-response": "sometimes",
  "content-filter": false,
  billing: false,
  cancelled: false,
};

export const RETRY_NOTE: Record<ProviderErrorClass, string> = {
  auth: "message must name the credential, never show it",
  "rate-limit": "honor provider hints; surface remaining quota when provided",
  overloaded: "bounded; escalate after N attempts",
  timeout: "distinguish connect vs first-token vs stall",
  "context-overflow": "retry only after compaction (§3.4)",
  "unsupported-capability": "flag the descriptor for review and report to the user",
  "invalid-response": "keep the raw fragment in the audit record, redacted",
  "content-filter": "distinguish from a model failure",
  billing: "out of credit or a paid tier is required",
  cancelled: "terminal, not an error worth retrying",
};

/** D-064, closing O-029: five waits, doubling, capped — and a provider hint moves a wait up, never down. */
export const RETRY_SCHEDULE_MS: readonly number[] = [1000, 2000, 4000, 8000, 16000];
export const JITTER_FACTOR = 0.25;
export const MAX_ATTEMPTS = RETRY_SCHEDULE_MS.length + 1;

export class ProviderError extends Error {
  readonly class: ProviderErrorClass;
  /** The provider's own words, secrets already stripped by the caller that logs it (§3.1's rule that raw bodies live
   *  in the audit record, not in this message). */
  readonly raw?: unknown;
  readonly retryAfterMs?: number | undefined;
  /** Which deadline tripped, for `timeout`: §3.5 asks that connect, first-token, and stall be distinguishable, and a
   *  ladder that cannot tell them apart retries the wrong thing (§4.4). */
  readonly deadline?: "connect" | "first-token" | "stall" | undefined;
  readonly attempt: number;

  constructor(
    errorClass: ProviderErrorClass,
    message: string,
    // Every option is written `T | undefined` rather than left optional, because `exactOptionalPropertyTypes` is on in
    // this repository: callers here pass values they read off other optional fields, and a caller should not have to
    // branch on `undefined` to avoid a type error.
    options: {
      raw?: unknown;
      retryAfterMs?: number | undefined;
      deadline?: ProviderError["deadline"] | undefined;
      attempt?: number | undefined;
    } = {},
  ) {
    super(message);
    this.name = `ProviderError`;
    this.class = errorClass;
    this.raw = options.raw;
    this.retryAfterMs = options.retryAfterMs;
    this.deadline = options.deadline;
    this.attempt = options.attempt ?? 1;
  }

  get retryable(): boolean {
    const rule = RETRYABILITY[this.class];
    // A retry of the *same* request cannot fix a context overflow, so the class is not retryable from here; the
    // runtime's compaction step re-enters the call and the flag stays informational.
    return rule === true || rule === "sometimes";
  }
}

/**
 * The wait before attempt `attempt` (1-based). `random` is injected for the same reason `now` is injected in policy: a
 * jittered schedule that a test cannot pin down is a schedule nobody verifies, and "jitter is not decoration" is only
 * true if the bounds are asserted.
 */
export function retryDelayMs(
  attempt: number,
  providerRetryAfterMs?: number,
  random: () => number = Math.random,
): { ms: number; source: "schedule" | "provider-hint" } {
  const last = RETRY_SCHEDULE_MS.length - 1;
  const base = RETRY_SCHEDULE_MS[Math.min(attempt - 1, last)] ?? RETRY_SCHEDULE_MS[last] ?? 1000;
  const drift = (random() * 2 - 1) * JITTER_FACTOR * base;
  const scheduled = Math.max(0, Math.round(base + drift));
  // "overrides the schedule upward for that attempt": a shorter `Retry-After` is ignored, because the provider asked
  // for a specific window and a client that shaves it down is a client that keeps getting 429s.
  if (providerRetryAfterMs !== undefined && providerRetryAfterMs > scheduled) {
    return { ms: Math.round(providerRetryAfterMs), source: "provider-hint" };
  }
  return { ms: scheduled, source: "schedule" };
}

export function shouldRetry(error: ProviderError, attempt: number): boolean {
  if (error.class === "cancelled") return false;
  if (!error.retryable) return false;
  return attempt < MAX_ATTEMPTS;
}

/** The HTTP/status mapping every family shares. Kept as a table, because an adapter's `if (status === 429)` chain is
 *  where a class quietly goes missing — and a missing class means an untranslatable raw body in front of a user. */
const STATUS_CLASSES: readonly {
  readonly test: (status: number) => boolean;
  readonly class: ProviderErrorClass;
}[] = [
  { test: (s) => s === 401 || s === 403, class: "auth" },
  { test: (s) => s === 402, class: "billing" },
  { test: (s) => s === 429, class: "rate-limit" },
  { test: (s) => s === 413, class: "context-overflow" },
  { test: (s) => s === 408, class: "timeout" },
  { test: (s) => s >= 500, class: "overloaded" },
];

export function classifyStatus(status: number, body?: string): ProviderErrorClass {
  const text = (body ?? "").toLowerCase();
  // Several providers report a context overflow as a 400 with prose, which is the one case where the body is the
  // authoritative signal; checking it first for those words costs nothing and prevents a 400 from becoming
  // `invalid-response`, which is retryable and would loop.
  if (/context length|too long|maximum context|exceeds the model/.test(text))
    return "context-overflow";
  if (/content filter|safety|blocked by policy|flagged/.test(text)) return "content-filter";
  if (/does not support|not supported|unsupported/.test(text)) return "unsupported-capability";
  if (/exceeded your current quota|insufficient credits|payment required|billing/.test(text))
    return "billing";
  for (const entry of STATUS_CLASSES) if (entry.test(status)) return entry.class;
  if (status >= 400 && status < 500) return "invalid-response";
  return "overloaded";
}

/** One entry point, so an adapter that forgets to translate also forgets to invent a class. */
export function translateProviderError(input: {
  status?: number | undefined;
  body?: string | undefined;
  retryAfterMs?: number | undefined;
  deadline?: ProviderError["deadline"] | undefined;
  aborted?: boolean | undefined;
  attempt?: number | undefined;
}): ProviderError {
  if (input.aborted) {
    return new ProviderError("cancelled", "the request was cancelled", { attempt: input.attempt });
  }
  if (input.deadline) {
    return new ProviderError("timeout", `the ${input.deadline} deadline was exceeded`, {
      deadline: input.deadline,
      attempt: input.attempt,
    });
  }
  if (input.status === undefined) {
    return new ProviderError("invalid-response", "the provider response could not be parsed", {
      raw: input.body,
      attempt: input.attempt,
    });
  }
  const errorClass = classifyStatus(input.status, input.body);
  const message =
    errorClass === "auth"
      ? `the provider rejected the configured credential (HTTP ${input.status})`
      : errorClass === "rate-limit"
        ? `the provider is rate-limiting this request (HTTP 429)${input.retryAfterMs ? `, retry after ${input.retryAfterMs} ms` : ""}`
        : `the provider returned HTTP ${input.status}${input.body ? `: ${input.body.slice(0, 200)}` : ""}`;
  return new ProviderError(errorClass, message, {
    raw: input.body,
    retryAfterMs:
      errorClass === "rate-limit" || errorClass === "overloaded" ? input.retryAfterMs : undefined,
    attempt: input.attempt,
  });
}
