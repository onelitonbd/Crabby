// <crabby-shell> — W1's bar, W2's nav, the `<main>` outlet, and the three global surfaces (more sheet W1-11, help sheet
// W-O9, offline banner W-O7). The element renders chrome only: the router picks the screen, each screen fetches its own
// facts, and this element subscribes to the store so a chip never lies about a state it was told.
import { request } from "../api.js";
import { hashFor, parseHash } from "../router.js";
import { getState, setState, subscribe } from "../store.js";
import { helpSheet, moreSheet, nav, offlineBanner, statusBar } from "../ui/shell.js";

export class CrabbyShell extends HTMLElement {
  connectedCallback() {
    this.unsubscribe = subscribe(() => this.drawChrome());
    this.addEventListener("click", (event) => this.onClick(event));
    this.addEventListener("keydown", (event) => this.onKey(event));
    this.draw();
    this.connectStream();
    this.pollStatus();
  }

  disconnectedCallback() {
    this.unsubscribe?.();
    this.controller?.abort();
  }

  draw() {
    const route = parseHash(window.location.hash);
    this.innerHTML = `
      <header class="bar" id="bar"></header>
      <div id="banner"></div>
      <main class="outlet" id="outlet" tabindex="-1"></main>
      <nav class="nav" id="nav" aria-label="primary"></nav>
      <dialog id="more-dialog" class="dialog sheet"></dialog>
      <dialog id="help-dialog" class="dialog"></dialog>
      <dialog id="new-dialog" class="dialog">
        <form id="new-form" method="dialog">
          <h2>new task</h2>
          <textarea id="new-objective" rows="3" placeholder="what should it do?"></textarea>
          <menu><button value="cancel" type="button" id="new-cancel">cancel</button><button value="go" class="send" type="submit">start task</button></menu>
        </form>
      </dialog>
      <div id="toast" class="toast" role="status" hidden></div>
    `;
    this.drawChrome();
    this.mountRoute(route);
    this.querySelector("#help-dialog").innerHTML = helpSheet();
    this.querySelector("#more-dialog").innerHTML = moreSheet(getState());
  }

  drawChrome() {
    const route = parseHash(window.location.hash);
    const screen = route.rest.length > 0 && route.screen === "settings" ? "settings" : route.screen;
    this.querySelector("#bar").innerHTML = statusBar(getState());
    this.querySelector("#nav").innerHTML = nav(screen, { approvals: getState().approvals });
    this.querySelector("#banner").innerHTML =
      getState().connection === "offline" ? offlineBanner() : "";
  }

  mountRoute(route) {
    const outlet = this.querySelector("#outlet");
    outlet.innerHTML = "";
    const tag = {
      chat: "crabby-screen-chat",
      context: "crabby-screen-context",
      tasks: "crabby-screen-tasks",
      approvals: "crabby-screen-approvals",
      sessions: "crabby-screen-sessions",
      jobs: "crabby-screen-jobs",
      settings: "crabby-screen-settings",
    }[route.screen];
    if (route.unknown !== undefined) {
      // W-O8: an unknown route lands home **with a note**, no dead end — both halves of the row: the hash becomes
      // home, and the toast is what makes the redirect legible instead of looking like the link did nothing.
      this.toast(`"${route.unknown}" is not a page — you are on chat`);
      window.location.hash = hashFor("chat");
    }
    if (tag === undefined) {
      window.location.hash = hashFor("chat");
      return;
    }
    const el = document.createElement(tag);
    el.dataset.rest = route.rest.join("/");
    outlet.append(el);
  }

