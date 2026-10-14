// Composition: `config.json`'s provider entries → the `Provider` a run calls. §3.3 gives two ways to configure an
// endpoint ("Configured through `crabby provider add` **or configuration**") and this is the second one, which is the
// one M2 can have: the verb is M4's (`docs/ROADMAP.md` §6, `apps/cli/registry.ts`'s `provider add/ls/rm` rows) and
// writes the same entry this reads.
//
// What composes here is narrow, and the narrowness is the whole content of this file. **An entry composes when it needs
// no secret.** §3.7 keeps a key in the vault and hands an adapter "a handle that yields the value at call time";
// nothing in this build resolves a `vault://` reference (`docs/CONSISTENCY_REVIEW.md` F-56, and `docs/ROADMAP.md` §7
// puts the vault in M5), so an entry carrying one is refused with that reason rather than composed with an empty
// credential — an adapter that silently dropped a key would answer `401` from the endpoint and read as a broken
// network. What is left is the keyless endpoint, which is not a consolation prize on the primary platform: D-066 and
// O-034 both settle local inference on Android as "supported only through an external server the user runs", and a
// `llama-server` or an Ollama OpenAI-compatible listener on `127.0.0.1` asks for no key at all.
//
// Three more refusals are decisions rather than gaps, and each is stated where it fires:
//
//  - `kind: "mock"` — §3.3 lists it as a preset and `SECURITY.md` §17 lists it as the instrument that keeps tests off
//    live APIs. Composing it from a user's config would let a task reach `completed` without a model ever answering,
//    which is the demo this phase has refused to ship.
//  - `kind: "ollama" | "anthropic" | "gemini"` — §3.3's other three families. D-100 records why they are absent
//    ("none of those three differs in a way this build has a caller for yet"), and pointing this family's adapter at
//    one of their wire protocols would produce a failure that reads as a broken endpoint instead of an absent adapter.
//  - a descriptor that does not parse — §3.2's own rule: "an unparsable descriptor disables the provider rather than
//    defaulting everything on".
//
// One entry's refusal never sinks another's, for the reason `packages/core/config.ts`'s rule 2 gives: on a phone,
// refusing to boot over a typo turns a config error into an outage. So this returns a result per entry and the caller
// decides what an install with none of them means.

import { isVaultReference, type LimitsConfig, type ProviderEntryConfig } from "@crabby/core";
import { validateProviderConfig } from "./config.ts";
import type { Provider } from "./contract.ts";
import type { ModelDescriptor, SupportedFeature } from "./descriptor.ts";
import { createOpenAiCompatibleProvider, OPENAI_DEADLINE_DEFAULTS } from "./openai.ts";

/** One config entry's fate. `warnings` are §3.3's — "a clear warning if the host is not loopback while the key would be
 *  sent over plain HTTP" — carried through from `validateProviderConfig` so the party that composed the adapter is the
 *  party that shows the warning, instead of it dying inside a constructor that has nowhere to put it. */
export type ProviderComposition =
  | {
      readonly id: string;
      readonly ok: true;
      readonly provider: Provider;
      readonly modelIds: readonly string[];
      readonly warnings: readonly string[];
    }
  | { readonly id: string; readonly ok: false; readonly reason: string };

/** The families §3.3 lists that have no adapter in this build, with the reason each is absent. Kept as data so the
 *  refusal names the family the user asked for rather than a generic "unsupported". */
const ABSENT_FAMILIES: Readonly<Record<string, string>> = {
  ollama:
    "`ollama`'s native API (model listing and pull state) has no adapter in this build; D-100 records why, and Ollama " +
    'serves an OpenAI-compatible endpoint at `<base>/v1` that `kind: "openai-compatible"` reaches',
  anthropic: "`anthropic`'s message format and tool blocks have no adapter in this build (D-100)",
  gemini: "`gemini`'s streaming and safety metadata have no adapter in this build (D-100)",
  mock:
    "`mock` is SECURITY.md §17's test instrument, not a provider a task may run on: composing it from configuration " +
    "would let a task reach `completed` with no model behind it, which is the demo this phase has refused to ship",
};

export function composeProviders(
  entries: Readonly<Record<string, ProviderEntryConfig>> | undefined,
  limits?: LimitsConfig,
): readonly ProviderComposition[] {
  if (entries === undefined) return [];
  return Object.entries(entries).map(([id, entry]) => composeOne(id, entry, limits));
}

