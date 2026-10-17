// The conversation repository, asserted as the sentences only a real database can answer: what schema version 6 created
// and what it backfilled, the order C11-01 sorts by, the token §2's concurrency row asks a mutation to carry, and the fact
// that a task moving in a conversation is activity rather than an edit.
//
// The backfill is the half a unit test cannot fake. Every install that ran before this migration holds `ses_…` ids on its
// task rows that nothing owned, and a migration that created an empty table would upgrade the schema and leave the user's
// forty conversations exactly as invisible as they were — which is the gap `docs/review/CLI.md` C11 exists to close.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, test } from "node:test";
import { newId, UNNAMED_TITLE } from "@crabby/api-contracts";
import { openDatabase, type SqliteDb } from "./db.ts";
import { appendMessage, coveredMessageIds, listMessages } from "./messages.ts";
import { MIGRATIONS, migrate, schemaVersion } from "./migrate.ts";
// The module's own export list, so the "nothing here deletes" assertion is about the file rather than about a copy of it.
import * as namespace from "./sessions.ts";
import {
  clipTitle,
  createSession,
  ensureSession,
  getSession,
  listSessions,
  patchSession,
  sessionRowOf,
  sessionRows,
  sessionTaskCount,
  sessionTaskFacts,
  sessionTasks,
  touchSession,
} from "./sessions.ts";
import { createTask, setState } from "./tasks.ts";

const T0 = new Date(2026, 9, 12, 12, 0).getTime();
const iso = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

function fileDb(): { db: SqliteDb; close(): void } {
  const dir = mkdtempSync(path.join(tmpdir(), "crabby-sessions-"));
  const handle = openDatabase(path.join(dir, "crabby.sqlite3"));
  migrate(handle.db);
  return { db: handle.db, close: () => handle.close() };
}

/** An install stopped at one version, for the tests that assert what a later migration does to rows an
 *  older one wrote. The ledger table is created by `migrate` rather than by a migration, so a hand-run
 *  migration has to create it first — the same sentence the backfill test carries. */
function migrateToVersion(db: SqliteDb, version: number): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migration (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
  );
  for (const migration of MIGRATIONS.filter((entry) => entry.version <= version)) {
    db.transaction(() => {
      migration.up(db);
      db.prepare("INSERT INTO schema_migration (version, name, applied_at) VALUES (?, ?, ?)").run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
    })();
  }
}

test("schema version 6 is the session table, and the index is the order the list is read in", () => {
  const { db, close } = fileDb();
  try {
    assert.equal(
      schemaVersion(db),
      16,
      "the file advances past 6 (the task pin, its switch, its origin, D-112's message table, D-116's coverage columns, M4's memory, M4's audit trail, the run history's release from its job, and M5's vault kind on the trail) but v6 is still sessions",
    );
    assert.equal(MIGRATIONS.find((entry) => entry.version === 6)?.name, "sessions");
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'session%'")
      .all() as { name: string }[];
    assert.deepEqual(
      indexes.map((row) => row.name),
      ["session_activity"],
      "C11-01 sorts by last activity, so the index is the list's order rather than an optimisation of it",
    );
    // The columns that carry the three decisions D-104 records: a nullable title, a nullable origin and a revision.
    const columns = db.prepare("PRAGMA table_info(session)").all() as {
      name: string;
      notnull: number;
    }[];
    const byName = new Map(columns.map((column) => [column.name, column]));
    assert.equal(
      byName.get("title")?.notnull,
      0,
      "W15-03's un-named session is an absence, not a blank string",
    );
    assert.equal(
      byName.get("origin_interface")?.notnull,
      0,
      "W15-11's attribution is unknown for a conversation that predates the record, and a guess would read as an attribution",
    );
    assert.equal(
      byName.get("revision")?.notnull,
      1,
      "the token §2's concurrency row asks for is never absent",
    );
    assert.equal(byName.get("last_activity_at")?.notnull, 1);
  } finally {
    close();
  }
});

