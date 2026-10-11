// The argument-dependent half of a tier: §4.2's per-row notes ("T3 outside the workspace", "T1 only for a user-curated
// allow-list", "T2 for cross-session") and §4.3's classifier, turned into functions that can be called with the
// arguments a real tool call carries.
//
// Two rules keep this module from becoming the place policy quietly gets weaker. First, an escalation may only raise a
// tier — `maxTier` is the only combinator here, never a min. Second, a rule reads an argument it needs and, if that
// argument is absent, says nothing: it does not guess a value and it does not lower the base tier for want of
// information. Absent `recursive` on `file.delete` therefore means "T2", which is what the row already said, rather
// than "T2 unless the caller tells me otherwise".
//
// Every rule cites the §4.2 row or §4.3 bullet it comes from, and `scripts/parity.ts` checks the set of tools that
// have a rule against the set of rows whose note mentions an escalation — so a new sentence in the document has to
// produce code in the same milestone, and a rule with no sentence has to be written into the document first.

import path from "node:path";
import { holdsGrant } from "./capabilities.ts";
import { checkPath, isSensitive, type PathContext } from "./paths.ts";
import { assessShellCommand } from "./shell.ts";
import { maxTier, raiseOnly, type Tier } from "./tiers.ts";
import type { ToolSpec } from "./tools.ts";

export interface Escalation {
  readonly tier: Tier;
  readonly reason: string;
}

export interface EvalContext {
  /** Absent means no filesystem judgement is possible, which caps what `file.*` can decide about paths. */
  readonly paths?: PathContext;
  /** §4.2's `net.fetch` row: "T1 only for a user-curated allow-list". The list is the user's, so it arrives here and
   *  never defaults to a value this module invents. */
  readonly egressAllowList?: readonly string[];
  /** D-060's rule that a restricted client may not be pushed into an approval it cannot answer. */
  readonly grants: readonly string[];
  /** The resolver §8's re-check-after-resolution rule needs. Without it a symlink hop is invisible, so `file.*`
   *  writes are refused rather than allowed on a half-check — the fail-closed direction. */
  readonly realpathOf?: (absolutePath: string) => string;
  readonly schemasValidated?: boolean;
}

type Args = Readonly<Record<string, unknown>>;

function expandHome(target: string, home: string | undefined): string | undefined {
  if (target.startsWith("/") && home === undefined) return target;
  if (target.startsWith("~/") || target === "~") {
    return home === undefined ? undefined : path.join(home, target.slice(2));
  }
  // A relative shell target is relative to a cwd policy does not own, so it cannot be judged as inside or outside a
  // root here. Returning undefined routes it to the "cannot locate" branch, which raises to T2 rather than guessing.
  return undefined;
}

function insideAnyRoot(absolute: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    const relative = path.relative(path.resolve(root), absolute);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}

