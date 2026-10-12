// The capability vocabulary of `SECURITY.md` §6.1, as data. The document says the names are "an initial proposed
// vocabulary (exact names are an implementation decision)", so this file *is* that decision, and `scripts/parity.ts`
// checks it against §6.1 row by row — the registry and the document may not drift apart in either direction, which is
// the same rule that keeps `DECISIONS.md` §2's table honest.
//
// Why a registry at all: policy is a *named-capability* system ("Permissions are named capabilities, not free-form
// text"), so the list has to be closed. A string that is not in here cannot be granted, cannot be asked for, and
// cannot appear in a parity row.

/** The four parameterized families §6.1 writes as `name:<slot>`. A grant carries its parameter (`fs.read:workspace`),
 *  and the parameter is part of the grant — `fs.read:workspace` never authorizes a read in `~/`, and the *host set*
 *  form is why `net.egress` can be T1 for a curated list and T2 for anything else (`PROVIDERS_AND_TOOLS.md` §4.2). */
import type { ClientInterface } from "@crabby/api-contracts";

export type CapabilityScope = "none" | "root" | "hostset" | "device";

export interface CapabilitySpec {
  readonly name: string;
  readonly scope: CapabilityScope;
  /** §6.1's "Grants" column, kept short and quotable: it is printed by `crabby tools ls` and by approval text. */
  readonly grants: string;
  /** `auth.manage` is local-only by construction, and that is a security rule rather than a UI preference. */
  readonly localOnly?: boolean;
  /** Whether a *remote* client may ever hold it. Everything except `auth.manage` and `config.write` is answerable
   *  remotely in principle; the field exists so the answer is declared, not inferred. */
  readonly grantsRemote?: boolean;
}

export const CAPABILITIES: readonly CapabilitySpec[] = [
  { name: "session.read", scope: "none", grants: "Read conversation and session state" },
  { name: "session.write", scope: "none", grants: "Modify conversation and session state" },
  { name: "task.create", scope: "none", grants: "Start a task" },
  { name: "task.cancel", scope: "none", grants: "Cancel a task" },
  { name: "task.read", scope: "none", grants: "Inspect task state, history, and results" },
  { name: "fs.read", scope: "root", grants: "Read files inside one configured root" },
  { name: "fs.write", scope: "root", grants: "Write files inside one configured root" },
  {
    name: "net.egress",
    scope: "hostset",
    grants: "Outbound network from tools, scoped by host set",
  },
  { name: "shell.run", scope: "none", grants: "Execute commands through the shell tool" },
  {
    name: "shell.privileged",
    scope: "none",
    grants: "Commands touching package managers, services, system config",
  },
  { name: "provider.invoke", scope: "none", grants: "Call a provider" },
  { name: "provider.billing", scope: "none", grants: "Call a paid endpoint" },
  { name: "memory.read", scope: "none", grants: "Search and read memory entries" },
  { name: "memory.write", scope: "none", grants: "Persist long-term memory" },
  { name: "memory.delete", scope: "none", grants: "Purge long-term memory" },
  { name: "ext.list", scope: "none", grants: "Enumerate installed extensions and their metadata" },
  {
    name: "ext.read",
    scope: "none",
    grants: "Read an extension's own manifest, docs, and conversion reports",
  },
  { name: "ext.install", scope: "none", grants: "Install an extension" },
  { name: "ext.execute", scope: "none", grants: "Run external code" },
  { name: "config.read", scope: "none", grants: "Read non-secret configuration" },
  {
    name: "config.write",
    scope: "none",
    grants: "Change configuration, including security settings",
  },
  {
    name: "tunnel.enable",
    scope: "none",
    grants: "Expose the Gateway remotely",
    grantsRemote: false,
  },
  {
    name: "auth.manage",
    scope: "none",
    grants: "Create, list, and revoke paired client identities",
    localOnly: true,
    grantsRemote: false,
  },
  // `SECURITY.md` §6.1 names exactly these nine, each "a distinct grant" — no tenth. They are complete names rather
  // than a `device:<slot>` family, which is why their scope is `none`: the *capability* is the device, so there is
  // nothing left to parameterize, and a grant of `device.` with no name is the kind of half-name that becomes a
  // wildcard by accident.
  { name: "device.notify", scope: "none", grants: "Post a device notification" },
  {
    name: "device.control",
    scope: "none",
    grants: "The small physical controls: torch, vibrate, volume, and kin",
  },
  { name: "device.sensor", scope: "none", grants: "Read a sensor, battery, or network state" },
  { name: "device.screen", scope: "none", grants: "Take a screenshot" },
  { name: "device.clipboard", scope: "none", grants: "Read or write the clipboard" },
  { name: "device.sms", scope: "none", grants: "Send an SMS" },
  { name: "device.contacts", scope: "none", grants: "Read the contacts list" },
  { name: "device.camera", scope: "none", grants: "Take a photo" },
  { name: "device.location", scope: "none", grants: "Read location" },
] as const;

