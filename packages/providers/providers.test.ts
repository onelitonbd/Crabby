// The conformance suite, run against the reference adapter — and, just as importantly, run against six adapters that
// are each wrong in exactly one documented way. §7's requirement is not "a suite exists" but "an adapter that claims
// `toolCalling` without passing the tool-calling conformance test must fail CI" (§3.2), and a suite that never fails is
// how that sentence becomes decorative. So each broken adapter below asserts both that the run failed *and* which area
// caught it.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertNoPrivilegedFields,
  CONFORMANCE_AREAS,
  type ConformanceArea,
  type ConformanceFixture,
  classifyStatus,
  conformanceCases,
  describesModel,
  FAILURE_PROJECTION,
  FAKE_CONFIG,
  FAKE_MODEL_ID,
  FAKE_TOOL_MODEL_ID,
  FakeProvider,
  FORBIDDEN_RESPONSE_FIELDS,
  MAX_ATTEMPTS,
  type ModelDescriptor,
  PROVIDER_ERROR_CLASSES,
  PROVIDER_METHODS,
  type Provider,
  ProviderError,
  type ProviderErrorClass,
  parseDescriptor,
  REQUIRED_METHODS,
  RETRY_SCHEDULE_MS,
  retryDelayMs,
  runConformance,
  type StreamEvent,
  SUPPORTED_FEATURES,
  shouldRetry,
  translateProviderError,
  vanishedCapabilities,
  withOverrides,
  withoutMethod,
} from "./index.ts";

const ALL_MODES: readonly ProviderErrorClass[] = [...PROVIDER_ERROR_CLASSES];

function fakeFixture(
  options: ConstructorParameters<typeof FakeProvider>[0] = {},
): ConformanceFixture {
  return {
    create: () =>
      new FakeProvider({
        script: [{ kind: "text", text: "alpha beta gamma delta epsilon" }],
        ...options,
      }),
    validConfig: FAKE_CONFIG,
    modelId: FAKE_MODEL_ID,
    toolCapableModelId: FAKE_TOOL_MODEL_ID,
    failureModes: ALL_MODES,
    triggerFailure: (provider, errorClass) => {
      (provider as FakeProvider).setFailure(errorClass as ProviderErrorClass);
    },
  };
}

/** Which areas a run touched. A case id is `area/n`, so the id is the only thing needed — and a suite that reported
 *  an area with zero cases would show it here as an absent area, which is the failure worth catching. */
/** `parseDescriptor` returns a discriminated result; a test asserting on the rejection needs the reason without a
 *  cast through `never`, which typechecks as "no properties at all" and hides the message it was meant to show. */
function reason(result: ReturnType<typeof parseDescriptor>): string {
  return result.ok ? "<accepted>" : result.reason;
}

function areasOf(result: Awaited<ReturnType<typeof runConformance>>): ConformanceArea[] {
  const ids = [...result.passed, ...result.failed.map((entry) => entry.id)];
  return [...new Set(ids.map((id) => id.split("/")[0] as ConformanceArea))].sort();
}

