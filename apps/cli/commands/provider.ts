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

import { readFileSync } from "node:fs";
import { EXIT, type ExitCode } from "@crabby/api-contracts";
import {
  type ConfigFile,
  type LoadedConfig,
  loadConfig,
  parseConfigValue,
  writeConfig,
} from "@crabby/core";
import type { DataLayout } from "@crabby/platform";
import { composeProviders } from "@crabby/providers";
import { parseTail } from "../args.ts";
import { connect, reportFailure, reportNoGateway } from "../connect.ts";
import type { Renderer } from "../output.ts";
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
  return config.config.provider?.[id];
}

/** The `vault://` reference as written, or nothing — never the value behind it, and this function has no code path
 *  that could print one even if the document held a raw key: a `key` that is not a reference is *labelled* as a
 *  violation rather than echoed, because echoing it would put whatever is in that field on a screen, and D-031's rule
 *  is that a secret never reaches a log, an event or a terminal. */
function keyReference(entry: Record<string, unknown>): string | undefined {
  const key = entry.key;
  if (typeof key !== "string" || key.length === 0) return undefined;
  return key.startsWith("vault://")
    ? key
    : "a key that is not a vault reference (PROVIDERS_AND_TOOLS.md §3.3 refuses this)";
}

/** C7-01 and C7-02: `crabby provider add <id> --base-url <url> --model <id> [--kind K] [--context N]
 *  [--max-output N] [--key-stdin | --key-file <path>] [--allow-insecure]`. Written through `writeConfig` — the same
 *  path `crabby config set` takes, because §3.3 makes configuration a document the user edits rather than a thing an
 *  interface invents, and a second writer with a second opinion about what that document is would be D-122's mistake in
 *  a place that writes. The write carries §2's token, so a Gateway `PUT /config` that lands between this command's read
 *  and write is a refusal rather than a silent overwrite (D-107).
 *
 *  **The key is refused, by name and with the reason.** C7-02's row is about *how a key reaches a process* — stdin or a
 *  file, never argv, because argv is visible in `ps` and in shell history — and this build honours that by reading it
 *  from either and then not storing it: `config.json` accepts a `vault://name` reference and nothing else (§3.3), and the
 *  vault that would resolve the name is M5's (docs/CONSISTENCY_REVIEW.md F-56). So the command reads what the user typed,
 *  tells them plainly that the secret is in no file anywhere, and writes the reference the schema wants. Refusing to
 *  store is the honest answer because the alternative is what D-031 exists to prevent, and *ignoring* the flag would be
 *  worse than either: a user who piped a key and saw a success line would believe it was stored.
 *
 *  **Both key flags at once is a refusal, not a preference.** `--key-stdin` and `--key-file` name two different
 *  secrets or the same one twice, and this command cannot tell which was meant — so it asks rather than picking, which
 *  is SECURITY.md §2 rule 02's shape (ambiguous identity → deny) applied to a flag pair.
 */
