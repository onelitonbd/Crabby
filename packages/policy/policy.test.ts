// Tests for the M1 policy skeleton. The framing that matters: these are the tests `SECURITY.md` §6 and
// `PROVIDERS_AND_TOOLS.md` §4.2–§4.4 describe, so every case names the sentence it enforces. A test that only checks
// that a function returns what it happens to return is how a policy engine grows a hole quietly.

import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import {
  APPROVAL_TTL_MS,
  type ApprovalRequest,
  approvalTtlMs,
  assessShellCommand,
  baseOf,
  CAPABILITIES,
  type ClientKind,
  capabilitiesFor,
  capabilityFor,
  checkPath,
  clearExtensionTools,
  DESTRUCTIVE_PATTERNS,
  type EvalContext,
  evaluate,
  grantsFor,
  holdsGrant,
  IRREVERSIBLE_RULES,
  isIrreversible,
  isSensitive,
  isTier,
  isWellFormedGrant,
  maxTier,
  type PolicyDecision,
  READ_ONLY_COMMANDS,
  raiseOnly,
  registerTool,
  removedGrantsFor,
  resolveTool,
  restrictCapabilities,
  TIERS,
  TOOL_REGISTRY,
  tierFor,
  UNCLASSIFIED_TIER,
} from "./index.ts";

const HOME = "/home/ua";
const DATA_DIR = `${HOME}/.local/share/crabby`;
const ROOT = `${HOME}/work/site`;
const PATHS = { home: HOME, dataDir: DATA_DIR, roots: [ROOT] };
const ALL_GRANTS = CAPABILITIES.map((c) => c.name);

interface Call {
  tool: string;
  args?: Record<string, unknown>;
  declaredArgs?: readonly string[];
  /** What the runtime observed, as distinct from what the caller asked for (D-099). */
  facts?: Record<string, unknown>;
}

function decide(
  call: Call,
  overrides: {
    grants?: readonly string[];
    removedGrants?: readonly string[];
    clientKind?: ClientKind;
    taskId?: string;
  } = {},
  ctx: Partial<EvalContext> = {},
  now = 1_700_000_000_000,
) {
  const grants = overrides.grants ?? ALL_GRANTS;
  // Built field by field rather than spread over a default object, because `exactOptionalPropertyTypes` is on: writing
  // `removedGrants: undefined` into a subject is a type error in this repository, and the field being *absent* is the
  // thing the code actually means.
  return evaluate(
    {
      tool: call.tool,
      args: call.args ?? {},
      ...(call.declaredArgs ? { declaredArgs: call.declaredArgs } : {}),
      ...(call.facts ? { facts: call.facts } : {}),
    },
    {
      grants,
      clientKind: overrides.clientKind ?? "local",
      taskId: overrides.taskId ?? "task_1",
      ...(overrides.removedGrants ? { removedGrants: overrides.removedGrants } : {}),
    },
    { ...ctx, grants },
    now,
  );
}

function asAllow(decision: ReturnType<typeof decide>) {
  assert.equal(decision.outcome, "allow", `expected allow, got ${decision.outcome}`);
  return decision as Extract<typeof decision, { outcome: "allow" }>;
}

type Approval = Extract<PolicyDecision, { outcome: "require-approval" }> & {
  approval: ApprovalRequest;
};

function asApproval(decision: ReturnType<typeof decide>): Approval {
  assert.equal(
    decision.outcome,
    "require-approval",
    `expected an approval, got ${decision.outcome}`,
  );
  return decision as Approval;
}

function asDeny(decision: ReturnType<typeof decide>): Extract<PolicyDecision, { outcome: "deny" }> {
  assert.equal(decision.outcome, "deny", `expected a denial, got ${decision.outcome}`);
  return decision as Extract<PolicyDecision, { outcome: "deny" }>;
}

/** The tier of a decision that has one. `unavailable` deliberately has no tier — there is nothing to weigh — so this
 *  helper asserts the outcome rather than letting a test read `undefined` and pass by accident. */
function tierOf(decision: ReturnType<typeof decide>) {
  assert.notEqual(decision.outcome, "unavailable", "this outcome carries no tier");
  return (decision as { tier: string }).tier;
}

