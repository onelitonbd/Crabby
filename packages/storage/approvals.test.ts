// The approval repository, asserted as the three sentences that only a real database can answer: the row a client
// reads back is the row that was written (`SECURITY.md` §6.3's fields, byte for byte), a restart neither satisfies a
// pending approval nor forgives a used one (§17's approval tests, verbatim), and the answers are identical to the ones
// the in-memory store gives — because four surfaces agreeing on an approval is a fact about *one* set of rules, not a
// fact about two implementations that happen to look alike.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  type ApprovalRecord,
  type ApprovalStore,
  createApprovals,
  createMemoryApprovalStore,
} from "@crabby/agent-runtime";
import type { ApprovalRequest } from "@crabby/policy";
import { createSqliteApprovalStore } from "./approvals.ts";
import { openDatabase, type SqliteDb } from "./db.ts";
import { MIGRATIONS, migrate } from "./migrate.ts";
import { createTask } from "./tasks.ts";

const T3_TTL = 5 * 60_000;
const T0 = 1_700_000_000_000;

function fileDb(): { db: SqliteDb; file: string; close(): void } {
  const dir = mkdtempSync(path.join(tmpdir(), "crabby-approvals-"));
  const file = path.join(dir, "crabby.sqlite3");
  const handle = openDatabase(file);
  migrate(handle.db);
  return { db: handle.db, file, close: () => handle.close() };
}

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    taskId: "tsk_01",
    tool: "shell.run",
    tier: "T3",
    summary: "run `rm -rf target` in the workspace root",
    exact: "rm -rf target",
    effects: "deletes the build directory",
    reversibility: "irreversible",
    whatCouldGoWrong: "uncommitted files under target/ are lost",
    scope: "once",
    ttlMs: T3_TTL,
    expiresAt: T0 + T3_TTL,
    binding: "sha256:aaa1",
    ...overrides,
  };
}

function service(store: ApprovalStore) {
  let next = 0;
  function newId(): string {
    next += 1;
    return `apv_${next}`;
  }
  return createApprovals({ store, newId });
}