export const CAPABILITY_NAMES: readonly string[] = CAPABILITIES.map((c) => c.name);

const BY_NAME = new Map(CAPABILITIES.map((c) => [c.name, c]));

export function capabilityFor(name: string): CapabilitySpec | undefined {
  return BY_NAME.get(baseOf(name));
}

/** `fs.read:workspace` → `fs.read`. A grant's parameter is kept where it is used (the decision carries it), because
 *  the vocabulary is about *what kind* of access a capability is; the parameter is about *which* instance. */
export function baseOf(grant: string): string {
  const colon = grant.indexOf(":");
  return colon === -1 ? grant : grant.slice(0, colon);
}

export function scopeOf(grant: string): CapabilityScope {
  return BY_NAME.get(baseOf(grant))?.scope ?? "none";
}

export function parameterOf(grant: string): string | undefined {
  const colon = grant.indexOf(":");
  if (colon === -1) return undefined;
  const parameter = grant.slice(colon + 1).trim();
  // `fs.read:` is written by hand more often than anyone wants to admit, and it means the same thing as no parameter
  // at all — so it is normalized here, before the well-formedness rule can be satisfied by an empty string.
  return parameter === "" ? undefined : parameter;
}

/** Whether `name` is a capability the vocabulary knows, ignoring any parameter. A tool *declares* a base name
 *  (`fs.read`) while a client *holds* a parameterized grant (`fs.read:workspace`), and `isWellFormedGrant` is the rule
 *  for the second of those. Validating a declaration with the grant rule would demand that a tool name every root it
 *  is allowed to serve, which is the user's configuration, not the tool's. */
export function isKnownCapabilityBase(name: string): boolean {
  return BY_NAME.has(baseOf(name));
}

/** A grant is well-formed only if its base exists *and* a scoped family carries a parameter: `fs.read` with no root
 *  would mean "every root", which is the one thing a scoped capability may not mean. Refusing it here is cheaper than
 *  explaining a whole-filesystem grant later. */
export function isWellFormedGrant(grant: string): { ok: true } | { ok: false; reason: string } {
  const spec = capabilityFor(grant);
  if (!spec) return { ok: false, reason: `'${baseOf(grant)}' is not in the capability vocabulary` };
  if (spec.scope !== "none" && parameterOf(grant) === undefined) {
    return {
      ok: false,
      reason: `'${grant}' names a ${spec.scope}-scoped capability with no ${spec.scope}`,
    };
  }
  if (spec.scope === "none" && parameterOf(grant) !== undefined) {
    return { ok: false, reason: `'${grant}' carries a parameter, but '${spec.name}' takes none` };
  }
  return { ok: true };
}

export function holdsGrant(grants: readonly string[], wanted: string): boolean {
  const target = baseOf(wanted);
  const parameter = parameterOf(wanted);
  return grants.some((held) => {
    if (baseOf(held) !== target) return false;
    if (parameter === undefined) return true;
    return parameterOf(held) === parameter;
  });
}

/** The two capabilities §9 keeps off a fresh install. Named once rather than inlined in a filter, because the sentence
 *  that excludes them is one sentence and the code implementing it should be one line a reviewer can check against it. */
const NOT_DEFAULT: readonly string[] = ["shell.run", "shell.privileged"];

