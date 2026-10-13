// §4.4's three `/config` paths over real HTTP, plus §4.2's two configuration rows inside a real run.
//
// The routes are asserted on a Gateway that composed a runner and on one that did not, and the split matters: a settings
// read has to work when a provider is broken or absent, because "why did that need approving" is the question a user asks
// precisely then. What only a runner can answer is the other half of the slice — that `config.get` really runs at T0 with
// no capability behind it, and that `config.set` really parks at a T3 approval this build has no interface to sign
// (D-085 confines a T3 signature to the TUI and the Web control UI, and M3 brings those). Shipping the T3 row without
// that second assertion would be shipping a tool whose price is a sentence in a table.
//
// The token is the third subject here, and it is §2's concurrency row applied to a file rather than to a row: absent
// `If-Match` is a validation answer that names the header, a token the file no longer carries is a conflict that names
// both tokens, and a document the schema refuses is checked *before* the token so that a client told "stale" cannot
// re-read and submit the same invalid document again (D-107).
//
// What is *not* asserted here, and why: the executor's own rendering — one line per leaf, a not-found that names the keys
// beside it, the bound on a long answer — is `packages/tools/config-tools.test.ts`, against sinks a test can tell what to
// answer; and the token's derivation (canonical form, compare-and-swap, the three refusals) is `packages/core/core.test.ts`,
// against a file a test can move between the read and the write. This file composes them and asks whether the composition
// is one document with one token.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { createScriptedProvider } from "@crabby/agent-runtime/loop-harness";
import {
  type ConfigReadBody,
  type ConfigWriteBody,
  isTerminal,
  type TaskRecord,
} from "@crabby/api-contracts";
import {
  applyConfigKey,
  type ConfigFile,
  configDocument,
  configSchema,
  createLogger,
  LIMITS_DEFAULTS,
  loadConfig,
  writeConfig,
} from "@crabby/core";
import { buildApp, createClient, type GatewayClient } from "@crabby/gateway";
import { dataLayout, homeDirectory } from "@crabby/platform";
import { capabilitiesFor } from "@crabby/policy";
import { composeProviders, FAKE_TOOL_MODEL_ID, type FakeStep } from "@crabby/providers";
import {
  migrate,
  mintPairingCode,
  openDatabase,
  readEvents,
  redeemPairingCode,
  type SqliteDb,
  taskScratch,
} from "@crabby/storage";
import {
  CONFIG_GET_TOOL,
  CONFIG_SET_TOOL,
  combineToolSurfaces,
  createConfigTools,
  createFileTools,
  defaultRealpathOf,
} from "@crabby/tools";

interface Harness {
  readonly cli: GatewayClient;
  readonly db: SqliteDb;
  readonly url: string;
  readonly token: string;
  readonly configPath: string;
  /** Every line the Gateway's logger wrote, as JSON. Captured because §7's obligation is at the serializer and a log
   *  file is one: the audit line a config write makes is asserted below rather than trusted. */
  readonly log: string[];
  close(): Promise<void>;
}