describe("the approval row", () => {
  it("comes back with the request byte-identical, including what was left unset", () => {
    const { db, close } = fileDb();
    const task = createTask(db, { objective: "clean the build directory" });
    const store = createSqliteApprovalStore(db);
    const request_ = request({ taskId: task.id });
    // `supersedes` carries a foreign key to the row it replaces, so the answered question has to exist for the re-ask to
    // be inserted — which is the schema refusing a chain link to nothing, the same fact §6.3's re-ask needs to be true
    // in ten minutes when a user asks "why did this get asked twice?".
    store.insert({
      id: "apv_0",
      request: { ...request_, binding: "sha256:9999" },
      requestedAt: T0 - 60_000,
      state: "denied",
      answeredAt: T0 - 30_000,
      answeredBy: "cli_00",
    });
    const record: ApprovalRecord = {
      id: "apv_1",
      request: request_,
      requestedAt: T0,
      state: "pending",
      supersedes: "apv_0",
    };
    store.insert(record);
    assert.deepEqual(
      store.get("apv_1"),
      record,
      "a pending row round-trips with no invented fields",
    );

    // `supersedes` rides with the request rather than with the answer: which earlier question a row replaces is a fact
    // about why the row exists, so the `UPDATE` has no column for it, exactly as it has none for the binding.
    store.update({
      ...record,
      state: "approved",
      answeredAt: T0 + 60_000,
      answeredBy: "cli_01",
      supersedes: "apv_unrelated",
    });
    const back = store.get("apv_1");
    assert.equal(back?.state, "approved");
    assert.equal(back?.answeredBy, "cli_01");
    assert.equal(back?.supersedes, "apv_0", "…and an answer cannot move the chain");
    assert.deepEqual(
      back?.request,
      request_,
      "the request the user saw is not a projection of the columns",
    );
    assert.deepEqual(
      store.all().map((row) => [row.id, row.state]),
      [
        ["apv_0", "denied"],
        ["apv_1", "approved"],
      ],
      "`all()` is insertion order by `rowid`, so a queue read at 09:05 lists the same rows in the same order",
    );
    close();
  });

  it("keeps an answer from rewriting what was asked, because the statement has no columns to do it with", () => {
    const { db, close } = fileDb();
    const task = createTask(db, { objective: "x" });
    const store = createSqliteApprovalStore(db);
    const original = request({ taskId: task.id });
    const record: ApprovalRecord = {
      id: "apv_1",
      request: original,
      requestedAt: T0,
      state: "pending",
    };
    store.insert(record);

    // A caller that tried to move the binding, the deadline or the task while recording an answer gets its *state*
    // written and nothing else — the narrowness of the `UPDATE` is the mechanism, not a convention in a comment.
    store.update({
      ...record,
      state: "approved",
      requestedAt: T0 + 999_999,
      request: {
        ...original,
        binding: "sha256:TAMPERED",
        expiresAt: T0 + 99 * 60_000,
        taskId: "tsk_other",
      },
    });
    const after = store.get("apv_1");
    assert.equal(after?.state, "approved", "the answer itself is recorded");
    assert.equal(after?.request.binding, "sha256:aaa1");
    assert.equal(after?.request.expiresAt, T0 + T3_TTL);
    assert.equal(after?.request.taskId, task.id);
    assert.equal(after?.requestedAt, T0);
    close();
  });

  it("cannot be stored in a state the runtime cannot be in, and says so when read from a file that is", () => {
    const { db, close } = fileDb();
    const task = createTask(db, { objective: "x" });
    const store = createSqliteApprovalStore(db);
    const record: ApprovalRecord = {
      id: "apv_1",
      request: request({ taskId: task.id }),
      requestedAt: T0,
      state: "pending",
    };
    store.insert(record);
    // `CHECK` covers `INSERT` and `UPDATE`, so no statement this build can write produces a fifth state, and
    // `toRecord`'s guard is therefore about the file that arrives from somewhere else: an older build, or a hand
    // edit. Both halves are named because the second is unreachable *here* and that is the point of the first.
    assert.throws(
      () => db.prepare("UPDATE approval SET state = 'auto-approved' WHERE id = 'apv_1'").run(),
      /CHECK constraint failed/,
    );
    assert.equal(store.get("apv_1")?.state, "pending");
    close();
  });

  it("loses its approvals with its task, and refuses to record an answer into the gap", () => {
    const { db, close } = fileDb();
    const task = createTask(db, { objective: "x" });
    const store = createSqliteApprovalStore(db);
    const record: ApprovalRecord = {
      id: "apv_1",
      request: request({ taskId: task.id }),
      requestedAt: T0,
      state: "pending",
    };
    store.insert(record);
    db.prepare("DELETE FROM task WHERE id = ?").run(task.id);
    assert.deepEqual(
      store.all(),
      [],
      "docs/DATA_AND_MEMORY.md §7 deletes a session's approvals with the session",
    );
    assert.throws(
      () => store.update({ ...record, state: "approved", answeredAt: T0 + 1 }),
      (error: Error) =>
        error.message.includes("no longer in the table") &&
        error.message.includes("DATA_AND_MEMORY.md §7"),
      "an update that matches nothing is a refusal, not a no-op: D-084's whole claim is that a row and its event cannot disagree",
    );
    close();
  });
});

