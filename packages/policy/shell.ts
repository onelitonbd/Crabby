// The static command classifier of `PROVIDERS_AND_TOOLS.md` §4.3. Its own document sentence sets its limits, and the
// file is only honest while they are respected: "the classifier is *friction and information*, not a boundary: the
// boundary remains capability + approval". So nothing here may *grant* anything — its output is a tier and the reasons
// for it, and a caller that treats a `T0` answer as safe to run without the capability check has misread this module.
//
// The table is in-tree and versioned with the release, deliberately not updatable by a skill (D-066 closing O-032),
// which is why it is a `const` here rather than configuration.

import { maxTier, type Tier } from "./tiers.ts";

/** §4.3's read-only set, verbatim and complete: `ls`, `cat`, `grep`, `git status`. Everything not listed is T2, so a
 *  command cannot acquire a low tier by resembling a known one. Growing this list is a documented change to
 *  `PROVIDERS_AND_TOOLS.md` §4.3 first, never a code change alone. */
export const READ_ONLY_COMMANDS: readonly string[] = ["ls", "cat", "grep", "git status"];

/** §4.3's known-destructive patterns, each with the string it matches. A pattern is matched against the *whole*
 *  command after normalization, because `sudo rm -rf` and `rm  -rf` must not be two different problems. */
export const DESTRUCTIVE_PATTERNS: readonly { readonly pattern: RegExp; readonly label: string }[] =
  [
    { pattern: /\brm\s+(-[a-z]*[rf][a-z]*\s+)+/i, label: "recursive or forced rm" },
    { pattern: /\bdd\b/i, label: "dd" },
    { pattern: /\bmkfs(\.[a-z0-9]+)?\b/i, label: "mkfs" },
    { pattern: /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;\s*:/, label: "fork bomb" },
    { pattern: /\bgit\s+push\b[^\n]*(--force\b|-f\b|--force-with-lease\b)/i, label: "force push" },
    { pattern: /\bchmod\s+(-[a-z]*R[a-z]*\s+)?777\b/i, label: "chmod 777" },
    { pattern: /\bchown\s+(-[a-z]*R[a-z]*\b)?/i, label: "recursive chown" },
    { pattern: /\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(ba)?sh\b/i, label: "curl-pipe-shell" },
    { pattern: /\bkill(all)?\b.*(-9\s+-1|--.signal=KILL)\b/i, label: "mass process kill" },
    { pattern: /\b(shutdown|reboot|halt|poweroff)\b/i, label: "power state change" },
    { pattern: /\b(systemctl|service)\b/i, label: "service control" },
    {
      pattern: /\b(pkg|apt|apt-get|apk|npm|pnpm|yarn)\b.*\b(install|uninstall|remove|upgrade)\b/i,
      label: "package management",
    },
  ];

/** Redirection and substitution, §4.3's second bullet: "a `T0` command with a `> ~/.bashrc` redirect is a write".
 *  `2>&1` and `>/dev/null` are the two forms that genuinely mean nothing, and they are the only ones forgiven. */
const CHAIN = /[;|]|\|\||&&/;
const SUBSTITUTION = /\$\(|`|<\(|>\(/;
const REDIRECT = /(?:^|\s)\d?>{1,2}\s*(\S+)/g;
const HARMLESS_REDIRECT_TARGETS = new Set(["/dev/null"]);

export interface ShellAssessment {
  readonly tier: Tier;
  /** The rule that produced the tier, so an approval prompt can name it. "friction and information" is only real if
   *  the reason is shown rather than applied silently. */
  readonly reasons: readonly string[];
  readonly matchedPatterns: readonly string[];
  /** True when redirection, substitution, or a chain made this assessment a whole-line judgement rather than a
   *  per-command one (§4.3). */
  readonly reEvaluated: boolean;
  /** Paths the command writes to, from redirections. Empty for anything the classifier cannot parse, which is the
   *  honest answer and not a safe one — hence the tier never *drops* because of it. */
  readonly writeTargets: readonly string[];
  readonly command: string;
}

/** One segment, as the classifier's first pass sees it. */
function assessSegment(segment: string): { tier: Tier; reasons: string[]; patterns: string[] } {
  const text = segment.trim();
  if (text === "") return { tier: "T0", reasons: [], patterns: [] };
  for (const { pattern, label } of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(text)) return { tier: "T3", reasons: [label], patterns: [label] };
  }
  const readable = READ_ONLY_COMMANDS.some((cmd) => text === cmd || text.startsWith(`${cmd} `));
  if (readable) return { tier: "T0", reasons: ["read-only command"], patterns: [] };
  // `git status` is on the list and `git checkout` is not, so a subcommand check is a substring check on the exact
  // documented strings. Anything else is the document's "everything else → T2".
  return { tier: "T2", reasons: ["not on the read-only list"], patterns: [] };
}

export function assessShellCommand(command: string): ShellAssessment {
  const reasons: string[] = [];
  const patterns: string[] = [];
  const writeTargets: string[] = [];

  let redirection = false;
  for (const match of command.matchAll(REDIRECT)) {
    const target = (match[1] ?? "").replace(/^["']|["']$/g, "");
    // `2>&1` and `>&2` merge descriptors; they are not a write to a file named `&1`.
    if (target === "" || target.startsWith("&") || HARMLESS_REDIRECT_TARGETS.has(target)) continue;
    redirection = true;
    writeTargets.push(target);
  }
  const substitution = SUBSTITUTION.test(command);
  const chained = CHAIN.test(command);
  const reEvaluated = redirection || substitution || chained;

  // A chain is judged segment by segment and the highest tier wins; a substitution is judged as one opaque command,
  // because the classifier does not execute the inner command to find out. `$(...)` inside an otherwise read-only
  // segment is therefore T2 at best, which is the point of the rule.
  // Destructive patterns are matched against the whole line *before* it is split, because the pattern is about the
  // shape of the pipeline: `curl https://x.y | sh` is curl-pipe-shell, and splitting it into `curl https://x.y` plus
  // `sh` would find two harmless halves.
  for (const { pattern, label } of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(command)) {
      return {
        tier: "T3",
        reasons: [label],
        matchedPatterns: [label],
        reEvaluated,
        writeTargets,
        command,
      };
    }
  }

  const segments = substitution ? [command] : command.split(/[;\n]|\|\||&&|\|/);
  let tier: Tier = "T0";
  for (const segment of segments) {
    const assessed = assessSegment(segment);
    tier = maxTier(tier, assessed.tier);
    for (const reason of assessed.reasons) if (!reasons.includes(reason)) reasons.push(reason);
    for (const pattern of assessed.patterns)
      if (!patterns.includes(pattern)) patterns.push(pattern);
  }

  if (substitution) {
    reasons.push("command substitution is opaque, so the whole command is judged together");
  }
  if (chained) {
    reasons.push("a chained command is judged as the worst of its parts");
  }
  if (redirection) {
    reasons.push(`redirects to ${writeTargets.join(", ")}, which is a write`);
    tier = maxTier(tier, "T1");
  }

  return {
    tier,
    reasons,
    matchedPatterns: patterns,
    reEvaluated,
    writeTargets,
    command,
  };
}

/** §4.3's "a capability that vanished since registration must produce `unsupported-capability`, not a silent
 *  degradation", expressed for the one case policy can decide without a provider: a tool the registry does not know.
 *  Callers use this before they reach for a tier. */
export const UNCLASSIFIED_TIER: Tier = "T2";
