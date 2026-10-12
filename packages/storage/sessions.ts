// The conversation repository: the record schema version 6 added, and the four things the interfaces ask of it — list them
// in the order a person remembers (`docs/review/CLI.md` C11-01), read one with the tasks that belong to it, name one the
// first time something happens in it (W15-03), and edit a title without letting two interfaces overwrite each other (§2's
// concurrency row).
//
// Two rules in this file are about what a session is *not*:
//
//   - **A rename does not move `lastActivityAt`, and activity does not move `revision`.** The first is because C11-01 sorts
//     by activity and a list ordered by edits would bury a conversation somebody is working in under one somebody tidied;
//     the second is because `revision` is the token a mutation compares against, and a token invalidated by a task
//     finishing would make every rename from a phone fail on a race nobody was having. The two clocks measure different
//     things and are deliberately not the same column.
//   - **Nothing here deletes.** Deleting a conversation is `history.deleteConversation` at T3 (§4.2, W15-07), so this
//     repository has no `DELETE` statement to be reached by accident — C11-05's "exactly one command that destroys
//     history" is kept by an absence in the code rather than by a guard in a route.
import {
  CLIENT_INTERFACES,
  type ClientInterface,
  isTerminal,
  newId,
  type SessionActionCode,
  type SessionRecord,
  type SessionRow,
  type SessionTaskFacts,
  sessionRow,
  type TaskRecord,
} from "@crabby/api-contracts";
import { type SqliteDb, transact } from "./db.ts";
import { TASK_SELECT, type TaskRow, taskRecordFromRow } from "./tasks.ts";

export const SESSION_TABLE = "session";

const COLUMNS = `id, title, model, origin_interface, created_at, updated_at, last_activity_at, revision`;

/** The row as SQLite holds it. Named apart from the contract's `SessionRow` on purpose: one is a column list with `NULL`s
 *  in it and the other is what a client reads, and a file that used one name for both would be a file where a missing
 *  mapping still typechecks. */
interface SessionDbRow {
  readonly id: string;
  readonly title: string | null;
  readonly model: string | null;
  readonly origin_interface: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly last_activity_at: string;
  readonly revision: number;
}

/** A stored value this build does not know is an error rather than a string, for the reason `jobs.ts` gives: SQLite holds
 *  any `TEXT` in a `CHECK`ed column when the file was written by another build or edited by hand, and reading it back as an
 *  arbitrary origin would put an attribution in a client's hands that no interface produced. */
function oneOf<T extends string>(value: string, vocabulary: readonly T[], what: string): T {
  if (!(vocabulary as readonly string[]).includes(value)) {
    throw new Error(
      `${what} is stored as \`${value}\`, which is not one of ${vocabulary.join(", ")} — restore from backup or ` +
        "delete the row (`docs/DATA_AND_MEMORY.md` §8)",
    );
  }
  return value as T;
}

function toRecord(row: SessionDbRow): SessionRecord {
  return {
    id: row.id,
    ...(row.title === null ? {} : { title: row.title }),
    ...(row.model === null ? {} : { model: row.model }),
    ...(row.origin_interface === null
      ? {}
      : { origin: oneOf(row.origin_interface, CLIENT_INTERFACES, `session ${row.id}'s origin`) }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at,
    revision: row.revision,
  };
}

function read(db: SqliteDb, id: string): SessionRecord | undefined {
  const row = db.prepare(`SELECT ${COLUMNS} FROM session WHERE id = ?`).get(id) as
    | SessionDbRow
    | undefined;
  return row === undefined ? undefined : toRecord(row);
}

export interface CreateSessionInput {
  readonly id?: string;
  readonly title?: string;
  readonly model?: string;
  readonly origin?: ClientInterface;
  readonly now?: string;
}

/** A new conversation. W15-03's is the shape: it starts empty and un-named, so every field but the id and the timestamps is
 *  optional and `{}` creates a session with nothing to show in a list except its own existence. */
export function createSession(db: SqliteDb, input: CreateSessionInput = {}): SessionRecord {
  const now = input.now ?? new Date().toISOString();
  const record: SessionRecord = {
    // `ses_` is one of the five prefixes `ids.ts` documents, so this is the one table in the schema whose id the documents
    // already named — unlike a client identity or a job, which are opaque and recorded as such (O-070).
    id: input.id ?? newId("ses"),
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.origin === undefined ? {} : { origin: input.origin }),
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    revision: 1,
  };
  db.prepare(
    `INSERT INTO session (id, title, model, origin_interface, created_at, updated_at, last_activity_at, revision)
     VALUES (@id, @title, @model, @origin, @createdAt, @updatedAt, @lastActivityAt, @revision)`,
  ).run({
    id: record.id,
    title: record.title ?? null,
    model: record.model ?? null,
    origin: record.origin ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastActivityAt: record.lastActivityAt,
    revision: record.revision,
  });
  return record;
}