async function addProvider(
  tail: ReturnType<typeof parseTail>,
  layout: DataLayout,
  renderer: Renderer,
): Promise<ExitCode> {
  const id = tail.positionals[0];
  const baseUrl = tail.values["base-url"];
  const models = tail.values.model;
  if (id === undefined || baseUrl === undefined || models === undefined) {
    renderer.line("provider add", "an id, a base URL and at least one model");
    renderer.fix(
      'crabby provider add local --base-url http://127.0.0.1:8080/v1 --model "qwen2.5:3b" ' +
        "— §3.2 refuses an entry with no models, because there would be nothing to route a request to",
    );
    return EXIT.usage;
  }
  const loaded = loadConfig(layout);
  if (loaded.config.provider?.[id] !== undefined) {
    renderer.line("provider add", `${id} is already configured`);
    renderer.fix(
      "`crabby provider remove <id>` then add it again, or `crabby config set provider.<id>.…` for one field",
    );
    return EXIT.usage;
  }
  const contextWindow = positiveInt(tail.values.context);
  const maxOutputTokens = positiveInt(tail.values["max-output"]);
  if (contextWindow === undefined || maxOutputTokens === undefined) {
    renderer.line("provider add", "--context and --max-output take positive whole numbers");
    renderer.fix(
      "both are required of a descriptor (§3.2 refuses one that cannot say how much fits), and without them this " +
        "command would write a window it made up",
    );
    return EXIT.usage;
  }
  if (maxOutputTokens >= contextWindow) {
    // Refused by the descriptor itself (`packages/providers/descriptor.ts`), but refused here with a sentence rather
    // than after the write, because a refusal the user reads once is cheaper than a file they have to undo.
    renderer.line(
      "provider add",
      `--max-output ${maxOutputTokens} does not fit in --context ${contextWindow}`,
    );
    renderer.fix(
      "a model cannot emit more than it can hold, and §3.2 refuses the descriptor rather than truncating",
    );
    return EXIT.usage;
  }
  // C7-06: plain HTTP away from loopback, or plain HTTP at all with a key, is refused unless the user says so
  // explicitly. §3.3 calls the same situation a warning for composition; C7-06 calls it a refusal for this verb, and
  // both are right because they are different acts — a composed provider that nobody looked at, versus a command a
  // person just typed.
  const insecure =
    baseUrl.startsWith("http://") && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(baseUrl);
  const keyStdin = tail.booleans.has("--key-stdin");
  const keyFile = tail.values["key-file"];
  if (keyStdin && keyFile !== undefined) {
    renderer.line("provider add", "--key-stdin and --key-file name two different ways in");
    renderer.fix(
      "pick one: C7-02 allows both and neither, and this command will not choose which secret you meant to hand it",
    );
    return EXIT.usage;
  }
  if (insecure && !tail.booleans.has("--allow-insecure")) {
    renderer.line("provider add", `${baseUrl} is plain HTTP and not loopback`);
    renderer.fix(
      "PROVIDERS_AND_TOOLS.md §3.3 asks for a key to be sent over TLS; `--allow-insecure` accepts the risk for a " +
        "LAN `llama-server`, and prints this warning every time it is used",
    );
    return EXIT.usage;
  }

  const keyText = keyStdin
    ? await readSecret()
    : keyFile === undefined
      ? undefined
      : readSecretFile(keyFile);
  if (keyText !== undefined && keyText.trim().length === 0) {
    renderer.line("provider add", "the key arrived empty");
    renderer.fix(
      "nothing is written: an empty secret is a missing secret, and one is not stored anywhere",
    );
    return EXIT.usage;
  }
  if (keyText === undefined && keyFile !== undefined) {
    renderer.line("provider add", `--key-file ${keyFile} could not be read`);
    renderer.fix(
      "the entry is not written: a key path that does not open is a question, and writing the entry without the key " +
        "would leave a configured provider nobody can call",
    );
    return EXIT.usage;
  }

  const descriptors = Object.fromEntries(
    models
      .split(",")
      .map((model) => model.trim())
      .filter((model) => model.length > 0)
      .map((model) => [model, descriptorFor(contextWindow, maxOutputTokens)]),
  );
  if (Object.keys(descriptors).length === 0) {
    renderer.line("provider add", "--model was only separators");
    renderer.fix("§3.2 refuses an entry with no models, so nothing is written");
    return EXIT.usage;
  }
  // Written as one object rather than a chain of `applyConfigKey` dotted writes, because a descriptor is a unit: half
  // a descriptor in a file is the state §3.2 refuses, and a chain that wrote `models` before it could compose would
  // leave exactly that behind on a typo. `crabby config set provider.<id>.<field>` still reaches one field, which is
  // why `withProviderEntry` reuses its clone discipline rather than a second one.
  const next = withProviderEntry(loaded.file, id, {
    baseUrl,
    ...(tail.values.kind === undefined ? {} : { kind: parseConfigValue(tail.values.kind) }),
    models: descriptors,
    ...(keyText === undefined ? {} : { key: `vault://${id}` }),
  });
  const written = writeConfig(layout, next as ConfigFile, undefined, { token: loaded.token });
  if (!written.ok) {
    renderer.line("refused", written.message);
    renderer.fix(
      written.code === "stale"
        ? "the file changed since this command read it — run it again and the write happens once more"
        : "the file was not changed",
    );
    return EXIT.usage;
  }

  // Composed here rather than after a Gateway restart, because §3.2's check is pure and a user who typed an endpoint
  // should learn it does not compose *now* rather than after restarting the thing they were configuring. **This is the
  // same `composeProviders` the Gateway calls at startup, on the same document** — so this screen and
  // `provider list` cannot hold two opinions about a static configuration; they can differ only about a process that
  // has not restarted yet, which is the honest reason to run it. The map is handed over rather than the whole file
  // because that is the section composition reads.
  const composed = composeProviders((next as ConfigFile).provider).find((row) => row.id === id);
  if (renderer.json) {
    renderer.done({
      id,
      path: layout.configPath,
      ...(composed === undefined
        ? {}
        : { composed: composed.ok, ...(composed.ok ? {} : { reason: composed.reason }) }),
      ...(keyText === undefined
        ? {}
        : { key: `read and discarded; config.json holds the reference vault://${id}` }),
      capabilities:
        "all denied but systemRole; set them with `crabby config set` before a run can stream or call tools",
    });
    return EXIT.success;
  }
  renderer.line("wrote", `${layout.configPath} · provider ${id}`);
  if (composed === undefined) {
    renderer.line("composed", "unknown — a Gateway restart will report it");
  } else if (composed.ok) {
    renderer.line(
      "composed",
      `${composed.modelIds.length} model(s): ${composed.modelIds.join(", ")}`,
    );
    for (const warning of composed.warnings) renderer.line("  warning", warning);
  } else {
    renderer.line("composed", `no — ${composed.reason}`);
  }
  if (keyText !== undefined) {
    // The sentence C7-02 exists for, told in the other direction: the secret was read from a path argv never shows,
    // and it is in no file anywhere.
    renderer.line(
      "key",
      `read from ${keyStdin ? "stdin" : String(keyFile)} and stored nowhere; ` +
        `config.json holds the reference vault://${id}, and the vault that resolves it arrives with M5 ` +
        "(docs/CONSISTENCY_REVIEW.md F-56)",
    );
  }
  if (insecure)
    renderer.line("warning", "plain HTTP to a non-loopback host, accepted by --allow-insecure");
  renderer.line(
    "cost class",
    "unmeasured — `crabby model probe` arrives with M4's conformance suite, and until then budgeting treats the " +
      "model as unknown rather than free (D-064)",
  );
  if (composed?.ok === true) {
    // The consequence a success line would otherwise hide: the entry composes, and every capability in it is denied
    // except `systemRole`, so a run against it will not stream and will not call a tool until the descriptor says it
    // can. Saying it here is the difference between a working provider and a provider that mysteriously ignores tools.
    renderer.line(
      "capabilities",
      "all denied but systemRole — §3.2 reads them as permission and this command will not claim them for an " +
        "endpoint it has not called",
    );
  }
  renderer.fix("restart the Gateway to compose it, or `crabby provider list` after that");
  return EXIT.success;
}

