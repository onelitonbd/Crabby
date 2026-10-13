// M1a's core tests. The header states the file's one structural job: it is the "one runner file per package" that
// `docs/ROADMAP.md` M1 asks for, and it imports through the package's own index so the index is never dead weight.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  applyConfigKey,
  canonicalConfig,
  configDocument,
  configForReading,
  configSchema,
  configToken,
  createLogger,
  createShutdown,
  dataLayoutFor,
  differingPaths,
  egressHosts,
  LIMITS_DEFAULTS,
  loadConfig,
  mergeConfig,
  REDACTED_MARKER,
  readLastExit,
  redact,
  redactText,
  writeConfig,
} from "./test-helpers.ts";

test("config: an absent file is defaults, not an error", () => {
  const layout = freshLayout();
  const loaded = loadConfig(layout);
  assert.equal(loaded.exists, false);
  assert.deepEqual(loaded.limits, LIMITS_DEFAULTS);
  assert.deepEqual(loaded.file, {});
});

test("config: a bad key is named, and the good keys still load", () => {
  const layout = freshLayout();
  writeFileSync(
    layout.configPath,
    JSON.stringify({ limits: { fsTimeoutMs: 15000 }, logging: { level: "debug" } }),
  );
  const loaded = loadConfig(layout);
  assert.equal(loaded.problems.length, 1, JSON.stringify(loaded.problems));
  assert.match(loaded.problems[0]?.message ?? "", /'logging'/);
  assert.equal(loaded.limits.fsTimeoutMs, 15000, "one typo must not turn a phone into an outage");
  assert.equal(loaded.limits.providerConnectMs, LIMITS_DEFAULTS.providerConnectMs);
});

test("config: malformed JSON is reported against the file, not swallowed", () => {
  const layout = freshLayout();
  writeFileSync(layout.configPath, "{ not json");
  const loaded = loadConfig(layout);
  assert.equal(loaded.exists, true);
  assert.match(loaded.problems[0]?.message ?? "", /not valid JSON/);
  assert.deepEqual(loaded.file, {});
});

test("config: a type error is refused by the writer that knows the schema", () => {
  const layout = freshLayout();
  writeFileSync(layout.configPath, "{}");
  const result = writeConfig(
    layout,
    applyConfigKey({}, "limits.parallelToolSteps", "two") as never,
  );
  assert.equal(result.ok, false);
  assert.match(result.message, /parallelToolSteps/);
  assert.equal(
    readFileSync(layout.configPath, "utf8").trim(),
    "{}",
    "a refused write changed nothing",
  );
});

test("config: the schema is JSON Schema, which is the whole reason TypeBox was chosen (D-060)", () => {
  const schema = configSchema();
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  const properties = schema.properties as Record<string, unknown>;
  assert.ok(properties?.limits, "limits must be in the printed schema");
  assert.equal(
    schema.additionalProperties as boolean,
    false,
    "the file rejects unknown keys, like every other body",
  );
});

test("config: merge is per-section so a partial file does not erase defaults", () => {
  const merged = mergeConfig({ limits: { ...LIMITS_DEFAULTS } }, { limits: { fsTimeoutMs: 1 } });
  assert.equal(merged.limits?.fsTimeoutMs, 1);
  assert.equal(merged.limits?.shellRunTimeoutMs, LIMITS_DEFAULTS.shellRunTimeoutMs);
});

test("redaction is not a log level", () => {
  const value = {
    authorization: "Bearer sk-abcdefghijklmnop",
    note: "approved the git.push call",
    nested: [{ token: "x".repeat(40) }],
  };
  const clean = redact(value) as typeof value;
  assert.equal(clean.authorization, "[redacted]");
  assert.equal(clean.note, "approved the git.push call");
  assert.equal((clean.nested[0] as { token: string }).token, "[redacted]");
  assert.match(redactText("Authorization: Bearer supersecretvalue"), /Authorization: \[redacted\]/);
  assert.match(redactText("GET /x?key=abcdefghijklmnop"), /key=\[redacted\]/);
});

