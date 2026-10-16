// Telegram's own platform numbers, named once. `docs/review/TELEGRAM.md`'s header is explicit that these are the Bot
// API's documented limits and **not Crabby's choices** — the choices are what the element rows say (split, coalesce,
// opaque id, file instead of text) — and that "a limit that changes silently turns these rows into bugs", which is why
// every limit the client enforces reads one of these names rather than a bare number at the call site.
//
// Source: Telegram Bot API reference, the numbers the inventory quotes (§ header, G2-02, G-A2, G5-01, G5-04, G5-08,
// G-O04). The rows ask for re-verification at implementation time; each constant's comment is the claim it makes, so a
// bot behaving oddly against a changed API is diagnosable from this file alone.

/** A message's text, after entity parsing (G2-02's "4 096 chars max per message"). */
export const MESSAGE_TEXT_MAX = 4_096;

/** A media caption (G5-08: "caption carries the outcome line; the rest goes in the message text"). */
export const CAPTION_MAX = 1_024;

/** `callback_data` on an inline keyboard button (G-A2/G-A3: opaque approval id, ≤64 bytes). */
export const CALLBACK_DATA_MAX = 64;

/** ~1 message/second per chat — the floor the progress coalescer respects (G4-01). Crabby adds headroom: the floor is
 *  a *maximum*, and editing at exactly 1 Hz leaves nothing for the replies a conversation also wants. */
export const EDIT_FLOOR_PRIVATE_MS = 1_100;

/** ~20/minute per group is the documented figure, so a group's floor is the same arithmetic with a margin (G4-01:
 *  "the group figure is lower"). */
export const EDIT_FLOOR_GROUP_MS = 3_100;

/** Bot upload limit for `sendDocument` (G5-04); `getFile` download is the 20 MB figure beside it (G5-01). */
export const UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
export const DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;

/** `setMyCommands` carries at most 10 entries (G-O04: "10 entries max", and a refused-by-policy entry is removed from
 *  the menu rather than left to fail). */
export const MENU_MAX = 10;

/** Long-poll wait per `getUpdates`, in seconds. Short enough that `SIGINT` is answered promptly on a phone, long
 *  enough that a quiet chat is not a request flood. Crabby's choice, not Telegram's. */
export const POLL_WAIT_SECONDS = 25;

/** The inbound shed (G-S10): more command messages than this from one chat in a rolling minute, and the extra ones
 *  are dropped with one "slow down" line per window. The number is Crabby's: low enough to stop a runaway script from
 *  turning the chat into a queue, high enough that a fast typist with three questions never meets it. */
export const INBOUND_SHED_PER_MINUTE = 12;

/** G-A10's split point for an exact target too long for one message: the target goes **whole** in its own message, so
 *  the constant is the ceiling at which the split *decides*, not a truncation. */
export const TARGET_OWN_MESSAGE_AT = 2_000;
