// The composer (T5), and the three places it has to obey something other than taste.
//
// **T5-A (closed by D-061): `Ctrl+J` is the newline key, always; `Shift+Enter` and `Alt+Enter` only when the terminal
// answers an extended-key query; `Enter` always sends.** That is not a preference — it is what `probes/p5.mjs` measured:
// CR and LF both arrive, so the two are distinguishable, and a kitty-capable terminal's Shift+Enter arrives as
// `return+shift`, which this decoder reports as an unbound key rather than swallowing. A composer that guessed would
// insert a newline when a person pressed Enter to send.
//
// **T5-02's real cursor, and the drawn block it replaces.** The row says: "not a drawn block: Termux's IME and its editing
// keys only behave around a real cursor". That is a platform fact about the primary platform, and it is why `Terminal`
// gained a cursor-visibility pair and why the composer asks for the cursor rather than painting one. `composerLine` still
// exists for `--plain` and for a pipe, where there is no cursor to move — and the two agree on where the edit position is,
// because the tests assert the same index.
//
// **T5-09's history does not steal `↑`.** The row is explicit: history "must not swallow `↑` for scrolling in a pane that
// scrolls". So `↑` means history *only* when the buffer is empty, and that condition is in `onKey` rather than in a keymap,
// because a keymap cannot know whether the pane scrolls.
//
// **T5-06's capability line before sending.** `fs: workspace · net: off · shell: off` is what a person needs to know about
// what a run may do, and it is printed *before* the send rather than discovered in an approval prompt afterwards.
import { composerLine } from "./input.ts";
import { visibleWidth } from "./render.ts";

export type ComposerAction =
  | { readonly kind: "insert"; readonly text: string }
  | { readonly kind: "newline" }
  | { readonly kind: "send" }
  | { readonly kind: "backspace" }
  | { readonly kind: "left" }
  | { readonly kind: "right" }
  | { readonly kind: "history"; readonly previous: string | undefined }
  | { readonly kind: "unbound"; readonly bytes: string }
  | { readonly kind: "ignore" };

/** The keys D-061 named, as bytes, in one table. `enter` and `ctrl-j` are separate entries because they are separate
 *  bytes: `\r` sends and `\n` inserts a newline, and that asymmetry is the decision. */
export function actionFor(
  key:
    | { readonly kind: "enter" }
    | { readonly kind: "ctrl"; readonly letter: string }
    | { readonly kind: "char"; readonly char: string }
    | { readonly kind: "unknown"; readonly bytes: string }
    | { readonly kind: "backspace" }
    | { readonly kind: "left" }
    | { readonly kind: "right" }
    | { readonly kind: "up" }
    | { readonly kind: "down" },
  bufferEmpty: boolean,
): ComposerAction {
  if (key.kind === "ctrl" && key.letter === "j") return { kind: "newline" };
  if (key.kind === "enter") return { kind: "send" };
  if (key.kind === "backspace") return { kind: "backspace" };
  if (key.kind === "left") return { kind: "left" };
  if (key.kind === "right") return { kind: "right" };
  // T5-09: `↑` is history only when there is nothing to type over. In a pane that scrolls it scrolls, and the composer is
  // not entitled to take it.
  if (key.kind === "up" && bufferEmpty) return { kind: "history", previous: undefined };
  if (key.kind === "down" && bufferEmpty) return { kind: "history", previous: undefined };
  if (key.kind === "unknown") {
    // A kitty terminal's Shift+Enter lands here. It is *named with its bytes*, so the hint strip can say the key is unbound
    // in this terminal — silently dropping a newline a person pressed is how a composer loses text, and guessing that it
    // meant a newline is how a composer inserts one when the person meant to send.
    return { kind: "unbound", bytes: key.bytes };
  }
  if (key.kind === "char") return { kind: "insert", text: key.char };
  return { kind: "ignore" };
}

/** The composer's own state, and the two rules that are about *correctness* rather than layout: a newline is inserted only
 *  by `Ctrl+J`, and the buffer is never longer than `maxLines` lines before it scrolls (T5-01). */
export interface ComposerState {
  readonly buffer: string;
  readonly cursor: number;
  readonly history: readonly string[];
  readonly historyIndex?: number | undefined;
}

export function emptyComposer(): ComposerState {
  return { buffer: "", cursor: 0, history: [] };
}

