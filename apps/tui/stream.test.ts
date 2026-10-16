// The stream reader's parsing, held to the two failures that are worse than a crash.
//
// **A frame split across two reads must not be parsed twice.** A pty delivers whatever arrived, so `\u001b[2m` and the rest
// can be two chunks; parsing early would invent an event and parsing the whole buffer without a separator check would lose
// one. The rule is that only text up to the last blank-line separator is consumed — the same rule the CLI's `task watch`
// reader follows, and for the same reason.
//
// **A malformed frame is dropped, not guessed.** `{"type":"message.added"` with no closing brace becomes *no* frame. The
// alternative — handing the half-parsed text to the transcript — produces a line in a conversation that a run never said,
// and a transcript is the record of what a run said (D-117).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHAT_TYPES, parseFrame } from "./stream.ts";

const frame = (lines: readonly string[]): string => lines.join("\n");

describe("parseFrame", () => {
  it("reads the event name and the payload", () => {
    const parsed = parseFrame(
      frame([
        "event: message.added",
        'data: {"seq":7,"type":"message.added","payload":{"role":"assistant","content":"hi"}}',
      ]),
    );
    assert.equal(parsed?.type, "message.added");
    assert.equal(parsed?.seq, 7);
    assert.equal(parsed?.payload?.role, "assistant");
  });

  it("takes the type from the data when the frame names none", () => {
    const parsed = parseFrame(frame(['data: {"type":"task.completed","payload":{}}']));
    assert.equal(parsed?.type, "task.completed");
  });

  it("ignores comments and blank lines", () => {
    // Keep-alives are `:` comments; a TUI that counted them as frames would fill the transcript with nothing.
    assert.equal(parseFrame(": keep-alive"), undefined);
    assert.equal(parseFrame(frame([": ping", "", 'data: {"type":"x"}']))?.type, "x");
  });

  it("joins a multi-line data field rather than parsing half of it", () => {
    const parsed = parseFrame(
      frame(['data: {"type":"message.added",', 'data: "payload":{"role":"user"}}']),
    );
    assert.equal(parsed?.type, "message.added");
    assert.equal(parsed?.payload?.role, "user");
  });

  it("drops a malformed frame instead of inventing a line", () => {
    assert.equal(parseFrame('data: {"type":"message.added"'), undefined);
    assert.equal(parseFrame("data: not json"), undefined);
    // …and a frame with no `data:` line at all is nothing, not an empty event.
    assert.equal(parseFrame("event: message.added"), undefined);
  });

  it("reports an unknown type rather than dropping the frame", () => {
    // A TUI built against an older Gateway must *see* the event it does not know: `applyEvent` ignores what it does not
    // recognise, and a reader that threw it away would make a future event invisible instead of merely unhandled.
    const parsed = parseFrame('data: {"type":"something.new","payload":{"a":1}}');
    assert.equal(parsed?.type, "something.new");
  });
});

describe("the families the chat pane asks for", () => {
  it("includes the tool families, because a tool call is not a message", () => {
    // T4-07/T4-08 ask for a tool line, and a transcript built from `message.added` alone would show the model's words and
    // none of the work it did.
    assert.ok(CHAT_TYPES.includes("tool.started"));
    assert.ok(CHAT_TYPES.includes("tool.finished"));
  });

  it("includes the terminal families, so the pane knows when a run ended", () => {
    for (const type of ["task.completed", "task.failed", "task.cancelled", "task.interrupted"]) {
      assert.ok(CHAT_TYPES.includes(type as (typeof CHAT_TYPES)[number]), type);
    }
  });

  it("includes the approval family, because a prompt in a chat is a real pause (D-084)", () => {
    assert.ok(CHAT_TYPES.includes("approval.requested"));
  });
});
