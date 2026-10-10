// Every built-in tool's capability set and base tier, transcribed from `PROVIDERS_AND_TOOLS.md` §4.2 — the table that
// settled them ("the per-tool capability and base-tier table above closes O-020 as a documentation question"). Nothing
// in the `TOOL_REGISTRY` rows below is a judgement call: `scripts/parity.ts` diffs this list against §4.2 row by row,
// so a tier can only move by the document moving first, in a commit a reviewer reads.
//
// A row's `tier` is the **base** tier. §4.2 writes some cells as `**T2** per command` or `**T1** (confirmed)`, so
// `tierText` keeps the cell verbatim wherever it says more than a single tier can — flattening those cells is how a
// document gets silently reinterpreted. Argument-dependent escalation ("Bumped to T2 when overwriting a file Crabby
// did not create") is `escalation.ts`, and §4.3 decides which of the two wins.
//
// Three rows carry no capability because §4.2's capability cell for them is the word "read-only" (`tunnel.status`,
// `ext.list`/`ext.info`, `memory.search`). That is recorded rather than tidied up: `SECURITY.md` §6.1 defines
// `ext.list` and `memory.read` capabilities, so the two documents disagree about whether a grant is needed, and
// `docs/CONSISTENCY_REVIEW.md` F-33 keeps the disagreement visible. The registry follows §4.2, which is the document that
// owns per-tool capability assignment; the disagreement is about whether a *second* check should exist, and adding one
// would silently deny tools that are supposed to work.

import { baseOf, isKnownCapabilityBase } from "./capabilities.ts";
import { UNCLASSIFIED_TIER } from "./shell.ts";
import { isTier, type Tier } from "./tiers.ts";

export interface ToolSpec {
  /** The name an agent or an interface calls it by. */
  readonly tool: string;
  /** §4.2 splits one tool across two rows when its arguments change its risk (`file.write (new file)` alongside
   *  `file.edit (existing)`). The parenthetical is kept rather than dropped, because it is why the row exists. */
  readonly qualifier?: string;
  /** Other names §4.2 gives in the same row (`file.list` / `file.stat`), so `toolFor("file.stat")` resolves instead of
   *  looking unclassified. */
  readonly aliases?: readonly string[];
  readonly capabilities: readonly string[];
  /** The document's own words, when a capability cell did not name a capability from the registry. `config.get` reads
   *  "`config.write`-independent read", which is a statement that it needs *no* capability — not a grant of one. */
  readonly capabilityNote?: string;
  readonly tier: Tier;
  /** The raw tier cell, for when it said something `tier` cannot carry. */
  readonly tierText?: string;
  /** §4.2's notes cell. Absent means the row's last column was empty — there is no
   *  second sentence to quote, which is a fact worth keeping distinct from filler. */
  readonly notes?: string;
}

