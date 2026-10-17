// The license audit Brief §14 asked for: every third-party dependency this build ships, with its license, checked
// against an allowlist, and the notices file generated from what is actually installed — not from a hand-kept list,
// which is how a notice goes stale while the lockfile moves.
//
// The rules (`docs/DEVELOPMENT.md` §9: "Supported Node range and dependency licenses are re-checked at release, not
// only at first publish"):
//
//   - The walk is **production only**, from the root `package.json` and every workspace package's `dependencies` —
//     devDependencies are tooling on the builder's machine, not something Crabby distributes.
//   - `@crabby/*` names are this repository's own packages and are skipped: the audit is about *third-party* code.
//   - The allowlist is the ordinary permissive set. Anything outside it — a GPL package, a custom "fair" license, an
//     unknown field — **fails the audit** rather than being waved through, because a license question nobody can
//     answer is a distribution blocker, and distribution is exactly what this file exists to unblock.
//   - `THIRD-PARTY-NOTICES.md` is regenerated here, sorted, with each package's own license text carried verbatim so
//     the file a user reads is the file the license told them to read.
//
// Run: `npm run license:audit`. Exit 0 when every license is allowlisted and the notices file is written.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

/** The permissive set. `Apache-2.0` carries a patent grant and a notice requirement the generated file satisfies;
 *  everything else here is short-form MIT/BSD/ISC-family. A dual license ("MIT OR Apache-2.0") passes when **every**
 *  branch passes, which is the conservative reading of an OR nobody asked us to pick from. */
const ALLOWED = new Set([
  "MIT",
  "MIT-0",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "0BSD",
  "Unlicense",
  "CC0-1.0",
  "BlueOak-1.0.0",
]);

interface PkgJson {
  name?: string;
  version?: string;
  license?: string;
  licenses?: { type?: string }[];
  dependencies?: Record<string, string>;
}

function readPkg(dir: string): PkgJson | undefined {
  try {
    return JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as PkgJson;
  } catch {
    return undefined;
  }
}

/** The license field, read the way npm documents it: a plain string, or the legacy `licenses` array. */
function licenseOf(pkg: PkgJson): string {
  if (typeof pkg.license === "string") return pkg.license;
  if (Array.isArray(pkg.licenses) && pkg.licenses.length > 0) {
    const types = pkg.licenses.map((entry) => entry.type ?? "").filter((entry) => entry !== "");
    if (types.length > 0) return types.join(" OR ");
  }
  return "UNLICENSED-UNKNOWN";
}

/** Every branch of an SPDX-ish expression must be allowlisted — the conservative reading, stated above. */
function allowedEverywhere(expression: string): boolean {
  const parts = expression
    .replaceAll("(", "")
    .replaceAll(")", "")
    .split(/\s+(?:OR|AND|WITH)\s+/)
    .map((part) => part.trim())
    .filter((part) => part !== "");
  return parts.length > 0 && parts.every((part) => ALLOWED.has(part));
}

/** The production closure: workspace `dependencies` minus `@crabby/*`, walked through `node_modules` and through
 *  each resolved package's own dependencies. Node resolves a nested tree, but `npm install` hoists, and the audit
 *  walks the hoisted tree the way the files actually sit; a package not hoisted is walked from its parent's
 *  `node_modules`, which this lookup order already handles. */
function resolveIn(name: string, from: string): string | undefined {
  for (const base of [from, ROOT]) {
    const candidate = path.join(base, "node_modules", name);
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
  }
  return undefined;
}

const seen = new Map<string, { dir: string; license: string; version: string }>();
const queue: { name: string; from: string }[] = [];

const workspaceJsons = [
  path.join(ROOT, "package.json"),
  ...readdirSync(path.join(ROOT, "packages")).map((name) =>
    path.join(ROOT, "packages", name, "package.json"),
  ),
  ...readdirSync(path.join(ROOT, "apps")).map((name) =>
    path.join(ROOT, "apps", name, "package.json"),
  ),
];
for (const file of workspaceJsons) {
  const pkg = readPkg(path.dirname(file));
  if (pkg === undefined) continue;
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    if (name.startsWith("@crabby/")) continue;
    queue.push({ name, from: path.dirname(file) });
  }
}

while (queue.length > 0) {
  const next = queue.pop();
  if (next === undefined) continue;
  const dir = resolveIn(next.name, next.from);
  if (dir === undefined) {
    console.error(
      `license audit: ${next.name} is not installed under node_modules — run npm install first`,
    );
    process.exit(1);
  }
  const key = next.name;
  if (seen.has(key)) continue;
  const pkg = readPkg(dir);
  if (pkg === undefined) {
    console.error(`license audit: ${next.name} has no readable package.json`);
    process.exit(1);
  }
  seen.set(key, {
    dir,
    license: licenseOf(pkg),
    version: typeof pkg.version === "string" ? pkg.version : "?",
  });
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    if (name.startsWith("@crabby/")) continue;
    queue.push({ name, from: dir });
  }
}

const entries = [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
const refused = entries.filter(([, entry]) => !allowedEverywhere(entry.license));

if (refused.length > 0) {
  console.error(
    "license audit: licenses outside the allowlist — these block distribution until the owner rules:",
  );
  for (const [name, entry] of refused)
    console.error(`  ${name} ${entry.version} — ${entry.license}`);
  process.exit(1);
}

// The notices file: each package's own license text, verbatim where the package ships one.
let notices = `# Third-party notices\n\nGenerated by \`npm run license:audit\` from what is actually installed — regenerate at release\n(\`docs/DEVELOPMENT.md\` §9, D-144). Crabby itself is MIT; the packages below travel with it.\n\n`;
for (const [name, entry] of entries) {
  notices += `## ${name} ${entry.version} — ${entry.license}\n\n`;
  const file = ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "LICENCE.md"]
    .map((candidate) => path.join(entry.dir, candidate))
    .find((candidate) => existsSync(candidate));
  if (file === undefined) {
    notices += `No license file ships in the package; the declared license above is the package.json field.\n\n`;
    continue;
  }
  notices += `${readFileSync(file, "utf8").trim()}\n\n`;
}
writeFileSync(path.join(ROOT, "THIRD-PARTY-NOTICES.md"), notices, "utf8");

console.log(
  `license audit: ${String(entries.length)} third-party packages, all within the allowlist — THIRD-PARTY-NOTICES.md written`,
);
for (const [name, entry] of entries) console.log(`  ${name} ${entry.version} — ${entry.license}`);
