// The list screens' pure half: W15's sessions, W16's jobs, W13's clients, W11's tools and W10's models — every row a
// word-bearing element (state words, never color alone), every id and URL on its own line so a long-press takes it
// whole (the same rule the TUI's T2-09 keeps, and for the same Termux reason).

import { cronWords, relativeTime } from "../format.js";
import { html } from "../safe.js";

/** W15-01/02/11's row: the current session is the word `current` *and* a mark, the origin is one short word. */
export function sessionRow(session, currentId) {
  const current = session.id === currentId;
  return html`
    <div class="row${current ? " row-here" : ""}" data-id="${session.id}">
      <span class="row-mark">${current ? "› current" : ""}</span>
      <div class="row-main">
        <button class="row-title row-open" type="button" data-id="${session.id}">${session.titleShown}</button>
        <span class="row-meta">${session.origin ?? ""} · ${relativeTime(session.updatedAt ?? session.createdAt)}${session.runningTasks > 0 ? ` · ${String(session.runningTasks)} running` : ""}</span>
      </div>
      <div class="row-actions">
        <button class="ghost row-rename" type="button" data-id="${session.id}">rename</button>
        <button class="ghost danger row-delete" type="button" data-id="${session.id}" data-title="${session.titleShown}">delete</button>
      </div>
    </div>
  `;
}

export function sessionList(sessions, currentId) {
  if (sessions.length === 0) {
    return html`<div class="empty"><p>no other sessions yet</p><p><code>crabby chat "…"</code> starts a fresh one — or press <strong>+</strong> above</p></div>`;
  }
  return html`${sessions.map((s) => sessionRow(s, currentId))}`;
}

/** W16-01's row: schedule written both ways — words when the reader knows them, the raw cron always. W16-02's state
 *  is a word-chip; `waiting on approval` is the one that must never be subtle. */
export function jobRow(job) {
  const words = cronWords(job.schedule ?? "");
  const state = job.stateWord ?? "active";
  return html`
    <div class="row" data-id="${job.id}">
      <div class="row-main">
        <button class="row-title row-open" type="button" data-id="${job.id}">${job.objective ?? job.name ?? job.id}</button>
        <span class="row-meta">${words === undefined ? html`<span class="warn-note">schedule reads raw:</span> <code>${job.schedule ?? "?"}</code>` : html`<span>${words}</span> · <code>${job.schedule}</code>`}</span>
        <span class="row-meta">${job.nextRun === undefined ? "no next run computed" : `next ${job.nextRun}`}</span>
      </div>
      <span class="state-chip state-${state}">${state}</span>
      <div class="row-actions">
        ${
          state === "paused"
            ? html`<button class="ghost job-resume" type="button" data-id="${job.id}">resume</button>`
            : html`<button class="ghost job-pause" type="button" data-id="${job.id}">pause</button>`
        }
        <button class="ghost job-run" type="button" data-id="${job.id}">run now</button>
      </div>
    </div>
  `;
}

export function jobList(jobs) {
  if (jobs.length === 0) {
    return html`<div class="empty"><p>no jobs yet</p><p><code>crabby task run --schedule "…"</code> creates one; this screen pauses and runs them</p></div>`;
  }
  return html`${jobs.map(jobRow)}`;
}

/** W13-01's rows: name, interface, caps count, connected as a word (the count is the Gateway's own field — one fact,
 *  one place), last seen. Mint and revoke are **loopback-only** (§3.1); a remote tab is told why the buttons are
 *  missing rather than being shown buttons that 403. */
export function clientList(clients, local) {
  const rows =
    clients.length === 0
      ? html`<div class="empty"><p>no paired clients</p><p><code>crabby auth pair --name &lt;label&gt; --interface web</code> prints a code; the connect screen redeems it</p></div>`
      : html`${clients.map(
          (c) => html`
      <div class="row" data-id="${c.id}">
        <div class="row-main">
          <span class="row-title">${c.name}</span>
          <span class="row-meta">${c.interface} · ${String((c.capabilities ?? []).length)} caps · ${c.liveStreams > 0 ? "connected" : "not connected"} · seen ${relativeTime(c.lastUsedAt ?? c.createdAt)}</span>
          <code class="row-id">${c.id}</code>
        </div>
        ${local === true ? html`<div class="row-actions"><button class="ghost danger client-revoke" type="button" data-id="${c.id}">revoke</button></div>` : ""}
      </div>
    `,
        )}`;
  if (local !== true) {
    return html`${rows}
      <p class="gap-note">pairing and revoking are local actions (D-053) — this tab is not on the gateway's own machine, so the buttons are not shown. Run <code>crabby auth pair</code> or <code>crabby auth revoke</code> on the host.</p>`;
  }
  return rows;
}

/** W11-01/02's tool rows: name, tier chip, capability, availability as words; escalation rules under the selection. */
export function toolList(tools) {
  if (tools.length === 0) {
    return html`<div class="empty"><p>no tools reported</p><p><code>GET /api/v1/tools</code> answers from the composed surface — is a gateway running?</p></div>`;
  }
  return html`${tools.map(
    (t) => html`
    <details class="row row-details">
      <summary>
        <span class="tier tier-${t.tier ?? t.riskTier ?? "T0"}">${t.tier ?? t.riskTier ?? "T0"}</span>
        <span class="row-title">${t.id}</span>
        <span class="row-meta">${(t.capabilities ?? []).join(", ")} · ${t.availability?.available === false ? `unavailable: ${t.availability.reason ?? "platform"}` : "available"}</span>
      </summary>
      <div class="row-body">
        ${(t.tierRules ?? []).map((r) => html`<p class="tool-rule">${r}</p>`)}
        ${t.limits === undefined ? "" : html`<p class="row-meta">limits: ${JSON.stringify(t.limits)}</p>`}
        <p class="gap-note">enable/disable and per-task narrowing are config/vault writes — the config side is on the settings screen; vault-backed keys have no route yet (named in HANDOVER).</p>
      </div>
    </details>
  `,
  )}`;
}

/** W10's models table, from what the config actually stores. `reported` vs `effective` needs a descriptor source the
 *  config alone does not carry — the table says what each row is rather than implying a comparison happened. */
export function modelList(models) {
  if (models.length === 0) {
    return html`<div class="empty"><p>no models configured</p><p><code>crabby provider add …</code> — the web form waits on vault-backed key storage (named in HANDOVER)</p></div>`;
  }
  return html`
    <table class="table">
      <thead><tr><th>provider / model</th><th>context</th><th>max output</th><th>capabilities (configured)</th></tr></thead>
      <tbody>
        ${models.map(
          (m) => html`
          <tr>
            <td><code>${m.label}</code></td>
            <td>${m.contextWindow === undefined ? "—" : String(m.contextWindow)}</td>
            <td>${m.maxOutput === undefined ? "—" : String(m.maxOutput)}</td>
            <td>${(m.capabilities ?? []).join(", ") || "—"}</td>
          </tr>
        `,
        )}
      </tbody>
    </table>
    <p class="gap-note">reported-vs-effective overrides and the probe are the TUI's models pane facts ("crabby model edit", "crabby model list"); the probe route does not exist in this build, so this table shows what is configured and no comparison it cannot prove.</p>
  `;
}
