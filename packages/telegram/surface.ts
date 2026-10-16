// The command implementations — one function per capability, each through the same routes the CLI, TUI and Web use
// (D-005's whole point: the interface may request, display and relay, and never open the store itself — §19's rule).
// The honest absences are absences here too: /logs, /export, /delete, /tunnel, /memory, /ext and /probe name the route
// that does not exist and the verb that works today, exactly as the Web screens and the TUI do. A Telegram-only
// phrasing of a gap would be G2-12's defect one level up.

import { createHash } from "node:crypto";
import { scheduleInWords } from "@crabby/agent-runtime";
import type { InlineKeyboard } from "./approvals.ts";
import { alignTable, idLine, stampTime } from "./format.ts";

/** What a command answers with. `text` always present (the sender applies the split rules); `keyboard` rides the
 *  same message; `file` is the document a command produces. `taskId`/`sessionId` ride beside the text so the bot can
 *  wire its own state (watch, chat→session) without parsing the human line back — G2-10 makes ids copyable lines,
 *  not data formats. */
export interface Reply {
  readonly text: string;
  readonly keyboard?: InlineKeyboard;
  readonly file?: { readonly filename: string; readonly media: string; readonly caption: string };
  readonly taskId?: string;
  readonly sessionId?: string;
}

export interface SurfaceClient {
  request(
    route: string,
    options?: {
      method?: "GET" | "POST" | "DELETE" | "PATCH" | "PUT";
      body?: unknown;
      headers?: Record<string, string>;
    },
  ): Promise<{ status: number; body: unknown }>;
}

export interface SurfaceContext {
  readonly client: SurfaceClient;
  readonly chatId: string;
  /** The session this chat points at (G1-04) — undefined until the chat's first question creates one. */
  readonly sessionId: string | undefined;
  /** G3-03's numbering: `/cancel 2` means the second row of this chat's last `/tasks`. */
  readonly resolveTask: (ref: string) => string | undefined;
  readonly zone: string | undefined;
}

export class SurfaceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

async function call<T>(
  ctx: SurfaceContext,
  route: string,
  options?: {
    method?: "GET" | "POST" | "DELETE" | "PATCH" | "PUT";
    body?: unknown;
    headers?: Record<string, string>;
  },
): Promise<T> {
  const answer = await ctx.client.request(route, options);
  return answer.body as T;
}

/** G2-12's envelope: `code` plus one human line, ≤3 lines — the same envelope every other interface prints. */
export function errorText(code: string, message: string): string {
  return `${code} — ${message}`;
}

function shortId(id: string): string {
  return id.length <= 18 ? id : `${id.slice(0, 8)}…${id.slice(-4)}`;
}

/** G3-01/G3-02. In this build a question enters as `POST /tasks` with the chat's session — the messages route is not
 *  built (§4's row says so in so many words), and pretending otherwise would make every /ask a 404. */
export async function ask(ctx: SurfaceContext, text: string): Promise<Reply> {
  if (text.length === 0) {
    return { text: "ask what? /ask <text> — or just send the sentence without a slash" };
  }
  const created = await call<{ id: string; sessionId: string }>(ctx, "/api/v1/tasks", {
    method: "POST",
    body: {
      objective: text,
      ...(ctx.sessionId === undefined ? {} : { sessionId: ctx.sessionId }),
    },
    headers: {
      "idempotency-key": `tg-ask-${createHash("sha256").update(`${ctx.chatId}\u0000${text}`).digest("hex").slice(0, 24)}`,
    },
  });
  return {
    text: [
      `question running as task ${created.id} — the answer follows here when it settles`,
      idLine("task", created.id),
    ].join("\n"),
    taskId: created.id,
    sessionId: created.sessionId,
  };
}

export async function startTask(ctx: SurfaceContext, objective: string): Promise<Reply> {
  if (objective.length === 0) {
    return { text: "an objective is one line: /task <what should be done>" };
  }
  const created = await call<{ id: string; sessionId: string }>(ctx, "/api/v1/tasks", {
    method: "POST",
    body: { objective },
    headers: {
      "idempotency-key": `tg-task-${createHash("sha256").update(`${ctx.chatId}\u0000${objective}`).digest("hex").slice(0, 24)}`,
    },
  });
  return {
    text: [
      `task started — /watch ${shortId(created.id)} attaches progress edits here, /cancel stops it`,
      idLine("task", created.id),
    ].join("\n"),
    taskId: created.id,
    sessionId: created.sessionId,
  };
}

