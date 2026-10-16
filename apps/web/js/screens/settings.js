// <crabby-screen-settings> — W12's screen and its sub-tabs (W12-09): general (appearance W12-04/05 + the schema-driven
// config form W12-01/02/03), access (W13), models (W10), tools (W11), logs (W14) — plus the two screens that exist to
// be honest about their absence: extensions (W-E) and memory (W8). The config edit dialog is W12-02's diff-before-
// apply: the write is `PUT /config` with the document's own token, refused from a stale read rather than merged.
import { request } from "../api.js";
import {
  appearanceControls,
  configEntries,
  diffLines,
  settingsForm,
  stringifyValue,
} from "../ui/config.js";
import { diagnosticsProblemShapes, gapBlock } from "../ui/gaps.js";
import { clientList, modelList, toolList } from "../ui/lists.js";

const SUBTABS = [
  { id: "", label: "general" },
  { id: "access", label: "access" },
  { id: "models", label: "models" },
  { id: "tools", label: "tools" },
  { id: "logs", label: "logs" },
  { id: "extensions", label: "extensions" },
  { id: "memory", label: "memory" },
];

export class CrabbyScreenSettings extends HTMLElement {
  connectedCallback() {
    this.sub = this.dataset.rest ?? "";
    void this.load();
  }

  async load() {
    const tabs = `<nav class="subtabs">${SUBTABS.map((t) => `<a class="subtab${this.sub === t.id ? " row-here" : ""}" href="#/settings${t.id === "" ? "" : `/${t.id}`}">${t.label}</a>`).join("")}</nav>`;
    try {
      if (this.sub === "access") return this.renderAccess(tabs);
      if (this.sub === "models") return await this.renderModels(tabs);
      if (this.sub === "tools") return await this.renderTools(tabs);
      if (this.sub === "logs") return await this.renderLogs(tabs);
      if (this.sub === "extensions") return this.renderGap(tabs, "extensions");
      if (this.sub === "memory") return this.renderGap(tabs, "memory");
      return await this.renderGeneral(tabs);
    } catch (error) {
      this.innerHTML = `${tabs}<div class="err-panel"><p><strong>${error.code}</strong> — ${error.message}</p></div>`;
    }
  }

  async renderGeneral(tabs) {
    const [config, schema] = await Promise.all([request("/config"), request("/config/schema")]);
    this.configDoc = config.config ?? config;
    this.configToken = config.token ?? config.etag;
    const entries = configEntries(schema.schema ?? schema, this.configDoc);
    this.innerHTML = `${tabs}
      <h2>general</h2>
      <div id="appearance">${appearanceControls(window.localStorage.getItem("crabby.density") ?? "comfortable")}</div>
      <h3>configuration — security-relevant rows are marked <span class="tier tier-T3">T3</span> before you touch them</h3>
      <div id="cfg"></div>`;
    this.querySelector("#cfg").innerHTML = settingsForm(entries).valueOf();
    this.querySelectorAll(".cfg-edit").forEach((b) => {
      b.addEventListener("click", () => this.openEdit(b.dataset.key, entries));
    });
    this.querySelectorAll(".theme-set").forEach((b) => {
      b.addEventListener("click", () => {
        document.documentElement.dataset.theme = b.dataset.theme;
        window.localStorage.setItem("crabby.theme", b.dataset.theme);
      });
    });
    this.querySelectorAll(".density-set").forEach((b) => {
      b.addEventListener("click", () => {
        document.documentElement.dataset.density = b.dataset.density;
        window.localStorage.setItem("crabby.density", b.dataset.density);
      });
    });
  }

  openEdit(key, entries) {
    const entry = entries.find((e) => e.key === key);
    if (entry === undefined) return;
    const dialog = this.querySelector("#cfg-dialog");
    this.querySelector("#cfg-key").textContent = key;
    const buffer = this.querySelector("#cfg-buffer");
    buffer.value = stringifyValue(entry.value);
    const diff = this.querySelector("#cfg-diff");
    diff.hidden = true;
    const note = this.querySelector("#cfg-note");
    note.textContent = "";
    this.querySelector("#cfg-show-diff").onclick = () => {
      let after;
      try {
        after = JSON.parse(buffer.value);
      } catch {
        after = buffer.value;
      }
      diff.hidden = false;
      // W12-02: exactly what changed, before it changes.
      diff.textContent = diffLines(key, entry.value, after).join("\n");
    };
    this.querySelector("#cfg-form").onsubmit = (event) => {
      event.preventDefault();
      void this.apply(key, entry.value, buffer.value, note, dialog);
    };
    dialog.showModal();
  }

