// The approval queue's wire shapes: the five states a row can be in (`SECURITY.md` §6.3's lifecycle, which
// `packages/agent-runtime` decides the transitions of) and the two §4.3 bodies a surface sends. What is deliberately
// absent is any rule about whether an answer *counts*. D-084 put the arbiter in the runtime, and a contract that
// restated "this approval is expired" would be a second arbiter — the same mistake `task.ts`'s header explains for the
// task state machine, caught before it was made a second time.
import { type Static, Type } from "@sinclair/typebox";

/** The five states of an approval row. `packages/storage/migrate.ts`'s `CHECK` constraint and this list are the same
 *  five, and `packages/storage/approvals.test.ts` asserts that against the database rather than trusting the copy. */
export const APPROVAL_STATES = ["pending", "approved", "denied", "expired", "consumed"] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];

export function isApprovalState(value: unknown): value is ApprovalState {
  return (APPROVAL_STATES as readonly string[]).includes(String(value));
}

/** `GET /approvals?state=pending` (§4.3). `state` is validated here instead of ignored, because a filter that
 *  silently matches nothing turns a typo into an empty queue, and an empty queue on a phone reads as "nothing needs
 *  you" — the one false negative this feature cannot afford. */
export const ApprovalListQuery = Type.Object(
  {
    state: Type.Optional(Type.Union(APPROVAL_STATES.map((name) => Type.Literal(name)))),
  },
  { additionalProperties: false },
);
export type ApprovalListQuery = Static<typeof ApprovalListQuery>;

/** `POST /approvals/{id}/decision` (§4.3). `scope` is typed as a *string* and not as the literal `"once"` on purpose:
 *  D-052 requires that "a request for a remembered approval is refused", and a request that a schema rejects never
 *  reaches the arbiter that has to say the sentence. The refusal is therefore a `policy` answer citing §6.3, not a
 *  validation error about an enum — which is also what makes it testable from an interface. */
export const ApprovalDecisionBody = Type.Object(
  {
    decision: Type.Union([Type.Literal("approve"), Type.Literal("deny")]),
    scope: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
  },
  { additionalProperties: false },
);
export type ApprovalDecisionBody = Static<typeof ApprovalDecisionBody>;