async function boot(options: {
  /** The document written to `config.json` before the listener opens. Absent means no file at all, which is the state
   *  a fresh install is in and an answer that has to be honest about. */
  readonly seed?: Record<string, unknown> | undefined;
  readonly rounds?: readonly (readonly FakeStep[])[] | undefined;
  readonly noRunner?: boolean | undefined;
}): Promise<Harness> {
  const dir = mkdtempSync(path.join(tmpdir(), "crabby-config-"));
  const layout = dataLayout(dir);
  mkdirSync(layout.stateDir, { recursive: true, mode: 0o700 });
  if (options.seed !== undefined)
    writeFileSync(layout.configPath, JSON.stringify(options.seed, null, 2));
  // A sibling of the data dir and never inside it: §8's deny-list refuses everything under `dataDir`.
  const root = mkdtempSync(path.join(tmpdir(), "crabby-config-work-"));
  mkdirSync(root, { recursive: true });

  const lines: string[] = [];
  const handle = openDatabase(path.join(dir, "crabby.sqlite3"));
  migrate(handle.db);
  const paths = { home: homeDirectory(), dataDir: layout.stateDir, roots: [root] };
  const files = createFileTools({ paths, scratchDirFor: (taskId) => taskScratch(layout, taskId) });

  // `apps/cli/commands/gateway.ts`'s composition, mirrored rather than approximated: the read sink is the same
  // `configDocument` the route answers from, and the write sink owns the read-modify-write and the token that goes with
  // it, because D-099's rule about a declared field is that a token a caller could choose would be a write aimed at a
  // document nobody read.
  const configTools = createConfigTools({
    read: () => configDocument(layout),
    write: ({ key, value }) => {
      const before = loadConfig(layout);
      const written = writeConfig(
        layout,
        applyConfigKey(before.file, key, value) as ConfigFile,
        undefined,
        { token: before.token },
      );
      if (!written.ok)
        return {
          ok: false as const,
          code: written.code ?? ("unwritable" as const),
          reason: written.message,
        };
      const after = loadConfig(layout);
      return {
        ok: true as const,
        token: after.token,
        changed: before.token !== after.token,
        path: layout.configPath,
      };
    },
    limits: loadConfig(layout).limits,
  });
  const composed = options.noRunner ? undefined : combineToolSurfaces([files, configTools]);
  const drive =
    composed === undefined
      ? undefined
      : {
          tools: composed,
          provider: createScriptedProvider(options.rounds ?? []),
          modelId: FAKE_TOOL_MODEL_ID,
          ctx: { paths, realpathOf: defaultRealpathOf },
        };

  const built = await buildApp({
    db: handle.db,
    layout,
    providers: composeProviders({
      local: {
        baseUrl: "http://127.0.0.1:8080/v1",
        models: {
          "qwen2.5:3b": {
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
          },
        },
      },
    }),
    log: createLogger({ level: "info", write: (line) => lines.push(line) }, "config-test"),
    version: "test",
    startedAt: new Date(),
    listenerMode: "local",
    declares: composed === undefined ? files.declares : composed.declares,
    ...(drive === undefined ? {} : { drive }),
  });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const address = built.app.server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const url = `http://127.0.0.1:${port}`;

  const minted = mintPairingCode(handle.db, {
    name: "the owner",
    interface: "cli",
    capabilities: capabilitiesFor("cli"),
  });
  const redeemed = redeemPairingCode(handle.db, minted.code);
  assert.ok(redeemed.ok && redeemed.token, "the harness's identity has to pair");
  const token = redeemed.token as string;
  return {
    cli: createClient({ url, token }),
    db: handle.db,
    url,
    token,
    configPath: layout.configPath,
    log: lines,
    async close() {
      built.scheduler?.shutdown();
      // D-066's order: runs settle before the listener and before SQLite. A run this file parks at a T3 approval is
      // still open when the assertions end, so the drain is what makes the teardown a fact rather than a race.
      await built.runner?.shutdown(5_000);
      await built.app.close();
      handle.close();
    },
  };
}

interface Answer {
  readonly status: number;
  readonly etag: string | null;
  readonly body: unknown;
}