test("the logger filters by level, bounds its buffer, and never loses the task id", () => {
  const lines: string[] = [];
  const log = createLogger({
    level: "info",
    write: (line) => lines.push(line),
    now: () => new Date("2026-10-10T00:00:00Z"),
    bufferLines: 2,
  });
  log.debug("hidden");
  log.info("visible", { taskId: "tsk_0123456789abcdefghjkmnpq0r", apiKey: "leakleakleakleak" });
  log.warn("second");
  log.error("third");
  assert.equal(lines.length, 3, "debug at level info must not reach the stream");
  // lines[0] is "visible": `debug` was filtered out, so the array is the three lines that passed the level, in order.
  const record = JSON.parse(lines[0] ?? "{}") as {
    level?: string;
    taskId?: string;
    fields?: Record<string, unknown>;
  };
  assert.equal(record.level, "info");
  assert.equal(record.fields?.apiKey, "[redacted]");
  assert.equal(record.taskId, "tsk_0123456789abcdefghjkmnpq0r");
  assert.deepEqual(
    log.records().map((r) => r.msg),
    ["second", "third"],
    "the tail is bounded on purpose",
  );
  const scoped = log.child("gateway");
  assert.equal(typeof scoped.info, "function");
});

test("shutdown runs every step, collects rather than propagates, and leaves a readable record", async () => {
  const layout = freshLayout();
  const order: string[] = [];
  const shutdown = createShutdown(layout, { drainMs: 50 });
  shutdown.onShutdown("first", () => void order.push("first"));
  shutdown.onShutdown("boom", () => {
    throw new Error("step failed");
  });
  shutdown.onShutdown("last", () => void order.push("last"));
  const result = await shutdown.run("signal", "SIGTERM");
  assert.deepEqual(order, ["first", "last"], "a step that throws must not strand the rest");
  assert.deepEqual(result.errors, [{ name: "boom", message: "step failed" }]);
  assert.equal(kindOf(readLastExit(layout)), "signal", "the record names how the process left");
  assert.equal(shutdown.running, true);
  const second = await shutdown.run("clean");
  assert.deepEqual(second.errors, [], "a second run does nothing, so it reports nothing");
  assert.equal(kindOf(readLastExit(layout)), "signal", "and the first record stands");
});

test("a missing record is not an unclean exit; a corrupt one is", () => {
  const layout = freshLayout();
  assert.equal(readLastExit(layout), "missing");
  writeFileSync(join(layout.stateDir, "last-exit.json"), "{ broken");
  assert.equal(readLastExit(layout), "unclean");
  writeFileSync(
    join(layout.stateDir, "last-exit.json"),
    JSON.stringify({ kind: "clean", at: "2026-10-10T00:00:00.000Z" }),
  );
  const record = readLastExit(layout);
  assert.equal(typeof record === "string" ? record : record.kind, "clean");
});

// ---- §3.7's provider namespace and §8's workspace roots (D-101)
//
// These are schema tests rather than composition tests: `packages/providers/compose.ts` decides whether an entry can
// *work*, and this file decides whether it may be *written down*. The division is the reason an inline key is refused
// here rather than there — composition runs after the file exists, and `config.json` is mode 0644
// (`docs/DATA_AND_MEMORY.md` §4.1), so a key that reached the file already lost.

const DESCRIPTOR = {
  contextWindow: 4096,
  maxOutputTokens: 512,
  supports: {
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
  },
  cancellation: "best-effort",
  rateLimits: null,
  cost: "local",
  batching: null,
};

test("config: a provider entry round-trips, and the file still holds no defaults", () => {
  const layout = freshLayout();
  const written = writeConfig(layout, {
    provider: {
      local: { baseUrl: "http://127.0.0.1:8080/v1", models: { "qwen2.5:3b": DESCRIPTOR } },
    },
    defaultModel: "local/qwen2.5:3b",
  } as never);
  assert.equal(written.ok, true, written.ok ? "" : written.message);
  const loaded = loadConfig(layout);
  assert.deepEqual(loaded.problems, []);
  assert.equal(loaded.config.provider?.local?.baseUrl, "http://127.0.0.1:8080/v1");
  assert.equal(loaded.config.defaultModel, "local/qwen2.5:3b");
  assert.deepEqual(
    loaded.limits,
    LIMITS_DEFAULTS,
    "a file that configures a provider has still frozen no default (D-074)",
  );
});