describe("capability vocabulary (SECURITY.md §6.1)", () => {
  it("is a closed list of unique names, each with a one-line description a prompt can quote", () => {
    const names = CAPABILITIES.map((c) => c.name);
    assert.equal(
      new Set(names).size,
      names.length,
      "a duplicate capability would make a grant ambiguous",
    );
    for (const spec of CAPABILITIES) {
      assert.match(
        spec.name,
        /^[a-z][a-z]*(\.[a-z][a-z]*)+$/,
        `${spec.name} should be dotted-lowercase`,
      );
      assert.ok(spec.grants.length > 8, `${spec.name} needs a description`);
    }
  });

  it("keeps auth.manage local-only, because a remote client holding it could mint its own access", () => {
    assert.equal(capabilityFor("auth.manage")?.localOnly, true);
    assert.equal(capabilityFor("auth.manage")?.grantsRemote, false);
  });

  it("refuses a scoped family with no scope and a flat capability with one", () => {
    assert.equal(isWellFormedGrant("fs.read:workspace").ok, true);
    assert.equal(
      isWellFormedGrant("fs.read").ok,
      false,
      "a root-less fs.read would mean every root",
    );
    assert.equal(isWellFormedGrant("task.read:today").ok, false);
    const unknown = isWellFormedGrant("made.up");
    assert.equal(unknown.ok, false);
    assert.match(unknown.ok === false ? unknown.reason : "", /vocabulary/);
  });

  it("holds a grant by base name and keeps the parameter as part of the grant", () => {
    assert.equal(holdsGrant(["fs.read:workspace"], "fs.read"), true);
    assert.equal(holdsGrant(["fs.read:workspace"], "fs.write"), false);
    assert.equal(holdsGrant(["fs.read:workspace"], "fs.read:secrets"), false);
    assert.equal(baseOf("net.egress:curated"), "net.egress");
  });

  // F-52's three questions, answered as code rather than as a paragraph: what a restriction means, who may set one, and
  // how a capability reaches `PolicySubject.grants`. The first two are the baseline and its narrowing; the third is the
  // expansion below them. Until these existed no code wrote `Identity.capabilities`, so every identity held an empty
  // set and a run started from a route would have been refused every tool it proposed.
  it("gives every interface one baseline, less what §9 and §5.3 withhold", () => {
    const cli = capabilitiesFor("cli");
    assert.deepEqual(
      [...capabilitiesFor("tui")],
      [...cli],
      "D-005 keeps parity by keeping capability identical and adapting presentation, so the three local interfaces hold one set",
    );
    assert.deepEqual([...capabilitiesFor("web")], [...cli]);
    for (const iface of ["cli", "tui", "web", "telegram"] as const) {
      for (const shell of ["shell.run", "shell.privileged"]) {
        assert.ok(
          !capabilitiesFor(iface).includes(shell),
          `§9: shell execution is "never enabled by default for a fresh install; enabling it is an explicit act", so ` +
            `${iface} must not arrive holding ${shell}`,
        );
      }
    }
    assert.ok(
      cli.includes("auth.manage"),
      "§6.1 makes it local-only by construction, and a local identity is exactly what may hold it",
    );
    const telegram = capabilitiesFor("telegram");
    assert.ok(
      !telegram.includes("auth.manage") && !telegram.includes("tunnel.enable"),
      "§6.1: no remote or agent-facing path may grant `auth.manage` — and in v1 a bot's requests are the ones that do " +
        "not originate on the Gateway's own host",
    );
    for (const capability of telegram) {
      assert.ok(
        cli.includes(capability),
        `§5.3: a remote client never receives a wider permission set than a local one — ${capability}`,
      );
    }
    assert.equal(
      cli.length,
      CAPABILITIES.length - 2,
      "only §9's two are withheld from a local baseline; everything else is the vocabulary itself",
    );
  });

  it("narrows on a restriction and refuses rather than widening or guessing", () => {
    const baseline = capabilitiesFor("cli");
    const narrowed = restrictCapabilities(baseline, ["task.read", "session.read", "task.read"]);
    assert.deepEqual(
      [...narrowed.capabilities],
      ["task.read", "session.read"],
      "the intersection, de-duplicated, in the order asked for",
    );
    assert.deepEqual(narrowed.refused, []);
    const shell = restrictCapabilities(baseline, ["shell.run"]);
    assert.equal(shell.capabilities.length, 0);
    assert.equal(
      shell.refused.length,
      1,
      "§5.3 makes a restriction an intersection, so `--restrict` is not a way to enable the shell",
    );
    const typo = restrictCapabilities(baseline, ["task.read", "task.red"]);
    assert.equal(typo.refused.length, 1);
    assert.match(
      typo.refused[0]?.reason ?? "",
      /vocabulary/,
      "§2's rule 03: an unknown capability is a refusal, not a name quietly dropped from the list",
    );
    const empty = restrictCapabilities(baseline, ["", " "]);
    assert.equal(
      empty.refused.length,
      1,
      "a restriction naming nothing is not a restriction, and an identity holding nothing could only ever fail",
    );
  });

  it("reads a dot-less token as the family it names, which is how §13 writes its own example", () => {
    const baseline = capabilitiesFor("cli");

    const family = restrictCapabilities(baseline, ["config"]);
    assert.deepEqual(
      [...family.capabilities],
      ["config.read", "config.write"],
      "§13's example is `crabby auth pair --restrict shell,config`, so a dot-less token has to reach the family it " +
        "names rather than be refused as a word nobody typed. The members arrive in the vocabulary's order, and the set " +
        "is still only what the baseline held: expansion is a shorthand for narrowing, never a way to reach a member " +
        "§9 or §6.1 withheld",
    );
    assert.deepEqual(family.refused, []);

    const mixed = restrictCapabilities(baseline, ["task", "task.read"]);
    assert.deepEqual(
      [...mixed.capabilities],
      ["task.create", "task.cancel", "task.read"],
      "a family and one of its own members may be asked for together, and the answer holds no duplicate",
    );
    assert.deepEqual(mixed.refused, []);

    // §13's example typed literally. One half of it works and the other cannot work on any install, and the difference
    // is the reason the two refusals say different things.
    const documented = restrictCapabilities(baseline, ["shell", "config"]);
    assert.deepEqual([...documented.capabilities], ["config.read", "config.write"]);
    assert.equal(documented.refused.length, 1);
    assert.equal(
      documented.refused[0]?.name,
      "shell",
      "the refusal names the token the operator typed rather than a member they never wrote, because a message naming " +
        "`shell.run` would have them looking for a flag they did not use. The function reports both halves — what could " +
        "be honoured and what could not — and it is the mint route that refuses the whole request when anything is " +
        "refused (§2's rule 03), so `shell,config` never mints a config-only identity",
    );
    assert.match(
      documented.refused[0]?.reason ?? "",
      /shell\.run, shell\.privileged/,
      "and it lists the family's members, so an operator sees what was withheld instead of guessing which rule stopped " +
        "them: §9 keeps the shell off every fresh install, so no baseline anywhere holds this family",
    );
    assert.match(
      documented.refused[0]?.reason ?? "",
      /widen the set rather than narrow it/,
      "with §5.3's rule named, because honouring it would be the widening D-054 forbids",
    );

    const remote = restrictCapabilities(capabilitiesFor("telegram"), ["auth"]);
    assert.equal(remote.refused.length, 1);
    assert.match(
      remote.refused[0]?.reason ?? "",
      /holds none of them/,
      "the same refusal for a different reason: §6.1 marks `auth.manage` local-only, so the `auth` family is empty for " +
        "a telegram baseline, and that is a rule about the interface rather than a spelling mistake",
    );

    const word = restrictCapabilities(baseline, ["nonsense"]);
    assert.equal(word.capabilities.length, 0);
    assert.match(
      word.refused[0]?.reason ?? "",
      /not a family either/,
      "a token that is neither a name nor a family is a typo, and saying so is worth the extra clause: it tells the " +
        "operator to check the spelling instead of hunting for a rule that stopped them",
    );
  });

  it("expands capabilities into well-formed grants, and withholds rather than inventing a parameter", () => {
    const first = "/data/data/com.termux/files/home/work";
    const second = "/sdcard/crabby";
    const expansion = grantsFor(["task.read", "fs.read", "net.egress"], { roots: [first, second] });
    assert.deepEqual(
      [...expansion.grants],
      ["task.read", `fs.read:${first}`, `fs.read:${second}`, "net.egress:allow-list"],
      "§6.1 writes `fs.read:<root>` and `net.egress:<hostset>`, so one configured root is one grant, a flat capability " +
        "stays flat, and a hostset names the *set* rather than its members (D-106) — a per-host grant would deny " +
        "exactly the hosts §4.3 prices at T2, which is a wall where the document put a price",
    );
    for (const grant of expansion.grants) {
      assert.equal(
        isWellFormedGrant(grant).ok,
        true,
        `every emitted grant is well-formed: ${grant}`,
      );
    }
    assert.deepEqual(
      [...expansion.withheld],
      [],
      "nothing is withheld here: the roots are configured and `net.egress` has a set to name, which since D-106 is " +
        "`net.allowList` in `config.json` — and an *empty* list still yields the grant, because a fresh install has " +
        "curated nothing and §4.3's T2-with-the-host-named is exactly the state that install is in",
    );

    const rootless = grantsFor(["fs.write"], {});
    assert.deepEqual(
      [...rootless.grants],
      [],
      "no roots means no grant: a root invented by a default would be a path the agent may write to that the user never chose",
    );
    assert.equal(rootless.withheld.length, 1);

    const chosen = grantsFor(["fs.read:/home/ua/one-root"], { roots: [first, second] });
    assert.deepEqual(
      [...chosen.grants],
      ["fs.read:/home/ua/one-root"],
      "a parameter somebody already chose is kept — re-expanding it against today's config would let an edit silently " +
        "move an identity's authority",
    );
  });

  it("names what a restriction removed, which is the half of §13's report `grants` cannot carry", () => {
    const full = capabilitiesFor("cli");
    assert.deepEqual(
      removedGrantsFor(full, "cli"),
      [],
      "an identity paired without `--restrict` had nothing removed. The empty set is the whole point: with it, a missing " +
        "capability reads as a denial the user can fix, and §13's other sentence stays reserved for a client that was " +
        "actually narrowed",
    );

    const narrow = restrictCapabilities(full, ["task.read", "fs.read"]);
    assert.deepEqual(
      narrow.refused,
      [],
      "the fixture restriction has to be honoured for the rest of this to mean anything",
    );
    const removed = removedGrantsFor(narrow.capabilities, "cli");
    assert.ok(
      removed.includes("fs.write"),
      "`fs.write` was in the baseline and is not held now, so it is what the restriction removed — and it is the name " +
        "that turns a refusal into 'not available to this client' instead of 'needs `fs.write`, which this identity " +
        "does not hold'",
    );
    assert.ok(
      !removed.includes("fs.read"),
      "and a capability the restriction kept is not reported as removed",
    );

    assert.ok(
      !removed.includes("shell.run") && !removed.includes("shell.privileged"),
      "§9 withholds the shell from every install, so no restriction removed it. Naming a rule's own exclusion as " +
        "somebody's narrowing would send the operator to inspect a pairing nobody narrowed, and `withheldReason` " +
        "already answers the shell from the registry side with the reason §9 gives",
    );

    const remote = capabilitiesFor("telegram");
    assert.deepEqual(
      removedGrantsFor(remote, "telegram"),
      [],
      "§6.1's local-only exclusions are a property of the interface, not of a restriction: an unrestricted telegram " +
        "identity had nothing taken away from it at pairing",
    );
    const empty = removedGrantsFor([], "telegram");
    assert.ok(
      !empty.includes("auth.manage"),
      "and a capability the telegram baseline never contained is not in the removed set either, however little the " +
        "identity holds",
    );
  });
});

