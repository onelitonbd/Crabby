// The task repository. `docs/DATA_AND_MEMORY.md` §6's first principle is "persist critical task state transitions
// before reporting them as durably recorded", so every write here completes before its caller answers — the whole
// reason this is synchronous SQLite rather than a fire-and-forget cache.
import {
  newId,
  type TaskCancellation,
  type TaskModelSwitch,
  type TaskRecord,
  type TaskState,
} from "@crabby/api-contracts";
import type { SqliteDb } from "./db.ts";
import { touchSession } from "./sessions.ts";

export interface CreateTaskInput {
  readonly objective: string;
  readonly sessionId?: string;
  /** §3.6's per-task pin (D-108), the `<provider>/<modelId>` pair the route validated against the composed provider. */
  readonly model?: string;
  readonly now?: string;
  readonly id?: string;
}

export interface ListTasksOptions {
  readonly limit: number;
  readonly cursor?: string | undefined;
  readonly state?: TaskState | undefined;
  readonly sessionId?: string | undefined;
}

/** The columns every task query selects, exported with the decoder below so a second reader of the table — `sessions.ts`,
 *  which answers `GET /api/v1/sessions/{id}` with the tasks in one conversation — cannot form a second opinion about what a
 *  row means. Two decoders drift the first time §6.2 adds a column, and the drift shows up as a record with a field missing
 *  in one route and present in another. */
export const TASK_SELECT = `SELECT id, session_id, state, objective, model, created_at, updated_at, last_seq, error_code, error_message, cancellation_json, model_switch_json FROM task`;

export type TaskRow = {
  id: string;
  session_id: string;
  state: string;
  objective: string;
  model: string | null;
  created_at: string;
  updated_at: string;
  last_seq: number;
  error_code: string | null;
  error_message: string | null;
  cancellation_json: string | null;
  model_switch_json: string | null;
};

export function createTask(db: SqliteDb, input: CreateTaskInput): TaskRecord {
  const now = input.now ?? new Date().toISOString();
  const record: TaskRecord = {
    id: input.id ?? newId("tsk"),
    sessionId: input.sessionId ?? newId("ses"),
    state: "queued",
    objective: input.objective,
    ...(input.model === undefined ? {} : { model: input.model }),
    createdAt: now,
    updatedAt: now,
    lastSeq: 0,
  };
  db.prepare(
    `INSERT INTO task (id, session_id, state, objective, model, created_at, updated_at, last_seq)
     VALUES (@id, @sessionId, @state, @objective, @model, @createdAt, @updatedAt, @lastSeq)`,
  ).run({ ...record, model: input.model ?? null });
  return record;
}

export function getTask(db: SqliteDb, id: string): TaskRecord | undefined {
  const row = db.prepare(`${TASK_SELECT} WHERE id = ?`).get(id) as TaskRow | undefined;
  return row && taskRecordFromRow(row);
}

/** §2's pagination: ordered by stable id, cursor is "give me everything after this id", so a list cannot shift under
 *  a client while the task it is watching appends records. */
export function listTasks(
  db: SqliteDb,
  options: ListTasksOptions,
): { items: TaskRecord[]; nextCursor?: string } {
  const where: string[] = [];
  const params: Record<string, unknown> = { limit: options.limit + 1 };
  if (options.state) {
    where.push("state = @state");
    params.state = options.state;
  }
  if (options.sessionId) {
    where.push("session_id = @sessionId");
    params.sessionId = options.sessionId;
  }
  if (options.cursor) {
    where.push("id > @cursor");
    params.cursor = options.cursor;
  }
  const sql = `${TASK_SELECT}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY id ASC LIMIT @limit`;
  const rows = db.prepare(sql).all(params) as TaskRow[];
  const page = rows.slice(0, options.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(taskRecordFromRow),
    ...(rows.length > options.limit && last ? { nextCursor: last.id } : {}),
  };
}

