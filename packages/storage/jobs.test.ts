// The job repository, asserted as the sentences only a real database can answer: the row a client reads back is the row
// that was written, an `update` cannot rewrite what the user approved or who approved it, the two foreign keys behave the
// way §4.5 needs them to (a job survives its creator's revocation; a run survives its task's deletion), and a stored
// value this build does not know is an error rather than a string.
//
// The last block is the one that justifies having two stores at all: the SQL store and `createMemoryJobStore` answer the
// same sequence identically, because the scheduler's unit tests run against the memory one and a difference between them
// would be a rule that holds in a test and not in a product.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createMemoryJobStore, type JobPatch, type JobStore } from "@crabby/agent-runtime";
import type { JobRecord, JobRunRecord } from "@crabby/api-contracts";
import { createIdentity, revoke } from "./clients.ts";
import { openDatabase, type SqliteDb } from "./db.ts";
import { createSqliteJobStore } from "./jobs.ts";
import { MIGRATIONS, migrate, schemaVersion } from "./migrate.ts";
import { createTask } from "./tasks.ts";

const T0 = new Date(2026, 9, 12, 12, 0).getTime();

function fileDb(): { db: SqliteDb; close(): void } {
  const dir = mkdtempSync(path.join(tmpdir(), "crabby-jobs-"));
  const handle = openDatabase(path.join(dir, "crabby.sqlite3"));
  migrate(handle.db);
  return { db: handle.db, close: () => handle.close() };
}

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job_1",
    name: "morning summary",
    schedule: "0 7 * * *",
    objective: "summarise what needs an answer",
    state: "active",
    createdBy: { clientId: "cli_1", name: "the owner", interface: "cli" },
    capabilities: ["task.create", "file.read"],
    sessionId: "ses_1",
    createdAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    nextRunAt: new Date(T0 + 60_000).toISOString(),
    missed: 0,
    utcOffsetMinutes: 360,
    ...overrides,
  };
}

function run(overrides: Partial<JobRunRecord> = {}): JobRunRecord {
  return {
    id: "run_1",
    jobId: "job_1",
    dueAt: new Date(T0 + 60_000).toISOString(),
    recordedAt: new Date(T0 + 61_000).toISOString(),
    outcome: "fired",
    trigger: "schedule",
    occurrences: 1,
    ...overrides,
  };
}

test("schema version 5 is the job tables, and the migration is the one that created them", () => {
  const { db, close } = fileDb();
  try {
    // Ten and not five, because §2.1's conversation record (D-104), the task's model pin, its switch, its origin and
    // D-112's message table all landed after this table did. The assertion that matters here is unchanged: the job tables are version 5's work and no later
    // migration touched them.
    assert.equal(schemaVersion(db), 11);
    assert.equal(
      MIGRATIONS.find((entry) => entry.version === 5)?.name,
      "jobs",
      "the ledger names the migration that created the tables this file is about",
    );
    const fifth = MIGRATIONS.find((entry) => entry.version === 5);
    assert.equal(fifth?.name, "jobs");
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'job%' ORDER BY name",
      )
      .all() as { name: string }[];
    assert.deepEqual(
      tables.map((row) => row.name),
      ["job", "job_run"],
    );
    // The index the tick's one question is organised around: "what is active and due".
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'job%' ORDER BY name",
      )
      .all() as { name: string }[];
    assert.deepEqual(indexes.map((row) => row.name).sort(), [
      "job_run_backlog",
      "job_run_job",
      "job_run_open",
      "job_state_next",
    ]);
  } finally {
    close();
  }
});

test("a job written is the job read back, including the fields that are absent rather than null", () => {
  const { db, close } = fileDb();
  try {
    const store = createSqliteJobStore(db);
    store.insert(job());
    const read = store.get("job_1");
    assert.deepEqual(
      read,
      job(),
      "every field survives the round trip, and the record is the contract's shape",
    );
    assert.equal(read?.nextRunAt, job().nextRunAt);
    assert.equal(
      read?.lastRunAt,
      undefined,
      "an absent last run is absent, not `null` in a JSON body",
    );

    // A paused job's cleared next fire is the fact `crabby job ls` prints, so it has to survive as an absence.
    store.update("job_1", {
      state: "paused",
      nextRunAt: null,
      updatedAt: new Date(T0 + 1).toISOString(),
    });
    const paused = store.get("job_1");
    assert.equal(paused?.state, "paused");
    assert.equal(paused?.nextRunAt, undefined);

    // `all()` is insertion order, which is `rowid`, so the list a client reads at 09:00 is the same list in the same
    // order at 09:05 whatever the planner does with the indexes.
    store.insert(job({ id: "job_2", name: "second" }));
    store.insert(job({ id: "job_3", name: "third" }));
    assert.deepEqual(
      store.all().map((row) => row.id),
      ["job_1", "job_2", "job_3"],
    );
  } finally {
    close();
  }
});

