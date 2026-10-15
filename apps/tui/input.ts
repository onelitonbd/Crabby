// Keys, and what happens when one does nothing.
//
// The decoding is the whole of this file and it is deliberately not a terminal emulator: it turns bytes into a small set of
// named keys, and the app binds names to actions. Everything awkward about that is documented rather than absorbed —
// T3-03 says "silence here reads as a hang", which is why `unknownKey` returns the byte *and* a suggestion instead of
// discarding the input.
//
// **P-010's measured facts are the reason this exists in this shape.** `probes/p5.mjs` ran Ink 8 in a real 40×24 pty and
// settled four things a document could not (P-010's row): the layout needs WebAssembly (no device compiler, unlike
// P-004), **Ctrl+J and Enter arrive as LF and CR** so the composer can tell them apart, a kitty-capable terminal's
// **Shift+Enter arrives as `return+shift`**, and **`exitOnCtrlC` has to be turned off** before the app can see Ctrl+C at
// all. Each of those is a promise about *bytes*, so they are handled here and pinned by the tests below rather than
// discovered on a phone. The consequences for this app are recorded in P-011 and F-26.
import { fit, visibleWidth } from "./render.ts";

export type Key =
  | { readonly kind: "char"; readonly char: string }
  | { readonly kind: "enter" }
  | { readonly kind: "escape" }
  | { readonly kind: "tab" }
  | { readonly kind: "backspace" }
  | { readonly kind: "up" }
  | { readonly kind: "down" }
  | { readonly kind: "left" }
  | { readonly kind: "right" }
  | { readonly kind: "ctrl"; readonly letter: string }
  | { readonly kind: "unknown"; readonly bytes: string };

/** One decode step. Returns `undefined` when `bytes` holds only the start of an escape sequence — the caller keeps reading,
 *  which is the only correct handling of a sequence split across two reads (a pty delivers whatever arrived). */
export function decodeKey(bytes: string): { key: Key; rest: string } | undefined {
  if (bytes.length === 0) return undefined;
  const first = bytes[0] ?? "";
  switch (first) {
    // CR and LF are two keys because the composer needs to tell them apart: P-010 measured both arriving, and a terminal
    // sends CR for Enter on most setups and LF for Ctrl+J. A composer that treats them as one cannot offer Shift+Enter, and a
    // terminal that sends neither (`return+shift`, kitty) arrives as an escape sequence below.
    case "\r":
      return { key: { kind: "enter" }, rest: bytes.slice(1) };
    case "\n":
      return { key: { kind: "enter" }, rest: bytes.slice(1) };
    case "\t":
      return { key: { kind: "tab" }, rest: bytes.slice(1) };
    case "\u007f":
    case "\b":
      return { key: { kind: "backspace" }, rest: bytes.slice(1) };
    case "\u001b":
      return decodeEscape(bytes);
    default:
      break;
  }
  const code = first.codePointAt(0) ?? 0;
  if (code < 0x20) {
    // C0 control: Ctrl-A is 0x01 … Ctrl-Z is 0x1a. Ctrl+C (0x03) and Ctrl+Q (0x11) are the two T1-08 binds, and
    // `exitOnCtrlC` has to be off for them to arrive here at all (P-010's measured finding).
    return { key: { kind: "ctrl", letter: String.fromCharCode(code + 96) }, rest: bytes.slice(1) };
  }
  // A whole code point, so an emoji or a Bengali character is one key rather than two halves — Termux is the primary
  // platform and §7.2's rules about the touch keyboard are about exactly this.
  const width = String.fromCodePoint(code).length;
  return {
    key: { kind: "char", char: bytes.slice(0, width) },
    rest: bytes.slice(width),
  };
}

const CSI_KEYS: Readonly<Record<string, Key["kind"]>> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "up",
  F: "down",
};

