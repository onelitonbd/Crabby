// The `openai-compatible` adapter against a server that speaks its wire protocol.
//
// §7 is blunt about what a provider test may touch: "all core and security tests run against the fake provider; a
// separate opt-in suite may hit real endpoints and must never be required for a green build." So nothing here reaches the
// internet, and nothing here mocks the adapter either — the thing under test is a real HTTP client, so the other side of
// the socket is a real HTTP server on `127.0.0.1`, speaking `POST /v1/chat/completions`, SSE frames, `retry-after`
// headers and the four `finish_reason` values. A stub *server* is not a stub *provider*: the bytes still go through
// undici, the frames still arrive in pieces, and a deadline still has to fire on a socket that has gone quiet.
//
// What is asserted, and why each one is here rather than in the adapter's comments: the §7 conformance suite over the
// whole five areas; the request this adapter puts on the wire (§4.4's order of checks starts before the provider sees
// anything, so the mapping is the contract); the response shapes it accepts and the ones it must refuse; streaming's
// terminal states; the three deadlines §3.5 asks to be distinguishable plus D-074's absolute one; cancellation, which is
// `best-effort` and has to behave like it; and §3.3's configuration rules, including the warning that is not a refusal.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import {
  CONFORMANCE_AREAS,
  type ConformanceArea,
  type ConformanceFixture,
  createOpenAiCompatibleProvider,
  type FinishReason,
  OPENAI_DEADLINE_DEFAULTS,
  PROVIDER_ERROR_CLASSES,
  type Provider,
  ProviderError,
  type ProviderErrorClass,
  type ProviderMessage,
  runConformance,
  type StreamEvent,
} from "./index.ts";

const TEXT = "alpha beta gamma delta epsilon";
/** The same answer in the pieces a stream delivers it in. Joining them has to reproduce `TEXT` exactly, because §3.1
 *  requires `stream` to surface the same terminal state as `generate` and the conformance suite compares the text. */
const FRAGMENTS = ["alpha ", "beta ", "gamma ", "delta ", "epsilon"];
const USAGE = { input: 11, output: 5 };
const TOOL_MODEL = "stub-tools";
const PLAIN_MODEL = "stub-plain";
const NO_STREAM_MODEL = "stub-nostream";

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

/** The three models this endpoint declares: one that calls tools and streams, one that streams but does not call tools
 *  (so §3.1's "an undeclared capability has to be refused" is reachable), and one that declares no streaming (so the
 *  adapter's `stream()` over a non-streaming endpoint is reachable). */
