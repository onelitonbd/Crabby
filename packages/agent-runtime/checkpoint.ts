// M2i: D-065's checkpoint — the saved state a resume continues from, and the rule that says which steps a resume may
// pass. `AGENT_RUNTIME.md` §4.4 gives this concept its own owner precisely so it is not confused with two neighbours: a
// checkpoint is *not* the log of what happened (that is the event repository's) and *not* a guarantee that an external
// side effect can be reversed or replayed (nothing in Crabby can make that guarantee, and §7.4 says so). What it is, is
// the boundary a run had reached when it last committed a step, plus enough of the run's working context to continue
// from there — and a verdict, computed when somebody asks, about whether continuing is safe.
//
// Four rules, all D-095's, and each one is a choice a reviewer should be able to argue with:
//
//   1. **One row per task, replaced at each boundary.** §7.1 restores "the latest valid task state", and a history of
//      checkpoints would be a second event log with a retention rule nobody priced. The boundary before the latest one is
//      only useful to a resume that intends to repeat work, which §7.3 forbids — so the footprint is one record per task
//      and it leaves with the task (`ON DELETE CASCADE`).
//   2. **The checkpoint commits inside the step's own transaction.** "Committed step boundary" is the operative phrase: a
//      checkpoint written after the phase that recorded the step could exist for a step a rollback took back, or be
//      missing for a step that happened. Both are a resume point that disagrees with the log, so the write is one of the
//      rows the phase commits, beside the events that make the step committed.
//   3. **A checkpoint carries no authority and no action arguments.** It records the model, the boundary and the working
//      context; it does not record grants, and it does not record what a gated step was going to do. Authority is the
//      arbiter's row and the identity's grants *at resume time* — §7.2's "recovery never authorizes itself" would be
//      meaningless if a checkpoint could carry a grant that has since been revoked, and D-084's binding comparison at the
//      moment of execution is only meaningful while the approval row is the only place the action exists.
//   4. **The verdict is computed, never stored.** It depends on the task's state now, on the log tail after the boundary,
//      and on what the tool runtime declares — three facts that can all change after the write. Storing an answer would be
//      storing a guess, and a guess in the field a recovery path acts on is the defect §7.3 exists to prevent.
//
// What this makes possible, and what it still does not: a restart now has something to resume *from*, which is the half
// of F-47 that checkpoints owed. The other half is a runner — a party that would call `loop.resume` with a rebuilt
// `RunInput` — and there is still no product provider adapter and no Gateway runner, so `recovery.ts` reports the
// verdict and resumes nothing. M2k closed a different part of the same sentence: `packages/tools` declares §4.1's
// `idempotent` for the rows it implements (D-098) and `stepFactsFromDeclarations` below turns a declaration into the
// `StepFacts` this file reads, so `pass` is an answer a composed Gateway can give. A surface that declares nothing still
// gets `re-ask` for every step that was in flight when the process died, which is the default D-065 wants: the permission
// belongs to the tool, and a tool that does not claim it does not have it.
import {
  type CheckpointBoundary,
  type CheckpointPending,
  type Event,
  isTerminal,
  type ResumeAnswer,
  type TaskCheckpoint,
  type TaskRecord,
  type TaskState,
  type ToolDeclaration,
} from "@crabby/api-contracts";
import type { ProviderMessage } from "@crabby/providers";
import { RuntimeError, type TaskJournal } from "./journal.ts";

/** The durable saved state. `packages/storage/checkpoints.ts` writes it (redacted, like every other payload that reaches
 *  the database) and a runner would read it; `messages` is the run's working context, which `AGENT_RUNTIME.md` §8.2 counts as a different
 *  category from the conversation record it is not — and in this build it is the only durable copy of it, because no
 *  conversation store exists yet. That is stated rather than smoothed over: a checkpoint that outlives its task is a
 *  transcript, and `docs/DATA_AND_MEMORY.md` §2.2 is where that limit is written down. */