test("config: an inline API key is refused at the keystroke, not at composition (§3.3)", () => {
  const layout = freshLayout();
  writeFileSync(layout.configPath, "{}");
  const written = writeConfig(layout, {
    provider: {
      groq: {
        baseUrl: "https://api.groq.com/openai/v1",
        key: "sk-live-abcdefghijklmnop",
        models: { "llama-3.3-70b": DESCRIPTOR },
      },
    },
  } as never);
  assert.equal(written.ok, false, "§3.3: a key is never inline in an ordinary config file");
  assert.match(written.ok ? "" : written.message, /key/);
  assert.equal(
    readFileSync(layout.configPath, "utf8").trim(),
    "{}",
    "a refused write changed nothing — the key never reached a 0644 file",
  );
});

test("config: a `vault://` reference is what the schema accepts (§3.7), and resolving it is M5's job", () => {
  const layout = freshLayout();
  const written = writeConfig(layout, {
    provider: {
      groq: {
        baseUrl: "https://api.groq.com/openai/v1",
        key: "vault://groq",
        models: { "llama-3.3-70b": DESCRIPTOR },
      },
    },
  } as never);
  assert.equal(written.ok, true, written.ok ? "" : written.message);
  assert.equal(loadConfig(layout).config.provider?.groq?.key, "vault://groq");
});

test("config: an entry with no models, and a family with no adapter, are both refused by the schema", () => {
  const layout = freshLayout();
  writeFileSync(layout.configPath, "{}");
  const noModels = writeConfig(layout, {
    provider: { local: { baseUrl: "http://127.0.0.1:8080/v1", models: {} } },
  } as never);
  assert.equal(
    noModels.ok,
    false,
    "§3.2's descriptors are what make a capability question answerable",
  );
  const badKind = writeConfig(layout, {
    provider: {
      local: { baseUrl: "http://127.0.0.1:8080/v1", kind: "openai", models: { m: DESCRIPTOR } },
    },
  } as never);
  assert.equal(badKind.ok, false, "§3.3 names the families; a typo is refused rather than assumed");
  assert.equal(readFileSync(layout.configPath, "utf8").trim(), "{}");
});

test("config: one field of a provider entry is writable, because §3.7 spells it that way", () => {
  // The regression this pins: a schema that required the whole entry at the keystroke made `provider.groq.key =
  // vault://groq` — §3.7's own example — unwritable, and answered with five problems about fields the user had not
  // typed yet. What an incomplete entry *means* is composition's answer, not the writer's.
  const layout = freshLayout();
  const written = writeConfig(
    layout,
    applyConfigKey({}, "provider.groq.key", "vault://groq") as never,
  );
  assert.equal(written.ok, true, written.ok ? "" : written.message);
  assert.equal(loadConfig(layout).config.provider?.groq?.key, "vault://groq");
});

test("config: workspace roots and a default model are settable by the dotted key a user types", () => {
  const withRoots = applyConfigKey({}, "workspace.roots", ["/data/local/crabby-workspace"]);
  assert.deepEqual((withRoots as { workspace: { roots: string[] } }).workspace.roots, [
    "/data/local/crabby-workspace",
  ]);
  const withModel = applyConfigKey({}, "defaultModel", "local/qwen2.5:3b");
  assert.equal((withModel as { defaultModel: string }).defaultModel, "local/qwen2.5:3b");
  // A model id contains dots, and `applyConfigKey` splits on dots — which is why `models` is a record whose whole
  // value is set at once rather than a nested path a user could address per field.
  const wholeModels = applyConfigKey({}, "provider.local.models", { "qwen2.5:3b": DESCRIPTOR });
  // Through `unknown` because `applyConfigKey` answers `ConfigFile`, whose `provider` is an index signature and
  // therefore does not promise the `local` key this test just wrote.
  const written = wholeModels as unknown as {
    provider: { local: { models: Record<string, unknown> } };
  };
  assert.deepEqual(Object.keys(written.provider.local.models), ["qwen2.5:3b"]);
});

