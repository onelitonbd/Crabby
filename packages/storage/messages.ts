// A conversation's turns, as a table (D-112, §2.5's message half).
//
// This exists because the event log is not a conversation. §2.5 asks for messages that keep their role, ordering, relevant
// timestamps and association with the right conversation; §5.2's log answers "what happened", which is a different question
// with a different retention (D-065 prices it per task) and a different reader. D-027's compaction needs records it may
// summarize *without* replacing, and it cannot summarize an event stream that §8.2 has already truncated at 64 KiB.
//
// Three rules, and each is a place where the obvious alternative was worse:
//
//   - **One writer, and it is the loop.** `append` is called inside the same transaction as the `message.added` event, by the
//     same code path. A second writer — a route, a tool, an import — would be a second opinion about what a turn is, and
//     `event_seq` exists precisely so a reviewer can prove the row and the frame agree.
//   - **Ordering is an ordinal, not the id.** Ids are time-sortable *as a convenience* (`ids.ts` says so in those words) and
//     two turns in one millisecond are ordered by nothing. `MAX(ordinal) + 1` inside the transaction is the conversation's
//     own counter, and `message_session`'s index is built for exactly this read.
//   - **The content is redacted on write**, through the same `redact()` the event payload uses. SECURITY.md §8.2 counts
//     conversation records and checkpoints as different *categories* of stored data — a category is about which deletion
//     rule applies, and neither is a place where a credential may sit.

import { type MESSAGE_ROLES, type MessageRecord, newId } from "@crabby/api-contracts";
import { redact } from "@crabby/core";
import type { SqliteDb } from "./db.ts";

/** The contract's list, not a second one: the column's `CHECK` in the migration and the schema in `packages/api-contracts`
 *  enumerate the same four, and a role added to either without the other is a role this build can store and cannot type. */
export type MessageRole = (typeof MESSAGE_ROLES)[number];

export interface AppendMessageInput {
  readonly sessionId: string;
  /** Absent for a turn no task produced; see the migration's comment for why the column is nullable. */
  readonly taskId?: string | undefined;
  readonly role: MessageRole;
  readonly content: string;
  /** D-116: present only on a summary, and only for a `system` role — the schema's own CHECK refuses the
   *  other combinations, so an honest caller cannot state a range for a turn that stands for nothing. */
  readonly covers?: { readonly from: number; readonly through: number } | undefined;
  readonly now?: string;
  readonly id?: string;
}

/** Writes one turn and answers it as stored — the redacted text, the ordinal the conversation gave it and the id it was
 *  minted with, because the caller needs all three to write the event that announces it. */
export function appendMessage(db: SqliteDb, input: AppendMessageInput): MessageRecord {
  const now = input.now ?? new Date().toISOString();
  // The foreign key would refuse this insert anyway, with a message naming a constraint rather than the fact. The check is
  // here because the caller is inside the loop's phase, where a raw SQLite error would surface as "the run threw" and name
  // nothing a caller could act on — and because the fact it names is a real one: a turn belongs to a conversation, and a
  // conversation that was never written down is a turn that belongs to nothing.
  if (
    db.prepare("SELECT 1 AS present FROM session WHERE id = ?").get(input.sessionId) === undefined
  ) {
    throw new Error(
      `no conversation ${input.sessionId} is in the database, so a turn cannot belong to it; ` +
        "ensureSession is what creates the row, and the Gateway's task handoff calls it before any run starts",
    );
  }
  const row = db
    .prepare("SELECT COALESCE(MAX(ordinal), 0) + 1 AS next FROM message WHERE session_id = ?")
    .get(input.sessionId) as { next: number };
  const record: MessageRecord = {
    id: input.id ?? newId("msg"),
    sessionId: input.sessionId,
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    role: input.role,
    content: redact(input.content),
    ordinal: row.next,
    ...(input.covers === undefined ? {} : { covers: { ...input.covers } }),
    createdAt: now,
  };
  db.prepare(
    `INSERT INTO message (id, session_id, task_id, role, content, ordinal, covers_from, covers_through, created_at)
     VALUES (@id, @sessionId, @taskId, @role, @content, @ordinal, @coversFrom, @coversThrough, @createdAt)`,
  ).run({
    ...record,
    taskId: record.taskId ?? null,
    coversFrom: record.covers?.from ?? null,
    coversThrough: record.covers?.through ?? null,
  });
  return record;
}

export interface ListMessagesOptions {
  readonly limit?: number;
  /** §2's cursor: the ordinal to resume after. The ordinal rather than an id, because it is the stable thing a page is
   *  ordered by — an id cursor would have to encode the ordinal anyway. */
  readonly after?: number | undefined;
}