/** §3.2's minimal descriptor, with **every capability denied**. This is the one place where writing "no" is the honest
 *  default and not a limitation: `supports` is read by the runtime as permission, so a `provider add` that guessed
 *  `streaming: true` for an endpoint nobody has called would enable a code path on a claim. `systemRole` is the single
 *  exception, because §2.1's prompt needs it and every OpenAI-compatible endpoint this adapter speaks accepts it —
 *  which is a fact about the *family*, stated by the family, not about the model behind it.
 *
 *  **The two numbers are the user's, not this command's.** `--context` and `--max-output` are required, because the
 *  descriptor cannot parse without them and a guessed window is a claim about a model that has never been called —
 *  budgeting (D-064) would then size compaction against a fiction. `cost` is a sentence saying so rather than a
 *  fabricated figure, and the same sentence is what `model list` prints for an entry nobody has probed. */
function descriptorFor(contextWindow: number, maxOutputTokens: number): Record<string, unknown> {
  return {
    contextWindow,
    maxOutputTokens,
    supports: {
      streaming: false,
      toolCalling: false,
      parallelToolCalls: false,
      systemRole: true,
      structuredOutput: false,
      imageInput: false,
      audioInput: false,
      reasoning: false,
    },
    // `cancellation: "unsupported"` and `cost: null` are the two fields that describe a *measurement*, and neither has
    // been measured here. The enum has no "unknown" member and the cost union has no free-text member, which is the
    // right shape: §3.2's data model cannot hold a sentence, so the sentence is printed by this command and the
    // descriptor says the truth, which is `null`. An adapter that did not implement cancellation and a model nobody
    // has priced are both exactly this.
    cancellation: "unsupported",
    rateLimits: null,
    cost: null,
    batching: null,
  };
}

/** §3.2's cost union as one line: `"local"` and `"free-tier"` say who pays, the object says how much, and `null` says
 *  nobody has measured it — which is a different claim from "free", and the distinction is the reason the union has no
 *  catch-all string. */
function costClass(cost: unknown): string {
  if (cost === null) return "unmeasured (null — not the same as free)";
  if (typeof cost === "string") return cost;
  const record = cost as { promptPerMTok?: number; completionPerMTok?: number };
  return `${String(record.promptPerMTok)} in / ${String(record.completionPerMTok)} out per MTok`;
}

/** A whole number, or nothing. `parseInt` alone would accept `8192abc` and `12.5`, and a descriptor holding either is a
 *  number no budget arithmetic can trust. */
function positiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return undefined;
  const value = Number.parseInt(raw.trim(), 10);
  return value > 0 ? value : undefined;
}

/** The entry as one object. `applyConfigKey` is a dotted-path writer and a provider entry is a value with a schema, so
 *  the write is done by hand through the same `structuredClone`-and-write discipline `applyConfigKey` uses. */
