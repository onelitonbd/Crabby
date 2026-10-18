// Storage's own tests, run against real SQLite in a temp directory rather than a mock, because the promises this file
// keeps are all about what the database actually does: a `busy_timeout` that is only real if the driver accepts it, a
// digest that must be provably not the plaintext, a `seq` that must survive a restart. A fake database would test the
// fake.
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { type Event, newId, SCHEMA_VERSION } from "@crabby/api-contracts";
import { dataLayout } from "@crabby/platform";
import {
  appendEvent,
  authenticate,
  codesMatch,
  createIdentity,
  createTask,
  DB_FILE_NAME,
  getTask,
  listIdentities,
  listTasks,
  MIGRATIONS,
  type Migration,
  migrate,
  mintPairingCode,
  newPairingCode,
  oldestRetainedSeq,
  openDatabase,
  pruneEvents,
  pruneScratch,
  REPLAY_WINDOW_EVENTS,
  readEvents,
  readReplayWindow,
  recall,
  redeemPairingCode,
  remember,
  requestHash,
  revoke,
  type SqliteDb,
  schemaVersion,
  scratchRoot,
  setState,
  stateCounts,
  taskScratch,
} from "./index.ts";

function tempDb(): { db: SqliteDb; dir: string; close(): void } {
  const dir = mkdtempSync(path.join(tmpdir(), "crabby-storage-"));
  const handle = openDatabase(path.join(dir, DB_FILE_NAME));
  migrate(handle.db);
  return { db: handle.db, dir, close: handle.close };
}

function event(
  taskId: string,
  sessionId: string,
  payload: Record<string, unknown> = {},
): Event & { taskId: string; sessionId: string } {
  return {
    id: newId("evt"),
    schemaVersion: SCHEMA_VERSION,
    type: "task.progress",
    ts: new Date().toISOString(),
    sessionId,
    taskId,
    seq: 0,
    payload,
  };
}

