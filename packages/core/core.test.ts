// M1a's core tests. The header states the file's one structural job: it is the "one runner file per package" that
// `docs/ROADMAP.md` M1 asks for, and it imports through the package's own index so the index is never dead weight.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  applyConfigKey,
  configSchema,
  createLogger,
  createShutdown,
  dataLayoutFor,
  LIMITS_DEFAULTS,
  loadConfig,
  mergeConfig,
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

function freshLayout() {
  const root = mkdtempSync(join(tmpdir(), "crabby-core-"));
  return dataLayoutFor(join(root, STATE));
}

const STATE = ".crabby";
