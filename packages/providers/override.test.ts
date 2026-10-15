// §3.8's per-model capability override: the rules, as tests.
//
// What is being held here is not "an override can be stored" — that is the easy half and it would pass with a single
// `any`. It is the four rules the section states, each of which has a way to be implemented wrongly that a type cannot
// catch:
//
//   1. **Highest specificity wins** — the user's value is the effective one, and the reported value is still there to
//      compare against. A test that only checked "the override applied" would also pass for an implementation that threw
//      the reported descriptor away.
//   2. **Forcing a capability on carries provenance** — the effective descriptor has to say which values were declared
//      rather than reported, because §3.8 requires the runtime to report "`toolCalling` was declared by override and
//      failed" and a sentence cannot be assembled after the provenance is gone.
//   3. **A broken override fails closed** — an unparsable override, an unknown feature, and an override that makes the
//      descriptor illegal each refuse the *provider*, with the field named. The tempting implementation drops the bad
//      field and applies the rest, and these are the tests that say no.
//   4. **`"auto"` clears, and `false` is not `"auto"`** — "the user turned it off" and "the user never said" are
//      different facts, and a drift report that cannot tell them apart reports drift that is not there.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProviderEntryConfig } from "@crabby/core";
import { composeProviders } from "./compose.ts";
import { type ModelDescriptor, parseDescriptor } from "./descriptor.ts";
import { applyOverride, parseOverride } from "./override.ts";

const DESCRIPTOR = {
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
} as const;

function entry(overrides?: Record<string, unknown>): ProviderEntryConfig {
  return {
    baseUrl: "http://127.0.0.1:8080/v1",
    models: { "qwen2.5:3b": { ...DESCRIPTOR } },
    ...(overrides === undefined ? {} : { overrides }),
  };
}

/** The stored descriptor, parsed once by the parser that owns §3.2 — so these tests exercise a real descriptor rather
 *  than a hand-built object that happens to satisfy the type. A failure here is a fixture failure, not a product one, so
 *  it throws rather than asserting: every assertion below is about the override, not about the fixture. */
function reportedDescriptor(): ModelDescriptor {
  const parsed = parseDescriptor(DESCRIPTOR);
  if (!parsed.ok) throw new Error(`the fixture descriptor does not parse: ${parsed.reason}`);
  return parsed.descriptor;
}

function compose(overrides?: Record<string, unknown>) {
  const composed = composeProviders({ local: entry(overrides) });
  const first = composed[0];
  assert.ok(first !== undefined, "one entry composed or refused");
  return first;
}

describe("parseOverride", () => {
  it("accepts a minimal manual override", () => {
    const parsed = parseOverride({ source: "manual", supports: { streaming: true } });
    assert.equal(parsed.ok, true);
  });

  it("refuses an unknown field and names it", () => {
    const parsed = parseOverride({ source: "manual", supports: {}, streamin: true });
    assert.equal(parsed.ok, false);
    assert.match(parsed.ok ? "" : parsed.reason, /streamin/);
  });

  it("refuses `reserveForOutput` with the reason it is derived, not merely unknown", () => {
    // F-62: §3.8's table lists a field nothing reads, because D-064 derives the reserve from `maxOutputTokens`.
    const parsed = parseOverride({ source: "manual", limits: { reserveForOutput: 512 } });
    assert.equal(parsed.ok, false);
    assert.match(parsed.ok ? "" : parsed.reason, /maxOutputTokens/);
  });

  it("refuses a feature the data model does not have, rather than storing a flag nothing reads", () => {
    const parsed = parseOverride({ source: "manual", supports: { toolCallings: true } });
    assert.equal(parsed.ok, false);
    assert.match(parsed.ok ? "" : parsed.reason, /toolCallings/);
  });

  it("refuses a `source` it cannot account for", () => {
    // §3.8 lists `source: manual | preset` because "I typed it" and "a preset shipped it" are different trust
    // statements; a record that must be guessed into one of them is a record with no account of how it got there.
    const parsed = parseOverride({ supports: {} });
    assert.equal(parsed.ok, false);
    assert.match(parsed.ok ? "" : parsed.reason, /source/);
  });

  it("refuses a limit that is not a positive integer", () => {
    const parsed = parseOverride({ source: "manual", limits: { contextWindow: 4096.5 } });
    assert.equal(parsed.ok, false);
  });
});

