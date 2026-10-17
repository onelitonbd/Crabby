// §13's routes over real HTTP, with an injected host — the seam the suite tests is the route's rules, not
// Cloudflare's: the T3 confirm flag in the body, the reachable-identity list in the answer (the sentence §13
// requires the enabling surface to say), the audit rows and the live mode flip on /health, the stop that
// clears the state, and the 404 that answers "off" instead of pretending a tunnel exists. The child-process
// machinery the default host drives is `tests/unit/tunnel.test.ts`'s subject, against a fake binary.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { createLogger } from "@crabby/core";
import { buildApp, type TunnelHost, type TunnelSnapshot } from "@crabby/gateway";
import { dataLayout } from "@crabby/platform";
import { capabilitiesFor } from "@crabby/policy";
import {
  listAudit,
  migrate,
  mintPairingCode,
  openDatabase,
  redeemPairingCode,
} from "@crabby/storage";

function fakeHost(): { host: TunnelHost } {
  let snapshot: TunnelSnapshot = { state: "off", command: "fake-cloudflared" };
  return {
    host: {
      async start(target: string) {
        snapshot = {
          state: "ready",
          url: "https://fake-id.trycloudflare.com",
          startedAt: new Date().toISOString(),
          command: "fake-cloudflared",
        };
        assert.match(
          target,
          /^http:\/\/127\.0\.0\.1:\d+$/,
          "the target is the Gateway's own loopback listener",
        );
        return { ok: true as const, url: snapshot.url ?? "" };
      },
      async stop() {
        snapshot = { state: "off", command: "fake-cloudflared" };
      },
      snapshot: () => snapshot,
    },
  };
}

interface Harness {
  readonly url: string;
  readonly token: string;
  readonly db: import("@crabby/storage").SqliteDb;
  close(): Promise<void>;
}

const boots: Harness[] = [];
after(async () => {
  for (const h of boots) await h.close();
});

async function boot(host: TunnelHost): Promise<Harness> {
  const dir = mkdtempSync(path.join(tmpdir(), "crabby-tunnel-http-"));
  const layout = dataLayout(dir);
  mkdirSync(layout.stateDir, { recursive: true, mode: 0o700 });
  const handle = openDatabase(path.join(dir, "crabby.sqlite3"));
  migrate(handle.db);
  const built = await buildApp({
    db: handle.db,
    layout,
    log: createLogger({ level: "error", write: () => {} }, "tunnel-test"),
    version: "test",
    startedAt: new Date(),
    listenerMode: "local",
    tunnel: host,
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
  assert.ok(redeemed.ok && redeemed.token);
  const h: Harness = {
    url: `http://127.0.0.1:${port}`,
    token: redeemed.token as string,
    db: handle.db,
    async close() {
      await built.app.close();
      handle.close();
    },
  };
  boots.push(h);
  return h;
}

function client(h: Harness) {
  return async (route: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${h.url}${route}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${h.token}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json; charset=utf-8" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
}

describe("§13's tunnel routes — reachability is one confirmed decision at a time", () => {
  it("enable is the confirmed act: the answer carries the URL and the reachable identities, the mode flips, the trail records it", async () => {
    const fake = fakeHost();
    const h = await boot(fake.host);
    const call = client(h);

    const unconfirmed = await call("/api/v1/tunnel", { method: "POST", body: {} });
    assert.equal(
      unconfirmed.status,
      400,
      "the confirm flag is the body's whole point — its absence is a refusal",
    );

    const opened = await call("/api/v1/tunnel", { method: "POST", body: { confirm: true } });
    assert.equal(opened.status, 201);
    const body = (await opened.json()) as {
      url: string;
      reachable: { name: string; interface: string }[];
    };
    assert.match(body.url, /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/);
    assert.ok(
      body.reachable.some((identity) => identity.name === "the owner"),
      "the answer lists the paired identities that just became remotely reachable (§13)",
    );

    const health = (await (await call("/api/v1/health")).json()) as { listener: { mode: string } };
    assert.equal(health.listener.mode, "tunnel", "the live mode, not the startup fact");

    const status = (await (await call("/api/v1/status")).json()) as {
      subsystems: { tunnel: { state: string; url?: string } };
    };
    assert.equal(status.subsystems.tunnel.state, "ready");
    assert.equal(status.subsystems.tunnel.url, body.url);

    const trail = listAuditRows(h);
    const row = trail.find(
      (candidate) => candidate.kind === "tunnel" && candidate.outcome === "ok",
    );
    assert.ok(row !== undefined, "§14: the tunnel's start is on the trail");
  });

  it("a second enable while one is ready is refused, and stop clears everything and says the truth after", async () => {
    const fake = fakeHost();
    const h = await boot(fake.host);
    const call = client(h);

    await call("/api/v1/tunnel", { method: "POST", body: { confirm: true } });
    const again = await call("/api/v1/tunnel", { method: "POST", body: { confirm: true } });
    assert.equal(
      again.status,
      409,
      "two tunnels is two exposures from one confirmation — the route refuses",
    );

    const stopped = await call("/api/v1/tunnel", { method: "DELETE" });
    assert.equal(stopped.status, 200);
    const health = (await (await call("/api/v1/health")).json()) as { listener: { mode: string } };
    assert.equal(health.listener.mode, "local", "the mode returns with the tunnel gone");

    const gone = await call("/api/v1/tunnel", { method: "DELETE" });
    assert.equal(
      gone.status,
      404,
      "a second stop has nothing to stop, and says so rather than nodding",
    );

    const trail = listAuditRows(h);
    const stopRow = trail.find(
      (candidate) =>
        candidate.kind === "tunnel" && (candidate.detail as { action?: string })?.action === "stop",
    );
    assert.ok(
      stopRow !== undefined,
      "the stop is on the trail beside the start (§14: tunnel start/stop)",
    );
  });
});

function listAuditRows(h: Harness): { kind: string; outcome: string; detail: unknown }[] {
  return listAudit(h.db, { limit: 50 }).rows.map((row) => ({
    kind: row.kind,
    outcome: row.outcome,
    detail: row.detail,
  }));
}