  toast(text) {
    const el = this.querySelector("#toast");
    el.textContent = text;
    el.hidden = false;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      el.hidden = true;
    }, 4000);
  }

  onClick(event) {
    const t = event.target;
    if (t.id === "session-title") {
      const current = getState().sessionTitle ?? "";
      const title = window.prompt("session title", current);
      if (title !== null && title.length > 0) this.renameSession(title);
      return;
    }
    if (t.id === "nav-new") {
      this.querySelector("#new-dialog").showModal();
      return;
    }
    if (t.id === "new-cancel") {
      this.querySelector("#new-dialog").close();
      return;
    }
    // W1-10: tapping empty bar space does nothing — the more sheet opens only from its own button, which the bar appends.
    if (t.classList?.contains("bar-more")) {
      this.querySelector("#more-dialog").showModal();
      return;
    }
  }

  async renameSession(title) {
    const id = getState().sessionId;
    if (id === undefined) {
      this.toast("no session to rename yet — say something first");
      return;
    }
    try {
      const detail = await request(`/sessions/${encodeURIComponent(id)}`);
      await request(`/sessions/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: {},
        body: { title },
        // The token is quoted, as RFC 9110 asks an entity-tag be — the same shape sessionETag writes.
        ifMatch: `"${String(detail.session?.revision ?? "")}"`,
      });
      setState({ sessionTitle: title });
      this.toast("renamed");
    } catch (error) {
      this.toast(`rename failed: ${error.message}`);
    }
  }

  onKey(event) {
    // W2-04's `g`-prefixed jumps and `n`; `?` is W-O9. Desktop affordances — a phone never needs them.
    if (event.key === "?" && !event.target.closest("textarea, input")) {
      event.preventDefault();
      this.querySelector("#help-dialog").showModal();
      return;
    }
    if (event.key === "n" && !event.target.closest("textarea, input")) {
      this.querySelector("#new-dialog").showModal();
      return;
    }
    if (event.key === "g") {
      this.gPressed = true;
      window.setTimeout(() => {
        this.gPressed = false;
      }, 900);
      return;
    }
    if (this.gPressed === true && "ctjes".includes(event.key)) {
      this.gPressed = false;
      const map = { c: "chat", t: "tasks", j: "jobs", e: "settings/extensions", s: "settings" };
      window.location.hash = hashFor(map[event.key]);
    }
  }

  /** The one stream (§7.3): connection word for the chip, approval count for the badge, and the reconnection policy —
   *  one retry, the TUI's own; a phone that lost its network should not hammer a loopback address. */
  connectStream(retried = false) {
    this.controller?.abort();
    this.controller = new AbortController();
    import("../api.js").then(({ followEvents }) => {
      void followEvents({
        signal: this.controller.signal,
        onOpen: () => setState({ connection: "live", lastConfirmed: new Date().toISOString() }),
        onFrame: (frame) => this.onFrame(frame),
        onClose: (reason) => {
          setState({ connection: "reconnecting", lastConfirmed: new Date().toISOString() });
          this.toast(`stream: ${reason}`);
          if (!retried) {
            window.setTimeout(() => this.connectStream(true), 2000);
          } else {
            setState({ connection: "offline" });
          }
        },
      });
    });
  }

  onFrame(frame) {
    if (frame.type === "approval.requested") {
      setState({ approvals: getState().approvals + 1 });
      this.toast("a run needs your approval");
    }
    if (
      frame.type === "task.completed" ||
      frame.type === "task.failed" ||
      frame.type === "task.cancelled"
    ) {
      void this.refreshCounts();
      window.dispatchEvent(new CustomEvent("crabby:frame", { detail: frame }));
    }
    if (
      frame.type === "message.added" ||
      frame.type === "tool.started" ||
      frame.type === "tool.finished"
    ) {
      window.dispatchEvent(new CustomEvent("crabby:frame", { detail: frame }));
    }
  }

  async refreshCounts() {
    try {
      const approvals = await request("/approvals");
      setState({ approvals: (approvals.items ?? []).length });
    } catch {
      // The chip keeps its last honest count; a failed poll is not a fact about approvals.
    }
  }

  /** W1-04's `last confirmed` and the version (W1-09) come from the one status read, on a slow poll — the stream is
   *  the live half, this is the correction half. */
  async pollStatus() {
    try {
      const body = await request("/diagnostics");
      setState({
        version: body.version,
        connection: "live",
        lastConfirmed: new Date().toISOString(),
      });
    } catch {
      // Offline is the stream's word to say; this poll stays silent on failure.
    }
  }
}

customElements.define("crabby-shell", CrabbyShell);
