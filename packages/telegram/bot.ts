// The bot itself: the loop, the gate, and the routing of everything Telegram sends to something Crabby answers.
// The inventory's binding case is this file's shape: "what does the user see when it works, and what do they see when
// Telegram's API says no". The gate runs before anything else (G1-01 — an unauthorized sender gets *nothing*, not a
// refusal); the shed keeps one chat's flood from becoming a queue (G-S10); the offset advances only after a handled
// update, so a crash replays into de-duplication, not double approval (G-S03, G-A8).
import { randomBytes } from "node:crypto";
import type { GatewayClient } from "@crabby/gateway";
import {
  type ApprovalItem,
  type ApprovalNonces,
  approvalKeyboard,
  approvalText,
  callbackAllowed,
  type DecisionOutcome,
  needsOwnTargetMessage,
  parseCallbackData,
  settledLine,
  whyText,
} from "./approvals.ts";
import { COMMANDS, closestCommand, FIRST_RUN_CARD, helpText, parseCommand } from "./commands.ts";
import { TARGET_OWN_MESSAGE_AT } from "./limit.ts";
import type { TelegramSender } from "./outbound.ts";
import type { ChatRecord, TelegramState, WatchRecord } from "./state.ts";
import { chatKey } from "./state.ts";
import type { SurfaceContext } from "./surface.ts";
import * as surface from "./surface.ts";
import type { TelegramTransport } from "./transport.ts";

export interface BotConfig {
  /** §5.2's allow-list, from config: user ids always, and (for groups) chat ids. Being able to message the bot is
   *  not authorization; the ids are the authorization. */
  readonly allowUsers: readonly string[];
  readonly allowChats: readonly string[];
  /** G2-09: times quoted in replies carry the Gateway's timezone label. */
  readonly zone: string | undefined;
}

export interface BotDeps {
  readonly transport: TelegramTransport;
  readonly client: GatewayClient;
  readonly sender: TelegramSender;
  state: TelegramState;
  readonly config: BotConfig;
  /** Every state mutation goes through here — the file write is `start`'s (0600, D-078's sixth name). */
  readonly persist?: (state: TelegramState) => void;
  /** §5.2's attempt record — wired to the log by `start`, a spy in tests. */
  readonly recordDeniedAttempt?: (chatId: string, userId: string) => void;
  readonly log?: (line: string) => void;
  readonly now?: () => number;
}

export interface BotReply {
  readonly text?: string | undefined;
  readonly keyboard?: unknown;
  readonly file?: { readonly filename: string; readonly content: string; readonly caption: string };
  /** Answer the callback query with this line instead of sending a message. */
  readonly callbackAnswer?: string | undefined;
  /** Edits the tapped message into its settled state (G-A5). */
  readonly editSettled?: string | undefined;
}

const TERMINAL_EVENTS = new Set([
  "task.completed",
  "task.failed",
  "task.cancelled",
  "task.interrupted",
]);

export class CrabbyBot {
  private readonly deps: BotDeps;
  private readonly numbers = new Map<string, Map<string, string>>();
  private readonly windows = new Map<string, number[]>();
  private readonly shedNotified = new Map<string, number>();
  private readonly approvalCards = new Map<
    string,
    { chatId: string; messageId: number; nonces: ApprovalNonces; userIds: string[] }
  >();

  constructor(deps: BotDeps) {
    this.deps = deps;
  }

  private chat(chatId: string): ChatRecord | undefined {
    return this.deps.state.chats[chatKey(chatId)];
  }

  private setState(state: TelegramState): void {
    this.deps.state = state;
    this.deps.persist?.(state);
  }

  private numbersFor(chatId: string): Map<string, string> {
    let map = this.numbers.get(chatId);
    if (map === undefined) {
      map = new Map();
      this.numbers.set(chatId, map);
    }
    return map;
  }

  /** G1-01's gate, as one predicate: private chats check the user; groups check the chat **and** the user (G1-05,
   *  G7-06). There is no third answer — the gate either opens or the sender is never called. */
  allowed(chatId: string, userId: string, chatKind: "private" | "group"): boolean {
    if (!this.deps.config.allowUsers.includes(userId)) return false;
    if (chatKind === "private") return true;
    return this.deps.config.allowChats.includes(chatId);
  }

