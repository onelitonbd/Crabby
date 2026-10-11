// The journal over SQLite, asserted as the properties a Map cannot model: a phase that throws rolls back, `seq` comes
// from the one writer that owns it, and §6.2's cancellation evidence is on the *record* — readable by polling
// `GET /tasks/{id}` and still there after the file is closed and reopened (`SECURITY.md` §17's restart property, applied
// to a run rather than to a queue). The last two tests are the composition F-46 owed: a real task, driven by the loop
// against this database, with the arbiter's rows committing in the same transaction as the task's events.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  createApprovals,
  createCancellation,
  createLoop,
  type TaskJournal,
  type ToolOutcome,
  type ToolRunContext,
} from "@crabby/agent-runtime";
import {
  createScriptedProvider,
  guardApprovals,
  WORKSPACE,
} from "@crabby/agent-runtime/loop-harness";
import { type Event, newId, type TaskRecord } from "@crabby/api-contracts";
import { dataLayout } from "@crabby/platform";
import type { ToolCall } from "@crabby/policy";
import { createSqliteApprovalStore } from "./approvals.ts";
import { openDatabase, type SqliteDb } from "./db.ts";
import { readEvents } from "./events.ts";
import { createSqliteJournal } from "./journal.ts";
import { migrate } from "./migrate.ts";
import { createTask, getTask, setState } from "./tasks.ts";

const PATH_ARGS = { type: "object", properties: { path: { type: "string" } } } as const;
const T0 = 1_700_000_000_000;

function tempDb(): { db: SqliteDb; dir: string; file: string; close(): void } {
  const dir = mkdtempSync(path.join(tmpdir(), "crabby-journal-"));
  const file = path.join(dir, "crabby.sqlite3");
  const handle = openDatabase(file);
  migrate(handle.db);
  return { db: handle.db, dir, file, close: () => handle.close() };
}

/** Reopens the same file the way a restarted Gateway would: a new connection, no shared cache, nothing in memory. */
function reopen(file: string): { db: SqliteDb; close(): void } {
  const handle = openDatabase(file);
  return { db: handle.db, close: () => handle.close() };
}

const deleteRound = [
  { kind: "tool-call", name: "file.delete", arguments: { path: `${WORKSPACE}/build` } },
] as const;
const doneRound = [{ kind: "text", text: "deleted build/" }] as const;

/** The executor the build does not have (`ARCHITECTURE.md` §18's `packages/tools`), recording instead of acting. Declared
 *  here rather than imported from the harness because the harness's own journal is a Map, and the point of this file is
 *  that the database one behaves the same. */
function recordingExecutor(tool: string, hangMs = 0) {
  const executions: { tool: string; aborted: boolean }[] = [];
  return {
    executions,
    surface: {
      specs: () => [
        { name: tool, description: `${tool}, as the executor declares it`, parameters: PATH_ARGS },
      ],
      run: async (call: ToolCall, ctx: ToolRunContext): Promise<ToolOutcome> => {
        let aborted = false;
        if (hangMs > 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, hangMs);
            ctx.signal.addEventListener(
              "abort",
              () => {
                aborted = true;
                clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
          });
        }
        executions.push({ tool: call.tool, aborted });
        return { ok: true, output: `removed ${String(call.args.path)}` };
      },
    },
  };
}

