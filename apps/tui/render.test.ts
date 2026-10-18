// The renderer's plan, held to the three properties a screen depends on.
//
// P-011's budget is the reason most of this file exists: a streaming answer must not repaint the world per token, so
// "unchanged writes nothing" and "changed writes only the changed lines" are not niceties — they are the budget. A
// renderer that redraws on every poll would spend it whether anything happened or not, and on a phone the frame rate is
// the difference between typing and waiting.
//
// The third property is the one D-061's inline mode creates: a shrinking frame must never move the cursor above where it
// started, because above the frame is the user's scrollback. A test that only checked the output text would not catch a
// renderer that erased a terminal's history, so the plan is checked for the cursor arithmetic as well.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type FramePlan,
  FrameRenderer,
  fit,
  planFrame,
  type Terminal,
  visibleWidth,
} from "./render.ts";

function planText(previous: readonly string[], next: readonly string[], columns = 40): string {
  return planFrame(previous, next, columns).text;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: these assertions are about the escape sequences this renderer writes
const UP = /\u001b\[(\d+)A/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ditto — the clear that precedes every rewritten line
const CLEAR = /\u001b\[2K/g;

/** The upward moves in a plan, in order. Counting them is how "never past the frame's first row" is checked without a pty. */
function ups(text: string): readonly number[] {
  return [...text.matchAll(UP)].map((match) => Number(match[1] ?? "0"));
}

describe("planFrame", () => {
  it("writes nothing when nothing changed", () => {
    const lines = ["one", "two", "three"];
    assert.equal(planText(lines, ["one", "two", "three"]), "");
    assert.equal(planFrame(lines, lines, 40).height, 3);
  });

  it("writes one line when one line changed, and does not touch the others", () => {
    const text = planText(["a", "b", "c"], ["a", "B", "c"]);
    assert.match(text, /B/);
    // `c` is not rewritten: P-011's budget is spent where something moved, and a rewrite of an unchanged line is the
    // flicker `docs/UI_UX_SPEC.md` §4 calls a real usability bug on a slow terminal.
    assert.ok(!text.includes("c\r"), text);
    assert.ok(!text.includes("a\r"), text);
  });

  it("moves up to the line it is rewriting, counting from the frame's last row", () => {
    // The cursor sits *on* a 3-row frame's last row (a plan writes no trailing newline), so line 0 is 2 rows up and line 2
    // is the current row. The tempting off-by-one — counting "below the frame" — makes every move one row short, so the
    // frame rewrites the line *after* the one it meant to: a screen that looks plausible and is wrong.
    assert.deepEqual(ups(planText(["a", "b", "c"], ["A", "b", "c"])), [2]);
    assert.deepEqual(
      ups(planText(["a", "b", "c"], ["a", "b", "C"])),
      [],
      "the last row is the current row",
    );
  });

  it("clears a rewritten line before writing it", () => {
    // Without the clear, a shorter new line leaves the tail of the longer old one visible beside it, and the frame lies
    // about its own width.
    const text = planText(["aaaaaaaaaa", "b"], ["a", "b"]);
    assert.equal((text.match(CLEAR) ?? []).length, 1);
  });

  it("erases the lines a shorter frame no longer occupies", () => {
    const text = planText(["a", "b", "c", "d"], ["a", "b"]);
    // Two extra clears: the taller frame's ghosts stay on screen otherwise, and the next taller frame grows into them.
    assert.equal((text.match(CLEAR) ?? []).length, 2);
  });

  it("never reaches above the frame, whatever the previous frame was", () => {
    // D-061's inline mode promises scrollback survives. A frame that moved the cursor further up than its own height
    // would rewrite the user's terminal history, which is the one thing the alternate screen was refused to cost.
    const tall = Array.from({ length: 12 }, (_, i) => `line ${i}`);
    const short = Array.from({ length: 2 }, (_, i) => `new ${i}`);
    const text = planText(tall, short);
    const ups = [...text.matchAll(UP)].map((m) => Number(m[1] ?? "0"));
    assert.ok(
      ups.every((up) => up <= tall.length - 1),
      `moved up ${Math.max(...ups)} on a ${tall.length}-row frame`,
    );
  });

  it("an empty frame is a teardown, not a crash", () => {
    const plan = planFrame(["a", "b"], [], 40);
    assert.equal(plan.height, 0);
    assert.notEqual(plan.text, "");
  });

  it("grows upward into rows it had not occupied", () => {
    const text = planText(["a"], ["a", "b", "c"]);
    assert.match(text, /b/);
    assert.match(text, /c/);
  });
});

describe("fit and visibleWidth", () => {
  it("clips to the terminal width and says so with an ellipsis", () => {
    const fitted = fit("x".repeat(60), 40);
    assert.equal(visibleWidth(fitted), 40);
    assert.match(fitted, /…$/);
  });

  it("measures a coloured line by what a person sees", () => {
    const coloured = "\u001b[36mgreen\u001b[0m";
    assert.equal(visibleWidth(coloured), 5);
    // A coloured line clipped mid-sequence would leave the terminal in that colour for the rest of the screen, so the
    // sequences are dropped rather than split.
    assert.equal(visibleWidth(fit(coloured + "y".repeat(60), 10)), 10);
  });

  it("never returns zero columns, because a zero-width cell is not a cell", () => {
    assert.equal(visibleWidth(fit("abc", 0)), 1);
  });
});

describe("FrameRenderer", () => {
  function fake(columns = 40, rows = 24) {
    const written: string[] = [];
    const terminal: Terminal = { columns, rows, write: (t) => written.push(t) };
    return { terminal, written, renderer: new FrameRenderer(terminal) };
  }

  it("draws once and not again for the same frame", () => {
    const { renderer, written } = fake();
    renderer.drawNow(["a"]);
    const after = written.length;
    renderer.drawNow(["a"]);
    assert.equal(written.length, after, "an unchanged frame writes nothing");
  });

  it("holds P-011's cap and still draws the last frame", () => {
    const { renderer, written } = fake();
    renderer.draw(["one", "two"], 1000);
    renderer.draw(["one", "two"], 1100);
    assert.equal(written.length, 1, "250 ms is the floor between repaints (P-011)");
    // The point of the cap: a repaint that *drops* the lines would lose the end of an answer, so the frame is held and
    // written as soon as the interval passes.
    renderer.draw(["one", "TWO"], 1400);
    assert.match(written.join(""), /TWO/);
  });

  it("the first frame is exempt from the cap, so a startup is not a blank terminal (T1-09)", () => {
    const { renderer, written } = fake();
    renderer.draw(["ready"], 1000);
    assert.equal(written.length, 1);
    renderer.draw(["ready"], 1001);
    assert.equal(written.length, 1, "nothing changed, so nothing was written");
  });

  it("pushes text into scrollback and leaves the frame empty", () => {
    const { renderer, written } = fake();
    renderer.drawNow(["a", "b"]);
    renderer.printToScrollback("copied output");
    const last = written.at(-1) ?? "";
    assert.match(last, /copied output/);
    assert.equal(renderer.height, 0);
  });

  it("makes room for a frame taller than the screen instead of wrapping into it", () => {
    const { renderer, written } = fake(40, 10);
    renderer.ensureRoom(24);
    // Inline means the terminal scrolls when the cursor reaches the last row. The alternative — the alternate screen — is
    // what D-061 refused, so the cost is paid here and named.
    assert.ok(written.join("").includes("\n"), "the frame gets rows by scrolling");
  });

  it("does not make room for a frame that fits", () => {
    const { renderer, written } = fake(40, 24);
    renderer.ensureRoom(8);
    assert.equal(written.length, 0);
  });

  it("reports the frame height it last drew", () => {
    const { renderer } = fake();
    renderer.drawNow(["a", "b", "c"]);
    assert.equal(renderer.height, 3);
  });

  it("anchors the first frame to a full screen, so startup lines cannot push the pinned rows off the bottom", () => {
    // The owner's canvas: a 30-row terminal where the shell prompt and `connecting…` already sit above the cursor.
    // Without the anchor, a 30-row frame drawn from row 2 runs two rows past the bottom, where CSI B clamps and the
    // status line and hint strip overwrite each other — the two rows T2/T3 say must always be true.
    const { renderer, written } = fake(63, 30);
    renderer.drawNow([">chat", "body", "status", "hints"]);
    const first = written[0] ?? "";
    assert.match(first, /\x1b\[999B/, "the walk to the bottom row (clamped wherever the cursor was)");
    assert.match(first, /\n{30}/, "one scroll per frame row — everything above goes to the scrollback");
    assert.match(first, /\x1b\[29A/, "back up to the frame's first row before the plan writes");
    // The second draw anchors nothing: the frame now owns its region.
    const before = written.length;
    renderer.drawNow([">chat", "body two", "status", "hints"]);
    assert.equal(written.length, before + 1, "the change itself is one diffed write");
    assert.ok(!written.at(-1)?.includes("999B"), "no second anchor");
  });
});

describe("T5-02's real cursor", () => {
  it("the plan reports the row its writes leave the cursor on", () => {
    // Only the middle line changes: the writes end there, and the reported row is that row — not the frame's last.
    const plan = planFrame(["a", "b", "c"], ["a", "B", "c"], 40);
    assert.equal(plan.cursorRow, 1);
    // A frame that changed nothing writes nothing and invents no position (-1): the renderer keeps its own.
    const same = planFrame(["a", "b"], ["a", "b"], 40);
    assert.equal(same.cursorRow, -1);
    assert.equal(same.text, "");
  });

  it("placeCursor moves from where the last plan left the cursor and shows it", () => {
    const writes: string[] = [];
    const terminal: Terminal = {
      columns: 40,
      rows: 10,
      write: (text) => writes.push(text),
    };
    const renderer = new FrameRenderer(terminal);
    renderer.drawNow(["alpha", "bravo", "charlie"]);
    writes.length = 0;
    // Row 1, column 3 of a 3-row frame: up one row from the plan's final row (2), then to the column.
    renderer.placeCursor(1, 3);
    const text = writes.join("");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the sequences under test
    assert.match(text, /\u001b\[1A/, text);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the sequences under test
    assert.match(text, /\u001b\[4G/, text);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the sequences under test
    assert.match(text, /\u001b\[\?25h/, text);
    // Clamped inside the frame: a row past the end lands on the frame's last row — down one from row 1 — and cannot
    // park a cursor in the scrollback below it.
    writes.length = 0;
    renderer.placeCursor(99, 0);
    assert.equal(renderer.height, 3);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the sequences under test
    assert.match(writes.join(""), /\u001b\[1B/);
  });
});

describe("the plan is a value, not a side effect", () => {
  it("planFrame does not touch the terminal it was not given", () => {
    // The purity is what lets the tests above assert on cursor arithmetic without a pty, and it is the same reason the
    // pane layer takes data rather than a terminal.
    const plan: FramePlan = planFrame(["a"], ["b"], 40);
    assert.equal(typeof plan.text, "string");
    assert.deepEqual(plan.lines, ["b"]);
  });
});
