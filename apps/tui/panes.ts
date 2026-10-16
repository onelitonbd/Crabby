// The TUI's panes: the tasks list (T6), and what the other five say until they are built.
//
// **One pane is real in this slice, and the other five say so in words rather than drawing an empty box.** T6-06 calls a
// blank pane a defect ("teaches the key and the CLI equivalent; a blank pane is a defect"), and that applies just as much
// to a pane that exists in the switch row and has nothing behind it: a user who presses `2` and sees a rectangle has been
// told less than a user who is told "this pane is not built yet, here is the CLI command that does it".
//
// The tasks pane reads `GET /api/v1/tasks` — the same route the CLI's `task ls` reads — and prints the same fields, so the
// TUI cannot drift from the CLI into a second opinion about a task list. **Every card is three lines** (T6-02): the task's
// objective, its state with progress, and its model with an approval mark. At 40 columns each line is clipped by the frame,
// so nothing here wraps: a wrapped card is how a task list turns into a wall of text on a phone.

import type { Response } from "@crabby/gateway";
import {
  actionFor,
  applyAction,
  type ComposerState,
  capabilityLine,
  composerView,
  emptyComposer,
  filterSlash,
} from "./composer.ts";
import type { FrameState, Pane, StatusState } from "./frame.ts";
import { statusLine } from "./frame.ts";
import { type TranscriptRow, type TranscriptState, visibleRows } from "./transcript.ts";

/** What the pane layer is given. A client, a layout and a renderer: no terminal, no escape sequences, no clock. That is the
 *  same boundary the CLI keeps (`apps/cli/connect.ts`), and it is what lets the panes be tested without a pty. */
export interface PaneContext {
  readonly client: TaskReader;
  readonly pane: Pane;
  readonly rows: number;
  readonly columns: number;
  readonly color: "truecolor" | "256" | "ansi" | "none";
  /** True when the connection is not `live`, which every pane turns into a line rather than into a spinner (T1-10). */
  readonly offline: boolean;
  readonly lastConfirmed?: string | undefined;
}

/**
 * The reader the TUI asks of a Gateway, and its shape is the **client's own**: `Response<T>`, i.e. `{ ok, status, body }`.
 * The first version of this interface promised `{ items }` directly and the app crashed on its first frame against a real
 * Gateway, because the cast that let the pane compile was also the cast that hid the envelope. So the interface says what
 * the client returns, and the pane reads `body.items` — where a missing field is a *message*, not a `TypeError`.
 */
export interface TaskReader {
  listTasks(options?: {
    readonly limit?: number;
    readonly state?: string;
  }): Promise<Response<unknown>>;
  /** T7's detail: the record, the run's own event tail and D-065's checkpoint view — the three reads the pane is a
   *  projection of. All three are client methods that already exist; naming them here keeps the pane's dependency the
   *  dependency's shape (D-131's rule). */
  getTask?(id: string): Promise<Response<unknown>>;
  taskEvents?(id: string, cursor?: number): Promise<Response<unknown>>;
  taskCheckpoint?(id: string): Promise<Response<unknown>>;
  /** T7-12's resume, over the same route `crabby task resume` uses. The pin body is the pane's business only when the
   *  person names one; the default (no body) continues on the model the run was using. */
  resumeTask?(id: string, body?: { readonly model?: string }): Promise<Response<unknown>>;
  /** T6-04: cancelling needs no modal in the TUI, the same as Web W5-03. It goes through the route the CLI's
   *  `task cancel` uses, so D-090's record is written by the Gateway either way — a keypress is not a second implementation
   *  of a cancellation, it is a request for one. */
  cancelTask(id: string): Promise<unknown>;
  /** T5-07's send is a **task start**, not a conversation write: the TUI sends through the same `POST /tasks` the CLI's
   *  `crabby chat` calls (D-123), so a chat is a run in every interface and there is no second writer of conversation
   *  history. The idempotency key is supplied by the caller because its meaning belongs to the Gateway's handoff. */
  createTask(
    body: { readonly objective: string; readonly sessionId?: string | undefined },
    idempotencyKey: string,
  ): Promise<Response<unknown>>;
  listApprovals?(options?: { readonly state?: string }): Promise<Response<unknown>>;
  /** `GET /diagnostics` — T15-05's artifact is the same document `crabby diagnostics` writes, so the pane and the verb
   *  refuse the same secret shapes and print the same kind of path. */
  diagnostics?(): Promise<Response<unknown>>;
  decideApproval?(
    id: string,
    body: { readonly decision: "approve" | "deny"; readonly scope?: string },
    idempotencyKey?: string,
  ): Promise<Response<unknown>>;
  listJobs?(options?: { readonly state?: string }): Promise<Response<unknown>>;
  /** `GET /jobs/{id}` — T17-04's detail reads the row, the bounded run history and the unacknowledged backlog rows from
   *  one answer, so a user deciding what to do about missed runs is not made to ask twice. */
  job?(id: string): Promise<Response<unknown>>;
  pauseJob?(id: string): Promise<Response<unknown>>;
  resumeJob?(id: string): Promise<Response<unknown>>;
  runJob?(id: string): Promise<Response<unknown>>;
  /** T17-06's non-material half: `PATCH /jobs/{id}` takes a name and a schedule. `objective` is not a field of the body
   *  at all — changing what a job does crosses into re-approval (§4.5) and no route in this build can open one (D-084). */
  patchJob?(
    id: string,
    body: { readonly name?: string; readonly schedule?: string },
  ): Promise<Response<unknown>>;
  /** T17-07's answer over `POST /jobs/{id}/backlog`. The body's `action` is `latest | skip`; T17-07's third answer
   *  (`each`) is the walk this TUI builds over `runJob` one decision at a time, because the wire has no `each` and a
   *  burst is what §4.5 forbids outright. */
  jobBacklog?(id: string, body: { readonly action: "latest" | "skip" }): Promise<Response<unknown>>;
}

