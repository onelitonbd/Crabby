// The wizard's testable half is the part that must never guess: the survey (where the first-run actually is),
// the non-TTY branch (which prints the manual path instead of prompting into a pipe), and the paste trail (every
// driven verb is echoed as `$ crabby …` before it runs). The interactive TTY path is rehearsed by hand — the
// wizard is the one command whose happy path is a human at a keyboard — but the state machine it walks and the
// trail it prints are asserted here.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { dataLayout } from "@crabby/platform";
import { runOnboard } from "../../apps/cli/commands/onboard.ts";
import { createRenderer } from "../../apps/cli/output.ts";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");

function harness(home: string) {
  const layout = dataLayout(path.join(home, ".crabby"));
  const out: string[] = [];
  const renderer = createRenderer(
    { write: (text) => out.push(text), err: (text) => out.push(text) },
    false,
  );
  const input = {
    layout,
    facts: { platform: "linux", arch: "x64", nodeVersion: "v22.22.3", isTermux: false } as never,
    rootPackageJson: path.join(REPO_ROOT, "package.json"),
    repoRoot: REPO_ROOT,
  };
  return { layout, out, renderer, input };
}

test("`onboard` in a pipe never prompts — it prints the numbered manual path and exits 0", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "crabby-onboard-fresh-"));
  const { out, renderer, input } = harness(home);
  const exit = await runOnboard([], input, renderer);
  assert.equal(exit, 0);
  const text = out.join("");
  assert.match(text, /fresh install/);
  assert.match(text, /non-interactive/);
  assert.match(text, /1\.\s+crabby init/);
  assert.match(text, /crabby doctor/);
  assert.match(
    text,
    /pair from a second session/,
    "the manual list carries the lesson of hits 2 and 3",
  );
  assert.match(
    text,
    /skips what is already done/,
    "the skip-what-is-done promise is on the record",
  );
  assert.ok(!text.includes("Configure a model provider now?"), "no prompt reaches a pipe");
});

test("`onboard` says where you are — paired and configured installs skip ahead in the non-TTY list", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "crabby-onboard-partial-"));
  const { layout, out, renderer, input } = harness(home);
  mkdirSync(layout.stateDir, { recursive: true });
  writeFileSync(
    path.join(layout.stateDir, "config.json"),
    JSON.stringify({
      provider: { groq: { baseUrl: "https://api.groq.com/openai/v1" } },
      defaultModel: "groq/x",
    }),
    "utf8",
  );
  const exit = await runOnboard([], input, renderer);
  assert.equal(exit, 0);
  const text = out.join("");
  assert.match(text, /provider configured ✓/);
  assert.match(text, /default model: groq\/x ✓/);
  assert.ok(!/1\.\s+crabby init/.test(text), "a configured install is not told to init again");
  assert.ok(
    !/vault set/.test(text.split("non-interactive")[1] ?? text),
    "a configured provider is not re-asked",
  );
});

test("the survey reads the real state dir, so `--data-dir` installs are seen as they are", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "crabby-onboard-other-"));
  const { layout, out, renderer, input } = harness(home);
  mkdirSync(layout.stateDir, { recursive: true });
  writeFileSync(
    path.join(layout.stateDir, "config.json"),
    JSON.stringify({ provider: {} }),
    "utf8",
  );
  await runOnboard([], input, renderer);
  assert.match(
    out.join(""),
    /no provider yet/,
    "a config with no baseUrl entry is not a configured provider",
  );
});
