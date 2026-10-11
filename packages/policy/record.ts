// The record a tool list shows. `PROVIDERS_AND_TOOLS.md` §4.1 fixes the fields every tool is described by — `id`,
// `version`, `description`, `inputSchema`, `outputSchema`, `capability`, `riskTier` + `tierRules`, `limits`,
// `idempotent`, `sideEffects`, `availability` — and this module produces that record for the fields the registry can
// answer today, naming the ones it cannot instead of filling them in.
//
// The shape lives here rather than in the Gateway because four interfaces read it: `GET /api/v1/tools`, `crabby tools
// ls` (C10-04), the Web's tools pane (W11-01, W11-02), and Telegram's `/tools` (G3-18) all promise "the same list",
// and one function producing one record is what makes that promise mechanical instead of aspirational.
//
// `pendingRecordFields` is the honest half of the design. `sideEffects: "none"` for `file.delete` would let a recovery
// path retry an irreversible action, and `inputSchema: {}` would read as "takes no arguments" — so the fields the M2
// tool runtime owns are reported as missing, which is a fact a UI can render and a test can assert disappears in M2.

import { createHash } from "node:crypto";
import type { ToolDeclaration } from "@crabby/api-contracts";
import type { PlatformFactsLike } from "./availability.ts";
import {
  type Availability,
  availabilityFor,
  deferralFor,
  type EnabledState,
  enabledFor,
  PENDING_RECORD_FIELDS,
} from "./availability.ts";
import type { Tier } from "./tiers.ts";
import type { ToolSpec } from "./tools.ts";
import { listExtensionTools, TOOL_REGISTRY } from "./tools.ts";

export interface ToolRecord {
  readonly id: string;
  /** The half of a split §4.2 row this record describes (`file.write` covers "new file", `file.edit` covers
   *  "existing"). Interfaces print it beside the id, because two rows with one name would be a contradiction. */
  readonly qualifier?: string;
  readonly aliases: readonly string[];
  /** Where the row came from: the checked-in table, or an extension registered at runtime. */
  readonly source: "builtin" | "extension";
  readonly capabilities: readonly string[];
  readonly capabilityNote?: string;
  readonly riskTier: Tier;
  /** §4.2's tier cell when it said more than one tier ("T2 per command"), kept because flattening it is a claim. */
  readonly tierText: string;
  /** W11-02's "escalation rules for that tool": the sentences of the row's note that name a tier. */
  readonly tierRules: readonly string[];
  readonly notes: string;
  readonly enabled: boolean;
  readonly enabledBasis: EnabledState["basis"];
  readonly enabledReason?: string;
  readonly availability: Availability;
  readonly deferred?: boolean;
  readonly deferralReason?: string;
  /** §4.1's five runtime fields, present exactly when a composed executor declares this tool (D-098). Absent rather than
   *  defaulted, for the reason this file's header gives: `sideEffects: "none"` on `file.delete` would let a recovery path
   *  retry an irreversible action, and `inputSchema: {}` would read as "takes no arguments". A merge fills a field in or
   *  leaves it out; it never guesses. */
  readonly inputSchema?: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly limits?: ToolDeclaration["limits"];
  readonly idempotent?: boolean;
  readonly sideEffects?: ToolDeclaration["sideEffects"];
  /** The §4.1 fields still unanswered *for this row*. Until an executor existed this was the same five names on all
   *  forty-five rows, which is what F-55 recorded; now it shrinks per row, so a client reads which half of the record is
   *  policy's and which half a runtime answered. An empty list is a claim that this row is fully described, and only a
   *  declaration can earn it. */
  readonly pendingRecordFields: readonly string[];
}

function tierRulesOf(spec: ToolSpec): { rules: string[]; prose: string } {
  const notes = spec.notes ?? "";
  if (notes === "") return { rules: [], prose: "" };
  const rules: string[] = [];
  const prose: string[] = [];
  for (const sentence of notes.split(/(?<=[.!?])\s+/)) {
    const trimmed = sentence.trim();
    if (trimmed === "") continue;
    (/\bT[0-3]\b/.test(trimmed) ? rules : prose).push(trimmed);
  }
  return { rules, prose: prose.join(" ") };
}

