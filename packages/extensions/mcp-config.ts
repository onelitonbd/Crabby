// D-137's file, parsed the way §4.2 taught: a native format is strict, because a server entry is a set of
// instructions Crabby will execute (a command line) or dial (a URL), and a typo'd field in that set is not a missing
// feature — it is a permission lying about itself.
//
// Two rules have no default to get wrong:
//   - **Environment values never enter the file** (§11's C-2 scope: env var *names*, never values). The names are
//     resolved from the process environment at spawn, so a `servers.json` that leaked into a backup carries no
//     credentials, and an entry that asked to store a value is refused with the rule named.
//   - **Imported entries are born disabled.** "Automatic approval of any server" is §11's first out-of-scope row, and
//     a file that arrived from another harness enabling itself on import would be exactly that.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** `<stateDir>/mcp/` — D-137's home: `servers.json` beside the conversion reports the C-2 import writes. */
export const MCP_DIR_NAME = "mcp";
export const SERVERS_FILE = "servers.json";
export const REPORTS_DIR_NAME = "reports";

export const MCP_PROTOCOL_VERSION = "2024-11-05";

export function mcpDir(stateDir: string): string {
  return join(stateDir, MCP_DIR_NAME);
}

export function serversFilePath(stateDir: string): string {
  return join(mcpDir(stateDir), SERVERS_FILE);
}

export type McpTransport = "stdio" | "http";

export interface StdioServerEntry {
  readonly transport: "stdio";
  /** The executable. Surfaced verbatim in the approval prompt (§10 → SECURITY §11): a command line nobody was shown
   *  is a command line nobody approved. */
  readonly command: string;
  readonly args?: readonly string[];
  /** Names only. Resolved from the environment at spawn; a name with no value in the environment is a named error at
   *  connect, not a silent empty string. */
  readonly envNames?: readonly string[];
}

export interface HttpServerEntry {
  readonly transport: "http";
  readonly url: string;
  /** Header *names* whose values come from the environment at call time — the same rule `envNames` follows. */
  readonly headerNames?: readonly string[];
}

export type ServerEntry = StdioServerEntry | HttpServerEntry;

export interface ServerEntries {
  readonly version: 1;
  readonly servers: Readonly<Record<string, ServerEntry>>;
}

export type EntriesParseResult =
  | { readonly ok: true; readonly entries: ServerEntries }
  | {
      readonly ok: false;
      readonly problems: readonly { readonly path: string; readonly message: string }[];
    };

const NAME_SHAPE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ENV_NAME_SHAPE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SERVERS_MAX_BYTES = 256 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse the native `servers.json`. Problems name their path, in field order, deterministically. */
export function parseServerEntries(text: string): EntriesParseResult {
  if (Buffer.byteLength(text, "utf8") > SERVERS_MAX_BYTES) {
    return {
      ok: false,
      problems: [
        {
          path: "(file)",
          message: `the servers file is over ${SERVERS_MAX_BYTES} bytes — a server list this size is a payload`,
        },
      ],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      problems: [{ path: "(json)", message: `not valid JSON: ${(error as Error).message}` }],
    };
  }
  if (!isRecord(parsed)) {
    return { ok: false, problems: [{ path: "(root)", message: "the file must be a JSON object" }] };
  }
  const problems: { path: string; message: string }[] = [];
  for (const key of Object.keys(parsed)) {
    if (key !== "version" && key !== "servers") {
      problems.push({
        path: key,
        message: `'${key}' is not a field of the servers file (version, servers)`,
      });
    }
  }
  if (parsed.version !== 1) {
    problems.push({
      path: "version",
      message: `'${String(parsed.version)}' is not a file version this build parses`,
    });
  }
  const servers = parsed.servers;
  if (!isRecord(servers)) {
    problems.push({ path: "servers", message: "'servers' must be a mapping of name → entry" });
    return { ok: false, problems };
  }
  const out: Record<string, ServerEntry> = {};
  for (const [name, raw] of Object.entries(servers)) {
    if (!NAME_SHAPE.test(name)) {
      problems.push({
        path: `servers.${name}`,
        message: `'${name}' is not a server name: lowercase letters, digits, hyphen, underscore, 1–64 characters`,
      });
      continue;
    }
    const entry = parseEntry(name, raw);
    problems.push(...entry.problems);
    if (entry.entry !== undefined) out[name] = entry.entry;
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, entries: { version: 1, servers: out } };
}

