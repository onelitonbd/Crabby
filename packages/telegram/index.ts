// `@crabby/telegram` — the Telegram interface (docs/review/TELEGRAM.md, 129 elements). The seams a caller needs:
// the bot (gate → dispatch), the loop (offset + backoff), the sender (limits + coalescer), and the pure halves the
// tests hold. grammY sits behind `TelegramTransport` and never leaks past it (P-009, D-069).

export {
  approvalKeyboard,
  approvalText,
  callbackAllowed,
  parseCallbackData,
  whyText,
} from "./approvals.ts";
export type { BotConfig, BotDeps, BotReply } from "./bot.ts";
export { CrabbyBot } from "./bot.ts";
export {
  BOT_ABOUT,
  COMMAND_NAMES,
  COMMANDS,
  closestCommand,
  FIRST_RUN_CARD,
  helpText,
  menuCommands,
  parseCommand,
} from "./commands.ts";
export {
  alignTable,
  escapeTelegram,
  splitMessage,
  stampTime,
  toTelegramHtml,
  truncationLabel,
} from "./format.ts";
export * from "./limit.ts";
export { TelegramSender } from "./outbound.ts";
export { runLoop } from "./run.ts";
export type { ChatRecord, TelegramState, WatchRecord } from "./state.ts";
export {
  EMPTY_STATE,
  readTelegramState,
  TELEGRAM_STATE_FILE,
  telegramStatePath,
  writeTelegramState,
} from "./state.ts";
export type { TelegramTransport } from "./transport.ts";
export { addressUpdate, grammYTransport, isRetryable, rateLimitSeconds } from "./transport.ts";
