// The TUI's frame: the rows that are the same in every pane — the pane switch row, the status line and the hint strip —
// and the layout arithmetic that keeps them usable at 40 columns.
//
// **`docs/UI_UX_SPEC.md` §4 makes 40 columns the design case, not the smallest**, so every row here is built from a *weight*
// and a documented drop order rather than from column counts. That is also why this file is pure: the frame is a function
// from a state to a list of lines, and the only thing that knows about escape sequences is `render.ts`.
//
// **Three rows from the element inventory, each with a rule that is easy to satisfy halfway:**
//
//   - **T2-08's drop order** is `queue → tunnel → vault → task state`, and `model`, `connection` and `approvals` **never**
//     drop. Not "prefer" — never. A frame that loses the connection word when the terminal narrows is a frame that looks
//     alive while it cannot confirm anything, which §7.2 of `docs/UI_UX_SPEC.md` and T1-10 both call out. So the drop
//     order is applied from the *end* of that list backwards, and the three protected fields are measured in first, so a
//     width that cannot hold them produces a truncated field rather than a missing one.
//   - **T2-02's word is always present**: `live` / `reconnecting` / `offline` plus the last confirmed time, and never
//     colour-only. In the 8-colour tier (`docs/DESIGN_SYSTEM.md` §2.1) the fields lose their colour and keep their words.
//   - **T1-06's below-40 state** is not a reflow into unreadability: the status line, one pane row, and one line naming the
//     minimum. A 30-column terminal is narrower than the design case, and the honest thing to say there is what the design
//     case is.
import { fit, visibleWidth } from "./render.ts";

export const DESIGN_COLUMNS = 40;
export const MINIMUM_COLUMNS = 40;

export type ConnectionState = "live" | "reconnecting" | "offline";

export interface StatusState {
  readonly connection: ConnectionState;
  /** When the connection was last confirmed, in the interface's own words ("12:04"). Not a timestamp the TUI computes: the
   *  Gateway is the party that knows when it answered, and a client-side clock is a second opinion. */
  readonly lastConfirmed?: string | undefined;
  /** `provider/model`, or undefined when the install has none — which is a fact to print, not a field to omit (C10-01's
   *  clause about hidden empties). */
  readonly model?: string | undefined;
  /** The ladder fired and the run moved to a different model (D-043), so the status line marks it rather than quietly
   *  showing the new one. */
  readonly modelFallback?: boolean;
  readonly pendingApprovals?: number;
  readonly tunnel?: string | undefined;
  readonly vault?: "locked" | "ok";
  readonly task?: {
    readonly id: string;
    readonly state: string;
    readonly step?: number;
    readonly total?: number;
  };
  readonly elapsed?: string | undefined;
  readonly queued?: number;
}

export interface FrameState {
  readonly pane: Pane;
  readonly panes: readonly Pane[];
  readonly status: StatusState;
  /** Up to six hints (T3-01), most useful first — the row's own cap. The strip shows what fits, so the pane's caller
   *  orders them and does not have to measure. */
  readonly hints?: readonly string[];
  /** The pane's own lines, which may be taller than the screen: the frame keeps the *last* `height - chrome` of them, so
   *  a chat transcript scrolls instead of pushing the status line off the bottom. */
  readonly body?: readonly string[];
  readonly help?: boolean;
  readonly color: "truecolor" | "256" | "ansi" | "none";
}

export type Pane = "chat" | "tasks" | "jobs" | "approvals" | "logs" | "models";

export const PANE_ORDER: readonly Pane[] = ["chat", "tasks", "jobs", "approvals", "logs", "models"];

/** T1-02's row, with the 40-column abbreviation: six names plus separators do not fit in 40 columns as words, so each name
 *  becomes its first three characters. The full names are in the help sheet (T3-02), which is the documented place for
 *  detail rather than a row that wraps. */
export function paneRow(panes: readonly Pane[], active: Pane, columns: number): string {
  const wide = panes.map((pane) => (pane === active ? `>${pane}` : ` ${pane}`));
  const wideText = wide.join(" ");
  if (visibleWidth(wideText) <= columns) return wideText;
  const narrow = panes.map((pane) =>
    pane === active ? `>${pane.slice(0, 3)}` : ` ${pane.slice(0, 3)}`,
  );
  return fit(narrow.join(" "), columns);
}

