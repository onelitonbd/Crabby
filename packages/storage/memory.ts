// Long-term memory, as one store with the rules D-073 and D-065 wrote down.
//
// **Provenance, not a confidence score.** A memory carries *how it was learned* — `stated` by the user, `confirmed` by
// an outcome, `inferred` from a pattern — where it came from (which task or conversation), how many independent sources
// support it, and when it was last confirmed. Rank is shown as a word (`stated` outranks `confirmed` outranks
// `inferred`), never as a float: a model-written number cannot be calibrated by anyone, and an uncalibrated number is
// trusted anyway, which makes it worse than no number.
//
// **Conflicts are displayed, never resolved in the dark.** A newer `stated` supersedes an older one (`supersede`); an
// `inferred` never overrides or deletes a `stated`; anything those two rules cannot settle stays as two active entries
// with timestamps, because the no-silent-edit rule for deletions applies to contradictions too.
//
// **Deletion propagates on read, never as a cascade.** Deleting a conversation marks memories whose only provenance is
// that conversation `needs-review` and re-attributes the ones with other sources — it deletes neither (§7: a memory
// may be referenced by other conversations, so cascade deletion must not be the automatic default). A summary whose
// source is gone is *displayed* as `source deleted` rather than rewritten, because rewriting derived text to match a
// deletion is how a memory system starts telling a story it never stored.
//
// **The search index is a derived record.** FTS5 with the one tokenizer (`unicode61`), which does not segment Bangla
// the way a purpose-built library might — the recall is *documented* as imperfect rather than quietly patched (D-065).
// The authoritative record is the `memory` row; `memory_search` is its index, and `rebuildIndex()` reconstructs the
// whole thing from the rows, so the index can never become an uncontrolled source of undeletable data (§2.4).
//
// **Auto-memory has a queue.** Candidates written with `status: "pending"` are the "propose, don't store" policy made
// physical: a proposal sits in the pending queue until a person approves or rejects it (W8-06/T9-06), because a memory
// written silently is a personality change nobody approved (D-073).
import { newId } from "@crabby/api-contracts";
import type { SqliteDb } from "./db.ts";

export type MemoryOrigin = "stated" | "confirmed" | "inferred";
export type MemorySourceKind = "conversation" | "task" | "user" | "agent";
export type MemoryStatus = "active" | "superseded" | "needs-review" | "pending";

export interface MemoryRecord {
  readonly id: string;
  readonly content: string;
  readonly category: string | undefined;
  readonly origin: MemoryOrigin;
  readonly sourceKind: MemorySourceKind;
  readonly sourceId: string | undefined;
  /** `true` when the source the row names no longer exists — §7's "source deleted" is this flag rendered, never a
   *  rewrite of the content or the provenance. */
  readonly sourceMissing: boolean;
  readonly sourceCount: number;
  /** Content that originated from untrusted external material: T2 until a user confirms it (W8-07). */
  readonly external: boolean;
  readonly status: MemoryStatus;
  readonly supersededBy: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastConfirmedAt: string | undefined;
}

export interface MemoryReference {
  readonly memoryId: string;
  readonly sessionId: string | undefined;
  readonly taskId: string | undefined;
  readonly at: string;
}

export interface SaveMemoryInput {
  readonly content: string;
  readonly category?: string | undefined;
  readonly origin: MemoryOrigin;
  readonly sourceKind: MemorySourceKind;
  readonly sourceId?: string | undefined;
  readonly sourceCount?: number | undefined;
  readonly external?: boolean | undefined;
  /** `pending` is the auto-memory queue; everything else starts active. */
  readonly status?: MemoryStatus | undefined;
}

/** What `forget` answers before and after: the entry, and what referenced it — the propagation preview C9-05/W8-08
 *  print, so a deletion is shown before it is committed and recorded after. */
export interface ForgetReport {
  readonly entry: MemoryRecord;
  readonly references: readonly MemoryReference[];
}

