// <crabby-screen-chat> and <crabby-screen-context>. The chat screen is W3+W4 over the routes that exist: turns from
// `GET /sessions/:id/messages`, a send that is **a chat message** (`POST /sessions/:id/messages`) or **a task**
// (`POST /tasks`) on the W4-05 toggle, streaming frames from the shell's one stream re-drawn here via the
// `crabby:frame` event, and the slash commands (W4-03) acting through the same routes the CLI's verbs use.
//
// `/attach` is T5-04's path-as-text shape: this build's API has no upload field, so the path rides the message marked
// for what it is, and the run's own file tools (already §8-checked) read it.
import { request } from "../api.js";
import { hashFor } from "../router.js";
import { html } from "../safe.js";
import { getState, setState } from "../store.js";
import { composer, errorPanel, messageRows, slashMatches, toolRow } from "../ui/chat.js";
import { contextView, overflowNote } from "../ui/context.js";

const ATTACH_RE = /^\/attach\s+(\S+)$/;

export class CrabbyScreenChat extends HTMLElement {
  connectedCallback() {
    this.sessionId = getState().sessionId;
    this.draft = "";
    this.attach = [];
    this.streaming = [];
    this.render();
    if (this.sessionId !== undefined) void this.load();
    else void this.ensureSession();
  }

  async ensureSession() {
    try {
      const list = await request("/sessions");
      const first = (list.items ?? [])[0];
      if (first !== undefined) {
        setState({ sessionId: first.id, sessionTitle: first.titleShown });
        this.sessionId = first.id;
        await this.load();
        return;
      }
      const created = await request("/sessions", { method: "POST", body: {} });
      setState({ sessionId: created.session.id, sessionTitle: created.session.titleShown });
      this.sessionId = created.session.id;
      this.render();
    } catch (error) {
      this.querySelector("#chat-err").innerHTML = errorPanel({
        code: error.code,
        message: error.message,
      });
    }
  }

  render() {
    this.innerHTML = `
      <div id="chat-err"></div>
      <div class="msgs" id="msgs"></div>
      <div class="composer-holder" id="composer"></div>
    `;
    this.drawComposer();
  }

