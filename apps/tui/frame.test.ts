// The frame's rules, held — the rows that must survive a 40-column terminal.
//
// The rows under test are the ones whose *content* is a promise about what a person can see: T2-08's drop order (queue →
// tunnel → vault → task state, and model/connection/approvals **never**), T2-02's word-always-present connection field,
// T1-06's below-40 state, and the frame's front-trimmed body. Each has a way to be implemented wrongly that still looks
// right on a wide terminal, which is why every test here pins a 40-column case.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DESIGN_COLUMNS,
  type FrameState,
  frameLines,
  MINIMUM_COLUMNS,
  nextPane,
  paneRow,
  type Segment,
  type StatusState,
  statusLine,
  statusSegments,
} from "./frame.ts";
import { visibleWidth } from "./render.ts";

const FULL: StatusState = {
  connection: "live",
  lastConfirmed: "12:04",
  model: "local/qwen2.5:3b",
  pendingApprovals: 2,
  tunnel: "off",
  vault: "ok",
  task: { id: "tsk_1", state: "running", step: 12, total: 17 },
  elapsed: "4m",
  queued: 3,
};

function frame(overrides: Partial<FrameState> = {}): FrameState {
  return {
    pane: "tasks",
    panes: ["chat", "tasks", "jobs", "approvals", "logs", "models"],
    status: FULL,
    hints: ["j/k move", "Enter open", "c cancel", "? help", "q quit"],
    body: ["one", "two", "three"],
    color: "none",
    ...overrides,
  };
}

describe("T2-08's drop order", () => {
  it("keeps everything on a wide terminal", () => {
    const line = statusLine(FULL, 120);
    for (const field of [
      "model",
      "live",
      "approvals: 2",
      "running",
      "vault",
      "tunnel",
      "queued: 3",
    ]) {
      assert.ok(line.includes(field), `${field} missing from "${line}"`);
    }
  });

  it("drops the queue first, then the tunnel, then the vault, then the task state", () => {
    // The order is the row's, and each step is asserted separately because a dropper that removed "whatever is cheapest"
    // would pass a single narrow test and fail the one that matters — a user who narrowed the terminal and lost the
    // connection word would be told nothing at all.
    const wide = statusLine(FULL, 120);
    assert.ok(wide.includes("queued"));
    const noQueue = statusLine(FULL, wide.length - 1 - "queued: 3 ·".length);
    assert.ok(!noQueue.includes("queued"), noQueue);
    assert.ok(noQueue.includes("tunnel"), "the tunnel outlives the queue");
    const noTunnel = statusLine(FULL, noQueue.length - 1 - "tunnel: off ·".length);
    assert.ok(!noTunnel.includes("tunnel"), noTunnel);
    assert.ok(noTunnel.includes("vault"), "the vault outlives the tunnel");
    const noVault = statusLine(FULL, noTunnel.length - 1 - "vault: ok ·".length);
    assert.ok(!noVault.includes("vault"), noVault);
    assert.ok(noVault.includes("running"), "the task state is the last to go");
  });

  it("never drops model, connection or approvals, even at 40 columns", () => {
    // T2-08's word is "never", and the protected three are what a person reads to know whether the app is even talking to
    // anything. A frame that loses them at the design width is a frame that looks alive while it confirms nothing.
    const line = statusLine(FULL, DESIGN_COLUMNS);
    assert.ok(visibleWidth(line) <= DESIGN_COLUMNS, `${visibleWidth(line)} columns: ${line}`);
    assert.match(line, /model: \S/, `the model label and a value: ${line}`);
    assert.ok(/\b(live|reconnecting|offline)\b/.test(line), `the connection word: ${line}`);
    // The count is the field, so both the word and a digit survive the shrink.
    assert.match(line, /approvals: \d/, line);
  });

  it("truncates rather than removes when 40 columns cannot hold the protected three", () => {
    const line = statusLine({ ...FULL, model: "a-very-long-provider-name/some-long-model-id" }, 12);
    assert.ok(visibleWidth(line) <= 12, line);
    // Clipping keeps the label: "model: l…" is still a model field, where a dropped segment would be a silent omission.
    assert.match(line, /^model/, line);
  });

  it("says `model: none` rather than omitting the field", () => {
    // C10-01's clause applied to a status line: a screen that hides an empty section reads as "there is nothing pinned".
    assert.ok(statusLine({ ...FULL, model: undefined }, 120).includes("model: none"));
  });

  it("says `approvals: 0` when there are none", () => {
    assert.ok(statusLine({ ...FULL, pendingApprovals: 0 }, 120).includes("approvals: 0"));
  });

  it("marks a ladder fallback instead of quietly showing the new model (D-043)", () => {
    const line = statusLine({ ...FULL, modelFallback: true }, 120);
    assert.match(line, /fell back/);
  });

  it("the connection word is present in every state, never colour alone", () => {
    for (const connection of ["live", "reconnecting", "offline"] as const) {
      const line = statusLine({ ...FULL, connection }, 120);
      assert.ok(line.includes(connection), `${connection} missing from "${line}"`);
    }
  });

  it("says when the connection was last confirmed, because `offline` alone has no age", () => {
    const line = statusLine({ ...FULL, connection: "offline", lastConfirmed: "12:04" }, 120);
    assert.match(line, /offline since 12:04/);
  });

  it("segments are pure data, so a screen cannot be built from a private arrangement of the line", () => {
    const segments: readonly Segment[] = statusSegments(FULL);
    assert.equal(segments.filter((segment) => segment.protected).length, 3);
    // The queue is rank 0 because T2-08 drops it first — the assertion is on the *data*, not on the string.
    assert.equal(segments.find((segment) => segment.label.startsWith("queued"))?.dropRank, 0);
  });
});

