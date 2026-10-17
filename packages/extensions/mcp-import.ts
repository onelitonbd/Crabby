// The C-2 import (§11): a foreign MCP server-configuration file becomes Crabby's `servers.json` plus a conversion
// report — server definitions and transport settings mapped, environment **names** kept, environment **values**
// dropped by name with a warning each (the one thing the phase's scope row writes in italics), and nothing approved
// by the act of importing: the file has no "connect to this now" power, because nothing in this build connects
// automatically — a server is dialed when a verb or a task asks, and the approval prompt shows the command line or
// URL (§10).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MCP_DIR_NAME,
  REPORTS_DIR_NAME,
  SERVERS_FILE,
  type ServerEntries,
  type ServerEntry,
} from "./mcp-config.ts";

export interface McpConversionReport {
  readonly sourceFormat: "mcp-servers-json";
  readonly sourcePath: string;
  readonly createdAt: string;
  readonly mapped: readonly {
    readonly server: string;
    readonly field: string;
    readonly value: unknown;
  }[];
  readonly dropped: readonly {
    readonly server: string;
    readonly field: string;
    readonly reason: string;
  }[];
  readonly reinterpreted: readonly unknown[];
  readonly unknown: readonly {
    readonly server: string;
    readonly field: string;
    readonly value: unknown;
  }[];
  readonly warnings: readonly string[];
}

