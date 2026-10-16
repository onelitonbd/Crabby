// W12's settings surface, driven by the **server's** schema (`GET /api/v1/config/schema`) rather than a local copy —
// W12-01's row is explicit that new config keys appear automatically, and a schema copied into the client would be a
// second copy of a contract that drifts. What the client owns is the *presentation*: the T3 marker families (a client-
// side mirror of `@crabby/core`'s SECURITY_FAMILIES, pinned by `settings-project.test.ts` so the two cannot drift
// silently), the diff-before-apply (W12-02), and the CAS write through `PUT /config` with the document's own token.

import { html } from "../safe.js";

/** The families a value belongs to when its key says so — the keys whose edit is a T3 act. */
export const SECURITY_FAMILIES = ["shell", "net", "workspace", "provider"];

export function isSecurityKey(key) {
  return SECURITY_FAMILIES.some((family) => key === family || key.startsWith(`${family}.`));
}

/** Walk the server's JSON schema into flat `{key, value, kind}` entries, values joined from the config document. */
export function configEntries(schema, doc, prefix = "") {
  const entries = [];
  if (schema === undefined || typeof schema !== "object") return entries;
  if (schema.type === "object") {
    const props = schema.properties ?? {};
    for (const [name, child] of Object.entries(props)) {
      const key = prefix.length === 0 ? name : `${prefix}.${name}`;
      const value = doc?.[name];
      if (child?.type === "object" && child.properties !== undefined) {
        entries.push(...configEntries(child, value ?? {}, key));
      } else {
        entries.push({ key, value, kind: child?.type ?? "unknown" });
      }
    }
  }
  return entries;
}

/** W12-02's diff, as lines. JSON for structure, bare for strings — the same shape `crabby config set` shows. */
export function diffLines(key, before, after) {
  const show = (v) => (typeof v === "string" ? v : JSON.stringify(v));
  return [`- ${key}: ${show(before)}`, `+ ${key}: ${show(after)}`];
}

/** The settings form: T3 markers **before** edit (W12-03), values as strings the walker round-trips. */
export function settingsForm(entries) {
  if (entries.length === 0) {
    return html`<div class="empty"><p>config answered nothing</p><p>is the gateway running, and paired?</p></div>`;
  }
  return html`${entries.map(
    (e) => html`
    <div class="row${isSecurityKey(e.key) ? " row-t3" : ""}" data-key="${e.key}">
      <div class="row-main">
        <span class="row-title">${e.key}${isSecurityKey(e.key) ? html` <span class="tier tier-T3">T3</span>` : ""}</span>
        <span class="row-meta">${e.kind}</span>
      </div>
      <code class="row-value">${stringifyValue(e.value)}</code>
      <div class="row-actions"><button class="ghost cfg-edit" type="button" data-key="${e.key}">edit</button></div>
    </div>
  `,
  )}

    <dialog id="cfg-dialog" class="dialog">
      <form method="dialog" id="cfg-form">
        <h2>edit <code id="cfg-key"></code></h2>
        <p class="row-meta">new value (JSON or bare text):</p>
        <textarea id="cfg-buffer" rows="3"></textarea>
        <pre id="cfg-diff" class="diff" hidden></pre>
        <p class="row-meta" id="cfg-note"></p>
        <menu>
          <button value="cancel" id="cfg-cancel" type="button">cancel</button>
          <button value="diff" id="cfg-show-diff" type="button">show diff</button>
          <button value="apply" id="cfg-apply" type="submit" class="send">write</button>
        </menu>
      </form>
    </dialog>`;
}

export function stringifyValue(value) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** W12-04/05: the two user-choice presentation settings, stored locally — a UI setting must not ride the Gateway's
 *  config (it is per-interface by DESIGN_SYSTEM §8's own rule). */
export function appearanceControls(current) {
  return html`
    <div class="row">
      <div class="row-main"><span class="row-title">theme</span><span class="row-meta">dark is designed first, light is measured too (D-068)</span></div>
      <div class="row-actions">
        <button class="ghost theme-set" data-theme="dark" type="button">dark</button>
        <button class="ghost theme-set" data-theme="light" type="button">light</button>
      </div>
    </div>
    <div class="row">
      <div class="row-main"><span class="row-title">density</span><span class="row-meta">a user choice, never auto-detected (DESIGN_SYSTEM §8)</span></div>
      <div class="row-actions">
        ${["comfortable", "compact", "reduced"].map((d) => html`<button class="ghost density-set${current === d ? " row-here" : ""}" data-density="${d}" type="button">${d}</button>`)}
      </div>
    </div>`;
}
