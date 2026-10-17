// The C-1 import (§11): a portable `SKILL.md` pack becomes Crabby content, and the conversion report is the contract —
// what was mapped, what was dropped, what was reinterpreted, and what remains unknown (§11 rule 1), because "exactly
// what transferred" is the user's answer, not a summary.
//
// The rules this file enforces rather than remembers:
//   - **The source directory is never modified** (§11 rule 7) — the import writes only inside the repo.
//   - **Unsupported constructs are preserved in the source form inside the imported folder, never loaded** (rule 3):
//     the original `SKILL.md` ships verbatim under `originals/`, so a later Crabby version can read what this one
//     recorded without the user re-downloading anything.
//   - **`allowed-tools` is read for the report and never granted** (§4.3): the report carries the raw list and the
//     §6.1 names it maps to, with `granted: false` stated where a reader will look for it.
//   - **The import passes the same scan a native package passes** (rule 5) — an `unsafe` body imports nothing.
//   - **The verdict is per capability, never per package** (rule 6): a skill whose frontmatter converted cleanly but
//     whose body trips the scan is `unsafe`, not "mostly fine".
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { HOST_API } from "./manifest.ts";
import { scanContent } from "./scan.ts";
import { parseSkill, SKILL_FILE } from "./skill.ts";

export interface ConversionReport {
  readonly sourceFormat: "skill-md";
  readonly sourcePath: string;
  readonly installedName: string;
  readonly hostApi: { readonly major: number; readonly minor: number };
  readonly createdAt: string;
  /** Fields §4.3 honors, with the value they landed under. */
  readonly mapped: readonly { readonly field: string; readonly value: unknown }[];
  /** Fields the format allows that Crabby displays but never acts on. */
  readonly displayed: readonly { readonly field: string; readonly value: string }[];
  /** Fields translated to something with a different meaning here — so far: none. The column exists because rule 4
   *  says "translated only when there is a genuine Crabby equivalent", and the honest empty list proves the rule was
   *  read rather than forgotten. */
  readonly reinterpreted: readonly unknown[];
  /** Fields this build does not understand, preserved verbatim under `originals/` and named here (rule 3). */
  readonly unknown: readonly { readonly field: string; readonly value: unknown }[];
  readonly allowedTools: {
    readonly raw: readonly string[];
    readonly granted: false;
    readonly note: string;
  };
  readonly warnings: readonly string[];
  readonly scan: { readonly unsafe: boolean; readonly patterns: readonly string[] };
}

export type ImportResult =
  | {
      readonly ok: true;
      readonly name: string;
      readonly installedAt: string;
      readonly report: ConversionReport;
      readonly reportPath: string;
      readonly warnings: readonly string[];
    }
  | { readonly ok: false; readonly reason: string; readonly problems?: readonly string[] };

/** §11 rule 2's "stored with the artifact" — one file per install, never overwritten: the millisecond timestamp is
 *  enough for humans, and the `-2`, `-3` suffixes are there so a scripted double-install cannot rewrite history. */
function uniqueReportName(reportsDir: string, now: Date): string {
  const stem = `report-${now.toISOString().replace(/[:.]/g, "-")}`;
  let candidate = `${stem}.json`;
  let counter = 2;
  while (existsSync(join(reportsDir, candidate))) {
    candidate = `${stem}-${counter}.json`;
    counter += 1;
  }
  return candidate;
}

/** The §6.1 names an upstream tool name maps to, for the report only. The alias table is explicit (upstream name ⇒
 *  capability) so the mapping itself is reviewable data, not a heuristic — and a name outside the table maps to
 *  nothing, loudly, rather than to its nearest-looking neighbor. */
const TOOL_ALIASES: Readonly<Record<string, string>> = {
  bash: "shell.run",
  shell: "shell.run",
  sh: "shell.run",
  read: "fs.read",
  readfile: "fs.read",
  write: "fs.write",
  writefile: "fs.write",
  edit: "fs.write",
  webfetch: "net.fetch",
  fetch: "net.fetch",
  glob: "fs.list",
  grep: "fs.list",
  ls: "fs.list",
};

function mapToolNames(raw: readonly string[]): readonly string[] {
  const mapped: string[] = [];
  for (const name of raw) {
    const capability = TOOL_ALIASES[name.trim().toLowerCase()];
    if (capability !== undefined && !mapped.includes(capability)) mapped.push(capability);
  }
  return mapped;
}

/** Import one `SKILL.md` (directly in `sourceDir`) or a folder of them (one level down, the pack shape). Never touches
 *  the source; writes `SKILL.md` (honored fields only), `originals/SKILL.md` (verbatim) and the report under `installDir`. */
