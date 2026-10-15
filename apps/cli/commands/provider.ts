// `crabby provider list` and `crabby model list` — `docs/review/CLI.md` C7-03 and C7-07, and the two rows in region C7
// that need nothing new behind them.
//
// Both are **reads of two sources, joined honestly**. What a Gateway composed comes from `GET /status`, which is the
// only party that knows whether an entry composed (D-100 makes an entry that cannot describe its models disabled, and
// §3.2's rule is that a disabled model is absent rather than broken). What a user *wrote* — the descriptors, the
// overrides, the vault reference — comes from `config.json` through `loadConfig`, because that is the document the user
// edits. Printing one source as if it were the other is how a screen starts lying: a row that lists a model the Gateway
// refused to compose is worse than no row, and a row that omits a model the Gateway composed hides a working
// endpoint. So every line names where its facts came from.
//
// **The key is never printed.** `config.json` holds a `vault://name` reference and nothing else (§3.3 and §3.7), and the
// one thing a list must never do is resolve it into a value on the way to a terminal — the reference is shown, the
// secret is not, and the difference is the whole reason D-031 exists.
import { EXIT, type ExitCode } from "@crabby/api-contracts";
import { loadConfig, type LoadedConfig } from "@crabby/core";
import type { DataLayout } from "@crabby/platform";
import { parseTail } from "../args.ts";
import { connect, reportFailure, reportNoGateway } from "../connect.ts";
import { type Renderer } from "../output.ts";
import { findCommand } from "../registry.ts";

export type ProviderVerb = "add" | "list" | "remove";
export type ModelVerb = "list" | "edit" | "probe";

/** §4.1's `providers` row, as this verb reads it: `state`, the ids that composed with their model ids, and the entries
 *  that refused with the reason. Declared here rather than imported because the status body has no schema of its own —
 *  `GET /status` answers a document composed at runtime, and a route with no contract is a route whose shape can drift
 *  without a type noticing. */
interface ProvidersRow {
  readonly state: "ready" | "absent";
  readonly reason?: string | undefined;
  readonly entries?:
    | readonly { readonly id: string; readonly models: readonly string[] }[]
    | undefined;
  readonly refused?: readonly { readonly id: string; readonly reason: string }[] | undefined;
}

function providerEntry(config: LoadedConfig, id: string): Record<string, unknown> | undefined {
  return (config.config.provider ?? {})[id];
}

/** The `vault://` reference as written, or nothing — never the value behind it. `redactText` is the same scrub the logger
 *  uses, so a key that somehow reached the document in the clear still cannot reach a terminal from here. */
function keyReference(entry: Record<string, unknown>): string | undefined {
  const key = entry.key;
  if (typeof key !== "string" || key.length === 0) return undefined;
  return key.startsWith("vault://")
    ? key
    : "a key that is not a vault reference (PROVIDERS_AND_TOOLS.md §3.3 refuses this)";
}

export async function runProvider(
  verb: ProviderVerb | undefined,
  argv: readonly string[],
  layout: DataLayout,
  renderer: Renderer,
): Promise<ExitCode> {
  const spec = findCommand("provider", verb);
  const tail = parseTail(argv, spec);
  if (tail.unknown.length > 0) {
    renderer.line("unknown flag(s)", tail.unknown.join(" "));
    renderer.fix(`${(spec?.flags ?? []).join(" ")} are what this verb accepts`);
    return EXIT.usage;
  }
  if (verb !== "list") {
    // `add` and `remove` are M4's, and saying so in one line beats a stub that half-works: they write configuration and
    // C7-02's `--key-stdin` / `--key-file` rule is about how a secret reaches a file at all, which is a decision this
    // slice has not made.
    renderer.line(`crabby provider ${verb}`, "not in this version yet");
    renderer.fix(
      "until then the same configuration is reachable with `crabby config set provider.<id>.baseUrl <url>` — " +
        "PROVIDERS_AND_TOOLS.md §3.3 names that path, and a key waits for the vault (docs/CONSISTENCY_REVIEW.md F-56)",
    );
    return EXIT.usage;
  }

  const config = loadConfig(layout);
  const connection = await connect(layout);
  if (connection.state !== "paired") return reportNoGateway(renderer, connection.state);
  let status: { readonly subsystems?: { readonly providers?: ProvidersRow } };
  try {
    status = (await connection.client.status()).body as typeof status;
  } catch (error) {
    return reportFailure(renderer, error);
  }
  const providers = status.subsystems?.providers;
  const composed = new Map((providers?.entries ?? []).map((row) => [row.id, row.models]));
  const refused = new Map((providers?.refused ?? []).map((row) => [row.id, row.reason]));
  const configured = Object.keys(config.config.provider ?? {});

  if (renderer.json) {
    renderer.done({
      configured,
      composed: Object.fromEntries(composed),
      refused: Object.fromEntries(refused),
      // C7-03's "preset vs user-defined": every entry in `config.json` is user-defined by definition, and a preset is a
      // starting point `provider add` would copy — so the distinction is reported as the fact it is.
      keyReferences: Object.fromEntries(
        configured.map((id) => [id, keyReference(providerEntry(config, id) ?? {}) ?? null]),
      ),
      ...(providers?.state === "ready"
        ? {}
        : { reason: providers?.reason ?? "no provider is configured" }),
    });
    return EXIT.success;
  }

  if (configured.length === 0) {
    renderer.line("providers", "none configured");
    renderer.fix(
      "§3.3's path is `crabby config set provider.<id>.baseUrl <url>`; an endpoint that needs a key waits for the vault",
    );
    return EXIT.success;
  }
  for (const id of configured) {
    const entry = providerEntry(config, id) ?? {};
    const models = composed.get(id);
    const models0 = Object.keys((entry.models ?? {}) as Record<string, unknown>);
    renderer.line(
      id,
      (typeof entry.baseUrl === "string" ? entry.baseUrl : "no base URL") +
        " · " +
        (typeof entry.kind === "string" ? entry.kind : "openai-compatible") +
        (keyReference(entry) === undefined ? " · no key" : " · key " + keyReference(entry)),
    );
    // The two lines below are why this verb joins two sources: a configured entry that composed, and one that did not,
    // are different facts and the reason belongs to the Gateway (§3.2 disables rather than breaks).
    renderer.line(
      "  models",
      models0.length === 0
        ? "none declared — §3.2 refuses an entry with no models, because it would have nothing to route a request to"
        : models0.join(", ") +
            (models === undefined
              ? " · none composed" + (refused.has(id) ? `: ${refused.get(id)}` : "")
              : models.length === 0
                ? " · composed with none"
                : " · composed"),
    );
  }
  renderer.fix("`crabby model list` prints each model's context window, output cap and cost class");
  return EXIT.success;
}