export function toolRecord(
  spec: ToolSpec,
  facts: PlatformFactsLike,
  source: ToolRecord["source"] = "builtin",
  declares?: (tool: string) => ToolDeclaration | undefined,
): ToolRecord {
  const availability = availabilityFor(spec, facts);
  const enabled = enabledFor(spec);
  const deferral = deferralFor(spec);
  const { rules, prose } = tierRulesOf(spec);
  const qualifier = spec.qualifier === undefined ? {} : { qualifier: spec.qualifier };
  const capabilityNote =
    spec.capabilityNote === undefined ? {} : { capabilityNote: spec.capabilityNote };
  const enabledReason = enabled.reason === undefined ? {} : { enabledReason: enabled.reason };
  const deferred =
    deferral === undefined ? {} : { deferred: true, deferralReason: deferral.reason };
  /** §4.1's other half, merged on the id the registry and the executor already share: `ToolDeclaration.name` is
   *  documented as "the key a merge happens on", so a declaration for a tool the registry never classified matches no row
   *  rather than inventing one, and `assertRegistrable` is the rule that keeps the two lists honest about each other.
   *  `outputSchema` stays absent when the executor omits it, because an empty schema is a check that always passes — its
   *  absence is the honest answer and the loop's own header makes the same argument. */
  const declared = declares?.(spec.tool);
  const merged =
    declared === undefined
      ? {}
      : {
          inputSchema: declared.inputSchema,
          ...(declared.outputSchema === undefined ? {} : { outputSchema: declared.outputSchema }),
          limits: declared.limits,
          idempotent: declared.idempotent,
          sideEffects: declared.sideEffects,
        };
  const answered = new Set(Object.keys(merged));
  return {
    id: spec.tool,
    ...qualifier,
    aliases: [...(spec.aliases ?? [])],
    source,
    capabilities: [...spec.capabilities],
    ...capabilityNote,
    riskTier: spec.tier,
    tierText: spec.tierText ?? spec.tier,
    tierRules: rules,
    notes: prose,
    enabled: enabled.enabled,
    enabledBasis: enabled.basis,
    ...enabledReason,
    availability,
    ...deferred,
    ...merged,
    // Per row rather than per registry, which is the whole of F-55's closing condition: a row an executor implements
    // answers what it can and names only what it still cannot, and a row nothing implements keeps naming all five.
    pendingRecordFields: PENDING_RECORD_FIELDS.filter((field) => !answered.has(field)),
  };
}

export function toolRecords(
  specs: readonly ToolSpec[],
  facts: PlatformFactsLike,
  source: ToolRecord["source"] = "builtin",
  declares?: (tool: string) => ToolDeclaration | undefined,
): ToolRecord[] {
  return specs.map((spec) => toolRecord(spec, facts, source, declares));
}

/** The whole list a client sees: the checked-in rows, then whatever an extension registered. Built in this order so a
 *  tool list reads the same on every interface and a terminal can diff it against another device's without sorting.
 *  `declares` is the composed executor's half of §4.1's record, handed in rather than imported: this package answers
 *  "what tier is this and who may do it", and which executor a process happens to have is a fact about the composition
 *  root that ran, not about policy. Passing nothing is the honest default and leaves every row naming all five fields. */
export function allToolRecords(
  facts: PlatformFactsLike,
  declares?: (tool: string) => ToolDeclaration | undefined,
): ToolRecord[] {
  return [
    ...toolRecords(TOOL_REGISTRY, facts, "builtin", declares),
    ...toolRecords(listExtensionTools(), facts, "extension", declares),
  ];
}

/** A digest of the registry as it will be printed. `crabby tools ls` and the Web's pane both show it, so two devices
 *  can tell whether they are looking at the same policy without diffing 45 rows by eye — which is the same reason
 *  `docs/INTERFACES_AND_API.md` §8 checks a generated matrix into the repository instead of describing one. */
export function registryDigest(records: readonly ToolRecord[]): string {
  const normalized = records
    .map(
      (record) =>
        `${record.id}${record.qualifier ? `(${record.qualifier})` : ""}:${record.riskTier}:${record.capabilities.join("+")}:${record.availability.available ? "a" : "-"}:${record.enabled ? "e" : "d"}`,
    )
    .sort()
    .join("\n");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}
