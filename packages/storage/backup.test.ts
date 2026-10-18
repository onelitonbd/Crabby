// `createBackup`'s promises are all about what the filesystem actually gets: an online copy that passes
// `integrity_check` on its own, secrets that are named as absent rather than silently missing, and a manifest a
// restoring human can read. §8's bullets are the assertions.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createBackup, DB_FILE_NAME, listBackups, openDatabase } from "./index.ts";
import { migrate } from "./migrate.ts";

function seededState(): { stateDir: string; close(): void; version: number } {
  const stateDir = mkdtempSync(path.join(tmpdir(), "crabby-backup-"));
  const handle = openDatabase(path.join(stateDir, DB_FILE_NAME));
  const { version } = migrate(handle.db);
  // The state dir a real install has: config, the extension repo with its reports, the MCP list, and the files
  // a backup must refuse to carry.
  writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({ provider: {} }), "utf8");
  mkdirSync(path.join(stateDir, "extensions", "weekly-report", "reports"), { recursive: true });
  writeFileSync(
    path.join(stateDir, "extensions", "weekly-report", "SKILL.md"),
    "name: weekly-report\n",
    "utf8",
  );
  writeFileSync(
    path.join(stateDir, "extensions", "weekly-report", "reports", "report-1.json"),
    "{}\n",
    "utf8",
  );
  mkdirSync(path.join(stateDir, "mcp"), { recursive: true });
  writeFileSync(
    path.join(stateDir, "mcp", "servers.json"),
    JSON.stringify({ servers: [] }),
    "utf8",
  );
  mkdirSync(path.join(stateDir, "vault"), { recursive: true });
  writeFileSync(path.join(stateDir, "vault", "secrets.vault"), "not-for-backups", "utf8");
  writeFileSync(path.join(stateDir, "client.json"), "token material", "utf8");
  writeFileSync(path.join(stateDir, "telegram.json"), "bearer material", "utf8");
  writeFileSync(path.join(stateDir, "gateway.json"), "{}", "utf8");
  mkdirSync(path.join(stateDir, "scratch", "task-1"), { recursive: true });
  writeFileSync(path.join(stateDir, "scratch", "task-1", "overflow.json"), "{}", "utf8");
  return { stateDir, close: handle.close, version };
}

describe("the backup (D-065, DATA_AND_MEMORY §8)", () => {
  it("makes a verified copy: opens it, passes integrity_check, matches the live schema version", async () => {
    const state = seededState();
    try {
      const result = await createBackup({ db: liveDb(state), stateDir: state.stateDir });
      assert.ok(result.ok, result.ok ? "" : result.reason);
      if (!result.ok) return;
      assert.equal(result.integrity, "ok");
      assert.equal(result.schemaVersion, state.version);
      const copy = openDatabase(result.database, { readonly: true });
      try {
        const row = copy.db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
        assert.equal(row.integrity_check, "ok");
        const counted = copy.db.prepare("SELECT COUNT(*) AS n FROM schema_migration").get() as {
          n: number;
        };
        assert.equal(counted.n, state.version, "the copy carries the whole migration ledger");
      } finally {
        copy.close();
      }
      assert.ok(
        existsSync(path.join(result.dir, "manifest.json")),
        "the manifest is part of the answer",
      );
      const manifest = JSON.parse(readFileSync(path.join(result.dir, "manifest.json"), "utf8")) as {
        included: string[];
        excluded: { name: string }[];
      };
      assert.ok(manifest.included.includes(DB_FILE_NAME));
      assert.ok(manifest.included.includes("config.json"));
      assert.ok(manifest.excluded.some((entry) => entry.name === "vault/"));
    } finally {
      state.close();
    }
  });

  it("excludes secrets and credentials by default, and names every exclusion with its reason (§8)", async () => {
    const state = seededState();
    try {
      const result = await createBackup({ db: liveDb(state), stateDir: state.stateDir });
      assert.ok(result.ok);
      if (!result.ok) return;
      assert.ok(
        !existsSync(path.join(result.dir, "vault")),
        "the vault file never rides in a backup",
      );
      assert.ok(
        !existsSync(path.join(result.dir, "client.json")),
        "the client's bearer token stays out",
      );
      assert.ok(
        !existsSync(path.join(result.dir, "telegram.json")),
        "the bot's bearer tokens stay out",
      );
      assert.ok(
        !existsSync(path.join(result.dir, "scratch")),
        "scratch is rebuildable, not backed up",
      );
      const named = result.excluded.map((entry) => entry.name);
      for (const must of [
        "vault/",
        "client.json",
        "telegram.json",
        "gateway.json / last-exit.json",
        "scratch/",
        "backups/",
      ]) {
        assert.ok(named.includes(must), `the exclusion ${must} is named, not silent`);
      }
      for (const entry of result.excluded) {
        assert.ok(
          entry.reason.length > 20,
          `the reason for ${entry.name} is a sentence, not a word`,
        );
      }
    } finally {
      state.close();
    }
  });

  it("carries the extension repo and the MCP list, because a database without its packs is half a machine", async () => {
    const state = seededState();
    try {
      const result = await createBackup({ db: liveDb(state), stateDir: state.stateDir });
      assert.ok(result.ok);
      if (!result.ok) return;
      const skill = path.join(result.dir, "extensions", "weekly-report", "SKILL.md");
      const report = path.join(
        result.dir,
        "extensions",
        "weekly-report",
        "reports",
        "report-1.json",
      );
      assert.ok(existsSync(skill), "the pack rides along");
      assert.ok(existsSync(report), "D-039's per-version reports ride with it");
      assert.ok(
        existsSync(path.join(result.dir, "mcp", "servers.json")),
        "the MCP server list rides with it",
      );
    } finally {
      state.close();
    }
  });

  it("never backs up into itself, and two backups never share a name", async () => {
    const state = seededState();
    try {
      const root = path.join(state.stateDir, "backups");
      const first = await createBackup({ db: liveDb(state), stateDir: state.stateDir });
      assert.ok(first.ok);
      if (!first.ok) return;
      const second = await createBackup({ db: liveDb(state), stateDir: state.stateDir });
      assert.ok(second.ok);
      if (!second.ok) return;
      assert.notEqual(first.dir, second.dir, "each backup is its own timestamped directory");
      const listed = listBackups(root);
      assert.equal(listed.length, 2);
      assert.deepEqual(listed, [...listed].sort(), "the list is oldest first");
      assert.ok(!existsSync(path.join(first.dir, "backups")), "no recursion");
    } finally {
      state.close();
    }
  });
});

/** The live handle, re-opened: `createBackup` takes the db as an argument and the seeded-state helper closed over
 *  the handle it migrated, so tests hand in a fresh connection to the same file — which is also the shape a
 *  Gateway-parallel backup has. */
function liveDb(state: { stateDir: string }) {
  return openDatabase(path.join(state.stateDir, DB_FILE_NAME)).db;
}
