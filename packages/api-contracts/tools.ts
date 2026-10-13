// §4.1's tool record, and the split that makes it two parties' work rather than one file's. `PROVIDERS_AND_TOOLS.md`
// §4.1 describes every tool by ten fields; `packages/policy` holds the four that come from §4.2's table (capability,
// base tier, tier rules, availability) because that table is a document transcribed and diffed by `scripts/parity.ts`,
// and the five an *executor* owns are the ones `PENDING_RECORD_FIELDS` named as unanswerable until the runtime that
// executes a tool existed: `inputSchema`, `outputSchema`, `limits`, `idempotent`, `sideEffects`. This file is the shape
// those five arrive in, so a registry row and an executor's declaration can be merged by whoever serves `GET /tools`
// without one of them inventing the other's half.
//
// Two of the five are safety vocabulary rather than metadata, and are the reason this file exists at all instead of the
// declarations living inside `packages/tools`:
//
//   - `sideEffects` is what §6.2's cancellation evidence is computed from. D-089 made `effectsUncertain` `true` for
//     every tool step *because* nothing declared one, and said so in the code; a declaration is what turns that from a
//     constant into a fact, and a fact two packages read has to be a contract.
//   - `idempotent` is one of the two permissions §7.3 and D-065 give a resume ("only a step whose tool declares itself
//     idempotent or whose effect is recorded"). Until a tool declared it, the first half of that sentence had no
//     possible witness, which is why D-095's verdict could only ever answer from the log.
//
// `availability` is deliberately *not* here: §4.1 lists it, and `packages/policy/availability.ts` already answers it
// from the registry plus a platform predicate, so a second copy in an executor would be a second opinion about whether
// a tool exists on this device.

/** §4.1's `sideEffects` vocabulary, verbatim: `none` / `local` / `external` / `irreversible`. The order is the
 *  severity order the words already have, which is why `rankSideEffects` can compare two of them without a table. */
export const SIDE_EFFECTS = ["none", "local", "external", "irreversible"] as const;
export type SideEffects = (typeof SIDE_EFFECTS)[number];

export function isSideEffects(value: unknown): value is SideEffects {
  return (SIDE_EFFECTS as readonly string[]).includes(String(value));
}

/** Which of two declarations is the more consequential, for a caller that has to summarise a step it did not run.
 *  `irreversible` outranks `external` because §6.2's uncertainty is about an effect that *may* have happened, and an
 *  effect nobody can undo is the one a user has to be told about first. */
export function rankSideEffects(value: SideEffects): number {
  return SIDE_EFFECTS.indexOf(value);
}

/** D-064's tool output cap: "64 KiB inline, larger goes to a file in the session scratch with the path printed". It is
 *  the same number as `MAX_EVENT_PAYLOAD_BYTES` and the same sentence decided both, so a test asserts the two are equal
 *  rather than letting either file remember the other — one opinion, two names, each accurate where it is used: an
 *  executor truncates what it hands the model, the event store truncates what it hands a subscriber. */
export const MAX_TOOL_OUTPUT_BYTES = 64 * 1024;

/** §4.1's `limits` cell: "Timeout, max output bytes, max files, max processes; defaults per tool class in §5.2
 *  (D-074)". Only the first two are priced anywhere — `fs.*` 10 s, `net.fetch` 20 s, `shell.run` 120 s and D-064's
 *  64 KiB — so `maxFiles` and `maxProcesses` stay absent rather than receiving a plausible number, and the tools that
 *  would need them bound their work with the output cap and the deadline instead (which is a measurement, not a guess). */
export interface ToolLimits {
  /** The class default from §5.2, which the runtime enforces with its own deadline: one clock, and the declaration says
   *  which one it is rather than starting a second. */
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxFiles?: number;
  readonly maxProcesses?: number;
}

/** The executor's half of §4.1's record. `name` is the id §4.2's table uses, and it is the key a merge happens on:
 *  a declaration whose name is not in the registry is a tool policy has never classified, which §4.4's order makes
 *  unrunnable rather than merely undocumented. */
export interface ToolDeclaration {
  readonly name: string;
  /** §4.1's `version`, which the registration rule makes meaningful ("`describe` output is versioned with the API
   *  contract"): a first-party tool's version is the release's, so it is optional here and absent until a release
   *  exists to be versioned against. */
  readonly version?: string;
  /** Model-visible, and untrusted text if it came from an MCP server (§10) — which a first-party declaration is not, so
   *  this one is written by a reviewer rather than by a stranger. */
  readonly description: string;
  /** Validated *before* policy evaluation (§4.4's first step), so a schema mismatch can never be mistaken for a
   *  permission answer. A JSON Schema object, because that is what a provider's `parameters` field carries and what
   *  `PROVIDERS_AND_TOOLS.md` §3.1's `ProviderToolSpec` already speaks. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /** Optional in §4.1 and optional here, for the reason the loop's header gives: a result check with no schema is a
   *  check that always passes, so an absent one is honest and a present-but-empty one would not be. */
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly limits: ToolLimits;
  /** Whether re-running is safe, which §7.3 and D-065 read directly. A tool that cannot promise it says `false`, and
   *  `false` is the default the contract's own vocabulary makes unnecessary to invent: nothing here is idempotent
   *  unless its executor says so. */
  readonly idempotent: boolean;
  readonly sideEffects: SideEffects;
}
