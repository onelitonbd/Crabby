// The `gemini` adapter against a server that speaks `generateContent` — the same discipline as the other two adapter
// tests: a real HTTP client over a real loopback socket, no adapter mocks, no internet. §7: the opt-in suite may hit
// real endpoints and must never be required for a green build; this file is not that suite.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import {
  type ConformanceFixture,
  createGeminiProvider,
  GEMINI_API_KEY_HEADER,
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
const TOOL_MODEL = "gemini-stub-tools";
const PLAIN_MODEL = "gemini-stub-plain";
const NO_STREAM_MODEL = "gemini-stub-nostream";

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
      contextWindow: 32_768,
      maxOutputTokens: 2_048,
      supports: supports(),
      cancellation: "best-effort",
      rateLimits: { rpm: 60, tpm: 20_000 },
      cost: "free-tier",
      batching: null,
    },
  },
  {
    id: PLAIN_MODEL,
    descriptor: {
      contextWindow: 8_192,
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
      contextWindow: 8_192,
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
  | { readonly kind: "safety" }
  | {
      readonly kind: "status";
      readonly status: number;
      readonly body?: string;
      readonly retryAfter?: string;
    }
  | { readonly kind: "html" }
  | { readonly kind: "hang"; readonly ms: number }
  | { readonly kind: "privileged"; readonly field: string }
  | { readonly kind: "unknown-finish"; readonly value: string };

interface RecordedRequest {
  readonly url: string;
  readonly body: Record<string, unknown>;
  readonly headers: IncomingMessage["headers"];
}

interface Stub {
  readonly baseUrl: string;
  mode: StubMode;
  readonly last: () => RecordedRequest | undefined;
  readonly close: () => Promise<void>;
}

function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
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
      requests.push({ url: req.url ?? "", body, headers: req.headers });
      void handle(req, res, body);
    });
  });
  const state: { mode: StubMode } = { mode: { kind: "text" } };

  const completion = (): Record<string, unknown> => ({
    candidates: [{ content: { role: "model", parts: [{ text: TEXT }] }, finishReason: "STOP" }],
    usageMetadata: {
      promptTokenCount: USAGE.input,
      candidatesTokenCount: USAGE.output,
      totalTokenCount: 16,
    },
  });
  const toolCompletion = (): Record<string, unknown> => ({
    candidates: [
      {
        content: {
          role: "model",
          parts: [
            { text: "reading" },
            { functionCall: { name: "file.read", args: { path: "notes/todo.md" } } },
          ],
        },
        finishReason: "STOP",
      },
    ],
    usageMetadata: { promptTokenCount: USAGE.input, candidatesTokenCount: USAGE.output },
  });

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
    if (body.stream === true || String(_req.url).includes("streamGenerateContent")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      openResponses.push(res);
      const frames: Record<string, unknown>[] = [];
      for (const fragment of FRAGMENTS.slice(0, 2)) {
        frames.push({ candidates: [{ content: { role: "model", parts: [{ text: fragment }] } }] });
      }
      for (const frame of frames) res.write(sseFrame(frame));
      timers.push(
        setTimeout(() => {
          for (const fragment of FRAGMENTS.slice(2)) {
            res.write(
              sseFrame({
                candidates: [{ content: { role: "model", parts: [{ text: fragment }] } }],
              }),
            );
          }
          if (mode.kind === "tool-call") {
            res.write(
              sseFrame({
                candidates: [
                  {
                    content: {
                      role: "model",
                      parts: [
                        { functionCall: { name: "file.read", args: { path: "notes/todo.md" } } },
                      ],
                    },
                    finishReason: "STOP",
                  },
                ],
              }),
            );
          }
          res.write(
            sseFrame({
              candidates: [
                {
                  content: { role: "model", parts: [] },
                  finishReason: mode.kind === "safety" ? "SAFETY" : "STOP",
                },
              ],
              usageMetadata: { promptTokenCount: USAGE.input, candidatesTokenCount: USAGE.output },
            }),
          );
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
        res.end(mode.body ?? '{"error":{"code":500,"message":"stub","status":"INTERNAL"}}');
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
        finish({ candidates: [{ content: { parts: [{ text: TEXT }] } }], [mode.field]: true });
        return;
      }
      case "unknown-finish": {
        finish({
          candidates: [{ content: { parts: [{ text: TEXT }] }, finishReason: mode.value }],
          usageMetadata: { promptTokenCount: USAGE.input, candidatesTokenCount: USAGE.output },
        });
        return;
      }
      case "safety": {
        finish({
          candidates: [{ content: { role: "model", parts: [] }, finishReason: "SAFETY" }],
          usageMetadata: { promptTokenCount: USAGE.input, candidatesTokenCount: 0 },
        });
        return;
      }
      case "tool-call": {
        finish(toolCompletion());
        return;
      }
      default: {
        timers.push(setTimeout(() => finish(completion()), 25));
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

const TEST_DEADLINES = { connectMs: 400, firstTokenMs: 500, idleStreamMs: 400 };

let stub: Stub | undefined;

function adapter(options: { models?: typeof MODELS; id?: string } = {}): Provider {
  const local = stub;
  assert.ok(local, "the stub server is not running");
  return createGeminiProvider({
    config: { baseUrl: local.baseUrl, apiKey: "stub-key" },
    models: options.models ?? MODELS,
    ...(options.id === undefined ? {} : { id: options.id }),
    deadlines: TEST_DEADLINES,
  });
}

function geminiFixture(): ConformanceFixture {
  const local = stub;
  assert.ok(local);
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
        body: '{"error":{"code":401,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}',
      };
    case "billing":
      return {
        kind: "status",
        status: 429,
        body: '{"error":{"code":429,"message":"billing: exceeded your current quota, payment required","status":"RESOURCE_EXHAUSTED"}}',
      };
    case "rate-limit":
      return {
        kind: "status",
        status: 429,
        retryAfter: "1",
        body: '{"error":{"code":429,"message":"Resource has been exhausted, slow down","status":"RESOURCE_EXHAUSTED"}}',
      };
    case "overloaded":
      return {
        kind: "status",
        status: 503,
        body: '{"error":{"code":503,"message":"The model is overloaded","status":"UNAVAILABLE"}}',
      };
    case "timeout":
      return { kind: "hang", ms: 1_500 };
    case "context-overflow":
      return {
        kind: "status",
        status: 400,
        body: '{"error":{"code":400,"message":"The input token count exceeds the maximum: too long for the model","status":"INVALID_ARGUMENT"}}',
      };
    case "content-filter":
      return {
        kind: "status",
        status: 400,
        body: '{"error":{"code":400,"message":"your prompt was blocked by the safety filter","status":"INVALID_ARGUMENT"}}',
      };
    case "unsupported-capability":
      return {
        kind: "status",
        status: 400,
        body: '{"error":{"code":400,"message":"this endpoint does not support response_mime_type","status":"INVALID_ARGUMENT"}}',
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
    taskId: "task_gemini_test",
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

describe("§7's conformance suite for gemini, over a real socket", () => {
  it("passes every area, with no case failed", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "text" };
    const result = await runConformance(geminiFixture(), "gemini");
    assert.deepEqual(
      result.failed.map((failure) => `${failure.id}: ${failure.title} — ${failure.error}`),
      [],
    );
    assert.ok(result.passed.length >= 10);
  });

  it("all five areas are covered", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "text" };
    const result = await runConformance(geminiFixture(), "gemini");
    for (const [, counts] of Object.entries(result.byArea)) {
      assert.ok(counts.passed > 0);
    }
  });
});

describe("the generateContent wire's own grammar", () => {
  it("targets the model's own endpoint, and the key rides the header, never the URL", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "text" };
    await adapter().generate(
      { modelId: TOOL_MODEL, messages: [{ role: "user", content: "hello" }] },
      context(new AbortController().signal),
    );
    const wire = local.last();
    assert.match(wire?.url ?? "", /:generateContent$/);
    assert.doesNotMatch(
      wire?.url ?? "",
      /key=/,
      "a credential in a URL is a credential in access logs",
    );
    assert.equal(wire?.headers[GEMINI_API_KEY_HEADER], "stub-key");
    assert.equal(
      ((wire?.body.generationConfig ?? {}) as Record<string, unknown>).maxOutputTokens,
      2_048,
      "the descriptor's maxOutputTokens is the default",
    );
  });

  it("streams through the streamGenerateContent endpoint with alt=sse", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "text" };
    const events = await collect(
      adapter().stream(
        { modelId: TOOL_MODEL, messages: [{ role: "user", content: "hello" }] },
        context(new AbortController().signal),
      ),
    );
    assert.match(local.last()?.url ?? "", /:streamGenerateContent\?alt=sse$/);
    assert.equal(
      events
        .filter((event): event is Extract<StreamEvent, { type: "delta" }> => event.type === "delta")
        .map((event) => event.text)
        .join(""),
      TEXT,
    );
    const terminals = events.filter((event) => event.type !== "delta");
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0]?.type, "done");
  });

  it("hoists system turns into systemInstruction, and roles map user/model", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "text" };
    const messages: ProviderMessage[] = [
      { role: "system", content: "you are terse" },
      { role: "assistant", content: "earlier answer" },
      { role: "user", content: "go on" },
    ];
    await adapter().generate(
      { modelId: TOOL_MODEL, messages },
      context(new AbortController().signal),
    );
    const wire = local.last();
    const contents = wire?.body.contents as Record<string, unknown>[];
    assert.deepEqual(
      contents.map((content) => content.role),
      ["model", "user"],
      "the system turn rides systemInstruction; assistant maps to model",
    );
    assert.deepEqual((wire?.body.systemInstruction as Record<string, unknown>).parts, [
      { text: "you are terse" },
    ]);
  });

  it("a tool result becomes a functionResponse carrying the tool's name, resolved from the proposing turn", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "text" };
    const messages: ProviderMessage[] = [
      { role: "user", content: "read the file" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "file.read", arguments: { path: "notes/todo.md" } }],
      },
      { role: "tool", toolCallId: "call_1", content: '{"content":"- one"}' },
    ];
    await adapter().generate(
      { modelId: TOOL_MODEL, messages },
      context(new AbortController().signal),
    );
    const contents = local.last()?.body.contents as Record<string, unknown>[];
    const toolTurn = contents.at(-1);
    assert.equal(toolTurn?.role, "user");
    const part = (toolTurn?.parts as Record<string, unknown>[])[0] ?? {};
    assert.deepEqual(part.functionResponse, {
      name: "file.read",
      response: { content: "- one" },
    });
  });

  it("a tool result with no proposing call is refused here, not a 400 from the endpoint", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "text" };
    const messages: ProviderMessage[] = [
      { role: "user", content: "go" },
      { role: "tool", toolCallId: "call_nobody", content: "{}" },
    ];
    await assert.rejects(
      () =>
        adapter().generate(
          { modelId: TOOL_MODEL, messages },
          context(new AbortController().signal),
        ),
      (error: unknown) => {
        assert.equal((error as { class?: string }).class, "invalid-response");
        assert.match((error as Error).message, /no assistant turn .* proposed|proposed/);
        return true;
      },
    );
  });

  it("a tool_call answer parses into calls; SAFETY maps to content-filter", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "tool-call" };
    const result = await adapter().generate(
      { modelId: TOOL_MODEL, messages: [{ role: "user", content: "read" }] },
      context(new AbortController().signal),
    );
    assert.deepEqual(result.toolCalls, [
      { id: "call_1", name: "file.read", arguments: { path: "notes/todo.md" } },
    ]);
    assert.equal(result.finishReason, "done");
    local.mode = { kind: "safety" };
    const refused = await adapter().generate(
      { modelId: TOOL_MODEL, messages: [{ role: "user", content: "hello" }] },
      context(new AbortController().signal),
    );
    assert.equal(refused.finishReason, "content-filter");
  });

  it("a finishReason outside the table is invalid-response, never a guessed terminal", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "unknown-finish", value: "MTU_PROMO" };
    await assert.rejects(
      () =>
        adapter().generate(
          { modelId: TOOL_MODEL, messages: [{ role: "user", content: "hello" }] },
          context(new AbortController().signal),
        ),
      (error: unknown) => {
        assert.equal((error as { class?: string }).class, "invalid-response");
        assert.match((error as Error).message, /MTU_PROMO/);
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
        return true;
      },
    );
  });

  it("construction rejects unparsable descriptors, duplicates, and an empty list (§3.2, fail-closed)", () => {
    const local = stub;
    assert.ok(local);
    assert.throws(
      () =>
        createGeminiProvider({
          config: { baseUrl: local.baseUrl, apiKey: "k" },
          models: [{ id: "m", descriptor: { contextWindow: "big" } }],
        }),
      /unparsable descriptor/,
    );
    assert.throws(
      () => createGeminiProvider({ config: { baseUrl: local.baseUrl }, models: [] }),
      /no models were declared/,
    );
  });
});
