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
