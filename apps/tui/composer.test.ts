// The composer, held to T5-A's asymmetry and to the two rules that are about correctness rather than layout.
//
// The first test is the one that matters most in this file: **`Enter` sends and `Ctrl+J` inserts a newline**, and both are
// one byte apart. A composer that treats them as one either loses the newline key D-061 promised or inserts a newline when
// the person meant to send — and on a phone keyboard, where Ctrl+J is a different key from Enter, one of those two mistakes
// is the difference between a working composer and an unusable one.
//
// The rest: `↑` is history only when the buffer is empty (T5-09's clause about not stealing the scroll key), the input area
// grows to six lines and then reports that it scrolled (T5-01), the slash menu filters as typed and lists only commands that
// also exist in the Web (T5-03 and parity §8), and the capability line is printed *before* the send with words rather than
// marks (T5-06).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  actionFor,
  applyAction,
  capabilityLine,
  composerView,
  emptyComposer,
  filterSlash,
  MAX_COMPOSER_LINES,
  modelSwitchWarning,
  slashMenuLines,
} from "./composer.ts";

describe("T5-A's asymmetry", () => {
  it("Enter sends and Ctrl+J is the newline", () => {
    assert.deepEqual(actionFor({ kind: "enter" }, false), { kind: "send" });
    assert.deepEqual(actionFor({ kind: "ctrl", letter: "j" }, false), { kind: "newline" });
  });

  it("a newline is inserted only by Ctrl+J, and the cursor moves past it", () => {
    const typed = applyAction(emptyComposer(), { kind: "insert", text: "one" }, undefined);
    const withNewline = applyAction(typed, { kind: "newline" }, undefined);
    assert.equal(withNewline.buffer, "one\n");
    assert.equal(withNewline.cursor, 4);
  });

  it("an unknown sequence is named with its bytes rather than swallowed", () => {
    // A kitty terminal's Shift+Enter arrives here. Dropping it loses a newline; guessing inserts one where the person
    // meant to send.
    const action = actionFor({ kind: "unknown", bytes: "\u001b[13;2u" }, false);
    assert.deepEqual(action, { kind: "unbound", bytes: "\u001b[13;2u" });
    // …and it changes nothing about the buffer.
    assert.equal(applyAction(emptyComposer(), action, undefined).buffer, "");
  });

  it("a backspace at the start of the buffer changes nothing rather than wrapping", () => {
    const state = applyAction(emptyComposer(), { kind: "backspace" }, undefined);
    assert.equal(state.buffer, "");
    assert.equal(state.cursor, 0);
  });

  it("inserts in the middle at the cursor, which is where the person is looking", () => {
    let state = applyAction(emptyComposer(), { kind: "insert", text: "ac" }, undefined);
    state = applyAction(state, { kind: "left" }, undefined);
    state = applyAction(state, { kind: "insert", text: "b" }, undefined);
    assert.equal(state.buffer, "abc");
  });
});

describe("T5-09's history does not steal the scroll key", () => {
  it("`↑` is history when the buffer is empty", () => {
    assert.deepEqual(actionFor({ kind: "up" }, true), { kind: "history", previous: undefined });
  });

  it("`↑` is ignored when there is text to scroll away from", () => {
    assert.deepEqual(actionFor({ kind: "up" }, false), { kind: "ignore" });
  });

  it("a restored input replaces the buffer and puts the cursor at its end", () => {
    const state = applyAction(
      emptyComposer(),
      { kind: "history", previous: undefined },
      "earlier question",
    );
    assert.equal(state.buffer, "earlier question");
    assert.equal(state.cursor, "earlier question".length);
  });

  it("history with nothing to restore leaves the buffer alone", () => {
    assert.equal(
      applyAction(emptyComposer(), { kind: "history", previous: undefined }, undefined).buffer,
      "",
    );
  });
});

