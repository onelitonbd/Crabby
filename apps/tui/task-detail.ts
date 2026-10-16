// `apps/tui/task-detail.ts` — the task detail pane (region T7), a pure projection over the three reads a detail needs:
// `GET /tasks/{id}` (the record), `GET /tasks/{id}/events` (the run's own log tail) and `GET /tasks/{id}/checkpoint`
// (D-065's boundary and verdict). Nothing here mutates: `c` asks the same cancel route the tasks pane does, `r` the
// same resume route the CLI's `task resume` does — a keypress is a request, never a second implementation.
//
// The region's own discipline, kept row by row: the id gets its own selectable line (T7-01/T2-09 — long-press
// selection is how Termux copies), the step rows are plain-space indented so the ASCII tier reads identically
// (T7-02/T10-04), the checkpoint panel speaks D-044's words ("resume continues, it never restarts"), and "what did not
// happen" is a required section, not an optional one (T7-11). What a route does not answer, the pane names — the same
// honesty `plannedPane` keeps elsewhere.

import type { Event, TaskCheckpoint, TaskRecord } from "@crabby/api-contracts";
import { wrapText } from "@crabby/platform";
import { clip } from "./render.ts";

/** The detail's own state: the three reads, paged through T7-09's history, with the tail toggle T7-13 prices. */
export interface TaskDetailState {
  readonly record: TaskRecord;
  readonly checkpoint?: TaskCheckpoint | undefined;
  readonly checkpointNote?: string | undefined;
  readonly events: readonly Event[];
  readonly approvalsPending: readonly { readonly id: string; readonly summary: string }[];
  readonly tail: boolean;
  readonly scrolled: number;
}

export function emptyTaskDetail(
  record: TaskRecord,
  checkpoint?: TaskCheckpoint,
  checkpointNote?: string,
): TaskDetailState {
  return {
    record,
    ...(checkpoint === undefined ? {} : { checkpoint }),
    ...(checkpointNote === undefined ? {} : { checkpointNote }),
    events: [],
    approvalsPending: [],
    tail: true,
    scrolled: 0,
  };
}

/** `items` out of the events answer, or a thrown sentence — the D-131 rule every reader of a Gateway body keeps. */
export function readEventItems(body: unknown): readonly Event[] {
  if (typeof body !== "object" || body === null)
    throw new Error("the events answer was not an object");
  const items = (body as Record<string, unknown>).items;
  if (!Array.isArray(items)) {
    throw new Error(
      "the events answer has no `items` list — this TUI speaks the Gateway's own body shape",
    );
  }
  return items as readonly Event[];
}

/** One tool step out of the event log: proposed → started → completed/failed/blocked, with the duration the `ts` pair
 *  gives and the attempt count named as the ladder stage it is (T7-03). Events arrive in `seq` order, so the fold is
 *  stable without a second sort. */
export interface ToolStep {
  readonly tool: string;
  readonly tier: string;
  readonly status: "proposed" | "running" | "completed" | "failed" | "blocked";
  readonly startedAt?: string | undefined;
  readonly endedAt?: string | undefined;
  readonly attempts: number;
  readonly output?: string | undefined;
  readonly reason?: string | undefined;
}

function payloadText(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  return undefined;
}

/** Fold the task's events into the steps T7-03 draws. A `toolCallId` groups them; an event without one is still a
 *  line — dropping it would be dropping the only evidence a step happened. */