function composeOne(
  id: string,
  entry: ProviderEntryConfig,
  limits: LimitsConfig | undefined,
): ProviderComposition {
  const refused = (reason: string): ProviderComposition => ({ id, ok: false, reason });

  const kind = entry.kind ?? "openai-compatible";
  if (kind !== "openai-compatible") {
    return refused(ABSENT_FAMILIES[kind] ?? `'${kind}' is not a family §3.3 names`);
  }
  // The schema already forces `key` to be a `vault://` reference (§3.3: "never inline in … an ordinary config file"),
  // so the only thing left to decide is whether this build can resolve one. It cannot, and saying so is F-56's whole
  // point: a `vault://` prefix in front of a plaintext file would make §3.7 true in a grep and false in every way that
  // matters.
  if (entry.key !== undefined) {
    // Reached with a value that is *not* a reference, because `loadConfig`'s rule 2 keeps a file with a bad key running
    // and reports the problem beside the usable part rather than refusing to compose. The refusal is printed on a
    // startup banner and can be written to a log, so it is a serializer, and SECURITY §7 puts the obligation there
    // rather than at the screen: naming the field is the fix a user needs, and quoting the value would put a secret in
    // both places at once. `redact` cannot be relied on for this one — its secret-shaped pattern wants a delimiter after
    // the prefix, and `gsk_…` has an underscore there — so the value is withheld at the source.
    if (!isVaultReference(entry.key)) {
      return refused(
        `'${id}' holds a key value where §3.7 allows only a \`vault://\` name, and the value is withheld here rather ` +
          "than printed (§7's obligation is at the serializer, and a startup banner is one). `crabby config get " +
          `provider.${id}.key\` shows it in the terminal that owns the file, and \`crabby doctor\` prints the fix. ` +
          "Nothing resolves a reference yet either — the vault arrives in M5 (docs/CONSISTENCY_REVIEW.md F-56) — so on " +
          "this build an endpoint that needs a key cannot be configured, which on this platform means a local server " +
          "the user runs (D-066, O-034)",
      );
    }
    return refused(
      `'${id}' supplies its key by reference (${entry.key}), and nothing in this build resolves a vault reference — ` +
        "the vault arrives in M5 (docs/ROADMAP.md §7, docs/CONSISTENCY_REVIEW.md F-56). Until then an endpoint that " +
        "needs no key composes and one that does not cannot be configured, which on this platform means a local server " +
        "the user runs (D-066, O-034)",
    );
  }

  // An entry a user is still building. §3.3 requires "name, base URL, model name(s)" of a *working* endpoint, and the
  // schema leaves each field optional so that `crabby config set provider.local.baseUrl …` can write one of them; the
  // requirement is enforced here, where the answer can name the command that finishes the entry instead of listing the
  // fields the user has not typed yet.
  if (entry.baseUrl === undefined || entry.baseUrl === "") {
    return refused(
      `'${id}' has no base URL — crabby config set provider.${id}.baseUrl <http(s) url> (§3.3's required field)`,
    );
  }
  const models = entry.models ?? {};
  if (Object.keys(models).length === 0) {
    return refused(
      `'${id}' declares no models, so there is nothing to route a request to and nothing to answer §3.2's capability ` +
        `questions from — crabby config set provider.${id}.models '{"<modelId>": { …descriptor }}'`,
    );
  }

  const config = { baseUrl: entry.baseUrl };
  const validation = validateProviderConfig(config);
  if (!validation.ok) return refused(validation.reason);

  const modelList = Object.entries(models).map(([modelId, descriptor]) => ({
    id: modelId,
    descriptor,
  }));
  try {
    const provider = createOpenAiCompatibleProvider({
      id,
      config,
      models: modelList,
      // D-074's provider timeouts are `limits.*` keys, and `crabby config set limits.providerConnectMs 3000` is a
      // documented override path. An adapter that read only `LIMITS_DEFAULTS` would make that sentence false for every
      // process except the one that printed it, so the composed deadlines come from the loaded config.
      deadlines: deadlinesFrom(limits),
    });
    return {
      id,
      ok: true,
      provider,
      modelIds: modelList.map((model) => model.id),
      warnings: validation.warnings ?? [],
    };
  } catch (error) {
    // §3.1's "rejects unusable configuration with an actionable reason" and §3.2's "an unparsable descriptor disables
    // the provider" are both enforced by the constructor, which throws. Composition is the party that turns a throw
    // into an answer a screen can print, and the message it throws is already the actionable one.
    return refused(error instanceof Error ? error.message : String(error));
  }
}

/** D-074's three adapter deadlines, read out of the loaded `limits` rather than the defaults, with the defaults behind
 *  them so a partial override does not un-arm a deadline. The fourth (absolute) is not here: §3.1 makes it the runtime
 *  wrapper's job and the loop arms it from `ctx.timeoutMs` (D-100). */
