// The `anthropic` adapter against a server that speaks the Messages API's wire — the same discipline as
// `openai.test.ts`: the thing under test is a real HTTP client, so the other side of the socket is a real HTTP server on
// `127.0.0.1`, and nothing here mocks the adapter or reaches the internet. §7: "all core and security tests run against
// the fake provider; a separate opt-in suite may hit real endpoints and must never be required for a green build."
//
// What is asserted beyond the suite: the family's own grammar — `system` hoisted to the top-level field, `max_tokens`
// defaulted from the descriptor when the request omits it, tool calls as `tool_use` blocks and results as `tool_result`
// in a user turn, the typed SSE events, the `stop_reason` table, and the key on `x-api-key` rather than in a URL.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import {
  ANTHROPIC_VERSION,
  type ConformanceFixture,
  createAnthropicProvider,
  PROVIDER_ERROR_CLASSES,
  type Provider,
  type ProviderErrorClass,
  type ProviderMessage,
  runConformance,
  type StreamEvent,
} from "./index.ts";

const TEXT = "alpha beta gamma delta epsilon";
const FRAGMENTS = ["alpha ", "beta ", "gamma ", "delta ", "epsilon"];
const USAGE = { input: 11, output: 5 };
const TOOL_MODEL = "claude-stub-tools";
const PLAIN_MODEL = "claude-stub-plain";
const NO_STREAM_MODEL = "claude-stub-nostream";

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

const MODELS = [
  {
    id: TOOL_MODEL,
    descriptor: {
      contextWindow: 8192,
      maxOutputTokens: 1_024,
      supports: supports(),
      cancellation: "best-effort",
      rateLimits: { rpm: 60, tpm: 20_000 },
      cost: null,
      batching: null,
    },
  },
  {
    id: PLAIN_MODEL,
    descriptor: {
      contextWindow: 4_096,
      maxOutputTokens: 512,
      supports: supports({ toolCalling: false }),
      cancellation: "best-effort",
      rateLimits: null,
      cost: null,
      batching: null,
    },
  },
  {
    id: NO_STREAM_MODEL,
    descriptor: {
      contextWindow: 4_096,
      maxOutputTokens: 512,
      supports: supports({ streaming: false, toolCalling: false }),
      cancellation: "best-effort",
      rateLimits: null,
      cost: null,
      batching: null,
    },
  },
] as const;

type StubMode =
  | { readonly kind: "text" }
  | { readonly kind: "tool-call" }
  | { readonly kind: "stream"; readonly withTools?: boolean }
  | {
      readonly kind: "status";
      readonly status: number;
      readonly body?: string;
      readonly retryAfter?: string;
    }
  | { readonly kind: "html" }
  | { readonly kind: "hang"; readonly ms: number }
  | { readonly kind: "privileged"; readonly field: string }
  | { readonly kind: "unknown-stop"; readonly value: string };

interface RecordedRequest {
  readonly body: Record<string, unknown>;
  readonly headers: IncomingMessage["headers"];
}

interface Stub {
  readonly baseUrl: string;
  mode: StubMode;
  readonly last: () => RecordedRequest | undefined;
  readonly close: () => Promise<void>;
}

