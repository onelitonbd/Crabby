// The pairing and identity shapes from `docs/INTERFACES_AND_API.md` §3.1–§3.2, as schemas rather than prose, because
// D-069's rule is that a route and a client share one validator: the Gateway validates a code with `Pattern` here and
// the CLI builds the same request against the same object.
import { type Static, Type } from "@sinclair/typebox";

/** The four interfaces D-005 names. An identity is per *interface and device*, not per transport: `SECURITY.md` §13
 *  narrows a client, never a connection. */
export const CLIENT_INTERFACES = ["cli", "tui", "web", "telegram"] as const;
export type ClientInterface = (typeof CLIENT_INTERFACES)[number];

/** §3.2: eight characters from a 32-symbol alphabet with the confusable glyphs left out. The pattern is the whole
 *  alphabet rule expressed once — a client that sends lowercase is told it is invalid rather than being quietly
 *  upper-cased, because the code a user pastes and the code the Gateway minted must be the same bytes. */
export const PAIRING_CODE_PATTERN = "^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$";

/** The lifetime is a storage decision (D-079 numbers `mintPairingCode`'s TTL); this string is the human-facing
 *  half of the same number so a CLI cannot print "a few minutes" while the row expires in 120 s. */
export const PAIRING_CODE_TTL_HINT = "2 minutes";

export const PairRequestBody = Type.Object(
  { code: Type.String({ pattern: PAIRING_CODE_PATTERN }) },
  { additionalProperties: false },
);
export type PairRequestBody = Static<typeof PairRequestBody>;

export const PairCodeRequestBody = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 64 }),
    interface: Type.Union(CLIENT_INTERFACES.map((name) => Type.Literal(name))),
  },
  { additionalProperties: false },
);
export type PairCodeRequestBody = Static<typeof PairCodeRequestBody>;

/** What `GET /auth/clients` answers. No secret is in here by construction — the client record's only credential is a
 *  digest column that the storage layer never selects (`INTERFACES_AND_API.md` §3.1). */
export const ClientRecord = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    name: Type.String({ minLength: 1 }),
    interface: Type.Union(CLIENT_INTERFACES.map((name) => Type.Literal(name))),
    capabilities: Type.Array(Type.String()),
    createdAt: Type.String({ format: "date-time" }),
    lastUsedAt: Type.Optional(Type.String({ format: "date-time" })),
  },
  { additionalProperties: false },
);
export type ClientRecord = Static<typeof ClientRecord>;
