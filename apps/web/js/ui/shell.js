// The shell's pure half: W1's status bar, W2's navigation, and the two global surfaces every screen inherits.
// **W1-A (closed by D-067) is the bar's law**: four chips inline — model, connection, approvals, vault — the rest in the
// more sheet, with the two exceptions that *escape the sheet into the bar*: a locked vault and an offline state, because
// those are the two states where the bar is the only place a user looks. Meaning never travels by color alone
// (DESIGN_SYSTEM §1-06): every chip carries a word, the dot is decoration.

import { relativeTime } from "../format.js";
import { hashFor } from "../router.js";
import { html } from "../safe.js";

/** The chips that are always inline. The order is D-067's: model, connection, approvals, vault — then the bar's own
 *  exceptions appended (offline forces itself out of the sheet by being inline here, not by a second rule). */
export function statusBar(state) {
  const connection = connectionChip(state.connection, state.lastConfirmed);
  const approvals =
    state.approvals > 0
      ? html`<a class="chip chip-live" href="${hashFor("approvals")}"><span class="dot dot-warn" aria-hidden="true"></span>${String(state.approvals)} waiting</a>`
      : "";
  const vault = state.vaultUnlocked
    ? html`<a class="chip" href="${hashFor("settings", ["access"])}"><span class="dot dot-ok" aria-hidden="true"></span>vault unlocked</a>`
    : html`<a class="chip chip-escape" href="${hashFor("settings", ["access"])}"><span class="dot dot-err" aria-hidden="true"></span>vault locked</a>`;
  const model =
    state.model === undefined
      ? html`<a class="chip" href="${hashFor("settings", ["models"])}">model: none</a>`
      : html`<a class="chip" href="${hashFor("settings", ["models"])}" title="${state.model}">${abbreviateProvider(state.model)}</a>`;
  return html`
    <a class="brand" href="${hashFor("chat")}">Crabby</a>
    <button class="chip chip-plain" id="session-title" type="button" title="rename">${state.sessionTitle ?? "no session"}</button>
    ${model}
    ${connection}
    ${approvals}
    ${vault}
    <a class="chip chip-hide-narrow" href="${hashFor("settings", ["logs"])}">${state.version === undefined ? "v?" : `v${state.version}`}</a>
  `;
}

function connectionChip(connection, lastConfirmed) {
  if (connection === "live") {
    return html`<span class="chip chip-live"><span class="dot dot-ok" aria-hidden="true"></span>live</span>`;
  }
  if (connection === "reconnecting") {
    return html`<span class="chip chip-live"><span class="dot dot-warn" aria-hidden="true"></span>reconnecting${lastConfirmed === undefined ? "" : ` · was ${relativeTime(lastConfirmed)}`}</span>`;
  }
  // Offline escapes the sheet into the bar (D-067's exception) and names the fix, per W-O7.
  return html`<span class="chip chip-escape"><span class="dot dot-err" aria-hidden="true"></span>offline</span>`;
}

/** W1-03: the provider abbreviated so the badge fits 360px — the first path segment, kept recognizable. */
function abbreviateProvider(model) {
  const slash = model.indexOf("/");
  if (slash < 0) return model.length > 24 ? `${model.slice(0, 23)}…` : model;
  const provider = model.slice(0, slash);
  const short = provider.length > 8 ? `${provider.slice(0, 7)}…` : provider;
  return `${short}/${model.slice(slash + 1)}`;
}

/** W2-01's five tabs; W2-02's `+` first (thumb-reachable); W2-03's badges; W2-04's `g`-prefixed shortcuts are wired in
 *  the shell element and listed in the help sheet, never required on mobile. */
export function nav(current, badges = {}) {
  const tabs = [
    { id: "chat", label: "Chat", key: "c" },
    { id: "tasks", label: "Tasks", key: "t", badge: badges.approvals },
    { id: "jobs", label: "Scheduled", key: "j" },
    { id: "extensions", label: "Extensions", key: "e" },
    { id: "settings", label: "Settings", key: "s" },
  ];
  return html`
    <button class="nav-new" id="nav-new" type="button" aria-label="new task">+</button>
    ${tabs.map((tab) => {
      const id = tab.id === "extensions" ? "settings/extensions" : tab.id;
      const badge =
        tab.badge !== undefined && tab.badge > 0
          ? html`<span class="nav-badge">${String(tab.badge)}</span>`
          : "";
      return html`<a class="nav-tab${current === tab.id ? " nav-here" : ""}" href="${hashFor(id)}">${tab.label}${badge}</a>`;
    })}
  `;
}

/** W-O9's help sheet: every key and every slash command, because a shortcut nobody can discover is a key nobody uses. */
export function helpSheet() {
  return html`
    <h2>Keys</h2>
    <dl class="help-list">
      <dt><kbd>g</kbd> then <kbd>c</kbd>/<kbd>t</kbd>/<kbd>j</kbd>/<kbd>e</kbd>/<kbd>s</kbd></dt><dd>jump to Chat / Tasks / Scheduled / Extensions / Settings</dd>
      <dt><kbd>n</kbd></dt><dd>new task</dd>
      <dt><kbd>?</kbd></dt><dd>this sheet</dd>
      <dt><kbd>Ctrl/Cmd</kbd>+<kbd>K</kbd></dt><dd>command palette (desktop)</dd>
    </dl>
    <h2>Slash commands</h2>
    <dl class="help-list">
      <dt><kbd>/model</kbd></dt><dd>pick the model for this turn</dd>
      <dt><kbd>/compact</kbd></dt><dd>compact this conversation, preview first</dd>
      <dt><kbd>/pin</kbd></dt><dd>protect turn ranges from compaction</dd>
      <dt><kbd>/task</kbd></dt><dd>send as a multi-step task</dd>
      <dt><kbd>/cancel</kbd></dt><dd>stop the running task — finishes the step first</dd>
      <dt><kbd>/attach</kbd></dt><dd>attach a file by workspace path</dd>
    </dl>
  `;
}

/** W1-11's more sheet: the chips that did not fit, each with its full text. Rendered into a `<dialog>` (D-068). */
export function moreSheet(state) {
  return html`
    <h2>More</h2>
    <a class="sheet-row" href="${hashFor("settings", ["logs"])}">Logs &amp; audit${state.version === undefined ? "" : ` · v${state.version}`}</a>
    <a class="sheet-row" href="${hashFor("sessions")}">Sessions</a>
    <a class="sheet-row" href="${hashFor("context")}">Context of this conversation</a>
    <a class="sheet-row" href="${hashFor("settings", ["tools"])}">Tools</a>
  `;
}

/** W-O7: the offline page is the exact restart command for Termux, not a generic retry. */
export function offlineBanner() {
  return html`
    <div class="banner banner-err" role="status">
      <span>the gateway is unreachable — the words you send are kept until it is back</span>
      <code>crabby gateway start</code>
    </div>
  `;
}