function sseFrame(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

async function startStub(): Promise<Stub> {
  const timers: ReturnType<typeof setTimeout>[] = [];
  const openResponses: ServerResponse[] = [];
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<
        string,
        unknown
      >;
      requests.push({ body, headers: req.headers });
      void handle(req, res, body);
    });
  });
  const state: { mode: StubMode } = { mode: { kind: "text" } };

  async function handle(
    _req: IncomingMessage,
    res: ServerResponse,
    body: Record<string, unknown>,
  ): Promise<void> {
    const mode = state.mode;
    const finish = (
      payload: Record<string, unknown>,
      status = 200,
      headers: Record<string, string> = {},
    ): void => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(payload));
    };
    // The wire decides, not the test's mood: a request that asked to stream gets the stream grammar whatever mode the
    // test set (the conformance suite streams against the plain text mode), and a request that did not gets JSON even
    // in a streaming mode — which is exactly case 7's "stream and generate agree" read twice.
    if (body.stream === true) {
      const withTools = mode.kind === "stream" && mode.withTools === true;
      // One delta, a pause long enough that an abort lands between frames (the cancellation case depends on the race
      // going the right way), then the rest of the grammar: blocks, stop reason, stop.
      res.writeHead(200, { "content-type": "text/event-stream" });
      openResponses.push(res);
      res.write(
        sseFrame("message_start", {
          type: "message_start",
          message: { usage: { input_tokens: USAGE.input, output_tokens: 0 } },
        }),
      );
      for (const fragment of FRAGMENTS.slice(0, 2)) {
        res.write(
          sseFrame("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: fragment },
          }),
        );
      }
      timers.push(
        setTimeout(() => {
          for (const fragment of FRAGMENTS.slice(2)) {
            res.write(
              sseFrame("content_block_delta", {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: fragment },
              }),
            );
          }
          if (withTools) {
            res.write(
              sseFrame("content_block_start", {
                type: "content_block_start",
                index: 1,
                content_block: { type: "tool_use", id: "toolu_1", name: "file.read" },
              }),
            );
            res.write(
              sseFrame("content_block_delta", {
                type: "content_block_delta",
                index: 1,
                delta: { type: "input_json_delta", partial_json: '{"path":' },
              }),
            );
            res.write(
              sseFrame("content_block_delta", {
                type: "content_block_delta",
                index: 1,
                delta: { type: "input_json_delta", partial_json: '"notes/todo.md"}' },
              }),
            );
          }
          res.write(
            sseFrame("message_delta", {
              type: "message_delta",
              delta: { stop_reason: withTools ? "tool_use" : "end_turn" },
              usage: { output_tokens: USAGE.output },
            }),
          );
          res.write(sseFrame("message_stop", { type: "message_stop" }));
          res.end();
        }, 60),
      );
      return;
    }
    switch (mode.kind) {
      case "status": {
        res.writeHead(mode.status, {
          "content-type": "application/json",
          ...(mode.retryAfter === undefined ? {} : { "retry-after": mode.retryAfter }),
        });
        res.end(mode.body ?? '{"type":"error","error":{"type":"api_error","message":"stub"}}');
        return;
      }
      case "html": {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html>not json</html>");
        return;
      }
      case "hang": {
        openResponses.push(res);
        timers.push(setTimeout(() => res.destroy(), mode.ms));
        return;
      }
      case "privileged": {
        finish({
          id: "msg_1",
          content: [{ type: "text", text: TEXT }],
          stop_reason: "end_turn",
          [mode.field]: true,
        });
        return;
      }
      case "unknown-stop": {
        finish({
          id: "msg_1",
          content: [{ type: "text", text: TEXT }],
          stop_reason: mode.value,
          usage: { input_tokens: USAGE.input, output_tokens: USAGE.output },
        });
        return;
      }
      case "tool-call": {
        finish({
          id: "msg_2",
          content: [
            { type: "text", text: "reading the file" },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "file.read",
              input: { path: "notes/todo.md" },
            },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: USAGE.input, output_tokens: USAGE.output },
        });
        return;
      }
      default: {
        // The non-stream text answer — after a beat, so a `cancel()` can reach a request that is genuinely in flight.
        timers.push(
          setTimeout(() => {
            if (body.system !== undefined && body.max_tokens === undefined) {
              finish(
                {
                  type: "error",
                  error: { type: "invalid_request_error", message: "max_tokens: field required" },
                },
                400,
              );
              return;
            }
            finish({
              id: "msg_1",
              content: [{ type: "text", text: TEXT }],
              stop_reason: "end_turn",
              usage: { input_tokens: USAGE.input, output_tokens: USAGE.output },
            });
          }, 25),
        );
      }
    }
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    get mode(): StubMode {
      return state.mode;
    },
    set mode(value: StubMode) {
      state.mode = value;
    },
    last: () => requests.at(-1),
    close: async () => {
      for (const timer of timers) clearTimeout(timer);
      timers.length = 0;
      for (const response of [...openResponses]) response.destroy();
      openResponses.length = 0;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Deadlines small enough that a test can watch one fire and large enough that a local stub is never late by accident. */
const TEST_DEADLINES = { connectMs: 400, firstTokenMs: 500, idleStreamMs: 400 };

let stub: Stub | undefined;

function adapter(options: { models?: typeof MODELS; id?: string } = {}): Provider {
  const local = stub;
  assert.ok(local, "the stub server is not running");
  return createAnthropicProvider({
    config: { baseUrl: local.baseUrl, apiKey: "stub-key" },
    models: options.models ?? MODELS,
    ...(options.id === undefined ? {} : { id: options.id }),
    deadlines: TEST_DEADLINES,
  });
}

function anthropicFixture(): ConformanceFixture {
  const local = stub;
  assert.ok(local);
  // Nine of §3.5's ten classes: `cancelled` is what the *client* does to a request, and the cancellation cases below are
  // where the adapter earns it. Declaring a mode the stub cannot produce would fail the suite.
  const modes: readonly ProviderErrorClass[] = PROVIDER_ERROR_CLASSES.filter(
    (errorClass) => errorClass !== "cancelled",
  );
  return {
    create: () => adapter(),
    validConfig: { baseUrl: local.baseUrl, apiKey: "stub-key" },
    modelId: TOOL_MODEL,
    toolCapableModelId: TOOL_MODEL,
    failureModes: modes,
    triggerFailure: (_provider, errorClass) => {
      local.mode = modeFor(errorClass);
    },
  };
}

function modeFor(errorClass: string): StubMode {
  switch (errorClass) {
    case "auth":
      return {
        kind: "status",
        status: 401,
        body: '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
      };
    case "billing":
      return {
        kind: "status",
        status: 400,
        body: '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low / exceeded your current quota"}}',
      };
    case "rate-limit":
      return {
        kind: "status",
        status: 429,
        retryAfter: "1",
        body: '{"type":"error","error":{"type":"rate_limit_error","message":"Number of requests too high, slow down"}}',
      };
    case "overloaded":
      return {
        kind: "status",
        status: 503,
        body: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      };
    case "timeout":
      return { kind: "hang", ms: 1_500 };
    case "context-overflow":
      return {
        kind: "status",
        status: 400,
        body: '{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: exceeds the model maximum context length"}}',
      };
    case "content-filter":
      return {
        kind: "status",
        status: 400,
        body: '{"type":"error","error":{"type":"invalid_request_error","message":"your input was flagged by the content filter"}}',
      };
    case "unsupported-capability":
      return {
        kind: "status",
        status: 400,
        body: '{"type":"error","error":{"type":"invalid_request_error","message":"this endpoint does not support response_format"}}',
      };
    case "invalid-response":
      return { kind: "html" };
    default:
      throw new Error(`the stub has no way to produce '${errorClass}'`);
  }
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function context(signal: AbortSignal, extra: { requestId?: string; timeoutMs?: number } = {}) {
  return {
    signal,
    requestId: extra.requestId ?? `req_${Math.random().toString(36).slice(2, 10)}`,
    ...(extra.timeoutMs === undefined ? {} : { timeoutMs: extra.timeoutMs }),
    taskId: "task_anthropic_test",
  };
}

before(async () => {
  stub = await startStub();
});

after(async () => {
  await stub?.close();
  const dispatcher = (globalThis as Record<symbol, unknown>)[
    Symbol.for("undici.globalDispatcher.1")
  ] as { close?: () => Promise<void> } | undefined;
  await dispatcher?.close?.();
});

describe("§7's conformance suite for anthropic, over a real socket", () => {
  it("passes every area, with no case failed", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "text" };
    const result = await runConformance(anthropicFixture(), "anthropic");
    assert.deepEqual(
      result.failed.map((failure) => `${failure.id}: ${failure.title} — ${failure.error}`),
      [],
    );
    assert.ok(
      result.passed.length >= 10,
      `the suite shrank: ${String(result.passed.length)} cases passed`,
    );
  });

  it("all five areas are covered", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "text" };
    const result = await runConformance(anthropicFixture(), "anthropic");
    for (const [, counts] of Object.entries(result.byArea)) {
      assert.ok(
        counts.passed > 0,
        "an area with zero passes is an area the fixture could not reach",
      );
    }
  });
});

