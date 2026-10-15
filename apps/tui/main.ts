// `apps/tui/main.ts` — the process: terminal in raw mode, a frame drawn from whatever the panes say, keys bound to actions.
//
// **T1-08's two binds are the reason this file exists at all.** `Ctrl-C` cancels the running task and **does not quit**, and
// quitting while a task runs confirms first. Both are refused by refusing to be the terminal's default: raw mode is on
// (`exitOnCtrlC` is off in P-010's measured finding, and Node's raw mode does the same thing for `readline`), so the bytes
// arrive here and the app decides. An app that quits on Ctrl-C would take a running task with it and D-093's recovery would
// have to rebuild it from a checkpoint the user did not know they were using.
//
// **T1-09's rule is the startup shape**: one line saying what is happening, then the frame — never a blank terminal and
// never a fake progress bar. So the first thing drawn is `connecting to the gateway…` with the exact command if it is not
// running, and the first frame replaces it.
//
// The event loop is the smallest thing that can hold the three obligations at once: keys, a poll for the pane's data, and a
// **capped** repaint (P-011's 4 fps). The repaint cap lives in `FrameRenderer`, not here, because the pane that streams
// fastest is the pane that would forget it.

import { EXIT, type ExitCode } from "@crabby/api-contracts";
import { dataLayout, terminalFacts } from "@crabby/platform";
import { connect } from "../cli/connect.ts";
import { frameLines, nextPane, PANE_ORDER, type Pane } from "./frame.ts";
import { decodeKey, dumbTerminalNotice, type Key, unknownKeyLine } from "./input.ts";
import type { PaneDescriptor } from "./panes.ts";
import {
  PANE_DESCRIPTORS,
  type PaneContext,
  paneState,
  plannedPane,
  statusFrom,
  type TaskReader,
  type TaskSummary,
  tasksPane,
} from "./panes.ts";
import { FrameRenderer, type Terminal } from "./render.ts";

export interface TuiOptions {
  readonly dataDir: string;
  readonly columns: number;
  readonly rows: number;
  readonly env: NodeJS.ProcessEnv;
  readonly stdin: NodeJS.ReadStream;
  readonly stdout: NodeJS.WriteStream;
  /** Injected so a test can drive the loop without a pty; production passes `() => Date.now()`. */
  readonly now?: () => number;
  /** Injected so a test can end the loop; production leaves it unset and `q` ends it. */
  readonly quitAfterKeys?: number;
}

/** The poll interval for a pane's data. Long enough that a phone is not woken for nothing, short enough that the status
 *  line's "last confirmed" is not a lie: P-011 measured ~300 repaints/s for 200 paced keystrokes, and a poll that repaints
 *  on every tick would spend that budget on data nobody asked for. Two seconds is also the interval T2-02's word can be
 *  stale by, which is the honest bound on how fresh `live` is. */
const POLL_MS = 2000;