export function getSession(db: SqliteDb, id: string): SessionRecord | undefined {
  return read(db, id);
}

export interface ListSessionsOptions {
  readonly limit?: number;
  /** Exclusive: the `lastActivityAt` of the last row a client already has, so a page continues where the previous one
   *  stopped instead of repeating the row it ended on. */
  readonly before?: string;
  readonly origin?: ClientInterface;
}

/** C11-01's order — last activity, newest first — as a query rather than as a sort in every client. Ties break on the id,
 *  so two sessions touched in the same millisecond keep a stable order between pages. */
export function listSessions(db: SqliteDb, options: ListSessionsOptions = {}): SessionRecord[] {
  const limit = options.limit ?? 200;
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (options.before !== undefined) {
    where.push("(last_activity_at < ? OR (last_activity_at = ? AND id > ?))");
    params.push(options.before, options.before, "");
  }
  if (options.origin !== undefined) {
    where.push("origin_interface = ?");
    params.push(options.origin);
  }
  const sql =
    `SELECT ${COLUMNS} FROM session` +
    (where.length === 0 ? "" : ` WHERE ${where.join(" AND ")}`) +
    " ORDER BY last_activity_at DESC, id ASC LIMIT ?";
  const rows = db.prepare(sql).all(...params, limit) as SessionDbRow[];
  return rows.map(toRecord);
}

export interface SessionPatch {
  readonly title?: string;
  /** `null` clears the override and returns the session to the install's default; `undefined` leaves it alone. */
  readonly model?: string | null;
  /** The revision the caller last saw. Required, because §2's concurrency row is about a write that arrives after
   *  another one, and a patch that omitted the token would be exactly the silent overwrite it forbids. */
  readonly expectedRevision: number;
  readonly now?: string;
}

export type SessionPatchResult =
  | { readonly ok: true; readonly session: SessionRecord }
  | { readonly ok: false; readonly code: SessionActionCode; readonly reason: string };

/** Renames a session and/or moves its model override, comparing the revision the caller holds with the one on the row.
 *  One statement with the comparison in its `WHERE`, rather than a read followed by a write: two interfaces saving an inline
 *  edit in the same instant is the case the token exists for, and a check performed in two steps is a check that can pass
 *  twice. */
