// The bot's behavior against scripted doubles: the gate (G1-01), the shed (G-S10), pairing (G1-02), the command
// surface's honest refusals, the approval fan-out with its nonce-bound callbacks (G-A3/A4/A7/A8), and the G-A12 rule
// that nothing mutates locally before the Gateway agrees. The Gateway is a stub `GatewayClient` — the bot is
// HTTP-shaped, and the stub records routes instead of serving them.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Update } from "grammy/types";
import type { InlineKeyboard } from "./approvals.ts";
import { type BotDeps, CrabbyBot } from "./bot.ts";
import { TelegramSender } from "./outbound.ts";
import type { TelegramState } from "./state.ts";
import type { TelegramTransport } from "./transport.ts";
import { addressUpdate } from "./transport.ts";

interface Call {
  readonly route: string;
  readonly options?:
    | { method?: string; body?: unknown; headers?: Record<string, string> }
    | undefined;
}

function harness(config?: {
  responses?: Map<string, unknown>;
  failures?: Map<string, { status: number; code: string; message: string }>;
}) {
  const calls: Call[] = [];
  const sends: { chatId: string; text: string; keyboard?: unknown; messageId: number }[] = [];
  const denied: { chatId: string; userId: string }[] = [];
  const persisted: TelegramState[] = [];
  let state: TelegramState = { chats: {}, watches: {}, offset: undefined, shed: undefined };
  const client = {
    url: "http://127.0.0.1:5000",
    request: async (
      route: string,
      options?: { method?: string; body?: unknown; headers?: Record<string, string> },
    ) => {
      calls.push({ route, options });
      const failure = config?.failures?.get(route);
      if (failure !== undefined) {
        throw Object.assign(new Error(failure.message), {
          status: failure.status,
          envelope: {
            error: {
              code: failure.code,
              message: failure.message,
              class: "conflict",
              retryable: false,
            },
          },
        });
      }
      const scripted = config?.responses?.get(route) ?? {};
      return { status: 200, body: scripted };
    },
  };
  const transport: TelegramTransport = {
    getMe: async () => ({ id: 42, username: "crabby_bot" }),
    getUpdates: async () => [],
    sendMessage: async (chatId, text, other) => {
      const message = { message_id: 500 + sends.length + 1 };
      sends.push({
        chatId: String(chatId),
        text,
        keyboard: other?.reply_markup,
        messageId: message.message_id,
      });
      return { ...message, chat: { id: Number(chatId) } };
    },
    editMessageText: async () => ({}),
    sendDocument: async () => ({ message_id: 1 }),
    answerCallbackQuery: async () => ({}),
    setMyCommands: async () => ({}),
  };
  const sender = new TelegramSender({ transport });
  const deps: BotDeps = {
    transport,
    client: client as unknown as BotDeps["client"],
    sender,
    state,
    config: { allowUsers: ["777"], allowChats: ["-200"], zone: "Asia/Dhaka" },
    persist: (next) => {
      state = next;
      persisted.push(next);
    },
    recordDeniedAttempt: (chatId, userId) => denied.push({ chatId, userId }),
  };
  const bot = new CrabbyBot(deps);
  return {
    bot,
    deps,
    calls,
    sends,
    denied,
    persisted,
    atState: () => state,
    sendText: (text: string, chatId = "100", userId = "777") =>
      bot.handle({ kind: "message", chatId, userId, messageId: 9, chatKind: "private", text }),
    pair: () =>
      bot.handle({
        kind: "message",
        chatId: "100",
        userId: "777",
        messageId: 9,
        chatKind: "private",
        text: "/start 2ABC9DEF",
      }),
  };
}

function messageUpdate(text: string, chatId = 100, userId = 777): Update {
  return {
    update_id: 1,
    message: {
      message_id: 9,
      date: Math.floor(Date.now() / 1000),
      text,
      chat: { id: chatId, type: chatId < 0 ? "group" : "private", first_name: "T" },
      from: { id: userId, is_bot: false, first_name: "T" },
    },
  } as Update;
}

