// Composition's refusals are the point of this file, and each one is a sentence from a document rather than a
// preference. What has to hold is not "a bad entry fails" but *which* entries fail and why: a keyless endpoint on this
// device is the supported path (D-066, O-034), a keyed one is a subsystem that does not exist yet (F-56), and `mock` is
// a test instrument that must never become a way to make a task look finished (SECURITY.md §17). A composition that
// accepted the second and third would pass a "does it build a provider" test and fail the product.
//
// This file runs under `npm run test:security` as well as `test:unit`, because "an inline key is refused before it can
// be written down" is a security property and not a convenience.
import assert from "node:assert/strict";
import { test } from "node:test";
import { validate } from "@crabby/api-contracts";
import type { ConfigFile, ProviderEntryConfig } from "@crabby/core";
import { ConfigFile as ConfigFileSchema } from "@crabby/core";
import {
  composeAskCandidates,
  composeProviders,
  deadlinesFrom,
  selectDefaultModel,
  selectPinnedModel,
} from "./compose.ts";
import type { ModelDescriptor } from "./descriptor.ts";
import { FakeProvider } from "./fake.ts";

const LOCAL = "http://127.0.0.1:8080/v1";

function supports(over: Partial<Record<string, boolean>> = {}): Record<string, boolean> {
  return {
    streaming: true,
    toolCalling: true,
    parallelToolCalls: false,
    systemRole: true,
    structuredOutput: false,
    imageInput: false,
    audioInput: false,
    reasoning: false,
    promptCaching: false,
    jsonSchemaValidation: false,
    ...over,
  };
}

/** A §3.2 descriptor for a model on the user's own machine: local cost, no rate limits, best-effort cancellation. */
function descriptor(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contextWindow: 4096,
    maxOutputTokens: 512,
    supports: supports(),
    cancellation: "best-effort",
    rateLimits: null,
    cost: "local",
    batching: null,
    ...over,
  };
}

/** The same shape, typed for `FakeProvider`'s `descriptors` option — a §3.2 `ModelDescriptor` rather than the JSON an
 *  `entry` carries, because the fixture parses config itself and this one is handed what it should already believe. */
function model(over: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return {
    contextWindow: 4096,
    maxOutputTokens: 512,
    supports: supports() as ModelDescriptor["supports"],
    cancellation: "best-effort",
    rateLimits: null,
    cost: "local",
    batching: null,
    ...over,
  };
}

function entry(over: Partial<ProviderEntryConfig> = {}): ProviderEntryConfig {
  return { baseUrl: LOCAL, models: { "qwen2.5:3b": descriptor() }, ...over };
}

function composed(entries: Record<string, ProviderEntryConfig>) {
  return composeProviders(entries);
}

test("compose: a keyless endpoint becomes an adapter, and the adapter is the entry", async () => {
  const [result] = composed({ local: entry() });
  assert.equal(result?.ok, true, result && !result.ok ? result.reason : "must compose");
  if (!result?.ok) return;
  assert.equal(
    result.provider.id,
    "local",
    "the config key is the adapter's id, so a screen can name it",
  );
  assert.deepEqual(result.modelIds, ["qwen2.5:3b"]);
  assert.deepEqual(await result.provider.listModels(), ["qwen2.5:3b"]);
  const described = await result.provider.describe();
  assert.equal(
    described["qwen2.5:3b"]?.contextWindow,
    4096,
    "§3.2's descriptor survives composition",
  );
  assert.deepEqual(result.warnings, []);
});

test("compose: no provider entry is not an error, it is an install that has not chosen one", () => {
  assert.deepEqual(composeProviders(undefined), []);
  assert.deepEqual(composed({}), []);
});

