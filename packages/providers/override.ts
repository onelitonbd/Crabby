// §3.8's per-model capability override: what the user changed about a model, kept **beside** the descriptor the
// endpoint reported rather than inside it.
//
// Two rules shape this file, and both come from §3.8 rather than from taste:
//
//  - **Highest specificity wins**: user override → bundled preset → provider discovery → adapter default. This build has
//    no bundled preset and no discovery, so in practice the chain is "user override → what the endpoint reported" — and
//    that short chain is *why* the priority order is worth stating rather than assuming: it is the order a future preset
//    or discovery layer has to slot into, and a rule written only for today's two layers would encode today's shape.
//  - **Forcing a capability on is a trust decision with a cost.** The runtime still verifies at call time, and when a
//    forced-on capability fails Crabby must report "`toolCalling` was declared by override and failed" rather than fall
//    back silently (SECURITY.md §2 rule 04 again: never treat a declaration as an authorization). For that sentence to be
//    possible the *provenance* has to survive composition, so `applyOverride` returns it beside the descriptor rather than
//    inside it.
//
// **Why provenance is not a field of `ModelDescriptor`** — the first version of this file put it there and §3.2's own
// parser refused the result: an adapter is handed a descriptor and parses it, and a parser that rejects unknown fields
// will reject a descriptor carrying an unknown field. That failure is the right answer to a question worth asking once:
// a provenance field *inside* the descriptor is a field a document could set, so a user's `config.json` could claim
// "`streaming` was declared by override" about a value the endpoint reported. Provenance therefore travels on
// `ProviderComposition` (`override.ts`'s `OverrideProvenance`), which only `applyOverride` can produce — a system fact
// that cannot be asserted by an input. What the runtime does with it — §3.8's failure sentence — is the next slice's
// work, and it is named there rather than claimed here.
//
// **What this file refuses, and why refusing is the answer.** An override that does not parse, names a feature the data
// model does not have, or produces a descriptor the descriptor parser would have refused (`maxOutputTokens` not smaller
// than `contextWindow`, a window that is not a positive integer) **fails the model closed**. The tempting alternative is
// to drop the bad field and apply the rest, which would leave a user who typo'd one flag believing they had raised a
// context window when they had not — and SECURITY.md §2 rule 02 says deny when in doubt, not "allow the parts we could
// understand".
//
// **`"auto"` is the clearing value**, per §3.8's `supports.<flag>` column: it means "no opinion", so the reported value
// stands and no provenance is recorded. That is what makes `crabby model edit --clear` expressible without deleting the
// whole record, and it is why `false` and `"auto"` are different values rather than a boolean and a missing key —
// "the user turned it off" and "the user never said" are different facts and a drift report needs both.
//
// **One field §3.8's table lists is deliberately not accepted here**: `limits.reserveForOutput`. D-064 derives it from
// `descriptor.maxOutputTokens` (see `packages/agent-runtime/context.ts`), so a stored reserve would be a second source
// for a number the runtime already computes, and two sources would drift. The parser refuses the key with that reason
// rather than accepting a value nothing reads — recorded as F-62.
import type { ModelDescriptor, SupportedFeature } from "./descriptor.ts";
import { SUPPORTED_FEATURES } from "./descriptor.ts";

/** §3.8's `supports.<flag>`: a forced `true`, a forced `false`, or `"auto"` for "whatever the endpoint reported". */
export type OverrideValue = boolean | "auto";

/** §3.8's record, minus the two fields that live elsewhere (see the header). `source` is required because a record with
 *  no account of how it got there cannot be reported as `manual` by default: "I typed it" and "a preset shipped it" are
 *  different trust statements, and §3.8's table lists the field for exactly that reason. */
export interface ModelOverride {
  readonly supports?: Readonly<Partial<Record<SupportedFeature, OverrideValue>>> | undefined;
  readonly limits?: Readonly<{ contextWindow?: number; maxOutputTokens?: number }> | undefined;
  readonly source: "manual" | "preset";
  readonly notes?: string | undefined;
}

