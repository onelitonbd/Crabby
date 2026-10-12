// `crabby job ls|show|pause|resume|run-now|backlog` — D-057's "first-class surface" in a terminal, over the same six
// routes a phone's Scheduled screen reads (`docs/INTERFACES_AND_API.md` §4.3, `docs/review/CLI.md` region C12). Every
// verb is HTTP and none of them opens SQLite, because §19's rule is that an interface may request, display and relay: a
// second reader of the job table would be a second opinion about what a paused job's next fire means.
//
// Two verbs the noun does not have, and both absences are decisions rather than gaps. There is no `job create`
// (C12-09): scheduling is created from a task by `cron.schedule`, a T2 call the user approved, and a second creation
// path with different approval semantics is how a schedule escapes review. And `job edit` stays planned, because C12-05
// documents it as editing "schedule, objective, model, recipients" — the material half — and §4.5 prices a material
// change as re-approval, which no route in this build can open (D-084). The non-material half (a name, a schedule) does
// have a route, `PATCH /api/v1/jobs/{id}`, and the Web's W16-06 uses it; a CLI verb arrives when an edit can carry a
// re-approval with it rather than implying one happened.
//
// `run-now` is the one verb here that blocks, and it blocks by *sharing* `task run`'s follow rather than owning a second
// SSE parser: C12-04's contract is that the command exits `3` when a run stops at an approval nobody answers, and that
// is §7.1's rule about a run rather than a rule about jobs — so it is implemented once, in `commands/task.ts`, and read
// off the task this verb created.
import {
  EXIT,
  type ExitCode,
  isJobState,
  JOB_STATES,
  type JobActionBody,
  type JobDetailBody,
  type JobListBody,
} from "@crabby/api-contracts";
import type { DataLayout } from "@crabby/platform";
import { parseTail } from "../args.ts";
import { connect, reportFailure, reportNoGateway } from "../connect.ts";
import { clip, type Renderer, shortId } from "../output.ts";
import { findCommand } from "../registry.ts";
import { followTask } from "./task.ts";

export type JobVerb = "ls" | "show" | "pause" | "resume" | "run-now" | "backlog";

/** How many of a job's runs `show` prints. C12-02's budget is fifteen lines for the whole command and the fields it
 *  names — identity, the capability set it holds, the last runs — come to eleven, so four is what is left. The route
 *  answers more than that (its own bounded history) and `--json` carries all of it, so the cap is a screen and not a
 *  limit on what a user can ask for. */
const SHOW_RUNS = 4;

