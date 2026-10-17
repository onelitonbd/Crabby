// The vault's own rules, tested against the two back ends the way §17 asks security code to be tested: the
// failure cases are the tests. The file store runs with a small scrypt (the `kdf` override exists for exactly
// this) and asserts the real format's properties — 0600, per-install salt, verifiable wrong passphrase — so the
// numbers the suite skips are numbers the assertions still speak about. The keychain branch runs through an
// injected command table and never touches PATH, so the same suite is honest on a Mac and on a headless CI box.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  ENVELOPE_FILE,
  FILE_STORE_DISCLOSURE,
  KDF_DEFAULT,
  openVault,
  resolverFor,
} from "./index.ts";
import { type CommandRunner, detectKeychain } from "./keychain.ts";

/** A scrypt the suite can afford hundreds of. The shipped default stays D-066's and is asserted below. */
const TEST_KDF = { N: 2 ** 10, r: 8, p: 1 } as const;

function scratch(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), `crabby-vault-${prefix}-`));
}

test("the file store: create, reopen locked, unlock, and the names never leak while locked", () => {
  const dir = scratch("file");
  const vault = openVault({ vaultDir: dir, platform: "linux", store: "file", kdf: TEST_KDF });
  assert.equal(vault.status().state, "unset", "nothing written yet");

  const created = vault.set("groq", "gsk_test_value", "correct horse");
  assert.ok(created.ok, "the first set creates the vault");
  assert.equal(vault.status().state, "unlocked");
  assert.equal(vault.status().kind, "file");
  assert.match(vault.status().note ?? "", /casual disclosure/, FILE_STORE_DISCLOSURE);

  // A second instance is how every new process sees it: locked, opaque, present.
  const fresh = openVault({ vaultDir: dir, platform: "linux", store: "file", kdf: TEST_KDF });
  const locked = fresh.status();
  assert.equal(locked.state, "locked");
  assert.equal(locked.entries, undefined, "a locked vault cannot prove how many entries it holds");
  assert.equal(locked.names, undefined);
  assert.match(
    locked.note ?? "",
    /casual disclosure/,
    "the weaker-store disclosure rides the locked state",
  );
  const refused = fresh.get("groq");
  assert.ok(!refused.ok);
  assert.match(refused.reason, /locked/);

  const opened = fresh.unlock("correct horse");
  assert.ok(opened.ok);
  const listed = fresh.list();
  assert.ok(listed.ok);
  assert.deepEqual(listed.names, ["groq"]);
  const got = fresh.get("groq");
  assert.ok(got.ok && got.secret === "gsk_test_value");
});

test("the file store: a wrong passphrase is a clean refusal and writes nothing", () => {
  const dir = scratch("wrong");
  const vault = openVault({ vaultDir: dir, platform: "linux", store: "file", kdf: TEST_KDF });
  assert.ok(vault.set("groq", "gsk_test_value", "correct horse").ok);
  vault.lock();
  const before = readFileSync(path.join(dir, ENVELOPE_FILE), "utf8");
  const wrong = vault.unlock("correct horse ");
  assert.ok(!wrong.ok, "the GCM tag verifies the passphrase, so a wrong one fails cleanly");
  assert.match(wrong.reason, /did not open/);
  assert.equal(vault.status().state, "locked");
  assert.equal(
    readFileSync(path.join(dir, ENVELOPE_FILE), "utf8"),
    before,
    "a failed unlock leaves the file alone",
  );
});

test("the file store: the envelope's shape is the spec — per-install salt, 0600, pinned KDF written in", () => {
  const dir = scratch("shape");
  const vault = openVault({ vaultDir: dir, platform: "linux", store: "file", kdf: TEST_KDF });
  assert.ok(vault.set("a", "1", "pass").ok);
  assert.ok(vault.set("b", "2", "pass").ok, "an unlocked store writes without re-asking");
  const file = path.join(dir, ENVELOPE_FILE);
  const mode = statSync(file).mode & 0o777;
  assert.equal(mode & 0o077, 0, `the envelope is 0600-shaped, saw ${mode.toString(8)}`);
  assert.equal(statSync(dir).mode & 0o777 & 0o077, 0, "the directory is 0700-shaped");
  const envelope = JSON.parse(readFileSync(file, "utf8")) as {
    version: number;
    kdf: { name: string; N: number; r: number; p: number };
    salt: string;
    iv: string;
    tag: string;
    data: string;
  };
  assert.equal(envelope.version, 1);
  assert.equal(envelope.kdf.N, TEST_KDF.N, "the file records the parameters it was written with");
  assert.equal(KDF_DEFAULT.N, 2 ** 15, "the shipped default stays D-066's N=2^15");
  const saltOne = envelope.salt;
  assert.ok(vault.set("c", "3", "pass").ok);
  const envelopeTwo = JSON.parse(readFileSync(file, "utf8")) as typeof envelope;
  assert.equal(
    envelopeTwo.salt,
    saltOne,
    "the salt is per-install, not per-write (D-066's own words)",
  );
  assert.notEqual(
    envelopeTwo.iv,
    envelope.iv,
    "the IV rotates per write — GCM does not survive its reuse",
  );
  const reopened = openVault({ vaultDir: dir, platform: "linux", store: "file", kdf: TEST_KDF });
  assert.ok(reopened.unlock("pass").ok);
  const listed = reopened.list();
  assert.ok(listed.ok);
  assert.deepEqual(listed.names, ["a", "b", "c"]);
});

