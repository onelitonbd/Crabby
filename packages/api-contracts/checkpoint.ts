// The checkpoint's wire shape: what `GET /tasks/{id}/checkpoint` returns (`docs/INTERFACES_AND_API.md` §4.3, "checkpoint
// view for recovery transparency") and the two vocabularies that view needs. Both come from documents rather than from
// this file's opinion: the boundaries are D-065's ("a checkpoint is written at committed step boundaries") and the
// verdicts are the four answers D-065's resume rule can give, in its own words — "resume may **pass** a step only if that
// step's tool declares itself idempotent or the step recorded its external effect; anything else **re-asks** rather than
// repeating".
//
// What is deliberately NOT here is the transcript. A checkpoint's saved state includes the run's working context — the
// messages a resume continues from — and `SECURITY.md` §7 requires redaction at the serialization layer, so those bytes
// are redacted on the way into the database the same way an event payload is. Handing them back over a route would make
// the redacted working context a fourth interface's copy of a conversation, which `AGENT_RUNTIME.md` §8.2 counts as a *different category*
// from the conversation record it is not. So the view reports the boundary, the size and the verdict, and the party that
// resumes reads the record from the store in its own process. `messages` is a count for that reason, and `redacted` is a
// field rather than a comment because it is a fact about the stored bytes a resumer has to know: a resumed run continues
// with markers wherever a secret-shaped value was.
//
// The rules are not here either, for the reason `task.ts` and `approvals.ts` give: a contract that restated "which steps
// a resume may pass" would be a second checkpoint manager, and D-065's rule lives in `packages/agent-runtime`.
import { type Static, Type } from "@sinclair/typebox";
import { TaskId } from "./ids.ts";
import { TASK_STATES } from "./task.ts";

/** Where a checkpoint sits in a run. `step` is D-065's committed step boundary — a tool step's outcome is recorded, so
 *  the run could continue after it. `prompt` is the boundary a suspended run sits on: the step is proposed and gated, the
 *  request is open, and nothing has executed, which is the only durable trace of a `SuspendedRun` that process memory
 *  otherwise loses at a restart. There is no third kind: a terminal task's checkpoint stays at the last boundary it
 *  reached, and the verdict is what says the task ended (§4.1's terminal states are absorbing, so "settled" would be a
 *  boundary kind that could never be resumed from and would only repeat what `state` already says). */
export const CHECKPOINT_BOUNDARIES = ["step", "prompt"] as const;
export type CheckpointBoundary = (typeof CHECKPOINT_BOUNDARIES)[number];

/** D-065's resume rule, as the four answers it can give. `resume` — nothing was in flight after the boundary, so a
 *  runner may continue from it without repeating anything. `pass` — a step *was* in flight, and the rule permits passing
 *  it because its tool declares itself idempotent or its external effect is on the record. `re-ask` — a step was in
 *  flight and neither permission holds, so §7.3 forbids repeating it and the runner asks instead (the model, or the
 *  user). `none` — there is nothing to resume from: no boundary was ever committed, or the task is terminal. */
export const RESUME_VERDICTS = ["resume", "pass", "re-ask", "none"] as const;
export type ResumeVerdict = (typeof RESUME_VERDICTS)[number];

/** The step a `prompt` boundary is waiting on. It names the action and points at the arbiter's row; it does not carry
 *  the action's arguments, and that absence is a rule rather than an omission. Two reasons, and either one is enough: the
 *  arguments are redacted on write like everything else in the record, so a copy of them here could not be executed
 *  faithfully, and a second copy of an approved action would be an action the arbiter never saw — D-084's binding
 *  comparison at the moment of execution is only meaningful while the row is the only place the action exists. */
export const CheckpointPending = Type.Object(
  {
    tool: Type.String({ minLength: 1 }),
    toolCallId: Type.String({ minLength: 1 }),
    approvalId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type CheckpointPending = Static<typeof CheckpointPending>;

/** The verdict, with the reason a user reads and the step it judged. `inFlight` is present exactly when the verdict had
 *  to decide something about a step that was running — which is the case §7.3 exists for, and naming the tool is what
 *  lets a reader disagree with the answer instead of guessing at it. */
export const ResumeAnswer = Type.Object(
  {
    verdict: Type.Union(RESUME_VERDICTS.map((name) => Type.Literal(name))),
    reason: Type.String({ minLength: 1 }),
    inFlight: Type.Optional(
      Type.Object(
        { tool: Type.String({ minLength: 1 }), startedSeq: Type.Integer({ minimum: 1 }) },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type ResumeAnswer = Static<typeof ResumeAnswer>;

/** `GET /tasks/{id}/checkpoint`. A view of the saved state, computed at read time rather than stored: the boundary is a
 *  fact about the moment it was written, while the verdict depends on the task's state now, on the log tail after the
 *  boundary, and on what the tool runtime declares — three things that can all change after the write, so storing an
 *  answer would be storing a guess. */
export const TaskCheckpoint = Type.Object(
  {
    taskId: TaskId,
    /** The task state when the boundary was committed. Not the state now: `GET /tasks/{id}` answers that, and a
     *  checkpoint that pretended to would be a second opinion about the lifecycle. */
    state: Type.Union(TASK_STATES.map((name) => Type.Literal(name))),
    boundary: Type.Union(CHECKPOINT_BOUNDARIES.map((name) => Type.Literal(name))),
    /** Committed tool steps at this boundary — D-088's `stepsPerTask` counter as far as the run got. */
    step: Type.Integer({ minimum: 0 }),
    /** The event sequence number the boundary was written at. The verdict reads the log *after* it, which is how a
     *  restart learns what was in flight without the dead process having to say. */
    lastSeq: Type.Integer({ minimum: 0 }),
    /** The model the run was on when the boundary was committed: `PROVIDERS_AND_TOOLS.md` §3.6's stage 3 requires the
     *  record to show the original model beside the chosen one, and "original" has to be written down before a switch
     *  exists to compare it with. */
    modelId: Type.String({ minLength: 1 }),
    writtenAt: Type.String({ format: "date-time" }),
    /** The stored record's size in bytes. A checkpoint is the one durable copy of a run's working context in this build,
     *  so its size is a storage fact a user on a phone can see rather than a number only a migration knows. */
    bytes: Type.Integer({ minimum: 0 }),
    /** How many working-context messages the record holds. A count, not the messages — see the header. */
    messages: Type.Integer({ minimum: 0 }),
    redacted: Type.Boolean(),
    pending: Type.Optional(CheckpointPending),
    resume: ResumeAnswer,
  },
  { additionalProperties: false },
);
export type TaskCheckpoint = Static<typeof TaskCheckpoint>;