test("an update cannot rewrite the objective or the creator, even when a caller tries to hand it one", () => {
  const { db, close } = fileDb();
  try {
    const store = createSqliteJobStore(db);
    store.insert(job());
    // §4.5's "a material change crosses into re-approval" as a property of the schema rather than of a route: the `SET`
    // list has no column for either field, so the strongest thing a caller can do is ask, and the answer is that nothing
    // changed. The cast is the point of the test — the type refuses this patch, and a type is not a database.
    const smuggling = {
      name: "renamed",
      schedule: "0 8 * * *",
      objective: "delete everything under /data",
      createdBy: { clientId: "cli_2", name: "somebody else", interface: "web" },
      updatedAt: new Date(T0 + 1).toISOString(),
    } as unknown as JobPatch;
    const updated = store.update("job_1", smuggling);
    assert.equal(updated?.name, "renamed", "the two fields an edit may change did change");
    assert.equal(updated?.schedule, "0 8 * * *");
    assert.equal(
      updated?.objective,
      "summarise what needs an answer",
      "and what the user approved is still what the row says",
    );
    assert.deepEqual(
      updated?.createdBy,
      {
        clientId: "cli_1",
        name: "the owner",
        interface: "cli",
      },
      "as is who approved it — an audit record that could be reassigned is not an audit record",
    );

    // `nextRunAt: undefined` leaves the column alone, which is the difference between "no change" and "clear it".
    const before = updated?.nextRunAt;
    const untouched = store.update("job_1", { updatedAt: new Date(T0 + 2).toISOString() });
    assert.equal(untouched?.nextRunAt, before);
  } finally {
    close();
  }
});

test("a job survives the revocation of the identity that created it, and says who that was", () => {
  const { db, close } = fileDb();
  try {
    const { identity } = createIdentity(db, {
      name: "the owner",
      interface: "cli",
      capabilities: [],
    });
    const store = createSqliteJobStore(db);
    store.insert(
      job({ createdBy: { clientId: identity.id, name: identity.name, interface: "cli" } }),
    );
    // O-071: revoking deletes the row. `job.client_id` has no foreign key on purpose — a cascade here would silently
    // delete standing authority the user can no longer see, and a `SET NULL` would leave a job that runs as nobody. What
    // has to survive is the job, so the scheduler can refuse it, pause it and record the reason with a name in it.
    assert.equal(revoke(db, identity.id), true);
    const read = store.get("job_1");
    assert.ok(read !== undefined, "the job outlives its creator");
    assert.equal(
      read?.createdBy.name,
      "the owner",
      "and still names the person who authorised it (§4.5)",
    );
    assert.equal(read?.createdBy.clientId, identity.id);
  } finally {
    close();
  }
});