const MODELS = [
  {
    id: TOOL_MODEL,
    descriptor: {
      contextWindow: 8192,
      maxOutputTokens: 1024,
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
      contextWindow: 4096,
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
      contextWindow: 4096,
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
  | { readonly kind: "privileged"; readonly field: string }
  | { readonly kind: "close" }
  | { readonly kind: "unknown-finish" }
  | { readonly kind: "bad-tool-json" }
  | { readonly kind: "quiet-stream" }
  | { readonly kind: "silent-stream" }
  | { readonly kind: "slow-stream"; readonly everyMs: number }
  | { readonly kind: "no-usage-stream" };

interface RecordedRequest {
  readonly body: Record<string, unknown>;
  readonly headers: IncomingMessage["headers"];
  readonly url: string;
}

interface Stub {
  readonly baseUrl: string;
  mode: StubMode;
  readonly requests: RecordedRequest[];
  readonly last: () => RecordedRequest | undefined;
  readonly close: () => Promise<void>;
}

function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function chunk(delta: Record<string, unknown>, finish: string | null = null): string {
  return frame({
    id: "chunk_1",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
}

function usageFrame(): string {
  return frame({
    id: "chunk_usage",
    object: "chat.completion.chunk",
    choices: [],
    usage: { prompt_tokens: USAGE.input, completion_tokens: USAGE.output },
  });
}

function completion(
  finish: string | null = "stop",
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "cmpl_1",
    object: "chat.completion",
    created: 1_700_000_000,
    model: "stub-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: TEXT },
        finish_reason: finish,
      },
    ],
    usage: { prompt_tokens: USAGE.input, completion_tokens: USAGE.output },
    ...extra,
  };
}

function toolCompletion(): Record<string, unknown> {
  return {
    id: "cmpl_2",
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "file.read", arguments: JSON.stringify({ path: "notes/todo.md" }) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: USAGE.input, completion_tokens: USAGE.output },
  };
}

let stub: Stub | undefined;

async function startStub(): Promise<Stub> {
  const requests: RecordedRequest[] = [];
  const openResponses: ServerResponse[] = [];
  const timers: ReturnType<typeof setTimeout>[] = [];
  const state: { mode: StubMode } = { mode: { kind: "text" } };

  const server: Server = createServer((request, response) => {
    const pieces: Buffer[] = [];
    request.on("data", (piece: Buffer) => pieces.push(piece));
    request.on("end", () => {
      const raw = Buffer.concat(pieces).toString("utf8");
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        body = { unparsable: raw.slice(0, 200) };
      }
      requests.push({ body, headers: request.headers, url: request.url ?? "" });
      answer(body, response);
    });
  });

  function answer(body: Record<string, unknown>, response: ServerResponse): void {
    const mode = state.mode;
    const streaming = body.stream === true;

    if (mode.kind === "close") {
      response.socket?.destroy();
      return;
    }
    if (mode.kind === "hang") {
      timers.push(
        setTimeout(() => {
          if (response.destroyed) return;
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(completion()));
        }, mode.ms),
      );
      return;
    }
    if (mode.kind === "status") {
      response.writeHead(mode.status, {
        "content-type": "application/json",
        ...(mode.retryAfter === undefined ? {} : { "retry-after": mode.retryAfter }),
      });
      response.end(
        mode.body ?? JSON.stringify({ error: { message: "the stub was told to fail" } }),
      );
      return;
    }
    if (mode.kind === "html") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html>not json</html>");
      return;
    }

    if (!streaming) {
      response.writeHead(200, { "content-type": "application/json" });
      if (mode.kind === "tool-call") response.end(JSON.stringify(toolCompletion()));
      else if (mode.kind === "privileged")
        response.end(JSON.stringify(completion("stop", { [mode.field]: "granted" })));
      else if (mode.kind === "unknown-finish")
        response.end(JSON.stringify(completion("weird-reason")));
      else if (mode.kind === "bad-tool-json") {
        response.end(
          JSON.stringify({
            ...completion("tool_calls"),
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: { name: "file.read", arguments: "{not json" },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          }),
        );
      } else response.end(JSON.stringify(completion()));
      return;
    }

    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    openResponses.push(response);
    response.on("close", () => {
      const at = openResponses.indexOf(response);
      if (at >= 0) openResponses.splice(at, 1);
    });

    if (mode.kind === "silent-stream") {
      // Flushed explicitly, because a Node server buffers `writeHead` until the first body byte and this mode never
      // writes one: without this the client waits on headers rather than on a first token, and the test measures the
      // wrong deadline.
      response.flushHeaders();
      return; // headers and then nothing: §3.5's first-token deadline
    }
    if (mode.kind === "quiet-stream") {
      response.write(chunk({ role: "assistant", content: FRAGMENTS[0] }));
      return; // one delta and then silence: §3.5's stall deadline
    }
    if (mode.kind === "slow-stream") {
      let sent = 0;
      const tick = (): void => {
        if (response.destroyed || sent >= 40) return;
        sent += 1;
        response.write(chunk({ content: "tick " }));
        timers.push(setTimeout(tick, mode.everyMs));
      };
      tick();
      return; // a stream that keeps talking, so only an absolute deadline can end it
    }
    if (mode.kind === "tool-call") {
      response.write(chunk({ role: "assistant" }));
      response.write(
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "file.read", arguments: "" },
            },
          ],
        }),
      );
      response.write(chunk({ tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] }));
      response.write(
        chunk({ tool_calls: [{ index: 0, function: { arguments: 'th": "notes/' } }] }),
      );
      response.write(chunk({ tool_calls: [{ index: 0, function: { arguments: 'todo.md"}' } }] }));
      response.write(chunk({}, "tool_calls"));
      response.write(usageFrame());
      response.write("data: [DONE]\n\n");
      response.end();
      return;
    }
    if (mode.kind === "privileged") {
      response.write(
        frame({
          [mode.field]: "granted",
          choices: [{ index: 0, delta: { content: "x" }, finish_reason: null }],
        }),
      );
      response.write("data: [DONE]\n\n");
      response.end();
      return;
    }
    // The default answer: a keep-alive comment (which §5.1 of the API doc requires of a stream and which a parser that
    // only knows `data:` would choke on), the fragments, the finish, the usage frame and `[DONE]`.
    response.write(": ping\n\n");
    for (const fragment of FRAGMENTS) response.write(chunk({ content: fragment }));
    response.write(chunk({}, "stop"));
    if (mode.kind !== "no-usage-stream") response.write(usageFrame());
    response.write("data: [DONE]\n\n");
    response.end();
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;

  return {
    baseUrl,
    get mode(): StubMode {
      return state.mode;
    },
    set mode(value: StubMode) {
      state.mode = value;
    },
    requests,
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

function adapter(options: { models?: typeof MODELS; id?: string; apiKey?: string } = {}): Provider {
  const local = stub;
  assert.ok(local, "the stub server is not running");
  return createOpenAiCompatibleProvider({
    config: { baseUrl: local.baseUrl, apiKey: options.apiKey ?? "stub-key" },
    models: options.models ?? MODELS,
    ...(options.id === undefined ? {} : { id: options.id }),
    deadlines: TEST_DEADLINES,
  });
}

function context(
  signal: AbortSignal,
  extra: { requestId?: string; timeoutMs?: number; attempt?: number } = {},
) {
  return {
    signal,
    requestId: extra.requestId ?? `req_${Math.random().toString(36).slice(2, 10)}`,
    ...(extra.timeoutMs === undefined ? {} : { timeoutMs: extra.timeoutMs }),
    ...(extra.attempt === undefined ? {} : { attempt: extra.attempt }),
    taskId: "task_openai_test",
  };
}

function request(modelId = TOOL_MODEL, extra: Partial<Parameters<Provider["generate"]>[0]> = {}) {
  return {
    modelId,
    messages: [{ role: "user", content: "conformance" } as ProviderMessage],
    ...extra,
  };
}

function openAiFixture(): ConformanceFixture {
  const local = stub;
  assert.ok(local, "the stub server is not running");
  // Nine of §3.5's ten classes, because the tenth is not a server's to produce: `cancelled` is what the *client* does to
  // a request, and the three cancellation cases below are where this adapter has to earn it. Declaring a mode the stub
  // cannot produce would fail the suite, and declaring all ten would have been a claim about coverage rather than a fact.
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
      return { kind: "status", status: 401, body: '{"error":{"message":"invalid api key"}}' };
    case "billing":
      return {
        kind: "status",
        status: 402,
        body: '{"error":{"message":"You exceeded your current quota"}}',
      };
    case "rate-limit":
      return {
        kind: "status",
        status: 429,
        retryAfter: "1",
        body: '{"error":{"message":"slow down"}}',
      };
    case "overloaded":
      return { kind: "status", status: 503, body: '{"error":{"message":"upstream is busy"}}' };
    case "timeout":
      return { kind: "hang", ms: 1_500 };
    case "context-overflow":
      return {
        kind: "status",
        status: 400,
        body: '{"error":{"message":"This value exceeds the model maximum context length"}}',
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
        body: '{"error":{"message":"this endpoint does not support response_format"}}',
      };
    case "invalid-response":
      return { kind: "html" };
    default:
      throw new Error(`the stub has no way to produce '${errorClass}'`);
  }
}

