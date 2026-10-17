// The native `crabby.extension.json`, parsed the way §4.2 demands: strict, because a typo that silently dropped a
// declared capability would be a permission lying about itself.
//
// The asymmetry with `skill.ts` is the deliberate one the spec draws: **native manifests reject unknown fields;
// imported skills record and preserve them** — a manifest is *our* format, written by an author who read §4.2, so an
// unrecognized key is a mistake and refusing it is the review; an upstream `SKILL.md` is *their* format, dated after
// this release by definition, so refusing it for carrying a field we never saw is how an import path becomes useless.
//
// Size and depth limits are the parser's own hygiene (§4.2: "the manifest parser must enforce size and depth limits
// to avoid pathological input"): a manifest over 64 KiB is refused before parsing, and the parsed tree is walked to a
// bounded depth so a hostile file cannot turn validation into a memory question.
import { readFileSync } from "node:fs";

/** The one host-API major this build ships (§4.4: "v1 ships exactly one major"). Skills without a manifest take the
 *  current pair implicitly; converted skills record the resolved pair in their report (D-039). */
export const HOST_API = { major: 1, minor: 0 } as const;

export const EXTENSION_KINDS = [
  "skill",
  "command",
  "mcp",
  "theme",
  "tool",
  "provider",
  "hook",
  "interface",
] as const;
export type ExtensionKind = (typeof EXTENSION_KINDS)[number];

/** The kinds that execute (§3's rows 4–7). Blocked until O-008 passes a hostile-extension test (D-038) — refused with
 *  the reason, never half-installed. */
export const EXECUTABLE_KINDS: readonly ExtensionKind[] = ["tool", "provider", "hook", "interface"];

/** The kinds this build's first release supports, all inert (§3's confirmed scope). */
export const CONTENT_KINDS: readonly ExtensionKind[] = ["skill", "command", "mcp", "theme"];

export const MANIFEST_FILE = "crabby.extension.json";
export const MANIFEST_MAX_BYTES = 64 * 1024;
const MAX_DEPTH = 8;

export interface ExtensionManifest {
  readonly manifestVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly kind: ExtensionKind;
  readonly hostApi: { readonly min: string; readonly max: string };
  readonly license: string;
  readonly capabilities?: readonly string[];
  readonly entrypoint?: { readonly module: string; readonly symbol: string };
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly platforms?: readonly string[];
  readonly resources?: Readonly<Record<string, unknown>>;
  readonly riskHint?: string;
  readonly integrity?: string;
  readonly compatibility?: Readonly<Record<string, unknown>>;
}

export interface ParseProblem {
  readonly path: string;
  readonly message: string;
}

export type ManifestParseResult =
  | { readonly ok: true; readonly manifest: ExtensionManifest }
  | { readonly ok: false; readonly problems: readonly ParseProblem[] };

const ID_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const API_PAIR_PATTERN = /^\d+\.\d+$/;
const SPDXISH_PATTERN = /^[A-Za-z0-9.+-]+$/;

/** The field list, as data, because the error for an unknown field must name it and the error for a missing one must
 *  not have to be inferred from a spread. */
const REQUIRED_FIELDS = [
  "manifestVersion",
  "id",
  "name",
  "description",
  "version",
  "kind",
  "hostApi",
  "license",
] as const;