export type McpImportResult =
  | {
      readonly ok: true;
      readonly entriesPath: string;
      readonly reportPath: string;
      readonly report: McpConversionReport;
      readonly servers: readonly string[];
    }
  | { readonly ok: false; readonly reason: string; readonly problems?: readonly string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One report per import, never overwritten — the same rule the C-1 reports follow (§11 rule 2), for the same reason. */
function uniqueReportName(reportsDir: string, now: Date): string {
  const stem = `report-${now.toISOString().replace(/[:.]/g, "-")}`;
  let candidate = `${stem}.json`;
  let counter = 2;
  while (existsSync(join(reportsDir, candidate))) {
    candidate = `${stem}-${counter}.json`;
    counter += 1;
  }
  return candidate;
}

/** The foreign shapes: Claude-style `{ "mcpServers": { name: { command, args, env } } }`, a bare `{ "servers": [...] }`
 *  array, or Crabby's own mapping shape. Anything else is refused with the shapes named — an importer that guessed
 *  would be an importer that guessed about command lines. */
export function importMcpServers(input: {
  readonly sourcePath: string;
  readonly stateDir: string;
  readonly now?: Date | undefined;
}): McpImportResult {
  const { sourcePath, stateDir } = input;
  if (!existsSync(sourcePath)) {
    return { ok: false, reason: `nothing to import at '${sourcePath}'` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(sourcePath, "utf8"));
  } catch (error) {
    return { ok: false, reason: `the source is not valid JSON: ${(error as Error).message}` };
  }
  if (!isRecord(parsed)) return { ok: false, reason: "the source must be a JSON object" };

  let rawServers: Record<string, unknown> | undefined;
  let _shape: "mcpServers" | "servers-mapping" | "servers-array";
  if (isRecord(parsed.mcpServers)) {
    _shape = "mcpServers";
    rawServers = parsed.mcpServers;
  } else if (isRecord(parsed.servers)) {
    _shape = "servers-mapping";
    rawServers = parsed.servers;
  } else if (Array.isArray(parsed.servers)) {
    _shape = "servers-array";
    rawServers = Object.fromEntries(
      parsed.servers
        .filter(
          (entry): entry is Record<string, unknown> =>
            isRecord(entry) && typeof entry.name === "string",
        )
        .map((entry) => [entry.name as string, entry]),
    );
  } else {
    return {
      ok: false,
      reason:
        "no server list found — the shapes this import reads are { mcpServers: {…} }, { servers: {…} } and " +
        "{ servers: [{ name, … }] }",
    };
  }

  const warnings: string[] = [];
  const mapped: { server: string; field: string; value: unknown }[] = [];
  const dropped: { server: string; field: string; reason: string }[] = [];
  const unknown: { server: string; field: string; value: unknown }[] = [];
  const servers: Record<string, ServerEntry> = {};

  for (const [name, raw] of Object.entries(rawServers)) {
    if (!isRecord(raw)) {
      warnings.push(`'${name}' is not an object; skipped`);
      continue;
    }
    const command = raw.command;
    const url = raw.url;
    if (typeof command === "string" && command.length > 0) {
      // A stdio entry. `env` values are read, named, and dropped — never copied (§11's C-2 scope).
      const env = isRecord(raw.env) ? raw.env : undefined;
      if (env !== undefined) {
        for (const [key, value] of Object.entries(env)) {
          dropped.push({
            server: name,
            field: `env.${key}`,
            reason:
              "environment values are never imported — the name is kept and the value is resolved from the " +
              `environment at spawn (found a ${typeof value})`,
          });
          warnings.push(`'${name}': environment value for ${key} dropped — only the name was kept`);
        }
      }
      mapped.push({ server: name, field: "transport", value: "stdio" });
      mapped.push({ server: name, field: "command", value: command });
      if (Array.isArray(raw.args)) mapped.push({ server: name, field: "args", value: raw.args });
      servers[name] = {
        transport: "stdio",
        command,
        ...(Array.isArray(raw.args)
          ? { args: raw.args.filter((arg): arg is string => typeof arg === "string") }
          : {}),
        ...(env !== undefined ? { envNames: Object.keys(env) } : {}),
      };
    } else if (typeof url === "string" && /^https?:\/\//.test(url)) {
      mapped.push({ server: name, field: "transport", value: "http" });
      mapped.push({ server: name, field: "url", value: url });
      const headers = isRecord(raw.headers) ? raw.headers : undefined;
      if (headers !== undefined) {
        for (const [key, value] of Object.entries(headers)) {
          dropped.push({
            server: name,
            field: `headers.${key}`,
            reason:
              "header values are never imported — the name is kept and the value is resolved from the " +
              `environment at call time (found a ${typeof value})`,
          });
          warnings.push(`'${name}': header value for ${key} dropped — only the name was kept`);
        }
      }
      servers[name] = {
        transport: "http",
        url,
        ...(headers !== undefined ? { headerNames: Object.keys(headers) } : {}),
      };
    } else {
      // Neither a command nor a URL: the entry's real content is unknown, preserved verbatim in the report (rule 3).
      for (const [field, value] of Object.entries(raw)) {
        unknown.push({ server: name, field, value });
      }
      warnings.push(
        `'${name}' names neither a command nor an http(s) URL — preserved in the report, never loaded`,
      );
    }
  }

  const _entries: ServerEntries = { version: 1, servers };
  const mcpDir = join(stateDir, MCP_DIR_NAME);
  const reportsDir = join(mcpDir, REPORTS_DIR_NAME);
  mkdirSync(reportsDir, { recursive: true });
  const entriesPath = join(mcpDir, SERVERS_FILE);
  // Merge, not clobber: an import that erased servers the user added by hand would be a deletion pretending to be
  // an install. The source file itself is never modified (§11 rule 7).
  let existing: ServerEntries = { version: 1, servers: {} };
  if (existsSync(entriesPath)) {
    try {
      const prior = JSON.parse(readFileSync(entriesPath, "utf8")) as ServerEntries;
      if (isRecord(prior.servers)) existing = { version: 1, servers: prior.servers };
    } catch {
      warnings.push("the existing servers.json was unreadable and was replaced by the import");
    }
  }
  const merged = { version: 1 as const, servers: { ...existing.servers, ...servers } };
  writeFileSync(entriesPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");

  const now = input.now ?? new Date();
  const report: McpConversionReport = {
    sourceFormat: "mcp-servers-json",
    sourcePath,
    createdAt: now.toISOString(),
    mapped,
    dropped,
    reinterpreted: [],
    unknown,
    warnings,
  };
  const reportPath = join(reportsDir, uniqueReportName(reportsDir, now));
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  return { ok: true, entriesPath, reportPath, report, servers: Object.keys(servers) };
}
