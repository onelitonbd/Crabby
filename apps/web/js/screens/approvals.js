// <crabby-screen-approvals> — W-A's queue over `GET /approvals` and `POST /approvals/:id/decision`, the same two calls
// the TUI's modal answers through. The stale-answer conflict (A10) is the 409 this route answers a second decision
// with; the history tab (A9) needs an audit listing that has no route yet, so it is named where it would have been.
import { request } from "../api.js";
import { approvalQueue } from "../ui/approvals.js";
import { gapBlock } from "../ui/gaps.js";

export class CrabbyScreenApprovals extends HTMLElement {
  connectedCallback() {
    void this.load();
  }

  async load() {
    try {
      const body = await request("/approvals");
      this.items = body.items ?? [];
      this.innerHTML = `
        <h2>approvals</h2>
        <div id="queue"></div>
        <h3>history</h3>
        <div id="history">${gapBlock("logs")}</div>
      `;
      this.querySelector("#queue").innerHTML = approvalQueue(
        this.items,
        this.conflict === true,
      ).valueOf();
      this.querySelectorAll(".approve").forEach((b) => {
        b.addEventListener("click", () => void this.decide(b.dataset.id, "approve"));
      });
      this.querySelectorAll(".deny").forEach((b) => {
        b.addEventListener("click", () => {
          const reason = this.querySelector(`#reason-${CSS.escape(b.dataset.id)}`)?.value ?? "";
          void this.decide(b.dataset.id, "deny", reason.length > 0 ? reason : undefined);
        });
      });
      this.querySelectorAll(".why").forEach((b) => {
        b.addEventListener("click", () => {
          // A12: the rule and the tier that produced the prompt — the tools screen is where those live.
          const note = this.querySelector(`#why-${CSS.escape(b.dataset.id)}`);
          if (note !== null) note.hidden = false;
        });
      });
    } catch (error) {
      this.innerHTML = `<div class="err-panel"><p><strong>${error.code}</strong> — ${error.message}</p></div>`;
    }
  }

  async decide(id, decision, reason) {
    try {
      await request(`/approvals/${encodeURIComponent(id)}/decision`, {
        method: "POST",
        body: { decision, scope: "once", ...(reason === undefined ? {} : { reason }) },
      });
      this.conflict = false;
    } catch (error) {
      // A10: the first answer wins; this client's answer arrived second and the route refused it.
      if (error.status === 409) this.conflict = true;
    }
    await this.load();
  }
}

customElements.define("crabby-screen-approvals", CrabbyScreenApprovals);