/** One conversation's turns in order, and how many it holds in total — the same "bounded page, true count beside it" shape
 *  a job's run history and a session's tasks use, for the same reason: a conversation kept for a month can hold more turns
 *  than a phone should render in one answer. */
export function listMessages(
  db: SqliteDb,
  sessionId: string,
  options: ListMessagesOptions = {},
): { readonly items: readonly MessageRecord[]; readonly count: number } {
  const limit = options.limit ?? 100;
  const columns =
    "id, session_id, task_id, role, content, ordinal, covers_from, covers_through, pinned, created_at";
  const rows = (
    options.after === undefined
      ? db
          .prepare(
            `SELECT ${columns} FROM message WHERE session_id = ? ORDER BY ordinal ASC LIMIT ?`,
          )
          .all(sessionId, limit)
      : db
          .prepare(
            `SELECT ${columns} FROM message WHERE session_id = ? AND ordinal > ? ORDER BY ordinal ASC LIMIT ?`,
          )
          .all(sessionId, options.after, limit)
  ) as MessageRow[];
  const total = (
    db.prepare("SELECT COUNT(*) AS n FROM message WHERE session_id = ?").get(sessionId) as {
      n: number;
    }
  ).n;
  return { items: rows.map(messageFromRow), count: total };
}

export function countMessages(db: SqliteDb, sessionId: string): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM message WHERE session_id = ?").get(sessionId) as {
      n: number;
    }
  ).n;
}

/** One small integer per turn: its ordinal, whether it is pinned, and how long its content is. D-119's context view
 *  needs a cost *per section* (C10-01: "each section with its cost"), and this is how it gets one without loading
 *  the conversation: SQLite counts the characters and hands over three numbers per turn, so a conversation of a
 *  thousand turns costs a thousand tiny rows rather than a thousand texts. `LENGTH(content)` on a TEXT value counts
 *  characters, not bytes, which is what §3.4's heuristic divides — so the number that leaves the store is already
 *  in the unit the estimate wants. */
export function messageLengths(
  db: SqliteDb,
  sessionId: string,
): readonly { readonly ordinal: number; readonly pinned: boolean; readonly chars: number }[] {
  const rows = db
    .prepare(
      "SELECT ordinal, pinned, LENGTH(content) AS chars FROM message WHERE session_id = ? ORDER BY ordinal ASC",
    )
    .all(sessionId) as { ordinal: number; pinned: number; chars: number }[];
  return rows.map((row) => ({ ordinal: row.ordinal, pinned: row.pinned === 1, chars: row.chars }));
}

/** D-119's three pin operations, over ordinals because ordinals are what a reader of
 *  `GET /sessions/{id}/messages` holds — a turn's id is a machine name, its ordinal is the number the transcript
 *  prints, and a pin named in the number a person can see is a pin a person can check.
 *
 *  Each returns the number of rows it changed, and each says `0` rather than throwing when the range names turns
 *  this conversation does not have: a pin is a request about turns, and "none of those turns exist here" is an
 *  answer the route turns into a 404 naming the conversation's real range, rather than a constraint error the
 *  caller has to decode. */
export interface PinRange {
  readonly from: number;
  readonly through: number;
}

export function pinMessages(db: SqliteDb, sessionId: string, range: PinRange): number {
  return db
    .prepare(
      "UPDATE message SET pinned = 1 WHERE session_id = ? AND ordinal BETWEEN ? AND ? AND pinned = 0",
    )
    .run(sessionId, range.from, range.through).changes;
}

export function unpinMessage(db: SqliteDb, sessionId: string, messageId: string): number {
  return db
    .prepare("UPDATE message SET pinned = 0 WHERE session_id = ? AND id = ? AND pinned = 1")
    .run(sessionId, messageId).changes;
}

/** The ranges of pinned turns, collapsed into one entry per unbroken run — because `GET /sessions/{id}/context`
 *  answers "what is protected" and a list of forty ordinals is not an answer a screen can print. */
export function pinnedRanges(db: SqliteDb, sessionId: string): readonly PinRange[] {
  const rows = db
    .prepare("SELECT ordinal FROM message WHERE session_id = ? AND pinned = 1 ORDER BY ordinal ASC")
    .all(sessionId) as { ordinal: number }[];
  const ranges: PinRange[] = [];
  for (const row of rows) {
    const last = ranges.at(-1);
    if (last !== undefined && row.ordinal === last.through + 1) {
      ranges[ranges.length - 1] = { from: last.from, through: row.ordinal };
    } else {
      ranges.push({ from: row.ordinal, through: row.ordinal });
    }
  }
  return ranges;
}

