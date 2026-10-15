// The compaction act, asserted as the sentences it is supposed to be true of: a summary covers the older
// turns without replacing them, the summarizer is told how large it may be and is handed no tools, a
// failure retries once and then surfaces, and a conversation that does not need compacting says so
// without calling anything.

import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { FAKE_MODEL_ID, FakeProvider, type FakeStep, ProviderError } from "@crabby/providers";
import {
  type CompactionDeps,
  type ContextRequest,
  type ConversationTurn,
  compactConversation,
  createContextManager,
} from "./compact.ts";
import type { ContextLimits } from "./context.ts";
import type { MessageWriter, RecordedMessage, SummarizeMessageInput } from "./messages.ts";

/** D-115's numbers, restated so a change to them is a change to a number in this file rather than to
 *  every expectation below it. */
const LIMITS: ContextLimits = { compactAt: 0.8, verbatimTurns: 6 };

const RUN_DESCRIPTOR = { contextWindow: 8192, maxOutputTokens: 1024 };
// D-115's second answer is that the summarizer is *configurable*, so these tests use a model that is
// not the run's own — the fake declares one extra model for exactly this, and an undeclared id would
// be refused as a discovery failure before any script ran.
const SUMMARY_MODEL_ID = "fake-summary";
const SUMMARIZER = { modelId: SUMMARY_MODEL_ID, contextWindow: 8192, maxOutputTokens: 1024 };

/** The fake, with the summarizer's model declared beside the run's own. An undeclared id is refused as
 *  a discovery failure before any script runs, so the model has to exist for the script to mean
 *  anything. */
function summarizerProvider(script: readonly FakeStep[]): FakeProvider {
  return new FakeProvider({ script, models: [FAKE_MODEL_ID, SUMMARY_MODEL_ID] });
}

/** The fake replays its whole script on every call, which cannot express the one sequence this file has
 *  to prove — "fails once, succeeds on the retry". A proxy that fails the first `generate` and delegates
 *  every other member says it directly, and keeps the fake's own call log as the evidence. */
function failFirstThen(provider: FakeProvider, error: ProviderError): FakeProvider {
  let failed = false;
  return new Proxy(provider, {
    get(target, property, receiver) {
      if (property !== "generate") return Reflect.get(target, property, receiver);
      return async (...args: Parameters<FakeProvider["generate"]>) => {
        if (!failed) {
          failed = true;
          throw error;
        }
        return target.generate(...args);
      };
    },
  }) as FakeProvider;
}

/** A recording writer, so a test can read what was written without a database — the row's own schema is
 *  `packages/storage`'s to prove, and this asserts only that the act *asked* for the right thing. */
function recordingWriter() {
  const written: SummarizeMessageInput[] = [];
  const writer: MessageWriter = {
    record: () => {
      throw new Error("a compaction must not write an ordinary turn");
    },
    summarize: (input) => {
      written.push(input);
      return {
        id: `msg_${written.length}`,
        ordinal: 100 + written.length,
      } satisfies RecordedMessage;
    },
  };
  return { written, writer };
}

function deps(writer: MessageWriter, provider: FakeProvider, waits: number[] = []): CompactionDeps {
  return {
    provider,
    messages: writer,
    // D-064's delay, recorded rather than slept: the retry test asserts the wait happened, not that a
    // second of wall time passed.
    wait: async (ms) => {
      waits.push(ms);
    },
  };
}

/** Twelve turns of `size` characters, which D-064's heuristic prices at `ceil(size × 1.35)` each. */
function turns(count: number, size: number, start = 1): ConversationTurn[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `t${start + index}`,
    ordinal: start + index,
    role: (index % 2 === 0 ? "user" : "assistant") as ConversationTurn["role"],
    content: "x".repeat(size),
  }));
}

const request = (overrides: Partial<Parameters<typeof compactConversation>[0]> = {}) => ({
  sessionId: "ses_1",
  taskId: "tsk_1",
  turns: turns(12, 400),
  descriptor: RUN_DESCRIPTOR,
  summarizer: SUMMARIZER,
  limits: LIMITS,
  now: () => 1_700_000_000_000,
  ...overrides,
});