test("a run keeps its reason and its task when it is closed, and its history is ordered by the occurrence it was for", () => {
  const { db, close } = fileDb();
  try {
    const store = createSqliteJobStore(db);
    const task = createTask(db, { objective: "the run's task" });
    store.insert(job());
    store.insertRun(run({ taskId: task.id, reason: "asked for explicitly" }));
    store.insertRun(
      run({
        id: "run_2",
        dueAt: new Date(T0 + 120_000).toISOString(),
        outcome: "missed",
        occurrences: 4,
      }),
    );
    store.insertRun(
      run({
        id: "run_3",
        dueAt: new Date(T0 + 30_000).toISOString(),
        outcome: "skipped",
        trigger: "schedule",
      }),
    );

    // `COALESCE` on the three columns a reconciliation may have nothing to say about, so closing a run cannot erase the
    // reason it was opened with or the task it fired.
    const closed = store.updateRun("run_1", {
      outcome: "completed",
      settledAt: new Date(T0 + 90_000).toISOString(),
    });
    assert.equal(closed?.outcome, "completed");
    assert.equal(closed?.reason, "asked for explicitly");
    assert.equal(closed?.taskId, task.id);
    assert.equal(closed?.settledAt, new Date(T0 + 90_000).toISOString());

    assert.deepEqual(
      store.runsFor("job_1", 50).map((row) => row.id),
      ["run_2", "run_1", "run_3"],
      "newest occurrence first, so the history a client renders reads as a history",
    );
    assert.deepEqual(
      store.runsFor("job_1", 2).map((row) => row.id),
      ["run_2", "run_1"],
      "and the limit is applied by the database rather than by a client that fetched the whole thing",
    );
    assert.equal(
      store.lastRun("job_1")?.id,
      "run_3",
      "the last run is the last one written, not the newest occurrence",
    );

    // The vocabulary is the contract's, so "open" means the same thing to the store and to the scheduler: `completed`,
    // `missed` and `skipped` are all settled, and only `fired` and `waiting_on_approval` are still moving.
    assert.deepEqual(
      store.openRuns().map((row) => row.id),
      [],
      "nothing is open once the fired run is closed, even though two rows are unsettled in the ordinary sense",
    );
    store.updateRun("run_3", { outcome: "waiting_on_approval" });
    assert.deepEqual(
      store.openRuns().map((row) => row.id),
      ["run_3"],
      "and a run that stopped at an approval stays open, which is what keeps its job from firing beside a prompt",
    );

    // `task_id` is `ON DELETE SET NULL`: `docs/DATA_AND_MEMORY.md` §7 deletes a conversation's tasks, and a run row that
    // vanished with its task would take the outcome of work that already happened with it.
    db.prepare("DELETE FROM task WHERE id = ?").run(task.id);
    const orphan = store.runsFor("job_1", 50).find((row) => row.id === "run_1");
    assert.ok(orphan !== undefined, "the run survives its task");
    assert.equal(
      orphan?.taskId,
      undefined,
      "and loses the pointer, which is what makes it reconcilable as 'gone'",
    );
    assert.equal(orphan?.outcome, "completed", "while keeping the outcome it recorded");

    // `job_id` is `ON DELETE CASCADE`: a job's runs are its history and nothing else, so deleting the job deletes them.
    db.prepare("DELETE FROM job WHERE id = ?").run("job_1");
    assert.equal(store.runsFor("job_1", 50).length, 0);
    assert.equal(store.get("job_1"), undefined);
  } finally {
    close();
  }
});

test("the backlog answer is written onto the rows rather than replacing them (D-065)", () => {
  const { db, close } = fileDb();
  try {
    const store = createSqliteJobStore(db);
    store.insert(job());
    store.insertRun(run({ id: "run_1", outcome: "missed", occurrences: 4 }));
    store.insertRun(run({ id: "run_2", outcome: "missed", occurrences: 2 }));
    store.insertRun(run({ id: "run_3", outcome: "skipped" }));
    store.update("job_1", { missed: 6, updatedAt: new Date(T0 + 1).toISOString() });

    assert.deepEqual(
      store.unacknowledgedMissed("job_1").map((row) => row.id),
      ["run_1", "run_2"],
      "the rows C12-06 asks about, oldest first, and only the ones nobody has answered for",
    );
    const at = new Date(T0 + 5 * 60_000).toISOString();
    assert.equal(
      store.acknowledgeMissed("job_1", at),
      6,
      "the count is the occurrences, not the rows",
    );
    const rows = store.runsFor("job_1", 50);
    assert.equal(rows.length, 3, "no row was deleted");
    for (const id of ["run_1", "run_2"]) {
      const row = rows.find((entry) => entry.id === id);
      assert.equal(
        row?.outcome,
        "missed",
        "the outcome stays: the system does not quietly edit its own past",
      );
      assert.equal(row?.acknowledgedAt, at, "and gains the moment the user answered");
      assert.equal(row?.occurrences, id === "run_1" ? 4 : 2);
    }
    assert.equal(
      rows.find((entry) => entry.id === "run_3")?.acknowledgedAt,
      undefined,
      "a `skipped` row is not a backlog row and is not stamped by the answer",
    );
    assert.deepEqual(store.unacknowledgedMissed("job_1"), []);
    assert.equal(
      store.acknowledgeMissed("job_1", at),
      0,
      "a second answer covers nothing, and says so with a zero",
    );
  } finally {
    close();
  }
});