describe("applyOverride", () => {
  const reported = reportedDescriptor();

  it("the user's value is the effective one, and the reported one is remembered", () => {
    const applied = applyOverride(reported, { source: "manual", supports: { toolCalling: true } });
    assert.equal(applied.ok, true);
    if (!applied.ok) return;
    assert.equal(applied.descriptor.supports.toolCalling, true);
    // The provenance is what makes "declared by override" sayable later, and `from` is the reported value — a test that
    // only asserted `to` would pass for an implementation that had thrown the reported value away.
    assert.deepEqual(applied.provenance.supports?.toolCalling, { from: false, to: true });
  });

  it("records no provenance for a value the user restated exactly", () => {
    // §3.8's `overridden` claim has to mean "a trust decision was made", not "a field exists". `systemRole` is already
    // true in the reported descriptor, so restating it decides nothing.
    const applied = applyOverride(reported, { source: "manual", supports: { systemRole: true } });
    assert.equal(applied.ok, true);
    if (!applied.ok) return;
    assert.equal(applied.provenance.supports?.systemRole, undefined);
  });

  it("`auto` clears an override and leaves the reported value standing", () => {
    const forced = applyOverride(reported, { source: "manual", supports: { streaming: true } });
    assert.equal(forced.ok, true);
    if (!forced.ok) return;
    assert.equal(forced.descriptor.supports.streaming, true);
    // Applied to the *reported* descriptor with `"auto"`: the reported value is in force and nothing is reported as
    // moved. That is the whole difference between `"auto"` and an absent key — `false` means "the user turned it off",
    // `"auto"` means "the user has no opinion", and a drift report cannot tell them apart if both mean the same thing.
    const cleared = applyOverride(reported, { source: "manual", supports: { streaming: "auto" } });
    assert.equal(cleared.ok, true);
    if (!cleared.ok) return;
    assert.equal(cleared.descriptor.supports.streaming, false);
    assert.equal(cleared.provenance.supports?.streaming, undefined);
  });

  it("raises a window and keeps the output cap legal", () => {
    const applied = applyOverride(reported, {
      source: "manual",
      limits: { contextWindow: 32768 },
    });
    assert.equal(applied.ok, true);
    if (!applied.ok) return;
    assert.equal(applied.descriptor.contextWindow, 32768);
    // Budgeting reads `maxOutputTokens` as the reserve (D-064), so an override of one and not the other has to still
    // satisfy the invariant the descriptor parser enforces.
    assert.ok(applied.descriptor.maxOutputTokens < applied.descriptor.contextWindow);
  });

  it("refuses an override that would make the descriptor illegal, and says which rule", () => {
    // `maxOutputTokens` fixed at 1024 with a window of 512 is a descriptor `parseDescriptor` rejects; applying an
    // override must not be the one path that produces one.
    const applied = applyOverride(reported, { source: "manual", limits: { contextWindow: 512 } });
    assert.equal(applied.ok, false);
    assert.match(applied.ok ? "" : applied.reason, /maxOutputTokens/);
  });
});

describe("composeProviders and §3.8", () => {
  it("composes with the override in force and names the model as overridden", async () => {
    const composed = compose({ "qwen2.5:3b": { source: "manual", supports: { streaming: true } } });
    assert.equal(composed.ok, true, composed.ok ? "" : composed.reason);
    if (!composed.ok) return;
    const overrides = composed.overrides;
    assert.deepEqual(Object.keys(overrides), ["qwen2.5:3b"]);
    assert.deepEqual(overrides["qwen2.5:3b"]?.supports?.streaming, { from: false, to: true });
    // The effective descriptor is what every later reader sees — one truth, not a stored opinion beside a reported value.
    const described = await composed.provider.describe();
    assert.equal(described["qwen2.5:3b"]?.supports.streaming, true);
  });

  it("names no overridden model when there is no override", () => {
    const composed = compose();
    assert.equal(composed.ok, true);
    if (!composed.ok) return;
    assert.deepEqual(Object.keys(composed.overrides), []);
  });

  it("refuses the entry when the override does not parse, rather than composing the reported values", () => {
    // This is the load-bearing fail-closed case: an implementation that logged the problem and composed anyway would
    // leave a user believing they had turned streaming on for a model that cannot stream.
    const composed = compose({ "qwen2.5:3b": { source: "manual", supports: { streamin: true } } });
    assert.equal(composed.ok, false);
    assert.match(composed.ok ? "" : composed.reason, /override/);
  });

  it("refuses the entry when the override would make the descriptor illegal", () => {
    const composed = compose({ "qwen2.5:3b": { source: "manual", limits: { contextWindow: 16 } } });
    assert.equal(composed.ok, false);
    assert.match(composed.ok ? "" : composed.reason, /contextWindow|maxOutputTokens/);
  });

  it("ignores an override for a model the entry does not declare", () => {
    // §3.8's overrides are keyed per model; an override naming a model that is not there is not a reason to disable the
    // models that are. The opposite choice — refusing — would let a typo in a map take down a working endpoint.
    const composed = compose({
      "not-declared": { source: "manual", supports: { streaming: true } },
    });
    assert.equal(composed.ok, true);
    if (!composed.ok) return;
    assert.deepEqual(Object.keys(composed.overrides), []);
  });
});
