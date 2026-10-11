// §7 as behaviour: what a restart does to the tasks a dead process left behind, and — the part that matters — what it
// refuses to do. Every assertion here is a sentence from §7.1, §7.2 or §7.3, because a recovery that improvises is the one
// module in the runtime that can turn a crash into a duplicated side effect.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Event, TaskCancellation, TaskRecord, TaskState } from "@crabby/api-contracts";
import type { ApprovalRequest } from "@crabby/policy";
import { type Approvals, createApprovals, createMemoryApprovalStore } from "./approvals.ts";
import { type CheckpointRecord, type Checkpoints, createCheckpoints } from "./checkpoint.ts";
import type { TaskJournal } from "./journal.ts";
import { createRecovery, RECOVERABLE_STATES, type Recovery } from "./recovery.ts";

const T0 = 1_700_000_000_000;
const T2_TTL = 10 * 60_000; // D-064's T2 window.

function request(taskId: string, overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    taskId,
    tool: "file.delete",
    tier: "T2",
    summary: "delete build/ inside the workspace",
    exact: "path: /home/user/workspace/build",
    effects: "removes the build directory",
    reversibility: "uncertain",
    whatCouldGoWrong: "uncommitted output under build/ is lost",
    scope: "once",
    ttlMs: T2_TTL,
    expiresAt: T0 + T2_TTL,
    binding: `binding:${taskId}`,
    ...overrides,
  };
}

/** A journal holding several tasks, because recovery is a scan and the loop's harness is one run. The shape is the seam's,
 *  not SQLite's: what these tests assert is what recovery *decides*, and `packages/storage/journal.test.ts` is where the
 *  same decisions are proved over the real database. */
function fixture(seeded: { id: string; state: TaskState; cancellation?: TaskCancellation }[] = []) {
  const tasks = new Map<string, TaskRecord>();
  for (const seed of seeded) {
    tasks.set(seed.id, {
      id: seed.id,
      sessionId: `ses_${seed.id}`,
      state: seed.state,
      objective: `objective for ${seed.id}`,
      createdAt: new Date(T0).toISOString(),
      updatedAt: new Date(T0).toISOString(),
      lastSeq: 0,
      ...(seed.cancellation === undefined ? {} : { cancellation: seed.cancellation }),
    });
  }
  const events: Event[] = [];
  const published: Event[] = [];
  const states: Record<string, TaskState[]> = {};
  let seq = 0;
  const clock = {
    at: T0,
    now: () => clock.at,
    advance(ms: number) {
      clock.at += ms;
    },
  };
  const journal: TaskJournal = {
    task: (taskId) => tasks.get(taskId),
    tasks: (wanted) =>
      [...tasks.values()].filter((task) => wanted === undefined || wanted.includes(task.state)),
    setState: (taskId, state, record) => {
      const task = tasks.get(taskId);
      if (task === undefined) throw new Error(`no task ${taskId} in the fixture`);
      tasks.set(taskId, {
        id: task.id,
        sessionId: task.sessionId,
        objective: task.objective,
        createdAt: task.createdAt,
        state,
        updatedAt: new Date(clock.now()).toISOString(),
        lastSeq: task.lastSeq,
        ...(record?.error === undefined ? {} : { error: record.error }),
        ...(record?.cancellation === undefined
          ? task.cancellation === undefined
            ? {}
            : { cancellation: task.cancellation }
          : { cancellation: record.cancellation }),
      });
      // Two statements rather than `(states[id] ??= []).push(...)`: an assignment inside an expression is what
      // `lint/suspicious/noAssignInExpressions` exists to keep out of a fixture that reads as a value.
      const seen = states[taskId] ?? [];
      seen.push(state);
      states[taskId] = seen;
    },
    append: ({ taskId, type, payload, at }) => {
      seq += 1;
      const task = tasks.get(taskId);
      if (task === undefined) throw new Error(`no task ${taskId} in the fixture`);
      const event: Event = {
        id: `evt_${seq}`,
        schemaVersion: 1,
        type,
        ts: new Date(at).toISOString(),
        sessionId: task.sessionId,
        taskId,
        seq,
        payload,
      };
      events.push(event);
      tasks.set(taskId, { ...task, lastSeq: seq });
      return event;
    },
    transact: <T>(body: () => T): T => body(),
  };
  const approvals: Approvals = createApprovals({
    store: createMemoryApprovalStore(),
    newId: (() => {
      let n = 0;
      return () => {
        n += 1;
        return `apv_${n}`;
      };
    })(),
  });
  // The real manager over one variable, wired to this fixture's journal and its event array: D-065's verdict is a
  // function of the boundary, the task's state and the log tail, and a stub would let a test assert a verdict the code
  // never computed.
  const checkpointWrites: CheckpointRecord[] = [];
  let checkpoint: CheckpointRecord | undefined;
  const checkpoints: Checkpoints = createCheckpoints({
    store: {
      read: (taskId) => (checkpoint?.taskId === taskId ? checkpoint : undefined),
      write: (record) => {
        checkpointWrites.push(record);
        checkpoint = record;
      },
    },
    journal,
    eventsAfter: (taskId, afterSeq) =>
      events.filter((event) => event.taskId === taskId && event.seq > afterSeq),
    now: clock.now,
  });
  const recovery: Recovery = createRecovery({
    journal,
    approvals,
    checkpoints,
    publish: (event) => published.push(event),
    now: clock.now,
  });
  return {
    journal,
    approvals,
    checkpoints,
    checkpointWrites,
    recovery,
    events,
    published,
    states,
    clock,
    tasks,
  };
}