test("a stored value this build does not know is an error on read, not a string a client renders", () => {
  const { db, close } = fileDb();
  try {
    const store = createSqliteJobStore(db);
    store.insert(job());
    store.insertRun(run());
    // SQLite's `CHECK` refuses the write from this build, so the row has to be written behind its back to reach the state
    // a hand-edited file or an older build would leave: the constraint is dropped, the value inserted, the constraint
    // restored. What is being asserted is the *read*.
    db.exec("PRAGMA ignore_check_constraints = ON");
    db.prepare("UPDATE job SET state = 'running' WHERE id = 'job_1'").run();
    db.prepare(
      "UPDATE job_run SET outcome = 'exploded', triggered_by = 'telepathy' WHERE id = 'run_1'",
    ).run();
    db.exec("PRAGMA ignore_check_constraints = OFF");

    assert.throws(
      () => store.get("job_1"),
      /not one of active, paused/,
      "reading an unknown state as an arbitrary string would put a word in a client's hands that no scheduler produced",
    );
    assert.throws(() => store.runsFor("job_1", 10), /not one of/);
    assert.throws(() => store.lastRun("job_1"), /not one of/);
    // The CHECKs are still in force for a write this build makes.
    assert.throws(() =>
      db
        .prepare(
          "INSERT INTO job_run (id, job_id, due_at, recorded_at, outcome, triggered_by) VALUES ('r','job_1','x','y','exploded','schedule')",
        )
        .run(),
    );
  } finally {
    close();
  }
});

test("the SQL store and the memory store answer the same sequence identically", () => {
  const { db, close } = fileDb();
  try {
    const stores: [string, JobStore][] = [
      ["sqlite", createSqliteJobStore(db)],
      ["memory", createMemoryJobStore()],
    ];
    const answers: Record<string, unknown> = {};
    // One real task for both stores, because `job_run.task_id` is a foreign key — a dangling id would be refused by one
    // store and accepted by the other — and because the comparison is about the *answers*, so an id that differed between
    // the two runs would be a difference the fixture made rather than one the stores made.
    const task = createTask(db, { objective: "the run's task" });
    // A paused job with no next fire, built by removing the field rather than by setting it to `undefined`: an explicit
    // `undefined` is a key the SQL store cannot have, and the point of this block is that the two agree.
    const paused: JobRecord = job({ id: "job_2", name: "second", state: "paused" });
    delete (paused as { nextRunAt?: string }).nextRunAt;
    for (const [name, store] of stores) {
      store.insert(job());
      store.insert(paused);
      store.update("job_1", {
        name: "renamed",
        state: "paused",
        nextRunAt: null,
        missed: 3,
        updatedAt: new Date(T0 + 1).toISOString(),
      });
      store.insertRun(run({ taskId: task.id }));
      store.insertRun(run({ id: "run_2", outcome: "missed", occurrences: 3 }));
      store.updateRun("run_1", { outcome: "completed", settledAt: new Date(T0 + 2).toISOString() });
      answers[name] = {
        all: store.all(),
        get: store.get("job_1"),
        missing: store.get("job_nobody_made"),
        runs: store.runsFor("job_1", 50),
        limited: store.runsFor("job_1", 1),
        last: store.lastRun("job_1"),
        open: store.openRuns(),
        backlog: store.unacknowledgedMissed("job_1"),
        acknowledged: store.acknowledgeMissed("job_1", new Date(T0 + 3).toISOString()),
        after: store.unacknowledgedMissed("job_1"),
        updateMissing: store.update("job_nobody_made", { updatedAt: new Date(T0).toISOString() }),
        updateRunMissing: store.updateRun("run_nobody_made", { outcome: "failed" }),
      };
    }
    // The scheduler's unit tests run against the memory store, so a difference between the two is a rule that holds in a
    // test and not in a product — which is the whole reason this block exists rather than two separate suites.
    assert.deepEqual(answers.memory, answers.sqlite);
    const sqlite = answers.sqlite as { all: JobRecord[]; acknowledged: number; get: JobRecord };
    assert.equal(sqlite.all.length, 2);
    assert.equal(sqlite.get.name, "renamed");
    assert.equal(sqlite.get.nextRunAt, undefined);
    assert.equal(sqlite.get.missed, 3);
    assert.equal(sqlite.acknowledged, 3);
  } finally {
    close();
  }
});
