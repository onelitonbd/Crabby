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

import type { FrameState, Pane, StatusState } from "./frame.ts";
import { statusLine } from "./frame.ts";

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

export interface TaskReader {
  listTasks(options?: { readonly limit?: number; readonly state?: string }): Promise<{
    items: readonly TaskSummary[];
  }>;
  /** T6-04: cancelling needs no modal in the TUI, the same as Web W5-03. It goes through the route the CLI's
   *  `task cancel` uses, so D-090's record is written by the Gateway either way — a keypress is not a second implementation
   *  of a cancellation, it is a request for one. */
  cancelTask(id: string): Promise<unknown>;
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
export function statusFrom(context: PaneContext, tasks: readonly TaskSummary[]): StatusState {
  const running = tasks.find(
    (task) => task.state === "running" || task.state === "awaiting_approval",
  );
  const pending = tasks.reduce((total, task) => total + (task.pendingApprovals ?? 0), 0);
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
export function tasksPane(context: PaneContext, tasks: readonly TaskSummary[]): readonly string[] {
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
  for (const task of shown) {
    lines.push(`> ${task.objective}`);
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

export interface PaneDescriptor {
  readonly pane: Pane;
  readonly hints: readonly string[];
  readonly built: boolean;
  readonly milestone?: string;
  readonly equivalent?: string;
}

export const PANE_DESCRIPTORS: readonly PaneDescriptor[] = [
  {
    pane: "chat",
    hints: ["i compose", "Enter send", "Tab panes", "? help", "q quit"],
    built: false,
    milestone: "M3 chat pane (T4, T5)",
    equivalent: "crabby chat",
  },
  {
    pane: "tasks",
    hints: ["j/k move", "Enter open", "c cancel", "Tab panes", "? help", "q quit"],
    built: true,
  },
  {
    pane: "jobs",
    hints: ["p pause", "r resume", "Tab panes", "? help", "q quit"],
    built: false,
    milestone: "M3 jobs pane (T17)",
    equivalent: "crabby job ls / job pause / job resume",
  },
  {
    pane: "approvals",
    hints: ["y approve once", "n deny", "Tab panes", "? help", "q quit"],
    built: false,
    milestone: "M3 approvals modal (T-A)",
    equivalent: "crabby approval approve/deny",
  },
  {
    pane: "logs",
    hints: ["Tab panes", "? help", "q quit"],
    built: false,
    milestone: "M3 logs pane",
    equivalent: "crabby diagnostics",
  },
  {
    pane: "models",
    hints: ["e edit override", "Tab panes", "? help", "q quit"],
    built: false,
    milestone: "M3 models pane",
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

/** Re-exported so `main.ts` builds its frame through the same code path the tests do. */
export { statusLine };
