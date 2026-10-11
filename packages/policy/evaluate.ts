// The decision function, in the order `PROVIDERS_AND_TOOLS.md` §4.4 fixes: "schema validation → capability check →
// tier/approval → execution → result validation. A tool never runs 'to see if it works'." Steps 4 and 5 belong to the
// runtime that executes the tool — since M2k that is `packages/tools` for eight of §4.2's rows (D-098) — so this module's
// job is the first three, and it returns a decision rather than performing work.
//
// Two things the pipeline must not do, both from `SECURITY.md` and both easy to get wrong in the direction of looking
// more permissive than intended:
//
//   - It must not queue an approval a client cannot answer. A capability *removed* by `crabby auth pair --restrict`
//     answers `unavailable` ("not available to this client"), never a prompt (§13).
//   - It must not treat T3 as "T2 with more steps". T3 approval is answerable in the TUI or Web only (§6.2), so from
//     Telegram the outcome is a refusal that says where to go, not a notification that waits forever.

import { baseOf, type CapabilityScope, capabilityFor, holdsGrant } from "./capabilities.ts";
import { type EvalContext, escalate, isIrreversible } from "./escalation.ts";
import { approvalTtlMs, rank, TIER_BEHAVIOR, type Tier } from "./tiers.ts";
import { builtinTool, resolveTool, type ToolSpec } from "./tools.ts";

export type ClientKind = "local" | "cli" | "tui" | "web" | "telegram" | "agent";

export interface PolicySubject {
  /** The capabilities this identity holds, parameters included: `fs.read:workspace`. */
  readonly grants: readonly string[];
  /** Capabilities `--restrict` removed from this identity. They are *not* in `grants`, and the difference is the whole
   *  reason this field exists: an ungranted capability is a denial the user can fix, a restricted one is a feature that
   *  is not available to this client, and the two must not print the same sentence. */
  readonly removedGrants?: readonly string[];
  readonly clientKind: ClientKind;
  readonly taskId: string;
}

export interface ToolCall {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  /** The tool's declared argument names, when a schema exists. §4.3: "Any tool receiving arguments it did not declare →
   *  reject before policy, so a schema mismatch can never be mistaken for permission." Passing this is M2's job, once
   *  tool schemas exist; until then a caller may omit it and the decision says so. */
  readonly declaredArgs?: readonly string[];
  /** What the runtime *observed* about this call, as distinct from what the caller asked for (D-099). Two of §4.3's
   *  escalations turn on facts only a party with a filesystem can answer — was this file already there, is that
   *  destination occupied — and §10's rule that "a declared field is never an authority" means the party asking for the
   *  permission cannot be the party supplying them. A separate field rather than extra keys in `args`, because `args` is
   *  checked against the tool's own schema: a fact smuggled in there is either rejected as an argument the tool never
   *  declared, or accepted as a declaration from the one party whose declaration §10 refuses. Absent means no executor
   *  answered, and the escalations that need one stay silent. */
  readonly facts?: Readonly<Record<string, unknown>>;
}

/** The fields §6.3 requires an approval request to carry, in the order the document lists them. */
export interface ApprovalRequest {
  readonly taskId: string;
  readonly tool: string;
  readonly tier: Tier;
  readonly summary: string;
  /** "the exact command or path or destination host" — one field, because §6.3 asks for exactly one of the three. */
  readonly exact: string;
  readonly effects: string;
  readonly reversibility: "reversible" | "uncertain" | "irreversible";
  readonly whatCouldGoWrong: string;
  readonly scope: "once";
  readonly ttlMs: number | undefined;
  readonly expiresAt: number;
  /** §6.3's binding: "a decision applies to *that* action with *those* arguments in *that* task". The hash is what a
   *  later comparison uses, and it is why no `scope: always` exists here. */
  readonly binding: string;
}