export interface MemoryListQuery {
  readonly status?: MemoryStatus | undefined;
  readonly category?: string | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

export interface MemoryCounts {
  readonly active: number;
  readonly superseded: number;
  readonly needsReview: number;
  readonly pending: number;
}

function rowToMemory(row: Record<string, unknown>): MemoryRecord {
  return {
    id: row.id as string,
    content: row.content as string,
    category: (row.category as string | null) ?? undefined,
    origin: row.origin as MemoryOrigin,
    sourceKind: row.source_kind as MemorySourceKind,
    sourceId: (row.source_id as string | null) ?? undefined,
    sourceMissing: row.source_missing === 1,
    sourceCount: row.source_count as number,
    external: row.external === 1,
    status: row.status as MemoryStatus,
    supersededBy: (row.superseded_by as string | null) ?? undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    lastConfirmedAt: (row.last_confirmed_at as string | null) ?? undefined,
  };
}

/** The word a screen shows for trust, one derivation: D-073's rank is provenance read as a word, and W8-07's external
 *  marker is a second word beside it — never a percentage, never a float. */
export function trustWord(entry: MemoryRecord): string {
  if (entry.status === "pending") return "proposed";
  if (entry.status === "needs-review") return "needs review";
  if (entry.status === "superseded") return "superseded";
  if (entry.external) return "unconfirmed";
  return entry.origin;
}

export function createMemoryStore(db: SqliteDb): MemoryStore {
  const insert = db.prepare(
    `INSERT INTO memory (id, content, category, origin, source_kind, source_id, source_missing, source_count,
       external, status, created_at, updated_at, last_confirmed_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
  );
  const insertSearch = db.prepare(
    "INSERT INTO memory_search_fts (memory_id, content) VALUES (?, ?)",
  );
  const deleteSearch = db.prepare("DELETE FROM memory_search_fts WHERE memory_id = ?");
  const now = (): string => new Date().toISOString();

  function indexRow(id: string, content: string): void {
    deleteSearch.run(id);
    insertSearch.run(id, content);
  }

  const store: MemoryStore = {
    save(input: SaveMemoryInput): MemoryRecord {
      const id = newId("mem");
      const at = now();
      insert.run(
        id,
        input.content,
        input.category ?? null,
        input.origin,
        input.sourceKind,
        input.sourceId ?? null,
        input.sourceCount ?? 1,
        input.external === true ? 1 : 0,
        input.status ?? "active",
        at,
        at,
        input.origin === "confirmed" ? at : null,
      );
      indexRow(id, input.content);
      return store.get(id) as MemoryRecord;
    },

    get(id: string): MemoryRecord | undefined {
      const row = db.prepare("SELECT * FROM memory WHERE id = ?").get(id) as
        | Record<string, unknown>
        | undefined;
      return row === undefined ? undefined : rowToMemory(row);
    },

    list(query: MemoryListQuery = {}): readonly MemoryRecord[] {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (query.status !== undefined) {
        clauses.push("status = ?");
        params.push(query.status);
      }
      if (query.category !== undefined) {
        clauses.push("category = ?");
        params.push(query.category);
      }
      const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
      const rows = db
        .prepare(`SELECT * FROM memory ${where} ORDER BY updated_at DESC, id LIMIT ? OFFSET ?`)
        .all(...params, query.limit ?? 200, query.offset ?? 0) as Record<string, unknown>[];
      return rows.map(rowToMemory);
    },

    search(query: string, limit = 50): readonly MemoryRecord[] {
      // FTS5's query syntax is a small language of its own, and a user typing "don't" is not asking for a syntax
      // error: the query is quoted into a phrase, which is the honest reading of "text search".
      const safe = query.replace(/"/g, '""');
      const rows = db
        .prepare(
          `SELECT m.* FROM memory m
           JOIN memory_search_fts f ON f.memory_id = m.id
           WHERE memory_search_fts MATCH ?
           ORDER BY rank LIMIT ?`,
        )
        .all(`"${safe}"`, limit) as Record<string, unknown>[];
      return rows.map(rowToMemory);
    },

    edit(id: string, content: string): MemoryRecord {
      // W8-03: user edits are authoritative over agent-authored text — an edit makes the entry `stated` by the user,
      // which is the strongest provenance this schema can express, and clears a review flag the way an answered
      // question deserves.
      db.prepare(
        `UPDATE memory SET content = ?, origin = 'stated', source_kind = 'user', source_id = NULL,
           status = CASE status WHEN 'superseded' THEN status ELSE 'active' END, updated_at = ? WHERE id = ?`,
      ).run(content, now(), id);
      indexRow(id, content);
      return store.get(id) as MemoryRecord;
    },

    confirm(id: string): MemoryRecord {
      const at = now();
      db.prepare(
        "UPDATE memory SET origin = 'confirmed', external = 0, last_confirmed_at = ?, updated_at = ? WHERE id = ?",
      ).run(at, at, id);
      return store.get(id) as MemoryRecord;
    },

    supersede(oldId: string, newId: string): MemoryRecord | undefined {
      // D-073's rule is the whole gate, and it is narrower than it looks: only **a newer `stated` over an older
      // `stated`** supersedes. An `inferred` never overrides or deletes anything; a `confirmed` entry has not earned
      // the push either. Everything else is two active entries with timestamps, displayed as the contradiction it is.
      const newer = store.get(newId);
      const older = store.get(oldId);
      if (newer === undefined || older === undefined) return undefined;
      if (newer.origin !== "stated" || older.origin !== "stated") return older;
      db.prepare(
        "UPDATE memory SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?",
      ).run(newId, now(), oldId);
      return store.get(oldId);
    },

    recordReference(input: {
      memoryId: string;
      sessionId?: string | undefined;
      taskId?: string | undefined;
    }): void {
      db.prepare(
        "INSERT INTO memory_reference (memory_id, session_id, task_id, at) VALUES (?, ?, ?, ?)",
      ).run(input.memoryId, input.sessionId ?? null, input.taskId ?? null, now());
    },

    references(id: string): readonly MemoryReference[] {
      return db
        .prepare("SELECT * FROM memory_reference WHERE memory_id = ? ORDER BY at")
        .all(id) as unknown as readonly MemoryReference[];
    },

    forget(id: string): ForgetReport | undefined {
      const entry = store.get(id);
      if (entry === undefined) return undefined;
      const refs = store.references(id);
      const gone = db.transaction(() => {
        db.prepare("DELETE FROM memory_reference WHERE memory_id = ?").run(id);
        deleteSearch.run(id);
        db.prepare("DELETE FROM memory WHERE id = ?").run(id);
      });
      gone();
      return { entry, references: refs };
    },

    forgetTopicPreview(matchText: string): readonly MemoryRecord[] {
      return store.search(matchText, 10_000).filter((entry) => entry.status === "active");
    },

    forgetMany(ids: readonly string[]): readonly MemoryRecord[] {
      const gone: MemoryRecord[] = [];
      const run = db.transaction(() => {
        for (const id of ids) {
          const report = store.forget(id);
          if (report !== undefined) gone.push(report.entry);
        }
      });
      run();
      return gone;
    },

    propagateConversationDeletion(sessionId: string): {
      needsReview: number;
      reattributed: number;
    } {
      // §7 by way of D-065: a conversation's death never deletes a memory. Memories whose only provenance is that
      // conversation are *marked* for review; memories with other sources are retained and re-attributed — the count
      // drops, and the pointer that now names a deleted conversation is flagged `source_missing` so a screen can say
      // "source deleted" instead of inventing a replacement story.
      const rows = db
        .prepare(
          "SELECT * FROM memory WHERE source_kind = 'conversation' AND source_id = ? AND status != 'superseded'",
        )
        .all(sessionId) as Record<string, unknown>[];
      let needsReview = 0;
      let reattributed = 0;
      const run = db.transaction(() => {
        for (const row of rows) {
          if ((row.source_count as number) <= 1) {
            db.prepare(
              "UPDATE memory SET status = 'needs-review', updated_at = ? WHERE id = ?",
            ).run(now(), row.id as string);
            needsReview += 1;
          } else {
            db.prepare(
              "UPDATE memory SET source_count = source_count - 1, source_missing = 1, updated_at = ? WHERE id = ?",
            ).run(now(), row.id as string);
            reattributed += 1;
          }
        }
      });
      run();
      return { needsReview, reattributed };
    },

    review(id: string, decision: "approve" | "reject"): MemoryRecord | undefined {
      const entry = store.get(id);
      if (entry === undefined || entry.status !== "pending") return entry;
      if (decision === "approve") {
        db.prepare("UPDATE memory SET status = 'active', updated_at = ? WHERE id = ?").run(
          now(),
          id,
        );
        return store.get(id);
      }
      const report = store.forget(id);
      return report?.entry;
    },

    counts(): MemoryCounts {
      const rows = db.prepare("SELECT status, COUNT(*) AS n FROM memory GROUP BY status").all() as {
        status: string;
        n: number;
      }[];
      const counts = { active: 0, superseded: 0, needsReview: 0, pending: 0 };
      for (const row of rows) {
        if (row.status === "active") counts.active = row.n;
        if (row.status === "superseded") counts.superseded = row.n;
        if (row.status === "needs-review") counts.needsReview = row.n;
        if (row.status === "pending") counts.pending = row.n;
      }
      return counts;
    },

    rebuildIndex(): number {
      const run = db.transaction(() => {
        db.prepare("DELETE FROM memory_search_fts").run();
        for (const row of db.prepare("SELECT id, content FROM memory").all() as Record<
          string,
          unknown
        >[]) {
          insertSearch.run(row.id as string, row.content as string);
        }
      });
      run();
      return (db.prepare("SELECT COUNT(*) AS n FROM memory_search_fts").get() as { n: number }).n;
    },
  };
  return store;
}

export interface MemoryStore {
  save(input: SaveMemoryInput): MemoryRecord;
  get(id: string): MemoryRecord | undefined;
  list(query?: MemoryListQuery): readonly MemoryRecord[];
  search(query: string, limit?: number): readonly MemoryRecord[];
  edit(id: string, content: string): MemoryRecord;
  confirm(id: string): MemoryRecord;
  /** D-073's first conflict rule, as a call: a newer `stated` may supersede an older one; an `inferred` never
   *  supersedes anything and a `stated` is never pushed aside — the attempt returns the older entry unchanged. */
  supersede(oldId: string, newId: string): MemoryRecord | undefined;
  recordReference(input: {
    memoryId: string;
    sessionId?: string | undefined;
    taskId?: string | undefined;
  }): void;
  references(id: string): readonly MemoryReference[];
  forget(id: string): ForgetReport | undefined;
  /** The T3 preview: what "forget everything about X" would touch, counted before anybody is asked to confirm. */
  forgetTopicPreview(matchText: string): readonly MemoryRecord[];
  forgetMany(ids: readonly string[]): readonly MemoryRecord[];
  /** §7's propagation, called by the conversation-delete path — never a cascade in the schema. */
  propagateConversationDeletion(sessionId: string): { needsReview: number; reattributed: number };
  /** The pending queue's answer: approve makes the proposal active, reject deletes it — both are a person's act. */
  review(id: string, decision: "approve" | "reject"): MemoryRecord | undefined;
  counts(): MemoryCounts;
  /** §2.4's "rebuildable from authoritative records", as one call; answers the number of indexed rows. */
  rebuildIndex(): number;
}
