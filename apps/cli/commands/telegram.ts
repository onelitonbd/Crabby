// `crabby telegram start` — §7.4's interface row: the bot process against this machine's Gateway. This file is the
// composition root: config → the vault sentence (G1-03's token rule meets this build's honest absence of a resolver)
// → the real transport → the loop, until SIGINT.
//
// Why start refuses in this build rather than taking a token some other way: the inventory is explicit (G1-03) that
// the token lives in the vault, referenced as `vault://telegram`, "never in argv, never in a URL, never printed by
// any command" — and `packages/providers/compose.ts` already established what a build without the vault says when a
// secret is referenced: it refuses, names the milestone, and does not accept the secret through a side door. The bot
// itself is fully implemented behind `TelegramTransport` and tested against an injected one; `startTelegramLoop`
// below is the wiring it will run, reviewable in one place, one gate away.
import process from "node:process";
import { EXIT, type ExitCode } from "@crabby/api-contracts";
import { loadConfig } from "@crabby/core";
import { createClient } from "@crabby/gateway";
import type { DataLayout } from "@crabby/platform";
import type { TelegramTransport } from "@crabby/telegram";
import {
  CrabbyBot,
  menuCommands,
  readTelegramState,
  runLoop,
  TelegramSender,
  writeTelegramState,
} from "@crabby/telegram";
import type { Renderer } from "../output.ts";

export async function runTelegramStart(
  _argv: readonly string[],
  layout: DataLayout,
  renderer: Renderer,
): Promise<ExitCode> {
  // The config is loaded the one way every surface loads it — a second loader would be a second opinion about what
  // the file means (D-060's schema is the meaning).
  const loaded = loadConfig(layout);
  const telegram = loaded.config.telegram;
  if (telegram === undefined || telegram.token === undefined) {
    renderer.line("telegram", "not configured — config.json carries no `telegram.token`");
    renderer.fix(
      'set it by reference — `crabby config set telegram.token "vault://telegram"` — and list the allowed users ' +
        "with `crabby config set telegram.allowUsers '[\"<id>\"]'` (§5.2: being able to message the bot is not " +
        "authorization)",
    );
    return EXIT.usage;
  }
  // G1-03/§3.3: the token is a vault reference, and this build resolves no vault references (the vault is M5).
  // Refusing here is the same sentence the provider composition gives, for the same reason: a bot that cannot read
  // its own credential must not go looking for it in argv or the environment.
  renderer.line("token", `${telegram.token} — a vault reference`);
  renderer.line("vault", "this build resolves no vault:// references (the vault arrives in M5)");
  renderer.fix(
    "the bot ships fully implemented and tested against an injected transport; `telegram start` begins polling the " +
      "day the vault resolves (docs/review/TELEGRAM.md G1-03). The allow-list needs no vault: `crabby config set " +
      "telegram.allowUsers …`",
  );
  return EXIT.platformUnsupported;
}

/** The wiring, one gate away: the vault's resolution turns this function into the running interface. Kept exported
 *  and honest rather than deleted-and-rewritten-later, so the day it is called, nothing here is new code. */
export async function startTelegramLoop(
  transport: TelegramTransport,
  options: {
    readonly url: string;
    readonly layout: DataLayout;
    readonly allowUsers: readonly string[];
    readonly allowChats: readonly string[];
    readonly zone: string | undefined;
  },
  renderer: Renderer,
): Promise<ExitCode> {
  const client = createClient({ url: options.url });
  const sender = new TelegramSender({
    transport,
    recordFailedSend: (chat, text, reason) =>
      // G-T06: the failed answer is recorded where the operator reads, and /tasks shows the state — never silently
      // dropped, never retried into a wall (G1-11).
      renderer.line("send failed", `${chat}: ${reason} — kept: ${text.slice(0, 40)}`),
  });
  const bot = new CrabbyBot({
    transport,
    client,
    sender,
    state: readTelegramState(options.layout),
    config: {
      allowUsers: options.allowUsers,
      allowChats: options.allowChats,
      zone: options.zone,
    },
    persist: (state) => writeTelegramState(options.layout, state),
    recordDeniedAttempt: (chatId, userId) =>
      renderer.line("denied attempt", `chat ${chatId} user ${userId} — nothing answered (G1-01)`),
    log: (line) => renderer.line("telegram", line),
  });
  // G-O04: the menu, once, at start — the menu and G3 agree because both render from the same table. A refusal from
  // Telegram here is logged and never fatal: the commands work typed even if the menu could not be set.
  try {
    await transport.setMyCommands(menuCommands());
  } catch (error) {
    renderer.line(
      "menu",
      `setMyCommands refused (${String(error)}) — typed commands are unaffected`,
    );
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  renderer.line(
    "telegram",
    `polling — paired chats: ${String(Object.keys(readTelegramState(options.layout).chats).length)}`,
  );
  renderer.line(
    "stop",
    "Ctrl-C; the offset is persisted, so a restart replays nothing already handled",
  );
  await runLoop({
    transport,
    bot,
    sender,
    editSettled: async (chatId, messageId, text) => {
      await transport.editMessageText(chatId, messageId, text);
    },
    answerCallback: async (callbackId, text) => {
      await transport.answerCallbackQuery({
        callback_query_id: callbackId,
        ...(text === undefined ? {} : { text }),
      });
    },
    sendDocument: async (chatId, file) => {
      const bytes = new TextEncoder().encode(file.content);
      await sender.sendDocument(
        chatId,
        { filename: file.filename, media: bytes },
        file.caption,
        async (document, caption) => {
          const sent = await transport.sendDocument(chatId, document, caption);
          return { messageId: sent.message_id };
        },
      );
    },
    getOffset: () => readTelegramState(options.layout).offset,
    setOffset: (offset) =>
      writeTelegramState(options.layout, { ...readTelegramState(options.layout), offset }),
    signal: controller.signal,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (line) => renderer.line("telegram", line),
  });
  return EXIT.success;
}
