// D-065's rule as behaviour: what a checkpoint holds, what it refuses to hold, and the four answers a resume can be
// given. Every assertion is a sentence from `docs/DATA_AND_MEMORY.md` §2.2, `AGENT_RUNTIME.md` §7.3 or D-095, because a
// verdict is the one field in this build that a recovery path acts on — and a wrong `resume` is a duplicated side effect,
// which is the failure §7.3 exists to prevent.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type Event,
  newId,
  TaskCheckpoint,
  type TaskRecord,
  type TaskState,
  validate,
} from "@crabby/api-contracts";
import {
  byteLength,
  type CheckpointRecord,
  type Checkpoints,
  createCheckpoints,
  inFlightStep,
  verdictFor,
} from "./checkpoint.ts";
import type { TaskJournal } from "./journal.ts";

const T0 = 1_700_000_000_000;
// A real id, because the contract's `TaskId` pattern is what `validate()` checks in two of these tests: a fixture id
// like "tsk_ckpt" would fail the shape for a reason that has nothing to do with the checkpoint, which is the trap
// `packages/api-contracts/ids.ts`'s "an id scheme is a wire contract" sentence exists to close.
const TASK = newId("tsk", T0, () => new Uint8Array(16));

/** One task, one row, one log — the shape `CheckpointStore` and `TaskJournal` ask for and nothing more. A recovery test
 *  needs several tasks and composes several fixtures; this file needs one task seen from four angles. */
function fixture(input: { state?: TaskState; lastSeq?: number } = {}) {
  let seq = input.lastSeq ?? 0;
  const events: Event[] = [];
  let record: TaskRecord = {
    id: TASK,
    sessionId: "ses_ckpt",
    state: input.state ?? "running",
    objective: "read notes.md and delete build/",
    createdAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    lastSeq: seq,
  };
  const journal: TaskJournal = {
    task: () => record,
    tasks: (wanted) => (wanted === undefined || wanted.includes(record.state) ? [record] : []),
    setState: (taskId, state, patch) => {
      if (taskId !== record.id) throw new Error(`the fixture holds one task, not ${taskId}`);
      record = {
        ...record,
        state,
        lastSeq: record.lastSeq,
        ...(patch?.error === undefined ? {} : { error: patch.error }),
      };
    },
    append: ({ taskId, type, payload, at }) => {
      seq += 1;
      const event: Event = {
        id: `evt_${seq}`,
        schemaVersion: 1,
        type,
        ts: new Date(at).toISOString(),
        sessionId: record.sessionId,
        taskId,
        seq,
        payload,
      };
      events.push(event);
      record = { ...record, lastSeq: seq };
      return event;
    },
    transact: <T>(body: () => T): T => body(),
  };
  const writes: CheckpointRecord[] = [];
  let stored: CheckpointRecord | undefined;
  const at = { now: T0 };
  const checkpoints: Checkpoints = createCheckpoints({
    store: {
      read: (taskId) => (stored !== undefined && stored.taskId === taskId ? stored : undefined),
      write: (one) => {
        writes.push(one);
        stored = one;
      },
    },
    journal,
    eventsAfter: (taskId, afterSeq) =>
      events.filter((event) => event.taskId === taskId && event.seq > afterSeq),
    now: () => at.now,
  });
  return {
    journal,
    checkpoints,
    events,
    writes,
    clock: at,
    task: () => record,
    /** Moves the record the way `transition()` would, without asking it: these tests are about the checkpoint, and a
     *  fixture that re-implemented the state machine would be testing a copy. */
    setState: (state: TaskState): void => {
      record = { ...record, state };
    },
    started: (tool: string, atMs = T0): Event =>
      journal.append({
        taskId: TASK,
        type: "tool.execution.started",
        payload: { tool },
        at: atMs,
      }),
    outcome: (
      tool: string,
      type: "tool.execution.completed" | "tool.execution.failed" = "tool.execution.completed",
    ): Event =>
      journal.append({
        taskId: TASK,
        type,
        payload: { tool, output: `${tool} ran` },
        at: T0,
      }),
    commit: (overrides: Partial<Parameters<Checkpoints["commit"]>[0]> = {}): CheckpointRecord =>
      checkpoints.commit({
        taskId: TASK,
        boundary: "step",
        step: 1,
        modelId: "fake/tool-model",
        messages: [{ role: "user", content: "read notes.md and delete build/" }],
        ...overrides,
      }),
  };
}

