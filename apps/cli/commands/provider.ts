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
import { createInterface } from "node:readline/promises";
import { EXIT, type ExitCode } from "@crabby/api-contracts";
import {
  type ConfigFile,
  type LoadedConfig,
  loadConfig,
  parseConfigValue,
  writeConfig,
} from "@crabby/core";
import type { DataLayout } from "@crabby/platform";
import {
  type ApplyResult,
  applyOverride,
  composeProviders,
  type ModelOverride,
  parseDescriptor,
  parseOverride,
  SUPPORTED_FEATURES,
} from "@crabby/providers";
import { parseTail } from "../args.ts";
import { connect, reportFailure, reportNoGateway } from "../connect.ts";
import type { Renderer } from "../output.ts";
import { findCommand } from "../registry.ts";
import {
  describeOverride,
  nextOverride,
  type OverrideAnswers,
  parseSupports,
} from "./model-edit.ts";

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

/** C7-08 and §3.8's single entry point: `crabby model edit <provider>/<model>`. Two interaction shapes, one stored
 *  value — flags for a script, per-field prompts for a person, and both through `nextOverride` in `model-edit.ts`, which
 *  is what makes D-064's "both paths must reach the same stored value" a fact about the code rather than a promise
 *  about it.
 *
 *  **What it prints is what the next run will use.** After the write it composes in-process (the same
 *  `composeProviders` a Gateway calls at startup) and prints the *provenance* — which values actually moved — rather than
 *  the values the user typed. That distinction is the whole reason §3.8 asks a screen to say which entries are
 *  overridden: a record that restates what the endpoint already said is not an override, and a success line that implied
 *  otherwise would be a claim about the effective descriptor rather than about the file.
 *
 *  **A prompt is only offered where there is a person.** With no flags and a TTY, each field is asked with its current
 *  effective value as the default, and an empty answer leaves that field alone. With no flags and no TTY — a pipe, a cron
 *  job, an editor calling this — the command prints what is in force and the flags to change it, because a command that
 *  waits for input nobody can type is the one failure mode that looks like a working terminal (C5-02's rule, applied
 *  here). */