describe("tier model (SECURITY.md §6.2, D-064)", () => {
  it("orders T0 to T3 and rejects anything else", () => {
    assert.deepEqual([...TIERS], ["T0", "T1", "T2", "T3"]);
    assert.equal(isTier("T2"), true);
    assert.equal(isTier("T4"), false);
    assert.equal(maxTier("T1", "T3", "T2"), "T3");
  });

  it("raises and never lowers", () => {
    assert.equal(raiseOnly("T1", "T2"), "T2");
    assert.equal(raiseOnly("T3", "T1"), "T3", "configuration cannot dig under a tier floor");
    assert.equal(raiseOnly("T2", undefined), "T2");
  });

  it("expires an approval faster the more it grants, and never below T1", () => {
    assert.deepEqual({ ...APPROVAL_TTL_MS }, { T1: 900_000, T2: 600_000, T3: 300_000 });
    assert.equal(approvalTtlMs("T0"), undefined);
    assert.equal(approvalTtlMs("T1"), 15 * 60_000);
    assert.equal(approvalTtlMs("T3"), 5 * 60_000);
  });
});

describe("tool registry (PROVIDERS_AND_TOOLS.md §4.2)", () => {
  it("has one row per tool-and-qualifier, with a real tier and a stated capability", () => {
    const keys = TOOL_REGISTRY.map((spec) => `${spec.tool}#${spec.qualifier ?? ""}`);
    assert.equal(
      new Set(keys).size,
      keys.length,
      "a repeated row would make the base tier ambiguous",
    );
    for (const spec of TOOL_REGISTRY) {
      assert.ok(isTier(spec.tier), `${spec.tool} needs a real tier`);
      assert.ok(
        spec.capabilities.length > 0 || spec.capabilityNote,
        `${spec.tool} must state a capability or why not`,
      );
    }
  });

  it("names only capabilities that exist in the vocabulary", () => {
    for (const spec of TOOL_REGISTRY) {
      for (const grant of spec.capabilities) {
        assert.ok(capabilityFor(grant), `${spec.tool} declares unknown capability ${grant}`);
      }
    }
  });

  it("keeps the security-relevant rows where §4.2 put them", () => {
    assert.deepEqual([...(resolveTool("shell.run")?.capabilities ?? [])], ["shell.run"]);
    assert.equal(resolveTool("shell.run")?.tier, "T2");
    assert.equal(resolveTool("shell.run")?.tierText, "T2 per command");
    assert.equal(resolveTool("config.set")?.tier, "T3", "changing permissions is T3");
    assert.equal(resolveTool("tunnel.enable")?.tier, "T3", "exposure is the risky part");
    assert.equal(resolveTool("termux-sms-send")?.tier, "T3", "D-033");
    assert.equal(tierFor("history.deleteConversation"), "T3");
  });

  it("splits one §4.2 row across two tiers instead of averaging them", () => {
    assert.equal(tierFor("process.spawn"), "T2");
    assert.equal(tierFor("process.list"), "T0", "listing must not cost as much as starting");
  });

  it("gives an unknown tool no tier at all, rather than a permissive default", () => {
    assert.equal(tierFor("made.up"), undefined);
    assert.equal(UNCLASSIFIED_TIER, "T2", "the floor an unclassified import inherits");
  });
});

