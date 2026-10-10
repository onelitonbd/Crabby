// The capability descriptor of §3.2, per model rather than per provider, and the fail-closed reader of it.
//
// §3.2's second sentence is the reason this file exists as code instead of a type: "Unknown fields fail closed: an
// unparsable descriptor disables the provider rather than defaulting everything on." A type cannot enforce that, since
// a type erases whatever a runtime object carries; only the parser can notice `supports: { toolCallings: true }` — a
// typo that a structural type would read as "no tool calling" and a careless reader would read as "yes". So this file
// owns the parse, names every field it did not recognize, and returns a descriptor only when nothing was guessed.

export const SUPPORTED_FEATURES = [
  "streaming",
  "toolCalling",
  "parallelToolCalls",
  "systemRole",
  "structuredOutput",
  "imageInput",
  "audioInput",
  "reasoning",
  "promptCaching",
  "jsonSchemaValidation",
] as const;
export type SupportedFeature = (typeof SUPPORTED_FEATURES)[number];

export const CANCELLATION_MODES = ["supported", "best-effort", "unsupported"] as const;
export type CancellationMode = (typeof CANCELLATION_MODES)[number];

export interface ModelDescriptor {
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly supports: Readonly<Record<SupportedFeature, boolean>>;
  readonly cancellation: CancellationMode;
  readonly rateLimits: { readonly rpm: number; readonly tpm: number } | null;
  readonly cost:
    | { readonly promptPerMTok: number; readonly completionPerMTok: number }
    | "free-tier"
    | "local"
    | null;
  readonly batching: { readonly maxRequestsPerSecond: number } | null;
}

export type DescriptorResult =
  | { ok: true; descriptor: ModelDescriptor }
  | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInt(
  value: unknown,
  field: string,
): { ok: true; value: number } | { ok: false; reason: string } {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return {
      ok: false,
      reason: `'${field}' must be a positive integer, got ${JSON.stringify(value) ?? String(value)}`,
    };
  }
  return { ok: true, value };
}

/**
 * Parse one descriptor. Every rejection names the field and what was expected, because §3.1's rule for the sibling
 * method is the standard applied here: a failure must be "actionable", and "invalid descriptor" is not.
 */
export function parseDescriptor(input: unknown): DescriptorResult {
  if (!isRecord(input)) return { ok: false, reason: "a descriptor must be an object" };

  const unknown = Object.keys(input).filter(
    (key) =>
      ![
        "contextWindow",
        "maxOutputTokens",
        "supports",
        "cancellation",
        "rateLimits",
        "cost",
        "batching",
      ].includes(key),
  );
  if (unknown.length > 0) {
    // The fail-closed rule, applied to the descriptor's own keys rather than only to its values.
    return {
      ok: false,
      reason: `unknown descriptor field(s): ${unknown.join(", ")} — an unparsable descriptor disables the provider (§3.2)`,
    };
  }

  const contextWindow = positiveInt(input.contextWindow, "contextWindow");
  if (!contextWindow.ok) return contextWindow;
  const maxOutputTokens = positiveInt(input.maxOutputTokens, "maxOutputTokens");
  if (!maxOutputTokens.ok) return maxOutputTokens;
  if (maxOutputTokens.value >= contextWindow.value) {
    return {
      ok: false,
      reason: `'maxOutputTokens' (${maxOutputTokens.value}) must be smaller than 'contextWindow' (${contextWindow.value})`,
    };
  }

  if (!isRecord(input.supports))
    return { ok: false, reason: "'supports' must be an object of booleans" };
  const unknownSupports = Object.keys(input.supports).filter(
    (key) => !(SUPPORTED_FEATURES as readonly string[]).includes(key),
  );
  if (unknownSupports.length > 0) {
    return { ok: false, reason: `'supports' has unknown field(s): ${unknownSupports.join(", ")}` };
  }
  const supports = {} as Record<SupportedFeature, boolean>;
  for (const feature of SUPPORTED_FEATURES) {
    // Absent is `false` here, and that is the one default this parser is allowed: §3.1 says "Presence of a method is
    // not enough — the capability must be declared in `describe()`", so an undeclared feature is an unclaimed one.
    const value = input.supports[feature] ?? false;
    if (typeof value !== "boolean")
      return { ok: false, reason: `'supports.${feature}' must be a boolean` };
    supports[feature] = value;
  }

  if (!CANCELLATION_MODES.includes(input.cancellation as CancellationMode)) {
    return { ok: false, reason: `'cancellation' must be one of ${CANCELLATION_MODES.join(", ")}` };
  }

  const rateLimits = input.rateLimits;
  if (rateLimits !== null) {
    if (
      !isRecord(rateLimits) ||
      typeof rateLimits.rpm !== "number" ||
      typeof rateLimits.tpm !== "number"
    ) {
      return { ok: false, reason: "'rateLimits' must be { rpm, tpm } or null" };
    }
  }

  const cost = input.cost;
  if (cost !== null && cost !== "free-tier" && cost !== "local") {
    if (
      !isRecord(cost) ||
      typeof cost.promptPerMTok !== "number" ||
      typeof cost.completionPerMTok !== "number"
    ) {
      return {
        ok: false,
        reason:
          "'cost' must be { promptPerMTok, completionPerMTok }, 'free-tier', 'local', or null",
      };
    }
  }

  const batching = input.batching;
  if (batching !== null) {
    if (
      !isRecord(batching) ||
      typeof batching.maxRequestsPerSecond !== "number" ||
      batching.maxRequestsPerSecond <= 0
    ) {
      return { ok: false, reason: "'batching' must be { maxRequestsPerSecond } or null" };
    }
  }

  return {
    ok: true,
    descriptor: {
      contextWindow: contextWindow.value,
      maxOutputTokens: maxOutputTokens.value,
      supports,
      cancellation: input.cancellation as CancellationMode,
      rateLimits: rateLimits === null ? null : (rateLimits as { rpm: number; tpm: number }),
      cost: cost as ModelDescriptor["cost"],
      batching: batching === null ? null : (batching as { maxRequestsPerSecond: number }),
    },
  };
}

/** §4.3's last provider rule: "a capability that vanished since registration must produce
 *  `unsupported-capability`, not a silent degradation". Diffing two descriptors is the whole mechanism, and it belongs
 *  next to the parser so an adapter cannot re-implement it leniently. */
export function vanishedCapabilities(
  registered: ModelDescriptor,
  current: ModelDescriptor,
): SupportedFeature[] {
  return SUPPORTED_FEATURES.filter(
    (feature) => registered.supports[feature] && !current.supports[feature],
  );
}

/** A model id that is not in the set is a discovery event, not a config error: §4.3 says its descriptor is
 *  re-validated, which is the caller's job, and this function only says whether the set covers it. */
export function describesModel(
  descriptors: Readonly<Record<string, ModelDescriptor>>,
  modelId: string,
): boolean {
  return Object.hasOwn(descriptors, modelId);
}
