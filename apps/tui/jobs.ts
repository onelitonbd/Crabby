// `apps/tui/jobs.ts` — the scheduled-jobs pane (region T17), a pure projection over the wire's own job rows. The region's
// sentence is the reason the pane exists: "a user can see, from a phone, what a standing schedule is allowed to do and
// why it did not run" — so every line below is one of the T17 rows, and the shapes are `@crabby/api-contracts`' `JobRow`
// and `JobRunRecord` rather than a view model of this file's own invention (D-069: the contract is the only place a
// shape is stated).
//
// Four things this module is deliberate about:
//
// - **The state word is never truncated** (T17-03). `waiting on approval` means work is stalled on a human, and the name
//   beside it is the part that may clip. The wire words (`waiting-approval`, `deferred:vault-locked`) are the contract's
//   greppable vocabulary; `jobStateDisplay` renders the phrases T17-03 writes, and both halves of that mapping are here
//   so the TUI cannot drift from the wire or from the row.
// - **The cron string is on the detail line** (T17-02's behavior). The row carries `scheduleInWords` — W16-01's
//   `every weekday 07:30` register — and the detail repeats the expression, so the expression is never the only
//   representation. One words renderer for every interface lives in `packages/agent-runtime/cron.ts`, for the reason
//   `packages/platform`'s `clip` is one: two renderers would be two answers to one question.
// - **`readJobItems` throws a sentence, not a TypeError** — the rule the task list learned against a real Gateway
//   (D-131): a client of a document that does not recognise the document must say so in words.
// - **The backlog prompt has three answers** (T17-07's row: latest / each / skip all). `each` is the one the wire's
//   `JobBacklogBody` cannot carry (its `action` is `latest | skip` only — a discrepancy this pane raises rather than
//   hides), and it is built as the walk the CLI's own comment describes: one missed occurrence at a time, each its own
//   decision, "which is a person deciding each time" — never a burst (§4.5's rule) and never a silent drop (D-065's).

import { scheduleInWords } from "@crabby/agent-runtime";
import type { JobDetailBody, JobRow, JobRunRecord } from "@crabby/api-contracts";
import { type ComposerState, composerView, emptyComposer } from "./composer.ts";
import type { PaneContext } from "./panes.ts";
import { clip } from "./render.ts";

/** T17-03's display vocabulary. The wire greps `waiting-approval`; the pane prints `waiting on approval`, and the phrase
 *  is whole or the line is not drawn right — T17-03's rule is that this word is never truncated away. */
export function jobStateDisplay(stateWord: string): string {
  switch (stateWord) {
    case "waiting-approval":
      return "waiting on approval";
    case "deferred:vault-locked":
      return "deferred: vault locked";
    default:
      return stateWord;
  }
}

/** `GET /jobs`'s rows out of the answer, or a thrown sentence. The body is `JobListBody`'s, and a document without its
 *  `items` list is a document this pane will not invent a list out of. */
export function readJobItems(body: unknown): readonly JobRow[] {
  if (typeof body !== "object" || body === null)
    throw new Error("the job list answer was not an object");
  const record = body as Record<string, unknown>;
  const items = record.items;
  if (!Array.isArray(items)) {
    throw new Error(
      `the job list answer has no \`items\` list (keys: ${Object.keys(record).join(", ") || "none"}) — this TUI speaks the ` +
        "Gateway's own body shape and will not invent a list from a document it does not recognise",
    );
  }
  return items as readonly JobRow[];
}

/** `GET /jobs/{id}`'s body (`JobDetailBody`): the row, the bounded run history and the unacknowledged backlog rows, all
 *  in one answer so a user deciding about missed runs does not have to ask twice. */
export function readJobDetail(body: unknown): JobDetailBody {
  if (typeof body !== "object" || body === null)
    throw new Error("the job detail answer was not an object");
  const record = body as Record<string, unknown>;
  const job = record.job;
  const runs = record.runs;
  if (typeof job !== "object" || job === null || !Array.isArray(runs)) {
    throw new Error(
      "the job detail answer is missing its `job` row or its `runs` list — this TUI speaks the Gateway's own body shape",
    );
  }
  return body as JobDetailBody;
}

/** One job's lines: T17-02's row (`name` + `state` at the design case, the schedule below), the next run beside it, and
 *  the two conditional lines the region allows on top — T17-07's missed-run line and T17-08's waiting line. The name is
 *  the only thing that clips (T17-03). */
