// The context manager's arithmetic (D-027, D-113, D-115): how many tokens a turn costs, how many a
// request may carry, and when the older part of a conversation has to become a summary.
//
// Everything here is pure and everything here is *about the numbers*. Nothing in this file calls a
// provider, writes a row, or reads a conversation — a summarizer call is a request to a model and a
// summary is a row, and both of those live in the slice that has the store and the pool. What lives
// here is the part that decides, because the part that decides must be testable without either.
//
// Four properties are decisions rather than conveniences:
//
//   - **An estimate is labelled as an estimate.** §3.4 says the estimate "is reported as an estimate,
//     never as a measurement, and a screen that shows one labels it `estimated`". So every count in
//     this module carries *how* it was produced, and a caller cannot render it as a measurement by
//     accident: it has to drop the label deliberately.
//   - **The budget is a fraction of the descriptor, not a number.** §3.4's budget is
//     `contextWindow` minus reserve-for-output, and every model's window differs by three orders of
//     magnitude. A budget stored in `config.json` would be wrong for every model but the one it was
//     measured on.
//   - **The threshold is a fraction of the budget** (D-113): `limits.context.compactAt`, 0.8 by
//     default, chosen by the owner on 2026-10-15. The leftover fifth is not slack for its own sake —
//     it is the room a summary has to be written into and the room a provider's own framing needs
//     before it reports overflow instead of truncating.
//   - **A plan that cannot help says so.** `refused` is a first-class answer with two named reasons,
//     because a compactor that summarized anyway would spend a model call to produce a context that is
//     still over the ceiling. Refusing is also what keeps the truth visible: the verbatim tail is
//     bigger than the budget is a *fact about the conversation*, and the honest response to it is to
//     report it rather than to drop the user's recent turns to make the number look better.

import type { ProviderMessage } from "@crabby/providers";

/** §3.4's tuning values, as the loop and the route read them. The defaults are D-115's — the owner
 *  chose them in conversation on 2026-10-15 — and they live in `limits.context.*` in `config.json`
 *  so that `crabby config get limits` prints them like every other number in this build (D-074).
 *
 *  The shape is structural rather than `LimitsConfig` on purpose: a caller with three numbers should
 *  not have to build a whole config file to ask whether a conversation needs compacting, and the
 *  config layer has already range-checked whatever it hands over. */
export interface ContextLimits {
  /** The fraction of the budget at which compaction runs, in `(0, 1]`. D-115 priced 0.8. */
  readonly compactAt: number;
  /** How many of the most recent turns stay verbatim and unsummarized. D-115 priced 6. A run whose
   *  conversation is shorter than this has nothing to summarize, which is a plan and not a failure. */
  readonly verbatimTurns: number;
  /** `<provider>/<modelId>` for the summarizer, spelled the way `POST /tasks/{id}/resume` spells an
   *  answer (D-108, D-110). Absent means the run's own model writes the summary, which is a default
   *  and not a switch: it is the same model already in use, so nothing new learns anything about the
   *  user. D-115 chose a configurable model so a cheap one can do the work. */
  readonly summaryModel?: string | undefined;
}

/** D-115's defaults. A test in this file asserts that these and `LIMITS_DEFAULTS` in
 *  `packages/core/config.ts` agree, the same way `providerAttempts` and `MAX_ATTEMPTS` do — two
 *  modules remembering the same number is how a limit becomes a lie in one interface only. */
export const DEFAULT_CONTEXT_LIMITS: ContextLimits = {
  compactAt: 0.8,
  verbatimTurns: 6,
};

/** §3.4's tuning values out of a config's `limits.context`, with defaults for whatever is absent.
 *  A caller may pass `undefined` for a process with no config at all — `crabby` itself has one, a
 *  test may not. */
export function contextLimits(
  limits:
    | {
        readonly context?: {
          readonly compactAt?: number | undefined;
          readonly verbatimTurns?: number | undefined;
          readonly summaryModel?: string | undefined;
        } | undefined;
      }
    | undefined,
): ContextLimits {
  const context = limits?.context;
  return {
    compactAt: context?.compactAt ?? DEFAULT_CONTEXT_LIMITS.compactAt,
    verbatimTurns: context?.verbatimTurns ?? DEFAULT_CONTEXT_LIMITS.verbatimTurns,
    summaryModel: context?.summaryModel,
  };
}