/** `items` out of a Gateway list body, or a thrown sentence. **A client of a document is not entitled to assume the field is
 *  there**: an older Gateway, a proxy that rewrote the body, or a future route that renames the key would each produce a
 *  `TypeError` inside a pane, and a crash is the worst possible answer to "the list came back different". */
export function readTaskItems(body: unknown): readonly TaskSummary[] {
  if (typeof body !== "object" || body === null)
    throw new Error("the task list answer was not an object");
  const record = body as Record<string, unknown>;
  const items = record.items;
  if (!Array.isArray(items)) {
    throw new Error(
      `the task list answer has no \`items\` list (keys: ${Object.keys(record).join(", ") || "none"}) — this TUI speaks the ` +
        "Gateway's own body shape and will not invent a list from a document it does not recognise",
    );
  }
  return items as readonly TaskSummary[];
}

/** The id out of a task-creation answer, or a thrown sentence. Same reason as `readTaskItems`. */
export function readTaskId(body: unknown): string {
  if (typeof body !== "object" || body === null)
    throw new Error("the task answer was not an object");
  const id = (body as Record<string, unknown>).id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(
      "the gateway accepted the message but answered without a task id, so nothing can be followed",
    );
  }
  return id;
}

export interface TaskSummary {
  readonly id: string;
  readonly state: string;
  readonly objective: string;
  readonly model?: string | undefined;
  readonly elapsed?: string | undefined;
  readonly pendingApprovals?: number;
  readonly lastSeq?: number;
}

/** The status the pane can derive for itself, and only for itself: a pane does not invent a connection word, it is told the
 *  one the Gateway last confirmed (T2-02's rule about a client-side clock being a second opinion). */
export function statusFrom(
  context: PaneContext,
  tasks: readonly TaskSummary[],
  /** T17-08: a job whose run is waiting on a human raises the pending-approval count on the status line, so a stall that
   *  began in a *timer* is visible from every pane and not only from the jobs list. */
  jobs: readonly { readonly stateWord: string }[] = [],
): StatusState {
  const running = tasks.find(
    (task) => task.state === "running" || task.state === "awaiting_approval",
  );
  const deferredRuns = jobs.filter((job) => job.stateWord === "waiting-approval").length;
  const pending =
    tasks.reduce((total, task) => total + (task.pendingApprovals ?? 0), 0) + deferredRuns;
  return {
    connection: context.offline ? "offline" : "live",
    ...(context.lastConfirmed === undefined ? {} : { lastConfirmed: context.lastConfirmed }),
    ...(running?.model === undefined ? {} : { model: running.model }),
    ...(pending === 0 ? {} : { pendingApprovals: pending }),
    ...(running === undefined
      ? {}
      : {
          task: {
            id: running.id,
            state: running.state,
            ...(running.lastSeq === undefined ? {} : { step: running.lastSeq }),
          },
        }),
    ...(running?.elapsed === undefined ? {} : { elapsed: running.elapsed }),
  };
}

const CARD_LINES = 3;

/** The tasks pane's body. T6-01's filter row is a later slice; what is here is the list itself and the empty state, because
 *  an empty state is the first thing a new user sees and T6-06 makes it a teaching moment rather than a blank row. */