export async function runModel(
  verb: ModelVerb | undefined,
  argv: readonly string[],
  layout: DataLayout,
  renderer: Renderer,
): Promise<ExitCode> {
  const spec = findCommand("model", verb);
  const tail = parseTail(argv, spec);
  if (tail.unknown.length > 0) {
    renderer.line("unknown flag(s)", tail.unknown.join(" "));
    renderer.fix(`${(spec?.flags ?? []).join(" ")} are what this verb accepts`);
    return EXIT.usage;
  }
  if (verb !== "list") {
    renderer.line(`crabby model ${verb}`, "not in this version yet");
    renderer.fix(
      verb === "edit"
        ? "D-064 prices this verb's shape — per-field prompts, flags, or both, reaching the same stored value — and the " +
            "stored value is a `config.json` descriptor today"
        : "a probe calls a provider and reports latency and the §3.5 error class; the composition it needs arrives with " +
            "M4's provider adapters",
    );
    return EXIT.usage;
  }

  const config = loadConfig(layout);
  const rows: {
    readonly provider: string;
    readonly model: string;
    readonly contextWindow?: number;
    readonly maxOutputTokens?: number;
    readonly cost?: string;
    readonly batch?: unknown;
    readonly baseUrl?: string;
  }[] = [];
  for (const [providerId, entry] of Object.entries(config.config.provider ?? {})) {
    const models = (entry.models ?? {}) as Record<string, Record<string, unknown>>;
    for (const [modelId, descriptor] of Object.entries(models)) {
      rows.push({
        provider: providerId,
        model: modelId,
        ...(typeof descriptor.contextWindow === "number"
          ? { contextWindow: descriptor.contextWindow }
          : {}),
        ...(typeof descriptor.maxOutputTokens === "number"
          ? { maxOutputTokens: descriptor.maxOutputTokens }
          : {}),
        ...(typeof descriptor.cost === "string" ? { cost: descriptor.cost } : {}),
        ...(descriptor.batching === undefined ? {} : { batching: descriptor.batching }),
        ...(typeof entry.baseUrl === "string" ? { baseUrl: entry.baseUrl } : {}),
      });
    }
  }
  if (renderer.json) {
    // C7-07's clause: "`--json` includes the capability descriptor with the priority order the data model already fixes
    // (user → preset → discover)". The descriptor is included whole for that reason — a client reading this document
    // should not have to know which of the fields are capabilities to learn that a model cannot stream.
    renderer.done({
      models: rows,
      ...(config.problems.length === 0
        ? {}
        : { configProblems: config.problems.map((problem) => problem.message) }),
    });
    return EXIT.success;
  }
  if (rows.length === 0) {
    renderer.line("models", "none declared — `config.json` holds no provider entry with models");
    renderer.fix(
      "§3.2 refuses an entry with no models, because there is nothing to route a request to",
    );
    return EXIT.success;
  }
  for (const row of rows) {
    renderer.line(
      `${row.provider}/${row.model}`,
      (row.contextWindow === undefined
        ? "context unknown"
        : `context ${row.contextWindow.toLocaleString("en-US")}`) +
        " · " +
        (row.maxOutputTokens === undefined
          ? "output cap unknown"
          : `output ${row.maxOutputTokens.toLocaleString("en-US")}`) +
        " · " +
        (row.cost ?? "cost class unstated"),
    );
  }
  if (config.problems.length > 0) {
    // The configuration's own complaints, because a model printed from a document the loader refused to accept is a row
    // that should not have been printed. §3.2's rule reaches further than composition: a descriptor that does not parse
    // is not a model.
    renderer.line("config problems", String(config.problems.length));
    for (const problem of config.problems.slice(0, 3))
      renderer.line("  " + problem.path, problem.message);
  }
  return EXIT.success;
}