// prettier-ignore
export const TOOL_REGISTRY: readonly ToolSpec[] = [
  {
    tool: "file.read",
    capabilities: ["fs.read"],
    tier: "T0",
    notes:
      "Within workspace. Denied outright on the SECURITY.md §8 sensitive deny-list even at T0 — reading ~/.ssh is not a 'read' operation.",
  },
  {
    tool: "file.list",
    aliases: ["file.stat"],
    capabilities: ["fs.read"],
    tier: "T0",
    notes: "Same deny-list applies to names.",
  },
  {
    tool: "file.write",
    qualifier: "new file",
    capabilities: ["fs.write"],
    tier: "T1",
    notes: "New paths inside root.",
  },
  {
    tool: "file.edit",
    qualifier: "existing",
    capabilities: ["fs.write"],
    tier: "T1",
    notes: "Bumped to T2 when overwriting a file Crabby did not create.",
  },
  {
    tool: "file.delete",
    capabilities: ["fs.write"],
    tier: "T2",
    notes:
      "T3 outside the workspace, or on the deny-list, or recursive on directories. Prefer trash/rename.",
  },
  {
    tool: "file.move",
    capabilities: ["fs.read", "fs.write"],
    tier: "T1",
    notes: "T2 across roots or onto an existing target.",
  },
  {
    tool: "fs.search",
    capabilities: ["fs.read"],
    tier: "T0",
    notes: "Content search results are untrusted data.",
  },
  { tool: "session.list", aliases: ["session.read"], capabilities: ["session.read"], tier: "T0" },
  { tool: "session.rename", capabilities: ["session.write"], tier: "T1" },
  {
    tool: "task.create",
    capabilities: ["task.create"],
    tier: "T1",
    notes:
      "T2 if the new task itself carries T2 steps; the task inherits its own tier, it does not inherit the caller's.",
  },
  { tool: "task.status", aliases: ["task.history"], capabilities: ["task.read"], tier: "T0" },
  {
    tool: "task.cancel",
    capabilities: ["task.cancel"],
    tier: "T1",
    notes: "T2 for cross-session or 'cancel all'; per ARCHITECTURE.md §10.",
  },
  {
    tool: "config.get",
    capabilities: [],
    capabilityNote: "config.write-independent read",
    tier: "T0",
    notes: "Secret *names* only, never values.",
  },
  {
    tool: "config.set",
    capabilities: ["config.write"],
    tier: "T3",
    notes: "Includes changing permissions, roots, or retention.",
  },
  { tool: "tunnel.status", capabilities: [], capabilityNote: "read-only", tier: "T0" },
  {
    tool: "tunnel.enable",
    aliases: ["tunnel.stop"],
    capabilities: ["tunnel.enable"],
    tier: "T3",
    notes: "Must list which paired identities become reachable (SECURITY.md §13).",
  },
  {
    tool: "ext.list",
    aliases: ["ext.info"],
    capabilities: [],
    capabilityNote: "read-only",
    tier: "T0",
  },
  { tool: "ext.install", capabilities: ["ext.install"], tier: "T2", notes: "Content-only kinds." },
  {
    tool: "ext.install",
    qualifier: "executable kind",
    capabilities: ["ext.execute"],
    tier: "T3",
    notes: "Blocked in the first release regardless of tier (D-038).",
  },
  {
    tool: "ext.uninstall",
    capabilities: ["ext.install"],
    tier: "T2",
    notes: "--purge-data is T3.",
  },
  {
    tool: "mcp.connect",
    aliases: ["mcp.tools"],
    capabilities: ["ext.install"],
    tier: "T2",
    notes: "Shows exact command line or URL.",
  },
  {
    tool: "net.fetch",
    capabilities: ["net.egress"],
    tier: "T2",
    notes: "T1 only for a user-curated allow-list; response is untrusted content.",
  },
  {
    tool: "http.request",
    qualifier: "non-GET",
    capabilities: ["net.egress"],
    tier: "T2",
    notes: "Any method that mutates remote state; carries destination host in the approval text.",
  },
  {
    tool: "provider.invoke",
    capabilities: ["provider.invoke"],
    tier: "T1",
    notes: "T2 when the selected model is paid (provider.billing).",
  },
  {
    tool: "shell.run",
    capabilities: ["shell.run"],
    tier: "T2",
    tierText: "T2 per command",
    notes:
      "Capability itself is off by default. Tier computed per command, not per tool; escalation table in §4.3.",
  },
  {
    tool: "shell.run",
    qualifier: "elevated",
    capabilities: ["shell.privileged"],
    tier: "T3",
    notes: "Package install/remove, service control, system config.",
  },
  {
    tool: "process.spawn",
    capabilities: ["shell.run"],
    tier: "T2",
    tierText: "T2 / T0",
    notes: "Long-running processes must be cancellable and re-attachable after restart.",
  },
  {
    tool: "process.list",
    capabilities: ["shell.run"],
    tier: "T0",
    tierText: "T2 / T0",
    notes: "The second name and the second tier of the same §4.2 cell.",
  },
  {
    tool: "memory.save",
    capabilities: ["memory.write"],
    tier: "T1",
    tierText: "T1 (confirmed)",
    notes:
      "Auto-memory is T1; a memory whose content originates from untrusted external material stays T2 until the user confirms — writing injection text into durable memory is the poisoning path (SECURITY.md §10).",
  },
  { tool: "memory.search", capabilities: [], capabilityNote: "read-only", tier: "T0" },
  {
    tool: "memory.delete",
    capabilities: ["memory.delete"],
    tier: "T2",
    notes: "T3 for bulk or 'forget everything about X' (see docs/DATA_AND_MEMORY.md §7).",
  },
  {
    tool: "history.export",
    capabilities: ["session.read"],
    tier: "T2",
    tierText: "T2 (confirmed)",
    notes:
      "Leaves the controlled store; may contain third-party content and secrets that were quoted into messages. Redaction runs before the file is written (§4.4).",
  },
  {
    tool: "history.deleteConversation",
    capabilities: ["session.write"],
    tier: "T3",
    notes: "Irreversible relative to derived memories.",
  },
  {
    tool: "notify.send",
    qualifier: "Telegram out",
    capabilities: ["net.egress"],
    tier: "T2",
    notes: "Sending to a new recipient is T2; publishing is T2/T3 by audience size.",
  },
  {
    tool: "git.read",
    qualifier: "status/diff/log",
    capabilities: ["fs.read"],
    tier: "T0",
    notes: "Read-only, inside repo root.",
  },
  { tool: "git.commit", capabilities: ["fs.write"], tier: "T1", notes: "Local, reversible." },
  {
    tool: "git.push",
    capabilities: ["net.egress"],
    tier: "T2",
    notes: "T3 with force, or to a protected branch.",
  },
  {
    tool: "termux-notify",
    capabilities: ["device.notify"],
    tier: "T1",
    notes: "Benign; no data leaves the device.",
  },
  { tool: "termux-sms-send", capabilities: ["device.sms"], tier: "T3", notes: "D-033." },
  {
    tool: "termux-contact-list",
    capabilities: ["device.contacts"],
    tier: "T3",
    notes: "Disclosure into context is the risk (EXTENSIONS.md §15 area, SECURITY.md §15).",
  },
  {
    tool: "termux-camera-photo",
    aliases: ["termux-location", "sensor read"],
    capabilities: ["device.camera", "device.location", "device.sensor"],
    tier: "T3",
    notes: "D-033, per-capability enablement.",
  },
  {
    tool: "termux-battery-status",
    aliases: ["termux-wifi-connectioninfo", "termux-torch", "termux-vibrate"],
    capabilities: ["device.sensor", "device.control"],
    tier: "T1",
    notes: "Low consequence; still opt-in per capability.",
  },
  {
    tool: "cron.schedule",
    capabilities: [],
    capabilityNote: "config.write-adjacent",
    tier: "T2",
    notes:
      "Confirmed: creating a timer is T2, and every step inside the job is still evaluated against policy each time it runs — a schedule never inherits or pre-buys approval. Editing an existing job to add T3 steps, or changing what it targets, is T3. See §4.5.",
  },
  {
    tool: "screenshot",
    aliases: ["clipboard.read"],
    capabilities: ["device.screen", "device.clipboard"],
    tier: "T2",
    notes: "Clipboard is a notorious secret carrier; reading it deserves to be visible.",
  },
  { tool: "clipboard.write", capabilities: ["device.clipboard"], tier: "T2" },
] as const;