describe("the Messages API's own grammar", () => {
  it("hoists system turns, requires nothing, and defaults max_tokens from the descriptor", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "text" };
    const messages: ProviderMessage[] = [
      { role: "system", content: "you are terse" },
      { role: "user", content: "hello" },
    ];
    await adapter().generate(
      { modelId: TOOL_MODEL, messages },
      context(new AbortController().signal),
    );
    const wire = local.last();
    assert.equal(wire?.body.model, TOOL_MODEL);
    assert.equal(wire?.body.system, "you are terse");
    assert.ok(Array.isArray(wire?.body.messages));
    assert.equal(
      (wire?.body.messages as unknown[]).length,
      1,
      "the system turn does not ride in messages",
    );
    assert.equal(wire?.body.max_tokens, 1_024, "the descriptor's maxOutputTokens is the default");
    assert.equal(wire?.body.stream, false);
    assert.equal(wire?.headers["anthropic-version"], ANTHROPIC_VERSION);
    assert.equal(wire?.headers["x-api-key"], "stub-key");
    assert.ok(String(wire?.headers["content-type"]).includes("application/json"));
  });

  it("an explicit maxTokens wins over the descriptor's", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "text" };
    await adapter().generate(
      { modelId: TOOL_MODEL, messages: [{ role: "user", content: "hello" }], maxTokens: 128 },
      context(new AbortController().signal),
    );
    assert.equal(local.last()?.body.max_tokens, 128);
  });

  it("tool results go back as tool_result blocks inside a user turn", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "text" };
    const messages: ProviderMessage[] = [
      { role: "user", content: "read the file" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "toolu_1", name: "file.read", arguments: { path: "notes/todo.md" } }],
      },
      { role: "tool", toolCallId: "toolu_1", content: "- one\n- two" },
    ];
    await adapter().generate(
      { modelId: TOOL_MODEL, messages },
      context(new AbortController().signal),
    );
    const wire = local.last();
    const sent = wire?.body.messages as Record<string, unknown>[];
    const toolTurn = sent.at(-1);
    assert.equal(toolTurn?.role, "user", "the family carries a tool result in a user turn");
    const block = (toolTurn?.content as Record<string, unknown>[])[0] ?? {};
    assert.equal(block.type, "tool_result");
    assert.equal(block.tool_use_id, "toolu_1");
    const assistantTurn = sent.at(-2);
    const toolUse = (assistantTurn?.content as Record<string, unknown>[]).find(
      (candidate) => candidate.type === "tool_use",
    );
    assert.deepEqual(toolUse?.input, { path: "notes/todo.md" });
  });

  it("a tool_use answer parses into calls with the tool-calls finish", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "tool-call" };
    const result = await adapter().generate(
      { modelId: TOOL_MODEL, messages: [{ role: "user", content: "read the file" }] },
      context(new AbortController().signal),
    );
    assert.equal(result.finishReason, "tool-calls");
    assert.deepEqual(result.toolCalls, [
      { id: "toolu_1", name: "file.read", arguments: { path: "notes/todo.md" } },
    ]);
    assert.equal(result.text, "reading the file");
  });

  it("streaming splits into deltas and ends done once, with the same text as generate", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "stream" };
    const events = await collect(
      adapter().stream(
        { modelId: TOOL_MODEL, messages: [{ role: "user", content: "hello" }] },
        context(new AbortController().signal),
      ),
    );
    const text = events
      .filter((event): event is Extract<StreamEvent, { type: "delta" }> => event.type === "delta")
      .map((event) => event.text)
      .join("");
    assert.equal(text, TEXT);
    const terminals = events.filter((event) => event.type !== "delta");
    assert.equal(terminals.length, 1, `one terminal event, got ${String(terminals.length)}`);
    assert.equal(terminals[0]?.type, "done");
    const usage =
      terminals[0] !== undefined && terminals[0].type === "done" ? terminals[0].usage : undefined;
    assert.deepEqual(usage, { inputTokens: USAGE.input, outputTokens: USAGE.output });

    local.mode = { kind: "text" };
    const result = await adapter().generate(
      { modelId: TOOL_MODEL, messages: [{ role: "user", content: "hello" }] },
      context(new AbortController().signal),
    );
    assert.equal(result.text, text);
    assert.deepEqual(result.usage, usage);
  });

  it("streamed tool calls accumulate their fragments into one call", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "stream", withTools: true };
    const events = await collect(
      adapter().stream(
        { modelId: TOOL_MODEL, messages: [{ role: "user", content: "read the file" }] },
        context(new AbortController().signal),
      ),
    );
    const call = events.find(
      (event): event is Extract<StreamEvent, { type: "tool-call" }> => event.type === "tool-call",
    );
    assert.ok(call !== undefined);
    assert.deepEqual(call.arguments, { path: "notes/todo.md" });
    const done = events.at(-1);
    assert.equal(done?.type, "done");
    assert.equal(
      done !== undefined && done.type === "done" ? done.finishReason : undefined,
      "tool-calls",
    );
  });

  it("a stop_reason outside the table is invalid-response, never a guessed terminal", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "unknown-stop", value: "network_error" };
    await assert.rejects(
      () =>
        adapter().generate(
          { modelId: TOOL_MODEL, messages: [{ role: "user", content: "hello" }] },
          context(new AbortController().signal),
        ),
      (error: unknown) => {
        assert.equal((error as { class?: string }).class, "invalid-response");
        assert.match((error as Error).message, /network_error/);
        return true;
      },
    );
  });

  it("a privileged field in the response is refused (§3.1's third rule)", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "privileged", field: "permissions" };
    await assert.rejects(
      () =>
        adapter().generate(
          { modelId: TOOL_MODEL, messages: [{ role: "user", content: "hello" }] },
          context(new AbortController().signal),
        ),
      (error: unknown) => {
        assert.equal((error as { class?: string }).class, "invalid-response");
        assert.match((error as Error).message, /permissions/);
        return true;
      },
    );
  });

  it("a model that declares no streaming still streams, as one delta then done", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "text" };
    const events = await collect(
      adapter().stream(
        { modelId: NO_STREAM_MODEL, messages: [{ role: "user", content: "hello" }] },
        context(new AbortController().signal),
      ),
    );
    const terminals = events.filter((event) => event.type !== "delta");
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0]?.type, "done");
    assert.equal(
      events.filter((event) => event.type === "delta").length,
      1,
      "a non-streaming endpoint is one body, so it is one delta",
    );
  });

  it("the key rides x-api-key, never the URL", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "text" };
    await adapter().generate(
      { modelId: TOOL_MODEL, messages: [{ role: "user", content: "hello" }] },
      context(new AbortController().signal),
    );
    assert.ok(!local.last()?.headers.host?.includes("stub-key"));
    assert.equal(local.last()?.headers["x-api-key"], "stub-key");
  });

  it("construction rejects unparsable descriptors and an empty model list (§3.2's fail-closed rule)", () => {
    const local = stub;
    assert.ok(local);
    assert.throws(
      () =>
        createAnthropicProvider({
          config: { baseUrl: local.baseUrl, apiKey: "stub-key" },
          models: [{ id: "m", descriptor: { contextWindow: "big" } }],
        }),
      /unparsable descriptor/,
    );
    assert.throws(
      () => createAnthropicProvider({ config: { baseUrl: local.baseUrl }, models: [] }),
      /no models were declared/,
    );
    assert.throws(
      () =>
        createAnthropicProvider({
          config: { baseUrl: local.baseUrl },
          models: [
            { id: "m", descriptor: MODELS[0]?.descriptor },
            { id: "m", descriptor: MODELS[0]?.descriptor },
          ],
        }),
      /declared twice/,
    );
  });

  it("a forced-on capability that fails names the override — §3.8's sentence rides this adapter too (D-128)", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = {
      kind: "status",
      status: 400,
      body: '{"error":{"message":"this endpoint does not support tools"}}',
    };
    const withOverride = createAnthropicProvider({
      id: "local",
      config: { baseUrl: local.baseUrl },
      models: MODELS,
      overrides: {
        [TOOL_MODEL]: { source: "manual", supports: { toolCalling: { from: false, to: true } } },
      },
      deadlines: TEST_DEADLINES,
    });
    const error = await withOverride
      .generate(
        {
          modelId: TOOL_MODEL,
          messages: [{ role: "user", content: "list the files" }],
          tools: [
            {
              name: "file.read",
              description: "read a file",
              parameters: { type: "object", properties: {} },
            },
          ],
        },
        context(new AbortController().signal),
      )
      .then(
        () => undefined,
        (e: Error) => e,
      );
    assert.ok(error !== undefined, "the call failed, which is the premise");
    assert.match(error.message, /`toolCalling` was declared by override and failed/);
    assert.match(error.message, /the endpoint reported false/);
  });
});
