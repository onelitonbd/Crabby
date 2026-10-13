// `docs/INTERFACES_AND_API.md` §4.4's `/config` row as bytes four interfaces can agree on, and §2's concurrency rule
// applied to a file instead of to a row.
//
// The row promised three paths — `GET /config`, `PUT /config`, `GET /config/schema` — and §2's concurrency row promised
// "`If-Match`-style version tokens on config and session mutations, so two interfaces editing the same thing do not
// silently overwrite". Sessions got theirs in D-104; config got nothing, and `docs/INTERFACES_AND_API.md` §2 said why
// out loud: "Config mutations still have no token, because there is no config route — a token with nothing to present it
// to is a control nobody can use." This module is the token's half of the answer, and the routes are the other.
//
// Two shapes here are decisions rather than conveniences, and D-107 is where they are recorded:
//
//   - **The token is a hash of what the file says, not a monotonic integer.** D-104 chose an integer for a session and
//     gave its reason — "a hash would make 'which of us is newer' unanswerable" — and the reason holds for a row, where
//     the database already keeps a counter. A file has no counter that is not itself a new fact in the user's
//     configuration, and `docs/DATA_AND_MEMORY.md` §4.1 says what that file holds: "Overrides only". So the token is
//     derived from the bytes instead of stored beside them, and what it buys is exactly what §2 asks for: a write that
//     would land on top of somebody else's is refused with both tokens named. Which of two writers was newer is answered
//     by the log line the write makes, not by the token.
//   - **A write is a whole document, not a key.** `PUT` replaces what the file says, so the safe pattern is the one §2
//     describes: read, edit, put with the token you read. A single-key mutation is what `crabby config set` and the
//     `config.set` tool do, and both of them perform the same read-modify-write against the same token, so there is one
//     concurrency rule and three callers of it rather than three rules.
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import type { Problem } from "./validate.ts";

/** What `GET /api/v1/config` answers. Two views of one file, because a client that showed only the merged view could not
 *  tell an override from a default, and a client that showed only the file could not tell what the process is running on:
 *  `file` is what the file says and is the document `PUT` replaces, while `config` has D-074's defaults folded in. */
export interface ConfigReadBody {
  readonly file: Readonly<Record<string, unknown>>;
  readonly config: Readonly<Record<string, unknown>>;
  readonly limits: Readonly<Record<string, unknown>>;
  /** §2's version token, and the value an `If-Match` has to equal. Opaque: a client presents it back and never parses
   *  it, which is why it is a hash rather than a number a client might be tempted to increment. */
  readonly token: string;
  /** Where the file lives, whether or not it exists yet — `crabby config path` answers the same question, and a
   *  settings screen that could not show it would be editing a document nobody could find. */
  readonly path: string;
  readonly exists: boolean;
  /** `loadConfig`'s rule 2: a file with a bad key is not a reason to refuse to run, so the problems travel with the
   *  usable part instead of replacing it. A settings screen prints these beside the fields they name. */
  readonly problems: readonly Problem[];
  /** The dotted paths whose values were withheld, because §4.2's `config.get` row is "Secret *names* only, never
   *  values". Empty in a valid file, and the reason it can be non-empty is `loadConfig`'s own rule 2: a key the schema
   *  refuses is dropped from the *merged* view but a bad leaf inside a good branch survives into `file`. */
  readonly redacted: readonly string[];
  readonly note: string;
}

/** What `PUT /api/v1/config` answers: the same document, plus the two facts a caller has to act on. */
export interface ConfigWriteBody extends ConfigReadBody {
  /** Whether the document moved, and — because it is the same fact seen from the other side — whether a restart is what
   *  makes the write take effect. The running Gateway composed its providers, its executor, its limits and its egress
   *  allow-list from the configuration it loaded at startup, so a write that changed the file is a fact about the next
   *  start and a settings screen renders this as a restart banner; a write that changed nothing needs no banner, which is
   *  why one flag answers both questions and a second field would only ever repeat it. A client that hid this would be
   *  showing a switch that does nothing. */
  readonly changed: boolean;
}

/** The body `PUT /api/v1/config` accepts: the whole document, and nothing beside it. Validated twice, and deliberately —
 *  here as a shape (§4.4's first step, so a body that is not an object never reaches the writer) and again in
 *  `packages/core` against `ConfigFile`, which is the schema `crabby config schema --json` prints and therefore the one
 *  opinion about what a key may be. */
export const PutConfigBody = Type.Object(
  {
    config: Type.Record(Type.String(), Type.Unknown(), {
      description:
        "The whole of `config.json` as it should read after this write — overrides only, never the defaults, because a " +
        "document that pinned D-074's numbers into the file would make the next default change unreachable. Requires " +
        "`If-Match` with the token `GET /config` answered (§2's concurrency row).",
    }),
  },
  { additionalProperties: false },
);
export type PutConfigBody = Static<typeof PutConfigBody>;

/** The `ETag` a config answer carries. Quoted because RFC 9110 requires an entity-tag to be a quoted string, for the
 *  reason `sessionETag` gives: a token a standard says is malformed is a token a proxy may rewrite. */
export function configETag(token: string): string {
  return `"${token}"`;
}

export type ConfigIfMatch =
  | { readonly ok: true; readonly token: string }
  | { readonly ok: false; readonly reason: string };

/** Reads an `If-Match` header for a config write. Not `parseIfMatch`, and the difference is the token's shape: that one
 *  parses D-104's integer revision, and a hash is not an integer. `undefined` means the header was absent, which the
 *  caller answers separately from a header that is present and unreadable — one is a client that did not know the rule
 *  and the other is a client that tried and got it wrong. A weak comparator is accepted and its weakness ignored, because
 *  the comparison here is of two hashes of the same file and there is no byte-level equality left to weaken. */
export function parseConfigIfMatch(header: string | undefined): ConfigIfMatch | undefined {
  if (header === undefined) return undefined;
  const text = header.trim().replace(/^W\//i, "");
  const match = /^"([0-9a-f]{8,128})"$/.exec(text) ?? /^([0-9a-f]{8,128})$/.exec(text);
  const token = match?.[1];
  if (token === undefined)
    return {
      ok: false,
      reason:
        `If-Match is '${header}', and the token for a config write is the opaque one \`GET /api/v1/config\` answered in ` +
        "its `etag` — a hash of what the file says, presented back unchanged. A token this shape cannot be compared, so " +
        "the write is refused rather than applied on top of whatever the file now holds",
    };
  return { ok: true, token };
}

/** The refusals a config write can answer with, and the HTTP class each belongs to. A union for the reason
 *  `SESSION_ACTION_CODES` is one: a new refusal fails to compile until somebody says what it means over HTTP. */
export const CONFIG_ACTION_CODES = ["stale", "invalid", "unwritable"] as const;
export type ConfigActionCode = (typeof CONFIG_ACTION_CODES)[number];

/** `stale` is a conflict: the file is not what the caller read, and the fix is to read it again. `invalid` is the
 *  caller's document, so it is a validation answer. `unwritable` is this device — a read-only mount, a full disk — which
 *  is not the caller's document and not a conflict, so it is an internal answer with the platform's own words in it. */
export const CONFIG_REFUSAL_CLASS: Readonly<
  Record<ConfigActionCode, "conflict" | "validation" | "internal">
> = {
  stale: "conflict",
  invalid: "validation",
  unwritable: "internal",
};