export async function runJob(
  verb: JobVerb | undefined,
  argv: readonly string[],
  layout: DataLayout,
  renderer: Renderer,
): Promise<ExitCode> {
  const spec = findCommand("job", verb);
  const tail = parseTail(argv, spec);
  if (tail.unknown.length > 0) {
    renderer.line("unknown flag(s)", tail.unknown.join(" "));
    renderer.fix(`${(spec?.flags ?? []).join(" ")} are what this verb accepts`);
    return EXIT.usage;
  }
  // Answered before the Gateway is asked about, for the reason `task.ts` answers its own usage questions first: §7.1's
  // exit codes are about the command, not about the process it would have talked to, and "which job?" arriving as a
  // connection failure is the difference between a fixed command and a mystery on a machine whose Gateway is down.
  const id = verb === "ls" || verb === undefined ? undefined : tail.positionals[0];
  if (verb !== undefined && verb !== "ls" && id === undefined) {
    renderer.line(`job ${verb}`, "which job? `crabby job ls` prints the ids");
    renderer.fix(
      "a job is created by `cron.schedule` inside a task, not by a verb here — that absence is C12-09's decision",
    );
    return EXIT.usage;
  }
  const state = verb === "ls" ? tail.values.state : undefined;
  if (state !== undefined && !isJobState(state)) {
    // Refused here rather than passed through, unlike `approval ls --state`: a job's state has two values and a typo
    // would be answered by the Gateway with a `400` naming them anyway, so the only difference is which process prints
    // the sentence — and this one can print the fix beside it.
    renderer.line("bad --state", `"${state}" is not a job state`);
    renderer.fix(`${JOB_STATES.join(" | ")} — leaving the flag off lists both`);
    return EXIT.usage;
  }
  // C12-06 asks once (latest / each / skip) and records the answer. In a terminal that can prompt, the asking is the
  // command's; here the flag *is* the asking, and there is deliberately no default, because one of the two answers
  // fires work and §4.5's sixth rule is that a backlog must not run without the user being told. `each` is not offered:
  // firing every missed occurrence is the burst the rule exists to prevent, and a user who wants N runs can ask for one
  // and then N-1 with `job run-now`, which is a person deciding each time.
  const action =
    verb === "backlog"
      ? tail.booleans.has("--latest") && !tail.booleans.has("--skip")
        ? "latest"
        : tail.booleans.has("--skip") && !tail.booleans.has("--latest")
          ? "skip"
          : undefined
      : undefined;
  if (verb === "backlog" && action === undefined) {
    renderer.line(
      "job backlog",
      tail.booleans.has("--latest") && tail.booleans.has("--skip")
        ? "`--latest` and `--skip` are two different answers and cannot both be the one you meant"
        : "which answer? one of `--latest` or `--skip` is required",
    );
    renderer.fix(
      "`--latest` fires one run for the most recent missed occurrence and acknowledges the rest; `--skip` acknowledges " +
        "them and fires nothing. Either way the answer is recorded (§4.5, C12-06)",
    );
    return EXIT.usage;
  }

  const connection = await connect(layout);
  if (connection.state !== "paired") return reportNoGateway(renderer, connection.state);
  const client = connection.client;

  try {
    if (verb === "ls") {
      const body = (await client.jobs({ ...(state === undefined ? {} : { state }) }))
        .body as JobListBody;
      if (renderer.json) return renderer.done({ ...body });
      // `--quiet` is ids and nothing else, one per line, for the reason §10's scripting contract gives: a shell that
      // meant to pipe them into `xargs crabby job pause` must not have to cut a label column out of every line first.
      if (tail.booleans.has("--quiet")) {
        for (const job of body.items) renderer.raw(job.id);
        return EXIT.success;
      }
      if (body.items.length === 0) {
        renderer.line(
          "jobs",
          `none${state === undefined ? "" : ` in state '${state}'`} — a job is created by the ` +
            "`cron.schedule` tool inside a task, which is a T2 call you approve (D-046)",
        );
        renderer.fix(
          '`crabby task run "check the inbox every morning at seven and summarise what needs an answer"` is how one ' +
            "gets asked for; there is no `crabby job create` (C12-09)",
        );
        return EXIT.success;
      }
      // C12-01's five fields on one line each, with the state word in the label column so a list greps by state without
      // a second tool: `crabby job ls | grep waiting-approval` is the sentence W16-02 says must never be hard to run.
      for (const job of body.items)
        renderer.line(
          job.stateWord,
          `${clip(job.name, 24)}  ${job.schedule}  next ${job.nextRunLocal ?? "—"}  ` +
            `last ${job.lastOutcome ?? "never"}  ${shortId(job.id)}`,
        );
      if (body.missedUnacknowledged > 0)
        renderer.fix(
          `${body.missedUnacknowledged} missed occurrence(s) nobody has answered for: ` +
            "`crabby job backlog <id> --latest` or `--skip` (§4.5)",
        );
      if (!body.driven) renderer.fix(body.note ?? "this Gateway is not driving these jobs");
      return EXIT.success;
    }

    if (verb === "show" && id !== undefined) {
      const body = (await client.job(id)).body as JobDetailBody;
      if (renderer.json) return renderer.done({ ...body });
      const { job } = body;
      // C12-02, in the order its own sentence gives: what was authorised, who authorised it, and what it has been doing.
      renderer.line("job", `${job.name} (${job.id})`);
      renderer.line("state", job.stateWord);
      renderer.line(
        "schedule",
        `${job.schedule}  (evaluated against this device's wall clock, recorded at ` +
          `${offsetLabel(job.utcOffsetMinutes)} — D-103)`,
      );
      renderer.line(
        "next run",
        job.nextRunLocal === undefined
          ? job.state === "paused"
            ? "none — paused, and `crabby job resume` re-evaluates the grants before it projects one"
            : "none recorded"
          : `${job.nextRunLocal}  (${job.nextRunAt})`,
      );
      renderer.line("objective", clip(job.objective, 60));
      renderer.line(
        "runs as",
        `${job.createdBy.name} via ${job.createdBy.interface} (${shortId(job.createdBy.clientId)})` +
          " — every run is a fresh policy evaluation under that identity, and it inherits no authority from being a " +
          "timer (§4.5)",
      );
      renderer.line(
        "capabilities",
        job.capabilities.length === 0
          ? "none recorded — a run holding nothing is refused at its first gated step rather than run unattended"
          : job.capabilities.join(", "),
      );
      renderer.line("created", `${job.createdAt} (session ${shortId(job.sessionId)})`);
      if (body.missedUnacknowledged.length > 0) {
        renderer.line(
          "missed",
          `${body.missedUnacknowledged.length} row(s), ` +
            `${body.missedUnacknowledged.reduce((total, run) => total + run.occurrences, 0)} ` +
            "occurrence(s) that passed while nothing was watching",
        );
        renderer.fix(
          "`crabby job backlog <id> --latest` fires the most recent and acknowledges the rest; `--skip` fires nothing",
        );
      }
      const runs = body.runs.slice(0, SHOW_RUNS);
      renderer.line("last runs", runs.length === 0 ? "none yet" : "");
      for (const run of runs)
        renderer.line(
          `  ${run.trigger}`,
          `${run.dueAt} → ${run.outcome}` +
            `${run.occurrences > 1 ? ` (${run.occurrences} occurrences in one row)` : ""}` +
            `${run.taskId === undefined ? "" : ` task ${shortId(run.taskId)}`}` +
            `${run.reason === undefined ? "" : ` — ${clip(run.reason, 48)}`}`,
        );
      if (!body.driven) renderer.fix(body.note ?? "this Gateway is not driving these jobs");
      return EXIT.success;
    }

    if ((verb === "pause" || verb === "resume") && id !== undefined) {
      const body = (verb === "pause" ? await client.pauseJob(id) : await client.resumeJob(id))
        .body as JobActionBody;
      if (renderer.json) return renderer.done({ ...body });
      // C12-03: one id, one line, and the line is the scheduler's own sentence rather than a paraphrase — it is the party
      // that knows a pause lands before the next tick and that a resume re-evaluated the grants (D-054).
      renderer.line(verb, body.note);
      if (body.openRunTaskId !== undefined)
        renderer.fix(
          `a run was already in flight and keeps going: \`crabby task cancel ${body.openRunTaskId}\` stops it (§4.5)`,
        );
      if (verb === "resume")
        renderer.fix(
          "the job now runs with the capabilities that identity holds *today*, narrowed by the ones the job recorded — " +
            "a revocation is not undone by a resume",
        );
      return EXIT.success;
    }

    if (verb === "run-now" && id !== undefined) {
      const body = (await client.runJob(id)).body as JobActionBody;
      // C12-04's two lines are this one and the outcome the follow prints. The sentence says what the run *is* — a fresh
      // evaluation, not a replay — because that is the fact a user is relying on when they press it: a T2 step inside the
      // run asks again, and if nobody answers, the command exits `3` instead of proceeding unattended.
      renderer.line(
        "run-now",
        `${jobLabel(body)} → task ${body.taskId ?? "?"} — a fresh policy evaluation, not a replay of the last run (§4.5)`,
      );
      if (body.taskId === undefined) {
        // Unreachable while the route answers `201` only with a task beside the run, and answered rather than asserted
        // because the body's shape says the field is optional: a verb that printed "task undefined" and exited `0` would
        // be claiming a run it cannot point at.
        renderer.line("run-now", body.note);
        return renderer.fail({
          code: "job.run_without_task",
          message:
            "the Gateway recorded a run and named no task for it, so there is nothing to follow",
        });
      }
      if (tail.booleans.has("--detach"))
        // One document and not two, for the reason `task run --detach` gives: `done()` renders the whole answer, and a
        // stdout holding a compact record beside an indented summary is a stdout no script can parse either way.
        return renderer.done({ ...body, following: false });
      if (renderer.json) renderer.raw(JSON.stringify(body));
      return followTask({
        url: connection.url,
        client,
        layout,
        renderer,
        taskId: body.taskId,
        stopAtApproval: true,
        exitOnOutcome: true,
      });
    }

    if (verb === "backlog" && id !== undefined && action !== undefined) {
      const body = (await client.jobBacklog(id, { action })).body as JobActionBody;
      if (renderer.json) return renderer.done({ ...body });
      // C12-06's three lines: what was missed, what the answer did, and that the answer is on the record. Not followed,
      // and deliberately: the user asked about a backlog rather than for a run, and `--latest` creating one is a
      // consequence they should be handed a command for rather than blocked inside (§7.1's exit `3` is for the verb that
      // *is* the run).
      renderer.line(
        "backlog",
        `${action}: ${body.acknowledged ?? 0} missed occurrence(s) acknowledged` +
          `${body.taskId === undefined ? ", nothing fired" : `, one run created as task ${body.taskId}`}`,
      );
      renderer.line("recorded", body.note);
      if (body.taskId !== undefined)
        renderer.fix(`crabby task watch ${body.taskId} — the run this answer created`);
      return EXIT.success;
    }
  } catch (error) {
    return reportFailure(renderer, error);
  }

  renderer.line("job", "which verb? `ls`, `show`, `pause`, `resume`, `run-now` or `backlog`");
  renderer.fix(
    "`crabby job edit` is planned, not missing: C12-05's edit is the material half §4.5 re-approves",
  );
  return EXIT.usage;
}

/** The label a run is reported under: the job's name when the body carries it, and the run's own id when it does not. A
 *  line that said only "run-now → task …" would leave the user to work out which of their jobs they just fired. */
function jobLabel(body: JobActionBody): string {
  return `${body.job.name} (${shortId(body.job.id)})${
    body.run === undefined ? "" : ` run ${shortId(body.run.id)}`
  }`;
}

/** The recorded UTC offset as a label, because D-103's rule is that a schedule is evaluated against the device's wall
 *  clock and the offset that was true at creation is part of the record: `+06:00` beside `0 7 * * *` is what tells a user
 *  that seven means seven *here*, and a job created before a timezone change says so rather than silently meaning
 *  something else. */
function offsetLabel(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const absolute = Math.abs(minutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const rest = String(absolute % 60).padStart(2, "0");
  return `UTC${sign}${hours}:${rest}`;
}
