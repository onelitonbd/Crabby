// The chat view's presentation vocabulary: the OpenClaw-shaped skin for the TUI's chat pane.
//
// **What was borrowed, and the one thing it had to respect.** OpenClaw's terminal chat (docs.openclaw.ai/web/tui,
// and its screenshots) is built from five surfaces: a user message that is a **full-width bar** rather than a
// prefixed line; assistant turns that open with the model that spoke; a quiet footer of facts; a separated input
// with a prompt mark; and tool calls as cards. The TUI's chat pane already had the facts (T2's status line, T3's
// hint strip, T5's composer) — what it drew like was a wire report. This file is the drawing: every function here
// is pure, tier-aware, and false-colour-proof.
//
// **The one thing it had to respect is `docs/review/TUI.md`, whose rows are accepted specifications:**
//
//   - **T4-01** (user message, "leading gutter ≤2, so long-press selection lands on the whole message"): the bar
//     adds *zero* prefix characters — the text starts at column 0 inside a background, which is a gutter of 0. The
//     `none` tier (`--plain`, pipes, `TERM=dumb`) keeps the old `│ ` prefix, because a background is an escape
//     sequence and §4's rule is that a pipe gets no escapes at all.
//   - **T4-02** ("model+provider on the first line of the turn"): the assistant header this file draws. The pane
//     had never implemented it — a gap this slice closes rather than a rule it changes.
//   - **T4-07/T4-08** (tool line, `tool · tier · status · duration`): the glyph is a *prefix*, the contract text
//     follows it untouched.
//   - **`docs/DESIGN_SYSTEM.md` §2.3**: the bar is `bg.raised` (`#171c22`) in the truecolor tier, its nearest
//     256-color cousin in that tier, inverse video in the 16-colour tier, and words in `none`.
//
// **Why the padding arithmetic pads to `columns` and not to the text:** a bar that stops where the words stop is a
// highlight; a bar that runs the full width is a *surface*, and the full-width surface is the whole OpenClaw look.
import type { CharsetTier } from "./markdown.ts";
import { visibleWidth } from "./render.ts";

const RESET = "\u001b[0m";
const DIM = "\u001b[2m";

/** The bar's background per colour tier. `bg.raised` is `#171c22` → RGB 23, 28, 34; the 256-colour cousin is
 *  xterm-235 (`#262626`-family greys, the closest dark surface the palette carries); the 16-colour tier has no
 *  background budget worth trusting, so it uses inverse video — the same trick `menuLines` uses onboard, where the
 *  mark must survive a terminal that barely has colours. */
const BAR_BG: Readonly<Record<Exclude<CharsetTier, "none">, string>> = {
  truecolor: "\u001b[48;2;23;28;34m",
  "256": "\u001b[48;5;235m",
  ansi: "\u001b[7m",
};

/** The composer's prompt mark. Two columns wide — `main.ts` adds this to the real cursor's column (T5-02), so the
 *  width lives here as a named constant and the cursor can never disagree with the drawing. */
export const PROMPT = "❯ ";

/** One line of a user turn. Colour tiers draw the full-width raised bar; the `none` tier keeps the `│ ` gutter the
 *  pane has always drawn — the same message, the same selection behaviour, no escapes (§4). */
export function userBarLine(line: string, tier: CharsetTier, columns: number): string {
  if (tier === "none") return `│ ${line}`;
  const bg = BAR_BG[tier];
  // Markdown attributes end with a reset, and a reset inside the bar would erase the bar's own background from
  // that column on — so every inner reset re-opens the background behind it.
  const repainted = line.split(RESET).join(RESET + bg);
  const pad = " ".repeat(Math.max(0, columns - visibleWidth(line)));
  return `${bg}${repainted}${pad}${RESET}`;
}

/** T4-02's first line of an assistant turn: the model that spoke, quiet, above the words. `none` keeps the line —
 *  it is information, not decoration — and only drops the dimming. */
export function assistantHeader(model: string, tier: CharsetTier): string {
  return tier === "none" ? `── ${model}` : `${DIM}── ${model}${RESET}`;
}

/** T4-07's collapsed/expanded states as one glyph each: ◇ closed, ◆ open. A character, not an attribute — the mark
 *  survives every tier including `none`, and the contract text follows it untouched. */
export function toolMark(collapsed: boolean): string {
  return collapsed ? "◇ " : "◆ ";
}

/** The pane's empty state (T6-06's rule — a pane that says nothing teaches nothing), in OpenClaw's register: who
 *  you are, which session and model this is, and the two keys a first message needs. Three lines, because a
 *  welcome that scrolls is a wall. */
export function welcomeLines(
  model: string | undefined,
  session: string | undefined,
  tier: CharsetTier,
): readonly string[] {
  const dim = (text: string): string => (tier === "none" ? text : `${DIM}${text}${RESET}`);
  const meta = [
    session === undefined ? undefined : `session ${session}`,
    model ?? "no model yet — /model picks one",
  ]
    .filter((part) => part !== undefined)
    .join(" · ");
  return ["🦀 crabby", dim(meta), dim("type below · Enter sends · Ctrl+J newline · ? help")];
}

/** Dim a whole line where the tier allows dimming. Used for the held-content note (T4-12) — the note is a status,
 *  and OpenClaw's footers taught the register: facts quiet, words intact. */
export function dimLine(text: string, tier: CharsetTier): string {
  return tier === "none" ? text : `${DIM}${text}${RESET}`;
}
