// The task detail pane, asserted against `docs/review/TUI.md` region T7's rows: the id on its own selectable line
// (T7-01/T2-09), the ladder named in the attempt count (T7-03), D-044's wording in the checkpoint panel (T7-07), the
// switch's disclosure travelling with the ladder panel (T7-08), classes printed verbatim (T7-09), artifacts reported
// (T7-10), "what did not happen" required (T7-11), and the narrow drops in T7-14's order.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Event, TaskCheckpoint, TaskRecord } from "@crabby/api-contracts";
import {
  artifactLines,
  cancellationLines,
  checkpointLines,
  emptyTaskDetail,
  failureLines,
  ladderLines,
  readEventItems,
  resultLines,
  stepDuration,
  stepLine,
  taskDetailLines,
  toolSteps,
} from "./task-detail.ts";

const record = (over: Partial<TaskRecord> = {}): TaskRecord =>
  ({
    id: "tsk_1",
    sessionId: "ses_1",
    state: "running",
    objective: "summarise the inbox and draft replies",
    createdAt: "2026-10-16T10:00:00.000Z",
    updatedAt: "2026-10-16T10:05:00.000Z",
    lastSeq: 9,
    ...over,
  }) as TaskRecord;

const event = (seq: number, type: string, payload: Record<string, unknown> = {}): Event =>
  ({
    id: `evt_${String(seq)}`,
    schemaVersion: 1,
    type,
    ts: new Date(Date.parse("2026-10-16T10:00:00Z") + seq * 1000).toISOString(),
    sessionId: "ses_1",
    taskId: "tsk_1",
    seq,
    payload,
  }) as Event;

const checkpoint = (over: Partial<TaskCheckpoint> = {}): TaskCheckpoint =>
  ({
    taskId: "tsk_1",
    state: "running",
    boundary: "step",
    step: 3,
    lastSeq: 8,
    modelId: "mock/tiny",
    writtenAt: "2026-10-16T10:04:00.000Z",
    bytes: 2048,
    messages: 6,
    redacted: true,
    resume: { verdict: "resume", reason: "nothing was in flight after the boundary" },
    ...over,
  }) as TaskCheckpoint;

describe("T7-01 — the header, with the id on its own selectable line", () => {
  it("puts objective, then id, then state+model — and drops created/updated first when narrow (T7-14)", () => {
    const lines = taskDetailLines(emptyTaskDetail(record()), 40, 24);
    assert.equal(lines[0], "summarise the inbox and draft replies");
    assert.equal(lines[1], "tsk_1");
    assert.ok((lines[2] as string).includes("running"));
    // 40 columns is the narrow case: created/updated are the first drop (T7-14).
    assert.ok(!lines.join("\n").includes("created 2026-"));
    const wide = taskDetailLines(emptyTaskDetail(record()), 100, 24).join("\n");
    assert.ok(wide.includes("created 2026-10-16T10:00:00.000Z"));
  });
});

describe("T7-02/03 — the steps, folded from the task's own events", () => {
  const events = [
    event(1, "tool.execution.started", { toolCallId: "c1", tool: "fs.read", tier: "T1" }),
    event(2, "tool.execution.completed", { toolCallId: "c1", path: "inbox/1.md" }),
    event(3, "tool.execution.started", { toolCallId: "c2", tool: "fs.write", tier: "T2" }),
    event(4, "tool.execution.failed", { toolCallId: "c2", class: "provider-rate-limited" }),
    event(5, "tool.execution.started", { toolCallId: "c2", tool: "fs.write", tier: "T2" }),
  ];

  it("names status, tool, duration and the attempt count as the ladder stage (T7-03)", () => {
    const steps = toolSteps(events);
    assert.equal(steps.length, 2);
    assert.equal(steps[0]?.status, "completed");
    assert.equal(steps[1]?.status, "running");
    const second = steps[1];
    assert.ok(second !== undefined, "two tool calls fold to two steps");
    assert.equal(second.attempts, 2, "one failure = the ladder spent a second attempt");
    // All five T7-03 fields survive the 40-column design case; the attempt count names the ladder (`2/5`), not a bare 2.
    const line = stepLine(second, 40);
    assert.ok(line.includes("2/5"), line);
    assert.ok(line.includes("fs.write"));
    assert.ok(line.includes("T2"));
    assert.ok(line.length <= 40);
    // c2 is mid-second-attempt (started again, no end yet), so its duration is `?` rather than a stale number — and the
    // first attempt's duration is measured from its own stamps.
    assert.ok(line.includes("?"));
    const first = steps[0];
    assert.ok(first !== undefined);
    assert.equal(stepLine(first, 40).includes("1.0s"), true);
  });

  it("measures duration from the event stamps and answers `?` rather than lying", () => {
    const started = events[0];
    const ended = events[1];
    assert.ok(started !== undefined && ended !== undefined);
    assert.equal(stepDuration(started.ts, ended.ts), "1.0s");
    assert.equal(stepDuration(undefined, ended.ts), "?");
  });
});

