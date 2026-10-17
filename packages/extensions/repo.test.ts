// The file-backed import path, wired to the verbs: a full-success import, the §4.3 note on its result, the
// folder-as-truth reconcile, and the uninstall that removes what install wrote.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it } from "node:test";
import { extInstall, extList, extUninstall } from "./repo.ts";
import { SKILL_FILE } from "./skill.ts";

const dirs: string[] = [];
function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `crabby-ext-${prefix}-`));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeSkill(root: string, folder: string, frontmatter: string): string {
  const dir = join(root, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, SKILL_FILE),
    `${frontmatter}\n\nTurn the raw weekly numbers into a one-page summary.\n`,
    "utf8",
  );
  return dir;
}

await it("imports a pack with a full-success result, originals and a report on disk", () => {
  const source = scratch("src");
  const repo = scratch("repo");
  writeSkill(
    source,
    "alpha-skill",
    [
      "---",
      "name: alpha-skill",
      "description: Writes the weekly report.",
      "allowed-tools: [Bash]",
      "---",
      "",
    ].join("\n"),
  );
  const result = extInstall({
    sourceDir: source,
    repoRoot: repo,
    now: new Date("2026-01-15T10:30:00Z"),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(result.warnings.join("\n"), /granted: never/);
  const converted = readFileSync(join(repo, "alpha-skill", SKILL_FILE), "utf8");
  assert.match(converted, /name: alpha-skill/);
  assert.match(converted, /Writes the weekly report\./);
  assert.equal(
    readFileSync(join(repo, "alpha-skill", "originals", SKILL_FILE), "utf8"),
    readFileSync(join(source, "alpha-skill", SKILL_FILE), "utf8"),
  );
  assert.equal(result.report.sourceFormat, "skill-md");
  assert.equal(readdirSync(join(repo, "alpha-skill", "reports")).length, 1);
  // The index row records the install.
  const listed = extList(repo, undefined);
  assert.deepEqual(
    listed.installed.map((extension) => [extension.name, extension.kind, extension.source]),
    [["alpha-skill", "skill", "import"]],
  );
  assert.ok(listed.installed[0]?.installedAt.startsWith("2026-01-15"));
});

await it("tolerates a missing index when listing and reconciles folders as the truth", () => {
  const repo = scratch("repo2");
  assert.deepEqual(extList(repo, undefined).installed, []);
  mkdirSync(join(repo, "kept-skill", "originals"), { recursive: true });
  writeFileSync(
    join(repo, "kept-skill", SKILL_FILE),
    "---\nname: kept-skill\ndescription: d\n---\nbody\n",
    "utf8",
  );
  writeFileSync(join(repo, "kept-skill", "originals", SKILL_FILE), "orig\n", "utf8");
  const listed = extList(repo, undefined);
  assert.equal(listed.installed.length, 1);
  assert.equal(listed.installed[0]?.name, "kept-skill");
  assert.ok(listed.installed[0]?.originalPath?.includes("originals"));
  const removed = extUninstall(repo, "kept-skill");
  assert.equal(removed.ok, true);
  assert.deepEqual(extList(repo, undefined).installed, []);
  assert.equal(extUninstall(repo, "kept-skill").ok, false);
});

await it("merges workspace skills into the listing and reports repo/workspace name collisions", () => {
  const repo = scratch("repo3");
  const workspace = scratch("ws");
  writeSkill(
    source5(workspace),
    "notes-skill",
    ["---", "name: notes-skill", "description: Take meeting notes.", "---", ""].join("\n"),
  );
  const listed = extList(repo, workspace);
  assert.deepEqual(
    listed.installed.map((extension) => [extension.name, extension.source]),
    [["notes-skill", "workspace"]],
  );
  assert.deepEqual(listed.collisions, []);
  // The same name imported into the repo: the imported copy wins the row (it carries the report), and the overlap
  // is §4.1's collision — reported, not silently swallowed.
  mkdirSync(join(repo, "notes-skill", "originals"), { recursive: true });
  writeFileSync(
    join(repo, "notes-skill", SKILL_FILE),
    "---\nname: notes-skill\ndescription: d\n---\nbody\n",
    "utf8",
  );
  writeFileSync(join(repo, "notes-skill", "originals", SKILL_FILE), "orig\n", "utf8");
  const merged = extList(repo, workspace);
  assert.deepEqual(
    merged.installed.map((extension) => [extension.name, extension.source]),
    [["notes-skill", "import"]],
  );
  assert.deepEqual(merged.collisions, ["notes-skill"]);
});

// A tiny helper so the workspace path is built by the package's own convention rather than a bare join in the test.
import { workspaceSkillsDir } from "./workspace.ts";

function source5(workspace: string): string {
  mkdirSync(workspaceSkillsDir(workspace), { recursive: true });
  return workspaceSkillsDir(workspace);
}