export type OverrideParseResult =
  | { readonly ok: true; readonly override: ModelOverride }
  | { readonly ok: false; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** §3.1's rule applied to an override: every rejection names the field and what was expected, because "invalid
 *  override" is not actionable and this is a document a person typed. */
export function parseOverride(input: unknown): OverrideParseResult {
  if (!isRecord(input)) return { ok: false, reason: "an override must be an object" };
  const unknownFields = Object.keys(input).filter(
    (key) => !["supports", "limits", "source", "notes"].includes(key),
  );
  if (unknownFields.length > 0) {
    // Fail closed on unknown keys, in the parser's own spirit and for the same reason: a field this build does not read
    // is a claim the user believes is in force. `reserveForOutput` gets its own sentence because it is named in §3.8's
    // table and refused here on purpose (F-62) — a reader who typed it deserves to know which of the two it is.
    const derived = unknownFields.filter((key) => key === "reserveForOutput");
    return {
      ok: false,
      reason:
        `unknown override field(s): ${unknownFields.join(", ")}` +
        (derived.length > 0
          ? " — `reserveForOutput` is not stored because D-064 derives it from `maxOutputTokens` (F-62); raise " +
            "`maxOutputTokens` instead, which is what budgeting reads"
          : " — an override this build cannot read is a claim that is not in force (SECURITY.md §2 rule 02)"),
    };
  }

  if (input.source !== "manual" && input.source !== "preset") {
    return { ok: false, reason: `'source' must be one of manual, preset` };
  }

  let supports: Partial<Record<SupportedFeature, OverrideValue>> | undefined;
  if (input.supports !== undefined) {
    if (!isRecord(input.supports))
      return { ok: false, reason: "'supports' must be an object of true|false|auto" };
    const unknownFeatures = Object.keys(input.supports).filter(
      (key) => !(SUPPORTED_FEATURES as readonly string[]).includes(key),
    );
    if (unknownFeatures.length > 0) {
      return {
        ok: false,
        reason: `'supports' has unknown feature(s): ${unknownFeatures.join(", ")} — the model has ${SUPPORTED_FEATURES.join(", ")}`,
      };
    }
    supports = {};
    for (const feature of SUPPORTED_FEATURES) {
      const value = input.supports[feature];
      if (value === undefined) continue;
      if (value !== "auto" && typeof value !== "boolean") {
        return { ok: false, reason: `'supports.${feature}' must be true, false, or auto` };
      }
      supports[feature] = value;
    }
  }

  let limits: { contextWindow?: number; maxOutputTokens?: number } | undefined;
  if (input.limits !== undefined) {
    if (!isRecord(input.limits)) return { ok: false, reason: "'limits' must be an object" };
    const unknownLimits = Object.keys(input.limits).filter(
      (key) => key !== "contextWindow" && key !== "maxOutputTokens",
    );
    if (unknownLimits.length > 0) {
      const derived = unknownLimits.filter((key) => key === "reserveForOutput");
      return {
        ok: false,
        reason:
          `'limits' has unknown field(s): ${unknownLimits.join(", ")}` +
          (derived.length > 0
            ? " — `reserveForOutput` is not stored because D-064 derives it from `maxOutputTokens` (F-62); raise " +
              "`maxOutputTokens` instead, which is what budgeting reads"
            : ""),
      };
    }
    limits = {};
    for (const field of ["contextWindow", "maxOutputTokens"] as const) {
      const value = input.limits[field];
      if (value === undefined) continue;
      if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
        return {
          ok: false,
          reason: `'limits.${field}' must be a positive integer, got ${JSON.stringify(value) ?? String(value)}`,
        };
      }
      limits[field] = value;
    }
  }

  if (input.notes !== undefined && typeof input.notes !== "string") {
    return { ok: false, reason: "'notes' must be a string" };
  }

  return {
    ok: true,
    override: {
      ...(supports === undefined ? {} : { supports }),
      ...(limits === undefined ? {} : { limits }),
      source: input.source,
      ...(typeof input.notes === "string" ? { notes: input.notes } : {}),
    },
  };
}

