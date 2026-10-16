// `apps/tui/logs.ts` — the logs pane (region T15): the three views the rows name (log, audit, approval decisions), the
// diagnostics artifact T15-05 prices, and T15-07's assurance note. What this build cannot show, it names: `GET /logs`
// and `GET /audit` have no routes in this build (the CLI's `logs` and `audit` verbs are `planned` on exactly those
// milestones), so T15-01/02/03/06 and the log half of T15-08 print their gap and the command that reaches what exists —
// a pane row that promised a screen nobody can see would be the shortcut-only capability `docs/INTERFACES_AND_API.md`
// §8 forbids.
//
// What *is* wired: T15-04's approval-decisions view over `GET /approvals` (every prompt and its answer, `expired` as
// its own outcome — never rendered as a denial), and T15-05's artifact through the CLI's own `findUnsafeShapes` +
// `writeDiagnosticsArtifact`, so the TUI and `crabby diagnostics` write the same bundle to the same shape of path and
// refuse the same secret shapes before either writes a byte.

import type { ApprovalSummary } from "./approvals.ts";
import type { PaneContext } from "./panes.ts";
import { clip } from "./render.ts";

export type LogsView = "log" | "audit" | "decisions" | "clients" | "config";

/** The cycle grew by two: the access view (T14) and the config view (T13) live in this pane because the review's own
 *  grouping is "Settings/access/logs" and T1-02's six-name row has no seventh seat. The other three panes keep their
 *  views; `v` walks all five. */
export const LOGS_VIEWS: readonly LogsView[] = ["log", "audit", "decisions", "clients", "config"];

export function nextLogsView(view: LogsView): LogsView {
  const index = LOGS_VIEWS.indexOf(view);
  return LOGS_VIEWS[(index + 1) % LOGS_VIEWS.length] as LogsView;
}

/** T15-08's volume control: how much one view keeps on screen at once. A terminal buffering 100k lines is a memory leak
 *  with good manners — the row's own words — and the number is a *page*, so a list longer than it says so. */
export const VIEW_PAGE_LINES = 200;

/** T15-07's assurance note — W14-07's sentence, kept the same on both screens: redaction is a *tested* property
 *  (`SECURITY.md` §17), and a scary disclaimer would claim less than the tests already prove. */
export function assuranceLine(): string {
  return "redaction is verified by tests (SECURITY.md §17) — a `redacted` marker means something was there (T15-02)";
}

/** T15-01's gap: the log view needs `GET /logs`, and the row's own behavior (tail as the default, `tail` said while on)
 *  is about a route this build does not answer. The line names the milestone the registry already carries. */
export function logViewLines(): readonly string[] {
  return [
    "log view: not built — `GET /logs` has no route in this build (crabby logs is planned with it)",
    "T15-01/02/06's rows wait on that route; T15-08's paging is here as VIEW_PAGE_LINES, the page the view will use",
    "what exists today: `crabby diagnostics` writes a sanitized bundle and prints its path (d does the same here)",
  ];
}

/** T15-03's gap, named the same way: the audit view's fields (who, client, action, decision, tier, outcome, timestamps
 *  — W14-03's order) have no route to read. */
export function auditViewLines(): readonly string[] {
  return [
    "audit view: not built — `GET /audit` has no route in this build",
    "T15-03's fields will be who, which client, action, decision, tier, outcome, timestamps (W14-03's order)",
  ];
}

/** T15-04's row: one prompt and its answer, 1–2 lines. `expired` is its own outcome — the words are the wire's state
 *  (the five `APPROVAL_STATES`), never a re-derivation, because a second party that restated "this approval is
 *  expired" would be a second arbiter. The answer's author rides the second line when there is one. */
export function decisionLines(approval: ApprovalSummary, columns: number): readonly string[] {
  const state = approval.state ?? "pending";
  const request = approval.request;
  const head = `${state} · ${request.tier} · ${request.tool} · ${request.summary}`;
  // T15-04's content is "every prompt and its answer" — the answer is line two and it is whole at 40 columns, because
  // `expired — its own outcome, not a denial` is exactly the clause the row forbids losing. Timestamps are T15-03's
  // fields (the audit view's), not this row's, so they do not compete with the answer for the width.
  const answer =
    state === "pending"
      ? "waiting for an answer"
      : state === "expired"
        ? approval.answeredBy === undefined
          ? // The colon form is 38 cells and survives the 40-column design case whole; the em-dash form was 39 and
            // clipped the very clause T15-04 says must never be read as a denial.
            "expired: its own outcome, not a denial"
          : `expired after an answer by ${approval.answeredBy}`
        : `answered by ${approval.answeredBy ?? "unknown"}`;
  return [clip(head, columns), `  ${clip(answer, columns - 2)}`];
}

/** T15-04's view: every prompt and its answer, paged to T15-08's bound with the count of what was left out. */
export function decisionsViewLines(
  approvals: readonly ApprovalSummary[],
  columns: number,
): readonly string[] {
  if (approvals.length === 0) {
    return ["no prompts have been asked yet", "a T2 or T3 step opens one at run time (§6)"];
  }
  const lines: string[] = [];
  const shown = approvals.slice(0, VIEW_PAGE_LINES);
  for (const approval of shown) lines.push(...decisionLines(approval, columns));
  if (approvals.length > shown.length) {
    lines.push(
      `…and ${approvals.length - shown.length} more (T15-08 pages at ${String(VIEW_PAGE_LINES)})`,
    );
  }
  return lines;
}

/** T15-05's result line: the path is the point — the clipboard is unreliable over ssh, and a printed path always works. */
export function diagnosticsLine(file: string, bytes: number): string {
  return `sanitized diagnostics written to ${file} (${String(bytes)} bytes) — the path copies better than a clipboard over ssh (T15-05)`;
}

/** The pane body for one view. Every view carries T15-07's note, because the marker a `redacted` word stands for is
 *  explained where the markers would appear. */
export function logsPane(
  context: PaneContext,
  view: LogsView,
  decisions: readonly ApprovalSummary[] = [],
): readonly string[] {
  if (context.offline) {
    return [
      `gateway unreachable (${context.lastConfirmed === undefined ? "never confirmed" : `last confirmed ${context.lastConfirmed}`})`,
      "restart it with: crabby gateway start",
    ];
  }
  const body =
    view === "log"
      ? logViewLines()
      : view === "audit"
        ? auditViewLines()
        : decisionsViewLines(decisions, context.columns);
  return [...body, assuranceLine()];
}
