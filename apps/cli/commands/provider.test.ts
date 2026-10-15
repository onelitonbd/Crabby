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
import { runModel, runProvider } from "./provider.ts";

interface Captured {
  /** Everything written so far, as one string. A snapshot field would have been the obvious shape and the useless one:
   *  every assertion here is about a *line*, and a renderer writes as it goes. */
  captured(): string;
  readonly renderer: Renderer;
  readonly layout: DataLayout;
}

function harness(): Captured {
  const dir = mkdtempSync(path.join(tmpdir(), "crabby-provider-"));
  const layout = dataLayout(dir);
  mkdirSync(layout.stateDir, { recursive: true, mode: 0o700 });
  const out: string[] = [];
  return {
    captured: () => out.join(""),
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
    const { renderer, layout } = harness();
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

describe("crabby model edit", () => {
  const ADD = [
    "local",
    "--base-url",
    "http://127.0.0.1:8080/v1",
    "--model",
    "qwen2.5:3b",
    "--context",
    "4096",
    "--max-output",
    "1024",
  ] as const;

  it("refuses a target that is not `<provider>/<model>`", async () => {
    const { captured, renderer, layout } = harness();
    assert.equal(await runModel("edit", ["qwen2.5:3b"], layout, renderer), EXIT.usage);
    // §3.8's overrides are per endpoint as well as per model, so a bare model id names two things at once and the
    // command says which part is missing rather than guessing a provider.
    assert.match(captured(), /<provider>\/<model>/);
  });

  it("refuses a provider that is not configured, naming what is", async () => {
    const { captured, renderer, layout } = harness();
    assert.equal(await runModel("edit", ["nope/qwen2.5:3b"], layout, renderer), EXIT.usage);
    assert.match(captured(), /no provider 'nope' is configured/);
  });

  it("refuses a model the entry does not declare", async () => {
    const { captured, renderer, layout } = harness();
    await runProvider("add", [...ADD], layout, renderer);
    assert.equal(await runModel("edit", ["local/other"], layout, renderer), EXIT.usage);
    assert.match(captured(), /has no model 'other'/);
  });

  it("writes an override and reports what actually moved", async () => {
    const { captured, renderer, layout } = harness();
    await runProvider("add", [...ADD], layout, renderer);
    assert.equal(
      await runModel(
        "edit",
        ["local/qwen2.5:3b", "--supports", "streaming=true"],
        layout,
        renderer,
      ),
      EXIT.success,
    );
    const file = JSON.parse(readFileSync(layout.configPath, "utf8")) as ConfigFile;
    assert.deepEqual(file.provider?.local?.overrides?.["qwen2.5:3b"], {
      source: "manual",
      supports: { streaming: true },
    });
    // The line that matters: §3.8's drift story needs "from what, to what", and a success line with no direction is a
    // claim that something changed without saying what.
    assert.match(captured(), /streaming: false → true/);
    assert.match(captured(), /declared by you/);
  });

  it("reports an unchanged override as unchanged rather than as a change", async () => {
    const { captured, renderer, layout } = harness();
    await runProvider("add", [...ADD], layout, renderer);
    await runModel("edit", ["local/qwen2.5:3b", "--supports", "systemRole=true"], layout, renderer);
    // `systemRole` is already true in the reported descriptor, so nothing moved — and a screen that said "wrote" here
    // would make a user believe they had declared something.
    assert.match(captured(), /unchanged/);
  });

  it("removes the record with --clear, and says the reported descriptor is in force", async () => {
    const { captured, renderer, layout } = harness();
    await runProvider("add", [...ADD], layout, renderer);
    await runModel("edit", ["local/qwen2.5:3b", "--context", "32768"], layout, renderer);
    assert.equal(
      await runModel("edit", ["local/qwen2.5:3b", "--clear"], layout, renderer),
      EXIT.success,
    );
    const file = JSON.parse(readFileSync(layout.configPath, "utf8")) as ConfigFile;
    // The key is gone rather than `{}`: an empty record is a claim that the user changed nothing, which an absent record
    // already says (D-126).
    assert.equal(file.provider?.local?.overrides, undefined);
    assert.match(captured(), /the reported descriptor is in force/);
  });

  it("writes the record and prints the composition refusal when the limits make the descriptor illegal", async () => {
    const { captured, renderer, layout } = harness();
    await runProvider("add", [...ADD], layout, renderer);
    // §3.2 refuses an output cap that does not fit inside the window. The record is written (composition is that gate,
    // D-126) and the refusal is printed — the two facts together are the honest answer, and a verb that quietly
    // dropped the write would leave the user with a flag that appears set and is not.
    assert.equal(
      await runModel("edit", ["local/qwen2.5:3b", "--context", "512"], layout, renderer),
      EXIT.success,
    );
    assert.match(captured(), /composed/);
    assert.match(captured(), /not in force/);
  });

  it("refuses a stored override it cannot parse, and offers --clear rather than building on it", async () => {
    const { captured, renderer, layout } = harness();
    await runProvider("add", [...ADD], layout, renderer);
    const file = JSON.parse(readFileSync(layout.configPath, "utf8")) as ConfigFile;
    const broken = {
      ...file,
      provider: {
        ...file.provider,
        local: {
          ...file.provider?.local,
          overrides: { "qwen2.5:3b": { supports: { nope: true } } },
        },
      },
    } as ConfigFile;
    writeFileSync(layout.configPath, JSON.stringify(broken, null, 2));
    assert.equal(
      await runModel("edit", ["local/qwen2.5:3b", "--context", "8192"], layout, renderer),
      EXIT.failure,
    );
    assert.match(captured(), /does not parse/);
    assert.match(captured(), /--clear/);
  });

  it("with no flags and no TTY it prints how to change the model instead of waiting for input", async () => {
    const { captured, renderer, layout } = harness();
    await runProvider("add", [...ADD], layout, renderer);
    assert.equal(await runModel("edit", ["local/qwen2.5:3b"], layout, renderer), EXIT.success);
    const out = captured();
    assert.match(out, /--supports/);
    assert.match(out, /--context/);
    // C5-02's rule applied to a flag that already has a non-interactive path: a command that blocks on input nobody can
    // type is the one failure that looks like a working terminal.
    assert.ok(!out.includes("answer with a value"), "no prompt in a pipe");
  });
});