  /** G-S10's shed: a rolling minute per chat; over the limit, one "slow down" line per window, the rest dropped —
   *  the answer to spam is never a per-message error. */
  private shed(chatId: string, now: number): boolean {
    const window = (this.windows.get(chatId) ?? []).filter((at) => now - at < 60_000);
    window.push(now);
    this.windows.set(chatId, window);
    const over = window.length > 12;
    if (!over) this.shedNotified.delete(chatId);
    return over;
  }

  /** One Telegram update → what the bot says (or silently does). Errors never escape as Telegram-visible stack
   *  traces: G2-12's envelope for a Gateway refusal, G-T01's one line for a down Gateway. */
  async handle(update: {
    kind: "message" | "callback";
    chatId: string;
    userId: string;
    messageId: number | undefined;
    chatKind: "private" | "group";
    text?: string;
    callbackId?: string;
    data?: string;
  }): Promise<BotReply> {
    if (!this.allowed(update.chatId, update.userId, update.chatKind)) {
      // G1-01: nothing at all — no refusal, no "unknown user". §5.2 asks that attempts be recorded, which is the one
      // side effect, and it goes to the log, never back to the sender.
      this.deps.recordDeniedAttempt?.(update.chatId, update.userId);
      return {};
    }
    if (update.kind === "callback") return this.onCallback(update);
    if (update.text === undefined || update.text.length === 0) return {};
    const now = this.deps.now ?? Date.now;
    if (this.shed(update.chatId, now())) {
      if (this.shedNotified.get(update.chatId) === undefined) {
        this.shedNotified.set(update.chatId, now());
        return {
          text: "slow down — too many messages in a minute; the extras were dropped, nothing queued behind them",
        };
      }
      return {};
    }
    const username = await this.botUsername();
    const parsed = parseCommand(update.text, username);
    if (parsed === undefined) {
      // G1-07: a mention inside someone else's sentence is not a command; in a group, silence. In a private chat,
      // G3-30: bare text is a question, visibly treated as one.
      if (update.chatKind === "group") return {};
      if (this.chat(update.chatId) === undefined) return { text: FIRST_RUN_CARD };
      const reply = await this.runCommand(
        update.chatId,
        update.userId,
        "ask",
        update.text,
        update.messageId,
      );
      return {
        ...reply,
        text:
          reply.text === undefined
            ? undefined
            : `(no command — treated as a question)\n${reply.text}`,
      };
    }
    if (parsed.name === "start") return await this.onStart(update, parsed.args);
    const spec = COMMANDS.find((command) => command.name === parsed.name);
    if (spec?.refused !== undefined) {
      return { text: spec.refused.reason };
    }
    if (spec === undefined) {
      // G3-29: name the closest real command — the one case where silence is not allowed.
      const nearest = closestCommand(parsed.name);
      return {
        text:
          nearest === undefined
            ? `unknown command: /${parsed.name} — /help lists every one`
            : `unknown command: /${parsed.name} — the closest is /${nearest}`,
      };
    }
    if (this.chat(update.chatId) === undefined) {
      return {
        text: "this chat is not paired yet — send /start <code> with the code from the Gateway's host",
      };
    }
    return this.runCommand(
      update.chatId,
      update.userId,
      parsed.name,
      parsed.args,
      update.messageId,
    );
  }

  private async botUsername(): Promise<string | undefined> {
    try {
      return (await this.deps.transport.getMe()).username;
    } catch {
      return undefined; // G-T02: Telegram down — commands still parse unaddressed.
    }
  }

