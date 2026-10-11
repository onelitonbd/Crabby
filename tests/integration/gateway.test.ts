// M1b's contract tests: the Gateway over real HTTP, on a port the OS chose, driven by the client module the four
// interfaces will share — not a mocked transport. Two rows of `docs/ROADMAP.md` §3's M1 exit list are asserted here:
// "a curl request creates a task, lists it, and receives events" and "the same `Idempotency-Key` replayed returns the
// recorded result". The second `describe` is the P-003 row: one *spawned* CLI process against a *spawned* Gateway,
// because an in-process app cannot prove that `gateway.json`, the drain, and the exit code work from outside.
import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  ClientRecord,
  type ErrorClass,
  ErrorEnvelope,
  type Event,
  newId,
  TaskRecord,
  validate,
} from "@crabby/api-contracts";
import { createLogger } from "@crabby/core";
import {
  buildApp,
  createClient,
  gatewayInfoPath,
  readGatewayInfo,
  STATUS_BY_CLASS,
} from "@crabby/gateway";
import { dataLayout } from "@crabby/platform";
import { CAPABILITY_NAMES, PENDING_RECORD_FIELDS, TIERS, TOOL_REGISTRY } from "@crabby/policy";
import {
  appendEvent,
  DB_FILE_NAME,
  getTask,
  migrate,
  mintPairingCode,
  openDatabase,
  readEvents,
  redeemPairingCode,
  type SqliteDb,
} from "@crabby/storage";

const REPO = path.resolve(new URL("../../", import.meta.url).pathname);

interface Harness {
  readonly url: string;
  readonly token: string;
  readonly client: ReturnType<typeof createClient>;
  readonly db: SqliteDb;
  readonly dir: string;
  readonly log: ReturnType<typeof createLogger>;
  close(): Promise<void>;
}

function boot(options: { platformFacts?: { isTermux: boolean } } = {}): Promise<Harness> {
  return bootWith(options);
}

async function bootWith(options: { platformFacts?: { isTermux: boolean } }): Promise<Harness> {
  const dir = mkdtempSync(path.join(tmpdir(), "crabby-gateway-"));
  const layout = dataLayout(dir);
  const handle = openDatabase(path.join(dir, DB_FILE_NAME));
  migrate(handle.db);
  const log = createLogger({ level: "debug", write: () => {} }, "gateway-test");
  const built = await buildApp({
    db: handle.db,
    layout,
    log,
    version: "test",
    startedAt: new Date(),
    listenerMode: "local",
    ...(options.platformFacts ? { platformFacts: options.platformFacts } : {}),
  });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const address = built.app.server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const url = `http://127.0.0.1:${port}`;
  // One identity, paired through storage rather than over HTTP, so a test about routes is not a test about waiting
  // for a code. The pairing exchange has its own tests below, which is where it belongs.
  const minted = mintPairingCode(handle.db, { name: "contract test", interface: "cli" });
  const redeemed = redeemPairingCode(handle.db, minted.code);
  assert.ok(
    redeemed.ok && redeemed.token,
    "the harness's own pairing has to work before it can test anything",
  );
  return {
    url,
    token: redeemed.token as string,
    db: handle.db,
    dir,
    log,
    client: createClient({ url, token: redeemed.token as string }),
    async close() {
      await built.app.close();
      handle.close();
    },
  };
}

