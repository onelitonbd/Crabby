// §4.1's workspace: one skill per folder under `<workspace>/skills`, the scan that reads them, and the name collision
// reported by the scan instead of thrown past it.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { SKILL_FILE } from "./skill.ts";
import { scanWorkspace, workspaceSkillsDir } from "./workspace.ts";

const dirs: string[] = [];
function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `crabby-ws-${prefix}-`));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function skillAt(workspace: string, folder: string, name: string): void {
  const dir = join(workspaceSkillsDir(workspace), folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, SKILL_FILE),
    `---\nname: ${name}\ndescription: The ${name} skill.\n---\n\nBody.\n`,
    "utf8",
  );
}

describe("the skills workspace (§4.1)", () => {
  it("reports a missing workspace as empty rather than throwing", () => {
    const scan = scanWorkspace(scratch("missing"));
    assert.equal(scan.exists, false);
    assert.deepEqual(scan.skills, []);
  });

  it("scans one skill per folder and carries the description", () => {
    const workspace = scratch("one");
    skillAt(workspace, "weekly-report", "weekly-report");
    const scan = scanWorkspace(workspace);
    assert.equal(scan.exists, true);
    assert.equal(scan.skills.length, 1);
    assert.equal(scan.skills[0]?.name, "weekly-report");
    assert.equal(scan.skills[0]?.description, "The weekly-report skill.");
  });

  it("reports a folder/name mismatch with the folder as identity and keeps the scan going", () => {
    const workspace = scratch("mismatch");
    skillAt(workspace, "weekly-report", "weekly-report");
    skillAt(workspace, "other-folder", "not-other-folder");
    const scan = scanWorkspace(workspace);
    const broken = scan.skills.find((skill) => skill.folder.endsWith("other-folder"));
    assert.ok(broken !== undefined);
    assert.equal(broken.parse.ok, false);
    assert.ok(
      scan.skills.some((skill) => skill.parse.ok),
      "the healthy folder is still listed",
    );
  });

  it("keeps the folder/name hard error visible per broken folder", () => {
    const workspace = scratch("broken");
    skillAt(workspace, "wrong", "not-wrong");
    const scan = scanWorkspace(workspace);
    assert.equal(scan.skills.length, 1);
    assert.equal(scan.skills[0]?.parse.ok, false);
    assert.match(scan.skills[0]?.warnings.join(" ") ?? "", /hard error/);
  });
});
