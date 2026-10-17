// The §10 client: two transports (stdio child process, remote HTTP), discovery through policy's registration gate,
// and the caps D-137 binds — output past the tool cap cut with a named marker, two calls in flight per server, a
// per-call timeout of the tool-class deadline plus `extensionAdapterOverheadMs`, and a server that fails to start or
// dies mid-call answered by a typed `mcp_server_error` naming the phase, never by an empty tool list.
//
// The protocol is deliberately the small, stable slice an MCP client needs: `initialize` (with the
// `notifications/initialized` follow-up), `tools/list`, `tools/call`. Framing on stdio is one JSON message per line;
// on HTTP it is POST JSON-RPC with `application/json` or `text/event-stream` answers, and the `Mcp-Session-Id` the
// server assigns on initialize is echoed on every later call.
import { type ChildProcess, spawn } from "node:child_process";
import { MAX_TOOL_OUTPUT_BYTES } from "@crabby/api-contracts";
import { LIMITS_DEFAULTS } from "@crabby/core";
import { extensionTier, registerTool } from "@crabby/policy";
import { TOOL_ALIASES } from "./convert.ts";
import { type HttpServerEntry, MCP_PROTOCOL_VERSION, type StdioServerEntry } from "./mcp-config.ts";

export class McpServerError extends Error {
  readonly code = "mcp_server_error";
  readonly phase: "start" | "handshake" | "list" | "call" | "connection";

  constructor(phase: "start" | "handshake" | "list" | "call" | "connection", message: string) {
    super(message);
    this.phase = phase;
  }
}

export interface McpToolDeclaration {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

export interface McpCallResult {
  readonly content: string;
  readonly isError: boolean;
  /** Set when Crabby cut the result at the tool-output cap — the marker names the cap, so a reader knows the shape
   *  of what was removed rather than finding a sentence that ends mid-word. */
  readonly truncated: boolean;
}

export interface DiscoveryReport {
  readonly server: string;
  readonly registered: readonly { readonly tool: string; readonly capability: string }[];
  /** Policy's own refusal sentences, verbatim — the security property stays the refusal, the report is how it is
   *  seen without weakening it (D-137). */
  readonly refused: readonly { readonly tool: string; readonly reason: string }[];
}

/** The per-call timeout: the priced row's own arithmetic — tool-class deadline plus the 5 s adapter overhead — so a
 *  slow plugin is blamed on neither the tool nor the host (PROVIDERS_AND_TOOLS §deadlines, D-137). */
export function mcpCallTimeoutMs(capability: string): number {
  const base =
    capability === "shell.run"
      ? LIMITS_DEFAULTS.shellRunTimeoutMs
      : capability === "net.fetch" || capability === "http.request"
        ? LIMITS_DEFAULTS.netFetchTimeoutMs
        : LIMITS_DEFAULTS.fsTimeoutMs;
  return base + LIMITS_DEFAULTS.extensionAdapterOverheadMs;
}

/** The §6.1 capability a discovered tool's name maps to — the same explicit alias table the C-1 report uses, so the
 *  client's mapping and the report's mapping cannot disagree. A name outside the table maps to nothing, and nothing
 *  is what the registration gate refuses with. */
export function mapMcpToolToCapability(tool: McpToolDeclaration): string | undefined {
  const haystack = tool.name.toLowerCase();
  for (const [alias, capability] of Object.entries(TOOL_ALIASES)) {
    if (haystack.includes(alias)) return capability;
  }
  return undefined;
}

interface Waiting {
  readonly resolve: (value: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

/** The JSON-RPC layer both transports share: one request id counter, responses matched by id, and the in-flight cap
 *  (`parallelToolSteps`' own number, applied per server) enforced by queueing rather than refusing. */
abstract class JsonRpcPeer {
  private nextId = 1;
  private pending = new Map<number, Waiting>();
  private inFlight = 0;
  private readonly queue: (() => void)[] = [];
  private readonly maxInFlight = LIMITS_DEFAULTS.parallelToolSteps;

  protected abstract send(message: Record<string, unknown>): void;

  protected rejectAll(message: string, phase: "connection" | "start" = "connection"): void {
    for (const [, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      waiting.reject(new McpServerError(phase, message));
    }
    this.pending.clear();
  }

  protected request(
    method: string,
    params: Record<string, unknown>,
    phase: "handshake" | "list" | "call",
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const run = (): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const id = this.nextId;
        this.nextId += 1;
        const cleanup = (): void => {
          clearTimeout(waiting.timer);
          this.pending.delete(id);
          this.inFlight -= 1;
          this.pump();
        };
        const timer = setTimeout(() => {
          if (!this.pending.has(id)) return;
          cleanup();
          reject(
            new McpServerError(
              phase,
              `no answer to '${method}' within ${timeoutMs} ms — Crabby's cap, not the server's`,
            ),
          );
        }, timeoutMs);
        const waiting: Waiting = {
          resolve: (value) => {
            cleanup();
            resolve(value);
          },
          reject: (error) => {
            cleanup();
            reject(error);
          },
          timer,
        };
        this.pending.set(id, waiting);
        this.inFlight += 1;
        this.send({ jsonrpc: "2.0", id, method, params });
      });
    if (this.inFlight < this.maxInFlight) return run();
    return new Promise((resolve) => {
      this.queue.push(() => {
        resolve(run());
      });
    });
  }

  private pump(): void {
    const next = this.queue.shift();
    if (next !== undefined) next();
  }

  protected settle(id: number, response: Record<string, unknown>): void {
    const waiting = this.pending.get(id);
    if (waiting === undefined) return;
    if (typeof response.error === "object" && response.error !== null) {
      waiting.reject(
        new McpServerError(
          "call",
          `the server answered with an error: ${JSON.stringify(response.error)}`,
        ),
      );
    } else {
      waiting.resolve(response);
    }
  }
}

function resultOf(
  response: Record<string, unknown>,
  phase: "list" | "call",
): Record<string, unknown> {
  const result = response.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new McpServerError(phase, "the server's answer carried no result");
  }
  return result as Record<string, unknown>;
}

function textOf(result: Record<string, unknown>): { content: string; isError: boolean } {
  const blocks = Array.isArray(result.content) ? result.content : [];
  const content = blocks
    .map((block) =>
      typeof block === "object" &&
      block !== null &&
      (block as Record<string, unknown>).type === "text"
        ? String((block as Record<string, unknown>).text ?? "")
        : "",
    )
    .filter((block) => block.length > 0)
    .join("\n");
  return { content, isError: result.isError === true };
}

function capped(text: string, isError: boolean): McpCallResult {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= MAX_TOOL_OUTPUT_BYTES) return { content: text, isError, truncated: false };
  const cut = Buffer.from(text, "utf8").subarray(0, MAX_TOOL_OUTPUT_BYTES).toString("utf8");
  return {
    content: `${cut}\n[truncated by Crabby: the server returned ${bytes} bytes and the tool cap is ${MAX_TOOL_OUTPUT_BYTES}]`,
    isError,
    truncated: true,
  };
}

