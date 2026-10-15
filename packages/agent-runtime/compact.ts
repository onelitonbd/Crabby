// D-027's act: a conversation that has outgrown its budget becomes a summary row that stands in for
// the older turns without replacing them, and the turns themselves stay exactly where they were.
//
// This file is the *act*, and the division of labour with `context.ts` is one sentence: that module
// decides **whether** a conversation needs compacting and how large a summary may be, and this one
// carries it out. Everything expensive or durable happens here — a model call, a row, a transaction —
// and everything cheap and pure stays there, so the part that can be wrong quietly is the part that
// can be tested without a phone.
//
// Four properties are decisions rather than conveniences:
//
//   - **The summarizer gets no tools.** A compaction is a text-in, text-out request about the
//     conversation that already happened. Handing it the tool registry would give a derived record the
//     power to act on the world while being written, and D-101's rule is that nothing may alter what a
//     task does except the task's own gated path.
//   - **The summary's size is a number from the plan, not an adjective.** `plan.summaryTokenAllowance`
//     is passed as `maxTokens` and named in the instruction, because "be brief" produces a summary
//     sized by whichever model read it.
//   - **A failed summary retries once and then surfaces** (D-115). Not the loop's six-rung ladder: a
//     summarizer that is rate-limited should not spend a task's whole attempt budget on a derived
//     record, and a compaction is not a task, so D-044's "ask the user which model instead" has no
//     rung here to land on. What it does instead is return `failed`, which the caller surfaces — the
//     alternative the owner rejected, silently dropping the oldest turns, is the one thing a context
//     manager must never do quietly.
//   - **A summarizer too small for the turns is refused, not attempted.** D-115 lets the user point
//     `summaryModel` at a cheap small model; feeding a large conversation to a window that cannot hold
//     it produces a `context-overflow` on the summarizer, which reads like the user's configuration
//     being broken rather than a mismatch worth naming.

import {
  type Provider,
  ProviderError,
  type ProviderMessage,
  retryDelayMs,
} from "@crabby/providers";
import {
  type BudgetDescriptor,
  type CompactionPlan,
  type CompactionRefusal,
  type ContextLimits,
  type ContextUnit,
  contextBudget,
  contextLimits,
  measureText,
  planCompaction,
} from "./context.ts";
import type { MessageWriter, RecordedMessage } from "./messages.ts";

/** What the caller has that this module cannot know: the turns, in the order they happened, and the
 *  ordinals they hold. Both are required — an ordinal is how a summary says what it stands in for, and
 *  a summary with no range would be a `system` turn pretending to be a record of the whole
 *  conversation. */
export interface ConversationTurn {
  readonly id: string;
  readonly ordinal: number;
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
}

export interface CompactionRequest {
  readonly sessionId: string;
  /** Absent for a compaction asked for over the route: a conversation can outgrow its budget with no
   *  task in it at all, and the summary row's `task_id` is nullable for exactly that row. */
  readonly taskId?: string | undefined;
  /** Oldest first, with their ordinals. A caller that reverses this summarizes the wrong end. */
  readonly turns: readonly ConversationTurn[];
  /** The descriptor of the model the **run** is on — the conversation's budget, which is the one that
   *  overflows. The summarizer's own descriptor is `summarizer`, because it has its own window. */
  readonly descriptor: BudgetDescriptor;
  readonly summarizer: BudgetDescriptor & { readonly modelId: string };
  readonly limits?: ContextLimits | undefined;
  /** §3.4's measurement preference, when the summarizer's adapter ships a counter. */
  readonly countTokens?: ((text: string) => number) | undefined;
  readonly now: () => number;
}

export interface CompactionDeps {
  readonly provider: Provider;
  readonly messages: MessageWriter;
  readonly signal?: AbortSignal | undefined;
  /** D-064's schedule, injectable so the retry test does not sleep a second of real time. */
  readonly wait?: ((ms: number) => Promise<void>) | undefined;
}

