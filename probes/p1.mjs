// P1 — the runtime baseline (D-070) and the number that becomes `engines.node`.
// Pass condition from docs/ROADMAP.md §2: type stripping works on the Node the Termux package actually ships, and
// `npm run test` passes there. Everything below is measurable on this machine; the *Termux* half is the device step.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { envFacts, isTermux, Probe, parseArgs, report } from "./lib.mjs";

const probe = new Probe(
  "P1",
  "Node runtime baseline: .ts and node --test with no flags, no loader, no esbuild",
);
const args = parseArgs();
const dir = mkdtempSync(path.join(os.tmpdir(), "crabby-p1-"));

console.log(
  `P1 · ${envFacts().node} on ${envFacts().platform}${isTermux() ? " (Termux)" : " (not Termux)"}`,
);

// 1. a file that uses only erasable TypeScript must run under plain `node`
const runnable = path.join(dir, "erasable.ts");
writeFileSync(
  runnable,
  `type Row = { id: number; label: string };
interface Reader<T> { read(): T[] }
class MemReader implements Reader<Row> {
  rows: Row[];
  constructor(rows: Row[]) { this.rows = rows; }
  read(): Row[] { return this.rows; }
}
const reader = new MemReader([{ id: 1, label: "ok" }]) satisfies Reader<Row>;
const first = reader.read()[0];
console.log("ERASABLE_OK " + (first?.label ?? "missing"));
`,
);
let ran = "";
try {
  ran = execFileSync(process.execPath, [runnable], { encoding: "utf8" }).trim();
} catch (err) {
  ran = `threw: ${err.message.split("\n")[0]}`;
}
probe.check("node file.ts runs erasable TypeScript unflagged", ran === "ERASABLE_OK ok", ran);

// 2. `node --test` must discover and run a .ts test file unflagged
const testFile = path.join(dir, "sample.test.ts");
writeFileSync(
  testFile,
  `import test from "node:test";
import assert from "node:assert/strict";
test("the runner strips types too", () => {
  const n: number = 2;
  assert.equal(n + n, 4);
});
`,
);
let testOut = "";
let testOk = false;
try {
  testOut = execFileSync(process.execPath, ["--test", testFile], { encoding: "utf8" });
  testOk = /pass 1/.test(testOut) && !/fail [1-9]/.test(testOut);
} catch (err) {
  testOut = String(err.stdout ?? err.message).slice(0, 300);
}
probe.check(
  "node --test runs a .ts test file",
  testOk,
  testOk ? "1 pass" : testOut.replace(/\n/g, " ").slice(0, 160),
);

// 3. coverage must be available with the flag the plan relies on (D-069)
let covOut = "";
let covOk = false;
try {
  covOut = execFileSync(process.execPath, ["--test", "--experimental-test-coverage", testFile], {
    encoding: "utf8",
  });
  covOk = /all files/i.test(covOut);
} catch (err) {
  covOut = String(err.stdout ?? err.message).slice(0, 200);
}
probe.check(
  "--experimental-test-coverage prints a table",
  covOk,
  covOk ? "" : covOut.replace(/\n/g, " ").slice(0, 140),
);

// 4. the negative case is part of the decision: non-erasable syntax must be refused by the runtime, not by a linter
const enumFile = path.join(dir, "not-erasable.ts");
writeFileSync(enumFile, `export enum E { A }\nconsole.log(E.A);\n`);
let enumFailed = false;
let enumMsg = "";
try {
  execFileSync(process.execPath, [enumFile], { encoding: "utf8", stdio: "pipe" });
} catch (err) {
  enumFailed = true;
  const text = [String(err.stderr ?? ""), String(err.message ?? "")].join("\n");
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  enumMsg = lines.find((l) => /not supported|SyntaxError/i.test(l)) ?? lines[0] ?? "";
}
probe.check(
  "enum is refused by the runtime (D-070's constraint is enforced, not stylistic)",
  enumFailed,
  enumMsg.slice(0, 150),
);

// 5. the number that must become `engines.node` — recorded here, never restated in a document
probe.note("node", process.version);
probe.note(
  "npm",
  safe(() => execFileSync("npm", ["--version"], { encoding: "utf8" }).trim()),
);
probe.note("v8", process.versions.v8);
probe.note(
  "enginesNote",
  "package.json has no `engines` until this probe has been run on Termux (D-070)",
);

probe.manual(
  "run P1 inside a clean Termux prefix and paste the output",
  `pkg install nodejs-lts && cd <clone> && npm install && npm run probe:p1 — then compare the \`node\` note here with
      the device's, and record both in probes/RESULTS.md. A different Node means a different \`engines.node\`.`,
);
probe.manual(
  "confirm npm can install from the device network with no proxy tricks",
  `cd $(mktemp -d) && npm init -y && npm i @sinclair/typebox@0.34.52 --no-audit --no-fund`,
);

report(probe, args);

function safe(fn) {
  try {
    return fn();
  } catch (err) {
    return `unavailable: ${err.message.split("\n")[0]}`;
  }
}