async function editModel(
  tail: ReturnType<typeof parseTail>,
  layout: DataLayout,
  renderer: Renderer,
): Promise<ExitCode> {
  const target = tail.positionals[0];
  if (target === undefined) {
    renderer.line(
      "model edit",
      "which model? `crabby model list` prints them as `<provider>/<model>`",
    );
    return EXIT.usage;
  }
  const slash = target.indexOf("/");
  if (slash <= 0 || slash === target.length - 1) {
    renderer.line("model edit", `'${target}' is not a <provider>/<model> pair`);
    renderer.fix(
      "§3.8's overrides are per endpoint as well as per model, so the provider is part of the name",
    );
    return EXIT.usage;
  }
  const providerId = target.slice(0, slash);
  const modelId = target.slice(slash + 1);

  const loaded = loadConfig(layout);
  const entry = loaded.config.provider?.[providerId];
  if (entry === undefined) {
    renderer.line("model edit", `no provider '${providerId}' is configured`);
    renderer.fix(
      Object.keys(loaded.config.provider ?? {}).length === 0
        ? "§3.3's path is `crabby provider add <id> --base-url <url> --model <id> --context N --max-output N`"
        : `configured: ${Object.keys(loaded.config.provider ?? {}).join(", ")}`,
    );
    return EXIT.usage;
  }
  if (entry.models?.[modelId] === undefined) {
    renderer.line("model edit", `'${providerId}' has no model '${modelId}'`);
    renderer.fix(
      `it declares ${Object.keys(entry.models ?? {}).join(", ") || "no models at all (§3.2 refuses that)"}`,
    );
    return EXIT.usage;
  }

  const stored = entry.overrides?.[modelId];
  // One shape for both cases, because the two-shape union made the `current` read below a narrowing exercise: an absent
  // record is not a different kind of answer, it is no answer.
  const parsedStored: ReturnType<typeof parseOverride> | { ok: true; override: undefined } =
    stored === undefined ? { ok: true, override: undefined } : parseOverride(stored);
  if (!parsedStored.ok) {
    // The document holds something composition will refuse, so this verb must not build on top of it: the fix is the
    // user's, and `--clear` is offered because for one model that is almost always the right first move.
    renderer.line(
      "model edit",
      `the stored override for '${target}' does not parse: ${parsedStored.reason}`,
    );
    renderer.fix(
      `crabby model edit ${target} --clear removes it, and then set only what you meant`,
    );
    return EXIT.failure;
  }
  const current: ModelOverride | undefined = parsedStored.ok ? parsedStored.override : undefined;

  const flagAnswers = parseSupports(tail.values.supports);
  if (!flagAnswers.ok) {
    renderer.line("model edit", flagAnswers.reason ?? "");
    return EXIT.usage;
  }
  const context = positiveInt(tail.values.context);
  const maxOutput = positiveInt(tail.values["max-output"]);
  if (tail.values.context !== undefined && context === undefined) {
    renderer.line("model edit", "--context takes a positive whole number");
    return EXIT.usage;
  }
  if (tail.values["max-output"] !== undefined && maxOutput === undefined) {
    renderer.line("model edit", "--max-output takes a positive whole number");
    return EXIT.usage;
  }
  const askedSomething =
    context !== undefined ||
    maxOutput !== undefined ||
    flagAnswers.supports !== undefined ||
    tail.values.notes !== undefined ||
    tail.booleans.has("--clear");

  const effective = effectiveOf(loaded.config.provider, providerId, modelId);
  let answers: OverrideAnswers | undefined = {
    ...(context === undefined ? {} : { context }),
    ...(maxOutput === undefined ? {} : { maxOutput }),
    ...(flagAnswers.supports === undefined ? {} : { supports: flagAnswers.supports }),
    ...(tail.values.notes === undefined ? {} : { notes: tail.values.notes }),
    ...(tail.booleans.has("--clear") ? { clear: true } : {}),
  };
  if (!askedSomething && tail.positionals.length === 1) {
    if (process.stdin.isTTY === true && process.stdout.isTTY === true) {
      answers = await promptForOverride(answers, current, effective, renderer);
      if (answers === undefined) {
        renderer.line("model edit", "nothing answered, nothing written");
        return EXIT.success;
      }
    } else {
      // Not a person. Print what is in force and how to change it, rather than waiting for a keypress that will never
      // come — C5-02's "an error, not a hang", applied to a command that has flags for exactly this case.
      renderer.line("model edit", `'${target}' has no override; flags change it:`);
      renderer.line(
        "  capabilities",
        `--supports toolCalling=true,streaming=false (or auto for "whatever the endpoint reported"; the model has ${SUPPORTED_FEATURES.join(", ")})`,
      );
      renderer.line(
        "  limits",
        "--context 8192 --max-output 1024 — budgeting (D-064) sizes compaction against these",
      );
      renderer.line(
        "  clear",
        `--clear removes the record; --notes "why" records the reason beside it`,
      );
      return EXIT.success;
    }
  }

  const next = nextOverride(current, answers ?? {});
  if (!next.ok) {
    renderer.line("model edit", next.reason);
    return EXIT.usage;
  }
  const file = structuredClone(loaded.file) as Record<string, unknown>;
  const providers = { ...((file.provider ?? {}) as Record<string, unknown>) };
  const entry0 = { ...((providers[providerId] ?? {}) as Record<string, unknown>) };
  const overrides = { ...((entry0.overrides ?? {}) as Record<string, unknown>) };
  if (next.override === undefined) delete overrides[modelId];
  else overrides[modelId] = next.override;
  if (Object.keys(overrides).length === 0) delete entry0.overrides;
  else entry0.overrides = overrides;
  providers[providerId] = entry0;
  file.provider = providers;

  const written = writeConfig(layout, file as ConfigFile, undefined, { token: loaded.token });
  if (!written.ok) {
    renderer.line("refused", written.message);
    renderer.fix(
      written.code === "stale"
        ? "the file changed since this command read it — run it again"
        : "nothing was written",
    );
    return EXIT.usage;
  }

  // Composed here rather than after a Gateway restart, and the reason is the same one `provider add` gives: this is the
  // same pure function on the same document, so what this prints is what the next process will compose rather than a
  // second opinion about it.
  const composed = composeProviders((file as ConfigFile).provider);
  const entry1 = composed.find((row) => row.id === providerId);
  const provenance = entry1?.ok === true ? entry1.overrides[modelId] : undefined;
  const changes = describeOverride(provenance);
  if (renderer.json) {
    renderer.done({
      model: target,
      ...(next.override === undefined
        ? { override: null, cleared: true }
        : { override: next.override }),
      ...(provenance === undefined ? {} : { effective: provenance }),
      ...(entry1 === undefined || !entry1.ok
        ? { composed: false, reason: entry1?.reason ?? "unknown" }
        : { composed: true }),
      changes,
    });
    return EXIT.success;
  }
  renderer.line(
    next.override === undefined ? "cleared" : "wrote",
    next.override === undefined
      ? `the override for ${target} — the reported descriptor is in force`
      : `provider.${providerId}.overrides.${modelId}`,
  );
  if (changes.length === 0) {
    // The honest version of a success line: nothing moved. §3.8's drift report needs this distinction, and a screen that
    // printed "ok" for a restated value would make a user believe they had widened a capability they had not.
    renderer.line(
      "effective",
      "unchanged — every value you set is what the endpoint already reported",
    );
  } else {
    for (const change of changes) renderer.line("  changed", change);
  }
  if (entry1 === undefined || !entry1.ok) {
    renderer.line(
      "composed",
      `no — ${entry1?.reason ?? "unknown"}, so this override is not in force until that is fixed`,
    );
  }
  if (current?.notes !== undefined && next.override !== undefined) {
    renderer.line("notes", next.override.notes ?? "(none)");
  }
  renderer.fix(
    "restart the Gateway to pick it up; `crabby model list` shows it as overridden. \u00a73.8's failure sentence " +
      "(\u201cdeclared by override and failed\u201d) arrives with the slice that wires provenance into the loop",
  );
  return EXIT.success;
}

