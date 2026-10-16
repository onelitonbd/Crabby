// W5's task cards and W6's detail. The progress line keeps T6-03's rule (measured vs estimated is a stated
// distinction, never a bar that looks like a measurement), cancellation is three phases (W6-06), the checkpoint panel
// says what a resume would repeat (W6-07), and the panels this build's routes cannot fill are named in place — a plan
// tree nobody computed is not drawn as one.

import { elapsed, relativeTime } from "../format.js";
import { html } from "../safe.js";

export function taskCard(task) {
  const state = task.state ?? "queued";
  const approvals =
    (task.pendingApprovals ?? 0) > 0
      ? html`<a class="chip chip-live" href="#/approvals"><span class="dot dot-warn" aria-hidden="true"></span>${String(task.pendingApprovals)} waiting</a>`
      : "";
  return html`
    <div class="row row-card" data-id="${task.id}">
      <div class="row-main">
        <button class="row-title row-open" type="button" data-id="${task.id}">${task.objective}</button>
        <span class="row-meta">${task.model ?? "install default"} · ${task.lastSeq === undefined ? "progress unknown" : `step ${String(task.lastSeq)} (measured, from the event log)`} · ${relativeTime(task.updatedAt ?? task.createdAt)}</span>
        <code class="row-id">${task.id}</code>
      </div>
      <span class="state-chip state-${state}">${state}</span>
      ${approvals}
      <div class="row-actions">
        ${
          state === "running" || state === "awaiting_approval"
            ? html`<button class="ghost danger task-cancel" type="button" data-id="${task.id}">cancel</button>`
            : state === "failed" || state === "interrupted"
              ? html`<button class="ghost task-resume" type="button" data-id="${task.id}">resume</button>`
              : ""
        }
      </div>
    </div>
  `;
}

export function taskList(tasks, filterState) {
  if (tasks.length === 0) {
    return html`<div class="empty"><p>no tasks${filterState === undefined || filterState === "all" ? " yet" : ` match “${filterState}”`}</p><p>press <strong>+</strong>, or run <code>crabby task run "…"</code> from Termux</p></div>`;
  }
  return html`${tasks.map(taskCard)}`;
}

/** W5-01's filter chips: the seven states plus `all`. */
export function taskFilter(current) {
  const states = [
    "all",
    "queued",
    "planning",
    "running",
    "awaiting_approval",
    "cancelling",
    "completed",
    "failed",
    "cancelled",
  ];
  return html`<div class="filter-row">${states.map((s) => html`<button class="ghost filter-chip${current === s ? " row-here" : ""}" data-state="${s}" type="button">${s}</button>`)}</div>`;
}

/** W6's detail: header with copyable id (W6-01), the panels the events/checkpoint answers fill, and the named gaps. */
export function taskDetail(task, events, checkpoint) {
  const state = task.state ?? "queued";
  return html`
    <a class="crumb" href="#/tasks">← tasks</a>
    <div class="card">
      <p class="card-ask">${task.objective}</p>
      <p class="card-task">state <span class="state-chip state-${state}">${state}</span> · ${task.model ?? "install default"}</p>
      <code class="row-id">${task.id}</code>
      <p class="row-meta">created ${relativeTime(task.createdAt)} · updated ${relativeTime(task.updatedAt)}${task.elapsed !== undefined ? ` · ran ${elapsed(task.elapsed)}` : ""}</p>
      <div class="card-actions">
        ${
          state === "running" || state === "awaiting_approval"
            ? html`<button class="ghost danger task-cancel" type="button" data-id="${task.id}">cancel — finishes the current step</button>`
            : state === "failed" || state === "interrupted"
              ? html`<button class="ghost task-resume" type="button" data-id="${task.id}">resume from checkpoint</button>`
              : ""
        }
      </div>
    </div>
    <h3>what happened</h3>
    ${events.length === 0 ? html`<p class="row-meta">no events yet${state === "queued" ? " — the run has not started" : ""}</p>` : html`${events.map(eventRow)}`}
    <h3>checkpoint</h3>
    ${
      checkpoint === undefined
        ? html`<p class="row-meta">no checkpoint recorded — a resume would start the task over, and this line exists so that fact is read before it is acted on</p>`
        : html`<p class="row-meta">${checkpoint}</p>`
    }
    <h3>named in this build</h3>
    <p class="gap-note">W6-02's plan tree, W6-08's ladder panel, W6-09's retry history and W6-10's artifacts need the run's own step records as routes; the event log above is the honest slice of the same data. Retry-failed-step (W6-12) waits on the same routes — resume is the act this build offers.</p>
  `;
}

/** One event as a row: tool calls collapse (W3-04's rule carries), messages show, everything else is a system line. */
export function eventRow(event) {
  if (event.type === "tool.started" || event.type === "tool.finished") {
    return html`${toolRow({
      name: event.tool ?? event.name ?? "tool",
      tier: event.tier ?? "T0",
      status: event.type === "tool.started" ? "running" : (event.outcome ?? "finished"),
      duration: event.durationMs === undefined ? undefined : elapsed(event.durationMs / 1000),
      detail: JSON.stringify(event.args ?? event.result ?? {}, null, 1),
    })}`;
  }
  if (event.type === "message.added") {
    return html`<div class="msg msg-assistant"><div class="msg-body">${event.content ?? ""}</div></div>`;
  }
  if (event.type === "approval.requested") {
    return html`<p class="row-meta">asked a human: ${event.summary ?? event.tool ?? "approval"} — <a href="#/approvals">the card</a></p>`;
  }
  return html`<p class="sys-line">${event.type}${event.note === undefined ? "" : ` — ${event.note}`}</p>`;
}

function toolRow(call) {
  return html`
    <details class="tool-row">
      <summary>
        <span class="tier tier-${call.tier}">${call.tier}</span>
        <span class="tool-name">${call.name}</span>
        <span class="tool-status">${call.status}</span>
        <span class="tool-dur">${call.duration ?? ""}</span>
      </summary>
      <pre class="tool-out">${call.detail}</pre>
    </details>
  `;
}
