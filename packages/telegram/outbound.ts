// Region G2 + G4's sending half: the one place bytes leave for Telegram, and therefore the one place the API's limits
// are honored (D-064's retry contract, Telegram side). What lives here and nowhere else:
//
//   * the split (G2-02) and the truncation label (G2-03), with HTML fallback to plain (G2-04);
//   * the per-chat floor — ~1 msg/s private, lower for groups (G4-01) — because "the floor is a maximum, not a target";
//   * the 429 `retry_after` wait (G4-06), with the task's work never stopped by a notification limit;
//   * one retry, then the answer is recorded rather than lost (G-T06);
//   * the progress coalescer: newest state wins (G4-02), edits held to the floor, **approvals bypass it** (G-A13).

import { splitMessage, toTelegramHtml } from "./format.ts";
import {
  CAPTION_MAX,
  EDIT_FLOOR_GROUP_MS,
  EDIT_FLOOR_PRIVATE_MS,
  MESSAGE_TEXT_MAX,
} from "./limit.ts";
import { rateLimitSeconds } from "./transport.ts";

export interface SentMessage {
  readonly messageId: number;
}

/** The sleep the sender can be told to wait by tests — injected so no test waits a real second. */
export type Sleeper = (ms: number) => Promise<void>;

export const realSleeper: Sleeper = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface SenderDeps {
  readonly transport: {
    sendMessage(
      chatId: string | number,
      text: string,
      other?: { parse_mode?: "HTML"; reply_to_message_id?: number; reply_markup?: unknown },
    ): Promise<{ message_id: number }>;
    editMessageText(
      chatId: string | number,
      messageId: number,
      text: string,
      other?: { parse_mode?: "HTML"; reply_markup?: unknown },
    ): Promise<unknown>;
  };
  /** The log a failed send is written to (G-T06), so the answer is not lost and `/tasks` shows it. */
  readonly recordFailedSend?: (chatId: string, text: string, reason: string) => void;
  readonly sleep?: Sleeper;
  readonly now?: () => number;
}

export class TelegramSender {
  private readonly lastSendAt = new Map<string, number>();
  private readonly deps: SenderDeps;

  constructor(deps: SenderDeps) {
    this.deps = deps;
  }

  private floor(chatId: string): number {
    return chatId.startsWith("-") ? EDIT_FLOOR_GROUP_MS : EDIT_FLOOR_PRIVATE_MS;
  }

  private async pace(chatId: string): Promise<void> {
    const sleep = this.deps.sleep ?? realSleeper;
    const now = this.deps.now ?? Date.now;
    const last = this.lastSendAt.get(chatId);
    if (last !== undefined) {
      const wait = last + this.floor(chatId) - now();
      if (wait > 0) await sleep(wait);
    }
    this.lastSendAt.set(chatId, now());
  }

  /** One attempt with D-064's shape: honor `retry_after`, retry a transient once, and record — never silently drop. */
  private async attempt<T>(work: () => Promise<T>, chatId: string, describe: string): Promise<T> {
    const sleep = this.deps.sleep ?? realSleeper;
    try {
      return await work();
    } catch (error) {
      const after = rateLimitSeconds(error);
      if (after !== undefined) {
        // G4-06: the wait is Telegram's number, with a small margin so a boundary retry does not land on the edge.
        await sleep((after + 1) * 1000);
        return await work();
      }
      const { isRetryable } = await import("./transport.ts");
      if (isRetryable(error)) {
        await sleep(1000);
        return await work();
      }
      // The thrown shape is a Telegram error object, not an Error — name its code so the record (G-T06's lifeboat)
      // says what the API refused, not "[object Object]".
      const code = (error as { error_code?: number }).error_code;
      throw new Error(
        `telegram send failed (${describe}) to ${chatId}: ${code === undefined ? String(error) : `HTTP ${String(code)}`}`,
      );
    }
  }