describe("gateway over http", () => {
  let h: Harness;
  before(async () => {
    h = await boot();
  });
  after(async () => {
    await h.close();
  });

  it("refuses every route without a token, health included (SECURITY.md §13)", async () => {
    const bare = createClient({ url: h.url });
    for (const route of [
      "/api/v1/health",
      "/api/v1/status",
      "/api/v1/diagnostics",
      "/api/v1/tasks",
      // §4.4 documents `GET /tools` as "registry with tier, capability, and platform availability", and a route that
      // answered without a token would leak which tools a device has to an unauthenticated probe.
      "/api/v1/tools",
      // The approval queue is the most interesting thing on this list: an unauthenticated `GET /approvals` is a map of
      // what the user has been asked to authorize, and an unauthenticated `POST …/decision` is a grant.
      "/api/v1/approvals",
      "/api/v1/approvals/apr_none/decision",
    ]) {
      await assert.rejects(
        async () => await bare.request(route),
        (error: unknown) => {
          const failure = error as {
            status: number;
            envelope: { error: { class: string; code: string } };
          };
          assert.equal(failure.status, 401, `${route} must answer 401`);
          assert.equal(failure.envelope.error.class, "auth");
          assert.equal(failure.envelope.error.code, "auth_missing");
          return true;
        },
      );
    }
  });

  it("answers a paired client with the fields §4.1 lists for /health", async () => {
    const body = (await h.client.health()).body as {
      status: string;
      version: string;
      uptimeMs: number;
      listener: { mode: string };
      vault: { managed: boolean };
      storage: { schemaVersion: number };
    };
    assert.equal(body.status, "ok");
    assert.equal(body.version, "test");
    assert.ok(body.uptimeMs >= 0);
    assert.equal(body.listener.mode, "local");
    assert.equal(
      body.vault.managed,
      false,
      "no vault code exists yet, so health must not imply one",
    );
    // Literal on purpose, and it is the second place the number is written: `docs/DATA_AND_MEMORY.md` §2's
    // `crabby.sqlite3` row says the same thing. A migration therefore cannot land quietly — it moves the ledger here and
    // in the document, or one of the two goes red, which is the only mechanism that keeps "what schema is this file
    // on?" answerable by someone holding a phone and a backup.
    assert.equal(
      body.storage.schemaVersion,
      4,
      "M2's `approval` table advanced the ledger from 1 to 2, §6.2's cancellation column (D-091) from 2 to 3, and " +
        "D-065's checkpoint table (D-095) from 3 to 4 — and this literal is why a migration cannot land quietly",
    );
  });

  it("reports readiness over exactly §4.1's five subsystems", async () => {
    const body = (await h.client.status()).body as {
      ready: boolean;
      subsystems: Record<string, { state: string; reason?: string }>;
    };
    assert.deepEqual(Object.keys(body.subsystems).sort(), [
      "extensions",
      "providers",
      "scheduler",
      "storage",
      "tunnel",
    ]);
    assert.equal(body.subsystems.storage?.state, "ready");
    assert.equal(
      body.ready,
      false,
      "four of the five do not exist yet, and saying so is the point of a readiness route",
    );
    for (const [name, row] of Object.entries(body.subsystems)) {
      if (row.state === "absent")
        assert.ok(row.reason, `${name} must name the milestone that brings it`);
    }
    assert.equal(
      body.subsystems.providers?.state,
      "contract-only",
      "M1c landed the §3.1 contract, the fake adapter, and the §7 suite; the adapters are still M2's",
    );
  });

  it("creates a task and answers with the record the contract describes", async () => {
    const response = await h.client.createTask(
      { objective: "list the files in ~/notes" },
      "contract-1",
    );
    assert.equal(response.status, 201);
    const checked = validate(TaskRecord, response.body);
    assert.ok(
      checked.ok,
      `the response must be a TaskRecord: ${JSON.stringify(checked.ok ? {} : checked.problems)}`,
    );
    if (!checked.ok) return;
    assert.equal(checked.value.state, "queued");
    assert.equal(checked.value.lastSeq, 1, "one event exists, so lastSeq must say so");
    assert.equal(getTask(h.db, checked.value.id)?.objective, "list the files in ~/notes");
  });

  it("replays the same key with the recorded answer instead of a second task", async () => {
    const first = await h.client.createTask({ objective: "only once" }, "contract-2");
    const again = await h.client.createTask({ objective: "only once" }, "contract-2");
    assert.deepEqual(
      again.body,
      first.body,
      "a replay returns the recorded result, never a new one",
    );
    const items = ((await h.client.listTasks()).body as { items: { objective: string }[] }).items;
    assert.equal(items.filter((t) => t.objective === "only once").length, 1);
  });

  it("rejects a key reused with a different body, and a missing key, with distinct codes", async () => {
    await h.client.createTask({ objective: "keep this key" }, "contract-3");
    await assert.rejects(
      async () => await h.client.createTask({ objective: "different body" }, "contract-3"),
      (error: unknown) => {
        const failure = error as {
          status: number;
          envelope: { error: { code: string; class: string } };
        };
        assert.equal(failure.status, 409);
        assert.equal(failure.envelope.error.class, "conflict");
        assert.equal(failure.envelope.error.code, "idempotency_conflict");
        return true;
      },
    );
    const missing = await fetch(`${h.url}/api/v1/tasks`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${h.client.url === "" ? "" : h.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ objective: "no key at all" }),
    });
    assert.equal(missing.status, 400);
    const body = (await missing.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "idempotency_key_required");
    assert.match(
      body.error.message,
      /Idempotency-Key/,
      "the fix has to be readable from the message alone",
    );
  });

  it("names an unknown field rather than ignoring it", async () => {
    const response = await fetch(`${h.url}/api/v1/tasks`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${h.token}`,
        "content-type": "application/json",
        "idempotency-key": "contract-4",
      },
      body: JSON.stringify({ objective: "with extras", provider: "gpt" }),
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as {
      error: { message: string; details?: { problems: { path: string }[] } };
    };
    assert.match(body.error.message, /provider/, "the message has to name the offending field");
    assert.ok(body.error.details?.problems.some((p) => p.path === "/provider"));
  });

  it("maps every §6 error class to the status D-077 chose, as data", () => {
    assert.deepEqual(STATUS_BY_CLASS, {
      validation: 400,
      auth: 401,
      policy: 403,
      "not-found": 404,
      conflict: 409,
      "rate-limit": 429,
      provider: 502,
      "resource-limit": 507,
      "platform-unsupported": 501,
      internal: 500,
    } satisfies Record<ErrorClass, number>);
  });

  it("answers an unknown path with one envelope and no census of the known ones", async () => {
    const response = await fetch(`${h.url}/api/v1/definitely-not-here`, {
      headers: { authorization: `Bearer ${h.token}` },
    });
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.ok(validate(ErrorEnvelope, body).ok, "a 404 is still an error envelope");
    assert.ok(
      !JSON.stringify(body).includes("/api/v1/tasks"),
      "an unknown path may not enumerate the routes that do exist",
    );
  });

  it("serves a task's events by polling, in seq order, after a cursor", async () => {
    const created = await h.client.createTask({ objective: "event order" }, "contract-5");
    const id = (created.body as { id: string }).id;
    const page = (await h.client.taskEvents(id)).body as { items: Event[]; replayWindow: number };
    assert.deepEqual(
      page.items.map((e) => e.seq),
      [1],
    );
    assert.equal(page.items[0]?.type, "task.created");
    assert.equal(page.replayWindow, 200);
    const tail = (await h.client.taskEvents(id, 1)).body as { items: unknown[] };
    assert.deepEqual(tail.items, [], "a cursor at the tail is empty, not an error");
  });

  it("lists with a state filter, and refuses a page above D-074's ceiling", async () => {
    const page = (await h.client.listTasks({ state: "queued", limit: 2 })).body as {
      items: unknown[];
      nextCursor?: string;
    };
    assert.ok(page.items.length <= 2);
    const over = await fetch(`${h.url}/api/v1/tasks?limit=5000`, {
      headers: { authorization: `Bearer ${h.token}` },
    });
    assert.equal(over.status, 400, "the ceiling is a validation error, not a silent clamp");
    const junk = await fetch(`${h.url}/api/v1/tasks?state=snoozing`, {
      headers: { authorization: `Bearer ${h.token}` },
    });
    assert.equal(junk.status, 400);
    const unknownQuery = await fetch(`${h.url}/api/v1/tasks?page=2`, {
      headers: { authorization: `Bearer ${h.token}` },
    });
    assert.equal(
      unknownQuery.status,
      400,
      "§2: unknown fields are rejected in a query as loudly as in a body",
    );
  });

  it("streams task.created to a live tail, with §5.1's headers", async () => {
    const response = await fetch(`${h.url}/api/v1/events`, {
      headers: { authorization: `Bearer ${h.token}`, accept: "text/event-stream" },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
    assert.equal(
      response.headers.get("x-accel-buffering"),
      "no",
      "§5.1: an SSE response must disable proxy buffering",
    );
    const reader = response.body?.getReader();
    assert.ok(reader);
    const created = await h.client.createTask({ objective: "streamed" }, "contract-6");
    const taskId = (created.body as { id: string }).id;
    const text = await readFrame(reader);
    await reader.cancel().catch(() => undefined);
    const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
    assert.ok(dataLine, `expected a data frame, got ${JSON.stringify(text)}`);
    const event = JSON.parse(dataLine.slice(6)) as Event;
    assert.equal(event.type, "task.created");
    assert.equal(event.taskId, taskId);
    assert.ok(
      text.startsWith(`id: ${event.id}\nevent: task.created`),
      "the frame carries its id, which is what Last-Event-ID sends back",
    );
    assert.equal(event.payload.state, "queued");
  });

  it("answers a reconnect outside the window with §5.4's gap marker", async () => {
    const created = await h.client.createTask({ objective: "gap" }, "contract-7");
    const taskId = (created.body as { id: string }).id;
    const response = await fetch(`${h.url}/api/v1/events?taskId=${taskId}`, {
      headers: {
        authorization: `Bearer ${h.token}`,
        "last-event-id": `evt_${newId("evt").slice(4)}`,
      },
    });
    const reader = response.body?.getReader();
    assert.ok(reader);
    const text = await readFrame(reader);
    await reader.cancel().catch(() => undefined);
    assert.match(text, /^event: gap\n/);
    const payload = JSON.parse((text.split("data: ")[1] as string).trim()) as {
      gap: boolean;
      stateAt: string;
    };
    assert.equal(payload.gap, true);
    assert.equal(payload.stateAt, taskId, "§5.4: stateAt names the task to reconcile from");
  });

  it("replays what a reconnecting client missed and nothing it already had", async () => {
    const created = await h.client.createTask({ objective: "replay" }, "contract-8");
    const taskId = (created.body as { id: string }).id;
    const first = readEvents(h.db, taskId)[0] as Event;
    const response = await fetch(`${h.url}/api/v1/events?taskId=${taskId}`, {
      headers: { authorization: `Bearer ${h.token}`, "last-event-id": first.id },
    });
    const reader = response.body?.getReader();
    assert.ok(reader);
    const empty = await readFrame(reader, 800);
    assert.equal(
      empty.trim().length,
      0,
      "the client has the only event, so an empty tail is the honest answer",
    );
    await reader.cancel().catch(() => undefined);

    // Now the case §5.4 is about: something happened while the client was away, so the reconnect must be handed it.
    appendEvent(h.db, { event: { ...first, id: newId("evt"), type: "task.progress", seq: 0 } });
    const after = await fetch(`${h.url}/api/v1/events?taskId=${taskId}`, {
      headers: { authorization: `Bearer ${h.token}`, "last-event-id": first.id },
    });
    const replayedReader = after.body?.getReader();
    assert.ok(replayedReader);
    const replayed = await readFrame(replayedReader);
    await replayedReader.cancel().catch(() => undefined);
    assert.match(replayed, /^event: task\.created\n|^event: task\.progress\n/m);
    assert.ok(
      replayed.includes("task.progress"),
      "the missed event, in order, before the live tail resumes",
    );
    assert.ok(!replayed.includes(first.id), "what the client already had is not sent again");
  });

  it("pairs over HTTP, and never lists a token it handed out once", async () => {
    const minted = await h.client.request<{ code: string; expiresAt: string; clientId: string }>(
      "/api/v1/auth/pair-codes",
      {
        method: "POST",
        body: { name: "phone", interface: "telegram" },
      },
    );
    assert.match(minted.body.code, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/);
    const redeemed = await h.client.request<{ clientId: string; token: string }>(
      "/api/v1/auth/pair",
      {
        method: "POST",
        body: { code: minted.body.code },
      },
    );
    assert.equal(redeemed.body.clientId, minted.body.clientId);
    const phone = createClient({ url: h.url, token: redeemed.body.token });
    const clients = (await phone.authList()).body as { items: Record<string, unknown>[] };
    for (const item of clients.items)
      assert.ok(validate(ClientRecord, item).ok, "a client record is a contract type");
    assert.ok(
      !JSON.stringify(clients).includes(redeemed.body.token),
      "a token is shown once and never listed again",
    );
    await assert.rejects(
      async () =>
        await h.client.request("/api/v1/auth/pair", {
          method: "POST",
          body: { code: minted.body.code },
        }),
      (error: unknown) => {
        assert.equal(
          (error as { status: number }).status,
          401,
          "a second redemption is an auth failure, not a conflict",
        );
        assert.match(
          (error as { message: string }).message,
          /crabby auth pair/,
          "§3.2: the text names the next action",
        );
        return true;
      },
    );
  });

  it("tells a client the difference between a mistyped code and a mis-shaped one", async () => {
    const bare = createClient({ url: h.url });
    await assert.rejects(
      async () =>
        await bare.request("/api/v1/auth/pair", { method: "POST", body: { code: "AAAAAAAA" } }),
      (error: unknown) => {
        assert.equal(
          (error as { status: number }).status,
          401,
          "§6 maps the auth class to 401 whatever the reason",
        );
        assert.match((error as { message: string }).message, /crabby auth pair/);
        return true;
      },
    );
    const lowercase = await fetch(`${h.url}/api/v1/auth/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "abcd2345" }),
    });
    assert.equal(
      lowercase.status,
      400,
      "a lowercase code is a shape error; a wrong code is a failed pairing — they need different fixes",
    );
  });

  it("revokes an identity so the next request fails, which is §3.1's whole promise", async () => {
    const minted = await h.client.request<{ code: string; clientId: string }>(
      "/api/v1/auth/pair-codes",
      {
        method: "POST",
        body: { name: "throwaway", interface: "web" },
      },
    );
    const own = await h.client.request<{ token: string }>("/api/v1/auth/pair", {
      method: "POST",
      body: { code: minted.body.code },
    });
    const throwaway = createClient({ url: h.url, token: own.body.token });
    assert.equal((await throwaway.health()).status, 200, "it worked a moment ago");
    assert.equal((await h.client.authRevoke(minted.body.clientId)).status, 204);
    await assert.rejects(
      async () => await throwaway.health(),
      (error: unknown) => {
        assert.equal((error as { status: number }).status, 401);
        assert.equal(
          (error as { envelope: { error: { code: string } } }).envelope.error.code,
          "auth_invalid",
        );
        return true;
      },
    );
    await assert.rejects(
      async () => await h.client.authRevoke("nosuchclient"),
      (error: unknown) => {
        assert.equal((error as { status: number }).status, 404);
        return true;
      },
    );
  });

  it("keeps an over-cap payload out of the event row, and out of the log", async () => {
    const huge = "y".repeat(70 * 1024);
    const created = await h.client.createTask({ objective: huge }, "contract-9");
    const id = (created.body as { id: string }).id;
    const event = readEvents(h.db, id)[0] as Event;
    assert.equal(event.payload.truncated, true);
    const reference = String(event.payload.reference);
    assert.ok(
      reference.startsWith(path.join(h.dir, "scratch", id)),
      "overflow belongs to the task's scratch dir",
    );
    assert.equal(
      JSON.parse(readFileSync(reference, "utf8")).objective,
      huge,
      "the bytes are moved, not dropped",
    );
    const diagnostics = JSON.stringify((await h.client.diagnostics()).body);
    assert.ok(
      !diagnostics.includes(huge.slice(0, 200)),
      "a paste-safe document must not carry the payload",
    );
    assert.ok(
      !JSON.stringify(h.log.records()).includes(huge.slice(0, 200)),
      "SECURITY.md §7: no secret in the log either",
    );
  });

  it("touches nothing in the state dir that it did not name", () => {
    assert.deepEqual(
      readdirSync(h.dir).sort(),
      ["crabby.sqlite3", "crabby.sqlite3-shm", "crabby.sqlite3-wal", "scratch"],
      "D-078's four names are the whole footprint — a fifth file is a decision, not a side effect",
    );
  });
});