export function nextPane(active: Pane, panes: readonly Pane[] = PANE_ORDER): Pane {
  const index = panes.indexOf(active);
  return panes[(index + 1) % panes.length] ?? active;
}

/** T2's status line as **segments**, each carrying its **budget** — the row's own "Sizes" column, which is the part that
 *  turns "does not drop" into something arithmetic. A segment is a value plus how many columns it may take; the line is the
 *  sum of the budgets plus two columns per separator.
 *
 *  **The protected set is `model`, `connection` and `approvals`** (T2-08 says they never drop), and their budgets are the
 *  row's 18 / 12 / 10 — 40 columns exactly, with no room for separators, which is itself the finding: at the design width
 *  every field is present and each is clipped to a share. Clipping a *field* is not dropping a field, and the difference is
 *  the whole row. */
export interface Segment {
  /** The part that must survive any shrink: `model:`, the connection's state word, `approvals:`. A field that keeps its
   *  label and loses its value is still a field; a field whose *label* is clipped is a value with no name beside it, which
   *  is how a status line ends up saying `approva…` about something that is not obviously an approval count. */
  readonly label: string;
  readonly value: string;
  /** Columns this segment may take at full size (T2-01…T2-07). */
  readonly budget: number;
  readonly protected: boolean;
  /** 0 is dropped first. `queue → tunnel → vault → task state` is the row's order, so queue is 0. */
  readonly dropRank?: number;
  /** Order in which a segment's *value* gives way when the line is still too long — 0 first. This is a second, finer
   *  order than `dropRank`, and it exists because dropping a whole field and shortening a value are different costs: the
   *  connection's age goes first, because a person who needs it can press `?`, and a model name with no id is a field that
   *  cannot be acted on. */
  readonly valueDropRank?: number;
}

/** `label + value`, which is what the line shows. */
export function segmentText(segment: Segment): string {
  return `${segment.label}${segment.value}`;
}

const BUDGET = {
  model: 18,
  connection: 12,
  approvals: 10,
  task: 22,
  vault: 8,
  tunnel: 14,
  queue: 10,
} as const;

const DROP_RANK = { queued: 0, tunnel: 1, vault: 2, task: 3 } as const;

export function statusSegments(status: StatusState): readonly Segment[] {
  const model = `model: ${status.model ?? "none"}${status.modelFallback === true ? " (fell back)" : ""}`;
  // T2-02's field is the *word* plus the time: the word is the label and the time is the value, so a narrow terminal
  // drops the age and keeps the word — and `live` alone is a complete answer.
  const connection =
    status.connection === "live"
      ? "live"
      : status.connection === "reconnecting"
        ? "reconnecting"
        : "offline";
  const connectionValue =
    status.lastConfirmed === undefined
      ? ""
      : status.connection === "offline"
        ? ` since ${status.lastConfirmed}`
        : ` ${status.lastConfirmed}`;
  const segments: Segment[] = [
    {
      label: "model: ",
      value: model.slice("model: ".length),
      budget: BUDGET.model,
      protected: true,
      valueDropRank: 1,
    },
    {
      label: connection,
      value: connectionValue,
      budget: BUDGET.connection,
      protected: true,
      valueDropRank: 0,
    },
    {
      label: "approvals: ",
      value: String(status.pendingApprovals ?? 0),
      budget: BUDGET.approvals,
      protected: true,
    },
  ];
  if (status.task !== undefined) {
    const progress =
      status.task.step !== undefined && status.task.total !== undefined
        ? ` ${status.task.step}/${status.task.total}`
        : "";
    segments.push({
      label: status.task.state,
      value: `${progress}${status.elapsed === undefined ? "" : ` ${status.elapsed}`}`,
      budget: BUDGET.task,
      protected: false,
      dropRank: DROP_RANK.task,
    });
  }
  if (status.vault !== undefined)
    segments.push({
      label: "vault: ",
      value: status.vault,
      budget: BUDGET.vault,
      protected: false,
      dropRank: DROP_RANK.vault,
    });
  if (status.tunnel !== undefined)
    segments.push({
      label: "tunnel: ",
      value: status.tunnel,
      budget: BUDGET.tunnel,
      protected: false,
      dropRank: DROP_RANK.tunnel,
    });
  if (status.queued !== undefined && status.queued > 1)
    segments.push({
      label: "queued: ",
      value: String(status.queued),
      budget: BUDGET.queue,
      protected: false,
      dropRank: DROP_RANK.queued,
    });
  return segments;
}