export function deadlinesFrom(limits: LimitsConfig | undefined): typeof OPENAI_DEADLINE_DEFAULTS {
  return {
    connectMs: limits?.providerConnectMs ?? OPENAI_DEADLINE_DEFAULTS.connectMs,
    firstTokenMs: limits?.providerFirstTokenMs ?? OPENAI_DEADLINE_DEFAULTS.firstTokenMs,
    idleStreamMs: limits?.providerIdleStreamMs ?? OPENAI_DEADLINE_DEFAULTS.idleStreamMs,
  };
}

/** §3.6's "The user selects a default model and may pin a model per task or per interface session; per-task pinning
 *  wins." This is the selection half; the pinning half is a run's `modelId` and belongs to whoever starts one. The
 *  spelling is `<provider>/<modelId>`, which is `docs/INTERFACES_AND_API.md` §7.1's `/model <provider/model>` argument,
 *  so the value in the file and the value a command takes are the same string. */
export type ModelSelection =
  | {
      readonly ok: true;
      readonly providerId: string;
      readonly modelId: string;
      readonly provider: Provider;
    }
  | { readonly ok: false; readonly reason: string };

export function selectDefaultModel(
  composed: readonly ProviderComposition[],
  defaultModel: string | undefined,
): ModelSelection {
  const usable = composed.filter(
    (entry): entry is Extract<ProviderComposition, { ok: true }> => entry.ok,
  );
  if (defaultModel === undefined || defaultModel === "") {
    return {
      ok: false,
      reason:
        "no default model is selected (§3.6). `crabby config set defaultModel <provider>/<modelId>` — the spelling " +
        "`docs/INTERFACES_AND_API.md` §7.1's `/model` command takes" +
        (usable.length === 0
          ? ""
          : `; what composes now: ${usable.map((entry) => entry.modelIds.map((m) => `${entry.id}/${m}`).join(", ")).join(", ")}`),
    };
  }
  const slash = defaultModel.indexOf("/");
  if (slash <= 0 || slash === defaultModel.length - 1) {
    return {
      ok: false,
      reason: `'${defaultModel}' is not a \`<provider>/<modelId>\` pair, which is the spelling §7.1's \`/model\` command takes`,
    };
  }
  const providerId = defaultModel.slice(0, slash);
  const modelId = defaultModel.slice(slash + 1);
  const entry = usable.find((candidate) => candidate.id === providerId);
  if (entry === undefined) {
    const refused = composed.find((candidate) => candidate.id === providerId);
    return {
      ok: false,
      reason:
        refused !== undefined && !refused.ok
          ? `provider '${providerId}' does not compose: ${refused.reason}`
          : `no provider '${providerId}' composes` +
            (usable.length > 0
              ? ` (the ones that do: ${usable.map((item) => item.id).join(", ")})`
              : ""),
    };
  }
  if (!entry.modelIds.includes(modelId)) {
    return {
      ok: false,
      reason: `'${providerId}' has no model '${modelId}'; it declares ${entry.modelIds.join(", ")}`,
    };
  }
  return { ok: true, providerId, modelId, provider: entry.provider };
}

/** §3.6's per-task pin (D-108's A, D-110's B, F-57), resolved against every provider the caller composed. The pin is
 *  `<provider>/<modelId>`, the same spelling `defaultModel` and `/model` take, and it may name any entry in the pool —
 *  which is the whole of option B: the caller resolves the pin (D-101's rule, extended from the model to the pair) and
 *  hands the loop the provider and the modelId it answered with, so nothing here becomes a choice the loop gets to
 *  make. A pin the pool cannot answer is refused with the pool's own ids beside it, and an ok answer is the same
 *  `ModelSelection` `selectDefaultModel` gives, so the caller passes `selection.provider` into a run the way it would
 *  pass a selected default. */
export async function selectPinnedModel(
  pool: readonly Provider[],
  pin: string,
): Promise<ModelSelection> {
  const slash = pin.indexOf("/");
  if (slash <= 0 || slash === pin.length - 1) {
    return {
      ok: false,
      reason: `'${pin}' is not a \`<provider>/<modelId>\` pair, which is the spelling §3.6's per-task pin and \`/model\` take`,
    };
  }
  const providerId = pin.slice(0, slash);
  const modelId = pin.slice(slash + 1);
  const provider = pool.find((candidate) => candidate.id === providerId);
  if (provider === undefined) {
    const ids = pool.map((candidate) => candidate.id).join(", ");
    return {
      ok: false,
      reason:
        `no composed provider answers to '${providerId}'` +
        (ids === ""
          ? ", and this Gateway composed no provider at all"
          : `; the composed ones are: ${ids} — pin one of those as <provider>/<modelId>`) +
        " (docs/INTERFACES_AND_API.md §4.3); a provider that refused composition says why at startup and in " +
        "GET /api/v1/status",
    };
  }
  const models = await provider.listModels();
  if (!models.includes(modelId)) {
    return {
      ok: false,
      reason: `'${providerId}' has no model '${modelId}'; it declares ${models.join(", ")}`,
    };
  }
  return { ok: true, providerId, modelId, provider };
}

