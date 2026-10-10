// §4.3's two approval routes over real HTTP, which is where the queue stops being a module and becomes the thing four
// surfaces answer from. The requests are seeded through the *service* rather than through a route, because there is no
// route that creates an approval and there must never be one: §6.1's "an interface may request, display, and relay; it
// may never grant" means the only writer of a request is the runtime that evaluated the policy. A test that invented an
// HTTP creation path would be testing a route this project has decided not to build.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createApprovals } from "@crabby/agent-runtime";
import { type Event, newId } from "@crabby/api-contracts";
import { createLogger } from "@crabby/core";
import { buildApp, createClient, GatewayFailure } from "@crabby/gateway";
import { dataLayout } from "@crabby/platform";
import type { ApprovalRequest } from "@crabby/policy";
import {
  createSqliteApprovalStore,
  createTask,
  migrate,
  mintPairingCode,
  openDatabase,
  readEvents,
  redeemPairingCode,
  type SqliteDb,
} from "@crabby/storage";

const T0 = Date.now();
const T3_TTL = 5 * 60_000;
const T2_TTL = 10 * 60_000;

interface Harness {
  /** A TUI identity, because the harness signs T3 requests and D-085 confines a T3 signature to the TUI and the Web UI.
   *  A harness paired as `cli` is refused by the rule under test, which is the rule working and the fixture wrong — the
   *  first run of this file made that distinction for me. */
  readonly client: ReturnType<typeof createClient>;
  readonly telegram: ReturnType<typeof createClient>;
  /** A third surface, so the tier rule is shown to be a mapping and not a mood: `cli` is refused a T3 by the same table
   *  that refuses Telegram, and accepting it for one of the two would be a rule written as an `if`. */
  readonly cli: ReturnType<typeof createClient>;
  readonly db: SqliteDb;
  /** The same arbiter the routes use, so a test seeds and reads through the code that decides. */
  readonly approvals: ReturnType<typeof createApprovals>;
  readonly taskId: string;
  readonly clientId: string;
  close(): Promise<void>;
}

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    taskId: "tsk_seeded",
    tool: "shell.run",
    tier: "T3",
    summary: "run `rm -rf target` in the workspace root",
    exact: "rm -rf target",
    effects: "deletes the build directory",
    reversibility: "irreversible",
    whatCouldGoWrong: "uncommitted files under target/ are lost",
    scope: "once",
    ttlMs: T3_TTL,
    expiresAt: T0 + T3_TTL,
    binding: "sha256:aaa1",
    ...overrides,
  };
}

function pair(db: SqliteDb, name: string, iface: "tui" | "telegram" | "cli") {
  const minted = mintPairingCode(db, { name, interface: iface });
  const redeemed = redeemPairingCode(db, minted.code);
  assert.ok(
    redeemed.ok && redeemed.token,
    `the harness's ${iface} identity has to be paired before it can be tested`,
  );
  return { token: redeemed.token as string, clientId: redeemed.clientId as string };
}

async function boot(): Promise<Harness> {
  const dir = mkdtempSync(path.join(tmpdir(), "crabby-approvals-"));
  const layout = dataLayout(dir);
  const handle = openDatabase(path.join(dir, "crabby.sqlite3"));
  migrate(handle.db);
  const built = await buildApp({
    db: handle.db,
    layout,
    log: createLogger({ level: "error", write: () => {} }, "approvals-test"),
    version: "test",
    startedAt: new Date(),
    listenerMode: "local",
  });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const address = built.app.server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const url = `http://127.0.0.1:${port}`;
  const tui = pair(handle.db, "desk", "tui");
  const tg = pair(handle.db, "phone", "telegram");
  const cli = pair(handle.db, "shell", "cli");
  const task = createTask(handle.db, { objective: "clean the build directory" });
  return {
    client: createClient({ url, token: tui.token }),
    telegram: createClient({ url, token: tg.token }),
    cli: createClient({ url, token: cli.token }),
    db: handle.db,
    approvals: createApprovals({
      store: createSqliteApprovalStore(handle.db),
      newId: () => newId("apr"),
    }),
    taskId: task.id,
    clientId: tui.clientId,
    async close() {
      await built.app.close();
      handle.close();
    },
  };
}

/** Seeds one live request through the arbiter, the way M2's runtime will. A test that wants an expired row moves
 *  `expiresAt` and not the server's clock, and leaves `ttlMs` unset to do it — the arbiter checks a request's deadline
 *  against the TTL the request itself carries, so faking the pair is the one thing a fixture may not do. */
function seed(h: Harness, overrides: Partial<ApprovalRequest> = {}, at = Date.now()): string {
  const opened = h.approvals.open(
    request({ taskId: h.taskId, expiresAt: at + T3_TTL, ...overrides }),
    at,
  );
  assert.ok(opened.ok, `the fixture request has to be accepted: ${JSON.stringify(opened)}`);
  return opened.ok ? opened.record.id : "";
}

