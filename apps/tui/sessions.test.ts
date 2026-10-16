// T16's switcher, driven by rows.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionRow } from "@crabby/api-contracts";
import {
  middleClip,
  relativeActivity,
  sessionLine,
  switcherLines,
  switchNote,
} from "./sessions.ts";

const row = (over: Partial<SessionRow> = {}): SessionRow => ({
  id: "ses_1",
  titleShown: "summarise the inbox",
  stateWord: "idle",
  title: "summarise the inbox",
  createdAt: "2026-02-03T09:00:00Z",
  updatedAt: "2026-02-03T09:30:00Z",
  lastActivityAt: "2026-02-03T09:30:00Z",
  revision: 3,
  tasks: 1,
  runningTasks: 0,
  ...over,
});

describe("T16-02 — relative activity and the middle-clipped title", () => {
  it("speaks durations a phone reads at a glance", () => {
    const now = Date.parse("2026-02-03T10:00:00Z");
    assert.equal(relativeActivity("2026-02-03T09:59:30Z", now), "30s ago");
    assert.equal(relativeActivity("2026-02-03T09:40:00Z", now), "20m ago");
    assert.equal(relativeActivity("2026-02-03T08:00:00Z", now), "2h ago");
    assert.equal(relativeActivity("2026-02-01T10:00:00Z", now), "2d ago");
    assert.equal(relativeActivity("not a stamp", now), "activity unknown");
  });

  it("cuts the title in the middle, keeping both ends", () => {
    const cut = middleClip("retry the flaky export twice, then rename the files", 20);
    assert.equal(cut.length, 20);
    assert.ok(cut.includes("…"), cut);
    assert.ok(cut.startsWith("retry"), cut);
    assert.ok(cut.endsWith("files"), cut);
    assert.equal(middleClip("short", 20), "short");
  });
});

describe("T16-02/03 — the row: state word wins, current is a marker and a word", () => {
  it("never truncates the state word — the title is what shrinks", () => {
    const line = sessionLine(
      row({
        titleShown: "a very long objective that keeps going and going and going",
        stateWord: "running",
      }),
      40,
      { current: false, selected: true, now: Date.parse("2026-02-03T09:35:00Z") },
    );
    assert.ok(line.length <= 40, line);
    assert.ok(line.includes("running"), line);
    assert.ok(line.startsWith("> "), line);
  });

  it("marks the current session with `>` and the word `current`", () => {
    const line = sessionLine(row(), 40, { current: true, selected: false, now: 0 });
    assert.ok(line.startsWith("  "), "not selected, so no cursor");
    assert.ok(line.includes("current"), line);
  });
});

describe("T16-01/04/08 — the overlay: hint line, ten rows, the id line", () => {
  const rows = Array.from({ length: 14 }, (_, i) =>
    row({ id: `ses_${String(i + 1).padStart(2, "0")}`, titleShown: `session ${i + 1}` }),
  );

  it("shows at most ten rows plus the chrome", () => {
    const lines = switcherLines(rows, "ses_03", 2, 40, { now: 0 });
    assert.ok(lines[0]?.includes("Enter switch"), lines[0]);
    const body = lines.filter((line) => line.includes("session "));
    assert.ok(body.length <= 10, lines.join(" | "));
    assert.ok(
      lines.some((line) => line.includes("ses_03")),
      "the highlighted id is on its own line (T16-08)",
    );
  });

  it("scrolls so the selection stays visible at the bottom of the list", () => {
    const lines = switcherLines(rows, undefined, 13, 40, { now: 0 });
    assert.ok(
      lines.some((line) => line.startsWith("> ") && line.includes("session 14")),
      lines.join(" | "),
    );
    assert.ok(
      !lines.some((line) => line.includes("session 1 ")),
      "the top of the list scrolled away",
    );
  });

  it("says what `d` is in this build — the T3 gap, not a fake confirm", () => {
    const lines = switcherLines(rows.slice(0, 2), undefined, 0, 40, {
      now: 0,
      deleteNote: "deleting waits for `crabby history delete` (T3's one confirmed path)",
    });
    assert.ok(
      lines.some((line) => line.includes("crabby history delete")),
      lines.join(" | "),
    );
  });

  it("draws the rename inline on the overlay, as T16-05 asks", () => {
    const lines = switcherLines(rows.slice(0, 2), undefined, 0, 40, {
      now: 0,
      renameFor: "ses_01",
      renameBuffer: "inbo",
    });
    assert.ok(
      lines.some((line) => line.includes("title for ses_01: inbo")),
      lines.join(" | "),
    );
  });
});

describe("T16-07 — switching away from work in motion", () => {
  it("says the task keeps running and the events stop rendering", () => {
    const note = switchNote(row({ stateWord: "running", runningTasks: 1 }));
    assert.ok(note?.includes("keeps running"), note);
    assert.ok(note?.includes("until you come back"), note);
  });

  it("says a waiting prompt is still waiting, and the bell still reaches you", () => {
    const note = switchNote(row({ stateWord: "waiting-approval" }));
    assert.ok(note?.includes("still waiting"), note);
    assert.ok(note?.includes("approvals pane"), note);
  });

  it("says nothing for an idle session, because nothing was left behind", () => {
    assert.equal(switchNote(row({ stateWord: "idle" })), undefined);
  });
});
