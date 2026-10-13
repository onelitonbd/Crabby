// M1b's contract tests: the Gateway over real HTTP, on a port the OS chose, driven by the client module the four
// interfaces will share — not a mocked transport. Two rows of `docs/ROADMAP.md` §3's M1 exit list are asserted here:
// "a curl request creates a task, lists it, and receives events" and "the same `Idempotency-Key` replayed returns the
// recorded result". The second `describe` is the P-003 row: one *spawned* CLI process against a *spawned* Gateway,
// because an in-process app cannot prove that `gateway.json`, the drain, and the exit code work from outside.
import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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
  type ToolDeclaration,
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
import { composeProviders, type ProviderComposition } from "@crabby/providers";
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
  setState,
} from "@crabby/storage";
import { createFileTools, defaultRealpathOf } from "@crabby/tools";

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

interface BootOptions {
  readonly platformFacts?: { isTermux: boolean };
  /** What `crabby gateway start` composes from `config.json`'s `provider.*` entries and hands in (§3.3's "or
   *  configuration"). A test that composed none is the honest default, and the reason `GET /status` reports `absent`. */
  readonly providers?: readonly ProviderComposition[];
  /** What `crabby gateway start` composes from `config.json`'s `workspace.roots` and hands in, so `GET /api/v1/tools` can
   *  merge §4.1's runtime fields instead of printing them as pending (F-55). A test that composes none is the honest
   *  default and is also the assertion that matters: with nothing composed, every row must still name all five. */
  readonly declares?: (tool: string) => ToolDeclaration | undefined;
}

function boot(options: BootOptions = {}): Promise<Harness> {
  return bootWith(options);
}

