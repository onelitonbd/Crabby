// The four risk tiers of `SECURITY.md` §6.2, and the two rules that make a tier mean something: a tool may raise its
// own tier and never lower it, and configuration may raise strictness but never below the tier's floor. Both are
// expressed as functions rather than as comments, because the failure they prevent is a caller *noticing* the rule
// and deciding to make an exception.

export const TIERS = ["T0", "T1", "T2", "T3"] as const;
export type Tier = (typeof TIERS)[number];

export function isTier(value: unknown): value is Tier {
  return typeof value === "string" && (TIERS as readonly string[]).includes(value);
}

export function rank(tier: Tier): number {
  return TIERS.indexOf(tier);
}

/** §6.2's "Default behavior" column, in the one place it is allowed to be read from. */
export const TIER_BEHAVIOR: Record<Tier, string> = {
  T0: "auto-allow, audited",
  T1: "auto-allow if the permission is granted; batch notification",
  T2: "explicit approval with full context; expiring",
  T3: "explicit approval in the TUI or Web (not Telegram-only); shows exact command/path/host; irreversible ones say so",
};

/** T3 has no relaxation path in the first release (§6.2, `PROVIDERS_AND_TOOLS.md` §4.2's preamble), so "config may
 *  raise strictness" is a one-directional ladder with a floor that configuration cannot dig under. */
export function raiseOnly(base: Tier, requested: Tier | undefined): Tier {
  if (requested === undefined) return base;
  return rank(requested) > rank(base) ? requested : base;
}

export function maxTier(...tiers: readonly Tier[]): Tier {
  return tiers.reduce<Tier>((best, tier) => (rank(tier) > rank(best) ? tier : best), "T0");
}

/** D-064 (closing O-041): the more an approval grants, the less time it stays open. T0 and T1 need no approval, so
 *  they carry no expiry — the absence is deliberate, and `approvalTtlMs` returns `undefined` rather than a number a
 *  caller could mistake for a promise. */
export const APPROVAL_TTL_MS: Partial<Record<Tier, number>> = {
  T1: 15 * 60_000,
  T2: 10 * 60_000,
  T3: 5 * 60_000,
};

export function approvalTtlMs(tier: Tier): number | undefined {
  return APPROVAL_TTL_MS[tier];
}
