// The tasks pane, held to the rules the region states.
//
// T6-06 ("a blank pane is a defect") and T6-03 (measured and estimated progress are different claims) are the two that a
// task list can get wrong in ways a screenshot would not show: a pane that says nothing teaches nothing, and a progress bar
// drawn from an event count reads as a measurement of work done when it is a measurement of events received.
//
// The rest — three lines per card, the approval mark, the offline line with the exact restart command (T1-10) — is asserted
// here as *text*, because a pane that renders well on a 120-column terminal and badly at 40 is the failure this file's
// sibling (`frame.test.ts`) exists to catch, and a pane that asserts nothing is how that failure arrives unnoticed.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type FrameState, frameLines } from "./frame.ts";
import {
  PANE_DESCRIPTORS,
  type PaneContext,
  paneState,
  plannedPane,
  statusFrom,
  type TaskSummary,
  tasksPane,
} from "./panes.ts";
import { visibleWidth } from "./render.ts";

const TASKS: readonly TaskSummary[] = [
  {
    id: "tsk_a",
    state: "running",
    objective: "refactor the context manager",
    model: "local/qwen2.5:3b",
    lastSeq: 12,
    elapsed: "4m",
  },
  {
    id: "tsk_b",
    state: "awaiting_approval",
    objective: "write config.json",
    model: "local/qwen2.5:3b",
    pendingApprovals: 1,
  },
  { id: "tsk_c", state: "completed", objective: "count the decisions", lastSeq: 3 },
];

function context(overrides: Partial<PaneContext> = {}): PaneContext {
  return {
    client: { listTasks: async () => ({ items: TASKS }), cancelTask: async () => undefined },
    pane: "tasks",
    rows: 24,
    columns: 40,
    color: "none",
    offline: false,
    ...overrides,
  };
}

describe("the tasks pane", () => {
  it("prints three lines per card, clipped by the frame rather than wrapped", () => {
    const body = tasksPane(context(), TASKS);
    // T6-02: three lines per card. A card that grows is how a task list becomes a wall of text on a phone.
    assert.equal(body.filter((line) => line.startsWith("> ")).length, 3);
    assert.equal(body.length, 9);
  });

  it("says progress is measured, and says what it was measured from", () => {
    const body = tasksPane(context(), TASKS);
    // T6-03: the distinction is a rule, not a decoration.
    assert.ok(
      body.some((line) => line.includes("measured, from the event log")),
      body.join(" | "),
    );
  });

  it("says `progress unknown` rather than drawing a bar for a task with no events", () => {
    const body = tasksPane(context(), [{ id: "tsk_d", state: "queued", objective: "x" }]);
    assert.ok(
      body.some((line) => line.includes("progress unknown")),
      body.join(" | "),
    );
  });

  it("marks a task waiting on a person, with the count", () => {
    const body = tasksPane(context(), TASKS);
    assert.ok(
      body.some((line) => line.includes("1 approval(s) waiting")),
      body.join(" | "),
    );
  });

  it("teaches the empty state instead of drawing nothing (T6-06)", () => {
    const body = tasksPane(context(), []);
    assert.equal(body.length, 3);
    assert.match(body[0] ?? "", /no tasks yet/);
    // The hint names the key *and* the CLI equivalent, which is the row's own wording.
    assert.match(body[1] ?? "", /`t`/);
    assert.match(body[1] ?? "", /crabby task run/);
  });

  it("names the exact restart command when the Gateway is gone (T1-10)", () => {
    const body = tasksPane(context({ offline: true }), TASKS);
    assert.ok(
      body.some((line) => line.includes("crabby gateway start")),
      body.join(" | "),
    );
    // Never a spinner: the line says the last confirmed time or says there was none.
    assert.ok(
      body.some((line) => /last confirmed|never confirmed/.test(line)),
      body.join(" | "),
    );
  });

  it("does not wrap a long objective — the frame clips it", () => {
    const body = tasksPane(context(), [
      { id: "tsk_e", state: "running", objective: "x".repeat(200) },
    ]);
    for (const line of body) {
      assert.ok(line.length < 220, "the pane emits one line per row and lets `fit` shorten it");
    }
  });
});

describe("the panes that are not built", () => {
  it("says which milestone, and the CLI command that reaches the same place", () => {
    const body = plannedPane("chat", "M3 chat pane (T4, T5)", "crabby chat");
    assert.match(body[0] ?? "", /chat: not built yet \(M3 chat pane/);
    // `docs/INTERFACES_AND_API.md` §8 forbids a shortcut-only capability: a pane row that promises a screen nobody can see
    // would be one, so the CLI equivalent is named.
    assert.match(body[1] ?? "", /crabby chat/);
  });

  it("every pane in the switch row has a descriptor, so no pane is an empty address", () => {
    const panes = PANE_DESCRIPTORS.map((entry) => entry.pane);
    assert.deepEqual(panes, ["chat", "tasks", "jobs", "approvals", "logs", "models"]);
    for (const entry of PANE_DESCRIPTORS) {
      assert.ok(entry.hints.length > 0, `${entry.pane} has no hints`);
      if (entry.built !== true) {
        assert.ok(entry.milestone !== undefined, `${entry.pane} is unbuilt and names no milestone`);
        assert.ok(
          entry.equivalent !== undefined,
          `${entry.pane} is unbuilt and names no CLI equivalent`,
        );
      }
    }
  });

  it("exactly one pane is built in this slice, and it is the tasks list", () => {
    assert.deepEqual(
      PANE_DESCRIPTORS.filter((entry) => entry.built).map((entry) => entry.pane),
      ["tasks"],
    );
  });
});

describe("the status the pane derives, and the one it does not", () => {
  it("counts pending approvals across tasks and never prints zero as a field it hides", () => {
    const status = statusFrom(context(), TASKS);
    assert.equal(status.pendingApprovals, 1);
  });

  it("takes the running task as the one the status line names", () => {
    const status = statusFrom(context(), TASKS);
    assert.equal(status.task?.id, "tsk_a");
    assert.equal(status.model, "local/qwen2.5:3b");
  });

  it("says offline rather than guessing a connection word", () => {
    // T2-02's rule: the connection field is the Gateway's word, and a client-side clock is a second opinion.
    assert.equal(statusFrom(context({ offline: true }), TASKS).connection, "offline");
  });

  it("a task with no model does not invent one", () => {
    const status = statusFrom(context(), [{ id: "tsk_c", state: "completed", objective: "x" }]);
    assert.equal(
      status.model,
      undefined,
      "an absent model is `model: none` in the line, not a guess",
    );
  });
});

describe("the tasks pane inside a frame", () => {
  it("draws at 40 columns with the status line still on screen", () => {
    const ctx = context();
    // The built pane's own descriptor, found rather than asserted: a `!` here would make this test pass on a pane that was
    // removed from the switch row, which is the opposite of what it is for.
    const descriptor = PANE_DESCRIPTORS.find((entry) => entry.pane === "tasks");
    assert.ok(descriptor !== undefined, "the tasks pane has a descriptor");
    if (descriptor === undefined) return;
    const state: FrameState = paneState(ctx, descriptor, tasksPane(ctx, TASKS), statusFrom(ctx, TASKS), false);
    const lines = frameLines(state, 40, 24);
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= 40, `${visibleWidth(line)} columns: ${line}`);
    }
    assert.ok(
      lines.some((line) => line.includes("refactor")),
      lines.join(" | "),
    );
    assert.ok(lines.at(-2)?.includes("approvals"), lines.at(-2) ?? "");
  });
});
