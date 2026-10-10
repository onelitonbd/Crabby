// The CLI is tested by running it, because everything §7.1 promises is about the process: exit codes, pipeability,
// one JSON document, and a help text that matches the registry. A unit test of an exported function would prove the
// wrong thing — that the code is correct in isolation rather than that `crabby` works.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type Check, containsSecret, tally } from "@crabby/cli/commands/doctor";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ENTRY = path.join(REPO, "apps/cli/crabby.ts");

function crabby(args: string[], dataDir?: string) {
  const argv = dataDir === undefined ? args : ["--data-dir", dataDir, ...args];
  const run = spawnSync(process.execPath, [ENTRY, ...argv], { encoding: "utf8", cwd: REPO });
  return { code: run.status, out: run.stdout ?? "", err: run.stderr ?? "" };
}

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "crabby-cli-"));
}

test("`--version` and `crabby version` are the same answer", () => {
  const flag = crabby(["--version", "--json"]);
  const command = crabby(["version", "--json"]);
  assert.equal(flag.code, 0, flag.err);
  assert.equal(
    flag.out,
    command.out,
    "a shortcut may not report something the noun-verb form does not",
  );
});

test("`crabby --help` prints the grammar and the exit-code contract, and exits 0", () => {
  const run = crabby(["--help"]);
  assert.equal(run.code, 0);
  assert.match(run.out, /^crabby <noun> <verb> \[args] \[--flags]/);
  assert.match(
    run.out,
    /exit codes: 0 success, 1 failure, 2 usage\/validation, 3 needs-approval, 4 platform-unsupported/,
  );
  for (const line of run.out.split("\n")) {
    if (line.includes("planned for")) assert.match(line, /M\d/);
  }
  const ESCAPE = String.fromCharCode(27);
  assert.ok(!run.out.includes(ESCAPE), "help must stay free of color when piped (§7.1)");
});

test("a bare `crabby` is a usage answer, not a success", () => {
  const run = crabby([]);
  assert.equal(run.code, 2, "§7.1 makes 2 the usage code, and no arguments is a usage question");
  assert.match(run.out, /crabby init/);
});

test("an unknown command is refused with exit 2 and a suggestion", () => {
  const typo = crabby(["tsk", "run", "x"]);
  assert.equal(typo.code, 2);
  assert.match(typo.out, /did you mean `crabby task run`\?/, typo.out);
  const planned = crabby(["task", "run", "do a thing"]);
  assert.equal(planned.code, 2);
  assert.match(planned.out, /not implemented yet — planned for M1/);
});

test("`init` creates the state dir, the vault at 700, and a config that holds no defaults", () => {
  const root = tempDir();
  const state = path.join(root, ".crabby");
  const first = crabby(["init"], state);
  assert.equal(first.code, 0, first.err + first.out);
  assert.match(first.out, /config\s+.*config\.json/);
  const vaultMode = readMode(state, "vault");
  assert.equal(vaultMode & 0o077, 0, "the vault directory must not be group- or world-readable");
  assert.deepEqual(JSON.parse(readFileSync(path.join(state, "config.json"), "utf8")), {});
  const second = crabby(["init"], state);
  assert.equal(second.code, 0);
  assert.match(
    second.out,
    /already there/,
    "a second init is someone checking their work, not a request to reset it",
  );
  assert.match(
    readFileSync(path.join(state, "config.json"), "utf8").trim(),
    /^\{\}$/,
    "init never overwrites",
  );
});

test("`doctor` exits 0 after init and prints a fix for every problem it can name", () => {
  const state = path.join(tempDir(), ".crabby");
  assert.equal(crabby(["init"], state).code, 0);
  const run = crabby(["doctor", "--json"], state);
  const payload = JSON.parse(run.out) as {
    ok: boolean;
    checks: { id: string; status: string; fix?: string }[];
    summary: Record<string, number>;
  };
  assert.equal(payload.ok, true, JSON.stringify(payload.checks.filter((c) => c.status === "fail")));
  const ids = payload.checks.map((c) => c.id);
  for (const required of [
    "runtime.node",
    "platform",
    "native.toolchain",
    "data.dir",
    "config",
    "vault",
    "exit.last",
    "gateway.listener",
    "gateway.paired-clients",
    "gateway.tunnel",
  ]) {
    assert.ok(
      ids.includes(required),
      `doctor must still cover ${required} (docs/DEVELOPMENT.md §10): ${ids.join(", ")}`,
    );
  }
  for (const check of payload.checks) {
    if (check.status === "fail" || check.status === "warn" || check.status === "deferred") {
      assert.ok(
        check.fix && check.fix.length > 10,
        `${check.id} reported a problem without a fix (docs/UI_UX_SPEC.md §5)`,
      );
    }
  }
  assert.equal(
    payload.checks.find((c) => c.id === "gateway.listener")?.status,
    "deferred",
    "no Gateway exists yet, so doctor may not claim one",
  );
});

test("`doctor` exits 1 when the config is broken, and names the field", () => {
  const state = path.join(tempDir(), ".crabby");
  crabby(["init"], state);
  writeFileSync(
    path.join(state, "config.json"),
    JSON.stringify({ limits: { fsTimeoutMs: "soon" }, logging: 3 }),
  );
  const run = crabby(["doctor"], state);
  assert.equal(run.code, 1);
  assert.match(run.out + run.err, /config/);
  assert.match(run.out + run.err, /'logging'/, "a config problem has to say which key");
});