function parseEntry(
  name: string,
  raw: unknown,
): {
  readonly problems: readonly { path: string; message: string }[];
  readonly entry?: ServerEntry;
} {
  const base = `servers.${name}`;
  if (!isRecord(raw))
    return { problems: [{ path: base, message: "an entry must be a JSON object" }] };
  const problems: { path: string; message: string }[] = [];
  const transport = raw.transport;
  const known = new Set(
    transport === "http"
      ? ["transport", "url", "headerNames"]
      : ["transport", "command", "args", "envNames"],
  );
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) {
      problems.push({
        path: `${base}.${key}`,
        message:
          `'${key}' is not a field of a '${String(transport)}' entry — native entries reject unknown fields, ` +
          "because an executed command line or a dialed URL is not where a typo gets to hide",
      });
    }
  }
  if (transport === "stdio") {
    if (typeof raw.command !== "string" || raw.command.length === 0) {
      problems.push({ path: `${base}.command`, message: "a stdio entry needs the command to run" });
    }
    if (
      raw.args !== undefined &&
      (!Array.isArray(raw.args) || raw.args.some((arg) => typeof arg !== "string"))
    ) {
      problems.push({ path: `${base}.args`, message: "'args' must be an array of strings" });
    }
    const env = checkEnvNames(base, raw.envNames);
    problems.push(...env.problems);
    if (problems.length === 0) {
      return {
        problems,
        entry: {
          transport: "stdio",
          command: raw.command as string,
          ...(Array.isArray(raw.args) ? { args: raw.args as readonly string[] } : {}),
          ...(env.names === undefined ? {} : { envNames: env.names }),
        },
      };
    }
    return { problems };
  }
  if (transport === "http") {
    if (typeof raw.url !== "string" || !/^https?:\/\//.test(raw.url)) {
      problems.push({
        path: `${base}.url`,
        message: "a http entry needs an http(s) URL — that URL is what the approval prompt shows",
      });
    }
    const headers = checkEnvNames(base, raw.headerNames);
    problems.push(...headers.problems);
    if (problems.length === 0) {
      return {
        problems,
        entry: {
          transport: "http",
          url: raw.url as string,
          ...(headers.names === undefined ? {} : { headerNames: headers.names }),
        },
      };
    }
    return { problems };
  }
  problems.push({
    path: `${base}.transport`,
    message: `'${String(transport)}' is not a transport — §10 ships two, 'stdio' and 'http'`,
  });
  return { problems };
}

/** Names only. A value-shaped field (`env`, `envValues`) is refused by name — the refusal is the whole C-2 rule. */
function checkEnvNames(
  base: string,
  raw: unknown,
): {
  readonly problems: readonly { path: string; message: string }[];
  readonly names?: readonly string[];
} {
  if (raw === undefined) return { problems: [] };
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) {
    return {
      problems: [
        { path: base, message: "environment/header references must be an array of names" },
      ],
    };
  }
  const names = raw as readonly string[];
  for (const entry of names) {
    if (!ENV_NAME_SHAPE.test(entry)) {
      return {
        problems: [
          {
            path: base,
            message: `'${entry}' is not an environment variable name — names only, resolved from the environment at spawn`,
          },
        ],
      };
    }
  }
  return { problems: [], names };
}

export function loadServerEntries(stateDir: string): {
  readonly exists: boolean;
  readonly parsed: EntriesParseResult;
} {
  const path = serversFilePath(stateDir);
  if (!existsSync(path))
    return { exists: false, parsed: { ok: true, entries: { version: 1, servers: {} } } };
  return { exists: true, parsed: parseServerEntries(readFileSync(path, "utf8")) };
}