function stringArg(args: Args, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function boolArg(args: Args, key: string): boolean {
  return args[key] === true;
}

/** §4.2's irreversible-by-construction rows. The doc asks that "irreversible ones say so" (§6.2), which is only
 *  possible if the set is enumerated somewhere, and it is not enumerated anywhere else in the repository. */
export const IRREVERSIBLE_RULES: readonly {
  readonly tool: string;
  readonly when: (args: Args) => boolean;
}[] = [
  { tool: "file.delete", when: (a) => boolArg(a, "recursive") || a.hard === true },
  { tool: "memory.delete", when: (a) => boolArg(a, "bulk") || a.all === true },
  { tool: "ext.uninstall", when: (a) => boolArg(a, "purgeData") },
  { tool: "git.push", when: (a) => boolArg(a, "force") },
  { tool: "device.control", when: () => true },
];

export function isIrreversible(tool: string, args: Args): boolean {
  return IRREVERSIBLE_RULES.some((rule) => rule.tool === tool && rule.when(args));
}

/** The one place a `file.*` argument becomes a judgement, so shell redirection and a `file.read` argument cannot
 *  disagree about what "outside the workspace" means. */
function pathEscalation(args: Args, ctx: EvalContext, spec: ToolSpec): Escalation | undefined {
  const requested = stringArg(args, "path") ?? stringArg(args, "destination");
  if (requested === undefined) return undefined;
  if (!ctx.paths) {
    // §8: "The default install grants no filesystem access outside the workspace; the home directory is not a
    // workspace." With no root configured there is no inside to be safe in, so this is the top tier and the approval
    // text says why — a caller that wants a hard refusal instead can read the reason, and M2's runtime does exactly
    // that for writes.
    return {
      tier: "T3",
      reason: `'${requested}' cannot be checked because no workspace root is configured (§8)`,
    };
  }
  const writing = spec.capabilities.includes("fs.write");
  const verdict = checkPath(requested, ctx.paths, writing ? ctx.realpathOf : undefined);
  if (writing && !ctx.realpathOf && verdict.ok) {
    return {
      tier: "T3",
      reason: `'${requested}' cannot be checked after symlink resolution, and §8 requires the check after the hop`,
    };
  }
  if (!verdict.ok) {
    // §8: "Denied outright on the SECURITY.md §8 sensitive deny-list even at T0". A denial is not a tier, and this is
    // the one case where escalation returns a *hard* answer — expressed as T3 so evaluate.ts renders an approval
    // rather than pretending there is none, and the reason says the deny-list is why.
    return { tier: "T3", reason: verdict.reason };
  }
  return undefined;
}

/**
 * Compute the tier for one call: the registry's base, raised by whatever the arguments imply. The return value always
 * carries the reasons, because §6.3 requires an approval to show "the exact command or path or destination host" and a
 * reason-less "T3" cannot be shown to a human usefully.
 */
export function escalate(
  spec: ToolSpec,
  args: Args,
  ctx: EvalContext,
  facts: Args = {},
): { tier: Tier; reasons: string[] } {
  const reasons: string[] = [];
  let tier: Tier = spec.tier;
  const raise = (escalation: Escalation | undefined) => {
    if (!escalation) return;
    const next = raiseOnly(tier, escalation.tier);
    if (next !== tier) reasons.push(escalation.reason);
    tier = next;
  };

  switch (spec.tool) {
    // §4.2's `shell.run` row is the one row whose tier cell is a *function* rather than a value — "**T2** per
    // command", "Tier computed per command, not per tool" — so the classifier's answer replaces the row's default
    // instead of being raised from it. That is a documented lowering relative to T2 and it is the row's own
    // instruction, not this module relaxing a floor; a read-only `ls` inside the workspace is T0 per §4.3.
    case "shell.run": {
      const command =
        stringArg(args, "command") ?? (Array.isArray(args.argv) ? args.argv.join(" ") : undefined);
      if (command === undefined) break;
      const assessed = assessShellCommand(command);
      tier = assessed.tier;
      if (assessed.tier === "T3") {
        reasons.push(
          `known-destructive pattern: ${assessed.matchedPatterns.join(", ") || "matched"}`,
        );
      } else if (assessed.tier === "T2") {
        reasons.push("not on the read-only list (§4.3)");
      } else {
        reasons.push("read-only command (§4.3)");
      }
      // A redirect is a write, and a write is judged by the same two questions §4.2 asks of `file.*`: is it inside a
      // root, and is it on the deny-list. `SECURITY.md` §8's last bullet demands exactly this pairing, because "shell
      // redirection as a 'read' call is still a write".
      for (const target of assessed.writeTargets) {
        const absolute = expandHome(target, ctx.paths?.home);
        if (absolute === undefined) {
          tier = maxTier(tier, "T2");
          reasons.push(`redirects to '${target}', which is a write the classifier cannot locate`);
          continue;
        }
        if (ctx.paths && isSensitive(absolute, ctx.paths)) {
          tier = maxTier(tier, "T3");
          reasons.push(`writes to '${target}', on the sensitive deny-list (§8)`);
          continue;
        }
        if (ctx.paths && !insideAnyRoot(absolute, ctx.paths.roots)) {
          tier = maxTier(tier, "T2");
          reasons.push(`writes to '${target}', outside every workspace root (§8)`);
        }
      }
      break;
    }
    // §4.2's file rows: the path decides. Two of them — `file.edit`'s "a file Crabby did not create" and `file.move`'s
    // "onto an existing target" — turn on a fact about the filesystem rather than on an intention the caller declared, so
    // they read `facts` and not `args` (D-099). A fact nobody observed leaves the row's base tier standing, which is the
    // only honest reading: this module can raise a tier on evidence, and it cannot invent evidence.
    case "file.edit":
    case "file.write":
    case "file.delete":
    case "file.move":
    case "fs.search":
    // §8 applies to *all* file tools ("All file tools operate relative to one or more configured workspace roots"),
    // so a read is checked for the deny-list and the root hop too — that is the row that says reading `~/.ssh` is
    // denied outright even at T0.
    case "file.read":
    case "file.list": {
      raise(pathEscalation(args, ctx, spec));
      if (spec.tool === "file.edit" && boolArg(facts, "preExistingUserFile")) {
        raise({
          tier: "T2",
          reason:
            "overwriting a file Crabby did not create (§4.2, and §8's T2 for destructive overwrites)",
        });
      }
      if (spec.tool === "file.delete" && boolArg(args, "recursive")) {
        raise({ tier: "T3", reason: "recursive delete (§4.2's T3 sentence for this row)" });
      }
      if (spec.tool === "file.move" && boolArg(facts, "overwrites")) {
        raise({ tier: "T2", reason: "moving onto an existing file (§4.2)" });
      }
      break;
    }
    // §4.2: "T1 only for a user-curated allow-list; any other host is T2 with the host named in the prompt."
    case "net.fetch": {
      const url = stringArg(args, "url");
      const host = url ? safeHost(url) : stringArg(args, "host");
      if (host === undefined) break;
      const allowed = ctx.egressAllowList?.includes(host);
      if (allowed) {
        // The one documented *de*-escalation in the registry, and it is not the module lowering below the floor:
        // §4.2's own cell reads "T2 … T1 only for a user-curated allow-list", so T1 is the row's tier for that
        // argument shape and the row was transcribed with the more permissive half as the default because an
        // unset allow-list is the state a fresh install is in. Every other branch here goes through `raiseOnly`.
        tier = "T1";
        reasons.push(`'${host}' is on the user's egress allow-list (§4.2)`);
      } else {
        tier = maxTier(spec.tier, "T2");
        reasons.push(
          `'${host}' is not on the egress allow-list, so the host is named in the prompt (§4.3)`,
        );
      }
      break;
    }
    case "git.push": {
      if (boolArg(args, "force")) raise({ tier: "T3", reason: "force push (§4.2: T3 with force)" });
      if (boolArg(args, "protectedBranch"))
        raise({ tier: "T3", reason: "push to a protected branch (§4.2)" });
      break;
    }
    // §4.2: provider.invoke is T1, T2 when the model costs money, and the extra capability is the point.
    case "provider.invoke": {
      if (boolArg(args, "paid")) {
        raise({ tier: "T2", reason: "the selected model bills (§4.2)" });
        if (!holdsGrant(ctx.grants, "provider.billing")) {
          reasons.push("provider.billing is not granted to this client");
        }
      }
      break;
    }
    case "memory.save": {
      if (boolArg(args, "fromUntrustedContent")) {
        raise({
          tier: "T2",
          reason: "the content came from untrusted material (§4.2, prompt-injection rule)",
        });
      }
      break;
    }
    case "memory.delete": {
      if (boolArg(args, "bulk") || args.all === true) {
        raise({ tier: "T3", reason: "bulk forget (§4.2: T3 for 'forget everything')" });
      }
      break;
    }
    case "ext.uninstall": {
      if (boolArg(args, "purgeData")) raise({ tier: "T3", reason: "--purge-data is T3 (§4.2)" });
      break;
    }
    case "task.cancel": {
      if (boolArg(args, "crossSession") || args.all === true) {
        raise({ tier: "T2", reason: "cross-session or cancel-all (§4.2)" });
      }
      break;
    }
    case "cron.schedule": {
      if (boolArg(args, "editsExisting") || boolArg(args, "changesTarget")) {
        raise({
          tier: "T3",
          reason: "editing a job to add T3 steps or changing what it targets (§4.2)",
        });
      }
      break;
    }
    default:
      break;
  }

  if (isIrreversible(spec.tool, args) && tier !== "T3") {
    reasons.push("irreversible, so approval has to say so (§6.2)");
    tier = maxTier(tier, "T3");
  }
  return { tier, reasons };
}

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}
