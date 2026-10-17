// The jobs pane, asserted row by row against `docs/review/TUI.md` region T17 — the element rows are accepted
// specifications, so each test below names the row it is holding the pane to. What is asserted is what a phone shows:
// the state word is never truncated (T17-03), the cron string is on the detail line rather than the only representation
// (T17-02), and the backlog prompt has three answers and fires nothing without one (T17-07).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JobDetailBody, JobRow, JobRunRecord } from "@crabby/api-contracts";
import {
  backlogPromptLines,
  deleteGapLine,
  deletePromptLines,
  editFormLines,
  jobCardLines,
  jobDetailPane,
  jobStateDisplay,
  jobsPane,
  openDeleteConfirm,
  openEditForm,
  readJobDetail,
  readJobItems,
  runLine,
} from "./jobs.ts";
import type { PaneContext } from "./panes.ts";

function row(over: Partial<JobRow> = {}): JobRow {
  return {
    id: "job_1",
    name: "nightly digest",
    schedule: "30 7 * * 1-5",
    objective: "summarise the inbox",
    state: "active",
    createdBy: { clientId: "cli_local", name: "Liton", interface: "cli" },
    capabilities: ["fs:workspace", "net:fetch"],
    sessionId: "ses_1",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    missed: 0,
    utcOffsetMinutes: 360,
    stateWord: "active",
    nextRunLocal: "2026-10-17T07:30+06:00",
    ...over,
  };
}

function run(over: Partial<JobRunRecord> = {}): JobRunRecord {
  return {
    id: "run_1",
    jobId: "job_1",
    dueAt: "2026-10-15T07:30+06:00",
    recordedAt: "2026-10-15T07:30+06:00",
    outcome: "missed",
    trigger: "schedule",
    occurrences: 1,
    ...over,
  };
}

const context = (over: Partial<PaneContext> = {}): PaneContext =>
  ({
    client: {},
    pane: "jobs",
    rows: 24,
    columns: 40,
    color: "none",
    offline: false,
    ...over,
  }) as PaneContext;

describe("T17-02 — the job row: name and state, the schedule in words below, next run with it", () => {
  it("renders name + state on one line and the words + next fire below, with the cron string nowhere on the row", () => {
    const lines = jobCardLines(row(), false, 40);
    assert.equal(lines[0], "  nightly digest · active");
    assert.equal(lines[1], "  every weekday 07:30");
    assert.equal(lines[2], "  next 2026-10-17T07:30+06:00");
    // T17-02's behavior: the cron string is on the detail line, never the only representation — the row speaks words.
    assert.ok(lines.every((line) => !line.includes("30 7 * * 1-5")));
  });

  it("clips the name and keeps the state word whole at 40 columns (T17-03)", () => {
    const lines = jobCardLines(
      row({ name: "a-very-long-job-name-that-will-not-fit-anywhere" }),
      false,
      40,
    );
    assert.ok((lines[0] as string).endsWith("· active"));
    assert.ok((lines[0] as string).length <= 40);
  });
});

describe("T17-03 — the state words, as words", () => {
  it("prints the row's vocabulary and never truncates `waiting on approval` away", () => {
    assert.equal(jobStateDisplay("waiting-approval"), "waiting on approval");
    assert.equal(jobStateDisplay("deferred:vault-locked"), "deferred: vault locked");
    assert.equal(jobStateDisplay("failing"), "failing");
    const lines = jobCardLines(row({ name: "x", stateWord: "waiting-approval" }), false, 20);
    assert.ok(
      (lines[0] as string).includes("waiting on approval"),
      "the state that means work is stalled on a human survives a 20-column frame",
    );
  });
});

describe("T17-07 — the missed-run line and the prompt's three answers", () => {
  it("counts the backlog in T17-07's own words on the row", () => {
    const lines = jobCardLines(row({ missed: 3 }), false, 40);
    assert.ok(lines.includes("  3 runs missed while Termux was killed"));
  });

  it("prompts once with latest / each / skip all and names the rule", () => {
    const lines = backlogPromptLines([run(), run({ id: "run_2" })]);
    assert.equal(lines[0], "2 runs missed while Termux was killed");
    assert.ok((lines[1] as string).includes("never bursts"));
    assert.ok((lines[2] as string).includes("[l]"));
    assert.ok((lines[2] as string).includes("[e]"));
    assert.ok((lines[2] as string).includes("[s]"));
  });

  it("still says each, because D-133 moved the walk onto the wire and the prompt's third answer stayed", () => {
    const lines = backlogPromptLines([run(), run({ id: "run_2" })]);
    assert.ok((lines[2] as string).includes("each one at a time"));
  });
});

describe("T17-08 — the run waiting for a human", () => {
  it("puts one line in the row when the last run is waiting on an answer", () => {
    const lines = jobCardLines(
      row({ stateWord: "waiting-approval", lastOutcome: "waiting_on_approval" }),
      false,
      40,
    );
    assert.ok(lines.some((line) => line.includes("waiting for an answer")));
  });

  it("says nothing about waiting when nothing is waiting", () => {
    const lines = jobCardLines(row(), false, 40);
    assert.ok(!lines.some((line) => line.includes("waiting for an answer")));
  });
});