async function bootWith(options: BootOptions): Promise<Harness> {
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
    ...(options.providers ? { providers: options.providers } : {}),
    ...(options.declares ? { declares: options.declares } : {}),
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
      6,
      "M2's `approval` table advanced the ledger from 1 to 2, §6.2's cancellation column (D-091) from 2 to 3, D-065's " +
        "checkpoint table (D-095) from 3 to 4, §4.5's `job` and `job_run` tables (D-046, D-057) from 4 to 5, and the " +
        "`session` record §2.1's conversations need (D-104) from 5 to 6 — and this literal is why a migration cannot " +
        "land quietly",
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
      "four of the five are absent in *this composition* — the scheduler because there is no runner for a fired job to " +
        "reach, the providers because nothing is configured, extensions and tunnel because no slice has built them — and " +
        "saying which is the point of a readiness route",
    );
    // The scheduler row is answered from the composition rather than from a milestone, and that is a change worth pinning:
    // it used to say the subsystem arrives with M2's runtime, a sentence that outlived its subject when §4.5 was built.
    // What this Gateway lacks is not the scheduler but the half a fired job needs, so the reason names that half.
    assert.equal(body.subsystems.scheduler?.state, "absent");
    assert.match(
      body.subsystems.scheduler?.reason ?? "",
      /composed no runner/,
      "an absent scheduler names the missing party rather than the milestone that will build it, because the subsystem exists",
    );
    assert.match(
      body.subsystems.scheduler?.reason ?? "",
      /no timer is armed/,
      "and says what the absence costs, so a reader knows a job would be recorded and never fired",
    );
    for (const [name, row] of Object.entries(body.subsystems)) {
      if (row.state === "absent")
        assert.ok(row.reason, `${name} must name the milestone that brings it`);
    }
    assert.equal(
      body.subsystems.providers?.state,
      "absent",
      "the harness composes no provider, so the row reports an install that has not configured one — not `contract-only`, " +
        "which stopped being true when M2l landed an adapter and M2m gave it §3.3's configuration path",
    );
    assert.match(
      body.subsystems.providers?.reason ?? "",
      /config set provider/,
      "an absent provider row has to name the command that ends the absence",
    );
  });

  it("reports a provider the composition root handed it, and says plainly that this Gateway drives no task with it", async () => {
    const composed = composeProviders({
      local: {
        baseUrl: "http://127.0.0.1:8080/v1",
        models: {
          "qwen2.5:3b": {
            contextWindow: 4096,
            maxOutputTokens: 512,
            supports: {
              streaming: true,
              toolCalling: true,
              parallelToolCalls: false,
              systemRole: true,
              structuredOutput: false,
              imageInput: false,
              audioInput: false,
              reasoning: false,
              promptCaching: false,
              jsonSchemaValidation: false,
            },
            cancellation: "best-effort",
            rateLimits: null,
            cost: "local",
            batching: null,
          },
        },
      },
      keyed: {
        baseUrl: "https://api.groq.com/openai/v1",
        key: "vault://groq",
        models: { "llama-3.3-70b": {} },
      },
    });
    const local = await boot({ providers: composed });
    try {
      const body = (await local.client.status()).body as {
        subsystems: Record<
          string,
          { state: string; entries?: { id: string }[]; refused?: { id: string }[]; note?: string }
        >;
      };
      const providers = body.subsystems.providers;
      assert.equal(providers?.state, "ready", JSON.stringify(providers));
      assert.deepEqual(
        providers?.entries?.map((entry) => entry.id),
        ["local"],
      );
      // A refusal is reported beside the entries rather than dropped: §4.1's row exists so a client can tell a
      // subsystem that is missing from one that is misconfigured, and F-56's reason is the difference between "you
      // have not configured a provider" and "the one you configured needs a vault this build does not have".
      assert.deepEqual(
        providers?.refused?.map((entry) => entry.id),
        ["keyed"],
      );
      assert.match(
        providers?.note ?? "",
        /this Gateway composed none/,
        "`ready` for the provider subsystem must not read as `a task will run`. This harness hands `buildApp` a composed " +
          "provider and no drive, which is the state an install reaches by configuring a model and no workspace root, and " +
          "the note has to say that plainly rather than leave a client to infer it from `ready`. The driven case is " +
          "asserted in `tests/integration/tasks.test.ts`, where a runner exists and the note says something else again",
      );
    } finally {
      await local.close();
    }
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

  // The title used to end "which is §3.1's whole promise" while covering one of its two halves — the next request.
  // §3.1 says revocation takes effect on the next request *and* terminates live event streams, and F-51 is the record
  // of how a test name can be the only thing that reads as coverage.
  it("revokes an identity so the next request fails, which is §3.1's first half", async () => {
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
    const revocation = await h.client.authRevoke(minted.body.clientId);
    // 200 with `{revoked, streamsEnded}` rather than the 204 this route used to send: C8-10 in `docs/review/CLI.md` asks
    // the CLI to print how many streams a revocation ended, and a count that exists only in a server log is a count no
    // operator sees (D-096). This identity never opened a stream, so the honest number is zero.
    assert.equal(revocation.status, 200);
    assert.deepEqual(revocation.body, { revoked: minted.body.clientId, streamsEnded: 0 });
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

  it("ends a revoked identity's live stream with a frame that says why, which is §3.1's other half", async () => {
    const minted = await h.client.request<{ code: string; clientId: string }>(
      "/api/v1/auth/pair-codes",
      {
        method: "POST",
        body: { name: "phone tail", interface: "telegram" },
      },
    );
    const own = await h.client.request<{ token: string }>("/api/v1/auth/pair", {
      method: "POST",
      body: { code: minted.body.code },
    });
    const revokedStream = await fetch(`${h.url}/api/v1/events`, {
      headers: { authorization: `Bearer ${own.body.token}`, accept: "text/event-stream" },
    });
    assert.equal(revokedStream.status, 200, "the stream opens while the identity still exists");
    const survivorStream = await fetch(`${h.url}/api/v1/events`, {
      headers: { authorization: `Bearer ${h.token}`, accept: "text/event-stream" },
    });
    const reader = revokedStream.body?.getReader();
    const survivor = survivorStream.body?.getReader();
    assert.ok(reader && survivor);

    // The same binding, read *before* the act: §3.1's "whether it is currently connected" and `docs/review/TUI.md`
    // T14-03's "prints how many streams it will kill first" are both answered from the registry the revocation closes
    // through, which is the reason the count lives on the bus and not in a second book of who is watching (D-096).
    const listed = (await h.client.authList()).body as {
      items: { id: string; liveStreams: number }[];
    };
    assert.equal(
      listed.items.find((row) => row.id === minted.body.clientId)?.liveStreams,
      1,
      "the identity about to be revoked has exactly one live stream, and the count is on the record before it is acted on",
    );
    assert.equal(
      listed.items.filter((row) => row.liveStreams > 0).length,
      2,
      "exactly two identities hold a stream — this one and the harness's — because revoking a client must not read as " +
        "disconnecting the others, and an earlier test's dead identity is not in the list at all",
    );

    const revocation = await h.client.authRevoke(minted.body.clientId);
    assert.equal(
      revocation.status,
      200,
      "the count is the point of the response, so it cannot be a 204",
    );
    assert.deepEqual(revocation.body, {
      revoked: minted.body.clientId,
      streamsEnded: 1,
    });

    const text = await readFrame(reader);
    assert.match(
      text,
      /^event: end\n/,
      "the close is *named*: a client that only reads `data:` still learns this was decided rather than dropped",
    );
    assert.ok(
      !text.startsWith("id:"),
      "and it is not an event — a control frame with an id would be a cursor into a stream that has just told the client " +
        "to stop coming back",
    );
    const payload = JSON.parse((text.split("data: ")[1] as string).trim()) as {
      end: boolean;
      reason: string;
      at: string;
    };
    assert.deepEqual(
      { end: payload.end, reason: payload.reason },
      { end: true, reason: "revoked" },
      "§3.1's termination has to be legible without prose, because the reason a client reconnects after a silence is the " +
        "same reason it must not reconnect after this",
    );
    const gone = await reader.read();
    assert.equal(
      gone.done,
      true,
      "the socket ends after the frame, so a stream cannot be kept alive by a client that ignores what it was told",
    );

    // The other identity keeps its stream and keeps receiving, which is the "affects that client only" half.
    await h.client.createTask({ objective: "after the revocation" }, "contract-10");
    const next = await readFrame(survivor);
    assert.match(next, /^id: evt_\S+\nevent: task\.created\n/);
    assert.equal(
      (next.split("data: ")[1] as string).includes("after the revocation"),
      true,
      "one revocation closes one identity's streams and disturbs nothing else on the bus",
    );
    await survivor.cancel().catch(() => undefined);

    // And the two halves meet where they have to: the frame says do not reconnect, and the next request agrees.
    await assert.rejects(
      async () => await createClient({ url: h.url, token: own.body.token }).health(),
      (error: unknown) => (error as { status: number }).status === 401,
      "a revoked token is refused on the next request too, so the frame is a courtesy and not the control",
    );
  });

  // F-52's first two questions, answered over the wire rather than in a paragraph: the baseline an identity arrives
  // holding, and what a restriction may do to it. `capability_json` had a writer in `mintPairingCode` and no caller from
  // M1b until now, so every identity held an empty set — which is why no route could make `auth.manage` the check
  // SECURITY.md §6.1 writes it as, and why a run started from `POST /tasks` would have been refused every tool it
  // proposed.
  it("gives a minted identity the baseline its interface holds, and §9's shell is not in it", async () => {
    const minted = await h.client.request<{ clientId: string; capabilities: readonly string[] }>(
      "/api/v1/auth/pair-codes",
      { method: "POST", body: { name: "capability baseline", interface: "cli" } },
    );
    const held = minted.body.capabilities;
    assert.ok(
      held.length > 0,
      "an identity that holds nothing could never drive a task, which is precisely the state F-52 described",
    );
    assert.ok(
      held.includes("task.create"),
      "§6.1's vocabulary is the baseline, narrowed only by the two sentences that withhold something",
    );
    assert.ok(
      held.includes("auth.manage"),
      "§6.1 makes it local-only by construction, and a CLI pairing against the loopback listener is local",
    );
    assert.ok(
      !held.includes("shell.run") && !held.includes("shell.privileged"),
      "§9: shell execution is never enabled by default for a fresh install, and enabling it is an explicit act",
    );
    const remote = await h.client.request<{ capabilities: readonly string[] }>(
      "/api/v1/auth/pair-codes",
      { method: "POST", body: { name: "capability remote", interface: "telegram" } },
    );
    assert.ok(
      !remote.body.capabilities.includes("auth.manage"),
      "§6.1: no remote or agent-facing path may grant `auth.manage`, and in v1 a bot's requests are the ones that do " +
        "not originate on the Gateway's own host",
    );
    for (const capability of remote.body.capabilities) {
      assert.ok(
        held.includes(capability),
        `§5.3: a remote client never receives a wider permission set than a local one — ${capability}`,
      );
    }
  });

  it("narrows on a restriction, reads a dot-less token as the family it names, and refuses one that would widen", async () => {
    const narrowed = await h.client.request<{ capabilities: readonly string[] }>(
      "/api/v1/auth/pair-codes",
      {
        method: "POST",
        body: { name: "narrow", interface: "cli", restrict: ["task.read", "session.read"] },
      },
    );
    assert.deepEqual(
      [...narrowed.body.capabilities],
      ["task.read", "session.read"],
      "the intersection and nothing else, in the order asked for",
    );

    await assert.rejects(
      async () =>
        await h.client.request("/api/v1/auth/pair-codes", {
          method: "POST",
          body: { name: "widen", interface: "cli", restrict: ["shell.run"] },
        }),
      (error: unknown) => {
        const failure = error as { status: number; envelope: { error: { message: string } } };
        assert.equal(failure.status, 400);
        assert.match(
          failure.envelope.error.message,
          /only narrow/,
          "§5.3 makes a restriction an intersection, so `--restrict` is not a way to enable the shell",
        );
        return true;
      },
    );

    await assert.rejects(
      async () =>
        await h.client.request("/api/v1/auth/pair-codes", {
          method: "POST",
          body: { name: "typo", interface: "cli", restrict: ["task.red"] },
        }),
      (error: unknown) => {
        const failure = error as { status: number; envelope: { error: { message: string } } };
        assert.equal(failure.status, 400);
        assert.match(
          failure.envelope.error.message,
          /vocabulary/,
          "§2's rule 03: an unknown capability is a refusal, not a name quietly dropped from the list",
        );
        return true;
      },
    );

    // §13 writes its own example in family terms — `crabby auth pair --restrict shell,config` — so the shorthand has to
    // survive the wire, and the half of that example which cannot be honoured has to be refused for the rule rather than
    // as a misspelling: `shell.run` and `shell` are different refusals with different repairs.
    const family = await h.client.request<{ capabilities: readonly string[] }>(
      "/api/v1/auth/pair-codes",
      { method: "POST", body: { name: "family", interface: "cli", restrict: ["config"] } },
    );
    assert.deepEqual(
      [...family.body.capabilities],
      ["config.read", "config.write"],
      "a dot-less token expands to the family the baseline holds, and to nothing the baseline withheld",
    );

    await assert.rejects(
      async () =>
        await h.client.request("/api/v1/auth/pair-codes", {
          method: "POST",
          body: { name: "shell-family", interface: "cli", restrict: ["shell"] },
        }),
      (error: unknown) => {
        const failure = error as { status: number; envelope: { error: { message: string } } };
        assert.equal(failure.status, 400);
        assert.match(
          failure.envelope.error.message,
          /holds none of them/,
          "§9 keeps both shell capabilities off every baseline, so the family is empty for every interface and the " +
            "refusal says that instead of quoting the vocabulary at an operator who spelled it correctly",
        );
        return true;
      },
    );
  });

  it("decides identity management on the socket, so no header can move it", async () => {
    const listed = await fetch(`${h.url}/api/v1/auth/clients`, {
      headers: { authorization: `Bearer ${h.token}`, "x-forwarded-for": "203.0.113.9" },
    });
    assert.equal(
      listed.status,
      200,
      "a public address in a forwarded header does not lock a local caller out, because `trustProxy: false` means " +
        "`request.ip` is the kernel's answer rather than a string a caller wrote — which is also why the same header " +
        "cannot borrow local rights. The refusal of a genuinely remote socket is not reachable from this process and is " +
        "asserted by predicate in `packages/gateway/wire.test.ts` instead of being faked here",
    );
    const body = (await listed.json()) as { items: { id: string; name: string }[] };
    assert.ok(
      body.items.length >= 1,
      "and the list is what §3.1 promises `crabby auth list` — names and interfaces, never a token",
    );
    assert.ok(
      !JSON.stringify(body).includes(h.token),
      "the credential stays out of the record a list route returns, revoked or not",
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
      /** §4.1's runtime half, present exactly when a composed executor declared the row (F-55). Optional in this local
       *  type for the reason they are optional in `ToolRecord`: a test must be able to assert a row has none. */
      inputSchema?: Record<string, unknown>;
      outputSchema?: Record<string, unknown>;
      limits?: { timeoutMs: number; maxOutputBytes: number };
      idempotent?: boolean;
      sideEffects?: string;
      pendingRecordFields: string[];
    }[];
    count: number;
    tiers: string[];
    capabilities: { name: string; grants: string }[];
    registry: { source: string; rows: number; digest: string };
    /** How much of the record a composed executor answered. Two counts rather than one: `implemented` is the rows an
     *  executor declares, `described` the rows with no field left pending, and a declaration with no `outputSchema`
     *  raises the first and not the second. */
    runtime: { implemented: number; described: number; pending: number };
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

  /** The executor `crabby gateway start` composes from `config.json`'s `workspace.roots`, built here the same way: one
   *  workspace, one home, one data directory, all three inside a `PathContext` because §8's deny-list is measured against
   *  home and dataDir with the roots as the inside — and a partial context is the difference between "inside the
   *  workspace" and "somewhere we did not check". `realpathOf` is the real resolver rather than an omission, because
   *  `file.delete` fails closed at T3 without one and a test that quietly composed a stricter executor than the product
   *  would be asserting about a build nobody runs. */
  function composeFileExecutor(): { declares: (tool: string) => ToolDeclaration | undefined } {
    const base = mkdtempSync(path.join(tmpdir(), "crabby-gateway-tools-"));
    const root = path.join(base, "workspace");
    const home = path.join(base, "home");
    const dataDir = path.join(base, "state");
    mkdirSync(root, { recursive: true });
    mkdirSync(home, { recursive: true });
    const tools = createFileTools({
      paths: { home, dataDir, roots: [root] },
      scratchDirFor: (taskId) => {
        const dir = path.join(dataDir, "scratch", taskId);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        return dir;
      },
      realpathOf: defaultRealpathOf,
    });
    return { declares: tools.declares };
  }

  it("answers §4.1's runtime fields from the composed executor and keeps naming them pending where nothing implements the row", async () => {
    const { declares } = composeFileExecutor();
    const harness = await boot({ platformFacts: { isTermux: false }, declares });
    try {
      const body = (await harness.client.tools()).body as ToolsBody;
      // Counted by "answered something" rather than by "answered everything", because the second is not what an executor
      // with no output schemas produces and asserting it would be asserting a build that does not exist.
      const answered = body.items.filter(
        (item) => item.pendingRecordFields.length < PENDING_RECORD_FIELDS.length,
      );
      const pending = body.items.filter(
        (item) => item.pendingRecordFields.length === PENDING_RECORD_FIELDS.length,
      );

      // Seven, not forty-five and not eight. `createFileTools` declares eight tools, but `file.stat` has no row in §4.2's
      // table, so seven registry rows can be answered — and reporting seven is the honest half of F-55's narrowing. A test
      // that demanded all 45 would be demanding the mock this phase has refused; one that demanded 8 would be counting a
      // declaration policy has never classified as though the registry agreed with it.
      assert.equal(
        answered.length,
        7,
        "exactly the registry rows the file executor declares may stop naming every runtime field as pending",
      );
      assert.equal(
        body.runtime.implemented,
        7,
        "`runtime.implemented` is the rows an executor declares, which is the number F-55 asked to see shrink",
      );
      assert.equal(
        body.runtime.pending,
        body.count - 7,
        "`runtime.pending` is the rows nothing implements, and it must not be a separate count that can drift",
      );
      // `described` stays 0, and that is why the route reports two counts instead of one: none of the file executor's
      // declarations carries an `outputSchema`, so no row is fully described even though seven are partly answered. A
      // client that read "implemented" as "complete" would render an empty output schema as a check that always passes.
      assert.equal(
        body.runtime.described,
        0,
        "a declaration with no `outputSchema` leaves that field pending, so no row may count as fully described",
      );

      for (const item of answered) {
        assert.ok(
          item.id.startsWith("file.") || item.id === "fs.search",
          `${item.id} answered its runtime fields but no executor in this build declares it`,
        );
        assert.deepEqual(
          [...item.pendingRecordFields],
          ["outputSchema"],
          `${item.id} must name exactly the field its executor does not answer, and nothing else — a row that named all ` +
            "five would have merged nothing, and one that named none would be claiming an output schema it has",
        );
        assert.equal(
          item.outputSchema,
          undefined,
          `${item.id} merged an output schema no declaration carries`,
        );
        assert.ok(
          Object.keys(item.inputSchema ?? {}).length > 0,
          `${item.id} merged an empty inputSchema, which reads as "takes no arguments" — the exact lie ` +
            "`pendingRecordFields` exists to prevent",
        );
        assert.ok(
          typeof item.idempotent === "boolean" && typeof item.sideEffects === "string",
          `${item.id} merged a half-record: idempotency and side effects are what a recovery path retries on`,
        );
        assert.ok(
          (item.limits?.timeoutMs ?? 0) > 0,
          `${item.id} merged no deadline, and a tool with no deadline is a run that cannot be cancelled`,
        );
      }
      for (const item of pending) {
        assert.deepEqual(
          [...item.pendingRecordFields],
          [...PENDING_RECORD_FIELDS],
          `${item.id} has no executor, so it must still name all five fields rather than carry defaults for them`,
        );
        assert.equal(
          item.inputSchema,
          undefined,
          `${item.id} answered a field nothing implemented`,
        );
      }
    } finally {
      await harness.close();
    }
  });

  it("keeps the registry digest policy-only, so composing an executor cannot look like a change of policy", async () => {
    const { declares } = composeFileExecutor();
    const merged = await boot({ platformFacts: { isTermux: false }, declares });
    try {
      const withExecutor = (await merged.client.tools()).body as ToolsBody;
      const withoutExecutor = await fetchTools({ isTermux: false });
      assert.equal(
        withExecutor.registry.digest,
        withoutExecutor.registry.digest,
        "the digest is an agreement about tiers, capabilities and availability — a device with a file executor composed " +
          "and one without have the same policy and different runtimes, and a digest that moved with the executor would " +
          "report that as a disagreement about policy",
      );
      assert.equal(
        withoutExecutor.runtime.implemented,
        0,
        "a Gateway with nothing composed must say so rather than imply its rows are described",
      );
      // Asserted over one body rather than by comparing two arrays of numbers, because the claim is about the Gateway that
      // composed nothing: every row of it still names all five fields. That is the assertion the merge above has to be read
      // against — without it, seven answered rows could hide the fact that the other thirty-eight are silent rather than
      // described.
      for (const item of withoutExecutor.items) {
        assert.deepEqual(
          [...item.pendingRecordFields],
          [...PENDING_RECORD_FIELDS],
          `${item.id} in a Gateway with no executor composed must name every runtime field it cannot answer`,
        );
      }
    } finally {
      await merged.close();
    }
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
    // The body is read exactly once: `Response.text()` and `Response.json()` both consume it, so a status assertion that
    // printed the text would leave nothing for the id, and the second read throws "Body is unusable". The parsed object is
    // what the failure message is built from instead.
    const createdTask = (await created.json()) as { id: string; state: string };
    assert.equal(
      created.status,
      201,
      `the Gateway refused the task it was asked to record: ${JSON.stringify(createdTask)}`,
    );

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
    assert.match(
      status.stdout,
      /runs +not composed/,
      "the screen asks the process whether it can drive a task instead of asserting a property of the build. This " +
        "spawned Gateway has no workspace root and no selected model, so it composes no runner and says so — and the " +
        "line this replaced said `crabby task run` was 'planned for the runtime slice', which is the stale-claim " +
        "defect `apps/cli/commands/status.ts` argues against in its own comments (F-38, F-40)",
    );

    // §6.1's stop button, end to end through two spawned processes: the CLI asks, the route records, the manager settles.
    // A `queued` task has nothing in flight, so the request settles inside `request()` and the answer is already
    // `cancelled` — which is why this needs no polling, and why the assertion is about the printed evidence rather than
    // about waiting. The three facts a user has to judge are on one line because §6.2 asks for them together: whether the
    // operation stopped, and whether an external effect is in doubt.
    const cancel = runCli(dir, ["task", "cancel", createdTask.id]);
    assert.equal(cancel.code, 0, cancel.stdout);
    assert.match(
      cancel.stdout,
      /^state +cancelled$/m,
      "a queued task settles at once (§6.1 step 3)",
    );
    assert.match(
      cancel.stdout,
      /finish-step · confirmed stopped · no external effect in doubt/,
      "§6.2's evidence has to reach the screen that asked, not only the record",
    );
    assert.ok(
      !cancel.stdout.includes("may still be running"),
      "the line that means work might continue must not appear when the manager confirmed it stopped",
    );

    const afterCancel = runCli(dir, ["task", "ls", "--json"]);
    assert.equal(afterCancel.code, 0, afterCancel.stdout);
    const listedAfter = JSON.parse(afterCancel.stdout) as {
      items: { id: string; state: string; cancellation?: { settledAt?: string } }[];
    };
    const settledTask = listedAfter.items.find((item) => item.id === createdTask.id);
    assert.equal(
      settledTask?.state,
      "cancelled",
      "a cancellation requested through the CLI must be readable through the CLI, by every interface alike",
    );
    assert.ok(
      typeof settledTask?.cancellation?.settledAt === "string",
      "D-091: present without `settledAt` means requested-not-settled, and this one settled",
    );
    const statusAfter = runCli(dir, ["status"]);
    assert.ok(
      !/tasks +queued 1/.test(statusAfter.stdout),
      "`crabby status` prints the queue a user acts on, so a settled task must leave it",
    );

    // Watching a task that already settled. This assertion is safe to make through the blocking `runCli` precisely
    // because of the verb's first move: `task watch` reads the task once before opening a stream, and a terminal state
    // will never publish another event, so the command answers and exits instead of blocking until somebody interrupts.
    // The alternative — opening the stream first — would have made this line hang the whole file.
    const watched = runCli(dir, ["task", "watch", createdTask.id]);
    assert.equal(watched.code, 0, watched.stdout);
    assert.ok(
      /cancelled/.test(watched.stdout),
      "the verb must say which terminal state it refused to wait on, not merely that it stopped",
    );
    assert.ok(
      !watched.stdout.includes("watching"),
      "printing `watching` for a task that can never publish again would promise a stream that cannot arrive — the " +
        "hang §7.1's exit-code contract cannot describe, because the command would never exit to return one",
    );
    assert.ok(
      /§4\.1|terminal/.test(watched.stdout),
      "the fix line names the rule that makes the refusal correct rather than a bug: a terminal state is absorbing",
    );

    // The same refusal in the mode a script reads. This is the assertion that would have caught a real bug: the house
    // renderer prints its document with two-space indentation, which is right for a snapshot and wrong for a verb whose
    // §7.1 contract is NDJSON — one document per line. A pretty-printed answer arrives as dozens of lines, and no reader
    // parsing one-event-per-line can tell a refusal from a malformed event.
    const watchedJson = runCli(dir, ["task", "watch", createdTask.id, "--json"]);
    assert.equal(watchedJson.code, 0, watchedJson.stdout);
    const jsonLines = watchedJson.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    assert.equal(
      jsonLines.length,
      1,
      `§7.1 promises this verb NDJSON, so the already-terminal answer must be one line, got ${JSON.stringify(watchedJson.stdout)}`,
    );
    const refusal = JSON.parse(jsonLines[0] ?? "{}") as {
      state?: string;
      streamed?: boolean;
      events?: number;
      fixes?: string[];
    };
    assert.equal(refusal.state, "cancelled");
    assert.equal(
      refusal.streamed,
      false,
      "no stream was opened, and the document must say so rather than imply it",
    );
    assert.equal(refusal.events, 0);
    assert.ok(
      (refusal.fixes ?? []).some((fix) => fix.includes("§4.1")),
      "the rule that makes the refusal correct travels in the document too, because a script has no ordering to read",
    );

    // Watching a task that is still alive, which is the verb's actual promise and the one thing a spawned *blocking*
    // helper cannot test: `runCli` waits for exit, and a stream that has not been told to end never exits. So the child
    // is started asynchronously, the task is cancelled from this process, and the watcher is then expected to notice the
    // terminal event and end itself — no kill, no timeout standing in for the behaviour under test.
    // Raw fetch, matching this describe's own idiom: P-003 spawns its Gateway rather than composing one in-process, so
    // there is no harness client to borrow — the port comes from the file both processes read and the token from the
    // credentials `crabby auth pair` wrote. A fresh idempotency key keeps this task from colliding with `spawned-1`.
    const liveResponse = await fetch(`http://127.0.0.1:${info.port}/api/v1/tasks`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokenFromCli(dir)}`,
        "content-type": "application/json",
        "idempotency-key": "spawned-watch",
      },
      body: JSON.stringify({ objective: "watched live" }),
    });
    const liveTask = (await liveResponse.json()) as { id: string; state: string };
    assert.equal(liveResponse.status, 201, JSON.stringify(liveTask));
    const watcher = spawn(
      process.execPath,
      [
        path.join(REPO, "apps/cli/crabby.ts"),
        "--data-dir",
        dir,
        "task",
        "watch",
        liveTask.id,
        "--json",
      ],
      { cwd: REPO, env: { ...process.env, HOME: path.dirname(dir) } },
    );
    try {
      let streamed = "";
      let stderrText = "";
      watcher.stdout.setEncoding("utf8");
      watcher.stdout.on("data", (chunk: string) => {
        streamed += chunk;
      });
      watcher.stderr?.setEncoding("utf8");
      watcher.stderr?.on("data", (chunk: string) => {
        stderrText += chunk;
      });
      // Wait for the stream to be *attached* before cancelling, because the alternative is a race this test lost once
      // already: `task watch` reads the task before it opens a stream, and cancelling a `queued` task with `immediate`
      // settles inside the manager's own `request()` (§6.1 step 3, nothing in flight), so a cancel that lands before the
      // child's pre-read produces a watcher that correctly answers "already cancelled" and never streams at all.
      //
      // Waiting for the first NDJSON line would never resolve, and the reason is in the Gateway rather than in the CLI:
      // `registerEventStream` replays history only for a request that carries *both* a `taskId` filter and a non-empty
      // `Last-Event-ID` header, so a subscriber with no cursor receives nothing until a new event is published — not even
      // a `gap` frame. This task's `task.created` was published before the child attached, so the only honest signal that
      // the stream exists is the Gateway's own count of its subscribers, which `GET /api/v1/diagnostics` reports.
      const attached = await (async () => {
        const deadline = Date.now() + 15_000;
        for (;;) {
          const response = await fetch(`http://127.0.0.1:${info.port}/api/v1/diagnostics`, {
            headers: { authorization: `Bearer ${tokenFromCli(dir)}` },
          });
          const body = (await response.json()) as { streams?: { subscribers?: number } };
          if ((body.streams?.subscribers ?? 0) >= 1) return true;
          if (Date.now() > deadline) return false;
          await wait(100);
        }
      })();
      assert.ok(
        attached,
        `the watcher never became a subscriber within 15 s, so there was nothing to cancel into; stdout was ` +
          `${JSON.stringify(streamed)} and stderr was ${JSON.stringify(stderrText)}`,
      );

      // Cancel from this process rather than through a second CLI, so the assertion is about the stream and not about two
      // spawned commands racing to reach the same Gateway.
      const cancelResponse = await fetch(
        `http://127.0.0.1:${info.port}/api/v1/tasks/${liveTask.id}/cancel`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${tokenFromCli(dir)}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ mode: "immediate" }),
        },
      );
      const cancelBody = (await cancelResponse.json()) as { state?: string };
      assert.equal(cancelResponse.status, 200, JSON.stringify(cancelBody));

      // Bounded, because the whole point is that the watcher ends on its own: waiting on `exit` with a deadline turns a
      // missing terminal-state check into a red test instead of a hung file.
      const exited = await new Promise<number | null>((resolve) => {
        const deadline = setTimeout(() => resolve(null), 15_000);
        watcher.once("exit", (code) => {
          clearTimeout(deadline);
          resolve(code);
        });
      });
      assert.notEqual(
        exited,
        null,
        "the watcher never ended after the task reached a terminal state, so it would hold a stream open forever — " +
          "`isTerminal` is what makes `task watch` a command that returns rather than a tail that only Ctrl-C ends",
      );
      assert.equal(exited, 0, streamed);

      const lines = streamed
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      assert.ok(lines.length > 0, `expected NDJSON lines, got ${JSON.stringify(streamed)}`);
      // Every line is parsed through a guard that names the offender, because "one document per line" is the contract
      // §7.1 states and a pretty-printed document anywhere in the stream breaks it silently: `JSON.parse` on a fragment
      // reports a position in an empty string rather than which line was not a document.
      const events = lines.map((line) => {
        try {
          return JSON.parse(line) as Event;
        } catch {
          throw new Error(
            `not one JSON document per line: ${JSON.stringify(line)} in ${JSON.stringify(streamed)}`,
          );
        }
      });
      assert.ok(
        events.every((event) => Number.isInteger(event.seq) && event.seq >= 0),
        "§7.1: each line carries the per-task `seq`, which is how a script notices a gap the way a browser does",
      );
      assert.ok(
        events.every((event) => event.taskId === liveTask.id),
        "`?taskId=` filtering is server-side (D-048), so another task's events must not appear in this stream",
      );
      const types = events.map((event) => event.type);
      assert.ok(
        types.includes("task.state.changed") || types.includes("task.cancelled"),
        `the cancellation must arrive as an event, got ${types.join(", ")}`,
      );
      assert.ok(
        types.includes("task.cancelled"),
        "the watcher ends because a terminal event arrived, and that event is the one it should have printed last",
      );
      const seqs = events.map((event) => event.seq);
      assert.deepEqual(
        [...seqs].sort((a, b) => a - b),
        seqs,
        "one stream, one task: the sequence must be monotonic, because a non-monotonic NDJSON feed is a gap the reader " +
          "cannot detect",
      );
    } finally {
      // Defensive: an assertion that fails mid-stream must not leave the child holding an SSE connection open, which
      // would keep this file alive past its own `after()` and look exactly like the known P-003 flake.
      if (watcher.exitCode === null) watcher.kill("SIGTERM");
    }

    // `--types` narrows what is printed, and the property worth testing is the one that could silently hang a user: a
    // filter naming `task.progress` does not name the event that ends the task, so if the verb asked the Gateway for
    // only what the user typed it would wait forever for a terminal event it had asked not to be told about. The verb
    // widens the query with the three terminal types and narrows the *printing* instead, so the command still returns —
    // which is §7.1's promise surviving a flag whose whole job is to hide things.
    const filteredResponse = await fetch(`http://127.0.0.1:${info.port}/api/v1/tasks`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokenFromCli(dir)}`,
        "content-type": "application/json",
        "idempotency-key": "spawned-watch-filter",
      },
      body: JSON.stringify({ objective: "watched through a filter" }),
    });
    const filteredTask = (await filteredResponse.json()) as { id: string };
    assert.equal(filteredResponse.status, 201, JSON.stringify(filteredTask));
    const filteredWatcher = spawn(
      process.execPath,
      [
        path.join(REPO, "apps/cli/crabby.ts"),
        "--data-dir",
        dir,
        "task",
        "watch",
        filteredTask.id,
        "--types",
        "task.progress",
        "--json",
      ],
      { cwd: REPO, env: { ...process.env, HOME: path.dirname(dir) } },
    );
    try {
      let filteredOut = "";
      let filteredErr = "";
      filteredWatcher.stdout.setEncoding("utf8");
      filteredWatcher.stdout.on("data", (chunk: string) => {
        filteredOut += chunk;
      });
      filteredWatcher.stderr?.setEncoding("utf8");
      filteredWatcher.stderr?.on("data", (chunk: string) => {
        filteredErr += chunk;
      });
      const filteredAttached = await (async () => {
        const deadline = Date.now() + 15_000;
        for (;;) {
          const response = await fetch(`http://127.0.0.1:${info.port}/api/v1/diagnostics`, {
            headers: { authorization: `Bearer ${tokenFromCli(dir)}` },
          });
          const body = (await response.json()) as { streams?: { subscribers?: number } };
          if ((body.streams?.subscribers ?? 0) >= 1) return true;
          if (Date.now() > deadline) return false;
          await wait(100);
        }
      })();
      assert.ok(
        filteredAttached,
        `the filtered watcher never became a subscriber within 15 s; stderr was ${JSON.stringify(filteredErr)}`,
      );

      const filteredCancel = await fetch(
        `http://127.0.0.1:${info.port}/api/v1/tasks/${filteredTask.id}/cancel`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${tokenFromCli(dir)}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ mode: "immediate" }),
        },
      );
      await filteredCancel.json();
      assert.equal(filteredCancel.status, 200);

      const filteredExit = await new Promise<number | null>((resolve) => {
        const deadline = setTimeout(() => resolve(null), 15_000);
        filteredWatcher.once("exit", (code) => {
          clearTimeout(deadline);
          resolve(code);
        });
      });
      assert.notEqual(
        filteredExit,
        null,
        "a `--types` filter that excludes the terminal event made the watcher hang, so the query must carry the events " +
          `that end a task whatever the user asked to see; stdout was ${JSON.stringify(filteredOut)}`,
      );
      assert.equal(filteredExit, 0, filteredOut);
      assert.ok(
        !filteredOut.includes("task.cancelled"),
        "the user asked for `task.progress` only, so the terminal event that ended the watch must not be printed — it " +
          "was requested from the Gateway to know when to stop, not to be shown",
      );
    } finally {
      if (filteredWatcher.exitCode === null) filteredWatcher.kill("SIGTERM");
    }

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