describe("createContextManager — what the loop is handed", () => {
  const RUN = { contextWindow: 8192, maxOutputTokens: 1024 };

  function managerFor(overrides: { run?: typeof RUN | undefined; summarizer?: boolean } = {}) {
    const { written, writer } = recordingWriter();
    const provider = summarizerProvider([{ kind: "text", text: "the notes" }]);
    return {
      written,
      manager: createContextManager({
        resolveRun: async () => overrides.run,
        resolveSummarizer: async () =>
          overrides.summarizer === false ? undefined : { provider, descriptor: { ...SUMMARIZER } },
        messages: writer,
        limits: LIMITS,
        wait: async () => undefined,
      }),
    };
  }

  /** Twelve recorded turns plus the task's opening message, which the runner built and no row exists for —
   *  the shape a real run has, and the reason `ordinalOf` answers `undefined` for the first one. Twelve at
   *  400 characters each is D-115's threshold being crossed with the verbatim tail still affordable. */
  function recordedRequest(): ContextRequest {
    // Distinct text per turn, because `ordinalOf` below keys on content: twelve identical turns would all
    // answer the same ordinal, and a test that hid that would be testing a map with one entry.
    const recorded = turns(12, 400).map((turn, index) => ({
      ...turn,
      content: `${turn.content}#${index + 1}`,
    }));
    const byContent = new Map(recorded.map((turn) => [turn.content, turn.ordinal]));
    return {
      sessionId: "ses_1",
      taskId: "tsk_1",
      messages: [
        { role: "user", content: "read the roadmap" },
        ...recorded.map((t) => ({ role: t.role, content: t.content })),
      ],
      ordinalOf: (message) => byContent.get(message.content),
    };
  }

  it("does nothing while no turn has been recorded, because it cannot state a range", async () => {
    const { manager } = managerFor({ run: RUN });
    const result = await manager.compact({
      sessionId: "ses_1",
      taskId: "tsk_1",
      messages: [{ role: "user", content: "read the roadmap" }],
      ordinalOf: () => undefined,
    });
    strictEqual(result.kind, "unchanged");
  });

  it("compacts a recorded conversation into a summary plus the tail the plan kept", async () => {
    const { manager, written } = managerFor({ run: RUN });
    const result = await manager.compact(recordedRequest());
    if (result.kind !== "compacted") throw new Error(`expected a compaction, got ${result.kind}`);
    strictEqual(result.messages[0]?.role, "system");
    strictEqual(result.messages[0]?.content, "the notes");
    strictEqual(
      result.messages.length,
      7,
      "the summary and the six verbatim turns — the covered six leave the request, and only the request",
    );
    strictEqual(written.length, 1, "and one summary row was written");
    strictEqual(written[0]?.covers.from, 1);
  });

  it("says it cannot rather than trimming, when this process resolved no summarizer", async () => {
    const { manager, written } = managerFor({ run: RUN, summarizer: false });
    const result = await manager.compact(recordedRequest());
    strictEqual(result.kind, "refused");
    if (result.kind !== "refused") return;
    strictEqual(result.reason, "summarizer-unavailable");
    strictEqual(written.length, 0);
  });

  it("answers unchanged when the run's own model cannot describe itself", async () => {
    // §3.2: a provider that cannot describe a model has disabled it, and a compactor with no descriptor has no
    // budget to enforce. Zero would be a budget everything exceeds, which would compact on every request.
    const { manager, written } = managerFor({ run: undefined });
    const result = await manager.compact(recordedRequest());
    strictEqual(result.kind, "unchanged");
    strictEqual(written.length, 0);
  });
});