function areasOf(result: Awaited<ReturnType<typeof runConformance>>): ConformanceArea[] {
  return (Object.entries(result.byArea) as [ConformanceArea, { passed: number }][])
    .filter(([, counts]) => counts.passed > 0)
    .map(([area]) => area);
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

before(async () => {
  stub = await startStub();
});

after(async () => {
  await stub?.close();
  // Node's global fetch keeps the undici dispatcher's sockets open for ~72 s after the last response, which holds the
  // event loop and makes a finished file look like a hung one. Closing it at the very end is how this file says it is
  // done — the same reason `tests/integration/gateway.test.ts` ends the same way.
  const dispatcher = (globalThis as Record<symbol, unknown>)[
    Symbol.for("undici.globalDispatcher.1")
  ] as { close?: () => Promise<void> } | undefined;
  await dispatcher?.close?.();
});

describe("§7's conformance suite, over a real socket", () => {
  it("passes every area for openai-compatible, with no case failed", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "text" };
    const result = await runConformance(openAiFixture(), "openai-compatible");
    assert.deepEqual(
      result.failed,
      [],
      `conformance failed: ${result.failed.map((entry) => `${entry.id} ${entry.title}: ${entry.error}`).join("\n")}`,
    );
    assert.deepEqual(
      areasOf(result).sort(),
      [...CONFORMANCE_AREAS].sort(),
      "every one of §7's five areas has to be exercised, not just the ones that pass easily",
    );
    assert.ok(result.passed.length >= 11, `the suite shrank to ${result.passed.length} cases`);
  });

  it("declares the descriptors §3.2 requires and refuses a model nobody priced", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "text" };
    const provider = adapter();
    assert.deepEqual(provider.listModels(), [TOOL_MODEL, PLAIN_MODEL, NO_STREAM_MODEL]);
    const descriptors = await provider.describe();
    assert.equal(descriptors[TOOL_MODEL]?.supports.toolCalling, true);
    assert.equal(descriptors[PLAIN_MODEL]?.supports.toolCalling, false);
    assert.equal(
      descriptors[TOOL_MODEL]?.cancellation,
      "best-effort",
      "an abort closes this side of the socket; it cannot stop a remote server generating tokens it will bill for, so " +
        "'supported' would tell §6.2's evidence something the adapter cannot know",
    );
    await assert.rejects(
      () => provider.generate(request("gpt-5-not-declared"), context(new AbortController().signal)),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.class, "unsupported-capability");
        assert.match(
          error.message,
          /gpt-5-not-declared/,
          "the refusal names the model the runtime asked for",
        );
        assert.match(error.message, /§3\.8/, "and the section where a user adds one");
        return true;
      },
      "§3.1: presence of a method is not enough — a model with no descriptor has unknowable limits",
    );
  });

  it("refuses tools for a model that does not declare toolCalling, rather than sending them to be ignored", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "text" };
    const provider = adapter();
    const before = local.requests.length;
    await assert.rejects(
      () =>
        provider.generate(
          request(PLAIN_MODEL, {
            tools: [{ name: "file.read", description: "read", parameters: {} }],
          }),
          context(new AbortController().signal),
        ),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.class, "unsupported-capability");
        return true;
      },
    );
    assert.equal(
      local.requests.length,
      before,
      "the refusal happens before the request is sent: a completion that silently ignored the tools would be read by " +
        "the loop as 'the model chose not to call a tool', which is the most expensive kind of wrong answer",
    );
  });

  it("has no countTokens, because §3.1 says absence means §3.4's estimation", () => {
    const provider = adapter();
    assert.equal(
      provider.countTokens,
      undefined,
      "an estimate dressed as a count is worse than no count: §3.4 budgets against this number, and a four-characters-" +
        "per-token guess presented as a measurement would be spent as if it were one",
    );
  });
});

