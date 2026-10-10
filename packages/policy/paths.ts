// Path judgement for `file.*` and for anything a shell command points at. `SECURITY.md` §8 is the source, and its
// ordering is the whole design: normalize, check, resolve links, then **check again** — "Absolute paths, `..`
// traversal, and symlink resolution must be normalized and re-checked *after* resolving links." A function that
// checks once and returns a boolean is where these bugs live, so containment and sensitivity are re-run on the
// resolved path and the first answer is discarded.

import path from "node:path";

/** §8's sensitive default deny-list, as data. It is "configurable, user-owned" in the product; the list here is the
 *  default, and the only direction a configuration may move it is *adding* entries (the same one-way rule tiers
 *  follow). The four browser-profile directories are the concrete instances of the doc's "browser profile
 *  directories" category; a new browser needs its path added here and the category sentence in §8 left alone. */
export const SENSITIVE_HOME_SEGMENTS: readonly string[] = [".ssh", ".gnupg", ".aws", ".config/gh"];
export const SENSITIVE_BROWSER_PROFILES: readonly string[] = [
  ".config/google-chrome",
  ".config/chromium",
  ".mozilla/firefox",
  "Library/Application Support/Google/Chrome",
];
export const SENSITIVE_BASENAME_GLOBS: readonly string[] = [
  ".env",
  "*.pem",
  "*.key",
  "credentials*",
];

export interface PathContext {
  readonly home: string;
  readonly dataDir: string;
  /** The configured workspace roots of §8's "one or more configured workspace roots". */
  readonly roots: readonly string[];
}

export type PathVerdict =
  | {
      readonly ok: true;
      readonly resolved: string;
      readonly root: string;
      readonly sensitive: false;
    }
  | { readonly ok: false; readonly reason: string; readonly sensitive: boolean };

/** §8's entries are written as globs (`*.pem`, `credentials*`, `.env*`), so a leading `*` is part of the document's
 *  notation rather than something to normalize away: `*.pem` must match `server.pem`, which sits in a workspace. */
function matchesGlob(basename: string, glob: string): boolean {
  const pattern = glob
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${pattern}$`).test(basename);
}

export function isSensitive(resolved: string, ctx: Pick<PathContext, "home" | "dataDir">): boolean {
  const under = (dir: string) => resolved === dir || resolved.startsWith(dir + path.sep);
  for (const segment of [...SENSITIVE_HOME_SEGMENTS, ...SENSITIVE_BROWSER_PROFILES]) {
    if (under(path.join(ctx.home, segment))) return true;
  }
  if (under(ctx.dataDir)) return true;
  const basename = path.basename(resolved);
  return SENSITIVE_BASENAME_GLOBS.some((glob) => matchesGlob(basename, glob));
}

function contains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * The one path judgement a tool adapter may use. `realpathOf` is injected rather than called directly so the
 * symlink-recheck rule is testable without a filesystem — and so a caller cannot forget to pass it: without it the
 * result is marked `unresolved`, and a write through an unresolved path is refused by `policy.evaluate`.
 */
export function checkPath(
  requested: string,
  ctx: PathContext,
  realpathOf?: (absolutePath: string) => string,
): PathVerdict {
  const base = ctx.roots[0] ?? ctx.home;
  const initial = path.resolve(base, requested);
  const matched = ctx.roots
    .map((root) => path.resolve(root))
    .find((root) => contains(root, initial));
  if (!matched) {
    return {
      ok: false,
      sensitive: isSensitive(initial, ctx),
      reason: `'${requested}' is outside every workspace root`,
    };
  }
  if (isSensitive(initial, ctx)) {
    return {
      ok: false,
      sensitive: true,
      reason: `'${requested}' is on the sensitive deny-list (SECURITY.md §8)`,
    };
  }
  if (!realpathOf) {
    // No resolver: the caller may still read, because reading an unresolved path inside a root that is not sensitive
    // has no second hop to hide. Writing is a different decision, made by evaluate.ts, which refuses it.
    return { ok: true, resolved: initial, root: matched ?? base, sensitive: false };
  }
  const resolved = path.resolve(realpathOf(initial));
  const resolvedRoot = ctx.roots
    .map((root) => path.resolve(root))
    .find((root) => contains(root, resolved));
  if (!resolvedRoot) {
    return {
      ok: false,
      sensitive: isSensitive(resolved, ctx),
      reason: `'${requested}' resolves through a link to '${resolved}', outside every workspace root`,
    };
  }
  if (isSensitive(resolved, ctx)) {
    return {
      ok: false,
      sensitive: true,
      reason: `'${requested}' resolves through a link to '${resolved}', which is on the deny-list`,
    };
  }
  return { ok: true, resolved, root: resolvedRoot, sensitive: false };
}
