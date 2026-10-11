// §7 over HTTP: what a restart does to the tasks and the queue a dead process left behind, read back through the routes a
// client actually uses. `packages/agent-runtime/recovery.test.ts` decides *what* recovery does; this file proves the
// Gateway calls it, that the answer survives the file being closed and reopened, and that §6.2's evidence reaches a client
// through `GET /tasks/{id}` rather than only through an event it may have missed.
//
// The restarts here are real: the Fastify instance is closed, the SQLite handle is closed, and a second process-shaped
// object is built over the same file. Nothing is stubbed except the two facts a route cannot yet write: the cancellation
// request in the second test, set through `setState` because `POST /api/v1/tasks/{id}/cancel` arrives with the runner that
// would have something to stop (D-090), and the checkpoint in the last test, committed through the manager because the
// *loop* writes boundaries and driving a whole run over HTTP is `packages/storage/journal.test.ts`'s job. What this file
// proves is the part a unit test cannot: that the row survives the reopen, and that the restarted Gateway — not a fixture
// — is the one answering for it.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { createApprovals, createCheckpoints } from "@crabby/agent-runtime";
import { newId, type TaskCheckpoint, type TaskRecord } from "@crabby/api-contracts";
import { createLogger } from "@crabby/core";
import { buildApp, createClient, type GatewayClient } from "@crabby/gateway";
import { type DataLayout, dataLayout } from "@crabby/platform";
import type { ApprovalRequest } from "@crabby/policy";
import {
  createSqliteApprovalStore,
  createSqliteCheckpointStore,
  createSqliteJournal,
  migrate,
  mintPairingCode,
  openDatabase,
  readEvents,
  redeemPairingCode,
  type SqliteDb,
  setState,
} from "@crabby/storage";

const T3_TTL = 5 * 60_000; // D-064's T3 window, restated as the number a fixture moves a deadline by.

interface Instance {
  readonly client: GatewayClient;
  readonly db: SqliteDb;
  /** What a restart means here: the listener and the file handle both go away, and a second pair is built over the file. */
  stop(): Promise<void>;
}

async function start(layout: DataLayout, db: SqliteDb, token?: string): Promise<Instance> {
  const built = await buildApp({
    db,
    layout,
    log: createLogger({ level: "error", write: () => {} }, "recovery-test"),
    version: "test",
    startedAt: new Date(),
    listenerMode: "local",
  });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const address = built.app.server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const credential = token ?? pair(db);
  return {
    client: createClient({ url: `http://127.0.0.1:${port}`, token: credential }),
    db,
    async stop() {
      await built.app.close();
    },
  };
}

function pair(db: SqliteDb): string {
  const minted = mintPairingCode(db, { name: "recovery-test", interface: "cli" });
  const redeemed = redeemPairingCode(db, minted.code);
  assert.ok(
    redeemed.ok && redeemed.token,
    "the identity has to be paired before it can read anything",
  );
  return redeemed.token as string;
}

function openFile(dir: string): { layout: DataLayout; db: SqliteDb; file: string; close(): void } {
  const layout = dataLayout(dir);
  const file = path.join(dir, "crabby.sqlite3");
  const handle = openDatabase(file);
  // Every process runs `migrate` on startup, which is why an upgrade adds a column instead of asking for a re-install.
  migrate(handle.db);
  return { layout, db: handle.db, file, close: () => handle.close() };
}

function request(taskId: string, overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    taskId,
    tool: "shell.run",
    tier: "T3",
    summary: "run `rm -rf target` in the workspace root",
    exact: "rm -rf target",
    effects: "deletes the build directory",
    reversibility: "irreversible",
    whatCouldGoWrong: "uncommitted output under target/ is lost",
    scope: "once",
    ttlMs: T3_TTL,
    expiresAt: Date.now() + T3_TTL,
    binding: `sha256:${taskId}`,
    ...overrides,
  };
}

async function eventsOf(
  client: GatewayClient,
  taskId: string,
): Promise<{ type: string; payload: Record<string, unknown> }[]> {
  const response = await client.taskEvents(taskId, 0);
  return (response.body as { items: { type: string; payload: Record<string, unknown> }[] }).items;
}