test("compose: a view resolves no references, and a handed resolver decides the keyed entry (F-56 closed)", () => {
  const [result] = composed({
    groq: entry({ baseUrl: "https://api.groq.com/openai/v1", key: "vault://groq" }),
  });
  assert.equal(result?.ok, false);
  if (result?.ok) return;
  assert.match(result.reason, /vault/, result.reason);
  assert.match(
    result.reason,
    /vault status/,
    "the refusal names where the state question is answered, not a milestone — the vault exists now",
  );
  // A resolver present and answering: the keyed entry composes with the value, and the value appears in
  // neither the composition result nor any refusal.
  const [resolved] = composeProviders(
    { groq: entry({ baseUrl: "https://api.groq.com/openai/v1", key: "vault://groq" }) },
    undefined,
    (reference) => {
      assert.equal(reference, "vault://groq", "the resolver sees the reference, not the field");
      return { ok: true, secret: "gsk_resolved_secret" };
    },
  );
  assert.equal(resolved?.ok, true, "the resolver's yes composes the entry");
  // A resolver present and refusing: the refusal is the resolver's own reason, so the vault state — locked,
  // missing name — is what the user reads, not a composition opinion about it.
  const [locked] = composeProviders(
    { groq: entry({ baseUrl: "https://api.groq.com/openai/v1", key: "vault://groq" }) },
    undefined,
    () => ({ ok: false, reason: "the vault is locked" }),
  );
  assert.equal(locked?.ok, false);
  if (locked?.ok) return;
  assert.match(locked.reason, /the vault is locked/, locked.reason);
});

test("compose: a key that is not a `vault://` name is refused without being printed (§7)", () => {
  const secret = "gsk_aRawKeyThatReachedCompositionBecauseLoadConfigKeepsRunning";
  const [result] = composed({
    groq: entry({ baseUrl: "https://api.groq.com/openai/v1", key: secret } as never),
  });
  assert.equal(result?.ok, false);
  if (result?.ok) return;
  assert.doesNotMatch(
    result.reason,
    /gsk_aRawKey/,
    "`loadConfig`'s rule 2 keeps a file with a bad key running, so this refusal is reachable with the secret still in " +
      "the entry — and it is printed on a startup banner and can be written to a log, which makes it a serializer. " +
      "SECURITY §7 puts the obligation there rather than at the screen, and `redact` would not have caught this one: " +
      "its secret-shaped pattern wants a delimiter after the prefix and `gsk_…` has an underscore",
  );
  assert.match(
    result.reason,
    /withheld/,
    "and the reason says the value was withheld, so the sentence is not read as " +
      "a field that happens to be empty",
  );
  assert.match(result.reason, /§3\.7/, "it names the rule the file broke");
  assert.match(
    result.reason,
    /crabby config get provider\.groq\.key/,
    "and the one place the owner may look at it: " +
      "the terminal that owns the file, which is not a serializer with a longer reach",
  );
});

test("compose: an inline key is refused by the schema, before it can be written to a 0644 file", () => {
  // §3.3: a key is "supplied by reference to the vault (§3.7), never inline in a conversation or an ordinary config
  // file". The control is the schema rather than a composition check, because composition runs *after* the file exists
  // — and `config.json` is mode 0644 (docs/DATA_AND_MEMORY.md §4.1), so a key that reached the file already lost.
  const file: ConfigFile = {
    provider: {
      local: { baseUrl: LOCAL, key: "sk-live-abcdefghijklmnop", models: { m: descriptor() } },
    },
  };
  const result = validate(ConfigFileSchema, file);
  assert.equal(result.ok, false, "an inline key must not validate");
  if (result.ok) return;
  assert.ok(
    result.problems.some((problem) => problem.path.endsWith("/key")),
    `the refusal must name the field: ${JSON.stringify(result.problems)}`,
  );
});

test("compose: `mock` is refused from configuration, because a task must not complete with no model behind it", () => {
  const [result] = composed({ fake: entry({ kind: "mock" }) });
  assert.equal(result?.ok, false);
  if (result?.ok) return;
  assert.match(result.reason, /§17/, result.reason);
  assert.match(result.reason, /completed/, "the reason says what the refusal prevents");
});