export function jobCardLines(job: JobRow, selected: boolean, columns: number): readonly string[] {
  const state = jobStateDisplay(job.stateWord);
  const cursor = selected ? "> " : "  ";
  // The state word keeps its whole width; whatever remains is the name's budget. A name with no budget left is clipped
  // to nothing rather than pushing the state off the line — the word is the part a phone must see.
  const nameBudget = Math.max(0, columns - cursor.length - 3 - state.length);
  const name = clip(job.name, nameBudget);
  const lines: string[] = [`${cursor}${name} · ${state}`];
  lines.push(`  ${clip(scheduleInWords(job.schedule), columns - 2)}`);
  // D-103's `nextRunLocal` is the Gateway's own rendering of the next fire in the zone the schedule is evaluated in;
  // a paused job's absence is the fact C12-03 asks a command to state rather than a time it is pretending to ignore.
  const next =
    job.nextRunLocal ??
    (job.state === "paused" ? "no next fire (paused)" : "unknown — no occurrence projected");
  lines.push(`  ${clip(`next ${next}`, columns - 2)}`);
  // T17-07's row line. The count is the job's unacknowledged backlog; the prompt that answers it is `b` (the hint line
  // is the authority, T17-05).
  if (job.missed > 0) {
    lines.push(
      `  ${clip(`${job.missed} run${job.missed === 1 ? "" : "s"} missed while Termux was killed`, columns - 2)}`,
    );
  }
  // T17-08's "1 line in the row": the run that cannot proceed, named so the stall is visible without opening anything.
  if (job.stateWord === "waiting-approval") {
    lines.push(
      `  ${clip("a run is waiting for an answer — it stops, never proceeds unattended", columns - 2)}`,
    );
  }
  return lines;
}

/** The pane body: the job cards, cut to the height the frame leaves, with the same `…and N more` tail the tasks pane
 *  teaches with. A blank pane is a defect (T6-06's rule, applied here): the empty state names how a job comes to be. */
export function jobsPane(
  context: PaneContext,
  jobs: readonly JobRow[],
  selected = 0,
): readonly string[] {
  if (context.offline) {
    return [
      `gateway unreachable (${context.lastConfirmed === undefined ? "never confirmed" : `last confirmed ${context.lastConfirmed}`})`,
      "restart it with: crabby gateway start",
    ];
  }
  if (jobs.length === 0) {
    return [
      "no jobs yet",
      "a schedule is created from a task by `cron.schedule`, and it runs as fresh policy every fire (§4.5)",
      "`crabby job ls` lists them from a shell",
    ];
  }
  const height = Math.max(1, context.rows - 3);
  const lines: string[] = [];
  let shown = 0;
  for (let index = 0; index < jobs.length; index += 1) {
    const card = jobCardLines(jobs[index] as JobRow, index === selected, context.columns);
    if (lines.length + card.length > height && shown > 0) break;
    lines.push(...card);
    shown += 1;
  }
  if (shown < jobs.length) {
    lines.push(`…and ${jobs.length - shown} more — \`crabby job ls\` lists them all`);
  }
  return lines;
}

/** T17-04's detail view, capped at twelve rows: the capability set the job holds and the identity it holds it under —
 *  "what did I authorize weeks ago" — plus the last runs with their outcomes. The cron expression is here because
 *  T17-02's behavior puts it here, and the objective is here because §4.5 authorises "the job as described at creation
 *  time" and a review of an authorization that does not show what it authorises is not a review. */
export function jobDetailPane(detail: JobDetailBody, columns: number): readonly string[] {
  const job = detail.job;
  const state = jobStateDisplay(job.stateWord);
  const rows = 12;
  const lines: string[] = [
    clip(`${job.name} · ${state}`, columns),
    `  ${clip(`cron: ${job.schedule}`, columns - 2)}`,
    `  ${clip(`${scheduleInWords(job.schedule)} · next ${job.nextRunLocal ?? "no next fire"}`, columns - 2)}`,
    `  ${clip(`objective: ${job.objective}`, columns - 2)}`,
    `  ${clip(`holds: ${job.capabilities.join(", ") || "no capabilities recorded"}`, columns - 2)}`,
    `  ${clip(`identity: ${job.createdBy.name} (${job.createdBy.interface}, ${job.createdBy.clientId})`, columns - 2)}`,
    "  last runs:",
  ];
  const room = rows - lines.length;
  const runs = detail.runs.slice(0, Math.max(0, room));
  if (runs.length === 0) {
    lines.push("    (no runs yet)");
  }
  for (const run of runs) {
    lines.push(`    ${clip(runLine(run), columns - 4)}`);
  }
  if (detail.runs.length > runs.length) {
    lines.push(`    …and ${detail.runs.length - runs.length} more`);
  }
  return lines;
}

/** One run's line: what it ended as, when it was due, and the task it created — "last runs with outcomes" (T17-04) and
 *  W16-09's task link in one line. **The outcome leads** so the state word is the part that survives a 40-column clip:
 *  the date is searchable from the shell, and `completed` clipped to `compl…` is a word nobody can grep. */
export function runLine(run: JobRunRecord): string {
  const task = run.taskId === undefined ? "" : ` (task ${run.taskId})`;
  const trigger = run.trigger === "schedule" ? "" : ` · ${run.trigger}`;
  return `${run.outcome} · ${run.dueAt}${task}${trigger}`;
}