export function toolSteps(events: readonly Event[]): readonly ToolStep[] {
  const steps = new Map<string, ToolStep & { readonly key: string }>();
  const order: string[] = [];
  for (const event of events) {
    if (!event.type.startsWith("tool.")) continue;
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const key = payloadText(payload.toolCallId) ?? `${event.type}:${String(event.seq)}`;
    const tool = payloadText(payload.tool) ?? payloadText(payload.toolName) ?? "tool";
    const tier = payloadText(payload.tier) ?? "?";
    const found = steps.get(key);
    if (found === undefined) order.push(key);
    const created: ToolStep & { readonly key: string } = found ?? {
      key,
      tool,
      tier,
      status: "proposed",
      attempts: 1,
    };
    // Each event folds into a fresh record (the readonly shapes are contracts, not conveniences), and a restart is a
    // new attempt: the previous attempt's end stamp must not survive into this one's duration, or the row would
    // measure attempt two with attempt one's failure and answer a negative number's `?`. The fold writes through a
    // mutable alias and only the assembled map is exposed.
    const current: {
      -readonly [K in keyof (ToolStep & { readonly key: string })]: (ToolStep & {
        readonly key: string;
      })[K];
    } = { ...created };
    switch (event.type) {
      case "tool.call.proposed":
        current.status = "proposed";
        break;
      case "tool.execution.started":
        current.status = "running";
        current.startedAt = event.ts;
        current.endedAt = undefined;
        current.reason = undefined;
        break;
      case "tool.execution.completed":
        current.status = "completed";
        current.endedAt = event.ts;
        current.output = payloadText(payload.summary) ?? payloadText(payload.path);
        break;
      case "tool.execution.failed":
        current.status = "failed";
        current.endedAt = event.ts;
        current.reason = payloadText(payload.reason) ?? payloadText(payload.class);
        // A retry is the ladder spending an attempt, and the row says so as `3/5`, not as a bare count (T7-03).
        current.attempts += 1;
        break;
      case "tool.execution.blocked":
        current.status = "blocked";
        current.reason = payloadText(payload.reason) ?? "policy refused this call";
        break;
      default:
        break;
    }
    steps.set(key, current);
  }
  return order.map((key) => {
    const step = steps.get(key) as ToolStep & { readonly key: string };
    const { key: _ignored, ...rest } = step;
    return rest;
  });
}