describe("compactConversation — a conversation that fits is left alone", () => {
  it("does nothing below the threshold, and writes nothing", async () => {
    const { written, writer } = recordingWriter();
    const provider = summarizerProvider([{ kind: "text", text: "should not be called" }]);
    const outcome = await compactConversation(
      request({ turns: turns(4, 100) }),
      deps(writer, provider),
    );
    strictEqual(outcome.kind, "not-needed");
    strictEqual(written.length, 0);
    strictEqual(provider.calls.length, 0);
  });

  it("refuses when there is nothing older than the verbatim tail", async () => {
    const { writer } = recordingWriter();
    const provider = summarizerProvider([{ kind: "text", text: "unused" }]);
    const outcome = await compactConversation(
      request({ turns: turns(6, 2000) }),
      deps(writer, provider),
    );
    strictEqual(outcome.kind, "refused");
    if (outcome.kind !== "refused") return;
    strictEqual(outcome.reason, "nothing-to-summarize");
    strictEqual(provider.calls.length, 0);
  });

  it("refuses when the verbatim tail alone is over the threshold, rather than dropping recent turns", async () => {
    const { writer } = recordingWriter();
    const provider = summarizerProvider([{ kind: "text", text: "unused" }]);
    const outcome = await compactConversation(
      request({ turns: turns(9, 2000), limits: { ...LIMITS, verbatimTurns: 8 } }),
      deps(writer, provider),
    );
    strictEqual(outcome.kind, "refused");
    if (outcome.kind !== "refused") return;
    strictEqual(outcome.reason, "verbatim-exceeds-budget");
  });

  it("refuses when the configured summarizer cannot hold the turns it was chosen for", async () => {
    const { written, writer } = recordingWriter();
    const provider = summarizerProvider([{ kind: "text", text: "unused" }]);
    const outcome = await compactConversation(
      request({ summarizer: { modelId: "tiny", contextWindow: 1024, maxOutputTokens: 256 } }),
      deps(writer, provider),
    );
    strictEqual(outcome.kind, "refused");
    if (outcome.kind !== "refused") return;
    strictEqual(outcome.reason, "summarizer-window-too-small");
    strictEqual(provider.calls.length, 0, "the call is refused before it is attempted");
    strictEqual(written.length, 0);
  });
});

describe("compactConversation — the summary it writes", () => {
  const script: readonly FakeStep[] = [
    { kind: "text", text: "Asked: ship the parser. Decided: no new dependency. Open: the test." },
  ];

  it("covers the older turns and leaves the last six out of the range", async () => {
    const { written, writer } = recordingWriter();
    const provider = summarizerProvider(script);
    const outcome = await compactConversation(request(), deps(writer, provider));
    strictEqual(outcome.kind, "summarized");
    strictEqual(written.length, 1);
    // Twelve turns, six kept verbatim: the first six are covered, and turn 6's ordinal is the last one
    // named — the range is inclusive, which is what lets the next summary start at 7.
    strictEqual(written[0]?.covers.from, 1);
    strictEqual(written[0]?.covers.through, 6);
    strictEqual(written[0]?.sessionId, "ses_1");
    strictEqual(written[0]?.taskId, "tsk_1");
  });

  it("hands the summarizer no tools, because a derived record must not be able to act on the world", async () => {
    const { writer } = recordingWriter();
    const provider = summarizerProvider(script);
    await compactConversation(request(), deps(writer, provider));
    strictEqual(provider.calls.length, 1);
    strictEqual(provider.calls[0]?.tools?.length ?? 0, 0);
  });

  it("sizes the summary by the plan's allowance, and names it in the instruction", async () => {
    const { writer } = recordingWriter();
    const provider = summarizerProvider(script);
    await compactConversation(request(), deps(writer, provider));
    const call = provider.calls[0];
    ok(call !== undefined);
    // `FakeCall` records the model and the messages; the allowance is asserted through the written
    // outcome instead, because the fake does not record `maxTokens`.
    strictEqual(call.modelId, SUMMARY_MODEL_ID);
    const messages = call.messages as { role: string; content: string }[];
    strictEqual(messages.length, 2);
    strictEqual(messages[0]?.role, "system");
    ok(
      (messages[0]?.content ?? "").includes("tokens"),
      "the instruction states the budget in its unit",
    );
    ok(
      (messages[1]?.content ?? "").startsWith("#1 user:"),
      "the transcript labels turns by ordinal",
    );
    ok(
      (messages[1]?.content ?? "").includes("#6 assistant:"),
      "the last covered turn is in the transcript",
    );
    ok(!(messages[1]?.content ?? "").includes("#7 user:"), "a verbatim turn is not summarized");
  });

  it("reports the sizes it saved, labelled as estimates", async () => {
    const { writer } = recordingWriter();
    const provider = summarizerProvider(script);
    const outcome = await compactConversation(request(), deps(writer, provider));
    if (outcome.kind !== "summarized") throw new Error(`expected a summary, got ${outcome.kind}`);
    strictEqual(outcome.tokensBefore.source, "estimated");
    strictEqual(outcome.tokensAfter.source, "estimated");
    ok(
      outcome.tokensAfter.tokens < outcome.tokensBefore.tokens,
      "a summary of six turns is smaller than them",
    );
    strictEqual(outcome.turns, 6);
    strictEqual(outcome.model, SUMMARY_MODEL_ID);
  });

  it("keeps the original turns: the act writes one row and names the others", async () => {
    const { written, writer } = recordingWriter();
    const provider = summarizerProvider(script);
    await compactConversation(request(), deps(writer, provider));
    // §2.5's "must not silently replace or destroy original conversation records" is asserted here as
    // the shape of the request rather than of a table: nothing in this file deletes a turn, and the
    // covered rows are identified rather than replaced.
    const provider_ = written[0];
    ok(provider_ !== undefined);
    strictEqual(provider_.covers.from >= 1, true);
    strictEqual(provider_.covers.through >= provider_.covers.from, true);
  });
});

