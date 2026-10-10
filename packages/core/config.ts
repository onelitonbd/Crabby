// `config.json` — the one file that holds policy (D-060: "`crabby config schema --json` prints the schema, and the
// schema is in `packages/api-contracts`"). Two rules shape this module:
//
//  1. It owns **only** the keys the documents place in the file. `docs/DECISIONS.md` D-074 is explicit that every
//     timeout and concurrency number is "a `limits.*` key in `config.json`, visible through `crabby config get
//     limits`", so `limits` is here; nothing else is, because no other config key is stated anywhere. A key with no
//     documented default stays absent rather than receiving a plausible number, and the port is the clearest case:
//     the documents say the listener binds loopback and that the platform reports the port, and they never name one.
//  2. A file with a bad key is not a reason to refuse to run. `doctor` reports the named problem and the usable part
//     still applies — on a phone, refusing to boot over a typo turns a config error into an outage.
import { readFileSync, writeFileSync } from "node:fs";
import { type Problem, validate } from "@crabby/api-contracts";
import type { DataLayout } from "@crabby/platform";
import { type Static, Type } from "@sinclair/typebox";

export const LimitsConfig = Type.Object(
  {
    // D-074's numbers, in milliseconds, one key per sentence it wrote. Key names are this module's choice — the
    // decision names the namespace (`limits.*`) and the command, not each field.
    providerConnectMs: Type.Optional(Type.Integer({ minimum: 1 })),
    providerFirstTokenMs: Type.Optional(Type.Integer({ minimum: 1 })),
    providerIdleStreamMs: Type.Optional(Type.Integer({ minimum: 1 })),
    providerAbsoluteMs: Type.Optional(Type.Integer({ minimum: 1 })),
    fsTimeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
    netFetchTimeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
    shellRunTimeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
    sqliteBusyTimeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
    extensionAdapterOverheadMs: Type.Optional(Type.Integer({ minimum: 0 })),
    parallelToolSteps: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
    concurrentProviderRequests: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 })),
    queuedTasksBeforeRefusal: Type.Optional(Type.Integer({ minimum: 1 })),
    // D-088 priced the two limits `PROVIDERS_AND_TOOLS.md` §5.2 required and D-074's table did not carry, and D-090
    // priced the safety-critical cancellation wait. All three are rows in §5.2's table, so all three are keys here —
    // a failure message that tells a user to run `crabby config set limits.stepsPerTask` is a claim about this schema,
    // and `additionalProperties: false` is what would make it false.
    stepsPerTask: Type.Optional(Type.Integer({ minimum: 1 })),
    cancellationSettleMs: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);
export type LimitsConfig = Static<typeof LimitsConfig>;

export const ConfigFile = Type.Object(
  {
    limits: Type.Optional(LimitsConfig),
  },
  { additionalProperties: false },
);
export type ConfigFile = Static<typeof ConfigFile>;

/** D-074's defaults, as data. These live in code, not in the file: `config.json` is an *override* of them, which is
 *  why `crabby init` writes an empty object and stays honest about what it did. */
export const LIMITS_DEFAULTS = {
  providerConnectMs: 10_000,
  providerFirstTokenMs: 60_000,
  providerIdleStreamMs: 45_000,
  providerAbsoluteMs: 300_000,
  fsTimeoutMs: 10_000,
  netFetchTimeoutMs: 20_000,
  shellRunTimeoutMs: 120_000,
  sqliteBusyTimeoutMs: 5_000,
  extensionAdapterOverheadMs: 5_000,
  parallelToolSteps: 2,
  concurrentProviderRequests: 4,
  queuedTasksBeforeRefusal: 5,
  stepsPerTask: 25,
  cancellationSettleMs: 5_000,
} as const satisfies LimitsConfig;

export const DEFAULT_CONFIG: ConfigFile = { limits: { ...LIMITS_DEFAULTS } };

