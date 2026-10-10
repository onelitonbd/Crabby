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