test("the backfill gives every conversation a task already referenced, named from its first question", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "crabby-sessions-backfill-"));
  const handle = openDatabase(path.join(dir, "crabby.sqlite3"));
  // Migrate to 5 only, write tasks the way an install before this slice did, then let version 6 catch up. The ledger
  // table is created by `migrate` rather than by a migration — a migration that created the table recording itself could
  // not fail halfway consistently — so a hand-run migration has to create it first.
  handle.db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migration (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
  );
  for (const migration of MIGRATIONS.filter((entry) => entry.version <= 5))
    handle.db.transaction(() => {
      migration.up(handle.db);
      handle.db
        .prepare("INSERT INTO schema_migration (version, name, applied_at) VALUES (?, ?, ?)")
        .run(migration.version, migration.name, new Date().toISOString());
    })();
  // A task written the way a pre-v7 install's `createTask` wrote one: the `model` column does not exist at version 5, so
  // the current `createTask` (which names it) cannot be the writer here. The backfill only reads objective, session_id
  // and the timestamps, which these carry.
  const writeTask = (id: string, sessionId: string, objective: string, at: string): void => {
    handle.db
      .prepare(
        `INSERT INTO task (id, session_id, state, objective, created_at, updated_at, last_seq)
         VALUES (?, ?, 'queued', ?, ?, ?, 0)`,
      )
      .run(id, sessionId, objective, at, at);
  };
  writeTask("tsk_a", "ses_before1", "the first question anybody asked", iso(0));
  writeTask("tsk_b", "ses_before1", "a later question in the same conversation", iso(60_000));
  writeTask("tsk_c", "ses_before2", "a conversation of its own", iso(30_000));
  assert.equal(
    (
      handle.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'session'").get() as {
        n: number;
      }
    ).n,
    0,
    "the fixture really is an install from before the record existed",
  );

  const applied = migrate(handle.db);
  try {
    assert.deepEqual(applied.applied, [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const rows = listSessions(handle.db);
    assert.deepEqual(
      rows.map((row) => row.id).sort(),
      ["ses_before1", "ses_before2"],
      "one row per distinct session id a task carried, and no more",
    );
    const first = getSession(handle.db, "ses_before1");
    assert.equal(
      first?.title,
      "the first question anybody asked",
      "W15-03's rule applied to a conversation that already had its first question: the title is the earliest task's " +
        "objective, not the newest and not a placeholder",
    );
    assert.equal(
      first?.createdAt,
      iso(0),
      "the conversation's own history, not the moment the schema caught up with it",
    );
    assert.equal(first?.lastActivityAt, iso(60_000));
    assert.equal(first?.origin, undefined);
    assert.equal(first?.revision, 1);
    assert.equal(
      (
        handle.db.prepare("SELECT session_id FROM task WHERE id = 'tsk_c'").get() as {
          session_id: string;
        }
      ).session_id,
      "ses_before2",
      "the fixture's third task is the second conversation",
    );
    const secondRow = getSession(handle.db, "ses_before2");
    assert.ok(secondRow !== undefined);
    assert.equal(sessionRowOf(handle.db, secondRow).titleShown, "a conversation of its own");
    // The tasks are untouched: a backfill that rewrote them would be editing records to match a table.
    assert.equal(
      (
        handle.db
          .prepare("SELECT COUNT(*) AS n FROM task WHERE session_id = 'ses_before1'")
          .get() as {
          n: number;
        }
      ).n,
      2,
    );
  } finally {
    handle.close();
  }
});

test("a session written is the session read back, and the list is in last-activity order", () => {
  const { db, close } = fileDb();
  try {
    const quiet = createSession(db, { id: "ses_quiet", now: iso(0) });
    assert.equal(quiet.title, undefined);
    assert.equal(quiet.model, undefined);
    assert.equal(quiet.origin, undefined);
    assert.equal(quiet.revision, 1);
    assert.deepEqual(getSession(db, "ses_quiet"), quiet, "every field survives the round trip");
    assert.equal(getSession(db, "ses_nobody_made"), undefined);

    createSession(db, {
      id: "ses_named",
      title: "the inbox project",
      model: "local/qwen2.5:3b",
      origin: "web",
      now: iso(1_000),
    });
    createSession(db, { id: "ses_newest", origin: "telegram", now: iso(2_000) });
    assert.deepEqual(
      listSessions(db).map((row) => row.id),
      ["ses_newest", "ses_named", "ses_quiet"],
      "newest activity first, which is the order C11-01 says a person remembers in",
    );
    touchSession(db, "ses_quiet", iso(3_000));
    assert.deepEqual(
      listSessions(db).map((row) => row.id),
      ["ses_quiet", "ses_newest", "ses_named"],
      "and activity moves a conversation to the top, which is the whole reason the column is not `created_at`",
    );
    assert.deepEqual(
      listSessions(db, { origin: "web" }).map((row) => row.id),
      ["ses_named"],
      "W15-11's attribution is a filter as well as a column",
    );
    assert.equal(listSessions(db, { limit: 2 }).length, 2, "and a page is a page");

    // A touch is not an edit: the token a phone holds survives it, so an inline rename does not fail because the agent
    // answered a question while the user was typing.
    const before = getSession(db, "ses_named")?.revision;
    touchSession(db, "ses_named", iso(4_000));
    assert.equal(getSession(db, "ses_named")?.revision, before);
    // And it never moves a conversation backwards in time.
    touchSession(db, "ses_named", iso(0));
    assert.equal(getSession(db, "ses_named")?.lastActivityAt, iso(4_000));
  } finally {
    close();
  }
});

