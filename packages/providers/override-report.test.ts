// §3.8's failure sentence: "`toolCalling` was declared by override and failed".
//
// This is the sentence the last two slices promised and did not build, and it is the one place where §3.8's override
// costs something: forcing a capability **on** is a trust decision, and a trust decision that is never checked is a lie
// the user believes. The tests below hold four things, and three of them are about *not* saying it:
//
//   1. It is said when it is true — a request that used a capability the user forced on, and the endpoint refused it.
//   2. It is not said for a transient failure. `overloaded` on a busy endpoint is no evidence about whether a declared
//      capability works, and a sentence that fires often enough to be ignored is worse than no sentence at all.
//   3. It is not said for a capability the user forced **off**, and not for one the request never used.
//   4. It changes the message and nothing else: the error class, the raw body and the attempt survive, because the ladder's
//      retry decision and the audit record must not depend on whether a human had edited a descriptor.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProviderRequest } from "./contract.ts";
import type { ModelDescriptor } from "./descriptor.ts";
import { createOpenAiCompatibleProvider } from "./openai.ts";

const DESCRIPTOR: ModelDescriptor = {
  contextWindow: 4096,
  maxOutputTokens: 1024,
  supports: {
    streaming: false,
    toolCalling: false,
    parallelToolCalls: false,
    systemRole: true,
    structuredOutput: false,
    imageInput: false,
    audioInput: false,
    reasoning: false,
    promptCaching: false,
    jsonSchemaValidation: false,
  },
  cancellation: "unsupported",
  rateLimits: null,
  cost: null,
  batching: null,
};

/** One that reports tool calling, so the forced-on value in the override is a *change* rather than a restatement. */
const REPORTING_TOOLS: ModelDescriptor = {
  ...DESCRIPTOR,
  supports: { ...DESCRIPTOR.supports, toolCalling: true },
};

function request(tools: boolean): ProviderRequest {
  return {
    modelId: "m",
    messages: [{ role: "user", content: "hello" }],
    ...(tools
      ? {
          tools: [
            { name: "file.read", description: "read a file", parameters: { type: "object" } },
          ],
        }
      : {}),
  };
}