describe("the §7 conformance suite", () => {
  it("covers exactly the five areas the document names, in order", () => {
    assert.deepEqual(
      [...CONFORMANCE_AREAS],
      [
        "capability-declaration",
        "streaming-terminal-states",
        "cancellation",
        "error-mapping",
        "invalid-config",
      ],
    );
    const fixture = fakeFixture();
    const areas = new Set(conformanceCases(fixture).map((testCase) => testCase.area));
    assert.deepEqual(
      [...areas].sort(),
      [...CONFORMANCE_AREAS].sort(),
      "every area needs at least one case",
    );
  });

  it("passes for the reference adapter, with every area green", async () => {
    const result = await runConformance(fakeFixture(), "mock/fake");
    assert.deepEqual(
      result.failed,
      [],
      `conformance failed: ${result.failed.map((entry) => `${entry.id} ${entry.title}: ${entry.error}`).join("\n")}`,
    );
    assert.deepEqual(areasOf(result).sort(), [...CONFORMANCE_AREAS].sort());
    assert.ok(result.passed.length >= 11, `the suite shrank to ${result.passed.length} cases`);
  });

  it("surfaces each of the ten §3.5 classes the fake can produce", async () => {
    const result = await runConformance(fakeFixture(), "mock/fake");
    const mapping = result.passed.filter((id) => id.startsWith("error-mapping/"));
    assert.equal(
      mapping.length,
      3,
      "the translator case, the taxonomy case, and the declared-modes case",
    );
    for (const errorClass of ALL_MODES) {
      const provider = new FakeProvider();
      provider.setFailure(errorClass);
      const events: StreamEvent[] = [];
      for await (const event of provider.stream(
        { modelId: FAKE_MODEL_ID, messages: [{ role: "user", content: "x" }] },
        { signal: new AbortController().signal, requestId: `probe_${errorClass}` },
      )) {
        events.push(event);
      }
      const terminal = events.at(-1);
      if (errorClass === "cancelled") {
        assert.equal(terminal?.type, "cancelled");
        continue;
      }
      assert.ok(terminal && terminal.type === "error", `${errorClass} ended as ${terminal?.type}`);
      assert.equal(
        terminal.error.class,
        errorClass,
        `${errorClass} projected through the translator as ${terminal.error.class}`,
      );
      assert.ok(
        terminal.error.message.length > 10,
        "a mapped error needs a message a user can read",
      );
    }
  });

  it("fails for an adapter that omits a required member", async () => {
    const broken = withoutMethod(new FakeProvider(), "generate") as Provider;
    const result = await runConformance(
      { ...fakeFixture(), create: () => broken },
      "missing-generate",
    );
    assert.ok(result.failed.length > 0, "a provider with no generate() must not pass");
    assert.ok(
      result.failed.some(
        (entry) => entry.id.startsWith("capability-declaration/") && /generate/.test(entry.error),
      ),
      `expected the required-member case to name generate(), got: ${result.failed.map((f) => f.error).join(" | ")}`,
    );
  });

  it("fails for an adapter that declares cancellation it cannot perform", async () => {
    const provider = new FakeProvider({ cancellation: "supported" });
    const broken = withoutMethod(provider, "cancel") as Provider;
    const result = await runConformance(
      { ...fakeFixture(), create: () => broken },
      "lying-about-cancel",
    );
    assert.ok(
      result.failed.some(
        (entry) => entry.id.startsWith("capability-declaration/") && /cancel\(\)/.test(entry.error),
      ),
      `expected the declaration case to catch it: ${result.failed.map((f) => f.error).join(" | ")}`,
    );
  });

  it("fails for an adapter whose stream ends without a terminal state", async () => {
    const silent = withOverrides(
      new FakeProvider({ script: [{ kind: "truncate", afterText: "half an answer" }] }),
      {
        // A stream that yields the deltas and stops: the adapter that forgets the terminal event, which is the shape a
        // consumer would read as "the model finished with those words".
        stream: (
          request: Parameters<Provider["stream"]>[0],
          ctx: Parameters<Provider["stream"]>[1],
        ) => ({
          [Symbol.asyncIterator]: () => {
            const inner = new FakeProvider({
              script: [{ kind: "truncate", afterText: "half an answer" }],
            }).stream(request, ctx);
            const iterator = inner[Symbol.asyncIterator]();
            return {
              async next() {
                const step = await iterator.next();
                return step.done
                  ? step
                  : step.value?.type === "done"
                    ? { value: undefined as never, done: true }
                    : step;
              },
              async return() {
                return { value: undefined as never, done: true as const };
              },
            };
          },
        }),
      },
    );
    const result = await runConformance(
      { ...fakeFixture(), create: () => silent },
      "truncating-stream",
    );
    assert.ok(
      result.failed.some((entry) => entry.id.startsWith("streaming-terminal-states/")),
      `a stream with no terminal event must fail the terminal-state case: ${result.failed.map((f) => f.error).join(" | ")}`,
    );
  });

  it("fails for an adapter that accepts its own unusable configuration", async () => {
    const lenient = withOverrides(new FakeProvider(), { validateConfig: () => ({ ok: true }) });
    const result = await runConformance(
      { ...fakeFixture(), create: () => lenient },
      "lenient-config",
    );
    assert.ok(
      result.failed.some(
        (entry) => entry.id.startsWith("invalid-config/") && /was accepted/.test(entry.error),
      ),
      `validateConfig that accepts everything must be caught: ${result.failed.map((f) => f.error).join(" | ")}`,
    );
  });

  it("fails for an adapter that accepts tools it never claimed to support", async () => {
    const source = new FakeProvider({ models: [FAKE_MODEL_ID] });
    // No refusal here: the adapter takes the tool list and ignores it, which is the exact "silent degradation" §3.2's
    // second contract rule forbids.
    const eager = withOverrides(source, {
      generate: (
        request: Parameters<Provider["generate"]>[0],
        ctx: Parameters<Provider["generate"]>[1],
      ) => {
        // `tools` dropped by destructuring rather than set to `undefined`: `exactOptionalPropertyTypes` makes the two
        // different, and an adapter that forwards `tools: undefined` is not the same as one that sends no tools.
        const { tools: ignored, ...rest } = request;
        void ignored;
        return source.generate(rest, ctx);
      },
    });
    const result = await runConformance(
      { ...fakeFixture(), create: () => eager },
      "accepts-unclaimed-tools",
    );
    assert.ok(
      result.failed.some((entry) => entry.id.startsWith("capability-declaration/")),
      `the toolCalling claim has to be verified: ${result.failed.map((f) => f.error).join(" | ")}`,
    );
  });

  it("fails for an adapter whose descriptor contains a field nobody defined", async () => {
    const descriptors = { ...new FakeProvider().describe() };
    const mutated = {
      [FAKE_MODEL_ID]: {
        ...(descriptors[FAKE_MODEL_ID] as ModelDescriptor),
        supports: { toolCallings: true },
      },
    } as unknown as Record<string, ModelDescriptor>;
    const typo = withOverrides(new FakeProvider({ models: [FAKE_MODEL_ID] }), {
      describe: () => mutated,
    });
    const result = await runConformance(
      { ...fakeFixture(), create: () => typo },
      "typo-descriptor",
    );
    assert.ok(
      result.failed.some(
        (entry) =>
          entry.id.startsWith("capability-declaration/") &&
          /toolCallings|unknown descriptor field/.test(entry.error),
      ),
      `a typo'd capability must disable the provider rather than default on: ${result.failed.map((f) => f.error).join(" | ")}`,
    );
  });
});

