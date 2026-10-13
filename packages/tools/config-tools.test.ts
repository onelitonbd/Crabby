// The configuration executor, and the two rows §4.2 prices for it. Asserted as the sentences it enforces: what the rows
// declare and at which tier the arbiter will price them, that a read answers the document the process runs on with every
// default marked as one, that a key nobody wrote is an answer rather than an empty string, that a withheld value is named
// and never printed, and that a write's refusal arrives with the sink's own code — including §2's stale token, which is
// the one refusal a tool cannot invent for itself because only the file knows whether it moved.
//
// A separate file from `tools.test.ts` for the reason `session-tools.test.ts` is one: that suite's subject is a real
// filesystem and this one's is a document and a sink. The sinks here are fakes, so what is under test is the executor's
// own behaviour — argument checking, key lookup, the refusal mapping, the bound on an answer. The real composition
// (`configDocument` in core, the compare-and-swap in `writeConfig`) is exercised by `packages/core/core.test.ts` and by
// `tests/integration/config.test.ts`, which reaches both through HTTP and through a run.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunOrigin, ToolRunContext } from "@crabby/agent-runtime";
import { MAX_TOOL_OUTPUT_BYTES } from "@crabby/api-contracts";
import { LIMITS_DEFAULTS } from "@crabby/core";
import { resolveTool } from "@crabby/policy";
import {
  CONFIG_GET_TOOL,
  CONFIG_SET_TOOL,
  CONFIG_TOOL_CODES,
  type ConfigToolRead,
  type ConfigToolWriteResult,
  createConfigTools,
} from "./index.ts";

const ORIGIN: RunOrigin = {
  clientId: "cli_1",
  clientName: "the owner",
  interface: "cli",
  capabilities: ["config.write"],
  sessionId: "ses_1",
};

function context(signal?: AbortSignal): ToolRunContext {
  return {
    taskId: "tsk_harness1",
    signal: signal ?? new AbortController().signal,
    deadlineMs: undefined,
    origin: ORIGIN,
  };
}

/** What the user wrote: two overrides and one `vault://` name. */
const FILE: Readonly<Record<string, unknown>> = {
  defaultModel: "groq/llama-3.3-70b-versatile",
  limits: { fsTimeoutMs: 4_000 },
  net: { allowList: ["example.test", "api.groq.com"] },
  provider: { groq: { baseUrl: "https://api.groq.com/openai/v1", key: "vault://groq" } },
};

/** The same document with D-074's defaults folded in, which is what a `key` is read from. */
const CONFIG: Readonly<Record<string, unknown>> = {
  defaultModel: "groq/llama-3.3-70b-versatile",
  limits: { fsTimeoutMs: 4_000, maxOutputBytes: 32_768, sqliteBusyTimeoutMs: 5_000 },
  net: { allowList: ["example.test", "api.groq.com"], fetchTimeoutMs: 20_000 },
  workspace: { roots: ["/data/home/user/work"] },
  provider: { groq: { baseUrl: "https://api.groq.com/openai/v1", key: "vault://groq" } },
};

function document(overrides: Partial<ConfigToolRead> = {}): ConfigToolRead {
  return {
    file: FILE,
    config: CONFIG,
    token: "0f2c9a41b7e8d356",
    path: "/tmp/crabby-state/config.json",
    exists: true,
    problems: [],
    redacted: [],
    ...overrides,
  };
}

interface Lab {
  /** Every key and value the write sink was handed, in order. Empty means no write was attempted. */
  readonly writes: { key: string; value: unknown }[];
  /** How many times the read sink was asked. A refusal that touches the file first would show up here. */
  reads: number;
  /** What the next write answers with. Absent means the write succeeded and moved the token. */
  // `| undefined` because `exactOptionalPropertyTypes` otherwise forbids the one-shot assignment that consumes a refusal.
  refuseNext?: ConfigToolWriteResult | undefined;
  /** The document the read sink answers with, replaceable per test. */
  next: ConfigToolRead | undefined;
  readonly tools: ReturnType<typeof createConfigTools>;
}