  async apply(key, _before, rawText, note, dialog) {
    let after;
    try {
      after = JSON.parse(rawText);
    } catch {
      after = rawText;
    }
    // The write carries the whole document with one key changed — the CAS is the Gateway's, via If-Match.
    const doc = structuredClone(this.configDoc ?? {});
    let cursor = doc;
    const parts = key.split(".");
    for (const part of parts.slice(0, -1)) {
      cursor[part] = cursor[part] ?? {};
      cursor = cursor[part];
    }
    cursor[parts[parts.length - 1]] = after;
    try {
      const written = await request("/config", {
        method: "PUT",
        body: doc,
        ifMatch: `"${String(this.configToken)}"`,
      });
      this.configDoc = written.config ?? written;
      this.configToken = written.token ?? written.etag;
      note.textContent = "written";
      dialog.close();
      await this.load();
    } catch (error) {
      note.textContent = `refused: ${error.message} — a stale read is refused, not merged; reload and try again`;
    }
  }

  async renderAccess(tabs) {
    let clients = [];
    let local = false;
    try {
      const body = await request("/auth/clients");
      clients = body.items ?? [];
      local = true;
    } catch (error) {
      // The loopback rule answers a remote tab with 403/401 — which *is* the W13-02 explanation, delivered by the
      // route itself. The screen renders the list it could not get as the named reason, not as a blank table.
      this.innerHTML = `${tabs}
        <h2>access</h2>
        <div class="gap"><p class="gap-title">identity management is loopback-only (§3.1 / D-053)</p>
        <p>this tab is not on the gateway's own machine, so the list and its acts are the host's: <code>crabby auth list</code>, <code>crabby auth revoke</code>, <code>crabby auth pair</code>.</p>
        <p>the gateway answered: <code>${error.code}</code></p></div>
        ${gapBlock("tunnel", "telegram", "lifecycle", "vault").valueOf()}`;
      return;
    }
    this.innerHTML = `${tabs}
      <h2>access</h2>
      <div id="clients"></div>
      ${gapBlock("tunnel", "telegram", "lifecycle", "vault").valueOf()}`;
    this.querySelector("#clients").innerHTML = clientList(clients, local).valueOf();
    this.querySelectorAll(".client-revoke").forEach((b) => {
      b.addEventListener("click", () => {
        if (
          window.confirm(
            `revoke ${b.dataset.id}? its live streams end immediately and its token stops working`,
          )
        ) {
          void request(`/auth/clients/${encodeURIComponent(b.dataset.id)}`, {
            method: "DELETE",
          }).then(() => this.load());
        }
      });
    });
  }

  async renderModels(tabs) {
    const config = await request("/config");
    const doc = config.config ?? config;
    const models = [];
    for (const [providerId, provider] of Object.entries(doc.provider ?? {})) {
      for (const [modelId, model] of Object.entries(provider?.models ?? {})) {
        models.push({
          label: `${providerId}/${modelId}`,
          contextWindow: model.contextWindow,
          maxOutput: model.maxOutput,
          capabilities: model.capabilities ?? model.overrideCapabilities,
        });
      }
    }
    this.innerHTML = `${tabs}<h2>models</h2>${modelList(models).valueOf()}${gapBlock("probe").valueOf()}`;
  }

  async renderTools(tabs) {
    const body = await request("/tools");
    this.innerHTML = `${tabs}<h2>tools</h2>${toolList(body.items ?? []).valueOf()}`;
  }

  async renderLogs(tabs) {
    let diagnostics = "";
    let problems = [];
    try {
      const body = await request("/diagnostics");
      diagnostics = JSON.stringify(body, null, 2);
      // W14-05: scanned before the clipboard gets it — the same shapes the CLI's `findUnsafeShapes` refuses.
      problems = diagnosticsProblemShapes(diagnostics);
      if (problems.length > 0)
        diagnostics = `NOT COPIED — the bundle contains: ${problems.join(", ")}`;
    } catch (error) {
      diagnostics = `diagnostics refused: ${error.message}`;
    }
    this.innerHTML = `${tabs}
      <h2>logs &amp; audit</h2>
      ${gapBlock("logs").valueOf()}
      <h3>diagnostics bundle (W14-05)</h3>
      <pre class="tool-out" id="diag">${diagnostics}</pre>
      <button class="ghost" id="diag-copy" type="button" ${problems.length > 0 ? "disabled" : ""}>copy sanitized bundle${problems.length === 0 ? " — verified by the scan above" : " (blocked by the scan)"}</button>
      <p class="row-meta">the scan is the same property the CLI holds, tested on both sides; a bundle that fails it is never copied (W14-07's assurance, in words).</p>`;
    this.querySelector("#diag-copy")?.addEventListener("click", () => {
      void navigator.clipboard?.writeText(diagnostics);
    });
  }

  renderGap(tabs, id) {
    const titles = { extensions: "extensions", memory: "memory" };
    this.innerHTML = `${tabs}<h2>${titles[id]}</h2>${gapBlock(id).valueOf()}`;
  }
}

customElements.define("crabby-screen-settings", CrabbyScreenSettings);