describe("T1-02's pane row", () => {
  it("marks the active pane with a leading `>`", () => {
    const row = paneRow(["chat", "tasks"], "tasks", 40);
    assert.match(row, />tasks/);
  });

  it("abbreviates to three characters at 40 columns", () => {
    const row = paneRow(["chat", "tasks", "jobs", "approvals", "logs", "models"], "tasks", 40);
    assert.ok(visibleWidth(row) <= 40, `${visibleWidth(row)}: ${row}`);
    // `approvals` cannot fit as a word beside five others, and a wrapped pane row costs a line of the pane.
    assert.ok(!row.includes("approvals"), row);
    assert.match(row, />tas/);
  });

  it("cycles in the inventory's order and wraps at the end", () => {
    const panes = ["chat", "tasks", "jobs", "approvals", "logs", "models"] as const;
    assert.equal(nextPane("chat", panes), "tasks");
    assert.equal(nextPane("models", panes), "chat");
  });
});

describe("T3-01's hint strip", () => {
  it("shows at most six hints", () => {
    const many = Array.from({ length: 12 }, (_, i) => `hint ${i}`);
    const strip = frameLines(frame({ hints: many }), 120, 24).at(-1) ?? "";
    assert.ok(!strip.includes("hint 6"), strip);
  });

  it("truncates rather than wrapping, and keeps the keys that fit", () => {
    const strip =
      frameLines(
        frame({ hints: ["j/k move", "Enter open the task detail pane", "c cancel", "q quit"] }),
        40,
        24,
      ).at(-1) ?? "";
    assert.ok(visibleWidth(strip) <= 40, `${visibleWidth(strip)}: ${strip}`);
    assert.match(strip, /j\/k move/);
  });
});

describe("T1-06 below the design width", () => {
  it("names the minimum rather than reflowing into unreadability", () => {
    const lines = frameLines(frame(), 30, 24);
    assert.ok(lines[0]?.includes("narrow"), lines.join(" | "));
    assert.match(lines[0] ?? "", new RegExp(String(MINIMUM_COLUMNS)));
    assert.equal(
      lines.length,
      3,
      "status line + one pane + the line naming the minimum, and nothing else",
    );
  });
});

describe("the frame as a whole", () => {
  it("pins the status line at the bottom, above the hint strip", () => {
    const lines = frameLines(frame(), 40, 24);
    assert.equal(
      lines.length,
      24,
      "the frame fills the screen so the body does not scroll the terminal",
    );
    assert.ok(lines.at(-2)?.includes("model:"), `status line: ${lines.at(-2)}`);
    assert.ok(lines.at(-1)?.includes("j/k move"), `hint strip: ${lines.at(-1)}`);
  });

  it("keeps the tail of the body, because a live pane grows at the end", () => {
    const body = Array.from({ length: 40 }, (_, i) => `row ${i}`);
    const lines = frameLines(frame({ body }), 40, 24);
    const shown = lines.slice(1, -2);
    assert.match(shown.at(-1) ?? "", /row 39/, "the newest row is on screen");
    assert.ok(!(shown[0] ?? "").includes("row 0"), "the oldest row is what a 40-row pane gives up");
  });

  it("hides the pane row while the help sheet is open, and the sheet says where output goes", () => {
    const lines = frameLines(frame({ help: true }), 40, 24);
    // T1-02's row is hidden here; T1-04's promise is that the sheet answers what happens to scrollback.
    assert.ok(!lines.some((line) => line.startsWith(">chat")), lines.join(" | "));
    assert.ok(
      lines.some((line) => line.includes("inline")),
      lines.join(" | "),
    );
  });

  it("a colour tier of `none` changes nothing about the words", () => {
    // `docs/DESIGN_SYSTEM.md` §2.1's 8-colour fallback: the tier decides colour, never content.
    const plain = frameLines(frame({ color: "none" }), 40, 24);
    const ansi = frameLines(frame({ color: "ansi" }), 40, 24);
    assert.deepEqual(plain, ansi);
  });
});
