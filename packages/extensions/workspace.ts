// §4.1's "A skill is its own folder": the workspace scans a folder that contains `SKILL.md` directly, or one level of
// folders that each contain one — the "one skill per folder" rule that makes the workspace mergeable and the name
// collision checkable.
//
// The default workspace path is fixed by convention, not config: `<workspace>/skills`. The whole point of the
// workspace scan is that it is shared and predictable — skills that live somewhere the user chose are imported
// (§11's C-1 path), which records a conversion report instead of a convention.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseSkill, SKILL_FILE, type SkillParseResult } from "./skill.ts";

/** `<workspace>/skills` — the convention §4.1 fixes; never a second config key, because a config key is a second
 *  place the same answer can disagree with itself. */
export function workspaceSkillsDir(workspace: string): string {
  return join(workspace, "skills");
}

export interface WorkspaceScan {
  readonly root: string;
  readonly exists: boolean;
  readonly skills: readonly {
    readonly folder: string;
    readonly name: string;
    readonly description: string;
    readonly warnings: readonly string[];
    readonly parse: SkillParseResult;
  }[];
}

export function scanWorkspace(workspace: string): WorkspaceScan {
  const root = workspaceSkillsDir(workspace);
  if (!existsSync(root)) return { root, exists: false, skills: [] };
  const folders = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, SKILL_FILE)))
    .map((entry) => join(root, entry.name));
  const skills: {
    folder: string;
    name: string;
    description: string;
    warnings: readonly string[];
    parse: SkillParseResult;
  }[] = [];
  for (const folder of folders) {
    const name = basename(folder);
    const parse = parseSkill(readFileSync(join(folder, SKILL_FILE), "utf8"), name);
    if (parse.ok) {
      skills.push({
        folder,
        name: parse.frontmatter.name,
        description: parse.frontmatter.description,
        warnings: parse.report.warnings.map((warning) => `${warning.path}: ${warning.message}`),
        parse,
      });
    } else {
      // A folder that fails the contract is reported with its folder-name as the identity — the workspace stays
      // scannable even when one folder is broken.
      skills.push({
        folder,
        name,
        description: "",
        warnings: parse.errors.map((error) => `${error.path}: ${error.message}`),
        parse,
      });
    }
  }
  return { root, exists: true, skills };
}