export interface CheckpointRecord {
  readonly taskId: string;
  readonly boundary: CheckpointBoundary;
  /** The task state when the boundary was committed — a fact about that moment, not a claim about now. */
  readonly state: TaskState;
  /** Committed tool steps, D-088's counter as far as the run got. */
  readonly step: number;
  /** The event `seq` the boundary was written at. The verdict reads the log after it. */
  readonly lastSeq: number;
  readonly modelId: string;
  readonly messages: readonly ProviderMessage[];
  /** Epoch milliseconds, from the same clock the events use. */
  readonly writtenAt: number;
  /** Present at a `prompt` boundary: the gated step the run is waiting on, named but not described — see rule 3. */
  readonly pending?: CheckpointPending | undefined;
}

/** The seam, in the shape `ApprovalStore` (D-084) and `TaskJournal` established: the runtime owns the abstraction, an
 *  adapter implements it, and both methods are synchronous because they are called inside a transaction that
 *  better-sqlite3 cannot span an `await` in. */
export interface CheckpointStore {
  read(taskId: string): CheckpointRecord | undefined;
  write(record: CheckpointRecord): void;
}

/** What a caller supplies. `state`, `lastSeq` and `writtenAt` are filled in here rather than by the caller, because a
 *  boundary that reported its own sequence number would be a second writer of a counter the event store owns. */
export interface CommitInput {
  readonly taskId: string;
  readonly boundary: CheckpointBoundary;
  readonly step: number;
  readonly modelId: string;
  readonly messages: readonly ProviderMessage[];
  readonly pending?: CheckpointPending | undefined;
}

/** D-065's two permissions to pass a step that was in flight. Both belong to the tool runtime that executes it, which is
 *  why `packages/policy` reports them as pending rather than guessing (`PENDING_RECORD_FIELDS`), and why the default here
 *  answers neither: a runtime that assumed `file.delete` was idempotent would be the exact lie `record.ts`'s header
 *  refuses. Since M2k an executor does declare the first of them — `packages/tools` fills in §4.1's `idempotent` for its
 *  eight file tools — and `stepFactsFromDeclarations` below is the bridge, so the `pass` branch is reachable in a composed
 *  Gateway rather than only in a test that invents a declaration. */
export interface StepFacts {
  readonly idempotent: boolean;
  /** The step's external effect is on the record — an operation identifier, a reconciled state, a receipt. §7.3's
   *  "idempotency mechanisms, operation identifiers, or external-state checks where available", as a boolean. */
  readonly effectRecorded: boolean;
}

/** The half the loop needs, named separately because a dependency that asks for more than it uses is a dependency that
 *  cannot be told what it is allowed to do: the loop writes boundaries and reads nothing back, and it must not compute a
 *  verdict, because the verdict is a fact about a task *now* and the loop is a party inside the run. */
export interface CheckpointGate {
  /** Writes D-065's boundary. Called from inside a phase; see rule 2. This is the whole of what the loop is allowed to
   *  do here: a loop that also judged resumability would be a party inside a run giving an opinion about a restart. */
  commit(input: CommitInput): CheckpointRecord;
}

/** The read half, named separately for the same reason as the write half: recovery, the cancellation settle and
 *  `GET /tasks/{id}/checkpoint` report a boundary and judge it, and none of them may write one, because a boundary is a
 *  fact about a run in progress and the only party that knows one was committed is the party that committed the step. */
export interface CheckpointReader {
  /** The record, for the party that resumes and for the two that report on it. Not the view: the transcript is in here
   *  and never in a route's body. */
  latest(taskId: string): CheckpointRecord | undefined;
  /** `GET /tasks/{id}/checkpoint`'s body: the boundary, its size, and the verdict. `undefined` when no boundary was ever
   *  committed, which the route turns into a `404` that says why rather than an empty object. */
  view(taskId: string): TaskCheckpoint | undefined;
  /** D-065's rule applied to this task right now, whether or not a record exists. Recovery reports it per task. */
  verdict(taskId: string): ResumeAnswer;
}

export interface Checkpoints extends CheckpointGate, CheckpointReader {}