test("config: a bad provider entry is reported against the file and does not sink the limits beside it", () => {
  const layout = freshLayout();
  writeFileSync(
    layout.configPath,
    JSON.stringify({
      limits: { fsTimeoutMs: 12000 },
      provider: { local: { baseUrl: "http://127.0.0.1:8080/v1", models: {}, nope: 1 } },
    }),
  );
  const loaded = loadConfig(layout);
  assert.ok(loaded.problems.length > 0, "a partial file still reports what is wrong with it");
  assert.ok(
    loaded.problems.some((problem) => problem.path.includes("provider")),
    `the problem has to name the section: ${JSON.stringify(loaded.problems)}`,
  );
  assert.equal(
    loaded.limits.fsTimeoutMs,
    12000,
    "rule 2: one typo must not turn a phone into an outage",
  );
  assert.equal(loaded.limits.providerConnectMs, LIMITS_DEFAULTS.providerConnectMs);
});

test("config: the printed schema names the sections §3.7 and §8 put in the file (D-060)", () => {
  const properties = configSchema().properties as Record<string, unknown>;
  for (const key of ["limits", "provider", "defaultModel", "workspace"])
    assert.ok(
      properties[key],
      `${key} must be in the schema \`crabby config schema --json\` prints`,
    );
});

function kindOf(record: ReturnType<typeof readLastExit>): string {
  return typeof record === "string" ? record : record.kind;
}

test("config: the curated egress host set is normalized once, because §4.2's T1 half is a string comparison", () => {
  const layout = freshLayout();
  writeFileSync(
    layout.configPath,
    JSON.stringify({
      net: { allowList: ["  API.Example.COM ", "api.example.com", "example.org"] },
    }),
  );
  const loaded = loadConfig(layout);
  assert.deepEqual(
    [...egressHosts(loaded.config)],
    ["api.example.com", "example.org"],
    "`packages/policy` lowercases the hostname it reads out of a URL before comparing, so a curated `API.Example.COM` " +
      "left upper-case would never match and the user would be asked to approve at T2 a host they had already " +
      "pre-approved at T1 — one spelling, chosen where the entries are read rather than where they are typed, and a " +
      "repeat dropped because a repeated entry would print a repeated reason (D-106)",
  );
  assert.deepEqual(
    [...egressHosts({})],
    [],
    "an install with no `net` section is not an error and gets no default: an empty set means every destination is a new " +
      "host, which is §4.3's T2 with the host named in the prompt, not a refusal",
  );
  assert.deepEqual(
    [...egressHosts({ net: { allowList: ["   "] } })],
    [],
    "and an entry that is only whitespace names no host — the schema's `minLength` cannot see it, so the read does",
  );
});

