// §6's deterministic checker, reduced to what the first release actually checks (D-035's content-only scope): format
// detection, structural validation, declared requirements against the host, platform fit, and the static safety scan.
// Steps [3] integrity and [8] AI-assist are out of this build's scope and named where they would go — integrity needs
// O-064's mechanism, and step 8 can only ever annotate a verdict step 7 reached.
//
// **The verdict is a function, not a process**: same files + same host facts ⇒ same verdict, which is what makes it
// testable without a model (§14) and re-runnable on update, host upgrade, and demand (§6's opening).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import {
  CONTENT_KINDS,
  EXECUTABLE_KINDS,
  type ExtensionKind,
  type ExtensionManifest,
  HOST_API,
  MANIFEST_FILE,
  readManifest,
} from "./manifest.ts";
import { scanContent } from "./scan.ts";
import { parseSkill, SKILL_FILE } from "./skill.ts";

export type ExtensionVerdict = "compatible" | "partial" | "incompatible" | "unsafe";

export interface CheckLine {
  readonly id: string;
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
}

export interface HostFacts {
  /** The platform this process runs on, in `platforms`-list vocabulary (e.g. `linux`, `android-termux`, `darwin`). */
  readonly platform: string;
  /** The host API this build serves; defaults to `HOST_API`, overridable by a test that pretends to be older. */
  readonly api?: { readonly major: number; readonly minor: number };
}

export interface CheckInput {
  readonly path: string;
  readonly host: HostFacts;
}

export interface CheckResult {
  readonly verdict: ExtensionVerdict;
  readonly lines: readonly CheckLine[];
  readonly format: "native" | "skill-md";
  readonly kind: ExtensionKind;
  readonly manifest: ExtensionManifest | undefined;
  readonly skill:
    | {
        readonly name: string;
        readonly description: string;
        readonly activationBlocked: boolean;
        readonly allowedTools: readonly string[];
        readonly unknownFields: readonly string[];
      }
    | undefined;
}

function detectFormat(path: string): "native" | "skill-md" | undefined {
  if (existsSync(join(path, MANIFEST_FILE))) return "native";
  const entries = existsSync(path) ? readdirSync(path) : [];
  const skillDirect = entries.includes(SKILL_FILE);
  const skillNested = entries.some((entry) => existsSync(join(path, entry, SKILL_FILE)));
  if (skillDirect || skillNested) return "skill-md";
  return undefined;
}

function parseApiPair(pair: string): { major: number; minor: number } | undefined {
  const [major, minor] = pair.split(".");
  if (major === undefined || minor === undefined) return undefined;
  const m = Number(major);
  const n = Number(minor);
  if (!Number.isInteger(m) || !Number.isInteger(n)) return undefined;
  return { major: m, minor: n };
}

/** §6 steps [1][2][4][5][6], in one pass. The lines are the report a user reads; the verdict is derived from them by
 *  the rules §6.1 states, in one place, so no codepath can upgrade a line after the fact. */
