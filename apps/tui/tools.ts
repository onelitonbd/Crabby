// T12's tools view, hosted in the models pane (the review's own grouping: "Providers/models/tools" is one section, and
// a seventh pane would break T1-02's six-name row). Everything reads `GET /tools`, the same answer `crabby tools ls`
// prints — one route, two interfaces, and the digest means a person can check the two agree.
//
// The rows are the spec: one line per tool, sorted by tier then name so the dangerous ones are together (T12-01); the
// escalation rule is text beside the selected row, because "T1 → T2 outside the root" is a sentence a user can act on
// and a colour is not (T12-02); deferred tools are listed with their reason, so absence is not mistaken for a bug
// (T12-04). What is *not* here yet: the schema viewer's paging is an expand of the selected row capped at what fits,
// with the CLI named for the whole schema — a gap carried in words, not silently.
import { wrapText } from "@crabby/platform";
import { clip, visibleWidth } from "./render.ts";

/** One tool as the view reads it — the fields of `GET /tools`'s items this view draws, typed loosely because the pane
 *  reads an envelope body the contract owns. The shapes match `apps/cli/commands/tools.ts`'s own reader, so the CLI
 *  and the TUI cannot disagree about what a tools page is. */
export interface ToolRow {
  readonly id: string;
  readonly qualifier?: string;
  readonly capabilities: readonly string[];
  readonly riskTier: string;
  readonly tierText: string;
  readonly tierRules: readonly string[];
  readonly enabled: boolean;
  readonly enabledReason?: string;
  readonly availability: {
    readonly available: boolean;
    readonly requires: string;
    readonly reason?: string;
  };
  readonly deferred?: boolean;
  readonly deferralReason?: string;
  readonly pendingRecordFields: readonly string[];
  readonly inputSchema?: Readonly<Record<string, unknown>>;
  readonly limits?: { readonly timeoutMs: number; readonly maxOutputBytes: number };
}

/** T12-01's sort: tier then name, "so the dangerous ones are together" — descending, because the eye lands at the top
 *  and a cluster that starts at T3 is the cluster a person scanning for danger wants first. The tier is the number in
 *  `T2`; a tier this build cannot parse sorts last rather than first, because an unknown is not a known danger. */
export function sortTools(rows: readonly ToolRow[]): readonly ToolRow[] {
  const rank = (tier: string): number => {
    const parsed = /^T(\d+)/.exec(tier);
    return parsed === null ? -1 : Number(parsed[1]);
  };
  return [...rows].sort((a, b) => {
    const tier = rank(b.riskTier) - rank(a.riskTier);
    if (tier !== 0) return tier;
    return a.id.localeCompare(b.id);
  });
}

/** T12-01's line: name (with its qualifier, because two rows share one id), tier, capability, and the state word —
 *  `on`, `off` (with the reason's leading clause), or `deferred`. The state word is the last thing the width may cut
 *  (T17-03's protection, applied here), because "can this run?" is the question the list answers. */
export function toolLine(row: ToolRow, columns: number, selected: boolean): string {
  const cursor = selected ? ">" : " ";
  const state =
    row.deferred === true ? "deferred" : row.enabled && row.availability.available ? "on" : "off";
  const head = `${row.riskTier} ${row.id}${row.qualifier === undefined ? "" : ` (${row.qualifier})`}`;
  const caps = row.capabilities.join("+");
  return clip(`${cursor} ${head} · ${caps} · ${state}`, columns);
}

/** T12-02's second element: the escalation rule as text, wrapped. A tool with no rule printed none — an empty block is
 *  the honest shape for "this tier never moves". */
export function tierRuleLines(row: ToolRow, columns: number): readonly string[] {
  if (row.tierRules.length === 0) return [];
  return row.tierRules.flatMap((rule) => wrapText(rule, columns, "  ↑ "));
}

/** T12-04's words: a deferred row says why it is absent, in its own line under the row — the reason is the point of
 *  the row, and a parenthetical would bury it. */
export function deferralLines(row: ToolRow, columns: number): readonly string[] {
  if (row.deferred !== true) return [];
  return wrapText(
    `not in this version — ${row.deferralReason ?? "EXTENSIONS.md §3"}`,
    columns,
    "    ",
  );
}

/** T12-03's viewer, one page of it: the input schema's JSON wrapped to the width, capped, with the CLI named for the
 *  rest. The cap is a carried gap, printed — not a silent cut. */
export function schemaLines(row: ToolRow, columns: number, maxLines: number): readonly string[] {
  const lines: string[] = [];
  if (row.limits !== undefined) {
    lines.push(
      `  limits: ${String(row.limits.timeoutMs)}ms · ${String(Math.round(row.limits.maxOutputBytes / 1024))} KiB out`,
    );
  }
  if (row.inputSchema === undefined) {
    lines.push("  no schema is in this row's record yet (pending executor fields)");
    return lines;
  }
  const json = JSON.stringify(row.inputSchema, null, 1)
    .split("\n")
    .map((line) => `  ${line}`);
  const wrapped = json.flatMap((line) =>
    visibleWidth(line) <= columns ? [line] : wrapText(line, columns, "  "),
  );
  const room = Math.max(0, maxLines - lines.length - 1);
  lines.push(...wrapped.slice(0, room));
  if (wrapped.length > room) {
    lines.push(clip(`  …the rest of the schema: crabby tools ls --json`, columns));
  }
  return lines;
}

/** The whole view. The selected row's escalation rule and deferral reason travel with it, and expansion is per
 *  selection — one tool's schema on screen at a time, which is all a 24-row terminal can honestly carry. */
export function toolsLines(
  rows: readonly ToolRow[],
  columns: number,
  selected: number,
  expanded: boolean,
  height: number,
  digest: string | undefined,
): readonly string[] {
  const sorted = sortTools(rows);
  const lines: string[] = [
    clip(`tools — ${String(sorted.length)} · registry ${digest ?? "?"}`, columns),
    clip("Enter schema · j/k move · Esc pane", columns),
  ];
  const listRoom = Math.max(1, height - 2);
  const first = Math.max(0, Math.min(selected - 3, sorted.length - listRoom));
  const shown = sorted.slice(first, first + listRoom);
  for (let index = 0; index < shown.length; index += 1) {
    const row = shown[index] as ToolRow;
    const isSelected = first + index === selected;
    lines.push(toolLine(row, columns, isSelected));
    if (isSelected) {
      lines.push(...deferralLines(row, columns));
      lines.push(...tierRuleLines(row, columns));
      if (expanded)
        lines.push(...schemaLines(row, columns, Math.max(4, height - lines.length - 1)));
    }
  }
  return lines.slice(0, height);
}
