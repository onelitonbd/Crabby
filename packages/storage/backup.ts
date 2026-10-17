// D-065's backup sentence, made concrete: "Backup is `db.backup()` to a timestamped file plus the config
// directory; restore is a documented manual step that runs an integrity check first." This module is the
// machine half of that — the documented manual step lives in `docs/DATA_AND_MEMORY.md` §8, and the two agree
// because they were written in the same change (D-034's rule, applied to a sentence about files).
//
// What a backup is, and is not:
//
//   - The **database** is copied with better-sqlite3's own online `db.backup()`, not by copying bytes: §8's
//     first bullet prices exactly this ("a backup method safe for the selected storage engine (online backup
//     preferred over raw file copy)"), and a raw copy of a WAL database taken while a Gateway is writing is a
//     restore gamble, not a backup.
//   - The **configuration** and the **extension repo** ride along, because a backup that restores a database
//     whose provider entries point at names the config no longer has is half a machine.
//   - **Secrets are excluded by default** (§8's fourth bullet): the vault's file is never copied — on the
//     restoring device a key arrives by `crabby vault set`, from the person who will type it, not from a file
//     a backup carried — and neither do the two bearer-token files. Each exclusion is named in the manifest
//     with its reason, because an exclusion a user has to discover after a crash is a second disaster.
//   - The **integrity check runs here**, at backup time, against the copy — §8's "restore validation" is
//     answered where it can be automated: a backup that does not pass `integrity_check` is deleted, not kept
//     to be discovered broken on the day it is needed. The manual restore still begins from a verified file.
//   - **Retention is the user's**: nothing prunes `backups/`, and the one disclosure §8 requires is printed by
//     the verb and recorded in D-142 — a backup is a moment in time, and data deleted after it was taken
//     returns when it is restored.
//
// There is no route for any of this, on purpose: a backup writes local files on the machine that owns them,
// which is the same class of act as `crabby init` and `crabby vault set` — local-only commands with no remote
// face, because a tunnel caller asking a Gateway to write a directory tree is a §13 question nobody should have
// to answer at restore time.
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DB_FILE_NAME, openDatabase, type SqliteDb } from "./db.ts";
import { schemaVersion } from "./migrate.ts";

export interface BackupExclusion {
  readonly name: string;
  readonly reason: string;
}

export type BackupResult =
  | {
      readonly ok: true;
      readonly dir: string;
      readonly database: string;
      readonly integrity: "ok";
      readonly included: readonly string[];
      readonly excluded: readonly BackupExclusion[];
      readonly schemaVersion: number;
      readonly created: string;
    }
  | { readonly ok: false; readonly reason: string };

/** The exclusions every backup carries, exported so the CLI's answer and the manifest say the same words. The
 *  names are state-dir-relative, and the reasons are sentences a person reads at 2 a.m., not field names. */
export function exclusionsFor(): readonly BackupExclusion[] {
  return [
    {
      name: "vault/",
      reason:
        "secrets are excluded by default (§8) — on the restoring device a key arrives by `crabby vault set`, from the person who types it",
    },
    { name: "client.json", reason: "a paired client's bearer token; pairing again is the revocation-safe path" },
    { name: "telegram.json", reason: "bearer tokens for the bot's paired chats" },
    { name: "gateway.json / last-exit.json", reason: "runtime state a Gateway start rewrites" },
    { name: "scratch/", reason: "tool payloads over the inline cap; the startup prune treats them as disposable" },
    { name: "backups/", reason: "a backup never contains itself" },
  ];
}

export async function createBackup(input: {
  db: SqliteDb;
  stateDir: string;
  /** Where the timestamped directory is created; default `<stateDir>/backups`. */
  destination?: string | undefined;
  now?: Date | undefined;
}): Promise<BackupResult> {
  const now = input.now ?? new Date();
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const dir = path.join(input.destination ?? path.join(input.stateDir, "backups"), `crabby-backup-${stamp}`);

  const configPath = path.join(input.stateDir, "config.json");
  const extensionsDir = path.join(input.stateDir, "extensions");
  const mcpDir = path.join(input.stateDir, "mcp");
  const included: string[] = [];

  try {
    mkdirSync(dir, { recursive: true });
    // The online copy: better-sqlite3 pages the database out through its own backup API, which is consistent
    // against a writing Gateway in a way a byte copy can never be (§8's first bullet).
    const databasePath = path.join(dir, DB_FILE_NAME);
    await input.db.backup(databasePath);
    included.push(DB_FILE_NAME);

    if (existsSync(configPath)) {
      copyFileSync(configPath, path.join(dir, "config.json"));
      included.push("config.json");
    }
    for (const [name, from] of [
      ["extensions/", extensionsDir],
      ["mcp/", mcpDir],
    ] as const) {
      if (!existsSync(from)) continue;
      // A report file vanishing mid-copy is not a failed backup — the manifest carries what was copied, and the
      // next backup re-takes it.
      cpSync(from, path.join(dir, name.replace("/", "")), { recursive: true });
      included.push(name);
    }

    // §8's "restore validation": the copy is opened — the file, not the live database — and must pass
    // `integrity_check`, or this backup never happened. The dir is removed so `backups/` only ever holds
    // copies that answered for themselves.
    const verify = openDatabase(databasePath, { readonly: true });
    let verdict: string | undefined;
    try {
      const row = verify.db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
      verdict = row?.integrity_check;
    } finally {
      verify.close();
    }
    if (verdict !== "ok") {
      rmSync(dir, { recursive: true, force: true });
      return { ok: false, reason: `the copy failed its integrity check (${verdict ?? "no answer"}) and was deleted` };
    }

    // A database that has never been migrated (a fresh `crabby init`, before the first Gateway start) is still a
    // legal thing to back up — it is exactly what you want on disk before an upgrade — so the manifest records
    // version 0 rather than asking for a table the file does not have yet.
    const ledger = input.db
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'schema_migration'")
      .get() as { n: number };
    const version = ledger.n === 0 ? 0 : schemaVersion(input.db);
    const excluded = exclusionsFor();
    writeFileSync(
      path.join(dir, "manifest.json"),
      `${JSON.stringify({ created: now.toISOString(), schemaVersion: version, included, excluded }, null, 2)}\n`,
      "utf8",
    );
    return {
      ok: true,
      dir,
      database: databasePath,
      integrity: "ok",
      included,
      excluded,
      schemaVersion: version,
      created: now.toISOString(),
    };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `the backup did not complete: ${reason}` };
  }
}

/** The backup directories that exist, oldest first — the verb's `ls` half, and what a restore doc points at.
 *  A directory without a `manifest.json` is not listed: an unnamed copy is not a backup this module made. */
export function listBackups(destination: string): readonly string[] {
  if (!existsSync(destination)) return [];
  return readdirSync(destination)
    .filter((name) => name.startsWith("crabby-backup-"))
    .filter((name) => existsSync(path.join(destination, name, "manifest.json")))
    .sort();
}
