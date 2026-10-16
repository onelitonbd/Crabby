// T8's context view, over the body `GET /sessions/{id}/context` answers.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionContextBody } from "@crabby/api-contracts";
import {
  budgetLine,
  compactedLines,
  contextLines,
  overflowLines,
  policyLines,
  sectionLines,
} from "./context.ts";

const body = (over: Partial<SessionContextBody> = {}): SessionContextBody => ({
  sessionId: "ses_1",
  projected: { tokens: 3200, source: "estimated" },
  budget: {
    window: 8192,
    reserveForOutput: 1024,
    tokens: 7168,
    compactAtTokens: 5734,
    compactAt: 0.8,
  },
  turns: 12,
  model: "local/qwen3:4b",
  sections: {
    compacted: { chars: 400, tokens: 100, source: "estimated", turns: 2 },
    pinned: { chars: 0, tokens: 0, source: "estimated", turns: 0 },
    current: { chars: 9600, tokens: 3100, source: "estimated", turns: 10 },
  },
  compacted: [],
  pinned: [],
  absent: ["memories", "summary-editing"],
  ...over,
});

describe("T8-01 — the budget line", () => {
  it("carries the `~` an estimate owes, with the reserve and the threshold", () => {
    const line = budgetLine(body());
    assert.ok(line.startsWith("~3,200 tokens of 7,168"), line);
    assert.ok(line.includes("reserve for output 1,024"), line);
    assert.ok(line.includes("5,734"), line);
  });

  it("drops the `~` when the count was measured", () => {
    assert.ok(
      budgetLine(body({ projected: { tokens: 3200, source: "measured" } })).startsWith("3,200"),
    );
  });

  it("says the window is unnamed rather than answering a zero (§3.2)", () => {
    const line = budgetLine(body({ budget: undefined } as unknown as Partial<SessionContextBody>));
    assert.ok(line.includes("unnamed window"), line);
    assert.ok(line.includes("§3.2"), line);
    assert.ok(!line.includes("of 0"), line);
  });
});

describe("T8-02 — the sections, zero shown not hidden", () => {
  it("prints each of the three sections with its cost", () => {
    const lines = sectionLines(body());
    assert.equal(lines.length, 4, lines.join(" | "));
    assert.ok(lines[1]?.includes("compacted summaries"), lines.join(" | "));
    assert.ok(lines[2]?.includes("~0 tokens"), "a section costing 0 shows 0");
    assert.ok(lines[3]?.includes("10 turns"), lines.join(" | "));
  });
});

describe("T8-03 — the compacted card and D-027's promise", () => {
  it("names where the originals live, in words a reader can act on", () => {
    const lines = compactedLines(
      body({
        compacted: [
          {
            messageId: "msg_9",
            covers: { from: 1, through: 8 },
            turns: 8,
            at: "2026-02-03T08:00:00Z",
          },
        ],
      }),
    );
    assert.ok(lines.join(" | ").includes("turns 1–8"), lines.join(" | "));
    assert.ok(
      lines.some((line) => line.includes("not gone") && line.includes("/messages")),
      lines.join(" | "),
    );
  });

  it("says `nothing yet` rather than rendering an empty card", () => {
    const lines = compactedLines(body());
    assert.ok(lines[0]?.includes("nothing yet"), lines.join(" | "));
  });
});

describe("T8-04/05/06 — pins, provenance and what this build does not have", () => {
  it("renders the pinned ranges and names the pin write", () => {
    const lines = policyLines(
      body({
        pinned: [
          { from: 3, through: 5 },
          { from: 7, through: 7 },
        ],
      }),
    );
    assert.ok(lines[0]?.includes("3-5, 7"), lines.join(" | "));
  });

  it("says where unpin and memory actually live, rather than faking them", () => {
    const lines = policyLines(body());
    assert.ok(lines.join(" | ").includes("crabby session unpin"), lines.join(" | "));
    assert.ok(lines.join(" | ").includes("M4"), lines.join(" | "));
    assert.ok(lines.join(" | ").includes("T8-05"), "the excluded-section gap is named, not silent");
  });
});

describe("T8-08 — the overflow warning, before the send", () => {
  it("warns past the compact threshold and offers the two fixes", () => {
    const lines = overflowLines(body({ projected: { tokens: 5900, source: "estimated" } }));
    assert.equal(lines.length, 2, lines.join(" | "));
    assert.ok(lines[0]?.includes("compact threshold"), lines.join(" | "));
  });

  it("warns harder at the window itself", () => {
    const lines = overflowLines(body({ projected: { tokens: 8000, source: "estimated" } }));
    assert.ok(lines[0]?.includes("window"), lines.join(" | "));
  });

  it("says nothing under the threshold", () => {
    assert.deepEqual(overflowLines(body()), []);
  });

  it("cannot warn without a budget, and does not invent one", () => {
    assert.deepEqual(
      overflowLines(body({ budget: undefined } as unknown as Partial<SessionContextBody>)),
      [],
    );
  });
});

describe("the whole view", () => {
  it("wraps to 40 columns and carries the confirm line", () => {
    const lines = contextLines(body(), 40, false);
    for (const line of lines) assert.ok(line.length <= 40, line);
    // The hint wraps at 40, so the assertion reads the tail of the view as one sentence, not one drawn line.
    const hint = (lines.at(-2) ?? "") + " " + (lines.at(-1) ?? "");
    assert.ok(hint.replace(/\s+/g, " ").includes("c compact now"), hint);
  });

  it("the second press is asked in words, with the sections as the preview (T8-07)", () => {
    const lines = contextLines(body(), 120, true);
    assert.ok(lines.at(-1)?.includes("press c again"), lines.at(-1));
    assert.ok(lines.at(-1)?.includes("preview"), lines.at(-1));
  });
});
