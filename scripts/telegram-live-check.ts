// A one-off live check for the Telegram adapter, to run **where api.telegram.org is reachable** — the build sandbox is
// not (its egress allowlist names no Telegram host; the TLS handshake is cut before it starts). The token arrived from
// the owner on 2026-10-16, and the three facts this build had to leave unverified (D-132's "not verified live, and
// named") are exactly the three this script exercises: the token itself (`getMe`), the menu (`setMyCommands`), and the
// poll (`getUpdates`).
//
// Run it with the token in the environment, never in argv and never in a file this script writes (G1-03):
//
//     TG_BOT_TOKEN=<token from @BotFather> npm run telegram:check
//
// Nothing here stores the token anywhere, prints it, or writes a file. It uses the adapter's own transport, so what
// passes here is what `crabby telegram start` will run.
import { menuCommands } from "../packages/telegram/commands.ts";
import { addressUpdate, grammYTransport } from "../packages/telegram/transport.ts";

function describeError(thrown: unknown): string {
  const error = thrown as { error_code?: number; message?: string };
  if (typeof error.error_code === "number") {
    if (error.error_code === 401)
      return "Telegram answered 401 Unauthorized — the token is invalid or was revoked (BotFather → /revoke mints a new one)";
    if (error.error_code === 409)
      return "Telegram answered 409 Conflict — another getUpdates consumer is polling this bot (stop the other one and re-run)";
    return `Telegram answered ${String(error.error_code)}: ${error.message ?? "(no message)"}`;
  }
  if (thrown instanceof Error) return thrown.message;
  return String(thrown);
}

const fail = (message: string): never => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

const token = process.env.TG_BOT_TOKEN ?? "";
if (!/^\d{5,20}:[A-Za-z0-9_-]{30,}$/.test(token)) {
  fail(
    "no token: set TG_BOT_TOKEN in the environment (the bot token from @BotFather) — it is read from the environment and stored nowhere",
  );
}

const transport = grammYTransport(token);

let me: { readonly id: number; readonly username?: string };
try {
  me = await transport.getMe();
} catch (thrown) {
  fail(
    `getMe failed: ${describeError(thrown)}\n  a network-shaped error means api.telegram.org is not reachable from here — run this on the phone or host that will run the bot`,
  );
}
console.log(
  `1/3 token accepted — the bot is @${me.username ?? "(no username)"} (id ${String(me.id)})`,
);

try {
  await transport.setMyCommands(menuCommands());
} catch (thrown) {
  fail(`setMyCommands failed: ${describeError(thrown)}`);
}
console.log(
  `2/3 menu accepted — ${String(menuCommands().length)} commands (setMyCommands, G-O04's cap held)`,
);

let updates: Parameters<typeof addressUpdate>[0][] = [];
try {
  updates = await transport.getUpdates({ timeout: 5 });
} catch (thrown) {
  fail(`getUpdates failed: ${describeError(thrown)}`);
}
console.log(`3/3 polling works — ${String(updates.length)} pending update(s) reached the bot`);
for (const raw of updates.slice(0, 5)) {
  // The parse is ours (D-069), and the print is its shape, not the sender's words — a check script has no business
  // echoing message content into a terminal.
  const addressed = addressUpdate(raw);
  const text = addressed.text === undefined ? "" : ` · text ${String(addressed.text.length)} chars`;
  console.log(
    `    ${addressed.kind} · from ${addressed.userId === "" ? "(none)" : addressed.userId} · chat ${addressed.chatId}${text}`,
  );
}
if (updates.length === 0)
  console.log("    (nothing pending — send /start to the bot and re-run to watch one arrive)");
console.log(
  "all three held: the token, the menu, and the poll. Next: `crabby telegram start` once the token is configured (M5's vault:// for a stored token, this environment variable until then).",
);