// Node's `fetch` keeps the global undici dispatcher's sockets open for ~72 s after the last response, so a finished file
// looks like a hung one. The same disarm the other two integration files carry.
after(async () => {
  const dispatcher = (globalThis as Record<symbol, unknown>)[
    Symbol.for("undici.globalDispatcher.1")
  ] as { close?: () => Promise<void> } | undefined;
  await dispatcher?.close?.();
});

describe("a restart, over http (§7.1, §7.2)", () => {
  it("marks the task a dead process left behind as interrupted, and says why", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "crabby-recovery-"));
    const first = openFile(dir);
    const before = await start(first.layout, first.db);
    const created = await before.client.createTask(
      { objective: "clean the build directory" },
      "rec-1",
    );
    const task = created.body as TaskRecord;
    assert.equal(task.state, "queued");
    const token = pair(before.db);

    await before.stop();
    first.close();

    const second = openFile(dir);
    const after = await start(second.layout, second.db, token);
    const record = (await after.client.getTask(task.id)).body as TaskRecord;

    assert.equal(
      record.state,
      "interrupted",
      "§7.1 restores the latest valid state and D-083's `recoveryTarget` is uniform: a process that died mid-round leaves " +
        "no trustworthy record of what the model had been told, so nothing here pretends otherwise",
    );
    const logged = await eventsOf(after.client, task.id);
    const interrupted = logged.find((event) => event.type === "task.interrupted");
    assert.ok(
      interrupted,
      "the move has its event, because a state change nobody can replay gets re-done by the next client",
    );
    assert.equal(
      interrupted?.payload.resumed,
      false,
      "§7.2: automatic orchestration of recovery is not automatic authorization",
    );
    assert.match(
      String(interrupted?.payload.reason),
      /no approval covers the step/,
      "and the reason a user reads says which half of §7.2 stopped it",
    );

    await after.stop();
    second.close();
  });

  it("settles a cancellation the user asked for before the crash instead of resurrecting it", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "crabby-recovery-"));
    const first = openFile(dir);
    const before = await start(first.layout, first.db);
    const created = await before.client.createTask({ objective: "send the summary" }, "rec-2");
    const task = created.body as TaskRecord;
    const token = pair(before.db);
    // The request, written the way `cancellation.ts` writes it — mode, who and why on the record, not only in the log. No
    // route can do this yet, and that is the honest gap: the recovery behaviour is what a route would have to honour.
    setState(before.db, task.id, "cancelling", {
      cancellation: {
        mode: "immediate",
        requestedAt: new Date().toISOString(),
        by: "cln_phone",
        reason: "it was sending to the wrong recipient",
      },
    });

    await before.stop();
    first.close();

    const second = openFile(dir);
    const after = await start(second.layout, second.db, token);
    const record = (await after.client.getTask(task.id)).body as TaskRecord;

    assert.equal(record.state, "cancelled", "a restart does not get to un-ask a cancellation");
    assert.equal(record.cancellation?.mode, "immediate");
    assert.equal(record.cancellation?.by, "cln_phone");
    assert.equal(record.cancellation?.reason, "it was sending to the wrong recipient");
    assert.equal(
      record.cancellation?.terminated,
      false,
      "a dead process cannot confirm that anything stopped",
    );
    assert.equal(
      record.cancellation?.effectsUncertain,
      true,
      "§6.2: the uncertainty is on the task, where a client polls it",
    );
    assert.equal(
      record.cancellation?.inFlight,
      "unknown",
      "and it says it does not know what was running rather than picking `none` and reading as a clean stop (D-092)",
    );
    const logged = await eventsOf(after.client, task.id);
    assert.ok(
      logged.some((event) => event.type === "task.cancelled"),
      "`task.cancelled` is in §5.2's actionable set, so the settle is a frame a client can act on",
    );
    assert.ok(
      !logged.some((event) => event.type === "task.interrupted"),
      "a settled cancellation does not pass through `interrupted`, where a runner might later resume it",
    );

    await after.stop();
    second.close();
  });

  it("expires a prompt whose deadline passed while the process was dead", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "crabby-recovery-"));
    const first = openFile(dir);
    const before = await start(first.layout, first.db);
    const created = await before.client.createTask({ objective: "delete target/" }, "rec-3");
    const task = created.body as TaskRecord;
    const token = pair(before.db);
    const approvals = createApprovals({
      store: createSqliteApprovalStore(first.db),
      newId: () => newId("apr"),
    });
    // A deadline in the past and no `ttlMs`, because the arbiter checks a request's deadline against the TTL the request
    // itself carries: faking the pair is the one thing a fixture may not do.
    const opened = approvals.open(
      request(task.id, { expiresAt: Date.now() - 1_000, ttlMs: undefined }),
      Date.now() - T3_TTL,
    );
    assert.ok(opened.ok, JSON.stringify(opened));

    await before.stop();
    first.close();

    const second = openFile(dir);
    const after = await start(second.layout, second.db, token);
    const pending = (await after.client.approvals({ state: "pending" })).body as { count: number };
    const expired = (await after.client.approvals({ state: "expired" })).body as { count: number };

    assert.equal(
      pending.count,
      0,
      "the queue a client reads after a restart is the queue that is true",
    );
    assert.equal(expired.count, 1);
    const logged = await eventsOf(after.client, task.id);
    assert.ok(
      logged.some((event) => event.type === "approval.expired"),
      "a row the clock expired still owes its event, or the log and the queue disagree about whether the prompt is open",
    );

    await after.stop();
    second.close();
  });

  it("expires a stale prompt on the read that renders the queue, with no restart at all (D-093)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "crabby-recovery-"));
    const instance = openFile(dir);
    const server = await start(instance.layout, instance.db);
    const created = await server.client.createTask({ objective: "delete target/" }, "rec-4");
    const task = created.body as TaskRecord;
    const approvals = createApprovals({
      store: createSqliteApprovalStore(instance.db),
      newId: () => newId("apr"),
    });
    approvals.open(
      request(task.id, { expiresAt: Date.now() - 1_000, ttlMs: undefined }),
      Date.now() - T3_TTL,
    );

    const listed = (await server.client.approvals()).body as {
      count: number;
      state: string;
      serverTime: string;
    };
    assert.equal(
      listed.state,
      "pending",
      "the route's default is the queue a client is waiting on",
    );
    assert.equal(
      listed.count,
      0,
      "§6.3's expire-on-timeout is worth nothing if a stale prompt is still shown as pending — and this count is what " +
        '`crabby status` prints as "N waiting"',
    );
    assert.ok(
      typeof listed.serverTime === "string",
      "the clock the countdown is rendered against is the server's",
    );

    const logged = await eventsOf(server.client, task.id);
    assert.equal(
      logged.filter((event) => event.type === "approval.expired").length,
      1,
      "one expiry, one event",
    );
    const again = (await server.client.approvals()).body as { count: number };
    assert.equal(again.count, 0);
    assert.equal(
      (await eventsOf(server.client, task.id)).filter((event) => event.type === "approval.expired")
        .length,
      1,
      "and a second read does not log the same expiry twice, because the row is no longer pending",
    );

    await server.stop();
    instance.close();
  });

  it("reports the boundary a dead run left behind, and D-065's verdict on it (D-095)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "crabby-recovery-"));
    const first = openFile(dir);
    // The two halves of a restart are released from a `finally` rather than at the end of the body, because a test that
    // fails with a listener still bound and a file handle still open does not report a failure — it hangs for two and a
    // half minutes on an undici socket and reports nothing. The other tests here clean up inline, and can afford to only
    // as long as they pass.
    let second: ReturnType<typeof openFile> | undefined;
    let after: Instance | undefined;
    const before = await start(first.layout, first.db);
    try {
      const created = await before.client.createTask({ objective: "delete target/" }, "rec-5");
      const task = created.body as TaskRecord;

      // A task with no saved state answers 404, and the verdict is in the envelope rather than guessed from an empty body.
      let missing: { status: number; details?: Record<string, unknown> | undefined } | undefined;
      try {
        await before.client.taskCheckpoint(task.id);
      } catch (error) {
        const failure = error as {
          status: number;
          envelope: { error: { details?: Record<string, unknown> } };
        };
        missing = { status: failure.status, details: failure.envelope.error.details };
      }
      assert.equal(
        missing?.status,
        404,
        '"no saved state" is its own answer and not an empty object, because a client that has to guess which of the two it ' +
          "got is a client that will eventually resume from nothing",
      );
      assert.equal(missing?.details?.verdict, "none");
      assert.match(String(missing?.details?.reason), /never reached a step boundary/);

      // The run then commits one step and dies on the next — `running` first, because the loop moves the task in the same
      // phase that records the step, and a boundary written against `queued` would be a boundary the state machine says is
      // impossible. Written through the manager because the loop is what does this,
      // and *inside* a transaction for the same reason: D-065's boundary is a property of the commit, not a note after it.
      const journal = createSqliteJournal({ db: first.db, layout: first.layout });
      const checkpoints = createCheckpoints({
        store: createSqliteCheckpointStore(first.db),
        journal,
        eventsAfter: (taskId, afterSeq) =>
          readEvents(first.db, taskId, { afterSeq, limit: 10_000 }),
      });
      setState(first.db, task.id, "running", { now: new Date().toISOString() });
      const boundary = first.db.transaction(() => {
        const completed = journal.append({
          taskId: task.id,
          type: "tool.execution.completed",
          payload: { tool: "file.read", output: "target/ contains 412 files" },
          at: Date.now(),
        });
        const committed = checkpoints.commit({
          taskId: task.id,
          boundary: "step",
          step: 1,
          modelId: "fake-tools",
          messages: [
            { role: "user", content: "delete target/" },
            { role: "tool", content: "target/ contains 412 files", toolCallId: "call_1" },
          ],
        });
        const started = journal.append({
          taskId: task.id,
          type: "tool.execution.started",
          payload: { tool: "file.delete", args: { path: "target/" } },
          at: Date.now(),
        });
        return { completed, committed, started };
      })();
      await before.stop();

      second = openFile(dir);
      after = await start(second.layout, second.db);
      const view = (await after.client.taskCheckpoint(task.id)).body as TaskCheckpoint;

      assert.equal(view.taskId, task.id);
      assert.equal(
        view.state,
        "running",
        "the state *at the boundary*, not the state now — `GET /tasks/{id}` answers that",
      );
      assert.equal(
        ((await after.client.getTask(task.id)).body as TaskRecord).state,
        "interrupted",
        "the boundary is durable and §7.1 still interrupts the task: a saved state a runner *could* resume from is not a run " +
          "that was resumed, and the two must not be confused by the client reading this screen",
      );
      assert.equal(view.boundary, "step");
      assert.equal(view.step, 1);
      assert.equal(
        view.lastSeq,
        boundary.completed.seq,
        "the sequence number the event store assigned and not one supplied, which is the whole reason the manager is called " +
          "from inside the phase: the boundary points at the event that made the step committed",
      );
      assert.equal(boundary.committed.lastSeq, boundary.completed.seq);
      assert.equal(view.modelId, "fake-tools");
      assert.equal(view.messages, 2, "a count of the working context, never the context itself");
      assert.equal(
        JSON.stringify(view).includes("412 files"),
        false,
        "the transcript stays in the store: §8.2 counts a checkpoint as a different category from the conversation record, " +
          "and four interfaces holding a redacted copy of it would be four copies to keep in sync",
      );
      assert.equal(
        view.resume.verdict,
        "re-ask",
        "the step that started and never reported is what the *log* says after the boundary, so the verdict moves without " +
          "the row changing — which is why D-095 computes it at read time",
      );
      assert.deepEqual(view.resume.inFlight, {
        tool: "file.delete",
        startedSeq: boundary.started.seq,
      });

      const logged = await eventsOf(after.client, task.id);
      const interrupted = logged.find((event) => event.type === "task.interrupted");
      assert.equal(
        (interrupted?.payload.checkpoint as { verdict?: string })?.verdict,
        "re-ask",
        "the same fact reaches a client that only streams what a client that polls would read (§5.2's rule, running in the " +
          "direction the restart needs)",
      );
      assert.match(String(interrupted?.payload.reason), /verdict on it is `re-ask`/);
    } finally {
      await after?.stop();
      second?.close();
      first.close();
    }
  });
});
