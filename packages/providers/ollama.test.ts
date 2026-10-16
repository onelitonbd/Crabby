// The `ollama` adapter against a server that speaks the native API — `/api/tags` for the listing that is the reason
// this family has its own adapter, `/api/chat` NDJSON for inference. Real HTTP client, real loopback socket, no
// adapter mocks, no internet (§7).
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import {
  type ConformanceFixture,
  createOllamaProvider,
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
const TOOL_MODEL = "llama-stub-tools";
const PLAIN_MODEL = "llama-stub-plain";
const NO_STREAM_MODEL = "llama-stub-nostream";

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
      contextWindow: 8_192,
      maxOutputTokens: 1_024,
      supports: supports(),
      cancellation: "best-effort",
      rateLimits: null,
      cost: "local",
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
      cost: "local",
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
      cost: "local",
      batching: null,
    },
  },
] as const;

type StubMode =
  | { readonly kind: "text" }
  | { readonly kind: "tool-call" }
  | {
      readonly kind: "status";
      readonly status: number;
      readonly body?: string;
      readonly retryAfter?: string;
    }
  | { readonly kind: "html" }
  | { readonly kind: "hang"; readonly ms: number }
  | { readonly kind: "tags-down" }
  | { readonly kind: "privileged"; readonly field: string }
  | { readonly kind: "unknown-done"; readonly value: string };

