// §3.7's vault routes over real HTTP, with the file store on a small scrypt: the lifecycle a phone actually
// runs — a Gateway that starts locked (D-031 forbids blocking startup on a passphrase), a status row that says
// so on every surface that reads /health and /status, an unlock that re-composes the provider list in place
// (D-139's hot half) and says what still needs a restart, a wrong passphrase that is a rejection on the trail
// without the credential in it, and a lock that puts the wall back.
//
// The CLI's half of the verbs is `tests/unit/vault-cli.test.ts`; the store's own rules live beside the package.
// What is asserted here is the seam: one vault, several faces, the passphrase written nowhere.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { createLogger } from "@crabby/core";
import { buildApp } from "@crabby/gateway";
import { dataLayout } from "@crabby/platform";
import { capabilitiesFor } from "@crabby/policy";
import { composeProviders } from "@crabby/providers";
import {
  listAudit,
  migrate,
  mintPairingCode,
  openDatabase,
  redeemPairingCode,
} from "@crabby/storage";
import { openVault } from "@crabby/vault";

/** A scrypt the suite can afford; the shipped default stays D-066's and is asserted in the package's own tests. */
const TEST_KDF = { N: 2 ** 10, r: 8, p: 1 } as const;

interface Harness {
  readonly url: string;
  readonly token: string;
  readonly vaultDir: string;
  readonly db: import("@crabby/storage").SqliteDb;
  close(): Promise<void>;
}

const boots: Harness[] = [];
after(async () => {
  for (const h of boots) await h.close();
});

async function boot(): Promise<Harness> {
  const dir = mkdtempSync(path.join(tmpdir(), "crabby-vault-http-"));
  const layout = dataLayout(dir);
  mkdirSync(layout.stateDir, { recursive: true, mode: 0o700 });
  const handle = openDatabase(path.join(dir, "crabby.sqlite3"));
  migrate(handle.db);
  const providers = [
    ...composeProviders(
      {
        groq: {
          baseUrl: "https://api.groq.com/openai/v1",
          key: "vault://groq",
          models: { "llama-3.3-70b": {} },
        },
      },
      undefined,
      undefined,
    ),
  ];
  const built = await buildApp({
    db: handle.db,
    layout,
    log: createLogger({ level: "error", write: () => {} }, "vault-test"),
    version: "test",
    startedAt: new Date(),
    listenerMode: "local",
    providers,
    vault: openVault({
      vaultDir: layout.vaultDir,
      platform: "linux",
      store: "file",
      kdf: TEST_KDF,
    }),
    recomposeProviders: () => {
      const fresh = composeProviders(
        {
          groq: {
            baseUrl: "https://api.groq.com/openai/v1",
            key: "vault://groq",
            models: { "llama-3.3-70b": {} },
          },
        },
        undefined,
        undefined,
      );
      providers.splice(0, providers.length, ...fresh);
      return {
        composed: fresh.filter((entry) => entry.ok).length,
        refused: fresh.flatMap((entry) =>
          entry.ok ? [] : [{ id: entry.id, reason: entry.reason }],
        ),
      };
    },
  });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const address = built.app.server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const minted = mintPairingCode(handle.db, {
    name: "the owner",
    interface: "cli",
    capabilities: capabilitiesFor("cli"),
  });
  const redeemed = redeemPairingCode(handle.db, minted.code);
  assert.ok(redeemed.ok && redeemed.token, "the harness's identity has to pair");
  boots.push({
    url: `http://127.0.0.1:${port}`,
    token: redeemed.token as string,
    vaultDir: layout.vaultDir,
    db: handle.db,
    async close() {
      await built.app.close();
      handle.close();
    },
  });
  return boots[boots.length - 1] as Harness;
}