export function patchSession(db: SqliteDb, id: string, patch: SessionPatch): SessionPatchResult {
  const current = read(db, id);
  if (current === undefined)
    return {
      ok: false,
      code: "not-found",
      reason: `no session ${id} — \`crabby session ls\` prints the ids this install holds`,
    };
  if (patch.title === undefined && patch.model === undefined)
    return {
      ok: false,
      code: "no-change",
      reason:
        "a patch with neither a title nor a model is not an edit; `PATCH /api/v1/sessions/{id}` takes those two and " +
        "nothing else, because deleting a conversation is `history.deleteConversation` at T3 (§4.2, C11-05)",
    };
  if (patch.expectedRevision !== current.revision)
    return {
      ok: false,
      code: "stale",
      reason:
        `session ${id} is at revision ${current.revision} and this write carries ${patch.expectedRevision}, so somebody ` +
        "edited it between the read and the write. Re-read it and decide again: §2's rule is that two interfaces editing " +
        "one thing do not silently overwrite, and the token is how a client learns it lost the race instead of winning it " +
        "quietly",
    };
  const now = patch.now ?? new Date().toISOString();
  const nextTitle = patch.title ?? current.title;
  const nextModel = patch.model === undefined ? current.model : (patch.model ?? undefined);
  const changed = db
    .prepare(
      `UPDATE session
          SET title = @title, model = @model, updated_at = @now, revision = revision + 1
        WHERE id = @id AND revision = @expectedRevision`,
    )
    .run({
      id,
      title: nextTitle ?? null,
      model: nextModel ?? null,
      now,
      expectedRevision: patch.expectedRevision,
    });
  if (changed.changes === 0)
    // Reached only when a second writer landed between the read above and this statement, which is the same race with a
    // narrower window: answered as `stale` rather than retried, because a retry that succeeded would have overwritten the
    // write the caller was told about.
    return {
      ok: false,
      code: "stale",
      reason: `session ${id} was written again while this patch was being applied; re-read it and decide again`,
    };
  const updated = read(db, id);
  if (updated === undefined)
    return { ok: false, code: "unwritable", reason: `session ${id} could not be read back` };
  return { ok: true, session: updated };
}

/** Records that something happened in a conversation. Called by the task path, which is the only activity this build has:
 *  a message store would give it a second caller, and C11-01's "last activity" would then mean what it reads as.
 *
 *  `revision` is deliberately untouched, and so is `updated_at`: this is not an edit to the record but a fact about the
 *  conversation, and a token that expired every time a task moved would make an inline rename fail on a race nobody was
 *  having. */
export function touchSession(
  db: SqliteDb,
  id: string,
  at: string = new Date().toISOString(),
): void {
  db.prepare("UPDATE session SET last_activity_at = ? WHERE id = ? AND last_activity_at < ?").run(
    at,
    id,
    at,
  );
}

export interface EnsureSessionInput {
  readonly id: string;
  /** The objective of the task that is about to be recorded, offered as the title only while the session has none:
   *  W15-03's "the title becomes the first question asked in it", and in a build with no message store the first question
   *  is the first task's objective. Never overwrites a title, because a name the user chose is not a placeholder. */
  readonly titleFrom?: string;
  readonly origin?: ClientInterface;
  readonly now?: string;
}

/** The write the task path makes so that a conversation always exists as a record: create it if nothing owns the id, name
 *  it if it is un-named, and record the activity either way. One transaction, because a task whose session row is missing
 *  is a conversation that cannot be listed — which is the state this migration exists to end. */
export function ensureSession(db: SqliteDb, input: EnsureSessionInput): SessionRecord {
  const now = input.now ?? new Date().toISOString();
  return transact(db, () => {
    const existing = read(db, input.id);
    if (existing === undefined) {
      const title = input.titleFrom === undefined ? undefined : clipTitle(input.titleFrom);
      return createSession(db, {
        id: input.id,
        ...(title === undefined ? {} : { title }),
        ...(input.origin === undefined ? {} : { origin: input.origin }),
        now,
      });
    }
    if (existing.title === undefined && input.titleFrom !== undefined)
      db.prepare("UPDATE session SET title = ? WHERE id = ? AND title IS NULL").run(
        clipTitle(input.titleFrom),
        input.id,
      );
    touchSession(db, input.id, now);
    return read(db, input.id) ?? existing;
  });
}

/** W15-04 limits the inline edit to 40 characters and W1-02 renders 24 with an ellipsis, but neither is a storage rule: a
 *  derived title is a clipped objective, and the clip is 80 so that a title read back from the database still says what the
 *  conversation was for. Clipped on a code-point boundary rather than a byte one, because a Bengali objective's fortieth
 *  character is not at byte forty and half a grapheme is not a title. */
export function clipTitle(text: string, max = 80): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  const points = [...trimmed];
  return points.length <= max ? points.join("") : `${points.slice(0, max - 1).join("")}…`;
}