export interface SetStateOptions {
  readonly now?: string;
  /** The failure a client reads on `GET /tasks/{id}`. Omitting it clears whatever a previous state left, which is what the
   *  columns do: a task that moves out of `failed` should not keep a reason for a state it is no longer in. */
  readonly error?: { code: string; message: string };
  /** §6.2's evidence, written once by the settle (F-46, D-089). Omitting it leaves what is there alone, because the only
   *  writer is the cancellation manager and no other state move has an opinion about it. */
  readonly cancellation?: TaskCancellation;
  /** §3.6 stage 3's switch, written by the answer that caused it (D-044). Omitting it leaves what is there alone rather
   *  than clearing it, because the same rule holds: exactly one writer — the resume that switched — has an opinion about
   *  it, and every other state move in the runtime passes no value here rather than an empty one. `model` is written the
   *  same statement and with the same rule, so a record can never name one model and describe a switch to another. */
  readonly model?: string;
  readonly modelSwitch?: TaskModelSwitch;
}

/** Every task in one of these states, unpaginated, for the startup scan §7.1 requires. `listTasks` stays cursor-paged
 *  because a client reads a page at a time; this exists because "restore the latest valid state of *every* task" is not a
 *  question a page can answer, and the row count is bounded by D-065's retention rather than by a limit. */
export function tasksInStates(db: SqliteDb, states: readonly TaskState[]): TaskRecord[] {
  if (states.length === 0) return [];
  const placeholders = states.map(() => "?").join(", ");
  const rows = db
    .prepare(`${TASK_SELECT} WHERE state IN (${placeholders})`)
    .all(...states) as TaskRow[];
  return rows.map(taskRecordFromRow);
}

export function setState(
  db: SqliteDb,
  id: string,
  state: TaskState,
  options: SetStateOptions = {},
): boolean {
  const now = options.now ?? new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE task SET state = ?, updated_at = ?, error_code = ?, error_message = ?,
                       cancellation_json = COALESCE(?, cancellation_json),
                       model = COALESCE(?, model),
                       model_switch_json = COALESCE(?, model_switch_json)
       WHERE id = ? AND state <> ?`,
    )
    .run(
      state,
      now,
      options.error?.code ?? null,
      options.error?.message ?? null,
      options.cancellation === undefined ? null : JSON.stringify(options.cancellation),
      options.model ?? null,
      options.modelSwitch === undefined ? null : JSON.stringify(options.modelSwitch),
      id,
      state,
    );
  const changed = result.changes > 0;
  if (changed) {
    // The conversation's last activity, written in the same statement that moved the task: a task changing state *is*
    // something happening in a session, and C11-01 sorts by exactly that ("last activity, not creation, because that is
    // the order a person remembers in"). Left to a caller it would be a fact four writers had to remember to write.
    const row = db.prepare("SELECT session_id FROM task WHERE id = ?").get(id) as
      | { session_id: string }
      | undefined;
    if (row !== undefined) touchSession(db, row.session_id, now);
  }
  return changed;
}
export function setLastSeq(db: SqliteDb, id: string, seq: number): void {
  db.prepare("UPDATE task SET last_seq = ?, updated_at = ? WHERE id = ? AND last_seq < ?").run(
    seq,
    new Date().toISOString(),
    id,
    seq,
  );
}

export function stateCounts(db: SqliteDb): Record<string, number> {
  const rows = db.prepare("SELECT state, COUNT(*) AS n FROM task GROUP BY state").all() as {
    state: string;
    n: number;
  }[];
  return Object.fromEntries(rows.map((row) => [row.state, row.n]));
}

export function taskRecordFromRow(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    state: row.state as TaskState,
    objective: row.objective,
    ...(row.model === null ? {} : { model: row.model }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeq: row.last_seq,
    ...(row.error_code === null || row.error_message === null
      ? {}
      : { error: { code: row.error_code, message: row.error_message } }),
    ...(row.cancellation_json === null
      ? {}
      : { cancellation: JSON.parse(row.cancellation_json) as TaskCancellation }),
    ...(row.model_switch_json === null
      ? {}
      : { modelSwitch: JSON.parse(row.model_switch_json) as TaskModelSwitch }),
  };
}
