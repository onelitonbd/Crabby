// Tests for the onboard TUI primitives (apps/cli/onboard-ui.ts). Everything the wizard draws is a pure function
// of (state, palette) — so the tests assert on exact glyph output, the way a terminal would receive it, plus the
// two behavioural promises: pipes get no colour (§6), and arrow movement wraps.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  banner,
  colorEnabled,
  menuLines,
  moveSelection,
  palette,
  pick,
  rail,
  type StepState,
  visibleWidth,
} from "../../apps/cli/onboard-ui.ts";

const plain = palette(false);
const color = palette(true);

describe("onboard-ui colour gate", () => {
  it("gives a pipe the identity palette (§6: colour is TTY-only)", () => {
    assert.equal(colorEnabled({ isTTY: false }), false);
    assert.equal(plain.cyan("x"), "x");
    assert.equal(plain.bold("crab"), "crab");
    assert.equal(plain.inverse("inv"), "inv");
  });

  it("colours only a real TTY without NO_COLOR", () => {
    assert.equal(colorEnabled({ isTTY: true }), true);
    assert.equal(
      colorEnabled({ isTTY: true, env: { NO_COLOR: "1" } } as never),
      false,
      "NO_COLOR is honoured even on a TTY",
    );
    assert.equal(color.cyan("x"), "\x1b[36mx\x1b[0m");
  });
});

describe("onboard-ui drawing", () => {
  it("measures visible width through SGR escapes", () => {
    assert.equal(visibleWidth("abc"), 3);
    assert.equal(visibleWidth(`${color.green("abc")}`), 3);
  });

  it("draws a banner whose frame lines all share one width", () => {
    const lines = banner(plain);
    assert.ok(
      lines.some((line) => line.includes("🦀")),
      "the crab is on the banner",
    );
    const widths = new Set(lines.map((line) => visibleWidth(line)));
    assert.equal(widths.size, 1, `frame lines should match: ${[...widths].join(",")}`);
    assert.ok(lines[0]?.startsWith("╭"));
    assert.ok(lines.at(-1)?.startsWith("╰"));
  });

  it("draws the step rail with done/now/pending/failed glyphs", () => {
    const lines = rail(
      [
        { name: "environment", state: "done" as StepState },
        { name: "model path", state: "now" as StepState },
        { name: "pairing", state: "pending" as StepState },
        { name: "shell", state: "failed" as StepState },
      ],
      plain,
    );
    assert.ok(lines[0] && lines[1] && lines[2] && lines[3], "one rail line per step");
    assert.match(lines[0], /✓/);
    assert.match(lines[1], /●/);
    assert.match(lines[2], /○/);
    assert.match(lines[3], /✗/);
  });

  it("marks exactly the selected menu row (❯ and inverse both, so it survives colour loss)", () => {
    const options = [
      { label: "Set up a provider now" },
      { label: "Skip for now", hint: "decide later" },
    ];
    const lines = menuLines("Pick", options, 1, plain);
    assert.equal(lines[0], "Pick", "the title is the first line");
    assert.ok(lines[1], "title + two rows + footer");
    assert.ok(lines[2]);
    assert.match(
      lines[1],
      /^ {3}Set up a provider now/,
      "unselected rows carry a blank cursor column",
    );
    assert.match(lines[2], /^ ❯ Skip for now/);
    assert.ok(lines[3], "the hint gets its own indented line under the row");
    assert.match(lines[3], /decide later/, "the hint — the one-line consequence — is on screen");
    const coloured = menuLines("Pick", options, 1, color)[2];
    assert.ok(coloured);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the SGR inverse sequence is exactly what is asserted.
    assert.match(coloured, /\x1b\[7m/, "the selected row is inverse on a TTY");
  });
});

describe("onboard-ui arrow movement", () => {
  const at = (selected: number, key: string, count = 3): number =>
    moveSelection(selected, key, count);

  it("moves down/up and wraps at both ends", () => {
    assert.equal(at(0, "down"), 1);
    assert.equal(at(2, "down"), 0, "down from the last row wraps to the first");
    assert.equal(at(0, "up"), 2, "up from the first row wraps to the last");
    assert.equal(at(1, "up"), 0);
  });

  it("accepts vim keys as aliases", () => {
    assert.equal(at(0, "j"), 1);
    assert.equal(at(1, "k"), 0);
  });

  it("leaves the selection alone for any other key and never escapes the range", () => {
    assert.equal(at(1, "escape"), 1);
    assert.equal(at(1, "left"), 1);
    assert.equal(moveSelection(0, "down", 1), 0, "a one-row menu cannot move");
  });
});

describe("onboard-ui pick", () => {
  it("is non-interactive on a pipe: cancelled, no prompt ever written (§6)", async () => {
    if (process.stdin.isTTY) return; // guard for the rare local TTY test run
    const result = await pick("Pick", [{ label: "a" }, { label: "b" }], plain);
    assert.deepEqual(result, { index: -1, cancelled: true });
  });
});
