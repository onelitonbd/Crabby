// The onboarding screen's own widgets — the smallest honest version of what `docs/UI_UX_SPEC.md` §5 means by
// "specified like a screen, not a README": a banner, a step rail, an arrow-key menu, and the rule that carries
// the whole CLI (§6) — colour is what a TTY gets, never what a pipe receives.
//
// Why these are here and not in `apps/tui/`: the TUI is an application (D-129) with a reconciling frame and a
// session; onboarding is a sequence of screens that hands the terminal to child verbs between them. Borrowing
// the frame's reconciler would buy complexity for a screen that exists only to ask four questions. What IS
// shared with the TUI's discipline: stdlib only (no Ink, P-010 still unmeasured), 16-colour-safe glyphs, no
// alternate screen (D-061 — scrollback survives the wizard), and Bengali-free fixed chrome (§5's copy is
// English like every interface's fixed strings; the wizard's job is clarity, not localisation yet).
import { emitKeypressEvents } from "node:readline";

/** §6's rule, read once: colour exists only for a TTY, and `NO_COLOR` is honoured like a good citizen. */
export function colorEnabled(
  stream: { isTTY?: boolean; env?: Record<string, string | undefined> } | undefined,
): boolean {
  if (stream?.isTTY !== true) return false;
  const noColor = stream.env?.NO_COLOR ?? process.env.NO_COLOR;
  return noColor === undefined;
}

const CODE = {
  cyan: (text: string): string => `\x1b[36m${text}\x1b[0m`,
  green: (text: string): string => `\x1b[32m${text}\x1b[0m`,
  yellow: (text: string): string => `\x1b[33m${text}\x1b[0m`,
  red: (text: string): string => `\x1b[31m${text}\x1b[0m`,
  dim: (text: string): string => `\x1b[2m${text}\x1b[0m`,
  inverse: (text: string): string => `\x1b[7m${text}\x1b[0m`,
  bold: (text: string): string => `\x1b[1m${text}\x1b[0m`,
} as const;

export type Paint = (text: string) => string;

/** The palette a screen paints with, or the identity functions when colour is off — callers never branch on
 *  `colorEnabled` themselves, so a pipe cannot grow an escape sequence by accident. */
export function palette(enabled: boolean): Readonly<Record<keyof typeof CODE, Paint>> {
  if (enabled) return CODE;
  const plain: Paint = (text) => text;
  return {
    cyan: plain,
    green: plain,
    yellow: plain,
    red: plain,
    dim: plain,
    inverse: plain,
    bold: plain,
  };
}

/** Width of a string as the terminal sees it: escape sequences count as nothing. Good enough for ASCII chrome —
 *  the banner's words are fixed ASCII, and anything user-supplied goes through `clip`-style shortening first. */
