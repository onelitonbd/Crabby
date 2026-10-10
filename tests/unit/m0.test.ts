import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

// M0's harness is the thing that decides whether the plan's assumptions are allowed to become code, so it gets real
// tests: the exit-code contract, and the invariant that the runner and the roadmap name the same probes. The probe
// files themselves are JavaScript on purpose (they run before the product's type surface exists), so they are asserted
// on as text and as processes rather than imported.
const repo = path.resolve(import.meta.dirname, "..", "..");
const read = (rel: string): string => readFileSync(path.join(repo, rel), "utf8");

describe("the probe harness", () => {
  it("exits 2 when a precondition is missing, and never calls that a pass", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "crabby-harness-"));
    const script = path.join(dir, "blocked.mjs");
    writeFileSync(
      script,
      `import { Probe, report, parseArgs } from ${JSON.stringify(path.join(repo, "probes", "lib.mjs"))};
const probe = new Probe("T1", "a probe whose tool is not here");
probe.block("the tool is installed", "nothing provides it on this machine");
report(probe, parseArgs());
`,
    );
    const res = spawnSync(process.execPath, [script], { encoding: "utf8" });
    assert.equal(
      res.status,
      2,
      `expected exit 2 for a blocked probe, got ${res.status}: ${res.stdout}${res.stderr}`,
    );
    assert.match(res.stdout, /T1 → blocked/);
    assert.doesNotMatch(res.stdout, /→ pass/);
    // and it left a machine-readable record behind, which is what run.mjs reads
    const json = JSON.parse(readFileSync(path.join(repo, "probes", "out", "T1.json"), "utf8"));
    assert.equal(json.status, "blocked");
    assert.equal(json.checks[0]?.blocked, true);
  });

  it("exits 1 for a measured failure and 0 for a clean pass", () => {
    for (const [ok, expected] of [
      [false, 1],
      [true, 0],
    ] as const) {
      const dir = mkdtempSync(path.join(os.tmpdir(), "crabby-harness-"));
      const script = path.join(dir, `verdict-${ok}.mjs`);
      writeFileSync(
        script,
        `import { Probe, report, parseArgs } from ${JSON.stringify(path.join(repo, "probes", "lib.mjs"))};
const probe = new Probe("T2${ok}", "a verdict check");
probe.check("the assumption", ${ok}, "observed detail");
report(probe, parseArgs());
`,
      );
      const res = spawnSync(process.execPath, [script], { encoding: "utf8" });
      assert.equal(
        res.status,
        expected,
        `${ok ? "pass" : "fail"} should exit ${expected}: ${res.stdout}`,
      );
    }
  });

  it("tells a non-Termux run that it proved the probe, not the assumption", () => {
    const lib = read(path.join("probes", "lib.mjs"));
    assert.match(lib, /not Termux/);
    assert.match(lib, /it cannot prove the assumption/);
  });
});

describe("the M0 set", () => {
  const ids = ["p1", "p2", "p3", "p4", "p5", "p6", "p7"];

  it("has a probe file for every roadmap probe, and each registers its own id", () => {
    for (const id of ids) {
      const src = read(path.join("probes", `${id}.mjs`));
      assert.match(
        src,
        new RegExp(`new Probe\\(\\s*"${id.toUpperCase()}"`),
        `${id}.mjs must announce itself as ${id.toUpperCase()}`,
      );
      assert.match(
        src,
        /report\(probe, args\)/,
        `${id}.mjs must finish with report(), or its exit code means nothing`,
      );
      assert.match(
        src,
        /probe\.manual\(/,
        `${id}.mjs must name at least one thing only a person on the phone can answer`,
      );
    }
  });

  it("lists the same probes in the runner, the manifest, and the roadmap", () => {
    const runner = read(path.join("probes", "run.mjs"));
    const listed = /const ALL = \[([^\]]+)\]/.exec(runner)?.[1] ?? "";
    const fromRunner = [...listed.matchAll(/"(p\d)"/g)].map((m) => m[1] as string);
    assert.deepEqual(fromRunner, ids, "run.mjs must run exactly the roadmap's set, in order");
    const manifest = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    for (const id of ids)
      assert.ok(manifest.scripts[`probe:${id}`], `npm run probe:${id} is missing`);
    assert.ok(manifest.scripts["test:termux"], "the device entry point is missing");
    const roadmap = read(path.join("docs", "ROADMAP.md"));
    const rows = [...roadmap.matchAll(/^\| (P\d) \|/gm)].map((m) => m[1] as string);
    const withSteps = ids.filter((id) => rows.includes(id.toUpperCase()));
    assert.ok(
      withSteps.length >= ids.length - 1,
      "the roadmap's P-rows and the probe files have drifted apart",
    );
  });

  it("keeps the probe installs and results out of the product", () => {
    const ignored = read(".gitignore");
    for (const entry of ["probes/.deps/", "probes/out/", "node_modules/"]) {
      assert.ok(
        ignored.includes(entry),
        `${entry} must be ignored: M0's scratch space cannot become a shipped file`,
      );
    }
    const status = spawnSync(
      "git",
      ["status", "--porcelain", "--ignored", "probes/.deps", "probes/out"],
      {
        cwd: repo,
        encoding: "utf8",
      },
    );
    assert.doesNotMatch(status.stdout, /^\s*[AMD?]{1,2}\s+probes\/out\/(?!.*json)/m);
  });
});

describe("the version pin the plan asked for", () => {
  it("refuses a laptop-derived engines field (D-070)", () => {
    const manifest = JSON.parse(read("package.json")) as { engines?: Record<string, string> };
    if (!manifest.engines?.node) return; // still absent, which is correct until P1 has a device number
    assert.match(
      manifest.engines.node,
      /^>=[0-9]+\./,
      "engines.node must be a lower bound, not a copy of one machine's version",
    );
    const results = read(path.join("probes", "RESULTS.md"));
    assert.match(results, /Termux/, "a pinned engines field has to cite the run that produced it");
  });

  it("records that the manifest is the only place a measured version may appear", () => {
    const results = read(path.join("probes", "RESULTS.md"));
    assert.match(results, /engines\.node/, "RESULTS.md must point at where the number goes");
    const dev = read(path.join("docs", "DEVELOPMENT.md"));
    assert.match(
      dev,
      /engines/,
      "DEVELOPMENT.md §1 has to explain the pin, or the next reader will guess again",
    );
  });
});

after(() => {
  // the harness writes probes/out/T1.json to prove it reports; that scratch result is not part of the record
  for (const id of ["T1", "T2true", "T2false"]) {
    try {
      execFileSync("rm", ["-f", path.join(repo, "probes", "out", `${id}.json`)]);
    } catch {
      /* nothing to clean on a machine where rm is not the tool */
    }
  }
});
