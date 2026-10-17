// §10's client, against servers this file itself stands up — a real child process speaking JSON-RPC over stdio, a
// real HTTP server answering in both content types the transport accepts — because a mock client proves nothing
// about framing. The security shape is pinned where the spec writes it: env values never leave the import file
// (C-2), discovery registers through policy's gate with the T2 floor and refuses the unnameable (D-137), and the
// caps are Crabby's — output cut with a named marker, calls timed out at Crabby's arithmetic, a dead server a typed
// error rather than an empty tool list.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { resolveTool } from "@crabby/policy";
import {
  discoverTools,
  HttpTransport,
  McpServerError,
  mapMcpToolToCapability,
  mcpCallTimeoutMs,
  StdioTransport,
} from "./mcp.ts";
import { loadServerEntries, parseServerEntries, serversFilePath } from "./mcp-config.ts";
import { importMcpServers } from "./mcp-import.ts";

const dirs: string[] = [];
function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `crabby-mcp-${prefix}-`));
  dirs.push(dir);
  return dir;
}
const servers: Server[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const server of servers.splice(0)) server.close();
});

/** A real MCP server over stdio: newline-delimited JSON-RPC, initialize → tools/list → tools/call. The tools are
 *  chosen to exercise both sides of the registration gate: `bash` maps to shell.run, `get_weather` maps to nothing. */
function stdioServerScript(): string {
  return `
const tools = [
  { name: "bash", description: "Run a shell command.", inputSchema: { type: "object" } },
  { name: "get_weather", description: "Weather somewhere.", inputSchema: { type: "object" } },
];
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line.length > 0) answer(JSON.parse(line));
    newline = buffer.indexOf("\\n");
  }
});
function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n"); }
function answer(message) {
  if (message.method === "initialize") reply(message.id, { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fixture", version: "1.0.0" } });
  else if (message.method === "tools/list") reply(message.id, { tools });
  else if (message.method === "tools/call") {
    const text = message.params.arguments && message.params.arguments.huge === true
      ? "x".repeat(300000)
      : "ran " + String(message.params.arguments && message.params.arguments.what);
    reply(message.id, { content: [{ type: "text", text }] });
  }
}
`;
}

async function startStdio(script: string, command?: string): Promise<StdioTransport> {
  const dir = scratch("stdio");
  const server = join(dir, "fixture-server.mjs");
  writeFileSync(server, script, "utf8");
  const transport = new StdioTransport({
    transport: "stdio",
    command: command ?? process.execPath,
    args: [server],
  });
  await transport.start();
  return transport;
}