/** How a count was produced, and §3.4's reason for carrying it: a screen that shows one labels it
 *  `estimated` rather than dimming it. `measured` means an adapter's own `countTokens` answered,
 *  which is only true for the families that ship one (`packages/providers/contract.ts` §`Estimator`). */
export interface TokenMeasure {
  readonly tokens: number;
  readonly source: "measured" | "estimated";
}

/** `Intl.Segmenter` is a runtime feature, not a language guarantee, and a build that lacks it still
 *  has to produce an estimate rather than refuse one. Code points are the fallback because they
 *  over-count Bengali (D-064's reason for preferring clusters) but never under-count it, and an
 *  estimate that is too large compacts early rather than overflowing late. */
const segmenter: Intl.Segmenter | undefined =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter("und", { granularity: "grapheme" })
    : undefined;

function graphemeClusters(text: string): number {
  if (segmenter) {
    let count = 0;
    for (const _cluster of segmenter.segment(text)) count += 1;
    return count;
  }
  return Array.from(text).length;
}

/** D-064's documented heuristic, verbatim: `max(chars / 4, grapheme clusters × 1.35)`, with the
 *  result rounded **up**. The rounding is this file's one addition and it is deliberate in that
 *  direction: an estimate that rounds down is an estimate that claims room the window does not have,
 *  and the failure that buys is a provider-reported overflow in the middle of a task rather than a
 *  compaction one step earlier. `0` for empty text, because an empty string is not one token. */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  const byChars = Math.ceil(text.length / 4);
  const byClusters = Math.ceil(graphemeClusters(text) * 1.35);
  return Math.max(1, byChars, byClusters);
}

/** §3.4's first rule of preference: an adapter that ships `countTokens` is asked, and the heuristic is
 *  only the fallback. The label travels with the number so nothing downstream can quietly promote an
 *  estimate into a measurement. */
export function measureText(
  text: string,
  countTokens?: ((text: string) => number) | undefined,
): TokenMeasure {
  if (countTokens) {
    const counted = countTokens(text);
    if (Number.isFinite(counted) && counted >= 0) {
      return { tokens: Math.ceil(counted), source: "measured" };
    }
    // A counter that answers with nonsense is not a measurement, and treating it as one would be
    // the exact failure §3.4's labelling rule exists to prevent. Fall through to the estimate.
  }
  return { tokens: estimateTokens(text), source: "estimated" };
}

/** A provider message carries more than its text: a proposed call's arguments travel in the same
 *  request and are usually the largest thing in it. Counting `content` alone would let a step whose
 *  arguments are 200 kB pass a 4 kB budget, so the arguments are counted as the serialized request
 *  counts them. Serialization cannot throw for a well-formed tool call, but a caller may hold
 *  anything, and a thrown compaction is worse than an imprecise one. */
export function measureMessage(
  message: ProviderMessage,
  countTokens?: ((text: string) => number) | undefined,
): TokenMeasure {
  const parts = [message.content];
  if (message.toolCalls && message.toolCalls.length > 0) {
    let serialized: string;
    try {
      serialized = JSON.stringify(message.toolCalls);
    } catch {
      serialized = message.toolCalls.map((call) => call.name).join(" ");
    }
    parts.push(serialized);
  }
  if (message.toolCallId) parts.push(message.toolCallId);
  return measureText(parts.join("\n"), countTokens);
}

/** One thing that occupies the context, with its cost already measured. The caller decides what a
 *  unit *is* — a turn, the system prompt, the tool specs — because §3.4 budgets a request rather than a
 *  conversation, and a caller that omitted its system prompt would be budgeting a request nobody
 *  sends. `kind` is carried so a planner can keep "the last six *turns*" verbatim without being told
 *  which unit is a turn, which is the difference between a verbatim tail and a verbatim tail that
 *  happens to be six messages including the tool specs. */
export interface ContextUnit {
  readonly kind: "turn" | "prefix";
  readonly id: string;
  readonly measure: TokenMeasure;
}

/** §3.4's budget, derived. `budget` is what a request may carry; `compactAtTokens` is when the
 *  runtime compacts. Both come from the descriptor rather than from configuration, which is the
 *  whole point: the same run against a 200 k window and a 8 k window gets budgets that fit. */