test("compose: the three families now compose, each through its own adapter (M4's slice)", () => {
  for (const kind of ["ollama", "anthropic", "gemini"] as const) {
    const [result] = composed({ named: entry({ kind }) });
    assert.ok(result?.ok, `${kind} composes: ${result && !result.ok ? result.reason : ""}`);
    if (!result?.ok) continue;
    assert.deepEqual(result.modelIds, ["qwen2.5:3b"]);
    assert.deepEqual(
      result.provider.listModels(),
      ["qwen2.5:3b"],
      "the adapter is the entry's models",
    );
  }
});

test("compose: an unparsable descriptor disables the provider rather than defaulting everything on (§3.2)", () => {
  const [result] = composed({
    local: entry({ models: { "qwen2.5:3b": { contextWindow: "lots" } } }),
  });
  assert.equal(result?.ok, false);
  if (result?.ok) return;
  assert.match(result.reason, /qwen2\.5:3b/, "the refusal names the model whose descriptor failed");
});

test("compose: a base URL carrying credentials is refused, for the reason §3.7 gives", () => {
  const [result] = composed({ local: entry({ baseUrl: "http://user:pass@127.0.0.1:8080/v1" }) });
  assert.equal(result?.ok, false);
  if (result?.ok) return;
  assert.match(result.reason, /credential/i, result.reason);
});

test("compose: an entry still under construction is refused with the command that finishes it", () => {
  // §3.3 requires a base URL and model name(s) of a *working* endpoint; the schema leaves both optional so that
  // `crabby config set provider.local.baseUrl …` can write one field. The requirement is enforced here, where the
  // answer names the next command instead of listing what the user has not typed.
  const [noBase] = composed({ local: { models: { m: descriptor() } } });
  assert.equal(noBase?.ok, false);
  assert.match(noBase && !noBase.ok ? noBase.reason : "", /config set provider\.local\.baseUrl/);

  const [noModels] = composed({ local: { baseUrl: LOCAL } });
  assert.equal(noModels?.ok, false);
  assert.match(
    noModels && !noModels.ok ? noModels.reason : "",
    /config set provider\.local\.models/,
    "§3.2's descriptors are what make a capability question answerable, so the reason says what to supply",
  );
});

test("compose: one entry's refusal never sinks another's", () => {
  const results = composed({
    broken: entry({ key: "vault://broken" }),
    working: entry({ baseUrl: "http://127.0.0.1:9999/v1" }),
  });
  assert.equal(results.length, 2);
  const byId = Object.fromEntries(results.map((result) => [result.id, result]));
  assert.equal(byId.broken?.ok, false);
  assert.equal(
    byId.working?.ok,
    true,
    "on a phone, refusing to boot over one typo is an outage (config.ts rule 2)",
  );
});

test("compose: a keyless entry over plain HTTP to a non-loopback host carries no warning, and that is decided", () => {
  // §3.3's warning is about a *key* going over plain HTTP. A key cannot reach composition at all — the schema refuses
  // an inline one and F-56 refuses a reference — so D-100's warning arm is unreachable from configuration and stays
  // reachable only for whoever constructs an adapter directly (a test, or M5's vault). Asserting the silence is what
  // keeps that from being mistaken for a dropped requirement.
  const [result] = composed({ lan: entry({ baseUrl: "http://192.168.1.20:8080/v1" }) });
  assert.equal(result?.ok, true, result && !result.ok ? result.reason : "");
  if (!result?.ok) return;
  assert.deepEqual(result.warnings, []);
});

test("compose: D-074's provider timeouts reach the adapter through `limits.*`", () => {
  const deadlines = deadlinesFrom({
    providerConnectMs: 1234,
    providerFirstTokenMs: 4321,
    providerIdleStreamMs: 999,
  } as never);
  assert.deepEqual(deadlines, { connectMs: 1234, firstTokenMs: 4321, idleStreamMs: 999 });
  const defaults = deadlinesFrom(undefined);
  assert.equal(defaults.connectMs, 10_000, "the defaults are D-074's, read rather than retyped");
});

