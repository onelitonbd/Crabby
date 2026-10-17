// Migrations, because `docs/DATA_AND_MEMORY.md` §2.6 says "configuration migrations must be considered when
// upgrading Crabby" and a database that cannot say which version it is on turns an upgrade into a re-install. The
// table is append-only and every entry is one `up()` — no down path in v1: a phone that failed halfway needs a
// restore from backup (§8), not a reverse migration nobody has tested.
import type { SqliteDb } from "./db.ts";

export interface Migration {
  readonly version: number;
  readonly name: string;
  up(db: SqliteDb): void;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "tasks-events-clients-idempotency",
    up(db) {
      db.exec(`
        CREATE TABLE task (
          id            TEXT PRIMARY KEY,
          session_id    TEXT NOT NULL,
          state         TEXT NOT NULL,
          objective     TEXT NOT NULL,
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL,
          last_seq      INTEGER NOT NULL DEFAULT 0,
          error_code    TEXT,
          error_message TEXT
        );
        CREATE INDEX task_state  ON task (state, id);
        CREATE INDEX task_session ON task (session_id, id);

        CREATE TABLE task_event (
          id              TEXT PRIMARY KEY,
          task_id         TEXT NOT NULL REFERENCES task (id) ON DELETE CASCADE,
          session_id      TEXT NOT NULL,
          seq             INTEGER NOT NULL,
          type            TEXT NOT NULL,
          ts              TEXT NOT NULL,
          schema_version  INTEGER NOT NULL,
          correlation_id  TEXT,
          payload_json    TEXT NOT NULL,
          truncated       INTEGER NOT NULL DEFAULT 0,
          overflow_path   TEXT,
          UNIQUE (task_id, seq)
        );
        CREATE INDEX event_task_seq_desc ON task_event (task_id, seq DESC);
        CREATE INDEX event_ts ON task_event (ts);

        CREATE TABLE client_identity (
          id              TEXT PRIMARY KEY,
          name            TEXT NOT NULL,
          interface       TEXT NOT NULL,
          capability_json TEXT NOT NULL,
          token_hash      TEXT NOT NULL UNIQUE,
          created_at      TEXT NOT NULL,
          last_used_at    TEXT
        );

        CREATE TABLE pairing_code (
          code_hash  TEXT PRIMARY KEY,
          client_id  TEXT NOT NULL REFERENCES client_identity (id) ON DELETE CASCADE,
          expires_at TEXT NOT NULL,
          used_at    TEXT
        );

        CREATE TABLE idempotency (
          key           TEXT NOT NULL,
          route         TEXT NOT NULL,
          request_hash  TEXT NOT NULL,
          response_json TEXT NOT NULL,
          created_at    TEXT NOT NULL,
          PRIMARY KEY (key, route)
        );
      `);
    },
  },
  {
    // D-084's queue, and the reason `ApprovalStore` was made a seam instead of a query API: this table is the only
    // place an approval exists, so "answer from anywhere" (SECURITY.md §6.3) is a property of the row rather than of
    // whichever surface wrote it.
    version: 2,
    name: "approvals",
    up(db) {
      db.exec(`
        CREATE TABLE approval (
          id           TEXT PRIMARY KEY,
          task_id      TEXT NOT NULL REFERENCES task (id) ON DELETE CASCADE,
          tool         TEXT NOT NULL,
          tier         TEXT NOT NULL,
          binding      TEXT NOT NULL,
          state        TEXT NOT NULL CHECK (state IN ('pending','approved','denied','expired','consumed')),
          requested_at INTEGER NOT NULL,
          expires_at   INTEGER NOT NULL,
          answered_at  INTEGER,
          answered_by  TEXT,
          consumed_at  INTEGER,
          supersedes   TEXT REFERENCES approval (id) ON DELETE SET NULL,
          request_json TEXT NOT NULL
        );
        -- The queue read (?state=) and the expiry sweep are the only two queries M2 needs. The order a client sees is
        -- the rowid order ApprovalStore.all() asks for, and it is deliberately NOT indexed: rowid is not even a
        -- nameable index column in SQLite (underscore-rowid is), which the first run of this migration reported, and leaving
        -- it that way is the decision rather than the error -- a covering index that happens to return rows in
        -- insertion order is a temptation to make an ordering a contract on a table that holds a phone's handful of
        -- pending prompts. Backticks are absent from this block on purpose: a template literal ends at the first one.
        CREATE INDEX approval_state   ON approval (state);
        CREATE INDEX approval_expiry  ON approval (state, expires_at);
        CREATE INDEX approval_task    ON approval (task_id);
      `);
    },
  },
  {
    // F-46's fix: §6.2 requires the cancellation uncertainty to be recorded *on the task*, and until this migration the
    // only place it lived was the `task.cancelled` event — durable, per-task and retrievable, but not on the record a
    // client reads when it polls `GET /tasks/{id}`. One JSON column rather than five, for the reason `approval`'s
    // `request_json` has: no query needs these fields apart, and a column nobody filters on is cheap to move later.
    version: 3,
    name: "task-cancellation",
    up(db) {
      db.exec(`
        ALTER TABLE task ADD COLUMN cancellation_json TEXT;
      `);
    },
  },
  {
    // D-065's checkpoint, and D-095's first rule: **one row per task, replaced at each committed step boundary**. §7.1
    // restores "the latest valid task state", and a history of boundaries would be a second event log with a retention
    // rule nobody priced — the boundary before the latest one is only useful to a resume that intends to repeat work,
    // which §7.3 forbids. `record_json` holds the whole record (the run's working context included), redacted on the way
    // in like every other payload that reaches this file, and the columns beside it are the ones a reader or a verdict
    // needs without parsing it. `ON DELETE CASCADE` because a checkpoint is saved state *for* a task and not a record
    // *about* one: deleting the task deletes the transcript that only existed to resume it.
    version: 4,
    name: "checkpoints",
    up(db) {
      db.exec(`
        CREATE TABLE checkpoint (
          task_id     TEXT PRIMARY KEY REFERENCES task (id) ON DELETE CASCADE,
          boundary    TEXT NOT NULL CHECK (boundary IN ('step','prompt')),
          state       TEXT NOT NULL,
          step        INTEGER NOT NULL,
          last_seq    INTEGER NOT NULL,
          model_id    TEXT NOT NULL,
          written_at  TEXT NOT NULL,
          bytes       INTEGER NOT NULL,
          record_json TEXT NOT NULL
        );
        -- No index beyond the primary key: every read this table has is by task, and that is the key.
      `);
    },
  },
  {
    // The scheduler's two tables (D-046, D-057, and F-57's third field: `schedule` is the scheduler's, and this is the
    // schema version 5 that finding said a schedule would need). Two tables rather than one because §4.5 makes the *runs*
    // the auditable half — "every execution of a scheduled job is a fresh policy evaluation", and a run that could not get
    // approval "stops and records" why — and a job row that carried only its last outcome would be a standing authority
    // whose history nobody could review a month later (W16-09's "approval trail per run").
    //
    // `client_id` deliberately has no `REFERENCES client_identity`: a revocation deletes the identity row (O-071), and a
    // cascade would erase the record of who authorised a timer that may already have run work. §4.5's sentence is that a
    // job "runs under the identity that created it, so audit records name a person rather than 'cron'", and a person's
    // name has to outlive their credential. The scheduler refuses to *fire* a job whose identity is gone, which is the
    // enforcement; this table keeps the attribution.
    //
    // `task_id` does cascade — as a `SET NULL`, not a delete: `docs/DATA_AND_MEMORY.md` §7 removes a conversation's tasks,
    // and a run row that vanished with its task would take the outcome of work that already happened with it.
    //
    // The column is triggered_by and not trigger, because TRIGGER is a SQLite keyword and a column that needs quoting in
    // every statement is a column somebody will eventually write without them.
    version: 5,
    name: "jobs",
    up(db) {
      db.exec(`
        CREATE TABLE job (
          id                 TEXT PRIMARY KEY,
          name               TEXT NOT NULL,
          schedule           TEXT NOT NULL,
          objective          TEXT NOT NULL,
          state              TEXT NOT NULL CHECK (state IN ('active','paused')),
          session_id         TEXT NOT NULL,
          client_id          TEXT NOT NULL,
          client_name        TEXT NOT NULL,
          client_interface   TEXT NOT NULL CHECK (client_interface IN ('cli','tui','web','telegram')),
          capability_json    TEXT NOT NULL,
          utc_offset_minutes INTEGER NOT NULL,
          created_at         TEXT NOT NULL,
          updated_at         TEXT NOT NULL,
          next_run_at        TEXT,
          last_run_at        TEXT,
          missed             INTEGER NOT NULL DEFAULT 0
        );
        -- The tick's one question is "what is active and due", so that is the index. A phone holds a handful of timers
        -- and the scan would be cheap anyway; the index exists so the query the scheduler runs every thirty seconds is
        -- the query the file is organised around.
        CREATE INDEX job_state_next ON job (state, next_run_at);

        CREATE TABLE job_run (
          id              TEXT PRIMARY KEY,
          job_id          TEXT NOT NULL REFERENCES job (id) ON DELETE CASCADE,
          due_at          TEXT NOT NULL,
          recorded_at     TEXT NOT NULL,
          settled_at      TEXT,
          outcome         TEXT NOT NULL CHECK (outcome IN
                            ('fired','waiting_on_approval','skipped','missed','refused',
                             'completed','failed','cancelled','interrupted')),
          triggered_by    TEXT NOT NULL CHECK (triggered_by IN ('schedule','run-now','backlog')),
          task_id         TEXT REFERENCES task (id) ON DELETE SET NULL,
          reason          TEXT,
          occurrences     INTEGER NOT NULL DEFAULT 1,
          acknowledged_at TEXT
        );
        -- One missed row stands for many occurrences, and the occurrences column says how many: §4.5's rule against a
        -- burst needs the count, and a phone does not need ten thousand rows to carry it.
        CREATE INDEX job_run_job     ON job_run (job_id, due_at);
        CREATE INDEX job_run_open    ON job_run (outcome);
        CREATE INDEX job_run_backlog ON job_run (job_id, outcome, acknowledged_at);
      `);
    },
  },
  {
    // Conversations become records. Until this migration a session existed only as an id on a task: `createTask` mints
    // `newId("ses")` when a caller names none and `task.session_id` is `NOT NULL`, so every install already holds
    // conversations that nothing owns — no title, no origin, no last activity, and nothing for `crabby session ls`
    // (`docs/review/CLI.md` C11-01), the Web sidebar (W15-01) or the TUI switcher (T16-01) to list. §4.2 prices two tools
    // against the record (`session.list` T0, `session.rename` T1) and §4.3 gives it four paths, and a tool that reads a
    // table nobody wrote is the mock this build refuses to ship.
    //
    // Three columns are decisions rather than conveniences, and D-104 records them:
    //
    //   - **`title` is nullable.** W15-03: "the new session starts empty and un-named, and the title becomes the first
    //     question asked in it." A title at creation would be a name the user did not choose, and an empty string is not
    //     "un-named" — it is a title that happens to be blank, which is what a client would render as a missing label.
    //   - **`origin_interface` is nullable and has no foreign key.** W15-11 wants "which interface created it … the list
    //     is where a user notices 'this appeared on its own'", and the rows this migration backfills have no recorded
    //     origin: they were minted by whatever created their first task, in a build that did not write the fact down. The
    //     honest value is `NULL` rendered as `unknown`, not a guess that reads as an attribution.
    //   - **`revision` is the §2 concurrency row's token** — "`If-Match`-style version tokens on config and session
    //     mutations, so two interfaces editing the same thing do not silently overwrite". A title is the one field four
    //     interfaces can edit inline at the same moment (W1-02, W15-04, T16-05), so it is the field where a silent
    //     overwrite is most likely and least noticed.
    //
    // The backfill is part of the migration and not a startup repair, because a database that has been upgraded and a
    // database that has been repaired are two different facts about the same file, and only the first is recorded in the
    // ledger. One row per distinct `session_id` a task carries: the title is the *first* task's objective clipped, which
    // is the closest thing this build has to W15-03's "first question asked in it" while no message store exists, and
    // `created_at`/`last_activity_at` come from the tasks rather than from the moment of the migration — a conversation
    // that ran last Tuesday did not become active when the schema caught up with it.
    version: 6,
    name: "sessions",
    up(db) {
      db.exec(`
        CREATE TABLE session (
          id               TEXT PRIMARY KEY,
          title            TEXT,
          model            TEXT,
          origin_interface TEXT CHECK (origin_interface IN ('cli','tui','web','telegram')),
          created_at       TEXT NOT NULL,
          updated_at       TEXT NOT NULL,
          last_activity_at TEXT NOT NULL,
          revision         INTEGER NOT NULL DEFAULT 1
        );
        -- C11-01 sorts by last activity and not by creation, "because that is the order a person remembers in", so the
        -- index is the list's order rather than an optimisation of it.
        CREATE INDEX session_activity ON session (last_activity_at DESC, id);

        INSERT INTO session (id, title, model, origin_interface, created_at, updated_at, last_activity_at, revision)
        SELECT t.session_id,
               (SELECT substr(t2.objective, 1, 80)
                  FROM task t2
                 WHERE t2.session_id = t.session_id
                 ORDER BY t2.created_at ASC, t2.id ASC
                 LIMIT 1),
               NULL,
               NULL,
               MIN(t.created_at),
               MAX(t.updated_at),
               MAX(t.updated_at),
               1
          FROM task t
         GROUP BY t.session_id;
      `);
    },
  },
  {
    // §3.6's per-task model pin (D-108, F-57's model half). The column mirrors `session.model` (version 6): the same
    // `<provider>/<modelId>` spelling, nullable for the same reason — absent means the install's default, a different
    // fact from "no model". One column rather than a split pair because no query filters on the provider half and a pin
    // is one value a reader parses, not two facts to join. A run resolves it against the composed provider (option A):
    // the runner holds one provider, so a pin naming another is refused at `POST /tasks` before the row is written.
    version: 7,
    name: "task-model-pin",
    up(db) {
      db.exec(`
        ALTER TABLE task ADD COLUMN model TEXT;
      `);
    },
  },
  {
    // §3.6's stage 3 says the task record must *show* the switch, so the switch is a column beside `model` rather than
    // something a reader has to dig out of the event log. One nullable JSON column, because the fact is a single object
    // that is written once (by the answer that caused it) and read whole, and because a pair of scalar columns would be
    // five nullable columns for one indivisible claim: either the switch happened with its reason, or it did not happen.
    //
    // Nullable with no default, which is the downgrade stance: a v7 database opens with `model_switch` absent on every
    // row, and `absent` is the meaning `GET /tasks/{id}` already had for a task that never switched. An older build
    // reading a v8 database ignores an extra column, so downgrading needs no table rebuild — it only loses the record of
    // switches made after the downgrade, which is the same thing the event log still carries.
    version: 8,
    name: "task-model-switch",
    up(db) {
      db.exec(`
        ALTER TABLE task ADD COLUMN model_switch_json TEXT;
      `);
    },
  },
  {
    // Which identity a task belongs to, so §14's attribution and F-47's cross-process resumption read one fact instead of
    // excavating it from the log. The `session` table's `origin_interface` (version 6) is the same idea for conversations
    // and kept its own column for the same reason this keeps its own JSON: the record is read whole and written once.
    //
    // JSON rather than three columns because `client_id` is deliberately *not* a foreign key: `client_identity` rows are
    // deleted on revocation (O-071), and a key would either refuse the delete or cascade the task away with it — the exact
    // failure D-104 avoided for conversations. A task outliving the identity that created it is the correct shape (the
    // work happened; the attribution stays), and a resumer checks the row is still there before continuing.
    //
    // Nullable with no default, and the downgrade stance follows version 8's: a version-8 database opens with no origin on
    // any row, `absent` is what `GET /tasks/{id}` already answered for every task, and an older build ignores the column.
    // Rows written before this version keep answering "no origin" rather than a backfilled guess — recovery must refuse
    // their resumption rather than attribute them to whoever happens to be asking.
    version: 9,
    name: "task-origin",
    up(db) {
      db.exec(`
        ALTER TABLE task ADD COLUMN origin_json TEXT;
      `);
    },
  },
  {
    // §2.5's message half, which D-104 explicitly left out and D-112 takes: "messages must retain their role, ordering,
    // relevant timestamps, and association with the correct conversation", with tool calls and their results kept beside the
    // turn they belong to. `role` and `content` are the turn; `ordinal` is its place; `created_at` is when; and the two
    // foreign keys are the association — the conversation always, the task where there was one, because a `/ask` turn
    // (C4-02) has no task and a NOT NULL column would have made the honest row illegal.
    //
    // Both cascades are the deletion half of §2.5, and they differ on purpose. Deleting the conversation deletes its
    // turns — that is what "users can delete their conversation history" means and C11-05's one T3 command is for. Deleting
    // a *task* deletes that task's turns with it, because a turn whose task no longer exists would be a claim about work
    // nobody can see; the conversation survives, and so do the turns its other tasks produced.
    //
    // There is deliberately no column naming the event that announced a turn: the link runs one way, from the frame to the
    // row (`message.added` carries `messageId`), which is the direction a reader needs and the only one that is true at write
    // time — the row is committed before the frame's `seq` exists, so a second column claiming otherwise would hold an
    // event's number or a guess, and §2.5's "association" is about the conversation, not about the log.
    //
    // Downgrade: nullable additions only, so a version-9 build opens and closes with the table simply unused, and a
    // version-10 build read by an older one ignores it. Turns written after a downgrade live in a table the older build does
    // not know about; the event log still carries them, which is the same bargain version 8's column made.
    version: 10,
    name: "messages",
    up(db) {
      db.exec(`
        CREATE TABLE message (
          id          TEXT PRIMARY KEY,
          session_id  TEXT NOT NULL REFERENCES session (id) ON DELETE CASCADE,
          task_id     TEXT REFERENCES task (id) ON DELETE CASCADE,
          role        TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
          content     TEXT NOT NULL,
          ordinal     INTEGER NOT NULL,
          created_at  TEXT NOT NULL
        );
        CREATE INDEX message_session ON message (session_id, ordinal, id);
      `);
    },
  },
  {
    // D-027's "which turns does this summary stand in for", as two nullable ordinals on the summary row
    // itself rather than a second table (D-116). The alternative — a `compaction` table with a row per act —
    // would answer the same question with one more table to migrate, one more cascade to get right, and
    // two ways to read "what was compacted"; a summary that carries its own range cannot disagree with
    // itself, and a turn's coverage is answerable with the index `message_session` already provides.
    //
    // The CHECKs are the load-bearing part. Both columns or neither, because a half-stated range is a range
    // nobody can read: "from 4 to nothing" has no meaning, and SQLite would store it happily. `through` ≥
    // `from`, because a range that ends before it starts is a bug that would silently skip turns. And
    // neither is set on a non-`system` role, because coverage is what makes a summary a summary — a user
    // turn cannot claim to stand in for other turns, and the refusal belongs in the schema because that is
    // where an invalid row cannot exist.
    //
    // Downgrade: nullable additions with a table rebuild (SQLite cannot add a CHECK to an existing table),
    // so a downgrade copies the old seven columns and leaves coverage behind. A version-10 build then reads
    // a summary as an ordinary `system` turn — which is exactly what it is, minus the sentence saying what
    // it replaced. No data is lost and no row is deleted; the only thing lost is the ability to answer
    // "which turns does this stand in for", which is the honest cost of running older code on newer data.
    version: 11,
    name: "message-coverage",
    up(db) {
      db.exec(`
        CREATE TABLE message_v11 (
          id            TEXT PRIMARY KEY,
          session_id    TEXT NOT NULL REFERENCES session (id) ON DELETE CASCADE,
          task_id       TEXT REFERENCES task (id) ON DELETE CASCADE,
          role          TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
          content       TEXT NOT NULL,
          ordinal       INTEGER NOT NULL,
          covers_from   INTEGER,
          covers_through INTEGER,
          created_at    TEXT NOT NULL,
          CHECK ((covers_from IS NULL) = (covers_through IS NULL)),
          CHECK (covers_through IS NULL OR covers_through >= covers_from),
          CHECK (covers_from IS NULL OR role = 'system')
        );
        INSERT INTO message_v11 (id, session_id, task_id, role, content, ordinal, created_at)
          SELECT id, session_id, task_id, role, content, ordinal, created_at FROM message;
        DROP TABLE message;
        ALTER TABLE message_v11 RENAME TO message;
        CREATE INDEX message_session ON message (session_id, ordinal, id);
      `);
    },
  },
  {
    // §8.1's "users SHOULD be able to protect important information", as one column on the row it protects
    // (D-119). The alternative — a `pin` table — would answer "is turn 7 pinned?" with a second read and make a
    // pin a row that can outlive the turn it names; a flag on the turn cannot disagree with it, cannot survive
    // its turn, and is deleted with it by the same cascade §2.5's deletion half already relies on.
    //
    // A default of 0 rather than NULL, because "not pinned" is the normal state of every turn in every
    // conversation and an absent value would make every read answer two questions. The rebuild is the same shape
    // as version 11's, for the same reason: a CHECK cannot be added to an existing table, and the one that
    // matters here is that a pin is a turn's own property — nothing can pin a conversation without naming a row.
    //
    // Downgrade: a rebuild that copies the flag aside, so a version-11 build reads a pinned turn as an ordinary
    // one — which is what it is, minus the flag. No row is lost, and the only thing lost is the protection, which
    // is the honest cost of running older code on newer data: a compaction under version 11 does not know about
    // pins, so it may summarize a turn this version would have kept verbatim.
    version: 12,
    name: "message-pins",
    up(db) {
      db.exec(`
        CREATE TABLE message_v12 (
          id            TEXT PRIMARY KEY,
          session_id    TEXT NOT NULL REFERENCES session (id) ON DELETE CASCADE,
          task_id       TEXT REFERENCES task (id) ON DELETE CASCADE,
          role          TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
          content       TEXT NOT NULL,
          ordinal       INTEGER NOT NULL,
          covers_from   INTEGER,
          covers_through INTEGER,
          pinned        INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
          created_at    TEXT NOT NULL,
          CHECK ((covers_from IS NULL) = (covers_through IS NULL)),
          CHECK (covers_through IS NULL OR covers_through >= covers_from),
          CHECK (covers_from IS NULL OR role = 'system')
        );
        INSERT INTO message_v12 (id, session_id, task_id, role, content, ordinal, covers_from, covers_through, created_at)
          SELECT id, session_id, task_id, role, content, ordinal, covers_from, covers_through, created_at FROM message;
        DROP TABLE message;
        ALTER TABLE message_v12 RENAME TO message;
        CREATE INDEX message_session ON message (session_id, ordinal, id);
      `);
    },
  },
  {
    version: 13,
    name: "memory",
    up(db) {
      db.exec(`
        CREATE TABLE memory (
          id                TEXT PRIMARY KEY,
          content           TEXT NOT NULL,
          category          TEXT,
          origin            TEXT NOT NULL CHECK (origin IN ('stated', 'confirmed', 'inferred')),
          source_kind       TEXT NOT NULL CHECK (source_kind IN ('conversation', 'task', 'user', 'agent')),
          source_id         TEXT,
          source_missing    INTEGER NOT NULL DEFAULT 0 CHECK (source_missing IN (0, 1)),
          source_count      INTEGER NOT NULL DEFAULT 1 CHECK (source_count >= 1),
          external          INTEGER NOT NULL DEFAULT 0 CHECK (external IN (0, 1)),
          status            TEXT NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'superseded', 'needs-review', 'pending')),
          superseded_by     TEXT REFERENCES memory (id),
          created_at        TEXT NOT NULL,
          updated_at        TEXT NOT NULL,
          last_confirmed_at TEXT
        );
        CREATE INDEX memory_status ON memory (status, updated_at);
        CREATE INDEX memory_source ON memory (source_kind, source_id);
        CREATE TABLE memory_reference (
          memory_id  TEXT NOT NULL REFERENCES memory (id) ON DELETE CASCADE,
          session_id TEXT,
          task_id    TEXT,
          at         TEXT NOT NULL
        );
        CREATE INDEX memory_reference_memory ON memory_reference (memory_id);
        CREATE TABLE memory_search (
          memory_id TEXT PRIMARY KEY REFERENCES memory (id) ON DELETE CASCADE,
          content   TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE memory_search_fts USING fts5(memory_id UNINDEXED, content, tokenize='unicode61');
      `);
    },
  },
  {
    // §14's audit trail: append-only by construction — the store exports no update or delete, and the table has no
    // foreign keys a cascade could follow, because an audit row that could be removed by deleting the task it names
    // would be a trail an agent could erase (§14's own refusal).
    version: 14,
    name: "audit",
    up(db) {
      db.exec(`
        CREATE TABLE audit_log (
          id             TEXT PRIMARY KEY,
          ts             TEXT NOT NULL,
          kind           TEXT NOT NULL CHECK (kind IN
                         ('auth_attempt', 'approval', 'config_change', 'tool_invocation', 'extension_install', 'tunnel', 'job_delete')),
          actor          TEXT,
          interface      TEXT,
          session_id     TEXT,
          task_id        TEXT,
          correlation_id TEXT,
          outcome        TEXT NOT NULL CHECK (outcome IN ('ok', 'rejected', 'error')),
          detail         TEXT
        );
        CREATE INDEX audit_kind ON audit_log (kind, ts);
        CREATE INDEX audit_task ON audit_log (task_id, ts);
      `);
    },
  },
];

export function schemaVersion(db: SqliteDb): number {
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_migration").get() as
    | { v: number | null }
    | undefined;
  return row?.v ?? 0;
}

/** Applies whatever is missing and returns the versions it ran, so the Gateway can log them and `crabby doctor` can
 *  print the storage half of `GET /status` truthfully. */
export function migrate(db: SqliteDb): { applied: number[]; version: number } {
  // The ledger table is created here and not inside a migration, because a migration that creates the table recording
  // itself cannot be rolled back consistently if it fails halfway.
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migration (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
  );
  const before = schemaVersion(db);
  const applied: number[] = [];
  const insert = db.prepare(
    "INSERT INTO schema_migration (version, name, applied_at) VALUES (?, ?, ?)",
  );
  for (const migration of MIGRATIONS) {
    if (migration.version <= before) continue;
    db.transaction(() => {
      migration.up(db);
      insert.run(migration.version, migration.name, new Date().toISOString());
    })();
    applied.push(migration.version);
  }
  return { applied, version: schemaVersion(db) };
}