const HANDSHAKE_TIMEOUT_MS = 10_000;

export class StdioTransport extends JsonRpcPeer {
  private readonly entry: StdioServerEntry;
  private readonly spawnProcess: typeof spawn;
  private child: ChildProcess | undefined;
  private buffer = "";
  private stderrTail = "";
  private exited = false;
  private handshakeDone = false;

  constructor(entry: StdioServerEntry, spawnProcess: typeof spawn = spawn) {
    super();
    this.entry = entry;
    this.spawnProcess = spawnProcess;
  }

  protected send(message: Record<string, unknown>): void {
    this.child?.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  /** Spawn and shake hands. The env is the process's own plus the *named* variables resolved now — names only in the
   *  file, values only here (D-137). A name with no value in the environment is a named error, not a silent empty. */
  async start(resolvedEnv: Readonly<Record<string, string>> = {}): Promise<void> {
    const missing = Object.keys(resolvedEnv).filter((name) => process.env[name] === undefined);
    if (missing.length > 0) {
      throw new McpServerError(
        "start",
        `the environment names variables this process does not have: ${missing.join(", ")}`,
      );
    }
    const child = this.spawnProcess(this.entry.command, this.entry.args ?? [], {
      env: { ...process.env, ...resolvedEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.on("error", (error) => {
      this.exited = true;
      this.rejectAll(
        `the server process failed: ${error.message}`,
        this.handshakeDone ? "connection" : "start",
      );
    });
    child.on("exit", (code) => {
      this.exited = true;
      this.rejectAll(
        `the server process exited (code ${String(code)})`,
        this.handshakeDone ? "connection" : "start",
      );
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString("utf8")}`.slice(-2048);
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      let newline = this.buffer.indexOf("\n");
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (line.length > 0) {
          try {
            const message = JSON.parse(line) as Record<string, unknown>;
            if (typeof message.id === "number") this.settle(message.id, message);
          } catch {
            // A line that is not JSON is not a message; the protocol's framing is one JSON object per line.
          }
        }
        newline = this.buffer.indexOf("\n");
      }
    });
    const response = await this.request(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "crabby", version: "0.0.0" },
      },
      "handshake",
      HANDSHAKE_TIMEOUT_MS,
    );
    if (response.error !== undefined) {
      throw new McpServerError("handshake", "the server refused the initialize handshake");
    }
    this.handshakeDone = true;
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async listTools(timeoutMs = HANDSHAKE_TIMEOUT_MS): Promise<readonly McpToolDeclaration[]> {
    if (this.exited) throw new McpServerError("connection", "the server process is not running");
    const result = resultOf(await this.request("tools/list", {}, "list", timeoutMs), "list");
    return toolsOf(result);
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<McpCallResult> {
    if (this.exited) throw new McpServerError("connection", "the server process is not running");
    let response: Record<string, unknown>;
    try {
      response = await this.request("tools/call", { name, arguments: args }, "call", timeoutMs);
    } catch (error) {
      if (error instanceof McpServerError && error.phase === "connection") {
        throw new McpServerError(
          "call",
          `the server died during the call${this.stderrTail.trim().length > 0 ? ` — stderr tail: ${this.stderrTail.trim()}` : ""}`,
        );
      }
      throw error;
    }
    const text = textOf(resultOf(response, "call"));
    return capped(text.content, text.isError);
  }

  stop(): void {
    if (this.child !== undefined && !this.exited) {
      this.child.kill();
    }
    this.rejectAll("the client stopped");
  }
}

export class HttpTransport extends JsonRpcPeer {
  private readonly entry: HttpServerEntry;
  private readonly doFetch: typeof fetch;
  private sessionId: string | undefined;

  constructor(entry: HttpServerEntry, doFetch: typeof fetch = fetch) {
    super();
    this.entry = entry;
    this.doFetch = doFetch;
  }

  protected send(message: Record<string, unknown>): void {
    void this.post(message).then(
      (response) => {
        if (typeof response.id === "number") this.settle(response.id, response);
      },
      (error: Error) => {
        this.rejectAll(error.message);
      },
    );
  }

  private async post(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.doFetch(this.entry.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(this.sessionId === undefined ? {} : { "mcp-session-id": this.sessionId }),
        },
        body: JSON.stringify(message),
      });
    } catch (error) {
      throw new McpServerError(
        "connection",
        `the server at ${this.entry.url} did not answer: ${(error as Error).message}`,
      );
    }
    const session = response.headers.get("mcp-session-id");
    if (session !== null) this.sessionId = session;
    const type = response.headers.get("content-type") ?? "";
    const body = await response.text();
    if (type.includes("text/event-stream")) {
      // SSE answers arrive as `data:` lines; the JSON payloads are found by id, ignoring the commentary events.
      for (const line of body.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        try {
          const parsed = JSON.parse(trimmed.slice(5).trim()) as Record<string, unknown>;
          if (parsed.id === message.id) return parsed;
        } catch {
          // Not every data line carries a response.
        }
      }
      throw new McpServerError("connection", "the event stream carried no answer to this request");
    }
    try {
      return JSON.parse(body) as Record<string, unknown>;
    } catch {
      throw new McpServerError(
        "connection",
        `the server's answer was neither JSON nor an event stream: ${body.slice(0, 200)}`,
      );
    }
  }

  async start(): Promise<void> {
    const response = await this.post({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "crabby", version: "0.0.0" },
      },
    });
    if (response.error !== undefined) {
      throw new McpServerError("handshake", "the server refused the initialize handshake");
    }
  }

  async listTools(timeoutMs = HANDSHAKE_TIMEOUT_MS): Promise<readonly McpToolDeclaration[]> {
    const result = resultOf(await this.request("tools/list", {}, "list", timeoutMs), "list");
    return toolsOf(result);
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<McpCallResult> {
    const text = textOf(
      resultOf(
        await this.request("tools/call", { name, arguments: args }, "call", timeoutMs),
        "call",
      ),
    );
    return capped(text.content, text.isError);
  }

  stop(): void {
    this.rejectAll("the client stopped");
  }
}

function toolsOf(result: Record<string, unknown>): readonly McpToolDeclaration[] {
  const tools = result.tools;
  if (!Array.isArray(tools))
    throw new McpServerError("list", "the server's tools/list answer carried no tool list");
  return tools.filter(
    (tool): tool is McpToolDeclaration & Record<string, unknown> =>
      typeof tool === "object" &&
      tool !== null &&
      typeof (tool as Record<string, unknown>).name === "string",
  );
}

export type McpTransportClient = StdioTransport | HttpTransport;

/** Discovery: the server's tools, through policy's gate. The T2 floor is not negotiable from the server's side — a
 *  declared tier is the field §10 says a server would lie in, so it is never read (D-137). */
export async function discoverTools(
  server: string,
  transport: McpTransportClient,
): Promise<DiscoveryReport> {
  const tools = await transport.listTools();
  const registered: { tool: string; capability: string }[] = [];
  const refused: { tool: string; reason: string }[] = [];
  for (const tool of tools) {
    const namespaced = `mcp:${server}:${tool.name}`;
    const capability = mapMcpToolToCapability(tool);
    if (capability === undefined) {
      refused.push({
        tool: namespaced,
        reason: `'${tool.name}' names no §6.1 capability in its name or description, so policy could not name what it asks for — not registered`,
      });
      continue;
    }
    const floor = extensionTier(undefined);
    if (!floor.ok) {
      refused.push({ tool: namespaced, reason: floor.reason });
      continue;
    }
    const result = registerTool({
      tool: namespaced,
      capabilities: [capability],
      source: "plugin",
      tier: floor.tier,
    });
    if (result.ok) registered.push({ tool: namespaced, capability });
    else refused.push({ tool: namespaced, reason: result.reason });
  }
  return { server, registered, refused };
}