describe("extension registration (SECURITY.md §5, DEVELOPMENT.md §5)", () => {
  it("denies unclassified tools at registration and never lets a declaration lower the floor", () => {
    clearExtensionTools();
    assert.equal(
      registerTool({
        tool: "acme.render",
        capabilities: ["fs.write"],
        tier: "T3",
        source: "extension",
      }).ok,
      true,
    );
    assert.equal(tierFor("acme.render"), "T3", "a riskier declaration is honored");
    assert.equal(
      registerTool({ tool: "acme.peek", capabilities: ["fs.read"], tier: "T0", source: "skill" })
        .ok,
      true,
      "registration succeeds, at the floor",
    );
    assert.equal(
      tierFor("acme.peek"),
      UNCLASSIFIED_TIER,
      "an unreviewed import may not declare itself T0",
    );

    const noCapability = registerTool({ tool: "acme.x", capabilities: [], source: "extension" });
    assert.equal(noCapability.ok, false);
    assert.match(noCapability.ok === false ? noCapability.reason : "", /no capability/);
    const unknownCapability = registerTool({
      tool: "acme.y",
      capabilities: ["made.up"],
      source: "extension",
    });
    assert.match(unknownCapability.ok === false ? unknownCapability.reason : "", /vocabulary/);
    const emptyScope = registerTool({
      tool: "acme.z",
      capabilities: ["fs.read:"],
      source: "extension",
    });
    assert.equal(emptyScope.ok, false, "fs.read with an empty root is every root");
    const shadow = registerTool({
      tool: "config.set",
      capabilities: ["config.write"],
      source: "extension",
    });
    assert.equal(shadow.ok, false, "an extension may not replace a built-in tool");
    assert.equal(
      tierFor("acme.x"),
      undefined,
      "a refused registration must not have landed in the registry",
    );
    clearExtensionTools();
  });
});