export interface CheckpointDeps {
  readonly store: CheckpointStore;
  readonly journal: TaskJournal;
  /** The log tail after one `seq`, oldest first. Without it the verdict cannot know what was in flight, and it says so
   *  rather than assuming the answer — see `verdictFor`'s fail-closed branch. */
  readonly eventsAfter?: ((taskId: string, afterSeq: number) => readonly Event[]) | undefined;
  readonly stepFacts?: ((tool: string) => StepFacts) | undefined;
  readonly now?: (() => number) | undefined;
}

const NO_FACTS: StepFacts = { idempotent: false, effectRecorded: false };

/** The bridge between §4.1's record and D-065's first permission: an executor's `declares` (D-098) answers whether
 *  re-running a step is safe, which is exactly the question `verdictFor` asks before it will say `pass` instead of
 *  `re-ask`. A runner composes this once, at startup, and hands the result to `createCheckpoints`.
 *
 *  `effectRecorded` stays `false` for every tool, and that is a statement about this build rather than an oversight:
 *  §7.3's "operation identifiers, or external-state checks where available" means a receipt — an idempotency key a remote
 *  service honours, a reconciled state read back after the fact. A file tool's effect is on the local filesystem and in
 *  the event log, and neither of those is a receipt for an operation that may or may not have completed. So the verdict
 *  for a step that was in flight is carried by the idempotence half alone, which is the half the executor can actually
 *  know. */
export function stepFactsFromDeclarations(
  declares: (tool: string) => ToolDeclaration | undefined,
): (tool: string) => StepFacts {
  return (tool) => {
    const declaration = declares(tool);
    // An unknown tool answers neither fact, which is the default's own rule: §7.3's "anything else re-asks rather than
    // repeating an external action" is the safe reading of a tool nobody declared.
    return { idempotent: declaration?.idempotent ?? false, effectRecorded: false };
  };
}

export function createCheckpoints(deps: CheckpointDeps): Checkpoints {
  const now = deps.now ?? ((): number => Date.now());
  const facts = deps.stepFacts ?? ((): StepFacts => NO_FACTS);
  const { store, journal } = deps;

  function tailFor(taskId: string, afterSeq: number): readonly Event[] | undefined {
    return deps.eventsAfter?.(taskId, afterSeq);
  }

  return {
    commit(input: CommitInput): CheckpointRecord {
      const task = journal.task(input.taskId);
      if (task === undefined) {
        // Throwing inside a phase is deliberate: the transaction rolls back, so a step cannot commit without the
        // boundary that says it committed.
        throw new RuntimeError({
          code: "runtime.task_missing",
          message: `task ${input.taskId} is not in the journal, so a checkpoint at its step ${input.step} has nothing to belong to`,
        });
      }
      const record: CheckpointRecord = {
        taskId: input.taskId,
        boundary: input.boundary,
        state: task.state,
        step: input.step,
        // The last event the phase appended, which is the whole reason this is read here rather than passed in: the
        // verdict's question is "what happened after this boundary", and "after" has to be the store's number.
        lastSeq: task.lastSeq,
        modelId: input.modelId,
        messages: input.messages,
        writtenAt: now(),
        ...(input.pending === undefined ? {} : { pending: input.pending }),
      };
      store.write(record);
      return record;
    },
    latest: (taskId) => store.read(taskId),
    view(taskId: string): TaskCheckpoint | undefined {
      const record = store.read(taskId);
      if (record === undefined) return undefined;
      const task = journal.task(taskId);
      const resume = verdictFor({
        ...(task === undefined ? {} : { task }),
        record,
        ...(tailFor(taskId, record.lastSeq) === undefined
          ? {}
          : { tail: tailFor(taskId, record.lastSeq) }),
        stepFacts: facts,
      });
      return {
        taskId: record.taskId,
        state: record.state,
        boundary: record.boundary,
        step: record.step,
        lastSeq: record.lastSeq,
        modelId: record.modelId,
        writtenAt: new Date(record.writtenAt).toISOString(),
        bytes: byteLength(record),
        messages: record.messages.length,
        // A fact about the stored bytes rather than a promise about this implementation: `SECURITY.md` §7 puts redaction
        // at the serialization layer, so a resumed context carries markers wherever a secret-shaped value was.
        redacted: true,
        ...(record.pending === undefined ? {} : { pending: record.pending }),
        resume,
      };
    },
    verdict(taskId: string): ResumeAnswer {
      const task = journal.task(taskId);
      const record = store.read(taskId);
      return verdictFor({
        ...(task === undefined ? {} : { task }),
        ...(record === undefined ? {} : { record }),
        ...(record === undefined || tailFor(taskId, record.lastSeq) === undefined
          ? {}
          : { tail: tailFor(taskId, record.lastSeq) }),
        stepFacts: facts,
      });
    },
  };
}

