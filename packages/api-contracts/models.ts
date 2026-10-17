// `docs/INTERFACES_AND_API.md` §4.4's `/models` rows as bytes four interfaces can agree on.
//
// The override write is the one D-127 priced twice and built once: `crabby model edit` and this route are two
// interaction shapes over **one** answer shape, and the answer shape is `packages/providers`' `OverrideAnswers` —
// `supports` values are the strings a person types (`"true"`, `"false"`, `"auto"`), not booleans, because `"auto"`
// ("no opinion — remove my claim") is a third state a boolean cannot carry and the whole point of the record is the
// difference between "I never said" and "I said no". The record rules that turn this body into a stored value live in
// `@crabby/providers`' `nextOverride`; nothing here duplicates them.
import { type Static, Type } from "@sinclair/typebox";

/** The body `PUT /api/v1/models/{provider}/{model}/overrides` accepts. Absent fields mean "not asked"; `clear` removes
 *  the whole record and is refused beside any other field, because "clear everything" and "set one flag" are different
 *  requests. */
export const PutModelOverridesBody = Type.Object(
  {
    context: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          "The `contextWindow` ceiling the user declares over the endpoint's report. Budgeting (D-064) reads the " +
          "effective value from the next composition on.",
      }),
    ),
    maxOutput: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          "The `maxOutputTokens` the user declares. §3.8's `reserveForOutput` is not a field here on purpose: D-064 " +
          "derives the reserve from this number, so a second source for it would be a number that could disagree (F-62).",
      }),
    ),
    supports: Type.Optional(
      Type.Record(
        Type.String(),
        Type.Union([Type.Literal("true"), Type.Literal("false"), Type.Literal("auto")]),
        {
          description:
            "Per-feature claim: `true` forces a capability on (a trust decision §3.8 prices), `false` forces it off " +
            "(always allowed, never argued about), `auto` withdraws the user's claim and lets the reported value stand.",
        },
      ),
    ),
    notes: Type.Optional(
      Type.String({
        description:
          "Free text for the human who reads the file next — why the endpoint's report was not believed.",
      }),
    ),
    clear: Type.Optional(
      Type.Boolean({
        description:
          "Remove the whole override record. Refused together with any other field. An unparsable stored record is the " +
          "one state this body can clear without reading it first.",
      }),
    ),
  },
  { additionalProperties: false },
);
export type PutModelOverridesBody = Static<typeof PutModelOverridesBody>;

/** What the write answers: what was stored, what actually moved (composition's provenance rendered as sentences, not
 *  what was typed), and whether the provider composed with the record in place — a write that composition refuses is
 *  `composed: false` with the reason, because the gate is composition's (D-127), applied after the file says what the
 *  user asked it to. `changed` and the `etag` are §2's concurrency pair, the same shape `PUT /config` answers with. */
export interface ModelOverridesWriteBody {
  readonly changed: boolean;
  readonly override: unknown;
  readonly changes: readonly string[];
  readonly composed: boolean;
  readonly composeReason?: string;
  readonly provenance: unknown;
  readonly note: string;
}

/** One row of `POST /api/v1/models/{provider}/{model}/probe`'s table (W10-07/C7-09, D-133). The statuses are closed:
 *  `pass` and `fail` are what this build's own probe observed, `unclaimed` is a capability the descriptor does not claim
 *  (so there is nothing to probe — probing a denial would spend a call proving a negative), and `unprobed` is a claim
 *  this build has no transport to exercise — reported as the claim it is, never silently folded into either verdict. */
export interface ModelProbeRow {
  readonly capability: string;
  readonly claimed: boolean;
  readonly status: "pass" | "fail" | "unprobed" | "unclaimed";
  /** §3.5's class when a probe failed, so the row names *how* it failed and a retry decision is possible without a
   *  second call. */
  readonly errorClass?: string;
  readonly detail?: string;
}

/** The probe's answer: stable row order (the descriptor's own feature order), one row per §3.2 capability, and the
 *  duration beside the timestamp because C7-09 wants output stable enough to diff — and a duration that moved is the
 *  honest reason two diffs differ. */
export interface ModelProbeBody {
  readonly provider: string;
  readonly model: string;
  readonly probedAt: string;
  readonly durationMs: number;
  readonly table: readonly ModelProbeRow[];
  readonly note: string;
}