  async load() {
    if (this.sessionId === undefined) return;
    try {
      const page = await request(
        `/sessions/${encodeURIComponent(this.sessionId)}/messages?limit=50`,
      );
      this.messages = (page.items ?? []).map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        taskId: m.taskId,
        when: relative(m.createdAt),
      }));
      this.render();
    } catch (error) {
      this.querySelector("#chat-err").innerHTML = errorPanel({
        code: error.code,
        message: error.message,
      });
    }
  }

  draw() {
    const live =
      this.streaming.length > 0
        ? `<div class="msg msg-assistant streaming"><div class="msg-body">${escapeText(this.streaming.join(""))}<span class="cursor" aria-hidden="true">▮</span></div></div>`
        : "";
    const tools = (this.liveTools ?? []).map((c) => toolRow(c)).join("");
    this.querySelector("#msgs").innerHTML =
      messageRows(this.messages ?? []).valueOf() + tools + live;
    this.querySelector("#msgs").scrollTop = this.querySelector("#msgs").scrollHeight;
    // W4-08: the composer's stop/send swap tracks the run — but only re-renders when the state flips, so typing
    // is never interrupted by a frame.
    if (this.isRunning() !== this.composerRunning) this.drawComposer();
  }

  isRunning() {
    return (
      (this.streaming?.length ?? 0) > 0 ||
      (this.liveTools ?? []).some((c) => c.status === "running")
    );
  }

  drawComposer() {
    const running = this.isRunning();
    this.composerRunning = running;
    this.querySelector("#composer").innerHTML = composer({
      draftChars: this.draft.length,
      queued: 0,
      running,
      taskMode: this.taskMode === true,
    });
    const input = this.querySelector("#compose");
    if (input !== null && this.draft.length > 0) input.value = this.draft;
    this.wire();
  }

  wire() {
    const input = this.querySelector("#compose");
    input.addEventListener("input", () => {
      this.draft = input.value;
      const menu = this.querySelector("#slash-menu");
      const matches = slashMatches(this.draft);
      if (matches.length > 0 && !this.draft.includes(" ")) {
        menu.hidden = false;
        menu.innerHTML = matches
          .map(
            (m) =>
              `<button class="slash-row" type="button" data-c="${m.command}">${m.command} <span class="row-meta">${m.about}</span></button>`,
          )
          .join("");
      } else {
        menu.hidden = true;
      }
      this.querySelector(".send")?.blur();
      const fact = this.querySelector(".draft-fact");
      if (fact !== null)
        fact.textContent =
          this.draft.length > 0
            ? `draft ≈ ${String(Math.max(1, Math.ceil(this.draft.length / 4)))} tokens (estimate, not a count)`
            : "";
    });
    input.addEventListener("keydown", (event) => {
      // W4-01: Enter sends, Shift+Enter newlines on desktop; W4-10: not while an IME composition is open.
      if (event.key === "Enter" && !event.shiftKey && event.isComposing !== true) {
        event.preventDefault();
        void this.send();
      }
    });
    this.querySelector("#slash-menu").addEventListener("click", (event) => {
      const command = event.target.dataset?.c;
      if (command === undefined) return;
      input.value = `${command} `;
      input.focus();
      this.querySelector("#slash-menu").hidden = true;
    });
    this.querySelector("#as-task").addEventListener("change", (event) => {
      this.taskMode = event.target.checked;
    });
    this.querySelector(".send")?.addEventListener("click", () => void this.send());
    // W4-08: stop interrupts the run in flight — it cancels the running task and says so; it never sends.
    this.querySelector("#send-stop")?.addEventListener("click", () => void this.stopRun());
    this.onFrame = (event) => this.applyFrame(event.detail);
    window.addEventListener("crabby:frame", this.onFrame);
  }

  async stopRun() {
    try {
      const tasks = await request("/tasks").catch(() => undefined);
      const running = (tasks?.items ?? []).find(
        (t) => t.state === "running" || t.state === "awaiting_approval",
      );
      if (running === undefined) {
        this.querySelector("#chat-err").textContent = "";
        return;
      }
      await request(`/tasks/${encodeURIComponent(running.id)}/cancel`, {
        method: "POST",
        body: {},
      });
      const banner = document.createElement("div");
      banner.className = "banner banner-warn";
      banner.textContent = `stop asked — the current step finishes, the task ${running.id} does not continue`;
      this.querySelector("#chat-err").replaceChildren(banner);
    } catch (error) {
      const banner = document.createElement("div");
      banner.className = "banner banner-warn";
      banner.textContent = `stop failed: ${error.message}`;
      this.querySelector("#chat-err").replaceChildren(banner);
    }
  }

  disconnectedCallback() {
    window.removeEventListener("crabby:frame", this.onFrame);
  }

  applyFrame(frame) {
    if (this.sessionId === undefined || frame.sessionId !== this.sessionId) return;
    if (frame.type === "tool.started" || frame.type === "tool.finished") {
      this.liveTools = [
        ...(this.liveTools ?? []).filter(
          (c) => !(c.name === (frame.tool ?? frame.name) && frame.type === "tool.started"),
        ),
        {
          name: frame.tool ?? frame.name ?? "tool",
          tier: frame.tier ?? "T0",
          status: frame.type === "tool.started" ? "running" : (frame.outcome ?? "finished"),
          detail: JSON.stringify(frame.args ?? frame.result ?? {}, null, 1),
        },
      ];
    }
    if (frame.type === "message.added") {
      this.streaming = [...this.streaming, frame.content ?? ""];
    }
    if (
      frame.type === "task.completed" ||
      frame.type === "task.failed" ||
      frame.type === "task.cancelled"
    ) {
      this.streaming = [];
      this.liveTools = [];
      void this.load();
      return;
    }
    this.draw();
  }

  async send() {
    const input = this.querySelector("#compose");
    let text = input.value.trim();
    if (text.length === 0) return;
    // A note's plain text is *data* (textContent); only the template's own markup passes as markup.
    const note = (content) => {
      const banner = document.createElement("div");
      banner.className = "banner banner-warn";
      if (typeof content === "string") banner.textContent = content;
      else banner.innerHTML = content.valueOf();
      this.querySelector("#chat-err").replaceChildren(banner);
    };
    // The slash commands, each through the same route the CLI verb uses — a command that did nothing would be a lie.
    if (text === "/cancel") {
      const tasks = await request("/tasks").catch(() => undefined);
      const running = (tasks?.items ?? []).find(
        (t) => t.state === "running" || t.state === "awaiting_approval",
      );
      if (running === undefined) return note("nothing is running");
      await request(`/tasks/${encodeURIComponent(running.id)}/cancel`, {
        method: "POST",
        body: {},
      }).catch((e) => note(e.message));
      input.value = "";
      return;
    }
    if (text === "/compact") {
      if (this.sessionId === undefined) return note("no conversation to compact");
      await request(`/sessions/${encodeURIComponent(this.sessionId)}/compact`, {
        method: "POST",
        body: {},
      }).catch((e) => note(e.message));
      input.value = "";
      return note("compaction asked for — the preview shows on the context screen");
    }
    if (text === "/task") {
      this.taskMode = true;
      this.querySelector("#as-task").checked = true;
      input.value = "";
      return note("the next send starts a task (POST /tasks)");
    }
    const attach = ATTACH_RE.exec(text);
    if (attach !== null) {
      this.attach = [...this.attach, attach[1]];
      input.value = "";
      return note(`attached ${attach[1]} — it rides the next send as text`);
    }
    if (text.startsWith("/model")) {
      window.location.hash = hashFor("settings", ["models"]);
      return;
    }
    if (text.startsWith("/pin")) {
      window.location.hash = `#/context`;
      return;
    }
    if (this.attach.length > 0) {
      text = `${text}\n[attached files: ${this.attach.join(", ")}]`;
      this.attach = [];
    }
    input.value = "";
    try {
      if (this.taskMode === true) {
        this.taskMode = false;
        this.querySelector("#as-task").checked = false;
        const created = await request("/tasks", {
          method: "POST",
          body: {
            objective: text,
            ...(this.sessionId === undefined ? {} : { sessionId: this.sessionId }),
          },
        });
        note(
          html`started task ${created.id} — <a href="${hashFor("tasks", [created.id])}">open it</a>`,
        );
      } else {
        await request(`/sessions/${encodeURIComponent(this.sessionId)}/messages`, {
          method: "POST",
          body: { content: text },
        });
        await this.load();
      }
    } catch (error) {
      note(`${error.code}: ${error.message}`);
    }
  }
}

