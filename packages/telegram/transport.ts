// The transport seam. P-009/D-069 accepted **grammY as the transport adapter only** — update parsing, `retry_after`
// handling and 429 backoff "live in Crabby's code ... because the retry policy is a contract for all four interfaces
// (D-064) and cannot be delegated to a library's convenience". So this file is the one place that touches the library:
// the rest of the package programs against `TelegramTransport`, and the tests inject a fake. That seam is also what
// makes the whole bot verifiable in a sandbox where api.telegram.org is unreachable.
import { Api, InputFile } from "grammy";
import type { Update } from "grammy/types";

/** The outbound calls the bot makes, as an interface — the shape grammY's `Api` already has, narrowed to what Crabby
 *  uses, so a fake is ten lines and a real call site cannot grow a second transport by accident. */
export interface TelegramTransport {
  getMe(): Promise<{ id: number; username: string }>;
  getUpdates(args: { offset?: number; timeout: number }): Promise<Update[]>;
  sendMessage(
    chatId: string | number,
    text: string,
    other?: { parse_mode?: "HTML"; reply_to_message_id?: number; reply_markup?: unknown },
  ): Promise<{ message_id: number; chat: { id: number } }>;
  editMessageText(
    chatId: string | number,
    messageId: number,
    text: string,
    other?: { parse_mode?: "HTML"; reply_markup?: unknown },
  ): Promise<unknown>;
  sendDocument(
    chatId: string | number,
    document: { filename: string; media: Uint8Array | string },
    caption?: string,
  ): Promise<{ message_id: number }>;
  answerCallbackQuery(args: { callback_query_id: string; text?: string }): Promise<unknown>;
  setMyCommands(commands: { command: string; description: string }[]): Promise<unknown>;
}

/** A Telegram API failure with its `retry_after` pulled out — G4-06: "honor it, keep working the task". The library
 *  raises `GrammyError` shapes for non-2xx answers; what the policy needs is the one number the API sends, so this
 *  predicate reduces any thrown thing to (isRateLimit, seconds) and the sender decides. */
export function rateLimitSeconds(thrown: unknown): number | undefined {
  if (typeof thrown !== "object" || thrown === null) return undefined;
  const error = thrown as {
    message?: string;
    error_code?: number;
    parameters?: { retry_after?: number };
  };
  if (error.error_code !== 429) return undefined;
  const after = error.parameters?.retry_after;
  if (typeof after === "number" && after >= 0) return after;
  // Some error shapes carry the number only in the message text; one bounded read, no regex optimism.
  const match = /retry after (\d+)/i.exec(error.message ?? "");
  return match === null ? 1 : Number(match[1]);
}

/** D-064's retry contract, Telegram side: an error is retryable when the API said so (`retry_after`), when it named a
 *  server-side condition (5xx), or when it was a network-level failure — and never when it named *our* request as
 *  wrong, because retrying a 400 is how a bot floods. */
export function isRetryable(thrown: unknown): boolean {
  if (rateLimitSeconds(thrown) !== undefined) return true;
  if (typeof thrown !== "object" || thrown === null) return true; // network-level: fetch throws TypeError
  const error = thrown as { error_code?: number; message?: string };
  if (typeof error.error_code === "number") return error.error_code >= 500;
  return !(error.message ?? "").includes("400");
}

/** The real transport: grammY's `Api`. The core client has *no* automatic retry of its own — a 429 surfaces as a
 *  thrown error with `error_code: 429`, which is exactly the shape `rateLimitSeconds` reads — so Crabby's sender is
 *  the one retry policy, per D-069. Only `start` builds this; tests inject their own. */
export function grammYTransport(token: string): TelegramTransport {
  const api = new Api(token);
  return {
    getMe: async () => {
      const me = await api.getMe();
      return {
        id: me.id,
        username:
          me.username === undefined || me.username.length === 0 ? String(me.id) : me.username,
      };
    },
    getUpdates: (args) => api.getUpdates(args),
    sendMessage: async (chatId, text, other) => {
      const rest = (other ?? {}) as Parameters<typeof api.sendMessage>[2];
      const message = await api.sendMessage(chatId, text, rest);
      return { message_id: message.message_id, chat: { id: message.chat.id } };
    },
    editMessageText: (chatId, messageId, text, other) =>
      api.editMessageText(
        chatId,
        messageId,
        text,
        (other ?? {}) as Parameters<typeof api.editMessageText>[3],
      ),
    sendDocument: async (chatId, document, caption) => {
      const media =
        typeof document.media === "string"
          ? document.media
          : new InputFile(Buffer.from(document.media), document.filename);
      const message = await api.sendDocument(chatId, media, {
        ...(caption === undefined ? {} : { caption }),
      });
      return { message_id: message.message_id };
    },
    answerCallbackQuery: (args) =>
      api.answerCallbackQuery(
        args.callback_query_id,
        args.text === undefined ? {} : { text: args.text },
      ),
    setMyCommands: (commands) => api.setMyCommands(commands),
  };
}

/** The inbound updates the bot actually consumes, narrowed from grammY's wide `Update` union. Keeping the narrow shape
 *  here (rather than threading the union everywhere) is what makes G1-01's gate a one-line predicate and G-S04's
 *  identity rule explicit: the sender id comes from `from.id`, never from message text. */
export interface AddressedUpdate {
  readonly updateId: number;
  readonly kind: "message" | "callback" | "ignored";
  readonly chatId: string;
  readonly chatKind: "private" | "group";
  readonly userId: string;
  readonly messageId: number | undefined;
  readonly text?: string | undefined;
  readonly callback: { readonly id: string; readonly data: string } | undefined;
}

/** The parse — ours, per D-069. A bot's own messages (G1-08) and every channel-post/media shape this build does not
 *  consume (G5-03 refuses them at the surface, not here) collapse to `ignored` before the gate even runs. */
export function addressUpdate(update: Update): AddressedUpdate {
  const updateId = update.update_id;
  const message = "message" in update ? update.message : undefined;
  const callback = "callback_query" in update ? update.callback_query : undefined;
  if (message !== undefined && "text" in message && typeof message.text === "string") {
    const from = message.from;
    if (from === undefined || from.is_bot) {
      // G1-08: never re-ingest the bot's own output — `is_bot` is Telegram's word for it, and a stray `from` is
      // likewise not a person to answer.
      return {
        updateId,
        kind: "ignored",
        chatId: String(message.chat.id),
        chatKind: message.chat.type === "private" ? "private" : "group",
        userId: "",
        messageId: message.message_id,
        text: undefined,
        callback: undefined,
      };
    }
    return {
      updateId,
      kind: "message",
      chatId: String(message.chat.id),
      chatKind: message.chat.type === "private" ? "private" : "group",
      userId: String(from.id),
      messageId: message.message_id,
      text: message.text,
      callback: undefined,
    };
  }
  if (callback !== undefined) {
    const from = callback.from;
    const message = callback.message;
    return {
      updateId,
      kind: "callback",
      chatId: String(message?.chat.id ?? from.id),
      chatKind: message?.chat.type === "private" ? "private" : "group",
      userId: String(from.id),
      messageId: message?.message_id,
      callback: { id: callback.id, data: callback.data ?? "" },
    };
  }
  const chatId = message !== undefined ? String(message.chat.id) : "0";
  return {
    updateId,
    kind: "ignored",
    chatId,
    chatKind: "private",
    userId: "",
    messageId: message?.message_id,
    text: undefined,
    callback: undefined,
  };
}