describe("recovery at startup (§7.1, §7.2)", () => {
  it("marks every non-terminal task interrupted, uniformly, and leaves the terminal ones exactly as they are", () => {
    const f = fixture([
      { id: "tsk_queued", state: "queued" },
      { id: "tsk_planning", state: "planning" },
      { id: "tsk_approval", state: "awaiting_approval" },
      { id: "tsk_running", state: "running" },
      { id: "tsk_done", state: "completed" },
      { id: "tsk_failed", state: "failed" },
      { id: "tsk_gone", state: "cancelled" },
    ]);

    const report = f.recovery.recoverAtStartup(T0);

    assert.equal(
      report.scanned,
      4,
      "the four non-terminal tasks, and `cancelling` is not among them here",
    );
    for (const id of ["tsk_queued", "tsk_planning", "tsk_approval", "tsk_running"]) {
      assert.equal(f.tasks.get(id)?.state, "interrupted", `${id} is interrupted`);
      assert.deepEqual(
        f.states[id],
        ["interrupted"],
        `${id} moved once: D-083's recoveryTarget is uniform, so recovery cannot improvise a different answer per state`,
      );
    }
    for (const [id, state] of [
      ["tsk_done", "completed"],
      ["tsk_failed", "failed"],
      ["tsk_gone", "cancelled"],
    ] as const) {
      assert.equal(f.tasks.get(id)?.state, state, `${id} is untouched`);
      assert.equal(
        f.states[id],
        undefined,
        "and no event was written for it: rewriting a terminal row during recovery would be the first bug in the ledger",
      );
    }
    assert.equal(
      f.events.filter((event) => event.type === "task.interrupted").length,
      4,
      "one event per move, and `task.interrupted` is the type the machine supplies",
    );
    assert.deepEqual(
      report.interrupted.map((task) => task.resumed),
      [false, false, false, false],
      "§7.2: automatic orchestration of recovery is not automatic authorization, and the report cannot claim a resumption",
    );
    assert.match(
      report.interrupted[0]?.reason ?? "",
      /no approval covers the step/,
      "the reason is user-visible and says which half of §7.2 applied",
    );
  });

  it("settles a cancellation the user asked for before the crash instead of resurrecting it", () => {
    const f = fixture([
      {
        id: "tsk_stopping",
        state: "cancelling",
        cancellation: {
          mode: "immediate",
          requestedAt: new Date(T0 - 5_000).toISOString(),
          by: "cln_phone",
          reason: "it was sending to the wrong recipient",
        },
      },
    ]);

    const report = f.recovery.recoverAtStartup(T0);

    const record = f.tasks.get("tsk_stopping");
    assert.equal(
      record?.state,
      "cancelled",
      "the user asked it to stop, so a restart does not get to un-ask",
    );
    assert.equal(
      record?.cancellation?.mode,
      "immediate",
      "what was asked survives, because it was written at the request",
    );
    assert.equal(record?.cancellation?.by, "cln_phone");
    assert.equal(record?.cancellation?.reason, "it was sending to the wrong recipient");
    assert.equal(record?.cancellation?.settledAt, new Date(T0).toISOString());
    assert.equal(
      record?.cancellation?.terminated,
      false,
      "a dead process cannot confirm that anything stopped",
    );
    assert.equal(
      record?.cancellation?.effectsUncertain,
      true,
      "§6.2: the uncertainty is recorded on the task, not resolved by assuming the step never ran",
    );
    assert.equal(
      record?.cancellation?.inFlight,
      "unknown",
      "and it says it does not know what was running, rather than picking `none` and reading as a clean stop (D-092)",
    );
    assert.deepEqual(
      f.states.tsk_stopping,
      ["cancelled"],
      "`cancelling` → `cancelled` is §4.1's only way in, and recovery takes it directly rather than routing a settled " +
        "cancellation through `interrupted` where a runner might later resume it",
    );
    assert.equal(f.events.filter((event) => event.type === "task.cancelled").length, 1);
    assert.equal(report.settledCancellations.length, 1);
    assert.equal(report.interrupted.length, 0);
  });

  it("expires the prompts whose deadline passed while the process was dead, and logs each one", () => {
    const f = fixture([{ id: "tsk_a", state: "awaiting_approval" }]);
    // Opened before the crash with D-064's T2 window, then the clock moves past it: the expiry is the clock's opinion and
    // not anybody's, which is why §6.3 has an expire-on-timeout default at all.
    // The deadline has to be D-064's window from the moment of the request, or the arbiter refuses the row outright
    // (`ttl-not-as-decided`) — a fixture that faked one would hide the rule the sweep depends on.
    f.approvals.open(request("tsk_a", { expiresAt: T0 - 1_000 }), T0 - T2_TTL - 1_000);
    f.clock.advance(1_000);

    const report = f.recovery.recoverAtStartup(f.clock.now());

    assert.deepEqual(
      report.expiredApprovals.map((row) => [row.taskId, row.tool]),
      [["tsk_a", "file.delete"]],
    );
    assert.equal(f.approvals.list({ taskId: "tsk_a" })[0]?.state, "expired");
    assert.equal(
      f.events.filter((event) => event.type === "approval.expired").length,
      1,
      "a row that expired because of the clock still owes its event, or the log and the queue disagree about whether the prompt is open",
    );
    assert.equal(
      f.events[0]?.type,
      "approval.expired",
      "and the sweep is written before the task moves, so a reader sees the queue settle first",
    );
    assert.equal(f.tasks.get("tsk_a")?.state, "interrupted");
    assert.equal(
      report.interrupted[0]?.approval,
      undefined,
      "an expired approval is not the still-valid cover §7.2 asks for, so it is not reported as such",
    );
  });

  it("reports the still-valid approval §7.2 would permit, and does not act on it", () => {
    const f = fixture([{ id: "tsk_b", state: "awaiting_approval" }]);
    const opened = f.approvals.open(request("tsk_b"), T0);
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const answered = f.approvals.answer({
      id: opened.record.id,
      decision: "approve",
      scope: "once",
      via: "web",
      at: T0 + 1_000,
    });
    assert.equal(answered.ok, true);

    const report = f.recovery.recoverAtStartup(T0 + 2_000);

    assert.equal(f.tasks.get("tsk_b")?.state, "interrupted");
    assert.equal(report.interrupted[0]?.approval?.id, opened.record.id);
    assert.equal(report.interrupted[0]?.approval?.state, "approved");
    assert.equal(
      report.interrupted[0]?.resumed,
      false,
      "§7.2 permits a resume only for work that is *both* safe and covered; the cover exists, and what is missing is " +
        "the party that would use it — no runner, no `packages/tools`, no product provider adapter",
    );
    assert.match(
      report.interrupted[0]?.reason ?? "",
      /never reached a committed step boundary/,
      "this run was seeded with no checkpoint, so the sentence says there is no saved state rather than implying one",
    );
    assert.match(report.interrupted[0]?.reason ?? "", /no runner to call `loop\.resume`/);
    assert.equal(
      report.interrupted[0]?.checkpoint?.verdict,
      "none",
      "D-065's verdict is reported beside the approval, because '§7.2 would permit it' is half an answer: a runner also " +
        "has to know whether the saved state is safe to continue from",
    );
    const event = f.events.find((entry) => entry.type === "task.interrupted");
    assert.equal(
      event?.payload.approvalId,
      opened.record.id,
      "the event names the approval a runner would be allowed to use, so the pause is a fact somebody can act on",
    );
    assert.equal(event?.payload.resumed, false);
    assert.equal(
      f.approvals.list({ taskId: "tsk_b" })[0]?.state,
      "approved",
      "and recovery does not spend, withdraw or expire an approval it has no authority over",
    );
  });

  it("reports D-065's verdict on the boundary a run left behind, and re-asks when a step was in flight", () => {
    const f = fixture([{ id: "tsk_d", state: "running" }]);
    // Two committed steps, then a third that started and never reported: the shape a process kill leaves, and the one
    // §7.3 exists for.
    f.journal.append({
      taskId: "tsk_d",
      type: "tool.execution.completed",
      payload: { tool: "file.read", output: "notes.md" },
      at: T0,
    });
    f.checkpoints.commit({
      taskId: "tsk_d",
      boundary: "step",
      step: 2,
      modelId: "fake/tool-model",
      messages: [],
    });
    const started = f.journal.append({
      taskId: "tsk_d",
      type: "tool.execution.started",
      payload: { tool: "file.delete", args: { path: "build/" } },
      at: T0 + 1_000,
    });

    const report = f.recovery.recoverAtStartup(T0 + 2_000);

    const saved = report.interrupted[0]?.checkpoint;
    assert.equal(saved?.step, 2, "the boundary the run committed, not the step it died on");
    assert.equal(saved?.boundary, "step");
    assert.equal(
      saved?.verdict,
      "re-ask",
      "`file.delete` was in flight and no tool in this build declares `idempotent` " +
        "(`PENDING_RECORD_FIELDS`), so D-065's rule re-asks rather than repeating an action whose effect is unknown",
    );
    assert.match(saved?.verdictReason ?? "", /file\.delete/);
    // The same fact in the log, because §5.2's rule runs in both directions: a client that only streams what a
    // restart decided has to learn as much as one that only polls the report.
    const payload = f.events.find((event) => event.type === "task.interrupted")?.payload
      .checkpoint as Record<string, unknown>;
    assert.equal(payload?.verdict, "re-ask");
    assert.equal(payload?.committed, true);
    assert.equal(
      payload?.lastSeq,
      started.seq - 1,
      "the boundary is the event before the step that never reported",
    );
    assert.deepEqual(payload?.inFlight, { tool: "file.delete", startedSeq: started.seq });

    // The same run with an outcome beside the start: nothing was in flight, so the answer flips to `resume` without
    // anything else moving. That contrast is the whole of D-065's rule and it is one event wide.
    f.journal.append({
      taskId: "tsk_d",
      type: "tool.execution.completed",
      payload: { tool: "file.delete", output: "removed build/" },
      at: T0 + 3_000,
    });
    assert.equal(
      f.checkpoints.verdict("tsk_d").verdict,
      "resume",
      "§7.3's question is answered by the log, not by a guess: an outcome beside the start means the step committed",
    );
  });

  it("passes an in-flight step only when its runtime says it may, which nothing in this build does", () => {
    const f = fixture([{ id: "tsk_e", state: "running" }]);
    f.checkpoints.commit({
      taskId: "tsk_e",
      boundary: "step",
      step: 1,
      modelId: "fake/tool-model",
      messages: [],
    });
    f.journal.append({
      taskId: "tsk_e",
      type: "tool.execution.started",
      payload: { tool: "memory.search" },
      at: T0,
    });

    assert.equal(
      f.checkpoints.verdict("tsk_e").verdict,
      "re-ask",
      "the default answers neither of D-065's permissions, because `sideEffects: none` for a tool nobody measured is the " +
        "lie `packages/policy/record.ts`'s header refuses",
    );

    // The `pass` branch exists and is tested, and reaching it takes a declaration the tool runtime does not yet make:
    // when `packages/tools` lands and a tool says it is idempotent, this is the branch that lets a resume continue
    // instead of asking, and no recovery code has to change.
    const declared = createCheckpoints({
      store: {
        read: () => f.checkpoints.latest("tsk_e"),
        write: () => {},
      },
      journal: f.journal,
      eventsAfter: (taskId, afterSeq) =>
        f.events.filter((event) => event.taskId === taskId && event.seq > afterSeq),
      stepFacts: (tool) => ({ idempotent: tool === "memory.search", effectRecorded: false }),
      now: f.clock.now,
    });
    const answer = declared.verdict("tsk_e");
    assert.equal(answer.verdict, "pass");
    assert.match(answer.reason, /declares it idempotent/);
    assert.deepEqual(answer.inFlight, { tool: "memory.search", startedSeq: 1 });
  });

  it("leaves a prompt inside its window pending, because a restart is not an answer", () => {
    const f = fixture([{ id: "tsk_c", state: "awaiting_approval" }]);
    f.approvals.open(request("tsk_c"), T0);

    const report = f.recovery.recoverAtStartup(T0 + 60_000);

    assert.equal(report.expiredApprovals.length, 0);
    assert.equal(f.approvals.list({ taskId: "tsk_c" })[0]?.state, "pending");
    assert.equal(
      report.interrupted[0]?.approval?.state,
      "pending",
      "§7.2's second bullet: a pending approval must not be treated as approved because a restart occurred — but it is " +
        "still the cover a runner would ask about, so the report names it rather than hiding it",
    );
    assert.equal(f.events.filter((event) => event.type === "approval.expired").length, 0);
  });

  it("writes nothing at all when there is nothing to recover", () => {
    const f = fixture([
      { id: "tsk_done", state: "completed" },
      { id: "tsk_gone", state: "cancelled" },
    ]);

    const report = f.recovery.recoverAtStartup(T0);

    assert.equal(report.scanned, 0);
    assert.deepEqual(report.interrupted, []);
    assert.equal(
      f.events.length,
      0,
      "a restart with nothing to recover is not an event anybody needs to see",
    );
    assert.equal(f.published.length, 0);
  });

  it("scans the states the contract names, so a tenth state cannot be skipped by accident", () => {
    assert.deepEqual(
      [...RECOVERABLE_STATES].sort(),
      ["awaiting_approval", "cancelling", "planning", "queued", "running"],
      "derived from the lifecycle rather than typed out beside it: the three terminal states are the only ones absent, " +
        "and a new state added to TASK_STATES has to be added here in a commit a reviewer reads",
    );
  });

  it("publishes what it wrote, after the commit", () => {
    const f = fixture([
      { id: "tsk_a", state: "running" },
      { id: "tsk_b", state: "queued" },
    ]);
    f.recovery.recoverAtStartup(T0);
    assert.deepEqual(
      f.published.map((event) => event.id),
      f.events.map((event) => event.id),
      "one restart is one transaction across whatever tasks it found, and a half-applied recovery is worse than none",
    );
    assert.equal(f.published.length, 2);
  });
});
