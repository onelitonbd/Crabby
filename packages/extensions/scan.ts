// §6 step 6, as one deterministic function: the static safety scan every import passes through — native or converted
// (§11 rule 5) — because inert content is still *untrusted content* (§3), and the poisoning path is a description that
// activates itself.
//
// The pattern list is short on purpose and each entry names itself: a scan that cried wolf on every shell word would
// train the reader to click through it, which is the one failure a security line must not have. A match is a verdict
// of `unsafe` (§6.1: rejected outright, no install-anywhere path in this release), and the line names the pattern so a
// human can read the actual text and disagree with the pattern's author — in the report, not by overriding the verdict.
export interface ScanLine {
  readonly pattern: string;
  readonly reason: string;
  /** Where it matched: `description` or `body` — the two strings a model reads. */
  readonly where: "description" | "body";
}

export interface ScanResult {
  readonly unsafe: boolean;
  readonly lines: readonly ScanLine[];
}

interface Pattern {
  readonly id: string;
  readonly reason: string;
  readonly re: RegExp;
}

/** The patterns, named for the report. Each is an instruction aimed at the agent or a payload aimed at the shell —
 *  the two things inert content must never carry. */
const PATTERNS: readonly Pattern[] = [
  {
    id: "instruction-override",
    reason:
      "text that tells the agent to disregard its instructions — the definition of a prompt injection (§1.3)",
    re: /ignore\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier)\s+(?:instructions|rules|prompts)/i,
  },
  {
    id: "role-hijack",
    reason: "text that reassigns the agent's identity mid-run",
    re: /\byou\s+are\s+now\s+(?:a|an|the)\b/i,
  },
  {
    id: "secret-exfiltration",
    reason: "text that asks the agent to reveal secrets or credentials it holds",
    re: /\b(?:reveal|print|show|exfiltrate|output)\s+(?:your|the|all)\s+(?:system\s+prompt|secrets?|api\s+keys?|tokens?|credentials?)/i,
  },
  {
    id: "shell-payload",
    reason: "a shell one-liner that fetches and executes remote code — not a procedure, a payload",
    re: /(?:curl|wget)\s+[^|\n]+\|\s*(?:ba)?sh\b/i,
  },
  {
    id: "destructive-command",
    reason: "a destructive filesystem command as a bare instruction",
    re: /rm\s+-rf\s+(?:~|\/)/,
  },
];

/** Scan the two strings a model reads. Deterministic: the lines come back in pattern order, so the same text always
 *  produces the same report (§6's reproducibility rule). */
export function scanContent(description: string, body: string): ScanResult {
  const lines: ScanLine[] = [];
  for (const pattern of PATTERNS) {
    if (pattern.re.test(description)) {
      lines.push({ pattern: pattern.id, reason: pattern.reason, where: "description" });
    }
    if (pattern.re.test(body)) {
      lines.push({ pattern: pattern.id, reason: pattern.reason, where: "body" });
    }
  }
  return { unsafe: lines.length > 0, lines };
}
