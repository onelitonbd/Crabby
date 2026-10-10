#!/usr/bin/env node
// RESULTS.md's measured block is generated, never typed. A hand-copied number goes stale the moment a probe is re-run,
// and a stale summary is the most trusted, least checked thing in a repository (docs/CONSISTENCY_REVIEW.md F-24).
//   node probes/to-results.mjs          rewrite the block
//   node probes/to-results.mjs --check  exit 1 if the file no longer matches the JSON
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { OUT_DIR, PROBE_DIR } from "./lib.mjs";

const FILE = path.join(PROBE_DIR, "RESULTS.md");
const BEGIN = "<!-- measured:begin -->";
const END = "<!-- measured:end -->";
const IDS = ["P1", "P2", "P3", "P4", "P5", "P6", "P7"];
const check = process.argv.includes("--check");

const measured = [
  "| probe | status | pass/fail/blocked | manual steps | environment |",
  "| --- | --- | --- | --- | --- |",
  ...IDS.map((id) => {
    const file = path.join(OUT_DIR, `${id}.json`);
    if (!existsSync(file))
      return `| ${id} | not run | — | — | run \`npm run probe:${id.toLowerCase()}\` |`;
    const r = JSON.parse(readFileSync(file, "utf8"));
    const counts = (want) =>
      r.checks.filter((c) =>
        want === "blocked" ? c.blocked : want === "pass" ? c.ok : !c.ok && !c.blocked,
      ).length;
    return `| ${id} | ${r.status} | ${counts("pass")}/${counts("fail")}/${counts("blocked")} | ${r.manualSteps.length} | ${r.env.node} · ${r.env.platform}${r.env.termux ? " · Termux" : " · not Termux"} |`;
  }),
  "",
  ...IDS.flatMap((id) => {
    const file = path.join(OUT_DIR, `${id}.json`);
    if (!existsSync(file)) return [`**${id} — not run.**`, ""];
    const r = JSON.parse(readFileSync(file, "utf8"));
    const counts = (want) =>
      r.checks.filter((c) =>
        want === "blocked" ? c.blocked : want === "pass" ? c.ok : !c.ok && !c.blocked,
      ).length;
    const notes = Object.entries(r.notes).map(
      ([k, v]) => `- ${k}: ${String(v).replace(/\s*\n\s*/g, " ")}`,
    );
    const oneLine = (v) => String(v).replace(/\s*\n\s*/g, " ");
    const lines = r.checks.map(
      (c) =>
        `- ${c.blocked ? "▢" : c.ok ? "✓" : "✗"} ${oneLine(c.name)}${c.detail ? ` — ${oneLine(c.detail)}` : ""}`,
    );
    return [
      `### ${id} · ${r.title}`,
      ``,
      `Status \`${r.status}\` — ${counts("pass")} passed, ${counts("fail")} failed, ${counts("blocked")} blocked, ${r.manualSteps.length} manual step(s), ${r.durationMs}ms, \`probes/out/${id}.json\`, recorded ${r.recordedAt}.`,
      ``,
      ...lines.filter((l) => l.includes("✗")),
      ...notes,
      ``,
      `<summary>every check this run</summary>`,
      ``,
      ...lines,
      "",
    ];
  }),
].join("\n");

const text = readFileSync(FILE, "utf8");
const start = text.indexOf(BEGIN);
const end = text.indexOf(END);
if (start < 0 || end < 0) {
  console.error(`${FILE} lost its ${BEGIN} markers`);
  process.exit(1);
}
const rebuilt = `${text.slice(0, start + BEGIN.length)}\n\n${measured}\n\n${text.slice(end)}`;
if (check) {
  if (rebuilt !== text) {
    console.error(
      "probes/RESULTS.md is stale: the measured block no longer matches probes/out/. Run: node probes/to-results.mjs",
    );
    process.exit(1);
  }
  console.log(
    `probes/RESULTS.md matches probes/out/ for ${IDS.filter((id) => existsSync(path.join(OUT_DIR, `${id}.json`))).length}/${IDS.length} probes`,
  );
} else {
  writeFileSync(FILE, rebuilt);
  console.log(`wrote the measured block into ${path.relative(process.cwd(), FILE)}`);
}