describe("G1-01 — the gate: an unauthorized sender gets nothing at all", () => {
  it("an unknown user's message produces no reply, only the attempt record", async () => {
    const h = harness();
    const update = addressUpdate(messageUpdate("/status", 100, 999));
    const reply = await h.bot.handle({
      kind: "message",
      chatId: update.chatId,
      userId: update.userId,
      messageId: update.messageId,
      chatKind: update.chatKind,
      ...(update.text === undefined ? {} : { text: update.text }),
    });
    assert.equal(reply.text, undefined);
    assert.deepEqual(h.denied, [{ chatId: "100", userId: "999" }]);
    assert.equal(h.calls.length, 0, "the Gateway is never asked about a sender the gate refused");
  });

  it("a group outside the allow-list is refused even for an allowed user (G1-05)", async () => {
    const h = harness();
    const update = addressUpdate(messageUpdate("/status", -999, 777));
    const reply = await h.bot.handle({
      kind: "message",
      chatId: update.chatId,
      userId: update.userId,
      messageId: update.messageId,
      chatKind: update.chatKind,
      ...(update.text === undefined ? {} : { text: update.text }),
    });
    assert.equal(reply.text, undefined);
    assert.equal(h.denied.length, 1);
  });

  it("an allowed group and allowed user pass (G7-06)", async () => {
    const h = harness();
    h.deps.state = {
      ...h.deps.state,
      chats: {
        "-200": {
          clientId: "c",
          token: "t",
          pairedAt: "p",
          userId: "777",
          kind: "group",
          sessionId: undefined,
        },
      },
    };
    const reply = await h.sendText("/health", "-200");
    assert.match(reply.text ?? "", /— up /);
  });
});

describe("G1-02 — pairing, in chat", () => {
  it("/start without a code explains the mint step and points at crabby init for the rest (G-O01)", async () => {
    const h = harness();
    const reply = await h.sendText("/start");
    assert.match(reply.text ?? "", /crabby auth pair --name .* --interface telegram/);
    assert.match(reply.text ?? "", /crabby init/);
  });

  it("/start <code> redeems into this chat's own identity (G1-04), stored via persist", async () => {
    const h = harness({
      responses: new Map([["/api/v1/auth/pair", { clientId: "cli_chat100", token: "tok_1" }]]),
    });
    const reply = await h.pair();
    assert.match(reply.text ?? "", /paired as cli_chat100/);
    assert.equal(h.atState().chats["100"]?.token, "tok_1");
    assert.equal(h.atState().chats["100"]?.userId, "777");
    assert.ok(h.persisted.length > 0);
  });

  it("a refused code surfaces the Gateway's own envelope (G2-12), and nothing is stored", async () => {
    const h = harness({
      failures: new Map([
        [
          "/api/v1/auth/pair",
          {
            status: 400,
            code: "pairing_code_invalid",
            message: "the code never existed or was used",
          },
        ],
      ]),
    });
    const reply = await h.pair();
    assert.match(reply.text ?? "", /pairing_code_invalid — the code never existed or was used/);
    assert.equal(h.atState().chats["100"], undefined);
  });
});