describe("the tool registry over http (§4.4's GET /tools row)", () => {
  interface ToolsBody {
    items: {
      id: string;
      qualifier?: string;
      source: string;
      capabilities: string[];
      riskTier: string;
      tierText: string;
      enabled: boolean;
      enabledReason?: string;
      availability: { available: boolean; requires: string; reason?: string };
      deferred?: boolean;
      deferralReason?: string;
      pendingRecordFields: string[];
    }[];
    count: number;
    tiers: string[];
    capabilities: { name: string; grants: string }[];
    registry: { source: string; rows: number; digest: string };
  }

  // A harness per platform, because `platformFacts` is a build-time input to the route and mutating `process.env`
  // between two requests would test the test rather than the route.
  async function fetchTools(platformFacts: { isTermux: boolean }): Promise<ToolsBody> {
    const harness = await boot({ platformFacts });
    try {
      return (await harness.client.tools()).body as ToolsBody;
    } finally {
      await harness.close();
    }
  }

  it("answers with exactly the rows §4.2 defines, at the tiers §4.2 assigns", async () => {
    const body = await fetchTools({ isTermux: false });
    assert.equal(
      body.count,
      body.items.length,
      "a count that disagrees with the page is a paging bug waiting to hide",
    );
    assert.equal(body.registry.rows, TOOL_REGISTRY.length);
    assert.deepEqual(body.tiers, [...TIERS]);
    // The registry *is* the answer: an HTTP copy that disagreed with the in-process table would mean the four
    // interfaces in M3 each render their own idea of a tool's tier.
    const expected = new Map(
      TOOL_REGISTRY.map((spec) => [`${spec.tool}#${spec.qualifier ?? ""}`, spec]),
    );
    assert.equal(body.items.length, expected.size, "the route added or dropped a row");
    for (const item of body.items) {
      const spec = expected.get(`${item.id}#${item.qualifier ?? ""}`);
      assert.ok(spec, `${item.id} came from nowhere`);
      assert.equal(
        item.riskTier,
        spec?.tier,
        `${item.id}'s tier moved between the table and the wire`,
      );
      assert.deepEqual(
        item.capabilities,
        [...(spec?.capabilities ?? [])],
        `${item.id}'s capabilities moved`,
      );
      assert.equal(
        item.tierText,
        spec?.tierText ?? spec?.tier,
        `${item.id} lost the wording its tier cell had`,
      );
    }
    assert.deepEqual(
      body.capabilities.map((row) => row.name),
      [...CAPABILITY_NAMES],
      "the vocabulary the route publishes must be the vocabulary policy enforces",
    );
  });

  it("reports platform availability as a reason rather than a broken row (C10-04)", async () => {
    const desktop = await fetchTools({ isTermux: false });
    const phone = await fetchTools({ isTermux: true });
    const desktopTermux = desktop.items.filter((item) => item.availability.requires === "termux");
    assert.ok(
      desktopTermux.length >= 4,
      "the termux-api rows have to exist before their absence means anything",
    );
    for (const item of desktopTermux) {
      assert.equal(item.availability.available, false, `${item.id} cannot run off Termux`);
      assert.ok(
        (item.availability.reason ?? "").length > 20,
        `${item.id} was reported unavailable with no reason, and §4.1 requires one`,
      );
    }
    for (const item of phone.items.filter((row) => row.availability.requires === "termux")) {
      assert.equal(item.availability.available, true, `${item.id} is available under Termux`);
      assert.equal(
        item.availability.reason,
        undefined,
        "an available tool must not carry an excuse",
      );
    }
    // Availability is the only difference the platform may make: the tiers stay identical, or a device could talk its
    // way into a cheaper approval by claiming to be a desktop.
    assert.deepEqual(
      desktop.items.map((item) => `${item.id}:${item.riskTier}`),
      phone.items.map((item) => `${item.id}:${item.riskTier}`),
      "a platform may change availability, never a tier",
    );
  });

  it("says which §4.1 fields the runtime has to fill in, and which tools are deferred", async () => {
    const body = await fetchTools({ isTermux: false });
    for (const item of body.items) {
      assert.deepEqual(
        [...item.pendingRecordFields],
        [...PENDING_RECORD_FIELDS],
        "every row is missing the same runtime fields, and saying so is the point",
      );
      if (item.enabled) continue;
      assert.ok(
        (item.enabledReason ?? "").length > 20,
        `${item.id} is disabled with no explanation`,
      );
    }
    const shell = body.items.find(
      (item) => item.id === "shell.run" && item.qualifier === undefined,
    );
    assert.equal(shell?.enabled, false, "§4.2: the shell.run capability is off by default");
    assert.match(shell?.enabledReason ?? "", /off by default/);
    const blocked = body.items.filter((item) => item.deferred);
    assert.ok(
      blocked.length >= 1,
      "a first-release block has to show up as deferred, not as silence",
    );
    for (const item of blocked) assert.match(item.deferralReason ?? "", /first release|blocked/i);
  });

  it("carries a digest two devices can compare without diffing 45 lines", async () => {
    const first = await fetchTools({ isTermux: false });
    const second = await fetchTools({ isTermux: false });
    assert.equal(
      first.registry.digest,
      second.registry.digest,
      "the same build must print the same digest twice",
    );
    assert.match(first.registry.digest, /^[0-9a-f]{12}$/);
    const phone = await fetchTools({ isTermux: true });
    assert.notEqual(
      first.registry.digest,
      phone.registry.digest,
      "the digest covers availability, so a desktop and a phone must not look identical",
    );
  });
});

