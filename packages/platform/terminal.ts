// Terminal facts the TUI and `crabby doctor` read. Deliberately narrow: M0 measured the behaviours (`probes/RESULTS.md`
// P5) and the two consequences were recorded where they belong — D-061's terminal input and rendering contract, and
// P-011's app-owned repaint throttle. So this module reports inputs and decides nothing.
export interface TerminalFacts {
  readonly term: string;
  readonly color: "truecolor" | "256" | "ansi" | "none";
  readonly columns: number;
  readonly rows: number;
  readonly isTTY: boolean;
}

export function colorDepth(env: NodeJS.ProcessEnv): TerminalFacts["color"] {
  const value = env.COLORTERM ?? "";
  if (value === "truecolor" || value === "24bit") return "truecolor";
  if (/256/.test(env.TERM ?? "")) return "256";
  if (env.TERM === "dumb") return "none";
  return "ansi";
}

export function terminalFacts(
  env: NodeJS.ProcessEnv,
  size: { columns?: number; rows?: number },
  isTTY: boolean,
): TerminalFacts {
  return {
    term: env.TERM ?? "",
    color: colorDepth(env),
    // **A measurement of zero is an absent measurement, not a terminal of no width.** A pty with no window size set — which
    // is what `script`, a CI harness and a freshly-resized Termux window can hand you — reports `columns: 0`, and a caller
    // that trusted it drew a frame of nothing. Found on this platform by running the TUI inside a pty, which is the whole
    // argument for running the thing once rather than only testing its functions.
    columns: positive(size.columns) ?? 80,
    rows: positive(size.rows) ?? 24,
    isTTY,
  };
}

function positive(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined;
}

/** Clipped for a narrow screen, which §7.2 makes the design case (Termux is 40–60 columns) and `docs/UI_UX_SPEC.md` §4
 *  repeats for the TUI: a summary that wraps pushes the field a user has to read off the line they were looking at.
 *
 *  **It lives here rather than in either interface** because there are two interfaces with a 40-column design case and two
 *  copies of this function would be two answers to "what does this look like at 40 columns" — and the answers would agree
 *  until one of them changed. `apps/cli/output.ts` re-exports it so the CLI's own call sites are unchanged. `--json`
 *  carries the whole value in both interfaces, so nothing is lost to a script by shortening here. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}\u2026`;
}

/** Word-wrapped to a width, whole words kept. The pane-shaped sibling of `clip`: a notice that *must* be read whole
 *  (a rule, a state word, a required disclosure) wraps onto the next drawn line instead of losing its tail to the
 *  ellipsis, because T17-03's protection of the state word is the inventory's own precedent for never clipping the
 *  point away. Lives beside `clip` for the same reason `clip` does — two interfaces, one 40-column design case. */
export function wrapText(text: string, width: number, indent = "  "): readonly string[] {
  const usable = Math.max(8, width - indent.length);
  if (text.length <= usable) return [`${indent}${text}`];
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(" ")) {
    if (current.length === 0) current = word;
    else if (`${current} ${word}`.length <= usable) current = `${current} ${word}`;
    else {
      lines.push(`${indent}${current}`);
      current = word;
    }
  }
  if (current.length > 0) lines.push(`${indent}${current}`);
  return lines;
}