describe("G3 — commands through the chat's own identity", () => {
  const paired = {
    chats: {
      "100": {
        clientId: "c",
        token: "tok_chat",
        pairedAt: "p",
        userId: "777",
        kind: "private" as const,
        sessionId: "s_1",
      },
    },
    watches: {},
    offset: undefined,
    shed: undefined,
  };

  it("an unknown command names the closest real one (G3-29)", async () => {
    const h = harness();
    h.deps.state = paired;
    const reply = await h.sendText("/tasls");
    assert.match(reply.text ?? "", /the closest is \/tasks/);
  });

  it("a distant unknown names nothing and points at /help", async () => {
    const h = harness();
    h.deps.state = paired;
    const reply = await h.sendText("/zzzzzzzz");
    assert.match(reply.text ?? "", /\/help lists every one/);
  });

  it("the refused commands answer with the row's reason (G3-31/G7-03/G7-08)", async () => {
    const h = harness();
    h.deps.state = paired;
    for (const [text, pattern] of [
      ["/pair", /local-only.*D-053|G7-03/],
      ["/restart", /lock .?out|G7-08/],
      ["/shutdown", /G7-08|lock/],
      ["/auth", /G7-03|local/],
    ] as const) {
      const reply = await h.sendText(text);
      assert.match(reply.text ?? "", pattern, `${text} must answer with its refusal`);
    }
  });

  it("bare text is treated as a question, visibly (G3-30), and creates the task with the chat's session", async () => {
    const h = harness({
      responses: new Map([["/api/v1/tasks", { id: "tsk_new", sessionId: "s_new" }]]),
    });
    h.deps.state = paired;
    const reply = await h.sendText("what is in the roadmap?");
    assert.match(reply.text ?? "", /^\(no command — treated as a question\)/);
    assert.match(reply.text ?? "", /question running as task tsk_new/);
    const call = h.calls.find((candidate) => candidate.route === "/api/v1/tasks");
    const body = (call?.options?.body ?? {}) as { sessionId?: string };
    assert.equal(body.sessionId, "s_1");
    assert.ok(
      (call?.options?.headers?.["idempotency-key"] ?? "").length > 8,
      "the create carries an idempotency key",
    );
    // G1-04: the chat's session follows the Gateway's answer — the Gateway is the source of truth for where the
    // conversation lives, and in the ordinary flow it echoes the session the chat already had.
    assert.equal(h.atState().chats["100"]?.sessionId, "s_new");
  });

  it("/tasks numbers rows so /cancel 2 works (G3-03/G3-06)", async () => {
    const h = harness({
      responses: new Map([
        [
          "/api/v1/tasks?limit=20",
          {
            items: [
              { id: "tsk_a", state: "running", objective: "first" },
              { id: "tsk_b", state: "awaiting_approval", objective: "second" },
            ],
          },
        ],
        ["/api/v1/tasks/tsk_b/cancel", {}],
      ]),
    });
    h.deps.state = paired;
    const list = await h.sendText("/tasks");
    const lines = (list.text ?? "").split("\n");
    assert.match(lines[0] ?? "", /\[needs approval\]/, "pending-approval tasks are marked first");
    assert.match(lines[0] ?? "", /^1\./);
    const cancel = await h.sendText("/cancel 1");
    assert.match(cancel.text ?? "", /cancellation requested for tsk_b/);
  });

  it("a Gateway refusal reaches the chat as the same envelope every interface prints (G2-12)", async () => {
    const h = harness({
      failures: new Map([
        ["/api/v1/tasks?limit=20", { status: 404, code: "not_found", message: "nothing here" }],
      ]),
    });
    h.deps.state = paired;
    const reply = await h.sendText("/tasks");
    assert.match(reply.text ?? "", /^not_found — nothing here$/);
  });

  it("a down Gateway is one line with the fix, never a false working-on-it (G-T01)", async () => {
    const h = harness();
    h.deps.state = paired;
    // Replace the client with one that throws like a dead socket:
    (h.deps as { client: unknown }).client = {
      url: "http://127.0.0.1:5000",
      request: async () => {
        throw new TypeError("fetch failed");
      },
    };
    const bot = new CrabbyBot(h.deps);
    const reply = await bot.handle({
      kind: "message",
      chatId: "100",
      userId: "777",
      messageId: 9,
      chatKind: "private",
      text: "/tasks",
    });
    assert.match(reply.text ?? "", /the Gateway is not answering/);
    assert.match(reply.text ?? "", /crabby gateway start/);
  });
});