describe("migrations", () => {
  it("creates the six M1 tables, M2's approval queue, checkpoint, job pair and session record, and a ledger row per migration", () => {
    const { db, close } = tempDb();
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    )
      .map((row) => row.name)
      .sort();
    for (const wanted of [
      "approval",
      "checkpoint",
      "client_identity",
      "idempotency",
      "job",
      "job_run",
      "pairing_code",
      "schema_migration",
      "task",
      "task_event",
    ])
      assert.ok(names.includes(wanted), `missing table ${wanted}`);
    assert.equal(schemaVersion(db), 16);
    // One row per migration, in order, and never an update to an old one: that is what `docs/DATA_AND_MEMORY.md`
    // §2.6's "configuration migrations must be considered when upgrading" means for this file — a v1 database gains a
    // table on the next start rather than being rebuilt, so an upgrade cannot silently drop a pending approval.
    const ledger = db
      .prepare("SELECT version, name FROM schema_migration ORDER BY version")
      .all() as {
      version: number;
      name: string;
    }[];
    assert.deepEqual(
      ledger,
      [
        { version: 1, name: "tasks-events-clients-idempotency" },
        { version: 2, name: "approvals" },
        { version: 3, name: "task-cancellation" },
        { version: 4, name: "checkpoints" },
        { version: 5, name: "jobs" },
        { version: 6, name: "sessions" },
        { version: 7, name: "task-model-pin" },
        { version: 8, name: "task-model-switch" },
        { version: 9, name: "task-origin" },
        { version: 10, name: "messages" },
        { version: 11, name: "message-coverage" },
        { version: 12, name: "message-pins" },
        { version: 13, name: "memory" },
        { version: 14, name: "audit" },
        { version: 15, name: "job-run-history" },
        { version: 16, name: "audit-kind-vault" },
      ],
      "one row per migration and never an update to an old one, so a file can say which version it is on",
    );
    close();
  });

  // D-065's "a failed migration leaves the previous file untouched" (§8's downgrade clause): the transaction
  // rolls back, the ledger does not record the failed version, and the file answers as the version it was.
  it("a migration that fails halfway leaves the previous file untouched and the ledger honest", () => {
    const { db, close } = tempDb();
    try {
      const before = schemaVersion(db);
      const tasksBefore = (db.prepare("SELECT COUNT(*) AS n FROM task").get() as { n: number }).n;
      const intruder = {
        version: before + 1,
        name: "fixture-that-throws",
        up() {
          db.exec("CREATE TABLE fixture_partial (id TEXT PRIMARY KEY)");
          throw new Error("boom — the fixture fails after writing something");
        },
      };
      (MIGRATIONS as unknown as Migration[]).push(intruder);
      try {
        assert.throws(() => migrate(db), /boom/);
        assert.equal(
          schemaVersion(db),
          before,
          "the ledger never recorded the version that failed",
        );
        assert.equal(
          (
            db
              .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'fixture_partial'")
              .get() as { n: number }
          ).n,
          0,
          "the failed migration's partial write rolled back with it",
        );
        assert.equal(
          (db.prepare("SELECT COUNT(*) AS n FROM task").get() as { n: number }).n,
          tasksBefore,
          "the previous version's tables still answer",
        );
      } finally {
        (MIGRATIONS as unknown as Migration[]).pop();
      }
      // And the file carries on: the next migrate is the ordinary idempotent one.
      const again = migrate(db);
      assert.equal(again.applied.length, 0);
    } finally {
      close();
    }
  });

  it("is idempotent, because every CLI process runs migrate on startup", () => {
    const { db, close } = tempDb();
    const second = migrate(db);
    assert.deepEqual(second.applied, []);
    assert.equal(second.version, 16);
    close();
  });

  it("leaves the file safe to reopen, which is the property a restart depends on", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "crabby-reopen-"));
    const file = path.join(dir, DB_FILE_NAME);
    const first = openDatabase(file);
    migrate(first.db);
    const task = createTask(first.db, { objective: "survive a restart" });
    first.close();
    const second = openDatabase(file);
    assert.equal(getTask(second.db, task.id)?.objective, "survive a restart");
    second.close();
  });
});

describe("tasks", () => {
  it("creates a task with a fresh session and the two timestamps the list needs", () => {
    const { db, close } = tempDb();
    const task = createTask(db, { objective: "read the inbox" });
    assert.match(task.id, /^tsk_/);
    assert.match(task.sessionId, /^ses_/);
    assert.equal(task.state, "queued");
    assert.equal(task.lastSeq, 0);
    assert.equal(task.createdAt, task.updatedAt);
    close();
  });

  it("reuses the caller's session when there is one", () => {
    const { db, close } = tempDb();
    const session = newId("ses");
    const task = createTask(db, { objective: "next step", sessionId: session });
    assert.equal(task.sessionId, session);
    close();
  });

  it("records a per-task model pin and reads it back; absent means no pin (D-108)", () => {
    const { db, close } = tempDb();
    const pinned = createTask(db, { objective: "use the small model", model: "local/qwen2.5:3b" });
    assert.equal(pinned.model, "local/qwen2.5:3b");
    assert.equal(getTask(db, pinned.id)?.model, "local/qwen2.5:3b", "the pin survives a read");
    const plain = createTask(db, { objective: "no pin" });
    assert.equal(plain.model, undefined, "an absent pin is undefined, not an empty string");
    assert.equal(getTask(db, plain.id)?.model, undefined);
    close();
  });

  it("pages by id cursor, so a list cannot shift under a writer", () => {
    const { db, close } = tempDb();
    const ids = ["a", "b", "c", "d"].map(
      (letter) => createTask(db, { objective: `task ${letter}` }).id,
    );
    const page = listTasks(db, { limit: 2 });
    assert.equal(page.items.length, 2);
    assert.ok(page.nextCursor, "a page with more behind it must name a cursor");
    const rest = listTasks(db, { limit: 2, cursor: page.nextCursor });
    assert.equal(rest.items.length, 2);
    assert.deepEqual([...page.items, ...rest.items].map((t) => t.id).sort(), [...ids].sort());
    assert.equal(rest.nextCursor, undefined);
    close();
  });

  it("filters by state and counts them for the status screen", () => {
    const { db, close } = tempDb();
    const task = createTask(db, { objective: "will run" });
    createTask(db, { objective: "will wait" });
    setState(db, task.id, "running", { now: new Date().toISOString() });
    assert.deepEqual(
      listTasks(db, { state: "running", limit: 50 }).items.map((t) => t.id),
      [task.id],
    );
    assert.deepEqual(stateCounts(db), { queued: 1, running: 1 });
    close();
  });

  it("carries an error through the record, because §4.3's answer must survive a client that missed the event", () => {
    const { db, close } = tempDb();
    const task = createTask(db, { objective: "will fail" });
    setState(db, task.id, "failed", {
      now: new Date().toISOString(),
      error: { code: "provider_unavailable", message: "no provider answered" },
    });
    const record = getTask(db, task.id);
    assert.equal(record?.state, "failed");
    assert.deepEqual(record?.error, {
      code: "provider_unavailable",
      message: "no provider answered",
    });
    close();
  });
});

