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
    createdAt: now,
  };
  db.prepare(
    `INSERT INTO message (id, session_id, task_id, role, content, ordinal, created_at)
     VALUES (@id, @sessionId, @taskId, @role, @content, @ordinal, @createdAt)`,
  ).run({ ...record, taskId: record.taskId ?? null });
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
  const rows = (
    options.after === undefined
      ? db
          .prepare(
            "SELECT id, session_id, task_id, role, content, ordinal, created_at, created_at FROM message WHERE session_id = ? ORDER BY ordinal ASC LIMIT ?",
          )
          .all(sessionId, limit)
      : db
          .prepare(
            "SELECT id, session_id, task_id, role, content, ordinal, created_at FROM message WHERE session_id = ? AND ordinal > ? ORDER BY ordinal ASC LIMIT ?",
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

/** Every turn a task produced, for the surfaces that show one task's conversation (`GET /tasks/{id}`'s siblings, C6-06's
 *  transcript) without reading a whole conversation. */
export function taskMessages(db: SqliteDb, taskId: string): readonly MessageRecord[] {
  const rows = db
    .prepare(
      "SELECT id, session_id, task_id, role, content, ordinal, created_at FROM message WHERE task_id = ? ORDER BY ordinal ASC",
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
    createdAt: row.created_at,
  };
}