describe("the request it puts on the wire", () => {
  it("sends the model, the messages and the streaming flag §3.3's family expects", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "text" };
    local.requests.length = 0;
    await adapter().generate(request(TOOL_MODEL), context(new AbortController().signal));
    const sent = local.last();
    assert.equal(
      sent?.url,
      "/v1/chat/completions",
      "the base URL is the API root the endpoint's own docs name, so the adapter appends a path and never guesses a version segment",
    );
    assert.equal(sent?.body.model, TOOL_MODEL);
    assert.equal(sent?.body.stream, false);
    assert.deepEqual(sent?.body.messages, [{ role: "user", content: "conformance" }]);
  });

  it("maps an assistant turn's tool calls and a tool result's id onto the wire's own shapes", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "text" };
    local.requests.length = 0;
    const messages: ProviderMessage[] = [
      { role: "system", content: "you are Crabby" },
      { role: "user", content: "read the list" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "file.read", arguments: { path: "notes/todo.md" } }],
      },
      { role: "tool", content: "buy rice", toolCallId: "call_1" },
    ];
    await adapter().generate(
      { modelId: TOOL_MODEL, messages },
      context(new AbortController().signal),
    );
    const sent = local.last();
    assert.deepEqual(
      sent?.body.messages,
      [
        { role: "system", content: "you are Crabby" },
        { role: "user", content: "read the list" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "file.read", arguments: '{"path":"notes/todo.md"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "buy rice" },
      ],
      "arguments go out as a JSON string because that is what this family's wire carries, and an assistant turn with tool calls sends null rather than an empty content, which several servers reject",
    );
  });

  it("offers tools as function specs with tool_choice auto, and asks for usage on a stream", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "text" };
    local.requests.length = 0;
    await adapter().generate(
      request(TOOL_MODEL, {
        tools: [{ name: "file.read", description: "read a file", parameters: { type: "object" } }],
        maxTokens: 256,
        temperature: 0.2,
      }),
      context(new AbortController().signal),
    );
    const sent = local.last();
    assert.deepEqual(sent?.body.tools, [
      {
        type: "function",
        function: { name: "file.read", description: "read a file", parameters: { type: "object" } },
      },
    ]);
    assert.equal(
      sent?.body.tool_choice,
      "auto",
      "the loop decides what to do with a proposal; the adapter does not steer it",
    );
    assert.equal(sent?.body.max_tokens, 256);
    assert.equal(sent?.body.temperature, 0.2);
    assert.equal(
      sent?.body.stream_options,
      undefined,
      "a non-streaming answer carries its usage anyway",
    );

    local.requests.length = 0;
    await collect(adapter().stream(request(TOOL_MODEL), context(new AbortController().signal)));
    const streamed = local.last();
    assert.equal(streamed?.body.stream, true);
    assert.deepEqual(
      streamed?.body.stream_options,
      { include_usage: true },
      "a stream without usage is one §3.4 cannot budget, and this is the documented way to ask for it",
    );
  });

  it("sends the key as a bearer token and lets a user header win", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "text" };
    local.requests.length = 0;
    const provider = createOpenAiCompatibleProvider({
      config: {
        baseUrl: local.baseUrl,
        apiKey: "sk-secret",
        headers: { "x-endpoint-tag": "termux", accept: "application/json" },
      },
      models: MODELS,
      deadlines: TEST_DEADLINES,
    });
    await provider.generate(request(TOOL_MODEL), context(new AbortController().signal));
    const sent = local.last();
    assert.equal(sent?.headers.authorization, "Bearer sk-secret");
    assert.equal(sent?.headers["x-endpoint-tag"], "termux");
    assert.equal(
      sent?.headers.accept,
      "application/json",
      "a user header overrides the generated one: §3.3 gives a custom endpoint no exemption from validation or tier " +
        "policy, and neither lives in a header, but a proxy in front of a local server may need one this adapter cannot predict",
    );
  });
});