/** The baseline capability set an identity paired for one interface holds. Every rule here is a sentence in a document
 *  rather than a preference, and the three of them pull in different directions, which is why they are stated:
 *
 *  1. **Parity.** D-005 keeps feature parity "by keeping capability identical and only adapting presentation", and
 *     §5.3 says the interface label "may only narrow capabilities". So the baseline is the whole vocabulary for every
 *     interface, and nothing is withheld from a surface for being a terminal rather than a browser.
 *  2. **Locality.** `grantsRemote: false` and `localOnly` are withheld from an interface whose requests do not
 *     originate on the Gateway's own host. In v1 that is `telegram` alone — a bot's requests arrive from Telegram's
 *     servers, while the other three reach the loopback listener `requireLoopback` guards (D-097) — and §5.3's rule is
 *     that a remote client never receives a wider set than a local one. Both fields exist so that answer is declared
 *     rather than inferred.
 *
 *     D-032 is the row a reviewer will bring to this rule — "Remote access adds no capability narrowing by default
 *     … Interface type may narrow only what the user configures, never what the core allows" — and withholding
 *     two names from `telegram` is narrowing no user configured. It is not a contradiction, and the reason is worth
 *     stating rather than leaving to be worked out: §6.1's table *is* the core's allowance, and its `auth.manage` row
 *     reads "Local-only by construction: no remote or agent-facing path may grant it". The core does not allow a remote
 *     identity to hold the capability, so there is nothing below that for an interface label to narrow to. What D-032
 *     forbids is a label inventing a restriction the documents do not state, and this function invents none: every name
 *     withheld here is withheld by a row that says so.
 *  3. **Shell.** `NOT_DEFAULT` is withheld from *every* baseline. §9: shell execution is "never enabled by default for
 *     a fresh install; enabling it is an explicit act", and the M2 phase row says the same of `crabby init`. A baseline
 *     carrying them would put arbitrary command execution one pairing away on a fresh install, which is the act §9
 *     reserves to the user. The opt-in that grants them is a different slice's work, and this function does not
 *     pre-grant what nobody has chosen. */
export function capabilitiesFor(iface: ClientInterface): readonly string[] {
  const remote = iface === "telegram";
  return CAPABILITIES.filter((spec) => {
    if (NOT_DEFAULT.includes(spec.name)) return false;
    if (remote && (spec.grantsRemote === false || spec.localOnly === true)) return false;
    return true;
  }).map((spec) => spec.name);
}

export interface Restriction {
  /** The set the identity will hold: the intersection, and never a union. */
  readonly capabilities: readonly string[];
  /** Every name that could not be honoured, each with the sentence that says why. A caller that finds anything here
   *  must refuse the whole request rather than mint a narrower identity than was asked for. */
  readonly refused: readonly { readonly name: string; readonly reason: string }[];
}

/** Applies a restriction. `SECURITY.md` §5.3 makes this an intersection and nothing else — "the interface label may
 *  only narrow capabilities" — so a restriction naming something the baseline withholds is refused rather than honoured,
 *  and `--restrict shell.run` is not a way to enable the shell. An unknown name is refused for the reason §2's rule 03
 *  is a rule: a capability that is not in the vocabulary cannot be granted, and quietly dropping it would let a typo
 *  decide an identity's authority.
 *
 *  D-054 settles what would otherwise be a guess here: "`--restrict` removes capabilities from an identity; it never
 *  converts them into an approval the same restricted client must answer." So a withheld name is simply gone from the
 *  set and nothing else happens — no approval row is opened, no tier is raised, and a restricted client is never asked
 *  to answer for something it can no longer do. The alternative reading (a restriction demoting a capability to
 *  ask-first) would have made `--restrict` a way to *add* friction the documents do not describe, and D-054 exists
 *  because somebody considered it.
 *
 *  An empty list is refused too, and deliberately: `restrict` present with nothing in it names no capability, so it is
 *  not a restriction, and minting an identity that holds nothing would hand back a token that can only fail. Both cases
 *  arrive as a refusal the caller turns into a `400` naming the offender. */
