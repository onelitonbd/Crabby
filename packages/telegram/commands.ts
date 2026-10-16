// Region G3 — the command surface's *grammar*, separate from what the commands do (`surface.ts`). One command per
// parity-matrix capability, and `docs/INTERFACES_AND_API.md` §7.4 is explicit that the list may not be curated down:
// "a missing command is a missing capability". What Telegram may choose is how little needs typing — the numbering in
// `/tasks` so `/cancel 2` works, the keyboard for approvals — and this file is where that choice lives as data.
export interface CommandSpec {
  readonly name: string;
  /** One line for `/help` (G3-28: every command, and the row count of region G3 is the source of the count). */
  readonly about: string;
  /** G-O04: the ten-entry Telegram menu. A refused-by-policy command never appears here (G-O04's own rule). */
  readonly menu: boolean;
  /** G3-31/G7-03/G7-08/G6-06: the command is refused *as a rule*, and the refusal names the owning row. */
  readonly refused?: { readonly reason: string; readonly row: string };
}

/** The list, in the order a person meets them (conversation → tasks → approvals → sessions and context → models and
 *  tools → data and settings → self-description). `/start` is not here — it is not a capability, it is the handshake
 *  (§7.4) — and it is handled before this table is consulted. */
export const COMMANDS: readonly CommandSpec[] = [
  {
    name: "ask",
    about: "/ask <text> — one question, no plan, no tool escalation (G3-01)",
    menu: true,
  },
  {
    name: "task",
    about: "/task <objective> — start a task; the reply carries the id (G3-02)",
    menu: true,
  },
  { name: "tasks", about: "/tasks — active and recent tasks, numbered (G3-03)", menu: true },
  {
    name: "watch",
    about: "/watch <n|id> — attach progress edits to this chat (G3-04)",
    menu: false,
  },
  {
    name: "unwatch",
    about: "/unwatch <n|id> — stop the edits, keep the task (G3-05)",
    menu: false,
  },
  {
    name: "cancel",
    about: "/cancel [n|id] — three-phase stop, reported as it settles (G3-06)",
    menu: false,
  },
  {
    name: "resume",
    about: "/resume <n|id> — from the checkpoint, never a restart (G3-07)",
    menu: false,
  },
  {
    name: "approve",
    about: "/approve <id> — the typed path beside the keyboard (G3-08)",
    menu: false,
  },
  {
    name: "deny",
    about: "/deny <id> [reason] — the reason lands on the record (G3-09)",
    menu: false,
  },
  { name: "approvals", about: "/approvals — the pending queue (G3-10)", menu: true },
  { name: "sessions", about: "/sessions — this chat's sessions (G3-11)", menu: false },
  { name: "new", about: "/new — another session in this chat (G3-12)", menu: false },
  {
    name: "rename",
    about: "/rename <n|id> <title> — rename what this chat points at (G3-32)",
    menu: false,
  },
  { name: "context", about: "/context — what is in the working context (G3-13)", menu: false },
  { name: "compact", about: "/compact — force compaction now (G3-14)", menu: false },
  {
    name: "model",
    about: "/model — configured models; switching per-session is a gap note (G3-15)",
    menu: false,
  },
  {
    name: "providers",
    about: "/providers — the configured providers, no secrets (G3-16)",
    menu: false,
  },
  { name: "probe", about: "/probe <model> — capability probe (G3-17)", menu: false },
  { name: "tools", about: "/tools — tools with tier and enabled state (G3-18)", menu: false },
  { name: "memory", about: "/memory — review, search, forget (G3-19)", menu: false },
  { name: "ext", about: "/ext — list, info, validate (G3-20)", menu: false },
  {
    name: "config",
    about: "/config <key> [value] — read, or confirm a diff before it is written (G3-21)",
    menu: false,
  },
  { name: "logs", about: "/logs — tail of the log, redacted (G3-22)", menu: false },
  { name: "export", about: "/export — this session as a file (G3-23)", menu: false },
  { name: "delete", about: "/delete <n|id> — the session title typed back (G3-24)", menu: false },
  {
    name: "tunnel",
    about: "/tunnel on|off — T3, identities named before it acts (G3-25)",
    menu: false,
  },
  { name: "jobs", about: "/jobs — the schedule list (G3-33)", menu: false },
  { name: "job", about: "/job <n|id> — one job with its keyboard (G3-34)", menu: false },
  {
    name: "report",
    about: "/report — the sanitized diagnostics bundle as a file (G3-35)",
    menu: false,
  },
  {
    name: "status",
    about: "/status — Gateway, vault, tunnel, queue, approvals (G3-26)",
    menu: true,
  },
  { name: "health", about: "/health — reachable, and since when (G3-27)", menu: true },
  {
    name: "help",
    about: "/help — every command, and the limits by their owning row (G3-28)",
    menu: true,
  },
  // G3-31's refusals are rows too: the two documented limitations, surfaced in the interface that has them.
  {
    name: "pair",
    about: "/pair — refused: identity minting is local-only (G7-03)",
    menu: false,
    refused: {
      reason:
        "pairing cannot happen from a chat — identity minting is local-only, and this is the one accepted " +
        "parity exception (G7-03, D-053). Run `crabby auth pair --interface telegram` on the Gateway's host, then " +
        "send /start <code> here",
      row: "G7-03",
    },
  },
  {
    name: "auth",
    about: "/auth — refused: access changes are local-only (G7-03)",
    menu: false,
    refused: {
      reason:
        "access changes are local-only (G7-03, D-053): revoking an identity that carries this chat's only way " +
        "back in, from inside the chat, can lock you out with no local client open. Use `crabby auth list/revoke`",
      row: "G7-03",
    },
  },
  {
    name: "restart",
    about: "/restart — refused: the process carries this interface (G7-08)",
    menu: false,
    refused: {
      reason:
        "restarting the Gateway from a chat can lock you out over this very link (G7-08, D-053/D-058) — a local " +
        "client runs `crabby gateway restart`, which confirms because it is T3",
      row: "G7-08",
    },
  },
  {
    name: "shutdown",
    about: "/shutdown — refused: same local-only logic as restart (G7-08)",
    menu: false,
    refused: {
      reason:
        "shutting the Gateway down from a chat is the same lock-out as restarting it, one step worse (G7-08). " +
        "A local client runs `crabby gateway stop`",
      row: "G7-08",
    },
  },
];