/** Duration between two ISO stamps, as the word a phone reads. Unparsable pairs answer `?` rather than a lie. */
export function stepDuration(startedAt: string | undefined, endedAt: string | undefined): string {
  if (startedAt === undefined || endedAt === undefined) return "?";
  const ms = Date.parse(endedAt) - Date.parse(startedAt);
  if (Number.isNaN(ms) || ms < 0) return "?";
  if (ms < 1000) return `${String(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** T7-11's "what did not happen": a required section, derived from where the run stopped. A task that ended `failed`
 *  with steps proposed-but-never-run names them; a terminal task with none says so in words — the section is present
 *  either way, because its absence is how a partial completion reads as a whole one. */
export function notHappenedLines(
  record: TaskRecord,
  steps: readonly ToolStep[],
): readonly string[] {
  const lines: string[] = ["what did not happen:"];
  const neverRan = steps.filter((step) => step.status === "proposed" || step.status === "running");
  if (record.state === "completed" && neverRan.length === 0) {
    lines.push("  nothing was left undone — every proposed step ran");
    return lines;
  }
  if (neverRan.length > 0) {
    for (const step of neverRan.slice(0, 3)) {
      lines.push(
        `  ${step.tool} — proposed but ${step.status === "running" ? "interrupted mid-step" : "never executed"}`,
      );
    }
    if (neverRan.length > 3) lines.push(`  …and ${String(neverRan.length - 3)} more`);
  } else if (record.state === "failed") {
    lines.push("  the run stopped before planning produced steps to skip");
  } else if (record.state === "cancelled") {
    lines.push("  the stop was asked for — anything after the current step never started");
  } else {
    lines.push("  the run is not finished, so nothing is settled yet");
  }
  return lines;
}

/** T7-03's one step row: status, tool, tier, duration, attempt count with the ladder named. All five fields are sized
 *  to survive the 40-column design case whole — `attempt 2/5` names the ladder rather than a bare count — and the
 *  failure reason or output joins only when the frame has room for them (T7-14's drop order, applied within the row). */
export function stepLine(step: ToolStep, columns: number): string {
  const duration = stepDuration(step.startedAt, step.endedAt);
  const base = `  ${step.status.padEnd(9)} ${clip(step.tool, 10).padEnd(10)} ${step.tier} ${duration} ${String(step.attempts)}/5`;
  if (columns >= 72 && step.reason !== undefined) return clip(`${base} · ${step.reason}`, columns);
  if (columns >= 72 && step.output !== undefined) return clip(`${base} · ${step.output}`, columns);
  return clip(base, columns);
}

/** T7-06's cancellation panel: three explicit phases, the same ones Web W6-06 draws. */
export function cancellationLines(record: TaskRecord, columns: number): readonly string[] {
  const cancellation = record.cancellation;
  if (cancellation === undefined) return [];
  const phase =
    record.state === "cancelling"
      ? "2. finishing the current step, then it settles"
      : TERMINAL.has(record.state)
        ? "3. settled"
        : "1. requested";
  const mode = cancellation.mode === undefined ? "" : ` (${cancellation.mode})`;
  return [clip(`cancel: ${phase}${mode}`, columns)];
}

const TERMINAL: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

/** T7-07's checkpoint panel, in D-044's own words: what is saved, when, and what a resume repeats vs skips. The
 *  checkpoint read can fail for the reason D-065 gives (no boundary was ever committed) — the note says that instead of
 *  the panel vanishing, because a missing panel reads as "nothing was saved" when the truth may be "the question
 *  failed". */
export function checkpointLines(
  checkpoint: TaskCheckpoint | undefined,
  note: string | undefined,
  columns: number,
): readonly string[] {
  if (checkpoint === undefined) {
    return wrapText(`checkpoint: ${note ?? "no saved state for this task"}`, columns);
  }
  // T7-07 sizes the panel at up to four lines, and every clause here is one a phone must read whole — so each line is
  // wrapped, never clipped (the same rule the models pane's notices take, via the same `wrapText`).
  const repeat =
    checkpoint.resume.verdict === "resume"
      ? "a resume continues from here — nothing repeats (D-044)"
      : checkpoint.resume.verdict === "pass"
        ? "a resume continues; the step in flight is passed because its effect is on the record"
        : checkpoint.resume.verdict === "re-ask"
          ? "a resume asks again rather than repeating the step in flight (§7.3)"
          : "nothing to resume from";
  return [
    ...wrapText(`checkpoint: ${checkpoint.boundary} at step ${String(checkpoint.step)}`, columns),
    ...wrapText(`written ${checkpoint.writtenAt} · ${String(checkpoint.bytes)} bytes`, columns),
    ...wrapText(repeat, columns),
    ...wrapText(checkpoint.resume.reason, columns),
  ];
}

/** T7-08's ladder panel, from the record's own switch fact. The disclosure travels with the panel, not in a footnote. */
export function ladderLines(record: TaskRecord, columns: number): readonly string[] {
  const switchInfo = record.modelSwitch;
  if (switchInfo === undefined) return [];
  return [
    ...wrapText(`model switch: ${switchInfo.from} → ${switchInfo.to}`, columns),
    ...wrapText(
      `stage ${String(switchInfo.stage)} · ${String(switchInfo.attempts)} attempt${switchInfo.attempts === 1 ? "" : "s"} spent · ${switchInfo.reason}`,
      columns,
    ),
    ...wrapText(
      `${switchInfo.reAttempted ? "the step was re-attempted on the new model" : "no step was re-attempted"} — the ask-prompt was shown before the switch (T7-08's disclosure)`,
      columns,
    ),
  ];
}

/** T7-09's history: every failure with its class, printed verbatim so it can be searched. */
export function failureLines(events: readonly Event[], columns: number): readonly string[] {
  const failures = events.filter(
    (event) =>
      event.type === "tool.execution.failed" ||
      event.type === "provider.retry.attempt" ||
      event.type === "task.failed" ||
      event.type === "tool.execution.blocked",
  );
  if (failures.length === 0) return [];
  const lines = ["failures (classes verbatim, PROVIDERS_AND_TOOLS.md §3.5):"];
  for (const event of failures.slice(-6)) {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const what =
      payloadText(payload.class) ??
      payloadText(payload.reason) ??
      payloadText(payload.code) ??
      event.type;
    // The class leads so the searchable token survives the 40-column clip — the type is the shape of the line, the
    // class is the content a user greps for (T7-09's "printed verbatim so they can be searched").
    lines.push(clip(`  ${what} · ${event.type}`, columns));
  }
  return lines;
}

