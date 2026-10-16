// The transport is the only file that knows Telegram's wire; these tests hold its two honest behaviors — which
// updates are addressed to us (G1-08), and which failures are worth another attempt (G4-06's input).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Update } from "grammy/types";
import { addressUpdate, isRetryable } from "./transport.ts";

function message(
  from: { id: number; is_bot?: boolean } | undefined,
  text?: string,
  chatId = 100,
): Update {
  return {
    update_id: 7,
    message: {
      message_id: 1,
      date: 0,
      text,
      chat: { id: chatId, type: chatId < 0 ? "group" : "private" },
      ...(from === undefined
        ? {}
        : { from: { id: from.id, is_bot: from.is_bot ?? false, first_name: "T" } }),
    },
  } as Update;
}

describe("addressUpdate (G1-08) — whose words are these", () => {
  it("a human's private text is addressed", () => {
    const addressed = addressUpdate(message({ id: 7, is_bot: false }, "hello"));
    assert.equal(addressed?.text, "hello");
    assert.equal(addressed?.userId, "7");
  });

  it("another bot's message is ignored — bots do not converse (G1-08)", () => {
    assert.equal(addressUpdate(message({ id: 8, is_bot: true }, "/status"))?.kind, "ignored");
  });

  it("an update without a sender, or without text, collapses to ignored before the gate runs", () => {
    assert.equal(addressUpdate(message(undefined, "ghost"))?.kind, "ignored");
    assert.equal(addressUpdate(message({ id: 7 }, undefined))?.kind, "ignored");
  });

  it("a callback is addressed by its data, even with empty data", () => {
    const update = {
      update_id: 9,
      callback_query: {
        id: "cb",
        from: { id: 7, is_bot: false, first_name: "T" },
        chat_instance: "ci",
        data: undefined,
      },
    } as unknown as Update;
    const addressed = addressUpdate(update);
    assert.equal(addressed?.kind, "callback");
    assert.equal(addressed?.text, undefined);
  });
});

describe("isRetryableError (G4-06's decision input)", () => {
  it("a 429 and a 5xx are the API's fault; a 4xx is ours", () => {
    assert.equal(isRetryable({ error_code: 429, message: "Too Many Requests" }), true);
    assert.equal(isRetryable({ error_code: 502, message: "bad gateway" }), true);
    assert.equal(isRetryable({ error_code: 400, message: "chat not found" }), false);
    assert.equal(isRetryable({ error_code: 403, message: "bot was blocked" }), false);
  });

  it("a network-shaped throw (no code) is retryable — including unrecognizable shapes, bounded by the sender's one-retry cap", () => {
    assert.equal(isRetryable(new TypeError("fetch failed")), true);
    assert.equal(isRetryable("some string"), true);
  });
});
