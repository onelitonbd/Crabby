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
    columns: typeof size.columns === "number" ? size.columns : 80,
    rows: typeof size.rows === "number" ? size.rows : 24,
    isTTY,
  };
}
