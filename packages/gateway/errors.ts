// The one place a class becomes a number. `docs/INTERFACES_AND_API.md` §6 says "HTTP status maps from the class" and
// then prints no table, which left two Gateways both defensible and no test able to say which was wrong — so the map
// is now written down here *and* in §6, and the contract test asserts every class in the union appears in it.
import { ERROR_CLASSES, type ErrorBody, errorEnvelope } from "@crabby/api-contracts";

export const STATUS_BY_CLASS: Readonly<Record<ErrorBody["class"], number>> = {
  validation: 400,
  auth: 401,
  policy: 403,
  "not-found": 404,
  conflict: 409,
  "rate-limit": 429,
  provider: 502,
  "resource-limit": 507,
  "platform-unsupported": 501,
  internal: 500,
};

export function statusForClass(name: string): number {
  return (STATUS_BY_CLASS as Record<string, number>)[name] ?? STATUS_BY_CLASS.internal;
}

export interface GatewayErrorInput {
  readonly code: string;
  readonly message: string;
  readonly class: ErrorBody["class"];
  readonly retryable?: boolean;
  readonly details?: Record<string, unknown>;
  readonly taskId?: string;
  readonly requestId?: string;
}

export class GatewayError extends Error {
  readonly body: ErrorBody;

  constructor(input: GatewayErrorInput) {
    super(input.message);
    this.name = "GatewayError";
    // `retryable` is required by the envelope builder on purpose (§6: a client branches on it), so an error that
    // cannot say whether a retry helps says `false`, which is the answer that never causes a retry storm.
    this.body = errorEnvelope({ ...input, retryable: input.retryable ?? false }).error;
  }

  get status(): number {
    return statusForClass(this.body.class);
  }
}

export function notFound(what: string, requestId?: string): GatewayError {
  return new GatewayError({
    code: "not_found",
    // §3.1: an unauthenticated caller must not learn which routes exist. The message says the same thing for a
    // missing id and for a path nobody recognises, and offers the one place that is always true.
    message: `${what} was not found. \`GET /api/v1/health\` answers for a live Gateway.`,
    class: "not-found",
    retryable: false,
    ...(requestId === undefined ? {} : { requestId }),
  });
}

export function validationError(
  problems: { path: string; message: string; kind: string }[],
  requestId?: string,
): GatewayError {
  return new GatewayError({
    code: "validation_failed",
    message:
      problems.map((p) => `${p.path || "<body>"} ${p.message}`).join("; ") ||
      "the request did not validate",
    class: "validation",
    retryable: false,
    details: { problems },
    ...(requestId === undefined ? {} : { requestId }),
  });
}

export function authError(
  reason: "missing" | "invalid" | "expired_or_revoked",
  requestId?: string,
): GatewayError {
  return new GatewayError({
    code: reason === "missing" ? "auth_missing" : "auth_invalid",
    message:
      reason === "missing"
        ? "no bearer token was supplied; pair this client with `crabby auth pair`"
        : "the token is not one this Gateway recognises; `crabby auth pair` mints a new one",
    class: "auth",
    retryable: false,
    ...(requestId === undefined ? {} : { requestId }),
  });
}

export const ERROR_CLASS_COUNT = ERROR_CLASSES.length;
