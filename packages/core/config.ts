// `config.json` — the one file that holds policy (D-060: "`crabby config schema --json` prints the schema, and the
// schema is in `packages/api-contracts`"). Two rules shape this module:
//
//  1. It owns **only** the keys the documents place in the file. `docs/DECISIONS.md` D-074 is explicit that every
//     timeout and concurrency number is "a `limits.*` key in `config.json`, visible through `crabby config get
//     limits`", so `limits` is here, and the four namespaces beside it are here because a document placed them in this
//     file too: `provider.<id>` and `defaultModel` (§3.7 and §3.6, D-101), `workspace.roots` (§8's containment, D-101)
//     and `net.allowList` (§6.1's `net.egress:<hostset>` and §4.2's "user-curated allow-list", D-106). Nothing else is,
//     because no other config key is stated anywhere. A key with no documented default stays absent rather than
//     receiving a plausible number, and the port is the clearest case: the documents say the listener binds loopback
//     and that the platform reports the port, and they never name one.
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
    // D-043's "at least 5 attempts per failing stage (configurable)": the floor is in the schema, so the configurable
    // half of that sentence cannot be used to configure the ladder out of existence. The default is `MAX_ATTEMPTS` from
    // `packages/providers`' schedule (6 = one attempt plus the five delays D-064 priced), and a test asserts the two
    // agree rather than letting this file remember the number.
    providerAttempts: Type.Optional(Type.Integer({ minimum: 5, maximum: 32 })),
  },
  { additionalProperties: false },
);
export type LimitsConfig = Static<typeof LimitsConfig>;

/** One provider entry in `config.json`, in the namespace §3.7 spells out (`provider.groq.key = vault://groq`) and with
 *  the fields §3.3 requires of a custom endpoint: "name, base URL, model name(s); key supplied by reference to the
 *  vault (§3.7), never inline in a conversation or an ordinary config file".
 *
 *  The division of labour with `packages/providers/compose.ts` is one sentence: **the schema refuses what must never be
 *  written down, and composition refuses what cannot work.** A key on disk is the first kind, so its shape is a pattern
 *  here; a missing base URL is the second, so it is a reason there — and an entry a user is still building has to be
 *  writable one field at a time, which a schema demanding the whole entry would forbid.
 *
 *  Two of §3.3's sentences are schema rather than advice, and both are refusals:
 *
 *  - `key` must be a `vault://` reference. §3.3's "never inline … in an ordinary config file" is the reason the pattern
 *    is in the schema instead of in a comment: a key typed into `config.json` is a key in a file mode `0644`
 *    (`docs/DATA_AND_MEMORY.md` §4.1), in every backup of it, and one `crabby config get provider` away from a
 *    terminal. Refusing the shape is the control; `packages/core/redact.ts` is defence in depth behind it.
 *  - `models` must not be empty. §3.2's descriptors are what make a capability question answerable, and D-100 made the
 *    list static and user-supplied because this build cannot ask a live API for one — so an entry with no models has
 *    nothing to route a request to and nothing to answer `supports` from.
 *
 *  The descriptor values themselves are `Unknown` here on purpose. §3.2's rules are implemented once, in
 *  `packages/providers`' `parseDescriptor`, and `packages/core` may not import `@crabby/providers`
 *  (`ARCHITECTURE.md` §19 keeps the dependency one way), so this schema checks that a descriptor is *present* per model
 *  and composition checks that it *parses*. A second copy of §3.2's rules here would be the drift rule 1 exists to
 *  prevent. */
export const ProviderEntryConfig = Type.Object(
  {
    /** §3.3's "name". Optional because the key it hangs off (`provider.groq`) is already a name, and a preset's whole
     *  purpose is "to pre-fill a display name" — a second one the user has to keep in sync is a second source. */
    name: Type.Optional(Type.String({ minLength: 1 })),
    /** §3.3's family, which D-100 made the adapter's unit ("implement families, not N vendors"). Optional and defaulting
     *  to `openai-compatible` because that is the only family with an adapter here, and the enum names the other three so
     *  that composition can refuse one with a reason instead of letting a user point this adapter at a wire protocol it
     *  does not speak and read the failure as a broken endpoint. `mock` is §3.3's preset and `SECURITY.md` §17's test
     *  instrument; it is in the enum for the same reason and refused at composition for that one. */
    kind: Type.Optional(
      Type.Union([
        Type.Literal("openai-compatible"),
        Type.Literal("ollama"),
        Type.Literal("anthropic"),
        Type.Literal("gemini"),
        Type.Literal("mock"),
      ]),
    ),
    /** §3.3's "base URL", required of a *working* entry and optional in the file, for the reason every `limits.*` key
     *  is optional: `crabby config set provider.local.baseUrl …` has to be able to write one field of an entry, and a
     *  schema that demanded the whole entry at the keystroke would make §3.7's own spelling (`provider.groq.key =
     *  vault://groq`) unwritable and answer with a pile of problems about fields the user has not typed yet. What an
     *  incomplete entry means is composition's answer, not the writer's. */
    baseUrl: Type.Optional(Type.String({ minLength: 1 })),
    /** §3.7's reference. Accepted as a shape and refused at composition until a vault exists to resolve it (F-56). */
    key: Type.Optional(Type.String({ pattern: "^vault://[A-Za-z0-9._-]+$" })),
    /** §3.3's "model name(s)", keyed by model id, each carrying the §3.2 descriptor D-100 made the user's to supply.
     *  Optional for `baseUrl`'s reason; `minProperties` stays, because an explicitly empty list is not an entry under
     *  construction but a claim that a provider has no models, and §3.2 has nothing to route a request to. */
    models: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { minProperties: 1 })),
    /** §3.3's custom-provider requirement that an endpoint declares "whether it is treated as local". Absent means the
     *  base URL decides, which is what `packages/providers`' loopback test already does. */
    local: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type ProviderEntryConfig = Static<typeof ProviderEntryConfig>;