/** The §4.2 rows that name several tools in one cell, resolved back to the row that describes them all. */
const ALIAS_INDEX = new Map<string, ToolSpec>();
for (const spec of TOOL_REGISTRY) {
  for (const alias of spec.aliases ?? []) ALIAS_INDEX.set(alias, spec);
}

export function builtinTool(name: string): ToolSpec | undefined {
  return TOOL_REGISTRY.find((spec) => spec.tool === name) ?? ALIAS_INDEX.get(name);
}

/**
 * An imported tool's tier, per `SECURITY.md` §5 and `EXTENSIONS.md`: "an imported tool is treated as unknown until a
 * human approves it … and inherits **T2** until explicitly re-classified". T2 is the floor and never the ceiling: an
 * extension may declare itself riskier, and §4.3 escalates from there on arguments. That is why this function can only
 * move a tier *up* from `UNCLASSIFIED_TIER` — a declared `T0` on an unreviewed import is the exact move the sentence
 * forbids, so it is read as "no declaration".
 */
export function extensionTier(
  declared: unknown,
): { ok: true; tier: Tier } | { ok: false; reason: string } {
  if (declared === undefined) return { ok: true, tier: UNCLASSIFIED_TIER };
  if (!isTier(declared)) return { ok: false, reason: `'${String(declared)}' is not a tier` };
  return { ok: true, tier: raiseFromFloor(declared) };
}

