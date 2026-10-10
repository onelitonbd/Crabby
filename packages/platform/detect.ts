// Platform facts Crabby can act on, isolated behind interfaces as `ARCHITECTURE.md` §17 requires. Detection is by
// positive markers only: guessing
// "Android" from the absence of something turns every unrecognised system into a false claim, which is the mistake
// this file exists to prevent.
export interface PlatformFacts {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly release: string;
  readonly isTermux: boolean;
  /** `process.platform === "android"`. Android and Termux are *not* separable from here without the markers below,
   *  so this is reported as its own fact instead of being folded into `isTermux`: a phone that looks like Android
   *  without Termux's environment is a case to explain, not a case to guess. */
  readonly isAndroid: boolean;
  readonly prefix: string | undefined;
  readonly uid: number | undefined;
  readonly termuxVersion: string | undefined;
  readonly nodeVersion: string;
}

export interface DetectInput {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly arch?: string;
  readonly release?: string;
  readonly uid?: number | undefined;
  readonly nodeVersion?: string;
}

const TERMUX_PREFIX_MARK = "/com.termux/files/usr";

export function detectPlatform(input: DetectInput): PlatformFacts {
  const prefix = typeof input.env.PREFIX === "string" ? input.env.PREFIX : undefined;
  const termuxVersion =
    typeof input.env.TERMUX_VERSION === "string" ? input.env.TERMUX_VERSION : undefined;
  // Two independent markers, either of which is enough to say Termux. Neither present means "not Termux" — and not
  // "probably Android": the two claims need different evidence, so they are computed separately.
  const isTermux =
    (prefix ? prefix.includes(TERMUX_PREFIX_MARK) : false) || termuxVersion !== undefined;
  return {
    platform: input.platform,
    arch: input.arch ?? "",
    release: input.release ?? "",
    isTermux,
    isAndroid: input.platform === "android",
    prefix,
    uid: input.uid,
    termuxVersion,
    nodeVersion: input.nodeVersion ?? "",
  };
}

export function detectProcess(): PlatformFacts {
  return detectPlatform({
    env: process.env,
    platform: process.platform,
    arch: process.arch,
    release: "",
    uid: typeof process.getuid === "function" ? process.getuid() : undefined,
    nodeVersion: process.version,
  });
}

/** The constraints a platform imposes on the product. Each line has to be a constraint a document already states —
 *  this table is how `doctor` prints D-034's "no workaround" answers instead of improvising them per interface. */
export type PlatformSurface = "termux" | "bare-android" | "server" | "desktop";

export interface PlatformConstraint {
  readonly id: string;
  readonly appliesTo: readonly PlatformSurface[];
  /** What the platform does to Crabby, in the user's terms — `doctor` prints these lines verbatim. */
  readonly text: string;
  /** Where the constraint is written down. A constraint with no document behind it is an assumption, and this
   *  project does not print assumptions as rules. */
  readonly source: string;
}

/** The four constraints `docs/INTERFACES_AND_API.md` §10 imposes, plus the two `docs/DEVELOPMENT.md` §1 and §2's
 *  loopback rule add. This is data rather than prose because `doctor` has to print the *applicable* subset, and an
 *  interface that re-types them will drift from the documents. */
export const PLATFORM_CONSTRAINTS: readonly PlatformConstraint[] = [
  {
    id: "hostile-network",
    appliesTo: ["termux", "bare-android"],
    text: "Network switches drop sockets and Android can freeze a backgrounded process: streams stay short-lived, progress resumes by taskId, and a connection is never how a task makes progress.",
    source: "docs/INTERFACES_AND_API.md §10",
  },
  {
    id: "battery",
    appliesTo: ["termux", "bare-android"],
    text: "An idle interface must not poll aggressively; backgrounded polling backs off by default.",
    source: "docs/INTERFACES_AND_API.md §10",
  },
  {
    id: "tunnel-url-not-sticky",
    appliesTo: ["termux", "bare-android", "server", "desktop"],
    text: "A quick tunnel's public URL changes on restart. The Gateway prints the new one and never redirects the old; shutdown drains in-flight requests for 5 s.",
    source: "docs/INTERFACES_AND_API.md §10 (D-066, closing O-009)",
  },
  {
    id: "loopback-first",
    appliesTo: ["termux", "bare-android", "server", "desktop"],
    text: "The listener binds 127.0.0.1/::1 only; --host needs an explicit remote-mode acknowledgment.",
    source: "docs/INTERFACES_AND_API.md §2",
  },
  {
    id: "build-tools",
    appliesTo: ["termux"],
    text: "Native modules build from source on Termux and need `pkg install python make clang`; a bundled prebuild is used when the loader finds one.",
    source: "docs/DEVELOPMENT.md §1",
  },
] as const;

export type ConstraintId = PlatformConstraint["id"];

export function surfacesFor(
  facts: Pick<PlatformFacts, "isTermux" | "isAndroid" | "platform">,
): PlatformSurface[] {
  if (facts.isTermux) return ["termux"];
  if (facts.isAndroid) return ["bare-android"];
  // Nothing in the documents distinguishes a laptop from a headless box for these constraints, and inventing a
  // difference would let `doctor` print a rule that changes nothing.
  return facts.platform === "linux" || facts.platform === "darwin"
    ? ["server", "desktop"]
    : ["server"];
}

export function constraintsFor(
  facts: Pick<PlatformFacts, "isTermux" | "isAndroid" | "platform">,
): PlatformConstraint[] {
  const surfaces = surfacesFor(facts);
  return PLATFORM_CONSTRAINTS.filter((row) => row.appliesTo.some((s) => surfaces.includes(s)));
}
