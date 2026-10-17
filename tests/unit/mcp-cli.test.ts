// C-E13's ready verbs, run the way the CLI is tested. The one assertion that matters most is the negative one: the
// secret VALUE the source file carried exists nowhere under the state dir after the import — names only, per §11's
// C-2 scope and D-137.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ENTRY = path.join(REPO, "apps/cli/crabby.ts");

function crabby(args: string[], dataDir: string) {
  const run = spawnSync(process.execPath, [ENTRY, "--data-dir", dataDir, ...args], {
    encoding: "utf8",
    cwd: REPO,
    env: { ...process.env, HOME: path.dirname(dataDir) },
  });
  return { code: run.status, out: run.stdout ?? "", err: run.stderr ?? "" };
}

test("mcp add imports a foreign server list with names kept and values dropped", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "crabby-mcp-cli-"));
  try {
    const dataDir = path.join(dir, "data");
    const source = path.join(dir, "servers.json");
    writeFileSync(
      source,
      JSON.stringify({
        mcpServers: {
          builder: { command: "npx", args: ["-y", "server"], env: { TOKEN: "secret-value" } },
          docs: {
            url: "https://docs.example.com/mcp",
            headers: { Authorization: "Bearer secret" },
          },
        },
      }),
      "utf8",
    );
    const added = crabby(["mcp", "add", source], dataDir);
    assert.equal(added.code, 0, added.out);
    assert.match(added.out, /imported\s+2 server/);
    assert.match(added.out, /values\s+2 environment\/header value\(s\) dropped/);
    assert.match(added.out, /report\s+\S+reports\/report-.*\.json/);
    // The state dir carries the names, never the values.
    const entries = readFileSync(path.join(dataDir, "mcp", "servers.json"), "utf8");
    assert.match(entries, /TOKEN/);
    assert.doesNotMatch(entries, /secret-value/);
    assert.doesNotMatch(entries, /Bearer secret/);
    const listed = crabby(["mcp", "list"], dataDir);
    assert.equal(listed.code, 0);
    assert.match(listed.out, /builder\s+stdio · npx -y server · env\/header names: TOKEN/);
    assert.match(listed.out, /docs\s+http · https:\/\/docs\.example\.com\/mcp/);
    const listedJson = crabby(["mcp", "list", "--json"], dataDir);
    const document = JSON.parse(listedJson.out) as {
      ok: boolean;
      servers: Record<string, { transport: string }>;
    };
    assert.equal(document.ok, true);
    assert.equal(document.servers.builder?.transport, "stdio");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mcp add refuses a file with no server list, and a missing file is a usage error", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "crabby-mcp-cli2-"));
  try {
    const dataDir = path.join(dir, "data");
    const source = path.join(dir, "not-servers.json");
    writeFileSync(source, JSON.stringify({ hello: true }), "utf8");
    const refused = crabby(["mcp", "add", source], dataDir);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /no server list found/);
    const missing = crabby(["mcp", "add", path.join(dir, "absent.json")], dataDir);
    assert.equal(missing.code, 2);
    const noServers = crabby(["mcp", "list"], dataDir);
    assert.equal(noServers.code, 0);
    assert.match(noServers.out, /no servers configured/);
    assert.ok(!existsSync(path.join(dataDir, "mcp")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
