// D-065's checkpoint over SQLite: `CheckpointStore` from `packages/agent-runtime` implemented here, in the direction
// `ARCHITECTURE.md` §19 requires ("infrastructure adapters implement those abstractions") and in the same arrangement as
// `approvals.ts` and `journal.ts` — the runtime owns the shape, this file owns the rows, and nothing in
// `packages/agent-runtime` knows a database exists. It is also the answer to `docs/DATA_AND_MEMORY.md` §5's "task and
// checkpoint repository": the task half was implemented twice over (`tasks.ts` for the record, `journal.ts` for the
// runtime's write seam) and the checkpoint half was nobody's. It is somebody's now.
//
// Three properties this file is responsible for, none of them re-decided here:
//
//   - **One row per task.** D-095's first rule, enforced by the primary key rather than by discipline: a boundary
//     replaces the one before it, because §7.1 restores the *latest* valid state and a history of checkpoints would be a
//     second event log with a retention rule nobody priced.
//   - **Redaction happens on the way in.** The record holds a run's working context — assistant text, tool arguments and
//     tool output — which is exactly the material `SECURITY.md` §7 puts at the serialization layer, and exactly what
//     §7's first bullet refuses to interleave with records a user might export. `appendEvent` does this for events and
//     this file does it for checkpoints, for the same reason: a payload that reached the database has already escaped the
//     boundary that was supposed to stop it. The consequence is written down rather than hidden — a resumed context
//     carries markers wherever a secret-shaped value was, which is why a checkpoint is never the authority for an action
//     (the arbiter's row is) and why the view reports `redacted: true`.
//   - **The write is synchronous and belongs to the caller's transaction.** `packages/agent-runtime`'s loop commits a
//     boundary inside the phase that records the step, so the checkpoint and the events that make the step committed are
//     one SQLite commit. A `write` that deferred, batched or opened its own transaction would break the one property
//     "committed step boundary" is claiming.
import type { CheckpointRecord, CheckpointStore } from "@crabby/agent-runtime";
import { redact } from "@crabby/core";
import type { SqliteDb } from "./db.ts";

const SELECT = `SELECT task_id, boundary, state, step, last_seq, model_id, written_at, bytes, record_json FROM checkpoint`;

type Row = {
  task_id: string;
  boundary: string;
  state: string;
  step: number;
  last_seq: number;
  model_id: string;
  written_at: string;
  bytes: number;
  record_json: string;
};

export function readCheckpoint(db: SqliteDb, taskId: string): CheckpointRecord | undefined {
  const row = db.prepare(`${SELECT} WHERE task_id = ?`).get(taskId) as Row | undefined;
  // The record is read back whole rather than reassembled from columns: the columns exist for a reader that must not have
  // to parse a transcript, and reassembling from them would make two sources of truth inside one row.
  return row === undefined ? undefined : (JSON.parse(row.record_json) as CheckpointRecord);
}

export function writeCheckpoint(db: SqliteDb, record: CheckpointRecord): void {
  const stored = redact(record);
  const json = JSON.stringify(stored);
  // An upsert rather than a delete-then-insert, because one row per task is D-095's rule and a two-statement version has
  // a window in which the task has no saved state at all. Note which names are which: `excluded.` refers to the row that
  // failed to insert, by *column* name, while the at-names belong to the parameter object — mixing them is a SqliteError,
  // which is the one kindness in a statement this easy to get wrong.
  db.prepare(
    `INSERT INTO checkpoint (task_id, boundary, state, step, last_seq, model_id, written_at, bytes, record_json)
     VALUES (@taskId, @boundary, @state, @step, @lastSeq, @modelId, @writtenAt, @bytes, @recordJson)
     ON CONFLICT (task_id) DO UPDATE SET
       boundary = excluded.boundary,
       state = excluded.state,
       step = excluded.step,
       last_seq = excluded.last_seq,
       model_id = excluded.model_id,
       written_at = excluded.written_at,
       bytes = excluded.bytes,
       record_json = excluded.record_json`,
  ).run({
    taskId: record.taskId,
    boundary: record.boundary,
    state: record.state,
    step: record.step,
    lastSeq: record.lastSeq,
    modelId: record.modelId,
    writtenAt: new Date(record.writtenAt).toISOString(),
    // The stored length, not the caller's: the number a view reports is the number of bytes this file wrote, redaction
    // included, so a reader cannot be shown a size the row does not have.
    bytes: json.length,
    recordJson: json,
  });
}

/** How many checkpoints the file holds. A one-row-per-task table makes this the count of tasks that reached a step
 *  boundary, which is the number `crabby doctor` and a storage report want without a second query to `task`. */
export function checkpointCount(db: SqliteDb): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM checkpoint").get() as { n: number };
  return row.n;
}

export function createSqliteCheckpointStore(db: SqliteDb): CheckpointStore {
  return {
    read: (taskId) => readCheckpoint(db, taskId),
    write: (record) => writeCheckpoint(db, record),
  };
}
