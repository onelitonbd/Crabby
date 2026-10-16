// <crabby-screen-tasks> — W5's list (filter chips W5-01, cards W5-02, inline actions W5-03) and W6's detail over the
// routes that exist: `GET /tasks`, `GET /tasks/:id`, `GET /tasks/:id/checkpoint`, `GET /tasks/:id/events` for the
// honest slice of the run's story, cancel and resume through the same two routes the TUI and CLI use.
import { request } from "../api.js";
import { errorPanel } from "../ui/chat.js";
import { taskDetail, taskFilter, taskList } from "../ui/tasks.js";

export class CrabbyScreenTasks extends HTMLElement {
  connectedCallback() {
    this.filter = "all";
    this.detailId = this.dataset.rest || undefined;
    void this.load();
  }

  async load() {
    try {
      if (this.detailId !== undefined && this.detailId.length > 0) {
        await this.loadDetail(this.detailId);
        return;
      }
      const body = await request("/tasks");
      const all = body.items ?? [];
      const shown = this.filter === "all" ? all : all.filter((t) => t.state === this.filter);
      this.innerHTML = `
        <h2>tasks</h2>
        <div id="filter">${taskFilter(this.filter)}</div>
        <div id="list"></div>
      `;
      this.querySelector("#list").innerHTML = taskList(shown, this.filter).valueOf();
      this.querySelectorAll(".filter-chip").forEach((b) => {
        b.addEventListener("click", () => {
          this.filter = b.dataset.state;
          void this.load();
        });
      });
      this.querySelectorAll(".row-open").forEach((b) => {
        b.addEventListener("click", () => {
          window.location.hash = `#/tasks/${encodeURIComponent(b.dataset.id)}`;
        });
      });
      this.querySelectorAll(".task-cancel").forEach((b) => {
        b.addEventListener("click", () => void this.act(b.dataset.id, "cancel"));
      });
      this.querySelectorAll(".task-resume").forEach((b) => {
        b.addEventListener("click", () => void this.act(b.dataset.id, "resume"));
      });
    } catch (error) {
      this.innerHTML = errorPanel({ code: error.code, message: error.message }).valueOf();
    }
  }

  async loadDetail(id) {
    const [task, checkpoint, events] = await Promise.all([
      request(`/tasks/${encodeURIComponent(id)}`),
      request(`/tasks/${encodeURIComponent(id)}/checkpoint`).catch(() => undefined),
      request(`/tasks/${encodeURIComponent(id)}/events?limit=100`).catch(() => ({ items: [] })),
    ]);
    const record = task.task ?? task;
    const cp = checkpoint?.checkpoint;
    const summary =
      cp === undefined
        ? undefined
        : `saved at step ${String(cp.lastSeq ?? cp.seq ?? "?")} — a resume repeats nothing before it and the step it stopped in`;
    this.innerHTML = taskDetail(record, events.items ?? [], summary).valueOf();
    this.querySelectorAll(".task-cancel").forEach((b) => {
      b.addEventListener("click", () => void this.act(id, "cancel", true));
    });
    this.querySelectorAll(".task-resume").forEach((b) => {
      b.addEventListener("click", () => void this.act(id, "resume", true));
    });
  }

  async act(id, kind, reloadDetail = false) {
    try {
      await request(`/tasks/${encodeURIComponent(id)}/${kind}`, { method: "POST", body: {} });
      if (reloadDetail) await this.loadDetail(id);
      else await this.load();
    } catch (error) {
      // A 409 here is the conflict the approvals screen shows too: the act already happened elsewhere.
      this.insertAdjacentHTML(
        "afterbegin",
        errorPanel({
          code: error.code,
          message: error.message,
          requestId: error.requestId,
        }).valueOf(),
      );
    }
  }
}

customElements.define("crabby-screen-tasks", CrabbyScreenTasks);
