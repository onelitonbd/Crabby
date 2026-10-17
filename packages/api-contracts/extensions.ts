// `docs/INTERFACES_AND_API.md` §4's `/extensions` rows as bytes: the installed-record list, the validate and install
// bodies, and the report history (D-039's two-version answer to "when did this start failing").
//
// The records themselves are `@crabby/extensions`' `InstalledExtension` — the repo (folders are the truth, §13's
// reconcile) and these shapes agree because the route passes the store's own rows through rather than re-deriving a
// second list. Nothing here knows Fastify; four interfaces read these.
import { type Static, Type } from "@sinclair/typebox";

/** `POST /extensions/validate` and `POST /extensions/install` share one body: the path of the pack to read. Absolute,
 *  because the Gateway serves a device and a relative path would be relative to *its* cwd — a fact a caller cannot
 *  know and so must not lean on. */
export const ExtPackBody = Type.Object(
  {
    path: Type.String({
      minLength: 1,
      description: "Absolute path of the SKILL.md pack to validate or install.",
    }),
  },
  { additionalProperties: false },
);
export type ExtPackBody = Static<typeof ExtPackBody>;

/** One row of `GET /extensions`' answer — structurally `@crabby/extensions`' `InstalledExtension`. `version` is
 *  absent when the pack declares none, which is a fact a row renders as "no version", never as a blank. */
export interface InstalledExtensionRow {
  readonly name: string;
  readonly kind: "skill";
  readonly source: "workspace" | "import";
  readonly installedAt: string;
  readonly version?: string;
  readonly path: string;
  readonly originalPath?: string;
  readonly lastReportPath?: string;
}

/** `GET /extensions`' answer: the list §13 reconciles from the folders, the names both the workspace and the imported
 *  repo claim (the imported copy wins the listing), and the verdict each pack's own check produced — a list that made
 *  a user run `validate` per row would be a list pretending the check does not exist. */
export interface ExtListBody {
  readonly items: readonly (InstalledExtensionRow & {
    readonly verdict: "compatible" | "partial" | "incompatible" | "unsafe";
  })[];
  readonly count: number;
  readonly collisions: readonly string[];
}

/** One conversion report of `GET /extensions/{id}/reports`, file name beside the parsed body because D-039's
 *  diffability is about *which* report said what — and the newest first, because that is the one a user opens. */
export interface ExtensionReportRow {
  readonly file: string;
  readonly report: Record<string, unknown>;
}

/** `GET /extensions/{id}/reports`' answer. Depth is the store's own rule (D-065 closing O-027): the installed version
 *  and the one before it are kept, older ones are pruned, so an unbounded history is not a promise to shrink here. */
export interface ExtensionReportsBody {
  readonly items: readonly ExtensionReportRow[];
  readonly count: number;
}