  /** G1-02 + G-O01: `/start` with no code explains the pairing step; `/start <code>` redeems the code into this
   *  chat's own identity (G1-04). The code is short-lived and single-use on the Gateway side; this side never logs
   *  it beyond the two characters the user already sees on their own screen. */
  private async onStart(
    update: { chatId: string; userId: string; chatKind: "private" | "group" },
    code: string,
  ): Promise<BotReply> {
    if (this.chat(update.chatId) !== undefined) {
      return { text: "this chat is already paired — /help lists what it can do" };
    }
    if (code.length === 0) {
      return {
        text: [
          "pairing this chat takes one code, minted on the Gateway's host:",
          "  crabby auth pair --name this-chat --interface telegram",
          "send /start <code> here with the 8-character code it prints — short-lived, single-use, never logged.",
          "keys and workspace roots stay with `crabby init`; a chat cannot do those (G-O01).",
        ].join("\n"),
      };
    }
    try {
      const answer = await this.deps.client.request<{ clientId: string; token: string }>(
        "/api/v1/auth/pair",
        {
          method: "POST",
          body: { code: code.toUpperCase() },
        },
      );
      const body = answer.body as { clientId: string; token: string };
      this.setState({
        ...this.deps.state,
        chats: {
          ...this.deps.state.chats,
          [chatKey(update.chatId)]: {
            clientId: body.clientId,
            token: body.token,
            pairedAt: new Date().toISOString(),
            userId: update.userId,
            kind: update.chatKind,
            sessionId: undefined,
          },
        },
      });
      return { text: `paired as ${body.clientId} — /help lists what this chat can do` };
    } catch (error) {
      const envelope = (error as { envelope?: { error?: { code?: string; message?: string } } })
        .envelope?.error;
      if (envelope !== undefined)
        return {
          text: surface.errorText(
            envelope.code ?? "error",
            envelope.message ?? "the code was refused",
          ),
        };
      return {
        text: "the Gateway is not answering — run `crabby gateway start` from Termux and send /start again",
      };
    }
  }

  private async onCallback(update: {
    chatId: string;
    userId: string;
    messageId: number | undefined;
    callbackId?: string;
    data?: string;
  }): Promise<BotReply> {
    const tapped = update.data === undefined ? undefined : parseCallbackData(update.data);
    if (tapped === undefined || update.callbackId === undefined) return {};
    const card = this.approvalCards.get(`${update.chatId}:${tapped.id}`);
    if (card === undefined) {
      // G-S09: unknown id, unknown nonce, replayed tap — one identical answer, no enumeration channel.
      return { callbackAnswer: "not pending" };
    }
    const action =
      tapped.nonce === card.nonces.approve
        ? "approve"
        : tapped.nonce === card.nonces.deny
          ? "deny"
          : undefined;
    if (action === undefined) return { callbackAnswer: "not pending" };
    if (
      !callbackAllowed({
        userId: update.userId,
        chatId: update.chatId,
        messageId: update.messageId,
        record: { chatId: card.chatId, messageId: card.messageId, userIds: card.userIds },
      })
    ) {
      // G-A4: a wrong user tapping the button in a group gets nothing — not an error.
      return {};
    }
    const outcome = await this.decide(tapped.id, action);
    this.approvalCards.delete(`${update.chatId}:${tapped.id}`);
    if (outcome.kind === "accepted") {
      return {
        callbackAnswer: "recorded",
        // G-A5: the keyboard is replaced by a settled line — a stale button is a trap.
        editSettled: `${settledLine(action, `user ${update.userId}`, new Date((this.deps.now ?? Date.now)()).toISOString())}\n\n${tapped.id}`,
      };
    }
    if (outcome.kind === "conflict") {
      return {
        callbackAnswer: "already answered",
        editSettled: `answered elsewhere — the first answer won, and nothing ran twice (G-A7)\n\n${tapped.id}`,
      };
    }
    if (outcome.kind === "expired") return { callbackAnswer: "expired — send /approve <id> again" };
    return { callbackAnswer: "not pending" };
  }

  private async runCommand(
    chatId: string,
    userId: string,
    name: string,
    args: string,
    messageId: number | undefined,
  ): Promise<BotReply> {
    const record = this.chat(chatId);
    if (record === undefined) return { text: "this chat is not paired yet — /start <code> first" };
    const client = this.chatClient(record.token);
    void userId;
    const ctx: SurfaceContext = {
      client,
      chatId,
      sessionId: record.sessionId,
      resolveTask: (ref) => surface.resolveTaskRef(this.numbersFor(chatId), ref),
      zone: this.deps.config.zone,
    };
    try {
      return await this.dispatch(ctx, chatId, name, args, messageId);
    } catch (error) {
      const envelope = (error as { envelope?: { error?: { code?: string; message?: string } } })
        .envelope?.error;
      if (envelope !== undefined) {
        return {
          text: surface.errorText(
            envelope.code ?? "error",
            envelope.message ?? "the Gateway refused",
          ),
        };
      }
      // G-T01: the Gateway being unreachable is one line with the fix, never a false "working on it".
      return {
        text: "the Gateway is not answering — run `crabby gateway start` from Termux and try again; nothing was half-done",
      };
    }
  }

