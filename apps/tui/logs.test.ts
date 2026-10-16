// The logs pane, asserted against `docs/review/TUI.md` region T15 — T15-04's decisions view (every prompt and its
// answer, `expired` as its own outcome), T15-05's artifact line, T15-07's assurance note and T15-08's page bound, with
// T15-01/03's route gaps named rather than faked.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assuranceLine,
  auditViewLines,
  decisionLines,
  decisionsViewLines,
  diagnosticsLine,
  logsPane,
  logViewLines,
  nextLogsView,
  VIEW_PAGE_LINES,
} from "./logs.ts";
import type { PaneContext } from "./panes.ts";

const approval = (over: Record<string, unknown> = {}) =>
  ({
    id: "apr_1",
    state: "pending",
    requestedAt: Date.parse("2026-10-16T10:00:00Z"),
    request: {
      taskId: "tsk_1",
      tool: "fs.write",
      tier: "T2",
      summary: "write notes.md in the workspace",
      exact: "fs.write notes.md",
      effects: "one file",
      reversibility: "reversible",
      whatCouldGoWrong: "the wrong file",
      expiresAt: Date.parse("2026-10-16T10:10:00Z"),
      binding: "exact",
    },
    ...over,
  }) as never;

const context = (over: Partial<PaneContext> = {}): PaneContext =>
  ({
    client: {},
    pane: "logs",
    rows: 24,
    columns: 40,
    color: "none",
    offline: false,
    ...over,
  }) as PaneContext;

describe("T15-04 — every prompt and its answer, expired included", () => {
  it("renders two lines per prompt and keeps `expired` its own outcome, never a denial", () => {
    const lines = decisionLines(approval(), 40);
    assert.equal(lines.length, 2);
    assert.ok((lines[0] as string).startsWith("pending · T2 · fs.write"));
    assert.ok((lines[1] as string).includes("waiting for an answer"));
    const expired = decisionLines(approval({ state: "expired" }), 40);
    assert.ok(expired.join("\n").includes("its own outcome, not a denial"));
    const denied = decisionLines(approval({ state: "denied", answeredBy: "Liton" }), 40);
    assert.ok(denied.join("\n").includes("answered by Liton"));
  });

  it("pages at T15-08's bound and says how many rows it left out", () => {
    const many = Array.from({ length: VIEW_PAGE_LINES + 3 }, (_, index) =>
      approval({ id: `apr_${index}` }),
    );
    const text = decisionsViewLines(many, 40).join("\n");
    assert.ok(text.includes("3 more"));
  });
});

describe("T15-01 and T15-03 — the route gaps named, not faked", () => {
  it("says `GET /logs` and `GET /audit` have no routes and names the milestone", () => {
    assert.ok(logViewLines().join("\n").includes("GET /logs"));
    assert.ok(auditViewLines().join("\n").includes("GET /audit"));
  });
});

describe("T15-05 and T15-07 — the artifact path and the tested-redaction note", () => {
  it("prints the path (a clipboard is unreliable over ssh) and the assurance note in W14-07's register", () => {
    assert.ok(
      diagnosticsLine("/tmp/crabby-diagnostics-x.json", 120).includes(
        "/tmp/crabby-diagnostics-x.json",
      ),
    );
    assert.ok(assuranceLine().includes("verified by tests"));
    assert.ok(assuranceLine().includes("redacted"));
  });

  it("every view carries the assurance note and the dead Gateway names the restart command (T1-10)", () => {
    assert.ok(logsPane(context(), "log").some((line) => line === assuranceLine()));
    assert.ok(
      logsPane(context(), "decisions", [approval() as never]).some(
        (line) => line === assuranceLine(),
      ),
    );
    assert.ok(
      logsPane(context({ offline: true }), "log")
        .join("\n")
        .includes("crabby gateway start"),
    );
  });
});

describe("the view cycle", () => {
  it("walks log → audit → decisions → log", () => {
    assert.equal(nextLogsView("log"), "audit");
    assert.equal(nextLogsView("audit"), "decisions");
    assert.equal(nextLogsView("decisions"), "log");
  });
});