/** What one override actually changed, as a system fact rather than a document's claim. `supports` holds one entry per
 *  feature whose effective value moved, `limits` one entry per ceiling that moved; `source` and `notes` are copied so a
 *  screen can say *why* without re-reading the file. */
export interface OverrideProvenance {
  readonly supports?:
    | Readonly<Partial<Record<SupportedFeature, { from: boolean; to: boolean }>>>
    | undefined;
  readonly limits?:
    | Readonly<{
        from?: { contextWindow?: number; maxOutputTokens?: number };
        to: { contextWindow: number; maxOutputTokens: number };
      }>
    | undefined;
  readonly source: "manual" | "preset";
  readonly notes?: string | undefined;
}

export type ApplyResult =
  | {
      readonly ok: true;
      readonly descriptor: ModelDescriptor;
      readonly provenance: OverrideProvenance;
    }
  | { readonly ok: false; readonly reason: string };

/** The effective descriptor: the reported one with the user's changes applied, plus the provenance for the values that
 *  actually moved — a feature restated exactly, or cleared with `"auto"`, is *not* moved and is not reported, because
 *  calling that an override would make a screen claim a trust decision nobody made.
 *
 *  The invariant `parseDescriptor` enforces is enforced *again* here, because applying an override is the one way a valid
 *  descriptor can become an invalid one — a `contextWindow` lowered below a fixed `maxOutputTokens`, say — and a
 *  descriptor the rest of the build would have refused must not survive the one path that constructs descriptors outside
 *  the parser. */
export function applyOverride(descriptor: ModelDescriptor, override: ModelOverride): ApplyResult {
  // Provenance for *this* application only, against the reported descriptor this was handed. There is no second hop
  // today — §3.8's chain has exactly one layer in this build — and a function that pretended to accumulate a chain it
  // cannot be given would be the kind of speculative parameter D-034's "no second opinion" rule exists to refuse. When a
  // bundled preset arrives, its own `applyOverride` result becomes an input here rather than a field smuggled through
  // the descriptor.
  const moved: Partial<Record<SupportedFeature, { from: boolean; to: boolean }>> = {};
  const supports = { ...descriptor.supports };
  for (const feature of SUPPORTED_FEATURES) {
    const value = override.supports?.[feature];
    if (value === undefined) continue;
    if (value === "auto") continue;
    if (supports[feature] === value) continue;
    moved[feature] = { from: supports[feature], to: value };
    supports[feature] = value;
  }

  const contextWindow = override.limits?.contextWindow ?? descriptor.contextWindow;
  const maxOutputTokens = override.limits?.maxOutputTokens ?? descriptor.maxOutputTokens;
  if (maxOutputTokens >= contextWindow) {
    return {
      ok: false,
      reason:
        `the override makes 'maxOutputTokens' (${maxOutputTokens}) not smaller than 'contextWindow' (${contextWindow}), ` +
        "which §3.2's descriptor parser refuses — the model is disabled rather than truncated",
    };
  }

  const limitsMoved =
    override.limits?.contextWindow === undefined && override.limits?.maxOutputTokens === undefined
      ? undefined
      : {
          from: {
            ...(override.limits?.contextWindow === undefined
              ? {}
              : { contextWindow: descriptor.contextWindow }),
            ...(override.limits?.maxOutputTokens === undefined
              ? {}
              : { maxOutputTokens: descriptor.maxOutputTokens }),
          },
          to: { contextWindow, maxOutputTokens },
        };

  return {
    ok: true,
    descriptor: {
      ...descriptor,
      contextWindow,
      maxOutputTokens,
      supports: supports as Record<SupportedFeature, boolean>,
    },
    provenance: {
      ...(Object.keys(moved).length === 0 ? {} : { supports: moved }),
      ...(limitsMoved === undefined ? {} : { limits: limitsMoved }),
      source: override.source,
      ...(override.notes === undefined ? {} : { notes: override.notes }),
    },
  };
}