describe("the responses it accepts, and the ones it refuses", () => {
  it("reads text, usage and finish_reason off a completion", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "text" };
    const result = await adapter().generate(
      request(TOOL_MODEL),
      context(new AbortController().signal),
    );
    assert.equal(result.text, TEXT);
    assert.deepEqual(result.usage, { inputTokens: USAGE.input, outputTokens: USAGE.output });
    assert.deepEqual(
      result.toolCalls,
      [],
      "a completion without tool calls reports an empty list, not undefined",
    );
    assert.equal(result.finishReason, "done");
  });

  it("maps the family's finish reasons onto §3.1's four terminal states", async () => {
    const local = stub;
    assert.ok(local);
    const expectations: [string | null, FinishReason][] = [
      ["stop", "done"],
      ["length", "length"],
      ["content_filter", "content-filter"],
      [null, "done"],
    ];
    for (const [wire, expected] of expectations) {
      local.mode = { kind: "status", status: 200, body: JSON.stringify(completion(wire)) };
      // A 200 through the error path is how the stub answers with an arbitrary body; the adapter reads it the same way.
      const result = await adapter().generate(
        request(TOOL_MODEL),
        context(new AbortController().signal),
      );
      assert.equal(
        result.finishReason,
        expected,
        `finish_reason ${JSON.stringify(wire)} → ${expected}`,
      );
    }
  });

  it("refuses a finish_reason it does not know instead of guessing a terminal state", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "unknown-finish" };
    await assert.rejects(
      () => adapter().generate(request(TOOL_MODEL), context(new AbortController().signal)),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.class, "invalid-response");
        assert.match(error.message, /weird-reason/);
        return true;
      },
      "§3.2: a declared-but-broken capability is a bug to fix in the adapter, not something the runtime papers over",
    );
  });

  it("parses a tool call's arguments and keeps the raw fragment when they are not JSON", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "tool-call" };
    const result = await adapter().generate(
      request(TOOL_MODEL),
      context(new AbortController().signal),
    );
    assert.deepEqual(result.toolCalls, [
      { id: "call_1", name: "file.read", arguments: { path: "notes/todo.md" } },
    ]);
    assert.equal(result.finishReason, "tool-calls");

    local.mode = { kind: "bad-tool-json" };
    await assert.rejects(
      () => adapter().generate(request(TOOL_MODEL), context(new AbortController().signal)),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.class, "invalid-response");
        assert.equal(
          error.raw,
          "{not json",
          "§3.5's note for this class is 'keep the raw fragment in the audit record, redacted' — redaction is the caller's job, keeping it is this one's",
        );
        return true;
      },
    );
  });

  it("refuses a completion that carries a privileged field, on the body and inside a stream frame", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "privileged", field: "systemPrompt" };
    await assert.rejects(
      () => adapter().generate(request(TOOL_MODEL), context(new AbortController().signal)),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.class, "invalid-response");
        assert.match(error.message, /systemPrompt/);
        assert.match(error.message, /§3\.1/);
        return true;
      },
      "a provider that could widen a task's permissions through its response would not need a bug in Crabby to do it",
    );

    const events = await collect(
      adapter().stream(request(TOOL_MODEL), context(new AbortController().signal)),
    );
    const terminal = events.at(-1);
    assert.equal(
      terminal?.type,
      "error",
      "the same field in a stream frame ends the stream as an error",
    );
    assert.equal(terminal?.type === "error" ? terminal.error.class : undefined, "invalid-response");
    assert.equal(
      events.filter((event) => ["done", "error", "cancelled"].includes(event.type)).length,
      1,
      "and it is still exactly one terminal event",
    );
  });

  it("answers invalid-response for a body that is not JSON, not overloaded", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "html" };
    await assert.rejects(
      () => adapter().generate(request(TOOL_MODEL), context(new AbortController().signal)),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(
          error.class,
          "invalid-response",
          "the endpoint answered and the answer was garbage; `overloaded` would say it could not be reached, which is a " +
            "different fact with a different retry story",
        );
        return true;
      },
    );
  });
});