describe("T7-06 — the cancellation panel's three phases", () => {
  it("walks requested → finishing current step → settled", () => {
    assert.ok(
      cancellationLines(
        record({ cancellation: { mode: "finish-step", requestedAt: "2026-02-03T10:00:10Z" } }),
        40,
      )
        .join("")
        .includes("1. requested"),
    );
    assert.ok(
      cancellationLines(
        record({
          state: "cancelling",
          cancellation: { mode: "finish-step", requestedAt: "2026-02-03T10:00:10Z" },
        }),
        40,
      )
        .join("")
        .includes("finishing the current step"),
    );
    assert.ok(
      cancellationLines(
        record({
          state: "cancelled",
          cancellation: { mode: "immediate", requestedAt: "2026-02-03T10:00:10Z" },
        }),
        40,
      )
        .join("")
        .includes("3. settled"),
    );
    assert.deepEqual(cancellationLines(record(), 40), []);
  });
});

describe("T7-07 — the checkpoint panel, in D-044's words", () => {
  it("says what is saved and that a resume continues, never restarts", () => {
    const lines = checkpointLines(checkpoint(), undefined, 40).join(" ").replace(/\s+/g, " ");
    assert.ok(lines.includes("step 3"));
    assert.ok(lines.includes("2048 bytes"));
    assert.ok(lines.includes("continues from here — nothing repeats (D-044)"));
    const reask = checkpointLines(
      checkpoint({ resume: { verdict: "re-ask", reason: "the step in flight is not idempotent" } }),
      undefined,
      40,
    )
      .join(" ")
      .replace(/\s+/g, " ");
    assert.ok(reask.includes("asks again rather than repeating"));
    assert.ok(reask.includes("the step in flight is not idempotent"));
  });

  it("keeps the panel present with the failure note when the read fails", () => {
    const lines = checkpointLines(undefined, "404 — no boundary was ever committed", 40)
      .join(" ")
      .replace(/\s+/g, " ");
    assert.ok(lines.includes("checkpoint:"));
    assert.ok(lines.includes("no boundary was ever committed"));
  });
});

describe("T7-08 — the ladder panel carries its own disclosure", () => {
  it("shows from → to, the stage, the attempts and the re-attempt fact", () => {
    const lines = ladderLines(
      record({
        modelSwitch: {
          from: "mock/tiny",
          to: "mock/big",
          reason: "the endpoint kept returning provider-rate-limited",
          stage: 2,
          reAttempted: true,
          attempts: 5,
          at: "2026-10-16T10:03:00.000Z",
        },
      }),
      40,
    )
      .join(" ")
      .replace(/\s+/g, " ");
    assert.ok(lines.includes("mock/tiny → mock/big"));
    assert.ok(lines.includes("stage 2"));
    assert.ok(lines.includes("5 attempts"));
    assert.ok(lines.includes("re-attempted on the new model"));
    assert.ok(lines.includes("ask-prompt was shown"));
  });
});

describe("T7-09 — failures with classes verbatim", () => {
  it("prints the class string unchanged so it can be searched", () => {
    const lines = failureLines(
      [event(4, "tool.execution.failed", { class: "provider-rate-limited" })],
      40,
    );
    assert.ok(lines.join("\n").includes("provider-rate-limited"));
  });

  it("says nothing when nothing failed", () => {
    assert.deepEqual(failureLines([event(1, "task.progress", {})], 40), []);
  });
});

describe("T7-10 — artifacts reported, never cleaned", () => {
  it("names files the run wrote with their sizes when the log carried them", () => {
    const lines = artifactLines(
      [event(2, "tool.execution.completed", { path: "out/draft.md", bytes: 512 })],
      40,
    ).join("\n");
    assert.ok(lines.includes("out/draft.md"));
    assert.ok(lines.includes("512 bytes"));
  });
});

describe("T7-11 — result and the required `what did not happen`", () => {
  it("is present even for a clean completion, saying so in words", () => {
    const lines = resultLines(
      record({ state: "completed" }),
      [
        event(9, "task.completed", { summary: "three replies drafted" }),
        event(2, "tool.execution.completed", { toolCallId: "c1", path: "inbox/1.md" }),
      ],
      40,
    ).join("\n");
    assert.ok(lines.includes("three replies drafted"));
    assert.ok(lines.includes("what did not happen:"));
    assert.ok(lines.includes("nothing was left undone"));
  });

  it("names the steps a failed run never executed", () => {
    const lines = resultLines(
      record({ state: "failed", error: { code: "provider-error", message: "x" } }),
      [event(1, "tool.call.proposed", { toolCallId: "c9", tool: "net.fetch", tier: "T2" })],
      40,
    ).join("\n");
    assert.ok(lines.includes("net.fetch — proposed but never executed"));
  });
});

describe("the pane body and the reads", () => {
  it("keeps the actions line on a 24-row screen even with a long history (T7-09 pages)", () => {
    const many = Array.from({ length: 40 }, (_, index) => event(index + 1, "task.progress", {}));
    const lines = taskDetailLines({ ...emptyTaskDetail(record()), events: many }, 40, 24);
    assert.ok((lines[lines.length - 1] as string).includes("q/Esc back"));
  });

  it("reads the Gateway's events envelope with a sentence, not a TypeError", () => {
    assert.equal(readEventItems({ items: [event(1, "task.progress", {})] }).length, 1);
    assert.throws(() => readEventItems({ rows: [] }), /no `items` list/);
  });
});