describe("a spawned gateway that drives tasks, and §7.1's exit codes for the verb that runs them", () => {
  let dir: string;
  let child: ChildProcess | undefined;
  let output = "";

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "crabby-run-"));
    const work = mkdtempSync(path.join(tmpdir(), "crabby-run-work-"));
    writeFileSync(path.join(work, "notes.md"), "# notes\n", "utf8");
    // A configuration that composes a runner, which is the only way to test this verb's exit codes at all: one
    // workspace root, one keyless provider entry, and a selected default model. The endpoint is a port nothing listens
    // on and `limits.providerAttempts` is 1, so a run fails on its first attempt instead of walking D-074's ladder for
    // half a minute. The assertions below are about an exit code and about what the command does and does not follow,
    // and a test that spent thirty seconds proving one integer would be a test nobody ran twice.
    writeFileSync(
      path.join(dir, "config.json"),
      `${JSON.stringify(
        {
          workspace: { roots: [work] },
          provider: {
            local: {
              baseUrl: "http://127.0.0.1:9/v1",
              models: {
                "qwen2.5:3b": {
                  contextWindow: 4096,
                  maxOutputTokens: 512,
                  supports: {
                    streaming: true,
                    toolCalling: true,
                    parallelToolCalls: false,
                    systemRole: true,
                    structuredOutput: false,
                    imageInput: false,
                    audioInput: false,
                    reasoning: false,
                    promptCaching: false,
                    jsonSchemaValidation: false,
                  },
                  cancellation: "best-effort",
                  rateLimits: null,
                  cost: "local",
                  batching: null,
                },
              },
            },
          },
          defaultModel: "local/qwen2.5:3b",
          limits: { providerAttempts: 1 },
        },
        null,
        2,
      )}\n`,
    );
    child = spawn(
      process.execPath,
      [path.join(REPO, "apps/cli/crabby.ts"), "--data-dir", dir, "gateway", "start"],
      { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    await waitForGatewayInfo(dir, 25_000);
    const code = output
      .split("\n")
      .find((line) => /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/.test(line.trim()));
    assert.ok(code, `the gateway has to print a pairing code; output was:\n${output}`);
    const paired = runCli(dir, ["auth", "pair", "--code", code.trim()]);
    assert.equal(paired.code, 0, paired.stdout);
    assert.match(
      runCli(dir, ["status"]).stdout,
      /runs +composed/,
      "this gateway composes a runner, and the screen says so — without it every assertion below would be about a " +
        "refusal instead of about a run",
    );
  });

  after(() => {
    child?.kill("SIGTERM");
  });

  it("exits with the run's outcome, so a failed task cannot be read as a success", () => {
    const ran = runCli(dir, ["task", "run", "summarise notes.md"]);
    assert.equal(
      ran.code,
      1,
      `§7.1: exit \`1\` is failure, and the failure here is the run's — output was:\n${ran.stdout}`,
    );
    assert.match(
      ran.stdout,
      /ended failed/,
      "and the sentence says whose outcome the code reports, because a verb that blocks has to explain the block",
    );
    assert.match(
      ran.stdout,
      /watching/,
      "it followed the run to its end, which is what the verb without `--detach` promises",
    );
    assert.match(
      runCli(dir, ["task", "ls"]).stdout,
      /failed/,
      "the state the exit code reported is the state on the record: the code is a reading of the run, not an opinion",
    );
  });

  it("returns at once on `--detach`, and answers a script with one document", () => {
    const detached = runCli(dir, ["task", "run", "--detach", "detached"]);
    assert.equal(
      detached.code,
      0,
      "a detached run is a task that was created, not an outcome nobody waited for — §7.1 calls this the script path",
    );
    assert.doesNotMatch(
      detached.stdout,
      /watching/,
      "`--detach` means the command does not follow, and a switch the registry advertises has to be one the parser " +
        "hands over: this one was read from `values` instead of `booleans`, so it was parsed and then ignored",
    );
    const doc = runCli(dir, ["task", "run", "--detach", "--json", "detached json"]);
    assert.equal(doc.code, 0, doc.stdout);
    const parsed = JSON.parse(doc.stdout) as {
      following: boolean;
      idempotencyKey: string;
      state: string;
    };
    assert.equal(parsed.following, false);
    assert.equal(parsed.state, "queued");
    assert.ok(
      parsed.idempotencyKey.length > 0,
      "the key the command generated is in the document, because a script that retries has to be able to show it",
    );
  });

  it("reports a failed task from a read verb without inheriting its outcome", () => {
    const listed = runCli(dir, ["task", "ls", "--json"]);
    const items = (JSON.parse(listed.stdout) as { items: { id: string; state: string }[] }).items;
    const failed = items.find((row) => row.state === "failed");
    assert.ok(failed, `a failed task has to be on the list; got ${listed.stdout}`);
    const watched = runCli(dir, ["task", "watch", failed.id]);
    assert.equal(
      watched.code,
      0,
      "a read reports its subject's outcome rather than inheriting it — the same reason `task show` on a failed task " +
        "exits `0`, and the state is on every line for a caller that wants to decide for itself",
    );
    assert.match(watched.stdout, /state +failed/, "and it says plainly what it found");
    assert.equal(
      runCli(dir, ["task", "show", failed.id]).code,
      0,
      "the snapshot verb agrees with the streaming one, so a script cannot get two answers from two reads",
    );
  });
});

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