/** §3.6 stage 2's options, labelled. `losses` is the half that needs the pool: §3.6 asks each option to carry "its
 *  provider, capability deltas, and cost class", and a *delta* is only true relative to something — here, to the model
 *  the run is currently on. Computing it here rather than in the ask is what keeps the ask honest: the loop receives
 *  comparisons and cannot form a new one from data it does not have, which is the same D-101 rule that keeps it out of
 *  the pool in the first place.
 *
 *  The order is §3.6's own: the same provider's other models first, then the rest of the pool. A user whose local model
 *  is overloaded should see the local alternatives before a hosted one that costs money and sends the conversation
 *  somewhere new — and the ask shows what each would cost, so the order is a preference, not a decision.
 *
 *  A provider whose `describe()` rejects is **skipped, not offered**: §3.2's rule is that an unparsable descriptor
 *  disables the provider rather than defaulting everything on, and a candidate we cannot describe is a candidate we cannot
 *  state the losses of. An install with one provider therefore gets an empty list, which the ask reports as an ask with no
 *  options — the honest answer, and one the resume route accepts as "try the same model again". */
export interface AskCandidate {
  readonly model: string;
  readonly provider: string;
  readonly cost: string;
  readonly contextWindow: number;
  readonly losses: readonly string[];
}

const FEATURE_LOSSES: ReadonlyArray<{
  readonly feature: SupportedFeature;
  readonly label: string;
}> = [
  { feature: "toolCalling", label: "no tool calling" },
  { feature: "parallelToolCalls", label: "no parallel tool calls" },
  { feature: "streaming", label: "no streaming" },
  { feature: "imageInput", label: "no image input" },
  { feature: "structuredOutput", label: "no structured output" },
  { feature: "reasoning", label: "no reasoning output" },
  { feature: "promptCaching", label: "no prompt caching" },
];

function costClass(cost: ModelDescriptor["cost"]): string {
  if (cost === "local") return "local (no per-token cost)";
  if (cost === "free-tier") return "free tier";
  if (cost === null) return "not declared";
  return "paid per token";
}

export async function composeAskCandidates(
  pool: readonly Provider[],
  current: { readonly providerId: string; readonly modelId: string },
): Promise<readonly AskCandidate[]> {
  const described = await Promise.all(
    pool.map(async (provider) => {
      try {
        return {
          provider,
          models: await provider.describe(),
        };
      } catch {
        // §3.2: a descriptor that does not parse disables the provider. A candidate that cannot describe itself is not
        // offered, and the ask that lists fewer options is still an ask a user can answer.
        return undefined;
      }
    }),
  );
  const currentDescriptor = described.find((entry) => entry?.provider.id === current.providerId)
    ?.models[current.modelId];

  const rows: Array<{ readonly candidate: AskCandidate; readonly sameProvider: boolean }> = [];
  for (const entry of described) {
    if (entry === undefined) continue;
    for (const [modelId, descriptor] of Object.entries(entry.models)) {
      if (entry.provider.id === current.providerId && modelId === current.modelId) continue;
      const losses: string[] = [];
      for (const { feature, label } of FEATURE_LOSSES) {
        if (
          currentDescriptor?.supports[feature] === true &&
          descriptor.supports[feature] !== true
        ) {
          losses.push(label);
        }
      }
      if (
        currentDescriptor !== undefined &&
        descriptor.contextWindow < currentDescriptor.contextWindow
      ) {
        losses.push(
          `a smaller context window (${descriptor.contextWindow.toLocaleString("en-US")} of ` +
            `${currentDescriptor.contextWindow.toLocaleString("en-US")})`,
        );
      }
      rows.push({
        sameProvider: entry.provider.id === current.providerId,
        candidate: {
          model: `${entry.provider.id}/${modelId}`,
          provider: entry.provider.id,
          cost: costClass(descriptor.cost),
          contextWindow: descriptor.contextWindow,
          losses,
        },
      });
    }
  }
  // A stable sort rather than the pool's own order: two providers' models must not appear in an order that depends on
  // which of them answered a `describe()` first, because a prompt whose options move around between two identical asks is
  // a prompt two users read differently.
  return rows
    .sort(
      (a, b) =>
        Number(b.sameProvider) - Number(a.sameProvider) ||
        a.candidate.model.localeCompare(b.candidate.model),
    )
    .map((row) => row.candidate);
}