describe("the §3.2 descriptor", () => {
  const valid = {
    contextWindow: 4096,
    maxOutputTokens: 512,
    supports: Object.fromEntries(SUPPORTED_FEATURES.map((feature) => [feature, false])),
    cancellation: "best-effort",
    rateLimits: null,
    cost: "local",
    batching: null,
  };

  it("accepts a complete descriptor and reproduces it field for field", () => {
    const parsed = parseDescriptor(valid);
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.reason);
    if (!parsed.ok) return;
    assert.equal(parsed.descriptor.contextWindow, 4096);
    assert.equal(parsed.descriptor.cancellation, "best-effort");
    assert.equal(parsed.descriptor.cost, "local");
    assert.equal(parsed.descriptor.supports.streaming, false);
  });

  it("fails closed on a field it does not recognize, at both levels", () => {
    assert.match(
      reason(parseDescriptor({ ...valid, tool_choice: "auto" })),
      /unknown descriptor field/,
    );
    const nested = parseDescriptor({
      ...valid,
      supports: { ...valid.supports, toolCallings: true },
    });
    assert.equal(nested.ok, false, "a misspelled capability must not read as absent-and-harmless");
  });

  it("reads an undeclared feature as not claimed, never as assumed", () => {
    const parsed = parseDescriptor({ ...valid, supports: { streaming: true } });
    assert.ok(parsed.ok);
    if (!parsed.ok) return;
    assert.equal(parsed.descriptor.supports.streaming, true);
    assert.equal(parsed.descriptor.supports.toolCalling, false);
  });

  it("rejects limits that cannot both be true", () => {
    assert.match(
      reason(parseDescriptor({ ...valid, contextWindow: 100, maxOutputTokens: 100 })),
      /smaller than/,
    );
    assert.equal(parseDescriptor({ ...valid, contextWindow: 0 }).ok, false);
    assert.equal(parseDescriptor({ ...valid, cancellation: "sometimes" }).ok, false);
    assert.equal(parseDescriptor({ ...valid, cost: { promptPerMTok: "3" } }).ok, false);
    assert.equal(parseDescriptor("nope").ok, false);
  });

  it("names a capability that vanished between registration and now", () => {
    const before = parseDescriptor({
      ...valid,
      supports: { ...valid.supports, toolCalling: true, imageInput: true },
    });
    const after = parseDescriptor({ ...valid, supports: { ...valid.supports, toolCalling: true } });
    assert.ok(before.ok && after.ok);
    if (!before.ok || !after.ok) return;
    assert.deepEqual(
      [...vanishedCapabilities(before.descriptor, after.descriptor)],
      ["imageInput"],
    );
    assert.equal(describesModel({ [FAKE_MODEL_ID]: after.descriptor }, "unseen-model"), false);
    assert.equal(describesModel({ [FAKE_MODEL_ID]: after.descriptor }, FAKE_MODEL_ID), true);
  });
});