test("config: §2's token is a hash of the document and not of the bytes, so a reformatting is not an edit (D-107)", () => {
  const layout = freshLayout();
  writeFileSync(layout.configPath, JSON.stringify({ limits: { fsTimeoutMs: 15000 } }));
  const first = loadConfig(layout);
  assert.match(
    first.token,
    /^[0-9a-f]{16}$/,
    "sixteen hex characters, opaque on purpose: a client presents it back " +
      "and has no business parsing it, which is the difference from D-104's session revision, where the integer is a " +
      "fact a client can read because the database already keeps one",
  );

  // The same document, written the way a human or a formatter would write it: keys in the other order, two-space
  // indent, a trailing newline. Nothing the process runs on has moved, so nothing a client presented may be refused.
  writeFileSync(layout.configPath, `{\n  "limits": {\n    "fsTimeoutMs": 15000\n  }\n}\n`);
  assert.equal(
    loadConfig(layout).token,
    first.token,
    "a token over the bytes would make every reformatting look like a concurrent writer, and the client that read the " +
      "document before it would be told its own settings had moved",
  );
  assert.equal(
    canonicalConfig({ b: 1, a: { d: [2, 1], c: null } }),
    canonicalConfig({ a: { c: null, d: [2, 1] }, b: 1 }),
    "keys sorted at every depth — and arrays in order, because `[a, b]` and `[b, a]` are two different allow-lists",
  );

  writeFileSync(layout.configPath, JSON.stringify({ limits: { fsTimeoutMs: 15001 } }));
  assert.notEqual(
    loadConfig(layout).token,
    first.token,
    "one value changed, so the token changed: that is the whole obligation, and a token that missed it would let a " +
      "second interface overwrite the first in silence",
  );

  const absent = dataLayoutFor(join(mkdtempSync(join(tmpdir(), "crabby-core-empty-")), STATE));
  assert.equal(
    loadConfig(absent).token,
    configToken({}),
    "no file is the empty document, and the empty document has " +
      "a token, because a first write is still a write somebody may have raced",
  );
  writeFileSync(absent.configPath, "{ not json");
  assert.equal(
    loadConfig(absent).token,
    configToken({}),
    "a corrupt file is also the empty document as far as a token can see, and that is stated rather than hidden: two " +
      "different corrupt files share a token, so a write over corruption is not refused as stale. The fix is not a " +
      "smarter hash, it is that the same answer names the problem (`problems`) and the user writes a good document",
  );

  writeFileSync(
    layout.configPath,
    JSON.stringify({ defaultModel: "groq/llama-3.3-70b-versatile" }),
  );
  const loaded = loadConfig(layout);
  assert.equal(
    loaded.token,
    configToken(loaded.file),
    "the token is computed from the file and never from the merged view: D-074's defaults are code, so a release that " +
      "moves a default would otherwise invalidate every token a client holds without anybody editing anything",
  );
  assert.notEqual(configToken(loaded.file), configToken(loaded.config));
});

test("config: a write with the token it read lands, and a write over a document that moved is refused (D-107)", () => {
  const layout = freshLayout();
  writeFileSync(layout.configPath, "{}");
  const read = loadConfig(layout);
  const next = applyConfigKey(read.file, "limits.fsTimeoutMs", 20000);
  const written = writeConfig(layout, next, undefined, { token: read.token });
  assert.equal(written.ok, true, written.message);
  assert.equal(
    written.token,
    configToken(next),
    "the answer carries the token the file now has, so a client that writes twice does not have to read between them",
  );
  assert.equal(
    loadConfig(layout).token,
    written.token,
    "and a re-read agrees, which is what makes it a version",
  );

  // Somebody else writes while this caller is composing its request. The token the caller holds is now a token for a
  // document that does not exist, and §2's row is about exactly this: two interfaces editing one configuration.
  const raced = writeConfig(layout, applyConfigKey(next, "limits.sqliteBusyTimeoutMs", 4000));
  assert.equal(
    raced.ok,
    true,
    "a write with no token is a write by a party that read nothing, and stays allowed: the " +
      "rule is presented-by-the-caller, not enforced on every writer, because `crabby init` has no document to read yet",
  );
  const racedToken = raced.token;
  assert.ok(
    racedToken !== undefined,
    "a write that landed answers with the token the file now carries",
  );
  const stale = writeConfig(
    layout,
    applyConfigKey(next, "defaultModel", "groq/llama-3.1-8b-instant"),
    undefined,
    {
      token: read.token,
    },
  );
  assert.equal(stale.ok, false);
  assert.equal(
    stale.code,
    "stale",
    "the refusal is named so a route can answer §6's conflict class instead of " +
      "guessing from the sentence",
  );
  assert.match(stale.message, new RegExp(read.token), "the token the caller presented");
  assert.match(
    stale.message,
    new RegExp(racedToken),
    "and the one the file now carries, because a refusal " +
      "that does not name both leaves a client unable to tell whether it read the wrong file or the wrong install",
  );
  assert.equal(
    loadConfig(layout).token,
    racedToken,
    "a refused write changed nothing: the document that won the race is still the document on disk",
  );

  const invalid = writeConfig(
    layout,
    applyConfigKey(next, "limits.parallelToolSteps", "two"),
    undefined,
    { token: read.token },
  );
  assert.equal(invalid.ok, false);
  assert.equal(
    invalid.code,
    "invalid",
    "the schema is checked before the token, and the order is the point: a client told `stale` would re-read and " +
      "submit the same invalid document again, so the answer that names a defect the caller can fix comes first",
  );
  assert.match(invalid.message, /parallelToolSteps/);

  const unwritable = writeConfig(
    layout,
    next,
    () => {
      throw new Error("EACCES: permission denied");
    },
    { token: racedToken },
  );
  assert.equal(unwritable.ok, false);
  assert.equal(
    unwritable.code,
    "unwritable",
    "this device's own answer, kept distinct from the caller's mistake",
  );
  assert.match(
    unwritable.message,
    /EACCES/,
    "and the reason is passed through rather than flattened",
  );

  // A token comparison reads the file, and the read is injectable for the same reason the write is: describing a file
  // somebody else changed should not take a second process.
  const moved = writeConfig(layout, next, undefined, {
    token: read.token,
    read: () => JSON.stringify({ limits: { fsTimeoutMs: 1 } }),
  });
  assert.equal(moved.ok, false);
  assert.equal(moved.code, "stale");
  assert.equal(
    loadConfig(layout).token,
    racedToken,
    "an injected read describes the file; it does not replace it",
  );
});