test("a patch compares the revision it was given, and refuses rather than overwriting", () => {
  const { db, close } = fileDb();
  try {
    createSession(db, { id: "ses_one", title: "before", now: iso(0) });
    const missing = patchSession(db, "ses_nobody_made", { title: "x", expectedRevision: 1 });
    assert.equal(missing.ok, false);
    if (!missing.ok) {
      assert.equal(missing.code, "not-found");
      assert.match(
        missing.reason,
        /crabby session ls/,
        "a refusal names the verb that would have found the id",
      );
    }
    const nothing = patchSession(db, "ses_one", { expectedRevision: 1 });
    assert.equal(nothing.ok, false);
    if (!nothing.ok) {
      assert.equal(nothing.code, "no-change", "a patch with neither field is not an edit");
      assert.match(
        nothing.reason,
        /history\.deleteConversation/,
        "and the refusal says what this route will never do",
      );
    }

    const stale = patchSession(db, "ses_one", { title: "a late write", expectedRevision: 99 });
    assert.equal(stale.ok, false);
    if (!stale.ok) {
      assert.equal(stale.code, "stale");
      assert.match(
        stale.reason,
        /revision 1 and this write carries 99/,
        "both numbers, because 'somebody edited it' without them is not actionable",
      );
    }
    assert.equal(getSession(db, "ses_one")?.title, "before", "the loser of the race wrote nothing");

    const renamed = patchSession(db, "ses_one", {
      title: "after",
      expectedRevision: 1,
      now: iso(5_000),
    });
    assert.ok(renamed.ok);
    if (!renamed.ok) return;
    assert.equal(renamed.session.title, "after");
    assert.equal(renamed.session.revision, 2);
    assert.equal(renamed.session.updatedAt, iso(5_000));
    assert.equal(
      renamed.session.lastActivityAt,
      iso(0),
      "a rename is an edit to the label, not something that happened *in* the conversation, so it does not move the list",
    );

    // `model: null` clears the override; `undefined` leaves it alone. The distinction is the difference between "use the
    // install's default again" and "keep whatever this session pinned".
    const pinned = patchSession(db, "ses_one", { model: "local/qwen2.5:3b", expectedRevision: 2 });
    assert.ok(pinned.ok);
    if (!pinned.ok) return;
    assert.equal(pinned.session.model, "local/qwen2.5:3b");
    const untouched = patchSession(db, "ses_one", { title: "still after", expectedRevision: 3 });
    assert.ok(untouched.ok);
    if (!untouched.ok) return;
    assert.equal(
      untouched.session.model,
      "local/qwen2.5:3b",
      "`undefined` left the override alone",
    );
    const cleared = patchSession(db, "ses_one", { model: null, expectedRevision: 4 });
    assert.ok(cleared.ok);
    if (!cleared.ok) return;
    assert.equal(cleared.session.model, undefined, "and `null` cleared it");
  } finally {
    close();
  }
});

