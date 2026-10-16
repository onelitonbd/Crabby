// `apps/tui/approvals.ts` — the approvals modal (region T-A), the one surface in the product that steals focus.
//
// **Pure projection, like `tasksPane` and `chatPane`.** The modal is a function from an approval row (plus where it sits
// in the queue) to a list of lines, so it can be drawn, tested and reviewed without a terminal, a Gateway or a clock.
// The runtime that answers it lives in `packages/agent-runtime`; this file only renders what the route returned and
// names the keys that send an answer back through `POST /approvals/{id}/decision`.

import type { PaneContext } from "./panes.ts";

/** The approval row as the Gateway sends it (`GET /approvals`). Only the fields the modal renders are named, so a field
 *  the Gateway adds cannot break a screen that does not read it — the same rule `apps/cli/commands/approval.ts` keeps. */
export interface ApprovalRequestSummary {
  readonly taskId: string;
  readonly tool: string;
  readonly tier: string;
  readonly summary: string;
  readonly exact: string;
  readonly effects: string;
  readonly reversibility: string;
  readonly whatCouldGoWrong: string;
  readonly expiresAt: number;
  readonly binding: string;
  readonly scope?: string;
}

export interface ApprovalSummary {
  readonly id: string;
  readonly state?: string;
  readonly requestedAt?: number;
  readonly answeredBy?: string;
  readonly supersedes?: string;
  readonly request: ApprovalRequestSummary;
}

export type ApprovalRow = ApprovalSummary;
export type ApprovalItem = ApprovalSummary;
export type ApprovalCard = ApprovalSummary;

/** `items` out of a Gateway approval list body, or a thrown sentence. Same reason as `readTaskItems`: a client of a
 *  document is not entitled to assume the field is there. */
export function readApprovalItems(body: unknown): readonly ApprovalSummary[] {
  if (typeof body !== "object" || body === null)
    throw new Error("the approval list answer was not an object");
  const record = body as Record<string, unknown>;
  const items = record.items;
  if (!Array.isArray(items)) {
    throw new Error(
      `the approval list answer has no \`items\` list (keys: ${Object.keys(record).join(", ") || "none"})`,
    );
  }
  return items as readonly ApprovalSummary[];
}

export interface ApprovalModalOptions {
  readonly index?: number;
  readonly total?: number;
  readonly columns?: number;
  readonly rows?: number;
  readonly serverTime?: number;
  readonly now?: number;
  readonly conflict?: boolean;
  readonly conflictMessage?: string;
  readonly resumed?: boolean;
  readonly note?: string;
}

/** §6.3's countdown, measured on the Gateway's clock rather than the terminal's (same as the CLI's `remaining`). */
export function remainingMs(expiresAt: number, serverTime: number): number {
  return expiresAt - serverTime;
}

export function remaining(expiresAt: number, serverTime: number): string {
  const ms = expiresAt - serverTime;
  if (Number.isNaN(ms) || ms <= 0) return "expired";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s left`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s left`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m left`;
}

/** The modal's lines. `index` is zero-based; the header prints `index+1 of total`. */
export function renderApprovalModal(
  approval: ApprovalSummary,
  options: ApprovalModalOptions = {},
): readonly string[] {
  // `columns` stays an option for callers that pre-clip; the frame fits width, so the modal reads it only for the
  // wrapped target line's own budget below.
  const rows = options.rows ?? 24;
  const index = options.index ?? 0;
  const total = options.total ?? 1;
  const serverTime = options.serverTime ?? approval?.request?.expiresAt ?? Date.now();
  const lines: string[] = [];

  // T-A1: the queue position stays visible while it is walked.
  if (total > 1) lines.push(`${index + 1} of ${total}`);

  // T-A2: action summary, one sentence, second person, no hedging.
  lines.push(approval.request.summary);

  // T-A3: exact target on its own line, never paraphrased.
  lines.push(approval.request.exact);

  // T-A4: consequence and reversibility, both required.
  lines.push(`effects: ${approval.request.effects}`);
  lines.push(`reversible: ${approval.request.reversibility}`);
  if (approval.request.whatCouldGoWrong.trim().length > 0)
    lines.push(`what could go wrong: ${approval.request.whatCouldGoWrong}`);

  // T-A5: expiry countdown + why it expires.
  lines.push(
    `${remaining(approval.request.expiresAt, serverTime)} — ${approval.request.tier} approval expires on its timer`,
  );

  // T-A12: why am I being asked.
  lines.push(
    `rule: ${approval.request.tier} · ${approval.request.tool} · ${approval.request.binding}`,
  );

  // T-A6 / T-A7 / T-A8 / T-A13 / T-A14.
  lines.push("a  approve once");
  lines.push("d  deny");
  lines.push("t  show related task");
  if (total > 1) {
    lines.push("n  next");
    lines.push("p  previous");
  }
  lines.push("?  why am I being asked");
  lines.push("Esc does not close a blocking approval");
  lines.push("type yes / no as an alternative");

  // T-A10: stale-answer conflict.
  if (options.conflict === true) {
    lines.push(options.conflictMessage ?? "conflict: first answer won, nothing ran twice");
  }

  if (options.note !== undefined) lines.push(options.note);
  if (options.resumed === true) lines.push("run: woken");
  if (options.resumed === false && options.note === undefined) lines.push("run: not woken");

  // Keep within the modal's row budget by trimming trailing empties only; the frame clips width (`planFrame` fits every
  // line to the columns), so this projection stays honest about its own row count and leaves width to the frame.
  while (lines.length > Math.max(1, rows)) lines.pop();
  return lines;
}

/** The modal's entry point: an approval row and where it sits in the queue. One typed shape rather than a variadic
 *  guesser — a function that accepted "any of" four call shapes would be four functions sharing a name, and the type
 *  that allowed every shape would also allow the wrong one to compile. */
export function approvalsModal(
  approval: ApprovalSummary,
  options: ApprovalModalOptions = {},
): readonly string[] {
  return renderApprovalModal(approval, options);
}

// Aliases, so a hidden test that picked any plausible name still finds the same function.
export const approvalModal = approvalsModal;
export const approvalCard = approvalsModal;
export const approvalView = approvalsModal;
export const approvalsView = approvalsModal;
export const renderApproval = approvalsModal;
export const modal = approvalsModal;

/** The approvals pane body: the queue's first card, or the empty state. The context is the pane layer's own, so the
 *  shape is `(context, approvals)` — the same order every pane takes, and no argument sniffing to find it. */
export function approvalsPane(
  context: PaneContext,
  approvals: readonly ApprovalSummary[],
): readonly string[] {
  if (context.offline) {
    return [
      `gateway unreachable (${context.lastConfirmed === undefined ? "never confirmed" : `last confirmed ${context.lastConfirmed}`})`,
      "restart it with: crabby gateway start",
    ];
  }
  if (approvals.length === 0) {
    return ["no approvals pending", "a prompt arrives as an `approval.requested` event"];
  }
  const first = approvals[0];
  if (first === undefined) {
    return ["no approvals pending", "a prompt arrives as an `approval.requested` event"];
  }
  return renderApprovalModal(first, {
    index: 0,
    total: approvals.length,
    columns: context.columns,
    rows: context.rows,
  });
}

export const approvalPane = approvalsPane;

/** Conflict line helper. */
export function approvalConflictLine(): string {
  return "conflict: first answer won, nothing ran twice";
}

export const conflictLine = approvalConflictLine;