export interface ContextBudget {
  readonly window: number;
  readonly reserveForOutput: number;
  readonly budget: number;
  readonly compactAtTokens: number;
}

/** The two descriptor fields §3.4 needs, structurally: `contextWindow` and `maxOutputTokens`, the
 *  second being this build's reserve-for-output (`packages/providers/descriptor.ts` refuses a
 *  descriptor whose `maxOutputTokens` is not smaller than its window, so the subtraction is always
 *  positive). Declared here rather than imported because `packages/agent-runtime` must not depend on
 *  a provider *adapter* to count tokens, and a structural type is the cheapest way to say that. */
export interface BudgetDescriptor {
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
}

export function contextBudget(
  descriptor: BudgetDescriptor,
  limits: ContextLimits = DEFAULT_CONTEXT_LIMITS,
): ContextBudget {
  const budget = Math.max(1, descriptor.contextWindow - descriptor.maxOutputTokens);
  return {
    window: descriptor.contextWindow,
    reserveForOutput: descriptor.maxOutputTokens,
    budget,
    // Floor, so the threshold never rounds *up* past the budget on a window small enough for one
    // token to matter.
    compactAtTokens: Math.max(1, Math.floor(budget * limits.compactAt)),
  };
}

/** Why a plan could not be made. Both reasons are facts about the conversation, and both are worth
 *  more to a caller than a plan that cannot be executed. */
export type CompactionRefusal = "nothing-to-summarize" | "verbatim-exceeds-budget";

/** What the planner decided. A union rather than a plan with nullable fields: every caller of this
 *  has to handle "no compaction needed" and "compaction refused" differently, and a nullable field is
 *  a way of writing that handling once and getting the other two cases wrong. */
export type CompactionPlan =
  | {
      readonly kind: "not-needed";
      /** What the units cost, and what the threshold was — so a caller that wants to *report* why it
       * did nothing can, without recomputing either number. */
      readonly projected: number;
      readonly threshold: number;
    }
  | {
      readonly kind: "planned";
      readonly projectedBefore: number;
      /** Oldest first. These become the summarizer's input, in this order. */
      readonly summary: readonly ContextUnit[];
      /** The tail, in the same oldest-first order the caller passed in — the order a provider sees a
       *  conversation in, and the order a summary and the turns it stands in for have to be read
       *  together afterwards. */
      readonly verbatim: readonly ContextUnit[];
      /** How large the summary may be, so that the *next* request still fits: the headroom between the
       *  threshold and the verbatim tail. A summarizer told "be brief" is a summarizer that guesses. */
      readonly summaryTokenAllowance: number;
    }
  | {
      readonly kind: "refused";
      readonly reason: CompactionRefusal;
      readonly projected: number;
    };

export function planCompaction(input: {
  /** Oldest first. A caller that sorts newest-first gets a plan about the wrong end of the
   *  conversation, which is why the order is stated in the doc rather than inferred. */
  readonly units: readonly ContextUnit[];
  readonly budget: ContextBudget;
  readonly verbatimTurns: number;
}): CompactionPlan {
  const projected = input.units.reduce((total, unit) => total + unit.measure.tokens, 0);
  const threshold = input.budget.compactAtTokens;
  if (projected <= threshold) return { kind: "not-needed", projected, threshold };

  // The verbatim tail is the *last* `verbatimTurns` turns. Units that are not turns (a system prompt,
  // tool specs) are kept verbatim by definition — they are not history and summarizing them would
  // invent a conversation that never happened — so the tail is the last N units and the split is
  // positional rather than filtered.
  const verbatimCount = Math.max(0, input.verbatimTurns);
  const splitAt = Math.max(0, input.units.length - verbatimCount);
  const summary = input.units.slice(0, splitAt);
  if (summary.length === 0) {
    return { kind: "refused", reason: "nothing-to-summarize", projected };
  }
  const verbatim = input.units.slice(splitAt);
  const verbatimTokens = verbatim.reduce((total, unit) => total + unit.measure.tokens, 0);
  const allowance = threshold - verbatimTokens;
  if (allowance <= 0) {
    return { kind: "refused", reason: "verbatim-exceeds-budget", projected };
  }
  return {
    kind: "planned",
    projectedBefore: projected,
    summary,
    verbatim,
    summaryTokenAllowance: allowance,
  };
}