interface TaskRow {
  readonly id: string;
  readonly state?: string;
  readonly objective?: string;
}

/** G3-03: numbered, ≤10 lines, pending-approval tasks marked first. The numbers are this chat's own — /cancel 2. */
export async function listTasks(ctx: SurfaceContext, numbers: Map<string, string>): Promise<Reply> {
  const body = await call<{ items?: TaskRow[] }>(ctx, "/api/v1/tasks?limit=20");
  const items = body.items ?? [];
  const waiting = items.filter((task) => task.state === "awaiting_approval");
  const rest = items.filter((task) => task.state !== "awaiting_approval");
  const ordered = [...waiting, ...rest].slice(0, 10);
  if (ordered.length === 0) return { text: "no tasks yet — /task starts one" };
  numbers.clear();
  const lines = ordered.map((task, index) => {
    numbers.set(String(index + 1), task.id);
    const mark = task.state === "awaiting_approval" ? " [needs approval]" : "";
    return `${String(index + 1)}. ${task.state ?? "?"}${mark} — ${task.objective ?? shortId(task.id)}`;
  });
  return { text: lines.join("\n") };
}

export function resolveTaskRef(
  numbers: Map<string, string>,
  ref: string | undefined,
): string | undefined {
  if (ref === undefined || ref.length === 0) return undefined;
  return numbers.get(ref) ?? (ref.includes("_") || ref.length > 6 ? ref : undefined);
}

/** G3-06: the three-phase stop, reported as it settles. */
export async function cancelTask(
  ctx: SurfaceContext,
  ref: string | undefined,
  numbers: Map<string, string>,
): Promise<Reply> {
  let id = resolveTaskRef(numbers, ref);
  if (id === undefined) {
    const body = await call<{ items?: TaskRow[] }>(ctx, "/api/v1/tasks?limit=20");
    const running = (body.items ?? []).find(
      (task) => task.state === "running" || task.state === "awaiting_approval",
    );
    if (running === undefined)
      return { text: "nothing is running in this chat — /tasks shows what exists" };
    id = running.id;
  }
  await call(ctx, `/api/v1/tasks/${encodeURIComponent(id)}/cancel`, { method: "POST", body: {} });
  return {
    text: `cancellation requested for ${id}\nthe current step finishes first, then the task settles — /tasks shows the state`,
  };
}

/** G3-07: resumes from the checkpoint and prints what will be skipped vs repeated (D-044); never a restart. */
export async function resumeTask(
  ctx: SurfaceContext,
  ref: string | undefined,
  numbers: Map<string, string>,
): Promise<Reply> {
  const id = resolveTaskRef(numbers, ref);
  if (id === undefined)
    return { text: "which task? /resume <n|id> — the numbers are /tasks' rows" };
  let skipped = "the checkpoint's completed steps are skipped";
  try {
    const checkpoint = await call<{
      boundary?: { seq?: number };
      verdict?: string;
      reason?: string;
    }>(ctx, `/api/v1/tasks/${encodeURIComponent(id)}/checkpoint`);
    if (checkpoint.verdict !== undefined)
      skipped = `checkpoint verdict: ${checkpoint.verdict}${checkpoint.reason === undefined ? "" : ` — ${checkpoint.reason}`}`;
  } catch {
    // No checkpoint is D-065's honest answer ("never reached a step boundary") — the resume is still the same ask.
  }
  await call(ctx, `/api/v1/tasks/${encodeURIComponent(id)}/resume`, { method: "POST", body: {} });
  return {
    text: [
      `resumed ${id} from the checkpoint — never a restart`,
      skipped,
      "repeated: only from the boundary forward",
    ].join("\n"),
  };
}

/** G3-10: the read-only queue; answering goes through keyboard or typed commands — one way to say yes. */
export async function listApprovals(ctx: SurfaceContext): Promise<Reply> {
  const body = await call<{
    items?: { id: string; summary?: string; tier?: string; taskId?: string }[];
  }>(ctx, "/api/v1/approvals");
  const items = body.items ?? [];
  if (items.length === 0) return { text: "nothing waiting — approvals appear here and in /status" };
  const lines = items
    .slice(0, 10)
    .map((item) => `- [${item.tier ?? "?"}] ${item.summary ?? item.id} — /approve ${item.id}`);
  return { text: lines.join("\n") };
}

