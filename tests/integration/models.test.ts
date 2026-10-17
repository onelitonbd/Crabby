// §4.4's two `/models` paths over real HTTP — the HTTP half of §3.8's override story, and the third face of D-127's
// one storage step (`crabby model edit` and the Gateway's route land on the same `writeOverrideRecord`).
//
// The assertions follow the file's own subject: `GET /models` answers the *difference* §3.8 exists to serve —
// effective, reported, override and provenance side by side, with a disabled entry named rather than hidden — and
// `PUT …/overrides` is `crabby model edit` over a wire: the same `If-Match` rule, the same refusals with their own
// codes (unknown provider, unknown model, an unparsable stored record that offers the clear), the same answer shape
// ("what moved", not "what was typed"), and composition's own gate applied after the write, so a ceiling that does not
// fit is the user's file changed and composition's reason beside it.
//
// What is *not* asserted here: the record rules themselves (`packages/providers/override-write.test.ts` holds them —
// `auto` clears, an empty record is not stored, a restatement is not a change) and the CLI verb's half
// (`apps/cli/commands/model-edit.test.ts`). This file asks whether the composition of the three is one document with
// one writer.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { type ConfigFile, createLogger } from "@crabby/core";
import { buildApp } from "@crabby/gateway";
import { dataLayout } from "@crabby/platform";
import { capabilitiesFor } from "@crabby/policy";
import { composeProviders } from "@crabby/providers";
import { migrate, mintPairingCode, openDatabase, redeemPairingCode } from "@crabby/storage";

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
} as const;

/** A config with one healthy entry and one entry whose descriptor cannot parse (D-100's disabled case), so both row
 *  shapes of `GET /models` have something true to answer from. */
function seed(overrides: Record<string, unknown> = {}): ConfigFile {
  return {
    provider: {
      local: {
        baseUrl: "http://127.0.0.1:8080/v1",
        models: { "qwen2.5:3b": DESCRIPTOR },
        ...(Object.keys(overrides).length === 0 ? {} : { overrides }),
      },
      broken: {
        baseUrl: "http://127.0.0.1:8080/v1",
        models: { "qwen2.5:3b": { contextWindow: "lots" } },
      },
    },
  } as unknown as ConfigFile;
}

interface Harness {
  readonly url: string;
  readonly token: string;
  readonly configPath: string;
  close(): Promise<void>;
}

async function boot(
  options: { readonly document?: ConfigFile | undefined } = {},
): Promise<Harness> {
  const dir = mkdtempSync(path.join(tmpdir(), "crabby-models-"));
  const layout = dataLayout(dir);
  mkdirSync(layout.stateDir, { recursive: true, mode: 0o700 });
  if (options.document !== undefined)
    writeFileSync(layout.configPath, JSON.stringify(options.document, null, 2));

  const handle = openDatabase(path.join(dir, "crabby.sqlite3"));
  migrate(handle.db);
  const built = await buildApp({
    db: handle.db,
    layout,
    providers: composeProviders(options.document?.provider ?? {}),
    log: createLogger({ level: "error", write: () => {} }, "models-test"),
    version: "test",
    startedAt: new Date(),
    listenerMode: "local",
  });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const address = built.app.server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  const minted = mintPairingCode(handle.db, {
    name: "the owner",
    interface: "cli",
    capabilities: capabilitiesFor("cli"),
  });
  const redeemed = redeemPairingCode(handle.db, minted.code);
  assert.ok(redeemed.ok && redeemed.token, "the harness's identity has to pair");
  return {
    url: `http://127.0.0.1:${port}`,
    token: redeemed.token as string,
    configPath: layout.configPath,
    async close() {
      await built.app.close();
      handle.close();
    },
  };
}

interface Answer {
  readonly status: number;
  readonly etag: string | null;
  readonly body: any;
}

