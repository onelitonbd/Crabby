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

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "crabby-cli-"));
}

/** `HOME` belongs to the test, not to whoever ran it. `docs/UI_UX_SPEC.md` §5 step 3 has `crabby init` create
 *  `$HOME/crabby-workspace`, so a suite that inherited the real environment would leave a directory in a developer's
 *  home — and would be asserting against a path it does not own. The data dir's parent is the home the test already
 *  chose, so one temp directory owns both and an assertion can name the root it expects. */
const FALLBACK_HOME = tempDir();

function crabby(args: string[], dataDir?: string) {
  const argv = dataDir === undefined ? args : ["--data-dir", dataDir, ...args];
  const home = dataDir === undefined ? FALLBACK_HOME : path.dirname(dataDir);
  const run = spawnSync(process.execPath, [ENTRY, ...argv], {
    encoding: "utf8",
    cwd: REPO,
    env: { ...process.env, HOME: home },
  });
  return { code: run.status, out: run.stdout ?? "", err: run.stderr ?? "" };
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
  // A planned command may not say "planned" alone: it names either a phase in `docs/ROADMAP.md` or, for something the
  // plan defers *by decision* rather than by sequence, the section that defers it. The tunnel is that case — F-36
  // records that no phase in the roadmap owns it, which is exactly why the help text cites `SECURITY.md` §13 instead of
  // inventing an M-number nobody scheduled.
  for (const line of run.out.split("\n")) {
    if (line.includes("planned for")) assert.match(line, /M\d|§/);
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
  // M1b moved the *reason* : creating a task nothing will execute is not a command, so `task run` is planned for the
  // runtime milestone and says so. The assertion keeps the shape of the sentence rather than a milestone that will
  // age, because "which milestone" is a planning fact and "does help name it" is the contract.
  assert.match(planned.out, /not implemented yet — planned for M\d/);
});