export interface LoadedConfig {
  /** Defaults applied. This is what the process runs on. */
  readonly config: ConfigFile;
  /** What the file itself says, with no defaults folded in — the only thing `config set` may write back, because a
   *  `set` that saved the merged object would pin every default into the file and make the next default change
   *  unreachable. */
  readonly file: ConfigFile;
  readonly limits: LimitsConfig;
  readonly problems: readonly Problem[];
  /** `undefined` when the file does not exist yet: `init` has to say "created" versus "already there", and `doctor`
   *  has to say which file it actually looked at. */
  readonly path: string | undefined;
  readonly exists: boolean;
}

export function loadConfig(
  layout: DataLayout,
  read: (path: string) => string = (file) => readFileSync(file, "utf8"),
): LoadedConfig {
  let raw: string;
  try {
    raw = read(layout.configPath);
  } catch (error) {
    if (isNotFound(error)) {
      return {
        config: structuredClone(DEFAULT_CONFIG),
        file: {},
        limits: { ...LIMITS_DEFAULTS },
        problems: [],
        path: undefined,
        exists: false,
      };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      config: structuredClone(DEFAULT_CONFIG),
      file: {},
      limits: { ...LIMITS_DEFAULTS },
      problems: [
        {
          path: "",
          message: `is not valid JSON — fix ${layout.configPath} or delete it to fall back to defaults`,
          kind: "invalid",
        },
      ],
      path: layout.configPath,
      exists: true,
    };
  }

  const result = validate(ConfigFile, parsed);
  const clean = result.ok ? result.value : onlyKnownKeys(parsed);
  return {
    config: mergeConfig(DEFAULT_CONFIG, clean),
    file: clean,
    limits: {
      ...LIMITS_DEFAULTS,
      ...(typeof clean.limits === "object" && clean.limits !== null
        ? (clean.limits as LimitsConfig)
        : {}),
    },
    problems: result.ok ? [] : result.problems,
    path: layout.configPath,
    exists: true,
  };
}

export function mergeConfig(base: ConfigFile, override: ConfigFile): ConfigFile {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = out[key];
    out[key] = isRecord(existing) && isRecord(value) ? { ...existing, ...value } : value;
  }
  return out as ConfigFile;
}

/** The JSON Schema `crabby config schema --json` prints (D-060, closing O-005: TypeBox was chosen precisely because
 *  the schema is an output, not a conversion). */
export function configSchema(): Record<string, unknown> {
  return { $schema: "https://json-schema.org/draft/2020-12/schema", ...ConfigFile };
}

/** `crabby config set limits.fsTimeoutMs 15000` — dotted key, JSON-or-string value, validated before the write so a
 *  typo is refused at the moment it is typed instead of at the next restart. */
export function applyConfigKey(config: ConfigFile, dottedKey: string, value: unknown): ConfigFile {
  const path = dottedKey.split(".");
  const next = structuredClone(config) as Record<string, unknown>;
  let cursor = next;
  for (const segment of path.slice(0, -1)) {
    const child = cursor[segment];
    cursor[segment] = isRecord(child) ? child : {};
    cursor = cursor[segment] as Record<string, unknown>;
  }
  const leaf = path[path.length - 1];
  if (value === undefined) delete cursor[leaf as string];
  else cursor[leaf as string] = value;
  return next as ConfigFile;
}

export function parseConfigValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function writeConfig(
  layout: DataLayout,
  config: ConfigFile, // the file's own contents, never the merged view
  write: (path: string, data: string) => void = (file, data) => writeFileSync(file, data),
): { ok: boolean; message: string } {
  const result = validate(ConfigFile, config);
  if (!result.ok) {
    return {
      ok: false,
      message: result.problems.map((p) => `${p.path || "<root>"} ${p.message}`).join("; "),
    };
  }
  write(layout.configPath, `${JSON.stringify(config, null, 2)}\n`);
  return { ok: true, message: `wrote ${layout.configPath}` };
}

/** When a file has a bad key, the good keys still load (see rule 2 above), so this keeps the valid subset rather
 *  than either the whole object or nothing. */
function onlyKnownKeys(parsed: unknown): ConfigFile {
  if (!isRecord(parsed)) return {};
  const out: Record<string, unknown> = {};
  const known = Object.keys(ConfigFile.properties);
  for (const [key, value] of Object.entries(parsed)) {
    if (known.includes(key)) out[key] = value;
  }
  return out as ConfigFile;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
