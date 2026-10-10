// The provider conformance suite §7 requires: "one shared test set every adapter must pass — capability declaration
// accuracy, streaming terminal states, cancellation semantics, error mapping for each §3.5 class, and correct
// rejection of invalid config". Those five areas are `CONFORMANCE_AREAS` below, in that order, and the list is checked
// against the sentence by `scripts/parity.ts` so neither side can quietly grow or shrink.
//
// Why it is a function returning cases instead of a test file: an adapter that never runs the suite has no
// conformance. `mock/fake` is the reference (`PROVIDERS_AND_TOOLS.md` §7) and `providers.test.ts` runs the suite
// against it; when `openai-compatible` and `ollama` land in M2 they call the same function from their own test files.
// A case is a name plus an async function that throws on failure, because that shape is portable to `node:test`
// (`it()` per case), to a CI job that prints a table, and to a Termux run — and the third of those is the platform
// the suite exists for (`SECURITY.md` §17: "works on CI Linux" is not the target).
//
// No case here reaches a network or a live endpoint. §7 is blunt about it: "all core and security tests run against
// the fake provider; a separate opt-in suite may hit real endpoints and must never be required for a green build."

import assert from "node:assert/strict";
import type { Provider, ProviderConfig, ProviderRequest } from "./contract.ts";
import { assertNoPrivilegedFields, PROVIDER_METHODS, REQUIRED_METHODS } from "./contract.ts";
import { parseDescriptor, SUPPORTED_FEATURES } from "./descriptor.ts";
import { PROVIDER_ERROR_CLASSES, RETRYABILITY, translateProviderError } from "./errors.ts";

export const CONFORMANCE_AREAS = [
  "capability-declaration",
  "streaming-terminal-states",
  "cancellation",
  "error-mapping",
  "invalid-config",
] as const;
export type ConformanceArea = (typeof CONFORMANCE_AREAS)[number];

export interface ConformanceCase {
  readonly id: string;
  readonly area: ConformanceArea;
  readonly title: string;
  run: () => Promise<void>;
}

export interface ConformanceFixture {
  /** The adapter under test, built fresh per case so a case cannot inherit another's abort state. */
  create(): Provider | Promise<Provider>;
  /** A configuration the suite may send that the adapter must accept. */
  validConfig: ProviderConfig;
  /** A model the descriptor set is expected to contain, and one it must reject tools for if it does not claim
   *  `toolCalling`. */
  modelId: string;
  /** A model chosen to exercise whatever behavior the suite needs twice for; defaults to `modelId`. */
  toolCapableModelId?: string;
  /** Which §3.5 classes this adapter's test mode can actually produce. An adapter declares them, the suite then
   *  requires each declared mode to be observed, and a mode listed but never produced is a failure — the alternative
   *  is a fixture that claims coverage it does not have. */
  failureModes?: readonly string[];
  /** Force the adapter into one of its declared failure modes. Required when `failureModes` is non-empty. */
  triggerFailure?: (provider: Provider, errorClass: string) => Promise<void> | void;
  request?: Partial<ProviderRequest>;
}

let requestCounter = 0;
function context(signal: AbortSignal, attempt = 1) {
  requestCounter += 1;
  return { signal, requestId: `conf_${requestCounter}`, attempt, taskId: "task_conf" };
}

function requestFor(
  fixture: ConformanceFixture,
  modelId: string,
  extra: Partial<ProviderRequest> = {},
): ProviderRequest {
  return {
    modelId,
    messages: [{ role: "user", content: "conformance" }],
    ...fixture.request,
    ...extra,
  };
}