/** The per-field prompts, answered as `OverrideAnswers` and no further — the boundary D-064 needs is that nothing below
 *  this knows which shape produced the answer. An empty answer leaves the field as it is, because a prompt with a
 *  default that overwrites the default when you press return is a prompt that quietly discards an edit. `undefined` comes
 *  back only when the person quit, which is not an answer and must not write anything. */
async function promptForOverride(
  seed: OverrideAnswers,
  current: ModelOverride | undefined,
  effective:
    | { contextWindow?: number; maxOutputTokens?: number; supports: Record<string, boolean> }
    | undefined,
  renderer: Renderer,
): Promise<OverrideAnswers | undefined> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (label: string, fallback: string): Promise<string | undefined> => {
    try {
      const answer = (await rl.question(`${label} [${fallback}]: `)).trim();
      return answer.length === 0 ? undefined : answer;
    } catch {
      // Ctrl-D, or a closed stdin. Neither is an answer, and writing what was gathered so far would be a partial edit
      // presented as a complete one.
      return undefined;
    }
  };
  try {
    renderer.line(
      "model edit",
      "answer with a value, or press return to keep what is in force; 'quit' writes nothing",
    );
    const supports: Record<string, "true" | "false" | "auto"> = {};
    for (const feature of SUPPORTED_FEATURES) {
      const now =
        current?.supports?.[feature] === undefined ? "auto" : String(current.supports[feature]);
      const answer = await ask(
        `  ${feature} (now ${now}, endpoint says ${String(effective?.supports[feature] ?? false)})`,
        now,
      );
      if (answer === undefined) continue;
      if (answer === "quit") return undefined;
      const value = parseSupports(`${feature}=${answer}`);
      if (!value.ok || value.supports === undefined) {
        renderer.line("  refused", value.reason ?? "that is not a value");
        continue;
      }
      Object.assign(supports, value.supports);
    }
    const contextAnswer = await ask(
      `  contextWindow (now ${String(effective?.contextWindow ?? "unknown")})`,
      String(current?.limits?.contextWindow ?? effective?.contextWindow ?? ""),
    );
    if (contextAnswer === "quit") return undefined;
    const maxAnswer = await ask(
      `  maxOutputTokens (now ${String(effective?.maxOutputTokens ?? "unknown")})`,
      String(current?.limits?.maxOutputTokens ?? effective?.maxOutputTokens ?? ""),
    );
    if (maxAnswer === "quit") return undefined;
    const notes = await ask("  notes (optional)", current?.notes ?? "");
    if (notes === "quit") return undefined;
    const context = contextAnswer === undefined ? undefined : positiveInt(contextAnswer);
    const maxOutput = maxAnswer === undefined ? undefined : positiveInt(maxAnswer);
    return {
      ...seed,
      ...(context === undefined ? {} : { context }),
      ...(maxOutput === undefined ? {} : { maxOutput }),
      ...(Object.keys(supports).length === 0 ? {} : { supports }),
      ...(notes === undefined ? {} : { notes }),
      ...(Object.keys(supports).length === 0 &&
      context === undefined &&
      maxOutput === undefined &&
      notes === undefined
        ? { clear: true }
        : {}),
    };
  } finally {
    rl.close();
  }
}