describe("the §3.5 taxonomy and D-064's schedule", () => {
  it("lists the ten classes the table has, with the contract rows beside them", () => {
    assert.equal(PROVIDER_ERROR_CLASSES.length, 10);
    assert.equal(
      PROVIDER_METHODS.length,
      8,
      "§3.1's member table is five required, two optional, plus id and validateConfig",
    );
    assert.deepEqual([...REQUIRED_METHODS].sort(), [
      "describe",
      "generate",
      "id",
      "listModels",
      "stream",
      "validateConfig",
    ]);
  });

  it("waits 1s, 2s, 4s, 8s, 16s with at most a quarter of drift", () => {
    assert.deepEqual([...RETRY_SCHEDULE_MS], [1000, 2000, 4000, 8000, 16000]);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const base = RETRY_SCHEDULE_MS[Math.min(attempt - 1, RETRY_SCHEDULE_MS.length - 1)] ?? 0;
      for (const seed of [0, 0.25, 0.5, 0.75, 0.999]) {
        const { ms, source } = retryDelayMs(attempt, undefined, () => seed);
        assert.equal(source, "schedule");
        assert.ok(
          ms <= base * 1.25 + 1 && ms >= base * 0.75 - 1,
          `attempt ${attempt} at seed ${seed} gave ${ms}, outside ±25% of ${base}`,
        );
      }
    }
    // The extremes of the generator are what a phone on a free tier would actually see.
    assert.equal(retryDelayMs(1, undefined, () => 0).ms, 750);
    assert.equal(retryDelayMs(1, undefined, () => 1).ms, 1250);
  });

  it("lets a provider hint push a wait up, and only up", () => {
    const longer = retryDelayMs(1, 30_000, () => 0.5);
    assert.deepEqual({ ...longer }, { ms: 30_000, source: "provider-hint" });
    const shorter = retryDelayMs(5, 10, () => 0.5);
    assert.equal(
      shorter.source,
      "schedule",
      "a suggestion below the schedule is not a license to hammer the endpoint",
    );
  });

  it("never retries a cancellation, and stops after the ladder", () => {
    assert.equal(shouldRetry(new ProviderError("cancelled", "cancelled"), 1), false);
    assert.equal(shouldRetry(new ProviderError("auth", "bad key"), 1), false);
    assert.equal(shouldRetry(new ProviderError("billing", "no credit"), 1), false);
    assert.equal(shouldRetry(new ProviderError("content-filter", "refused"), 1), false);
    assert.equal(shouldRetry(new ProviderError("overloaded", "503"), 1), true);
    assert.equal(
      shouldRetry(new ProviderError("overloaded", "503"), MAX_ATTEMPTS),
      false,
      "'yes, bounded' means bounded",
    );
    assert.equal(
      new ProviderError("context-overflow", "too big").retryable,
      false,
      "only after compaction is not a yes",
    );
    assert.equal(
      new ProviderError("invalid-response", "truncated").retryable,
      true,
      "'sometimes' retries once, and the bound is the ladder",
    );
  });

  it("classifies the shapes providers actually return", () => {
    assert.equal(classifyStatus(429, "slow down"), "rate-limit");
    assert.equal(classifyStatus(500), "overloaded");
    assert.equal(
      classifyStatus(400, "Requested 33000 tokens exceed the model maximum context length of 8192"),
      "context-overflow",
    );
    assert.equal(classifyStatus(404, "no such model"), "invalid-response");
    const translated = translateProviderError({
      status: 429,
      body: "quota",
      retryAfterMs: 4200,
      attempt: 2,
    });
    assert.equal(
      translated.retryAfterMs,
      4200,
      "the hint has to survive translation or the ladder loses it",
    );
    assert.equal(translated.attempt, 2);
    assert.match(translated.message, /429/);
    assert.equal(translateProviderError({ status: 401, body: "sk-abc123 invalid" }).class, "auth");
  });

  it("names the credential without showing it", () => {
    const error = translateProviderError({ status: 401, body: "api key sk-secret-value rejected" });
    assert.doesNotMatch(
      error.message,
      /sk-secret-value/,
      "§3.5: the message must name the credential, never show it",
    );
  });
});

