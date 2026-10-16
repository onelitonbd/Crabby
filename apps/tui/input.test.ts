// Key decoding, held to the four facts `probes/p5.mjs` measured in a real 40×24 pty (P-010's row).
//
// These are byte-level promises, and every one of them was found by measurement rather than by reading a document — which
// is why they are pinned here rather than discovered on a phone:
//
//   - **Ctrl+J and Enter arrive as LF and CR**, so the composer must tell them apart.
//   - **Shift+Enter on a kitty-capable terminal arrives as `return+shift`** — a CSI sequence this build does not name.
//   - **`exitOnCtrlC` has to be off before the app sees Ctrl+C**, so T1-08's "Ctrl-C cancels the task and does not quit"
//     depends on bytes arriving at all.
//   - **An escape sequence can be split across two reads**, so a partial sequence must return "not yet" rather than an
//     unknown key.
//
// Plus two platform facts that are not about bytes: a code point is one key (Termux is the primary platform and §7.2 is about
// the touch keyboard), and a key that does nothing says so (T3-03 — silence reads as a hang).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { composerLine, decodeKey, dumbTerminalNotice, type Key, unknownKeyLine } from "./input.ts";

function key(bytes: string): Key {
  const decoded = decodeKey(bytes);
  assert.ok(decoded !== undefined, `"${bytes}" decoded`);
  return decoded.key;
}

describe("decodeKey", () => {
  it("reads a printable character", () => {
    assert.deepEqual(key("q"), { kind: "char", char: "q" });
  });

  it("reads Ctrl-C as a control key, which is what T1-08 binds", () => {
    // 0x03 is Ctrl-C. `exitOnCtrlC` off (P-010's finding) is what puts this byte in this process at all.
    assert.deepEqual(key("\u0003"), { kind: "ctrl", letter: "c" });
    assert.deepEqual(key("\u0011"), { kind: "ctrl", letter: "q" });
  });

  it("reads Enter and Ctrl+J as different keys, because they are different bytes", () => {
    // P-010 measured both arriving, and D-061's asymmetry needs them *different*: `\r` sends, `\n` (Ctrl+J's byte)
    // inserts a newline. The old decode named both `enter`, which made the composer's own table unreachable from a real
    // terminal — main.test.ts's end-to-end Ctrl-J test is the assertion of record, and this one now agrees with it.
    assert.deepEqual(key("\r"), { kind: "enter" });
    assert.deepEqual(key("\n"), { kind: "ctrl", letter: "j" });
  });

  it("reads Tab, backspace and the arrows", () => {
    assert.deepEqual(key("\t"), { kind: "tab" });
    assert.deepEqual(key("\u007f"), { kind: "backspace" });
    assert.deepEqual(key("\u001b[A"), { kind: "up" });
    assert.deepEqual(key("\u001b[B"), { kind: "down" });
    assert.deepEqual(key("\u001b[C"), { kind: "right" });
    assert.deepEqual(key("\u001b[D"), { kind: "left" });
  });

  it("waits for the rest of a split escape sequence instead of inventing an unknown key", () => {
    // A pty delivers whatever arrived, so `\\u001b[` and `A` can be two reads. Reporting "unknown" here would make a fast
    // typist's arrow key flash a "not bound" line at them.
    assert.equal(decodeKey("\u001b["), undefined);
    assert.equal(decodeKey("\u001b[1;"), undefined);
    const decoded = decodeKey("\u001b[A");
    assert.deepEqual(decoded?.key, { kind: "up" });
  });

  it("names a kitty Shift+Enter as unknown and keeps its bytes", () => {
    // P-010: a kitty-capable terminal sends Shift+Enter as `return+shift`. Swallowing it would make the composer lose a
    // newline a person pressed; reporting it lets the hint strip say the key is not bound *in this terminal*.
    const sequence = "\u001b[13;2u";
    const decoded = decodeKey(sequence);
    assert.deepEqual(decoded?.key, { kind: "unknown", bytes: sequence });
    assert.equal(decoded?.rest, "");
  });

  it("reads a modified arrow as the arrow, without inventing a binding for the modifier", () => {
    // D-061 closed T3-A: not configurable in v1. A half-supported modifier is a binding nobody documented.
    assert.deepEqual(key("\u001b[1;5A"), { kind: "up" });
    // The whole sequence is consumed. Leaving `;5A` behind would decode as three more keys, and a modifier press would
    // silently type into the composer.
    assert.deepEqual(decodeKey("\u001b[1;5A")?.rest, "");
  });

  it("treats a lone ESC as Escape, because the help sheet closes with it", () => {
    assert.deepEqual(key("\u001b"), { kind: "escape" });
  });

  it("reads a whole code point as one key, so a Bengali character is one keystroke", () => {
    // Termux is the primary platform and §7.2's rules are about the touch keyboard: half a character per key press would
    // make every Bengali word take twice as many presses, and the composer would insert a broken pair.
    const decoded = decodeKey("আ");
    assert.deepEqual(decoded?.key, { kind: "char", char: "আ" });
    assert.equal(decoded?.rest, "", "nothing left over to decode twice");
  });

  it("leaves the rest of the buffer for the next key", () => {
    assert.deepEqual(decodeKey("ab")?.rest, "b");
    assert.deepEqual(decodeKey("\u001b[Aj")?.rest, "j");
  });
});

describe("T3-03's feedback for a key that does nothing", () => {
  it("names the key and the closest real binding", () => {
    const line = unknownKeyLine("\u001b[13;2u", ["j/k move", "Enter open"]);
    assert.match(line, /not bound here/);
    assert.match(line, /j\/k move/);
  });

  it("falls back to the key list when the pane has no hints at all", () => {
    assert.match(unknownKeyLine("\u001b[13;2u", []), /press \?/);
  });
});

describe("T3-05's dumb terminal", () => {
  it("prints the key list once instead of a hint strip that cannot work", () => {
    const lines = dumbTerminalNotice(["chat", "tasks"], ["Tab panes", "q quit"]);
    assert.equal(lines.length, 2);
    assert.match(lines[0] ?? "", /dumb terminal/);
    assert.match(lines[1] ?? "", /Tab panes/);
  });
});

describe("the composer line", () => {
  it("draws the cursor as a character", () => {
    assert.equal(composerLine("abc", 2, 40), "ab\u258fc");
  });

  it("shows the tail of a line longer than the terminal, with the cursor inside it", () => {
    // The character being typed is the only one the person cares about; a composer that scrolled to the beginning would
    // hide it and look broken.
    const line = composerLine("x".repeat(50), 50, 10);
    assert.equal(line.length, 11);
    assert.match(line, /\u258f$/);
  });

  it("draws a newline as a space rather than reflowing the chrome", () => {
    assert.equal(composerLine("a\nb", 3, 40), "a b\u258f");
  });
});