function client(h: Harness) {
  return {
    get: (route: string) =>
      fetch(`${h.url}${route}`, { headers: { authorization: `Bearer ${h.token}` } }),
    post: (route: string, body?: unknown) =>
      fetch(`${h.url}${route}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${h.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json; charset=utf-8" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
  };
}

describe("§3.7's vault routes — the lifecycle a phone runs", () => {
  it("a Gateway starts locked without blocking, says so everywhere, and refuses a wrong passphrase without recording it", async () => {
    const h = await boot();
    const c = client(h);

    const health = (await (await c.get("/api/v1/health")).json()) as {
      vault: { managed: boolean; kind: string; state: string; note?: string };
    };
    assert.deepEqual(
      health.vault,
      { managed: true, kind: "file", state: "unset", note: health.vault.note },
      "unset is the state before the first set, and the note carries the §7 disclosure",
    );
    assert.match(health.vault.note as string, /casual disclosure/);

    const status = (await (await c.get("/api/v1/status")).json()) as {
      ready: boolean;
      subsystems: Record<string, { state: string; reason?: string }>;
    };
    assert.equal(status.subsystems.vault?.state, "unset");
    assert.equal(
      status.ready,
      false,
      "a Gateway with a locked-away provider pool is not ready, and says why",
    );
    assert.match(status.subsystems.providers?.reason ?? "", /vault/);

    const wrong = await c.post("/api/v1/vault/unlock", { passphrase: "not the one" });
    assert.equal(
      wrong.status,
      409,
      "a vault that does not exist is a conflict with the act, not a typo",
    );
    const wrongBody = (await wrong.json()) as { error: { code: string; message: string } };
    assert.equal(wrongBody.error.code, "vault_unset");
    assert.match(wrongBody.error.message, /no vault exists/);
    const trail = listAudit(h.db, { limit: 10 });
    const rejection = trail.rows.find((row) => row.kind === "vault" && row.outcome === "rejected");
    assert.ok(rejection !== undefined, "the attempt is on the trail (§14)");
    assert.doesNotMatch(
      JSON.stringify(rejection.detail),
      /not the one/,
      "the credential itself is nowhere in the record",
    );
  });

  it("the store is filled out of band, unlock re-composes, and the answer names the runner limit", async () => {
    const h = await boot();
    const c = client(h);
    // Out of band: the CLI writes the store in its own process — the Gateway learns it only through unlock.
    const cliVault = openVault({
      vaultDir: h.vaultDir,
      platform: "linux",
      store: "file",
      kdf: TEST_KDF,
    });
    assert.ok(cliVault.set("groq", "gsk_integration_secret", "the passphrase").ok);

    const unlocked = await c.post("/api/v1/vault/unlock", { passphrase: "the passphrase" });
    assert.equal(unlocked.status, 200);
    const body = (await unlocked.json()) as {
      state: string;
      providers: { composed: number; refused: { id: string; reason: string }[] };
      note?: string;
    };
    assert.equal(body.state, "unlocked");
    // The harness's recompose closure carries no resolver — the composition state this test can honestly assert
    // is that the answer names the runner limit and the lock transition worked, not that a fake key appeared.
    assert.match(
      body.note ?? "",
      /runner/,
      "the answer states the one honest limit: composition is hot, the runner is not",
    );

    const status = (await (await c.get("/api/v1/vault")).json()) as {
      state: string;
      names?: string[];
    };
    assert.equal(status.state, "unlocked");
    assert.deepEqual(status.names, ["groq"], "names are the whole listing a status carries");

    // Lock puts the wall back, and the trail holds both transitions (§14).
    const locked = await c.post("/api/v1/vault/lock");
    assert.equal(locked.status, 200);
    assert.equal(((await locked.json()) as { state: string }).state, "locked");
    const trail = listAudit(h.db, { limit: 20 });
    const transitions = trail.rows.filter((row) => row.kind === "vault" && row.outcome === "ok");
    assert.deepEqual(
      transitions.map((row) => (row.detail as { action: string }).action).sort(),
      ["lock", "unlock"],
      "the trail holds the unlock and the lock, with no credential beside them",
    );
  });

  it("the routes answer the token like every other read, and the passphrase never reaches a log", async () => {
    const lines: string[] = [];
    const dir = mkdtempSync(path.join(tmpdir(), "crabby-vault-log-"));
    const layout = dataLayout(dir);
    mkdirSync(layout.stateDir, { recursive: true, mode: 0o700 });
    const handle = openDatabase(path.join(dir, "crabby.sqlite3"));
    migrate(handle.db);
    const built = await buildApp({
      db: handle.db,
      layout,
      log: createLogger({ level: "debug", write: (line) => lines.push(line) }, "vault-log-test"),
      version: "test",
      startedAt: new Date(),
      listenerMode: "local",
      vault: openVault({
        vaultDir: layout.vaultDir,
        platform: "linux",
        store: "file",
        kdf: TEST_KDF,
      }),
    });
    await built.app.listen({ host: "127.0.0.1", port: 0 });
    const address = built.app.server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const unauth = await fetch(`http://127.0.0.1:${port}/api/v1/vault`);
    assert.equal(unauth.status, 401, "the vault status answers the token, like every other read");
    const unauthUnlock = await fetch(`http://127.0.0.1:${port}/api/v1/vault/unlock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: "the passphrase" }),
    });
    assert.equal(unauthUnlock.status, 401);
    await built.app.close();
    handle.close();
    assert.ok(
      !lines.some((line) => line.includes("the passphrase")),
      "§7: a body that reached a log already escaped the boundary that was supposed to stop it",
    );
  });
});
