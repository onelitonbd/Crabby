// CLI exit codes: `docs/INTERFACES_AND_API.md` §7.1's sentence turned into data — `0` success, `1` failure, `2`
// usage/validation, `3`
// needs-approval, `4` platform-unsupported. Four interfaces plus scripts all read the same five numbers, so they are
// exported as one frozen object rather than written out at each call site.
export const EXIT = Object.freeze({
  success: 0,
  failure: 1,
  usage: 2,
  needsApproval: 3,
  platformUnsupported: 4,
} as const);

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export const EXIT_CODES: readonly ExitCode[] = [0, 1, 2, 3, 4];

export function isExitCode(value: unknown): value is ExitCode {
  return typeof value === "number" && (EXIT_CODES as readonly number[]).includes(value);
}

/** Error class → exit code. The mapping is a contract because a script branches on it: a denied approval is `3`, a
 *  missing binary on this platform is `4`, and both would otherwise look like `1`. An `auth` failure is deliberately
 *  *not* `3`: §7.1 reserves that code for "approval needed, no answer reachable", and a pairing problem is not an
 *  approval. */
export function exitCodeForErrorClass(name: string): ExitCode {
  switch (name) {
    case "validation":
      return EXIT.usage;
    case "policy":
      return EXIT.needsApproval;
    case "platform-unsupported":
      return EXIT.platformUnsupported;
    default:
      return EXIT.failure;
  }
}