describe("the queue across a restart (SECURITY.md §17's approval tests)", () => {
  it("is still pending after a restart, and still only usable once", () => {
    const { db, file, close } = fileDb();
    const task = createTask(db, { objective: "x" });
    const before = service(createSqliteApprovalStore(db));
    const opened = before.open(request({ taskId: task.id }), T0);
    assert.ok(opened.ok);
    close();

    const reopened = openDatabase(file);
    migrate(reopened.db);
    const after = service(createSqliteApprovalStore(reopened.db));

    assert.equal(after.pending(task.id).length, 1, "the queue survives the process");
    assert.equal(
      after.pending(task.id)[0]?.state,
      "pending",
      "…unanswered, not silently satisfied",
    );
    const tooEarly = after.consume({
      id: opened.record.id,
      taskId: task.id,
      tool: "shell.run",
      binding: "sha256:aaa1",
      at: T0 + 1_000,
    });
    assert.ok(!tooEarly.ok);
    if (!tooEarly.ok) {
      assert.equal(
        tooEarly.code,
        "not-pending",
        "an approval nobody answered is not executable after a restart",
      );
    }

    const answered = after.answer({
      id: opened.record.id,
      decision: "approve",
      scope: "once",
      via: "tui",
      at: T0 + 2_000,
    });
    assert.ok(answered.ok, JSON.stringify(answered));
    const first = after.consume({
      id: opened.record.id,
      taskId: task.id,
      tool: "shell.run",
      binding: "sha256:aaa1",
      at: T0 + 3_000,
    });
    assert.ok(first.ok, "the answer recorded before the restart is honored after it");
    reopened.close();

    const secondBoot = openDatabase(file);
    migrate(secondBoot.db);
    const third = service(createSqliteApprovalStore(secondBoot.db));
    const again = third.consume({
      id: opened.record.id,
      taskId: task.id,
      tool: "shell.run",
      binding: "sha256:aaa1",
      at: T0 + 4_000,
    });
    assert.ok(!again.ok);
    assert.equal(again.code, "consumed", "a restart is not a second use of `scope: once` (D-052)");
    assert.equal(third.list({ state: "consumed" }).length, 1);
    secondBoot.close();
  });
});

describe("upgrading", () => {
  it("gains the approval table on a version-1 file instead of asking for a re-install (docs/DATA_AND_MEMORY.md §2.6)", () => {
    // A v1 database, made by undoing this milestone's migration and recording the ledger row `migrate` would have
    // written. The point is that the next start adds a table and disturbs nothing, because the alternative reading of
    // §2.6 is "upgrade = re-install", and on a phone that means losing the task history that outlives an approval.
    const { db, close } = fileDb();
    // A row written before the upgrade: created while the schema is still current, so the `createTask` this file calls
    // finds every column it names — the undo below then removes the ones v1 never had, leaving the row standing for the
    // upgrade to keep.
    const task = createTask(db, { objective: "survives the upgrade" });
    // Undoing *this* milestone's migration means undoing every migration after it too: a real v1 file has no `approval`
    // table, no `cancellation_json` column, no `model` or `model_switch_json` column, no `checkpoint` table, no job pair
    // and no session record,
    // and a fixture that left them in place would fail a later migration's CREATE or ALTER for a reason no upgrade would
    // ever meet. `job_run` goes before `job` because it is the one holding the foreign key.
    db.exec(
      "DELETE FROM schema_migration; DROP TABLE approval; DROP TABLE checkpoint; DROP TABLE message; " +
        "DROP TABLE memory_reference; DROP TABLE memory_search; DROP TABLE memory_search_fts; DROP TABLE memory; " +
        "DROP TABLE job_run; DROP TABLE job; DROP TABLE session; " +
        "ALTER TABLE task DROP COLUMN cancellation_json; ALTER TABLE task DROP COLUMN model; " +
        "ALTER TABLE task DROP COLUMN model_switch_json; ALTER TABLE task DROP COLUMN origin_json",
    );
    db.prepare("INSERT INTO schema_migration (version, name, applied_at) VALUES (1, ?, ?)").run(
      MIGRATIONS[0]?.name ?? "v1",
      new Date(0).toISOString(),
    );
    assert.deepEqual(migrate(db), {
      applied: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
      version: 13,
    });
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS c FROM task").get() as { c: number } | undefined)?.c,
      1,
      "the row written before the upgrade is the row after it",
    );
    const store = createSqliteApprovalStore(db);
    store.insert({
      id: "apv_1",
      request: request({ taskId: task.id }),
      requestedAt: T0,
      state: "pending",
    });
    assert.equal(
      store.get("apv_1")?.state,
      "pending",
      "and the new table is usable on the same start",
    );
    close();
  });
});