describe("events", () => {
  it("numbers seq from 1 per task and keeps task.lastSeq in step", () => {
    const { db, close } = tempDb();
    const task = createTask(db, { objective: "counted" });
    const other = createTask(db, { objective: "counted too" });
    assert.equal(appendEvent(db, { event: event(task.id, task.sessionId) }).seq, 1);
    assert.equal(appendEvent(db, { event: event(task.id, task.sessionId) }).seq, 2);
    assert.equal(appendEvent(db, { event: event(other.id, other.sessionId) }).seq, 1);
    assert.equal(getTask(db, task.id)?.lastSeq, 2);
    assert.equal(getTask(db, other.id)?.lastSeq, 1);
    close();
  });

  it("redacts on write, so a secret never exists in the file at all", () => {
    const { db, dir, close } = tempDb();
    const task = createTask(db, { objective: "leaky" });
    const secret = "sk-live-abcdefghijklmnop";
    appendEvent(db, {
      event: event(task.id, task.sessionId, { api_token: secret, note: "harmless" }),
    });
    const stored = readEvents(db, task.id)[0];
    assert.equal(stored?.payload.note, "harmless");
    assert.notEqual(stored?.payload.api_token, secret);
    // The stronger claim, and the one D-065 hinges on: the bytes on disk never held it. A read-time filter would pass
    // the two lines above and fail this one.
    assert.ok(!readFileSync(path.join(dir, DB_FILE_NAME), "utf8").includes(secret));
    close();
  });

  it("moves an over-cap payload to scratch and leaves a marker in its place", () => {
    const { db, dir, close } = tempDb();
    const task = createTask(db, { objective: "big output" });
    const huge = "x".repeat(70 * 1024);
    const result = appendEvent(db, {
      event: event(task.id, task.sessionId, { output: huge }),
      scratchDir: taskScratch(dataLayout(dir), task.id),
    });
    assert.equal(result.truncated, true);
    assert.ok(result.overflowPath && statSync(result.overflowPath).size > 60 * 1024);
    const stored = readEvents(db, task.id)[0];
    assert.equal(stored?.payload.truncated, true);
    assert.equal(stored?.payload.bytes, JSON.stringify({ output: huge }).length);
    assert.equal(JSON.parse(readFileSync(result.overflowPath as string, "utf8")).output, huge);
    close();
  });

  it("reads with a cursor, and the replay window is count-bounded per task", () => {
    const { db, close } = tempDb();
    const task = createTask(db, { objective: "many events" });
    for (let i = 0; i < 12; i++) appendEvent(db, { event: event(task.id, task.sessionId, { i }) });
    assert.deepEqual(
      readEvents(db, task.id, { afterSeq: 10 }).map((e) => e.payload.i),
      [10, 11],
    );
    assert.equal(readReplayWindow(db, task.id, 5).length, 5);
    assert.equal(oldestRetainedSeq(db, task.id), 1);
    assert.equal(REPLAY_WINDOW_EVENTS, 200);
    close();
  });

  it("prunes by age and by count, and reports what it removed", () => {
    const { db, close } = tempDb();
    const task = createTask(db, { objective: "aged" });
    for (let i = 0; i < 6; i++) appendEvent(db, { event: event(task.id, task.sessionId, { i }) });
    assert.equal(pruneEvents(db, { maxPerTask: 2 }).deleted, 4);
    assert.equal(readEvents(db, task.id).length, 2);
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE task_event SET ts = ? WHERE seq = 6").run(old);
    assert.equal(pruneEvents(db, {}).deleted, 1);
    close();
  });
});