export function importSkillPack(input: {
  readonly sourceDir: string;
  readonly installDir: string;
  readonly now?: Date | undefined;
}): ImportResult {
  const { sourceDir, installDir } = input;
  if (!existsSync(sourceDir)) {
    return { ok: false, reason: `nothing to import at '${sourceDir}'` };
  }
  const entries = readdirSync(sourceDir);
  const direct = entries.includes(SKILL_FILE);
  const folders = direct
    ? [sourceDir]
    : entries
        .filter((entry) => !entry.startsWith(".") && existsSync(join(sourceDir, entry, SKILL_FILE)))
        .map((entry) => join(sourceDir, entry));
  if (folders.length === 0) {
    return {
      ok: false,
      reason: `no ${SKILL_FILE} at '${sourceDir}' (directly, or one level down)`,
    };
  }

  const now = input.now ?? new Date();
  const warnings: string[] = [];
  mkdirSync(installDir, { recursive: true });

  let lastName = "";
  let lastReportFile = "";
  const reports: ConversionReport[] = [];
  for (const dir of folders) {
    const folderName = basename(dir);
    const text = readFileSync(join(dir, SKILL_FILE), "utf8");
    const parsed = parseSkill(text, folderName);
    if (!parsed.ok) {
      return {
        ok: false,
        reason: `'${folderName}' does not parse under D-071's contract`,
        problems: parsed.errors.map((error) => `${error.path}: ${error.message}`),
      };
    }
    const fm = parsed.frontmatter;
    // Rule 5: the same scan a native package passes. Unsafe content imports nothing.
    const scan = scanContent(fm.description, parsed.report.body);
    if (scan.unsafe) {
      return {
        ok: false,
        reason: `'${fm.name}' matches the static safety scan (§6 step 6), and unsafe content imports nothing (§6.1)`,
        problems: scan.lines.map((line) => `${line.pattern} (${line.where}): ${line.reason}`),
      };
    }

    const skillDir = join(installDir, fm.name);
    const originalsDir = join(skillDir, "originals");
    const reportsDir = join(skillDir, "reports");
    mkdirSync(originalsDir, { recursive: true });
    mkdirSync(reportsDir, { recursive: true });

    // Rule 3: the source, verbatim, where a later version can find it — and never loaded, because only the converted
    // `SKILL.md` beside it is read.
    copyFileSync(join(dir, SKILL_FILE), join(originalsDir, SKILL_FILE));

    // The converted frontmatter carries only what §4.3 honors; the body is the body — truncation is the one thing a
    // loader may never do (§4.3).
    const frontmatterLines = [
      "---",
      `name: ${fm.name}`,
      `description: ${JSON.stringify(fm.description)}`,
      ...(fm.license === undefined ? [] : [`license: ${fm.license}`]),
      ...(fm.metadata.version === undefined
        ? []
        : [`metadata:`, `  version: ${fm.metadata.version}`]),
      "---",
      "",
    ];
    writeFileSync(
      join(skillDir, SKILL_FILE),
      `${frontmatterLines.join("\n")}${parsed.report.body}`,
      "utf8",
    );

    const unknown: { field: string; value: unknown }[] = [
      ...parsed.report.unknownFields.map((field) => ({
        field,
        value: field.startsWith("metadata.")
          ? ((parsed.report.preserved as Record<string, unknown>)[
              field.slice("metadata.".length)
            ] ?? fm.metadata.unknown[field.slice("metadata.".length)])
          : (parsed.report.preserved as Record<string, unknown>)[field],
      })),
      ...(parsed.report.preserved["allowed-tools"] !== undefined
        ? [{ field: "allowed-tools", value: parsed.report.preserved["allowed-tools"] }]
        : []),
      ...(fm.compatibility === undefined ? [] : []),
    ];
    const report: ConversionReport = {
      sourceFormat: "skill-md",
      sourcePath: join(dir, SKILL_FILE),
      installedName: fm.name,
      hostApi: { ...HOST_API },
      createdAt: now.toISOString(),
      mapped: [
        { field: "name", value: fm.name },
        { field: "description", value: fm.description },
        ...(fm.license === undefined ? [] : [{ field: "license", value: fm.license }]),
        ...(fm.metadata.version === undefined
          ? []
          : [{ field: "metadata.version", value: fm.metadata.version }]),
        ...(fm.metadata.author === undefined
          ? []
          : [{ field: "metadata.author", value: fm.metadata.author }]),
        ...(fm.metadata.tags === undefined
          ? []
          : [{ field: "metadata.tags", value: fm.metadata.tags }]),
      ],
      displayed:
        fm.compatibility === undefined ? [] : [{ field: "compatibility", value: fm.compatibility }],
      reinterpreted: [],
      unknown,
      allowedTools: {
        raw: fm.allowedTools ?? [],
        granted: false,
        note:
          "§4.3: read for the capability diff, never granted — an approval tier is never skipped because a file " +
          "asked to be exempt",
      },
      warnings: parsed.report.warnings.map((warning) => `${warning.path}: ${warning.message}`),
      scan: { unsafe: false, patterns: [] },
    };
    const reportName = uniqueReportName(reportsDir, now);
    const reportPath = join(reportsDir, reportName);
    lastReportFile = reportPath;
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    reports.push(report);
    lastName = fm.name;
    if (fm.allowedTools !== undefined && fm.allowedTools.length > 0) {
      warnings.push(
        `'${fm.name}' asks for tools [${fm.allowedTools.join(", ")}] — mapped for the report as ` +
          `[${mapToolNames(fm.allowedTools).join(", ") || "nothing in §6.1's vocabulary"}]; granted: never`,
      );
    }
    for (const warning of parsed.report.warnings)
      warnings.push(`'${fm.name}': ${warning.path}: ${warning.message}`);
  }

  return {
    ok: true,
    name: lastName,
    installedAt: join(installDir),
    report: reports[reports.length - 1] as ConversionReport,
    reportPath: lastReportFile,
    warnings,
  };
}