function respond(status: number, body: string): typeof globalThis.fetch {
  return (async () =>
    new Response(body, {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof globalThis.fetch;
}

function provider(
  overrides: Parameters<typeof createOpenAiCompatibleProvider>[0]["overrides"],
  descriptor = REPORTING_TOOLS,
) {
  return createOpenAiCompatibleProvider({
    id: "local",
    config: { baseUrl: "http://127.0.0.1:8080/v1" },
    models: [{ id: "m", descriptor }],
    fetch: respond(400, '{"error":{"message":"tools are not supported by this model"}}'),
    ...(overrides === undefined ? {} : { overrides }),
  });
}

const ctx = {
  requestId: "r1",
  attempt: 1,
  signal: new AbortController().signal,
  deadlineMs: 30_000,
};

async function generateWith(
  overrides: Parameters<typeof createOpenAiCompatibleProvider>[0]["overrides"],
  tools: boolean,
  fetchImpl?: typeof globalThis.fetch,
) {
  const p =
    fetchImpl === undefined
      ? provider(overrides)
      : createOpenAiCompatibleProvider({
          id: "local",
          config: { baseUrl: "http://127.0.0.1:8080/v1" },
          models: [{ id: "m", descriptor: REPORTING_TOOLS }],
          fetch: fetchImpl,
          ...(overrides === undefined ? {} : { overrides }),
        });
  return p.generate(request(tools), ctx);
}

describe("§3.8's failure sentence", () => {
  it("is said when a forced-on capability is used and the endpoint refuses the call", async () => {
    const error = await generateWith(
      { m: { source: "manual", supports: { toolCalling: { from: false, to: true } } } },
      true,
    ).then(
      () => undefined,
      (e: Error) => e,
    );
    assert.ok(error !== undefined, "the call failed, which is the premise");
    assert.match(error.message, /declared by override and failed/);
    // The words §3.8 specifies, with the capability named rather than a pronoun, and the reported value quoted so the
    // user can see which of their two beliefs the endpoint contradicted.
    assert.match(error.message, /`toolCalling` was declared by override and failed/);
    assert.match(error.message, /the endpoint reported false/);
  });

  it("is absent when the same call fails with no override in force", async () => {
    const error = await generateWith(undefined, true).then(
      () => undefined,
      (e: Error) => e,
    );
    assert.ok(error !== undefined);
    // The failure is still reported — §3.8's rule is "report rather than fall back silently", and a fallback would be
    // the loop retrying without tools and pretending the endpoint had no tools to begin with.
    assert.ok(!/declared by override/.test(error.message), error.message);
  });

  it("is absent for a transient failure, because being busy is no evidence about a capability", async () => {
    const error = await generateWith(
      { m: { source: "manual", supports: { toolCalling: { from: false, to: true } } } },
      true,
      respond(503, '{"error":{"message":"overloaded"}}'),
    ).then(
      () => undefined,
      (e: Error) => e,
    );
    assert.ok(error !== undefined, "the call failed, which is the premise");
    const transient = error as Error & { class?: string };
    assert.equal(
      transient.class,
      "overloaded",
      "503 maps to the transient class, which is why the sentence is withheld",
    );
    assert.ok(!/declared by override/.test(error.message), error.message);
  });

  it("is absent for a capability the user forced off, which cannot break a call", async () => {
    // `systemRole` is used by every request here and was forced *off*. Nothing was sent that needed it, so attributing
    // a failure to that override would be blaming a decision for something it did not cause — and §3.8 says forcing off
    // is "always allowed and never argued about".
    const error = await generateWith(
      { m: { source: "manual", supports: { systemRole: { from: true, to: false } } } },
      true,
    ).then(
      () => undefined,
      (e: Error) => e,
    );
    assert.ok(error !== undefined);
    assert.ok(!/declared by override/.test(error.message), error.message);
  });

  it("is absent when the request never used the forced-on capability", async () => {
    // The override says tool calling is on; this call sends no tools. A sentence here would be the loudest kind of wrong:
    // it would tell the user their override is broken when the endpoint never saw it.
    const error = await generateWith(
      { m: { source: "manual", supports: { toolCalling: { from: false, to: true } } } },
      false,
    ).then(
      () => undefined,
      (e: Error) => e,
    );
    assert.ok(error !== undefined);
    assert.ok(!/declared by override/.test(error.message), error.message);
  });

  it("changes the message and nothing else: class, raw and attempt survive", async () => {
    const error = (await generateWith(
      { m: { source: "manual", supports: { toolCalling: { from: false, to: true } } } },
      true,
    ).then(
      () => undefined,
      (e: Error) => e,
    )) as Error & { class?: string; raw?: unknown; attempt?: number };
    assert.equal(
      error.class,
      "unsupported-capability",
      "the ladder's retry decision must not depend on a human edit",
    );
    assert.equal(error.attempt, 1);
    assert.equal(
      typeof error.raw,
      "string",
      "the endpoint's own words are still in the audit record (§3.5)",
    );
  });

  it("an override that restates the reported value is not provenance, so nothing is said about it", async () => {
    // Composition records provenance only for values that *moved* (D-126), so a record claiming `toolCalling: true` on a
    // descriptor that already said true produces no provenance entry — and there is nothing to blame.
    const error = await generateWith(
      { m: { source: "manual", supports: { streaming: { from: false, to: true } } } },
      true,
    ).then(
      () => undefined,
      (e: Error) => e,
    );
    assert.ok(error !== undefined);
    // `streaming` was forced on but `stream()` is not this call, so a refusal of the tool list says nothing about it.
    assert.ok(!/declared by override/.test(error.message), error.message);
  });
});