describe("the two stores", () => {
  it("answer one script identically, so persistence changes no rule", () => {
    const { db, close } = fileDb();
    const task = createTask(db, { objective: "x" });
    const sqlite = service(createSqliteApprovalStore(db));
    const memory = service(createMemoryApprovalStore());

    const script = (approvals: ReturnType<typeof service>) => {
      const events: string[] = [];
      const record = (result: ReturnType<typeof approvals.open>, label: string) =>
        `${label}:${result.ok ? `${result.event}${result.deduplicated ? "+dedup" : ""}` : result.code}`;
      const first = approvals.open(request({ taskId: task.id }), T0);
      events.push(record(first, "open"));
      events.push(record(approvals.open(request({ taskId: task.id }), T0 + 10), "re-open"));
      events.push(
        record(
          approvals.answer({
            id: "apv_1",
            decision: "approve",
            scope: "always" as "once",
            via: "tui",
            at: T0 + 20,
          }),
          "scope",
        ),
      );
      events.push(
        record(
          approvals.answer({
            id: "apv_1",
            decision: "approve",
            scope: "once",
            via: "telegram",
            at: T0 + 30,
          }),
          "surface",
        ),
      );
      const answered = approvals.answer({
        id: "apv_1",
        decision: "approve",
        scope: "once",
        byClientId: "cli_01",
        via: "tui",
        at: T0 + 40,
      });
      events.push(record(answered, "answer"));
      events.push(
        record(
          approvals.answer({
            id: "apv_1",
            decision: "deny",
            scope: "once",
            via: "tui",
            at: T0 + 50,
          }),
          "second-answer",
        ),
      );
      // The denied re-request and the re-ask chain, then a materially different action that must open a new row.
      events.push(record(approvals.open(request({ taskId: task.id }), T0 + 60), "repeat"));
      const askedAgain = approvals.open(
        request({ taskId: task.id, binding: "sha256:bbb2", expiresAt: T0 + 60 + T3_TTL }),
        T0 + 60,
      );
      events.push(record(askedAgain, "re-ask"));
      events.push(
        record(
          approvals.consume({
            id: "apv_1",
            taskId: task.id,
            tool: "shell.run",
            binding: "sha256:aaa1",
            at: T0 + 70,
          }),
          "consume",
        ),
      );
      // A deadline one millisecond out, and `ttlMs` left unset rather than shrunk: the arbiter checks a request's
      // `expiresAt` against the TTL the request itself carries (D-064's table belongs to `packages/policy`, not to a
      // second copy here), so this is the shape that legitimately has no per-tier window at all.
      const expired = approvals.open(
        request({
          taskId: task.id,
          tool: "fs.write",
          binding: "sha256:ccc3",
          ttlMs: undefined,
          expiresAt: T0 + 81,
        }),
        T0 + 80,
      );
      events.push(record(expired, "short"));
      const swept = approvals.sweep(T0 + 90);
      events.push(`sweep:${swept.expired.length}:${swept.expired[0]?.event ?? "-"}`);
      return {
        events,
        refusals: approvals.refusalCount(task.id, "shell.run"),
        rows: approvals.list().map((row) => [row.id, row.state, row.supersedes ?? "-"] as const),
      };
    };

    // `sweep` is not an `ApprovalResult`, so its line is appended as a count rather than as an event; the equality that
    // matters is that both stores swept the same single row.
    const a = script(sqlite);
    const b = script(memory);
    assert.deepEqual(
      a,
      b,
      "the SQLite answer to every step is the in-memory answer, refusals included",
    );
    assert.ok(
      a.events.includes("surface:surface-not-allowed") &&
        a.events.includes("scope:scope-unsupported"),
      `and the refusals the rule exists to produce are in the transcript: ${a.events.join("|")}`,
    );
    assert.equal(
      a.rows.length,
      4,
      "one answered row, one re-asked row, one material change, one swept row",
    );
    close();
  });
});