function escapeText(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function relative(iso) {
  if (iso === undefined) return "";
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${String(Math.round(seconds / 60))}m ago`;
  if (seconds < 86400) return `${String(Math.round(seconds / 3600))}h ago`;
  return `${String(Math.round(seconds / 86400))}d ago`;
}

/** <crabby-screen-context> — W7's drawer as its own screen (the routes are per-session, the drawer follows the
 *  session the chat is in). */
export class CrabbyScreenContext extends HTMLElement {
  connectedCallback() {
    void this.load();
  }

  async load() {
    const id = getState().sessionId;
    if (id === undefined) {
      this.innerHTML = `<div class="empty"><p>no conversation yet</p><p>say something in chat first</p></div>`;
      return;
    }
    try {
      const body = await request(`/sessions/${encodeURIComponent(id)}/context`);
      this.innerHTML = `${contextView(body).valueOf()}${overflowNote(body, 0).valueOf()}`;
      this.querySelector("#ctx-compact")?.addEventListener("click", () => {
        // W7-07 with a confirm, because D-027's "never implies the original is gone" still deserves a question first.
        if (
          window.confirm(
            "compact now? the summary stands in for older turns; the original records stay",
          )
        ) {
          void request(`/sessions/${encodeURIComponent(id)}/compact`, {
            method: "POST",
            body: {},
          }).then(() => this.load());
        }
      });
    } catch (error) {
      this.innerHTML = errorPanel({ code: error.code, message: error.message }).valueOf();
    }
  }
}

customElements.define("crabby-screen-chat", CrabbyScreenChat);
