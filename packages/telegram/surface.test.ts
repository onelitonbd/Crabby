// The surface's promises, against a scripted client: the two-step config write (T3), the telegram.* refusal (G7-03),
// the redaction (G-S06), the honest gaps (G-T01 — each names what is not built and its path), the jobs keyboard
// (G3-34), and G3-03's numbering arithmetic.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ask,
  compactNow,
  configCommand,
  deleteCommand,
  exportCommand,
  listJobs,
  listModels,
  logsCommand,
  memoryCommand,
  probeModel,
  resolveTaskRef,
  type SurfaceClient,
  type SurfaceContext,
  showContext,
  showJob,
  statusCommand,
  tunnelCommand,
} from "./surface.ts";

interface Recorded {
  readonly route: string;
  readonly options?:
    | { method?: string; body?: unknown; headers?: Record<string, string> }
    | undefined;
}

function ctxFor(responses: Map<string, unknown>) {
  const calls: Recorded[] = [];
  const client: SurfaceClient = {
    request: async (route, options) => {
      calls.push({ route, options });
      return { status: 200, body: responses.get(route.split("?")[0] ?? route) ?? {} };
    },
  };
  const numbers = new Map([
    ["1", "tsk_first"],
    ["2", "tsk_second"],
  ]);
  const ctx: SurfaceContext = {
    client,
    chatId: "100",
    sessionId: "s_chat",
    resolveTask: (ref) =>
      numbers.get(ref) ?? (ref.includes("_") || ref.length > 6 ? ref : undefined),
    zone: "Asia/Dhaka",
  };
  return { ctx, calls, numbers };
}

describe("ask / G3-30's engine — a question is POST /tasks on the chat's session", () => {
  it("creates with the session, an idempotency key, and returns the id line plus the task's id field", async () => {
    const { ctx, calls } = ctxFor(
      new Map([["/api/v1/tasks", { id: "tsk_q1", sessionId: "s_chat" }]]),
    );
    const reply = await ask(ctx, "what is on the board today?");
    const call = calls[0];
    assert.equal(call?.route, "/api/v1/tasks");
    assert.deepEqual(call?.options?.body, {
      objective: "what is on the board today?",
      sessionId: "s_chat",
    });
    const key = call?.options?.headers?.["idempotency-key"] ?? "";
    assert.match(
      key,
      /^tg-ask-/,
      "the key is tg-ask- prefixed so replays of the same ask are visible",
    );
    assert.match(reply.text, /tsk_q1/);
    assert.equal(reply.taskId, "tsk_q1");
  });
});

describe("resolveTaskRef — G3-03's grammar", () => {
  it("a row number resolves through the last /tasks; an id passes; a bare word does not", () => {
    const numbers = new Map([["1", "tsk_a"]]);
    assert.equal(resolveTaskRef(numbers, "1"), "tsk_a");
    assert.equal(resolveTaskRef(numbers, "tsk_a"), "tsk_a");
    assert.equal(resolveTaskRef(numbers, "zzz"), undefined);
  });
});

describe("config — the two-step write and its guards", () => {
  it("a set shows the diff and demands the same command with apply — one message, no write", async () => {
    const { ctx, calls } = ctxFor(
      new Map([
        [
          "/api/v1/config",
          {
            file: { gateway: { port: 5000 } },
            config: { gateway: { port: 5000 } },
            token: "abcd1234",
            redacted: [],
          },
        ],
      ]),
    );
    const reply = await configCommand(ctx, "set gateway.port 5001");
    assert.match(reply.text, /confirm by repeating/);
    assert.match(reply.text, /- gateway\.port: 5000/);
    assert.match(reply.text, /\+ gateway\.port: 5001/);
    assert.equal(
      calls.filter((call) => call.options?.method === "PUT").length,
      0,
      "nothing was written yet",
    );
  });

  it("the apply carries the overrides document as {config} with if-match — built on the file view, not the merged one", async () => {
    const { ctx, calls } = ctxFor(
      new Map([
        [
          "/api/v1/config",
          {
            file: { gateway: { port: 5000 } },
            config: { gateway: { port: 5000 }, limits: { shellRun: 120 } },
            token: "abcd1234",
            redacted: [],
          },
        ],
      ]),
    );
    const reply = await configCommand(ctx, "apply gateway.port 5001");
    const put = calls.find((call) => call.options?.method === "PUT");
    assert.ok(put !== undefined);
    assert.deepEqual(
      put.options?.body,
      { config: { gateway: { port: 5001 } } },
      "defaults are not pinned back into the file",
    );
    assert.equal(put.options?.headers?.["if-match"], '"abcd1234"');
    assert.match(reply.text, /written: gateway\.port/);
  });

  it("telegram.* is refused on both paths — access configuration never changes from a chat (G7-03)", async () => {
    const { ctx, calls } = ctxFor(new Map());
    for (const args of ["set telegram.allowUsers 999", "apply telegram.allowUsers 999"]) {
      const reply = await configCommand(ctx, args);
      assert.match(reply.text, /G7-03|local-only/);
    }
    assert.equal(calls.length, 0, "not even a read — the refusal is the whole answer");
  });

  it("a read redacts credential-looking keys (G-S06) but prints a vault reference as itself", async () => {
    const { ctx } = ctxFor(
      new Map([
        [
          "/api/v1/config",
          {
            file: {},
            config: { gateway: { token: "plain-secret" }, provider: { key: "vault://main" } },
            token: "abcd1234",
            redacted: [],
          },
        ],
      ]),
    );
    const secret = await configCommand(ctx, "gateway.token");
    assert.equal(secret.text, "gateway.token = redacted");
    const vaultRef = await configCommand(ctx, "provider.key");
    assert.equal(vaultRef.text, 'provider.key = "vault://main"');
  });
});