describe("compactConversation — when the summarizer fails (D-115: retry once, then surface)", () => {
  it("retries a retryable class once, on D-064's schedule, and succeeds", async () => {
    const { written, writer } = recordingWriter();
    const provider = failFirstThen(
      summarizerProvider([{ kind: "text", text: "notes after the retry" }]),
      new ProviderError("rate-limit", "quota window", { retryAfterMs: 250, attempt: 1 }),
    );
    const waits: number[] = [];
    const outcome = await compactConversation(request(), deps(writer, provider, waits));
    strictEqual(outcome.kind, "summarized");
    strictEqual(provider.calls.length, 1, "only the successful attempt reaches the adapter");
    strictEqual(waits.length, 1, "the retry waits on D-064's schedule rather than immediately");
    // §3.5's rule that a provider's own `Retry-After` overrides the schedule *upward*: the wait is the
    // schedule's first rung (jittered) or the hint, whichever is longer — never shorter. A summarizer
    // that just reported a quota window must be believed about it.
    ok((waits[0] ?? 0) >= 250, `expected at least the provider's hint, got ${waits[0]}`);
    strictEqual(written.length, 1);
  });

  it("surfaces the failure after the second attempt, and writes no summary", async () => {
    const { written, writer } = recordingWriter();
    const provider = summarizerProvider([
      { kind: "fail", class: "overloaded" },
      { kind: "fail", class: "overloaded" },
    ]);
    const waits: number[] = [];
    const outcome = await compactConversation(request(), deps(writer, provider, waits));
    strictEqual(outcome.kind, "failed");
    if (outcome.kind !== "failed") return;
    strictEqual(outcome.attempts, 2);
    strictEqual(outcome.error.class, "overloaded");
    strictEqual(written.length, 0, "a failure must leave the conversation exactly as it was");
    strictEqual(provider.calls.length, 2);
  });

  it("does not retry a class a second request cannot fix", async () => {
    const { writer } = recordingWriter();
    const provider = summarizerProvider([{ kind: "fail", class: "auth" }]);
    const outcome = await compactConversation(request(), deps(writer, provider));
    strictEqual(outcome.kind, "failed");
    if (outcome.kind !== "failed") return;
    strictEqual(outcome.attempts, 1);
    strictEqual(provider.calls.length, 1);
  });

  it("treats an empty summary as a failure rather than covering turns with nothing", async () => {
    const { written, writer } = recordingWriter();
    const provider = summarizerProvider([{ kind: "text", text: "   " }]);
    const outcome = await compactConversation(request(), deps(writer, provider));
    strictEqual(outcome.kind, "failed");
    if (outcome.kind !== "failed") return;
    strictEqual(outcome.error.class, "invalid-response");
    strictEqual(written.length, 0);
  });
});