/** The five areas, as cases bound to one fixture. */
export function conformanceCases(fixture: ConformanceFixture): ConformanceCase[] {
  const provider = async () => fixture.create() as Provider;
  const cases: ConformanceCase[] = [];
  const add = (area: ConformanceArea, title: string, run: () => Promise<void>) =>
    cases.push({ id: `${area}/${cases.length + 1}`, area, title, run });

  // ---- capability declaration accuracy (§7's first area)
  add("capability-declaration", "every required member of §3.1 exists", async () => {
    const adapter = await provider();
    for (const member of REQUIRED_METHODS) {
      const value = (adapter as unknown as Record<string, unknown>)[member];
      assert.ok(
        member === "id" ? typeof value === "string" && value !== "" : typeof value === "function",
        `${member} is required by §3.1`,
      );
    }
    for (const spec of PROVIDER_METHODS) {
      assert.ok(
        spec.contract.length > 10,
        `${spec.member}'s contract sentence went missing from the table`,
      );
    }
  });

  add(
    "capability-declaration",
    "every descriptor parses under §3.2's fail-closed rules",
    async () => {
      const adapter = await provider();
      const descriptors = await adapter.describe();
      const models = await adapter.listModels();
      assert.ok(Object.keys(descriptors).length > 0, "describe() must declare at least one model");
      for (const modelId of models) {
        const declared = descriptors[modelId];
        assert.ok(
          declared,
          `'${modelId}' is listed by listModels() with no descriptor, so its limits are unknowable`,
        );
        const parsed = parseDescriptor(declared);
        assert.ok(parsed.ok, `'${modelId}': ${parsed.ok ? "" : parsed.reason}`);
      }
      for (const [modelId, descriptor] of Object.entries(descriptors)) {
        assert.ok(models.includes(modelId), `'${modelId}' has a descriptor but is not listed`);
        for (const feature of SUPPORTED_FEATURES) {
          assert.equal(
            typeof descriptor.supports?.[feature],
            "boolean",
            `${modelId}.supports.${feature} must be declared`,
          );
        }
      }
    },
  );

  add(
    "capability-declaration",
    "a declared cancellation mode has the method behind it",
    async () => {
      const adapter = await provider();
      const descriptors = await adapter.describe();
      for (const [modelId, descriptor] of Object.entries(descriptors)) {
        if (descriptor.cancellation === "supported" || descriptor.cancellation === "best-effort") {
          assert.equal(
            typeof adapter.cancel,
            "function",
            `'${modelId}' declares cancellation '${descriptor.cancellation}' without implementing cancel(); §3.1's rule is that the declaration carries the semantics, so the runtime would be waiting for a request it was told could be stopped`,
          );
        }
      }
    },
  );

  add("capability-declaration", "tools are refused when toolCalling is not declared", async () => {
    const adapter = await provider();
    const descriptors = await adapter.describe();
    const entry = Object.entries(descriptors).find(
      ([, descriptor]) => !descriptor.supports.toolCalling,
    );
    if (!entry) return; // An adapter whose whole catalogue calls tools has nothing to check here, by definition.
    const [modelId] = entry;
    await assert.rejects(
      () =>
        adapter.generate(
          requestFor(fixture, modelId, {
            tools: [{ name: "file.read", description: "read", parameters: {} }],
          }),
          context(new AbortController().signal),
        ),
      (error: unknown) => {
        assert.ok(error instanceof Error, "a refusal must be an Error");
        const providerError = error as { class?: string };
        assert.equal(
          providerError.class,
          "unsupported-capability",
          "§3.1: presence of a method is not enough; an undeclared capability has to be refused, not accepted and mangled",
        );
        return true;
      },
    );
  });

  add("capability-declaration", "a completion cannot carry a privileged field", async () => {
    const adapter = await provider();
    const result = await adapter.generate(
      requestFor(fixture, fixture.toolCapableModelId ?? fixture.modelId),
      context(new AbortController().signal),
    );
    assert.equal(typeof result.text, "string");
    assert.equal(typeof result.usage?.inputTokens, "number");
    assert.ok(
      Array.isArray(result.toolCalls),
      "a completion without tool calls reports an empty list, not undefined",
    );
    // §3.1's third rule, checked on the shape the adapter returns: a provider that could widen a task's permissions
    // through its response would not need a bug in Crabby to do it.
    assert.ok(
      assertNoPrivilegedFields(result as unknown as Record<string, unknown>).ok,
      "a result must not carry permissions",
    );
  });

  // ---- streaming terminal states
  add("streaming-terminal-states", "a stream ends in exactly one terminal event", async () => {
    const adapter = await provider();
    const events = [];
    for await (const event of adapter.stream(
      requestFor(fixture, fixture.modelId),
      context(new AbortController().signal),
    )) {
      events.push(event);
    }
    assert.ok(
      events.length > 0,
      "a stream with no events at all is indistinguishable from a provider that never answered",
    );
    const terminal = events.at(-1);
    assert.ok(
      terminal && ["done", "error", "cancelled"].includes(terminal.type),
      `the last event was '${terminal?.type}', and §3.1 names done, error, and cancelled as the terminal states`,
    );
    assert.equal(
      events.filter((event) => ["done", "error", "cancelled"].includes(event.type)).length,
      1,
      "two terminal events would let a consumer read a truncated answer as finished",
    );
    for (const event of events.slice(0, -1)) {
      assert.ok(
        ["delta", "tool-call"].includes(event.type),
        `a non-terminal event cannot be '${event.type}'`,
      );
    }
  });

  add(
    "streaming-terminal-states",
    "stream and generate agree about the terminal state",
    async () => {
      const adapter = await provider();
      const events = [];
      for await (const event of adapter.stream(
        requestFor(fixture, fixture.modelId),
        context(new AbortController().signal),
      )) {
        events.push(event);
      }
      const streamedText = events
        .filter((event) => event.type === "delta")
        .map((event) => event.text)
        .join("");
      const result = await adapter.generate(
        requestFor(fixture, fixture.modelId),
        context(new AbortController().signal),
      );
      assert.equal(
        result.text,
        streamedText,
        "§3.1: stream MUST surface the same terminal states as generate",
      );
      const done = events.at(-1);
      assert.ok(done && done.type === "done");
      assert.deepEqual(
        result.usage,
        done.usage,
        "usage reported twice must be the same number twice",
      );
    },
  );

  // ---- cancellation semantics
  add("cancellation", "ctx.signal is honored mid-request", async () => {
    const adapter = await provider();
    const controller = new AbortController();
    const events = [];
    for await (const event of adapter.stream(
      requestFor(fixture, fixture.modelId),
      context(controller.signal),
    )) {
      events.push(event);
      if (event.type === "delta") controller.abort();
    }
    const terminal = events.at(-1);
    assert.equal(
      terminal?.type,
      "cancelled",
      "an abort during a stream must end it as cancelled, not as done",
    );
  });

  add("cancellation", "generate rejects a cancelled request with the cancelled class", async () => {
    const adapter = await provider();
    const controller = new AbortController();
    const pending = adapter.generate(
      requestFor(fixture, fixture.modelId),
      context(controller.signal),
    );
    controller.abort();
    await assert.rejects(pending, (error: unknown) => {
      assert.equal((error as { class?: string }).class, "cancelled");
      return true;
    });
  });

  add(
    "cancellation",
    "cancel() reaches an in-flight request when the adapter implements it",
    async () => {
      const adapter = await provider();
      if (typeof adapter.cancel !== "function") return;
      const controller = new AbortController();
      const ctx = context(controller.signal);
      const pending = adapter.generate(requestFor(fixture, fixture.modelId), ctx);
      await adapter.cancel({ requestId: ctx.requestId });
      await assert.rejects(pending, (error: unknown) => {
        assert.equal(
          (error as { class?: string }).class,
          "cancelled",
          "an adapter-side abort is still a cancellation",
        );
        return true;
      });
    },
  );

  // ---- error mapping for each §3.5 class
  add("error-mapping", "the shared translator covers all ten classes", async () => {
    const expectations: readonly {
      readonly status?: number;
      readonly body?: string;
      readonly expected: string;
    }[] = [
      { status: 401, expected: "auth" },
      { status: 403, expected: "auth" },
      { status: 402, expected: "billing" },
      { status: 429, body: "slow down", expected: "rate-limit" },
      { status: 503, expected: "overloaded" },
      { status: 408, expected: "timeout" },
      {
        status: 400,
        body: "This value exceeds the model maximum context length",
        expected: "context-overflow",
      },
      {
        status: 400,
        body: "your input was flagged by the content filter",
        expected: "content-filter",
      },
      {
        status: 400,
        body: "this endpoint does not support response_format",
        expected: "unsupported-capability",
      },
      { body: "<html>not json</html>", expected: "invalid-response" },
    ];
    for (const expectation of expectations) {
      const error = translateProviderError({
        ...(expectation.status === undefined ? {} : { status: expectation.status }),
        ...(expectation.body === undefined ? {} : { body: expectation.body }),
      });
      assert.equal(
        error.class,
        expectation.expected,
        `HTTP ${expectation.status ?? "-"} must map to ${expectation.expected}`,
      );
    }
    assert.equal(translateProviderError({ aborted: true }).class, "cancelled");
    assert.equal(translateProviderError({ deadline: "first-token" }).class, "timeout");
    for (const errorClass of PROVIDER_ERROR_CLASSES) {
      assert.ok(
        typeof RETRYABILITY[errorClass] === "boolean" ||
          RETRYABILITY[errorClass] === "after" ||
          RETRYABILITY[errorClass] === "sometimes",
        `${errorClass} has no retryability`,
      );
    }
    assert.equal(
      RETRYABILITY.cancelled,
      false,
      "cancelled is terminal, 'not an error worth retrying'",
    );
  });

  add("error-mapping", "an adapter throws only taxonomy members", async () => {
    const adapter = await provider();
    await assert.rejects(
      () =>
        adapter.generate(
          requestFor(fixture, "conf-model-that-does-not-exist"),
          context(new AbortController().signal),
        ),
      (error: unknown) => {
        assert.ok(error instanceof Error, "a rejection must be an Error");
        const providerError = error as { class?: string };
        assert.ok(
          providerError.class !== undefined &&
            (PROVIDER_ERROR_CLASSES as readonly string[]).includes(providerError.class),
          `'${providerError.class ?? error?.constructor?.name}' is not a §3.5 class; raw provider errors may not reach the runtime`,
        );
        return true;
      },
    );
  });

  const modes = fixture.failureModes ?? [];
  if (modes.length > 0) {
    add("error-mapping", "each declared failure mode surfaces with its class", async () => {
      for (const errorClass of modes) {
        const adapter = await provider();
        assert.ok(
          (PROVIDER_ERROR_CLASSES as readonly string[]).includes(errorClass),
          `'${errorClass}' is not a §3.5 class, so it may not be declared as a failure mode`,
        );
        assert.ok(
          fixture.triggerFailure,
          "failureModes without triggerFailure is a declaration with no mechanism",
        );
        await fixture.triggerFailure?.(adapter, errorClass);
        const outcome = await adapter
          .generate(requestFor(fixture, fixture.modelId), context(new AbortController().signal))
          .then(
            () => undefined,
            (error: unknown) => error as { class?: string },
          );
        assert.equal(
          outcome?.class,
          errorClass,
          `the ${errorClass} mode surfaced as '${outcome?.class}'`,
        );
      }
    });
  }

  // ---- correct rejection of invalid config
  add("invalid-config", "the valid configuration is accepted", async () => {
    const adapter = await provider();
    const result = adapter.validateConfig(fixture.validConfig);
    assert.equal(
      result.ok,
      true,
      `the fixture's own config was rejected: ${result.ok ? "" : result.reason}`,
    );
  });

  add(
    "invalid-config",
    "unusable configurations are rejected with an actionable reason",
    async () => {
      const adapter = await provider();
      const unusable: readonly { title: string; config: ProviderConfig; mentions: RegExp }[] = [
        {
          title: "an empty baseUrl has no endpoint to call",
          config: { baseUrl: "" },
          mentions: /baseUrl/,
        },
        {
          title: "'not a url' is not a URL",
          config: { baseUrl: "not a url" },
          mentions: /baseUrl|URL/i,
        },
        {
          title: "an ftp endpoint is not a provider API",
          config: { baseUrl: "ftp://example.invalid/x" },
          mentions: /http/i,
        },
        {
          title: "a non-string key cannot be sent as a header",
          config: { baseUrl: "https://x.invalid/v1", apiKey: 42 } as unknown as ProviderConfig,
          mentions: /apiKey/,
        },
        {
          title: "an unknown field means the user set something the adapter ignores",
          config: { baseUrl: "https://x.invalid/v1", model: "gpt" } as unknown as ProviderConfig,
          mentions: /model/,
        },
      ];
      for (const entry of unusable) {
        let result: ReturnType<Provider["validateConfig"]> | undefined;
        try {
          result = adapter.validateConfig(entry.config);
        } catch (error) {
          assert.fail(
            `${entry.title}: validateConfig threw (${(error as Error).message}) instead of returning a reason`,
          );
        }
        assert.equal(result?.ok, false, `${entry.title} was accepted`);
        if (result === undefined || result.ok) continue;
        assert.ok(
          result.reason.length > 10,
          `${entry.title}: §3.1 requires an actionable reason, not a shrug`,
        );
        assert.match(
          result.reason,
          entry.mentions,
          `the reason for "${entry.title}" has to name the field at fault`,
        );
      }
    },
  );

  return cases;
}

