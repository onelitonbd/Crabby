// The logger. `SECURITY.md` §14's rule — "Diagnostics commands must be safe to paste into a bug report: redaction is
// verified by tests, not by hope" — is why redaction is not a level here: it runs on every line, at the logging layer
// rather than at the UI that displays it. A debug log that has to be edited before it can be shared is a log nobody
// shares, and the report dies with it.
import { redact, redactText } from "./redact.ts";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Exported for `GET /logs`'s level filter: one ranking, so a route and the logger cannot disagree about which
 *  level outranks which. */
export const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogRecord {
  ts: string;
  level: LogLevel;
  msg: string;
  taskId?: string;
  fields?: Record<string, unknown>;
}

export interface Logger {
  readonly level: LogLevel;
  child(scope: string, fields?: Record<string, unknown>): Logger;
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  records(): readonly LogRecord[];
}

export interface LogOptions {
  readonly level?: LogLevel;
  readonly write?: (line: string) => void;
  readonly now?: () => Date;
  /** Kept in memory as well as written, because `crabby logs --tail` and the doctor's "last ten log lines" read the
   *  same buffer a test can assert on. Bounded so a debug session cannot grow it without limit. */
  readonly bufferLines?: number;
}

const MAX_BUFFER = 500;

export function createLogger(
  options: LogOptions = {},
  scope = "crabby",
  inherited: Record<string, unknown> = {},
): Logger {
  const level = options.level ?? "info";
  const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const now = options.now ?? (() => new Date());
  const cap = options.bufferLines ?? MAX_BUFFER;
  const buffer: LogRecord[] = [];

  function emit(levelName: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (RANK[levelName] < RANK[level]) return;
    const record: LogRecord = { ts: now().toISOString(), level: levelName, msg: redactText(msg) };
    const merged = { ...inherited, ...(fields ?? {}) };
    const clean = redact(merged);
    if (typeof clean.taskId === "string") record.taskId = clean.taskId;
    const rest = Object.fromEntries(Object.entries(clean).filter(([k]) => k !== "taskId"));
    if (Object.keys(rest).length > 0) record.fields = rest;
    buffer.push(record);
    if (buffer.length > cap) buffer.splice(0, buffer.length - cap);
    write(JSON.stringify(record));
  }

  return {
    level,
    child(childScope, fields = {}) {
      return createLogger(options, `${scope}.${childScope}`, { ...inherited, ...redact(fields) });
    },
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    records: () => buffer,
  };
}
