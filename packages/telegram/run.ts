// The loop: `getUpdates` → address → gate (inside `handle`) → reply → advance the offset. This is the second half of
// D-069's "transport adapter only" line — grammY's Api performs each call, and **the loop policy is ours**: the offset
// advances only after a handled update (G-S03), `POLL_WAIT_SECONDS` is a long-poll that SIGINT can answer, and a
// Telegram-side failure backs off instead of spinning (G-T02: on recovery, queued outputs go out in order, because the
// sender's floor is still the pacer).

import type { BotReply, CrabbyBot } from "./bot.ts";
import { POLL_WAIT_SECONDS } from "./limit.ts";
import type { TelegramTransport } from "./transport.ts";
import { addressUpdate } from "./transport.ts";

export interface RunOptions {
  readonly transport: TelegramTransport;
  readonly bot: CrabbyBot;
  readonly sender: {
    sendText(
      chatId: string | number,
      text: string,
      options?: { replyTo?: number },
    ): Promise<{ messageId: number }[]>;
  };
  readonly editSettled: (chatId: string, messageId: number, text: string) => Promise<void>;
  readonly answerCallback: (callbackId: string, text: string | undefined) => Promise<void>;
  readonly sendDocument: (
    chatId: string,
    file: { filename: string; content: string; caption: string },
  ) => Promise<void>;
  readonly getOffset: () => number | undefined;
  readonly setOffset: (offset: number) => void;
  readonly signal: AbortSignal;
  /** The backoff between failed polls — injected so tests never sleep, and so a dark period grows honestly. */
  readonly sleep: (ms: number) => Promise<void>;
  readonly log?: (line: string) => void;
}

/** The poll loop. Returns when `signal` aborts; it never throws for a transport outage — it backs off and keeps
 *  polling, because "Telegram API down" is G-T02's state, not a crash. */
export async function runLoop(options: RunOptions): Promise<void> {
  const log = options.log ?? (() => {});
  let backoffMs = 0;
  while (!options.signal.aborted) {
    let updates: ReturnType<typeof addressUpdate>[] = [];
    try {
      const offset = options.getOffset();
      const raw = await options.transport.getUpdates({
        ...(offset === undefined ? {} : { offset: offset + 1 }),
        timeout: POLL_WAIT_SECONDS,
      });
      updates = raw.map(addressUpdate);
      backoffMs = 0;
    } catch (error) {
      if (options.signal.aborted) return;
      backoffMs = backoffMs === 0 ? 2_000 : Math.min(backoffMs * 2, 60_000);
      log(
        `telegram poll failed (${String(error)}) — backing off ${String(Math.round(backoffMs / 1000))}s`,
      );
      await options.sleep(backoffMs);
      continue;
    }
    for (const update of updates) {
      if (update.kind === "ignored") {
        options.setOffset(update.updateId);
        continue;
      }
      let reply: BotReply = {};
      try {
        reply = await options.bot.handle({
          kind: update.kind,
          chatId: update.chatId,
          userId: update.userId,
          messageId: update.messageId,
          chatKind: update.chatKind,
          ...(update.text === undefined ? {} : { text: update.text }),
          ...(update.callback === undefined
            ? {}
            : { callbackId: update.callback.id, data: update.callback.data }),
        });
      } catch (error) {
        // `handle` maps Gateway errors to lines; a throw here is this bot's own bug, and the log is where it goes —
        // never the chat (G2-12's envelope is for refusals, not for stack traces).
        log(`update ${String(update.updateId)} threw: ${String(error)}`);
      }
      try {
        if (reply.callbackAnswer !== undefined && update.callback !== undefined) {
          await options.answerCallback(update.callback.id, reply.callbackAnswer);
        }
        if (reply.editSettled !== undefined && update.messageId !== undefined) {
          await options.editSettled(update.chatId, update.messageId, reply.editSettled);
        } else if (reply.text !== undefined) {
          await options.sender.sendText(update.chatId, reply.text);
        }
        if (reply.file !== undefined) {
          await options.sendDocument(update.chatId, reply.file);
        }
      } catch (error) {
        // G-T06: the send failed after its retry — the answer is logged and the offset still advances, because
        // re-delivering a *handled* update into a de-duplicated bot would be the second kind of loss.
        options.log?.(`reply to ${update.chatId} failed: ${String(error)}`);
      }
      options.setOffset(update.updateId);
    }
  }
}