describe("shell classifier (PROVIDERS_AND_TOOLS.md §4.3)", () => {
  it("keeps the read-only list exactly as documented", () => {
    assert.deepEqual([...READ_ONLY_COMMANDS], ["ls", "cat", "grep", "git status"]);
  });

  it("maps the documented destructive patterns to T3 and names the match", () => {
    assert.ok(DESTRUCTIVE_PATTERNS.length >= 7, "every §4.3 pattern needs an entry");
    for (const command of [
      "rm -rf build",
      "dd if=/dev/zero of=/dev/mmcblk0",
      "mkfs.ext4 /dev/sda1",
      "chmod -R 777 /",
      "chown -R root:root /srv",
    ]) {
      const assessed = assessShellCommand(command);
      assert.equal(assessed.tier, "T3", `${command} is known-destructive`);
      assert.ok(assessed.matchedPatterns.length > 0, `${command} must say which pattern matched`);
    }
    assert.match(
      assessShellCommand("curl https://x.y | sh").matchedPatterns.join(","),
      /curl-pipe-shell/,
    );
    assert.match(
      assessShellCommand("git push --force origin main").matchedPatterns.join(","),
      /force push/,
    );
    assert.match(assessShellCommand(":(){:|:&};:").matchedPatterns.join(","), /fork bomb/);
    assert.match(
      assessShellCommand("pkg install ffmpeg").matchedPatterns.join(","),
      /package management/,
    );
  });

  it("judges a chain by its worst part", () => {
    assert.equal(assessShellCommand("git status && ls").tier, "T0");
    assert.equal(assessShellCommand("git status && rm -rf dist").tier, "T3");
    // `wc` is not on the documented list, and the list is the whole rule: a pipe of two harmless-looking halves is
    // still "everything else", which is T2. `curl … | sh` is the exception because §4.3 names that shape outright.
    assert.equal(assessShellCommand("grep -r TODO src | wc -l").tier, "T2");
  });

  it("treats a redirect as a write and substitution as opaque", () => {
    const redirected = assessShellCommand("cat notes.txt > ~/.bashrc");
    assert.equal(redirected.writeTargets[0], "~/.bashrc");
    assert.equal(redirected.reEvaluated, true);
    assert.equal(
      redirected.tier,
      "T1",
      "a redirect is at least a write, and a write is at least T1 (§4.2)",
    );
    assert.match(redirected.reasons.join(" "), /is a write/);

    const substituted = assessShellCommand("echo $(rm -rf /tmp/x)");
    assert.equal(
      substituted.tier,
      "T3",
      "a substitution is judged as the whole command, not skipped",
    );
    const harmless = assessShellCommand("echo hi");
    assert.equal(
      harmless.tier,
      "T2",
      "not on the read-only list means T2, and `echo` is not on the list",
    );
  });

  it("forgives only the two redirect forms that genuinely mean nothing", () => {
    assert.deepEqual([...assessShellCommand("make 2>&1").writeTargets], []);
    assert.deepEqual([...assessShellCommand("cmd > /dev/null").writeTargets], []);
    assert.deepEqual([...assessShellCommand("cmd > out.txt").writeTargets], ["out.txt"]);
  });
});