describe("D-065's checkpoint (saved state, and the rule that judges it)", () => {
  it("takes the state and the sequence number from the journal, not from the caller", () => {
    const f = fixture({ state: "running" });
    f.outcome("file.read");

    const record = f.commit({ step: 1 });

    assert.equal(
      record.state,
      "running",
      "the state at the boundary is the task's, read at the write",
    );
    assert.equal(
      record.lastSeq,
      f.task().lastSeq,
      "the boundary's `lastSeq` is the number the event store assigned, because the verdict's whole question is " +
        "'what does the log say happened after this point' and a caller-supplied number would answer a different one",
    );
    assert.equal(
      record.writtenAt,
      f.clock.now,
      "one clock: the events and the boundary are read against the same time",
    );
  });

  it("holds one row per task, so a boundary replaces the one before it", () => {
    const f = fixture();
    f.outcome("file.read");
    f.commit({ step: 1 });
    f.outcome("file.delete");
    f.commit({ step: 2 });

    assert.equal(f.writes.length, 2, "two boundaries were committed");
    assert.equal(f.checkpoints.latest(TASK)?.step, 2, "and only the latest one is saved state");
    assert.equal(
      f.checkpoints.view(TASK)?.step,
      2,
      "D-095's first rule: \u00a77.1 restores the *latest* valid state, and a history of boundaries would be a second event " +
        "log whose retention nobody priced \u2014 the boundary before this one is only useful to a resume that intends to " +
        "repeat work, which \u00a77.3 forbids",
    );
  });

  it("reports the boundary and its size, and never the transcript", () => {
    const f = fixture();
    f.outcome("file.read");
    const record = f.commit({ step: 1 });

    const view = f.checkpoints.view(TASK);

    assert.ok(view !== undefined);
    assert.equal(view?.taskId, TASK);
    assert.equal(view?.boundary, "step");
    assert.equal(
      view?.messages,
      1,
      "a count, because the working context is not a route's to hand out",
    );
    assert.equal(view?.modelId, "fake/tool-model");
    assert.equal(view?.writtenAt, new Date(T0).toISOString());
    assert.equal(
      view?.bytes,
      byteLength(record),
      "the size a client is shown is the size of the record that was stored",
    );
    assert.equal(
      view?.redacted,
      true,
      "`SECURITY.md` \u00a77 puts redaction at the serialization layer, so a resumed context carries markers where a " +
        "secret-shaped value was \u2014 a fact a resumer has to be told rather than discover",
    );
    assert.deepEqual(
      validate(TaskCheckpoint, view).ok,
      true,
      'and the view satisfies the contract, whose `additionalProperties: false` is what makes "no transcript over a ' +
        'route" a checked property rather than a comment: \u00a78.2 counts a checkpoint as a different category from the ' +
        "conversation record it is not, and a fourth interface holding a redacted copy would blur exactly that line",
    );
    assert.equal(
      JSON.stringify(view ?? {}).includes("read notes.md"),
      false,
      "the working context the record holds does not reach the view — transparency about the boundary, not a copy of it",
    );
    assert.equal(view?.resume.verdict, "resume");
  });

  it("answers `resume` when the log shows every step after the boundary had an outcome", () => {
    const f = fixture();
    f.outcome("file.read");
    f.commit({ step: 1 });
    f.started("file.delete");
    f.outcome("file.delete");

    const answer = f.checkpoints.verdict(TASK);

    assert.equal(answer.verdict, "resume");
    assert.equal(answer.inFlight, undefined, "nothing was left unanswered, so nothing is named");
    assert.match(
      answer.reason,
      /every step the log started after seq/,
      "the reason says what was checked, because a verdict a reader cannot audit is a verdict nobody can argue with",
    );
  });

  it("answers `re-ask` when a step was in flight, which is the case §7.3 exists for", () => {
    const f = fixture();
    f.outcome("file.read");
    f.commit({ step: 1 });
    const started = f.started("file.delete");

    const answer = f.checkpoints.verdict(TASK);

    assert.equal(
      answer.verdict,
      "re-ask",
      "`file.delete` started and never reported, and no tool in this build declares `idempotent`, so D-065's rule " +
        "re-asks instead of repeating an action whose completion status is unknown",
    );
    assert.deepEqual(answer.inFlight, { tool: "file.delete", startedSeq: started.seq });
    assert.match(answer.reason, /PENDING_RECORD_FIELDS/);
    assert.match(answer.reason, /tool\.execution\.started/);
  });

  it("passes an in-flight step only on one of D-065's two permissions", () => {
    const f = fixture();
    f.commit({ step: 1 });
    const started = f.started("memory.search");

    const withFacts = (facts: { idempotent: boolean; effectRecorded: boolean }): string => {
      const manager = createCheckpoints({
        store: { read: () => f.checkpoints.latest(TASK), write: () => {} },
        journal: f.journal,
        eventsAfter: (taskId, afterSeq) =>
          f.events.filter((event) => event.taskId === taskId && event.seq > afterSeq),
        stepFacts: () => facts,
      });
      return manager.verdict(TASK).verdict;
    };

    assert.equal(withFacts({ idempotent: false, effectRecorded: false }), "re-ask");
    assert.equal(
      withFacts({ idempotent: true, effectRecorded: false }),
      "pass",
      "a tool that declares itself idempotent may be passed, because repeating it cannot duplicate an effect",
    );
    assert.equal(
      withFacts({ idempotent: false, effectRecorded: true }),
      "pass",
      "and so may one whose external effect was written down \u2014 \u00a77.3's 'establish whether that effect already occurred' " +
        "answered by something recorded rather than by something assumed",
    );
    assert.deepEqual(f.checkpoints.verdict(TASK).inFlight, {
      tool: "memory.search",
      startedSeq: started.seq,
    });
  });

  it("fails closed when the log tail cannot be read, and says that is what it did", () => {
    const f = fixture();
    f.commit({ step: 3 });
    const blind = createCheckpoints({
      store: { read: () => f.checkpoints.latest(TASK), write: () => {} },
      journal: f.journal,
      // No `eventsAfter`: the tail is not readable, which is a different fact from an empty one.
    });

    const answer = blind.verdict(TASK);

    assert.equal(
      answer.verdict,
      "re-ask",
      "not readable is not the same as empty, and guessing `resume` here is the guess \u00a77.3 exists to prevent",
    );
    assert.match(answer.reason, /not readable/);
  });

  it("treats a prompt boundary as resumable even with an unreadable tail, because nothing had executed", () => {
    const f = fixture({ state: "awaiting_approval" });
    f.commit({
      step: 2,
      boundary: "prompt",
      pending: { tool: "file.delete", toolCallId: "call_1", approvalId: "apv_1" },
    });
    const blind = createCheckpoints({
      store: { read: () => f.checkpoints.latest(TASK), write: () => {} },
      journal: f.journal,
    });

    const answer = blind.verdict(TASK);
    const view = f.checkpoints.view(TASK);

    assert.equal(
      answer.verdict,
      "resume",
      "a `prompt` boundary is written before the gated action runs, so there is no step to repeat; what happened next is " +
        "the arbiter's row to answer, and a row already `consumed` makes `loop.resume` refuse rather than re-run",
    );
    assert.match(answer.reason, /arbiter's row/);
    assert.deepEqual(view?.pending, {
      tool: "file.delete",
      toolCallId: "call_1",
      approvalId: "apv_1",
    });
    assert.equal(
      validate(TaskCheckpoint, view).ok,
      true,
      "the pending step names the action and points at the approval, and the contract's `additionalProperties: false` is " +
        "what keeps it at three fields: the arguments are redacted on write like everything else in the record, and a " +
        "second copy of an approved action would be an action the arbiter never saw \u2014 D-084's binding comparison " +
        "needs one copy to mean anything",
    );
  });

  it("answers `none` for a task that ended, with a reason per terminal state", () => {
    const f = fixture({ state: "completed" });
    f.commit({ step: 2 });
    assert.equal(f.checkpoints.verdict(TASK).verdict, "none");
    assert.match(
      f.checkpoints.verdict(TASK).reason,
      /terminal and absorbing/,
      "\u00a74.1: a completed task has nothing to resume, and a new objective is a new task",
    );

    f.setState("cancelled");
    assert.match(
      f.checkpoints.verdict(TASK).reason,
      /the cancellation asked to stop/,
      "resuming a cancelled task would repeat the work the user stopped, which is the one recovery outcome \u00a76 prevents",
    );

    f.setState("failed");
    const failed = f.checkpoints.verdict(TASK);
    assert.equal(failed.verdict, "none");
    assert.match(failed.reason, /D-044/);
    assert.match(
      failed.reason,
      /F-50/,
      "D-044 promises a resume from the checkpoint after the retry budget is spent, and \u00a74.1 has no edge out of " +
        "`failed` for it to resume along. The contradiction is recorded rather than resolved by a verdict that pretends " +
        "one of the two documents does not say what it says",
    );
  });

  it("answers `none` for a run that never committed a boundary, and says why that is the easy case", () => {
    const f = fixture({ state: "planning" });

    const answer = f.checkpoints.verdict(TASK);
    const view = f.checkpoints.view(TASK);

    assert.equal(answer.verdict, "none");
    assert.match(
      answer.reason,
      /never reached a step boundary/,
      "D-065 writes a checkpoint at each *committed step* boundary, and a task that was still planning has committed " +
        "none \u2014 inventing a boundary at step 0 would be a resume point the decision does not name",
    );
    assert.match(answer.reason, /nothing external happened/);
    assert.equal(
      view,
      undefined,
      "and there is no view to render, which the route turns into a 404 with this reason",
    );
  });

  it("matches an outcome to its start by tool, so a refusal does not close a step that is still running", () => {
    const started = (tool: string, seq: number): Event => ({
      id: `evt_${seq}`,
      schemaVersion: 1,
      type: "tool.execution.started",
      ts: new Date(T0).toISOString(),
      sessionId: "ses_ckpt",
      taskId: TASK,
      seq,
      payload: { tool },
    });
    const blocked = (tool: string, seq: number): Event => ({
      ...started(tool, seq),
      type: "tool.execution.blocked",
      payload: { tool, reason: "policy refused it" },
    });

    assert.deepEqual(
      inFlightStep([started("file.delete", 4), blocked("shell.run", 5)]),
      { tool: "file.delete", startedSeq: 4 },
      "a `tool.execution.blocked` for an action policy refused has no start to close, and consuming one would report a " +
        "step as finished that never ran",
    );
    assert.deepEqual(
      inFlightStep([started("file.read", 1), blocked("file.read", 2)]),
      undefined,
      "while a blocked event for the same tool does close it: the step has an outcome, and the outcome is the refusal",
    );
    assert.deepEqual(inFlightStep([]), undefined);
  });

  it("judges a task the journal does not hold as `none`, rather than as resumable", () => {
    const answer = verdictFor({
      record: undefined,
      stepFacts: () => ({ idempotent: false, effectRecorded: false }),
    });

    assert.equal(answer.verdict, "none");
    assert.match(answer.reason, /not in the journal/);
  });
});