/** The size a view reports. Computed rather than stored, because a stored number that disagreed with the column would be
 *  two opinions about one row. */
export function byteLength(record: CheckpointRecord): number {
  return JSON.stringify(record).length;
}

export interface VerdictInput {
  readonly task?: TaskRecord | undefined;
  readonly record?: CheckpointRecord | undefined;
  /** The events after the boundary's `lastSeq`. Absent means "not readable", which is not the same fact as "empty". */
  readonly tail?: readonly Event[] | undefined;
  readonly stepFacts: (tool: string) => StepFacts;
}

/** D-065's resume rule, as one function a test can drive without a database. The order of the branches is the argument:
 *  a task that ended is answered before a boundary is examined, a missing boundary is answered before a log is read, and
 *  an unreadable log fails closed to `re-ask` rather than open to `resume` — because the expensive mistake here is
 *  repeating an external action, and the cheap one is asking. */
export function verdictFor(input: VerdictInput): ResumeAnswer {
  const { task, record } = input;

  if (task === undefined) {
    return {
      verdict: "none",
      reason:
        "the task is not in the journal, so there is nothing a checkpoint could belong to and nothing to resume",
    };
  }

  if (isTerminal(task.state)) {
    return { verdict: "none", reason: terminalReason(task, record) };
  }

  if (record === undefined) {
    return {
      verdict: "none",
      reason:
        `no checkpoint was committed for task ${task.id}: the run never reached a step boundary, so there is no saved ` +
        "state to resume from. D-065 writes one at each committed step boundary, and a task that was still planning when " +
        "the process ended has not committed one — which is §7.3's easy case, because nothing external happened to repeat",
    };
  }

  if (input.tail === undefined) {
    // "Not readable" is not the same fact as "empty", so this branch fails closed — except at a `prompt` boundary, where
    // the boundary itself is the evidence that no step had executed: the loop suspends *before* the gated action runs, and
    // what happens next is the arbiter's row to say rather than this verdict's. A row already `consumed` makes
    // `loop.resume` refuse (a consumed approval is a duplicate resume), so nothing repeats either way.
    if (record.boundary === "prompt") {
      return {
        verdict: "resume",
        reason:
          `the run suspended at a prompt after step ${record.step}, and the log tail after seq ${record.lastSeq} was not ` +
          "readable — but a `prompt` boundary is written before the gated action executes, so no step was in flight to " +
          "repeat. What happened next is the arbiter's row to answer, not this record: one still `pending` is waiting for " +
          "an answer, and one already `consumed` means the step ran and only the log can say what it did",
      };
    }
    return {
      verdict: "re-ask",
      reason:
        `the checkpoint at step ${record.step} (event seq ${record.lastSeq}) is durable, but the log tail after it was ` +
        "not readable, so whether a step was in flight cannot be established. §7.3's answer for an unknown completion " +
        "status is re-ask rather than repeat, and a verdict that guessed `resume` would be the guess that section exists " +
        "to prevent",
    };
  }

  const inFlight = inFlightStep(input.tail);
  if (inFlight === undefined) {
    return {
      verdict: "resume",
      reason:
        `the boundary at step ${record.step} is the last thing the run committed, and every step the log started after ` +
        `seq ${record.lastSeq} has an outcome beside it, so nothing was in flight to repeat. A provider round may have ` +
        "been in flight, which D-089 classifies as having no effect on the user's device beyond the provider having seen " +
        "a prompt it was already sent",
    };
  }

  const facts = input.stepFacts(inFlight.tool);
  if (facts.idempotent) {
    return {
      verdict: "pass",
      reason:
        `'${inFlight.tool}' was in flight when the run ended (its \`tool.execution.started\` at seq ${inFlight.startedSeq} ` +
        "has no outcome beside it), and its runtime declares it idempotent, so D-065 permits passing it: repeating it " +
        "cannot duplicate an external effect",
      inFlight,
    };
  }
  if (facts.effectRecorded) {
    return {
      verdict: "pass",
      reason:
        `'${inFlight.tool}' was in flight when the run ended (its \`tool.execution.started\` at seq ${inFlight.startedSeq} ` +
        "has no outcome beside it), and its external effect is on the record, so D-065 permits passing it rather than " +
        'repeating it — §7.3\'s "establish whether that effect already occurred" answered by something that was written ' +
        "down",
      inFlight,
    };
  }
  return {
    verdict: "re-ask",
    reason:
      `'${inFlight.tool}' was in flight when the run ended — its \`tool.execution.started\` at seq ${inFlight.startedSeq} ` +
      "has no outcome beside it — and neither permission D-065 names holds: the runtime that executes it does not declare " +
      "it idempotent, and nothing recorded this step's external effect. §7.3 forbids repeating an action whose completion " +
      "status is unknown, so a runner re-asks instead of re-running",
    inFlight,
  };
}