const OPTIONAL_FIELDS = [
  "capabilities",
  "entrypoint",
  "dependencies",
  "platforms",
  "resources",
  "riskHint",
  "integrity",
  "compatibility",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function depthOf(value: unknown, depth = 0): number {
  if (depth > MAX_DEPTH) return depth;
  if (Array.isArray(value))
    return value.reduce<number>((max, item) => Math.max(max, depthOf(item, depth + 1)), depth);
  if (isRecord(value)) {
    return Object.values(value).reduce<number>(
      (max, item) => Math.max(max, depthOf(item, depth + 1)),
      depth,
    );
  }
  return depth;
}

/** Parse a manifest from a string, with every refusal naming the field it refused. Deterministic: the problems come
 *  back in field order, not in filesystem order, so the same bytes always produce the same answer (§6's reproducibility
 *  rule). */
export function parseManifest(text: string): ManifestParseResult {
  if (Buffer.byteLength(text, "utf8") > MANIFEST_MAX_BYTES) {
    return {
      ok: false,
      problems: [
        {
          path: "(file)",
          message:
            `the manifest is ${Buffer.byteLength(text, "utf8")} bytes; §4.2 caps it at ${MANIFEST_MAX_BYTES}, ` +
            "because a file this size is a payload rather than a description",
        },
      ],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      problems: [
        { path: "(json)", message: `the manifest is not valid JSON: ${(error as Error).message}` },
      ],
    };
  }
  if (!isRecord(parsed)) {
    return {
      ok: false,
      problems: [{ path: "(root)", message: "the manifest must be a JSON object" }],
    };
  }
  if (depthOf(parsed) > MAX_DEPTH) {
    return {
      ok: false,
      problems: [
        {
          path: "(root)",
          message: `the manifest nests deeper than ${MAX_DEPTH} levels (§4.2's depth limit)`,
        },
      ],
    };
  }

  const problems: ParseProblem[] = [];
  const known = new Set<string>([...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]);
  for (const key of Object.keys(parsed)) {
    if (!known.has(key)) {
      problems.push({
        path: key,
        message:
          `'${key}' is not a field of §4.2 — native manifests reject unknown fields rather than ignoring them, ` +
          "because a typo'd capability name would otherwise disable a permission silently",
      });
    }
  }
  for (const field of REQUIRED_FIELDS) {
    if (parsed[field] === undefined) {
      problems.push({ path: field, message: `'${field}' is required by §4.2 and is missing` });
    }
  }
  if (problems.length > 0) return { ok: false, problems };

  if (parsed.manifestVersion !== 1) {
    problems.push({
      path: "manifestVersion",
      message:
        `'${String(parsed.manifestVersion)}' is not a manifest version this build parses; the format is ` +
        "versioned so a future change is explicit rather than inferred",
    });
  }
  if (typeof parsed.id !== "string" || !ID_PATTERN.test(parsed.id)) {
    problems.push({
      path: "id",
      message:
        `'${String(parsed.id)}' is not a stable reverse-DNS identifier (§4.2's example shape: ` +
        "`dev.crabby.skill.report-writing`)",
    });
  }
  for (const field of ["name", "description"] as const) {
    if (typeof parsed[field] !== "string" || (parsed[field] as string).length === 0) {
      problems.push({ path: field, message: `'${field}' must be a non-empty string` });
    }
  }
  if (typeof parsed.version !== "string" || !VERSION_PATTERN.test(parsed.version)) {
    problems.push({
      path: "version",
      message: `'${String(parsed.version)}' is not a semver (major.minor.patch, optional -suffix)`,
    });
  }
  if (
    typeof parsed.kind !== "string" ||
    !(EXTENSION_KINDS as readonly string[]).includes(parsed.kind)
  ) {
    problems.push({
      path: "kind",
      message: `'${String(parsed.kind)}' is not one of §3's kinds: ${EXTENSION_KINDS.join(", ")}`,
    });
  }
  const hostApi = parsed.hostApi;
  if (!isRecord(hostApi) || typeof hostApi.min !== "string" || typeof hostApi.max !== "string") {
    problems.push({
      path: "hostApi",
      message:
        '\'hostApi\' must be `{ min: "major.minor", max: "major.minor" }` — one pair for the whole host ' +
        'surface, because per-capability versions need a resolver and a resolver is where "works on my host" hides (§4.4)',
    });
  } else {
    for (const half of ["min", "max"] as const) {
      const value = hostApi[half];
      if (typeof value !== "string" || !API_PAIR_PATTERN.test(value)) {
        problems.push({
          path: `hostApi.${half}`,
          message: `'${String(value)}' is not a major.minor pair`,
        });
      }
    }
    const min = hostApi.min ?? "";
    const max = hostApi.max ?? "";
    if (API_PAIR_PATTERN.test(min) && API_PAIR_PATTERN.test(max) && min > max) {
      problems.push({ path: "hostApi", message: `the range ${min}…${max} is inverted` });
    }
  }
  if (typeof parsed.license !== "string" || !SPDXISH_PATTERN.test(parsed.license)) {
    problems.push({
      path: "license",
      message: `'${String(parsed.license)}' is not an SPDX identifier or license token (§9's checks read this)`,
    });
  }
  if (parsed.capabilities !== undefined) {
    if (
      !Array.isArray(parsed.capabilities) ||
      parsed.capabilities.some((entry) => typeof entry !== "string")
    ) {
      problems.push({
        path: "capabilities",
        message: "'capabilities' must be an array of §6.1 capability names",
      });
    }
  }
  if (parsed.platforms !== undefined) {
    if (
      !Array.isArray(parsed.platforms) ||
      parsed.platforms.some((entry) => typeof entry !== "string")
    ) {
      problems.push({
        path: "platforms",
        message:
          '\'platforms\' must be an array of platform names — absence means "unstated", never "all"',
      });
    }
  }
  if (parsed.entrypoint !== undefined) {
    const entry = parsed.entrypoint;
    if (!isRecord(entry) || typeof entry.module !== "string" || typeof entry.symbol !== "string") {
      problems.push({
        path: "entrypoint",
        message:
          "'entrypoint' must be `{ module, symbol }` — and an executable kind is blocked in this build (D-038) " +
          "until O-008's isolation gate passes, so a valid entrypoint still installs nothing",
      });
    }
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, manifest: parsed as unknown as ExtensionManifest };
}

/** Read and parse a manifest file. The file error is the caller's to place, so the path is in the problem. */
export function readManifest(path: string): ManifestParseResult {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return {
      ok: false,
      problems: [
        { path: "(file)", message: `the manifest could not be read: ${(error as Error).message}` },
      ],
    };
  }
  return parseManifest(text);
}