export function check(input: CheckInput): CheckResult {
  const lines: CheckLine[] = [];
  const format = detectFormat(input.path);
  if (format === undefined) {
    return {
      verdict: "incompatible",
      lines: [
        {
          id: "format",
          severity: "error",
          message:
            `nothing this build recognizes at '${input.path}' — a native '${MANIFEST_FILE}' or a ` +
            "`SKILL.md` (directly, or one level down) is what format detection looks for (§6 step 1)",
        },
      ],
      format: "skill-md",
      kind: "skill",
      manifest: undefined,
      skill: undefined,
    };
  }

  if (format === "native") {
    const parsed = readManifest(join(input.path, MANIFEST_FILE));
    if (!parsed.ok) {
      for (const problem of parsed.problems) {
        lines.push({ id: `manifest.${problem.path}`, severity: "error", message: problem.message });
      }
      return {
        verdict: "incompatible",
        lines,
        format,
        kind: "skill",
        manifest: undefined,
        skill: undefined,
      };
    }
    const manifest = parsed.manifest;
    // The executable kinds are blocked outright (D-038, §3): refused with the version-lock reason, never installed
    // half-way — C-E12's sentence.
    if ((EXECUTABLE_KINDS as readonly string[]).includes(manifest.kind)) {
      lines.push({
        id: "kind.executable",
        severity: "error",
        message:
          `kind '${manifest.kind}' executes code, and third-party executable extensions stay blocked until ` +
          "O-008's isolation gate passes a hostile-extension test (D-038) — reported as \"not supported yet in this " +
          'version", not loaded',
      });
      return {
        verdict: "incompatible",
        lines,
        format,
        kind: manifest.kind,
        manifest,
        skill: undefined,
      };
    }

    // §4.4's policy: a min-host-api above the host refuses to load, naming both versions; a max below the running
    // minor still loads, because nothing it called changed.
    const host = input.host.api ?? HOST_API;
    const min = parseApiPair(manifest.hostApi.min);
    if (min !== undefined && min.major > host.major) {
      lines.push({
        id: "host-api",
        severity: "error",
        message:
          `the bundle needs host API >= ${manifest.hostApi.min} and this build serves ` +
          `${host.major}.${host.minor} — ext_host_api_unsupported (§4.4): "half-loaded, some calls failing" is the ` +
          "failure mode this refusal prevents",
      });
      return {
        verdict: "incompatible",
        lines,
        format,
        kind: manifest.kind,
        manifest,
        skill: undefined,
      };
    }
    const minParsed = min ?? { major: host.major, minor: 0 };
    if (minParsed.minor > host.minor && minParsed.major === host.major) {
      lines.push({
        id: "host-api",
        severity: "warning",
        message:
          `the bundle asks for host API >= ${manifest.hostApi.min}; this build serves ${host.major}.${host.minor}` +
          " — additive-minor policy says it loads, and the gap is named rather than hidden",
      });
    }

    // Platform fit: absence means "unstated", never "all" (§4.2) — so an unstated platform is no constraint at all,
    // and a stated list that omits this host is the author's own boundary, which the checker respects.
    if (manifest.platforms !== undefined && !manifest.platforms.includes(input.host.platform)) {
      lines.push({
        id: "platform",
        severity: "error",
        message:
          `the bundle states platforms [${manifest.platforms.join(", ")}] and this host is ` +
          `'${input.host.platform}' — the list is the author's boundary, not a warning to override`,
      });
      return {
        verdict: "incompatible",
        lines,
        format,
        kind: manifest.kind,
        manifest,
        skill: undefined,
      };
    }

    // The static scan rides native packages too (§11 rule 5's "same §6 step 6 scan").
    const scan = scanContent(manifest.description, "");
    if (scan.unsafe) {
      for (const line of scan.lines) {
        lines.push({
          id: `scan.${line.pattern}`,
          severity: "error",
          message:
            `the ${line.where} matches the '${line.pattern}' pattern: ${line.reason} — §6.1 rejects ` +
            "`unsafe` outright, with no install-anywhere path in this release",
        });
      }
      return { verdict: "unsafe", lines, format, kind: manifest.kind, manifest, skill: undefined };
    }

    // A native content kind with no capabilities is exactly what this build supports; anything requesting
    // capabilities is a trust decision the executable path would answer, and there is no executable path yet.
    const capabilities = manifest.capabilities ?? [];
    if (capabilities.length > 0) {
      lines.push({
        id: "capabilities",
        severity: "warning",
        message:
          `the manifest requests [${capabilities.join(", ")}]; this build loads content only, and a ` +
          "capability grant is an executable-kind question (§7) — recorded in the report, granted to nothing",
      });
    }
    lines.push({
      id: "verdict",
      severity: "info",
      message:
        `native ${manifest.kind} '${manifest.id}' checks out against host ` +
        `${host.major}.${host.minor} on ${input.host.platform}`,
    });
    return {
      verdict: "compatible",
      lines,
      format,
      kind: manifest.kind,
      manifest,
      skill: undefined,
    };
  }

  // skill-md: one skill per folder (direct or one level down); several are several checks.
  const entries = readdirSync(input.path);
  const skillDir = entries.includes(SKILL_FILE) ? input.path : undefined;
  const nested =
    skillDir !== undefined
      ? []
      : entries.filter(
          (entry) => !entry.startsWith(".") && existsSync(join(input.path, entry, SKILL_FILE)),
        );
  const folders =
    skillDir !== undefined ? [input.path] : nested.map((entry) => join(input.path, entry));
  const folderNameOf = (dir: string): string => dir.split(/[\\/]/).filter(Boolean).pop() ?? dir;

  let unsafe = false;
  let incompatible = false;
  let activationBlocked = false;
  let first: CheckResult["skill"];
  const kind: ExtensionKind = "skill";

  for (const dir of folders) {
    const text = readFileSync(join(dir, SKILL_FILE), "utf8");
    const parsed = parseSkill(text, folderNameOf(dir));
    if (!parsed.ok) {
      incompatible = true;
      for (const error of parsed.errors) {
        lines.push({ id: `skill.${error.path}`, severity: "error", message: error.message });
      }
      continue;
    }
    const fm = parsed.frontmatter;
    const scan = scanContent(fm.description, parsed.report.body);
    if (scan.unsafe) {
      unsafe = true;
      for (const line of scan.lines) {
        lines.push({
          id: `scan.${line.pattern}`,
          severity: "error",
          message:
            `'${fm.name}'s ${line.where} matches the '${line.pattern}' pattern: ${line.reason} — ` +
            "unsafe content imports nothing (§6.1)",
        });
      }
      continue;
    }
    if (parsed.report.activationBlocked) activationBlocked = true;
    for (const warning of parsed.report.warnings) {
      lines.push({
        id: `skill${warning.path === "(body)" ? ".body" : `.${warning.path}`}`,
        severity: "warning",
        message: warning.message,
      });
    }
    if (parsed.report.unknownFields.length > 0) {
      // "Ignored loudly" (§4.3) is one named line per unknown key — silence is what makes a user believe a
      // `permissions:` line did something.
      lines.push({
        id: "skill.unknown-fields",
        severity: "warning",
        message: `ignored frontmatter (preserved in the report, granted never): ${parsed.report.unknownFields.join(", ")}`,
      });
    }
    if (fm.allowedTools !== undefined && fm.allowedTools.length > 0) {
      lines.push({
        id: "skill.allowed-tools",
        severity: "warning",
        message:
          `'allowed-tools' lists [${fm.allowedTools.join(", ")}] — recorded for the capability diff and ` +
          "flagged for review at install; an approval tier is never skipped because a file asked to be exempt (§4.3)",
      });
    }
    if (first === undefined) {
      first = {
        name: fm.name,
        description: fm.description,
        activationBlocked: parsed.report.activationBlocked,
        allowedTools: fm.allowedTools ?? [],
        unknownFields: parsed.report.unknownFields,
      };
    }
  }

  if (unsafe) return { verdict: "unsafe", lines, format, kind, manifest: undefined, skill: first };
  if (incompatible)
    return { verdict: "incompatible", lines, format, kind, manifest: undefined, skill: first };
  if (activationBlocked) {
    lines.push({
      id: "skill.activation",
      severity: "warning",
      message:
        "the import succeeds; activation will refuse until the body is under the byte cap (§4.3)",
    });
    return { verdict: "partial", lines, format, kind, manifest: undefined, skill: first };
  }
  lines.push({
    id: "verdict",
    severity: "info",
    message:
      `skill${folders.length === 1 ? "" : "s"} check${folders.length === 1 ? "" : "s"} out against host ` +
      `${(input.host.api ?? HOST_API).major}.${(input.host.api ?? HOST_API).minor} on ${input.host.platform}`,
  });
  return { verdict: "compatible", lines, format, kind, manifest: undefined, skill: first };
}

/** §12's `ext validate` semantics in one word: non-zero on any error line. The CLI maps this to exit `2`. */
export function hasErrors(result: CheckResult): boolean {
  return result.lines.some((line) => line.severity === "error");
}

export const CONTENT_ONLY_KINDS: readonly ExtensionKind[] = CONTENT_KINDS;
export const SKILL_EXTENSION = extname(SKILL_FILE);
