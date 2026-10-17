// Region C-E's `ext` verbs — the CLI face of `EXTENSIONS.md`'s content-only path. The verbs are thin on purpose:
// every rule they enforce lives in `@crabby/extensions` (the checker, the conversion report, the repo), so the CLI
// cannot have a private opinion about what is safe to install. What this file adds is the interaction shape the
// accepted rows price:
//
//   - C-E2: `ext validate` prints one line per check and exits `2` with the failing key named — usable in CI.
//   - C-E4: the conversion report is written per install and never overwritten, and the verb prints the path.
//   - C-E5: `ext check-compat <id> --diff <older>` prints a unified diff of two reports, because "what changed
//     between v1 and v2" is the question the report format exists to answer.
//   - C-E6: install is validate → verdict → capability diff → approval, and an `unsafe` verdict stops the command —
//     there is no override flag to search for.
//   - C-E7: the size and dependency count print before the confirmation prompt, one line.
//   - C-E11: uninstall discloses what it removed in two lines; `--purge-data` is the distinct action, and for skills
//     it says honestly that no owner data exists to purge in this build.
//
// The registry is the flag grammar; `parseTail` reads the tail against it, so a flag that is not in `registry.ts`
// cannot be typed here either.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { EXIT, type ExitCode } from "@crabby/api-contracts";
import {
  extInit,
  extInstall,
  extList,
  extUninstall,
  extValidate,
  workspaceSkillsDir,
} from "@crabby/extensions";
import type { DataLayout } from "@crabby/platform";
import { migrate, openDatabase, recordAudit } from "@crabby/storage";
import { parseTail } from "../args.ts";
import type { Renderer } from "../output.ts";
import { findCommand } from "../registry.ts";

export type ExtVerb =
  | "init"
  | "validate"
  | "check-compat"
  | "install"
  | "list"
  | "info"
  | "uninstall";

/** `<stateDir>/extensions` — the imported-content repo the Gateway's routes will read too, so both interfaces answer
 *  from one place (the D-005 test) and the folder is the truth the index merely remembers (EXTENSIONS.md §13). */
export function extensionsRepoDir(layout: DataLayout): string {
  return join(layout.stateDir, "extensions");
}

/** §4.1's workspace is the folder the person is in: `<cwd>/skills` when it exists, nothing otherwise — a workspace
 *  the user never created is not a workspace, and scanning it anyway would list scaffolds nobody finished. */
function workspaceIfPresent(): string | undefined {
  const workspace = process.cwd();
  return existsSync(workspaceSkillsDir(workspace)) ? workspace : undefined;
}

/** The name is the install key (§4.3); `init` writes folders, so it enforces the same shape the frontmatter will be
 *  checked against — refusing here costs nothing, while refusing at validate costs a scaffold. */
const NAME_SHAPE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Unified diff of two texts, small enough to be read in a terminal: an LCS over lines, at most `context` lines of
 *  the unchanged kind around each hunk. Reports are a few KiB, so the quadratic LCS is not a runtime question. */
export function diffUnified(
  older: string,
  newer: string,
  olderLabel: string,
  newerLabel: string,
  context = 3,
): string {
  const a = older.split("\n");
  const b = newer.split("\n");
  // The LCS table, then the walk backwards that tags each line kept, deleted, or added.
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    const row = table[i] as number[];
    for (let j = b.length - 1; j >= 0; j--) {
      const ai = a[i];
      const bj = b[j];
      row[j] =
        ai === bj
          ? (table[i + 1]?.[j + 1] ?? 0) + 1
          : Math.max(table[i + 1]?.[j] ?? 0, table[i]?.[j + 1] ?? 0);
    }
  }
  const ops: { kind: " " | "-" | "+"; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: " ", text: a[i] as string });
      i += 1;
      j += 1;
    } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
      ops.push({ kind: "-", text: a[i] as string });
      i += 1;
    } else {
      ops.push({ kind: "+", text: b[j] as string });
      j += 1;
    }
  }
  while (i < a.length) {
    ops.push({ kind: "-", text: a[i] as string });
    i += 1;
  }
  while (j < b.length) {
    ops.push({ kind: "+", text: b[j] as string });
    j += 1;
  }
  // Hunks: group changed lines with their surrounding context, with `@@` headers in the classic shape.
  const lines: string[] = [`--- ${olderLabel}`, `+++ ${newerLabel}`];
  let index = 0;
  let anyChange = false;
  while (index < ops.length) {
    if (ops[index]?.kind === " ") {
      index += 1;
      continue;
    }
    anyChange = true;
    const start = Math.max(0, index - context);
    let end = index;
    while (end < ops.length) {
      if (ops[end]?.kind !== " ") {
        end += 1;
        continue;
      }
      let run = 0;
      while (end + run < ops.length && ops[end + run]?.kind === " ") run += 1;
      if (run > context * 2) break;
      end += run;
    }
    end = Math.min(ops.length, end + context);
    const hunk = ops.slice(start, end);
    const oldCount = hunk.filter((op) => op.kind !== "+").length;
    const newCount = hunk.filter((op) => op.kind !== "-").length;
    lines.push(`@@ -${start + 1},${oldCount} +${start + 1},${newCount} @@`);
    for (const op of hunk) lines.push(`${op.kind} ${op.text}`);
    index = end;
  }
  return anyChange ? lines.join("\n") : "the two reports are identical";
}