export function tasksPane(
  context: PaneContext,
  tasks: readonly TaskSummary[],
  /** T6's cursor. Optional so existing callers keep compiling; the `>` marker is how a phone knows which card Enter
   *  will open (T7's detail), and a marker that moved invisibly would be worse than none. */
  selected = 0,
): readonly string[] {
  if (context.offline) {
    // T1-10: the exact restart command, never a spinner pretending freshness.
    return [
      `gateway unreachable (${context.lastConfirmed === undefined ? "never confirmed" : `last confirmed ${context.lastConfirmed}`})`,
      "restart it with: crabby gateway start",
    ];
  }
  if (tasks.length === 0) {
    return [
      "no tasks yet",
      'start one with `t`, or from a shell: crabby task run "what should it do"',
      "(C11-02's rule applies here too: a blank pane is a defect)",
    ];
  }
  const height = Math.max(1, context.rows - 3);
  const shown = tasks.slice(0, Math.max(1, Math.floor(height / CARD_LINES)));
  const lines: string[] = [];
  for (let index = 0; index < shown.length; index += 1) {
    const task = shown[index] as TaskSummary;
    const cursor = index === selected ? ">" : " ";
    lines.push(`${cursor} ${task.objective}`);
    // T6-03: measured and estimated progress are different claims, so the fallback text says which one it is rather than
    // drawing a bar that looks like a measurement.
    const progress =
      task.lastSeq === undefined
        ? "progress unknown"
        : `progress ${task.lastSeq} (measured, from the event log)`;
    const approvals =
      task.pendingApprovals === undefined || task.pendingApprovals === 0
        ? ""
        : ` · ${task.pendingApprovals} approval(s) waiting`;
    lines.push(`  ${task.state} · ${progress}${approvals}`);
    // T2-09's rule lives here too: the id is on its own line, so long-press selection lands on it whole.
    lines.push(`  ${task.model ?? "the install default"} · ${task.id}`);
  }
  if (shown.length < tasks.length) {
    lines.push(`…and ${tasks.length - shown.length} more — \`crabby task ls\` lists them all`);
  }
  return lines;
}

/** The panes that are not built yet, in the words the element rows ask for. Each names the key, the milestone and the CLI
 *  command that reaches the same place today, because `docs/INTERFACES_AND_API.md` §8 forbids a shortcut-only capability
 *  and a pane row that promises a screen nobody can see is exactly that. */
export function plannedPane(pane: Pane, milestone: string, equivalent: string): readonly string[] {
  return [
    `${pane}: not built yet (${milestone})`,
    `the same thing from a shell today: ${equivalent}`,
    "the row that asks for it is in docs/review/TUI.md",
  ];
}

/** The chat pane's body (T4/T5), built from a transcript state and a composer state. **Both are plain data**, so the pane
 *  is a projection and the tests can read the rows without a stream, a pty or a clock.
 *
 *  The body is ordered transcript → composer → capability line, because that is the order the eye needs them in: the
 *  conversation, what you are about to add to it, and what that turn may do. The capability line is **below** the input on
 *  purpose (T5-06's row describes it as "before send"), so it is never mistaken for part of the message being composed. */
export function chatPane(
  transcript: TranscriptState,
  composer: ComposerState,
  capabilities: { readonly fs: string; readonly net: boolean; readonly shell: boolean },
  columns: number,
  /** The height **this pane** has, not the screen: the frame's own rows are subtracted by the caller, because the frame is
   *  the party that owns them and a pane that re-guessed the number would drift from it the first time the help sheet added a
   *  row. */
  rows: number,
): readonly string[] {
  // The composer takes up to six rows (T5-01), the capability line one, and the transcript gets what is left — never zero,
  // because a pane that has nothing left for the conversation is a pane that cannot show the answer.
  const composerLines = composerView(composer, columns).lines;
  const chrome = composerLines.length + 2;
  const height = Math.max(1, rows - chrome);
  const lines: string[] = [];
  const shown = visibleRows(transcript, height);
  for (const row of shown) {
    for (const line of rowLines(row)) lines.push(line);
  }
  const padding = Math.max(0, height - lines.length);
  for (let index = 0; index < padding; index += 1) lines.push("");
  lines.push(...composerLines);
  lines.push(capabilityLine(capabilities));
  // T5-03's menu, filtered as typed, under the input and at most six lines.
  for (const command of filterSlash(composer.buffer.slice(0, composer.cursor)))
    lines.push(`  ${command}`);
  // T4-12's held-position note, only when something is actually held.
  if (transcript.held > 0) lines.push(`  new content (${transcript.held}) — press End to follow`);
  return lines;
}