describe("the MCP client (§10)", () => {
  it("shakes hands over stdio, lists tools, and calls one", async () => {
    const transport = await startStdio(stdioServerScript());
    try {
      const tools = await transport.listTools();
      assert.deepEqual(
        tools.map((tool) => tool.name),
        ["bash", "get_weather"],
      );
      const result = await transport.callTool("bash", { what: "ls" }, 5_000);
      assert.equal(result.content, "ran ls");
      assert.equal(result.truncated, false);
    } finally {
      transport.stop();
    }
  });

  it("answers a server that fails to start with a typed error naming the phase, not an empty list", async () => {
    const transport = new StdioTransport({
      transport: "stdio",
      command: "definitely-not-a-real-binary-xyz",
    });
    await assert.rejects(transport.start(), (error: unknown) => {
      assert.ok(error instanceof McpServerError);
      assert.equal(error.code, "mcp_server_error");
      assert.equal(error.phase, "start");
      return true;
    });
  });

  it("cuts oversized results at the tool cap with a marker naming both numbers", async () => {
    const transport = await startStdio(stdioServerScript());
    try {
      const result = await transport.callTool("bash", { huge: true }, 5_000);
      assert.equal(result.truncated, true);
      assert.match(
        result.content,
        /\[truncated by Crabby: the server returned 300000 bytes and the tool cap is \d+\]/,
      );
    } finally {
      transport.stop();
    }
  });

  it("times a silent server out at Crabby's cap, naming whose cap it was", async () => {
    const dir = scratch("slow");
    const server = join(dir, "slow-server.mjs");
    writeFileSync(
      server,
      `process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line.length > 0) {
      const message = JSON.parse(line);
      if (message.method === "initialize") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: {} } }) + "\\n");
      }
      // everything else: read, never answered
    }
    newline = buffer.indexOf("\\n");
  }
});
setTimeout(() => process.exit(0), 5000);
`,
      "utf8",
    );
    const transport = new StdioTransport({
      transport: "stdio",
      command: process.execPath,
      args: [server],
    });
    await transport.start();
    try {
      await assert.rejects(transport.callTool("bash", {}, 300), (error: unknown) => {
        assert.ok(error instanceof McpServerError);
        assert.match(error.message, /Crabby's cap, not the server's/);
        return true;
      });
    } finally {
      transport.stop();
    }
  });

  it("registers discovered tools namespaced and tier-floored, and refuses the unnameable", async () => {
    const transport = await startStdio(stdioServerScript());
    try {
      const report = await discoverTools("fixture", transport);
      assert.equal(report.registered.length, 1);
      const row = report.registered[0] as { tool: string; capability: string };
      assert.equal(row.tool, "mcp:fixture:bash");
      assert.equal(row.capability, "shell.run");
      assert.equal(report.refused.length, 1);
      assert.match(report.refused[0]?.reason ?? "", /could not name what it asks for/);
      // The registry row: T2 floor until a human re-classifies (extensionTier(undefined)).
      const spec = resolveTool("mcp:fixture:bash");
      assert.ok(spec !== undefined);
      assert.equal(spec.tier, "T2");
      assert.deepEqual(spec.capabilities, ["shell.run"]);
    } finally {
      transport.stop();
    }
  });

  it("maps tool names through the same alias table the C-1 report uses", () => {
    assert.equal(mapMcpToolToCapability({ name: "read_file" }), "fs.read");
    assert.equal(mapMcpToolToCapability({ name: "webfetch_url" }), "net.fetch");
    assert.equal(mapMcpToolToCapability({ name: "get_weather" }), undefined);
  });

  it("speaks to a real HTTP server in both content types the transport accepts", async () => {
    const requests: { id: unknown; method: unknown; session: string | null }[] = [];
    const httpServer = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const message = JSON.parse(body) as { id: number; method: string };
        requests.push({
          id: message.id,
          method: message.method,
          session: (() => {
            const value = request.headers["mcp-session-id"];
            return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
          })(),
        });
        const reply = (result: unknown): void => {
          if (message.method === "tools/call") {
            // One answer rides an event stream, the other plain JSON — the transport accepts both.
            const sse = requests.length % 2 === 0;
            const payload = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
            response.setHeader("content-type", sse ? "text/event-stream" : "application/json");
            if (sse) response.end(`event: message\ndata: ${payload}\n\n`);
            else response.end(payload);
            return;
          }
          response.setHeader("content-type", "application/json");
          if (message.method === "initialize") response.setHeader("mcp-session-id", "session-1");
          response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
        };
        if (message.method === "initialize") {
          reply({
            protocolVersion: "2024-11-05",
            capabilities: {},
            serverInfo: { name: "http-fixture", version: "1.0.0" },
          });
        } else if (message.method === "tools/list") {
          reply({
            tools: [
              { name: "fetch_page", description: "Fetches.", inputSchema: { type: "object" } },
            ],
          });
        } else if (message.method === "tools/call") {
          reply({ content: [{ type: "text", text: "page body" }], isError: false });
        }
      });
    });
    const port = await new Promise<number>((resolve) => {
      httpServer.listen(0, "127.0.0.1", () =>
        resolve((httpServer.address() as { port: number }).port),
      );
    });
    servers.push(httpServer);
    const transport = new HttpTransport({ transport: "http", url: `http://127.0.0.1:${port}/mcp` });
    await transport.start();
    try {
      const tools = await transport.listTools();
      assert.deepEqual(
        tools.map((tool) => tool.name),
        ["fetch_page"],
      );
      const result = await transport.callTool("fetch_page", { url: "https://example.com" }, 5_000);
      assert.equal(result.content, "page body");
      // The session the server assigned on initialize rides the later calls.
      assert.ok(
        requests.every((row) => row.method === "initialize" || row.session === "session-1"),
      );
    } finally {
      transport.stop();
    }
  });

  it("prices a call at the tool-class deadline plus the adapter overhead", () => {
    assert.equal(mcpCallTimeoutMs("shell.run"), 125_000);
    assert.equal(mcpCallTimeoutMs("net.fetch"), 25_000);
    assert.equal(mcpCallTimeoutMs("fs.read"), 15_000);
  });
});

