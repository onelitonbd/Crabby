// The event store, and the two documented numbers it enforces: §5.2's "payload size cap with a truncation marker;
// large tool output is referenced by id, not inlined" — which D-064 priced at 64 KiB inline with the rest in the
// per-task scratch and the path printed — and D-065's retention (30 days or 5 000 events per task, pruned at startup
// and after a task completes, never lazily during a replay).

import { writeFileSync } from "node:fs";
import path from "node:path";
import { type Event, MAX_EVENT_PAYLOAD_BYTES, SCHEMA_VERSION } from "@crabby/api-contracts";
import { redact } from "@crabby/core";
import type { SqliteDb } from "./db.ts";

/** D-049's count-bounded replay window. The window is per task, because what a client needs after a three-second
 *  phone blip is that task's tail — and a number this small is a tuning knob, not a design: 200 events at the inline
 *  cap is a few megabytes at worst, and anything beyond it is the gap marker's job. */
export const REPLAY_WINDOW_EVENTS = 200;

export interface AppendEventInput {
  /** A *task-scoped* event: the journal is the task_event table, and §4.4's replay is per-task. The system
   *  family (`system.ready`, `system.vault.unlocked`, …) publishes over the bus without journalling — its
   *  replayable truth is the status routes — so the type here keeps the fields the table's primary key needs. */
  readonly event: Event & { readonly taskId: string; readonly sessionId: string };
  /** Where overflow bytes go. When omitted, a too-large payload is truncated without a reference — which the contract
   *  allows (the marker is what a client reads), but the Gateway always passes a scratch path. */
  readonly scratchDir?: string | undefined;
}

export interface AppendResult {
  readonly seq: number;
  readonly truncated: boolean;
  readonly overflowPath?: string | undefined;
}

export function appendEvent(db: SqliteDb, input: AppendEventInput): AppendResult {
  const { event } = input;
  // Redaction happens on the way *in*, not on the way out: a secret that reaches the database has already escaped the
  // boundary that was supposed to stop it (`SECURITY.md` §7 puts the obligation at the serialization layer).
  const payload = redact(event.payload);
  const inline = JSON.stringify(payload);
  const tooBig = inline.length > MAX_EVENT_PAYLOAD_BYTES;
  let stored = payload as Record<string, unknown>;
  let overflowPath: string | undefined;
  if (tooBig) {
    if (input.scratchDir) {
      overflowPath = path.join(input.scratchDir, `${event.id}.json`);
      writeFileSync(overflowPath, inline);
      stored = { truncated: true, bytes: inline.length, reference: overflowPath };
    } else {
      stored = { truncated: true, bytes: inline.length };
    }
  }
  const seq = nextSeq(db, event.taskId);
  db.prepare(
    `INSERT INTO task_event (id, task_id, session_id, seq, type, ts, schema_version, correlation_id, payload_json, truncated, overflow_path)
     VALUES (@id, @taskId, @sessionId, @seq, @type, @ts, @schemaVersion, @correlationId, @payloadJson, @truncated, @overflowPath)`,
  ).run({
    id: event.id,
    taskId: event.taskId,
    sessionId: event.sessionId,
    seq,
    type: event.type,
    ts: event.ts,
    schemaVersion: event.schemaVersion,
    correlationId: event.correlationId ?? null,
    payloadJson: JSON.stringify(stored),
    truncated: tooBig ? 1 : 0,
    overflowPath: overflowPath ?? null,
  });
  db.prepare("UPDATE task SET last_seq = MAX(last_seq, ?), updated_at = ? WHERE id = ?").run(
    seq,
    event.ts,
    event.taskId,
  );
  return { seq, truncated: tooBig, ...(overflowPath === undefined ? {} : { overflowPath }) };
}

/** Sequence numbers start at **1**, not 0, so that `task.lastSeq === 0` means "this task has no events yet" and
 *  never the ambiguous "its first event has number 0". §5.2 requires monotonicity per task and prices no start value;
 *  D-079 records the choice with the other unpriced numbers this milestone had to pick. */
function nextSeq(db: SqliteDb, taskId: string): number {
  const row = db
    .prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM task_event WHERE task_id = ?")
    .get(taskId) as { s: number };
  return row.s + 1;
}

export interface ReadEventsOptions {
  readonly afterSeq?: number;
  readonly limit?: number;
}

export function readEvents(db: SqliteDb, taskId: string, options: ReadEventsOptions = {}): Event[] {
  const rows = db
    .prepare(
      `SELECT id, session_id, seq, type, ts, schema_version, correlation_id, payload_json
       FROM task_event WHERE task_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
    )
    .all(taskId, options.afterSeq ?? -1, options.limit ?? 500) as {
    id: string;
    session_id: string;
    seq: number;
    type: string;
    ts: string;
    schema_version: number;
    correlation_id: string | null;
    payload_json: string;
  }[];
  return rows.map((row) => ({
    id: row.id,
    // The column exists so a future schema bump can be read honestly, and every row written by this build carries
    // `SCHEMA_VERSION`; reading an older number back would be a migration's business, not this map's.
    schemaVersion: SCHEMA_VERSION,
    type: row.type,
    ts: row.ts,
    sessionId: row.session_id,
    taskId,
    ...(row.correlation_id === null ? {} : { correlationId: row.correlation_id }),
    seq: row.seq,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
  }));
}

/** The newest `limit` events, for an SSE reconnect that arrives with a `Last-Event-ID` inside the window. */
export function readReplayWindow(
  db: SqliteDb,
  taskId: string,
  limit = REPLAY_WINDOW_EVENTS,
): Event[] {
  const rows = readEvents(db, taskId, { limit: 10_000 });
  return rows.slice(-limit);
}

export function oldestRetainedSeq(db: SqliteDb, taskId: string): number {
  const row = db.prepare("SELECT MIN(seq) AS s FROM task_event WHERE task_id = ?").get(taskId) as {
    s: number | null;
  };
  return row.s ?? 0;
}

/** D-065: 30 days or 5 000 events per task, whichever comes first. Called at startup and after a task completes —
 *  never from a replay, because a replay that prunes while it streams misreports what it showed. */
export function pruneEvents(
  db: SqliteDb,
  options: { maxAgeDays?: number; maxPerTask?: number; now?: Date } = {},
): { deleted: number } {
  const maxAgeDays = options.maxAgeDays ?? 30;
  const maxPerTask = options.maxPerTask ?? 5_000;
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
  const byAge = db.prepare("DELETE FROM task_event WHERE ts < ?").run(cutoff);
  const byCount = db
    .prepare(
      `DELETE FROM task_event
       WHERE task_id IN (SELECT id FROM task)
         AND seq <= (SELECT MAX(seq) - @maxPerTask FROM task_event e2 WHERE e2.task_id = task_event.task_id)`,
    )
    .run({ maxPerTask });
  return { deleted: byAge.changes + byCount.changes };
}

export { SCHEMA_VERSION };
