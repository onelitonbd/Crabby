// `crabby tools ls` — C10-04's row: "name, tier, capability, enabled, platform availability, and the reason for
// anything deferred", one line per tool, "the same list the Web shows (W11-01), including 'not in this version' rows".
//
// It reads the Gateway route rather than importing the registry, which is the difference between a command that shows
// what *this device* can do and a command that prints a file. `packages/policy` is the source of truth the route
// serializes; a CLI that imported the table directly would keep answering after the Gateway was patched out from
// under it, and the four interfaces would each have their own copy of the answer for M3 to reconcile.
import { EXIT, type ExitCode } from "@crabby/api-contracts";
import type { DataLayout } from "@crabby/platform";
import { parseTail } from "../args.ts";
import { connect, reportFailure, reportNoGateway } from "../connect.ts";
import type { Renderer } from "../output.ts";
import { findCommand } from "../registry.ts";

interface ToolsPage {
  items: {
    id: string;
    qualifier?: string;
    source: "builtin" | "extension";
    capabilities: string[];
    capabilityNote?: string;
    riskTier: string;
    tierText: string;
    tierRules: string[];
    notes: string;
    enabled: boolean;
    enabledReason?: string;
    availability: { available: boolean; requires: string; reason?: string };
    deferred?: boolean;
    deferralReason?: string;
    pendingRecordFields: string[];
  }[];
  count: number;
  registry: { source: string; rows: number; digest: string };
}

export async function runTools(
  verb: "ls" | string | undefined,
  argv: readonly string[],
  layout: DataLayout,
  renderer: Renderer,
): Promise<ExitCode> {
  const spec = findCommand("tools", verb);
  const tail = parseTail(argv, spec);
  if (tail.unknown.length > 0) {
    renderer.line("unknown flag(s)", tail.unknown.join(" "));
    renderer.fix(`${(spec?.flags ?? []).join(" ")} are what this verb accepts`);
    return EXIT.usage;
  }
  // One verb exists, so one verb is accepted. `docs/review/CLI.md` C10-04 documents `tools ls` and nothing else, and a
  // bare `crabby tools` printing the list would advertise a shorthand the grammar does not contain — the same rule
  // `task.ts` follows when it answers "which verb?" instead of guessing.
  if (verb !== "ls") {
    renderer.line("tools", "which verb? `ls`");
    renderer.fix("crabby tools ls --help is the whole grammar for this noun");
    return EXIT.usage;
  }
  const connection = await connect(layout);
  if (connection.state !== "paired") return reportNoGateway(renderer, connection.state);

  try {
    const page = (await connection.client.tools()).body as ToolsPage;
    for (const tool of page.items) renderer.line(labelFor(tool), columnsFor(tool));
    if (page.items.some((tool) => tool.pendingRecordFields.length > 0)) {
      // C10-04 asks for the *reason* behind anything the list cannot answer, and `renderer.fix` is the one channel
      // that survives into `--json` as `fixes[]`, so the caveat reaches a script too instead of only a terminal.
      renderer.fix(
        `${page.items[0]?.pendingRecordFields.join(", ")} come from the tool runtime and are not reported until M2`,
      );
    }
    renderer.line(
      "registry",
      `${page.registry.rows} rows from ${page.registry.source} · digest ${page.registry.digest} · ${page.count} shown`,
    );
    return renderer.done({ ...page });
  } catch (error) {
    return reportFailure(renderer, error);
  }
}

function labelFor(tool: ToolsPage["items"][number]): string {
  const qualifier = tool.qualifier === undefined ? "" : ` (${tool.qualifier})`;
  const origin = tool.source === "extension" ? " [extension]" : "";
  return `${tool.id}${qualifier}${origin}`;
}

/** The line a human reads. Widths come from the longest values in §4.2 rather than from a fixed column count, so a
 *  tool whose capability is `fs.read + fs.write` is not truncated into a different meaning — and the reason columns
 *  are appended only when there is a reason, because C10-04 asks for the reason *for anything deferred*. */
function columnsFor(tool: ToolsPage["items"][number]): string {
  const capability =
    tool.capabilities.length > 0 ? tool.capabilities.join(" + ") : (tool.capabilityNote ?? "none");
  const state = tool.enabled ? "enabled" : "off";
  const platform = tool.availability.available
    ? tool.availability.requires
    : `needs ${tool.availability.requires}`;
  const parts = [
    tool.riskTier.padEnd(2),
    capability.padEnd(24),
    state.padEnd(8),
    platform.padEnd(14),
  ];
  if (tool.availability.available === false && tool.availability.reason)
    parts.push(`unavailable: ${tool.availability.reason}`);
  if (tool.deferred) parts.push(`deferred: ${tool.deferralReason}`);
  if (tool.tierRules.length > 0) parts.push(`escalates: ${tool.tierRules.join(" ")}`);
  if (parts.length === 4 && tool.notes.length > 0) parts.push(tool.notes);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}