describe("cancellation over http (AGENT_RUNTIME.md §6.1, §6.2)", () => {
  let h: Harness;
  before(async () => {
    h = await boot();
  });
  after(async () => {
    await h.close();
  });

  async function create(objective: string, key: string): Promise<string> {
    const created = await h.client.createTask({ objective }, key);
    assert.equal(created.status, 201, "the harness has to be able to create a task to cancel one");
    return (created.body as TaskRecord).id;
  }

  it("settles a queued task at once, because §6.1's step 6 applies the moment nothing is in flight", async () => {
    const id = await create("a task nobody started", "cancel-1");

    const response = await h.client.cancelTask(id);

    assert.equal(response.status, 200);
    const record = response.body as TaskRecord;
    assert.ok(
      validate(TaskRecord, record).ok,
      "the answer is a task record, and the contract says so",
    );
    assert.equal(
      record.state,
      "cancelled",
      "a `queued` task has no step to finish, so the request and the settle are one act — answering `cancelling` here " +
        "would promise a second event that nothing will ever send",
    );
    // §6.2's evidence on the record and not only in the log (D-091), because the record is what a phone reads when it
    // comes back from the background: `inFlight: "none"` is the fact that makes `effectsUncertain: false` trustworthy.
    assert.deepEqual(
      record.cancellation,
      {
        mode: "finish-step",
        requestedAt: record.cancellation?.requestedAt,
        settledAt: record.cancellation?.settledAt,
        terminated: true,
        effectsUncertain: false,
        inFlight: "none",
        by: record.cancellation?.by,
      },
      "the manager's default mode, and evidence that says nothing was running and nothing is uncertain",
    );
    assert.ok(
      typeof record.cancellation?.by === "string" && record.cancellation.by.length > 0,
      "§14's audit field travelled: the record names the identity that asked, which is what makes a cancellation " +
        "reviewable after the fact rather than only observable while it happens",
    );
    assert.ok(
      typeof record.cancellation?.settledAt === "string",
      "a settled task says when it settled; §6.2's `settledAt` is what distinguishes this from a request still waiting",
    );
  });

  it("publishes the request as a state change and the settle as `task.cancelled`, inventing no third event type", async () => {
    const id = await create("a task with an audience", "cancel-2");
    await h.client.cancelTask(id);

    const page = (await h.client.taskEvents(id)).body as { items: Event[] };
    const types = page.items.map((event) => event.type);

    assert.deepEqual(
      types,
      ["task.created", "task.state.changed", "task.cancelled"],
      "docs/INTERFACES_AND_API.md §5.2: a cancellation *request* needs no event type of its own, because it is a move " +
        "into `cancelling` and travels as `task.state.changed`; `task.cancelled` is the settle",
    );
    const settle = page.items.find((event) => event.type === "task.cancelled");
    assert.equal(
      settle?.payload.inFlight,
      "none",
      "§6.2's evidence travels in the settle event too",
    );
    assert.equal(
      settle?.payload.mode,
      "finish-step",
      "and so does the mode, because a client that reads only the stream still learns what was asked for",
    );
  });

  it("answers a double-tap with the request it recorded, not with a conflict (§6.2)", async () => {
    const id = await create("a task cancelled twice", "cancel-3");

    const first = await h.client.cancelTask(id);
    const second = await h.client.cancelTask(id);

    assert.equal(first.status, 200);
    assert.equal(
      second.status,
      200,
      "a phone that taps stop twice is relaying one fact, and answering the second tap with 409 would read as a refusal " +
        "of something that already happened",
    );
    assert.equal((second.body as TaskRecord).state, "cancelled");
    const page = (await h.client.taskEvents(id)).body as { items: Event[] };
    assert.equal(
      page.items.filter((event) => event.type === "task.cancelled").length,
      1,
      "one settle, one event: the second request added no second opinion to the log",
    );
  });

  it("accepts `immediate`, because §6.2's override has to be reachable over HTTP and not only in code", async () => {
    const id = await create("a task stopped hard", "cancel-4");

    const response = await h.client.cancelTask(id, {
      mode: "immediate",
      reason: "wrong directory",
    });
    const record = response.body as TaskRecord;

    assert.equal(record.cancellation?.mode, "immediate");
    assert.equal(
      record.cancellation?.reason,
      "wrong directory",
      "the reason a user typed is the reason a reviewer reads a week later (§14)",
    );
  });

  it("refuses a task that already finished, quoting §4.1's absorbing rule rather than rephrasing it", async () => {
    const id = await create("a task that completed first", "cancel-5");
    // Set in the database because nothing in this build can complete a task over HTTP: the runner exists but no route
    // hands a task to it (F-52), so the fixture writes the state a completed run would have left.
    assert.ok(setState(h.db, id, "completed"), "the fixture has to reach the state it is testing");

    await assert.rejects(
      async () => await h.client.cancelTask(id),
      (error: unknown) => {
        const failure = error as {
          status: number;
          envelope: { error: { class: string; code: string; message: string } };
        };
        assert.equal(
          failure.status,
          409,
          "`conflict`: the request was well-formed and the world disagreed",
        );
        assert.equal(failure.envelope.error.code, "cancel_terminal");
        assert.match(
          failure.envelope.error.message,
          /terminal and absorbing.*§4\.1/s,
          "the manager's own sentence, verbatim — a route that rephrased it would be a second voice",
        );
        return true;
      },
    );
    assert.equal(getTask(h.db, id)?.state, "completed", "and the outcome it recorded is untouched");
  });

  it("answers 404 for a task nobody created, without enumerating the routes that do exist", async () => {
    await assert.rejects(
      async () => await h.client.cancelTask("tsk_never_existed"),
      (error: unknown) => {
        const failure = error as {
          status: number;
          envelope: { error: { code: string; message: string } };
        };
        assert.equal(failure.status, 404);
        assert.equal(failure.envelope.error.code, "cancel_not-found");
        assert.ok(
          !failure.envelope.error.message.includes("/api/v1"),
          "§3.1: a refusal is not a map of the surface",
        );
        return true;
      },
    );
  });

  it("refuses a mode outside §6.1's vocabulary, because a typo must not be read as `immediate`", async () => {
    const id = await create("a task with a mistyped stop", "cancel-6");

    await assert.rejects(
      async () =>
        await h.client.request(`/api/v1/tasks/${id}/cancel`, {
          method: "POST",
          body: { mode: "now" },
        }),
      (error: unknown) => {
        const failure = error as { status: number; envelope: { error: { class: string } } };
        assert.equal(failure.status, 400);
        assert.equal(
          failure.envelope.error.class,
          "validation",
          "one schema, one validator (D-069)",
        );
        return true;
      },
    );
    assert.equal(
      getTask(h.db, id)?.state,
      "queued",
      "a refused body moves nothing: the task is still waiting for somebody to ask properly",
    );
  });

  it("demands a token, like every other route, including the ones the security sweep cannot reach", async () => {
    const id = await create("a task with no caller", "cancel-7");
    // The sweep in `tests/security/policy-surface.test.ts` checks parameterless routes only, so a route with an `:id` in
    // it is checked here instead. SECURITY.md §13 rejects *every* route, and an unauthenticated cancel is the one that
    // would cost a user their work.
    const bare = createClient({ url: h.url });

    await assert.rejects(
      async () => await bare.request(`/api/v1/tasks/${id}/cancel`, { method: "POST", body: {} }),
      (error: unknown) => {
        const failure = error as { status: number; envelope: { error: { class: string } } };
        assert.equal(failure.status, 401);
        assert.equal(failure.envelope.error.class, "auth");
        return true;
      },
    );
    assert.equal(
      getTask(h.db, id)?.state,
      "queued",
      "and an unauthenticated request moved nothing",
    );
  });
});
