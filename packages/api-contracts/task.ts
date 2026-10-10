// Task records and the create/list shapes behind M1's exit condition — "a task can be created and read back with an
// id, and nothing else" (`docs/ROADMAP.md` §3's exit line). The nine states are `AGENT_RUNTIME.md` §4.1's initial
// lifecycle; transition rules are the runtime's business (M2) and deliberately not encoded here, because a contract
// that restates the state machine becomes a second state machine.
import { type Static, Type } from "@sinclair/typebox";
import { SessionId, TaskId } from "./ids.ts";

export const TASK_STATES = [
  "queued",
  "planning",
  "awaiting_approval",
  "running",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

/** The three `AGENT_RUNTIME.md` §4.1 insists a runtime must keep apart: success is not cancellation, which is not
 *  failure, which is not incomplete execution. `terminal` is that distinction as data. */
export const TERMINAL_STATES = [
  "completed",
  "failed",
  "cancelled",
] as const satisfies readonly TaskState[];
export const INCOMPLETE_STATES = [
  "interrupted",
  "cancelling",
  "awaiting_approval",
] as const satisfies readonly TaskState[];

export function isTerminal(state: TaskState): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

/** §6.1's policy and §6.2's override, as the two names a client can send and read. The names live here and the rules live
 *  in `packages/agent-runtime/cancellation.ts` (D-090), which is D-083's split applied a second time: a contract that
 *  restated "wait for the step to finish" would be a second cancellation manager. */
export const CANCELLATION_MODES = ["finish-step", "immediate"] as const;
export type CancellationMode = (typeof CANCELLATION_MODES)[number];

/** What was running when the request arrived. D-089 records this beside the two booleans because "a provider call was in
 *  flight" and "a tool was in flight" are why `effectsUncertain` differs, and a reader who disagrees with the
 *  classification has to be able to see which one was made. */
export const CANCELLATION_IN_FLIGHT = ["none", "provider", "tool"] as const;
export type CancellationInFlight = (typeof CANCELLATION_IN_FLIGHT)[number];

/** The outcome of a cancellation, on the record rather than only in the log: §6.2 requires that where an external action
 *  may already have taken effect "that uncertainty MUST be recorded explicitly on the task", and §5.2's recovery rule
 *  makes the task route the place a client that missed the event looks. Written once, at the settle (F-46). */
export const TaskCancellation = Type.Object(
  {
    mode: Type.Union(CANCELLATION_MODES.map((name) => Type.Literal(name))),
    requestedAt: Type.String({ format: "date-time" }),
    settledAt: Type.String({ format: "date-time" }),
    /** §6.2's distinction: the operation reported that it stopped, which is not the same fact as the runtime ceasing to
     *  wait for it (D-089). */
    terminated: Type.Boolean(),
    effectsUncertain: Type.Boolean(),
    inFlight: Type.Union(CANCELLATION_IN_FLIGHT.map((name) => Type.Literal(name))),
    by: Type.Optional(Type.String()),
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type TaskCancellation = Static<typeof TaskCancellation>;

export const TaskRecord = Type.Object(
  {
    id: TaskId,
    sessionId: SessionId,
    state: Type.Union(TASK_STATES.map((name) => Type.Literal(name))),
    /** §4.3 names this field *objective*. A maximum length is a `limits.*` concern (D-074), not a type
     *  concern, so the contract sets no ceiling here. */
    objective: Type.String({ minLength: 1 }),
    createdAt: Type.String({ format: "date-time" }),
    updatedAt: Type.String({ format: "date-time" }),
    /** The last event sequence number the client may safely assume exists; §5.2's `seq` in record form. */
    lastSeq: Type.Integer({ minimum: 0 }),
    error: Type.Optional(
      Type.Object({ code: Type.String(), message: Type.String() }, { additionalProperties: false }),
    ),
    /** Present once a cancellation has settled. Absent while the task is merely `cancelling`: the state says a request was
     *  recorded, and the evidence §6.2 asks for does not exist until the step in flight has settled (D-089). */
    cancellation: Type.Optional(TaskCancellation),
  },
  { additionalProperties: false },
);

export type TaskRecord = Static<typeof TaskRecord>;

/** §2's idempotency rule is a header, not a body field (`Idempotency-Key`), so it is named here as the place the
 *  Gateway reads it and nowhere else. */
export const IDEMPOTENCY_HEADER = "idempotency-key";
export const REQUEST_ID_HEADER = "x-crabby-request-id";

export const CreateTaskBody = Type.Object(
  { objective: Type.String({ minLength: 1 }), sessionId: Type.Optional(SessionId) },
  { additionalProperties: false },
);
export type CreateTaskBody = Static<typeof CreateTaskBody>;

/** §2's cursor pagination (`?cursor=&limit=`), ordered by stable id so a list does not shift while a task appends
 *  records. The 200 ceiling is a proposal recorded here, not a documented number — D-074's `limits.*` table is where
 *  a page size belongs, and no document names one yet. No default is applied, because a default is a policy and the
 *  policy belongs to the route that documents it. */
export const ListQuery = Type.Object(
  {
    cursor: Type.Optional(Type.String({ maxLength: 128 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    sessionId: Type.Optional(SessionId),
    state: Type.Optional(Type.Union(TASK_STATES.map((name) => Type.Literal(name)))),
  },
  { additionalProperties: false },
);
export type ListQuery = Static<typeof ListQuery>;

export const TaskList = Type.Object(
  { items: Type.Array(TaskRecord), nextCursor: Type.Optional(Type.String({ maxLength: 128 })) },
  { additionalProperties: false },
);
export type TaskList = Static<typeof TaskList>;
