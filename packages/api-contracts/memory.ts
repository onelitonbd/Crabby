// `docs/INTERFACES_AND_API.md` §4.4's `/memory` rows as bytes four interfaces can agree on — the review/edit/forget
// surface D-019 promises and D-073 shapes. The request bodies are the only schemas here: a memory *entry* is answered,
// not accepted, so its shape is the store's `MemoryRecord` plus `trustWord`'s rank-as-a-word (D-073: never a
// percentage) and is defined where the store lives.
import { type Static, Type } from "@sinclair/typebox";
import { idPattern } from "./ids.ts";

/** The `:id` a memory route accepts — D-135's seventh prefix, validated by the one pattern the contract owns. */
export const MemId = Type.String({ pattern: idPattern("mem") });

/** The body `POST /api/v1/memory` accepts. `origin`/`sourceKind` default to the honest reading of a request that
 *  arrived over an authenticated owner client: the user stated it. `status: "pending"` is the auto-memory queue made
 *  physical — a proposal a person must review (W8-06) — and is the only way a row starts in that state, because a
 *  memory written silently is a personality change nobody approved (D-073). */
export const CreateMemoryBody = Type.Object(
  {
    content: Type.String({ minLength: 1, maxLength: 8_000 }),
    category: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    origin: Type.Optional(
      Type.Union([Type.Literal("stated"), Type.Literal("confirmed"), Type.Literal("inferred")]),
    ),
    sourceKind: Type.Optional(
      Type.Union([
        Type.Literal("conversation"),
        Type.Literal("task"),
        Type.Literal("user"),
        Type.Literal("agent"),
      ]),
    ),
    sourceId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    sourceCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
    external: Type.Optional(
      Type.Boolean({
        description:
          "The content originated from untrusted external material: the entry reads as `unconfirmed` and stays T2 " +
          "until a user confirms it (W8-07, PROVIDERS_AND_TOOLS §4.2).",
      }),
    ),
    status: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("pending")])),
  },
  { additionalProperties: false },
);
export type CreateMemoryBody = Static<typeof CreateMemoryBody>;

/** The body `PATCH /api/v1/memory/{id}` accepts: the corrected text, and nothing else — every other field a client
 *  might want to move is either a system fact (provenance, timestamps) or an act with its own route (review). W8-03
 *  makes a user edit authoritative: the store re-attributes the entry to `stated`/`user` on this write. */
export const EditMemoryBody = Type.Object(
  { content: Type.String({ minLength: 1, maxLength: 8_000 }) },
  { additionalProperties: false },
);
export type EditMemoryBody = Static<typeof EditMemoryBody>;

/** The body `POST /api/v1/memory/{id}/review` accepts — the pending queue's answer. `approve` activates the proposal;
 *  `reject` deletes it and the answer carries what was removed, because "no" is also a person's memory decision and a
 *  rejection nobody can see is a deletion nobody can audit. */
export const ReviewMemoryBody = Type.Object(
  { decision: Type.Union([Type.Literal("approve"), Type.Literal("reject")]) },
  { additionalProperties: false },
);
export type ReviewMemoryBody = Static<typeof ReviewMemoryBody>;