/** One directory's own bytes and file count — C-E7's size line, computed from the tree rather than guessed. */
function treeSize(dir: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  const walk = (path: string): void => {
    for (const entry of readdirSync(path)) {
      const full = join(path, entry);
      const stats = statSync(full);
      if (stats.isDirectory()) walk(full);
      else {
        bytes += stats.size;
        files += 1;
      }
    }
  };
  walk(dir);
  return { bytes, files };
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${bytes} B`;
}

/** Resolve `check-compat`/`install`'s subject: a path that exists wins; otherwise the word is looked up among the
 *  installed extensions, because a report diff has to be able to name `weekly-report` and not its path. */
function resolveTarget(
  word: string,
  repoRoot: string,
): { readonly path: string; readonly installedName?: string } | undefined {
  if (existsSync(word)) return { path: resolve(word) };
  if (existsSync(repoRoot)) {
    for (const entry of readdirSync(repoRoot, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        entry.name === word &&
        existsSync(join(repoRoot, word, "SKILL.md"))
      ) {
        return { path: join(repoRoot, word), installedName: word };
      }
    }
  }
  return undefined;
}

/** The reports directory of an installed skill, sorted oldest-first — ISO-stamped names sort themselves. */
function reportsOf(installedName: string, repoRoot: string): readonly string[] {
  const dir = join(repoRoot, installedName, "reports");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => join(dir, name));
}

async function confirmInstall(
  renderer: Renderer,
  yes: boolean,
): Promise<"yes" | "no" | "refuse-non-tty"> {
  if (yes) return "yes";
  if (process.stdin.isTTY === true && process.stdout.isTTY === true) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await rl.question("proceed with this install? [y/N]: ")).trim().toLowerCase();
      return answer === "y" || answer === "yes" ? "yes" : "no";
    } catch {
      return "no";
    } finally {
      rl.close();
    }
  }
  renderer.fix("not a terminal: pass --yes to install without a prompt");
  return "refuse-non-tty";
}

export async function runExt(
  verb: string | undefined,
  rest: readonly string[],
  layout: DataLayout,
  renderer: Renderer,
): Promise<ExitCode> {
  const spec = findCommand("ext", verb);
  const tail = parseTail(rest, spec);
  const repoRoot = extensionsRepoDir(layout);

  if (tail.unknown.length > 0) {
    renderer.line("unknown flag(s)", tail.unknown.join(" "));
    renderer.fix(
      `crabby ext ${verb ?? ""} --help lists the flags this verb reads`.replace(/ {2,}/g, " "),
    );
    return EXIT.usage;
  }

  switch (verb) {
    case "init": {
      const name = tail.positionals[0];
      if (name === undefined) {
        renderer.line("usage", "crabby ext init <name> [--description TEXT] [--out DIR]");
        return EXIT.usage;
      }
      if (name.length > 64 || !NAME_SHAPE.test(name)) {
        renderer.line(
          "ext init",
          `'${name}' is not a skill name: 1–64 characters, lowercase letters, digits and single interior hyphens`,
        );
        return EXIT.usage;
      }
      const out = tail.values.out ?? process.cwd();
      const target = join(resolve(out), name);
      if (existsSync(target)) {
        renderer.line(
          "ext init",
          `refused: '${target}' already exists — ext init never overwrites`,
        );
        return EXIT.failure;
      }
      const description = tail.values.description ?? `The ${name} skill.`;
      const written = extInit(target, { name, description });
      renderer.line("scaffolded", written);
      renderer.line(
        "body",
        "replace the stub paragraph with the instructions the agent follows when the skill is active",
      );
      renderer.line(
        "splitting",
        "keep the body under 500 lines; reference material goes in files beside SKILL.md",
      );
      renderer.fix(`crabby ext validate ${target} checks it before anyone installs it`);
      renderer.fix(`crabby ext install ${target} imports it into ${repoRoot}`);
      return renderer.done({ path: written });
    }

    case "validate": {
      const path = tail.positionals[0] ?? process.cwd();
      if (!existsSync(path)) {
        renderer.line("ext validate", `nothing to validate at '${path}'`);
        return EXIT.usage;
      }
      const result = extValidate(path, process.platform);
      for (const line of result.lines) {
        if (line.id !== "verdict") renderer.line(line.id, line.message);
      }
      renderer.line("verdict", result.verdict);
      if (renderer.json) {
        renderer.done({ path: resolve(path), verdict: result.verdict, lines: result.lines });
        return hasErrorLines(result.lines) ? EXIT.usage : EXIT.success;
      }
      return hasErrorLines(result.lines) ? EXIT.usage : EXIT.success;
    }

    case "check-compat": {
      const word = tail.positionals[0];
      if (word === undefined) {
        renderer.line("usage", "crabby ext check-compat <path|name> [--diff OLDER] [--explain]");
        return EXIT.usage;
      }
      const target = resolveTarget(word, repoRoot);
      if (target === undefined) {
        renderer.line("ext check-compat", `no extension or path '${word}'`);
        return EXIT.usage;
      }
      const result = extValidate(target.path, process.platform);
      for (const line of result.lines) {
        if (line.id !== "verdict") renderer.line(line.id, line.message);
      }
      renderer.line("verdict", result.verdict);
      if (tail.booleans.has("--explain")) {
        renderer.line(
          "explain",
          "the AI-assisted explanation is §6 step 8 and rides a later slice; the verdict above is the deterministic check and will not change when it arrives",
        );
      }
      if (tail.values.diff !== undefined) {
        // C-E5: the diff is between two *reports* on disk, so the answer is evidence rather than a re-rendering.
        if (target.installedName === undefined) {
          renderer.line(
            "ext check-compat",
            `'--diff' names an installed extension's reports; '${word}' is a path`,
          );
          return EXIT.usage;
        }
        const reports = reportsOf(target.installedName, repoRoot);
        if (reports.length === 0) {
          renderer.line(
            "ext check-compat",
            `'${target.installedName}' has no conversion reports on disk`,
          );
          return EXIT.failure;
        }
        const olderWanted = tail.values.diff ?? "";
        const fileName = (file: string): string => file.split(/[\\/]/).pop() ?? file;
        const older = reports.find((file) => fileName(file).includes(olderWanted));
        if (older === undefined) {
          renderer.line(
            "ext check-compat",
            `no report matches '${olderWanted}'; on disk: ${reports.map((file) => fileName(file)).join(", ")}`,
          );
          return EXIT.usage;
        }
        const latest = reports[reports.length - 1] as string;
        if (older === latest) {
          renderer.line(
            "ext check-compat",
            `'${olderWanted}' is the latest report; there is nothing newer to diff against`,
          );
          return EXIT.usage;
        }
        renderer.raw(
          diffUnified(readFileSync(older, "utf8"), readFileSync(latest, "utf8"), older, latest),
        );
      }
      if (renderer.json) {
        renderer.done({ verdict: result.verdict, lines: result.lines });
        return hasErrorLines(result.lines) ? EXIT.usage : EXIT.success;
      }
      return hasErrorLines(result.lines) ? EXIT.usage : EXIT.success;
    }

    case "install": {
      const word = tail.positionals[0];
      if (word === undefined) {
        renderer.line("usage", "crabby ext install <path>");
        return EXIT.usage;
      }
      const target = resolveTarget(word, repoRoot);
      if (target === undefined) {
        renderer.line("ext install", `nothing to install at '${word}'`);
        return EXIT.usage;
      }
      // Step 1 — the verdict. `unsafe` and `incompatible` stop here, with no flag to search for (C-E6).
      const result = extValidate(target.path, process.platform);
      for (const line of result.lines.filter(
        (line) => line.severity !== "info" && line.id !== "verdict",
      )) {
        renderer.line(line.id, line.message);
      }
      renderer.line("verdict", result.verdict);
      if (result.verdict === "unsafe" || result.verdict === "incompatible") {
        renderer.line("ext install", "stopped: this verdict has no override");
        return EXIT.failure;
      }
      // Step 2 — the capability diff, as lines a person can read before they answer anything.
      if (result.skill !== undefined) {
        const mapped = result.skill.allowedTools;
        renderer.line(
          "capability diff",
          mapped.length === 0
            ? "the skill asks for nothing beyond being read"
            : `it names tools [${mapped.join(", ")}] — recorded for review, granted never (§4.3)`,
        );
      } else if (
        result.manifest?.capabilities !== undefined &&
        result.manifest.capabilities.length > 0
      ) {
        renderer.line(
          "capability diff",
          `the manifest declares [${result.manifest.capabilities.join(", ")}] — recorded, granted to nothing in a content-only build (§7)`,
        );
      } else {
        renderer.line("capability diff", "declares nothing beyond being read");
      }
      // Step 3 — C-E7's one line, before any prompt.
      const size = treeSize(target.path);
      renderer.line(
        "size",
        `${formatBytes(size.bytes)} across ${size.files} file(s) · dependencies: 0 (content-only pack)`,
      );
      // Step 4 — the approval itself. In `--json` mode there is no prompt to answer: a scripting call that wants the
      // install carries `--yes`, and one that omits it gets a document saying so rather than a question a script
      // cannot read — which is the empty-stdout bug this line fixed.
      if (renderer.json && !tail.booleans.has("--yes")) {
        renderer.fail({
          code: "approval_required",
          message: "install needs --yes in --json mode: a prompt is not a scripting answer",
        });
        return EXIT.needsApproval;
      }
      const answer = await confirmInstall(renderer, tail.booleans.has("--yes"));
      if (answer === "refuse-non-tty") return EXIT.needsApproval;
      if (answer === "no") {
        renderer.line("ext install", "declined; nothing was written");
        return EXIT.needsApproval;
      }
      const installed = extInstall({ sourceDir: target.path, repoRoot });
      if (!installed.ok) {
        renderer.line("ext install", installed.reason);
        for (const problem of installed.problems ?? []) renderer.line("  problem", problem);
        return EXIT.failure;
      }
      // §14's `extension_install` row, written by the CLI's own face: the trail holds the event, not the interface
      // that happened to perform it — the same row the Gateway's route writes when a phone installs.
      try {
        const handle = openDatabase(join(layout.stateDir, "crabby.sqlite3"));
        try {
          // Idempotent, and required: an install may be the first thing a fresh state dir ever runs, and the trail's
          // table exists only after the migrations do.
          migrate(handle.db);
          recordAudit(handle.db, {
            ts: new Date().toISOString(),
            kind: "extension_install",
            outcome: "ok",
            actor: "cli",
            interface: "cli",
            detail: {
              action: "install",
              name: installed.name,
              report: installed.reportPath,
            },
          });
        } finally {
          handle.close();
        }
      } catch {
        // A trail write that cannot reach the database is logged as a note, never a failed install — the pack is on
        // disk and the next install's report still names this one.
        renderer.line("audit", "the trail row could not be written (database unavailable)");
      }
      renderer.line("installed", join(repoRoot, installed.name));
      // C-E4: the report path is part of the answer, not a side effect to go looking for.
      renderer.line("report", installed.reportPath);
      for (const warning of installed.warnings) renderer.line("  note", warning);
      if (result.skill?.activationBlocked) {
        renderer.fix(
          "the body is over the 32 KiB activation cap (§4.3); the import is on disk and activation will refuse until it is split",
        );
      }
      return renderer.done({
        name: installed.name,
        path: join(repoRoot, installed.name),
        report: installed.reportPath,
        warnings: installed.warnings,
      });
    }

    case "list": {
      const workspace = workspaceIfPresent();
      const state = extList(repoRoot, workspace);
      for (const extension of state.installed) {
        const verdict =
          extension.source === "workspace"
            ? "compatible"
            : extValidate(extension.path, process.platform).verdict;
        renderer.line(
          extension.name,
          `${extension.kind} · ${extension.version ?? "no version"} · source: ${extension.source} · verdict: ${verdict} · state: installed`,
        );
      }
      for (const collision of state.collisions) {
        renderer.line(
          `collision: '${collision}'`,
          "exists in both <cwd>/skills and the imported repo; the imported copy is the one listed",
        );
      }
      if (state.installed.length === 0 && state.collisions.length === 0) {
        renderer.line(
          "ext list",
          `nothing installed — \`crabby ext install <path>\` imports a SKILL.md pack into ${repoRoot}`,
        );
      }
      return renderer.done({
        root: state.root,
        extensions: state.installed,
        collisions: state.collisions,
      });
    }

    case "info": {
      const word = tail.positionals[0];
      if (word === undefined) {
        renderer.line("usage", "crabby ext info <name>");
        return EXIT.usage;
      }
      const state = extList(repoRoot, workspaceIfPresent());
      const extension = state.installed.find((entry) => entry.name === word);
      if (extension === undefined) {
        renderer.line("ext info", `nothing installed under '${word}'`);
        return EXIT.usage;
      }
      renderer.line(
        extension.name,
        `${extension.kind} · ${extension.version ?? "no version"} · source: ${extension.source}`,
      );
      renderer.line("path", extension.path);
      if (extension.installedAt !== "") renderer.line("installed", extension.installedAt);
      if (extension.originalPath !== undefined)
        renderer.line("original preserved at", extension.originalPath);
      const check = extValidate(extension.path, process.platform);
      if (existsSync(join(extension.path, "SKILL.md"))) {
        const skill = check.skill;
        if (skill !== undefined) {
          renderer.line("description", `"${skill.description}"`);
          renderer.line(
            "tool requests",
            skill.allowedTools.length === 0
              ? "none"
              : `${skill.allowedTools.join(", ")} — recorded, granted never`,
          );
        }
      }
      const reports = reportsOf(extension.name, repoRoot);
      if (reports.length > 0) {
        const latest = reports[reports.length - 1] as string;
        renderer.line("reports", `${reports.length} on disk; latest: ${latest}`);
      }
      // C-E9's "last error": the deterministic check, re-run now — a stored verdict would answer about yesterday.
      const errors = check.lines.filter((line) => line.severity === "error");
      for (const error of errors) renderer.line("last error", `${error.id}: ${error.message}`);
      renderer.line("verdict", check.verdict);
      return renderer.done({
        ...extension,
        verdict: check.verdict,
        reports: reports.length,
        lines: check.lines,
      });
    }

    case "uninstall": {
      const name = tail.positionals[0];
      if (name === undefined) {
        renderer.line("usage", "crabby ext uninstall <name> [--purge-data]");
        return EXIT.usage;
      }
      const state = extList(repoRoot, workspaceIfPresent());
      const extension = state.installed.find((entry) => entry.name === name);
      if (extension === undefined) {
        renderer.line("ext uninstall", `nothing installed under '${name}'`);
        return EXIT.usage;
      }
      if (extension.source === "workspace") {
        renderer.line(
          "ext uninstall",
          `refused: '${name}' is a workspace skill at ${extension.path} — that folder is the author's source, and ext uninstall only removes imported copies`,
        );
        return EXIT.usage;
      }
      // C-E11's disclosure, before the removal: what will be gone, in the two lines the row prices.
      const size = treeSize(extension.path);
      const reportCount = reportsOf(extension.name, repoRoot).length;
      renderer.line(
        "removing",
        `${extension.path} — ${formatBytes(size.bytes)} across ${size.files} files, ${reportCount} conversion report(s), the preserved original included`,
      );
      const removed = extUninstall(repoRoot, name);
      if (!removed.ok) {
        renderer.line("ext uninstall", removed.message);
        return EXIT.failure;
      }
      renderer.line(
        tail.booleans.has("--purge-data") ? "purge-data" : "residual data",
        "skills record no owner data in this build — the folder was the whole extension, so there is nothing further to purge",
      );
      return renderer.done({ removed: extension.path, files: size.files });
    }

    default: {
      renderer.line("usage", "crabby ext <init|validate|check-compat|install|list|info|uninstall>");
      return EXIT.usage;
    }
  }
}

function hasErrorLines(lines: readonly { readonly severity: string }[]): boolean {
  return lines.some((line) => line.severity === "error");
}