describe("the fake adapter itself", () => {
  it("agrees between generate and stream on text, usage, and terminal reason", async () => {
    const provider = new FakeProvider({ script: [{ kind: "text", text: "one two three four" }] });
    const ctx = { signal: new AbortController().signal, requestId: "r1" };
    const request = {
      modelId: FAKE_MODEL_ID,
      messages: [{ role: "user" as const, content: "go" }],
    };
    const streamed: StreamEvent[] = [];
    for await (const event of provider.stream(request, ctx)) streamed.push(event);
    const generated = await provider.generate(request, ctx);
    assert.equal(
      generated.text,
      streamed
        .filter((e) => e.type === "delta")
        .map((e) => (e as { text: string }).text)
        .join(""),
    );
    const done = streamed.at(-1);
    assert.ok(done && done.type === "done");
    assert.deepEqual(generated.usage, done.usage);
    assert.equal(done.finishReason, "done");
    assert.equal(
      generated.finishReason,
      done.finishReason,
      "the same answer, whichever method asked for it",
    );
  });

  it("reports a truncated stream to generate as invalid-response, not as an empty answer", async () => {
    const provider = new FakeProvider({
      script: [{ kind: "truncate", afterText: "half an answer" }],
    });
    const ctx = { signal: new AbortController().signal, requestId: "r2" };
    await assert.rejects(
      () => provider.generate({ modelId: FAKE_MODEL_ID, messages: [] }, ctx),
      (error: unknown) => (error as ProviderError).class === "invalid-response",
    );
    const events: StreamEvent[] = [];
    for await (const event of provider.stream(
      { modelId: FAKE_MODEL_ID, messages: [] },
      { ...ctx, requestId: "r3" },
    )) {
      events.push(event);
    }
    const last = events.at(-1);
    assert.ok(
      last !== undefined && !["done", "error", "cancelled"].includes(last.type),
      "a truncated stream ends mid-sentence, with no terminal event — which is the shape generate() must refuse",
    );
  });

  it("honors both abort routes and records them", async () => {
    const bySignal = new FakeProvider({ script: [{ kind: "hang", afterText: "waited" }] });
    const controller = new AbortController();
    const pending = bySignal.generate(
      { modelId: FAKE_MODEL_ID, messages: [] },
      { signal: controller.signal, requestId: "r4" },
    );
    controller.abort();
    await assert.rejects(
      pending,
      (error: unknown) => (error as ProviderError).class === "cancelled",
    );
    assert.equal(
      bySignal.calls[0]?.aborted,
      true,
      "the call log must show the abort reached the adapter",
    );

    const byMethod = new FakeProvider({ script: [{ kind: "hang" }] });
    const ctx = { signal: new AbortController().signal, requestId: "r5" };
    const running = byMethod.generate({ modelId: FAKE_MODEL_ID, messages: [] }, ctx);
    await byMethod.cancel({ requestId: "r5" });
    await assert.rejects(
      running,
      (error: unknown) => (error as ProviderError).class === "cancelled",
    );
    assert.deepEqual(byMethod.cancellations, ["r5"]);
  });

  it("refuses a model it does not declare and tools a model did not claim", async () => {
    const provider = new FakeProvider();
    const ctx = { signal: new AbortController().signal, requestId: "r6" };
    await assert.rejects(
      () => provider.generate({ modelId: "not-a-model", messages: [] }, ctx),
      (error: unknown) => (error as ProviderError).class === "unsupported-capability",
    );
    await assert.rejects(
      () =>
        provider.generate(
          {
            modelId: FAKE_MODEL_ID,
            messages: [],
            tools: [{ name: "file.read", description: "x", parameters: {} }],
          },
          ctx,
        ),
      (error: unknown) => {
        const typed = error as ProviderError;
        assert.equal(typed.class, "unsupported-capability");
        assert.match(typed.message, /does not declare toolCalling/);
        return true;
      },
    );
    const withTools = await provider.generate(
      {
        modelId: FAKE_TOOL_MODEL_ID,
        messages: [],
        tools: [{ name: "file.read", description: "x", parameters: {} }],
      },
      ctx,
    );
    assert.deepEqual([...(withTools.toolCalls ?? [])], []);
  });

  it("projects each failure mode through the shared translator", () => {
    assert.deepEqual(Object.keys(FAILURE_PROJECTION).sort(), [...ALL_MODES].sort());
    for (const errorClass of ALL_MODES) {
      if (errorClass === "cancelled") continue;
      const projection = FAILURE_PROJECTION[errorClass];
      const translated = translateProviderError({ ...projection });
      assert.equal(
        translated.class,
        errorClass,
        `${errorClass}'s projection must classify back to ${errorClass}`,
      );
    }
  });

  it("keeps a completion from carrying privileged fields", () => {
    assert.ok(
      assertNoPrivilegedFields({ text: "hi", usage: { inputTokens: 1, outputTokens: 1 } }).ok,
    );
    for (const field of FORBIDDEN_RESPONSE_FIELDS) {
      const result = assertNoPrivilegedFields({ [field]: true });
      assert.equal(result.ok, false, `'${field}' must not be accepted from a provider`);
    }
  });

  it("records what it was asked, so a test can assert the request and not just the reply", async () => {
    const provider = new FakeProvider({ script: [{ kind: "text", text: "ok" }] });
    await provider.generate(
      { modelId: FAKE_MODEL_ID, messages: [{ role: "user", content: "hello" }] },
      { signal: new AbortController().signal, requestId: "r7", attempt: 3, taskId: "task_9" },
    );
    const call = provider.calls[0];
    assert.equal(call?.requestId, "r7");
    assert.equal(call?.attempt, 3);
    assert.equal(call?.modelId, FAKE_MODEL_ID);
    assert.equal(call?.aborted, false);
    assert.equal(
      provider.calls.length,
      1,
      "one generate, one record — a retry is a second call, visibly",
    );
  });
});
