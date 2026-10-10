// `Idempotency-Key`, because §2 makes it a contract rule and §11 makes it a test: "a replayed key returns the
// recorded result, never a second execution". The record is the response itself, so a retry after a lost answer gets
// the same bytes rather than a fresh execution or a `conflict` about a key it already supplied.
import { createHash } from "node:crypto";
import type { SqliteDb } from "./db.ts";

export interface IdempotencyRecord {
  readonly key: string;
  readonly route: string;
  readonly requestHash: string;
  readonly response: unknown;
  readonly createdAt: string;
}

export function requestHash(body: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(body ?? null))
    .digest("hex");
}

export function recall(
  db: SqliteDb,
  key: string,
  route: string,
  hash: string,
): { found: false } | { found: true; record: IdempotencyRecord } | { found: true; mismatch: true } {
  const row = db
    .prepare(
      "SELECT key, route, request_hash, response_json, created_at FROM idempotency WHERE key = ? AND route = ?",
    )
    .get(key, route) as
    | {
        key: string;
        route: string;
        request_hash: string;
        response_json: string;
        created_at: string;
      }
    | undefined;
  if (!row) return { found: false };
  if (row.request_hash !== hash) return { found: true, mismatch: true };
  return {
    found: true,
    record: {
      key: row.key,
      route: row.route,
      requestHash: row.request_hash,
      response: JSON.parse(row.response_json) as unknown,
      createdAt: row.created_at,
    },
  };
}

export function remember(
  db: SqliteDb,
  input: { key: string; route: string; requestHash: string; response: unknown; now?: string },
): void {
  db.prepare(
    `INSERT INTO idempotency (key, route, request_hash, response_json, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (key, route) DO NOTHING`,
  ).run(
    input.key,
    input.route,
    input.requestHash,
    JSON.stringify(input.response),
    input.now ?? new Date().toISOString(),
  );
}
