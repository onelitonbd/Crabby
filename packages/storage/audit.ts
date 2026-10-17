// §14's audit trail, as a store. The properties the section decides and this file keeps:
//
//   - **Append-only from the application's perspective** — there is no update and no delete exported, and the table
//     has no foreign keys a cascade could follow, so deleting the task an audit row names cannot erase the trail
//     (§14's own refusal, made structural).
//   - **Redaction on the way in** — the same rule `appendEvent` follows (§7): a payload that reached the database has
//     already escaped the boundary that was supposed to stop it. What is kept is *what was attempted*; what is
//     stripped is the secret-shaped half (O-022's fine rules stay open; the scanner's rules are the ones that exist).
//   - **Paging by id** — `aud_` ids are time-sortable like every id in `ids.ts`, so `GET /audit`'s cursor is "after
//     this row", stable under inserts, and honest about order (`sortedBy`-style: the answer states the order).
//
// The writer's list is §14's: auth attempts and failures, permission decisions, approval requests with their payload
// and outcome, tool invocations with tier, config changes, extension installs, tunnel start/stop. The Gateway writes
// the rows it witnesses; a tool invocation the (future) runner makes will write through the same function, because a
// second audit writer would be a second opinion about the trail.

import { newId } from "@crabby/api-contracts";
import { redact } from "@crabby/core";
import type { SqliteDb } from "./db.ts";

export const AUDIT_KINDS = [
  "auth_attempt",
  "approval",
  "config_change",
  "tool_invocation",
  "extension_install",
  "tunnel",
  "job_delete",
] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

export const AUDIT_OUTCOMES = ["ok", "rejected", "error"] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export interface AuditEntry {
  readonly ts: string;
  readonly kind: AuditKind;
  readonly outcome: AuditOutcome;
  /** Who acted: a client id, or a word for a path with no credential (`local`, `anonymous`). */
  readonly actor?: string;
  readonly interface?: string;
  readonly sessionId?: string;
  readonly taskId?: string;
  readonly correlationId?: string;
  /** What was attempted, redacted on write. Absent is normal — most rows need no payload. */
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface AuditRow {
  readonly id: string;
  readonly ts: string;
  readonly kind: AuditKind;
  readonly outcome: AuditOutcome;
  readonly actor: string | undefined;
  readonly interface: string | undefined;
  readonly sessionId: string | undefined;
  readonly taskId: string | undefined;
  readonly correlationId: string | undefined;
  readonly detail: Readonly<Record<string, unknown>> | undefined;
}

export function recordAudit(db: SqliteDb, entry: AuditEntry): string {
  const id = newId("aud");
  db.prepare(
    "INSERT INTO audit_log (id, ts, kind, actor, interface, session_id, task_id, correlation_id, outcome, detail) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    entry.ts,
    entry.kind,
    entry.actor ?? null,
    entry.interface ?? null,
    entry.sessionId ?? null,
    entry.taskId ?? null,
    entry.correlationId ?? null,
    entry.outcome,
    entry.detail === undefined ? null : JSON.stringify(redact(entry.detail)),
  );
  return id;
}

export function listAudit(
  db: SqliteDb,
  options: {
    readonly cursor?: string | undefined;
    readonly taskId?: string | undefined;
    readonly limit?: number | undefined;
  } = {},
): { readonly rows: readonly AuditRow[]; readonly sortedBy: "id" } {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.cursor !== undefined) {
    clauses.push("id > ?");
    params.push(options.cursor);
  }
  if (options.taskId !== undefined) {
    clauses.push("task_id = ?");
    params.push(options.taskId);
  }
  const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
  const rows = db
    .prepare(
      `SELECT id, ts, kind, actor, interface, session_id, task_id, correlation_id, outcome, detail FROM audit_log ${where} ORDER BY id LIMIT ?`,
    )
    .all(...params, limit + 1) as {
    id: string;
    ts: string;
    kind: string;
    actor: string | null;
    interface: string | null;
    session_id: string | null;
    task_id: string | null;
    correlation_id: string | null;
    outcome: string;
    detail: string | null;
  }[];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    rows: page.map((row) => ({
      id: row.id,
      ts: row.ts,
      kind: row.kind as AuditKind,
      outcome: row.outcome as AuditOutcome,
      actor: row.actor ?? undefined,
      interface: row.interface ?? undefined,
      sessionId: row.session_id ?? undefined,
      taskId: row.task_id ?? undefined,
      correlationId: row.correlation_id ?? undefined,
      detail: row.detail === null ? undefined : (JSON.parse(row.detail) as Record<string, unknown>),
    })),
    sortedBy: "id",
  };
}