  /** G2-02 + G2-04 + G4-08's partial-delivery rule: split at line boundaries, marker count is real, and the parts
   *  after a failure are delivered when the window opens — the loop below simply keeps going. */
  async sendText(
    chatId: string | number,
    text: string,
    options?: { replyTo?: number },
  ): Promise<SentMessage[]> {
    const sent: SentMessage[] = [];
    const parts = splitMessage(text, MESSAGE_TEXT_MAX);
    let last: SentMessage | undefined;
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      if (part === undefined) continue;
      const body = part.marker === undefined ? part.text : `${part.text}\n${part.marker}`;
      await this.pace(String(chatId));
      const rendered = toTelegramHtml(body);
      const replyTo =
        options?.replyTo !== undefined && i === 0 ? { reply_to_message_id: options.replyTo } : {};
      last = await this.attempt(
        async () => {
          const message = await this.deps.transport.sendMessage(chatId, rendered ?? body, {
            ...(rendered === undefined ? {} : { parse_mode: "HTML" as const }),
            ...replyTo,
          });
          return { messageId: message.message_id };
        },
        String(chatId),
        `part ${String(i + 1)}/${String(parts.length)}`,
      ).catch((error) => {
        // G-T06: retried once inside `attempt`; recording is the answer's lifeboat, not a second retry.
        this.deps.recordFailedSend?.(String(chatId), body, String(error));
        return undefined;
      });
      if (last !== undefined) sent.push(last);
    }
    return sent;
  }

  /** G5-08: the caption carries the outcome line; the rest goes in the text — so the caller hands both and this
   *  method clips the caption to the API's own 1 024 rather than letting the API reject the whole send. */
  async sendDocument(
    chatId: string | number,
    document: { filename: string; media: Uint8Array | string },
    caption: string,
    send: (
      document: { filename: string; media: Uint8Array | string },
      caption: string,
    ) => Promise<SentMessage>,
  ): Promise<SentMessage> {
    const clipped =
      caption.length > CAPTION_MAX ? `${caption.slice(0, CAPTION_MAX - 1)}…` : caption;
    await this.pace(String(chatId));
    return await send(document, clipped);
  }

  /** G4-01/G4-02: progress edits for one message, newest wins, floor enforced, and a queued edit collapses into the
   *  next real one instead of queueing a burst. */
  private readonly pendingEdits = new Map<
    string,
    { text: string; timer: ReturnType<typeof setTimeout> | undefined }
  >();

  editProgress(
    chatId: string | number,
    messageId: number,
    text: string,
    render: (text: string) => void,
  ): void {
    const key = `${String(chatId)}:${String(messageId)}`;
    const pending = this.pendingEdits.get(key);
    const now = this.deps.now ?? Date.now;
    if (pending !== undefined && pending.timer !== undefined) {
      // Newest state wins; the older text is dropped from the *message* but was never lost as a record (G4-02).
      this.pendingEdits.set(key, { text, timer: pending.timer });
      return;
    }
    const last = this.lastEditAt.get(key) ?? 0;
    const wait = Math.max(0, last + this.floor(String(chatId)) - now());
    if (wait === 0) {
      this.lastEditAt.set(key, now());
      render(text);
      return;
    }
    const timer = setTimeout(() => {
      const queued = this.pendingEdits.get(key);
      this.pendingEdits.set(key, { text, timer: undefined });
      this.lastEditAt.set(key, now());
      render(queued?.text ?? text);
    }, wait);
    this.pendingEdits.set(key, { text, timer });
  }

  private readonly lastEditAt = new Map<string, number>();

  /** G-A13: approvals bypass the coalescer — a decision waits for nobody. */
  async sendApprovalBypassingCoalescer(
    chatId: string | number,
    text: string,
    keyboard: unknown,
  ): Promise<SentMessage> {
    const rendered = toTelegramHtml(text);
    const message = await this.deps.transport.sendMessage(chatId, rendered ?? text, {
      ...(rendered === undefined ? {} : { parse_mode: "HTML" as const }),
      reply_markup: keyboard,
    });
    return { messageId: message.message_id };
  }
}

/** G4-01's floor is the sender's; the watcher renders its next line and calls `editProgress` — the floor decides when
 *  the API actually sees it. */
export function progressEditSink(
  sender: TelegramSender,
  chatId: string | number,
  messageId: number,
) {
  return (text: string, doEdit: (text: string) => void) =>
    sender.editProgress(chatId, messageId, text, doEdit);
}