export type PolicyDecision =
  | {
      readonly outcome: "allow";
      readonly tier: Tier;
      readonly reasons: readonly string[];
      readonly behavior: string;
    }
  | {
      readonly outcome: "require-approval";
      readonly tier: Tier;
      readonly reasons: readonly string[];
      readonly behavior: string;
      readonly approval: ApprovalRequest;
    }
  | {
      readonly outcome: "deny";
      readonly class: "policy" | "validation";
      readonly tier: Tier | undefined;
      readonly reason: string;
      readonly reasons: readonly string[];
    }
  | {
      readonly outcome: "unavailable";
      readonly class: "platform-unsupported";
      readonly reason: string;
      readonly capability: string;
      readonly scope: CapabilityScope | undefined;
    };

function exactTarget(call: ToolCall): string {
  for (const key of ["command", "path", "url", "destination", "host", "recipient"]) {
    const value = call.args[key];
    if (typeof value === "string" && value !== "") return `${key}: ${value}`;
  }
  const keys = Object.keys(call.args).sort();
  return keys.length === 0 ? `${call.tool} with no arguments` : `${call.tool}(${keys.join(", ")})`;
}

function fingerprint(call: ToolCall, taskId: string): string {
  const pairs = (source: Readonly<Record<string, unknown>>) =>
    Object.keys(source)
      .sort()
      .map((key) => `${key}=${JSON.stringify(source[key]) ?? "undefined"}`);
  const observed = pairs(call.facts ?? {});
  // §6.3: "a decision applies to *that* action with *those* arguments in *that* task", so the task id is part of the
  // binding and not a column next to it. Two tasks asking for the same thing are two approvals.
  //
  // The observed facts are in the binding too, and separately bracketed so a reader can see which half is which: the fact
  // is part of what made the action the action the user priced. An approval signed for "replace a file that was already
  // there" (T2, §4.2) must not be spendable on "replace a file that was not", and D-084's comparison at the moment of
  // execution is the mechanism that says so — which only works if the fact is inside what gets compared.
  return `${taskId}:${call.tool}{${pairs(call.args).join(",")}}${
    observed.length === 0 ? "" : `(${observed.join(",")})`
  }`;
}

/** §4.4's step 1, and the only step that can reject without consulting the registry at all. */
function checkSchema(call: ToolCall): string | undefined {
  if (!call.declaredArgs) return undefined;
  const undeclared = Object.keys(call.args).filter((key) => !call.declaredArgs?.includes(key));
  return undeclared.length === 0
    ? undefined
    : `'${call.tool}' was given ${undeclared.map((k) => `'${k}'`).join(", ")}, which it does not declare`;
}

/**
 * The whole point of the skeleton: given who is asking and what they are asking for, say allow, approve, deny, or
 * "not here". `now` is injected because §6.3's expiry is a fact about the approval a test must be able to pin.
 */