test("config: a read withholds a key that is not a `vault://` name, and names what it withheld (§4.2, SECURITY §7)", () => {
  const raw = "gsk_aRawProviderKeyThatMustNeverBeAnswered";
  const bad = { provider: { groq: { baseUrl: "https://api.groq.com/openai/v1", key: raw } } };
  const withheld = configForReading(bad);
  assert.deepEqual(
    withheld.redacted,
    ["provider.groq.key"],
    "the dotted path is an answer and the value is not: §4.2's `config.get` row is secret *names* only, never values",
  );
  const withheldKey = (withheld.file.provider as Record<string, { key?: string }> | undefined)?.groq
    ?.key;
  assert.equal(
    withheldKey,
    REDACTED_MARKER,
    "withheld in place rather than dropped, so a settings screen still shows the field the user has to fix",
  );
  assert.doesNotMatch(JSON.stringify(withheld.file), /gsk_/);

  const good = configForReading({ provider: { groq: { key: "vault://groq" } } });
  assert.deepEqual(good.redacted, []);
  const namedKey = (good.file.provider as Record<string, { key?: string }> | undefined)?.groq?.key;
  assert.equal(
    namedKey,
    "vault://groq",
    "§3.7's own spelling of a secret's *name* is printed, because a name is what a user has to recognise",
  );

  const layout = freshLayout();
  // A raw key fails the schema, and `onlyKnownKeys` is shallow, so the bad leaf survives inside its good branch in
  // `file` — the view a settings screen edits. This is the case `configForReading` exists for.
  writeFileSync(layout.configPath, JSON.stringify({ ...bad, limits: { fsTimeoutMs: 9000 } }));
  const document = configDocument(layout);
  assert.doesNotMatch(
    JSON.stringify(document),
    /gsk_aRaw/,
    "SECURITY §7 puts the obligation at the serializer rather than at the screen, and `configDocument` is the one " +
      "derivation both `GET /api/v1/config` and the `config.get` tool answer from — so neither caller can forget it",
  );
  assert.deepEqual(document.redacted, ["provider.groq.key"]);
  assert.equal(
    document.problems.length,
    1,
    "and the defect is still named: withholding is not the same as hiding",
  );
  assert.match(document.problems[0]?.message ?? "", /key/);
  assert.equal(document.path, layout.configPath);
  assert.equal(document.exists, true);
  assert.equal(
    document.limits.fsTimeoutMs,
    9000,
    "the good key beside the bad one still loads (rule 2 above)",
  );
  assert.equal(
    document.token,
    loadConfig(layout).token,
    "the token is §2's, computed from the file as written",
  );
  assert.deepEqual(document.config.limits, { ...LIMITS_DEFAULTS, fsTimeoutMs: 9000 });
  assert.equal(
    (document.config.limits as Record<string, unknown>).providerFirstTokenMs,
    LIMITS_DEFAULTS.providerFirstTokenMs,
    "D-074's `providerFirstTokenMs` is a *clock* whose name contains the word `token`, so the shared scrub's key-name " +
      "rule masks it — and a configuration read answering `[redacted]` for a timeout would hide a number the " +
      "documentation promises is visible through `crabby config get limits`. A secret in a JSON document is a string, " +
      "so `configForReading` puts a non-string leaf back as it read it and leaves every string to the scrub",
  );
});