interface SessionRow {
  readonly id: string;
  readonly titleShown?: string;
  readonly updatedAt?: string;
}

/** G3-11: this chat's sessions only — a group sees the group's (G7-07). The Gateway's list is the source; the chat's
 *  own history is the filter, because sessions have no chat field on the wire. */
export async function listSessions(
  ctx: SurfaceContext,
  chatSessions: readonly string[],
): Promise<Reply> {
  const body = await call<{ items?: SessionRow[] }>(ctx, "/api/v1/sessions");
  const own = (body.items ?? []).filter((session) => chatSessions.includes(session.id));
  if (own.length === 0)
    return { text: "no sessions from this chat yet — a question or /new starts one" };
  const lines = own.slice(0, 10).map((session) => {
    const when =
      session.updatedAt === undefined ? "" : ` · ${stampTime(session.updatedAt, ctx.zone)}`;
    return `- ${session.titleShown ?? "(unnamed)"}${when}\n  ${session.id}`;
  });
  return { text: lines.join("\n") };
}

/** G3-12: a new session, and the chat now points at it. The caller moves the mapping on `{sessionId}`. */
export async function newSession(ctx: SurfaceContext): Promise<Reply & { sessionId?: string }> {
  const created = await call<{ id: string }>(ctx, "/api/v1/sessions", { method: "POST", body: {} });
  return {
    text: `new session started for this chat — the old one keeps its history, /sessions lists both\n${created.id}`,
    sessionId: created.id,
  };
}

/** G3-32: rename what this chat points at, through PATCH with the revision the GET carried. */
export async function renameSession(ctx: SurfaceContext, title: string): Promise<Reply> {
  if (ctx.sessionId === undefined) return { text: "no session to rename — say something first" };
  const detail = await call<{ session: { revision: number } }>(
    ctx,
    `/api/v1/sessions/${encodeURIComponent(ctx.sessionId)}`,
  );
  await call(ctx, `/api/v1/sessions/${encodeURIComponent(ctx.sessionId)}`, {
    method: "PATCH",
    body: { title },
    headers: { "if-match": `"${String(detail.session.revision)}"` },
  });
  return { text: `renamed to "${title}"` };
}

/** G3-13: sections with cost, what was compacted, what is pinned — the phone version of W7/T8, same numbers. */
export async function showContext(ctx: SurfaceContext): Promise<Reply> {
  if (ctx.sessionId === undefined) return { text: "no session yet — /ask or /new starts one" };
  const body = await call<Record<string, unknown>>(
    ctx,
    `/api/v1/sessions/${encodeURIComponent(ctx.sessionId)}/context`,
  );
  const lines: string[] = [];
  const budget = body.budget as
    | { window?: number; reserveForOutput?: number; compactAtTokens?: number }
    | undefined;
  const projected = body.projected as { tokens?: number; source?: string } | undefined;
  if (projected !== undefined && budget !== undefined) {
    lines.push(
      `context: ${String(projected.tokens ?? 0)} tokens${projected.source === "estimated" ? " (estimated by the documented heuristic)" : ""} of ${String(budget.window ?? "?")}`,
      `reserve for output ${String(budget.reserveForOutput ?? "?")} · compacts at ${String(budget.compactAtTokens ?? "?")}`,
    );
  } else {
    lines.push(
      "context: the model cannot describe its budget — the numbers are absent by design, not zero",
    );
  }
  const compacted = (body.compacted as { summary?: string }[] | undefined) ?? [];
  lines.push(
    `compacted: ${String(compacted.length)} summary row(s) — the originals stay readable (/compact previews first)`,
  );
  const pinned = (body.pinned as unknown[] | undefined) ?? [];
  lines.push(`pinned: ${String(pinned.length)} turn(s)`);
  return { text: lines.join("\n") };
}

/** G3-14: prints what was summarized and where the originals live; never implies the original text is gone (D-027). */
export async function compactNow(ctx: SurfaceContext): Promise<Reply> {
  if (ctx.sessionId === undefined) return { text: "no conversation to compact" };
  const body = await call<{ covers?: { from?: number; through?: number }; note?: string }>(
    ctx,
    `/api/v1/sessions/${encodeURIComponent(ctx.sessionId)}/compact`,
    { method: "POST", body: {} },
  );
  return {
    text: [
      `summarized turns ${String(body.covers?.from ?? "?")}–${String(body.covers?.through ?? "?")} into one summary`,
      body.note ??
        "the covered turns are still readable — a summary is another record, never a replacement",
    ].join("\n"),
  };
}