export interface ConformanceResult {
  readonly adapter: string;
  readonly passed: readonly string[];
  readonly failed: readonly {
    readonly id: string;
    readonly title: string;
    readonly error: string;
  }[];
  readonly byArea: Readonly<
    Record<ConformanceArea, { readonly passed: number; readonly failed: number }>
  >;
}

/** Run every case. Throwing is the *adapter's* failure and this function reports it, because the caller is a test
 *  runner or a CI step that has to say which adapter and which area broke, not a stack trace ending in a loop. */
export async function runConformance(
  fixture: ConformanceFixture,
  adapterName: string,
): Promise<ConformanceResult> {
  const passed: string[] = [];
  const failed: { id: string; title: string; error: string }[] = [];
  const byArea = Object.fromEntries(
    CONFORMANCE_AREAS.map((area) => [area, { passed: 0, failed: 0 }]),
  ) as Record<ConformanceArea, { passed: number; failed: number }>;
  for (const testCase of conformanceCases(fixture)) {
    try {
      await testCase.run();
      passed.push(testCase.id);
      byArea[testCase.area].passed += 1;
    } catch (error) {
      failed.push({ id: testCase.id, title: testCase.title, error: (error as Error).message });
      byArea[testCase.area].failed += 1;
    }
  }
  return { adapter: adapterName, passed, failed, byArea };
}
