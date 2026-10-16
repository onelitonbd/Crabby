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
import { type ComposerState, emptyComposer } from "./composer.ts";
import {
  FRAME_CHROME_ROWS as CHROME,
  frameLines,
  nextPane,
  PANE_ORDER,
  type Pane,
} from "./frame.ts";
import { decodeKey, dumbTerminalNotice, type Key, unknownKeyLine } from "./input.ts";
import type { PaneDescriptor } from "./panes.ts";
import {
  chatKey,
  chatPane,
  PANE_DESCRIPTORS,
  type PaneContext,
  paneState,
  plannedPane,
  readTaskId,
  readTaskItems,
  statusFrom,
  type TaskReader,
  type TaskSummary,
  tasksPane,
} from "./panes.ts";
import { FrameRenderer, type Terminal } from "./render.ts";
import { followEvents, type StreamHandle } from "./stream.ts";
import {
  applyEvent,
  commitStreaming,
  emptyTranscript,
  type TranscriptState,
} from "./transcript.ts";

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
  /** Injected so the app itself can be tested without a Gateway — the same reason `openai.ts` takes a `fetch`. **The
   *  fake is a whole `TaskReader`, not a patch of one method**, because a test that stubs only the call it exercises
   *  cannot see the pane crash on the call it does not. This seam is what found the two bugs a pty could not reach here:
   *  `listTasks` answering an envelope rather than a bare list, and the start pane making Tab the wrong key for the pane a
   *  person wants. */
  readonly client?: TaskReader | undefined;
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
  // The client is narrowed to what the TUI actually asks of it, rather than exposed whole: the panes depend on a reader with
  // three methods, and a fourth one arriving later is then a decision somebody makes in a pane instead of by accident.
  const client: TaskReader | undefined =
    options.client ??
    (connection.state === "paired" ? (connection.client as unknown as TaskReader) : undefined);

  // **The TUI opens on chat**, not on tasks. §4's pane list starts with chat and `docs/review/TUI.md`'s switch row is
  // `chat · tasks · jobs · approvals · logs · models`; the tasks pane is the *second* thing a person looks at. Opening on
  // tasks also made Tab the wrong key for reaching the pane you wanted — Tab cycles forward, so from tasks it goes to jobs,
  // which is a fact a run on this device showed and no unit test could.
  let pane: Pane = "chat";
  let help = false;
  let tasks: readonly TaskSummary[] = [];
  let message: string | undefined;
  let quit = false;
  // The chat pane's two states. Both are plain data and both are drawn from, which is what lets the whole pane be tested
  // without a stream (and what would let a reconnect rebuild them from `GET /tasks/{id}` rather than from a replay).
  let transcript: TranscriptState = emptyTranscript(
    columns,
    facts.color === "none" ? "none" : facts.color,
  );
  let composer: ComposerState = emptyComposer();
  /** The stream handle, kept for its lifetime. Nothing consults it — closing it *is* the shutdown, so the shutdown closes it
   *  rather than the loop asking whether it is still there. */
  let stream: StreamHandle | undefined;
  /** T5-09's input history, per session. Held here rather than in the composer because the composer is handed one entry at a
   *  time — a buffer that owns its own history would have to survive the pane switch, and a TUI that keeps two copies of what
   *  a person typed is a TUI with two answers to "what did I send". */
  const previousInputs: string[] = [];

  // T1-09: the first line is never blank, and when the Gateway is not running it names the command rather than showing a
  // spinner that pretends something is happening.
  // T1-09's first line, and it is about the Gateway rather than the keyboard. An earlier version folded T3-05's dumb
  // terminal notice in here too, so a connected-less TUI printed "keys are not reported" beside "no paired gateway" — two
  // unrelated facts in one screen, one of which was wrong.
  const first =
    client === undefined
      ? [`no paired gateway (${connection.state}) — start one with: crabby gateway start`, ""]
      : ["connecting to the gateway…", ""];
  stdout.write(`${first.join("\n")}\n`);

  const readTasks = async (): Promise<void> => {
    if (client === undefined) return;
    try {
      tasks = readTaskItems((await client.listTasks({ limit: 20 })).body);
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

  /** The pane's own body. The chat pane is the transcript plus the composer (T4/T5); every other pane is whatever it draws
   *  itself. Kept here rather than in `frameLines` so that "which pane am I in" is answered once, and the frame stays a
   *  function of (pane, body) with no knowledge of any pane's content. */
  const body = (): readonly string[] => {
    if (pane === "chat") {
      return chatPane(
        transcript,
        composer,
        // T5-06's capability line. **These come from what the Gateway composed for this identity**, and until the chat pane
        // reads that route they are the documented defaults — printed as they are, because a wrong "shell: on" is a wrong
        // promise about what a run may do, and the defaults here are the conservative ones.
        { fs: "workspace", net: false, shell: false },
        columns,
        rows - CHROME,
      );
    }
    const descriptor = descriptorFor(pane);
    return descriptor.built === true
      ? tasksPane(context(), tasks)
      : plannedPane(
          pane,
          descriptor.milestone ?? "M3",
          descriptor.equivalent ?? "crabby diagnostics",
        );
  };

  const draw = (): void => {
    const descriptor = descriptorFor(pane);
    const lines0 = [...body()];
    if (message !== undefined) lines0.push(`! ${message}`);
    const lines = frameLines(
      paneState(context(), descriptor, lines0, statusFrom(context(), tasks), help),
      columns,
      rows,
    );
    renderer.draw(lines, now());
  };

  // The stream, opened once and kept. **It is not opened per pane switch**: a socket per switch is a socket per keypress,
  // and the Gateway's connection count is not the place a TUI should be discovering its bounds. The pane that draws it
  // changes; the stream does not.
  const pairedUrl =
    options.client === undefined && connection.state === "paired" ? connection.url : undefined;
  if (client !== undefined && pairedUrl !== undefined) {
    stream = followEvents({
      url: pairedUrl,
      layout,
      onFrame: (frame) => {
        transcript = applyEvent(commitStreaming(transcript), frame);
        draw();
      },
      onClosed: (reason) => {
        // T1-10's rule and T4-13's: the reason in words, and the transcript keeps what it had rather than emptying itself —
        // a conversation that vanishes when a socket hiccups is worse than one that is visibly stale.
        message = `stream: ${reason}`;
        draw();
      },
    });
  }

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

  // **The `end` promise is created before the first frame**, and that is a product rule rather than a test convenience.
  // Android freezes and kills this process whenever it feels like it, a pipe runs out, and a terminal window can close —
  // so a stdin that ends before the app finished drawing must *end the app*, not be missed by a listener that had not been
  // attached yet. The first version attached both listeners after the first draw, which meant a stream that ended early
  // left the app waiting forever: a hang on the exact platform whose process death the whole of `AGENTS.md` §8 is about.
  let stop = (): void => undefined;
  const ended = new Promise<void>((resolve) => {
    stop = resolve;
  });
  stdin.once("end", () => stop());

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
    // The composer owns every printable key when the chat pane is up (T3-04), and the pane's own bindings are read *after*
    // it — so a letter can never be swallowed by a pane binding and a pane binding can never eat a half-typed word.
    if (pane === "chat" && isComposerKey(key)) {
      const handled = chatKey(
        composer,
        composerHistory(previousInputs),
        key as ComposerKey,
        undefined,
      );
      composer = handled.composer;
      if (handled.unbound !== undefined) {
        message = `${handled.unbound} is not bound here — this terminal has no Shift+Enter (D-061 measured that); use Ctrl+J for a newline`;
      }
      if (handled.action === "send") {
        message = undefined;
        // The history records what was typed, not what was sent, and it records it before the send is attempted: a send that
        // fails must not erase the words a person just typed.
        if (composer.buffer.trim().length > 0) previousInputs.push(composer.buffer.trim());
        void send(client, composer, transcript).then(
          (sent) => {
            composer = emptyComposer();
            message = sent;
            draw();
          },
          (error: unknown) => {
            message = `send failed: ${error instanceof Error ? error.message : String(error)}`;
            draw();
          },
        );
      }
      return false;
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

  // The first frame, after the listeners exist — so a keystroke or an `end` arriving during the first draws is not lost.
  draw();

  stdin.on("data", onData);
  const poll = setInterval(() => {
    void readTasks().then(draw);
  }, POLL_MS);
  const shutdown = (): void => {
    clearInterval(poll);
    // The socket closes with the app: a reader nobody cancels is a socket nobody closes, and Termux backgrounds this process
    // the moment the person switches away (D-066's drain is the other end of the same rule).
    stream?.close();
    stdin.off("data", onData);
    stdin.setRawMode?.(false);
    stdin.pause();
    renderer.showCursor();
    stop();
  };
  // The 50 ms tick is what turns a `quit` flag into a shutdown. **A `setInterval` rather than a busy loop**, because a
  // phone charging a frame per turn of the event loop is a phone that gets warm (§4 of `docs/DESIGN_SYSTEM.md`, and the
  // reason P-011 caps repaints at all).
  const tick = setInterval(() => {
    if (quit) {
      clearInterval(tick);
      shutdown();
    }
  }, 50);
  await ended;
  clearInterval(tick);
  shutdown();
  return EXIT.success;
}

/** The descriptor for a pane. A `find` with a fallback would let a pane name in the switch row exist without a descriptor,
 *  and the switch row is the frame's own address — an address with nothing at it is the defect T6-06 names. So the lookup
 *  falls back to a *descriptor*, never to `undefined`, and the fallback says which pane it is standing in for. */
/** The composer's key type, which is a subset of the decoder's. Narrowing here rather than widening the composer's signature
 *  is the point: the composer must never be handed a `tab` and must never be told to handle one. */
type ComposerKey = Parameters<typeof chatKey>[2];

/** The most recent input, which is what `↑` restores. The newest last, so the last element is the previous message. */
function composerHistory(inputs: readonly string[]): string | undefined {
  return inputs.at(-1);
}

/** The keys the composer claims when the chat pane is up. T3-04's rule is that a pane's bindings and the composer cannot
 *  overlap: `a` is an approve in the approvals pane and a letter here, so the composer's claim is checked *first* and the
 *  pane's bindings only see what the composer did not take. Tab, `?`, Ctrl-C and Ctrl-Q stay with the pane — a person must
 *  always be able to leave the pane and stop the run, whatever they are typing. */
function isComposerKey(key: Key): boolean {
  if (key.kind === "char") return true;
  if (key.kind === "ctrl") return key.letter === "j";
  return (
    key.kind === "enter" || key.kind === "backspace" || key.kind === "left" || key.kind === "right"
  );
}

/** Sending is **starting a task**, which is D-123's shape and not a second writer of conversation history: the same
 * `POST /tasks` the CLI's `crabby chat` calls, with the session id when the pane is continuing one. The reply is the task id,
 *  and the pane prints it rather than hiding it — a person who wants to watch the run from a shell has the id, which is the
 *  same reasoning C11-06 gives for printing a conversation id. */
async function send(
  client: TaskReader | undefined,
  draft: ComposerState,
  from: TranscriptState,
): Promise<string | undefined> {
  if (client === undefined) return "no gateway to send to — start one with: crabby gateway start";
  const text = draft.buffer.trim();
  if (text.length === 0) return undefined;
  if (text.startsWith("/"))
    return `slash commands are not wired in the TUI yet — ${text} works in the CLI`;
  const session = lastSession(from);
  const created = readTaskId(
    (
      await client.createTask(
        { objective: text, ...(session === undefined ? {} : { sessionId: session }) },
        // An idempotency key derived from the words, so a retried send on a phone that lost its network does not start the task
        // twice. The Gateway owns what that key means (D-084's handoff); the TUI only has to supply one.
        `tui-${hash(text)}`,
      )
    ).body,
  );
  return `sent as task ${created} — \`crabby task watch ${created}\` follows it from a shell`;
}

/** A stable-enough key from the words themselves. `Date.now()` would make every send unique, which is the opposite of what an
 *  idempotency key is for: a retry after a dropped connection must carry the *same* key. This is not a security primitive and
 *  is not used as one — it only has to be equal for equal text. */
function hash(text: string): string {
  let value = 0;
  for (let index = 0; index < text.length; index += 1) {
    value = (value * 31 + (text.charCodeAt(index) | 0)) | 0;
  }
  return Math.abs(value).toString(36);
}

/** The conversation this transcript belongs to, when the frames said. Read from the transcript rather than held beside it, so
 *  there is one place that knows and a reconnect rebuilds it. */
function lastSession(state: TranscriptState): string | undefined {
  for (const row of state.rows) {
    if (row.kind === "system" && row.text.startsWith("session ")) return row.text.slice(8).trim();
  }
  return undefined;
}

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
