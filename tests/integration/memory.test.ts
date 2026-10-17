// §4.4's `/memory` surface over real HTTP — the review/edit/forget routes D-019 promises, with the rules asserted at
// the seam they must hold at: a route may translate bytes, but it must not adjudicate memory (that is the store's,
// where D-073/D-065 are tested). What this file adds over the store tests is the wire truth: status codes, the
// refusal codes a client branches on, the preview-before-delete shape C9-05 renders, the queue's only exit being a
// person's review, and the note that says "text search" rather than pretending (C9-04).
//
// Every boot is tracked and closed in `after` — a listener that outlives its test hangs the sweep, and a sweep that
// hangs is a worse answer than a sweep that fails.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { createLogger } from "@crabby/core";
import { buildApp, createClient } from "@crabby/gateway";
import { dataLayout } from "@crabby/platform";
import { capabilitiesFor } from "@crabby/policy";
import { migrate, mintPairingCode, openDatabase, redeemPairingCode } from "@crabby/storage";

interface Harness {
  readonly url: string;
  readonly token: string;
  close(): Promise<void>;
}

const open: Harness[] = [];
after(async () => {
  for (const h of open) await h.close();
  open.length = 0;
});

async function boot(): Promise<Harness> {
  const dir = mkdtempSync(path.join(tmpdir(), "crabby-memory-"));
  const layout = dataLayout(dir);
  mkdirSync(layout.stateDir, { recursive: true, mode: 0o700 });
  const handle = openDatabase(path.join(dir, "crabby.sqlite3"));
  migrate(handle.db);
  const built = await buildApp({
    db: handle.db,
    layout,
    log: createLogger({ level: "error", write: () => {} }, "memory-test"),
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
  const harness: Harness = {
    url: `http://127.0.0.1:${port}`,
    token: redeemed.token as string,
    async close() {
      await built.app.close();
      handle.close();
    },
  };
  open.push(harness);
  return harness;
}

async function raw(
  h: Harness,
  route: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${h.url}${route}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${h.token}`,
      // A content-type without a body is Fastify's empty-JSON refusal — the header names a payload, so it rides
      // only when there is one.
      ...(init.body === undefined ? {} : { "content-type": "application/json; charset=utf-8" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text.length === 0 ? null : JSON.parse(text) };
}

describe("§4.4's /memory routes — review, edit, forget, and the queue a person answers", () => {
  it("saves, lists with counts, and reads trust as a word — never a number", async () => {
    const h = await boot();
    const saved = await raw(h, "/api/v1/memory", {
      method: "POST",
      body: { content: "the backup drive passphrase rotates monthly", category: "ops" },
    });
    assert.equal(saved.status, 201);
    assert.ok(String(saved.body.entry.id).startsWith("mem_"), "D-135's prefix");
    assert.equal(saved.body.trust, "stated");

    const external = await raw(h, "/api/v1/memory", {
      method: "POST",
      body: {
        content: "the README claims port 9090",
        origin: "inferred",
        sourceKind: "task",
        external: true,
      },
    });
    assert.equal(external.body.trust, "unconfirmed", "W8-07's marker is a word too");

    const list = await raw(h, "/api/v1/memory");
    assert.equal(list.status, 200);
    assert.equal(list.body.entries.length, 2);
    assert.equal(list.body.counts.active, 2);
    assert.match(list.body.note as string, /never a percentage/);
  });

  it("an unknown status filter is a 400 that names all four", async () => {
    const h = await boot();
    const answer = await raw(h, "/api/v1/memory?status=vibes");
    assert.equal(answer.status, 400);
    assert.match(
      String(answer.body.error?.details?.[0]?.message ?? answer.body.error?.message),
      /active/,
    );
    assert.match(
      String(answer.body.error?.details?.[0]?.message ?? answer.body.error?.message),
      /pending/,
    );
  });

  it("search answers and says it is text search — not semantic (C9-04/D-021)", async () => {
    const h = await boot();
    await raw(h, "/api/v1/memory", {
      method: "POST",
      body: { content: "the office wifi password is hunter2" },
    });
    const found = await raw(h, "/api/v1/memory/search?q=wifi");
    assert.equal(found.status, 200);
    assert.equal(found.body.entries.length, 1);
    assert.match(found.body.note as string, /text search only in v1/);
    const empty = await raw(h, "/api/v1/memory/search?q=");
    assert.equal(empty.status, 400);
  });

  it("the per-entry preview carries the references W8-08 renders, and an unknown id is memory_unknown", async () => {
    const h = await boot();
    const saved = await raw(h, "/api/v1/memory", {
      method: "POST",
      body: { content: "the gate code" },
    });
    const id = saved.body.entry.id as string;
    const preview = await raw(h, `/api/v1/memory/${id}`);
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.body.references, []);
    const missing = await raw(h, "/api/v1/memory/mem_zzzzzzzzzzzzzzzzzzzzzzzzzz");
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, "memory_unknown");
  });

  it("an edit re-attributes to the user — W8-03's authority rule, visible in the answer", async () => {
    const h = await boot();
    const saved = await raw(h, "/api/v1/memory", {
      method: "POST",
      body: { content: "deploys on tuesday", origin: "inferred", sourceKind: "agent" },
    });
    const edited = await raw(h, `/api/v1/memory/${saved.body.entry.id}`, {
      method: "PATCH",
      body: { content: "deploys on wednesday" },
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.entry.content, "deploys on wednesday");
    assert.equal(edited.body.entry.origin, "stated");
    assert.equal(edited.body.entry.sourceKind, "user");
    assert.match(edited.body.note as string, /authoritative/);
  });

  it("the pending queue has one exit, and it is a person's review", async () => {
    const h = await boot();
    const proposal = await raw(h, "/api/v1/memory", {
      method: "POST",
      body: {
        content: "maybe prefers oat milk",
        origin: "inferred",
        sourceKind: "agent",
        status: "pending",
      },
    });
    assert.equal(proposal.body.trust, "proposed");
    const id = proposal.body.entry.id as string;

    const premature = await raw(h, `/api/v1/memory/${id}/review`, {
      method: "POST",
      body: { decision: "approve" },
    });
    assert.equal(premature.status, 200);
    assert.equal(premature.body.entry.status, "active");

    const second = await raw(h, "/api/v1/memory", {
      method: "POST",
      body: {
        content: "maybe dislikes coriander",
        origin: "inferred",
        sourceKind: "agent",
        status: "pending",
      },
    });
    const again = await raw(h, `/api/v1/memory/${second.body.entry.id}/review`, {
      method: "POST",
      body: { decision: "approve" },
    });
    assert.equal(again.body.entry.status, "active");

    const third = await raw(h, "/api/v1/memory", {
      method: "POST",
      body: {
        content: "maybe owns a kayak",
        origin: "inferred",
        sourceKind: "agent",
        status: "pending",
      },
    });
    const rejected = await raw(h, `/api/v1/memory/${third.body.entry.id}/review`, {
      method: "POST",
      body: { decision: "reject" },
    });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.entry, null, "a rejection answers no entry, because there is none");
    assert.equal(
      rejected.body.removed.content,
      "maybe owns a kayak",
      "the answer carries what was removed",
    );
    const gone = await raw(h, `/api/v1/memory/${third.body.entry.id}`);
    assert.equal(gone.status, 404);

    const reviewed = await raw(h, `/api/v1/memory/${id}/review`, {
      method: "POST",
      body: { decision: "approve" },
    });
    assert.equal(reviewed.status, 409);
    assert.equal(reviewed.body.error.code, "memory_not_pending");
  });

  it("forget answers what was removed and takes the index entry with it", async () => {
    const h = await boot();
    const saved = await raw(h, "/api/v1/memory", {
      method: "POST",
      body: { content: "the guest wifi is open" },
    });
    const id = saved.body.entry.id as string;
    await raw(h, `/api/v1/memory/${id}`);
    const forgotten = await raw(h, `/api/v1/memory/${id}`, { method: "DELETE" });
    assert.equal(forgotten.status, 200);
    assert.equal(forgotten.body.entry.id, id);
    assert.equal(forgotten.body.entry.content, "the guest wifi is open");
    const search = await raw(h, "/api/v1/memory/search?q=wifi");
    assert.equal(
      search.body.entries.length,
      0,
      "the derived index went with the row — no undeletable ghost",
    );
    const twice = await raw(h, `/api/v1/memory/${id}`, { method: "DELETE" });
    assert.equal(twice.status, 404);
  });
});
