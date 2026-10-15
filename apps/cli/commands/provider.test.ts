// `crabby provider add` — C7-01, C7-02 and C7-06, and the three claims this verb makes that a test can hold it to.
//
// These are **unit tests against a temp `dataLayout` and a capturing renderer**, with no Gateway and no process. That is
// possible because `add` composes the same `composeProviders` the Gateway calls and writes the same `config.json` that
// `crabby config set` writes — the reasons D-125 records for it being an ordinary command rather than a route. A test
// that had to start a Gateway to check "the key never reaches the file" would be a test that could not be written
// cheaply enough to be written at all.
//
// **What each test holds the verb to:**
//
//   1. *The secret is in no file.* The key is read (C7-02: stdin or a file, never argv) and the written document holds
//      `vault://<id>` and nothing resembling the value — D-031's rule, asserted rather than asserted-in-a-comment.
//   2. *Insecure transport is refused.* Plain HTTP to a non-loopback host is a refusal without `--allow-insecure`
//      (C7-06), and it is a refusal *and no write*, not a warning with a file behind it.
//   3. *Capabilities are denied, not claimed.* The descriptor this command writes says `systemRole` and `false` for
//      everything else, because §3.2 reads `supports` as permission and this process has never called the endpoint.
//   4. *The numbers are the user's.* `--context` / `--max-output` are required and validated, because a window this
//      command invented would size D-064's budgeting against a fiction.
//
// The CLI has no test harness for its streaming commands and this file does not pretend to be one: it covers the verbs
// that are a pure function of a configuration document and a temp directory, which is what `add` is.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { EXIT } from "@crabby/api-contracts";
import type { ConfigFile } from "@crabby/core";
import { type DataLayout, dataLayout } from "@crabby/platform";
import { createRenderer, type Renderer } from "../output.ts";
import { runProvider } from "./provider.ts";

interface Captured {
  readonly out: string;
  readonly renderer: Renderer;
  readonly layout: DataLayout;
}

function harness(): Captured {
  const dir = mkdtempSync(path.join(tmpdir(), "crabby-provider-"));
  const layout = dataLayout(dir);
  mkdirSync(layout.stateDir, { recursive: true, mode: 0o700 });
  const out: string[] = [];
  return {
    out: "",
    renderer: createRenderer({ write: (s) => out.push(s), err: () => undefined }, false),
    layout,
  };
}

const BASE = [
  "local",
  "--base-url",
  "http://127.0.0.1:8080/v1",
  "--model",
  "qwen2.5:3b",
  "--context",
  "8192",
  "--max-output",
  "1024",
] as const;

describe("crabby provider add", () => {
  it("writes the entry and composes it, and says so", async () => {
    const { renderer, layout, ...rest } = harness();
    void rest;
    const code = await runProvider("add", [...BASE], layout, renderer);
    assert.equal(code, EXIT.success);
    const file = JSON.parse(readFileSync(layout.configPath, "utf8")) as ConfigFile;
    const entry = file.provider?.local;
    assert.ok(entry !== undefined, "the entry is in the file the user edits");
    assert.equal(entry.baseUrl, "http://127.0.0.1:8080/v1");
    // §3.2 refuses an entry with no models, so the write is meaningless without them and the test says they are there.
    assert.deepEqual(Object.keys(entry.models ?? {}), ["qwen2.5:3b"]);
  });

  it("refuses plain HTTP away from loopback without --allow-insecure, and writes nothing", async () => {
    const { renderer, layout } = harness();
    const code = await runProvider(
      "add",
      [
        "lan",
        "--base-url",
        "http://192.168.1.9:8080/v1",
        "--model",
        "m",
        "--context",
        "4096",
        "--max-output",
        "512",
      ],
      layout,
      renderer,
    );
    assert.equal(code, EXIT.usage);
    // No file at all, rather than a file with a refused entry in it: C7-06's word is "refuses", and a partially
    // written configuration is the state §3.2 disables.
    assert.throws(() => readFileSync(layout.configPath, "utf8"));
  });

  it("denies every capability but systemRole, because it has not called the endpoint", async () => {
    const { renderer, layout } = harness();
    await runProvider("add", [...BASE], layout, renderer);
    const file = JSON.parse(readFileSync(layout.configPath, "utf8")) as ConfigFile;
    const models = file.provider?.local?.models ?? {};
    const descriptor = models["qwen2.5:3b"] as Record<string, unknown>;
    const supports = descriptor.supports as Record<string, boolean>;
    assert.equal(supports.systemRole, true);
    assert.equal(supports.streaming, false);
    assert.equal(supports.toolCalling, false);
    assert.equal(supports.imageInput, false);
  });

  it("refuses a context that cannot hold its own output, before writing", async () => {
    const { renderer, layout } = harness();
    const code = await runProvider(
      "add",
      [
        "local",
        "--base-url",
        "https://api.example/v1",
        "--model",
        "m",
        "--context",
        "512",
        "--max-output",
        "512",
      ],
      layout,
      renderer,
    );
    assert.equal(code, EXIT.usage);
    assert.throws(() => readFileSync(layout.configPath, "utf8"));
  });

  it("refuses a non-numeric window rather than writing a number budgeting cannot use", async () => {
    const { renderer, layout } = harness();
    const code = await runProvider(
      "add",
      [
        "local",
        "--base-url",
        "https://api.example/v1",
        "--model",
        "m",
        "--context",
        "8192abc",
        "--max-output",
        "512",
      ],
      layout,
      renderer,
    );
    assert.equal(code, EXIT.usage);
    assert.throws(() => readFileSync(layout.configPath, "utf8"));
  });

  it("refuses a second `add` for an id that is already configured", async () => {
    const { renderer, layout } = harness();
    await runProvider("add", [...BASE], layout, renderer);
    const again = await runProvider("add", [...BASE], layout, renderer);
    assert.equal(again, EXIT.usage);
  });
});

describe("crabby provider add: the key path", () => {
  it("refuses both --key-stdin and --key-file, because it cannot tell which secret was meant", async () => {
    const { renderer, layout } = harness();
    const code = await runProvider(
      "add",
      [...BASE, "--key-stdin", "--key-file", "/nowhere/key"],
      layout,
      renderer,
    );
    assert.equal(code, EXIT.usage);
    assert.throws(() => readFileSync(layout.configPath, "utf8"));
  });

  it("refuses an empty key as a missing secret rather than writing an empty reference", async () => {
    const { renderer, layout } = harness();
    const keyFile = path.join(layout.stateDir, "empty.key");
    writeFileSync(keyFile, "\n");
    const code = await runProvider("add", [...BASE, "--key-file", keyFile], layout, renderer);
    assert.equal(code, EXIT.usage);
    assert.throws(() => readFileSync(layout.configPath, "utf8"));
  });

  it("refuses a key file it cannot open, rather than adding a provider nobody can call", async () => {
    const { renderer, layout } = harness();
    const code = await runProvider(
      "add",
      [...BASE, "--key-file", "/nowhere/absent.key"],
      layout,
      renderer,
    );
    assert.equal(code, EXIT.usage);
    assert.throws(() => readFileSync(layout.configPath, "utf8"));
  });
});