/** Why a compaction did not happen. The first two come from the planner and mean the conversation is
 *  fine or cannot be helped; the third means the user's own configuration does not fit the turns. */
export type CompactionOutcomeReason = CompactionRefusal | "summarizer-window-too-small";

export type CompactionOutcome =
  | { readonly kind: "not-needed"; readonly projected: number; readonly threshold: number }
  | {
      readonly kind: "refused";
      readonly reason: CompactionOutcomeReason;
      readonly projected: number;
    }
  | {
      readonly kind: "summarized";
      readonly stored: RecordedMessage;
      readonly covers: { readonly from: number; readonly through: number };
      readonly turns: number;
      /** D-064's `estimated` label travels with these two numbers, because §3.4 requires it and because
       *  "we saved 4,000 tokens" is a claim a screen should not make in the present tense. */
      readonly tokensBefore: { readonly tokens: number; readonly source: "measured" | "estimated" };
      readonly tokensAfter: { readonly tokens: number; readonly source: "measured" | "estimated" };
      readonly model: string;
    }
  | { readonly kind: "failed"; readonly error: ProviderError; readonly attempts: number };

/** §3.2's instruction to a summarizer, as a sentence rather than a prompt fragment. It says what to
 *  keep, because a summary of a task that omits the constraints is how a context system discards the
 *  thing the user pinned — §8.1's own warning, written where the model that has to honour it can read
 *  it. `allowance` is in tokens because that is the unit `maxTokens` is in. */
function summaryInstruction(allowance: number): string {
  return [
    "You are compressing a conversation so an unfinished task can keep working.",
    "Write compact notes, not prose: what was asked, what was decided, what is still open,",
    "and any constraint, path, name or error that must not be lost.",
    "Do not invent, do not resolve anything that is still open, and do not add advice.",
    `Reply with the notes only, at most ${allowance} tokens.`,
  ].join(" ");
}

/** The turns as one user message, each labelled so the summarizer can refer to them by place. Ordinals
 *  are printed rather than inferred from order, because "the fourth turn" and "turn 4" are different
 *  statements and only one of them survives a conversation that was paged or resumed. */
function transcript(turns: readonly ConversationTurn[]): string {
  return turns.map((turn) => `#${turn.ordinal} ${turn.role}: ${turn.content}`).join("\n\n");
}

/** §3.5's retryable classes, read from the error rather than re-declared. A retryable class is the only
 *  thing worth one more attempt: `auth` and `billing` are refusals that a second request cannot fix,
 *  and `content-filter` is a verdict. Reusing the taxonomy instead of a local list is the point — a
 *  second list is a second opinion about what is worth retrying. */
function isRetryable(error: ProviderError): boolean {
  return error.retryable === true;
}