describe("T5-01's input area", () => {
  it("grows to six lines and then reports that it scrolled", () => {
    let state = emptyComposer();
    for (let index = 0; index < 9; index += 1) {
      state = applyAction(state, { kind: "insert", text: `line ${index}` }, undefined);
      state = applyAction(state, { kind: "newline" }, undefined);
    }
    const view = composerView(state, 40);
    assert.equal(view.lines.length, MAX_COMPOSER_LINES);
    // The newest *text* is on screen, the cursor's line is the empty one after it, and the oldest lines are gone: the
    // person is typing, so the cursor has to be in view and the rest must not push it out.
    assert.ok(
      view.lines.some((line) => line.startsWith("line 8")),
      view.lines.join(" | "),
    );
    assert.ok(view.lines.at(-1)?.includes("\u258f"), view.lines.at(-1) ?? "");
    assert.ok(
      view.hiddenAbove > 0,
      "a scrolled input says so rather than pretending the text is complete",
    );
  });

  it("the cursor lands on the line the edit position is on", () => {
    let state = applyAction(emptyComposer(), { kind: "insert", text: "one" }, undefined);
    state = applyAction(state, { kind: "newline" }, undefined);
    state = applyAction(state, { kind: "insert", text: "two" }, undefined);
    const view = composerView(state, 40);
    assert.equal(view.cursorLine, 1, "the edit position is on the second line");
    assert.equal(
      view.lines[1],
      "two\u258f",
      "the glyph marks the position after the text typed on that line",
    );
  });

  it("does not count a newline as a column", () => {
    // The buffer's cursor index and the drawn column differ by the newlines before it; a composer that used the buffer index
    // as a column would put the cursor one place right for every line after the first.
    let state = applyAction(emptyComposer(), { kind: "insert", text: "ab" }, undefined);
    state = applyAction(state, { kind: "newline" }, undefined);
    state = applyAction(state, { kind: "insert", text: "cd" }, undefined);
    state = applyAction(state, { kind: "left" }, undefined);
    const view = composerView(state, 40);
    assert.match(view.lines[1] ?? "", /^c\u258fd$/);
  });
});

describe("T5-03's slash menu", () => {
  it("filters as typed, `/attach` the sixth the menu's own cap has room for", () => {
    assert.deepEqual(filterSlash("/"), [
      "/model",
      "/compact",
      "/pin",
      "/task",
      "/cancel",
      "/attach",
    ]);
    assert.deepEqual(filterSlash("/co"), ["/compact"]);
    assert.deepEqual(filterSlash("/nothing"), []);
  });

  it("is empty for text that is not a command, so a path is not a command", () => {
    assert.deepEqual(filterSlash("crabby chat --session"), []);
  });

  it("never offers more than the row's six lines", () => {
    assert.ok(filterSlash("/").length <= 6);
  });
});

describe("T5-06 and T5-05", () => {
  it("prints the capability line in words, before anything is sent", () => {
    assert.equal(
      capabilityLine({ fs: "workspace", net: false, shell: false }),
      "fs: workspace · net: off · shell: off",
    );
  });

  it("names the capability the switch would cost, because 'a worse model' is not actionable", () => {
    const warning = modelSwitchWarning(["no tool calling", "no streaming"]);
    assert.ok(warning !== undefined);
    assert.match(warning, /no tool calling, no streaming/);
    assert.match(warning, /D-045/);
  });

  it("says nothing when nothing would be lost", () => {
    assert.equal(modelSwitchWarning([]), undefined);
  });
});

describe("T5-03's drawn menu", () => {
  it("draws each command with its about line, within the width", () => {
    const lines = slashMenuLines("/", 40);
    assert.equal(lines.length, 6);
    for (const line of lines) assert.ok(line.length <= 40, line);
    assert.ok(lines[5]?.includes("/attach"), lines.join(" | "));
    // At 40 the about line clips after its first clauses — the row's own extras rule — so the marker assertion runs wide.
    assert.ok(lines[0]?.includes("pick the model"), lines[0]);
    assert.ok(slashMenuLines("/", 120)[0]?.includes("T5-05"), "wide enough for the whole sentence");
  });

  it("draws nothing for text that is not a command", () => {
    assert.deepEqual(slashMenuLines("hello", 40), []);
  });
});
