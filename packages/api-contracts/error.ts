// The one error envelope (`docs/INTERFACES_AND_API.md` §6, which defers to `SECURITY.md` §14 for "no provider bodies
// containing credentials"). The class list, the field list and the "no stack traces,
// no provider bodies with credentials" rule are all §6's; `code` is the stable machine-facing value because a status
// alone cannot tell "denied by policy" from "needs approval".
import { type Static, Type } from "@sinclair/typebox";
import { RequestId, TaskId } from "./ids.ts";

export const ERROR_CLASSES = [
  "validation",
  "auth",
  "policy",
  "not-found",
  "conflict",
  "rate-limit",
  "provider",
  "resource-limit",
  "platform-unsupported",
  "internal",
] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];

/** Dotted, lowercase, namespaced by the thing that failed: `approval.required`, `ext_host_api_unsupported`-style
 *  extension codes are D-072's. A pattern rather than a closed union on purpose — a new code is an addition, a new
 *  class is a change to this file and to the status mapping. */
export const ErrorCode = Type.String({ pattern: "^[a-z][a-z0-9_.-]{2,63}$" });

export const ErrorBody = Type.Object(
  {
    code: ErrorCode,
    message: Type.String({ minLength: 1, maxLength: 2000 }),
    class: Type.Union(ERROR_CLASSES.map((name) => Type.Literal(name))),
    retryable: Type.Boolean(),
    taskId: Type.Optional(TaskId),
    requestId: Type.Optional(RequestId),
    details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

export const ErrorEnvelope = Type.Object({ error: ErrorBody }, { additionalProperties: false });

export type ErrorBody = Static<typeof ErrorBody>;
export type ErrorEnvelope = Static<typeof ErrorEnvelope>;

/** A machine-readable error is worth nothing if the reader cannot tell what to do: `retryable` and `class` are
 *  required, so a builder that cannot say them is a bug and says so rather than guessing. */
export function errorEnvelope(input: {
  code: string;
  message: string;
  class: ErrorClass;
  retryable: boolean;
  taskId?: string;
  requestId?: string;
  details?: Record<string, unknown>;
}): ErrorEnvelope {
  const body: ErrorBody = {
    code: input.code,
    message: input.message,
    class: input.class,
    retryable: input.retryable,
  };
  if (input.taskId !== undefined) body.taskId = input.taskId;
  if (input.requestId !== undefined) body.requestId = input.requestId;
  if (input.details !== undefined) body.details = input.details;
  return { error: body };
}

/** The redaction the envelope makes possible: an `Error` carrying a provider body must never reach a client or a
 *  log line with its raw message if the message holds a credential-shaped value. Core's logger uses this, and
 *  `docs/DEVELOPMENT.md` §10 requires the redaction to have tests. */
export function isSecretShaped(text: string): boolean {
  return (
    /(api[_-]?key|secret|token|password|authorization|bearer)\s*[:=]\s*\S/i.test(text) ||
    /\b(sk|ghp|xox[baprs])-[A-Za-z0-9]{8,}\b/.test(text)
  );
}
