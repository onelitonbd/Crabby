// W-A's cards. The queue is oldest-first; each card leads with the second-person sentence (A2), shows the **exact
// target** (A3 — never a paraphrase), names consequence and reversibility (A4), counts down the expiry with its reason
// (A5), and offers the one affirmative act v1 has: approve once (A6, D-052). Deny carries an optional reason (A7).
// A stale answer from another interface is a *conflict* banner (A10), first answer wins, nothing runs twice.

import { elapsed } from "../format.js";
import { html } from "../safe.js";

export function approvalCard(approval, now = Date.now()) {
  const expires = approval.expiresAt === undefined ? "" : Date.parse(approval.expiresAt);
  const secondsLeft = Number.isNaN(expires) ? undefined : Math.round((expires - now) / 1000);
  const countdown =
    secondsLeft === undefined
      ? ""
      : secondsLeft <= 0
        ? "expired — it will answer itself as a denial"
        : `expires in ${elapsed(secondsLeft)} · because a prompt nobody answers must not stall the run forever`;
  return html`
    <div class="card approval" data-id="${approval.id}">
      <p class="card-ask">${approval.summary ?? approval.question ?? "the run asks to act"}</p>
      <p class="card-target"><span class="meta-word">exact target</span> <code>${approval.target ?? "—"}</code></p>
      <p class="card-consequence">${approval.consequence ?? "reversibility is not stated by this build's prompts — read the target before approving"}</p>
      <p class="card-expiry">${countdown}</p>
      <p class="card-task">${approval.taskId === undefined ? "" : html`task <a href="#/tasks/${approval.taskId}">${approval.taskId}</a> · `}${approval.tool ?? ""} <span class="tier tier-${approval.tier ?? "T0"}">${approval.tier ?? ""}</span></p>
      <div class="card-actions">
        <button class="send approve" type="button" data-id="${approval.id}">approve once</button>
        <button class="ghost danger deny" type="button" data-id="${approval.id}">deny</button>
        <button class="ghost why" type="button" data-id="${approval.id}">why am I asked?</button>
      </div>
      <input class="deny-reason" id="reason-${approval.id}" type="text" placeholder="reason (recorded on the task), optional" aria-label="deny reason"/>
      <p class="why-note" id="why-${approval.id}" hidden>the prompt exists because the tool's tier asks (see the tool screen's escalation rules) — configuration, not the run, decides when people are asked.</p>
    </div>
  `;
}

export function approvalQueue(items, conflict, now = Date.now()) {
  // The banner is *before* the empty check on purpose: the queue that just emptied because another interface answered
  // first is exactly the moment A10's sentence has to be on screen.
  const banner =
    conflict === true
      ? html`<div class="banner banner-warn" role="status">answered elsewhere — the first answer won, and nothing ran twice (A10)</div>`
      : "";
  if (items.length === 0) {
    return html`${banner}<div class="empty"><p>nothing waiting</p><p>approvals appear here — and in the status bar's chip — when a run needs a human</p></div>`;
  }
  return html`${banner}${items.map((a) => approvalCard(a, now))}`;
}
