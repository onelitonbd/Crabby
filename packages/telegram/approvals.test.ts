// Region G-A: the card carries the same five facts as the Web and TUI (G-A1), the payload is opaque (G-A3), the
// verification is three-way (G-A4), and the long-target split is a *whole* message (G-A10).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type ApprovalItem,
  approvalKeyboard,
  approvalText,
  callbackAllowed,
  needsOwnTargetMessage,
  parseCallbackData,
  settledLine,
  whyText,
} from "./approvals.ts";
import { CALLBACK_DATA_MAX } from "./limit.ts";

const ITEM: ApprovalItem = {
  id: "apr_9f2c",
  summary: "the run wants to write a file",
  target: "echo hello > /workspace/out.txt",
  consequence: "writes one file in the granted root",
  reversible: true,
  tier: "T2",
  tool: "fs.write",
  taskId: "tsk_1",
  expiresAt: new Date(Date.now() + 90_000).toISOString(),
};

describe("G-A1 — the card is the whole card", () => {
  it("summary, exact target, consequence, reversibility, tier, expiry, and the id on its own line", () => {
    const card = approvalText(ITEM);
    assert.match(card, /the run wants to write a file/);
    assert.match(card, /exact target: echo hello > \/workspace\/out\.txt/);
    assert.match(card, /consequence: writes one file/);
    assert.match(card, /reversible: yes/);
    assert.match(card, /tier: T2 · tool: fs\.write/);
    assert.match(card, /expires in \d+m \d+s/);
    assert.match(card, /apr_9f2c/);
  });

  it("an expiry already passed reads as passed, never as a live countdown (G-A6's cousin)", () => {
    const card = approvalText(ITEM, Date.now() + 120_000);
    assert.match(card, /expiry: passed/);
  });

  it("a missing reversibility is absent, not guessed", () => {
    const card = approvalText({ ...ITEM, reversible: undefined });
    assert.doesNotMatch(card, /reversible:/);
  });
});

describe("G-A2/G-A3 — two buttons, one row, opaque payload", () => {
  it("the keyboard is Approve once + Deny, and neither payload names an action word", () => {
    const nonces = { approve: "aaaa1111", deny: "bbbb2222" };
    const keyboard = approvalKeyboard(ITEM, nonces);
    assert.equal(keyboard.inline_keyboard.length, 1);
    const [approve, deny] = keyboard.inline_keyboard[0] ?? [];
    assert.equal(approve?.text, "Approve once");
    assert.equal(deny?.text, "Deny");
    for (const button of [approve, deny]) {
      assert.ok((button?.callback_data.length ?? 0) <= CALLBACK_DATA_MAX);
      assert.doesNotMatch(
        button?.callback_data ?? "",
        /approve|deny/i,
        "the action is never in the payload",
      );
    }
  });

  it("parseCallbackData reads the id+nonce shape and rejects foreign data", () => {
    assert.deepEqual(parseCallbackData("apr:apr_9f2c:aaaa1111"), {
      id: "apr_9f2c",
      nonce: "aaaa1111",
    });
    assert.equal(
      parseCallbackData("deny:apr_9f2c"),
      undefined,
      "an action-word payload is not this bot's shape",
    );
    assert.equal(parseCallbackData("apr:apr_9f2c"), undefined);
  });
});

describe("G-A4 — the three-way verification", () => {
  const record = { chatId: "100", messageId: 5, userIds: ["777"] };
  it("the right user, chat, and message pass", () => {
    assert.equal(callbackAllowed({ userId: "777", chatId: "100", messageId: 5, record }), true);
  });
  it("a wrong user in a group gets nothing — not an error", () => {
    assert.equal(callbackAllowed({ userId: "999", chatId: "100", messageId: 5, record }), false);
  });
  it("a wrong chat or a tapped message that is not the card fails closed", () => {
    assert.equal(callbackAllowed({ userId: "777", chatId: "200", messageId: 5, record }), false);
    assert.equal(callbackAllowed({ userId: "777", chatId: "100", messageId: 6, record }), false);
  });
});

describe("G-A10 and the settled line (G-A5) and the why (G-A11)", () => {
  it("a 3KB target demands its own whole message before the card", () => {
    assert.equal(needsOwnTargetMessage({ ...ITEM, target: "x".repeat(3_000) }, 2_000), true);
    assert.equal(needsOwnTargetMessage(ITEM, 2_000), false);
  });

  it("the settled line names who, when, and that no stale button remains", () => {
    const line = settledLine("approve", "user 777", "2026-10-16T12:00:00Z");
    assert.match(line, /approved by user 777/);
    assert.match(line, /keyboard is gone/);
  });

  it("the why-note is the tier's reason, the same content as W-A12/T-A12", () => {
    const why = whyText(ITEM);
    assert.match(why, /tier T2/);
    assert.match(why, /A12/);
  });
});