describe("the honest gaps — each names what is not built and the local path (G-T01)", () => {
  it("logs, export, delete, tunnel, memory, extensions, and probe refuse with their row", async () => {
    const { ctx } = ctxFor(
      new Map([["/api/v1/sessions/s_chat/compact", { covers: { from: 1, through: 6 } }]]),
    );
    assert.match(logsCommand().text, /no routes in this build/);
    assert.match(exportCommand().text, /not built in this milestone/);
    assert.match(deleteCommand().text, /not built/);
    assert.match(tunnelCommand(undefined).text, /not built/);
    assert.match(memoryCommand().text, /not in this build/);
    assert.match((await listModels(ctx)).text, /not built yet/);
    assert.match(probeModel("gpt-x").text, /not built/);
    const compact = await compactNow(ctx);
    assert.match(compact.text, /summarized turns 1–6/);
    assert.match(
      compact.text,
      /still readable/,
      "a summary is another record, never a replacement (D-027)",
    );
  });

  it("the status answer is a map, not a poem (G3-27's /status)", async () => {
    const { ctx } = ctxFor(
      new Map([
        ["/api/v1/status", { ready: true, subsystems: { tunnel: { state: "absent" } } }],
        [
          "/api/v1/health",
          { status: "ok", version: "0.4.0", uptimeMs: 65_000, vault: { managed: false } },
        ],
        ["/api/v1/approvals", { items: [] }],
      ]),
    );
    const reply = await statusCommand(ctx);
    assert.match(reply.text, /ready · v0\.4\.0 · up 65s/);
    assert.match(reply.text, /vault: unmanaged/);
    assert.match(reply.text, /approvals waiting: 0/);
  });
});

describe("jobs — G3-34's keyboard", () => {
  it("one job shows its schedule in words with the six-action keyboard", async () => {
    const { ctx } = ctxFor(
      new Map([
        ["/api/v1/jobs", {}],
        [
          "/api/v1/jobs/jb_1",
          {
            id: "jb_1",
            name: "nightly",
            schedule: "0 2 * * *",
            state: "active",
            nextRun: "2026-10-17T02:00:00Z",
          },
        ],
      ]),
    );
    const reply = await showJob(ctx, "jb_1", new Map());
    assert.match(reply.text, /nightly/);
    assert.match(reply.text, /every day 02:00/, "the schedule is translated to words");
    assert.match(
      reply.text,
      /\d{2}:\d{2} \(Asia\/Dhaka\)/,
      "the next run is stamped in the Gateway's zone",
    );
    const buttons =
      reply.keyboard?.inline_keyboard.flat().map((button) => button.callback_data) ?? [];
    for (const action of ["pause", "resume", "run", "edit", "delete"]) {
      assert.ok(
        buttons.some((data) => data.endsWith(`:${action}`)),
        `${action} is on the keyboard`,
      );
    }
  });

  it("an empty jobs list says what a job *is* — a T2 cron.schedule, not a chat command", async () => {
    const { ctx } = ctxFor(new Map([["/api/v1/jobs", {}]]));
    const reply = await listJobs(ctx);
    assert.match(reply.text, /cron\.schedule/);
  });
});

describe("context — G3-16's read-only view", () => {
  it("shows usage and the compact threshold, and never offers to edit", async () => {
    const { ctx } = ctxFor(
      new Map([
        [
          "/api/v1/sessions/s_chat/context",
          {
            budget: { window: 100_000, reserveForOutput: 8_000, compactAtTokens: 80_000 },
            projected: { tokens: 42_000, source: "measured" },
            compacted: [{ summary: "earlier turns" }],
            pinned: [1, 2],
          },
        ],
      ]),
    );
    const reply = await showContext(ctx);
    assert.match(reply.text, /42000 tokens of 100000/);
    assert.match(reply.text, /compacts at 80000/);
    assert.match(reply.text, /pinned: 2/);
    assert.doesNotMatch(reply.text, /keyboard/);
  });
});
