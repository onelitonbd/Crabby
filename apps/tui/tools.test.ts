// T12's tools view.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sortTools, type ToolRow, toolLine, toolsLines } from "./tools.ts";

const row = (over: Partial<ToolRow> = {}): ToolRow => ({
  id: "fs.write",
  capabilities: ["fs.write"],
  riskTier: "T2",
  tierText: "T2",
  tierRules: ["file.write T1 → T2 outside the root"],
  enabled: true,
  availability: { available: true, requires: "any" },
  pendingRecordFields: [],
  ...over,
});

describe("T12-01 — the list, sorted so the dangerous ones are together", () => {
  it("sorts by tier descending, then name", () => {
    const sorted = sortTools([
      row({ id: "net.fetch", riskTier: "T1" }),
      row({ id: "shell.run", riskTier: "T3" }),
      row({ id: "fs.read", riskTier: "T0" }),
      row({ id: "fs.write", riskTier: "T2" }),
    ]);
    assert.deepEqual(
      sorted.map((tool) => tool.id),
      ["shell.run", "fs.write", "net.fetch", "fs.read"],
    );
  });

  it("one line per tool, the state word last and never cut", () => {
    const line = toolLine(
      row({ id: "fs.write", riskTier: "T2", capabilities: ["fs.read", "fs.write"] }),
      40,
      false,
    );
    assert.ok(line.endsWith(" on"), line);
    assert.ok(line.length <= 40, line);
  });

  it("a tool that is off or deferred says so, not silence", () => {
    assert.ok(toolLine(row({ enabled: false }), 40, false).endsWith(" off"));
    assert.ok(toolLine(row({ deferred: true }), 40, false).endsWith(" deferred"));
  });
});

describe("T12-02/04 — the escalation rule and the deferral, as text", () => {
  it("the selected row carries its escalation sentence", () => {
    const lines = toolsLines([row()], 40, 0, false, 24, "abc123");
    assert.ok(
      lines.some((line) => line.includes("T1 → T2 outside the root")),
      lines.join(" | "),
    );
  });

  it("a deferred row names the reason, so absence is not a bug", () => {
    const lines = toolsLines(
      [
        row({
          id: "mem.search",
          riskTier: "T1",
          deferred: true,
          deferralReason: "memory arrives with M4",
        }),
      ],
      40,
      0,
      false,
      24,
      undefined,
    );
    // The reason wraps at 40, so the block is read as one sentence, not one drawn line.
    const said = lines.join(" ").replace(/\s+/g, " ");
    assert.ok(said.includes("not in this version") && said.includes("M4"), said);
  });
});

describe("T12-03 — the schema, one page and the gap named", () => {
  it("Enter wraps the input schema, capped, with the CLI for the rest", () => {
    const lines = toolsLines(
      [row({ inputSchema: { type: "object", properties: { path: { type: "string" } } } })],
      40,
      0,
      true,
      12,
      undefined,
    );
    assert.ok(
      lines.some((line) => line.includes('"type"')),
      lines.join(" | "),
    );
    assert.ok(
      lines.every((line) => line.length <= 40),
      lines.join(" | "),
    );
  });

  it("a row with no schema yet says so rather than drawing nothing", () => {
    const lines = toolsLines([row()], 40, 0, true, 20, undefined);
    assert.ok(
      lines.some((line) => line.includes("no schema is in this row's record yet")),
      lines.join(" | "),
    );
  });
});
