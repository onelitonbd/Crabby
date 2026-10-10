// M1a's platform tests. Resolution rules are the dangerous part of a data directory — a wrong guess writes into
// someone's real `~/.crabby` — so this file asserts the absences as loudly as the presences.
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  colorDepth,
  constraintsFor,
  dataLayout,
  detectPlatform,
  expandHome,
  resolveDataDir,
  STATE_DIR_NAME,
  terminalFacts,
} from "@crabby/platform";

test("Termux is detected from its own markers, not from the absence of something else", () => {
  const byPrefix = detectPlatform({
    env: { PREFIX: "/data/data/com.termux/files/usr" },
    platform: "linux",
  });
  assert.equal(byPrefix.isTermux, true);
  const byVersion = detectPlatform({ env: { TERMUX_VERSION: "0.118.0" }, platform: "linux" });
  assert.equal(byVersion.isTermux, true);
  assert.equal(byVersion.termuxVersion, "0.118.0");
  const neither = detectPlatform({ env: { PREFIX: "/usr" }, platform: "linux" });
  assert.equal(neither.isTermux, false);
  assert.equal(neither.isAndroid, false);
  const android = detectPlatform({ env: {}, platform: "android" });
  assert.equal(
    android.isTermux,
    false,
    "no markers, no claim — the alternative is asserting Termux from an OS name",
  );
  assert.equal(
    android.isAndroid,
    true,
    "and the Android-shaped case stays visible so doctor can explain it",
  );
});

test("constraints are the documented ones and the applicable subset is a function of the platform", () => {
  const termux = constraintsFor({ isTermux: true, isAndroid: false, platform: "linux" });
  const server = constraintsFor({ isTermux: false, isAndroid: false, platform: "linux" });
  assert.ok(
    termux.some((row) => row.id === "build-tools"),
    "the `pkg install python make clang` rule must reach a phone",
  );
  assert.ok(!server.some((row) => row.id === "build-tools"), "…and not be printed on a laptop");
  assert.ok(termux.some((row) => row.id === "hostile-network"));
  for (const row of constraintsFor({ isTermux: false, isAndroid: true, platform: "android" })) {
    assert.ok(row.source.length > 0, `${row.id} must cite the document it came from`);
    assert.ok(row.text.length > 20, `${row.id} has to say something a user can act on`);
  }
});

test("the data directory resolves from one flag and nothing else", () => {
  const home = path.join(path.sep, "home", "me");
  assert.equal(resolveDataDir({ home }), path.join(home, STATE_DIR_NAME));
  assert.equal(
    resolveDataDir({ home, dataDir: "/tmp/x" }),
    "/tmp/x",
    "--data-dir names the state dir itself, per docs/DEVELOPMENT.md §10",
  );
  assert.equal(resolveDataDir({ home, dataDir: "relative", cwd: "/work" }), "/work/relative");
  assert.equal(
    resolveDataDir({ home, dataDir: "" }),
    path.join(home, STATE_DIR_NAME),
    "an empty value is no value",
  );
  assert.equal(
    process.env.CRABBY_DATA_DIR,
    undefined,
    "there is no environment override to discover",
  );
});

test("the layout is the three documented paths and no more", () => {
  const layout = dataLayout("/tmp/root/.crabby");
  assert.deepEqual(layout, {
    stateDir: "/tmp/root/.crabby",
    configPath: "/tmp/root/.crabby/config.json",
    vaultDir: "/tmp/root/.crabby/vault",
  });
  assert.equal(expandHome("~/.crabby", "/home/me"), "/home/me/.crabby");
  assert.equal(expandHome("/a/~/b", "/home/me"), "/a/~/b", "only a leading tilde is home");
});

test("terminal facts report inputs without deciding anything", () => {
  assert.equal(colorDepth({ COLORTERM: "truecolor" }), "truecolor");
  assert.equal(colorDepth({ COLORTERM: "24bit" }), "truecolor");
  assert.equal(colorDepth({ TERM: "xterm-256color" }), "256");
  assert.equal(colorDepth({ TERM: "dumb" }), "none");
  assert.equal(colorDepth({}), "ansi");
  const facts = terminalFacts({ TERM: "xterm" }, { columns: 40 }, true);
  assert.equal(facts.columns, 40);
  assert.equal(facts.rows, 24, "a missing size falls back to the ANSI default, not to 0");
  assert.equal(facts.isTTY, true);
});