interface ProviderEntry {
  readonly key?: string;
  readonly baseUrl?: string;
  readonly models?: string[];
  readonly defaultModel?: string;
}

function redactKey(reference: string | undefined): string {
  return reference === undefined
    ? "(none)"
    : reference.replace(/^vault:\/\/.*$/, "redacted (a vault:// reference)");
}

/** G3-15 + G6-01: the configured models. This build has no `GET /models` and no per-session override route (W9's
 *  slice) — the table shows what is configured, and the refusal says so instead of a button that 404s. */
export async function listModels(ctx: SurfaceContext): Promise<Reply> {
  const body = await call<{ provider?: Record<string, ProviderEntry> }>(ctx, "/api/v1/config");
  const providers = body.provider ?? {};
  const rows: string[][] = [["provider/model", "key", "base"]];
  for (const [name, entry] of Object.entries(providers)) {
    for (const model of entry.models ?? []) {
      rows.push([
        `${name}/${model}`,
        entry.key === undefined ? "(none)" : "redacted",
        entry.baseUrl ?? "",
      ]);
    }
  }
  const table =
    rows.length === 1
      ? "(no providers configured — `crabby provider add` on the host)"
      : alignTable(rows);
  return {
    text: [
      table,
      "",
      "switching or probing a model from a chat needs `GET /models` + `PUT /overrides` + `POST …/probe`, which are " +
        "not built yet (the W9 slice) — the Web settings screen shows the same facts; defaultModel is set with " +
        "`crabby config set defaultModel <provider/model>`",
    ].join("\n"),
  };
}

/** G3-16: list-only; G6-06's refusal for add is the documented limitation. */
export async function listProviders(ctx: SurfaceContext): Promise<Reply> {
  const body = await call<{
    provider?: Record<string, ProviderEntry>;
    net?: Record<string, unknown>;
  }>(ctx, "/api/v1/config");
  const providers = body.provider ?? {};
  if (Object.keys(providers).length === 0)
    return { text: "no providers configured — `crabby provider add` on the host" };
  const rows: string[][] = [["provider", "key", "models"]];
  for (const [name, entry] of Object.entries(providers)) {
    rows.push([name, redactKey(entry.key), String((entry.models ?? []).length)]);
  }
  return {
    text: [
      alignTable(rows),
      "",
      "adding or editing an endpoint is refused here (G6-06 — the documented §8 limitation): keys and URLs are " +
        "typed once, locally, with `crabby provider add`",
    ].join("\n"),
  };
}

/** G3-17: the same probe the Web button triggers — which is to say, the route is not built yet, and both say so. */
export function probeModel(_model: string): Reply {
  return {
    text: "the probe route (`POST /models/…/probe`) is not built in this milestone — the Web probe button shows the same gap; `crabby model probe <p>/<m>` is where it lands first",
  };
}

interface ToolRow {
  readonly id?: string;
  readonly tier?: string;
  readonly enabled?: boolean;
  readonly availability?: { available?: boolean; reason?: string };
}

/** G3-18: tools with tier and enabled state, ≤20 lines, deferred tools with their reason. */
export async function listTools(ctx: SurfaceContext): Promise<Reply> {
  const body = await call<{ items?: ToolRow[] }>(ctx, "/api/v1/tools");
  const items = body.items ?? [];
  if (items.length === 0)
    return { text: "the registry answered nothing — is the Gateway composed?" };
  const rows = items
    .slice(0, 20)
    .map((tool) => [
      tool.id ?? "?",
      `${tool.tier ?? "?"}`,
      tool.availability?.available === false
        ? `deferred: ${tool.availability.reason ?? "platform"}`
        : "available",
    ]);
  return { text: alignTable([["tool", "tier", "state"], ...rows]) };
}

/** G3-19: memory is §8.1's route gap in this build — the same answer Web's memory screen gives. */
export function memoryCommand(): Reply {
  return {
    text: "the memory routes (/api/v1/memory*) are not in this build — nothing stores or serves memories yet; `crabby memory list/search` reaches the store when the slice lands (Web shows the same gap)",
  };
}