function lab(
  options: {
    document?: ConfigToolRead | undefined;
    limits?: { fsTimeoutMs?: number; maxOutputBytes?: number };
  } = {},
): Lab {
  const self: Lab = {
    writes: [],
    reads: 0,
    refuseNext: undefined,
    next: options.document === undefined ? document() : options.document,
    get tools() {
      return tools;
    },
  };
  const tools = createConfigTools({
    read: () => {
      self.reads += 1;
      return self.next;
    },
    write: ({ key, value }) => {
      self.writes.push({ key, value });
      const refusal = self.refuseNext;
      if (refusal !== undefined) {
        self.refuseNext = undefined;
      }
      return (
        refusal ?? {
          ok: true,
          token: "9d1e0b62c4a7f813",
          changed: true,
          path: "/tmp/crabby-state/config.json",
        }
      );
    },
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  return self;
}

const call = (tool: string, args: Record<string, unknown> = {}) => ({ tool, args });
type Outcome = { ok: boolean; output: string; code?: string };

test("the two declarations say what §4.2's rows say, and the arbiter prices them the same way", () => {
  const instance = lab();
  const declarations = instance.tools.declarations();
  assert.deepEqual(
    declarations.map((declaration) => declaration.name),
    [CONFIG_GET_TOOL, CONFIG_SET_TOOL],
    "§4.2's two configuration rows and no third: this tool sets and never unsets, because removing a key from the file " +
      "that decides permissions is a different act from writing one",
  );
  const [get, set] = declarations;
  assert.equal(
    get?.idempotent,
    true,
    "a read with no writes in it, so §7.3's resume may repeat it freely",
  );
  assert.equal(
    get?.sideEffects,
    "none",
    "and §6.2's evidence for a step abandoned here is that nothing was left behind",
  );
  assert.equal(
    set?.idempotent,
    false,
    "the second write is a *new* write over a document that may have moved, so §7.3's question — is repeating this step " +
      "safe without asking again — is answered no for a T3 act on the file that decides permissions",
  );
  assert.equal(
    set?.sideEffects,
    "local",
    "nothing outside this install moves, and the previous document is not kept, so `irreversible` would overstate it " +
      "while `none` would tell a recovery path there was nothing to be uncertain about",
  );
  for (const declaration of declarations) {
    assert.equal(
      declaration?.limits.timeoutMs,
      LIMITS_DEFAULTS.fsTimeoutMs,
      "D-074's `fs.*` row: the act is a file read and a file write, so this tool borrows the clock of the thing it " +
        "touches rather than inventing a fifth number for a document on the same disk",
    );
    assert.equal(
      declaration?.limits.maxOutputBytes,
      MAX_TOOL_OUTPUT_BYTES,
      "§4.1's record carries the cap the executor enforces, so a declaration and an answer cannot disagree",
    );
    assert.equal(
      declaration?.outputSchema,
      undefined,
      "no executor in this build declares one (§4.1)",
    );
    assert.equal(typeof declaration?.description, "string");
    assert.ok(
      (declaration?.description ?? "").includes("§4.2"),
      "the description a model reads cites the row it came from, so an answer can be checked against the document",
    );
  }
  // The tier is not this file's to choose: it is the registry's, and the registry's is §4.2's.
  assert.equal(resolveTool(CONFIG_GET_TOOL)?.tier, "T0", "§4.2 prices the read at T0");
  assert.deepEqual(
    resolveTool(CONFIG_GET_TOOL)?.capabilities,
    [],
    "the row's own words are `config.write`-independent read, which is a statement that it needs no capability",
  );
  assert.equal(resolveTool(CONFIG_SET_TOOL)?.tier, "T3", "§4.2 prices the write at T3");
  assert.deepEqual(
    resolveTool(CONFIG_SET_TOOL)?.capabilities,
    ["config.write"],
    "so the arbiter asks for an approval before this executor is ever reached (D-084: only the loop opens one)",
  );
  assert.deepEqual(
    instance.tools.specs().map((spec) => spec.name),
    [CONFIG_GET_TOOL, CONFIG_SET_TOOL],
    "both rows are offered to a provider, which is what makes the T3 park in `tests/integration/config.test.ts` reachable",
  );
});

test("config.get with no key answers the document the process runs on, one line per leaf, defaults marked", async () => {
  const instance = lab();
  const outcome = (await instance.tools.run(call(CONFIG_GET_TOOL), context())) as Outcome;
  assert.equal(outcome.ok, true);
  assert.equal(outcome.code, undefined);
  assert.match(outcome.output, /^read \/tmp\/crabby-state\/config\.json; token 0f2c9a41b7e8d356/);
  assert.match(outcome.output, /limits\.fsTimeoutMs = 4000$/m);
  assert.match(
    outcome.output,
    /limits\.maxOutputBytes = 32768 {2}\(default\)$/m,
    "`file` and `config` are both in the answer for one reason: a model that cannot tell an override from a default " +
      "cannot tell the user whose number a refusal came from",
  );
  assert.match(outcome.output, /net\.allowList = \["example\.test","api\.groq\.com"\]$/m);
  assert.match(outcome.output, /provider\.groq\.key = vault:\/\/groq$/m);
  assert.doesNotMatch(
    outcome.output,
    /limits\.fsTimeoutMs = 4000 {2}\(default\)/,
    "the one line the user did write must not be marked as a default",
  );
  assert.equal(instance.writes.length, 0, "a read that wrote would not be `sideEffects: none`");
});

test("config.get with a key answers that key and says whether it came from the file or from D-074", async () => {
  const instance = lab();
  const override = (await instance.tools.run(
    call(CONFIG_GET_TOOL, { key: "limits.fsTimeoutMs" }),
    context(),
  )) as Outcome;
  assert.equal(override.ok, true);
  assert.match(override.output, /^limits\.fsTimeoutMs = 4000\nfrom config\.json\n/);
  const fallback = (await instance.tools.run(
    call(CONFIG_GET_TOOL, { key: "limits.sqliteBusyTimeoutMs" }),
    context(),
  )) as Outcome;
  assert.equal(fallback.ok, true);
  assert.match(
    fallback.output,
    /^limits\.sqliteBusyTimeoutMs = 5000\nfrom a default \(D-074\)\n/,
    "a number the user never wrote is still the number a deadline was enforced with, so it is answered and labelled " +
      "rather than refused as unknown",
  );
  const branch = (await instance.tools.run(
    call(CONFIG_GET_TOOL, { key: "net" }),
    context(),
  )) as Outcome;
  assert.equal(branch.ok, true);
  assert.match(
    branch.output,
    /^net = \{"allowList":\["example\.test","api\.groq\.com"\],"fetchTimeoutMs":20000\}\nfrom config\.json/,
    "a key that holds a branch answers the branch as JSON, because the alternative is a model asking once per leaf",
  );
});

test("a key nobody wrote is a not-found that names the keys beside it", async () => {
  const instance = lab();
  const outcome = (await instance.tools.run(
    call(CONFIG_GET_TOOL, { key: "limits.noop" }),
    context(),
  )) as Outcome;
  assert.equal(
    outcome.ok,
    false,
    "an empty answer would be read as `undefined is a value`, and a model would ask again",
  );
  assert.equal(outcome.code, CONFIG_TOOL_CODES.notFound);
  assert.match(outcome.output, /there is no 'limits\.noop' in this install's configuration/);
  assert.match(
    outcome.output,
    /the keys beside it are fsTimeoutMs, maxOutputBytes, sqliteBusyTimeoutMs/,
    "the useful half of a not-found is what the parent does hold",
  );
  assert.match(
    outcome.output,
    /crabby config schema --json/,
    "and the way to see every key the schema knows",
  );
  const missingBranch = (await instance.tools.run(
    call(CONFIG_GET_TOOL, { key: "retention.days" }),
    context(),
  )) as Outcome;
  assert.equal(missingBranch.code, CONFIG_TOOL_CODES.notFound);
  assert.doesNotMatch(
    missingBranch.output,
    /the keys beside it are/,
    "a path with no parent has no siblings to name, and the sentence says nothing rather than naming an empty list",
  );
});

test("a withheld value is named in the answer and never printed in it", async () => {
  const raw = "gsk_thisIsARawProviderKeyThatShouldNeverBeAnswered";
  const instance = lab({
    document: document({
      file: {
        ...FILE,
        provider: { groq: { baseUrl: "https://api.groq.com/openai/v1", key: raw } },
      },
      config: {
        ...CONFIG,
        provider: { groq: { baseUrl: "https://api.groq.com/openai/v1", key: "[redacted]" } },
      },
      redacted: ["provider.groq.key"],
    }),
  });
  const outcome = (await instance.tools.run(call(CONFIG_GET_TOOL), context())) as Outcome;
  assert.equal(outcome.ok, true);
  assert.doesNotMatch(
    outcome.output,
    new RegExp(raw.slice(0, 12)),
    "§4.2's `config.get` row is secret *names* only, never values, and SECURITY §7 puts that obligation at the " +
      "serializer rather than at the screen — so it holds in a tool answer too, which is a serializer",
  );
  assert.match(outcome.output, /provider\.groq\.key = \[redacted\]/);
  assert.match(
    outcome.output,
    /1 value\(s\) withheld: provider\.groq\.key/,
    "withholding without naming it would leave a model to guess whether the file is broken or the answer is filtered",
  );
  const byKey = (await instance.tools.run(
    call(CONFIG_GET_TOOL, { key: "provider.groq.key" }),
    context(),
  )) as Outcome;
  assert.equal(byKey.ok, true);
  assert.doesNotMatch(
    byKey.output,
    new RegExp(raw.slice(0, 12)),
    "asking for the key by path does not undo the rule",
  );
});

test("config.set hands the sink exactly the key and value, and reports what the write answered", async () => {
  const instance = lab();
  const outcome = (await instance.tools.run(
    call(CONFIG_SET_TOOL, {
      key: "net.allowList",
      value: [
        "example.test",
        "api.groq.com",
        "routify-file-proxy-sg.oss-ap-southeast-1.aliyuncs.com",
      ],
    }),
    context(),
  )) as Outcome;
  assert.equal(outcome.ok, true);
  assert.equal(instance.writes.length, 1);
  assert.equal(instance.writes[0]?.key, "net.allowList");
  assert.deepEqual(instance.writes[0]?.value, [
    "example.test",
    "api.groq.com",
    "routify-file-proxy-sg.oss-ap-southeast-1.aliyuncs.com",
  ]);
  assert.match(outcome.output, /^net\.allowList written to \/tmp\/crabby-state\/config\.json$/m);
  assert.match(outcome.output, /the document's token is now 9d1e0b62c4a7f813/);
  assert.match(
    outcome.output,
    /this Gateway keeps the configuration it loaded at startup — the write applies at the next start/,
    "a switch that silently does not take effect in the running process is the worst kind of wrong answer, so the " +
      "answer says what the write did and did not do",
  );
  const tools = createConfigTools({
    read: () => document(),
    write: () => ({
      ok: true,
      token: "0f2c9a41b7e8d356",
      changed: false,
      path: "/tmp/crabby-state/config.json",
    }),
  });
  const again = (await tools.run(
    call(CONFIG_SET_TOOL, { key: "defaultModel", value: "groq/llama-3.3-70b-versatile" }),
    context(),
  )) as Outcome;
  assert.equal(again.ok, true);
  assert.match(
    again.output,
    /the document already said this, so nothing moved and the token is still 0f2c9a41b7e8d356/,
    "writing the value that is already there is not a change, and saying so is what makes `changed` a fact rather " +
      "than a restatement of success",
  );
});

test("a write the sink refuses arrives with the sink's own code, and a stale one names the document this run read", async () => {
  for (const refusal of [
    {
      code: CONFIG_TOOL_CODES.stale,
      reason: "config.json moved since this read (the token is now 4b8f0d21e6c9a375)",
      expect: /token 0f2c9a41b7e8d356/,
      why:
        "§2's concurrency rule arriving through a tool: the run's own document is named so the model can tell the " +
        "user that somebody else wrote, rather than retrying into the same refusal",
    },
    {
      code: CONFIG_TOOL_CODES.invalid,
      reason: "the schema refuses this document: limits.fsTimeoutMs must be >= 1",
      expect:
        /Nothing was written: §4\.2's `config\.set` row changes the file that decides permissions/,
      why: "a refusal that leaves a half-written file behind is worse than the typo that caused it",
    },
    {
      code: CONFIG_TOOL_CODES.unwritable,
      reason: "config.json is not writable by this process",
      expect: /Nothing was written/,
      why: "the disk's own answer, passed through rather than flattened into a generic failure",
    },
  ] as const) {
    const instance = lab();
    instance.refuseNext = { ok: false, code: refusal.code, reason: refusal.reason };
    const outcome = (await instance.tools.run(
      call(CONFIG_SET_TOOL, { key: "limits.fsTimeoutMs", value: 0 }),
      context(),
    )) as Outcome;
    assert.equal(outcome.ok, false, refusal.why);
    assert.equal(
      outcome.code,
      refusal.code,
      "the executor does not invent a code for a refusal the sink already named",
    );
    assert.match(outcome.output, new RegExp(refusal.reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(outcome.output, refusal.expect, refusal.why);
  }
});

test("an install that composed no configuration reader says so instead of guessing at a document", async () => {
  for (const tool of [CONFIG_GET_TOOL, CONFIG_SET_TOOL] as const) {
    const instance = lab();
    instance.next = undefined;
    const outcome = (await instance.tools.run(
      call(tool, tool === CONFIG_SET_TOOL ? { key: "defaultModel", value: "x" } : {}),
      context(),
    )) as Outcome;
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, CONFIG_TOOL_CODES.unavailable);
    assert.match(outcome.output, /this process composed no configuration reader/);
    assert.match(
      outcome.output,
      /crabby config path/,
      "the absence is reported with the way to end it",
    );
    assert.equal(
      instance.writes.length,
      0,
      "a write sink is never reached when there is no document to write",
    );
  }
});

test("§4.1's three pre-execution refusals: undeclared, malformed, and already aborted", async () => {
  const instance = lab();
  const undeclared = (await instance.tools.run(call("config.delete"), context())) as Outcome;
  assert.equal(undeclared.ok, false);
  assert.equal(undeclared.code, CONFIG_TOOL_CODES.notDeclared);
  assert.match(undeclared.output, /which declares 2: config\.get, config\.set/);
  assert.equal(
    instance.reads,
    0,
    "an undeclared tool is unrunnable rather than tolerant, so no sink is touched",
  );

  const malformed = (await instance.tools.run(
    call(CONFIG_SET_TOOL, { key: "" }),
    context(),
  )) as Outcome;
  assert.equal(malformed.ok, false);
  assert.equal(malformed.code, CONFIG_TOOL_CODES.invalidArguments);
  assert.match(malformed.output, /arguments its own schema rejects/);
  const missingValue = (await instance.tools.run(
    call(CONFIG_SET_TOOL, { key: "defaultModel" }),
    context(),
  )) as Outcome;
  assert.equal(missingValue.code, CONFIG_TOOL_CODES.invalidArguments);
  assert.match(
    missingValue.output,
    /value/,
    "a write with no value is a deletion, and this tool does not delete: the schema says so before the sink is asked",
  );
  const extra = (await instance.tools.run(
    call(CONFIG_GET_TOOL, { key: "limits", token: "anything" }),
    context(),
  )) as Outcome;
  assert.equal(extra.code, CONFIG_TOOL_CODES.invalidArguments);
  assert.match(
    extra.output,
    /token/,
    "a token in the arguments is refused at the door: D-099's rule is that a declared field is never an authority, so " +
      "the concurrency token is read and presented by the sink and never accepted from a caller",
  );
  assert.equal(instance.reads, 0, "argument checking happens before the document is read");

  const controller = new AbortController();
  controller.abort();
  const aborted = (await instance.tools.run(
    call(CONFIG_GET_TOOL),
    context(controller.signal),
  )) as Outcome;
  assert.equal(aborted.ok, false);
  assert.equal(aborted.code, CONFIG_TOOL_CODES.aborted);
  assert.match(aborted.output, /before it touched the configuration \(§6\.1's step 2\)/);
  assert.equal(
    instance.reads,
    0,
    "a cancellation is honoured before the act, which is what makes `none` a promise",
  );
});

test("an answer bigger than the cap is cut and says where the whole document is", async () => {
  const models: Record<string, unknown> = {};
  for (let index = 0; index < 400; index += 1)
    models[`model-${index}`] = {
      contextWindow: 128_000,
      supportsTools: true,
      notes: "a descriptor long enough that four hundred of them exceed any cap this build sets",
    };
  const instance = lab({
    document: document({
      config: {
        ...CONFIG,
        provider: { groq: { baseUrl: "https://api.groq.com/openai/v1", models } },
      },
      file: { ...FILE, provider: { groq: { models } } },
    }),
    limits: { maxOutputBytes: 512 },
  });
  const outcome = (await instance.tools.run(call(CONFIG_GET_TOOL), context())) as Outcome;
  assert.equal(outcome.ok, true);
  assert.ok(
    Buffer.byteLength(outcome.output, "utf8") < 1_024,
    `the cap is 512 and the answer is ${Buffer.byteLength(outcome.output, "utf8")} bytes, so the render was cut`,
  );
  assert.match(
    outcome.output,
    /\[cut at \d+ of \d+ bytes: the whole document is \/tmp\/crabby-state\/config\.json/,
    "D-064's overflow rule is a scratch copy for bytes that exist nowhere else; a configuration render is a view of a " +
      "file that is already on disk, so the note names the file instead of writing a second copy of it",
  );
  assert.ok(
    outcome.output.includes("provider.groq.models"),
    "`provider.<id>.models.<model>` is a document of its own, so the leaves stop at the model and render it as JSON",
  );
});

test("a file the schema has problems with still answers, and the problems are named in the answer", async () => {
  const instance = lab({
    document: document({
      problems: [{ path: "limits.fsTimeoutMs", message: "must be >= 1", kind: "invalid" }],
    }),
  });
  const outcome = (await instance.tools.run(call(CONFIG_GET_TOOL), context())) as Outcome;
  assert.equal(
    outcome.ok,
    true,
    "a bad leaf is not a reason to refuse to run (loadConfig's rule 2)",
  );
  assert.match(outcome.output, /1 problem\(s\) the schema names: limits\.fsTimeoutMs must be >= 1/);
  const written = (await instance.tools.run(
    call(CONFIG_SET_TOOL, { key: "defaultModel", value: "groq/llama-3.1-8b-instant" }),
    context(),
  )) as Outcome;
  assert.equal(written.ok, true);
  assert.match(
    written.output,
    /the file still carries 1 problem\(s\) the schema names/,
    "a write that succeeds over a document the schema dislikes says so, because `changed` is not the same claim as " +
      "`valid` and a model that conflates them will tell the user their settings are fine",
  );
});

test("no file yet is an honest answer rather than an invented document", async () => {
  const instance = lab({
    document: document({ file: {}, config: CONFIG, exists: false, token: "e3b0c44298fc1c14" }),
  });
  const outcome = (await instance.tools.run(call(CONFIG_GET_TOOL), context())) as Outcome;
  assert.equal(outcome.ok, true);
  assert.match(
    outcome.output,
    /^no file yet at \/tmp\/crabby-state\/config\.json; token e3b0c44298fc1c14/,
  );
  assert.match(
    outcome.output,
    /limits\.maxOutputBytes = 32768 {2}\(default\)/,
    "every value is a default when nothing was written, which is exactly what the labels say",
  );
});