export function evaluate(
  call: ToolCall,
  subject: PolicySubject,
  ctx: EvalContext,
  now = Date.now(),
): PolicyDecision {
  const schemaProblem = checkSchema(call);
  if (schemaProblem) {
    return {
      outcome: "deny",
      class: "validation",
      tier: undefined,
      reason: schemaProblem,
      reasons: [schemaProblem],
    };
  }

  const spec: ToolSpec | undefined = resolveTool(call.tool);
  if (!spec) {
    const reason = `'${call.tool}' is not in the tool registry, so it has no capability and no tier to enforce`;
    return { outcome: "deny", class: "policy", tier: undefined, reason, reasons: [reason] };
  }

  // Capability check, before any tier arithmetic: an ungranted capability must not be laundered into an approval.
  //
  // The registry records a capability by base name (`fs.read`), because §4.2 writes it that way, so this checks the
  // *kind* of access. Which instance of it — whether `fs.read:workspace` reaches the path in this call — is decided by
  // the path judgement in `paths.ts`, which only knows about the roots this identity configured. Splitting it that way
  // is deliberate: a grant whose parameter was checked twice would drift out of agreement with the adapter, which is
  // the failure mode §8 names when it says the tool "must not accept a caller-provided path that it then re-interprets".
  for (const grant of spec.capabilities) {
    if (holdsGrant(subject.grants, grant)) continue;
    const removed = (subject.removedGrants ?? []).some((entry) => baseOf(entry) === baseOf(grant));
    if (removed) {
      return {
        outcome: "unavailable",
        class: "platform-unsupported",
        reason: `'${grant}' is not available to this client: it was removed when this identity was paired (§13)`,
        capability: grant,
        scope: capabilityFor(grant)?.scope,
      };
    }
    const reason = `'${call.tool}' needs '${grant}', which this identity does not hold`;
    return { outcome: "deny", class: "policy", tier: spec.tier, reason, reasons: [reason] };
  }

  const { tier, reasons } = escalate(
    spec,
    call.args,
    { ...ctx, grants: subject.grants },
    call.facts,
  );
  const behavior = TIER_BEHAVIOR[tier];

  if (tier === "T0" || tier === "T1") {
    // §6.2's T1 row is "auto-allow **if the permission is granted**; batch notification". The grant check above is
    // that `if`, and `ext.list`-style rows with no capability have nothing to check, which is why they land here too.
    return { outcome: "allow", tier, reasons, behavior };
  }

  // T3 is answerable in the TUI or Web only. A Telegram client cannot answer it, and queuing it would be the deadlock
  // §13 refuses for a different reason — same shape, same refusal.
  if (tier === "T3" && subject.clientKind === "telegram") {
    const reason =
      `'${call.tool}' is T3, and T3 approval is not answerable from Telegram (§6.2). ` +
      "Answer it in the TUI or the Web control UI.";
    return { outcome: "deny", class: "policy", tier, reason, reasons: [...reasons, reason] };
  }

  const ttlMs = approvalTtlMs(tier);
  const irreversible = isIrreversible(spec.tool, call.args) || tier === "T3";
  const approval: ApprovalRequest = {
    taskId: subject.taskId,
    tool: call.tool,
    tier,
    summary: `${call.tool} — ${spec.notes || (builtinTool(call.tool)?.capabilityNote ?? "no description")}`,
    exact: exactTarget(call),
    effects:
      reasons.length > 0
        ? reasons.join("; ")
        : `${spec.capabilities.join(" + ")} on ${exactTarget(call)}`,
    reversibility: irreversible ? "irreversible" : "uncertain",
    whatCouldGoWrong: whatCouldGoWrong(call, spec, tier),
    scope: "once",
    ttlMs,
    expiresAt: ttlMs === undefined ? 0 : now + ttlMs,
    binding: fingerprint(call, subject.taskId),
  };
  return { outcome: "require-approval", tier, reasons, behavior, approval };
}

/** §6.3's "explicit 'what could go wrong'" is a per-tier and per-argument sentence, not a per-tool one, and the
 *  documents do not contain a table for it. What is written here is therefore derived from the two things they do
 *  state — the capability's blast radius and the tier's meaning — rather than invented per tool. A registry note that
 *  already says why (many do) is quoted instead, which is why this function prefers `spec.notes`. */
function whatCouldGoWrong(call: ToolCall, spec: ToolSpec, tier: Tier): string {
  const fromDoc = spec.notes && rank(tier) >= 2 ? spec.notes : "";
  const scope = spec.capabilities
    .map((grant) => capabilityFor(grant)?.grants)
    .filter(Boolean)
    .join("; ");
  const parts = [
    fromDoc,
    scope,
    tier === "T3"
      ? "this is irreversible or broad enough that Crabby will not do it without a human, once, for these arguments"
      : "the action is not reversible by Crabby on its own, and the approval covers only this task and these arguments",
  ].filter(Boolean);
  return `${parts.join(". ")}${call.tool === "shell.run" ? ". A chained or redirected command is judged as its worst part" : ""}`;
}