/** G3-20: extensions are M4's host-installed slice; the refusal is the same one /status's subsystem row prints. */
export function extensionsCommand(): Reply {
  return {
    text: "the extensions surface has no routes in this build (M4's host installs them) — validate stays a local `crabby ext validate`; there is no third-party executable kind to approve (D-038)",
  };
}

/** G3-21: reads print the value; a set confirms with the diff before it is written. `telegram.*` keys are refused
 *  outright from a chat — access changes are local-only (G7-03's family). */
export async function configCommand(ctx: SurfaceContext, args: string): Promise<Reply> {
  const [verb, key, ...valueParts] = args.split(/\s+/);
  const value = valueParts.join(" ");
  if (verb === undefined || verb.length === 0) {
    return {
      text: "/config <key> — read one key, or /config set <key> <value> — confirm a diff first",
    };
  }
  if ((verb === "set" || verb === "apply") && (key === undefined || key.length === 0)) {
    return { text: `/config ${verb} needs a key: /config ${verb} <key> <value>` };
  }
  const configKey = key ?? "";
  if (verb === "set") {
    if (configKey.startsWith("telegram.")) {
      return {
        text: "the telegram allow-list and token are access configuration — changed locally with `crabby config set`, never from a chat (G7-03)",
      };
    }
    if (value.length === 0) return { text: "a set needs a value: /config set <configKey> <value>" };
    const current = await call<{ config?: Record<string, unknown>; token?: string }>(
      ctx,
      "/api/v1/config",
    );
    const before = JSON.stringify(readPath(current.config ?? {}, configKey));
    const after = JSON.stringify(coerceScalar(value));
    const diff = [`- ${configKey}: ${before}`, `+ ${configKey}: ${after}`].join("\n");
    return {
      text: [
        "this write is T3-marked when the configKey is a security family — confirm by repeating the same command with `apply`:",
        diff,
        `/config apply ${configKey} ${value}`,
      ].join("\n"),
    };
  }
  if (verb === "apply") {
    if (configKey.startsWith("telegram.")) {
      return { text: "telegram.* is access configuration — local-only (G7-03)" };
    }
    if (value.length === 0)
      return { text: "an apply needs the same configKey and value as the set you confirmed" };
    const current = await call<{ file?: Record<string, unknown>; token?: string }>(
      ctx,
      "/api/v1/config",
    );
    const token = current.token;
    if (token === undefined)
      return {
        text: errorText(
          "config_token_absent",
          "the document answered no version token — nothing was written",
        ),
      };
    // The write replaces the *file* view — overrides only. Building on the merged view would fold D-074's defaults into
    // the document, and `PutConfigBody`'s own description refuses exactly that: a pinned default makes the next default
    // change unreachable.
    const next = structuredClone(current.file ?? {});
    writePath(next, configKey, coerceScalar(value));
    await call(ctx, "/api/v1/config", {
      method: "PUT",
      body: { config: next },
      headers: { "if-match": `"${String(token)}"` },
    });
    return { text: `written: ${configKey}` };
  }
  const body = await call<{ config?: Record<string, unknown> }>(ctx, "/api/v1/config");
  const found = readPath(body.config ?? {}, verb);
  if (found === undefined) return { text: `${verb}: (not set)` };
  return { text: `${verb} = ${redactValue(verb, JSON.stringify(found))}` };
}

/** G-S06: `redacted` appears where a secret value would have been — a vault reference is itself printable, a resolved
 *  value never reaches a client in this build, and a key that *looks* like credential material is not printed either. */
function redactValue(key: string, value: string): string {
  if (/key|token|secret|password/i.test(key) && !value.startsWith('"vault://')) return "redacted";
  return value;
}