describe("streaming", () => {
  it("delivers the same text and the same usage generate reports, in exactly one terminal event", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "text" };
    const events = await collect(
      adapter().stream(request(TOOL_MODEL), context(new AbortController().signal)),
    );
    const deltas = events
      .filter((event) => event.type === "delta")
      .map((event) => (event.type === "delta" ? event.text : ""));
    assert.deepEqual(
      deltas,
      FRAGMENTS,
      "a delta is a piece, not a running total: the consumer concatenates",
    );
    assert.equal(deltas.join(""), TEXT);
    const terminal = events.at(-1);
    assert.equal(terminal?.type, "done");
    assert.deepEqual(terminal?.type === "done" ? terminal.usage : undefined, {
      inputTokens: USAGE.input,
      outputTokens: USAGE.output,
    });
    assert.equal(
      events.filter((event) => ["done", "error", "cancelled"].includes(event.type)).length,
      1,
      "two terminal events would let a consumer read a truncated answer as finished",
    );
  });

  it("accumulates a tool call streamed in fragments, because arguments are only JSON when the last piece lands", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "tool-call" };
    const events = await collect(
      adapter().stream(request(TOOL_MODEL), context(new AbortController().signal)),
    );
    const calls = events.filter((event) => event.type === "tool-call");
    assert.equal(calls.length, 1, "three fragments of one call are one call, not three");
    const first = calls[0];
    assert.deepEqual(
      first?.type === "tool-call"
        ? { id: first.id, name: first.name, arguments: first.arguments }
        : undefined,
      { id: "call_1", name: "file.read", arguments: { path: "notes/todo.md" } },
    );
    const terminal = events.at(-1);
    assert.equal(terminal?.type, "done");
    assert.equal(terminal?.type === "done" ? terminal.finishReason : undefined, "tool-calls");
  });

  it("reports zero usage rather than an estimate when the endpoint sends none", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "no-usage-stream" };
    const events = await collect(
      adapter().stream(request(TOOL_MODEL), context(new AbortController().signal)),
    );
    const terminal = events.at(-1);
    assert.equal(terminal?.type, "done");
    assert.deepEqual(
      terminal?.type === "done" ? terminal.usage : undefined,
      { inputTokens: 0, outputTokens: 0 },
      "`Usage` has no 'unknown', and a character-count guess dressed as a measurement would be spent by §3.4's budget as " +
        "if it were one; D-100 records that the honest fix is a `reported` flag and that it belongs to §3.4's owner",
    );
  });

  it("still streams for a model that declares no streaming, because the flag describes the endpoint and not the method", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "text" };
    local.requests.length = 0;
    const events = await collect(
      adapter().stream(request(NO_STREAM_MODEL), context(new AbortController().signal)),
    );
    assert.deepEqual(
      events.map((event) => event.type),
      ["delta", "done"],
      "§3.1 requires the method and its terminal states; it does not require the wire to be SSE",
    );
    const sent = local.last();
    assert.equal(
      sent?.body.stream,
      false,
      "and the endpoint is asked in the one shape it declares it can answer",
    );
  });
});

describe("the four deadlines §3.5 asks to be distinguishable", () => {
  it("names a connect deadline when the endpoint never sends headers", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "hang", ms: 1_500 };
    await assert.rejects(
      () => adapter().generate(request(TOOL_MODEL), context(new AbortController().signal)),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.class, "timeout");
        assert.equal(error.deadline, "connect");
        return true;
      },
      "§3.5: distinguish connect vs first-token vs stall, because a ladder that cannot tell them apart retries the wrong thing",
    );
  });

  it("names a first-token deadline when headers arrive and no delta follows", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "silent-stream" };
    const events = await collect(
      adapter().stream(request(TOOL_MODEL), context(new AbortController().signal)),
    );
    const terminal = events.at(-1);
    assert.equal(terminal?.type, "error");
    assert.equal(terminal?.type === "error" ? terminal.error.class : undefined, "timeout");
    assert.equal(terminal?.type === "error" ? terminal.error.deadline : undefined, "first-token");
  });

  it("names a stall deadline when a stream goes quiet between deltas", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "quiet-stream" };
    const events = await collect(
      adapter().stream(request(TOOL_MODEL), context(new AbortController().signal)),
    );
    assert.equal(events[0]?.type, "delta", "the first fragment did arrive");
    const terminal = events.at(-1);
    assert.equal(terminal?.type, "error");
    assert.equal(terminal?.type === "error" ? terminal.error.deadline : undefined, "stall");
  });

  it("names the absolute deadline the runtime supplied, even for a stream that keeps talking", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "slow-stream", everyMs: 30 };
    const events = await collect(
      adapter().stream(
        request(TOOL_MODEL),
        context(new AbortController().signal, { timeoutMs: 250 }),
      ),
    );
    const terminal = events.at(-1);
    assert.equal(terminal?.type, "error");
    assert.equal(
      terminal?.type === "error" ? terminal.error.deadline : undefined,
      "absolute",
      "D-074's fourth number: a call that ran out of budget is a different fact from an endpoint that never answered, " +
        "and §3.1 makes the runtime the party that supplies it",
    );
    assert.ok(
      events.some((event) => event.type === "delta"),
      "the stream was healthy right up to the budget, which is what makes this the absolute deadline and not a stall",
    );
  });

  it("defaults the three adapter deadlines to D-074's numbers rather than to a second copy of them", () => {
    assert.deepEqual(
      OPENAI_DEADLINE_DEFAULTS,
      {
        connectMs: 10_000,
        firstTokenMs: 60_000,
        idleStreamMs: 45_000,
      },
      "`packages/core` owns these; an adapter that retyped them would drift from what `crabby config get limits` prints",
    );
  });
});

