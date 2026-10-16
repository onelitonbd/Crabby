// T8's context view: what a conversation costs, what has been compacted, what is protected — one screen over
// `GET /sessions/{id}/context`, which is the same read `crabby session show` makes (C11-03).
//
// Every number here is an estimate unless the body says otherwise (§3.4), and the view keeps the body's own honesty:
// an absent budget is a fact about the model ("cannot describe its window"), not a zero; a section costing nothing
// prints `0` so the *shape* of the conversation stays visible (T8-02); and the compacted card never implies the
// original turns are gone (D-027) — they live at the messages route, named in words.
import type { SessionContextBody } from "@crabby/api-contracts";
import { wrapText } from "@crabby/platform";
import { visibleWidth } from "./render.ts";

const numbered = (value: number): string => value.toLocaleString("en-US");

/** T8-01's one budget line: used / available, the estimate's `~` (O-031's whole point), and the reserve for output.
 *  An absent budget says why rather than inventing a window (§3.2 — disabled, not broken). */
export function budgetLine(body: SessionContextBody): string {
  const wave = body.projected.source === "estimated" ? "~" : "";
  const used = `${wave}${numbered(body.projected.tokens)} tokens`;
  if (body.budget === undefined) {
    return `${used} of an unnamed window — the model cannot describe its budget (§3.2)`;
  }
  return `${used} of ${numbered(body.budget.tokens)} · reserve for output ${numbered(body.budget.reserveForOutput)} · compacts at ${numbered(body.budget.compactAtTokens)}`;
}

/** T8-02: each section with its cost, `0` shown rather than hidden. Three sections because the route answers three
 *  questions (compacted, pinned, current) — the same three `session show` asks. */
export function sectionLines(body: SessionContextBody): readonly string[] {
  const line = (name: string, section: SessionContextBody["sections"]["current"]): string =>
    `${name}: ~${numbered(section.tokens)} tokens · ${numbered(section.chars)} chars · ${String(section.turns)} ${section.turns === 1 ? "turn" : "turns"}`;
  return [
    "in context:",
    line("  compacted summaries", body.sections.compacted),
    line("  pinned turns", body.sections.pinned),
    line("  the verbatim tail", body.sections.current),
  ];
}

/** T8-03: the summary cards, and the sentence that keeps D-027's promise — nothing is deleted, the originals are
 *  readable where the route says they are. */
export function compactedLines(body: SessionContextBody): readonly string[] {
  if (body.compacted.length === 0)
    return ["compacted: nothing yet — the whole conversation is the verbatim tail"];
  const lines = body.compacted.slice(0, 4).map((card) => {
    const through = card.covers.through;
    const from = card.covers.from;
    return `  summary of turns ${String(from)}–${String(through)} (${String(card.turns)} turns, written ${card.at.slice(0, 10)})`;
  });
  if (body.compacted.length > 4) lines.push(`  …and ${String(body.compacted.length - 4)} earlier`);
  lines.push(
    "  the original turns are not gone — they are readable at GET /sessions/" +
      body.sessionId +
      "/messages",
  );
  return lines;
}

/** T8-04/06's halves that exist, with the two that do not named rather than faked: pins by turn range are a write
 *  this build has; unpin needs the turn's *id*, which the context read does not carry, so it says where the CLI
 *  does it; injected memory is `absent` in the body (M4), and T8-05's exclude-without-delete has no route at all. */
export function policyLines(body: SessionContextBody): readonly string[] {
  const pins =
    body.pinned.length === 0
      ? "pinned: none — `p 3-5` protects a range"
      : `pinned: ${body.pinned.map((range) => (range.from === range.through ? String(range.from) : `${String(range.from)}-${String(range.through)}`)).join(", ")}`;
  return [
    pins,
    "unpin needs the turn's id, which this view cannot see — `crabby session unpin` does it",
    "injected memory: nothing (the body names it absent — memory arrives with M4)",
    "excluding a section from the next turn has no route in this build (T8-05 waits for one)",
  ];
}

/** T8-08's warning, *before* a send rather than as an error after one: two lines, the fact and the two fixes. The
 *  threshold is the body's own `compactAt`, because a client that recomputed it could disagree with the Gateway. */
export function overflowLines(body: SessionContextBody): readonly string[] {
  if (body.budget === undefined) return [];
  const tokens = body.projected.tokens;
  if (tokens + 2000 > body.budget.window) {
    return [
      `! the next turn would pass this model's window (~${numbered(tokens)} of ${numbered(body.budget.window)})`,
      "  compact this conversation (c), or start a new one — sending as-is will fail at the provider",
    ];
  }
  if (tokens > body.budget.compactAtTokens) {
    return [
      `! over the compact threshold (~${numbered(tokens)} of ${numbered(body.budget.compactAtTokens)}): the next turns pay for it`,
      "  compact now (c) to keep the tail and free the budget, or keep going and let the drive decide",
    ];
  }
  return [];
}

/** The whole view. `confirmCompact` is the second-press state for T8-07's force compact — a destructive-ish act over
 *  the same endpoint Web W7-07 uses, so it asks once, in words, before it runs. */
export function contextLines(
  body: SessionContextBody,
  columns: number,
  confirmCompact: boolean,
  /** T8-04's pin input, drawn inline on the view while it is being typed — an overlay asking for a range is still one
   *  screen, and the range a person is typing belongs next to the pins it will join. */
  pinInput?: string | undefined,
): readonly string[] {
  const lines = [
    `context of ${body.sessionId}${body.model === undefined ? "" : ` · ${body.model}`}`,
    budgetLine(body),
    ...sectionLines(body),
    ...compactedLines(body),
    ...policyLines(body),
    ...overflowLines(body),
  ];
  if (pinInput !== undefined) {
    lines.push(`pin range (from-through, like 3-5): ${pinInput}▏ (Enter pins · Esc back)`);
  }
  lines.push(
    confirmCompact
      ? "compact NOW? press c again — the tail above is the preview of what it would summarize"
      : "c compact now (the sections above are the preview) · p pin range · Esc back",
  );
  const wrapped = lines.flatMap((line) =>
    visibleWidth(line) <= columns ? [line] : wrapText(line, columns, ""),
  );
  return wrapped;
}