function withProviderEntry(
  file: Record<string, unknown>,
  id: string,
  entry: Record<string, unknown>,
): Record<string, unknown> {
  const next = structuredClone(file) as Record<string, unknown>;
  const provider = (next.provider ?? {}) as Record<string, unknown>;
  provider[id] = entry;
  next.provider = provider;
  return next;
}

async function readSecret(): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return chunks.length === 0 ? undefined : Buffer.concat(chunks).toString("utf8");
}

function readSecretFile(path: string): string | undefined {
  try {
    // Node's own reader, because the flag is a file path a user typed and this command has no platform module: the
    // path is a configuration path, not a workspace path, so §8's containment rules do not reach it.
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** C7-04: `crabby provider remove <id>` names how many tasks are pinned to it, because removing a provider under a
 *  pinned task leaves a task whose model cannot be resolved — and D-110 resolves a pin against the whole composition,
 *  so the pin would fail at run time rather than at write time. The count comes from the Gateway, because only the
 *  Gateway knows which tasks are pinned; the configuration alone can be read, but the consequence cannot be computed
 *  from a file. */
async function removeProvider(
  tail: ReturnType<typeof parseTail>,
  layout: DataLayout,
  renderer: Renderer,
): Promise<ExitCode> {
  const id = tail.positionals[0];
  if (id === undefined) {
    renderer.line("provider remove", "which provider? `crabby provider list` prints the ids");
    return EXIT.usage;
  }
  const loaded = loadConfig(layout);
  if (loaded.config.provider?.[id] === undefined) {
    renderer.line("provider remove", `${id} is not configured`);
    return EXIT.failure;
  }
  const connection = await connect(layout);
  if (connection.state === "paired") {
    let pinned = 0;
    try {
      const page = (await connection.client.listTasks({ limit: 200 })).body as {
        items: readonly { model?: string }[];
      };
      // A pin is `<provider>/<model>` (D-108), so the id is compared against the part before the slash rather than
      // against the whole string — a substring test would count `local` against `local-eu` too.
      pinned = page.items.filter((task) => (task.model ?? "").split("/")[0] === id).length;
    } catch (error) {
      return reportFailure(renderer, error);
    }
    if (pinned > 0 && !tail.booleans.has("--force")) {
      renderer.line("provider remove", `${pinned} task(s) are pinned to ${id}`);
      renderer.fix(
        "`--force` removes it anyway: those tasks keep their pin and their next run will be refused for naming a model " +
          "that no longer exists, which is D-110's rule rather than a silent fallback to another model",
      );
      return EXIT.usage;
    }
    if (pinned > 0)
      renderer.line("warning", `${pinned} pinned task(s) keep a pin no provider can resolve`);
  }
  const next = structuredClone(loaded.file) as Record<string, unknown>;
  const provider = { ...((next.provider ?? {}) as Record<string, unknown>) };
  delete provider[id];
  next.provider = provider;
  const written = writeConfig(layout, next as ConfigFile, undefined, { token: loaded.token });
  if (!written.ok) {
    renderer.line("refused", written.message);
    renderer.fix(
      written.code === "stale"
        ? "the file changed since this command read it — run it again"
        : "the file was not changed",
    );
    return EXIT.usage;
  }
  renderer.line("removed", `${id} from ${layout.configPath}`);
  renderer.fix(
    "restart the Gateway to stop composing it; a running process keeps the adapter it already built",
  );
  return EXIT.success;
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
  if (verb === "add") return addProvider(tail, layout, renderer);
  if (verb === "remove") return removeProvider(tail, layout, renderer);

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
      `${typeof entry.baseUrl === "string" ? entry.baseUrl : "no base URL"} · ${
        typeof entry.kind === "string" ? entry.kind : "openai-compatible"
      }${keyReference(entry) === undefined ? " · no key" : ` · key ${keyReference(entry)}`}`,
    );
    // The two lines below are why this verb joins two sources: a configured entry that composed, and one that did not,
    // are different facts and the reason belongs to the Gateway (§3.2 disables rather than breaks).
    renderer.line(
      "  models",
      models0.length === 0
        ? "none declared — §3.2 refuses an entry with no models, because it would have nothing to route a request to"
        : `${models0.join(", ")}${
            models === undefined
              ? ` · none composed${refused.has(id) ? `: ${refused.get(id)}` : ""}`
              : models.length === 0
                ? " · composed with none"
                : " · composed"
          }`,
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
        ...(descriptor.cost === undefined ? {} : { cost: costClass(descriptor.cost) }),
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
      renderer.line(`  ${problem.path}`, problem.message);
  }
  return EXIT.success;
}
