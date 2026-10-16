// The chat screen's pure half — W3's message list and W4's composer. Two decisions are inherited whole:
// **T5-06/W4-06's capability line prints the documented conservative defaults** for the same reason the TUI's does —
// nothing answers "which identity am I", so a capability line computed anyway would be a guess wearing a fact's clothes.
// And **tool rows stay collapsed with their tier visible** (W3-04), expanding to args and output (W3-05) where a
// `redacted` marker means "something was there" (W14-02's rule, in a tool's clothing).
import { html } from "../safe.js";

export const SLASH_COMMANDS = ["/model", "/compact", "/pin", "/task", "/cancel", "/attach"];

/** W4-03's filtered menu: what the half-typed slash still matches, each with its about line. */
export function slashMatches(text) {
  if (!text.startsWith("/")) return [];
  const query = text.slice(1).toLowerCase();
  const about = {
    "/model": "pick the model — this turn only",
    "/compact": "compact this conversation, preview first",
    "/pin": "protect turn ranges from compaction",
    "/task": "send as a multi-step task (POST /tasks)",
    "/cancel": "stop the running task — finishes the step first",
    "/attach": "attach a file by workspace path",
  };
  return SLASH_COMMANDS.filter((c) => c.slice(1).startsWith(query)).map((c) => ({
    command: c,
    about: about[c],
  }));
}

/** W3-01/W3-02's rows. Content is *data* — escaped by the template — and a turn's first assistant line carries the
 *  model tag (W3-02). `taskId` renders W3-07's banner line. */
export function messageRows(messages) {
  if (messages.length === 0) {
    return html`<div class="empty"><p>nothing said yet</p><p>say something below, or from a shell: <code>crabby chat "…"</code></p></div>`;
  }
  return html`${messages.map((m) => {
    const role = m.role === "user" ? "msg-user" : "msg-assistant";
    const modelTag =
      m.role === "assistant" && m.model !== undefined
        ? html`<span class="msg-model">${m.model}</span>`
        : "";
    const taskLink =
      m.taskId !== undefined
        ? html`<a class="msg-task" href="${hashTask(m.taskId)}">task ${m.taskId}</a>`
        : "";
    return html`
      <div class="msg ${role}" data-id="${m.id}">
        <div class="msg-meta">${modelTag}${taskLink}<span class="msg-when">${m.when ?? ""}</span></div>
        <div class="msg-body">${m.content}</div>
      </div>
    `;
  })}`;
}

function hashTask(id) {
  return `#/tasks/${encodeURIComponent(id)}`;
}

/** W3-04's collapsed tool row: name, tier chip, status, duration — expandable by the element, never by content. */
export function toolRow(call) {
  return html`
    <details class="tool-row" data-tool="${call.name}">
      <summary>
        <span class="tier tier-${call.tier}">${call.tier}</span>
        <span class="tool-name">${call.name}</span>
        <span class="tool-status">${call.status}</span>
        <span class="tool-dur">${call.duration ?? ""}</span>
      </summary>
      <pre class="tool-out">${call.detail ?? ""}</pre>
    </details>
  `;
}

/** W3-11's error panel — code, one human line, what is pending, resumable?, request id. Never a bare toast (W-O5). */
export function errorPanel(error) {
  return html`
    <div class="err-panel" role="alert">
      <p><strong>${error.code}</strong> — ${error.message}</p>
      ${error.resumable === true ? html`<p>resumable: the run can continue from its last checkpoint</p>` : ""}
      ${error.requestId === undefined ? "" : html`<p class="err-req">request ${error.requestId}</p>`}
    </div>
  `;
}

/** W4's composer: the input, the slash menu slot, the send/stop button (W4-07), and the two draft facts — queue count
 *  (W4-08) and token estimate (W4-09, labeled as an estimate). The capability chip (W4-06) is the conservative-defaults
 *  line, named as such rather than dressed up. */
export function composer(state) {
  const estimate =
    state.draftChars > 0
      ? html`<span class="draft-fact">draft ≈ ${String(Math.max(1, Math.ceil(state.draftChars / 4)))} tokens (estimate, not a count)</span>`
      : "";
  const queued =
    state.queued > 0
      ? html`<button class="draft-fact draft-link" id="queue-open" type="button">queued ${String(state.queued)} — sends when the run settles</button>`
      : "";
  // The stop affordance replaces send while a run is in flight — and deliberately does *not* carry the `.send`
  // class, so one selector can never bind "send" to the button whose whole job is to interrupt (W4-08).
  const stop = state.running
    ? html`<button class="composer-stop" id="send-stop" type="button">stop — finishes the step</button>`
    : html`<button class="send" id="send-go" type="button">send</button>`;
  return html`
    <div class="composer">
      <div class="cap-line" id="cap-line" title="what a run may touch — from documented defaults, see the gap note">
        fs: workspace · net: off · shell: off
      </div>
      <div class="slash" id="slash-menu" hidden></div>
      <textarea id="compose" rows="1" placeholder="${state.taskMode ? "describe the task — Enter sends it as one" : "ask, or / for commands"}" aria-label="message"></textarea>
      <div class="composer-row">
        <label class="task-toggle"><input type="checkbox" id="as-task" ${state.taskMode ? "checked" : ""}/> as task</label>
        ${estimate}${queued}
        <span class="composer-spacer"></span>
        ${stop}
      </div>
    </div>
  `;
}
