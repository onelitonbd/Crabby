// `crabby backup` — D-065's backup sentence with a machine behind it (`packages/storage/backup.ts`), and a
// restore that stays what D-065 says it is: a documented manual step. The verb's job is to make that step rare
// and legible, not to automate it — an automated restore that guesses which files to replace is the one command
// a panicked user should never have to trust. So the answer prints the restore doc's §8 pointer, the exclusions
// with their reasons (§8 requires the secrets-excluded default to be visible, not discoverable), and the one
// disclosure retention carries: data deleted after a backup was taken returns when it is restored.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { EXIT, type ExitCode } from "@crabby/api-contracts";
import type { DataLayout } from "@crabby/platform";
import { createBackup, openDatabase } from "@crabby/storage";
import type { Renderer } from "../output.ts";

export function runBackup(rest: string[], layout: DataLayout, renderer: Renderer): Promise<ExitCode> {
  if (rest.includes("--help")) {
    renderer.line("usage", "crabby backup [destination-dir] [--json]");
    renderer.line(
      "default",
      "a timestamped directory under <stateDir>/backups — the database, config.json, extensions/ and mcp/",
    );
    renderer.fix("restore is a manual step: docs/DATA_AND_MEMORY.md §8 has the steps — nothing restores itself");
    return Promise.resolve(EXIT.success);
  }

  const positional = rest.filter((arg) => !arg.startsWith("--"));
  if (positional.length > 1) {
    renderer.line("backup", "one destination directory at most");
    return Promise.resolve(EXIT.usage);
  }
  const destination = positional[0] === undefined ? undefined : path.resolve(positional[0]);
  mkdirSync(destination ?? path.join(layout.stateDir, "backups"), { recursive: true });

  const dbPath = path.join(layout.stateDir, "crabby.sqlite3");
  let handle: ReturnType<typeof openDatabase>;
  try {
    handle = openDatabase(dbPath);
  } catch (error) {
    renderer.line("backup", `the database could not be opened: ${error instanceof Error ? error.message : error}`);
    renderer.fix(`expected the database at ${dbPath} — \`crabby init\` creates it`);
    return Promise.resolve(EXIT.failure);
  }

  // The handle closes when the backup's promise settles, not when this function returns — `createBackup` awaits
  // the online copy, and a `finally` here would close the database out from under it.
  return createBackup({ db: handle.db, stateDir: layout.stateDir, destination })
    .catch((error: unknown): "the backup did not complete" => {
      renderer.line("backup", `the backup failed: ${error instanceof Error ? error.message : String(error)}`);
      return "the backup did not complete";
    })
    .then((outcome) => {
      handle.close();
      if (typeof outcome === "string") return EXIT.failure;
      if (!outcome.ok) {
        renderer.line("backup", outcome.reason);
        renderer.fix("the partial directory was removed — `backups/` only ever holds complete, verified copies");
        return EXIT.failure;
      }
      if (renderer.json) {
        return renderer.done({
          dir: outcome.dir,
          database: outcome.database,
          integrity: outcome.integrity,
          schemaVersion: outcome.schemaVersion,
          created: outcome.created,
          included: [...outcome.included],
          excluded: outcome.excluded.map((entry) => ({ ...entry })),
        });
      }
      renderer.line("backup", outcome.dir);
      for (const name of outcome.included) renderer.line(`  in (${name})`, "copied");
      for (const entry of outcome.excluded) renderer.line(`  out (${entry.name})`, entry.reason);
      renderer.line("integrity", `ok — schema version ${String(outcome.schemaVersion)}`);
      renderer.fix(
        "a backup is a moment in time: data deleted after it was taken comes back when it is restored (§8). " +
          "Restore by hand — docs/DATA_AND_MEMORY.md §8 — and nothing prunes this directory; the disk is yours",
      );
      return EXIT.success;
    });
}