/** T17-07's prompt: one line of fact, one line of rule, one line of the three answers. `missed` is the detail's
 *  unacknowledged backlog — the rows `POST /jobs/{id}/backlog` will acknowledge. The row writes the template
 *  `N runs missed while Termux was killed`, so the count is its first word. */
export function backlogPromptLines(missed: readonly JobRunRecord[]): readonly string[] {
  const count = missed.length;
  return [
    `${count} run${count === 1 ? "" : "s"} missed while Termux was killed`,
    "one answer is recorded and nothing fires without it — a backlog never bursts and is never dropped silently (§4.5)",
    "run the latest only [l] · run each one at a time [e] · skip all [s]",
  ];
}

/** The `each` answer as a walk: one missed occurrence per decision. This is the mapping T17-07's third answer takes over
 *  a wire that has only `latest | skip` — the CLI's `job backlog` records the same semantics ("a user who wants N runs
 *  can ask for one and then N-1 … a person deciding each time"), and D-103's one-run-at-a-time rule means N runs cannot
 *  open at once anyway. Each `run` is a fresh policy evaluation (`run-now`, §4.5); when the walk ends, the rows are
 *  acknowledged so none of them is dropped silently. */
export function walkPromptLines(missed: readonly JobRunRecord[], index: number): readonly string[] {
  const run = missed[index];
  if (run === undefined) return ["the walk is over — nothing left to decide"];
  return [
    `missed occurrence ${index + 1} of ${missed.length} — due ${run.dueAt}${run.reason === undefined ? "" : ` (${run.reason})`}`,
    "run this one [y] · skip it [n] — one decision at a time, never a burst (D-103)",
  ];
}

/** T17-06's edit form, 4–6 lines: the two fields the row names and the re-approval notice. `schedule` is the
 *  non-material half `PATCH /jobs/{id}` carries; `objective` is the material half §4.5 prices as re-approval and
 *  nothing in this build can open one (D-084) — so the form collects both, and the save says which of them can land. */
export interface JobEditForm {
  readonly job: JobRow;
  readonly field: "schedule" | "objective";
  readonly schedule: ComposerState;
  readonly objective: ComposerState;
}

export function openEditForm(job: JobRow): JobEditForm {
  return {
    job,
    field: "schedule",
    schedule: { buffer: job.schedule, cursor: job.schedule.length, history: [] },
    objective: { buffer: job.objective, cursor: job.objective.length, history: [] },
  };
}

export function editFormLines(form: JobEditForm, columns: number): readonly string[] {
  const scheduleLine = composerView(form.schedule, columns - 11).lines;
  const objectiveLine = composerView(form.objective, columns - 12).lines;
  // The notice is three short lines rather than one long one, because T17-06 sizes the form at 4–6 lines and a notice
  // clipped to `…re-appr` tells a phone nothing. Every clause fits 40 columns whole.
  return [
    clip(`edit ${form.job.name} — Esc cancels`, columns),
    `  schedule: ${scheduleLine[0] ?? ""}`,
    `  objective: ${objectiveLine[0] ?? ""}`,
    clip("schedule is 'when', not 'what' (§4.5)", columns),
    clip("objective change needs re-approval:", columns),
    clip("no route here can open one (D-084)", columns),
  ];
}

/** T17-05's delete confirmation: the job name typed back. The typed buffer is the only thing that confirms — a single
 *  `d` never deletes (W-O4's "destructive action never pre-focused" in a terminal's shape). */
export interface JobDeleteConfirm {
  readonly job: JobRow;
  readonly typed: ComposerState;
}

export function openDeleteConfirm(job: JobRow): JobDeleteConfirm {
  return { job, typed: emptyComposer() };
}

export function deletePromptLines(confirm: JobDeleteConfirm, columns: number): readonly string[] {
  const typed = composerView(confirm.typed, columns - 7).lines;
  // The ask is on its own line: T17-05's confirmation sentence is the part that must never be the clipped tail of a
  // longer line, and at 40 columns `delete nightly digest? type the job name back to confirm` loses the ask itself.
  return [
    clip(`delete ${confirm.job.name}? (Esc cancels)`, columns),
    clip("type the job name back to confirm", columns),
    clip("past runs stay on the record (W16-11)", columns),
    `  name: ${typed[0] ?? ""}`,
  ];
}

/** What the pane prints when the typed name matches and the act is asked for: there is no `DELETE /jobs/{id}` route in
 *  this build and no delete in the scheduler either, so the row's key completes its confirmation and then reports the
 *  gap by name — T17-05 and W16-11 both price a delete this build cannot perform, and a silent nothing would read as a
 *  delete that happened. */
export function deleteGapLine(job: JobRow): string {
  return (
    `the name matches, but this build has no DELETE /jobs/${job.id} route and the scheduler has no delete — ` +
    "the job stands (T17-05/W16-11's delete is raised, not silently dropped)"
  );
}