/** T7-10's artifacts: files the run wrote, with sizes when the log carried them. Leftovers are reported, never cleaned
 *  here — a delete in a viewer is the precedent §3.8's scratch-prune comment refuses. */
export function artifactLines(events: readonly Event[], columns: number): readonly string[] {
  const artifacts: string[] = [];
  for (const event of events) {
    if (event.type !== "tool.execution.completed") continue;
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const path = payloadText(payload.path);
    if (path === undefined) continue;
    const size = typeof payload.bytes === "number" ? ` (${String(payload.bytes)} bytes)` : "";
    artifacts.push(clip(`  ${path}${size}`, columns - 2));
    if (artifacts.length >= 4) break;
  }
  if (artifacts.length === 0) return [];
  return ["artifacts:", ...artifacts];
}

/** T7-11's result: the completion event's own words, with the disclosure section required beside it. */
export function resultLines(
  record: TaskRecord,
  events: readonly Event[],
  columns: number,
): readonly string[] {
  if (record.state !== "completed" && record.state !== "failed") return [];
  const completion = [...events].reverse().find((event) => event.type === "task.completed");
  const payload =
    completion === undefined ? {} : ((completion.payload ?? {}) as Record<string, unknown>);
  const text = payloadText(payload.summary) ?? payloadText(payload.result);
  const lines: string[] = [
    clip(
      `result: ${text ?? (record.state === "failed" ? (record.error?.message ?? "the run failed") : "no summary in the log")}`,
      columns,
    ),
  ];
  lines.push(...notHappenedLines(record, toolSteps(events)));
  return lines;
}

/** The pane: header (T7-01), steps (T7-02/03), the panels the run's facts earn, the actions line (T7-12), and the tail
 *  note (T7-13). Narrow drops in T7-14's own order: created/updated first, then durations. */
export function taskDetailLines(
  state: TaskDetailState,
  columns: number,
  rows: number,
): readonly string[] {
  const record = state.record;
  const steps = toolSteps(state.events);
  const narrow = columns < 60;
  const lines: string[] = [
    clip(record.objective, columns),
    clip(record.id, columns),
    clip(
      `${record.state} · ${record.model ?? "install default"}${record.error === undefined ? "" : ` · ${record.error.code}`}`,
      columns,
    ),
  ];
  if (!narrow)
    lines.push(clip(`created ${record.createdAt} · updated ${record.updatedAt}`, columns));
  lines.push(...cancellationLines(record, columns));
  lines.push(...checkpointLines(state.checkpoint, state.checkpointNote, columns));
  lines.push(...ladderLines(record, columns));
  if (steps.length > 0) {
    lines.push(clip(`steps (${String(steps.length)}):`, columns));
    for (const step of steps) lines.push(stepLine(step, narrow ? columns : columns));
  } else {
    lines.push(clip("steps: none in the log yet", columns));
  }
  if (state.approvalsPending.length > 0) {
    lines.push(
      clip(`waiting on you (${String(state.approvalsPending.length)}) — press a:`, columns),
    );
    for (const approval of state.approvalsPending.slice(0, 3)) {
      lines.push(clip(`  ${approval.summary}`, columns - 2));
    }
  }
  lines.push(...failureLines(state.events, columns));
  lines.push(...artifactLines(state.events, columns));
  lines.push(...resultLines(record, state.events, columns));
  // T7-12's actions, two lines that each survive the design case whole — a clipped `q back` would be the exit nobody
  // can find, which is T3-01's hint-strip lesson applied to a panel.
  lines.push(clip("c cancel · r resume · a approvals", columns));
  lines.push(clip("t tail · q/Esc back (T7-12 asks first)", columns));
  if (!state.tail) lines.push(clip("tail off — this view is not live (T7-13)", columns));
  // The frame owns the clip; here only the count is kept honest so the tail (actions) is never pushed off a 24-row
  // screen by a long history — T7-09's paging bound.
  const budget = Math.max(6, rows);
  return lines.length > budget
    ? [
        ...lines.slice(0, budget - 1),
        clip(`…${String(lines.length - budget + 1)} more lines (T7-09 pages)`, columns),
      ]
    : lines;
}