test("`init` creates the state dir, the vault at 700, and §5 step 3's workspace root", () => {
  const root = tempDir();
  const state = path.join(root, ".crabby");
  const first = crabby(["init"], state);
  assert.equal(first.code, 0, first.err + first.out);
  assert.match(first.out, /config\s+.*config\.json/);
  const vaultMode = readMode(state, "vault");
  assert.equal(vaultMode & 0o077, 0, "the vault directory must not be group- or world-readable");

  // §5 step 3, and the reason the default is not `$HOME` itself: SECURITY.md §8 says "the home directory is not a
  // workspace", and a root that wide would leave the sensitive deny-list — a floor, not a containment rule — as the
  // only thing between a task and `~/.ssh`.
  const workspace = path.join(root, "crabby-workspace");
  assert.equal(statSync(workspace).isDirectory(), true, "init creates the root it names");
  assert.match(first.out, /workspace\s+.*crabby-workspace/);
  assert.match(first.out, /deny-list/, "§5 step 3 shows the deny-list with the root");

  // The file holds what init created and nothing else: a recorded root is a fact about this install, while every
  // D-074 default stays in code so a partial file cannot freeze one.
  assert.deepEqual(JSON.parse(readFileSync(path.join(state, "config.json"), "utf8")), {
    workspace: { roots: [workspace] },
  });

  const second = crabby(["init"], state);
  assert.equal(second.code, 0);
  assert.match(
    second.out,
    /already there/,
    "a second init is someone checking their work, not a request to reset it",
  );
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(state, "config.json"), "utf8")),
    { workspace: { roots: [workspace] } },
    "init never overwrites, and never records the same root twice",
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
  const file = readFileSync(path.join(state, "config.json"), "utf8");
  assert.deepEqual(
    (JSON.parse(file) as { limits?: unknown }).limits,
    { fsTimeoutMs: 15000 },
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
  assert.equal(
    readFileSync(path.join(state, "config.json"), "utf8"),
    file,
    "a refused set changed nothing — not the key it was asked about, and not the root init recorded beside it",
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

test("`doctor` reads the listener a Gateway published, and reports one whose pid is gone", () => {
  const state = path.join(tempDir(), ".crabby");
  assert.equal(crabby(["init"], state).code, 0);
  const info = (pid: number) =>
    JSON.stringify({
      host: "127.0.0.1",
      port: 4188,
      pid,
      startedAt: "2026-10-10T00:00:00.000Z",
      version: "0.0.0",
    });
  // Pid 1 answers `EPERM` rather than `ESRCH` to a liveness probe, and that is the branch `isPidAlive` has to get
  // right: a process that exists but belongs to someone else *is* alive, and a `doctor` that called it dead would
  // send the user to start a second Gateway beside a running one.
  writeFileSync(path.join(state, "gateway.json"), info(1));
  const live = crabby(["doctor", "--json"], state);
  const listener = checkOf(live.out, "gateway.listener");
  assert.equal(listener.status, "ok", live.out);
  assert.match(String(listener.summary), /127\.0\.0\.1:4188/);
  const clients = checkOf(live.out, "gateway.paired-clients");
  assert.equal(clients.status, "deferred");
  assert.match(
    String(clients.fix),
    /crabby auth pair --code/,
    "a live listener with no token needs pairing, not `gateway start`",
  );

  writeFileSync(path.join(state, "gateway.json"), info(4_000_000));
  const stale = checkOf(crabby(["doctor", "--json"], state).out, "gateway.listener");
  assert.equal(stale.status, "warn", "a file naming a dead process is a finding, not a listener");
  assert.match(String(stale.fix), /crabby gateway start/);
});

function checkOf(json: string, id: string): Record<string, unknown> {
  const payload = JSON.parse(json) as { checks: Record<string, unknown>[] };
  const found = payload.checks.find((c) => c.id === id);
  assert.ok(found, `doctor dropped the ${id} check: ${payload.checks.map((c) => c.id).join(", ")}`);
  return found;
}

function readMode(stateDir: string, child: string): number {
  return statSync(path.join(stateDir, child)).mode & 0o777;
}

// ---- §5's steps 2 and 3 as doctor checks (D-101)
//
// `crabby doctor` "re-runs the same checks at any time and prints fixes, not findings", so the two things §5's
// first-run flow asks a person to choose — a model path and a workspace root — have to be answerable from it afterwards.
// What each test asserts is the *status*, because that is the part a user acts on: a gap this build cannot close is
// `deferred`, a mistake the user can fix is `warn` or `fail`, and a choice nobody made yet is a `note` rather than a
// finding (§5 makes skipping a supported path).

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
};

interface DoctorPayload {
  ok: boolean;
  checks: { id: string; status: string; summary: string; detail?: string; fix?: string }[];
}

// `code` is nullable for the reason `crabby()`'s is: a spawned process that was signalled has no exit status.
function doctor(state: string): { code: number | null; payload: DoctorPayload; raw: string } {
  const run = crabby(["doctor", "--json"], state);
  return { code: run.code, payload: JSON.parse(run.out) as DoctorPayload, raw: run.out + run.err };
}

function checkIn(payload: DoctorPayload, id: string) {
  return payload.checks.find((check) => check.id === id);
}

test("`doctor` reports the workspace root `init` created, and a model path nobody chose yet", () => {
  const root = tempDir();
  const state = path.join(root, ".crabby");
  crabby(["init"], state);
  const { code, payload } = doctor(state);
  assert.equal(code, 0, JSON.stringify(payload.checks.filter((c) => c.status === "fail")));
  const workspace = checkIn(payload, "workspace");
  assert.equal(workspace?.status, "ok");
  assert.match(
    workspace?.summary ?? "",
    /crabby-workspace/,
    "§8's containment has a root to contain to",
  );
  // A note, not a warn: §5's step 2 offers "skip for now", and an install that took it is configured that way rather
  // than broken.
  assert.equal(checkIn(payload, "provider")?.status, "note");
  assert.equal(checkIn(payload, "model")?.status, "note");
  assert.match(checkIn(payload, "provider")?.fix ?? "", /config set provider/);
});

test("`doctor` fails a workspace root that is the home directory, which §8 says is not a workspace", () => {
  const root = tempDir();
  const state = path.join(root, ".crabby");
  crabby(["init"], state);
  writeFileSync(path.join(state, "config.json"), JSON.stringify({ workspace: { roots: [root] } }));
  const { code, payload } = doctor(state);
  assert.equal(
    code,
    1,
    "a root this wide removes §8's boundary, so it is a finding and not a note",
  );
  const workspace = checkIn(payload, "workspace");
  assert.equal(workspace?.status, "fail");
  assert.match(workspace?.summary ?? "", /home directory/, workspace?.summary ?? "");
  assert.match(
    workspace?.fix ?? "",
    /crabby-workspace/,
    "the fix names the directory `init` would have created, not only the rule that was broken",
  );
});

test("`doctor` defers a keyed provider instead of failing it, and names the milestone that closes it", () => {
  const root = tempDir();
  const state = path.join(root, ".crabby");
  crabby(["init"], state);
  writeFileSync(
    path.join(state, "config.json"),
    JSON.stringify({
      workspace: { roots: [path.join(root, "crabby-workspace")] },
      provider: {
        groq: {
          baseUrl: "https://api.groq.com/openai/v1",
          key: "vault://groq",
          models: { "llama-3.3-70b": DESCRIPTOR },
        },
      },
      defaultModel: "groq/llama-3.3-70b",
    }),
  );
  const { code, payload } = doctor(state);
  const provider = checkIn(payload, "provider");
  assert.equal(provider?.status, "deferred", provider?.detail ?? "");
  assert.equal(code, 0, "a subsystem this build does not have is not a broken install (F-28)");
  assert.match(
    provider?.fix ?? "",
    /M5/,
    "the fix names the milestone, so `deferred` is a plan and not a shrug",
  );
  assert.match(provider?.detail ?? "", /F-56/);
  assert.equal(checkIn(payload, "model")?.status, "warn");
});

test("`doctor` names the model an install selected, and the provider that composes it", () => {
  const root = tempDir();
  const state = path.join(root, ".crabby");
  crabby(["init"], state);
  writeFileSync(
    path.join(state, "config.json"),
    JSON.stringify({
      workspace: { roots: [path.join(root, "crabby-workspace")] },
      provider: {
        local: { baseUrl: "http://127.0.0.1:8080/v1", models: { "qwen2.5:3b": DESCRIPTOR } },
      },
      defaultModel: "local/qwen2.5:3b",
    }),
  );
  const { code, payload } = doctor(state);
  assert.equal(code, 0, JSON.stringify(payload.checks.filter((c) => c.status === "fail")));
  assert.equal(checkIn(payload, "provider")?.status, "ok");
  assert.match(checkIn(payload, "provider")?.summary ?? "", /local \(1\)/);
  assert.equal(checkIn(payload, "model")?.status, "ok");
  assert.equal(checkIn(payload, "model")?.summary, "local/qwen2.5:3b");
});