export function applyAction(
  state: ComposerState,
  action: ComposerAction,
  previousInput: string | undefined,
): ComposerState {
  switch (action.kind) {
    case "insert":
      return {
        ...state,
        buffer: `${state.buffer.slice(0, state.cursor)}${action.text}${state.buffer.slice(state.cursor)}`,
        cursor: state.cursor + action.text.length,
      };
    case "newline": {
      const next = `${state.buffer.slice(0, state.cursor)}\n${state.buffer.slice(state.cursor)}`;
      return { ...state, buffer: next, cursor: state.cursor + 1 };
    }
    case "backspace":
      if (state.cursor === 0) return state;
      return {
        ...state,
        buffer: `${state.buffer.slice(0, state.cursor - 1)}${state.buffer.slice(state.cursor)}`,
        cursor: state.cursor - 1,
      };
    case "left":
      return { ...state, cursor: Math.max(0, state.cursor - 1) };
    case "right":
      return { ...state, cursor: Math.min(state.buffer.length, state.cursor + 1) };
    case "history": {
      if (previousInput === undefined || previousInput.length === 0) return state;
      // The restored buffer replaces rather than appends, and the cursor goes to its end: the person asked for the last
      // thing they said, not for that thing with an edit point in the middle of it.
      return { ...state, buffer: previousInput, cursor: previousInput.length };
    }
    case "unbound":
    case "ignore":
      return state;
    default:
      return state;
  }
}

/** T5-01: the input area grows to six lines and then scrolls. Six is the row's number, and the count is reported so the
 *  pane can draw a scroll indicator rather than pretending the text is complete. */
export const MAX_COMPOSER_LINES = 6;

export interface ComposerView {
  /** The lines to draw, oldest first, tail-scrolled when the buffer is longer than `MAX_COMPOSER_LINES`. */
  readonly lines: readonly string[];
  /** How many lines are hidden above — non-zero means the view is scrolled, and a person needs to know that. */
  readonly hiddenAbove: number;
  /** The line the edit position is on, 0-based within `lines`. */
  readonly cursorLine: number;
}

export function composerView(state: ComposerState, columns: number): ComposerView {
  const before = state.buffer.slice(0, state.cursor);
  const cursorLine = before.split("\n").length - 1;
  const raw = state.buffer.split("\n");
  const hiddenAbove = Math.max(0, raw.length - MAX_COMPOSER_LINES);
  const shown = raw.slice(hiddenAbove);
  // A hard newline is one column in the drawn line and zero in the buffer, so the cursor column is measured with newlines
  // removed — the same correction `composerLine` makes, and the two must not disagree.
  const lineStart = before.lastIndexOf("\n") + 1;
  const column = visibleWidth(state.buffer.slice(lineStart, state.cursor).replace(/\n/g, ""));
  return {
    lines: shown.map((line, index) => {
      const text = line.length > columns ? line.slice(0, columns) : line;
      if (index === cursorLine - hiddenAbove) {
        const at = Math.min(text.length, column);
        return `${text.slice(0, at)}\u258f${text.slice(at)}`;
      }
      return text;
    }),
    hiddenAbove,
    cursorLine: Math.max(0, cursorLine - hiddenAbove),
  };
}

/** T5-03's slash commands, filtered as typed. `/model` `/compact` `/pin` `/task` `/cancel` — the row's list, and **every one
 *  of them also has a visible control in the Web** (`docs/INTERFACES_AND_API.md` §8's parity rule: a shortcut-only
 *  capability is not a capability). */
export const SLASH_COMMANDS = ["/model", "/compact", "/pin", "/task", "/cancel"] as const;

export function filterSlash(text: string, limit = 6): readonly string[] {
  if (!text.startsWith("/")) return [];
  const query = text.slice(1).toLowerCase();
  return SLASH_COMMANDS.filter((command) => command.slice(1).toLowerCase().startsWith(query)).slice(
    0,
    limit,
  );
}

/** T5-06's capability line, printed *before* the send. The words are the point: `shell: off` is a fact a person can act on
 *  (`crabby config set shell.enabled true`), and a dot or a colour would be neither. */
export function capabilityLine(capabilities: {
  readonly fs: string;
  readonly net: boolean;
  readonly shell: boolean;
}): string {
  return `fs: ${capabilities.fs} · net: ${capabilities.net ? "on" : "off"} · shell: ${capabilities.shell ? "on" : "off"}`;
}

/** T5-05's warning when the turn's model cannot do what the composer is about to ask of it. D-045 prices the decision to
 *  switch: the delta is named, because "the new model is worse" is not actionable and "no tool calling" is. */
export function modelSwitchWarning(losses: readonly string[]): string | undefined {
  if (losses.length === 0) return undefined;
  return `this turn would use a model without ${losses.join(", ")} — the run may ask you instead (D-045)`;
}

/** The drawn cursor, for `--plain` and for a pipe. Exported so the pane and the tests agree on the glyph. */
export { composerLine };