describe("G-A — approvals from the keyboard and the typed path", () => {
  const paired = {
    chats: {
      "100": {
        clientId: "c",
        token: "tok_chat",
        pairedAt: "p",
        userId: "777",
        kind: "private" as const,
        sessionId: "s_1",
      },
    },
    watches: {},
    offset: undefined,
    shed: undefined,
  };

  it("/approve <unknown id> is one identical answer, whether it never existed or belongs elsewhere (G-S09)", async () => {
    const h = harness({
      failures: new Map([
        [
          "/api/v1/approvals/xyz/decision",
          { status: 404, code: "not_found", message: "no such approval" },
        ],
      ]),
    });
    h.deps.state = paired;
    const reply = await h.sendText("/approve xyz");
    assert.match(reply.text ?? "", /nothing pending under xyz/);
  });

  it("a conflict (answered elsewhere) says the first answer won and nothing ran twice (G-A7/G-A8)", async () => {
    const h = harness({
      failures: new Map([
        [
          "/api/v1/approvals/apr_1/decision",
          { status: 409, code: "approval_already_answered", message: "answered by cli" },
        ],
      ]),
    });
    h.deps.state = paired;
    const reply = await h.sendText("/approve apr_1");
    assert.match(reply.text ?? "", /answered elsewhere — the first answer won/);
    // Idempotent: the second tap reads the same conflict, not a new answer.
    const again = await h.sendText("/approve apr_1");
    assert.match(again.text ?? "", /answered elsewhere/);
  });

  it("the deny path carries the reason onto the record (G3-09)", async () => {
    const h = harness({});
    h.deps.state = paired;
    const reply = await h.sendText("/deny apr_2 the directory is wrong");
    const call = h.calls.find(
      (candidate) => candidate.route === "/api/v1/approvals/apr_2/decision",
    );
    assert.deepEqual(call?.options?.body, {
      decision: "deny",
      scope: "once",
      reason: "the directory is wrong",
    });
    assert.match(reply.text ?? "", /denied apr_2/);
  });

  it("the keyboard tap: nonce-bound, verified, answered, and the card edits to its settled line (G-A3/A4/A5)", async () => {
    const h = harness({});
    h.deps.state = paired;
    await h.bot.pushApproval({
      id: "apr_9",
      summary: "write a file",
      target: "echo hi > /workspace/x",
      tier: "T2",
      tool: "fs.write",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const card = h.sends.find(
      (send) => (send.keyboard as InlineKeyboard | undefined) !== undefined,
    );
    assert.ok(card !== undefined, "the card went out");
    const buttons = (card.keyboard as InlineKeyboard).inline_keyboard[0] ?? [];
    assert.equal(buttons.length, 2);
    // Tap the approve button as the chat's paired user:
    const parsed = (await import("./approvals.ts")).parseCallbackData(
      buttons[0]?.callback_data ?? "",
    );
    assert.ok(parsed !== undefined);
    const reply = await h.bot.handle({
      kind: "callback",
      chatId: "100",
      userId: "777",
      messageId: card.messageId,
      chatKind: "private",
      callbackId: "cbid_1",
      ...(buttons[0]?.callback_data === undefined ? {} : { data: buttons[0].callback_data }),
    });
    assert.equal(reply.callbackAnswer, "recorded");
    assert.match(reply.editSettled ?? "", /approved by user 777/);
    assert.match(reply.editSettled ?? "", /keyboard is gone/);
    const call = h.calls.find(
      (candidate) => candidate.route === "/api/v1/approvals/apr_9/decision",
    );
    assert.deepEqual(call?.options?.body, { decision: "approve", scope: "once" });
  });

  it("a forged nonce gets the identical not-pending answer (G-A3's reason, G-S09's answer)", async () => {
    const h = harness({});
    h.deps.state = paired;
    await h.bot.pushApproval({ id: "apr_10", tier: "T2" });
    const reply = await h.bot.handle({
      kind: "callback",
      chatId: "100",
      userId: "777",
      messageId: 5,
      chatKind: "private",
      callbackId: "cbid_2",
      data: "apr:apr_10:deadbeef",
    });
    assert.equal(reply.callbackAnswer, "not pending");
    assert.equal(
      h.calls.filter((call) => call.route.includes("/decision")).length,
      0,
      "a forged tap never reaches the Gateway",
    );
  });
});

describe("G4 — watch, unwatch, and the terminal message", () => {
  const paired = {
    chats: {
      "100": {
        clientId: "c",
        token: "tok_chat",
        pairedAt: "p",
        userId: "777",
        kind: "private" as const,
        sessionId: "s_1",
      },
    },
    watches: {},
    offset: undefined,
    shed: undefined,
  };

  it("a second /watch on the same task is a no-op that says so (G3-04)", async () => {
    const h = harness({});
    h.deps.state = paired;
    const first = await h.sendText("/watch tsk_a");
    assert.match(first.text ?? "", /watching tsk_a/);
    const second = await h.sendText("/watch tsk_a");
    assert.match(second.text ?? "", /a second \/watch changes nothing/);
  });

  it("/unwatch stops edits, keeps the task — and says the difference (G4-08)", async () => {
    const h = harness({});
    h.deps.state = paired;
    await h.sendText("/watch tsk_a");
    const reply = await h.sendText("/unwatch tsk_a");
    assert.match(reply.text ?? "", /the task itself is untouched; \/cancel is the stop command/);
    assert.equal(h.atState().watches.tsk_a, undefined);
  });

  it("a terminal frame is its own message and detaches the watcher (G4-03)", async () => {
    const h = harness({});
    h.deps.state = paired;
    await h.sendText("/watch tsk_a");
    await h.bot.onTaskFrame("tsk_a", { type: "task.completed", payload: { summary: "done well" } });
    const terminal = h.sends.at(-1);
    assert.match(terminal?.text ?? "", /^task completed — done well/);
    assert.match(terminal?.text ?? "", /tsk_a/, "G-T05: labeled with the task id, no shared done");
    assert.equal(h.atState().watches.tsk_a, undefined);
  });

  it("the final answer is delivered whole (G4-05), not summarized", async () => {
    const h = harness({});
    h.deps.state = paired;
    await h.sendText("/watch tsk_a");
    await h.bot.onTaskFrame("tsk_a", {
      type: "message.added",
      payload: { role: "assistant", content: "the answer is 4" },
    });
    assert.match(h.sends.at(-1)?.text ?? "", /the answer is 4/);
  });

  it("a lost edit is never a lost task (G1-10): the edit failure is swallowed, not thrown", async () => {
    const h = harness({});
    h.deps.state = paired;
    await h.sendText("/watch tsk_a");
    (h.deps.transport as unknown as { editMessageText: () => Promise<never> }).editMessageText =
      async () => {
        throw new Error("message is not modified");
      };
    await h.bot.onTaskFrame("tsk_a", { type: "tool.started", payload: { name: "fs.write" } });
    assert.ok(true, "reaching here is the assertion — the throw was contained");
  });
});
