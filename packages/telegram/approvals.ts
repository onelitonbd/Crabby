// Region G-A — approvals on the smallest screen. The fields are the same five the Web card and the TUI modal carry
// (G-A1: "a shorter explanation on the smallest screen is not acceptable"), the buttons are two (G-A2, D-052's
// once-only), and every way this can go wrong — expired, answered elsewhere, double-tapped, tapped by a stranger — is
// a row with its own answer. The keyboard is the common path; `/approve <id>` and `/deny <id>` are the typed path
// (G3-08/G3-09) so a stale keyboard is never a dead end.
import { CALLBACK_DATA_MAX } from "./limit.ts";

/** The approval the Gateway answered `GET /approvals` with — the fields every interface renders. */
export interface ApprovalItem {
  readonly id: string;
  readonly summary?: string | undefined;
  readonly target?: string | undefined;
  readonly consequence?: string | undefined;
  readonly reversible?: boolean | undefined;
  readonly tier?: string | undefined;
  readonly tool?: string | undefined;
  readonly taskId?: string | undefined;
  readonly expiresAt?: string | undefined;
}

/**
 * G-A3: the callback carries the opaque approval id and an opaque nonce — **never the action word**. The nonce is the
 * bot's own per-prompt binding of "this button means approve" / "this button means deny" (a payload that spelled the
 * action would let a replayed or forged callback carry a *different decision than the button the user saw*); a nonce
 * the record does not know is a forged tap and gets nothing. A replay after the item settled finds no record and is
 * answered identically to an unknown id (G-S09) — the same property from the record side.
 */
export function callbackData(approvalId: string, nonce: string): string {
  const data = `apr:${approvalId}:${nonce}`;
  if (data.length > CALLBACK_DATA_MAX) {
    // The Gateway's approval ids are `apr_…` short ids; a longer shape is a contract change and must be loud.
    throw new Error(`callback_data would exceed Telegram's 64 bytes for ${approvalId}`);
  }
  return data;
}

/** The two nonces a sent card carries, minted by the caller (random, per prompt) and held beside the message id. */
export interface ApprovalNonces {
  readonly approve: string;
  readonly deny: string;
}

/** Parse `apr:<id>:<nonce>`; anything else is not this bot's callback. */
export function parseCallbackData(data: string): { id: string; nonce: string } | undefined {
  const match = /^apr:([^:]+):([A-Za-z0-9_-]{4,16})$/.exec(data);
  if (match === null) return undefined;
  return { id: match[1] ?? "", nonce: match[2] ?? "" };
}

/** G-A1: the whole card. Words carry the state (G2-13); the tier is printed on the prompt itself (G7-04). */
export function approvalText(item: ApprovalItem, now = Date.now()): string {
  const lines = [
    item.summary ?? "an action needs your approval",
    "",
    `exact target: ${item.target ?? "(not stated)"}`,
    item.consequence === undefined ? "" : `consequence: ${item.consequence}`,
    item.reversible === undefined
      ? ""
      : `reversible: ${item.reversible ? "yes" : "no — think first"}`,
    `tier: ${item.tier ?? "?"}${item.tool === undefined ? "" : ` · tool: ${item.tool}`}`,
    expiresLine(item.expiresAt, now),
    "",
    item.id,
  ].filter((line) => line.length > 0);
  return lines.join("\n");
}

function expiresLine(expiresAt: string | undefined, now: number): string {
  if (expiresAt === undefined) return "expiry: the queue's own retention";
  const ms = Date.parse(expiresAt) - now;
  if (Number.isNaN(Date.parse(expiresAt))) return `expiry: ${expiresAt}`;
  if (ms <= 0) return "expiry: passed";
  const seconds = Math.round(ms / 1000);
  const readable =
    seconds >= 60
      ? `${String(Math.floor(seconds / 60))}m ${String(seconds % 60)}s`
      : `${String(seconds)}s`;
  return `expires in ${readable}`;
}

/** G-A2: two buttons, one row. */
export interface InlineKeyboard {
  readonly inline_keyboard: { text: string; callback_data: string }[][];
}

export function approvalKeyboard(item: ApprovalItem, nonces: ApprovalNonces): InlineKeyboard {
  return {
    inline_keyboard: [
      [
        { text: "Approve once", callback_data: callbackData(item.id, nonces.approve) },
        { text: "Deny", callback_data: callbackData(item.id, nonces.deny) },
      ],
    ],
  };
}

/** What answering produced, so the caller can edit the message into its settled state (G-A5) and answer the tap
 *  (G-A8). `conflict` is G-A7's answered-elsewhere; `expired` is G-A6; `unknown` is G-S09's identical answer for
 *  never-existed, expired-for-long, and belongs-to-another-chat alike. */
export type DecisionOutcome =
  | { readonly kind: "accepted"; readonly decision: "approve" | "deny" }
  | { readonly kind: "conflict"; readonly answeredIn: string }
  | { readonly kind: "expired" }
  | { readonly kind: "unknown" };

/** The settled line G-A5 replaces the keyboard with: who answered, when, from which client. */
export function settledLine(decision: "approve" | "deny", by: string, when: string): string {
  const word = decision === "approve" ? "approved" : "denied";
  return `${word} by ${by} at ${when} — the keyboard is gone so no stale button can be tapped`;
}

/** G-A4's verification, as a pure predicate: the requester, the chat, and the originating message must all match the
 *  pending item. A wrong user tapping the button in a group gets *nothing* — not an error (G-A4's own sentence). */
export function callbackAllowed(input: {
  readonly userId: string;
  readonly chatId: string;
  readonly messageId: number | undefined;
  readonly record: {
    readonly chatId: string;
    readonly messageId: number | undefined;
    readonly userIds: readonly string[];
  };
}): boolean {
  if (input.record.chatId !== input.chatId) return false;
  if (input.record.messageId !== undefined && input.messageId !== input.record.messageId)
    return false;
  return input.record.userIds.includes(input.userId);
}

/** G-A11: the "why am I being asked" note — same content as Web W-A12 and TUI T-A12. */
export function whyText(item: ApprovalItem): string {
  return [
    `why: tier ${item.tier ?? "?"} of tool ${item.tool ?? "?"} needs a human before it acts — the tier belongs to`,
    "the action, not to the verb that asked for it (A12). This prompt was produced by the Gateway's arbiter,",
    "which names the rule it applied on the record",
  ].join("\n");
}

/** G-A10: an exact target too long for the card goes whole in its own message first, so nobody approves a truncated
 *  string. The predicate decides; the caller sends the target message before the keyboard message. */
export function needsOwnTargetMessage(item: ApprovalItem, at: number): boolean {
  return (item.target?.length ?? 0) > at;
}