describe("path judgement (SECURITY.md §8)", () => {
  it("denies the documented deny-list even for a read", () => {
    for (const candidate of [
      `${HOME}/.ssh/id_ed25519`,
      `${HOME}/.aws/credentials`,
      `${HOME}/.config/gh/hosts.yml`,
      `${HOME}/.config/google-chrome/Default/Cookies`,
      `${ROOT}/.env`,
      `${ROOT}/server.pem`,
      `${ROOT}/credentials.json`,
    ]) {
      assert.equal(isSensitive(candidate, PATHS), true, `${candidate} is on §8's list`);
    }
    assert.equal(isSensitive(`${ROOT}/src/app.ts`, PATHS), false);
    assert.equal(isSensitive(DATA_DIR, PATHS), true, "the data directory is on the list itself");
  });

  it("refuses absolute paths and traversal outside every root", () => {
    assert.equal(checkPath("/etc/passwd", PATHS).ok, false);
    assert.equal(checkPath("../../etc/passwd", PATHS).ok, false);
    assert.equal(checkPath("src/app.ts", PATHS).ok, true);
  });

  // A resolver that answers every path with the same string is not a resolver. `realpath` is a function of the path it
  // is given, and a constant one collapses the root onto the target, so containment holds for anything asked of it —
  // which is how these three fixtures read before the root itself started resolving too. They now name the one path
  // that hops and leave every other path alone, exactly as `realpathSync` does. The assertions are unchanged; what they
  // test is the rule rather than the artifact.
  const linkAt = path.resolve(ROOT, "link");
  const hopTo = (target: string) => (absolute: string) => (absolute === linkAt ? target : absolute);

  it("re-checks after the symlink hop and rejects what the first check missed", () => {
    const escaping = checkPath("link", PATHS, hopTo(`${HOME}/.ssh/id_ed25519`));
    assert.equal(escaping.ok, false);
    assert.match(escaping.ok === false ? escaping.reason : "", /resolves through a link/);
    assert.equal(checkPath("link", PATHS, hopTo("/etc/hosts")).ok, false);
    assert.equal(
      checkPath("link", PATHS, hopTo(`${ROOT}/real.txt`)).ok,
      true,
      "a hop that stays inside the root is not a finding",
    );
  });

  it("accepts a workspace root that is itself behind a link, because both sides of the re-check resolve", () => {
    // The shape that made the file executor's whole suite fail on macOS while passing on every Linux runner, and that
    // no test in this file covered: macOS hands `os.tmpdir()` out as `/var/folders/...` where the real directory is
    // `/private/var/folders/...`, so a root configured at the link and a target resolved through it are two names for
    // one directory. Refusing the target reads as an escape while describing a file that never left the root. Termux's
    // `/sdcard` is a link to `/storage/emulated/0`, which makes this the primary platform's most obvious workspace
    // layout and therefore a defect rather than a CI inconvenience.
    const REAL = "/private/home/ua/work/site";
    const throughLink = (absolute: string) =>
      absolute === ROOT || absolute.startsWith(`${ROOT}/`)
        ? absolute.replace(ROOT, REAL)
        : absolute;
    const inside = checkPath("src/app.ts", PATHS, throughLink);
    assert.equal(inside.ok, true, inside.ok ? "" : inside.reason);
    assert.equal(
      inside.ok ? inside.root : "",
      REAL,
      "the root reported back is the resolved one: the file executor measures `path.relative(root, resolved)`, and a " +
        "lexical root beside a resolved target emits `..` segments that name no location on disk",
    );
    assert.equal(
      checkPath("link", PATHS, (absolute) =>
        absolute === linkAt ? "/etc/hosts" : throughLink(absolute),
      ).ok,
      false,
      "resolving both sides must not turn containment into a formality — a hop out of the real root is still a finding",
    );
  });

  it("escalates a write it cannot re-check, instead of allowing it", () => {
    const decision = decide({ tool: "file.write", args: { path: "a.txt" } }, {}, { paths: PATHS });
    assert.equal(
      asApproval(decision).tier,
      "T3",
      "no resolver means the §8 re-check did not happen",
    );
  });

  it("fails closed when no workspace root exists at all", () => {
    const decision = decide({ tool: "file.read", args: { path: "a.txt" } });
    assert.match(asApproval(decision).reasons.join(" "), /no workspace root/);
  });
});

describe("escalation on observed facts (PROVIDERS_AND_TOOLS.md §4.3, D-099)", () => {
  // §4.3's file rows turn on facts about the filesystem rather than on intentions the caller declared, and `escalate`
  // reads them from a channel the caller cannot write to. These four are the first tests those two escalations have ever
  // had, which is the measure of how unreachable they were: before an executor existed there was no party to observe
  // anything, so the rule could not be exercised even in principle.
  const CTX = { paths: PATHS, realpathOf: (absolutePath: string) => absolutePath };
  const EDIT = {
    tool: "file.edit",
    args: { path: "a.txt", content: "x" },
    declaredArgs: ["path", "content"],
  };

  it("raises an edit of a file that was already there to T2, and leaves it at T1 with nothing observed", () => {
    assert.equal(
      tierOf(decide(EDIT, {}, CTX)),
      "T1",
      "§4.2's `file.edit (existing)` row is T1, and a fact nobody observed cannot raise it — this module can escalate on " +
        "evidence and it cannot invent evidence",
    );
    const observed = decide({ ...EDIT, facts: { preExistingUserFile: true } }, {}, CTX);
    assert.equal(
      tierOf(observed),
      "T2",
      "§4.2: 'Bumped to T2 when overwriting a file Crabby did not create'",
    );
    assert.match(
      asApproval(observed).approval.effects,
      /overwriting a file Crabby did not create/,
      "§6.2's T2 row is 'explicit approval with full context', so the sentence that raised the tier is in the prompt",
    );
  });

  it("refuses the same fact from the caller, because §10 says a declared field is never an authority", () => {
    const forged = decide(
      {
        tool: "file.edit",
        args: { path: "a.txt", content: "x", preExistingUserFile: false },
        declaredArgs: ["path", "content"],
      },
      {},
      CTX,
    );
    const denial = asDeny(forged);
    assert.equal(
      denial.class,
      "validation",
      "a fact smuggled in as an argument is an argument the tool never declared, and §4.3's rule for those is rejection " +
        "before policy — the model cannot lower its own tier by declaring the answer",
    );
    assert.match(denial.reason, /does not declare/);
  });

  it("raises a move onto an occupied destination to T2, on the runtime's observation of the destination", () => {
    const MOVE = {
      tool: "file.move",
      args: { path: "a.txt", destination: "b.txt" },
      declaredArgs: ["path", "destination"],
    };
    assert.equal(tierOf(decide(MOVE, {}, CTX)), "T1", "§4.2's `file.move` row");
    assert.equal(
      tierOf(decide({ ...MOVE, facts: { overwrites: true } }, {}, CTX)),
      "T2",
      "§4.2: 'T2 across roots or onto an existing target' — and the target's state is a fact, not an intention",
    );
  });

  it("puts the observed fact inside the binding, so a signature covers what policy actually saw", () => {
    // `file.delete` is used because the fact changes nothing about its tier, which isolates the only difference between
    // the two calls: §6.3's binding has to cover the observation as well as the request, or D-084's comparison at the
    // moment of execution would be comparing half of what the user priced.
    const DELETE = { tool: "file.delete", args: { path: "a.txt" }, declaredArgs: ["path"] };
    const plain = asApproval(decide(DELETE, {}, CTX));
    const observed = asApproval(
      decide({ ...DELETE, facts: { preExistingUserFile: true } }, {}, CTX),
    );
    assert.equal(
      plain.approval.tier,
      observed.approval.tier,
      "the tier is the same, so the tier is not what differs",
    );
    assert.notEqual(
      plain.approval.binding,
      observed.approval.binding,
      "the fact is part of the action's identity: two calls that policy judged on different evidence are two approvals",
    );
    assert.equal(
      asApproval(decide({ ...DELETE, facts: { preExistingUserFile: true } }, {}, CTX)).approval
        .binding,
      observed.approval.binding,
      "and the same evidence produces the same binding, which is what makes the comparison at execution a comparison " +
        "rather than a coin toss",
    );
  });
});