describe("clients and pairing", () => {
  it("mints a code from an alphabet that cannot contain a confusable glyph", () => {
    for (let i = 0; i < 200; i++) {
      const code = newPairingCode();
      assert.match(code, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/);
    }
    assert.equal(
      codesMatch("ABCD2345", "abcd2345"),
      false,
      "a code is matched byte for byte, not case-folded",
    );
    assert.equal(codesMatch("ABCD2345", "ABCD2345"), true);
  });

  it("exchanges a code for a token exactly once", () => {
    const { db, close } = tempDb();
    const minted = mintPairingCode(db, { name: "phone cli", interface: "cli" });
    const redeemed = redeemPairingCode(db, minted.code);
    assert.equal(redeemed.ok, true);
    assert.equal(redeemed.clientId, minted.clientId);
    assert.ok(redeemed.token && authenticate(db, redeemed.token)?.id === minted.clientId);
    assert.equal(redeemPairingCode(db, minted.code).reason, "used");
    close();
  });

  it("expires a code that was never redeemed", () => {
    const { db, close } = tempDb();
    const past = new Date(Date.now() - 1000);
    const minted = mintPairingCode(db, { name: "slow", interface: "tui", now: past, ttlMs: 1 });
    assert.equal(redeemPairingCode(db, minted.code, new Date()).reason, "expired");
    close();
  });

  it("keeps only digests: neither the code nor the token appears in the file", () => {
    const { db, dir, close } = tempDb();
    const minted = mintPairingCode(db, { name: "phone cli", interface: "cli" });
    const redeemed = redeemPairingCode(db, minted.code);
    const token = redeemed.token as string;
    close();
    const bytes = readFileSync(path.join(dir, DB_FILE_NAME), "utf8");
    assert.ok(!bytes.includes(minted.code), "the plaintext code must not be stored");
    assert.ok(!bytes.includes(token), "the plaintext token must not be stored");
  });

  it("answers a wrong code with `unknown`, and never with a client id", () => {
    const { db, close } = tempDb();
    mintPairingCode(db, { name: "real", interface: "web" });
    const wrong = redeemPairingCode(db, "ZZZZZZZZ");
    assert.deepEqual(wrong, { ok: false, reason: "unknown" });
    close();
  });

  it("revokes a token on the next request and lists only live identities", () => {
    const { db, close } = tempDb();
    const first = createIdentity(db, { name: "keep", interface: "cli" });
    const second = createIdentity(db, { name: "drop", interface: "telegram" });
    assert.equal(listIdentities(db).length, 2);
    assert.ok(revoke(db, second.identity.id));
    assert.equal(revoke(db, "nosuchclient"), false);
    assert.equal(authenticate(db, second.token), undefined);
    assert.equal(authenticate(db, first.token)?.name, "keep");
    assert.deepEqual(
      listIdentities(db).map((i) => i.name),
      ["keep"],
    );
    close();
  });

  it("touches last_used_at on authentication, because §3.1 shows a client when it was last seen", () => {
    const { db, close } = tempDb();
    const created = createIdentity(db, { name: "busy", interface: "cli" });
    assert.equal(listIdentities(db)[0]?.lastUsedAt, undefined);
    authenticate(db, created.token);
    assert.ok(listIdentities(db)[0]?.lastUsedAt);
    close();
  });
});

