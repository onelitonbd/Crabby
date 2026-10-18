// Tests for the chat view's OpenClaw-shaped skin (apps/tui/chatview.ts, wired through panes.chatPane's `style`).
// The accepted rows in docs/review/TUI.md are the contract the skin had to keep: T4-01's zero-gutter selection,
// T4-02's model on the assistant turn's first line, T4-07's one-line tool card, T5-06's capability line last — and
// §4's rule that the `none` tier gets words, never escapes. The 63×30 terminal is the owner's canvas; the bar
// arithmetic is asserted at exactly that width.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assistantHeader,
  dimLine,
  PROMPT,
  toolMark,
  userBarLine,
  welcomeLines,
} from "./chatview.ts";
import { emptyComposer } from "./composer.ts";
import { FRAME_CHROME_ROWS, type FrameState, frameLines } from "./frame.ts";
import { type ChatStyle, chatPane } from "./panes.ts";
import { visibleWidth } from "./render.ts";
import { addSystem, emptyTranscript } from "./transcript.ts";

const CAPS = { fs: "workspace", net: false, shell: false };
const style256: ChatStyle = { tier: "256", model: "groq/llama-3.3-70b", session: "main" };
const bg256 = "\u001b[48;5;235m";
const RESET = "\u001b[0m";
const COLUMNS = 63;
const ROWS = 30;

function userTranscript(tier: "256" | "none" = "256") {
  let transcript = emptyTranscript(COLUMNS, tier);
  transcript = addSystem(transcript, "session started");
  return transcript;
}

describe("chatview: the user bar (T4-01, OpenClaw's full-width surface)", () => {
  it("draws a bar that measures exactly the terminal width — 63 here — with the text at column 0", () => {
    const line = userBarLine("a question about the roadmap", "256", COLUMNS);
    assert.equal(visibleWidth(line), COLUMNS, line);
    assert.ok(line.includes(bg256), "the 256-tier background is bg.raised's cousin");
    assert.ok(line.includes("a question about the roadmap"));
    // zero-gutter selection: no character precedes the text (T4-01's ≤2, taken to 0)
    assert.ok(line.startsWith(bg256));
  });

  it("punches no hole in the bar when markdown attributes reset inside it", () => {
    const attributed = `\u001b[36mcode\u001b[0m tail`;
    const line = userBarLine(attributed, "256", COLUMNS);
    assert.equal(visibleWidth(line), COLUMNS);
    assert.ok(line.includes(`${RESET}${bg256}`), "every inner reset re-opens the bar's background");
  });

  it("keeps the │ gutter in the none tier — words, never escapes (§4)", () => {
    const line = userBarLine("plain", "none", COLUMNS);
    assert.equal(line, "│ plain");
    assert.ok(!line.includes("\u001b"));
  });

  it("uses inverse video in the 16-colour tier", () => {
    assert.ok(userBarLine("x", "ansi", COLUMNS).includes("\u001b[7m"));
  });

  it("keeps measuring true through the whole pane at 63 columns", () => {
    let transcript = userTranscript();
    transcript = {
      ...transcript,
      rows: [
        { kind: "turn", role: "user", ordinal: 1, lines: ["where is the roadmap?"], width: 21 },
      ],
    };
    const lines = chatPane(transcript, emptyComposer(), CAPS, COLUMNS, 27, [], false, style256);
    const bar = lines.find((line) => line.includes("where is the roadmap?"));
    assert.ok(bar, "the bar is drawn");
    assert.equal(visibleWidth(bar), COLUMNS, "the bar survives chatPane at its full width");
  });
});

describe("chatview: assistant turns (T4-02's model header)", () => {
  it("puts the model on the turn's first line, dimmed", () => {
    const header = assistantHeader("groq/llama-3.3-70b", "256");
    assert.ok(header.includes("groq/llama-3.3-70b"));
    assert.ok(header.includes("\u001b[2m"), "the header is dim, not loud");
  });

  it("keeps the words and drops the dimming in the none tier", () => {
    assert.equal(assistantHeader("groq/llama-3.3-70b", "none"), "── groq/llama-3.3-70b");
  });

  it("the pane draws the header only when the model is a fact it holds", () => {
    const rows = [
      { kind: "turn", role: "assistant", ordinal: 1, lines: ["five decisions"], width: 14 },
    ] as const;
    const withModel = chatPane(
      { ...userTranscript(), rows: [...rows] },
      emptyComposer(),
      CAPS,
      COLUMNS,
      27,
      [],
      false,
      style256,
    );
    assert.ok(
      withModel.some((line) => line.includes("── groq/llama-3.3-70b")),
      "the model header appears above the turn",
    );
    const withoutModel = chatPane(
      { ...userTranscript(), rows: [...rows] },
      emptyComposer(),
      CAPS,
      COLUMNS,
      27,
      [],
      false,
      { tier: "none" },
    );
    assert.ok(
      !withoutModel.some((line) => line.includes("──")),
      "no model fact, no model line — never a guess",
    );
    assert.ok(withoutModel.some((line) => line.includes("five decisions")));
  });
});