test("select: §3.6's default model resolves against what composed, and says so when it cannot", () => {
  const entries = composed({
    local: entry(),
    keyed: entry({ baseUrl: "https://api.groq.com/openai/v1", key: "vault://groq" }),
  });
  const ok = selectDefaultModel(entries, "local/qwen2.5:3b");
  assert.equal(ok.ok, true, ok.ok ? "" : ok.reason);
  if (ok.ok) {
    assert.equal(ok.providerId, "local");
    assert.equal(ok.modelId, "qwen2.5:3b");
    assert.equal(ok.provider.id, "local");
  }

  const none = selectDefaultModel(entries, undefined);
  assert.equal(none.ok, false);
  if (!none.ok) {
    assert.match(none.reason, /§3\.6/, none.reason);
    assert.match(
      none.reason,
      /local\/qwen2\.5:3b/,
      "the refusal lists what would work instead of only what did not",
    );
  }

  const malformed = selectDefaultModel(entries, "qwen2.5:3b");
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.match(malformed.reason, /<provider>\/<modelId>/);

  const refusedProvider = selectDefaultModel(entries, "keyed/llama-3.3-70b");
  assert.equal(refusedProvider.ok, false);
  if (!refusedProvider.ok)
    assert.match(
      refusedProvider.reason,
      /does not compose/,
      "a provider that refused says why, not just that it is missing",
    );

  const unknownModel = selectDefaultModel(entries, "local/gpt-4o");
  assert.equal(unknownModel.ok, false);
  if (!unknownModel.ok)
    assert.match(
      unknownModel.reason,
      /qwen2\.5:3b/,
      "the refusal names the models the entry does declare",
    );
});

// Option B (D-110): the pool is every provider the caller composed, so a pin may name any of them — the half D-108
// deferred, which the owner started on 2026-10-14. `team/model-x` on purpose: only the first slash separates the
// provider, so a modelId may itself contain one.
test("a per-task pin resolves against every composed provider, and refuses one that is absent (D-110, F-57)", async () => {
  const local = new FakeProvider({ id: "local", models: ["qwen2.5:3b", "team/model-x"] });
  const second = new FakeProvider({ id: "second", models: ["big-chat"] });
  const pool = [local, second];

  const pinned = await selectPinnedModel(pool, "local/qwen2.5:3b");
  assert.equal(pinned.ok, true, pinned.ok ? "" : pinned.reason);
  if (pinned.ok) {
    assert.equal(pinned.providerId, "local");
    assert.equal(pinned.modelId, "qwen2.5:3b");
    assert.equal(
      pinned.provider,
      local,
      "the pool's own instance returns, so a run calls what composed",
    );
  }

  const slashed = await selectPinnedModel(pool, "local/team/model-x");
  assert.equal(
    slashed.ok,
    true,
    "only the first slash splits, so a modelId with a slash still resolves",
  );
  if (slashed.ok) assert.equal(slashed.modelId, "team/model-x");

  const cross = await selectPinnedModel(pool, "second/big-chat");
  assert.equal(cross.ok, true, "a pin may name any composed provider — D-108's deferred option B");
  if (cross.ok) {
    assert.equal(
      cross.provider,
      second,
      "and the run would call that provider rather than the default's",
    );
    assert.equal(cross.modelId, "big-chat");
  }

  const stranger = await selectPinnedModel(pool, "groq/llama-3.3-70b");
  assert.equal(stranger.ok, false, "a provider this Gateway did not compose cannot be pinned");
  if (!stranger.ok) {
    assert.match(
      stranger.reason,
      /no composed provider answers to 'groq'/,
      "the refusal names the id that is absent from this Gateway",
    );
    assert.match(
      stranger.reason,
      /local, second/,
      "it lists what is composed instead of only what is not",
    );
    assert.match(
      stranger.reason,
      /INTERFACES_AND_API\.md/,
      "it cites where §4.3 documents the pin",
    );
  }

  const malformed = await selectPinnedModel(pool, "qwen2.5:3b");
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.match(malformed.reason, /<provider>\/<modelId>/);

  const unknown = await selectPinnedModel(pool, "local/gpt-4o");
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.match(unknown.reason, /team\/model-x/, "names the declared models");
});