async function raw(
  h: Harness,
  route: string,
  init: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    token?: string | null;
  } = {},
): Promise<Answer> {
  const response = await fetch(`${h.url}${route}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.token === null ? {} : { authorization: `Bearer ${init.token ?? h.token}` }),
      "content-type": "application/json; charset=utf-8",
      ...init.headers,
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    etag: response.headers.get("etag"),
    body: text.length === 0 ? null : JSON.parse(text),
  };
}

interface ErrorEnvelope {
  readonly error: {
    readonly class: string;
    readonly code: string;
    readonly message: string;
    readonly details?: { readonly problems?: readonly { path?: string; message?: string }[] };
  };
}

const failureOf = (answer: Answer): ErrorEnvelope["error"] => (answer.body as ErrorEnvelope).error;

const readConfig = async (h: Harness): Promise<{ body: ConfigReadBody; etag: string }> => {
  const answer = await raw(h, "/api/v1/config");
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  return { body: answer.body as ConfigReadBody, etag: answer.etag as string };
};

const putConfig = (
  h: Harness,
  config: Record<string, unknown>,
  ifMatch: string | null | undefined,
): Promise<Answer> =>
  raw(h, "/api/v1/config", {
    method: "PUT",
    body: { config },
    ...(ifMatch === undefined ? {} : { headers: ifMatch === null ? {} : { "if-match": ifMatch } }),
  });

async function untilTerminal(h: Harness, id: string, deadlineMs = 20_000): Promise<TaskRecord> {
  const started = Date.now();
  for (;;) {
    const record = (await h.cli.getTask(id)).body as TaskRecord;
    if (isTerminal(record.state)) return record;
    if (Date.now() - started > deadlineMs) assert.fail(`task ${id} was still \`${record.state}\``);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function untilState(
  h: Harness,
  id: string,
  state: string,
  deadlineMs = 20_000,
): Promise<TaskRecord> {
  const started = Date.now();
  for (;;) {
    const record = (await h.cli.getTask(id)).body as TaskRecord;
    if (record.state === state) return record;
    if (isTerminal(record.state))
      assert.fail(`task ${id} reached \`${record.state}\` before \`${state}\``);
    if (Date.now() - started > deadlineMs) assert.fail(`task ${id} was still \`${record.state}\``);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The `output` a tool call left on the record, found by tool name rather than by step number: which seq a call lands on
 *  depends on how many events the run wrote before it. */
function toolOutput(h: Harness, taskId: string, tool: string): string | undefined {
  for (const event of readEvents(h.db, taskId, { limit: 10_000 })) {
    const payload = event.payload as { tool?: string; output?: string };
    if (
      (event.type === "tool.execution.completed" || event.type === "tool.execution.failed") &&
      payload.tool === tool
    )
      return typeof payload.output === "string" ? payload.output : undefined;
  }
  return undefined;
}

const SEED = {
  defaultModel: "local/qwen2.5:3b",
  limits: { fsTimeoutMs: 9000 },
  net: { allowList: ["example.test"] },
};

describe("GET /api/v1/config", () => {
  it("answers the document a write replaces and the document the process runs on, with §2's token as the etag", async () => {
    const h = await boot({ seed: SEED, noRunner: true });
    try {
      const { body, etag } = await readConfig(h);
      assert.match(
        body.token,
        /^[0-9a-f]{16}$/,
        "sixteen hex characters of SHA-256 over the canonical document",
      );
      assert.equal(
        etag,
        `"${body.token}"`,
        "the entity-tag is the token, quoted because RFC 9110 requires it and an unquoted one is a tag a proxy may " +
          "rewrite — a client that reads the `etag` and a client that reads `token` are holding the same string",
      );
      assert.equal(
        body.path,
        h.configPath,
        "a settings screen that could not show where the file lives would be " +
          "editing a document nobody could find",
      );
      assert.equal(body.exists, true);
      assert.deepEqual(body.problems, []);
      assert.deepEqual(body.redacted, []);
      assert.deepEqual(
        body.file,
        SEED,
        "`file` holds overrides only (docs/DATA_AND_MEMORY.md §4.1), and it is the document `PUT` replaces",
      );
      assert.equal(
        (body.config.limits as Record<string, unknown>).fsTimeoutMs,
        9000,
        "the merged view is what the process runs on, so the override is in it",
      );
      assert.equal(
        (body.config.limits as Record<string, unknown>).providerConnectMs,
        LIMITS_DEFAULTS.providerConnectMs,
        "and so is a D-074 default the file never mentioned — which is the whole reason both views are answered: a " +
          "client showing one of them cannot tell the user whose number a deadline came from",
      );
      assert.deepEqual(
        body.limits,
        { ...LIMITS_DEFAULTS, fsTimeoutMs: 9000 },
        "`limits` is the resolved clock table the process runs on rather than a fourth view of the same file, so a " +
          "client that renders D-074's numbers does not have to merge them itself",
      );
      assert.match(
        body.note,
        /If-Match/,
        "the note tells a client what to present back, because a token with no " +
          "instruction beside it is a token a first client will guess at",
      );
      assert.match(body.note, /next start/, "and what a change does not do to the running process");
    } finally {
      await h.close();
    }
  });

  it("answers 401 to a caller that has not paired, like every other route (§3.2)", async () => {
    const h = await boot({ seed: SEED, noRunner: true });
    try {
      for (const route of ["/api/v1/config", "/api/v1/config/schema"]) {
        const refused = await raw(h, route, { token: null });
        assert.equal(refused.status, 401, `${route} is behind the pairing guard`);
        assert.equal(
          failureOf(refused).class,
          "auth",
          "§6 maps the auth class to 401 whatever the reason",
        );
      }
      const unauthenticated = await raw(h, "/api/v1/config", {
        method: "PUT",
        body: { config: SEED },
        token: null,
      });
      assert.equal(
        unauthenticated.status,
        401,
        "and the writer is behind the same guard as the readers",
      );
      const invented = await putConfig(h, SEED, '"0000000000000000"');
      assert.equal(
        invented.status,
        409,
        "a made-up token is a token for a document that does not exist, so it is " +
          "stale rather than accepted",
      );
    } finally {
      await h.close();
    }
  });

  it("withholds a provider key that is not a `vault://` name, and says it withheld one (§4.2, SECURITY §7)", async () => {
    const raw_ = "gsk_aRawProviderKeyThatMustNeverLeaveThisDevice";
    const h = await boot({
      seed: {
        ...SEED,
        provider: { groq: { baseUrl: "https://api.groq.com/openai/v1", key: raw_ } },
      },
      noRunner: true,
    });
    try {
      const answer = await raw(h, "/api/v1/config");
      assert.equal(answer.status, 200);
      assert.doesNotMatch(
        JSON.stringify(answer.body),
        /gsk_aRawProviderKey/,
        "§4.2's `config.get` row is secret *names* only, never values, and SECURITY §7 puts that obligation at the " +
          "serializer rather than at the screen — a route is a serializer. The case is reachable because `loadConfig`'s " +
          "rule 2 keeps a file with a bad key running and `onlyKnownKeys` is shallow, so the bad leaf survives inside " +
          "its good branch in the view a settings screen edits",
      );
      const body = answer.body as ConfigReadBody;
      assert.deepEqual(
        body.redacted,
        ["provider.groq.key"],
        "named, because withholding without naming it leaves a " +
          "client unable to tell a filtered answer from a broken file",
      );
      assert.equal(
        ((body.file.provider as Record<string, { key?: string }>).groq as { key?: string }).key,
        "[redacted]",
        "withheld in place rather than dropped, so the field the user has to fix is still on the screen",
      );
      assert.equal(
        body.problems.length,
        1,
        "and the defect the schema sees is still reported beside it",
      );
      assert.match(body.note, /withheld/);
    } finally {
      await h.close();
    }
  });

  it("serves the same schema the command prints, because D-060 made the schema an output rather than a conversion", async () => {
    const h = await boot({ seed: SEED, noRunner: true });
    try {
      const answer = await raw(h, "/api/v1/config/schema");
      assert.equal(answer.status, 200);
      const body = answer.body as { schema: Record<string, unknown>; note: string };
      assert.deepEqual(
        body.schema,
        JSON.parse(JSON.stringify(configSchema())) as Record<string, unknown>,
        "one opinion about what a key may be, printed by `crabby config schema --json` and served by this route — a " +
          "route that transcribed what a command says would be a second opinion with the same name. Compared as JSON " +
          "because that is what a route can carry: D-060's schema is a typebox object in the process and a JSON Schema " +
          "on the wire, and the symbols that make it the first are exactly what the second does not have",
      );
      assert.equal(body.schema.type, "object");
      const properties = body.schema.properties as Record<string, unknown>;
      for (const section of ["defaultModel", "limits", "net", "provider", "workspace"])
        assert.ok(properties[section] !== undefined, `the schema names \`${section}\``);
      assert.match(
        body.note,
        /PUT \/config/,
        "the note says which writers refuse a document with it, so a client can " +
          "validate before it writes instead of learning from a 400",
      );
    } finally {
      await h.close();
    }
  });
});

describe("PUT /api/v1/config", () => {
  it("refuses a write with no If-Match and names the header that is missing (§2)", async () => {
    const h = await boot({ seed: SEED, noRunner: true });
    try {
      const refused = await putConfig(h, { ...SEED, defaultModel: "local/other" }, undefined);
      assert.equal(refused.status, 400);
      assert.equal(
        failureOf(refused).code,
        "if_match_required",
        "a distinct code rather than `validation_failed`: " +
          "the fix is not in the body, and a client that reads the code can act — read the document, take its etag, send " +
          "it back",
      );
      assert.equal(failureOf(refused).class, "validation");
      assert.match(failureOf(refused).message, /If-Match/);
      assert.deepEqual(
        JSON.parse(readFileSync(h.configPath, "utf8")),
        SEED,
        "a refused write changed nothing",
      );
    } finally {
      await h.close();
    }
  });

  it("refuses an If-Match it cannot compare, and the problem names the header rather than the body", async () => {
    const h = await boot({ seed: SEED, noRunner: true });
    try {
      const refused = await putConfig(h, SEED, '"3"');
      assert.equal(refused.status, 400);
      assert.equal(failureOf(refused).class, "validation");
      assert.equal(
        failureOf(refused).details?.problems?.[0]?.path,
        "if-match",
        "a session revision is D-104's integer and a config token is a hash, so `parseIfMatch` cannot be reused and " +
          "the refusal has to say which shape this route wanted",
      );
      assert.match(failureOf(refused).message, /etag/);
      const accepted = await putConfig(h, SEED, `W/"${(await readConfig(h)).body.token}"`);
      assert.equal(
        accepted.status,
        200,
        "a weak comparator is accepted and its weakness ignored: the comparison is of two hashes of one file, so there " +
          "is no byte-level equality left to weaken",
      );
    } finally {
      await h.close();
    }
  });

  it("writes the document the caller read, answers with the token it now carries, and says a restart is what applies it", async () => {
    const h = await boot({ seed: SEED, noRunner: true });
    try {
      const first = await readConfig(h);
      const next = {
        ...SEED,
        limits: { fsTimeoutMs: 12000 },
        net: { allowList: ["example.test", "api.example.org"] },
      };
      const written = await putConfig(h, next, `"${first.body.token}"`);
      assert.equal(written.status, 200, JSON.stringify(written.body));
      const body = written.body as ConfigWriteBody;
      assert.equal(body.changed, true);
      assert.notEqual(
        body.token,
        first.body.token,
        "the document moved, so the token moved with it",
      );
      assert.equal(
        written.etag,
        `"${body.token}"`,
        "the answer carries the next token, so a client that writes twice does not have to read between them",
      );
      assert.deepEqual(
        body.file,
        next,
        "`PUT` replaces the whole document, which is why the body is the document and " +
          "not a patch — a partial write to the file that decides permissions would be a partial answer about them",
      );
      assert.deepEqual(
        JSON.parse(readFileSync(h.configPath, "utf8")),
        next,
        "and the file on disk says the same",
      );
      assert.match(
        body.note,
        /limits\.fsTimeoutMs, net\.allowList changed/,
        "the keys that moved are named",
      );
      assert.match(
        body.note,
        /next start/,
        "`changed` is also the restart flag, because this Gateway composed its providers, its workspace roots, its " +
          "limits and its egress allow-list at startup: one fact seen from two sides, and a second field would only " +
          "ever repeat it",
      );
      const after = await readConfig(h);
      assert.equal(
        after.body.token,
        body.token,
        "a re-read agrees, which is what makes the token a version",
      );
    } finally {
      await h.close();
    }
  });

  it("answers `changed: false` for a write that says what the file already said", async () => {
    const h = await boot({ seed: SEED, noRunner: true });
    try {
      const first = await readConfig(h);
      const written = await putConfig(h, SEED, `"${first.body.token}"`);
      assert.equal(written.status, 200);
      const body = written.body as ConfigWriteBody;
      assert.equal(
        body.changed,
        false,
        "nothing moved, so there is nothing to restart for and no banner to show",
      );
      assert.equal(body.token, first.body.token);
      assert.equal(written.etag, `"${first.body.token}"`);
      assert.match(body.note, /no change/);
    } finally {
      await h.close();
    }
  });

  it("refuses a stale token with both tokens named, and leaves the file as the winner wrote it (D-107)", async () => {
    const h = await boot({ seed: SEED, noRunner: true });
    try {
      const read = await readConfig(h);
      const winner = await putConfig(
        h,
        { ...SEED, defaultModel: "local/qwen2.5:7b" },
        `"${read.body.token}"`,
      );
      assert.equal(winner.status, 200);
      const winnerToken = (winner.body as ConfigWriteBody).token;

      const loser = await putConfig(
        h,
        { ...SEED, defaultModel: "local/something-else" },
        `"${read.body.token}"`,
      );
      assert.equal(loser.status, 409, "§6 maps the conflict class to 409");
      assert.equal(failureOf(loser).code, "config_stale");
      assert.equal(failureOf(loser).class, "conflict");
      assert.match(
        failureOf(loser).message,
        new RegExp(read.body.token),
        "the token the caller presented",
      );
      assert.match(
        failureOf(loser).message,
        new RegExp(winnerToken),
        "and the one the file now carries: a refusal " +
          "that named neither would leave a client unable to tell whether it read the wrong file or the wrong install",
      );
      assert.deepEqual(
        JSON.parse(readFileSync(h.configPath, "utf8")).defaultModel,
        "local/qwen2.5:7b",
        "the write that won the race is still the document on disk, and the write that lost changed nothing — which is " +
          "the whole of §2's row: two interfaces editing one configuration do not silently overwrite each other",
      );

      const retry = await putConfig(
        h,
        { ...SEED, defaultModel: "local/something-else" },
        `"${winnerToken}"`,
      );
      assert.equal(
        retry.status,
        200,
        "and the fix the refusal names — read again, write again — works",
      );
    } finally {
      await h.close();
    }
  });

  it("checks the document against the schema before it compares the token, so a stale answer cannot send a client in a circle", async () => {
    const h = await boot({ seed: SEED, noRunner: true });
    try {
      const read = await readConfig(h);
      await putConfig(h, { ...SEED, defaultModel: "local/qwen2.5:7b" }, `"${read.body.token}"`);
      const invalid = await putConfig(
        h,
        { limits: { fsTimeoutMs: "soon" } },
        `"${read.body.token}"`,
      );
      assert.equal(invalid.status, 400);
      assert.equal(
        failureOf(invalid).code,
        "config_invalid",
        "the caller's document is refused as a validation answer even though the token is also stale: a client told " +
          "`stale` would re-read and submit the same invalid document again, so the answer that names a defect it can " +
          "fix comes first",
      );
      assert.equal(failureOf(invalid).class, "validation");
      assert.match(failureOf(invalid).message, /fsTimeoutMs/);
      const notADocument = await raw(h, "/api/v1/config", {
        method: "PUT",
        body: { config: [], extra: true },
        headers: { "if-match": `"${read.body.token}"` },
      });
      assert.equal(
        notADocument.status,
        400,
        "and a body that is not the contract is refused by the route's own schema " +
          "before the writer sees it (§4.4's first step)",
      );
    } finally {
      await h.close();
    }
  });

  it("decides on the token and not on a grant: the route is the user's act, and T3 is the price of a model asking (F-52)", async () => {
    const h = await boot({ seed: SEED, noRunner: true });
    try {
      // The premise, stated rather than assumed: a paired CLI identity holds `config.write`, so there is no missing
      // capability for the arbiter to refuse on — and a route has an identity but no `PolicySubject`, which is the seam
      // D-097's migration is what closes.
      assert.ok(capabilitiesFor("cli").includes("config.write"));
      const written = await putConfig(
        h,
        { ...SEED, defaultModel: "local/qwen2.5:7b" },
        `"${(await readConfig(h)).body.token}"`,
      );
      assert.equal(
        written.status,
        200,
        "a settings route answers on the token, not on a tier: the T3 in §4.2's `config.set` row is the price of a " +
          "*model* asking to change the file that decides permissions, and D-084's rule is that only the loop opens an " +
          "approval. The user's own interface writing the user's own configuration is the act the row exists to gate, " +
          "not a caller of it",
      );
      assert.equal((written.body as ConfigWriteBody).changed, true);
    } finally {
      await h.close();
    }
  });

  it("audits the write with the keys that moved and never a value, and keeps the one token a log may print (§7)", async () => {
    const h = await boot({ seed: SEED, noRunner: true });
    try {
      const read = await readConfig(h);
      const written = await putConfig(
        h,
        {
          ...SEED,
          limits: { fsTimeoutMs: 12000 },
          net: { allowList: ["example.test", "api.example.org"] },
        },
        `"${read.body.token}"`,
      );
      assert.equal(written.status, 200, JSON.stringify(written.body));
      const record = h.log
        .map((line) => JSON.parse(line) as { msg: string; fields?: Record<string, unknown> })
        .find((entry) => entry.msg === "config written");
      assert.ok(
        record,
        "a write to the file that decides permissions is an audited act, not a quiet one",
      );
      const fields = record.fields ?? {};
      assert.equal(fields.changed, true);
      assert.equal(
        fields.keys,
        "limits.fsTimeoutMs, net.allowList",
        "key *paths*, because §3.7 is why a configuration value is not a log field: a log file that carried the values " +
          "would be a second copy of the document, readable by anything that can read the log",
      );
      assert.doesNotMatch(
        JSON.stringify(fields),
        /api\.example\.org/,
        "and no value the document holds appears anywhere in the line",
      );
      assert.equal(
        fields.etag,
        (written.body as ConfigWriteBody).token,
        "the token does survive the log, under a name the shared scrub does not claim: a field called `token` reaches a " +
          "log file as `[redacted]`, because `redact` masks any string under a key that looks like a credential — and " +
          "this line is the only record of which document a write produced, which is where D-107 sends a reader asking " +
          "which of two writers was newer. A config token is a hash of a document the client already holds, so the " +
          "honest fix is the field name and not a weaker scrub",
      );
      assert.equal(
        fields.via,
        "cli",
        "§14's attribution: the act belongs to an identity and an interface, not to 'a request'",
      );
      assert.equal(typeof fields.by, "string", "and to the client that performed it");
    } finally {
      await h.close();
    }
  });
});

describe("§4.2's two configuration rows inside a run", () => {
  it("runs `config.get` at T0 with no approval and answers from the file the process runs on", async () => {
    const h = await boot({
      seed: SEED,
      rounds: [
        [{ kind: "tool-call", name: CONFIG_GET_TOOL, arguments: { key: "limits.fsTimeoutMs" } }],
        [{ kind: "text", text: "the timeout is in the answer above" }],
      ],
    });
    try {
      const created = await h.cli.createTask(
        { objective: "why did that read time out" },
        "config-1",
      );
      const task = created.body as TaskRecord;
      const done = await untilTerminal(h, task.id);
      assert.equal(
        done.state,
        "completed",
        "a T0 read needs no capability and no prompt, so the run finishes",
      );
      const output = toolOutput(h, task.id, CONFIG_GET_TOOL);
      assert.match(
        output ?? "",
        /limits\.fsTimeoutMs = 9000/,
        "the number the process enforces with, not a copy of " +
          "the schema's default — which is why the sink reads the file at call time rather than the startup copy",
      );
      assert.match(
        output ?? "",
        /from config\.json/,
        "and labelled as the user's override rather than as D-074",
      );
      const pending = (await h.cli.approvals({ state: "pending" })).body as { items: unknown[] };
      assert.equal(
        pending.items.length,
        0,
        "no approval was opened for it: §4.2's own words are " +
          "`config.write`-independent read, which is a statement that it needs no capability",
      );
      assert.equal(
        readEvents(h.db, task.id, { limit: 10_000 }).filter(
          (event) => event.type === "tool.execution.blocked",
        ).length,
        0,
        "and nothing was refused on the way",
      );
    } finally {
      await h.close();
    }
  });

  it("parks `config.set` at a T3 approval this build has no interface to sign, and the file does not move (D-085)", async () => {
    const h = await boot({
      seed: SEED,
      rounds: [
        [
          {
            kind: "tool-call",
            name: CONFIG_SET_TOOL,
            arguments: { key: "net.allowList", value: ["example.test", "anything.example"] },
          },
        ],
        [{ kind: "text", text: "never reached: the T3 call parks the run" }],
      ],
    });
    try {
      const created = await h.cli.createTask(
        { objective: "add a host to the allow-list for me" },
        "config-2",
      );
      const task = created.body as TaskRecord;
      const parked = await untilState(h, task.id, "awaiting_approval");
      assert.equal(
        parked.state,
        "awaiting_approval",
        "§4.2 prices `config.set` at T3 because it includes changing permissions, roots or retention, and the arbiter " +
          "asks before the executor is reached (D-084: only the loop opens an approval)",
      );
      const queue = (await h.cli.approvals({ state: "pending" })).body as {
        items: { id: string; request: { tier: string; tool: string; exact?: string } }[];
      };
      const row = queue.items.find((item) => item.request.tool === CONFIG_SET_TOOL);
      assert.ok(row, "the prompt exists and names the tool");
      assert.equal(
        row?.request.tier,
        "T3",
        "the row's own price, arrived at from the registry and read back to the user",
      );

      const refused = await raw(h, `/api/v1/approvals/${row?.id}/decision`, {
        method: "POST",
        body: { decision: "approve" },
      });
      assert.equal(refused.status, 403);
      assert.equal(
        failureOf(refused).code,
        "approval_surface-not-allowed",
        "the arbiter's own code, with the route's prefix: a refusal this specific is one a client can render rather " +
          "than paraphrase",
      );
      assert.match(
        failureOf(refused).message,
        /§6\.2/,
        "D-085 confines a T3 signature to the TUI and the Web control UI, and M2 has neither — so on this build the " +
          "request parks rather than runs. That is the rule working, and the refusal says it instead of leaving a user " +
          "to infer it from a task that never finishes",
      );
      const stillPending = (await h.cli.approvals({ state: "pending" })).body as {
        items: { id: string; state: string }[];
      };
      assert.equal(
        stillPending.items.find((item) => item.id === row?.id)?.state,
        "pending",
        "a refusal from the wrong surface neither consumes the row nor expires it: the TUI is still expected to answer " +
          "this one when M3 brings it",
      );
      assert.deepEqual(
        JSON.parse(readFileSync(h.configPath, "utf8")),
        SEED,
        "and the file that decides permissions is exactly as it was, which is the point of pricing it at T3 rather than " +
          "letting a model widen its own egress allow-list mid-run",
      );
    } finally {
      await h.close();
    }
  });

  it("answers an install with no configuration file at all rather than inventing one", async () => {
    const h = await boot({ noRunner: true });
    try {
      const { body, etag } = await readConfig(h);
      assert.equal(
        body.exists,
        false,
        "no file yet is a state a fresh install is in, and an answer that hid it would " +
          "be an answer about a document that does not exist",
      );
      assert.equal(body.path, h.configPath);
      assert.deepEqual(body.file, {});
      assert.equal(
        (body.config.limits as Record<string, unknown>).fsTimeoutMs,
        LIMITS_DEFAULTS.fsTimeoutMs,
        "every value is a default, and the merged view says so by holding nothing else",
      );
      assert.equal(
        etag,
        `"${body.token}"`,
        "the empty document has a token too, because a first write is still a " +
          "write somebody may have raced",
      );
      const written = await putConfig(h, { defaultModel: "local/qwen2.5:3b" }, `"${body.token}"`);
      assert.equal(written.status, 200);
      assert.equal((written.body as ConfigWriteBody).changed, true);
      assert.deepEqual(JSON.parse(readFileSync(h.configPath, "utf8")), {
        defaultModel: "local/qwen2.5:3b",
      });
    } finally {
      await h.close();
    }
  });
});

// Sockets opened by `fetch` outlive the tests that opened them, and an open handle keeps `node --test` alive after its
// last assertion has passed.
after(() => {
  const global = (globalThis as unknown as Record<symbol, { close?: () => Promise<void> }>)[
    Symbol.for("undici.globalDispatcher.1")
  ];
  if (global !== undefined && typeof global.close === "function") void global.close();
});