test("a task's session is created if nothing owns it, named once, and never renamed by a later task", () => {
  const { db, close } = fileDb();
  try {
    const id = "ses_minted";
    const first = ensureSession(db, {
      id,
      titleFrom: "  the   first question  ",
      origin: "cli",
      now: iso(0),
    });
    assert.equal(
      first.title,
      "the first question",
      "trimmed and with its runs of whitespace collapsed",
    );
    assert.equal(first.origin, "cli");
    assert.equal(first.revision, 1);

    const second = ensureSession(db, {
      id,
      titleFrom: "a later question",
      origin: "web",
      now: iso(60_000),
    });
    assert.equal(
      second.title,
      "the first question",
      "W15-03 names a conversation once: the first question is the title and the ones after it are not edits to it",
    );
    assert.equal(
      second.origin,
      "cli",
      "and the attribution is whoever created it, not whoever used it last",
    );
    assert.equal(
      second.lastActivityAt,
      iso(60_000),
      "while the activity is the latest thing that happened",
    );
    assert.equal(second.revision, 1, "activity is not an edit, so the token survives it");

    // A title the user chose is not a placeholder either, and an un-named session takes one from the first task.
    const bare = createSession(db, { id: "ses_bare", now: iso(0) });
    assert.equal(bare.title, undefined);
    assert.equal(
      ensureSession(db, {
        id: "ses_bare",
        titleFrom: "the question that named it",
        now: iso(1_000),
      }).title,
      "the question that named it",
    );
    // With nothing to name it from, it stays un-named rather than acquiring a guess.
    const anonymous = ensureSession(db, { id: "ses_anonymous", now: iso(0) });
    assert.equal(anonymous.title, undefined);
    assert.equal(sessionRowOf(db, anonymous).titleShown, UNNAMED_TITLE);
  } finally {
    close();
  }
});

test("a task changing state is activity in its conversation, written by the same call that moved it", () => {
  const { db, close } = fileDb();
  try {
    const task = createTask(db, { objective: "a question", sessionId: "ses_active", now: iso(0) });
    ensureSession(db, { id: "ses_active", titleFrom: task.objective, origin: "cli", now: iso(0) });
    assert.equal(getSession(db, "ses_active")?.lastActivityAt, iso(0));

    assert.equal(setState(db, task.id, "running", { now: iso(30_000) }), true);
    assert.equal(
      getSession(db, "ses_active")?.lastActivityAt,
      iso(30_000),
      "a task moving is something happening in a conversation, and C11-01 sorts by exactly that",
    );
    assert.equal(getSession(db, "ses_active")?.revision, 1, "and it spends no token");

    // A state move that changes nothing touches nothing.
    assert.equal(setState(db, task.id, "running", { now: iso(40_000) }), false);
    assert.equal(getSession(db, "ses_active")?.lastActivityAt, iso(30_000));

    const facts = sessionTaskFacts(db);
    assert.deepEqual(facts.get("ses_active"), { tasks: 1, waitingApproval: 0, running: 1 });
    assert.equal(sessionTaskCount(db, "ses_active"), 1);
    assert.deepEqual(
      sessionTasks(db, "ses_active", 10).map((row) => row.id),
      [task.id],
    );

    // The state word's three cases, from the counts rather than from a fixture's opinion: a parked task outranks a moving
    // one because W16-02's rule is that work stalled on a human is the state that must never be hidden.
    setState(db, task.id, "awaiting_approval", { now: iso(50_000) });
    const word = (): string => {
      const record = getSession(db, "ses_active");
      assert.ok(record !== undefined, "the fixture's conversation exists for the whole test");
      return sessionRowOf(db, record).stateWord;
    };
    assert.equal(word(), "waiting-approval");
    const second = createTask(db, {
      objective: "another",
      sessionId: "ses_active",
      now: iso(60_000),
    });
    setState(db, second.id, "completed", { now: iso(70_000) });
    assert.equal(
      word(),
      "waiting-approval",
      "one parked task in a conversation with a finished one is still a conversation waiting on a human",
    );
    setState(db, task.id, "completed", { now: iso(80_000) });
    assert.equal(word(), "idle");
    assert.deepEqual(
      sessionRows(db, listSessions(db)).map((row) => row.tasks),
      [2],
      "and a page of rows costs one aggregate query rather than one per line",
    );
  } finally {
    close();
  }
});