/** **Three** columns per separator — ` · ` is a space, a middle dot and a space — so a line of `n` fields costs
 *  `sum(budgets) + 3 * (n - 1)`. This constant was one too small the first time, and the symptom was a status line whose
 *  last field's *label* was clipped at exactly 40 columns: the cost model said the line fitted, the terminal disagreed, and
 *  the last-resort `fit` took the difference out of a name. A width constant that is wrong in the direction of "looks fine"
 *  is worse than no constant. */
const SEPARATOR = 3;

export function statusLine(status: StatusState, columns: number): string {
  let kept: Segment[] = [...statusSegments(status)];
  const cost = (list: readonly Segment[]): number =>
    list.reduce(
      (total, segment) => total + Math.min(segment.budget, visibleWidth(segmentText(segment))),
      0,
    ) +
    Math.max(0, list.length - 1) * SEPARATOR;
  while (cost(kept) > columns) {
    // The documented order, applied one field at a time: the *lowest* rank among the droppables goes first. T2-08 says
    // queue, then tunnel, then vault, then task state, which is exactly ascending rank.
    const worst = kept
      .filter((segment) => !segment.protected)
      .reduce<Segment | undefined>(
        (lowest, segment) =>
          lowest === undefined || (segment.dropRank ?? 99) < (lowest.dropRank ?? 99)
            ? segment
            : lowest,
        undefined,
      );
    if (worst === undefined) break;
    kept = kept.filter((segment) => segment !== worst);
  }
  // Every droppable is gone and it still does not fit: the protected fields are clipped to a **share** of what is left,
  // proportionally to their budgets, with a floor so a field is never squeezed into an ellipsis. This is T2-08's "never
  // drop" taken literally — a shorter field is not an absent one, and `model: loc…` is still a model field.
  const separatorCost = Math.max(0, kept.length - 1) * SEPARATOR;
  const available = columns - separatorCost;
  const wanted = kept.reduce((total, segment) => total + visibleWidth(segmentText(segment)), 0);
  if (wanted > available) {
    kept = kept.map((segment) => {
      // The *weight* is the budget capped by the real width: a 10-column field with a 14-column budget is worth 10 columns,
      // and a field already inside its budget is not entitled to take more than it uses.
      const full = Math.min(segment.budget, visibleWidth(segmentText(segment)));
      // **The label is untouchable and the value is what gives way.** `approvals: 2` at 9 columns becomes `approvals…2`? No —
      // it becomes `approvals:` with the count clipped to one column, because the count *is* the field and the word is its
      // name. A floor of `label + 1` keeps both a name and at least one character of value, which is the smallest thing that
      // is still a field rather than a decoration.
      const share = Math.max(segment.label.length + 1, Math.floor((available * full) / wanted));
      const valueShare = Math.max(1, share - segment.label.length);
      return { ...segment, value: fit(segment.value, valueShare) };
    });
    // The `label + 1` floor can overshoot on a narrow line, and the last-resort `fit` below would then clip a *label* — the
    // one thing this whole arrangement exists to prevent. So the overshoot is taken back out of the values, one column at
    // a time from the longest one, and the loop stops when only the labels are left. A status line whose fields are names
    // with nothing after them is ugly; a status line whose names are ellipsised is unreadable.
    let total = kept.reduce((sum, segment) => sum + visibleWidth(segmentText(segment)), 0);
    while (total > available) {
      // The segment whose value gives way next: lowest `valueDropRank`, and within a rank the longest value — so the
      // connection's age goes before the model's name, and a long model name goes before a short one.
      const next0 = kept.reduce<Segment | undefined>((candidate, segment) => {
        if (segment.value.length === 0) return candidate;
        if (candidate === undefined) return segment;
        const rank = segment.valueDropRank ?? 2;
        const best = candidate.valueDropRank ?? 2;
        return rank < best || (rank === best && segment.value.length > candidate.value.length)
          ? segment
          : candidate;
      }, undefined);
      if (next0 === undefined) break;
      // To nothing, not to an ellipsis: `clip("x", 1)` is still one character, so shrinking towards an ellipsis would
      // loop forever and the last-resort `fit` would then cut a label.
      const shrunk = next0.value.length <= 1 ? "" : fit(next0.value, next0.value.length - 1);
      kept = kept.map((segment) => (segment === next0 ? { ...segment, value: shrunk } : segment));
      total -= next0.value.length - shrunk.length;
    }
  }
  return fit(kept.map((segment) => segmentText(segment)).join(" · "), columns);
}

