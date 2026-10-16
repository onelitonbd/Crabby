// <crabby-connect> — the first-run screen, and it is §3.2's pairing ceremony with nothing added: an 8-character code
// from `crabby auth pair`, typed once, redeemed against `POST /api/v1/auth/pair` (§3.1's one exempt route), the token
// stored locally and never shown again. There is deliberately no "enter a token" field next to it: a token that can be
// pasted into a browser field is a token that can be pasted out of a screenshot, and the code path is the one the
// Gateway's own docs promise. W13-02's spirit is on this screen too: minting is a host-side act, and the screen says so.
import { request, writeToken } from "../api.js";
import { html } from "../safe.js";
import { setState } from "../store.js";

export function connectView() {
  return html`
    <div class="card connect-card">
      <h1>Crabby</h1>
      <p>pair this browser with your gateway. On the machine the gateway runs on:</p>
      <pre class="tool-out">crabby auth pair --name this-browser --interface web</pre>
      <p>it prints an 8-character code — <strong>single use, expires in ~2 minutes</strong>. Type it here:</p>
      <form id="pair-form">
        <input id="pair-code" class="pair-code" type="text" maxlength="8" autocomplete="off"
               spellcheck="false" placeholder="········" aria-label="pairing code" required/>
        <button class="send" type="submit">pair</button>
      </form>
      <p class="row-meta" id="pair-note"></p>
      <p class="gap-note">the code is the only thing this page will ever ask for: it redeems once for a token this
      browser keeps to itself. Minting codes is a host-side act (D-053) — the gateway's own user runs
      <code>crabby auth pair</code>, nobody else can ask for one.</p>
    </div>
  `;
}

export class CrabbyConnect extends HTMLElement {
  connectedCallback() {
    this.innerHTML = connectView();
    this.querySelector("#pair-form").addEventListener("submit", (event) => {
      event.preventDefault();
      void this.pair(this.querySelector("#pair-code").value.trim().toUpperCase());
    });
  }

  async pair(code) {
    const note = this.querySelector("#pair-note");
    note.textContent = "pairing…";
    try {
      const answer = await request("/auth/pair", { method: "POST", body: { code } });
      writeToken(answer.token);
      setState({ connection: "offline" });
      window.location.hash = "#/chat";
      window.location.reload();
    } catch (error) {
      note.textContent = `${error.message} — mint a fresh code and try again; codes do not retry`;
    }
  }
}

customElements.define("crabby-connect", CrabbyConnect);