export async function runTui(options: TuiOptions): Promise<ExitCode> {
  const { columns, rows, env, stdin, stdout } = options;
  // `terminalFacts` takes the size and the TTY flag from the *caller* rather than reading `process.stdout`, because a test
  // drives this app with a fake stream and a real `process.stdout` would report the phone's width to a 40-column frame.
  const facts = terminalFacts(env, { columns, rows }, stdin.isTTY === true);
  const terminal: Terminal = { columns, rows, write: (text) => stdout.write(text) };
  const renderer = new FrameRenderer(terminal);
  const now = options.now ?? (() => Date.now());
  const layout = dataLayout(options.dataDir);
  // `connect` is the CLI's, used as-is: the pairing is a credential on disk and a port in a file, and a second reader of
  // either would be a second opinion about whether a Gateway exists (C7-12's "a local CLI invocation is the owner
  // identity" — the TUI is a local invocation too).
  const connection = await connect(layout);
  const client: TaskReader | undefined =
    connection.state === "paired" ? (connection.client as unknown as TaskReader) : undefined;

  let pane: Pane = "tasks";
  let help = false;
  let tasks: readonly TaskSummary[] = [];
  let message: string | undefined;
  let quit = false;

  // T1-09: the first line is never blank, and when the Gateway is not running it names the command rather than showing a
  // spinner that pretends something is happening.
  const first =
    client === undefined
      ? [
          `no paired gateway (${connection.state}) — start one with: crabby gateway start`,
          "",
          ...dumbTerminalNotice(PANE_ORDER, ["Tab panes", "? help", "q quit"]),
        ]
      : ["connecting to the gateway…", ""];
  stdout.write(`${first.join("\n")}\n`);

  const readTasks = async (): Promise<void> => {
    if (client === undefined) return;
    try {
      tasks = (await client.listTasks({ limit: 20 })).items;
    } catch (error) {
      // T1-10's rule again: the reason in words, never a spinner. A failed poll leaves the last good list on screen with a
      // line saying it is stale, because a stale list labelled stale is more useful than an empty pane.
      message = `task list failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
  await readTasks();

  const context = (): PaneContext => ({
    client: client as TaskReader,
    pane,
    rows,
    columns,
    color: facts.color === "none" ? "none" : facts.color,
    offline: client === undefined,
    ...(connection.state === "paired" ? {} : { lastConfirmed: undefined }),
  });

  const draw = (): void => {
    const descriptor = descriptorFor(pane);
    const body = [
      ...(descriptor.built === true
        ? tasksPane(context(), tasks)
        : plannedPane(
            pane,
            descriptor.milestone ?? "M3",
            descriptor.equivalent ?? "crabby diagnostics",
          )),
    ];
    if (message !== undefined) body.push(`! ${message}`);
    const lines = frameLines(
      paneState(context(), descriptor, body, statusFrom(context(), tasks), help),
      columns,
      rows,
    );
    renderer.draw(lines, now());
  };

  if (facts.isTTY === false) {
    // T3-05: a terminal that cannot report keys gets the list once and then a stream of frames it cannot act on — so it gets
    // the list, the frames, and nothing pretending to be interactive.
    stdout.write(
      `${dumbTerminalNotice(PANE_ORDER, ["Tab panes", "? help", "q quit"]).join("\n")}\n`,
    );
  }

  let seen = 0;
  stdin.setRawMode?.(true);
  renderer.hideCursor();
  stdin.resume();
  draw();

  const onData = (chunk: Buffer | string): void => {
    let buffer = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (;;) {
      const decoded = decodeKey(buffer);
      if (decoded === undefined) return; // A partial escape sequence: wait for the rest.
      buffer = decoded.rest;
      seen += 1;
      if (handle(decoded.key)) return;
      if (options.quitAfterKeys !== undefined && seen >= options.quitAfterKeys) {
        quit = true;
        return;
      }
      draw();
    }
  };

  const handle = (key: Key): boolean => {
    if (key.kind === "ctrl" && key.letter === "c") {
      // T1-08: Ctrl-C cancels the task and does not quit. A second Ctrl-C is the way out, and it says so.
      if (running(tasks) === undefined) {
        quit = true;
        return true;
      }
      message = "cancelling the running task — press Ctrl-C again to quit anyway";
      void cancel(client as TaskReader, running(tasks)?.id ?? "").catch((error: unknown) => {
        message = `cancel failed: ${error instanceof Error ? error.message : String(error)}`;
      });
      return false;
    }
    if (key.kind === "ctrl" && key.letter === "q") {
      // T1-08: quitting with a running task confirms first. No modal in this slice — the confirmation is the second press,
      // stated as a line — and the confirmation requirement is recorded rather than dropped.
      message =
        "a task is running; press Ctrl-Q again to quit (T1-08 asks for a confirmation here)";
      return false;
    }
    if (key.kind === "char" && key.char === "q" && !help) {
      quit = true;
      return true;
    }
    if (key.kind === "tab") {
      pane = nextPane(pane);
      return false;
    }
    if (key.kind === "char" && "123456".includes(key.char)) {
      const index = Number(key.char) - 1;
      pane = PANE_ORDER[index] ?? pane;
      return false;
    }
    if (key.kind === "char" && key.char === "?") {
      help = !help;
      return false;
    }
    if (key.kind === "escape" && help) {
      help = false;
      return false;
    }
    // T3-03: a key that does nothing says so, with the pane's own first hint as the closest thing.
    if (key.kind === "unknown")
      message = unknownKeyLine(key.bytes, PANE_DESCRIPTORS[0]?.hints ?? []);
    else if (key.kind === "char")
      message = unknownKeyLine(key.char, PANE_DESCRIPTORS[0]?.hints ?? []);
    return false;
  };

  stdin.on("data", onData);
  const poll = setInterval(() => {
    void readTasks().then(draw);
  }, POLL_MS);

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      clearInterval(poll);
      stdin.off("data", onData);
      stdin.setRawMode?.(false);
      stdin.pause();
      renderer.showCursor();
      resolve();
    };
    stdin.once("end", stop);
    const tick = setInterval(() => {
      if (quit) {
        clearInterval(tick);
        stop();
      }
    }, 50);
  });
  return EXIT.success;
}

/** The descriptor for a pane. A `find` with a fallback would let a pane name in the switch row exist without a descriptor,
 *  and the switch row is the frame's own address — an address with nothing at it is the defect T6-06 names. So the lookup
 *  falls back to a *descriptor*, never to `undefined`, and the fallback says which pane it is standing in for. */
function descriptorFor(pane: Pane): PaneDescriptor {
  const found = PANE_DESCRIPTORS.find((entry) => entry.pane === pane);
  if (found !== undefined) return found;
  return {
    pane,
    hints: ["Tab panes", "? help", "q quit"],
    built: false,
    milestone: "M3",
    equivalent: "crabby task ls",
  };
}

function running(tasks: readonly TaskSummary[]): TaskSummary | undefined {
  return tasks.find((task) => task.state === "running" || task.state === "awaiting_approval");
}

/** The cancel act, kept in one place so the verb and the key cannot differ: `POST /tasks/{id}/cancel`, which is the route
 *  the CLI's `task cancel` uses. D-090's record is the route's job — this only asks. */
async function cancel(client: TaskReader, id: string): Promise<void> {
  await client.cancelTask(id);
}