/** One transcript row's lines, flattened. A `tool` row is one collapsed line unless it was expanded (T4-07/T4-08), and an
 *  error row is the panel T4-11 asks for: a code, one human line, and whether it can be resumed — three facts and no toast,
 *  because there is no toast in a terminal. */
function rowLines(row: TranscriptRow): readonly string[] {
  switch (row.kind) {
    case "turn":
      return row.lines.map((line) => (row.role === "user" ? `│ ${line}` : line));
    case "system":
      return [`· ${row.text}`];
    case "tool":
      return row.lines.map((line) => `  ${line}`);
    case "error":
      return [
        `! ${row.code}: ${row.line}`,
        `  ${row.resumable ? "resumable: crabby task resume <id>" : "not resumable — the run cannot continue"}`,
      ];
    case "note":
      return [row.text];
    default:
      return [];
  }
}

/** Key handling for the chat pane: the composer's own table first, then the pane's bindings. **The composer wins for
 *  printable characters**, because T3-04's rule is that `a` is a literal in the composer and an approve elsewhere — a
 *  pane-level binding that swallowed printable keys would make the composer unusable. */
export function chatKey(
  composer: ComposerState,
  previousInput: string | undefined,
  key: Parameters<typeof actionFor>[0],
  paneBinding: string | undefined,
): {
  readonly composer: ComposerState;
  readonly action: string | undefined;
  readonly unbound?: string;
} {
  if (paneBinding !== undefined) {
    return { composer, action: paneBinding };
  }
  const action = actionFor(key, composer.buffer.length === 0);
  if (action.kind === "unbound") return { composer, action: undefined, unbound: action.bytes };
  if (action.kind === "send") return { composer: emptyComposer(), action: "send" };
  return { composer: applyAction(composer, action, previousInput), action: undefined };
}

export interface PaneDescriptor {
  readonly pane: Pane;
  readonly hints: readonly string[];
  readonly built: boolean;
  readonly milestone?: string;
  readonly equivalent?: string;
}

export const PANE_DESCRIPTORS: readonly PaneDescriptor[] = [
  {
    // Built: D-130's markdown/transcript/composer and D-131's stream + task-start send. The `built` flag is what the
    // frame's fallback reads, and a flag that says `false` here would route a pane that exists to `plannedPane`.
    pane: "chat",
    hints: ["i compose", "Enter send", "Tab panes", "? help", "q quit"],
    built: true,
  },
  {
    pane: "tasks",
    hints: ["j/k move", "Enter open", "c cancel", "Tab panes", "? help", "q quit"],
    built: true,
  },
  {
    // T17-05 names the four row keys and says the hint line is the authority — so the hint line lists exactly those
    // first, then the two affordances the region needs a key for and does not name (the detail T17-04 draws, and
    // T17-07's backlog prompt). `p` is pause *and* resume on one key because the row writes one key and two acts.
    pane: "jobs",
    hints: [
      "p pause/resume",
      "n run now",
      "e edit",
      "d delete",
      "Enter detail",
      "b backlog",
      "j/k move",
      "Tab panes",
      "? help",
      "q quit",
    ],
    built: true,
  },
  {
    // Built: T-A's modal (one card, n/p walk, typed answers) and the queue pane over `GET /approvals`.
    pane: "approvals",
    hints: ["y approve once", "n deny", "Tab panes", "? help", "q quit"],
    built: true,
  },
  {
    // T15-04 (decisions) and T15-05 (diagnostics) are wired; T15-01/03's log and audit views name their gap because
    // `GET /logs` and `GET /audit` have no routes in this build. The hint line lists only the keys that do something.
    pane: "logs",
    hints: ["v view", "d diagnostics", "Tab panes", "? help", "q quit"],
    built: true,
  },
  {
    // T11-03/04/06/08's editor is wired (`e`, `r`), and the hint line lists only what is possible right now (T3-01):
    // the probe (T11-07) is the row this build cannot act on and names its gap in the pane instead.
    pane: "models",
    hints: ["e edit", "r reset", "j/k move", "Tab panes", "? help", "q quit"],
    built: true,
    equivalent: "crabby model list / crabby model edit",
  },
];

export function paneState(
  context: PaneContext,
  descriptor: PaneDescriptor,
  body: readonly string[],
  status: StatusState,
  help: boolean,
): FrameState {
  return {
    pane: context.pane,
    panes: PANE_DESCRIPTORS.map((entry) => entry.pane),
    status,
    hints: descriptor.hints,
    body,
    help,
    color: context.color,
  };
}

export * from "./approvals.ts";
export * from "./jobs.ts";
export * from "./logs.ts";
export * from "./models.ts";
/** Re-exported so `main.ts` builds its frame through the same code path the tests do. */
export { statusLine };
