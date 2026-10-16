// W7's context drawer: the budget bar (W7-01, estimate flagged), the sections with their costs (W7-02), the compacted
// card that **never implies the original is gone** (W7-03 / D-027), and force compact (W7-07) — which asks first,
// because a summarizing act is destructive-shaped even when the records survive.
import { html } from "../safe.js";

export function budgetLine(body) {
  const wave = body.projected?.source === "estimated" ? "~" : "";
  const used = `${wave}${Number(body.projected?.tokens ?? 0).toLocaleString("en-US")} tokens`;
  if (body.budget === undefined) {
    return `${used} of an unnamed window — the model cannot describe its budget`;
  }
  return `${used} of ${Number(body.budget.window).toLocaleString("en-US")} · reserve for output ${Number(body.budget.reserveForOutput).toLocaleString("en-US")} · compacts at ${Number(body.budget.compactAtTokens).toLocaleString("en-US")}`;
}

/** W7-08's overflow warning — the same arithmetic the composer keeps, drawn here where the budget lives. */
export function overflowNote(body, draftTokens) {
  const window = body.budget?.window;
  if (window === undefined || window <= 0) return "";
  const next = Number(body.projected?.tokens ?? 0) + draftTokens;
  if (next <= window) return "";
  return html`<div class="banner banner-warn" role="status">the next turn may not fit: ~${String(next)} of ${String(window)} — fix it with <button class="ghost" id="ctx-compact" type="button">compact now</button> or a wider model</div>`;
}

export function contextView(body) {
  const pct =
    body.budget === undefined || body.budget.tokens === 0
      ? 0
      : Math.min(
          100,
          Math.round((Number(body.projected?.tokens ?? 0) / Number(body.budget.tokens)) * 100),
        );
  return html`
    <a class="crumb" href="#/chat">← chat</a>
    <div class="card">
      <p class="card-ask">${budgetLine(body)}</p>
      <div class="budget-bar" role="img" aria-label="${String(pct)}% of the window used"><div class="budget-fill" style="width:${String(pct)}%"></div></div>
      <p class="row-meta">${body.projected?.source === "estimated" ? "estimated by the documented heuristic, not counted" : "counted by the provider's own counter"}</p>
    </div>
    <h3>what is in context</h3>
    ${(body.sections ?? []).map((s) => html`<p class="row-meta">${s.label ?? s.name ?? "section"} — ${String(s.tokens ?? 0)} tokens</p>`)}
    <h3>what was compacted</h3>
    ${
      (body.compacted ?? []).length === 0
        ? html`<p class="row-meta">nothing compacted yet</p>`
        : html`${(body.compacted ?? []).map((c) => html`<p class="row-meta">a summary stands in for turns ${String(c.fromOrdinal ?? "?")}–${String(c.toOrdinal ?? "?")} — the original records are still there, and this line links to nothing only because the routes for the originals are the messages page itself</p>`)}`
    }
    <div class="card-actions">
      <button class="send" id="ctx-compact" type="button">force compact — shows what it would keep, then asks</button>
    </div>
  `;
}