/** The step a log tail left unanswered: the earliest `tool.execution.started` with no outcome event beside it. Outcomes
 *  are matched by tool name, newest first, because a `tool.execution.blocked` for an action policy refused has no start
 *  to close and must not consume one that is still open. */
export function inFlightStep(
  tail: readonly Event[],
): { tool: string; startedSeq: number } | undefined {
  const open: { tool: string; startedSeq: number }[] = [];
  for (const event of tail) {
    if (event.type === "tool.execution.started") {
      open.push({ tool: String(event.payload.tool ?? ""), startedSeq: event.seq });
      continue;
    }
    if (
      event.type !== "tool.execution.completed" &&
      event.type !== "tool.execution.failed" &&
      event.type !== "tool.execution.blocked"
    ) {
      continue;
    }
    const tool = String(event.payload.tool ?? "");
    for (let index = open.length - 1; index >= 0; index -= 1) {
      if (open[index]?.tool === tool) {
        open.splice(index, 1);
        break;
      }
    }
  }
  return open[0];
}

/** §4.1's terminal states are absorbing, so the answer is the same shape for all three and differs only in the reason a
 *  user reads. `failed` is the one that carries a debt: D-044 promises a resume from the checkpoint after the retry
 *  budget is spent, and a move out of `failed` does not exist — which is F-50, recorded rather than resolved here. */
function terminalReason(task: TaskRecord, record: CheckpointRecord | undefined): string {
  const at = record === undefined ? "with no committed checkpoint" : `at step ${record.step}`;
  if (task.state === "completed") {
    return `the task completed ${at}, and \`completed\` is terminal and absorbing (AGENT_RUNTIME.md §4.1), so there is nothing to resume: a new objective is a new task`;
  }
  if (task.state === "cancelled") {
    return (
      `the user stopped this task ${at} and §6.2's evidence is on the record, so nothing resumes from the boundary: ` +
      "resuming would repeat work the cancellation asked to stop, which is the one recovery outcome §6 exists to prevent"
    );
  }
  return (
    `the task failed ${at}, and \`failed\` is terminal and absorbing (AGENT_RUNTIME.md §4.1), so this build resumes ` +
    "nothing from the checkpoint. D-044's stage 2 — ask the user which model to use instead and continue from here, " +
    "never restarting the task — is the rung that is not built, and it has to ask *before* the task is failed, because " +
    "the state machine has no edge out of `failed` for it to resume along (docs/CONSISTENCY_REVIEW.md F-50)"
  );
}