test("a stored origin this build does not know is an error on read, not an attribution a client renders", () => {
  const { db, close } = fileDb();
  try {
    createSession(db, { id: "ses_odd", now: iso(0) });
    // The `CHECK` refuses this from the build, so the row has to be written behind its back to reach the state a
    // hand-edited file or another build would leave. What is asserted is the read.
    db.exec("PRAGMA ignore_check_constraints = ON");
    db.prepare("UPDATE session SET origin_interface = 'fax' WHERE id = 'ses_odd'").run();
    db.exec("PRAGMA ignore_check_constraints = OFF");
    assert.throws(
      () => getSession(db, "ses_odd"),
      /not one of cli, tui, web, telegram/,
      "an unknown origin read back as a string would put an attribution in a client's hands that no interface produced",
    );
    assert.throws(() => listSessions(db), /not one of/);
  } finally {
    close();
  }
});

test("a derived title is clipped on a code-point boundary, and the clip says it happened", () => {
  assert.equal(clipTitle("  a   short  title  "), "a short title", "trimmed and collapsed");
  assert.equal(clipTitle("x".repeat(80)).length, 80, "exactly at the limit is not clipped");
  const long = clipTitle("y".repeat(120));
  assert.equal(long.length, 80, "and past it the title is the limit, ellipsis included");
  assert.equal(long.endsWith("…"), true);
  // A Bengali objective's fortieth character is not at byte forty, and half a grapheme is not a title. The count is of code
  // points, so the clip lands between two of them rather than inside one.
  const bengali = clipTitle("অ".repeat(120));
  assert.equal([...bengali].length, 80);
  assert.equal(bengali.endsWith("…"), true);
  assert.ok(
    !bengali.includes("\uFFFD"),
    "no replacement character, which is what a byte-boundary clip would have produced",
  );
});

test("nothing in this repository deletes, because destroying a conversation is T3 and belongs to one command", () => {
  const { db, close } = fileDb();
  try {
    createSession(db, { id: "ses_kept", now: iso(0) });
    // The statement a `session delete` would need is not one this module prepares, and the assertion is about the module's
    // exports rather than about the database: C11-05's "exactly one command that destroys history" is kept by an absence
    // in the code, so the absence is what has to be checked.
    const exported = Object.keys(namespace);
    assert.ok(
      !exported.some((name) => /delete|remove|destroy|forget/i.test(name)),
      `no deletion is exported from the conversation repository; the exports are ${exported.join(", ")}`,
    );
    assert.equal(getSession(db, "ses_kept")?.id, "ses_kept");
  } finally {
    close();
  }
});

/** The prefix a session id carries, asserted here because a test that mints one has to mint a valid one: `ids.ts`
 *  documents five prefixes and `ses_` is the one §5.2 and §6 use for conversations. */
test("a session id is the documented prefix and nothing invented", () => {
  const id = newId("ses");
  assert.match(id, /^ses_[0-9a-hj-km-np-z]{26}$/);
  const { db, close } = fileDb();
  try {
    const created = createSession(db);
    assert.match(created.id, /^ses_/);
    assert.equal(getSession(db, created.id)?.id, created.id);
  } finally {
    close();
  }
});

// D-112's message half, on the table §2.5 asks for. The four bullets that bullet names — role, ordering, timestamps,
// association with the right conversation — are four separate assertions here rather than one "it stores messages",
// because the first version of this file would have passed a test that checked none of them.
/** D-111's origin triple: the tests here care about turns, so the identity is a constant rather than a second thing each
 *  test builds. */
const ORIGIN = { clientId: "cli_phone", clientName: "the phone", interface: "cli" as const };

