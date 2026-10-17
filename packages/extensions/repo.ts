// §12's `ext` verbs, as functions — the CLI layer (a later slice) binds these to argv; keeping the verbs here means
// the registry bookkeeping and the output shaping have one home and the command file stays a translator.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type CheckLine, type CheckResult, check, type HostFacts } from "./check.ts";
import { type ConversionReport, type ImportResult, importSkillPack } from "./convert.ts";
import { HOST_API } from "./manifest.ts";
import { scanWorkspace, workspaceSkillsDir } from "./workspace.ts";

export interface ExtRepoState {
  readonly root: string;
  readonly installed: readonly InstalledExtension[];
  /** §4.1's name uniqueness, across collections: names both the workspace and the imported repo claim. The imported
   *  copy wins the listing (it carries the conversion report); the collision is reported so the overlap is a fact, not
   *  a silent choice. */
  readonly collisions: readonly string[];
}

export interface InstalledExtension {
  readonly name: string;
  readonly kind: "skill";
  readonly source: "workspace" | "import";
  readonly installedAt: string;
  readonly version: string | undefined;
  readonly path: string;
  readonly originalPath: string | undefined;
  readonly lastReportPath: string | undefined;
}

const INDEX_FILE = "index.json";

function readIndex(root: string): { extensions: InstalledExtension[] } {
  const path = join(root, INDEX_FILE);
  if (!existsSync(path)) return { extensions: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { extensions?: InstalledExtension[] };
    return { extensions: Array.isArray(parsed.extensions) ? parsed.extensions : [] };
  } catch {
    // An unreadable index is rebuilt from disk on the next reconcile — the folders are the truth, the index is a
    // cache of the truth with timestamps.
    return { extensions: [] };
  }
}

function writeIndex(root: string, state: ExtRepoState): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, INDEX_FILE),
    `${JSON.stringify({ extensions: state.installed }, null, 2)}\n`,
    "utf8",
  );
}

/** §13's reconcile: the folders are the truth. Every folder with a converted `SKILL.md` appears in the list, whether
 *  or not the index remembers installing it; the index only adds timestamps and source. */
export function extList(repoRoot: string, workspace: string | undefined): ExtRepoState {
  const installed: InstalledExtension[] = [];
  const index = readIndex(repoRoot);
  const byName = new Map(index.extensions.map((extension) => [extension.name, extension]));
  if (existsSync(repoRoot)) {
    for (const entry of readdirSync(repoRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === INDEX_FILE) continue;
      const skillPath = join(repoRoot, entry.name, "SKILL.md");
      if (!existsSync(skillPath)) continue;
      const remembered = byName.get(entry.name);
      let version: string | undefined = remembered?.version;
      try {
        const text = readFileSync(skillPath, "utf8");
        const frontmatter = text.split(/^---$/m)[1] ?? "";
        const versionLine = frontmatter.match(/^\s*version:\s*(.+)$/m);
        if (versionLine === null) {
          const yamlBlock = frontmatter.match(/version:\s*([^\n]+)/);
          if (yamlBlock !== null) version = yamlBlock[1]?.trim();
        } else {
          version = versionLine[1]?.trim();
        }
      } catch {
        version = remembered?.version;
      }
      installed.push({
        name: entry.name,
        kind: "skill",
        source: remembered?.source ?? "import",
        installedAt: remembered?.installedAt ?? "",
        version,
        path: join(repoRoot, entry.name),
        originalPath: existsSync(join(repoRoot, entry.name, "originals", "SKILL.md"))
          ? join(repoRoot, entry.name, "originals", "SKILL.md")
          : undefined,
        lastReportPath: remembered?.lastReportPath,
      });
    }
  }
  const collisions: string[] = [];
  if (workspace !== undefined) {
    const scan = scanWorkspace(workspace);
    for (const skill of scan.skills) {
      if (!skill.parse.ok) continue;
      if (installed.some((extension) => extension.name === skill.name)) {
        // §4.1's name uniqueness across collections: the imported copy wins the row (it carries the report); the
        // overlap is reported, not swallowed.
        collisions.push(skill.name);
        continue;
      }
      installed.push({
        name: skill.name,
        kind: "skill",
        source: "workspace",
        installedAt: "",
        version: skill.parse.frontmatter.metadata.version,
        path: skill.folder,
        originalPath: undefined,
        lastReportPath: undefined,
      });
    }
  }
  return { root: repoRoot, installed, collisions };
}

export function extValidate(path: string, platform: string): CheckResult {
  return check({ path, host: { platform } });
}

export function extInit(
  targetDir: string,
  options: { readonly name: string; readonly description: string },
): string {
  mkdirSync(targetDir, { recursive: true });
  const frontmatter = [
    "---",
    `name: ${options.name}`,
    `description: ${JSON.stringify(options.description)}`,
    'license: "MIT"',
    "---",
    "",
  ].join("\n");
  const body =
    `# ${options.name}\n\n` +
    "Replace this paragraph with the instructions the agent follows when this skill is active.\n" +
    "Keep the body under 500 lines; move reference material into `references/` files.\n";
  writeFileSync(join(targetDir, "SKILL.md"), `${frontmatter}${body}`, "utf8");
  return join(targetDir, "SKILL.md");
}

export function extCheckCompat(input: {
  readonly path: string;
  readonly platform: string;
  readonly api?: { readonly major: number; readonly minor: number } | undefined;
}): {
  readonly verdict: CheckResult["verdict"];
  readonly lines: readonly CheckLine[];
  readonly hostApi: typeof HOST_API;
} {
  const host: HostFacts =
    input.api === undefined
      ? { platform: input.platform }
      : { platform: input.platform, api: input.api };
  const result = check({ path: input.path, host });
  return { verdict: result.verdict, lines: result.lines, hostApi: HOST_API };
}

export function extInstall(input: {
  readonly sourceDir: string;
  readonly repoRoot: string;
  readonly now?: Date | undefined;
}): ImportResult {
  const result = importSkillPack({
    sourceDir: input.sourceDir,
    installDir: input.repoRoot,
    now: input.now,
  });
  if (!result.ok) return result;
  const index = readIndex(input.repoRoot);
  const report = result.report;
  const next: InstalledExtension = {
    name: report.installedName,
    kind: "skill",
    source: "import",
    installedAt: report.createdAt,
    version:
      (report.mapped.find((entry) => entry.field === "metadata.version")?.value as
        | string
        | undefined) ?? undefined,
    path: join(input.repoRoot, report.installedName),
    originalPath: join(input.repoRoot, report.installedName, "originals", "SKILL.md"),
    lastReportPath: join(input.repoRoot, report.installedName, "reports"),
  };
  const others = index.extensions.filter((extension) => extension.name !== report.installedName);
  writeIndex(input.repoRoot, {
    root: input.repoRoot,
    installed: [...others, next],
    collisions: [],
  });
  return result;
}

export function extUninstall(
  repoRoot: string,
  name: string,
): { readonly ok: boolean; readonly message: string } {
  const dir = join(repoRoot, name);
  if (!existsSync(dir)) {
    return { ok: false, message: `nothing installed under '${name}'` };
  }
  rmSync(dir, { recursive: true, force: true });
  const index = readIndex(repoRoot);
  writeIndex(repoRoot, {
    root: repoRoot,
    installed: index.extensions.filter((extension) => extension.name !== name),
    collisions: [],
  });
  return { ok: true, message: `'${name}' removed (converted content, originals and reports)` };
}

export type { ConversionReport, ImportResult };
export { HOST_API, workspaceSkillsDir };