function raiseFromFloor(declared: Tier): Tier {
  return declared === "T0" || declared === "T1" ? UNCLASSIFIED_TIER : declared;
}

export interface RegistrationRequest {
  readonly tool: string;
  readonly capabilities: readonly string[];
  readonly tier?: unknown;
  readonly source: "extension" | "skill" | "plugin";
}

export type RegistrationResult = { ok: true; spec: ToolSpec } | { ok: false; reason: string };

/**
 * The gate DEVELOPMENT §5 names as an example test — "deny unclassified tools at registration". Its two refusals are
 * the whole security property of the extension surface: a capability outside the vocabulary cannot be granted at all,
 * and a tool that arrives without a tier does not get to run. Refusing at *registration* rather than at *call* is the
 * part worth defending: a missing tier found at call time is a bug report, and a missing tier found at registration
 * time is an install that failed loudly.
 */
export function registerTool(request: RegistrationRequest): RegistrationResult {
  if (builtinTool(request.tool)) {
    return {
      ok: false,
      reason: `'${request.tool}' is a built-in tool; an extension may not replace it`,
    };
  }
  if (request.capabilities.length === 0) {
    return {
      ok: false,
      reason: `'${request.tool}' declares no capability, so policy could not name what it asks for`,
    };
  }
  for (const declared of request.capabilities) {
    if (!isKnownCapabilityBase(declared)) {
      return {
        ok: false,
        reason: `'${declared}' is not in the capability vocabulary, so '${request.tool}' cannot be granted it`,
      };
    }
    if (baseOf(declared) !== declared) {
      return {
        ok: false,
        reason: `'${request.tool}' declares '${declared}': a tool declares a capability, not a scope`,
      };
    }
  }
  const tier = extensionTier(request.tier);
  if (!tier.ok)
    return { ok: false, reason: `'${request.tool}' declares an invalid tier: ${tier.reason}` };
  const spec: ToolSpec = {
    tool: request.tool,
    capabilities: request.capabilities,
    tier: tier.tier,
    notes: `registered from a ${request.source}; ${UNCLASSIFIED_TIER} floor until a human re-classifies it`,
  };
  EXTENSION_TOOLS.set(request.tool, spec);
  return { ok: true, spec };
}

/** Where an imported tool lands. Separate from `TOOL_REGISTRY` so the checked-in table stays a literal a human can
 *  diff, and so `crabby tools ls` can say which rows came from an extension. */
const EXTENSION_TOOLS = new Map<string, ToolSpec>();

export function extensionTool(name: string): ToolSpec | undefined {
  return EXTENSION_TOOLS.get(name);
}

export function resolveTool(name: string): ToolSpec | undefined {
  return builtinTool(name) ?? extensionTool(name);
}

/** Every registered extension tool, in registration order. The route and `tools ls` print these after the built-in
 *  rows, marked by source, because a row that arrived from an extension is a different kind of fact than one that
 *  came from the checked-in table. */
export function listExtensionTools(): readonly ToolSpec[] {
  return [...EXTENSION_TOOLS.values()];
}

/** For `crabby tools ls`: every known row, extensions included. */
export function allTools(): readonly ToolSpec[] {
  return [...TOOL_REGISTRY, ...EXTENSION_TOOLS.values()];
}

export function clearExtensionTools(): void {
  EXTENSION_TOOLS.clear();
}

/**
 * §4.3's last bullet, expressed as a type: policy is asked about a tool, and a tool it does not know is not "no tier"
 * but "a question". Returning `undefined` instead of a default is what keeps the decision with the caller — an
 * unclassified built-in name is a registry bug (fail the test), while an unclassified extension name is an unapproved
 * import (refuse the call), and a blanket default would silently pick one of those two behaviours for both.
 */
export function tierFor(name: string): Tier | undefined {
  return resolveTool(name)?.tier;
}