async function failure(
  run: Promise<unknown>,
): Promise<{ status: number; code: string; message: string }> {
  try {
    await run;
  } catch (error) {
    if (error instanceof GatewayFailure) {
      return {
        status: error.status,
        code: error.envelope.error.code,
        message: error.envelope.error.message,
      };
    }
    throw error;
  }
  throw new Error("expected the request to fail, and it succeeded");
}

function events(h: Harness, type: string): Event[] {
  return readEvents(h.db, h.taskId).filter((event) => event.type === type);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The same disarm `tests/integration/gateway.test.ts` carries, for the same reason: Node's `fetch` keeps the global
// undici dispatcher's sockets open for ~72 s after the last response, so a finished file looks like a hung one.
after(async () => {
  const dispatcher = (globalThis as Record<symbol, unknown>)[
    Symbol.for("undici.globalDispatcher.1")
  ] as { close?: () => Promise<void> } | undefined;
  await dispatcher?.close?.();
});

describe("the approval queue over http", () => {
  let h: Harness;
  before(async () => {
    h = await boot();
  });
  after(async () => {
    await h.close();
  });

  it("lists what the arbiter holds, and the row a client reads is the row that was opened", async () => {
    const id = seed(h, { binding: "sha256:list1" });
    const listed = await h.client.approvals();
    const body = listed.body as {
      items: { id: string; request: ApprovalRequest; state: string }[];
      count: number;
      state: string;
      serverTime: string;
    };
    assert.equal(
      body.state,
      "pending",
      "the documented default is the state a client can still act on",
    );
    const row = body.items.find((item) => item.id === id);
    assert.ok(row, "the seeded request is in the queue");
    assert.equal(row.state, "pending");
    assert.equal(
      row.request.exact,
      "rm -rf target",
      "§6.3's exact target reaches the client whole",
    );
    assert.equal(row.request.tier, "T3");
    assert.ok(
      Number.isFinite(Date.parse(body.serverTime)),
      "…and the countdown has a clock to count against",
    );
  });

  it("records an answer, appends the event, and moves the row out of the actionable queue", async () => {
    const id = seed(h, { binding: "sha256:ans1" });
    const decided = await h.client.decideApproval(id, { decision: "approve", scope: "once" });
    const record = (
      decided.body as { record: { state: string; answeredBy: string; request: ApprovalRequest } }
    ).record;
    assert.equal(record.state, "approved");
    assert.equal(
      record.answeredBy,
      h.clientId,
      "§14's actor is the paired identity, not a name a client sent",
    );

    const logged = events(h, "approval.answered");
    assert.equal(logged.length, 1);
    const payload = logged[0]?.payload as Record<string, unknown>;
    assert.equal(payload.approvalId, id);
    // The field is `outcome` and not `decision`, because §14 asks an audit record for "approval requests with their
    // payload and outcome" and the arbiter's word for what happened to it is the one that goes in the log: a second
    // name for the same fact is a second thing to keep true.
    assert.equal(payload.outcome, "approve");
    assert.equal(
      payload.exact,
      "rm -rf target",
      "the audit keeps what was attempted, in plaintext (D-065)",
    );
    assert.equal(payload.via, "tui");
    assert.ok(
      logged[0]?.correlationId,
      "§14 wants a correlation id, and the request id is what the route has",
    );

    const pending = (await h.client.approvals({ state: "pending" })).body as {
      items: { id: string }[];
    };
    assert.ok(
      !pending.items.some((item) => item.id === id),
      "…and the answered row leaves the pending queue",
    );
    const history = (await h.client.approvals({ state: "approved" })).body as {
      items: { id: string }[];
    };
    assert.ok(
      history.items.some((item) => item.id === id),
      "…while it is still readable in the state that records it, because an answer a user cannot find afterwards is an " +
        "answer they will not trust",
    );
  });

  it("refuses a second answer and names who got there first", async () => {
    const id = seed(h, { binding: "sha256:twice1" });
    await h.client.decideApproval(id, { decision: "approve" });
    // A wrong surface reaching a row that is already answered is told the answer stands (409) and not sent to the TUI
    // (403), which is the order `answer` checks in and the right one: "go approve it there" would point at a request
    // that can no longer be approved anywhere. Test 8 covers the other half — a still-pending T3 from a chat surface
    // is refused by §6.2 and the row is left alone.
    const fromTelegram = await failure(h.telegram.decideApproval(id, { decision: "deny" }));
    assert.equal(fromTelegram.status, 409);
    assert.match(fromTelegram.code, /already-answered/);
    const fromTui = await failure(h.client.decideApproval(id, { decision: "deny" }));
    assert.equal(fromTui.status, 409);
    assert.match(fromTui.code, /already-answered/);
    assert.ok(
      fromTui.message.includes(h.clientId),
      `"the first answer stands" has to say whose: ${fromTui.message}`,
    );
    assert.equal(
      h.approvals.list().find((row) => row.id === id)?.state,
      "approved",
      "and a denied second answer does not overwrite the approved first one",
    );
  });

  it("refuses an answer that arrives after the deadline, expires the row, and logs the expiry", async () => {
    const id = seed(h, { binding: "sha256:late01", ttlMs: undefined, expiresAt: Date.now() + 2 });
    await sleep(12);
    const late = await failure(h.client.decideApproval(id, { decision: "approve" }));
    assert.equal(late.status, 409);
    assert.match(late.code, /expired/);
    assert.equal(
      h.approvals.list().find((row) => row.id === id)?.state,
      "expired",
      "the refusal still moved the row, because a queue that hides a request needs a log entry explaining it",
    );
    assert.equal(events(h, "approval.expired").length, 1);
    assert.equal(
      events(h, "approval.answered").filter(
        (e) => (e.payload as { approvalId?: string }).approvalId === id,
      ).length,
      0,
      "…and no answer was recorded, which is the difference between an expiry and an answer",
    );
  });

  it("refuses an unknown approval id with the next action and not a bare refusal", async () => {
    const missing = await failure(
      h.client.decideApproval("apr_does_not_exist", { decision: "approve" }),
    );
    assert.equal(missing.status, 404);
    // §3.1's "one sentence whether the path is unknown or merely not built" is about an *unauthenticated* probe, and
    // this caller is paired: what it needs is the arbiter's own next action, which is why the body points at the queue
    // to answer from instead of at `GET /health`.
    assert.match(missing.message, /GET \/approvals\?state=pending/);
  });

  it("refuses a filter that is not a state and names the five", async () => {
    const bogus = await failure(h.client.approvals({ state: "approved-or-whatever" }));
    assert.equal(bogus.status, 400);
    for (const state of ["pending", "approved", "denied", "expired", "consumed"]) {
      assert.ok(
        bogus.message.includes(state),
        `a refusal to accept a filter has to list the options, and ${state} was missing`,
      );
    }
  });

  it("refuses a request for a remembered approval rather than forgetting it (D-052)", async () => {
    const id = seed(h, { binding: "sha256:scope1" });
    const widened = await failure(
      h.client.decideApproval(id, { decision: "approve", scope: "always" }),
    );
    assert.equal(
      widened.status,
      403,
      "`scope` is not a preference a client may set, so this is `policy` and not `validation`",
    );
    assert.match(widened.message, /D-052/);
    assert.equal(h.approvals.list().find((row) => row.id === id)?.state, "pending");
  });

  it("will not let a chat surface sign a T3, and leaves the row for a surface that may (D-085)", async () => {
    const id = seed(h, { binding: "sha256:tsurf1" });
    for (const surface of [h.telegram, h.cli]) {
      const refused = await failure(surface.decideApproval(id, { decision: "approve" }));
      assert.equal(refused.status, 403);
      assert.match(refused.code, /surface-not-allowed/);
      assert.match(refused.message, /§6\.2/);
    }
    assert.equal(
      h.approvals.list().find((row) => row.id === id)?.state,
      "pending",
      "a refusal from the wrong surface must neither consume the row nor expire it",
    );
    assert.equal(
      events(h, "approval.answered").filter(
        (e) => (e.payload as { approvalId?: string }).approvalId === id,
      ).length,
      0,
      "…and must not write to the log either",
    );

    const t2 = seed(h, {
      binding: "sha256:t2ok01",
      tier: "T2",
      ttlMs: T2_TTL,
      expiresAt: Date.now() + T2_TTL,
    });
    const answered = await h.telegram.decideApproval(t2, { decision: "approve" });
    assert.equal(
      (answered.body as { record: { state: string } }).record.state,
      "approved",
      "a T2 answer from the same client is accepted, so the restriction is the tier and not the transport",
    );
  });

  it("replays a recorded answer for the same idempotency key instead of reporting a second answer", async () => {
    const id = seed(h, { binding: "sha256:idem01" });
    const key = newId("req");
    const first = await h.client.request(`/api/v1/approvals/${id}/decision`, {
      method: "POST",
      body: { decision: "approve" },
      idempotencyKey: key,
    });
    const replay = await h.client.request(`/api/v1/approvals/${id}/decision`, {
      method: "POST",
      body: { decision: "approve" },
      idempotencyKey: key,
    });
    assert.deepEqual(
      replay.body,
      first.body,
      "a phone that retried after a blip reads back its own answer instead of being told it answered twice",
    );
    assert.equal(
      events(h, "approval.answered").filter(
        (e) => (e.payload as { approvalId?: string }).approvalId === id,
      ).length,
      1,
      "…and exactly one event for it, which is the half a replay has to guarantee",
    );
    const conflicting = await failure(
      h.client.request(`/api/v1/approvals/${id}/decision`, {
        method: "POST",
        body: { decision: "deny" },
        idempotencyKey: key,
      }),
    );
    assert.equal(conflicting.status, 409);
    assert.match(conflicting.code, /idempotency_conflict/);
  });
});