describe("decision pipeline (PROVIDERS_AND_TOOLS.md §4.4)", () => {
  it("rejects undeclared arguments before it reaches permission", () => {
    const decision = decide(
      { tool: "file.read", args: { path: "a.txt", redirect: "~/.bashrc" }, declaredArgs: ["path"] },
      {
        grants: [],
      },
    );
    const denial = asDeny(decision);
    assert.equal(denial.class, "validation", "a schema mismatch is not a policy answer");
    assert.match(denial.reason, /does not declare/);
  });

  it("refuses a tool the registry does not know", () => {
    const denial = asDeny(decide({ tool: "acme.mystery", args: {} }));
    assert.match(denial.reason, /no capability and no tier/);
  });

  it("denies an ungranted capability instead of queueing an approval for it", () => {
    const denial = asDeny(
      decide({ tool: "file.delete", args: { path: "a.txt" } }, { grants: ["fs.read:workspace"] }),
    );
    assert.equal(denial.class, "policy");
    assert.match(denial.reason, /fs\.write/);
  });

  it("answers 'not available to this client' for a restricted identity", () => {
    const decision = decide(
      { tool: "shell.run", args: { command: "ls" } },
      { grants: [], removedGrants: ["shell.run"] },
    );
    assert.equal(
      decision.outcome,
      "unavailable",
      "a removed capability is not a denial the user can approve (§13)",
    );
    if (decision.outcome !== "unavailable") return;
    assert.equal(decision.class, "platform-unsupported");
    assert.equal(decision.capability, "shell.run");
  });

  it("auto-allows T0 and does not build an approval for it", () => {
    const allow = asAllow(
      decide(
        { tool: "file.read", args: { path: "a.txt" } },
        {},
        { paths: PATHS, realpathOf: (p: string) => p },
      ),
    );
    assert.equal(allow.tier, "T0");
    assert.match(allow.behavior, /auto-allow, audited/);
  });

  it("builds a T2 approval carrying every field §6.3 requires", () => {
    const decision = decide(
      { tool: "net.fetch", args: { url: "https://api.example.com/v1/status" } },
      { grants: ["net.egress"] },
    );
    const { approval } = asApproval(decision);
    assert.equal(approval.tier, "T2");
    assert.equal(
      approval.expiresAt,
      1_700_000_000_000 + 10 * 60_000,
      "D-064: T2 expires in ten minutes",
    );
    assert.equal(approval.scope, "once", "D-052: exactly one answer shape exists");
    assert.equal(approval.taskId, "task_1");
    assert.equal(approval.tool, "net.fetch");
    assert.equal(
      approval.exact,
      "url: https://api.example.com/v1/status",
      "§6.3 asks for the exact destination host",
    );
    for (const field of [
      "summary",
      "effects",
      "reversibility",
      "whatCouldGoWrong",
      "binding",
    ] as const) {
      assert.ok(String(approval[field]).length > 0, `${field} may not be empty`);
    }
    const otherTask = decide(
      { tool: "net.fetch", args: { url: "https://api.example.com/v1/status" } },
      {
        grants: ["net.egress"],
        taskId: "task_2",
      },
    );
    assert.notEqual(
      asApproval(otherTask).approval.binding,
      approval.binding,
      "an approval is bound to its task, so another task must not reuse it",
    );
    const edited = decide(
      { tool: "net.fetch", args: { url: "https://api.example.com/v2/status" } },
      { grants: ["net.egress"] },
    );
    assert.notEqual(
      asApproval(edited).approval.binding,
      approval.binding,
      "materially changed arguments need a new approval",
    );
  });

  it("escalates egress by host, and only a user-curated list moves it down to T1", () => {
    const ctx = { egressAllowList: ["api.example.com"] };
    asAllow(
      decide(
        { tool: "net.fetch", args: { url: "https://api.example.com/x" } },
        { grants: ["net.egress"] },
        ctx,
      ),
    );
    const elsewhere = decide(
      { tool: "net.fetch", args: { url: "https://evil.example/y" } },
      { grants: ["net.egress"] },
      ctx,
    );
    assert.match(
      asApproval(elsewhere).reasons.join(" "),
      /evil\.example/,
      "the host has to be named in the prompt",
    );
  });

  it("reaches §4.2's `net.fetch` row from a real identity's grants, and prices the two halves of the row apart", () => {
    // The chain a Gateway actually runs, rather than a subject built by hand: `capabilitiesFor` for the interface,
    // `grantsFor` against this install's configuration, and then the arbiter. It is here because the two halves of
    // §4.2's cell — "**T1** only for a user-curated allow-list" and the T2 base — are only both reachable if the grant
    // expansion names the *set* instead of its members. A per-host expansion would have failed the capability check for
    // every host nobody curated and answered `deny`, turning "escalation by destination" (§4.3) into a wall, and the
    // deny would have read as a configuration problem the user could not fix from `config.json` at all.
    const roots = ["/data/data/com.termux/files/home/work"];
    const curated = ["api.example.com"];
    for (const allowList of [curated, [] as readonly string[]]) {
      const grants = grantsFor(capabilitiesFor("cli"), { roots }).grants;
      const onList = decide(
        { tool: "net.fetch", args: { url: "https://api.example.com/v1/status" } },
        { grants },
        { egressAllowList: allowList },
      );
      const offList = decide(
        { tool: "net.fetch", args: { url: "https://example.org/v1/status" } },
        { grants },
        { egressAllowList: allowList },
      );
      const curatedNow = allowList.length > 0;
      if (curatedNow) {
        assert.equal(
          asAllow(onList).tier,
          "T1",
          "a host the user curated is §4.2's T1 half: auto-allowed, with the curation as the reason",
        );
      } else {
        assert.equal(
          asApproval(onList).approval.tier,
          "T2",
          "with nothing curated there is no T1 to be had, and the row's base tier is the price — not a denial",
        );
      }
      assert.equal(
        asApproval(offList).approval.tier,
        "T2",
        "a host that is not on the list is T2 whichever list was loaded, which is §4.3's escalation by destination",
      );
      assert.match(
        asApproval(offList).approval.exact,
        /example\.org/,
        "and §6.3's exact field carries the destination, so the user approves a host rather than a tool name",
      );
    }
  });

  it("refuses to answer a T3 from Telegram, and asks normally everywhere else", () => {
    const fromTelegram = decide(
      { tool: "config.set", args: { key: "a", value: "b" } },
      { clientKind: "telegram" },
    );
    assert.match(asDeny(fromTelegram).reason, /TUI or the Web/);
    assert.match(asDeny(fromTelegram).reason, /not answerable from Telegram/);
    const fromWeb = decide(
      { tool: "config.set", args: { key: "a", value: "b" } },
      { clientKind: "web" },
    );
    assert.equal(fromWeb.outcome, "require-approval");
    if (fromWeb.outcome !== "require-approval") return;
    assert.equal(fromWeb.approval.ttlMs, 5 * 60_000, "T3 gets the shortest window");
  });

  it("says so when an action is irreversible", () => {
    for (const rule of IRREVERSIBLE_RULES) {
      assert.ok(
        rule.tool === "device.control" || resolveTool(rule.tool),
        `${rule.tool} must exist in the registry`,
      );
    }
    assert.equal(isIrreversible("ext.uninstall", { purgeData: true }), true);
    assert.equal(isIrreversible("ext.uninstall", {}), false);
    const decision = decide({ tool: "memory.delete", args: { all: true } });
    assert.equal(asApproval(decision).tier, "T3", "bulk forget is T3 (§4.2)");
    assert.equal(
      asApproval(decision).approval.reversibility,
      "irreversible",
      "§6.2: irreversible ones say so",
    );
  });

  it("keeps a read-only command cheap and a destructive one expensive", () => {
    asAllow(decide({ tool: "shell.run", args: { command: "ls -la" } }, {}, { paths: PATHS }));
    assert.equal(
      tierOf(
        decide(
          { tool: "shell.run", args: { command: "ls -la && rm -rf build" } },
          {},
          { paths: PATHS },
        ),
      ),
      "T3",
    );
    const sensitiveWrite = decide(
      { tool: "shell.run", args: { command: "echo x > ~/.ssh/authorized_keys" } },
      {},
      { paths: PATHS },
    );
    assert.equal(tierOf(sensitiveWrite), "T3");
    assert.match(asApproval(sensitiveWrite).reasons.join(" "), /deny-list/);
    const outsideWrite = decide(
      { tool: "shell.run", args: { command: "echo x > ~/.bashrc" } },
      {},
      { paths: PATHS },
    );
    assert.equal(tierOf(outsideWrite), "T2", "outside every root is a write, not a read");
  });

  it("requires the billing capability to be mentioned when a paid model is chosen", () => {
    const decision = decide(
      { tool: "provider.invoke", args: { model: "gpt-paid", paid: true } },
      {
        grants: ["provider.invoke"],
      },
    );
    const approval = asApproval(decision);
    assert.equal(approval.tier, "T2");
    assert.match(approval.reasons.join(" "), /bills/);
  });

  it("treats the elevated shell row as its own tool, not as a flag on shell.run", () => {
    const elevated = resolveTool("shell.run");
    assert.equal(elevated?.tier, "T2");
    const privileged = TOOL_REGISTRY.find((spec) => spec.capabilities.includes("shell.privileged"));
    assert.equal(privileged?.tier, "T3");
  });
});