test("`config` round-trips: path, get, set, schema — and a set writes only the override", () => {
  const state = path.join(tempDir(), ".crabby");
  crabby(["init"], state);
  const set = crabby(["config", "set", "limits.fsTimeoutMs", "15000"], state);
  assert.equal(set.code, 0, set.out + set.err);
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(state, "config.json"), "utf8")),
    { limits: { fsTimeoutMs: 15000 } },
    "defaults must not be frozen into the user's file",
  );
  const get = crabby(["config", "get", "limits.fsTimeoutMs", "--json"], state);
  // The dotted key the user typed is the key in the document: `config get limits.fsTimeoutMs` answers that question,
  // and re-nesting it into `{limits:{fsTimeoutMs}}` would invent a shape nobody asked about.
  assert.equal(
    (JSON.parse(get.out) as Record<string, number>)["limits.fsTimeoutMs"],
    15000,
    get.out,
  );
  const merged = crabby(["config", "get", "limits", "--json"], state);
  assert.equal(
    JSON.parse(merged.out).limits.providerConnectMs,
    10000,
    "a get shows what is in force, defaults included",
  );
  const bad = crabby(["config", "set", "limits.nope", "1"], state);
  assert.equal(bad.code, 2);
  assert.match(bad.out, /'nope'/);
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(state, "config.json"), "utf8")),
    { limits: { fsTimeoutMs: 15000 } },
    "a refused set changed nothing",
  );
  const schema = crabby(["config", "schema", "--json"], state);
  const printed = JSON.parse(schema.out) as {
    properties?: Record<string, unknown>;
    additionalProperties?: boolean;
  };
  assert.ok(
    printed.properties?.limits,
    "crabby config schema --json prints the schema itself (D-060)",
  );
  assert.equal(printed.additionalProperties, false);
  const where = crabby(["config", "path"], state);
  assert.match(where.out, /config\.json/);
});

test("`version` names the runtime it is describing, in both modes", () => {
  const text = crabby(["version"]);
  assert.equal(text.code, 0);
  assert.match(text.out, new RegExp(`node\\s+${process.version}`));
  const json = crabby(["version", "--json"]);
  const payload = JSON.parse(json.out) as { crabby: string; node: string; install: string };
  assert.equal(payload.node, process.version);
  assert.equal(payload.install, "checkout");
  assert.match(payload.crabby, /^\d+\.\d+\.\d+/);
});

test("output is pipeable: closing the reader does not crash the writer", () => {
  const state = path.join(tempDir(), ".crabby");
  crabby(["init"], state);
  crabby(["config", "set", "limits.fsTimeoutMs", "1"], state);
  const run = spawnSync(
    "sh",
    [
      "-c",
      `${process.execPath} ${JSON.stringify(ENTRY)} --data-dir ${JSON.stringify(state)} config get limits | head -2`,
    ],
    { encoding: "utf8", cwd: REPO },
  );
  assert.equal(run.status, 0, `stderr: ${run.stderr}`);
  assert.doesNotMatch(run.stderr, /EPIPE|Unhandled/, run.stderr);
  assert.equal(run.stdout.split("\n").filter(Boolean).length, 2);
});

test("the doctor payload is scanned for secret-shaped text, and its tally counts what it prints", () => {
  const checks: Check[] = [
    { id: "config", status: "ok", summary: "config valid" },
    {
      id: "vault",
      status: "warn",
      summary: "vault: authorization: Bearer sk-abcdefghijklmnop",
      fix: "rotate it",
    },
  ];
  assert.equal(
    containsSecret(checks),
    true,
    "a credential-shaped line must not reach a paste-ready report (SECURITY.md T-08)",
  );
  assert.equal(
    containsSecret([checks[0] as Check]),
    false,
    "and an ordinary summary must not be flagged as one",
  );
  assert.deepEqual(tally(checks), { ok: 1, warn: 1, fail: 0, note: 0, deferred: 0 });
});

test("a secret-shaped value in the config never reaches `crabby doctor`, in either mode", () => {
  const state = path.join(tempDir(), ".crabby");
  crabby(["init"], state);
  // Invalid *and* credential-shaped: the validator will want to quote the value it rejected, which is the exact path
  // `SECURITY.md` §14 forbids for a command whose whole purpose is being pasted into a bug report.
  writeFileSync(
    path.join(state, "config.json"),
    JSON.stringify({ limits: { shellRunTimeoutMs: "sk-abcdefghijklmnop" } }),
  );
  const secret = "sk-abcdefghijklmnop";
  const json = crabby(["doctor", "--json"], state);
  assert.equal(json.code, 1, "a bad config is still a finding");
  assert.ok(!json.out.includes(secret), `the JSON document leaked: ${json.out}`);
  const text = crabby(["doctor"], state);
  assert.ok(
    !text.out.includes(secret) && !text.err.includes(secret),
    "and neither did the human output",
  );
  assert.match(
    json.out,
    /shellRunTimeoutMs/,
    "while still naming the key, which is the point of redacting instead of omitting",
  );
});

function readMode(stateDir: string, child: string): number {
  return statSync(path.join(stateDir, child)).mode & 0o777;
}