export function restrictCapabilities(
  baseline: readonly string[],
  restrict: readonly string[],
): Restriction {
  const held = new Set(baseline);
  const capabilities: string[] = [];
  const refused: { name: string; reason: string }[] = [];
  if (restrict.every((name) => name.trim().length === 0)) {
    return {
      capabilities: [],
      refused: [
        {
          name: restrict.join(","),
          reason:
            "a restriction that names no capability is not a restriction; leave it off to mint the baseline set",
        },
      ],
    };
  }
  for (const raw of restrict) {
    const name = raw.trim();
    if (name.length === 0) continue;
    if (!capabilityFor(name)) {
      refused.push({
        name,
        reason: `'${baseOf(name)}' is not in the capability vocabulary (§6.1)`,
      });
      continue;
    }
    if (!held.has(name)) {
      refused.push({
        name,
        reason: `'${name}' is not in this interface's baseline, and a restriction may only narrow`,
      });
      continue;
    }
    if (!capabilities.includes(name)) capabilities.push(name);
  }
  return { capabilities, refused };
}

export interface GrantExpansion {
  /** Well-formed grants, every one of them checked by `isWellFormedGrant` before it was emitted. */
  readonly grants: readonly string[];
  /** Capabilities held that produced no grant, each with the reason. Withheld rather than dropped, because an
   *  identity that holds `fs.write` and can write nowhere is a fact the Gateway should be able to report, not a
   *  silence a user has to diagnose from a denied tool call. */
  readonly withheld: readonly { readonly capability: string; readonly reason: string }[];
}

/** F-52's third question — how a capability reaches `PolicySubject.grants`. A capability *name* is only a grant's base:
 *  §6.1 writes `fs.read:<root>` and `net.egress:<hostset>`, and `isWellFormedGrant` refuses a scoped capability with no
 *  parameter, so the expansion has to supply one from somewhere honest.
 *
 *  For `scope: "root"` the only source is the configured workspace roots, one grant per root. With none configured the
 *  capability is withheld rather than given a default, because `WorkspaceConfig`'s own reasoning applies: a root
 *  invented by a default would be a path the agent may write to that the user never chose. For `hostset` there is no
 *  source in `config.json` at all, so `net.egress` is withheld in every build until one exists — which is fail-closed
 *  (§2's rule 03) rather than a gap, and it is reported so that a denied `net.fetch` has an explanation.
 *
 *  A capability that already carries a parameter is kept as it is rather than re-expanded against the configured roots:
 *  a parameter somebody chose is a decision, and replacing it with whatever `config.json` says today would let a config
 *  edit silently move an identity's authority. */
export function grantsFor(
  capabilities: readonly string[],
  ctx: { readonly roots?: readonly string[] | undefined },
): GrantExpansion {
  const grants: string[] = [];
  const withheld: { capability: string; reason: string }[] = [];
  const roots = (ctx.roots ?? []).filter((root) => root.trim().length > 0);
  for (const capability of capabilities) {
    const spec = capabilityFor(capability);
    if (!spec) {
      withheld.push({
        capability,
        reason: `'${baseOf(capability)}' is not in the capability vocabulary (§6.1)`,
      });
      continue;
    }
    if (parameterOf(capability) !== undefined) {
      const verdict = isWellFormedGrant(capability);
      if (verdict.ok) grants.push(capability);
      else withheld.push({ capability, reason: verdict.reason });
      continue;
    }
    if (spec.scope === "none") {
      grants.push(spec.name);
      continue;
    }
    if (spec.scope === "root") {
      if (roots.length === 0) {
        withheld.push({
          capability: spec.name,
          reason:
            `'${spec.name}' is root-scoped and no workspace root is configured, so there is no ${spec.scope} to name — ` +
            "a root invented by a default would be a path the agent may write to that the user never chose",
        });
        continue;
      }
      for (const root of roots) {
        const grant = `${spec.name}:${root}`;
        const verdict = isWellFormedGrant(grant);
        if (verdict.ok) grants.push(grant);
        else withheld.push({ capability: grant, reason: verdict.reason });
      }
      continue;
    }
    withheld.push({
      capability: spec.name,
      reason:
        `'${spec.name}' is ${spec.scope}-scoped and nothing in \`config.json\` supplies a ${spec.scope}, so no ` +
        `well-formed grant can be built for it (${spec.grants})`,
    });
  }
  return { grants, withheld };
}