describe("a conversation's turns", () => {
  function conversation(): { db: SqliteDb; close(): void; sessionId: string; taskId: string } {
    const { db, close } = fileDb();
    const session = ensureSession(db, { id: newId("ses"), titleFrom: "tidy the notes" });
    const task = createTask(db, {
      objective: "tidy the notes",
      sessionId: session.id,
      origin: ORIGIN,
    });
    return { db, close, sessionId: session.id, taskId: task.id };
  }

  it("keeps role, place, time and association for every turn", () => {
    const { db, close, sessionId, taskId } = conversation();
    try {
      const first = appendMessage(db, {
        sessionId,
        taskId,
        role: "user",
        content: "summarise notes.md",
        now: "2026-03-04T10:00:00.000Z",
      });
      const second = appendMessage(db, {
        sessionId,
        taskId,
        role: "assistant",
        content: "one heading, nothing else",
        now: "2026-03-04T10:00:01.000Z",
      });
      const chat = appendMessage(db, {
        sessionId,
        role: "user",
        content: "and what about build/?",
        now: "2026-03-04T10:00:02.000Z",
      });

      assert.deepEqual(
        [first, second, chat].map((message) => [message.role, message.ordinal, message.taskId]),
        [
          ["user", 1, taskId],
          ["assistant", 2, taskId],
          // A `/ask` turn (C4-02) has no task, and the row says so rather than inventing one.
          ["user", 3, undefined],
        ],
        "§2.5's role, ordering and association, in one read — and the place is the conversation's own counter, not the id",
      );
      assert.equal(second.createdAt, "2026-03-04T10:00:01.000Z", "timestamps are kept as written");
      assert.ok(
        (first.id.startsWith("msg_") && first.id > second.id) || first.id !== second.id,
        "the sixth prefix exists and two turns in one conversation never share an id",
      );

      const page = listMessages(db, sessionId);
      assert.deepEqual(
        page.items.map((message) => message.content),
        ["summarise notes.md", "one heading, nothing else", "and what about build/?"],
        "a page reads in the order the turns happened",
      );
      assert.equal(
        page.count,
        3,
        "the true total sits beside the page, as it does for a session's tasks",
      );
      assert.deepEqual(
        listMessages(db, sessionId, { after: 1 }).items.map((message) => message.ordinal),
        [2, 3],
        "§2's cursor resumes after an ordinal, so appending a turn cannot shift a page a reader is holding",
      );
      assert.deepEqual(
        listMessages(db, sessionId, { limit: 2 }).items.map((message) => message.ordinal),
        [1, 2],
      );
    } finally {
      close();
    }
  });

  it("writes a summary's coverage beside it and never over the turns it covers (D-116)", () => {
    // §2.5's "generated summaries must not silently replace or destroy original conversation records" as
    // a table: the covered rows stay, the summary points at them, and both are readable afterwards.
    const { db, close, sessionId, taskId } = conversation();
    try {
      for (const content of ["first", "second", "third"]) {
        appendMessage(db, {
          sessionId,
          taskId,
          role: "user",
          content,
          now: "2026-03-04T10:00:00.000Z",
        });
      }
      const summary = appendMessage(db, {
        sessionId,
        taskId,
        role: "system",
        content: "notes on turns 1-2",
        covers: { from: 1, through: 2 },
        now: "2026-03-04T10:00:01.000Z",
      });
      assert.deepEqual(summary.covers, { from: 1, through: 2 });
      assert.equal(
        summary.ordinal,
        4,
        "a summary is a row in the conversation, with its own place",
      );
      const page = listMessages(db, sessionId).items;
      assert.deepEqual(
        page.map((message) => [
          message.ordinal,
          message.covers?.from ?? null,
          message.covers?.through ?? null,
        ]),
        [
          [1, null, null],
          [2, null, null],
          [3, null, null],
          [4, 1, 2],
        ],
        "the three turns are still rows; the fourth names them",
      );
      assert.deepEqual(
        coveredMessageIds(db, summary.id),
        page.slice(0, 2).map((message) => message.id),
        "the range is the one the summary named, not everything older than the summary itself",
      );
      assert.deepEqual(
        coveredMessageIds(db, page[2]?.id ?? ""),
        [],
        "an ordinary turn stands in for nothing, and says so by covering nothing",
      );
    } finally {
      close();
    }
  });

  it("refuses a coverage range the schema cannot mean (D-116)", () => {
    const { db, close, sessionId, taskId } = conversation();
    try {
      appendMessage(db, {
        sessionId,
        taskId,
        role: "user",
        content: "one",
        now: "2026-03-04T10:00:00.000Z",
      });
      // A user turn cannot stand in for other turns, and a range that ends before it starts skips the
      // turns in between. Both are refused by the CHECK rather than stored and discovered later.
      assert.throws(() =>
        db
          .prepare(
            "INSERT INTO message (id, session_id, task_id, role, content, ordinal, covers_from, covers_through, created_at) VALUES ('msg_x', ?, ?, 'user', 'x', 2, 1, 2, '2026-03-04T10:00:00.000Z')",
          )
          .run(sessionId, taskId),
      );
      assert.throws(() =>
        db
          .prepare(
            "INSERT INTO message (id, session_id, task_id, role, content, ordinal, covers_from, covers_through, created_at) VALUES ('msg_y', ?, ?, 'system', 'x', 2, 5, 2, '2026-03-04T10:00:00.000Z')",
          )
          .run(sessionId, taskId),
      );
      assert.throws(() =>
        db
          .prepare(
            "INSERT INTO message (id, session_id, task_id, role, content, ordinal, covers_from, covers_through, created_at) VALUES ('msg_z', ?, ?, 'system', 'x', 2, 1, NULL, '2026-03-04T10:00:00.000Z')",
          )
          .run(sessionId, taskId),
      );
    } finally {
      close();
    }
  });

  it("keeps every turn across the version-12 rebuilds, because a migration copies rather than recreates", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "crabby-sessions-v11-"));
    const handle = openDatabase(path.join(dir, "crabby.sqlite3"));
    try {
      migrateToVersion(handle.db, 10);
      const sessionId = ensureSession(handle.db, { id: newId("ses"), titleFrom: "first question" });
      // Written by the version-10 build's own statement, which is what an install that has not upgraded
      // yet would run — the current writer names the version-11 columns and cannot be the one that fills
      // a version-10 table, which is itself part of what the rebuild is for.
      for (const [index, content] of ["one", "two"].entries()) {
        handle.db
          .prepare(
            `INSERT INTO message (id, session_id, task_id, role, content, ordinal, created_at)
             VALUES (?, ?, NULL, 'user', ?, ?, '2026-03-04T10:00:00.000Z')`,
          )
          .run(newId("msg"), sessionId.id, content, index + 1);
      }
      assert.equal(schemaVersion(handle.db), 10);
      migrate(handle.db);
      assert.equal(
        schemaVersion(handle.db),
        16,
        "six migrations run at once: coverage (11), pins (12), memory (13), the audit trail (14), the run history (15) and M5's vault kind (16)",
      );
      assert.deepEqual(
        listMessages(handle.db, sessionId.id).items.map((message) => message.content),
        ["one", "two"],
        "a table rebuild that dropped the rows would have deleted a conversation's history on upgrade",
      );
    } finally {
      handle.close();
    }
  });

  it("redacts on write, because §8.2 counts conversation records as a category of their own", () => {
    const { db, close, sessionId, taskId } = conversation();
    try {
      const stored = appendMessage(db, {
        sessionId,
        taskId,
        role: "user",
        content: "my key is sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        now: "2026-03-04T10:00:00.000Z",
      });
      assert.doesNotMatch(
        stored.content,
        /sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAA/,
        "the credential is masked on the way in, exactly as an event payload's is — the category differs, the rule does not",
      );
      const raw = (
        db.prepare("SELECT content FROM message WHERE id = ?").get(stored.id) as { content: string }
      ).content;
      assert.equal(
        raw,
        stored.content,
        "and the column holds what the caller was told, so the redacted text is one fact rather than two spellings",
      );
    } finally {
      close();
    }
  });

  it("goes when its conversation does, and goes alone when one task of many is deleted", () => {
    const { db, close, sessionId, taskId } = conversation();
    try {
      const other = createTask(db, {
        objective: "summarise the roadmap",
        sessionId,
        origin: ORIGIN,
      });
      appendMessage(db, {
        sessionId,
        taskId,
        role: "user",
        content: "notes",
        now: "2026-03-04T10:00:00.000Z",
      });
      appendMessage(db, {
        sessionId,
        taskId: other.id,
        role: "user",
        content: "roadmap",
        now: "2026-03-04T10:00:01.000Z",
      });

      db.prepare("DELETE FROM task WHERE id = ?").run(taskId);
      assert.deepEqual(
        listMessages(db, sessionId).items.map((message) => message.content),
        ["roadmap"],
        "a turn whose task no longer exists would be a claim about work nobody can see, so it goes with the task",
      );

      db.prepare("DELETE FROM session WHERE id = ?").run(sessionId);
      assert.equal(
        listMessages(db, sessionId).count,
        0,
        "§2.5's deletion bullet: deleting a conversation deletes its history, which is what C11-05's one T3 command is for",
      );
    } finally {
      close();
    }
  });
});