  /** The chat's own token on the wire: each request carries this chat's identity, so audit rows say `telegram` plus
   *  this chat (G1-04, G7-05) without the bot ever wearing another interface's credential. */
  private chatClient(token: string): surface.SurfaceClient {
    return {
      request: async (route, options) => {
        const response = await this.deps.client.request(route, {
          ...(options?.method === undefined ? {} : { method: options.method }),
          ...(options?.body === undefined ? {} : { body: options.body }),
          headers: { ...(options?.headers ?? {}), authorization: `Bearer ${token}` },
        });
        return { status: response.status, body: response.body };
      },
    };
  }

  private async dispatch(
    ctx: SurfaceContext,
    chatId: string,
    name: string,
    args: string,
    messageId: number | undefined,
  ): Promise<BotReply> {
    const numbers = this.numbersFor(chatId);
    switch (name) {
      case "help":
        return { text: helpText() };
      case "ask": {
        // G3-30's visible guess is prepended by the caller for bare text; a typed /ask needs no prefix.
        const reply = await surface.ask(ctx, args);
        if (reply.sessionId !== undefined) this.noteSession(chatId, reply.sessionId);
        if (reply.taskId !== undefined) await this.watch(chatId, reply.taskId, messageId);
        return { text: reply.text };
      }
      case "task": {
        const reply = await surface.startTask(ctx, args);
        if (reply.sessionId !== undefined) this.noteSession(chatId, reply.sessionId);
        return { text: reply.text };
      }
      case "tasks": {
        const reply = await surface.listTasks(ctx, numbers);
        return { text: reply.text };
      }
      case "watch": {
        const id = surface.resolveTaskRef(numbers, args.split(/\s+/)[0]);
        if (id === undefined)
          return { text: "which task? /watch <n|id> — the numbers are /tasks' rows" };
        return await this.watch(chatId, id, messageId);
      }
      case "unwatch": {
        const id = surface.resolveTaskRef(numbers, args.split(/\s+/)[0]);
        if (id === undefined) return { text: "which task? /unwatch <n|id>" };
        return this.unwatch(chatId, id);
      }
      case "cancel": {
        const reply = await surface.cancelTask(ctx, args.split(/\s+/)[0], numbers);
        return { text: reply.text };
      }
      case "resume": {
        const reply = await surface.resumeTask(ctx, args.split(/\s+/)[0], numbers);
        return { text: reply.text };
      }
      case "approve": {
        const id = args.split(/\s+/)[0] ?? "";
        const outcome = await this.decide(id, "approve");
        return { text: this.decisionLine(outcome, id) };
      }
      case "deny": {
        const parts = args.split(/\s+/);
        const outcome = await this.decide(
          parts[0] ?? "",
          "deny",
          parts.length > 1 ? parts.slice(1).join(" ") : undefined,
        );
        return { text: this.decisionLine(outcome, parts[0] ?? "") };
      }
      case "approvals": {
        const reply = await surface.listApprovals(ctx);
        return { text: reply.text };
      }
      case "sessions": {
        const own = Object.values(this.deps.state.chats)
          .map((chat) => chat.sessionId)
          .filter((id): id is string => id !== undefined);
        const reply = await surface.listSessions(ctx, own);
        return { text: reply.text };
      }
      case "new": {
        const created = await surface.newSession(ctx);
        if (created.sessionId !== undefined) this.noteSession(chatId, created.sessionId);
        return { text: created.text };
      }
      case "rename": {
        const reply = await surface.renameSession(ctx, args);
        return { text: reply.text };
      }
      case "context": {
        const reply = await surface.showContext(ctx);
        return { text: reply.text };
      }
      case "compact": {
        const reply = await surface.compactNow(ctx);
        return { text: reply.text };
      }
      case "model": {
        const reply = await surface.listModels(ctx);
        return { text: reply.text };
      }
      case "providers": {
        const reply = await surface.listProviders(ctx);
        return { text: reply.text };
      }
      case "probe": {
        const reply = surface.probeModel(args);
        return { text: reply.text };
      }
      case "tools": {
        const reply = await surface.listTools(ctx);
        return { text: reply.text };
      }
      case "memory":
        return { text: surface.memoryCommand().text };
      case "ext":
        return { text: surface.extensionsCommand().text };
      case "config": {
        const reply = await surface.configCommand(ctx, args);
        return { text: reply.text };
      }
      case "logs":
        return { text: surface.logsCommand().text };
      case "export":
        return { text: surface.exportCommand().text };
      case "delete":
        return { text: surface.deleteCommand().text };
      case "tunnel":
        return { text: surface.tunnelCommand(args.split(/\s+/)[0]).text };
      case "jobs": {
        const reply = await surface.listJobs(ctx);
        return { text: reply.text };
      }
      case "job": {
        const parts = args.split(/\s+/);
        if (parts[0] === "edit") {
          const reply = await surface.editJob(
            ctx,
            parts[1] ?? "",
            parts[2] ?? "",
            parts.slice(3).join(" "),
          );
          return { text: reply.text };
        }
        const reply = await surface.showJob(ctx, parts[0] ?? "", numbers);
        return { text: reply.text, keyboard: reply.keyboard };
      }
      case "report": {
        // G3-35: the bundle is already redacted; the caption names the version and the range it covers.
        const answer = await ctx.client.request("/api/v1/diagnostics");
        const bundle = JSON.stringify(answer.body, null, 2);
        const version = (answer.body as { version?: string }).version ?? "unknown";
        return {
          text: "the sanitized diagnostics bundle follows as a file — safe to paste into a bug report",
          file: {
            filename: "crabby-diagnostics.json",
            content: bundle,
            caption: `crabby diagnostics — gateway v${version}, covers this Gateway's uptime`,
          },
        };
      }
      case "status": {
        const reply = await surface.statusCommand(ctx);
        return { text: reply.text };
      }
      case "health": {
        const reply = await surface.healthCommand(ctx);
        return { text: reply.text };
      }
      default:
        return { text: `unknown command: /${name}` };
    }
  }