/** T3-01's hint strip: up to six hints at 40 columns, and every key the pane can actually act on is in it. The strip is
 *  truncated rather than wrapped, because a wrapped strip costs a line of the pane and a wrapped key list is unreadable. */
export function hintStrip(hints: readonly string[], columns: number): string {
  const picked: string[] = [];
  let text = "";
  for (const hint of hints.slice(0, 6)) {
    const candidate = picked.length === 0 ? hint : `${text} · ${hint}`;
    if (visibleWidth(candidate) > columns) break;
    picked.push(hint);
    text = candidate;
  }
  return text;
}

/** The whole frame, top to bottom: pane row, body, status line, hint strip. **The order is the inventory's**: T1-02's row is
 *  the address of what is on screen, the body is the screen, and T2's line is pinned at the *bottom* because it is the one
 *  row that must be true no matter what the pane is doing (`docs/UI_UX_SPEC.md` §4).
 *
 *  **The body is trimmed from the front, keeping the tail.** A chat transcript and a task list both grow at the end, and a
 *  frame that trimmed the end would hide the newest thing on screen — the opposite of what a live pane is for. */
export function frameLines(state: FrameState, columns: number, rows: number): readonly string[] {
  if (state.help) {
    // T1-02's row is hidden while the help overlay is open: two rows of navigation above a sheet that is itself about
    // navigation is one row too many at 40 columns.
    return helpLines(state, rows);
  }
  if (columns < MINIMUM_COLUMNS) {
    // T1-06: status line + one pane + the line naming the minimum. Not a reflow into unreadability.
    const body = (state.body ?? [])[(state.body ?? []).length - 1];
    return [
      `narrow: ${columns} columns, below the ${MINIMUM_COLUMNS} this app is built for`,
      fit(body ?? "", columns),
      statusLine(state.status, columns),
    ];
  }
  const chrome = 3;
  const bodyHeight = Math.max(1, rows - chrome);
  // Fitted here as well as in the renderer, and the reason is that **the frame is where widths are decided**: a body line
  // that only gets clipped at write time is a line a pane can measure wrongly (a progress bar sized for 80 columns, a wrap
  // decision made against the wrong width) and a line a test cannot assert on without a terminal. One place decides, and the
  // renderer's fit is the belt to this braces.
  const body = (state.body ?? []).slice(-bodyHeight).map((line) => fit(line, columns));
  const padding = Array.from({ length: Math.max(0, bodyHeight - body.length) }, () => "");
  return [
    paneRow(state.panes, state.pane, columns),
    ...padding,
    ...body,
    statusLine(state.status, columns),
    hintStrip(state.hints ?? [], columns),
  ];
}

/** T3-02's overlay content, and the one place T1-04's promise is kept: the sheet says which buffer the app draws in, so
 *  "what happens to scrollback" is answered by the app rather than discovered by a user who scrolled away from it. */
function helpLines(state: FrameState, rows: number): readonly string[] {
  const sheet: readonly (readonly string[])[] = [
    ["keys", "Tab panes · 1-6 jump · ? this sheet · q quit"],
    ["scrollback", "inline (D-061): what you scroll past stays yours"],
    ["panes", state.panes.join(" · ")],
    ["status", "model · connection · approvals never drop at 40 columns (T2-08)"],
  ];
  const height = Math.max(1, rows - 1);
  const lines = [
    "help — Esc or ? closes",
    ...sheet.flatMap(([label, text]) => [` ${label}: ${text}`]),
  ];
  return lines.slice(0, height);
}
