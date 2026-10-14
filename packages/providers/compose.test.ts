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
  composeProviders,
  deadlinesFrom,
  selectDefaultModel,
  selectPinnedModel,
} from "./compose.ts";
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

test("compose: a `vault://` key is refused, because nothing in this build resolves one (F-56)", () => {
  const [result] = composed({
    groq: entry({ baseUrl: "https://api.groq.com/openai/v1", key: "vault://groq" }),
  });
  assert.equal(result?.ok, false);
  if (result?.ok) return;
  assert.match(result.reason, /vault/, result.reason);
  assert.match(
    result.reason,
    /M5/,
    "the reason names the milestone that closes it, not just the gap",
  );
  assert.match(
    result.reason,
    /F-56/,
    "and the finding that records it, so a reader can follow the sentence",
  );
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

test("compose: §3.3's other three families are refused, each naming itself", () => {
  for (const kind of ["ollama", "anthropic", "gemini"] as const) {
    const [result] = composed({ named: entry({ kind }) });
    assert.equal(result?.ok, false, `${kind} has no adapter in this build (D-100)`);
    if (result?.ok) continue;
    assert.match(result.reason, new RegExp(kind), `${kind}'s refusal must name ${kind}`);
  }
  // Ollama is the one a Termux user is most likely to reach for, so its refusal carries the workaround rather than
  // leaving them to guess that an OpenAI-compatible listener exists on the same server.
  const [ollama] = composed({ named: entry({ kind: "ollama" }) });
  assert.match(ollama && !ollama.ok ? ollama.reason : "", /openai-compatible/);
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

test("a per-task pin resolves against the composed provider and refuses to cross it (D-108, F-57)", async () => {
  // `team/model-x` on purpose: only the first slash separates the provider, so a modelId may itself contain one.
  const provider = new FakeProvider({ id: "local", models: ["qwen2.5:3b", "team/model-x"] });

  const pinned = await selectPinnedModel(provider, "local/qwen2.5:3b");
  assert.equal(pinned.ok, true);
  if (pinned.ok) assert.equal(pinned.modelId, "qwen2.5:3b");

  const slashed = await selectPinnedModel(provider, "local/team/model-x");
  assert.equal(
    slashed.ok,
    true,
    "only the first slash splits, so a modelId with a slash still resolves",
  );
  if (slashed.ok) assert.equal(slashed.modelId, "team/model-x");

  const cross = await selectPinnedModel(provider, "groq/llama-3.3-70b");
  assert.equal(
    cross.ok,
    false,
    "a pin may not cross to a provider the runner does not hold (option A)",
  );
  if (!cross.ok) {
    assert.match(cross.reason, /scoped to the composed provider/, "option A's limitation is named");
    assert.match(
      cross.reason,
      /INTERFACES_AND_API\.md/,
      "the refusal cites where the limitation is documented",
    );
    assert.match(
      cross.reason,
      /qwen2\.5:3b/,
      "the refusal lists what the composed provider does declare",
    );
  }

  const malformed = await selectPinnedModel(provider, "qwen2.5:3b");
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.match(malformed.reason, /<provider>\/<modelId>/);

  const unknown = await selectPinnedModel(provider, "local/gpt-4o");
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.match(unknown.reason, /team\/model-x/, "names the declared models");
});
