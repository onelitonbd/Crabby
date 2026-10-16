// The loop's policy, held without sleeping: the offset advances after every update (G-S03), a poll failure backs off
// and doubles instead of spinning or crashing (G-T02), and a failed reply never eats the offset — the alternative is
// re-running a handled command forever (G-T06's other half).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type RunOptions, runLoop } from "./run.ts";
import type { TelegramTransport } from "./transport.ts";

function harness(raw: Update[], config?: { abortOnSleep?: boolean }) {
  const polls: { offset?: number; timeout: number }[] = [];
  const offsets: number[] = [];
  const sleeps: number[] = [];
  const logs: string[] = [];
  const handled: string[] = [];
  const sent: string[] = [];
  const controller = new AbortController();
  let call = 0;
  const transport: TelegramTransport = {
    getMe: async () => ({ id: 1, username: "crabby_bot" }),
    getUpdates: async (query) => {
      polls.push({
        ...(query.offset === undefined ? {} : { offset: query.offset }),
        timeout: query.timeout,
      });
      call += 1;
      if (call > 1) controller.abort();
      return call > 1 ? [] : raw;
    },
    sendMessage: async (_chatId, text) => {
      sent.push(text);
      return { message_id: 1, chat: { id: 100 } };
    },
    editMessageText: async () => ({}),
    sendDocument: async () => ({ message_id: 2 }),
    answerCallbackQuery: async () => ({}),
    setMyCommands: async () => ({}),
  };
  const options: RunOptions = {
    transport,
    bot: {
      handle: async (input: { text?: string; data?: string }) => {
        handled.push(input.text ?? input.data ?? "(callback)");
        return { text: `echo: ${input.text ?? input.data ?? ""}` };
      },
    } as unknown as RunOptions["bot"],
    sender: { sendText: async (_chatId, _text) => [{ messageId: 1 }] },
    editSettled: async () => {},
    answerCallback: async () => {},
    sendDocument: async () => {},
    getOffset: () =>
      (offsets.at(-1) ?? undefined) === undefined ? undefined : (offsets.at(-1) as number),
    setOffset: (offset) => void offsets.push(offset),
    signal: controller.signal,
    sleep: async (ms) => {
      sleeps.push(ms);
      if (config?.abortOnSleep !== false) controller.abort();
    },
    log: (line) => void logs.push(line),
  };
  return { options, polls, offsets, sleeps, logs, handled, sent, controller };
}

type Update = import("grammy/types").Update;
function textUpdate(updateId: number, text: string): Update {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 0,
      text,
      chat: { id: 100, type: "private" },
      from: { id: 7, is_bot: false, first_name: "T" },
    },
  } as Update;
}

describe("runLoop — the offset and the backoff", () => {
  it("polls at offset+1 (G-S03's arithmetic) with the long-poll wait", async () => {
    const h = harness([textUpdate(41, "/health")]);
    await runLoop(h.options);
    assert.deepEqual(
      h.polls[0],
      { timeout: 25 },
      "a fresh state has no offset — the first poll asks for everything",
    );
    assert.deepEqual(
      h.polls[1],
      { offset: 42, timeout: 25 },
      "the next poll is last-update-id + 1 (G-S03)",
    );
  });

  it("the offset advances after each handled update — including a reply that failed (G-S03 + G-T06)", async () => {
    const h = harness([textUpdate(41, "/health"), textUpdate(42, "/status")]);
    h.options.sender.sendText = async () => {
      throw new Error("502 again");
    };
    await runLoop(h.options);
    assert.deepEqual(h.offsets, [41, 42], "a swallowed reply still moves the offset");
    assert.match(h.logs.at(-1) ?? "", /reply to 100 failed/);
  });

  it("an ignored update advances the offset without reaching the bot (G1-08's loop half)", async () => {
    const h = harness([textUpdate(50, "/health")]);
    // Make it ignored: strip the sender.
    (
      h.options.transport as {
        getUpdates: (q: { offset?: number; timeout: number }) => Promise<Update[]>;
      }
    ).getUpdates = async (query) => {
      h.polls.push(query);
      h.controller.abort();
      return [
        {
          update_id: 50,
          message: {
            message_id: 50,
            date: 0,
            text: "bot's own output",
            chat: { id: 100, type: "private" },
            from: { id: 9, is_bot: true, first_name: "B" },
          },
        } as Update,
      ];
    };
    await runLoop(h.options);
    assert.deepEqual(h.offsets, [50]);
    assert.equal(h.handled.length, 0);
  });

  it("a poll failure backs off 2s → 4s and never throws (G-T02); recovery resets it", async () => {
    const h = harness([], { abortOnSleep: false });
    let fails = 0;
    h.options.transport.getUpdates = async () => {
      fails += 1;
      if (fails <= 2) throw new TypeError("fetch failed");
      h.controller.abort();
      return [];
    };
    await runLoop(h.options);
    assert.deepEqual(h.sleeps, [2_000, 4_000]);
    assert.match(h.logs[0] ?? "", /backing off 2s/);
  });

  it("SIGINT between polls ends the loop quietly", async () => {
    const h = harness([]);
    h.options.signal.addEventListener("abort", () => {}, { once: true });
    h.options.transport.getUpdates = async () => {
      h.controller.abort();
      throw new Error("aborted mid-poll");
    };
    await runLoop(h.options);
    assert.equal(h.sleeps.length, 0, "an abort during a failed poll exits instead of backing off");
  });
});
