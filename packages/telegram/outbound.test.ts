// The sender's policy, held against a scripted transport: the floor (G4-01), the split (G2-02), the retry_after wait
// (G4-06), the one-retry-then-record answer (G-T06), and the coalescer that keeps a busy task from becoming a
// notification flood without ever holding an approval (G-A13). Time is injected — the tests prove the *policy*, not
// that this machine can wait.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TelegramSender } from "./outbound.ts";

interface ScriptedSend {
  readonly chatId: string;
  readonly text: string;
  readonly options?:
    | { parse_mode?: "HTML"; reply_to_message_id?: number; reply_markup?: unknown }
    | undefined;
}

function harness(config: { throws?: (call: number, text: string) => unknown; now?: () => number }) {
  const sends: ScriptedSend[] = [];
  const edits: { chatId: string; messageId: number; text: string }[] = [];
  const waits: number[] = [];
  const failures: { chatId: string; text: string; reason: string }[] = [];
  let clock = 0;
  let call = 0;
  const now = config.now ?? (() => clock);
  const sender = new TelegramSender({
    transport: {
      sendMessage: async (chatId, text, options) => {
        call += 1;
        const thrown = config.throws?.(call, text);
        if (thrown !== undefined) throw thrown;
        sends.push({ chatId: String(chatId), text, options });
        clock = now();
        return { message_id: 100 + sends.length };
      },
      editMessageText: async (chatId, messageId, text) => {
        edits.push({ chatId: String(chatId), messageId, text });
        return {};
      },
    },
    recordFailedSend: (chatId, text, reason) => failures.push({ chatId, text, reason }),
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    now: () => clock,
  });
  return { sender, sends, edits, waits, failures, at: () => clock };
}

describe("the per-chat floor (G4-01 — ~1/s private, lower for groups)", () => {
  it("a second immediate send waits the private floor", async () => {
    const h = harness({});
    await h.sender.sendText("100", "first");
    await h.sender.sendText("100", "second");
    assert.deepEqual(h.waits, [1_100]);
    assert.equal(h.sends.length, 2);
  });

  it("a group's floor is the lower rate (the '-' prefix is a group id on the wire)", async () => {
    const h = harness({});
    await h.sender.sendText("-200", "one");
    await h.sender.sendText("-200", "two");
    assert.deepEqual(h.waits, [3_100]);
  });

  it("different chats pace independently", async () => {
    const h = harness({});
    await h.sender.sendText("100", "a");
    await h.sender.sendText("200", "b");
    assert.deepEqual(h.waits, []);
  });
});

describe("the split ride (G2-02 + G2-03)", () => {
  it("a long answer arrives as marked parts, none over the API's limit", async () => {
    const h = harness({});
    const body = Array.from({ length: 500 }, (_, i) => `row ${String(i)} ${"z".repeat(30)}`).join(
      "\n",
    );
    await h.sender.sendText("100", body);
    assert.ok(h.sends.length >= 3);
    for (const send of h.sends) {
      assert.ok(send.text.length <= 4_096, `a part is ${String(send.text.length)} chars`);
    }
    assert.match(h.sends[0]?.text ?? "", /\(1\/\d+\)$/);
  });

  it("the reply target quotes only the first part (G2-11)", async () => {
    const h = harness({});
    const body = Array.from({ length: 400 }, (_, i) => `row ${String(i)} ${"z".repeat(30)}`).join(
      "\n",
    );
    await h.sender.sendText("100", body, { replyTo: 77 });
    assert.equal(h.sends[0]?.options?.reply_to_message_id, 77);
    assert.equal(h.sends[1]?.options?.reply_to_message_id, undefined);
  });
});

describe("G4-06 — retry_after is honored, and the task never stops", () => {
  it("a 429 waits the API's number plus margin, then sends", async () => {
    let once = false;
    const h = harness({
      throws: (nth) => {
        if (nth === 2 && !once) {
          once = true;
          return {
            error_code: 429,
            parameters: { retry_after: 2 },
            message: "Too Many Requests: retry after 2",
          };
        }
        return undefined;
      },
    });
    await h.sender.sendText("100", "one");
    await h.sender.sendText("100", "two");
    assert.equal(h.sends.length, 2);
    assert.deepEqual(h.waits, [1_100, 3_000], "the wait is retry_after (2s) + 1s margin");
  });
});

describe("G-T06 — one retry, then the answer is recorded, never dropped silently", () => {
  it("a 5xx retries once and succeeds", async () => {
    const h = harness({
      throws: (nth) => (nth === 1 ? { error_code: 502, message: "bad gateway" } : undefined),
    });
    await h.sender.sendText("100", "first send retries the 502");
    assert.equal(h.sends.length, 1);
    assert.equal(h.failures.length, 0);
  });

  it("a 400 is not retried — retrying a wrong request is how a bot floods", async () => {
    const h = harness({
      throws: () => ({ error_code: 400, message: "Bad Request: chat not found" }),
    });
    await h.sender.sendText("100", "never deliverable");
    assert.equal(h.sends.length, 0);
    assert.equal(h.failures.length, 1);
    assert.match(h.failures[0]?.reason ?? "", /400/);
  });
});

describe("the progress coalescer (G4-02) and the approval bypass (G-A13)", () => {
  it("edits inside the floor are held, newest wins", async () => {
    const h = harness({});
    h.sender.editProgress("100", 5, "step 1", (text) => void h.sender.sendText("100", text));
    h.sender.editProgress(
      "100",
      5,
      "step 2 — newest",
      (text) => void h.sender.sendText("100", text),
    );
    await new Promise((resolve) => setTimeout(resolve, 1_400));
    const texts = h.sends.map((send) => send.text);
    assert.ok(!texts.includes("step 1"), "the older state is dropped from the message");
  });

  it("the approval goes out immediately, coalescer or not (G-A13 — a decision waits for nobody)", async () => {
    const h = harness({});
    // Hold the floor busy with a just-sent message:
    await h.sender.sendText("100", "filling the floor");
    const before = h.at();
    await h.sender.sendApprovalBypassingCoalescer("100", "needs your approval", {
      inline_keyboard: [],
    });
    assert.equal(h.at(), before, "no pacing wait was applied");
  });
});