describe("T17-04 — the detail view: what it may touch, as granted", () => {
  const detail: JobDetailBody = {
    job: row(),
    runs: [
      run({ outcome: "completed", settledAt: "2026-10-15T07:31+06:00", taskId: "tsk_9" }),
      run({ id: "run_2", dueAt: "2026-10-14T07:30+06:00", outcome: "missed" }),
    ],
    missedUnacknowledged: [],
    driven: true,
  };

  it("keeps to twelve rows and carries the capability set, the identity and the last runs", () => {
    const lines = jobDetailPane(detail, 40);
    assert.ok(lines.length <= 12);
    const text = lines.join("\n");
    assert.ok(text.includes("holds: fs:workspace, net:fetch"));
    assert.ok(text.includes("identity: Liton (cli, cli_local)"));
    // At the 40-column design case the outcome is the part T17-04's content names ("last runs with outcomes") and the
    // part that must survive the clip; the task id beside it is room-dependent.
    assert.ok(text.includes("completed"));
  });

  it("names the task a run created when the frame has room (W16-09's link)", () => {
    const text = jobDetailPane(detail, 100).join("\n");
    assert.ok(text.includes("task tsk_9"));
  });

  it("carries the cron string on the detail line (T17-02's behavior)", () => {
    const lines = jobDetailPane(detail, 40);
    assert.ok((lines[1] as string).includes("cron: 30 7 * * 1-5"));
  });
});

describe("T17-06 — the edit form and its re-approval notice", () => {
  it("is 4 lines at the design case: schedule, objective, and the notice that says what saving can do", () => {
    const lines = editFormLines(openEditForm(row()), 40);
    assert.ok(lines.length >= 4 && lines.length <= 6);
    assert.ok((lines[1] as string).includes("schedule:"));
    assert.ok((lines[2] as string).includes("objective:"));
    assert.ok(lines.join("\n").includes("re-approval"));
    assert.ok(lines.join("\n").includes("D-084"));
  });
});

describe("T17-05 — the row keys and the typed delete", () => {
  it("asks for the job name typed back before anything destructive is even possible", () => {
    const confirm = openDeleteConfirm(row());
    const lines = deletePromptLines(confirm, 40);
    assert.ok(lines.join("\n").includes("type the job name back to confirm"));
  });

  it("reports the delete gap by name when the name matches — a silent nothing would read as a delete that happened", () => {
    assert.ok(deleteGapLine(row()).includes("no DELETE /jobs/job_1 route"));
    assert.ok(deleteGapLine(row()).includes("raised"));
  });
});

describe("reading the Gateway's own job shapes", () => {
  it("reads `items` and throws a sentence, not a TypeError, on a document it does not recognise", () => {
    assert.deepEqual(readJobItems({ items: [row()] }).length, 1);
    assert.throws(() => readJobItems({ rows: [] }), /no `items` list/);
    assert.throws(() => readJobItems(null), /not an object/);
    assert.throws(() => readJobDetail({ job: row() }), /missing/);
  });
});

describe("T17-01 and the empty state — a blank pane is a defect", () => {
  it("teaches how a job comes to be rather than drawing an empty box", () => {
    const lines = jobsPane(context(), []);
    assert.ok(lines.join("\n").includes("no jobs yet"));
    assert.ok(lines.join("\n").includes("cron.schedule"));
  });

  it("answers a dead Gateway with the restart command (T1-10) instead of a spinner", () => {
    const lines = jobsPane(context({ offline: true }), [row()]);
    assert.ok(lines.join("\n").includes("crabby gateway start"));
  });

  it("cuts the list to the frame and says how many more there are", () => {
    const many = Array.from({ length: 8 }, (_, index) =>
      row({ id: `job_${index}`, name: `job ${index}` }),
    );
    const lines = jobsPane(context({ rows: 10 }), many);
    assert.ok(lines.some((line) => line.includes("more")));
  });

  it("marks the selected row with the cursor and not the others", () => {
    const lines = jobsPane(context({ rows: 24 }), [row(), row({ id: "job_2", name: "second" })], 1);
    assert.ok(lines.some((line) => line.startsWith("> second")));
    assert.ok(lines.some((line) => line.startsWith("  nightly digest")));
  });
});

describe("T4-02's one-line run record — the audit trail a month later reads", () => {
  it("names the task a run created and the trigger that created it", () => {
    assert.equal(
      runLine(run({ outcome: "completed", taskId: "tsk_9", trigger: "run-now" })),
      "completed · 2026-10-15T07:30+06:00 (task tsk_9) · run-now",
    );
    assert.equal(runLine(run()), "missed · 2026-10-15T07:30+06:00");
  });
});
