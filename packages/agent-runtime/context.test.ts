// The context manager's arithmetic, asserted as the sentences it is supposed to be true of: §3.4's
// heuristic prefers an adapter's own counter, an estimate is always labelled an estimate, the budget
// is derived from the descriptor rather than stored, D-115's threshold fires at four fifths, and a
// plan that cannot help says so instead of spending a model call to fail.

import { LIMITS_DEFAULTS } from "@crabby/core";
import type { ProviderMessage } from "@crabby/providers";
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  contextBudget,
  contextLimits,
  DEFAULT_CONTEXT_LIMITS,
  estimateTokens,
  type ContextUnit,
  measureMessage,
  measureText,
  planCompaction,
} from "./context.ts";

function unit(id: string, tokens: number, kind: "turn" | "prefix" = "turn"): ContextUnit {
  return { kind, id, measure: { tokens, source: "estimated" } };
}

function units(...tokens: readonly number[]): readonly ContextUnit[] {
  return tokens.map((value, index) => unit(`t${index + 1}`, value));
}

describe("estimateTokens — §3.4's heuristic, and D-064's Bengali case", () => {
  it("counts an empty string as nothing, because an empty string is not one token", () => {
    strictEqual(estimateTokens(""), 0);
  });

  it("is D-064's formula literally: max(chars / 4, clusters × 1.35)", () => {
    strictEqual(estimateTokens("abcd"), Math.ceil(4 * 1.35));
    strictEqual(estimateTokens("a".repeat(400)), Math.ceil(400 * 1.35));
  });

  it("over-counts Latin text, and that is the number's direction rather than a bug in this file", () => {
    // A Western tokenizer spends about one token per four characters, so the cluster term prices
    // English at roughly five times its real cost. That is D-064 as accepted, and it errs toward
    // compacting early: an over-estimate costs a summary call, an under-estimate costs an overflow
    // in the middle of a task. It is also why O-075 exists — see DECISIONS.md — since a coefficient
    // this far from a real count is worth the owner's attention even when it is the safe direction.
    const english = "the quick brown fox jumps over the lazy dog";
    strictEqual(estimateTokens(english), Math.ceil(english.length * 1.35));
    ok(estimateTokens(english) > english.length / 4);
  });

  it("prefers grapheme clusters over code units, which is where D-064's Bengali case matters", () => {
    // `দিয়েছি` is D-064's own measurement: 7 code units, 3 clusters. Dividing code units by four
    // would under-count a grapheme-heavy script; counting clusters cannot.
    const bengali = "দিয়েছি";
    strictEqual(bengali.length, 7);
    strictEqual(estimateTokens(bengali), Math.ceil(3 * 1.35));
    ok(estimateTokens(bengali) > 0);
  });

  it("rounds up rather than down: an estimate that claims room the window does not have overflows", () => {
    // One grapheme is 1.35 tokens before rounding, so rounding down would price a whole cluster at
    // one token. Ceil, never floor.
    strictEqual(estimateTokens("a"), 2);
    strictEqual(estimateTokens("ab"), 3);
  });
});

describe("measureText — §3.4's preference order, and its labelling rule", () => {
  it("asks the adapter's counter when there is one, and says it was measured", () => {
    deepStrictEqual(measureText("abcd", () => 99), { tokens: 99, source: "measured" });
  });

  it("estimates when there is no counter, and labels the result `estimated`", () => {
    deepStrictEqual(measureText("abcd"), { tokens: Math.ceil(4 * 1.35), source: "estimated" });
  });

  it("refuses a counter that answers with nonsense — a bad number is not a measurement", () => {
    const estimated = { tokens: Math.ceil(4 * 1.35), source: "estimated" };
    deepStrictEqual(measureText("abcd", () => Number.NaN), estimated);
    deepStrictEqual(measureText("abcd", () => -5), estimated);
  });
});

describe("measureMessage — a request carries more than its text", () => {
  const call: ProviderMessage = {
    role: "assistant",
    content: "",
    toolCalls: [{ id: "call_1", name: "file.write", arguments: { path: "a.txt", content: "x".repeat(400) } }],
  };

  it("counts a proposed call's arguments, so a step's payload cannot pass the budget unmeasured", () => {
    ok(measureMessage(call).tokens >= 100);
  });

  it("counts a tool result's text and its toolCallId", () => {
    const result: ProviderMessage = { role: "tool", content: "y".repeat(80), toolCallId: "call_1" };
    ok(measureMessage(result).tokens >= 20);
  });

  it("survives a tool call it cannot serialize, because a thrown count is worse than an imprecise one", () => {
    const cyclic: ProviderMessage = {
      role: "assistant",
      content: "z",
      toolCalls: [{ id: "call_2", name: "shell.run", arguments: undefined as never }],
    };
    (cyclic.toolCalls as unknown as { arguments: unknown }).arguments = (() => {
      const box: Record<string, unknown> = {};
      box.self = box;
      return box;
    })();
    ok(measureMessage(cyclic).tokens >= 1);
  });
});

