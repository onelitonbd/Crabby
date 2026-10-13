// `PROVIDERS_AND_TOOLS.md` §4.1's `availability` field: "Platform predicate; false yields a documented reason instead
// of a broken tool." The sentence has two halves, and the second is the reason this file exists — the answer a tool
// list gives when a desktop asks about `termux-sms-send` is not "no" but "no, and here is why", because C10-04 in
// `docs/review/CLI.md` promises "the reason for anything deferred" and a blank cell reads as a bug.
//
// The predicate is intentionally coarse. It answers only what the documents settle: the Termux:API tools need Termux,
// and nothing else in §4.2 is platform-conditional on the evidence available today. A finer answer needs the platform
// probe's real constraints (`packages/platform/detect.ts`'s `PLATFORM_CONSTRAINTS`), which is M-Platform's work, and a
// registry that guesses per-tool availability would be indistinguishable from one that invented it.

import type { ToolSpec } from "./tools.ts";

export type ToolRequirement = "any" | "termux";

export interface Availability {
  readonly available: boolean;
  readonly requires: ToolRequirement;
  /** Present exactly when `available` is false. §4.1's rule is that a false predicate is *explained*, so this is not
   *  an optional nicety — the route that serializes it refuses a false availability with no reason. */
  readonly reason?: string;
}

/** The tools whose only implementation is a Termux:API binary. Matched on the name the document gives them, not on
 *  the capability, because `device.clipboard` is also reachable from a desktop in principle. */
export function isTermuxTool(tool: string): boolean {
  return tool.startsWith("termux-");
}

export function requirementFor(spec: ToolSpec): ToolRequirement {
  return isTermuxTool(spec.tool) || (spec.aliases ?? []).some((alias) => isTermuxTool(alias))
    ? "termux"
    : "any";
}

export interface PlatformFactsLike {
  readonly isTermux: boolean;
}

export function availabilityFor(spec: ToolSpec, facts: PlatformFactsLike): Availability {
  const requires = requirementFor(spec);
  if (requires === "any") return { available: true, requires };
  if (facts.isTermux) return { available: true, requires };
  return {
    available: false,
    requires,
    reason: `'${spec.tool}' is a Termux:API tool; this platform has no Termux environment, so the binary it would call is not present`,
  };
}

/**
 * §4.2's deferrals, read out of the row's own note. `ext.install` with the executable kind says "Blocked in the first
 * release regardless of tier (D-038)", and that is a decision the row already carries — so the deferral list is
 * derived from the table instead of maintained beside it, which is the difference between a list that stays true and
 * one that becomes a second source of truth.
 */
export function deferralFor(
  spec: ToolSpec,
): { readonly deferred: true; readonly reason: string } | undefined {
  const notes = spec.notes ?? "";
  if (!/first release|not in this version|blocked/i.test(notes)) return undefined;
  return { deferred: true, reason: notes };
}

/** Which §4.1 record fields the registry cannot answer, and where they come from. A tool's `inputSchema`,
 *  `outputSchema`, `limits`, `idempotent`, and `sideEffects` are properties of the *runtime* that executes it — and since
 *  M2k such a runtime exists: `packages/tools` declares all five for the eight rows it implements (D-098). This list is
 *  still what `GET /tools` prints, because the Gateway composes no executor, so no route holds a declaration to merge into
 *  a registry row; `docs/CONSISTENCY_REVIEW.md` F-55 names the runner that will. Naming the gap in the response stays
 *  cheaper than inventing defaults: `sideEffects: "none"` for `file.delete` would be a lie a recovery path could act on. */
export const PENDING_RECORD_FIELDS: readonly string[] = [
  "inputSchema",
  "outputSchema",
  "limits",
  "idempotent",
  "sideEffects",
];

/**
 * The enabled state. §4.2's `shell.run` row carries "Capability itself is off by default" in its own note, which is a
 * statement about the default policy of a fresh install, and §6.2's preamble says a user may tighten. Nothing in this
 * build can *set* it — there is no configuration key for capability grants yet — so this returns the documented
 * default and says that is what it is. Once `config` grows a `permissions` section, this function is where the
 * lookup replaces the constant, and `basis` is the field that will change.
 */
export interface EnabledState {
  readonly enabled: boolean;
  readonly basis: "documented default";
  readonly reason?: string;
}

/** Exactly the capability §4.2's note names, and nothing inferred beside it. `shell.privileged` — the elevated row —
 *  is T3 and so needs an approval, but no document says its capability ships off, and "the sibling capability is
 *  probably off too" is the kind of inference that later reads as a documented rule. The gap is recorded as
 *  `docs/CONSISTENCY_REVIEW.md` F-34 rather than closed by a guess. */
export const OFF_BY_DEFAULT: readonly string[] = ["shell.run"];

export function enabledFor(spec: ToolSpec): EnabledState {
  const off = spec.capabilities.filter((capability) => OFF_BY_DEFAULT.includes(capability));
  if (off.length > 0) {
    return {
      enabled: false,
      basis: "documented default",
      reason: `${off.join(", ")} ${off.length === 1 ? "is" : "are"} off by default (PROVIDERS_AND_TOOLS.md §4.2); no configuration key can turn ${off.length === 1 ? "it" : "them"} on yet`,
    };
  }
  return { enabled: true, basis: "documented default" };
}
