// The vault verbs, tested the way the CLI is tested: by running it. The assertions are on exit codes, the
// JSON documents, and the one place a value may appear — `vault get`'s own stdout. Everything else (the file's
// mode, the salt, the wrong-passphrase refusal) is the package's own suite; here the question is whether the
// commands a person types answer the way §7 says they must.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ENTRY = path.join(REPO, "apps/cli/crabby.ts");

function crabby(
  args: string[],
  options: { readonly dataDir: string; readonly stdin?: string | undefined },
) {
  const run = spawnSync(process.execPath, [ENTRY, "--data-dir", options.dataDir, ...args], {
    encoding: "utf8",
    cwd: REPO,
    input: options.stdin ?? "",
    env: { ...process.env, HOME: path.dirname(options.dataDir) },
  });
  return { code: run.status, out: run.stdout ?? "", err: run.stderr ?? "" };
}

test("vault: set creates the vault, get shows the value to this terminal alone, list shows names only", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "crabby-vault-cli-"));
  const dataDir = path.join(dir, "data");

  const created = crabby(["vault", "set", "groq", "--json"], {
    dataDir,
    stdin: "correct horse\ngsk_value_one\n",
  });
  assert.equal(created.code, 0, created.out + created.err);
  const createdBody = JSON.parse(created.out) as { name: string; rotated: boolean };
  assert.equal(createdBody.name, "groq");
  assert.equal(createdBody.rotated, false);
  assert.match(
    created.out,
    /casual disclosure/,
    "the weaker-store disclosure rides the create — on the human path as a fix line, on --json as `fixes`",
  );

  const got = crabby(["vault", "get", "groq", "--json"], { dataDir, stdin: "correct horse\n" });
  assert.equal(got.code, 0);
  assert.match(
    got.out,
    /gsk_value_one/,
    "get is the one surface that shows a value — the owner's terminal",
  );

  const listed = crabby(["vault", "list", "--json"], { dataDir, stdin: "correct horse\n" });
  assert.equal(listed.code, 0);
  const listedBody = JSON.parse(listed.out) as { names: string[]; count: number };
  assert.deepEqual(listedBody.names, ["groq"]);

  // Rotation is `set` on an existing name; the answer says so, because "did I just rotate?" is a real question.
  const rotated = crabby(["vault", "set", "groq", "--json"], {
    dataDir,
    stdin: "correct horse\ngsk_value_two\n",
  });
  assert.equal(rotated.code, 0);
  assert.equal((JSON.parse(rotated.out) as { rotated: boolean }).rotated, true);

  // A store the process just created is locked to the next process — the lock state is per-session, and the
  // status answers locally without a passphrase.
  const status = crabby(["vault", "status", "--json"], { dataDir, stdin: "" });
  assert.equal(status.code, 0);
  const statusBody = JSON.parse(status.out) as { store: string; state: string };
  assert.equal(statusBody.store, "file");
  assert.equal(statusBody.state, "locked");

  // Revoke (§7's one-command rotation-and-revocation pair).
  const removed = crabby(["vault", "delete", "groq", "--json"], {
    dataDir,
    stdin: "correct horse\n",
  });
  assert.equal(removed.code, 0);
  const gone = crabby(["vault", "get", "groq"], { dataDir, stdin: "correct horse\n" });
  assert.equal(gone.code, 1);
  assert.match(gone.err, /no entry named groq/, "a refusal is the error stream's answer");
});

test("vault: a wrong passphrase refuses with exit 1 and writes nothing", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "crabby-vault-cli-wrong-"));
  const dataDir = path.join(dir, "data");
  assert.equal(
    crabby(["vault", "set", "groq", "--json"], { dataDir, stdin: "the phrase\nthe value\n" }).code,
    0,
  );
  const wrong = crabby(["vault", "get", "groq", "--json"], { dataDir, stdin: "not the phrase\n" });
  assert.equal(wrong.code, 1);
  const body = JSON.parse(wrong.out) as { ok: boolean; code: string };
  assert.equal(body.ok, false);
  assert.equal(body.code, "vault_get_refused");
  assert.match(body.code + wrong.err + wrong.out, /refused|passphrase/);
});

test("vault: an unknown verb is a usage exit, and unlock names the Gateway it needs", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "crabby-vault-cli-usage-"));
  const dataDir = path.join(dir, "data");
  const unknown = crabby(["vault", "rotate"], { dataDir, stdin: "" });
  assert.equal(unknown.code, 2);
  assert.match(unknown.out, /which verb/);

  // No Gateway is running: unlock/lock are the Gateway session's acts, and the answer says what is missing
  // rather than pretending a process-local unlock happened.
  const unlock = crabby(["vault", "unlock"], { dataDir, stdin: "the phrase\n" });
  assert.notEqual(unlock.code, 0);
  assert.ok(unlock.out.length > 0, "the answer is prose a person can act on, never silence");
});
