// Region C-E13's MCP verbs — client-only, and the help never implies Crabby can *be* an MCP server (D-040). The
// verbs are the file's face: `mcp add` is the C-2 import (names kept, values dropped, report written, nothing
// approved by the act), `mcp list` reads D-137's `servers.json`. `restart` stays planned until a runtime connects
// to — so the help's planned row is honest about exactly what is missing.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT, type ExitCode } from "@crabby/api-contracts";
import { importMcpServers, loadServerEntries } from "@crabby/extensions";
import type { DataLayout } from "@crabby/platform";
import { parseTail } from "../args.ts";
import type { Renderer } from "../output.ts";
import { findCommand } from "../registry.ts";

export type McpVerb = "add" | "list";

export async function runMcp(
  verb: string | undefined,
  rest: readonly string[],
  layout: DataLayout,
  renderer: Renderer,
): Promise<ExitCode> {
  const spec = findCommand("mcp", verb);
  const tail = parseTail(rest, spec);

  if (tail.unknown.length > 0) {
    renderer.line("unknown flag(s)", tail.unknown.join(" "));
    renderer.fix(
      `crabby mcp ${verb ?? ""} --help lists the flags this verb reads`.replace(/ {2,}/g, " "),
    );
    return EXIT.usage;
  }

  switch (verb) {
    case "add": {
      const source = tail.positionals[0];
      if (source === undefined) {
        renderer.line("usage", "crabby mcp add <servers.json>");
        return EXIT.usage;
      }
      if (!existsSync(source)) {
        renderer.line("mcp add", `nothing to import at '${source}'`);
        return EXIT.usage;
      }
      const result = importMcpServers({ sourcePath: source, stateDir: layout.stateDir });
      if (!result.ok) {
        renderer.line("mcp add", result.reason);
        return EXIT.failure;
      }
      // C-2's whole security shape, said in the answer: names were kept, values were not, nothing was approved.
      renderer.line("imported", `${result.servers.length} server(s) into ${result.entriesPath}`);
      renderer.line(
        "values",
        `${result.report.dropped.length} environment/header value(s) dropped — only the names were kept (§11)`,
      );
      if (result.report.unknown.length > 0) {
        renderer.line(
          "preserved",
          `${result.report.unknown.length} unrecognizable field(s) kept in the report, never loaded`,
        );
      }
      renderer.line("report", result.reportPath);
      renderer.fix(
        "importing approves nothing — a server's tools are T2 until a human re-classifies them (§10)",
      );
      return renderer.done({
        servers: result.servers,
        entriesPath: result.entriesPath,
        report: result.reportPath,
        dropped: result.report.dropped.length,
      });
    }

    case "list": {
      const loaded = loadServerEntries(layout.stateDir);
      if (!loaded.parsed.ok) {
        for (const problem of loaded.parsed.problems) renderer.line(problem.path, problem.message);
        renderer.fix(`fix ${join(layout.stateDir, "mcp", "servers.json")} or delete it`);
        return EXIT.failure;
      }
      const names = Object.keys(loaded.parsed.entries.servers);
      for (const name of names) {
        const entry = loaded.parsed.entries.servers[name];
        if (entry === undefined) continue;
        const where =
          entry.transport === "stdio"
            ? `${entry.command}${entry.args === undefined ? "" : ` ${entry.args.join(" ")}`}`
            : entry.url;
        const names_ =
          entry.transport === "stdio" ? (entry.envNames ?? []) : (entry.headerNames ?? []);
        renderer.line(
          name,
          `${entry.transport} · ${where}${names_.length > 0 ? ` · env/header names: ${names_.join(", ")}` : ""}`,
        );
      }
      if (names.length === 0 && !loaded.exists) {
        renderer.line(
          "mcp list",
          `no servers configured — \`crabby mcp add <servers.json>\` imports a foreign server list`,
        );
      }
      if (names.length === 0 && loaded.exists) {
        renderer.line("mcp list", "the file exists and names no servers");
      }
      if (renderer.json) {
        return renderer.done({ exists: loaded.exists, servers: loaded.parsed.entries.servers });
      }
      return EXIT.success;
    }

    default: {
      renderer.line("usage", "crabby mcp <add|list> — Crabby is an MCP client only (D-040)");
      return EXIT.usage;
    }
  }
}

// The one read a restart verb will need later: the entries as parsed, so the runtime and the verbs cannot disagree
// about what a file said.
export function readServersFile(stateDir: string): string | undefined {
  const path = join(stateDir, "mcp", "servers.json");
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}
