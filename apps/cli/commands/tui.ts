// `crabby tui` — the command that starts it.
//
// The TUI is its own process rather than a verb of the CLI's registry, and this file is why that is not a second way to do
// the same thing: the registry's rule is that a **verb** is listed when a route is behind it, and the TUI is not a verb — it
// is an application with its own event loop, its own terminal handling and its own renderer. Putting it in `registry.ts`
// would have put an app in a table of verbs, and `apps/cli/registry.ts`'s own header says that a row is a promise about a
// *command*, which this is not. So the CLI answers `crabby tui` in one branch, names the app it starts, and the app's own
// documentation (`docs/review/TUI.md`, `docs/UI_UX_SPEC.md` §4) is where its grammar lives.
//
// **One thing the CLI does *not* do here: check for a Gateway.** T1-09 and T1-10 belong to the TUI's first frame, because a
// TUI that is not connected still draws a frame and says which command starts one — and a pre-flight refusal in the CLI would
// leave the user with a terminal error instead of the screen that explains itself.
import { EXIT, type ExitCode } from "@crabby/api-contracts";
import { terminalFacts } from "@crabby/platform";
import { MINIMUM_COLUMNS } from "../../tui/frame.ts";
import { runTui } from "../../tui/main.ts";

export async function runTuiCommand(
  argv: readonly string[],
  dataDir: string,
  stdout: NodeJS.WriteStream,
): Promise<ExitCode> {
  // Two flags, both about the terminal rather than about a route, and both honoured by `docs/UI_UX_SPEC.md` §4: `--plain`
  // turns rendering off entirely (the same switch the CLI has), and `--columns` exists because a phone's terminal can be
  // narrower than the design case and the TUI should be told so rather than measuring a window it does not have.
  const plain = argv.includes("--plain");
  const columnsFlag = argv.indexOf("--columns");
  const asked = columnsFlag >= 0 ? Number(argv[columnsFlag + 1]) : undefined;
  if (columnsFlag >= 0 && (!Number.isFinite(asked) || (asked ?? 0) <= 0)) {
    stdout.write("tui --columns takes a positive number of columns\n");
    return EXIT.usage;
  }
  // The measurement goes through `terminalFacts`, which is where "a pty that reports 0 columns is an absent measurement"
  // is decided (one place, for the CLI, the TUI and `crabby doctor`). Reading `process.stdout.columns` here instead would
  // be a second rule — and the first version of this file did exactly that, which is how a frame of zero columns reached a
  // real pty on this device.
  const facts = terminalFacts(
    process.env,
    {
      ...(asked === undefined ? {} : { columns: asked }),
      ...(typeof process.stdout.rows === "number" ? { rows: process.stdout.rows } : {}),
    },
    process.stdin.isTTY === true,
  );
  const columns = facts.columns;
  const rows = facts.rows;
  if (facts.columns !== asked) {
    // Said once, in words: a frame drawn at the fallback width when the terminal reported none is at least honest about it.
    stdout.write(`tui: the terminal reported no width, drawing at ${columns} columns\n`);
  }
  if (facts.isTTY === false) {
    // T3-05: a terminal that cannot report keys is told so, with the list, rather than being given a frame nobody can act on.
    stdout.write(
      "tui: stdin is not a terminal, so no keys can be reported here — use `crabby task ls` in this shell\n",
    );
    return EXIT.usage;
  }
  if (columns < MINIMUM_COLUMNS) {
    // Named, not refused: T1-06's rule is that a narrower terminal gets the status line, one pane and a line saying what the
    // design case is. The app itself prints that line, and this is the same fact said once before it starts.
    stdout.write(
      `tui: ${columns} columns, below the ${MINIMUM_COLUMNS} this app is built for — resize when you can\n`,
    );
  }
  if (plain) stdout.write("tui: --plain turns rendering off, which the first frame reports\n");
  return runTui({
    dataDir,
    columns,
    rows,
    env: process.env,
    stdin: process.stdin,
    stdout,
  });
}