test("the file store: an unset vault refuses a passphrase-less operation with the create sentence", () => {
  const dir = scratch("unset");
  const vault = openVault({ vaultDir: dir, platform: "linux", store: "file", kdf: TEST_KDF });
  const answer = vault.list();
  assert.ok(!answer.ok);
  assert.match(answer.reason, /no vault exists/);
});

test("the keychain: every command, both flavors, through an injected runner", () => {
  // macOS: the value rides argv; Linux: the value rides stdin. The table records what it was handed so the
  // test asserts the exact contract each CLI has.
  const seen: { command: readonly string[]; input?: string | undefined }[] = [];
  const values = new Map<string, string>();
  const runner: CommandRunner = (command, options) => {
    seen.push({ command, ...(options.input === undefined ? {} : { input: options.input }) });
    const [binary, sub] = command;
    if (binary === "which") return { status: 0, stdout: `/usr/bin/${sub ?? ""}`, stderr: "" };
    if (binary === "security" && sub === "add-generic-password") {
      values.set(command[6] ?? "", command[8] ?? "");
      return { status: 0, stdout: "", stderr: "" };
    }
    if (binary === "secret-tool" && sub === "store") {
      values.set(command[6] ?? "", options.input ?? "");
      return { status: 0, stdout: "", stderr: "" };
    }
    if (
      (binary === "security" && sub === "find-generic-password") ||
      (binary === "secret-tool" && sub === "lookup")
    ) {
      // find/lookup/clear have no `--label` slot, so their name lands one index earlier than store's/add's.
      const name = command[5] ?? "";
      const value = values.get(name);
      return value === undefined
        ? { status: 44, stdout: "", stderr: "not found" }
        : { status: 0, stdout: `${value}\n`, stderr: "" };
    }
    if (
      (binary === "security" && sub === "delete-generic-password") ||
      (binary === "secret-tool" && sub === "clear")
    ) {
      const name = command[5] ?? "";
      return values.delete(name)
        ? { status: 0, stdout: "", stderr: "" }
        : { status: 44, stdout: "", stderr: "" };
    }
    return { status: 2, stdout: "", stderr: `unexpected ${binary} ${sub}` };
  };

  for (const platform of ["darwin", "linux"]) {
    const dir = scratch(`keychain-${platform}`);
    assert.ok(
      detectKeychain(platform, runner) !== undefined,
      `${platform} detects its CLI by PATH probe`,
    );
    const vault = openVault({ vaultDir: dir, platform, run: runner });
    assert.equal(vault.kind, "keychain", `${platform} detects its CLI`);
    assert.equal(vault.status().state, "unlocked", "a keychain never reports locked");
    assert.ok(vault.set("groq", "gsk_keychain", "unused").ok);
    const got = vault.get("groq");
    assert.ok(got.ok && got.secret === "gsk_keychain");
    const listed = vault.list();
    assert.ok(listed.ok);
    assert.deepEqual(listed.names, ["groq"], "the name index answers the listing");
    // The value must have travelled the channel that flavor actually has.
    const write = seen.findLast(
      (call) => call.command[1] === "add-generic-password" || call.command[1] === "store",
    );
    assert.ok(write !== undefined);
    if (platform === "linux") {
      assert.equal(write.input, "gsk_keychain", "secret-tool reads the value from stdin");
      assert.ok(!write.command.includes("gsk_keychain"), "no value on a Linux argv");
    }
    assert.ok(vault.delete("groq").ok);
    const gone = vault.get("groq");
    assert.ok(!gone.ok);
    const emptied = vault.list();
    assert.ok(emptied.ok);
    assert.deepEqual(emptied.names, [], "the index follows the deletion");
  }
});

test("the keychain: a refused write answers a reason, not a throw, and the index stays consistent", () => {
  const runner: CommandRunner = (command) => {
    if (command[0] === "which")
      return { status: command[1] === "security" ? 0 : 1, stdout: "", stderr: "" };
    if (command[1] === "add-generic-password" && command[6] === "cursed") {
      return { status: 45, stdout: "", stderr: "SecKeychainSearch failed" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  const dir = scratch("keychain-refuse");
  const vault = openVault({ vaultDir: dir, platform: "darwin", run: runner });
  const refused = vault.set("cursed", "value", "unused");
  assert.ok(!refused.ok);
  assert.match(refused.reason, /refused the write/);
  const listing = vault.list();
  assert.ok(listing.ok);
  assert.deepEqual(listing.names, [], "a failed write does not add the name");
});

test("the resolver: names only resolve through the store, and the answer carries the reason", () => {
  const dir = scratch("resolver");
  const vault = openVault({ vaultDir: dir, platform: "linux", store: "file", kdf: TEST_KDF });
  assert.ok(vault.set("groq", "gsk_resolved", "pass").ok);
  const resolve = (value: string): string => {
    const facade = openVault({ vaultDir: dir, platform: "linux", store: "file", kdf: TEST_KDF });
    facade.unlock("pass");
    const answer = resolverFor(facade)(value);
    return answer.ok ? answer.secret : answer.reason;
  };
  assert.equal(resolve("vault://groq"), "gsk_resolved");
  assert.match(resolve("vault://nobody"), /no entry named/);
  assert.match(resolve("sk-plain"), /not a vault reference/);
  assert.ok(existsSync(path.join(dir, ENVELOPE_FILE)));
});