describe("the C-2 import (§11)", () => {
  it("imports a Claude-shaped servers.json: names kept, env values dropped by name, report written", () => {
    const dir = scratch("import");
    const stateDir = scratch("state");
    const source = join(dir, "servers.json");
    writeFileSync(
      source,
      JSON.stringify({
        mcpServers: {
          builder: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-builder"],
            env: { BUILDER_TOKEN: "secret-value" },
          },
          docs: {
            url: "https://docs.example.com/mcp",
            headers: { Authorization: "Bearer secret" },
          },
          mystery: { prompt: "do things" },
        },
      }),
      "utf8",
    );
    const result = importMcpServers({
      sourcePath: source,
      stateDir,
      now: new Date("2026-03-01T09:00:00Z"),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // The entries file exists, and the secret values exist nowhere in it.
    const entries = readFileSync(serversFilePath(stateDir), "utf8");
    assert.match(entries, /"command": "npx"/);
    assert.match(entries, /BUILDER_TOKEN/);
    assert.doesNotMatch(entries, /secret-value/);
    assert.doesNotMatch(entries, /Bearer secret/);
    // The report says what was dropped and why, and the warnings name each value.
    assert.ok(
      result.report.dropped.some(
        (entry) => entry.server === "builder" && entry.field === "env.BUILDER_TOKEN",
      ),
    );
    assert.ok(
      result.report.dropped.some(
        (entry) => entry.server === "docs" && entry.field === "headers.Authorization",
      ),
    );
    assert.ok(
      result.report.unknown.some((entry) => entry.server === "mystery" && entry.field === "prompt"),
    );
    assert.ok(result.report.warnings.some((warning) => /BUILDER_TOKEN/.test(warning)));
    // Rule 7: the source file is untouched — and it still contains the secrets it arrived with.
    assert.match(readFileSync(source, "utf8"), /secret-value/);
    // The entries parse under the native schema.
    const loaded = loadServerEntries(stateDir);
    assert.equal(loaded.parsed.ok, true);
  });

  it("merges into an existing servers.json instead of clobbering it", () => {
    const dir = scratch("merge");
    const stateDir = scratch("state2");
    const first = join(dir, "a.json");
    const second = join(dir, "b.json");
    writeFileSync(
      first,
      JSON.stringify({ mcpServers: { alpha: { command: "alpha-bin" } } }),
      "utf8",
    );
    writeFileSync(
      second,
      JSON.stringify({ mcpServers: { beta: { url: "https://beta.example.com" } } }),
      "utf8",
    );
    assert.equal(importMcpServers({ sourcePath: first, stateDir }).ok, true);
    const result = importMcpServers({ sourcePath: second, stateDir });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const loaded = loadServerEntries(stateDir);
    assert.ok(loaded.parsed.ok);
    if (!loaded.parsed.ok) return;
    assert.deepEqual(Object.keys(loaded.parsed.entries.servers).sort(), ["alpha", "beta"]);
  });

  it("refuses a file with no recognizable server list, naming the shapes it reads", () => {
    const dir = scratch("refuse");
    const source = join(dir, "servers.json");
    writeFileSync(source, JSON.stringify({ somethingElse: true }), "utf8");
    const result = importMcpServers({ sourcePath: source, stateDir: scratch("state3") });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /no server list found/);
    assert.match(result.reason, /mcpServers/);
  });

  it("parses the native servers.json strictly: unknown fields named, env values refused", () => {
    const bad = parseServerEntries(
      JSON.stringify({
        version: 1,
        servers: { weird: { transport: "stdio", command: "x", envValues: { A: "b" } } },
      }),
    );
    assert.equal(bad.ok, false);
    if (bad.ok) return;
    assert.ok(bad.problems.some((problem) => problem.path === "servers.weird.envValues"));
    const badEnv = parseServerEntries(
      JSON.stringify({
        version: 1,
        servers: {
          named: { transport: "stdio", command: "x", envNames: ["OK_NAME", "not a name"] },
        },
      }),
    );
    assert.equal(badEnv.ok, false);
    if (badEnv.ok) return;
    assert.match(badEnv.problems[0]?.message ?? "", /names only/);
    const good = parseServerEntries(
      JSON.stringify({
        version: 1,
        servers: {
          fine: { transport: "http", url: "https://x.example.com", headerNames: ["Authorization"] },
        },
      }),
    );
    assert.equal(good.ok, true);
    if (good.ok) assert.deepEqual(Object.keys(good.entries.servers), ["fine"]);
  });
});