function coerceScalar(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function readPath(document: Record<string, unknown>, key: string): unknown {
  return key.split(".").reduce<unknown>((node, part) => {
    if (typeof node !== "object" || node === null) return undefined;
    return (node as Record<string, unknown>)[part];
  }, document);
}

function writePath(document: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split(".");
  let node: Record<string, unknown> = document;
  for (const part of parts.slice(0, -1)) {
    const existing = node[part];
    if (typeof existing !== "object" || existing === null) node[part] = {};
    node = node[part] as Record<string, unknown>;
  }
  node[parts[parts.length - 1] ?? ""] = value;
}

/** G3-22: the log tail is a route gap in this build — /report is the sanitized bundle this interface *can* produce. */
export function logsCommand(): Reply {
  return {
    text: "`GET /api/v1/logs` and `GET /api/v1/audit` have no routes in this build — `crabby logs` is the CLI's verb for the file; /report produces the sanitized diagnostics bundle from here",
  };
}

/** G3-23: the export route is not built (`POST /sessions/{id}/export`, history.export T2) — the honest answer names it. */
export function exportCommand(): Reply {
  return {
    text: "the export route (`POST /sessions/{id}/export`) is not built in this milestone — `crabby history export` names the artifact once the slice lands; sending a file here without the route would be a fabrication",
  };
}

/** G3-24: delete is `history.deleteConversation` at T3 and the route is deliberately absent (W15-07 prices the typed
 *  title for the day it exists); nothing destroys history yet, and the command says so rather than performing theater. */
export function deleteCommand(): Reply {
  return {
    text: "delete is not built: `DELETE /sessions/{id}` is absent by decision (history.deleteConversation, T3, typed-back) — nothing destroys history in this build, on any interface",
  };
}

/** G3-25: tunnel is T3 and its routes are absent in this build; the refusal still names which identities would become
 *  reachable, because that sentence is the row's point. */
export function tunnelCommand(mode: string | undefined): Reply {
  return {
    text:
      "the tunnel routes (`POST /tunnel`, `DELETE /tunnel`) are not built — enabling one would be T3 with the paired identities named before it acts, and `crabby tunnel on/off` is the local path once the slice lands" +
      (mode === undefined ? "" : ` (you asked for: ${mode})`),
  };
}

interface JobRow {
  readonly id: string;
  readonly name?: string;
  readonly schedule?: string;
  readonly state?: string;
  readonly nextRun?: string;
}

/** G3-33: name, words-schedule, next run, state word — a list-and-open command, not a report. */
export async function listJobs(ctx: SurfaceContext): Promise<Reply> {
  const body = await call<{ items?: JobRow[] }>(ctx, "/api/v1/jobs");
  const items = body.items ?? [];
  if (items.length === 0)
    return {
      text: "no standing schedules — a job is cron.schedule, a T2 call, never a chat command",
    };
  const rows = items
    .slice(0, 10)
    .map((job, index) => [
      `${String(index + 1)}. ${job.name ?? shortId(job.id)}`,
      `${job.schedule ?? "?"} = ${scheduleInWords(job.schedule ?? "")}`,
      job.nextRun === undefined
        ? "no next run computed"
        : `next ${stampTime(job.nextRun, ctx.zone)}`,
      `state: ${job.state ?? "?"}`,
    ]);
  return { text: rows.map((row) => row.join("\n   ")).join("\n\n") };
}

/** G3-34: one job with a keyboard — pause · resume · run now · edit · delete · show last runs. Edit asks one field at
 *  a time; the D-057 re-approval notice rides the same message as the change it describes. */
export async function showJob(
  ctx: SurfaceContext,
  ref: string,
  numbers: Map<string, string>,
): Promise<Reply> {
  const id = resolveTaskRef(numbers, ref) ?? ref;
  const job = await call<JobRow & { runs?: { at?: string; state?: string }[] }>(
    ctx,
    `/api/v1/jobs/${encodeURIComponent(id)}`,
  );
  const lines = [
    `${job.name ?? shortId(job.id)} — state ${job.state ?? "?"}`,
    `${job.schedule ?? "?"} = ${scheduleInWords(job.schedule ?? "")}`,
    job.nextRun === undefined ? "no next run computed" : `next ${stampTime(job.nextRun, ctx.zone)}`,
  ];
  const runs = job.runs ?? [];
  if (runs.length > 0) {
    lines.push("last runs:");
    for (const run of runs.slice(0, 3)) {
      lines.push(
        `  ${run.at === undefined ? "?" : stampTime(run.at, ctx.zone)} — ${run.state ?? "?"}`,
      );
    }
  }
  const keyboard: InlineKeyboard = {
    inline_keyboard: [
      [
        { text: "pause", callback_data: `job:${job.id}:pause` },
        { text: "resume", callback_data: `job:${job.id}:resume` },
        { text: "run now", callback_data: `job:${job.id}:run` },
      ],
      [
        { text: "edit schedule", callback_data: `job:${job.id}:edit` },
        { text: "delete", callback_data: `job:${job.id}:delete` },
      ],
    ],
  };
  return { text: lines.join("\n"), keyboard };
}

/** G3-34's edit path, one field at a time, with D-057's re-approval notice in the confirmation itself. */
export async function editJob(
  ctx: SurfaceContext,
  id: string,
  field: string,
  value: string,
): Promise<Reply> {
  if (field !== "name" && field !== "schedule") {
    return {
      text: "edit one field at a time: /job edit <n|id> name <v> or /job edit <n|id> schedule <cron>",
    };
  }
  const body = field === "name" ? { name: value } : { schedule: value };
  await call(ctx, `/api/v1/jobs/${encodeURIComponent(id)}`, { method: "PATCH", body });
  return {
    text: [
      `${field} changed to "${value}"`,
      "the next run is re-evaluated against this identity's current grants and stops at an approval if the change needs one — nothing is pre-approved by editing (D-057)",
    ].join("\n"),
  };
}

/** A job keyboard tap. `delete` is the gap Web's job screen also names (no DELETE route); pause/resume/run are real. */
export async function jobAction(ctx: SurfaceContext, id: string, action: string): Promise<Reply> {
  if (action === "pause") {
    await call(ctx, `/api/v1/jobs/${encodeURIComponent(id)}/pause`, { method: "POST", body: {} });
    return {
      text: `paused ${shortId(id)} — a run already in flight keeps going; /cancel stops that`,
    };
  }
  if (action === "resume") {
    await call(ctx, `/api/v1/jobs/${encodeURIComponent(id)}/resume`, { method: "POST", body: {} });
    return {
      text: `resumed ${shortId(id)} — grants re-evaluated, nothing restored from creation time`,
    };
  }
  if (action === "run") {
    await call(ctx, `/api/v1/jobs/${encodeURIComponent(id)}/run`, { method: "POST", body: {} });
    return {
      text: `run now asked for ${shortId(id)} — a fresh policy evaluation, so it may stop at an approval`,
    };
  }
  if (action === "edit") {
    return { text: "one field at a time: /job edit <n|id> schedule <cron> (or name <v>)" };
  }
  if (action === "delete") {
    return {
      text: "job delete has no route in this build — pause is the reversible act (the Web job screen shows the same gap)",
    };
  }
  return { text: `unknown job action: ${action}` };
}

/** G3-26: the phone version of `crabby status` — same facts, ≤8 lines, and a bug report from either reads the same. */
export async function statusCommand(ctx: SurfaceContext): Promise<Reply> {
  const status = await call<{
    ready?: boolean;
    subsystems?: Record<string, { state?: string; reason?: string }>;
  }>(ctx, "/api/v1/status");
  const health = await call<{ version?: string; uptimeMs?: number; vault?: { managed?: boolean } }>(
    ctx,
    "/api/v1/health",
  );
  const approvals = await call<{ items?: unknown[] }>(ctx, "/api/v1/approvals");
  const lines = [
    `gateway: ${status.ready === true ? "ready" : "degraded"} · v${String(health.version ?? "?")} · up ${String(Math.round((health.uptimeMs ?? 0) / 1000))}s`,
    `vault: ${health.vault?.managed === true ? "managed" : "unmanaged (no vault code in this build)"}`,
    `tunnel: ${status.subsystems?.tunnel?.state ?? "absent"} — ${status.subsystems?.tunnel?.reason ?? "the slice has not landed"}`,
    `extensions: ${status.subsystems?.extensions?.state ?? "absent"}`,
    `approvals waiting: ${String((approvals.items ?? []).length)}`,
    ctx.sessionId === undefined
      ? "this chat has no session yet"
      : `session: ${shortId(ctx.sessionId)}`,
  ];
  return { text: lines.join("\n") };
}

/** G3-27: deliberately boring, safe to ask at any moment, reveals nothing about other chats. */
export async function healthCommand(ctx: SurfaceContext): Promise<Reply> {
  const health = await call<{ status?: string; version?: string; uptimeMs?: number }>(
    ctx,
    "/api/v1/health",
  );
  return {
    text: `${health.status ?? "?"} — up ${String(Math.round((health.uptimeMs ?? 0) / 1000))}s, v${String(health.version ?? "?")}`,
  };
}
