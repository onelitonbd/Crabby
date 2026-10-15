// The transcript, held to the rules that a static screenshot would not show.
//
// Three of these are the reasons this file exists rather than a `render(events)` function:
//
//   - **A streaming turn is not a row.** D-117 records every turn as it happens; folding each frame into its own row produces
//     a transcript of forty copies of one answer. So an assistant frame updates a *buffer* and only a completion (or a draw)
//     makes it a row.
//   - **A system event is its own row.** T4-10 says it must be "never reachable only by scrolling back", and folding a
//     compaction note into the next message is exactly how it becomes unreachable.
//   - **Held scroll position is state.** T4-12's `new content (3)` note is what a person reads instead of being yanked out
//     of an earlier turn by their own conversation.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyEvent,
  commitStreaming,
  draftEstimate,
  emptyTranscript,
  expandTool,
  heldNote,
  type TranscriptState,
  truncationLabel,
  visibleRows,
} from "./transcript.ts";

const COLUMNS = 40;

function state(): TranscriptState {
  return emptyTranscript(COLUMNS, "none");
}

function added(role: string, content: string, extra: Record<string, unknown> = {}) {
  return applyEvent(state(), {
    type: "message.added",
    payload: { role, content, ordinal: 1, ...extra },
  });
}

describe("a turn", () => {
  it("a user message is a row, wrapped to the pane width", () => {
    const after = added("user", "one two three four five six seven eight nine ten eleven twelve");
    assert.equal(after.rows.length, 1);
    assert.equal(after.rows[0]?.kind, "turn");
    const lines = after.rows[0]?.kind === "turn" ? after.rows[0].lines : [];
    assert.ok(lines.length > 1, "the sentence is wrapped rather than clipped");
  });

  it("an assistant message streams into a buffer, not into a row (T4-05)", () => {
    const after = added("assistant", "partial answer");
    assert.equal(after.rows.length, 0, "not a row yet");
    assert.equal(after.streaming?.text, "partial answer");
  });

  it("the buffer becomes one row when the turn ends", () => {
    const committed = commitStreaming(added("assistant", "the whole answer"));
    assert.equal(committed.rows.length, 1);
    assert.equal(committed.streaming, undefined);
  });

  it("a second frame for the same turn replaces the buffer rather than adding a row", () => {
    let after = applyEvent(state(), {
      type: "message.added",
      payload: { role: "assistant", ordinal: 7, content: "first" },
    });
    after = applyEvent(after, {
      type: "message.added",
      payload: { role: "assistant", ordinal: 7, content: "first and more" },
    });
    assert.equal(after.rows.length, 0);
    assert.equal(after.streaming?.text, "first and more");
    assert.equal(commitStreaming(after).rows.length, 1, "one turn, one row");
  });

  it("a user message commits any turn still streaming, so the order cannot invert", () => {
    let after = applyEvent(state(), {
      type: "message.added",
      payload: { role: "assistant", ordinal: 1, content: "answer" },
    });
    after = applyEvent(after, {
      type: "message.added",
      payload: { role: "user", ordinal: 2, content: "next question" },
    });
    const rows = commitStreaming(after).rows;
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.kind === "turn" ? rows[0].role : "", "assistant");
    assert.equal(rows[1]?.kind === "turn" ? rows[1].role : "", "user");
  });

  it("a frame with no ordinal is ignored rather than rendered as a nameless turn", () => {
    const after = applyEvent(state(), {
      type: "message.added",
      payload: { role: "assistant", content: "x" },
    });
    assert.equal(after.rows.length, 0);
    assert.equal(after.streaming, undefined);
  });

  it("the streaming turn shows a cursor glyph, and the last line when there is one (T4-06)", () => {
    const after = added("assistant", "line one\nline two");
    const rows = visibleRows(after, 10);
    const last = rows.at(-1);
    assert.ok(
      last?.kind === "turn" && String(last.lines.at(-1)).endsWith("▏"),
      JSON.stringify(last),
    );
  });
});

describe("tool lines", () => {
  it("a tool turn is a collapsed line naming the tool, and a refusal says so", () => {
    const refused = applyEvent(state(), {
      type: "message.added",
      payload: {
        role: "tool",
        ordinal: 2,
        content: "denied",
        tool: "config.set",
        tier: "T3",
        refused: true,
      },
    });
    assert.equal(refused.rows.length, 1);
    const row = refused.rows[0];
    assert.ok(row?.kind === "tool" && row.status === "refused", JSON.stringify(row));
    // T4-07's four facts, on one line.
    assert.match(row?.lines[0] ?? "", /config\.set · T3 · refused/);
  });

  it("expanding pages at the row's limit rather than printing everything", () => {
    const row = {
      kind: "tool" as const,
      tool: "shell.run",
      tier: "T3",
      status: "ok",
      expanded: false,
      lines: Array.from({ length: 40 }, (_, i) => `line ${i}`),
    };
    const expanded = expandTool(row);
    assert.ok(expanded.kind === "tool");
    assert.equal(expanded.lines.length, 20);
  });

  it("truncated output is labelled with how much of it there was", () => {
    // An output that stops mid-word with no label reads as the whole output, and that is how a person misses a secret's
    // existence in the tail.
    assert.match(truncationLabel(1024, 4096), /first 1,024 of 4,096 bytes/);
    // Grouped, for the same reason the estimate is: a byte count is read against a limit at a glance.
    assert.equal(truncationLabel(4096, 4096), "4,096 bytes");
  });
});

describe("system and error rows", () => {
  it("a compaction is its own row, in order, not folded into the next message (T4-10)", () => {
    let after = added("user", "a long conversation");
    after = applyEvent(after, {
      type: "message.compacted",
      payload: { summary: "compacted 12 turns into 1" },
    });
    assert.equal(after.rows.length, 2);
    assert.equal(after.rows[1]?.kind, "system");
    assert.match(after.rows[1]?.kind === "system" ? after.rows[1].text : "", /compacted 12 turns/);
  });

  it("a failure is a panel in the list with its code and whether it can resume (T4-11)", () => {
    const after = applyEvent(state(), {
      type: "task.failed",
      payload: { code: "provider_auth", message: "the endpoint refused the key", resumable: true },
    });
    const row = after.rows[0];
    assert.ok(row?.kind === "error", JSON.stringify(row));
    assert.equal(row.code, "provider_auth");
    assert.equal(row.resumable, true);
  });

  it("an unknown event type changes nothing", () => {
    const after = applyEvent(state(), { type: "something.new", payload: {} });
    assert.equal(after.rows.length, 0);
  });
});

describe("the held position (T4-12)", () => {
  it("the note says how much arrived, in the Web's wording", () => {
    assert.equal(heldNote(3), "new content (3) — press End to follow");
    assert.equal(heldNote(1), "new content (1) — press End to follow");
  });

  it("the view is the tail of the rows, so the newest thing is always on screen", () => {
    let after = state();
    for (const index of [1, 2, 3, 4, 5]) {
      after = applyEvent(after, {
        type: "message.added",
        payload: { role: "user", ordinal: index, content: `question ${index}` },
      });
    }
    const shown = visibleRows(after, 2);
    assert.equal(shown.length, 2);
    assert.match(JSON.stringify(shown.at(-1)), /question 5/);
  });
});

describe("the draft estimate (T5-10)", () => {
  it("is labelled an estimate and named as the client's own", () => {
    const text = draftEstimate(400);
    assert.match(text, /est/);
    // The client's arithmetic is D-064's divisor branch and cannot see the conversation, so saying whose number it is matters
    // more than the digits.
    assert.match(text, /Gateway's own number may differ/);
  });
});
