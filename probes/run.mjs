// The M0 runner. One command, seven probes, one verdict — and a verdict that cannot be read as stronger than it is:
// `blocked` (exit 2) is a missing precondition, `fail` (exit 1) is a measured problem, and neither is a pass.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { isTermux, OUT_DIR, PROBE_DIR } from "./lib.mjs";

const ALL = ["p1", "p2", "p3", "p4", "p5", "p6", "p7"];
const argv = process.argv.slice(2);
const device = argv.includes("--device");
const onlyIdx = argv.indexOf("--only");
const chosen =
  onlyIdx >= 0
    ? argv[onlyIdx + 1].split(",").map((s) => s.trim().toLowerCase().replace(/^p/, "p"))
    : ALL;
const unknown = chosen.filter((id) => !ALL.includes(id));
if (unknown.length) {
  console.error(`unknown probe(s): ${unknown.join(", ")} — the set is ${ALL.join(", ")}`);
  process.exit(64);
}

const startedAt = Date.now();
const rows = [];
for (const id of chosen) {
  const file = path.join(PROBE_DIR, `${id}.mjs`);
  if (!existsSync(file)) {
    rows.push({
      id: id.toUpperCase(),
      status: "missing",
      detail: "no such probe file",
      passed: 0,
      failed: 0,
      blocked: 0,
    });
    continue;
  }
  console.log(`\n${"—".repeat(78)}\n${id.toUpperCase()} · ${path.relative(process.cwd(), file)}\n`);
  const res = spawnSync(process.execPath, [file], { stdio: "inherit" });
  const json = path.join(OUT_DIR, `${id.toUpperCase()}.json`);
  let result = null;
  if (existsSync(json) && statSync(json).mtimeMs >= startedAt) {
    try {
      result = JSON.parse(readFileSync(json, "utf8"));
    } catch {
      result = null;
    }
  }
  if (!result) {
    rows.push({
      id: id.toUpperCase(),
      status: "crashed",
      detail: `exit ${res.status ?? "?"} with no result file — the probe died before it could report`,
      passed: 0,
      failed: 1,
      blocked: 0,
    });
    continue;
  }
  rows.push({
    id: result.id,
    status: result.status,
    detail: `${result.durationMs}ms on ${result.env.platform} · ${result.env.node}${result.env.termux ? " · Termux" : ""}`,
    passed: result.checks.filter((c) => c.ok).length,
    failed: result.checks.filter((c) => !c.ok && !c.blocked).length,
    blocked: result.checks.filter((c) => c.blocked).length,
    manual: result.manualSteps.length,
    envTermux: result.env.termux,
  });
}

console.log(`\n${"=".repeat(78)}`);
console.log("probe   status    pass fail blocked manual   note");
for (const r of rows) {
  console.log(
    `${r.id.padEnd(8)}${r.status.padEnd(10)}${String(r.passed).padStart(4)}${String(r.failed).padStart(5)}${String(r.blocked).padStart(8)}${String(r.manual ?? 0).padStart(8)}   ${r.detail}`,
  );
}
console.log("=".repeat(78));

const anyFail = rows.some((r) => r.failed > 0);
const anyBlocked = rows.some((r) => r.blocked > 0);
const allPass = !anyFail && !anyBlocked && rows.length === chosen.length;

if (device) {
  console.log(`
Device run (${isTermux() ? "this is Termux" : "NOT Termux — copy the block below to the phone and run it there"}):
  1. pkg install nodejs-lts git && git clone <repo> && cd <repo> && npm install
  2. npm run test:termux            # this command again, on the phone
  3. paste the table into probes/RESULTS.md's device column, and answer every manual step:
${rows.map((r) => `       ${r.id}: ${r.manual ?? 0} manual step(s)`).join("\n")}
  4. anything that changes a plan assumption becomes a DECISIONS.md row before M1 starts (docs/ROADMAP.md §2).`);
}

if (allPass) {
  console.log(
    "M0 exit condition is not this line. The condition is: every probe's result recorded in DECISIONS.md, and\nevery Proposed choice a probe touched resolved (docs/ROADMAP.md §2). Report the numbers, then decide.",
  );
}
process.exitCode = anyFail ? 1 : anyBlocked ? 2 : 0;