export function visibleWidth(text: string): number {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are exactly the control range this strips.
  return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** The welcome banner: a box-drawing frame, the crab, and the one-line promise. Width is computed from the
 *  widest line so the frame never depends on a terminal size guess. */
export function banner(p: Readonly<Record<keyof typeof CODE, Paint>>): readonly string[] {
  const lines = [
    `${p.bold("🦀 Crabby")} — first-run onboarding`,
    p.dim("one flow: check → model → pair → verify"),
  ];
  const width = Math.max(...lines.map(visibleWidth)) + 4;
  const top = `╭${"─".repeat(width)}╮`;
  const bottom = `╰${"─".repeat(width)}╯`;
  const body = lines.map(
    (line) => `│${p.cyan(`  ${line}${" ".repeat(width - 2 - visibleWidth(line))}`)}│`,
  );
  return [p.cyan(top), ...body, p.cyan(bottom)];
}

export type StepState = "done" | "now" | "pending" | "failed";

const GLYPH: Readonly<Record<StepState, string>> = {
  done: "✓",
  now: "●",
  pending: "○",
  failed: "✗",
};

/** One rail line, painted: ✓ green, ● cyan, ✗ red, ○ dim — all four readable on a 16-colour Termux (AGENTS §8). */
export function stepLine(
  name: string,
  state: StepState,
  p: Readonly<Record<keyof typeof CODE, Paint>>,
): string {
  const glyph = GLYPH[state];
  const label = name.padEnd(12, " ");
  switch (state) {
    case "done":
      return `  ${p.green(glyph)} ${p.dim(label)}`;
    case "now":
      return `  ${p.cyan(glyph)} ${p.bold(label)}`;
    case "failed":
      return `  ${p.red(glyph)} ${p.red(label)}`;
    default:
      return `  ${p.dim(glyph)} ${p.dim(label)}`;
  }
}

/** The whole rail, in order — the screen that answers "where am I?" before any question is asked. */
export function rail(
  steps: readonly { readonly name: string; readonly state: StepState }[],
  p: Readonly<Record<keyof typeof CODE, Paint>>,
): readonly string[] {
  return steps.map((step) => stepLine(step.name, step.state, p));
}

export interface MenuOption {
  readonly label: string;
  /** The dim sentence under the label, when the choice needs its consequence named (§5's one-line rule). */
  readonly hint?: string | undefined;
}

/** The menu as lines: `❯` and inverse video mark the selection — two signals, so colour-off terminals still see
 *  the cursor and 16-colour ones get the highlight. */
export function menuLines(
  title: string,
  options: readonly MenuOption[],
  selected: number,
  p: Readonly<Record<keyof typeof CODE, Paint>>,
): readonly string[] {
  const out: string[] = [p.bold(title)];
  options.forEach((option, index) => {
    const cursor = index === selected ? "❯" : " ";
    const label = ` ${cursor} ${option.label}`;
    const hint = option.hint === undefined ? [] : [`     ${p.dim(option.hint)}`];
    out.push(index === selected ? p.inverse(label) : label, ...hint);
  });
  out.push(p.dim("  (↑/↓ move · Enter choose)"));
  return out;
}

/** How a keypress moves a menu: ↑/k up, ↓/j down, clamped — pure, so the movement rules are testable without a
 *  terminal. */
export function moveSelection(selected: number, key: string, count: number): number {
  if (count === 0) return selected;
  switch (key) {
    case "up":
    case "k":
      return selected === 0 ? count - 1 : selected - 1;
    case "down":
    case "j":
      return selected === count - 1 ? 0 : selected + 1;
    default:
      return selected;
  }
}

export interface PickResult {
  readonly index: number;
  readonly cancelled: boolean;
}

/** Ask one arrow-key question on the user's terminal. Raw mode lives only inside this function — the wizard's
 *  child verbs inherit a cooked terminal, exactly as a typed command would. Escape answers "cancelled"; the
 *  caller decides whether that is skip or abort. */
export async function pick(
  title: string,
  options: readonly MenuOption[],
  p: Readonly<Record<keyof typeof CODE, Paint>>,
): Promise<PickResult> {
  const stdin = process.stdin;
  if (stdin.isTTY !== true || stdin.setRawMode === undefined) {
    return { index: -1, cancelled: true };
  }
  const out = process.stdout;
  const render = (selected: number): void => {
    const lines = menuLines(title, options, selected, p);
    out.write(`${lines.join("\n")}\n`);
  };
  return new Promise((resolve) => {
    let selected = 0;
    let drawn = false;
    const redraw = (next: number): void => {
      // Line-diffed in the smallest sense: clear what this menu drew, draw the new state. No alternate screen
      // (D-061) — the scrollback keeps every previous question, which is the honest transcript of a setup.
      if (drawn) {
        const lines = menuLines(title, options, selected, p).length;
        out.write(`\x1b[${String(lines)}A\x1b[J`);
      }
      selected = next;
      render(selected);
      drawn = true;
    };
    const cleanup = (result: PickResult): void => {
      stdin.setRawMode(false);
      stdin.removeListener("keypress", onKey);
      resolve(result);
    };
    const onKey = (_text: string, key: { name?: string } | undefined): void => {
      const name = key?.name ?? "";
      if (name === "return") {
        out.write("\n");
        cleanup({ index: selected, cancelled: false });
        return;
      }
      if (name === "escape") {
        cleanup({ index: -1, cancelled: true });
        return;
      }
      if (name === "up" || name === "down" || name === "k" || name === "j") {
        redraw(moveSelection(selected, name, options.length));
      }
    };
    // `emitKeypressEvents` is the stdlib way to read arrows without a dependency; raw mode lives only for the
    // duration of this one question, and a pipe never reaches here at all.
    emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("keypress", onKey);
    render(0);
    drawn = true;
  });
}
