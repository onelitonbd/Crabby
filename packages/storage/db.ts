// One SQLite connection, opened the way the documents require: WAL so a reader (the TUI, a browser, `sqlite3`
// itself) never blocks the writer; `busy_timeout` from D-074's 5 s so a second process waits instead of failing; and
// `foreign_keys` on, because "cascade on delete-session" (§7) is a schema fact and not a query someone remembers.
//
// `docs/DATA_AND_MEMORY.md` §4 warns that SQLite allows one writer at a time and asks for "a bounded, serialized
// write queue". `better-sqlite3` is synchronous, so within one Gateway process every write is already serialized by
// the event loop — the queue would be a queue of one. The requirement that actually bites is the cross-process one,
// and `busy_timeout` is what answers it. When an async driver or a second writer is ever added, this file is the
// place the queue belongs, and this comment is the reason it is not here yet.

import type { LimitsConfig } from "@crabby/core";
import Database from "better-sqlite3";

export type SqliteDb = Database.Database;

export interface OpenOptions {
  readonly readonly?: boolean;
  readonly limits?: LimitsConfig | undefined;
  /** `:memory:` is a real database for tests; a file path is what production opens. */
  readonly file?: string;
}

export const DB_FILE_NAME = "crabby.sqlite3";

export interface Handle {
  readonly db: SqliteDb;
  readonly path: string;
  close(): void;
}

export function openDatabase(path: string, options: OpenOptions = {}): Handle {
  const db = new Database(path, { readonly: options.readonly ?? false });
  if (!options.readonly) db.pragma("journal_mode = WAL");
  db.pragma(`busy_timeout = ${options.limits?.sqliteBusyTimeoutMs ?? 5000}`);
  db.pragma("foreign_keys = ON");
  return {
    db,
    path,
    close() {
      db.close();
    },
  };
}

/** A transaction is the unit §6 of `docs/DATA_AND_MEMORY.md` asks for ("use transactions for logically related
 *  updates"), and better-sqlite3's `transaction()` is the whole mechanism — no wrapper cleverness on top of it. */
export function transact<T>(db: SqliteDb, fn: () => T): T {
  const wrapped = db.transaction(fn);
  return wrapped();
}
