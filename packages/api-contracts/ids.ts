// Identifiers, as the documents name them. `docs/INTERFACES_AND_API.md` §5.2 and §6 use five prefixes — `evt_`,
// `ses_`, `apr_`, `req_`, `tsk_` — and no others, so this module exports exactly those and `ids.test.ts` holds it to
// that: an id scheme is a wire contract, and a prefix invented here would be a format nobody approved. D-112 added the
// sixth (`msg_`) the way the documents allow one to be added — the decision first, §6's list beside it, and the test's
// assertion moved with them, so the test still says "exactly what §6 lists" rather than a number.
import { randomBytes as cryptoBytes } from "node:crypto";
import { Type } from "@sinclair/typebox";

export const ID_PREFIXES = ["evt", "ses", "apr", "req", "tsk", "msg"] as const;
export type IdPrefix = (typeof ID_PREFIXES)[number];

/** The documents show `evt_01H…`, which is time-sortable, so ids are generated that way: a lowercase base32 encoding
 *  of the creation millisecond followed by entropy. Sortable is a convenience and never a sequencing rule — ordering
 *  inside a task belongs to `seq` (§5.2), because two ids minted in the same millisecond are ordered by nothing. */
const BASE32 = "0123456789abcdefghjkmnpqrstvwxyz";
const TIME_LEN = 10;
const ENTROPY_LEN = 16;

export function idPattern(prefix: IdPrefix): string {
  return `^${prefix}_[${BASE32}]{${TIME_LEN + ENTROPY_LEN}}$`;
}

export function newId(
  prefix: IdPrefix,
  at: number = Date.now(),
  bytes: (n: number) => Uint8Array = cryptoBytes,
): string {
  return `${prefix}_${base32Time(at)}${base32Random(ENTROPY_LEN, bytes)}`;
}

export function isId(prefix: IdPrefix, value: string): boolean {
  return new RegExp(idPattern(prefix)).test(value);
}

export function idPrefixOf(value: string): IdPrefix | null {
  const head = value.slice(0, 3);
  return (ID_PREFIXES as readonly string[]).includes(head) ? (head as IdPrefix) : null;
}

export const EventId = Type.String({ pattern: idPattern("evt") });
export const SessionId = Type.String({ pattern: idPattern("ses") });
export const ApprovalId = Type.String({ pattern: idPattern("apr") });
export const RequestId = Type.String({ pattern: idPattern("req") });
export const TaskId = Type.String({ pattern: idPattern("tsk") });
/** D-112's sixth prefix: one turn of a conversation. Time-sortable like the rest, which is a convenience and **not** its
 *  place in the conversation — `messages.ordinal` is, because ids minted in one millisecond are ordered by nothing. */
export const MessageId = Type.String({ pattern: idPattern("msg") });

function base32Time(ms: number): string {
  let n = Math.max(0, Math.floor(ms));
  let out = "";
  for (let i = 0; i < TIME_LEN; i++) {
    out = BASE32.charAt(n % 32) + out;
    n = Math.floor(n / 32);
  }
  return out;
}

function base32Random(len: number, bytes: (n: number) => Uint8Array): string {
  let out = "";
  for (const b of bytes(len)) {
    out += BASE32.charAt(b % 32);
    if (out.length >= len) break;
  }
  return out.slice(0, len);
}