interface RecordedRequest {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

interface Stub {
  readonly baseUrl: string;
  mode: StubMode;
  readonly last: () => RecordedRequest | undefined;
  readonly close: () => Promise<void>;
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
      requests.push({ url: req.url ?? "", body });
      void handle(req, res, body);
    });
  });
  const state: { mode: StubMode } = { mode: { kind: "text" } };

  async function handle(
    req: IncomingMessage,
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
    if (String(req.url) === "/api/tags") {
      if (mode.kind === "tags-down") {
        res.writeHead(503, { "content-type": "application/json" });
        res.end('{"error":"server is loading"}');
        return;
      }
      finish({
        models: [
          { name: TOOL_MODEL, model: TOOL_MODEL },
          { name: "installed-but-undeclared:8b", model: "installed-but-undeclared:8b" },
        ],
      });
      return;
    }
    if (body.stream === true) {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      openResponses.push(res);
      const line = (payload: Record<string, unknown>): string => `${JSON.stringify(payload)}\n`;
      for (const fragment of FRAGMENTS.slice(0, 2)) {
        res.write(
          line({
            model: TOOL_MODEL,
            message: { role: "assistant", content: fragment },
            done: false,
          }),
        );
      }
      timers.push(
        setTimeout(() => {
          for (const fragment of FRAGMENTS.slice(2)) {
            res.write(
              line({
                model: TOOL_MODEL,
                message: { role: "assistant", content: fragment },
                done: false,
              }),
            );
          }
          if (mode.kind === "tool-call") {
            res.write(
              line({
                model: TOOL_MODEL,
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    { function: { name: "file.read", arguments: { path: "notes/todo.md" } } },
                  ],
                },
                done: false,
              }),
            );
          }
          res.write(
            line({
              model: TOOL_MODEL,
              message: { role: "assistant", content: "" },
              done: true,
              done_reason: mode.kind === "tool-call" ? "stop" : "stop",
              prompt_eval_count: USAGE.input,
              eval_count: USAGE.output,
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
        res.end(mode.body ?? '{"error":{"message":"stub"}}');
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
        finish({ message: { role: "assistant", content: TEXT }, [mode.field]: true });
        return;
      }
      case "unknown-done": {
        finish({
          message: { role: "assistant", content: TEXT },
          done: true,
          done_reason: mode.value,
          prompt_eval_count: USAGE.input,
          eval_count: USAGE.output,
        });
        return;
      }
      case "tool-call": {
        finish({
          message: {
            role: "assistant",
            content: "reading",
            tool_calls: [{ function: { name: "file.read", arguments: { path: "notes/todo.md" } } }],
          },
          done: true,
          done_reason: "stop",
          prompt_eval_count: USAGE.input,
          eval_count: USAGE.output,
        });
        return;
      }
      default: {
        timers.push(
          setTimeout(() => {
            finish({
              message: { role: "assistant", content: TEXT },
              done: true,
              done_reason: "stop",
              prompt_eval_count: USAGE.input,
              eval_count: USAGE.output,
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

const TEST_DEADLINES = { connectMs: 400, firstTokenMs: 500, idleStreamMs: 400 };

let stub: Stub | undefined;

function adapter(options: { models?: typeof MODELS; id?: string } = {}): Provider {
  const local = stub;
  assert.ok(local, "the stub server is not running");
  return createOllamaProvider({
    config: { baseUrl: local.baseUrl },
    models: options.models ?? MODELS,
    ...(options.id === undefined ? {} : { id: options.id }),
    deadlines: TEST_DEADLINES,
  });
}

function ollamaFixture(): ConformanceFixture {
  const local = stub;
  assert.ok(local);
  const modes: readonly ProviderErrorClass[] = PROVIDER_ERROR_CLASSES.filter(
    (errorClass) => errorClass !== "cancelled",
  );
  return {
    create: () => adapter(),
    validConfig: { baseUrl: local.baseUrl },
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
        body: '{"error":{"message":"unauthorized: invalid api key"}}',
      };
    case "billing":
      return {
        kind: "status",
        status: 402,
        body: '{"error":{"message":"exceeded your current quota"}}',
      };
    case "rate-limit":
      return {
        kind: "status",
        status: 429,
        retryAfter: "1",
        body: '{"error":{"message":"slow down"}}',
      };
    case "overloaded":
      return {
        kind: "status",
        status: 503,
        body: '{"error":{"message":"server busy, upstream is busy"}}',
      };
    case "timeout":
      return { kind: "hang", ms: 1_500 };
    case "context-overflow":
      return {
        kind: "status",
        status: 400,
        body: '{"error":{"message":"input exceeds the model maximum context length"}}',
      };
    case "content-filter":
      return {
        kind: "status",
        status: 400,
        body: '{"error":{"message":"your input was flagged by the content filter"}}',
      };
    case "unsupported-capability":
      return {
        kind: "status",
        status: 400,
        body: '{"error":{"message":"this endpoint does not support format"}}',
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

function context(signal: AbortSignal, extra: { requestId?: string } = {}) {
  return {
    signal,
    requestId: extra.requestId ?? `req_${Math.random().toString(36).slice(2, 10)}`,
    taskId: "task_ollama_test",
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

describe("§7's conformance suite for ollama, over a real socket", () => {
  it("passes every area, with no case failed", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "text" };
    const result = await runConformance(ollamaFixture(), "ollama");
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
    const result = await runConformance(ollamaFixture(), "ollama");
    for (const [, counts] of Object.entries(result.byArea)) {
      assert.ok(counts.passed > 0);
    }
  });
});

describe("the native API's own grammar", () => {
  it("listModels() is the declared, priced set — the suite's rule is listed-means-descriptor", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "text" };
    const models = await adapter().listModels();
    assert.ok(models.includes(TOOL_MODEL));
    assert.ok(models.includes(PLAIN_MODEL));
    // `/api/tags` names models without pricing them, and §3.2's rule (asserted by the suite's own case) is that an
    // unpriced name is not listable. The machine's installed names reaching a screen is the contract change D-133's
    // record names, not a widening here.
    assert.ok(!models.includes("installed-but-undeclared:8b"));
  });

  it("describe() stays the declared descriptors — /api/tags names models, it does not price them", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "text" };
    const descriptors = await adapter().describe();
    assert.equal(descriptors[TOOL_MODEL]?.contextWindow, 8_192);
    assert.equal(descriptors["installed-but-undeclared:8b"], undefined);
  });

  it("inference rides /api/chat with options.num_predict from the descriptor's default", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "text" };
    await adapter().generate(
      { modelId: TOOL_MODEL, messages: [{ role: "user", content: "hello" }] },
      context(new AbortController().signal),
    );
    const wire = local.last();
    assert.equal(wire?.url, "/api/chat");
    assert.equal(((wire?.body.options ?? {}) as Record<string, unknown>).num_predict, 1_024);
    assert.equal(wire?.body.stream, false);
  });

  it("a tool result rides a tool message carrying the tool's name", async () => {
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
      { role: "tool", toolCallId: "call_1", content: "- one" },
    ];
    await adapter().generate(
      { modelId: TOOL_MODEL, messages },
      context(new AbortController().signal),
    );
    const sent = local.last()?.body.messages as Record<string, unknown>[];
    const toolTurn = sent.at(-1);
    assert.equal(toolTurn?.role, "tool");
    assert.equal(toolTurn?.tool_name, "file.read");
  });

  it("streaming is NDJSON: deltas, then one terminal done with the usage line", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "text" };
    const events = await collect(
      adapter().stream(
        { modelId: TOOL_MODEL, messages: [{ role: "user", content: "hello" }] },
        context(new AbortController().signal),
      ),
    );
    assert.equal(
      events
        .filter((event): event is Extract<StreamEvent, { type: "delta" }> => event.type === "delta")
        .map((event) => event.text)
        .join(""),
      TEXT,
    );
    const terminals = events.filter((event) => event.type !== "delta");
    assert.equal(terminals.length, 1);
    const done = terminals[0];
    assert.equal(done?.type, "done");
    if (done !== undefined && done.type === "done") {
      assert.deepEqual(done.usage, { inputTokens: USAGE.input, outputTokens: USAGE.output });
      assert.equal(done.finishReason, "done");
    }
  });

  it("streamed tool calls arrive whole and end with the tool-calls finish", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "tool-call" };
    const events = await collect(
      adapter().stream(
        { modelId: TOOL_MODEL, messages: [{ role: "user", content: "read the file" }] },
        context(new AbortController().signal),
      ),
    );
    const call = events.find(
      (event): event is Extract<StreamEvent, { type: "tool-call" }> => event.type === "tool-call",
    );
    assert.deepEqual(call?.arguments, { path: "notes/todo.md" });
    const done = events.at(-1);
    assert.equal(
      done !== undefined && done.type === "done" ? done.finishReason : undefined,
      "done",
    );
  });

  it("a done_reason outside the table is invalid-response, never a guessed terminal", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "unknown-done", value: "evicted" };
    await assert.rejects(
      () =>
        adapter().generate(
          { modelId: TOOL_MODEL, messages: [{ role: "user", content: "hello" }] },
          context(new AbortController().signal),
        ),
      (error: unknown) => {
        assert.equal((error as { class?: string }).class, "invalid-response");
        assert.match((error as Error).message, /evicted/);
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
        return true;
      },
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
    const withOverride = createOllamaProvider({
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
