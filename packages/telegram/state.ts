// The bot process's own state file: `telegram.json` in the state directory, 0600. D-078 names the state directory's
// five files and says a sixth name "is a decision to be recorded here, not a constant to be added quietly" — so the
// sixth name is recorded (DECISIONS.md, the row this file's header cites) rather than smuggled in. Why a sixth file at
// all: `client.json` is *a* paired client's credential, and on this machine it belongs to the CLI; a bot that wrote its
// identity there would be wearing another client's name in every audit row (G7-05), and `crabby auth revoke` of that
// client would decapitate a different interface.
//
// What lives here: the bot's gateway identity (one per chat — G1-04's name read literally: a chat redeems its own code,
// so the audit record says `telegram` plus the chat, and revoking one chat never touches another), each chat's session
// mapping, the watch registry, and the getUpdates offset (G-S03: an update is processed once, including across a
// restart). What never lives here: the bot token (G1-03 — the vault, referenced from config) and any pairing code
// (§5.1 — never logged, never persisted).
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DataLayout } from "@crabby/platform";

export const TELEGRAM_STATE_FILE = "telegram.json";

export interface ChatRecord {
  readonly clientId: string;
  readonly token: string;
  readonly pairedAt: string;
  /** The Telegram user id that paired this chat — G-A4's verification input, and G7-06's actor for a private chat. */
  readonly userId: string | undefined;
  /** The session this chat points at (G1-04); `/new` moves it, the old one stays reachable via /sessions. */
  readonly sessionId: string | undefined;
  /** G1-12: the private chat an allow-listed owner paired from — the address a group refusal (G1-05) is explained in. */
  readonly kind: "private" | "group";
}

export interface WatchRecord {
  readonly chatId: string;
  readonly messageId: number;
  readonly lastSeq: number;
  readonly startedAt: string;
}

export interface TelegramState {
  readonly chats: Readonly<Record<string, ChatRecord>>;
  readonly watches: Readonly<Record<string, WatchRecord>>;
  /** The last update_id this process handled (G-S03). `undefined` until the first update. */
  readonly offset: number | undefined;
  /** The number the shed counted in the current window (G-S10) — persisted so a restart does not reset a flood away. */
  readonly shed: number | undefined;
}

export const EMPTY_STATE: TelegramState = {
  chats: {},
  watches: {},
  offset: undefined,
  shed: undefined,
};

export function telegramStatePath(layout: DataLayout): string {
  return path.join(layout.stateDir, TELEGRAM_STATE_FILE);
}

/** 0600, same argument as `client.json`'s: the file carries bearer material (G7-05's attribution depends on nobody
 *  else wearing these tokens), and a filesystem that will not set the mode is not one this code can force — so the
 *  chmod is best-effort exactly where the Gateway's own credential writes are. */
export function writeTelegramState(layout: DataLayout, state: TelegramState): void {
  const file = telegramStatePath(layout);
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* as with client.json: the write is the act, the mode is the filesystem's grace */
  }
}

export function readTelegramState(layout: DataLayout): TelegramState {
  const file = telegramStatePath(layout);
  if (!existsSync(file)) return EMPTY_STATE;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<TelegramState>;
    return {
      chats: parsed.chats ?? {},
      watches: parsed.watches ?? {},
      offset: parsed.offset,
      shed: parsed.shed,
    };
  } catch {
    // A state file this process cannot parse is a state it cannot trust with tokens it is about to re-derive anyway:
    // pairing is a /start away, so losing a corrupt file loses a mapping, not a conversation.
    return EMPTY_STATE;
  }
}

export function chatKey(chatId: string | number): string {
  return String(chatId);
}