/** Which fields an override record touches, in the screen's own words. This is the **record** (what the user set), not the
 *  provenance (what actually moved): a list answers "what did I change here", and `model edit` answers "what did it do",
 *  because a screen that answered both with one word would have to choose between restating a value and widening one. */
function overrideLabels(entry: { readonly overrides?: unknown }, modelId: string): string[] {
  const record = (entry.overrides as Record<string, unknown> | undefined)?.[modelId];
  if (record === undefined) return [];
  const parsed = parseOverride(record);
  if (!parsed.ok) return ["an override that does not parse — `crabby model edit` says why"];
  const labels = Object.keys(parsed.override.supports ?? {});
  const limits = parsed.override.limits ?? {};
  if (limits.contextWindow !== undefined) labels.push("contextWindow");
  if (limits.maxOutputTokens !== undefined) labels.push("maxOutputTokens");
  if (labels.length === 0 && parsed.override.notes !== undefined) labels.push("notes only");
  return labels;
}

/** The effective values of one model, from the same composition the write is judged by. Read before the write so the
 *  prompts can show the truth rather than the file. */
function effectiveOf(
  providers: Record<string, Record<string, unknown>> | undefined,
  providerId: string,
  modelId: string,
):
  | { contextWindow?: number; maxOutputTokens?: number; supports: Record<string, boolean> }
  | undefined {
  if (providers === undefined) return undefined;
  // Composition is asked whether the entry composes at all, so a screen never shows effective values for a provider the
  // runtime would refuse — a "current" value for a model nothing can call is a fiction.
  const composed = composeProviders(providers as ConfigFile["provider"]).find(
    (row) => row.id === providerId,
  );
  if (composed === undefined || !composed.ok) return undefined;
  // The reported descriptor comes from the document rather than from `provider.describe()`: `describe()` is async, and a
  // synchronous screen path should not make the whole verb async to read one number — §3.2's parser plus
  // `applyOverride` is exactly the composition does internally, applied here to the stored pair.
  const models = (providers[providerId]?.models ?? {}) as Record<string, Record<string, unknown>>;
  const stored = models[modelId];
  if (stored === undefined) return undefined;
  const parsed = parseDescriptor(stored);
  if (!parsed.ok) return undefined;
  const overrides = (providers[providerId]?.overrides ?? {}) as Record<string, ModelOverride>;
  const record = overrides[modelId];
  const applied: ApplyResult =
    record === undefined
      ? { ok: true, descriptor: parsed.descriptor, provenance: { source: "manual" } }
      : applyOverride(parsed.descriptor, record);
  if (!applied.ok) return undefined;
  return {
    contextWindow: applied.descriptor.contextWindow,
    maxOutputTokens: applied.descriptor.maxOutputTokens,
    supports: applied.descriptor.supports,
  };
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
  if (verb === "edit") return editModel(tail, layout, renderer);
  if (verb !== "list") {
    renderer.line(`crabby model ${verb}`, "not in this version yet");
    renderer.fix(
      "a probe calls a live endpoint and reports latency and the §3.5 error class per capability; the credential it " +
        "needs belongs to a Gateway rather than to a terminal, and no route holds one — `crabby model edit` is the " +
        "verb that works without a call, because §3.8's override is a document",
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
    readonly overriddenBy?: string[];
    readonly reported?: { readonly contextWindow?: number; readonly maxOutputTokens?: number };
  }[] = [];
  for (const [providerId, entry] of Object.entries(config.config.provider ?? {})) {
    const models = (entry.models ?? {}) as Record<string, Record<string, unknown>>;
    for (const [modelId, descriptor] of Object.entries(models)) {
      // §3.8's last rule: this screen shows the **effective** capability set and which entries are overridden. Effective,
      // not stored — an override that raised the window is what budgeting (D-064) sizes compaction against, and a list
      // that printed the reported number would be a second opinion about the value the next run uses.
      const effective = effectiveOf(
        config.config.provider as Record<string, Record<string, unknown>>,
        providerId,
        modelId,
      );
      const labels = overrideLabels(entry, modelId);
      rows.push({
        provider: providerId,
        model: modelId,
        ...(effective?.contextWindow === undefined
          ? typeof descriptor.contextWindow === "number"
            ? { contextWindow: descriptor.contextWindow }
            : {}
          : { contextWindow: effective.contextWindow }),
        ...(effective?.maxOutputTokens === undefined
          ? typeof descriptor.maxOutputTokens === "number"
            ? { maxOutputTokens: descriptor.maxOutputTokens }
            : {}
          : { maxOutputTokens: effective.maxOutputTokens }),
        ...(descriptor.cost === undefined ? {} : { cost: costClass(descriptor.cost) }),
        ...(descriptor.batching === undefined ? {} : { batching: descriptor.batching }),
        ...(typeof entry.baseUrl === "string" ? { baseUrl: entry.baseUrl } : {}),
        ...(labels.length === 0 ? {} : { overriddenBy: labels }),
        // The reported numbers, kept beside the effective ones when they differ, because the difference *is* the drift a
        // user needs to see — and because a screen that showed only the override would make it impossible to tell
        // whether the endpoint moved or the user did.
        ...(effective === undefined ||
        (typeof descriptor.contextWindow === "number" &&
          descriptor.contextWindow === effective.contextWindow &&
          typeof descriptor.maxOutputTokens === "number" &&
          descriptor.maxOutputTokens === effective.maxOutputTokens)
          ? {}
          : {
              reported: {
                ...(typeof descriptor.contextWindow === "number"
                  ? { contextWindow: descriptor.contextWindow }
                  : {}),
                ...(typeof descriptor.maxOutputTokens === "number"
                  ? { maxOutputTokens: descriptor.maxOutputTokens }
                  : {}),
              },
            }),
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
        (row.cost ?? "cost class unstated") +
        (row.overriddenBy === undefined ? "" : ` · overridden: ${row.overriddenBy.join(", ")}`) +
        (row.reported === undefined
          ? ""
          : ` · the endpoint reported context ${String(row.reported.contextWindow ?? "?")} / output ${String(row.reported.maxOutputTokens ?? "?")}`),
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
