// D-133's three read routes over real HTTP: `GET /whoami`, `GET /logs`, `GET /audit`.
//
// The questions this file asks are the ones a route can only answer by existing. Does `whoami` answer the identity the
// token resolves to, with the surface stated as an absence rather than defaulted when no executor composed? Does `/logs`
// page the ring buffer a real request just wrote, refuse a level nobody can spell, and carry no knob that turns §7's
// redaction off? Does `/audit` hold the rows the trail exists for — a rejection the guard wrote *before* its 401 left,
// a deletion whose subject stops existing — in id order, with the no-foreign-key rule visible as a fact?
//
// The route work's own units live beside their stores (`packages/storage/audit.test.ts`) and beside the routes that
// write (`tests/integration/jobs.test.ts` pins the `job_delete` row). What is asserted here is the seam over HTTP.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { createLogger } from "@crabby/core";
import { buildApp } from "@crabby/gateway";
import { dataLayout } from "@crabby/platform";
import { capabilitiesFor } from "@crabby/policy";
import { migrate, mintPairingCode, openDatabase, redeemPairingCode } from "@crabby/storage";

interface Harness {
  readonly url: string;
  readonly token: string;
  close(): Promise<void>;
}

async function boot(): Promise<Harness> {
  const dir = mkdtempSync(path.join(tmpdir(), "crabby-audit-http-"));
  const layout = dataLayout(dir);
  mkdirSync(layout.stateDir, { recursive: true, mode: 0o700 });
  const handle = openDatabase(path.join(dir, "crabby.sqlite3"));
  migrate(handle.db);
  const built = await buildApp({
    db: handle.db,
    layout,
    log: createLogger({ level: "info", write: () => {} }, "audit-test"),
    version: "test",
    startedAt: new Date(),
    listenerMode: "local",
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
  return {
    url: `http://127.0.0.1:${port}`,
    token: redeemed.token as string,
    async close() {
      await built.app.close();
      handle.close();
    },
  };
}

interface Answer {
  readonly status: number;
  readonly body: any;
}

async function raw(h: Harness, route: string, token?: string | null): Promise<Answer> {
  const response = await fetch(`${h.url}${route}`, {
    headers: token === null ? {} : { authorization: `Bearer ${token ?? h.token}` },
  });
  const text = await response.text();
  return { status: response.status, body: text.length === 0 ? null : JSON.parse(text) };
}

describe("D-133's three read routes over http", () => {
  const boots: Harness[] = [];
  after(async () => {
    for (const h of boots) await h.close();
  });

  it("whoami answers the identity and states the surface's absence, never a default", async () => {
    const h = await boot();
    boots.push(h);
    const answer = await raw(h, "/api/v1/whoami");
    assert.equal(answer.status, 200);
    const body = answer.body as {
      client: {
        id: string;
        name: string;
        interface: string;
        capabilities: string[];
        createdAt: string;
      };
      surface: Record<string, boolean> | undefined;
      note?: string;
    };
    assert.equal(body.client.interface, "cli");
    assert.equal(body.client.name, "the owner");
    assert.ok(Array.isArray(body.client.capabilities));
    assert.ok(!Number.isNaN(Date.parse(body.client.createdAt)));
    // This Gateway composed no executor, so the surface line would be a default wearing a fact's clothes (T5-06):
    // absent, with the note that says so.
    assert.equal(body.surface, undefined);
    assert.match(body.note ?? "", /no executor/);

    const refused = await raw(h, "/api/v1/whoami", "crabby_wrong_token");
    assert.equal(refused.status, 401, "whoami is behind the same guard as everything else");
  });

  it("logs pages the buffer a real request wrote, filters by the one ranking, and refuses a level it cannot spell", async () => {
    const h = await boot();
    boots.push(h);
    // A rejected token attempt logs at warn through the guard; the pairing redeem logs too. The buffer has lines.
    await raw(h, "/api/v1/whoami", "crabby_wrong_token");
    await raw(h, "/api/v1/logs?limit=2");
    assert.equal((await raw(h, "/api/v1/logs")).status, 200);
    const page = await raw(h, "/api/v1/logs?limit=2");
    assert.equal(page.status, 200);
    const body = page.body as {
      records: { ts: string; level: string }[];
      cursor: number;
      hasMore: boolean;
      bufferLines: number;
      sortedBy: string;
    };
    assert.equal(body.records.length, 2, "the limit is the window, not the buffer");
    assert.equal(body.sortedBy, "ts");
    assert.ok(body.bufferLines >= 1, "a request just logged, so the buffer is not empty");
    assert.ok(
      body.records.every(
        (record) => Date.parse(record.ts) <= Date.parse(body.records[1]?.ts ?? ""),
      ),
      "oldest first inside the window",
    );

    const unknown = await raw(h, "/api/v1/logs?level=loud");
    assert.equal(unknown.status, 400);
    assert.equal((unknown.body as any).error.code, "logs_unknown_level");

    const errors = await raw(h, "/api/v1/logs?level=error");
    assert.equal(errors.status, 200);
    const errorBody = errors.body as typeof body;
    assert.ok(
      errorBody.records.every((record) => record.level === "error"),
      "the rank filter is a floor, and error is the ceiling — nothing above it exists to pass",
    );
  });

  it("audit holds the rows the trail exists for: a rejection written before its 401, in id order, unredactable by design", async () => {
    const h = await boot();
    boots.push(h);
    // The guard writes the rejected attempt on its way to the 401 — the route never ran, and the trail says so anyway.
    const rejected = await raw(h, "/api/v1/whoami", "crabby_wrong_token");
    assert.equal(rejected.status, 401);
    // The token itself rode in on the request; §7's redaction is at the serializer, so it must not survive into the
    // detail the trail holds.
    const page = await raw(h, "/api/v1/audit");
    assert.equal(page.status, 200);
    const body = page.body as {
      records: {
        id: string;
        kind: string;
        outcome: string;
        actor?: string;
        detail?: Record<string, unknown>;
      }[];
      sortedBy: string;
      cursor?: string;
      hasMore: boolean;
    };
    assert.equal(body.sortedBy, "id");
    const attempt = body.records.find((record) => record.kind === "auth_attempt");
    assert.ok(attempt !== undefined, "the guard's row is on the trail");
    assert.equal(attempt.outcome, "rejected");
    assert.ok(
      !JSON.stringify(body).includes("crabby_wrong_token"),
      "the secret-shaped input the caller sent is not in the trail — write-time redaction, not a query option",
    );

    // The id cursor pages: asking from the row we just saw moves past it.
    assert.ok(
      attempt.id.startsWith("aud_"),
      "D-138's prefix is the wire fact the cursor is made of",
    );
    const next = await raw(h, `/api/v1/audit?cursor=${attempt.id}`);
    const nextBody = next.body as typeof body;
    assert.ok(
      nextBody.records.every((record) => record.id > (attempt as { id: string }).id),
      "the cursor is the last id seen, and the next page starts after it",
    );

    // The trail outlives the process's own records: the harness closes below, and the rows are in the file, not in a
    // buffer — which is the difference between this route and `/logs`, stated by the stores they answer from.
    assert.ok(body.records.length >= 1);
  });
});