export async function compactConversation(
  request: CompactionRequest,
  deps: CompactionDeps,
): Promise<CompactionOutcome> {
  const limits = request.limits ?? contextLimits(undefined);
  const budget = contextBudget(request.descriptor, limits);
  const units: ContextUnit[] = request.turns.map((turn) => ({
    kind: "turn",
    id: turn.id,
    measure: measureText(turn.content, request.countTokens),
  }));
  const plan: CompactionPlan = planCompaction({
    units,
    budget,
    verbatimTurns: limits.verbatimTurns,
  });
  if (plan.kind === "not-needed") {
    return { kind: "not-needed", projected: plan.projected, threshold: plan.threshold };
  }
  if (plan.kind === "refused")
    return { kind: "refused", reason: plan.reason, projected: plan.projected };

  // The summarizer has to be able to *read* the turns it is summarizing, which is a different window
  // from the one being relieved: the run's budget says how much context is too much, and the
  // summarizer's says how much is receivable. Checked before the call rather than discovered as a
  // `context-overflow`, because a refusal that names the mismatch is something a user can act on and a
  // provider error is not (D-115 lets them configure this model; nothing told them it was too small).
  const summaryTokens = plan.summary.reduce((total, unit) => total + unit.measure.tokens, 0);
  const summarizerBudget = contextBudget(request.summarizer, limits);
  if (summaryTokens >= summarizerBudget.budget) {
    return {
      kind: "refused",
      reason: "summarizer-window-too-small",
      projected: plan.projectedBefore,
    };
  }

  const turns = plan.summary.map((unit) => {
    const turn = request.turns.find((candidate) => candidate.id === unit.id);
    // Present by construction — `units` came from `turns` — and a summarizer that silently summarized
    // three of four turns would be the worst bug this file could have, so it is a thrown error rather
    // than a filter that drops whatever it cannot find.
    if (turn === undefined)
      throw new Error(`unit ${unit.id} is not one of the conversation's turns`);
    return turn;
  });
  const first = turns[0];
  const last = turns[turns.length - 1];
  if (first === undefined || last === undefined) {
    return { kind: "refused", reason: "nothing-to-summarize", projected: plan.projectedBefore };
  }

  const messages: ProviderMessage[] = [
    { role: "system", content: summaryInstruction(plan.summaryTokenAllowance) },
    { role: "user", content: transcript(turns) },
  ];
  const allowance = plan.summaryTokenAllowance;
  const requestId = `compact_${request.sessionId}`;
  const controller = new AbortController();
  deps.signal?.addEventListener("abort", () => controller.abort(), { once: true });

  let attempts = 0;
  let lastError: ProviderError | undefined;
  // Two attempts, one retry: D-115's answer, and the whole of the retry policy for this request.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    attempts = attempt;
    try {
      const result = await deps.provider.generate(
        { modelId: request.summarizer.modelId, messages, maxTokens: allowance },
        {
          signal: controller.signal,
          requestId,
          ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
        },
      );
      const text = result.text.trim();
      if (text.length === 0) {
        // An empty summary is not a summary: it would cover turns with nothing, and the next request
        // would carry a `system` row that says it stands in for four turns and says nothing at all.
        // §3.5 has a class for exactly this — the response was well-formed and useless.
        return {
          kind: "failed",
          error: new ProviderError(
            "invalid-response",
            "the summarizer returned no text, so nothing would stand in for the covered turns",
            { attempt: attempts },
          ),
          attempts,
        };
      }
      const stored = deps.messages.summarize({
        sessionId: request.sessionId,
        ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
        content: text,
        covers: { from: first.ordinal, through: last.ordinal },
        at: request.now(),
      });
      const verbatimTokens = plan.verbatim.reduce((total, unit) => total + unit.measure.tokens, 0);
      const summaryMeasure = measureText(text, request.countTokens);
      return {
        kind: "summarized",
        stored,
        covers: { from: first.ordinal, through: last.ordinal },
        turns: turns.length,
        // D-064's `estimated` label travels with both numbers, because §3.4 requires it and because
        // "we saved 4,000 tokens" is a claim a screen should not make in the present tense.
        // `tokensBefore` is an estimate by construction: it is a sum of per-turn measures, and only an
        // adapter with a counter can have made any one of them a measurement — which summing does not change.
        tokensBefore: { tokens: plan.projectedBefore, source: "estimated" },
        tokensAfter: {
          tokens: summaryMeasure.tokens + verbatimTokens,
          source: summaryMeasure.source,
        },
        model: request.summarizer.modelId,
      };
    } catch (thrown) {
      const error = thrown as ProviderError;
      lastError = error;
      if (!isRetryable(error) || attempt === 2) break;
      const { ms } = retryDelayMs(attempt, error.retryAfterMs);
      const wait =
        deps.wait ?? ((delay: number) => new Promise<void>((done) => setTimeout(done, delay)));
      await wait(ms);
    }
  }
  return { kind: "failed", error: lastError as ProviderError, attempts };
}