  private noteSession(chatId: string, sessionId: string | undefined): void {
    if (sessionId === undefined) return;
    const record = this.chat(chatId);
    if (record === undefined) return;
    this.setState({
      ...this.deps.state,
      chats: { ...this.deps.state.chats, [chatKey(chatId)]: { ...record, sessionId } },
    });
  }

  private decisionLine(outcome: DecisionOutcome, id: string): string {
    if (outcome.kind === "accepted")
      return `${outcome.decision === "approve" ? "approved" : "denied"} ${id} — once-only (D-052); the record carries it`;
    if (outcome.kind === "conflict")
      return `answered elsewhere — the first answer won, and nothing ran twice (G-A7)`;
    if (outcome.kind === "expired") return `expired — send /approve ${id} again`;
    return `nothing pending under ${id}`;
  }

  /** The Gateway's decision route, with every G-A row's answer: 404 is `unknown` (G-S09's identical answer), 409 is
   *  `conflict` (G-A7), an expiry refusal is `expired` (G-A6). Nothing mutates locally before the Gateway agrees
   *  (G-A12: a half-delivered path never marks a prompt answered). */
  async decide(
    id: string,
    decision: "approve" | "deny",
    reason?: string,
  ): Promise<DecisionOutcome> {
    try {
      await this.deps.client.request(`/api/v1/approvals/${encodeURIComponent(id)}/decision`, {
        method: "POST",
        body:
          reason === undefined ? { decision, scope: "once" } : { decision, scope: "once", reason },
      });
      return { kind: "accepted", decision };
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 409) return { kind: "conflict", answeredIn: "another client" };
      if (status === 404) return { kind: "unknown" };
      const message =
        (error as { envelope?: { error?: { message?: string } } }).envelope?.error?.message ?? "";
      if (message.includes("expired")) return { kind: "expired" };
      throw error;
    }
  }

  /** G3-04: attach progress edits for one task to one chat. A second /watch on the same task is a no-op that says so. */
  async watch(chatId: string, taskId: string, messageId: number | undefined): Promise<BotReply> {
    const existing = this.deps.state.watches[taskId];
    if (existing !== undefined && existing.chatId === chatId) {
      return {
        text: `already watching ${taskId} — the edits continue; a second /watch changes nothing`,
      };
    }
    const watches: Record<string, WatchRecord> = {
      ...this.deps.state.watches,
      [taskId]: {
        chatId,
        messageId: messageId ?? 0,
        lastSeq: 0,
        startedAt: new Date().toISOString(),
      },
    };
    this.setState({ ...this.deps.state, watches });
    return {
      text: `watching ${taskId} — one progress message will be edited here; the outcome arrives as its own message`,
    };
  }

  /** G4-08: stop the edits, keep the task — the difference is stated, because `cancel` is the other thing a panicking
   *  user reaches for. */
  unwatch(chatId: string, taskId: string): BotReply {
    const existing = this.deps.state.watches[taskId];
    if (existing === undefined || existing.chatId !== chatId) {
      return {
        text: `not watching ${taskId} — /tasks lists what exists; watching and running are different things`,
      };
    }
    const watches = { ...this.deps.state.watches };
    delete watches[taskId];
    this.setState({ ...this.deps.state, watches });
    return {
      text: `stopped the edits for ${taskId} — the task itself is untouched; /cancel is the stop command`,
    };
  }

  /** The approval fan-out (G7-09): a prompt routes to the chat watching its task, else the first paired private
   *  chat. Sent through the sender's bypass path (G-A13); a long exact target goes whole in its own message first
   *  (G-A10). */
  async pushApproval(item: ApprovalItem): Promise<void> {
    const chatId =
      (item.taskId !== undefined ? this.deps.state.watches[item.taskId]?.chatId : undefined) ??
      Object.keys(this.deps.state.chats).find(
        (key) => this.deps.state.chats[key]?.kind === "private",
      );
    if (chatId === undefined) return;
    const nonces: ApprovalNonces = {
      approve: randomBytes(4).toString("hex"),
      deny: randomBytes(4).toString("hex"),
    };
    if (needsOwnTargetMessage(item, TARGET_OWN_MESSAGE_AT)) {
      await this.deps.sender.sendText(
        chatId,
        `exact target (whole, before the card):\n${item.target ?? ""}`,
      );
    }
    const sent = await this.deps.sender.sendApprovalBypassingCoalescer(
      chatId,
      approvalText(item),
      approvalKeyboard(item, nonces),
    );
    const chat = this.chat(chatId);
    this.approvalCards.set(`${chatId}:${item.id}`, {
      chatId,
      messageId: sent.messageId,
      nonces,
      userIds: chat?.userId === undefined ? [] : [chat.userId],
    });
  }

  /** G-A11: the why-note for a pending card, sent as a reply in the same chat. */
  async explainApproval(_chatId: string, item: ApprovalItem): Promise<BotReply> {
    return { text: whyText(item) };
  }

  /** G4-01…G4-05: frames from the Gateway's stream land here. The terminal outcome is its own message; the final
   *  answer is the same content the other interfaces show; progress goes through the coalescer. */
  async onTaskFrame(
    taskId: string,
    frame: { type: string; payload: Record<string, unknown> },
  ): Promise<void> {
    const watch = this.deps.state.watches[taskId];
    if (watch === undefined) return;
    if (TERMINAL_EVENTS.has(frame.type)) {
      const word = frame.type.replace("task.", "");
      const summary =
        typeof frame.payload.summary === "string" ? ` — ${frame.payload.summary}` : "";
      await this.deps.sender.sendText(watch.chatId, `task ${word}${summary}\n${taskId}`);
      const watches = { ...this.deps.state.watches };
      delete watches[taskId];
      this.setState({ ...this.deps.state, watches });
      return;
    }
    if (
      frame.type === "message.added" &&
      frame.payload.role === "assistant" &&
      typeof frame.payload.content === "string"
    ) {
      await this.deps.sender.sendText(watch.chatId, frame.payload.content);
      return;
    }
    if (
      frame.type === "tool.started" ||
      frame.type === "tool.finished" ||
      frame.type === "approval.requested"
    ) {
      const line =
        frame.type === "approval.requested"
          ? "waiting for an approval — /approvals shows it"
          : `last tool: ${String(frame.payload.name ?? frame.payload.tool ?? "?")}${frame.type === "tool.started" ? " (running)" : " (finished)"}`;
      this.deps.sender.editProgress(watch.chatId, watch.messageId, line, (text) => {
        void this.deps.transport.editMessageText(watch.chatId, watch.messageId, text).catch(() => {
          // G1-10: a lost edit is never a lost task — the next update is a new message in the same chat.
        });
      });
    }
  }
}