describe("idempotency", () => {
  it("returns the recorded response for the same key and route", () => {
    const { db, close } = tempDb();
    const body = { objective: "create once" };
    const hash = requestHash(body);
    assert.deepEqual(recall(db, "k1", "POST /api/v1/tasks", hash), { found: false });
    remember(db, {
      key: "k1",
      route: "POST /api/v1/tasks",
      requestHash: hash,
      response: { id: "tsk_x" },
    });
    const hit = recall(db, "k1", "POST /api/v1/tasks", hash);
    assert.equal(hit.found, true);
    assert.deepEqual((hit as { record: { response: unknown } }).record.response, { id: "tsk_x" });
    close();
  });

  it("separates routes, so a key cannot leak between two endpoints", () => {
    const { db, close } = tempDb();
    remember(db, { key: "k1", route: "POST /api/v1/tasks", requestHash: "h", response: {} });
    assert.deepEqual(recall(db, "k1", "POST /api/v1/other", "h"), { found: false });
    close();
  });

  it("reports a mismatch rather than silently replaying a different body", () => {
    const { db, close } = tempDb();
    remember(db, { key: "k1", route: "POST /api/v1/tasks", requestHash: "h1", response: {} });
    assert.deepEqual(recall(db, "k1", "POST /api/v1/tasks", "h2"), { found: true, mismatch: true });
    close();
  });

  it("keeps the first answer when two writers race the same key", () => {
    const { db, close } = tempDb();
    remember(db, { key: "k1", route: "POST /api/v1/tasks", requestHash: "h", response: { n: 1 } });
    remember(db, { key: "k1", route: "POST /api/v1/tasks", requestHash: "h", response: { n: 2 } });
    const hit = recall(db, "k1", "POST /api/v1/tasks", "h") as {
      record: { response: { n: number } };
    };
    assert.equal(hit.record.response.n, 1);
    close();
  });
});

describe("scratch", () => {
  it("creates one directory per task, owner-only", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "crabby-scratch-"));
    const layout = dataLayout(dir);
    const taskId = newId("tsk");
    const path2 = taskScratch(layout, taskId);
    assert.equal(path2, path.join(scratchRoot(layout), taskId));
    assert.equal(statSync(path2).mode & 0o077, 0, "no group or other bits");
  });

  it("prunes past its age and names what it removed", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "crabby-prune-"));
    const layout = dataLayout(dir);
    const oldTask = newId("tsk");
    const freshTask = newId("tsk");
    const oldDir = taskScratch(layout, oldTask);
    writeFileSync(path.join(oldDir, "e.json"), "{}");
    utimesSync(path.join(oldDir, "e.json"), new Date(0), new Date(0));
    utimesSync(oldDir, new Date(0), new Date(0));
    taskScratch(layout, freshTask);
    const report = pruneScratch(scratchRoot(layout), { maxAgeMs: 1000 });
    assert.deepEqual(report.removed, [oldTask]);
    assert.ok(!readdirSync(scratchRoot(layout)).includes(oldTask));
    assert.ok(readdirSync(scratchRoot(layout)).includes(freshTask));
  });

  it("survives a scratch root that does not exist yet, because a fresh install has none", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "crabby-noscratch-"));
    assert.deepEqual(pruneScratch(path.join(dir, "scratch")), { removed: [], bytes: 0 });
  });
});