/** The task facts a session's state word is computed from, for every session at once: one aggregate query rather than one
 *  per row, because C11-01's list is a page a phone renders and a page that cost one query per line would not be rendered. */
export function sessionTaskFacts(db: SqliteDb): Map<string, SessionTaskFacts> {
  const rows = db
    .prepare(
      `SELECT session_id,
              COUNT(*) AS tasks,
              SUM(CASE WHEN state = 'awaiting_approval' THEN 1 ELSE 0 END) AS waiting,
              SUM(CASE WHEN state NOT IN (${TERMINAL_PLACEHOLDERS}) THEN 1 ELSE 0 END) AS running
         FROM task
        GROUP BY session_id`,
    )
    .all(...TERMINAL_STATES) as {
    session_id: string;
    tasks: number;
    waiting: number;
    running: number;
  }[];
  const facts = new Map<string, SessionTaskFacts>();
  for (const row of rows)
    facts.set(row.session_id, {
      tasks: row.tasks,
      waitingApproval: row.waiting,
      running: row.running,
    });
  return facts;
}

export function sessionTaskFactsFor(db: SqliteDb, id: string): SessionTaskFacts {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS tasks,
              SUM(CASE WHEN state = 'awaiting_approval' THEN 1 ELSE 0 END) AS waiting,
              SUM(CASE WHEN state NOT IN (${TERMINAL_PLACEHOLDERS}) THEN 1 ELSE 0 END) AS running
         FROM task
        WHERE session_id = ?`,
    )
    .get(...TERMINAL_STATES, id) as { tasks: number; waiting: number; running: number };
  return { tasks: row.tasks, waitingApproval: row.waiting, running: row.running };
}

/** A session's tasks, newest first, bounded by the caller — the read `GET /api/v1/sessions/{id}` answers with beside the
 *  true total, for the reason a job's run history is bounded rather than paged. The columns and the decoder are
 *  `tasks.ts`'s, so a task read from a session and a task read from `GET /api/v1/tasks/{id}` are the same record by
 *  construction rather than by coincidence. */
export function sessionTasks(db: SqliteDb, id: string, limit: number): TaskRecord[] {
  const rows = db
    .prepare(
      `${TASK_SELECT.replace("FROM task", "")}FROM task
        WHERE session_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .all(id, limit) as TaskRow[];
  return rows.map(taskRecordFromRow);
}

export function sessionTaskCount(db: SqliteDb, id: string): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM task WHERE session_id = ?").get(id) as {
    n: number;
  };
  return row.n;
}

/** One conversation as a list line reads it. The derivation lives here rather than in each caller because it is a claim
 *  about two tables at once: `GET /api/v1/sessions` and `session.list` both answer with it, and two derivations would be
 *  two opinions about whether a conversation with a parked task is `running` or `waiting-approval`. */
export function sessionRowOf(db: SqliteDb, record: SessionRecord): SessionRow {
  return sessionRow(record, sessionTaskFactsFor(db, record.id));
}

/** A page of them, with one aggregate query for the whole page rather than one per row: C11-01's list is what a phone
 *  renders on a pull-down, and a list that cost one query per line would not survive the render. */
export function sessionRows(db: SqliteDb, records: readonly SessionRecord[]): SessionRow[] {
  const facts = sessionTaskFacts(db);
  const none: SessionTaskFacts = { tasks: 0, running: 0, waitingApproval: 0 };
  return records.map((record) => sessionRow(record, facts.get(record.id) ?? none));
}

/** The terminal states, taken from the contract's own predicate rather than written out here: a second list of states is a
 *  list that drifts, and the drift would be a session that reads `running` forever because a state this file did not know
 *  about ended. */
const TERMINAL_STATES: readonly string[] = [
  "completed",
  "failed",
  "cancelled",
  "interrupted",
].filter((state) => isTerminal(state as TaskRecord["state"]));
const TERMINAL_PLACEHOLDERS = TERMINAL_STATES.map(() => "?").join(", ");