// D-044's second rung, as the pool labels it (§3.6 stage 2): each option carries its provider, what it would cost, and
// what choosing it loses. The third clause is the one this file exists to check, because a delta needs two models and the
// pair the run is on is the other half.
test("an ask's options are labelled against the model the run is on, same provider first", async () => {
  const rich = model({
    contextWindow: 128_000,
    supports: supports({
      streaming: true,
      toolCalling: true,
      imageInput: true,
    }) as ModelDescriptor["supports"],
    cost: { promptPerMTok: 0.5, completionPerMTok: 1.5 },
  });
  const thin = model({
    contextWindow: 8_192,
    supports: supports({ streaming: false }) as ModelDescriptor["supports"],
  });
  const local = new FakeProvider({
    id: "local",
    models: ["qwen2.5:3b", "qwen2.5:0.5b"],
    descriptors: { "qwen2.5:3b": rich, "qwen2.5:0.5b": thin },
  });
  const hosted = new FakeProvider({
    id: "hosted",
    models: ["llama-3.1-8b"],
    descriptors: {
      "llama-3.1-8b": model({
        contextWindow: 8_192,
        supports: supports({ streaming: false }) as ModelDescriptor["supports"],
        cost: { promptPerMTok: 0.5, completionPerMTok: 1.5 },
      }),
    },
  });

  const candidates = await composeAskCandidates([hosted, local], {
    providerId: "local",
    modelId: "qwen2.5:3b",
  });

  assert.deepEqual(
    candidates.map((candidate) => candidate.model),
    ["local/qwen2.5:0.5b", "hosted/llama-3.1-8b"],
    "the same provider's other models come first (§3.6 stage 2), and the model the run is on is not offered as an " +
      "alternative to itself — answering with no pin is what that means",
  );
  const localOption = candidates[0];
  assert.equal(localOption?.provider, "local");
  assert.equal(
    localOption?.cost,
    "local (no per-token cost)",
    "the cost class is what §3.6 asks the prompt to print",
  );
  assert.deepEqual(
    localOption?.losses,
    ["no streaming", "no image input", "a smaller context window (8,192 of 128,000)"],
    "the losses are computed against the current model — every capability it has and this one lacks, then the window",
  );
  const hostedOption = candidates[1];
  assert.equal(
    hostedOption?.cost,
    "paid per token",
    "a hosted model says so before it is chosen, not after",
  );
  assert.equal(
    hostedOption?.losses.includes("no image input"),
    true,
    "a capability the current model has and this one does not is a loss, whether or not the task needs it",
  );

  // The current model's own provider being in the pool is not what orders this: a run on the *second* provider still sees
  // its own alternatives first, which is what a user means by "somewhere else to try".
  const flipped = await composeAskCandidates([local, hosted], {
    providerId: "hosted",
    modelId: "llama-3.1-8b",
  });
  assert.deepEqual(
    flipped.map((candidate) => candidate.model),
    ["local/qwen2.5:0.5b", "local/qwen2.5:3b"],
  );
  assert.deepEqual(
    flipped[0]?.losses,
    [],
    "against a current model with the same capabilities and the same window there is no loss to state, and printing an " +
      "invented one would make every option look like a downgrade",
  );
});

test("an ask with nothing to offer says so, rather than describing a provider that cannot describe itself", async () => {
  const broken = new FakeProvider({ id: "broken", models: ["whatever"] });
  broken.describe = () => {
    throw new Error("descriptor did not parse");
  };

  assert.deepEqual(
    await composeAskCandidates([broken], { providerId: "local", modelId: "qwen2.5:3b" }),
    [],
    "§3.2: a descriptor that does not parse disables the provider, so its models are not offered as alternatives",
  );
  assert.deepEqual(
    await composeAskCandidates([], { providerId: "local", modelId: "qwen2.5:3b" }),
    [],
    "and a single-model install gets an empty list, which the ask reports as an ask with no options",
  );
});