export const COMMAND_NAMES: readonly string[] = COMMANDS.map((command) => command.name);

/** G-O04's ten entries, menu-flagged, truncated to the documented max. */
export function menuCommands(): { command: string; description: string }[] {
  return COMMANDS.filter((command) => command.menu)
    .slice(0, 10)
    .map((command) => ({
      command: `/${command.name}`,
      description: command.about.split(" — ")[1] ?? command.name,
    }));
}

/** G3-28: `/help` renders from this table, so the row count *is* the command count and neither can drift from the
 *  other. The limitations are named by their owning rows, per the element text. */
export function helpText(): string {
  const lines = COMMANDS.map((command) => command.about);
  const limits = [
    "limits: pairing/revocation from chat — refused (G7-03)",
    "limits: provider add from chat — refused (G6-06)",
    "limits: gateway restart from chat — refused (G7-08)",
    "limits: content transits Telegram's servers (G-S07)",
  ];
  return [lines.join("\n"), "", limits.join("\n")].join("\n");
}

export interface ParsedCommand {
  readonly name: string;
  readonly args: string;
  /** True when the command named the bot explicitly (`/tasks@crabby_bot`) — the group form (G1-06/G1-07). */
  readonly addressed: boolean;
}

/** Parse one message's text into a command. Telegram's privacy mode means a group deliverable is a command or a
 *  mention; the mention inside someone else's sentence is not a command (G1-07), so the parse only succeeds when the
 *  slash **starts** the text. */
export function parseCommand(text: string, botUsername?: string): ParsedCommand | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const match = /^\/([a-zA-Z0-9_]+)(@([A-Za-z0-9_]+))?(\s([\s\S]*))?$/.exec(trimmed);
  if (match === null) return undefined;
  const name = (match[1] ?? "").toLowerCase();
  const addressedTo = match[3];
  if (addressedTo !== undefined && botUsername !== undefined && addressedTo !== botUsername)
    return undefined;
  return { name, args: (match[5] ?? "").trim(), addressed: addressedTo !== undefined };
}

/** G3-29: an unknown command names the closest real command — the one place silence is not allowed, because a real
 *  answer and "you are not on the allow-list" must not look identical. Distance is a bounded Levenshtein with an
 *  early give-up: a typo is one transposition, not an essay. */
export function closestCommand(name: string): string | undefined {
  let best: { readonly name: string; readonly distance: number } | undefined;
  for (const candidate of COMMAND_NAMES) {
    const distance = boundedLevenshtein(name, candidate, 3);
    if (distance === undefined) continue;
    if (best === undefined || distance < best.distance) best = { name: candidate, distance };
  }
  if (best === undefined) return undefined;
  return best.distance <= (name.length <= 4 ? 1 : 2) ? best.name : undefined;
}

function boundedLevenshtein(a: string, b: string, max: number): number | undefined {
  if (Math.abs(a.length - b.length) > max) return undefined;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
      current.push(value);
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > max) return undefined;
    previous = current;
  }
  return previous[b.length];
}

/** G-O03: the first-run card is the invite, not a second catalogue — ≤5 lines, ending in `→ /help`. */
export const FIRST_RUN_CARD = [
  "this chat talks to your Crabby Gateway: ask with /ask, start work with /task",
  "approvals arrive here with buttons; /approvals lists what is waiting",
  "status is /status, health is /health",
  "→ /help",
].join("\n");

/** G-O05: what strangers read. One sentence, no security detail, no version promise (PROJECT_BRIEF.md's rule). */
export const BOT_ABOUT =
  "A chat front for your own Crabby agent Gateway: ask questions, run tasks, answer approvals from your phone.";