describe("cancellation, which is best-effort and has to behave like it", () => {
  it("ends a stream as cancelled when the caller aborts mid-answer", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "slow-stream", everyMs: 30 };
    const controller = new AbortController();
    const events: StreamEvent[] = [];
    for await (const event of adapter().stream(request(TOOL_MODEL), context(controller.signal))) {
      events.push(event);
      if (event.type === "delta") controller.abort();
    }
    assert.equal(
      events.at(-1)?.type,
      "cancelled",
      "an abort during a stream ends it as cancelled, not as done",
    );
  });

  it("rejects generate with the cancelled class when the signal is already aborted", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "text" };
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => adapter().generate(request(TOOL_MODEL), context(controller.signal)),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.class, "cancelled", "§3.5: terminal, not an error worth retrying");
        assert.equal(error.retryable, false);
        return true;
      },
    );
  });

  it("reaches an in-flight request through cancel(), by the runtime's request id", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "hang", ms: 3_000 };
    const provider = adapter();
    const ctx = context(new AbortController().signal, { requestId: "req_cancel_me" });
    const pending = provider.generate(request(TOOL_MODEL), ctx);
    await provider.cancel?.({ requestId: ctx.requestId });
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(
        error.class,
        "cancelled",
        "an adapter-side abort is still a cancellation, not a timeout",
      );
      assert.equal(error.deadline, undefined, "and it is not reported as a deadline that tripped");
      return true;
    });
  });

  it("does nothing for a request id it never saw, because best-effort means best-effort", async () => {
    const provider = adapter();
    await provider.cancel?.({ requestId: "req_never_existed" });
    assert.ok(
      true,
      "a cancel for an unknown id is a no-op rather than a throw: the request may have finished a moment ago",
    );
  });
});

describe("§3.5's mapping of what an endpoint can do wrong", () => {
  const cases: [StubMode, ProviderErrorClass, string][] = [
    [{ kind: "status", status: 401 }, "auth", "a rejected credential"],
    [{ kind: "status", status: 403 }, "auth", "a forbidden credential"],
    [{ kind: "status", status: 402 }, "billing", "out of credit"],
    [{ kind: "status", status: 429, retryAfter: "2" }, "rate-limit", "a rate limit with a hint"],
    [{ kind: "status", status: 503 }, "overloaded", "an upstream that is busy"],
    [{ kind: "status", status: 408 }, "timeout", "the endpoint's own timeout"],
    [
      { kind: "status", status: 400, body: "This value exceeds the model maximum context length" },
      "context-overflow",
      "a 400 whose prose is the authoritative signal",
    ],
    [
      { kind: "status", status: 400, body: "your input was flagged by the content filter" },
      "content-filter",
      "a filter, which §3.5 says must be distinguishable from a model failure",
    ],
    [{ kind: "close" }, "overloaded", "a socket closed before headers"],
  ];

  for (const [mode, expected, title] of cases) {
    it(`maps ${title} onto ${expected}`, async () => {
      const local = stub;
      assert.ok(local);
      local.mode = mode;
      await assert.rejects(
        () => adapter().generate(request(TOOL_MODEL), context(new AbortController().signal)),
        (error: unknown) => {
          assert.ok(
            error instanceof ProviderError,
            "a raw provider error may not reach the runtime",
          );
          assert.equal(error.class, expected);
          assert.ok(
            (PROVIDER_ERROR_CLASSES as readonly string[]).includes(error.class),
            "and whatever it produced is one of §3.5's ten",
          );
          return true;
        },
      );
    });
  }

  it("carries a rate limit's retry-after into the error, where D-064's ladder reads it", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "status", status: 429, retryAfter: "3" };
    await assert.rejects(
      () => adapter().generate(request(TOOL_MODEL), context(new AbortController().signal)),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.class, "rate-limit");
        assert.equal(
          error.retryAfterMs,
          3_000,
          "a provider hint moves D-064's wait up, never down, and it can only do that if the adapter reads the header",
        );
        return true;
      },
    );
  });

  it("reports a dead endpoint as overloaded and names the endpoint, because §3.5 has no 'unreachable' class", async () => {
    const provider = createOpenAiCompatibleProvider({
      config: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "stub-key" },
      models: MODELS,
      deadlines: { connectMs: 200, firstTokenMs: 200, idleStreamMs: 200 },
    });
    await assert.rejects(
      () => provider.generate(request(TOOL_MODEL), context(new AbortController().signal)),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(
          error.class,
          "overloaded",
          "a refused connection is the retryable-and-escalating kind of failure, and `invalid-response` would put a dead " +
            "endpoint in the same bucket as a malformed body, which the ladder treats differently",
        );
        assert.match(error.message, /could not be reached/);
        return true;
      },
    );
  });
});