test("config: `differingPaths` names the keys that moved and never a value, because a configuration value is not a log field (§7)", () => {
  assert.deepEqual(
    [...differingPaths({ limits: { fsTimeoutMs: 1 } }, { limits: { fsTimeoutMs: 2 } }, "")],
    ["limits.fsTimeoutMs"],
  );
  assert.deepEqual(
    [...differingPaths({ a: 1 }, { a: 1 }, "")],
    [],
    "nothing moved, nothing to name",
  );
  assert.deepEqual(
    [...differingPaths({ net: { allowList: ["a"] } }, { net: { allowList: ["a", "b"] } }, "")],
    ["net.allowList"],
    "an array is named whole rather than per index: which element moved is a question a value would answer, and a " +
      "value in a log line is the thing §7 forbids — so `PUT /config` logs the paths that moved and stops there",
  );
  assert.deepEqual(
    [...differingPaths({ a: { b: 1 } }, { a: {}, c: 2 }, "")],
    ["a.b", "c"],
    "a key that disappeared and a key that appeared are both differences, which is what makes this usable to describe " +
      "a write rather than only an edit",
  );
});

test("config: shell execution is opt-in — `shell.enabled` is absent by default and only `true` enables", () => {
  const layout = freshLayout();
  // No file, no key: a fresh install has never heard of the shell, which is §9's "never enabled by default" as data.
  assert.equal(loadConfig(layout).config.shell, undefined);
  // Absent, empty, and false are all off — and all three load without a problem, because off is the default and not
  // a state that needs explaining.
  for (const doc of [{}, { shell: {} }, { shell: { enabled: false } }]) {
    writeFileSync(layout.configPath, JSON.stringify(doc));
    const loaded = loadConfig(layout);
    assert.deepEqual(loaded.problems, [], `off-by-default must not be a problem: ${JSON.stringify(doc)}`);
    assert.notEqual(loaded.config.shell?.enabled, true);
  }
  writeFileSync(layout.configPath, JSON.stringify({ shell: { enabled: true } }));
  const opted = loadConfig(layout);
  assert.deepEqual(opted.problems, []);
  assert.equal(opted.config.shell?.enabled, true);
  // Anything that is not a boolean is refused by the schema rather than coerced: a truthy string enabling shell
  // execution would be an opt-in nobody typed.
  for (const bad of ["yes", 1, 0, null]) {
    writeFileSync(layout.configPath, JSON.stringify({ shell: { enabled: bad } }));
    const refused = loadConfig(layout);
    assert.ok(
      refused.problems.some((problem) => problem.path.includes("shell")),
      `the problem has to name the section: ${JSON.stringify(refused.problems)}`,
    );
    assert.equal(
      refused.limits.fsTimeoutMs,
      LIMITS_DEFAULTS.fsTimeoutMs,
      "rule 2: a bad shell value must not sink the limits beside it",
    );
  }
  // The dotted key a user types reaches the same field `crabby init --enable-shell` writes, because both are one
  // spelling of one opt-in rather than two paths that can drift.
  const keyed = applyConfigKey({}, "shell.enabled", true);
  assert.equal((keyed as { shell: { enabled: boolean } }).shell.enabled, true);
  // The opt-in moves the D-107 token, so a Gateway `PUT /config` that landed between the read and the write is
  // refused as `stale` instead of silently overwriting the choice.
  assert.notEqual(configToken({ shell: { enabled: true } }), configToken({}));
  // And the schema `crabby config schema --json` prints names the section, because a key the schema does not list
  // is a key `crabby config set` refuses at the keystroke.
  const properties = configSchema().properties as Record<string, unknown>;
  assert.ok(properties.shell, "`shell` must be in the schema the command prints");
});

function freshLayout() {
  const root = mkdtempSync(join(tmpdir(), "crabby-core-"));
  return dataLayoutFor(join(root, STATE));
}

const STATE = ".crabby";