describe("a spawned gateway and a spawned cli (P-003)", () => {
  let dir: string;
  let child: ChildProcess | undefined;
  let output = "";

  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), "crabby-cli-"));
    writeFileSync(path.join(dir, "config.json"), "{}\n");
  });

  after(() => {
    child?.kill("SIGTERM");
  });

  it("starts on an OS-chosen port, publishes it, pairs a CLI to it, and leaves nothing behind on SIGTERM", async () => {
    child = spawn(
      process.execPath,
      [path.join(REPO, "apps/cli/crabby.ts"), "--data-dir", dir, "gateway", "start"],
      {
        cwd: REPO,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));

    const info = await waitForGatewayInfo(dir, 25_000);
    assert.equal(
      info.host,
      "127.0.0.1",
      "the default bind is loopback, and this is the test that proves it",
    );
    assert.ok(info.port > 0, "port 0 means the OS chose one; a zero here would mean nothing bound");
    assert.equal(info.pid, child.pid, "the file names the process that is actually serving");
    const code = output
      .split("\n")
      .find((line) => /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/.test(line.trim()));
    assert.ok(
      code,
      `a fresh state dir must print a pairing code on its own line; output was:\n${output}`,
    );

    const paired = runCli(dir, ["auth", "pair", "--code", code.trim()]);
    assert.equal(paired.code, 0, paired.stdout);
    assert.match(paired.stdout, /^paired +\S+/m);
    assert.equal(
      readGatewayInfo(dataLayout(dir)).state,
      "live",
      "the same file both processes use agrees",
    );

    const listed = runCli(dir, ["task", "ls"]);
    assert.equal(listed.code, 0, listed.stdout);
    assert.match(listed.stdout, /tasks +none/, "an empty list says none rather than failing");

    const created = await fetch(`http://127.0.0.1:${info.port}/api/v1/tasks`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokenFromCli(dir)}`,
        "content-type": "application/json",
        "idempotency-key": "spawned-1",
      },
      body: JSON.stringify({ objective: "from a spawned client" }),
    });
    assert.equal(created.status, 201, await created.text());

    const shown = runCli(dir, ["task", "ls"]);
    assert.match(
      shown.stdout,
      /queued +from a spawned client/,
      "a write over HTTP must be readable through the CLI",
    );

    const status = runCli(dir, ["status"]);
    assert.equal(status.code, 0, status.stdout);
    assert.match(status.stdout, new RegExp(`http://127\\.0\\.0\\.1:${info.port}`));
    assert.match(status.stdout, /tasks +queued 1/);

    // C10-04's row, end to end: a spawned CLI asking a spawned Gateway for the registry. `tools ls --json` is the
    // machine form of the same answer the Web's tools pane will render in M3, and this is the test that says the two
    // cannot drift — there is one route behind both.
    const tools = runCli(dir, ["tools", "ls", "--json"]);
    assert.equal(tools.code, 0, tools.stdout);
    const page = JSON.parse(tools.stdout) as {
      ok: boolean;
      items: { id: string; riskTier: string; availability: { available: boolean } }[];
      registry: { digest: string; rows: number };
      fixes?: string[];
    };
    assert.equal(page.ok, true);
    assert.ok(page.items.length >= 40, `the CLI printed ${page.items.length} tools`);
    assert.ok(page.items.some((row) => row.id === "shell.run" && row.riskTier === "T2"));
    assert.ok(
      page.items.every((row) => row.availability.available || row.id.startsWith("termux-")),
      "only the Termux:API rows may be unavailable on this host",
    );
    assert.match(page.registry.digest, /^[0-9a-f]{12}$/);
    assert.ok(
      (page.fixes ?? []).some((line) => /sideEffects/.test(line)),
      "the pending §4.1 fields have to be named in the document, not only in the terminal",
    );
    const humanTools = runCli(dir, ["tools", "ls"]);
    assert.equal(humanTools.code, 0, humanTools.stdout);
    assert.match(humanTools.stdout, /^shell\.run\s+T2/m, "one line per tool, tier first");
    assert.equal(
      runCli(dir, ["tools"]).code,
      2,
      "a noun with one documented verb answers 'which verb?' with the usage exit",
    );

    child.kill("SIGTERM");
    await waitGone(child, 12_000);
    assert.match(output, /stopped cleanly/);
    assert.equal(
      readGatewayInfo(dataLayout(dir)).state,
      "absent",
      "a clean stop leaves no file claiming a listener exists",
    );
    // The record names the mechanism (`signal`) *and* that every step finished (`drained`), which is the pair
    // D-066 and `DEVELOPMENT.md` §10 ask `doctor` to distinguish: a kill that got to say goodbye versus one that did
    // not. Both facts in one file, so a phone that was frozen mid-task reads differently from a Ctrl-C.
    const lastExit = JSON.parse(readFileSync(path.join(dir, "last-exit.json"), "utf8")) as {
      kind: string;
      signal?: string;
      drained?: boolean;
    };
    assert.equal(lastExit.kind, "signal");
    assert.equal(lastExit.signal, "SIGTERM");
    assert.equal(lastExit.drained, true, "no drain step may have failed or timed out");
  });
});

