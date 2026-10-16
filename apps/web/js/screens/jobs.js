// <crabby-screen-jobs> — W16 over the seven job routes: list, pause/resume (W16-04), run-now (W16-05, still a fresh
// policy evaluation), backlog (W16-08) and the detail's next-run/last-outcome lines. Delete is W16-11 and has no
// route in this build, so the row says so and names what the CLI does — pause is the reversible act this build offers.
import { request } from "../api.js";
import { gapBlock } from "../ui/gaps.js";
import { jobList } from "../ui/lists.js";

export class CrabbyScreenJobs extends HTMLElement {
  connectedCallback() {
    void this.load();
  }

  async load() {
    try {
      const body = await request("/jobs");
      this.jobs = body.items ?? [];
      this.innerHTML = `
        <h2>scheduled jobs</h2>
        <div id="list"></div>
        <h3>delete</h3>
        ${gapBlock("jobDelete")}
      `;
      this.querySelector("#list").innerHTML = jobList(this.jobs).valueOf();
      this.querySelectorAll(".row-open").forEach((b) => {
        b.addEventListener("click", () => void this.detail(b.dataset.id));
      });
      this.querySelectorAll(".job-pause").forEach((b) => {
        b.addEventListener("click", () => void this.act(b.dataset.id, "pause"));
      });
      this.querySelectorAll(".job-resume").forEach((b) => {
        b.addEventListener("click", () => void this.act(b.dataset.id, "resume"));
      });
      this.querySelectorAll(".job-run").forEach((b) => {
        b.addEventListener("click", () => {
          // W16-05: run-now executes once, outside the schedule, and says so before it does.
          if (
            window.confirm(
              "run this job once now? T2/T3 steps inside it still ask at run time — nothing is pre-approved.",
            )
          ) {
            void this.act(b.dataset.id, "run");
          }
        });
      });
    } catch (error) {
      this.innerHTML = `<div class="err-panel"><p><strong>${error.code}</strong> — ${error.message}</p></div>`;
    }
  }

  async act(id, verb) {
    try {
      await request(`/jobs/${encodeURIComponent(id)}/${verb}`, { method: "POST", body: {} });
      await this.load();
    } catch (error) {
      window.alert(`${error.code}: ${error.message}`);
    }
  }

  async detail(id) {
    try {
      const body = await request(`/jobs/${encodeURIComponent(id)}`);
      const job = body.job ?? body;
      const runs = body.recentRuns ?? body.runs ?? [];
      const runsHtml =
        Array.isArray(runs) && runs.length > 0
          ? `<ul class="runs">${runs.map((r) => `<li><a href="#/tasks/${r.taskId ?? r.task ?? ""}">${r.taskId ?? r.task ?? ""}</a> — ${r.outcome ?? r.state ?? "?"}</li>`).join("")}</ul>`
          : `<p class="row-meta">no runs recorded yet</p>`;
      window.alert(
        `${job.objective ?? job.name ?? id}\nschedule: ${job.schedule ?? "?"}\nstate: ${job.stateWord ?? "active"}\n${runsHtml.replace(/<[^>]+>/g, " ")}`,
      );
    } catch {
      void this.load();
    }
  }
}

customElements.define("crabby-screen-jobs", CrabbyScreenJobs);
