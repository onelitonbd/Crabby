// Task records and the create/list shapes behind M1's exit condition — "a task can be created and read back with an
// id, and nothing else" (`docs/ROADMAP.md` §3's exit line). The nine states are `AGENT_RUNTIME.md` §4.1's initial
// lifecycle; transition rules are the runtime's business (M2) and deliberately not encoded here, because a contract
// that restates the state machine becomes a second state machine.
import { type Static, Type } from "@sinclair/typebox";
import { CLIENT_INTERFACES } from "./clients.ts";
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
/** `unknown` is not a fourth kind of work, it is the absence of an answer: a process that died cannot say what it was
 *  running, and §6.2 requires that uncertainty to be recorded rather than resolved by picking one (D-092). */
export const CANCELLATION_IN_FLIGHT = ["none", "provider", "tool", "unknown"] as const;
export type CancellationInFlight = (typeof CANCELLATION_IN_FLIGHT)[number];

/** The cancellation, on the record rather than only in the log. Two phases, and the difference is readable: §6.1's step 1
 *  records the *request* (`mode`, `requestedAt`, who and why), and the settle adds §6.2's evidence — which is what
 *  "that uncertainty MUST be recorded explicitly on the task" asks for, and what §5.2's recovery rule makes the task route
 *  the place to read it. So `cancellation` present with no `settledAt` means a request was recorded and the task has not
 *  settled; present with one means the runtime knows, and says, whether the operation stopped (F-46, D-091, and the
 *  amendment in D-092: §7.1's recovery has to know what was *asked* before it can honour it, and reading that back out of
 *  the event log is archaeology where a column would do). */