// Node's global fetch keeps a connection alive for 72 s (Fastify's default `keepAliveTimeout`), which is right for a
// phone and wrong for a test process that has finished asserting: the sockets hold the event loop open and the file
// "times out" long after its last assertion passed. Closing the dispatcher at the very end of the file is how the
// test says "I am done with those sockets" — and it must be the *end*, because a closed dispatcher rejects the next
// request, which is the other describe's business.
after(async () => {
  const dispatcher = (globalThis as Record<symbol, unknown>)[
    Symbol.for("undici.globalDispatcher.1")
  ] as { close?: () => Promise<void> } | undefined;
  await dispatcher?.close?.();
});

function tokenFromCli(dir: string): string {
  return JSON.parse(readFileSync(path.join(dir, "client.json"), "utf8")).token as string;
}

/** Read one SSE frame, ignoring heartbeat comments, and never wait longer than `ms`. The race with a timer is what
 *  makes an *idle* stream testable: `reader.read()` on a stream that has nothing to say stays pending until the next
 *  byte, so a plain deadline check between reads would sit there until the 15 s heartbeat answered for it. */
async function readFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ms = 4_000,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const timeout = new Promise<{ done: true }>((resolve) =>
      setTimeout(() => resolve({ done: true }), Math.max(1, deadline - Date.now())),
    );
    const chunk = await Promise.race([reader.read(), timeout]);
    if (chunk.done) break;
    text += decoder.decode((chunk as { value: Uint8Array }).value, { stream: true });
    const frames = text.split("\n\n");
    text = frames.pop() ?? "";
    const real = frames.filter(
      (frame) => frame.trim().length > 0 && !frame.trimStart().startsWith(":"),
    );
    if (real.length > 0) return real.join("\n\n");
  }
  return text.trim().length > 0 && !text.trimStart().startsWith(":") ? text : "";
}

async function waitForGatewayInfo(dir: string, timeoutMs: number) {
  const layout = dataLayout(dir);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const file = gatewayInfoPath(layout);
    if (existsSync(file)) {
      try {
        return JSON.parse(readFileSync(file, "utf8")) as {
          host: string;
          port: number;
          pid: number;
        };
      } catch {
        /* the writer is mid-write; the next poll sees a whole file */
      }
    }
    await wait(50);
  }
  throw new Error(`no gateway.json appeared in ${dir} within ${timeoutMs} ms`);
}

function runCli(dir: string, args: readonly string[]): { stdout: string; code: number | null } {
  const result = spawnSync(
    process.execPath,
    [path.join(REPO, "apps/cli/crabby.ts"), "--data-dir", dir, ...args],
    {
      cwd: REPO,
      encoding: "utf8",
    },
  );
  return { stdout: `${result.stdout ?? ""}${result.stderr ?? ""}`, code: result.status };
}

async function waitGone(child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (child.exitCode === null && Date.now() < deadline) await wait(50);
  assert.notEqual(child.exitCode, null, "SIGTERM did not end the process within its drain budget");
  assert.equal(
    child.exitCode,
    0,
    "a drained shutdown exits 0 — it stopped the way it was asked to",
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