async function raw(
  h: Harness | undefined,
  route: string,
  init: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    token?: string | null;
  } = {},
): Promise<Answer> {
  if (h === undefined) throw new Error("the harness is not booted");
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

function storedFile(h: Harness | undefined): Record<string, any> {
  if (h === undefined) throw new Error("the harness is not booted");
  return JSON.parse(readFileSync(h.configPath, "utf8")) as Record<string, any>;
}

describe("§4.4's GET /models — the difference §3.8 exists to serve, in one body", () => {
  // Every boot is tracked and every boot is closed: a listener that outlives its test is an active handle the
  // runner's process cannot exit under, and a sweep that hangs is a worse answer than a sweep that fails.
  const open: Harness[] = [];
  after(async () => {
    for (const h of open) await h.close();
    open.length = 0;
  });

  it("answers effective, reported, override and provenance side by side, and names a disabled entry", async () => {
    open.push(
      await boot({
        document: seed({
          "qwen2.5:3b": { source: "manual", supports: { toolCalling: false }, notes: "flaky" },
        }),
      }),
    );
    const answer = await raw(open.at(-1), "/api/v1/models");
    assert.equal(answer.status, 200);
    const composed = answer.body.providers.find((row: any) => row.id === "local");
    assert.ok(composed, "the healthy entry has a row");
    const model = composed.models[0];
    assert.equal(model.effective.supports.toolCalling, false, "effective carries the override");
    assert.equal(model.reported.supports.toolCalling, true, "reported is the endpoint's claim");
    assert.equal(model.override.source, "manual");
    assert.equal(model.provenance.supports.toolCalling.to, false);
    const broken = answer.body.providers.find((row: any) => row.id === "broken");
    assert.equal(broken.state, "disabled");
    assert.match(
      broken.reason,
      /qwen2\.5:3b/,
      "the reason names the model whose descriptor failed",
    );
  });

  it("?provider= filters to one entry", async () => {
    const answer = await raw(open.at(-1), "/api/v1/models?provider=broken");
    assert.equal(answer.status, 200);
    assert.equal(answer.body.providers.length, 1);
    assert.equal(answer.body.providers[0].id, "broken");
  });
});

describe("§4.4's PUT /models/{provider}/{model}/overrides — `crabby model edit` over a wire", () => {
  const open: Harness[] = [];
  after(async () => {
    for (const h of open) await h.close();
    open.length = 0;
  });

  it("demands If-Match, and a stale token is a conflict that names both", async () => {
    open.push(await boot({ document: seed() }));
    const noToken = await raw(open.at(-1), "/api/v1/models/local/qwen2.5:3b/overrides", {
      method: "PUT",
      body: { supports: { toolCalling: "true" } },
      headers: {},
    });
    assert.equal(noToken.status, 400);
    assert.equal((noToken.body as any).error.code, "if_match_required");

    const read = await raw(open.at(-1), "/api/v1/config");
    const stale = await raw(open.at(-1), "/api/v1/models/local/qwen2.5:3b/overrides", {
      method: "PUT",
      body: { supports: { toolCalling: "true" } },
      headers: { "if-match": '"deadbeefdeadbeef"' },
    });
    assert.equal(stale.status, 409);
    assert.equal((stale.body as any).error.code, "config_stale");
    assert.ok(read.status === 200, "the read the client should repeat worked");
  });

  it("refuses a provider or model the document does not declare, each with its own code", async () => {
    open.push(await boot({ document: seed() }));
    const read = await raw(open.at(-1), "/api/v1/config");
    const etag = read.etag as string;
    const noProvider = await raw(open.at(-1), "/api/v1/models/groq/llama-3/overrides", {
      method: "PUT",
      body: { clear: true },
      headers: { "if-match": etag },
    });
    assert.equal(noProvider.status, 404);
    assert.equal((noProvider.body as any).error.code, "provider_unknown");
    const noModel = await raw(open.at(-1), "/api/v1/models/local/llama-3/overrides", {
      method: "PUT",
      body: { clear: true },
      headers: { "if-match": etag },
    });
    assert.equal(noModel.status, 404);
    assert.equal((noModel.body as any).error.code, "model_unknown");
  });

  it("writes the sibling record, answers what moved, and the file says so", async () => {
    open.push(await boot({ document: seed() }));
    const read = await raw(open.at(-1), "/api/v1/config");
    const written = await raw(open.at(-1), "/api/v1/models/local/qwen2.5:3b/overrides", {
      method: "PUT",
      body: {
        supports: { parallelToolCalls: "true", streaming: "false" },
        notes: "proxy strips stream",
      },
      headers: { "if-match": read.etag as string },
    });
    assert.equal(written.status, 200);
    assert.equal(written.body.changed, true);
    assert.equal(written.body.composed, true);
    assert.equal(written.body.override.source, "manual");
    const moves = (written.body.changes as readonly string[]).join(" | ");
    assert.match(moves, /parallelToolCalls/, "the report names the capability that moved");
    assert.match(moves, /streaming/, "and the other one");
    const file = storedFile(open.at(-1));
    const record = file.provider.local.overrides["qwen2.5:3b"];
    assert.equal(record.supports.parallelToolCalls, true);
    assert.equal(record.supports.streaming, false);
    assert.equal(record.notes, "proxy strips stream");
    // The token moved with the file: a second write with the first read's token is now the stale case.
    const replay = await raw(open.at(-1), "/api/v1/models/local/qwen2.5:3b/overrides", {
      method: "PUT",
      body: { clear: true },
      headers: { "if-match": read.etag as string },
    });
    assert.equal(replay.status, 409);
  });

  it("a record that restates the report is unchanged — no change is a claim about nothing", async () => {
    open.push(await boot({ document: seed() }));
    const read = await raw(open.at(-1), "/api/v1/config");
    const written = await raw(open.at(-1), "/api/v1/models/local/qwen2.5:3b/overrides", {
      method: "PUT",
      body: { supports: { toolCalling: "true" } },
      headers: { "if-match": read.etag as string },
    });
    assert.equal(written.status, 200);
    assert.deepEqual(written.body.changes, [], "a restatement moved nothing");
    assert.match(
      written.body.note as string,
      /restates|nothing about the effective/,
      "the note says so rather than implying a win",
    );
  });

  it("a ceiling composition refuses is written and reported — the gate is composition's, applied after", async () => {
    open.push(await boot({ document: seed() }));
    const read = await raw(open.at(-1), "/api/v1/config");
    const written = await raw(open.at(-1), "/api/v1/models/local/qwen2.5:3b/overrides", {
      method: "PUT",
      body: { context: 1024, maxOutput: 2048 },
      headers: { "if-match": read.etag as string },
    });
    assert.equal(written.status, 200);
    assert.equal(written.body.composed, false, "composition refused the pair");
    assert.match(written.body.composeReason as string, /qwen2\.5:3b/);
    assert.ok(
      storedFile(open.at(-1)).provider.local.overrides,
      "the record is in the file, because the user asked",
    );
  });

  it("an unparsable stored record is a conflict that offers the clear, and the clear works", async () => {
    open.push(
      await boot({
        document: seed({ "qwen2.5:3b": { supports: { notAFeature: true } } }),
      }),
    );
    const read = await raw(open.at(-1), "/api/v1/config");
    const blocked = await raw(open.at(-1), "/api/v1/models/local/qwen2.5:3b/overrides", {
      method: "PUT",
      body: { supports: { streaming: "false" } },
      headers: { "if-match": read.etag as string },
    });
    assert.equal(blocked.status, 409);
    assert.equal((blocked.body as any).error.code, "override_unparsable");
    assert.match((blocked.body as any).error.message, /clear/i, "the refusal names the repair");

    const cleared = await raw(open.at(-1), "/api/v1/models/local/qwen2.5:3b/overrides", {
      method: "PUT",
      body: { clear: true },
      headers: { "if-match": read.etag as string },
    });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.override, null);
    assert.equal(
      storedFile(open.at(-1)).provider.local.overrides,
      undefined,
      "the empty map is removed with the record",
    );
  });
});