describe("the SQLite journal", () => {
  it("assigns seq from the one writer that owns it, and reads the session off the task", () => {
    const { db, dir, close } = tempDb();
    const journal = createSqliteJournal({ db, layout: dataLayout(dir) });
    const task = createTask(db, { objective: "tidy up" });

    const first = journal.append({
      taskId: task.id,
      type: "task.progress",
      payload: { n: 1 },
      at: T0,
    });
    const second = journal.append({
      taskId: task.id,
      type: "task.progress",
      payload: { n: 2 },
      at: T0 + 1,
    });

    assert.equal(
      first.seq,
      1,
      "seq starts at 1, so `lastSeq === 0` still means 'no events' (D-079)",
    );
    assert.equal(second.seq, 2, "and it is monotone per task without the caller counting");
    assert.equal(
      first.sessionId,
      task.sessionId,
      "the event's session comes from the task, not from the caller",
    );
    assert.equal(
      getTask(db, task.id)?.lastSeq,
      2,
      "`appendEvent` advances the counter; a second writer would lie",
    );
    assert.deepEqual(
      readEvents(db, task.id).map((event) => event.seq),
      [1, 2],
    );
    close();
  });

  it("rolls a phase back, which is the property a Map cannot model", () => {
    const { db, dir, close } = tempDb();
    const journal = createSqliteJournal({ db, layout: dataLayout(dir) });
    const task = createTask(db, { objective: "will half-write" });

    assert.throws(
      () =>
        journal.transact(() => {
          journal.append({ taskId: task.id, type: "task.progress", payload: {}, at: T0 });
          setState(db, task.id, "running", { now: new Date(T0).toISOString() });
          throw new Error("the phase broke after two writes");
        }),
      /the phase broke/,
    );

    assert.equal(readEvents(db, task.id).length, 0, "the event is gone");
    assert.equal(
      getTask(db, task.id)?.state,
      "queued",
      "and so is the state move: one commit or none",
    );
    close();
  });

  it("names the task when an event has nothing to belong to", () => {
    const { db, dir, close } = tempDb();
    const journal = createSqliteJournal({ db, layout: dataLayout(dir) });

    assert.throws(
      () => journal.append({ taskId: "tsk_absent", type: "task.progress", payload: {}, at: T0 }),
      /tsk_absent is not in the database/,
      "the foreign key would have refused it anyway; the message is the difference between a reviewer acting and guessing",
    );
    close();
  });

  it("carries §6.2's evidence on the record, and it survives closing the file (F-46)", () => {
    const { db, file, close } = tempDb();
    const task = createTask(db, { objective: "delete the build directory" });
    setState(db, task.id, "cancelling", { now: new Date(T0).toISOString() });

    setState(db, task.id, "cancelled", {
      now: new Date(T0 + 1_000).toISOString(),
      cancellation: {
        mode: "immediate",
        requestedAt: new Date(T0).toISOString(),
        settledAt: new Date(T0 + 1_000).toISOString(),
        terminated: false,
        effectsUncertain: true,
        inFlight: "tool",
        by: "cln_phone",
        reason: "it was sending to the wrong recipient",
      },
    });
    const before = getTask(db, task.id);
    assert.equal(before?.cancellation?.effectsUncertain, true);
    assert.equal(before?.cancellation?.terminated, false);
    close();

    const again = reopen(file);
    const after = getTask(again.db, task.id);
    assert.deepEqual(
      after?.cancellation,
      before?.cancellation,
      "§6.2 requires the uncertainty to be recorded on the task, and §17 requires that to mean after a restart — a fact " +
        "that only lived in process memory would be a fact a killed phone loses",
    );
    assert.equal(after?.state, "cancelled");
    // The two omission rules differ on purpose, and a client depends on both: an error is cleared by a move that carries
    // none, because a reason for a state the task is no longer in is a reason nobody can act on; the cancellation is
    // kept, because only the settle writes it and it is written once.
    setState(again.db, task.id, "interrupted", {
      now: new Date(T0 + 2_000).toISOString(),
      error: { code: "provider.rate-limit", message: "the provider was busy" },
    });
    const moved = getTask(again.db, task.id);
    assert.equal(moved?.state, "interrupted");
    assert.equal(moved?.error?.code, "provider.rate-limit");
    assert.deepEqual(
      moved?.cancellation,
      before?.cancellation,
      "a later state move does not erase what a cancellation recorded (COALESCE, not overwrite)",
    );
    setState(again.db, task.id, "queued", { now: new Date(T0 + 3_000).toISOString() });
    assert.equal(
      getTask(again.db, task.id)?.error,
      undefined,
      "and an error is cleared by the next move",
    );
    assert.deepEqual(getTask(again.db, task.id)?.cancellation, before?.cancellation);
    again.close();
  });

  it("gains the column on a version-2 file rather than asking for a re-install", () => {
    // The same shape as the approval table's upgrade test: undo this migration, keep the rows, and let the next start add
    // the column. `docs/DATA_AND_MEMORY.md` §2.6's alternative reading is "upgrade = re-install", and on a phone that
    // means losing the task history that outlives one cancellation.
    const { db, dir, close } = tempDb();
    // Undoing v3 means undoing v4 as well, for the reason `approvals.test.ts` gives: a ledger that still records the later
    // migration would leave `migrate` with nothing to apply, and the fixture would be testing an upgrade no file can be in.
    db.exec(
      "DELETE FROM schema_migration WHERE version >= 3; DROP TABLE checkpoint; " +
        "ALTER TABLE task DROP COLUMN cancellation_json",
    );
    const task = createTask(db, { objective: "survives the upgrade" });
    // Nothing is read before `migrate` on purpose: v3's SELECT names the new column, so a v2 file is unreadable by v3
    // code until the migration runs. That is why every process migrates on startup rather than lazily, and why this test
    // asserts the upgrade instead of the state before it.
    assert.deepEqual(migrate(db), { applied: [3, 4], version: 4 });
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS c FROM task").get() as { c: number } | undefined)?.c,
      1,
      "the row written before the upgrade is the row after it",
    );
    setState(db, task.id, "cancelling", { now: new Date(T0).toISOString() });
    setState(db, task.id, "cancelled", {
      now: new Date(T0 + 1).toISOString(),
      cancellation: {
        mode: "finish-step",
        requestedAt: new Date(T0).toISOString(),
        settledAt: new Date(T0 + 1).toISOString(),
        terminated: true,
        effectsUncertain: false,
        inFlight: "none",
      },
    });
    assert.equal(getTask(db, task.id)?.cancellation?.mode, "finish-step");
    close();
    void dir;
  });

  it("runs a whole gated task against the database, with the arbiter committing in the same transaction", async () => {
    const { db, dir, file, close } = tempDb();
    const layout = dataLayout(dir);
    const task = createTask(db, { objective: "delete build/ and report" });
    const published: Event[] = [];

    // The journal, with a flag that says when a transaction is open: the arbiter is wrapped in it so this test proves the
    // property over the real database rather than over a Map — an approval row and the task's events commit together, or
    // a crash leaves a queue and a log that disagree.
    let inside = false;
    const sqlite = createSqliteJournal({ db, layout });
    const journal: TaskJournal = {
      ...sqlite,
      transact: <T>(body: () => T): T => {
        inside = true;
        try {
          return sqlite.transact(body);
        } finally {
          inside = false;
        }
      },
    };
    const approvals = guardApprovals(
      createApprovals({ store: createSqliteApprovalStore(db), newId: () => newId("apr") }),
      () => inside,
    );
    const executor = recordingExecutor("file.delete");
    let at = T0;
    const loop = createLoop({
      journal,
      approvals,
      provider: createScriptedProvider([deleteRound, doneRound]),
      tools: executor.surface,
      platform: { isTermux: false },
      publish: (event) => {
        assert.equal(inside, false, "publishing happens after the commit, never inside it");
        published.push(event);
      },
      now: () => at,
    });

    const started = await loop.start({
      taskId: task.id,
      modelId: "fake-tools",
      subject: { grants: ["fs.write"], clientKind: "cli" },
      ctx: {
        grants: ["fs.write"],
        paths: { home: "/home/user", dataDir: dir, roots: [WORKSPACE] },
        realpathOf: (absolutePath: string) => absolutePath,
      },
    });
    assert.equal(started.kind, "awaiting-approval", JSON.stringify(started));
    if (started.kind !== "awaiting-approval") return;
    assert.equal(getTask(db, task.id)?.state, "awaiting_approval");
    const rows = approvals.list({ state: "pending" });
    assert.equal(
      rows.length,
      1,
      "the prompt is a row in the approval table, not a promise in memory",
    );
    assert.equal(rows[0]?.request.tier, "T2");

    // The answer, written the way the §4.3 route writes it: the arbiter's row and the event in one transaction.
    at += 1_000;
    const answered = journal.transact(() => {
      const result = approvals.answer({
        id: rows[0]?.id ?? "",
        decision: "approve",
        scope: "once",
        via: "web",
        byClientId: "cln_web",
        at,
      });
      const stored =
        result.ok && result.event
          ? journal.append({
              taskId: task.id,
              type: result.event,
              at,
              payload: { approvalId: result.record.id, outcome: "approve" },
            })
          : undefined;
      return { result, stored };
    });
    assert.equal(answered.result.ok, true, JSON.stringify(answered.result));
    // The route publishes after the transaction commits; a test that skipped this would be comparing a stream to a
    // database it never sent.
    if (answered.stored !== undefined) published.push(answered.stored);

    const finished = await loop.resume(started.run);
    assert.equal(finished.kind, "completed", JSON.stringify(finished));
    assert.deepEqual(executor.executions, [{ tool: "file.delete", aborted: false }]);

    const record = getTask(db, task.id);
    assert.equal(record?.state, "completed");
    const types = readEvents(db, task.id).map((event) => event.type);
    assert.deepEqual(
      types,
      [
        "task.state.changed",
        "tool.call.proposed",
        "approval.requested",
        "task.state.changed",
        "approval.answered",
        "approval.consumed",
        "task.state.changed",
        "tool.execution.started",
        "tool.execution.completed",
        "message.added",
        "task.completed",
      ],
      "the whole cycle is in the log, in order, with one event per state change",
    );
    assert.deepEqual(
      published.map((event) => event.seq),
      types.map((_, index) => index + 1),
      "and every frame a client was sent is a frame the database holds",
    );
    assert.equal(approvals.list({ taskId: task.id })[0]?.state, "consumed");
    close();

    const again = reopen(file);
    assert.equal(
      getTask(again.db, task.id)?.state,
      "completed",
      "the outcome survives the restart",
    );
    assert.equal(
      readEvents(again.db, task.id).length,
      types.length,
      "and so does every event that carried it",
    );
    again.close();
  });

  it("puts the cancellation evidence on the record when the loop and the manager settle a real run", async () => {
    const { db, dir, file, close } = tempDb();
    const layout = dataLayout(dir);
    const task = createTask(db, { objective: "delete build/" });
    const journal = createSqliteJournal({ db, layout });
    const executor = recordingExecutor("file.read", 200);
    let at = T0;
    const cancellation = createCancellation({ journal, publish: () => undefined, now: () => at });
    const loop = createLoop({
      journal,
      cancellation,
      approvals: createApprovals({
        store: createSqliteApprovalStore(db),
        newId: () => newId("apr"),
      }),
      // A T0 step, so the task is *running* when the cancellation arrives: a gated one would have stopped it at a prompt
      // first, and this test is about §6.1's step in flight rather than §6.3's.
      provider: createScriptedProvider([
        [{ kind: "tool-call", name: "file.read", arguments: { path: "notes.md" } }],
        doneRound,
      ]),
      tools: executor.surface,
      platform: { isTermux: false },
      publish: () => undefined,
      now: () => at,
      limits: { toolDeadlines: { "file.read": 5_000 } },
    });

    const running = loop.start({
      taskId: task.id,
      modelId: "fake-tools",
      subject: { grants: ["fs.read"], clientKind: "cli" },
      ctx: {
        grants: ["fs.read"],
        paths: { home: "/home/user", dataDir: dir, roots: [WORKSPACE] },
        realpathOf: (absolutePath: string) => absolutePath,
      },
      signal: cancellation.signalFor(task.id),
    });
    const deadline = Date.now() + 2_000;
    while (readEvents(db, task.id).every((event) => event.type !== "tool.execution.started")) {
      assert.ok(Date.now() < deadline, "the step never started");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    at += 100;
    const requested = cancellation.request({
      taskId: task.id,
      mode: "immediate",
      byClientId: "cln_phone",
      reason: "stop now",
    });
    assert.equal(requested.ok, true, JSON.stringify(requested));
    const outcome = await running;
    assert.equal(outcome.kind, "cancelled", JSON.stringify(outcome));

    const record: TaskRecord | undefined = getTask(db, task.id);
    assert.equal(record?.state, "cancelled");
    assert.equal(record?.cancellation?.mode, "immediate");
    assert.equal(record?.cancellation?.by, "cln_phone");
    assert.equal(record?.cancellation?.reason, "stop now");
    assert.equal(record?.cancellation?.inFlight, "tool");
    assert.equal(
      record?.cancellation?.effectsUncertain,
      true,
      "§6.2's MUST, on the record a client polls rather than only in the event it may have missed",
    );
    assert.equal(
      executor.executions[0]?.aborted,
      true,
      "the override stopped the step instead of finishing it",
    );
    assert.equal(executor.executions[0]?.tool, "file.read");
    close();

    const again = reopen(file);
    assert.deepEqual(
      getTask(again.db, task.id)?.cancellation,
      record?.cancellation,
      "and it is still there after the file is closed, which is the difference between a record and a variable",
    );
    again.close();
  });
});