describe("§3.3's configuration rules", () => {
  it("rejects a URL that carries credentials, and says where the key belongs instead", () => {
    const provider = adapter();
    const result = provider.validateConfig({
      baseUrl: "https://user:sk-live@example.invalid/v1",
      apiKey: "sk-live",
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /credentials/);
    assert.match(result.reason, /vault/);
    assert.match(
      result.reason,
      /baseUrl/,
      "the reason names the field at fault, because §3.1 asks for an actionable reason and 'unusable' is not one",
    );
  });

  it("warns about a key over plain HTTP to another host, and does not refuse it", () => {
    const provider = adapter();
    const result = provider.validateConfig({
      baseUrl: "http://192.168.1.20:1234/v1",
      apiKey: "sk-lan",
    });
    assert.equal(
      result.ok,
      true,
      "a LAN llama-server on plain HTTP is a setup §3.3 accepts, and the risk is the user's to take",
    );
    if (!result.ok) return;
    assert.equal(result.warnings?.length, 1);
    assert.match(result.warnings?.[0] ?? "", /plain HTTP/);
    assert.match(result.warnings?.[0] ?? "", /192\.168\.1\.20/);
    assert.match(
      result.warnings?.[0] ?? "",
      /reported rather than refused/,
      "the warning says who decided, because an adapter that rejected this would be making a security decision the document assigned to the user",
    );
  });

  it("stays quiet about loopback and about TLS, where there is nothing to warn about", () => {
    const provider = adapter();
    const local = stub;
    assert.ok(local);
    for (const baseUrl of [
      local.baseUrl,
      "https://api.groq.com/openai/v1",
      "http://localhost:1234/v1",
      "http://[::1]:1234/v1",
    ]) {
      const result = provider.validateConfig({ baseUrl, apiKey: "sk-x" });
      assert.equal(result.ok, true, baseUrl);
      assert.equal(
        result.ok ? result.warnings : undefined,
        undefined,
        `${baseUrl}: a warning that fires on a safe configuration trains a user to ignore the one that matters`,
      );
    }
  });

  it("refuses to construct on an unparsable descriptor, a duplicate model or no models at all", () => {
    assert.throws(
      () =>
        createOpenAiCompatibleProvider({
          config: { baseUrl: "https://x.invalid/v1" },
          models: [
            { id: "m", descriptor: { contextWindow: 8192, supports: { toolCallings: true } } },
          ],
          deadlines: TEST_DEADLINES,
        }),
      /unparsable descriptor/,
      "§3.2: an unparsable descriptor disables the provider rather than defaulting everything on — and the typo in that " +
        "`supports` key is the exact one a structural type would erase",
    );
    assert.throws(
      () =>
        createOpenAiCompatibleProvider({
          config: { baseUrl: "https://x.invalid/v1" },
          models: [
            MODELS[0] as { id: string; descriptor: unknown },
            MODELS[0] as { id: string; descriptor: unknown },
          ],
          deadlines: TEST_DEADLINES,
        }),
      /declared twice/,
    );
    assert.throws(
      () =>
        createOpenAiCompatibleProvider({
          config: { baseUrl: "https://x.invalid/v1" },
          models: [],
          deadlines: TEST_DEADLINES,
        }),
      /no models were declared/,
    );
    assert.throws(
      () =>
        createOpenAiCompatibleProvider({
          config: { baseUrl: "ftp://x.invalid/v1" },
          models: MODELS,
          deadlines: TEST_DEADLINES,
        }),
      /unusable/,
      "§3.1's rule is that unusable configuration is rejected *before any call*, and an adapter that constructs and then " +
        "fails every call has not rejected anything",
    );
  });

  it("is the same adapter with a different name, because §3.3's presets carry no privileged behavior", async () => {
    const local = stub;
    assert.ok(local);
    local.mode = { kind: "text" };
    const groq = adapter({ id: "groq" });
    assert.equal(groq.id, "groq");
    const result = await groq.generate(request(TOOL_MODEL), context(new AbortController().signal));
    assert.equal(
      result.text,
      TEXT,
      "a preset is a base URL, a name and a model list — nothing else differs",
    );
  });
});