export const TaskCancellation = Type.Object(
  {
    mode: Type.Union(CANCELLATION_MODES.map((name) => Type.Literal(name))),
    requestedAt: Type.String({ format: "date-time" }),
    /** Present exactly when the task has settled. The four fields below arrive with it, because §6.2's evidence does not
     *  exist until the step in flight has finished or been walked away from. */
    settledAt: Type.Optional(Type.String({ format: "date-time" })),
    /** §6.2's distinction: the operation reported that it stopped, which is not the same fact as the runtime ceasing to
     *  wait for it (D-089). */
    terminated: Type.Optional(Type.Boolean()),
    effectsUncertain: Type.Optional(Type.Boolean()),
    inFlight: Type.Optional(Type.Union(CANCELLATION_IN_FLIGHT.map((name) => Type.Literal(name)))),
    by: Type.Optional(Type.String()),
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type TaskCancellation = Static<typeof TaskCancellation>;

/** §3.6's stage 3, as data. Every field is required but two, and each of the two is the record's honest silence: a run
 *  resumed on the model it already used switched nothing, so this is absent rather than `to === from`, and an answer from
 *  a client the Gateway could not name carries no `by` rather than a placeholder that would read as an identity.
 *
 *  `reAttempted` is the field a reviewer should read twice. It is `false` for every switch this build can produce, and
 *  that is the guarantee D-044 makes rather than an observation: a resume continues from the boundary the run committed,
 *  so a completed step is never run twice (§3.9's first rule). It is on the record because a task that switched models
 *  mid-flight is exactly the one whose history a reader will want to check against the log, and a boolean that can only
 *  be `false` today is how the next resume finds out if it ever is not. */
export const TaskModelSwitch = Type.Object(
  {
    /** The `<provider>/<modelId>` pair the run was using, which for a task with no pin is the composed default it
     *  actually called rather than the word "default" — the record should name what happened, not what was configured. */
    from: Type.String({ minLength: 3 }),
    /** The pair the answer chose, which is also what `model` now holds. */
    to: Type.String({ minLength: 3 }),
    /** Why the ladder stopped retrying, in the sentence §3.6 stage 2 promises the user at the prompt. */
    reason: Type.String({ minLength: 1 }),
    /** Which rung of the ladder reached this switch. Only `2` is reachable: stage 1 retries the same model, and a
     *  billing class stops the run rather than switching (D-044, `PROVIDERS_AND_TOOLS.md` §3.6). */
    stage: Type.Integer({ minimum: 2, maximum: 2 }),
    reAttempted: Type.Boolean(),
    /** The attempts the ladder spent before it asked. A reader comparing this with the log can see that the budget went
     *  to one model and the task moved to another, rather than having to trust that it did. */
    attempts: Type.Integer({ minimum: 1 }),
    at: Type.String({ format: "date-time" }),
    by: Type.Optional(Type.String()),
    via: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type TaskModelSwitch = Static<typeof TaskModelSwitch>;

/** Which identity a task belongs to — §14's attribution and F-47's resumption, from one field.
 *
 *  Only the *identity* is stored, never its capabilities: the grants a run holds are evaluated at the moment it starts
 *  (§13's revocation), so a copy of a capability list here would be a historical fact in a place a reader would take for
 *  a current one. What a resumer does with this is look the identity **up** — a client that was revoked has no row, and
 *  the resumption is refused rather than continued under the authority a dead process happened to be holding. */
export const TaskOrigin = Type.Object(
  {
    clientId: Type.String({ minLength: 1 }),
    clientName: Type.String({ minLength: 1 }),
    // §3.1's own list, the same constant `session.origin_interface` and every identity row are built from — one list, so a
    // fifth interface cannot be added to one and forgotten in the others. It is also what makes this field assignable to
    // `RunOrigin.interface` without a cast, which is the whole reason it is typed rather than read as text.
    interface: Type.Union(CLIENT_INTERFACES.map((name) => Type.Literal(name))),
  },
  { additionalProperties: false },
);
export type TaskOrigin = Static<typeof TaskOrigin>;

export const TaskRecord = Type.Object(
  {
    id: TaskId,
    sessionId: SessionId,
    state: Type.Union(TASK_STATES.map((name) => Type.Literal(name))),
    /** §4.3 names this field *objective*. A maximum length is a `limits.*` concern (D-074), not a type
     *  concern, so the contract sets no ceiling here. */
    objective: Type.String({ minLength: 1 }),
    /** §3.6's per-task pin as stored, the `<provider>/<modelId>` pair; absent means the install's default, a different
     *  fact from "no model" (D-108, mirroring `SessionRecord.model`). */
    model: Type.Optional(Type.String()),
    createdAt: Type.String({ format: "date-time" }),
    updatedAt: Type.String({ format: "date-time" }),
    /** The last event sequence number the client may safely assume exists; §5.2's `seq` in record form. */
    lastSeq: Type.Integer({ minimum: 0 }),
    error: Type.Optional(
      Type.Object({ code: Type.String(), message: Type.String() }, { additionalProperties: false }),
    ),
    /** Present from the moment a cancellation is requested, with §6.2's evidence added when the task settles (D-091,
     *  amended by D-092 so that recovery can read what was asked instead of excavating it from the log). */
    cancellation: Type.Optional(TaskCancellation),
    /** The identity that created the task (D-111, schema version 9). Absent means the row predates it or was written by a
     *  composition root that had no identity to record; §14's audit is served by the log either way, so this is a fact
     *  that makes attribution and cross-process resumption possible rather than a fact a reader loses. */
    origin: Type.Optional(TaskOrigin),
    /** §3.6's stage 3 requires the record itself to show a switch — original model, chosen model, reason, the ladder
     *  stage that reached it, and whether any step was re-attempted — so this sits beside `model` the way
     *  `cancellation` sits beside the state it was asked for: a log the reader may not have read is not a record. Absent
     *  means no switch has happened, which is a different fact from "the switch was to the same model". */
    modelSwitch: Type.Optional(TaskModelSwitch),
  },
  { additionalProperties: false },
);

export type TaskRecord = Static<typeof TaskRecord>;

/** §2's idempotency rule is a header, not a body field (`Idempotency-Key`), so it is named here as the place the
 *  Gateway reads it and nowhere else. */
export const IDEMPOTENCY_HEADER = "idempotency-key";
export const REQUEST_ID_HEADER = "x-crabby-request-id";

export const CreateTaskBody = Type.Object(
  {
    objective: Type.String({ minLength: 1 }),
    sessionId: Type.Optional(SessionId),
    /** §3.6's per-task pin, in the `<provider>/<modelId>` form `defaultModel` takes. Resolved at the route against every
     *  composed provider (D-110), not against the run's own provider alone: a pin is the user's way of naming a model,
     *  and refusing a model that is configured is not a smaller feature but a different product (F-57's option B). */
    model: Type.Optional(Type.String({ minLength: 3 })),
  },
  { additionalProperties: false },
);
export type CreateTaskBody = Static<typeof CreateTaskBody>;

/** §6.1's request, as a body. Both fields are optional because the manager has a default for each — `finish-step` for
 *  the mode, no reason at all — and a body that demanded a mode would make `POST /tasks/{id}/cancel` unwritable by the
 *  one client that matters most: a phone's stop button. `mode` is here rather than invented per interface so that §6.2's
 *  override is reachable over HTTP ("a safety-critical intervention MUST override finish-the-current-step"), which it
 *  cannot be if the only way to ask is a mode the route hardcodes.
 *
 *  There is deliberately no `Idempotency-Key` requirement on this route, and the reason is that the manager is already
 *  idempotent in a stronger sense than a key cache: a second request for the same task returns the request it recorded
 *  (`deduplicated`), and a second request that *escalates* is the override §6.2 asks for rather than a conflict. A key
 *  would have to choose between those two and would get one of them wrong. */
export const CancelTaskBody = Type.Object(
  {
    mode: Type.Optional(Type.Union(CANCELLATION_MODES.map((name) => Type.Literal(name)))),
    // 512 is a proposal recorded here rather than a documented number, in the same way `ListQuery`'s 200 is: long enough
    // for a sentence a user would actually type ("it is touching the wrong directory"), short enough that a reason cannot
    // become the payload-smuggling path §7 closes for events.
    reason: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  },
  { additionalProperties: false },
);
export type CancelTaskBody = Static<typeof CancelTaskBody>;

/** The answer to §3.6 stage 2's prompt, as a body. One optional field, and the emptiness is the point: an answer with no
 *  pin continues on the model the run already used, which is a real answer — the budget was spent, the same model may
 *  well succeed on a fresh attempt — and is the only answer a single-model install has to give. A pin names the model to
 *  switch to and is validated against every composed provider before anything moves (D-110).
 *
 *  There is no `decline`, and the reason is a decision rather than an omission: what moves an *unanswered* ask to
 *  `failed` is not priced by any document, so a body field here would be an interface inventing a semantic the runtime
 *  has no answer for (DECISIONS.md O-073, `docs/CONSISTENCY_REVIEW.md` F-50's residual). A user who wants the task to
 *  stop cancels it, which is an act that already exists and already means what it says. */
export const ResumeTaskBody = Type.Object(
  {
    model: Type.Optional(Type.String({ minLength: 3 })),
  },
  { additionalProperties: false },
);
export type ResumeTaskBody = Static<typeof ResumeTaskBody>;

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
