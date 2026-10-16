// <crabby-screen-sessions> — W15's list over `GET /sessions`, `POST /sessions`, `PATCH /sessions/:id` (rename, the
// same control the status bar's title uses — W15-04's one path, two entry points) and `DELETE /sessions/:id`, behind
// W15-07's typed confirm: the typed word is the session's **title**, not "yes", because deleting the wrong conversation
// is unrecoverable. Export (W15-08) downloads the same turns the messages route answers — one artifact, no second path.
import { request } from "../api.js";
import { getState, setState } from "../store.js";
import { sessionList } from "../ui/lists.js";

export class CrabbyScreenSessions extends HTMLElement {
  connectedCallback() {
    void this.load();
  }

  async load() {
    try {
      const body = await request("/sessions");
      this.sessions = body.items ?? [];
      const query = "";
      this.innerHTML = `
        <h2>sessions</h2>
        <input id="session-search" class="search" type="search" placeholder="filter by title (local, not a memory search)" value="${query}"/>
        <div id="list"></div>
      `;
      this.querySelector("#session-search").addEventListener("input", (event) =>
        this.draw(event.target.value),
      );
      this.draw("");
    } catch (error) {
      this.innerHTML = `<div class="err-panel"><p><strong>${error.code}</strong> — ${error.message}</p></div>`;
    }
  }

  draw(query) {
    const needle = query.toLowerCase();
    const shown = this.sessions.filter(
      (s) => needle.length === 0 || (s.titleShown ?? "").toLowerCase().includes(needle),
    );
    this.querySelector("#list").innerHTML = sessionList(shown, getState().sessionId).valueOf();
    this.querySelectorAll(".row-open").forEach((b) => {
      b.addEventListener("click", () => void this.switchTo(b.dataset.id));
    });
    this.querySelectorAll(".row-rename").forEach((b) => {
      b.addEventListener("click", () => void this.rename(b.dataset.id));
    });
    this.querySelectorAll(".row-delete").forEach((b) => {
      b.addEventListener("click", () => void this.destroy(b.dataset.id, b.dataset.title));
    });
  }

  /** W15-05/06: a switch follows the stream, and while a task runs the sentence says the task keeps going. */
  async switchTo(id) {
    const running = (await request("/tasks").catch(() => ({ items: [] }))).items?.some(
      (t) => t.state === "running" && t.sessionId === id,
    );
    if (
      running === true &&
      !window.confirm(
        "a task is still running in this conversation — it keeps running in the background; find it under Tasks. Switch anyway?",
      )
    ) {
      return;
    }
    const session = this.sessions.find((s) => s.id === id);
    setState({ sessionId: id, sessionTitle: session?.titleShown });
    window.location.hash = "#/chat";
  }

  async rename(id) {
    const session = this.sessions.find((s) => s.id === id);
    const title = window.prompt("rename session", session?.titleShown ?? "");
    if (title === null || title.length === 0) return;
    try {
      const detail = await request(`/sessions/${encodeURIComponent(id)}`);
      await request(`/sessions/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: { title },
        ifMatch: `"${String(detail.session.revision)}"`,
      });
      if (getState().sessionId === id) setState({ sessionTitle: title });
      await this.load();
    } catch (error) {
      window.alert(`${error.code}: ${error.message}`);
    }
  }

  async destroy(id, title) {
    // W15-07: type the title. "yes" is not the word — the word is the thing being lost.
    const typed = window.prompt(
      `delete "${title}"? type the title to confirm — this removes the conversation and is unrecoverable`,
    );
    if (typed !== title) {
      if (typed !== null) window.alert("the typed title did not match — nothing was deleted");
      return;
    }
    try {
      const detail = await request(`/sessions/${encodeURIComponent(id)}`);
      await request(`/sessions/${encodeURIComponent(id)}`, {
        method: "DELETE",
        ifMatch: `"${String(detail.session.revision)}"`,
      });
      await this.load();
    } catch (error) {
      window.alert(`${error.code}: ${error.message}`);
    }
  }
}

customElements.define("crabby-screen-sessions", CrabbyScreenSessions);