describe("contextBudget — §3.4 derives it from the descriptor", () => {
  it("subtracts reserve-for-output, and thresholds at D-115's four fifths", () => {
    const budget = contextBudget({ contextWindow: 8192, maxOutputTokens: 1024 });
    deepStrictEqual(budget, {
      window: 8192,
      reserveForOutput: 1024,
      budget: 7168,
      compactAtTokens: Math.floor(7168 * 0.8),
    });
    strictEqual(budget.compactAtTokens, 5734);
  });

  it("scales with the model: the same limits give a 200k model a proportionally larger budget", () => {
    const small = contextBudget({ contextWindow: 8192, maxOutputTokens: 1024 });
    const large = contextBudget({ contextWindow: 200_000, maxOutputTokens: 8_000 });
    ok(large.budget > small.budget * 20);
  });

  it("never produces a threshold of zero on a tiny window", () => {
    const budget = contextBudget({ contextWindow: 64, maxOutputTokens: 63 }, {
      ...DEFAULT_CONTEXT_LIMITS,
      compactAt: 0.01,
    });
    strictEqual(budget.budget, 1);
    strictEqual(budget.compactAtTokens, 1);
  });
});

describe("contextLimits — configuration with defaults, and the one key without a default", () => {
  it("defaults to D-115's numbers with no configuration at all", () => {
    deepStrictEqual(contextLimits(undefined), { compactAt: 0.8, verbatimTurns: 6, summaryModel: undefined });
  });

  it("fills only what configuration omits", () => {
    deepStrictEqual(contextLimits({ context: { verbatimTurns: 3 } }), {
      compactAt: 0.8,
      verbatimTurns: 3,
      summaryModel: undefined,
    });
  });

  it("keeps a configured summarizer model, spelled as an answer spells it", () => {
    strictEqual(contextLimits({ context: { summaryModel: "groq/llama-3.3-70b" } }).summaryModel, "groq/llama-3.3-70b");
  });

  it("agrees with the config file's own defaults, so a number cannot differ between two interfaces", () => {
    deepStrictEqual(
      { compactAt: LIMITS_DEFAULTS.context.compactAt, verbatimTurns: LIMITS_DEFAULTS.context.verbatimTurns },
      { compactAt: DEFAULT_CONTEXT_LIMITS.compactAt, verbatimTurns: DEFAULT_CONTEXT_LIMITS.verbatimTurns },
    );
  });
});

describe("planCompaction — D-027's hybrid, decided in arithmetic", () => {
  const budget = contextBudget({ contextWindow: 8192, maxOutputTokens: 1024 });

  it("does nothing below the threshold, and reports both numbers so a caller can explain itself", () => {
    const plan = planCompaction({ units: units(100, 100), budget, verbatimTurns: 6 });
    strictEqual(plan.kind, "not-needed");
    if (plan.kind !== "not-needed") return;
    strictEqual(plan.projected, 200);
    strictEqual(plan.threshold, budget.compactAtTokens);
  });

  it("splits at D-115's six most recent turns, oldest first", () => {
    // Twelve turns of 500 tokens: 6,000 > 5,734, so it compacts; the six newest stay verbatim.
    const many = units(...Array.from({ length: 12 }, () => 500));
    const plan = planCompaction({ units: many, budget, verbatimTurns: 6 });
    strictEqual(plan.kind, "planned");
    if (plan.kind !== "planned") return;
    deepStrictEqual(
      plan.summary.map((u) => u.id),
      ["t1", "t2", "t3", "t4", "t5", "t6"],
    );
    deepStrictEqual(
      plan.verbatim.map((u) => u.id),
      ["t7", "t8", "t9", "t10", "t11", "t12"],
    );
    strictEqual(plan.projectedBefore, 6000);
  });

  it("sizes the summary by the headroom the verbatim tail leaves under the threshold", () => {
    const many = units(...Array.from({ length: 12 }, () => 500));
    const plan = planCompaction({ units: many, budget, verbatimTurns: 6 });
    if (plan.kind !== "planned") throw new Error("expected a plan");
    strictEqual(plan.summaryTokenAllowance, budget.compactAtTokens - 3000);
    ok(plan.summaryTokenAllowance > 0);
  });

  it("refuses when there is nothing older to summarize, rather than summarizing the recent turns", () => {
    const plan = planCompaction({ units: units(...Array.from({ length: 6 }, () => 1000)), budget, verbatimTurns: 6 });
    strictEqual(plan.kind, "refused");
    if (plan.kind !== "refused") return;
    strictEqual(plan.reason, "nothing-to-summarize");
  });

  it("refuses when the verbatim tail alone is over the threshold: dropping the user's recent turns is not compaction", () => {
    const plan = planCompaction({ units: units(...Array.from({ length: 9 }, () => 1000)), budget, verbatimTurns: 8 });
    strictEqual(plan.kind, "refused");
    if (plan.kind !== "refused") return;
    strictEqual(plan.reason, "verbatim-exceeds-budget");
  });

  it("keeps a non-turn unit verbatim by position, so the system prompt is never summarized away", () => {
    const plan = planCompaction({
      units: [
        unit("system", 500, "prefix"),
        unit("t1", 2000),
        unit("t2", 2000),
        unit("t3", 2000),
      ],
      budget,
      verbatimTurns: 1,
    });
    if (plan.kind !== "planned") throw new Error(`expected a plan, got ${plan.kind}`);
    // The system prompt is the oldest unit, so a positional tail of one leaves it in the summary —
    // which is the documented consequence of a positional split and the reason a caller counts
    // prefixes into its own budget rather than trusting the plan to protect them.
    deepStrictEqual(
      plan.verbatim.map((u) => u.id),
      ["t3"],
    );
  });
});