/** The pinned ordinals as a set a planner can ask about, which is the only thing compaction needs to know about
 *  a pin: not what it says, but that this turn must not be summarized away. */
export function pinnedOrdinals(db: SqliteDb, sessionId: string): ReadonlySet<number> {
  return new Set(
    (
      db
        .prepare("SELECT ordinal FROM message WHERE session_id = ? AND pinned = 1")
        .all(sessionId) as { ordinal: number }[]
    ).map((row) => row.ordinal),
  );
}

/** One turn by id, for a caller that holds a row's id rather than a page — the route that compacts writes a summary
 *  and is asked to answer with it, and re-reading a page to find the row it just wrote would be a second way of
 *  getting at the same fact. `undefined` is a row that is not there. */
export function getMessage(db: SqliteDb, messageId: string): MessageRecord | undefined {
  const row = db
    .prepare(
      "SELECT id, session_id, task_id, role, content, ordinal, covers_from, covers_through, pinned, created_at FROM message WHERE id = ?",
    )
    .get(messageId) as MessageRow | undefined;
  return row === undefined ? undefined : messageFromRow(row);
}

/** How many characters a conversation holds, without reading one of them. D-118's route asks this first, because a
 *  phone that has to load forty turns to discover it had twelve is a phone that did the wrong work: the decision
 *  "does this need compacting?" can be made on a length, and only a conversation that needs it pays for the read.
 *  The count is in *characters*, not tokens, because that is the cheapest thing SQLite can count without loading
 *  the rows — `packages/agent-runtime`'s estimator turns it into tokens, and the turn it takes is the upper bound
 *  of the heuristic (one cluster is never more than one character). */
export function messageCharCount(
  db: SqliteDb,
  sessionId: string,
): { readonly chars: number; readonly rows: number } {
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(LENGTH(content)), 0) AS chars, COUNT(*) AS rows FROM message WHERE session_id = ?",
    )
    .get(sessionId) as { chars: number; rows: number };
  return { chars: row.chars, rows: row.rows };
}

/** Every turn a task produced, for the surfaces that show one task's conversation (`GET /tasks/{id}`'s siblings, C6-06's
 *  transcript) without reading a whole conversation. */
export function taskMessages(db: SqliteDb, taskId: string): readonly MessageRecord[] {
  const rows = db
    .prepare(
      "SELECT id, session_id, task_id, role, content, ordinal, covers_from, covers_through, pinned, created_at FROM message WHERE task_id = ? ORDER BY ordinal ASC",
    )
    .all(taskId) as MessageRow[];
  return rows.map(messageFromRow);
}

type MessageRow = {
  id: string;
  session_id: string;
  task_id: string | null;
  role: string;
  content: string;
  ordinal: number;
  covers_from: number | null;
  covers_through: number | null;
  pinned: number;
  created_at: string;
};

function messageFromRow(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    ...(row.task_id === null ? {} : { taskId: row.task_id }),
    role: row.role as MessageRole,
    content: row.content,
    ordinal: row.ordinal,
    ...(row.pinned === 1 ? { pinned: true } : {}),
    ...(row.covers_from === null || row.covers_through === null
      ? {}
      : { covers: { from: row.covers_from, through: row.covers_through } }),
    createdAt: row.created_at,
  };
}

/** D-116: the turn ids one summary stands in for, in the order they happened. It is a *read* over coverage
 *  rather than a write over the covered rows: §2.5's "must not silently replace or destroy original
 *  conversation records" is why the original turns stay rows and the summary points at them. A row with no
 *  range covers nothing, and answers `[]` rather than refusing — which is the same answer an ordinary turn
 *  deserves. */
export function coveredMessageIds(db: SqliteDb, messageId: string): readonly string[] {
  const summary = db
    .prepare(
      "SELECT session_id AS sessionId, covers_from AS first, covers_through AS last FROM message WHERE id = ?",
    )
    .get(messageId) as { sessionId: string; first: number | null; last: number | null } | undefined;
  if (summary === undefined || summary.first === null || summary.last === null) return [];
  // `ordinal BETWEEN first AND last` rather than "everything older than the summary": a summary that
  // covers turns 4–9 says so, and a reader that inferred the range from the summary's own ordinal would
  // report turns 1–3 as covered when they were kept verbatim.
  const rows = db
    .prepare(
      "SELECT id FROM message WHERE session_id = ? AND ordinal BETWEEN ? AND ? ORDER BY ordinal ASC",
    )
    .all(summary.sessionId, summary.first, summary.last) as { id: string }[];
  return rows.map((covered) => covered.id);
}