function decodeEscape(bytes: string): { key: Key; rest: string } | undefined {
  if (bytes.length === 1) {
    // A lone ESC *is* the Escape key on a real terminal (T3-02 closes the help sheet with it), and waiting for more bytes
    // would make Escape unusable on a fast typist. The cost is that a split escape sequence whose first byte has not
    // arrived yet is read as Escape — a real cost, paid knowingly, because the alternative (a timer) is a second event loop
    // for one key and this app already owns its repaint budget (P-011).
    return { key: { kind: "escape" }, rest: "" };
  }
  const second = bytes[1] ?? "";
  if (second !== "[" && second !== "O") {
    // ESC followed by a character is Alt-<char> on most terminals. There is no binding for it in v1 (D-061 closed T3-A:
    // keys are not configurable), so it is reported as unknown rather than invented.
    return { key: { kind: "unknown", bytes: bytes.slice(0, 2) }, rest: bytes.slice(2) };
  }
  // CSI sequences end with a final byte in `@`–`~`. Anything shorter is still arriving.
  const end = [...bytes.slice(2)].findIndex((char) => char >= "@" && char <= "~");
  if (end < 0) return undefined;
  const final = [...bytes.slice(2)][end] ?? "";
  // ESC + `[` + the parameters + the final byte. Getting this wrong by the length of the final byte alone (2 + 1) happens to
  // work for a bare `\u001b[A` and truncates every sequence that carries parameters, leaving the rest of them in the buffer
  // to be decoded as more keys — which is how a `\u001b[1;5A` becomes an arrow followed by four stray characters.
  const consumed = 2 + end + 1;
  const parameters = bytes.slice(2, 2 + end);
  const kind = CSI_KEYS[final] as Key["kind"] | undefined;
  if (
    kind === undefined ||
    kind === "unknown" ||
    kind === "escape" ||
    kind === "char" ||
    kind === "ctrl"
  ) {
    // P-010's measured finding: a kitty-capable terminal sends Shift+Enter as `return+shift`, which arrives as a CSI
    // sequence this build has no name for. It is named `unknown` with its bytes intact so the hint strip can say
    // "Shift+Enter is not bound in this terminal" rather than the composer silently swallowing a newline.
    return {
      key: { kind: "unknown", bytes: bytes.slice(0, consumed) },
      rest: bytes.slice(consumed),
    };
  }
  // Modified arrows (`\u001b[1;5A`) are still that arrow: the modifiers are read and discarded rather than invented into
  // bindings, because D-061 closed T3-A with "not configurable in v1" and a half-supported modifier is a binding nobody
  // documented.
  void parameters;
  return { key: { kind: kind as "up" | "down" | "left" | "right" }, rest: bytes.slice(consumed) };
}

/** T3-03's feedback: one line naming the key and the closest real binding. **Silence reads as a hang**, so an unbound key
 *  always says something — and the suggestion comes from the pane's own hints rather than from a global list, because the
 *  pane knows which of its keys are possible right now (T3-04). */
export function unknownKeyLine(bytes: string, hints: readonly string[]): string {
  const printable = bytes
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to *show* control bytes as `.`
    .replace(/\u001b/g, "\\e")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to *show* control bytes as `.`
    .replace(/[\u0000-\u001f]/g, ".");
  const first = hints[0];
  return (
    `${printable} is not bound here` +
    (first === undefined ? " — press ? for the key list" : ` — closest: ${first}`)
  );
}

/** T3-05: `TERM=dumb` cannot report keys, so the app prints the key list once at start instead of pretending a hint strip
 *  is interactive. The detection is `platform`'s (`terminalFacts`), and this is only the decision about what to do. */
export function dumbTerminalNotice(
  paneNames: readonly string[],
  keys: readonly string[],
): string[] {
  return [
    `dumb terminal: keys are not reported, so this is the key list — panes ${paneNames.join(", ")}`,
    keys.join(" · "),
  ];
}

/** One line of the composer, for T5. Kept here because wrapping a line to the terminal width is the same arithmetic as
 *  `fit` and the two must not disagree.
 *
 *  **A newline in the buffer is shown as a space.** Enter submits and Shift+Enter is unbound in v1 (D-061 closed T3-A, and
 *  P-010 measured that a kitty terminal's Shift+Enter arrives as a sequence this build does not name), so there is no way to
 *  type one; a buffer that somehow holds one should still draw on one line rather than reflow the frame's chrome.
 *
 *  **The cursor is drawn as a character, not moved.** On a touch keyboard the user cannot see a hardware cursor land in the
 *  right place, and a character is unambiguous at every colour tier (`docs/DESIGN_SYSTEM.md` §2.1's 8-colour fallback). */
export function composerLine(text: string, cursor: number, columns: number): string {
  const flat = text.replace(/\n/g, " ");
  // The window is the *tail* of the line when it overflows: a composer that scrolled to show the beginning would hide the
  // character being typed, which is the only character the person cares about at that moment.
  const start = Math.max(0, flat.length - columns);
  const window = flat.slice(start);
  const offset = Math.max(0, Math.min(window.length, cursor - start));
  return `${window.slice(0, offset)}\u258f${window.slice(offset)}`;
}

/** Clipped to the width, for the one place the app measures a string it is about to draw. Re-exported so a pane does not
 *  import `render.ts` for one helper and end up with two clipping rules. */
export { fit, visibleWidth };
