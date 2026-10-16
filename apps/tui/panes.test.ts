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
import { applyAction, emptyComposer } from "./composer.ts";
import { FRAME_CHROME_ROWS, type FrameState, frameLines } from "./frame.ts";
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
  type TaskSummary,
  tasksPane,
} from "./panes.ts";
import { visibleWidth } from "./render.ts";
import { applyEvent, emptyTranscript } from "./transcript.ts";

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
    // The reader speaks the Gateway's envelope (`{ ok, status, body }`), because the pane reads `body.items` — see the
    // interface's own comment and the two tests below that hold what happens when the field is missing.
    client: {
      listTasks: async () => ({ ok: true, status: 200, body: { items: TASKS } }),
      cancelTask: async () => ({ ok: true, status: 202, body: {} }),
      createTask: async () => ({ ok: true, status: 201, body: { id: "tsk_new" } }),
    },
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

  it("the built set is the slice's truth: every pane draws real content now (logs' log/audit views name their route gaps)", () => {
    assert.deepEqual(
      PANE_DESCRIPTORS.filter((entry) => entry.built).map((entry) => entry.pane),
      ["chat", "tasks", "jobs", "approvals", "logs", "models"],
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
    const state: FrameState = paneState(
      ctx,
      descriptor,
      tasksPane(ctx, TASKS),
      statusFrom(ctx, TASKS),
      false,
    );
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

describe("the chat pane", () => {
  const CAPS = { fs: "workspace", net: false, shell: false };

  function transcriptWith(
    ...frames: readonly { type: string; payload: Record<string, unknown> }[]
  ) {
    let state = emptyTranscript(40, "none");
    for (const frame of frames) state = applyEvent(state, frame);
    return state;
  }

  it("shows the transcript, the composer and the capability line, in that order", () => {
    const transcript = transcriptWith(
      {
        type: "message.added",
        payload: { role: "user", ordinal: 1, content: "what is in the roadmap" },
      },
      {
        type: "message.added",
        payload: { role: "assistant", ordinal: 1, content: "five decisions" },
      },
    );
    const lines = chatPane(transcript, emptyComposer(), CAPS, 40, 24);
    assert.ok(
      lines.some((line) => line.includes("what is in the roadmap")),
      lines.join(" | "),
    );
    // The capability line is last: T5-06 describes it as what you see *before sending*, and putting it above the input
    // would make it read as part of the message being composed.
    assert.equal(lines.at(-1), "fs: workspace · net: off · shell: off");
  });

  it("a user message is marked so the two sides of a conversation are distinguishable", () => {
    const transcript = transcriptWith({
      type: "message.added",
      payload: { role: "user", ordinal: 1, content: "a question" },
    });
    const lines = chatPane(transcript, emptyComposer(), CAPS, 40, 24);
    assert.ok(
      lines.some((line) => line.startsWith("│")),
      lines.join(" | "),
    );
  });

  it("a failure is a panel with its code and whether it can resume (T4-11)", () => {
    const transcript = transcriptWith({
      type: "task.failed",
      payload: { code: "provider_auth", message: "the endpoint refused the key", resumable: true },
    });
    const lines = chatPane(transcript, emptyComposer(), CAPS, 40, 24);
    assert.ok(
      lines.some((line) => line.includes("provider_auth")),
      lines.join(" | "),
    );
    // There is no toast in a terminal, so the panel stays in the list and names the command that continues the run.
    assert.ok(
      lines.some((line) => line.includes("crabby task resume")),
      lines.join(" | "),
    );
  });

  it("the slash menu appears under the input while a command is being typed", () => {
    let composer = emptyComposer();
    for (const char of "/co")
      composer = applyAction(composer, { kind: "insert", text: char }, undefined);
    const lines = chatPane(emptyTranscript(40, "none"), composer, CAPS, 40, 24);
    assert.ok(
      lines.some((line) => line.trim() === "/compact"),
      lines.join(" | "),
    );
  });

  it("printable keys go to the composer, so the pane's own bindings cannot swallow them (T3-04)", () => {
    // `a` is an approve in the approvals pane and a literal here. A pane-level binding that took printable keys would make
    // the composer unusable, which is the failure T3-04's row exists to prevent.
    const typed = chatKey(emptyComposer(), undefined, { kind: "char", char: "a" }, undefined);
    assert.equal(typed.composer.buffer, "a");
    const bound = chatKey(emptyComposer(), undefined, { kind: "char", char: "a" }, "approve");
    assert.equal(bound.action, "approve");
  });

  it("Enter sends and clears the composer, Ctrl+J does not", () => {
    const composer = applyAction(emptyComposer(), { kind: "insert", text: "hello" }, undefined);
    const sent = chatKey(composer, undefined, { kind: "enter" }, undefined);
    assert.equal(sent.action, "send");
    assert.equal(
      sent.composer.buffer,
      "",
      "the composer empties so the next question is not appended to this one",
    );
    const typed = chatKey(composer, undefined, { kind: "ctrl", letter: "j" }, undefined);
    assert.equal(typed.action, undefined);
    assert.equal(typed.composer.buffer, "hello\n");
  });

  it("the held note appears only when something is held", () => {
    const transcript = emptyTranscript(40, "none");
    assert.ok(
      !chatPane(transcript, emptyComposer(), CAPS, 40, 24).some((line) =>
        line.includes("new content"),
      ),
    );
    assert.ok(
      chatPane({ ...transcript, held: 3 }, emptyComposer(), CAPS, 40, 24).some((line) =>
        line.includes("new content (3)"),
      ),
    );
  });

  it("the transcript never gets zero rows, even with nothing said yet", () => {
    // A pane that has nothing left for the conversation cannot show the answer, which is the opposite of the row's purpose.
    // The height here is the pane's, so the frame's own rows are subtracted by the caller — one party owns the chrome.
    const body = 24 - FRAME_CHROME_ROWS;
    const lines = chatPane(emptyTranscript(40, "none"), emptyComposer(), CAPS, 40, body);
    // Never more than the height it was given: the status line is the one row T2 says is always true, and a pane that
    // overflowed it by one line would push it off the bottom of a phone.
    assert.ok(lines.length <= body, `${lines.length} lines for a body of ${body}`);
    assert.ok(
      lines.filter((line) => line === "").length >= body - lines.length - 1,
      "the empty transcript is padded, not missing",
    );
  });
});

describe("reading the Gateway's own body shape", () => {
  it("takes the items list out of the envelope", () => {
    assert.equal(readTaskItems({ items: TASKS }).length, 3);
  });

  it("throws a sentence when the list has no `items`, rather than a TypeError", () => {
    // The first version of this interface promised `{ items }` and the app crashed on its first frame against a real
    // Gateway — the cast that let it compile was the cast that hid the envelope. A client of a document that does not
    // recognise the document must say so in words.
    assert.throws(() => readTaskItems({ tasks: [] }), /no `items` list/);
    assert.throws(() => readTaskItems(undefined), /not an object/);
  });

  it("throws when a created task has no id, because nothing can be followed", () => {
    assert.equal(readTaskId({ id: "tsk_x" }), "tsk_x");
    assert.throws(() => readTaskId({ ok: true }), /without a task id/);
  });
});