/** `SECURITY.md` §8's containment, as configuration: "Tool-declared paths must resolve within one or more **configured
 *  workspace roots**", and "the home directory is not a workspace". §4.2's `config.set` row names roots as one of the
 *  things that key may change, so the namespace is documented even though the field names are this module's choice.
 *  An absent or empty list is not an error and gets no default here: `loadConfig` runs on a machine whose home this
 *  module must not guess at, and a root invented by a default would be a path the agent may write to that the user
 *  never chose. `crabby init` creates one (`docs/UI_UX_SPEC.md` §5 step 3) and *records what it created*, which is a
 *  fact about this install rather than a default. */
export const WorkspaceConfig = Type.Object(
  {
    roots: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  },
  { additionalProperties: false },
);
export type WorkspaceConfig = Static<typeof WorkspaceConfig>;

/** `SECURITY.md` §6.1's `net.egress:<hostset>` and `PROVIDERS_AND_TOOLS.md` §4.2's "**T1** only for a user-curated
 *  allow-list", as configuration — the host set the capability's parameter names and the list the tier is computed
 *  from. Until this key existed both sentences described something with nowhere to live: `grantsFor` withheld every
 *  `net.egress` grant "because nothing in `config.json` supplies a host set" (F-52's amendment), and
 *  `EvalContext.egressAllowList` was a field no composition ever filled, so §4.3's escalation by destination had no
 *  allow-list to escalate *from* and every host arrived at the same price.
 *
 *  Three rules, each a sentence somewhere rather than a preference:
 *
 *  1. **Hosts, not URLs.** §4.3 escalates "by destination" and §6.3's approval row carries the destination *host* in
 *     its `exact` field, so the unit a user curates is a host. A `https://` prefix in an entry would be a URL compared
 *     against a hostname, which never matches and reads as a grant that is held.
 *  2. **Absent and empty are the same state, and it is not an error.** A host invented by a default would be a
 *     destination the agent may reach that the user never chose — the same reason `workspace.roots` gets no default.
 *     What an empty list means is stated rather than implied: not "no egress", but "no host is curated", so §4.3's
 *     other half applies to all of them and every destination is T2 with the host named in the prompt. Turning egress
 *     off is `crabby auth pair --restrict net.egress` (§13), which removes the capability instead of pricing it.
 *  3. **The list lowers a price and grants nothing by itself.** `grantsFor` mints one `net.egress` grant naming the
 *     curated set, and this list decides whether a destination is T1 or T2 (D-106). A host appearing here is therefore
 *     not a host the agent may reach without the user's knowledge — it is a host the user pre-approved at T1, which is
 *     §4.2's own cell. */
export const NetConfig = Type.Object(
  {
    allowList: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  },
  { additionalProperties: false },
);
export type NetConfig = Static<typeof NetConfig>;

/** The curated host set, normalized in one place instead of at each of the two that read it (D-106): the composition
 *  root hands it to `EvalContext.egressAllowList`, where §4.3's escalation compares it against a destination, and to
 *  the grant expansion, where §6.1's parameter names it. Lowercased because `packages/policy`'s `safeHost` lowercases
 *  the hostname it reads out of a URL before comparing, so a curated `Example.COM` would never match and the user would
 *  be asked to approve at T2 a host they had already pre-approved at T1 — one spelling, chosen where the entries are
 *  read rather than where they are typed. Trimmed and de-duplicated because this array is written by hand into a JSON
 *  file, and a repeated entry would print a repeated reason. An empty result is a state with a meaning, not an error:
 *  no host is curated, so every destination is a new one and §4.3 prices it T2 with the host named in the prompt. */
export function egressHosts(config: ConfigFile): readonly string[] {
  const hosts: string[] = [];
  for (const entry of config.net?.allowList ?? []) {
    const host = entry.trim().toLowerCase();
    if (host.length > 0 && !hosts.includes(host)) hosts.push(host);
  }
  return hosts;
}

export const ConfigFile = Type.Object(
  {
    limits: Type.Optional(LimitsConfig),
    /** §3.7's namespace, one entry per provider. Absent means no provider is configured, which is a state the Gateway
     *  reports rather than papers over: a run needs an adapter, and an adapter nobody selected is not a default. */
    provider: Type.Optional(Type.Record(Type.String(), ProviderEntryConfig)),
    /** §3.6's "The user selects a default model and may pin a model per task or per interface session; per-task pinning
     *  wins." Spelled `<provider>/<modelId>`, which is the spelling `docs/INTERFACES_AND_API.md` §7.1's `/model
     *  <provider/model>` command already uses, so the config value and the command argument are the same string. */
    defaultModel: Type.Optional(Type.String({ minLength: 3 })),
    workspace: Type.Optional(WorkspaceConfig),
    /** §6.1's host set (D-106). Absent means no host is curated, which leaves every destination at §4.2's base tier. */
    net: Type.Optional(NetConfig),
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
  providerAttempts: 6,
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
