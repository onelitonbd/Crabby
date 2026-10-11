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