describe("chatview: tool marks and quiet lines", () => {
  it("marks collapsed ◇ and expanded ◆ around the contract text", () => {
    assert.equal(toolMark(true), "◇ ");
    assert.equal(toolMark(false), "◆ ");
  });

  it("dims the held note without changing its words (T4-12)", () => {
    const dim = dimLine("  new content (3) — press End to follow", "256");
    assert.ok(dim.includes("new content (3)"));
    assert.ok(dim.includes("\u001b[2m"));
    assert.equal(dimLine("x", "none"), "x");
  });

  it("the prompt mark is two columns, and the composer's first line wears it", () => {
    assert.equal(visibleWidth(PROMPT), 2);
    const lines = chatPane(userTranscript("none"), emptyComposer(), CAPS, COLUMNS, 27, [], false, {
      tier: "none",
    });
    assert.ok(
      lines.some((line) => line.startsWith(PROMPT)),
      `the composer opens with the prompt: ${lines.join(" | ")}`,
    );
  });
});

describe("chatview: the welcome block (T6-06 — a pane that says nothing teaches nothing)", () => {
  it("three lines: the crab, the session and model, the keys", () => {
    const lines = welcomeLines("groq/llama-3.3-70b", "main", "256");
    assert.equal(lines.length, 3);
    assert.ok(lines[0]?.includes("🦀"));
    assert.ok(lines[1]?.includes("session main") && lines[1]?.includes("groq/llama-3.3-70b"));
    assert.ok(lines[2]?.includes("Enter sends") && lines[2]?.includes("Ctrl+J"));
  });

  it("an absent model is a sentence, not a blank", () => {
    const lines = welcomeLines(undefined, undefined, "none");
    assert.ok(lines[1]?.includes("no model yet — /model picks one"));
  });

  it("the pane shows it only while the conversation is empty", () => {
    const empty = chatPane(
      emptyTranscript(COLUMNS, "none"),
      emptyComposer(),
      CAPS,
      COLUMNS,
      27,
      [],
      false,
      { tier: "none" },
    );
    assert.ok(empty.some((line) => line.includes("🦀 crabby")));
    const started = chatPane(
      userTranscript("none"),
      emptyComposer(),
      CAPS,
      COLUMNS,
      27,
      [],
      false,
      { tier: "none" },
    );
    assert.ok(
      !started.some((line) => line.includes("🦀 crabby")),
      "said hello once, no crabs again",
    );
  });
});

describe("chatview: the pane's standing contracts under the skin", () => {
  it("the capability line is still last (T5-06), and the tool card keeps its text with a glyph", () => {
    let transcript = userTranscript();
    transcript = {
      ...transcript,
      rows: [
        {
          kind: "tool",
          tool: "read_file",
          tier: "T1",
          status: "ok",
          expanded: false,
          lines: ["read_file · T1 · ok · 12ms"],
        },
      ],
    };
    const lines = chatPane(transcript, emptyComposer(), CAPS, COLUMNS, 27, [], false, style256);
    assert.equal(lines.at(-1), "fs: workspace · net: off · shell: off");
    const tool = lines.find((line) => line.includes("read_file · T1 · ok · 12ms"));
    assert.ok(tool?.includes("◇ "), "collapsed cards carry the closed glyph");
  });

  it("the default style is the plain skin, so every pre-skin caller sees what it always saw", () => {
    const withTurn = {
      ...userTranscript("none"),
      rows: [{ kind: "turn", role: "user", ordinal: 1, lines: ["plain question"], width: 14 }],
    } as const;
    const lines = chatPane(withTurn, emptyComposer(), CAPS, 40, 24);
    assert.ok(lines.some((line) => line.startsWith("│")));
    assert.ok(!lines.some((line) => line.includes("\u001b")));
  });
});

describe("chatview: the whole frame at the owner's canvas, 63×30", () => {
  it("returns exactly 30 lines with the chat body wearing the skin", () => {
    let transcript = userTranscript();
    transcript = {
      ...transcript,
      rows: [
        { kind: "turn", role: "user", ordinal: 1, lines: ["hello crabby"], width: 12 },
        {
          kind: "turn",
          role: "assistant",
          ordinal: 2,
          lines: ["hello — five decisions"],
          width: 22,
        },
      ],
    };
    const body = chatPane(
      transcript,
      emptyComposer(),
      CAPS,
      COLUMNS,
      ROWS - FRAME_CHROME_ROWS,
      [],
      false,
      style256,
    );
    const state: FrameState = {
      pane: "chat",
      panes: ["chat", "tasks", "jobs", "approvals", "logs", "models"],
      status: { connection: "live", model: "groq/llama-3.3-70b" },
      body,
      color: "256",
    };
    const lines = frameLines(state, COLUMNS, ROWS);
    assert.equal(lines.length, ROWS, `${lines.length} lines at ${COLUMNS}×${ROWS}`);
    assert.ok(lines[0]?.startsWith(">chat"), "the pane row opens the frame");
    assert.ok(lines.some((line) => line.includes("hello — five decisions")));
    assert.ok(
      lines.some((line) => line.includes("── groq/llama-3.3-70b")),
      "the model header survives the frame at 63 columns",
    );
  });
});
