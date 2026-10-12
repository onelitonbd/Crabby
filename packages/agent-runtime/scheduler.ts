// The scheduler: the party that turns "a job exists" into "a task was created because the schedule said so", and the
// only party that knows which occurrences of a schedule passed while nothing was watching. `docs/ROADMAP.md` §4 lists it
// as M2's deliverable and `PROVIDERS_AND_TOOLS.md` §4.5 as the strictest scheduling policy in the project, so the rules
// this file exists to keep are quoted where they are kept:
//
//   - **"Every execution of a scheduled job is a fresh policy evaluation."** Kept structurally rather than by a promise:
//     a fire creates a *task* and hands it to the same runner a `POST /tasks` reaches, so the loop that evaluates each
//     step is the loop every other task gets. This file holds no tier, no grant and no approval of its own, and cannot
//     pre-buy one, because it has no way to ask for one — the arbiter is opened by the loop (D-084).
//   - **"A job inherits no ambient authority from the user who created it beyond its own recorded capability set, and it
//     runs under the identity that created it, so audit records name a person rather than 'cron'."** The recorded set is
//     re-intersected with the identity's *current* capabilities at every fire, so it narrows as an identity is narrowed
//     and can never widen (D-054's rule applied to a timer), and an identity that was revoked leaves the job unable to
//     name a person — which pauses it with the reason on the record rather than firing it under nobody.
//   - **"If a scheduled run cannot obtain approval within its window, it stops and records 'waiting on approval'; it must
//     not proceed unattended."** A run whose task reaches `awaiting_approval` is recorded in exactly those words and
//     stays open, which also keeps the job from firing another run beside a prompt that is waiting for a human.
//   - **"A device killed overnight … must not fire a burst of backlogged runs on resume without telling the user."** The
//     occurrences that passed while the process was down are *counted*, written as one `missed` row, added to the job's
//     `missed` counter, and logged at startup — and none of them is fired. What happens to them afterwards is the user's
//     answer to `crabby job backlog` (C12-06): run the latest, or skip them, with the answer recorded.
//
// It lands in this package rather than in the Gateway for the reason the package index gives — "a rule the Gateway owns
// is a rule only the Gateway can follow" (D-003) — and one run at a time per job is exactly such a rule: four interfaces
// can each ask for a run-now, a tick can wake late, and a restart can find a schedule with a day of occurrences behind
// it, and all four have to be answered by something that is not a route.
//
// What this file does *not* do is write tasks. Like the runner beside it, it holds no database: `JobStore` is the seam
// `packages/storage/jobs.ts` implements (§19's direction), `fire` is the composition root's, and `taskStateOf` is a read
// of a fact the journal owns. The scheduler's own bookkeeping is one timer handle and nothing else, so a restart loses
// no in-memory truth — every fact a reader can ask about is a row.

import { randomBytes } from "node:crypto";
import type {
  ClientInterface,
  JobRecord,
  JobRunOutcome,
  JobRunRecord,
  JobRunTrigger,
  JobState,
  JobView,
  TaskState,
} from "@crabby/api-contracts";
import { isOpenRunOutcome } from "@crabby/api-contracts";
import type { Logger } from "@crabby/core";
import {
  type CronSchedule,
  localStamp,
  nextFire,
  type OccurrenceCount,
  occurrencesBetween,
  parseCron,
  utcOffsetMinutesOf,
} from "./cron.ts";

/** The persistence seam, in the shape `ApprovalStore` set: the runtime owns the abstraction, `packages/storage` owns the
 *  SQL, and neither imports the other's business. */
export interface JobStore {
  insert(job: JobRecord): void;
  get(id: string): JobRecord | undefined;
  /** Every job, ordered by creation. Unpaginated for the reason `ApprovalStore.all()` is: a phone holds a handful of
   *  timers, and a scheduler that had to page through its own jobs to find the next one due would be a party that cannot
   *  answer "what fires next" without a second query per job. */
  all(): readonly JobRecord[];
  /** One statement per fact. `JobPatch` has no `objective` and no `createdBy`, so no caller of this seam can rewrite what
   *  the user approved or who approved it — the same structural guarantee `packages/storage/approvals.ts` gives an
   *  answer, and the reason §4.5's "material change crosses into re-approval" is a property of the schema and not only
   *  of a route that refuses. */
  update(id: string, patch: JobPatch): JobRecord | undefined;
  insertRun(run: JobRunRecord): void;
  updateRun(id: string, patch: RunPatch): JobRunRecord | undefined;
  runsFor(jobId: string, limit: number): readonly JobRunRecord[];
  lastRun(jobId: string): JobRunRecord | undefined;
  /** Runs whose outcome is still open, across every job: the reconciliation a tick does before it decides what may fire,
   *  and the count a shutdown reports. */
  openRuns(): readonly JobRunRecord[];
  /** C12-06's subject: the `missed` rows nobody has answered for yet, oldest first. */
  unacknowledgedMissed(jobId: string): readonly JobRunRecord[];
  /** Records C12-06's answer — the rows keep their outcome and gain an `acknowledgedAt`, because D-065's rule that the
   *  system does not quietly edit its own past applies to a timer's history too — and returns the number of occurrences
   *  the answer covered, which is what zeroes the job's counter. */
  acknowledgeMissed(jobId: string, at: string): number;
}

export interface JobPatch {
  readonly name?: string;
  readonly schedule?: string;
  readonly state?: JobState;
  /** `null` clears it, and clearing is the point: a paused job has no next fire rather than a next fire it is ignoring. */
  readonly nextRunAt?: string | null;
  /** Narrows only. The store cannot enforce that and the scheduler does, at every fire and at every resume. */
  readonly capabilities?: readonly string[];
  readonly lastRunAt?: string;
  readonly missed?: number;
  readonly updatedAt: string;
}

export interface RunPatch {
  readonly outcome?: JobRunOutcome;
  readonly reason?: string;
  readonly taskId?: string;
  readonly settledAt?: string;
}

/** The person a job runs as, read at fire time rather than trusted from creation. `interface` is the four-name
 *  `ClientInterface` and not policy's wider `ClientKind`, because a job runs under the identity that created it (§4.5)
 *  and that identity was paired for one of the four — `agent` is a subject kind a run can have, and using it here would
 *  name "cron" in an audit record instead of a person, which is the substitution §4.5 forbids. The fire path hands it to
 *  `removedGrantsFor`, whose baseline is per interface, and to a `LoopSubject`, whose `clientKind` accepts it because the
 *  four are a subset of policy's six. */
export interface JobIdentity {
  readonly name: string;
  readonly interface: ClientInterface;
  readonly capabilities: readonly string[];
}

export interface FireRequest {
  readonly job: JobRecord;
  /** The instant this fire is for: the occurrence the schedule named, not the moment the tick happened to wake. A run
   *  recorded against the wrong instant is a history nobody can reconcile with the expression that produced it. */
  readonly at: number;
  /** §4.5's intersection, computed by this file at fire time: what the job recorded, narrowed by what the identity still
   *  holds. The composition root expands these into grants the way `POST /tasks` expands the ones an identity arrived
   *  with, because the install's half (roots, host sets) is a fact about the process and not about the job. */
  readonly capabilities: readonly string[];
  readonly trigger: JobRunTrigger;
}

export type FireResult =
  | { readonly ok: true; readonly taskId: string }
  | { readonly ok: false; readonly code: string; readonly reason: string };

export interface ScheduleInput {
  readonly name: string;
  readonly schedule: string;
  readonly objective: string;
  readonly sessionId: string;
  readonly createdBy: {
    readonly clientId: string;
    readonly name: string;
    readonly interface: ClientInterface;
  };
  readonly capabilities: readonly string[];
  readonly at?: number;
}

export type ScheduleResult =
  | { readonly ok: true; readonly job: JobRecord }
  | {
      readonly ok: false;
      /** `unavailable` is the one code this file never produces itself, and the reason it is in the union anyway: the
       *  composition root binds the tool's sink after the runner exists, so an executor composed without a scheduler has
       *  a refusal to give that is neither a bad expression nor a failed write. Naming it here rather than letting a
       *  caller widen the type on its own keeps one shape for every answer `cron.schedule` can give. */
      readonly code: "invalid_schedule" | "no_occurrence" | "unwritable" | "unavailable";
      readonly reason: string;
    };

/** What a pause, a resume, a run-now or a backlog answer produced. `note` carries the sentence the interface prints, and
 *  it is part of the result rather than a log line because C12-03 asks a command to *say* that a pause takes effect
 *  before the next tick — a fact only this file knows. */
/** The refusals a job verb can answer with. Named rather than inferred so a route can map them to §6's statuses and an
 *  interface can print them without reading this file's control flow. */
export type JobActionCode =
  | "not-found"
  | "paused"
  | "revoked"
  | "in-flight"
  | "unfireable"
  | "unwritable";

export type JobActionResult =
  | {
      readonly ok: true;
      readonly job: JobRecord;
      readonly note: string;
      readonly run?: JobRunRecord;
      readonly taskId?: string;
      readonly acknowledged?: number;
      /** The run still open when a pause was asked for, so the sentence can name the task that keeps going. */
      readonly openRunTaskId?: string;
    }
  | { readonly ok: false; readonly code: JobActionCode; readonly reason: string };

export interface StartupReport {
  readonly jobs: number;
  readonly active: number;
  readonly paused: number;
  /** §4.5's "without telling the user": one entry per job that had occurrences pass while nothing was watching. */
  readonly missed: {
    readonly jobId: string;
    readonly name: string;
    readonly occurrences: number;
    readonly capped: boolean;
  }[];
  /** Runs left open by the process that died, closed here against the state §7.1's recovery gave their tasks. */
  readonly reconciled: number;
  readonly nextRunAt?: string;
}

export interface TickReport {
  readonly at: number;
  readonly fired: { readonly jobId: string; readonly taskId: string }[];
  readonly skipped: {
    readonly jobId: string;
    readonly occurrences: number;
    readonly reason: string;
  }[];
  readonly missed: {
    readonly jobId: string;
    readonly occurrences: number;
    readonly capped: boolean;
  }[];
  readonly refused: { readonly jobId: string; readonly reason: string }[];
  readonly reconciled: { readonly runId: string; readonly outcome: JobRunOutcome }[];
  readonly nextRunAt?: string;
}

export interface SchedulerFacts {
  readonly jobs: number;
  readonly active: number;
  readonly paused: number;
  readonly openRuns: number;
  readonly missedUnacknowledged: number;
  readonly armed: boolean;
  readonly nextRunAt?: string;
}

export interface SchedulerTimers {
  readonly set: (fn: () => void, ms: number) => unknown;
  readonly clear: (handle: unknown) => void;
}

export interface SchedulerDeps {
  readonly store: JobStore;
  /** The fire path, which is the composition root's because it is the party holding the runner, the journal and the
   *  identity table. A refusal is a fact rather than an exception, so a tick can record it and move on. */
  readonly fire: (request: FireRequest) => FireResult;
  /** Who a job's creator is *now*. Absent means the identity was revoked, which `packages/storage/clients.ts` does by
   *  deleting the row (O-071). */
  readonly identityOf: (clientId: string) => JobIdentity | undefined;
  /** The task's state, read from the journal's own store: the scheduler reconciles a run against the fact the runtime
   *  already wrote rather than against an opinion of its own (§9's one writer per fact). */
  readonly taskStateOf: (taskId: string) => TaskState | undefined;
  readonly log?: Logger | undefined;
  readonly now?: (() => number) | undefined;
  readonly newJobId?: (() => string) | undefined;
  readonly newRunId?: (() => string) | undefined;
  /** How long a timer may sleep when nothing is due. Bounded because a job another process created, and a clock that
   *  jumped, both have to be noticed without an event to announce them; 30 s against a one-minute schedule is a latency
   *  nobody can observe and a wake-up count a phone can afford. */
  readonly maxSleepMs?: number | undefined;
  readonly timers?: SchedulerTimers | undefined;
  /** How many runs `GET /jobs/{id}` carries. Bounded because W16-09 pages a history it does not hold whole. */
  readonly runHistoryLimit?: number | undefined;
}

export interface Scheduler {
  /** Reads every job against the clock, records what passed while the process was down, closes the runs the previous
   *  process left open, and arms the timer. Called by whoever owns the process's exit path, after §7.1's recovery has
   *  run, because the reconciliation below reads the states recovery wrote. */
  start(): StartupReport;
  /** One evaluation. Public because it is the whole of the scheduler's behaviour and a test that has to wait a minute
   *  for a tick is a test nobody runs; `start`, the timer and `runNow` all end up here. */
  tick(at?: number): TickReport;
  /** `cron.schedule`'s write path, and the only one: C12-09 records that there is no `crabby job create` because two
   *  creation paths with different approval semantics is how a schedule escapes review, and this one arrives through a T2
   *  tool call the user approved. */
  schedule(input: ScheduleInput): ScheduleResult;
  pause(id: string, at?: number): JobActionResult;
  resume(id: string, at?: number): JobActionResult;
  /** §4.5's *non-material* half of an edit, and the only half this build has: the name a person calls the job by, and
   *  when it runs. What a job does is not patchable anywhere in it, because "any material change to its steps, targets,
   *  recipients, or model/provider crosses into re-approval" and nothing outside the loop can open an approval (D-084) —
   *  so the honest surface is one that cannot perform the change rather than one that performs it and calls it reviewed.
   *  A new schedule is re-projected from now, because the next fire of an expression is a fact about the expression. */
  edit(
    id: string,
    patch: { readonly name?: string; readonly schedule?: string },
    at?: number,
  ): JobActionResult;
  /** C12-04's explicit run outside the schedule, which changes nothing about the schedule. */
  runNow(id: string, at?: number): JobActionResult;
  /** C12-06's answer to §4.5's backlog: `latest` fires one run for the most recent missed occurrence, `skip` fires
   *  nothing, and both are recorded. */
  backlog(id: string, action: "latest" | "skip", at?: number): JobActionResult;
  list(): readonly JobRecord[];
  get(id: string): JobView | undefined;
  facts(): SchedulerFacts;
  /** Recompute the timer. Called after any write that changes what is due next, and exposed because a composition that
   *  creates a job through a path this file did not run still has to be able to wake the scheduler up. */
  arm(): void;
  /** Stops the timer and reports what is still open. It cancels nothing: a run in flight is a task, and §4.5 says a job
   *  is cancellable *like a task* — through `task.cancel`, by a party that knows what is in flight. */
  shutdown(): { readonly openRuns: number };
}

/** The most occurrences one `missed` row will count. A per-minute expression left for a year is half a million of them,
 *  and the answer §4.5 needs from that number is "more than you want to run" — so the count is capped and the row says it
 *  was, rather than spending a second on a phone counting occurrences nobody will read one by one. */
export const MISSED_COUNT_CAP = 1000;
/** The shortest timer this file will arm. A tick that wakes immediately after a fire is a busy loop wearing a
 *  scheduler's clothes, and the schedule's own resolution is a minute. */
const MIN_SLEEP_MS = 250;
const DEFAULT_MAX_SLEEP_MS = 30_000;
/** How many runs one `GET /api/v1/jobs/{id}` carries. Exported because the route answers the same question the runtime
 *  does, and two numbers for one history is how a phone renders a list the API said was complete. */
export const DEFAULT_RUN_HISTORY = 10;

/** The in-memory `JobStore`, exported for the reason `createMemoryApprovalStore` is: the scheduler's behaviour is a
 *  sequence of decisions about time, and a test that had to open SQLite to assert one would be a test about a database
 *  that happens to have a timer in it — and `packages/agent-runtime` imports no storage at all (`ARCHITECTURE.md` §19).
 *  The SQL store's own assertions live beside it, in `packages/storage`.
 *
 *  It mirrors `createSqliteJobStore` field by field rather than by spreading a record, and that is the point of the shape:
 *  an `update` here has as little ability to rewrite `objective` or `createdBy` as the `SET` list there does, so a
 *  scheduler test cannot pass against a store that would let a patch do something the real one refuses. */
export function createMemoryJobStore(): JobStore {
  const jobs = new Map<string, JobRecord>();
  const runs = new Map<string, JobRunRecord>();
  const jobOrder: string[] = [];
  const runOrder: string[] = [];

  function writeJob(job: JobRecord): JobRecord {
    jobs.set(job.id, job);
    return job;
  }

  return {
    insert(job) {
      if (jobs.has(job.id))
        // `insert` and never a replace, for the reason the SQL store gives: a colliding id is a bug in the caller, and
        // replacing a row would silently withdraw a timer somebody is looking at.
        throw new Error(`job ${job.id} already exists`);
      jobs.set(job.id, job);
      jobOrder.push(job.id);
    },
    get: (id) => jobs.get(id),
    all: () =>
      jobOrder.flatMap((id) => {
        const job = jobs.get(id);
        return job === undefined ? [] : [job];
      }),
    update(id, patch: JobPatch) {
      const current = jobs.get(id);
      if (current === undefined) return undefined;
      // `null` clears the next fire and `undefined` leaves it alone, which is a distinction the record's optional field
      // cannot express by omission — so the row is rebuilt column by column, exactly as the SQL `SET` list is.
      const nextRunAt =
        patch.nextRunAt === undefined ? current.nextRunAt : (patch.nextRunAt ?? undefined);
      const lastRunAt = patch.lastRunAt ?? current.lastRunAt;
      return writeJob({
        id: current.id,
        name: patch.name ?? current.name,
        schedule: patch.schedule ?? current.schedule,
        objective: current.objective,
        state: patch.state ?? current.state,
        createdBy: current.createdBy,
        capabilities: patch.capabilities ?? current.capabilities,
        sessionId: current.sessionId,
        createdAt: current.createdAt,
        updatedAt: patch.updatedAt,
        ...(nextRunAt === undefined ? {} : { nextRunAt }),
        ...(lastRunAt === undefined ? {} : { lastRunAt }),
        missed: patch.missed ?? current.missed,
        utcOffsetMinutes: current.utcOffsetMinutes,
      });
    },
    insertRun(run) {
      if (runs.has(run.id)) throw new Error(`job run ${run.id} already exists`);
      runs.set(run.id, run);
      runOrder.push(run.id);
    },
    updateRun(id, patch: RunPatch) {
      const current = runs.get(id);
      if (current === undefined) return undefined;
      // `?? current.x` is the memory store's `COALESCE`: an update that closes a run cannot erase the reason it was
      // opened with or the task it fired.
      const updated: JobRunRecord = {
        ...current,
        outcome: patch.outcome ?? current.outcome,
        ...(patch.reason === undefined ? {} : { reason: patch.reason }),
        ...(patch.taskId === undefined ? {} : { taskId: patch.taskId }),
        ...(patch.settledAt === undefined ? {} : { settledAt: patch.settledAt }),
      };
      runs.set(id, updated);
      return updated;
    },
    runsFor(jobId, limit) {
      // The SQL store's ordering restated — `ORDER BY due_at DESC, rowid DESC` — newest due instant first and the most
      // recently written row winning a tie. Two runs for one occurrence are not a hypothetical: a `missed` row and the
      // `fired` row beside it carry the same `dueAt`, and a history that ordered those differently in a test than in a
      // product would be a rule that holds in one of the two.
      const ours = runOrder
        .flatMap((id, index) => {
          const run = runs.get(id);
          return run === undefined || run.jobId !== jobId ? [] : [{ run, index }];
        })
        .sort((a, b) =>
          a.run.dueAt === b.run.dueAt ? b.index - a.index : a.run.dueAt < b.run.dueAt ? 1 : -1,
        );
      return ours.slice(0, limit).map((entry) => entry.run);
    },
    lastRun(jobId) {
      for (let index = runOrder.length - 1; index >= 0; index -= 1) {
        const run = runs.get(runOrder[index] as string);
        if (run !== undefined && run.jobId === jobId) return run;
      }
      return undefined;
    },
    openRuns() {
      return runOrder.flatMap((id) => {
        const run = runs.get(id);
        return run !== undefined && isOpenRunOutcome(run.outcome) ? [run] : [];
      });
    },
    unacknowledgedMissed(jobId) {
      return runOrder.flatMap((id) => {
        const run = runs.get(id);
        return run !== undefined &&
          run.jobId === jobId &&
          run.outcome === "missed" &&
          run.acknowledgedAt === undefined
          ? [run]
          : [];
      });
    },
    acknowledgeMissed(jobId, at) {
      let total = 0;
      for (const id of runOrder) {
        const run = runs.get(id);
        if (
          run === undefined ||
          run.jobId !== jobId ||
          run.outcome !== "missed" ||
          run.acknowledgedAt !== undefined
        )
          continue;
        total += run.occurrences;
        // The rows keep their outcome and gain an `acknowledgedAt`: D-065's rule that the system does not quietly edit
        // its own past applies to a timer's history too.
        runs.set(id, { ...run, acknowledgedAt: at });
      }
      return total;
    },
  };
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const now = deps.now ?? ((): number => Date.now());
  const log = deps.log;
  const maxSleepMs = deps.maxSleepMs ?? DEFAULT_MAX_SLEEP_MS;
  const runHistoryLimit = deps.runHistoryLimit ?? DEFAULT_RUN_HISTORY;
  const timers: SchedulerTimers = deps.timers ?? {
    set: (fn, ms) => {
      const handle = setTimeout(fn, ms);
      // Unreferenced so that the scheduler's timer is never the reason a process stays alive: the listener is what a
      // Gateway keeps open, and a timer that held a process up on its own would be one Ctrl-C cannot end. A test that
      // forgets to shut the scheduler down gets the same benefit.
      const maybe = handle as { unref?: () => void };
      if (typeof maybe.unref === "function") maybe.unref();
      return handle;
    },
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  let timer: unknown | undefined;
  let stopped = false;

  const newJobId = deps.newJobId ?? defaultOpaqueId;
  const newRunId = deps.newRunId ?? defaultOpaqueId;

  // ------------------------------------------------------------------ reads

  function parsedOf(
    job: JobRecord,
  ): { ok: true; schedule: CronSchedule } | { ok: false; reason: string } {
    // Parsed on every use rather than cached at creation: the expression on the row is the one that was approved, and a
    // parse that refused it is a fact about the row that a later build may read differently — a cached parse would be a
    // second copy of the schedule that could disagree with the first.
    const parsed = parseCron(job.schedule);
    return parsed.ok
      ? { ok: true, schedule: parsed.schedule }
      : { ok: false, reason: parsed.reason };
  }

  function openRunFor(jobId: string): JobRunRecord | undefined {
    return deps.store.openRuns().find((run) => run.jobId === jobId);
  }

  function list(): readonly JobRecord[] {
    return deps.store.all();
  }

  function get(id: string): JobView | undefined {
    const job = deps.store.get(id);
    if (job === undefined) return undefined;
    const runs = deps.store.runsFor(job.id, runHistoryLimit);
    const lastRun = deps.store.lastRun(job.id);
    return { job, runs, ...(lastRun === undefined ? {} : { lastRun }) };
  }

  function facts(): SchedulerFacts {
    const jobs = deps.store.all();
    const active = jobs.filter((job) => job.state === "active");
    let soonest: number | undefined;
    for (const job of active) {
      if (job.nextRunAt === undefined) continue;
      const at = Date.parse(job.nextRunAt);
      if (Number.isNaN(at)) continue;
      if (soonest === undefined || at < soonest) soonest = at;
    }
    return {
      jobs: jobs.length,
      active: active.length,
      paused: jobs.length - active.length,
      openRuns: deps.store.openRuns().length,
      missedUnacknowledged: jobs.reduce((total, job) => total + job.missed, 0),
      armed: timer !== undefined,
      ...(soonest === undefined ? {} : { nextRunAt: new Date(soonest).toISOString() }),
    };
  }

  // ------------------------------------------------------------------ writes

  /** §4.5's intersection, and the only place it happens. Narrowing is durable — a capability an identity lost does not
   *  come back because a job once held it — so the narrowed set is written to the row, and widening is impossible because
   *  the intersection of a recorded set with anything is never larger than the recorded set. */
  function effectiveCapabilities(
    job: JobRecord,
    identity: JobIdentity,
    at: number,
  ): { capabilities: readonly string[]; lost: readonly string[] } {
    const held = new Set(identity.capabilities);
    const kept = job.capabilities.filter((name) => held.has(name));
    const lost = job.capabilities.filter((name) => !held.has(name));
    if (lost.length > 0) {
      deps.store.update(job.id, { capabilities: kept, updatedAt: new Date(at).toISOString() });
      log?.info("job capabilities narrowed at fire time", {
        job: job.id,
        lost,
        reason:
          "a job inherits nothing beyond its recorded capability set, and the identity that created it holds less than " +
          "it did (PROVIDERS_AND_TOOLS.md §4.5)",
      });
    }
    return { capabilities: kept, lost };
  }

  function recordRun(
    job: JobRecord,
    at: number,
    run: {
      dueAt: number;
      outcome: JobRunOutcome;
      trigger: JobRunTrigger;
      readonly occurrences?: number;
      readonly reason?: string | undefined;
      readonly taskId?: string | undefined;
    },
  ): JobRunRecord {
    const record: JobRunRecord = {
      id: newRunId(),
      jobId: job.id,
      dueAt: new Date(run.dueAt).toISOString(),
      recordedAt: new Date(at).toISOString(),
      outcome: run.outcome,
      trigger: run.trigger,
      occurrences: run.occurrences ?? 1,
      ...(run.reason === undefined ? {} : { reason: run.reason }),
      ...(run.taskId === undefined ? {} : { taskId: run.taskId }),
      ...(isOpenRunOutcome(run.outcome) ? {} : { settledAt: new Date(at).toISOString() }),
    };
    deps.store.insertRun(record);
    return record;
  }

  /** The next occurrence after `at`, written to the row. A schedule that stops having occurrences pauses the job rather
   *  than leaving it active with no next fire: an active job that cannot fire again is a row that reads as "soon" forever,
   *  and the alternative — re-evaluating it every tick and refusing every time — is a log with nothing to say. */
  function advance(
    job: JobRecord,
    schedule: CronSchedule,
    at: number,
  ): { ok: true } | { ok: false; reason: string } {
    const next = nextFire(schedule, at);
    if (!next.ok) {
      deps.store.update(job.id, {
        state: "paused",
        nextRunAt: null,
        updatedAt: new Date(at).toISOString(),
      });
      recordRun(job, at, {
        dueAt: at,
        outcome: "refused",
        trigger: "schedule",
        reason: `${next.reason} — the job is paused, because an active job that cannot fire again reads as one that will`,
      });
      log?.warn("job paused: its schedule has no next occurrence", {
        job: job.id,
        reason: next.reason,
      });
      return { ok: false, reason: next.reason };
    }
    deps.store.update(job.id, {
      nextRunAt: new Date(next.at).toISOString(),
      updatedAt: new Date(at).toISOString(),
    });
    return { ok: true };
  }

  function fireOnce(
    job: JobRecord,
    at: number,
    dueAt: number,
    trigger: JobRunTrigger,
  ):
    | { readonly ok: true; readonly run: JobRunRecord; readonly taskId: string }
    | { readonly ok: false; readonly code: JobActionCode; readonly reason: string } {
    const identity = deps.identityOf(job.createdBy.clientId);
    if (identity === undefined) {
      // Paused rather than left active: a job whose creator is gone cannot name a person for the audit record §4.5
      // requires, and firing it every minute to record a refusal each time is a log with nothing to say.
      const reason =
        `the identity that created this job (${job.createdBy.name}, ${job.createdBy.clientId}) was revoked, so there is ` +
        "no capability set to run under and no person for the audit record to name (PROVIDERS_AND_TOOLS.md §4.5); the " +
        "job is paused until it is re-created from a live identity";
      deps.store.update(job.id, {
        state: "paused",
        nextRunAt: null,
        updatedAt: new Date(at).toISOString(),
      });
      recordRun(job, at, { dueAt, outcome: "refused", trigger, reason });
      log?.warn("job refused: its identity was revoked", { job: job.id, trigger });
      return { ok: false, code: "revoked", reason };
    }
    const { capabilities } = effectiveCapabilities(job, identity, at);
    const fired = deps.fire({ job, at: dueAt, capabilities, trigger });
    if (!fired.ok) {
      const reason = `the run was not created: ${fired.reason}`;
      recordRun(job, at, { dueAt, outcome: "refused", trigger, reason });
      log?.warn("job fire refused", {
        job: job.id,
        trigger,
        code: fired.code,
        reason: fired.reason,
      });
      return { ok: false, code: "unwritable", reason };
    }
    const run = recordRun(job, at, {
      dueAt,
      outcome: "fired",
      trigger,
      taskId: fired.taskId,
      reason:
        trigger === "schedule"
          ? undefined
          : "asked for explicitly, outside the schedule — still a fresh policy evaluation (§4.5)",
    });
    deps.store.update(job.id, {
      lastRunAt: new Date(at).toISOString(),
      updatedAt: new Date(at).toISOString(),
    });
    log?.info("job fired", {
      job: job.id,
      trigger,
      task: fired.taskId,
      dueAt: new Date(dueAt).toISOString(),
    });
    return { ok: true, run, taskId: fired.taskId };
  }

  // ------------------------------------------------------------------ reconciliation

  /** Reads every open run against its task's state and closes the ones that ended. This is the half of §4.5 that says a
   *  run which cannot get approval "stops and records 'waiting on approval'": the record is written here, from the state
   *  the loop already moved the task into, and the run stays open — which is also what keeps the job from firing another
   *  run beside a prompt that is waiting for a human. */
  function reconcile(at: number): { readonly runId: string; readonly outcome: JobRunOutcome }[] {
    const reconciled: { readonly runId: string; readonly outcome: JobRunOutcome }[] = [];
    for (const run of deps.store.openRuns()) {
      if (run.taskId === undefined) {
        // A `fired` row with no task is a row this file wrote and then lost the id of, which no code path does — so it is
        // closed loudly rather than left open, because an open run blocks its job forever.
        deps.store.updateRun(run.id, {
          outcome: "refused",
          settledAt: new Date(at).toISOString(),
          reason: "the run recorded no task id, so there is nothing to reconcile it against",
        });
        reconciled.push({ runId: run.id, outcome: "refused" });
        continue;
      }
      const state = deps.taskStateOf(run.taskId);
      if (state === undefined) {
        // `docs/DATA_AND_MEMORY.md` §7 deletes a conversation's tasks; a run whose task is gone cannot be reconciled and
        // must not stay open, so it takes the state that means "this ended without finishing and nothing is driving it".
        deps.store.updateRun(run.id, {
          outcome: "interrupted",
          settledAt: new Date(at).toISOString(),
          reason: `the task record ${run.taskId} is gone, so the run cannot be reconciled against it`,
        });
        reconciled.push({ runId: run.id, outcome: "interrupted" });
        continue;
      }
      if (state === "awaiting_approval") {
        if (run.outcome === "waiting_on_approval") continue;
        deps.store.updateRun(run.id, {
          outcome: "waiting_on_approval",
          reason:
            "the run stopped at an approval and does not proceed unattended (PROVIDERS_AND_TOOLS.md §4.5); it stays " +
            "here until the prompt is answered or expires under D-064's window",
        });
        reconciled.push({ runId: run.id, outcome: "waiting_on_approval" });
        log?.info("scheduled run waiting on approval", { job: run.jobId, task: run.taskId });
        continue;
      }
      if (
        state === "queued" ||
        state === "planning" ||
        state === "running" ||
        state === "cancelling"
      )
        continue;
      // `completed`, `failed`, `cancelled`, `interrupted`: the task's own outcome is the run's, because a scheduled run is
      // a task and not a special kind of work.
      deps.store.updateRun(run.id, {
        outcome: state,
        settledAt: new Date(at).toISOString(),
        // Kept beside the outcome rather than replacing it: whoever answers a prompt an hour late should be able to see
        // that the run waited for them, which is the fact §4.5 asked to be recorded.
        ...(run.outcome === "waiting_on_approval"
          ? { reason: `it waited on an approval, and the task ended ${state}` }
          : {}),
      });
      reconciled.push({ runId: run.id, outcome: state });
      log?.info("scheduled run settled", { job: run.jobId, task: run.taskId, outcome: state });
    }
    return reconciled;
  }

  // ------------------------------------------------------------------ the tick

  function tick(at: number = now()): TickReport {
    const reconciled = reconcile(at);
    const fired: TickReport["fired"] = [];
    const skipped: TickReport["skipped"] = [];
    const missed: TickReport["missed"] = [];
    const refused: TickReport["refused"] = [];

    for (const job of deps.store.all()) {
      if (job.state === "paused") continue;
      const parsed = parsedOf(job);
      if (!parsed.ok) {
        // An expression this build cannot read is a row an older or a hand-edited file left behind. Refused, recorded and
        // paused, because a job that is evaluated every tick and refused every tick is a log with nothing to say.
        deps.store.update(job.id, {
          state: "paused",
          nextRunAt: null,
          updatedAt: new Date(at).toISOString(),
        });
        recordRun(job, at, {
          dueAt: at,
          outcome: "refused",
          trigger: "schedule",
          reason: `${parsed.reason} — the job is paused until its schedule is one this build can read`,
        });
        refused.push({ jobId: job.id, reason: parsed.reason });
        continue;
      }
      const schedule = parsed.schedule;
      const dueAt = job.nextRunAt === undefined ? Number.NaN : Date.parse(job.nextRunAt);
      if (Number.isNaN(dueAt)) {
        // No next fire on an active job means the row was written without one, so it is computed rather than reported:
        // the alternative is a job that never fires and a `job ls` line with nothing in its "next run" column forever.
        const next = nextFire(schedule, at);
        if (!next.ok) {
          deps.store.update(job.id, {
            state: "paused",
            nextRunAt: null,
            updatedAt: new Date(at).toISOString(),
          });
          refused.push({ jobId: job.id, reason: next.reason });
          continue;
        }
        deps.store.update(job.id, {
          nextRunAt: new Date(next.at).toISOString(),
          updatedAt: new Date(at).toISOString(),
        });
        log?.info("job had no next run; computed one", {
          job: job.id,
          nextRunAt: new Date(next.at).toISOString(),
        });
        continue;
      }
      if (dueAt > at) continue;

      // Occurrences that passed *besides* the one that is due. A tick that woke five minutes late on a per-minute
      // expression owes the user four recorded occurrences and one run, in that order: §4.5's rule against a burst is
      // about a restart, and the same rule is the right answer for a late wake-up inside a live process.
      const extra: OccurrenceCount = occurrencesBetween(schedule, dueAt, at, MISSED_COUNT_CAP);
      const open = openRunFor(job.id);
      if (open !== undefined) {
        const occurrences = 1 + extra.count;
        const reason =
          `the occurrence at ${new Date(dueAt).toISOString()} came due while the run for task ` +
          `${open.taskId ?? open.id} was still open${occurrences > 1 ? `, and ${extra.count} more passed beside it` : ""}` +
          " — one run at a time per job, so a job cannot pile up work behind a prompt nobody answered";
        recordRun(job, at, { dueAt, outcome: "skipped", trigger: "schedule", occurrences, reason });
        skipped.push({ jobId: job.id, occurrences, reason });
        advance(job, schedule, at);
        continue;
      }
      const result = fireOnce(job, at, dueAt, "schedule");
      if (result.ok) fired.push({ jobId: job.id, taskId: result.taskId });
      else refused.push({ jobId: job.id, reason: result.reason });
      // Re-read before touching the schedule: a refusal whose reason will not change — a revoked identity, an expression
      // this build cannot read — paused the job inside `fireOnce`, and writing a next fire onto a paused row would be a
      // second opinion about whether it may run.
      const after = deps.store.get(job.id);
      if (after === undefined || after.state === "paused") continue;
      if (extra.count > 0) {
        const reason =
          `the scheduler woke ${extra.count} occurrence${extra.count === 1 ? "" : "s"} late` +
          `${extra.capped ? " (at least — the count stopped at the cap)" : ""}: one run fired for ` +
          `${new Date(dueAt).toISOString()} and the rest were recorded rather than fired, because §4.5's rule is that a ` +
          "schedule nobody was watching does not become a burst when somebody starts watching it again";
        recordRun(job, at, {
          dueAt,
          outcome: "missed",
          trigger: "schedule",
          occurrences: extra.count,
          reason,
        });
        deps.store.update(job.id, {
          missed: job.missed + extra.count,
          updatedAt: new Date(at).toISOString(),
        });
        missed.push({ jobId: job.id, occurrences: extra.count, capped: extra.capped });
      }
      // The refusal path already wrote the row it needed (and paused the job when the reason was one that will not
      // change), so the schedule advances either way: a job that stays due is a job that fires twice for one occurrence.
      advance(after, schedule, at);
    }

    arm();
    const factsNow = facts();
    return {
      at,
      fired,
      skipped,
      missed,
      refused,
      reconciled,
      ...(factsNow.nextRunAt === undefined ? {} : { nextRunAt: factsNow.nextRunAt }),
    };
  }

  function arm(): void {
    if (timer !== undefined) {
      timers.clear(timer);
      timer = undefined;
    }
    if (stopped) return;
    const at = now();
    const next = facts().nextRunAt;
    const sleep =
      next === undefined
        ? maxSleepMs
        : Math.min(Math.max(Date.parse(next) - at, MIN_SLEEP_MS), maxSleepMs);
    timer = timers.set(() => {
      timer = undefined;
      tick();
    }, sleep);
  }

  function start(): StartupReport {
    const at = now();
    stopped = false;
    const reconciled = reconcile(at);
    const missed: StartupReport["missed"] = [];
    for (const job of deps.store.all()) {
      if (job.state === "paused") continue;
      const parsed = parsedOf(job);
      if (!parsed.ok) continue; // the tick refuses and pauses it, with the reason recorded there rather than twice
      const dueAt = job.nextRunAt === undefined ? Number.NaN : Date.parse(job.nextRunAt);
      if (Number.isNaN(dueAt) || dueAt > at) continue;
      const window = occurrencesBetween(parsed.schedule, dueAt - 1, at, MISSED_COUNT_CAP);
      const reason =
        `${window.count} occurrence${window.count === 1 ? "" : "s"} of '${job.schedule}' passed between ` +
        `${new Date(dueAt).toISOString()} and ${new Date(at).toISOString()} while this process was not running` +
        `${window.capped ? " (at least — the count stopped at the cap)" : ""}. None of them fired: §4.5's rule is that a ` +
        "device killed overnight does not come back to a burst, and `crabby job backlog " +
        `${job.id}` +
        "` is where the answer to what happens to them is recorded";
      recordRun(job, at, {
        dueAt,
        outcome: "missed",
        trigger: "schedule",
        occurrences: window.count,
        reason,
      });
      deps.store.update(job.id, {
        missed: job.missed + window.count,
        updatedAt: new Date(at).toISOString(),
      });
      missed.push({
        jobId: job.id,
        name: job.name,
        occurrences: window.count,
        capped: window.capped,
      });
      advance(job, parsed.schedule, at);
    }
    arm();
    const report: StartupReport = {
      jobs: deps.store.all().length,
      active: deps.store.all().filter((job) => job.state === "active").length,
      paused: deps.store.all().filter((job) => job.state === "paused").length,
      missed,
      reconciled: reconciled.length,
      ...(facts().nextRunAt === undefined ? {} : { nextRunAt: facts().nextRunAt }),
    };
    if (report.jobs > 0 || report.missed.length > 0)
      log?.info("scheduler started", {
        jobs: report.jobs,
        active: report.active,
        paused: report.paused,
        missedRuns: report.missed.length,
        missedOccurrences: report.missed.reduce((total, row) => total + row.occurrences, 0),
        reconciled: report.reconciled,
        ...(report.nextRunAt === undefined ? {} : { nextRunAt: report.nextRunAt }),
      });
    return report;
  }

  // ------------------------------------------------------------------ the verbs

  function schedule(input: ScheduleInput): ScheduleResult {
    const parsed = parseCron(input.schedule);
    if (!parsed.ok) return { ok: false, code: "invalid_schedule", reason: parsed.reason };
    const at = input.at ?? now();
    const next = nextFire(parsed.schedule, at);
    if (!next.ok) return { ok: false, code: "no_occurrence", reason: next.reason };
    const job: JobRecord = {
      // Opaque, and not `newId("job")`: `ids.ts` documents five prefixes and a sixth invented here would be a wire
      // format nobody approved (O-070's open question, which a job id joins a client id in).
      id: newJobId(),
      name: input.name,
      schedule: parsed.schedule.expression,
      objective: input.objective,
      state: "active",
      createdBy: {
        clientId: input.createdBy.clientId,
        name: input.createdBy.name,
        interface: input.createdBy.interface,
      },
      capabilities: [...input.capabilities],
      sessionId: input.sessionId,
      createdAt: new Date(at).toISOString(),
      updatedAt: new Date(at).toISOString(),
      nextRunAt: new Date(next.at).toISOString(),
      missed: 0,
      utcOffsetMinutes: utcOffsetMinutesOf(at),
    };
    deps.store.insert(job);
    arm();
    log?.info("job scheduled", {
      job: job.id,
      schedule: job.schedule,
      nextRunAt: job.nextRunAt,
      by: job.createdBy.name,
    });
    return { ok: true, job };
  }

  function pause(id: string, at: number = now()): JobActionResult {
    const job = deps.store.get(id);
    if (job === undefined) return notFound(id);
    const open = openRunFor(id);
    if (job.state === "paused")
      return {
        ok: true,
        job,
        note: `already paused, so it was not going to fire; \`crabby job resume ${id}\` starts it again`,
        ...(open?.taskId === undefined ? {} : { openRunTaskId: open.taskId }),
      };
    const paused = deps.store.update(id, {
      state: "paused",
      nextRunAt: null,
      updatedAt: new Date(at).toISOString(),
    });
    if (paused === undefined)
      return { ok: false, code: "unwritable", reason: `job ${id} could not be written` };
    arm();
    log?.info("job paused", { job: id, by: "crabby job pause" });
    return {
      ok: true,
      job: paused,
      note:
        "paused before the next tick, and its next fire is cleared rather than ignored — nothing is scheduled while it is " +
        `paused${
          open?.taskId === undefined
            ? ""
            : `, and the run already in flight keeps going because a pause is not a cancellation: \`crabby task cancel ${open.taskId}\` is how that one stops (§4.5)`
        }`,
      ...(open?.taskId === undefined ? {} : { openRunTaskId: open.taskId }),
    };
  }

  function resume(id: string, at: number = now()): JobActionResult {
    const job = deps.store.get(id);
    if (job === undefined) return notFound(id);
    if (job.state === "active" && job.nextRunAt !== undefined)
      return {
        ok: true,
        job,
        note: `already active; the next fire is ${job.nextRunAt}`,
      };
    const identity = deps.identityOf(job.createdBy.clientId);
    if (identity === undefined)
      return {
        ok: false,
        code: "revoked",
        reason:
          `the identity that created this job (${job.createdBy.name}, ${job.createdBy.clientId}) was revoked, so there ` +
          "is no capability set to run under and no person for the audit record to name (§4.5); re-create the job from a " +
          "live identity rather than resuming this one",
      };
    // C12-03's second half: a resume re-evaluates the grants instead of trusting the last evaluation. The intersection is
    // written to the row, so the narrowing survives the resume rather than lasting only as long as the run it produced.
    const { capabilities, lost } = effectiveCapabilities(job, identity, at);
    const parsed = parsedOf({ ...job, capabilities });
    if (!parsed.ok) return { ok: false, code: "unfireable", reason: parsed.reason };
    const next = nextFire(parsed.schedule, at);
    if (!next.ok) return { ok: false, code: "unfireable", reason: next.reason };
    const resumed = deps.store.update(id, {
      state: "active",
      capabilities,
      nextRunAt: new Date(next.at).toISOString(),
      updatedAt: new Date(at).toISOString(),
    });
    if (resumed === undefined)
      return { ok: false, code: "unwritable", reason: `job ${id} could not be written` };
    arm();
    log?.info("job resumed", {
      job: id,
      nextRunAt: resumed.nextRunAt,
      ...(lost.length === 0 ? {} : { lost }),
    });
    return {
      ok: true,
      job: resumed,
      note:
        `active again from ${new Date(at).toISOString()}, next fire ${resumed.nextRunAt ?? "unknown"} — the grants were ` +
        "re-evaluated against the identity's current capabilities rather than trusted from the last run (§4.5)" +
        (lost.length === 0
          ? ""
          : `, and the set is narrower now: ${lost.join(", ")} ${lost.length === 1 ? "was" : "were"} removed from the identity that created this job`),
    };
  }

  function edit(
    id: string,
    patch: { readonly name?: string; readonly schedule?: string },
    at: number = now(),
  ): JobActionResult {
    const job = deps.store.get(id);
    if (job === undefined) return notFound(id);
    if (patch.name === undefined && patch.schedule === undefined)
      return {
        ok: false,
        code: "unfireable",
        reason:
          "an edit with nothing in it is not an edit; this route takes `name` and `schedule`, and `objective` is not " +
          "patchable in this build because changing what a job does crosses into re-approval (§4.5) and nothing outside " +
          "the loop can open one (D-084)",
      };
    const schedule = patch.schedule ?? job.schedule;
    const parsed = parseCron(schedule);
    if (!parsed.ok) return { ok: false, code: "unfireable", reason: parsed.reason };
    const changed = patch.schedule !== undefined && parsed.schedule.expression !== job.schedule;
    // Projected whenever the patch carries a schedule, and from *now* rather than from the instant the old expression
    // named, because a new expression's next occurrence is a fact about that expression: a daily job edited at 14:00 into
    // `*/5 * * * *` owes a fire within five minutes, and projecting from tomorrow's 07:00 would hand back a row that reads
    // as "the edit did nothing". A refusal here rather than a row with no next fire, for the reason creation refuses the
    // same way: an expression with no occurrence left is a job that will never run, and "unknown" beside a schedule reads
    // as "soon" forever.
    //
    // Projected for a *paused* job too, and that is a decision rather than a convenience: writing an expression that can
    // never fire onto a paused row would defer the refusal to `resume`, where the user has already been told the pause
    // worked. What an edit does *not* do is re-litigate the expression already on the row — a rename of a job whose
    // schedule died years ago is still a rename, and refusing it would be a verb arguing about something it was not
    // asked to change.
    const projected = changed ? nextFire(parsed.schedule, at) : undefined;
    if (projected !== undefined && !projected.ok)
      return { ok: false, code: "unfireable", reason: projected.reason };
    // A paused job keeps having no next fire: resuming is the act that re-evaluates the grants and projects the schedule
    // again, and computing one here would leave a paused row advertising a time it is not going to keep.
    const next = job.state === "paused" ? undefined : projected;
    const updated = deps.store.update(id, {
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(changed ? { schedule: parsed.schedule.expression } : {}),
      ...(next?.ok ? { nextRunAt: new Date(next.at).toISOString() } : {}),
      updatedAt: new Date(at).toISOString(),
    });
    if (updated === undefined)
      return { ok: false, code: "unwritable", reason: `job ${id} could not be written` };
    arm();
    log?.info("job edited", {
      job: id,
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(changed ? { schedule: parsed.schedule.expression } : {}),
    });
    return {
      ok: true,
      job: updated,
      note:
        `${changed ? `the schedule is now '${parsed.schedule.expression}'` : "the schedule is unchanged"}${
          patch.name === undefined ? "" : ` and the name is now '${patch.name}'`
        }` +
        (updated.state === "paused"
          ? "; the job is paused, so it has no next fire until `crabby job resume` re-evaluates it"
          : `, and the next fire is ${
              updated.nextRunAt === undefined
                ? "unknown"
                : // D-103's rendering, in the sentence rather than only in the row: a time a user is asked to act on has to
                  // be the time on their wall, with the offset that made it visible beside it.
                  `${localStamp(Date.parse(updated.nextRunAt))} (${updated.nextRunAt})`
            }`) +
        " — what the job *does* is not editable here: changing its objective, targets or model crosses into re-approval " +
        "(§4.5), and no route in this build can open one",
    };
  }

  function runNow(id: string, at: number = now()): JobActionResult {
    const job = deps.store.get(id);
    if (job === undefined) return notFound(id);
    if (job.state === "paused")
      return {
        ok: false,
        code: "paused",
        reason:
          `the job is paused, and a pause an explicit verb could step around is a pause with a hole in it — ` +
          `\`crabby job resume ${id}\` first, then ask for the run`,
      };
    const open = openRunFor(id);
    if (open !== undefined)
      return {
        ok: false,
        code: "in-flight",
        reason:
          `a run of this job is still open (task ${open.taskId ?? "unknown"}, ${open.outcome}); one run at a time per ` +
          "job, so a second one would be a burst of two — `crabby task cancel " +
          `${open.taskId ?? "<id>"}` +
          "` stops the first",
      };
    const parsed = parsedOf(job);
    if (!parsed.ok) return { ok: false, code: "unfireable", reason: parsed.reason };
    const result = fireOnce(job, at, at, "run-now");
    if (!result.ok) return { ok: false, code: result.code, reason: result.reason };
    return {
      ok: true,
      job: deps.store.get(id) ?? job,
      run: result.run,
      taskId: result.taskId,
      note:
        `ran once outside the schedule — the next fire is unchanged at ${job.nextRunAt ?? "unknown"}, and this run is a ` +
        "fresh policy evaluation like any other (§4.5), so a T2 or T3 step inside it asks now",
    };
  }

  function backlog(id: string, action: "latest" | "skip", at: number = now()): JobActionResult {
    const job = deps.store.get(id);
    if (job === undefined) return notFound(id);
    const rows = deps.store.unacknowledgedMissed(id);
    if (rows.length === 0)
      return {
        ok: true,
        job,
        acknowledged: 0,
        note: "no occurrence of this job passed while nothing was watching, so there is no backlog to answer for",
      };
    if (action === "skip") {
      const acknowledged = deps.store.acknowledgeMissed(id, new Date(at).toISOString());
      const skipped = deps.store.update(id, { missed: 0, updatedAt: new Date(at).toISOString() });
      log?.info("job backlog skipped", { job: id, occurrences: acknowledged });
      return {
        ok: true,
        job: skipped ?? job,
        acknowledged,
        note:
          `${acknowledged} missed occurrence${acknowledged === 1 ? "" : "s"} recorded as skipped and none of them fired; ` +
          "the rows keep their outcome and gain the moment you answered, because the history of work that did not happen " +
          "is the record §4.5 asks for (D-065's rule about not editing the past)",
      };
    }
    // `latest`: one run for the most recent missed occurrence, and the rest acknowledged. Firing the *latest* rather than
    // the earliest is the reading C12-06 offers first, and the reason is the same one §4.5 gives for not firing a burst:
    // the work a timer describes is usually about now, and running an occurrence from Tuesday on Friday is not what the
    // user meant by "catch up".
    const latest = rows[rows.length - 1];
    const dueAt = latest === undefined ? at : Date.parse(latest.dueAt);
    const job0 = job.state === "paused" ? undefined : job;
    if (job0 === undefined)
      return {
        ok: false,
        code: "paused",
        reason: `the job is paused, so nothing may run for it — \`crabby job resume ${id}\` first, then answer the backlog`,
      };
    const open = openRunFor(id);
    if (open !== undefined)
      return {
        ok: false,
        code: "in-flight",
        reason: `a run of this job is still open (task ${open.taskId ?? "unknown"}, ${open.outcome}); one run at a time per job`,
      };
    const parsed = parsedOf(job0);
    if (!parsed.ok) return { ok: false, code: "unfireable", reason: parsed.reason };
    const result = fireOnce(job0, at, Number.isNaN(dueAt) ? at : dueAt, "backlog");
    if (!result.ok) return { ok: false, code: result.code, reason: result.reason };
    const acknowledged = deps.store.acknowledgeMissed(id, new Date(at).toISOString());
    const updated = deps.store.update(id, { missed: 0, updatedAt: new Date(at).toISOString() });
    log?.info("job backlog answered", {
      job: id,
      action,
      occurrences: acknowledged,
      task: result.taskId,
    });
    return {
      ok: true,
      job: updated ?? job0,
      run: result.run,
      taskId: result.taskId,
      acknowledged,
      note:
        `one run fired for the most recent missed occurrence (${new Date(dueAt).toISOString()}) and ${acknowledged} ` +
        "acknowledged in total; the rest were not fired, because §4.5's rule is that a backlog does not become a burst",
    };
  }

  function notFound(id: string): JobActionResult {
    return {
      ok: false,
      code: "not-found",
      reason: `no job ${id} — \`crabby job ls\` prints the ids this Gateway holds`,
    };
  }

  function shutdown(): { readonly openRuns: number } {
    stopped = true;
    if (timer !== undefined) {
      timers.clear(timer);
      timer = undefined;
    }
    const openRuns = deps.store.openRuns().length;
    log?.info("scheduler stopped", {
      openRuns,
      reason:
        openRuns === 0
          ? "no run was open"
          : "a run still open is a task, and §7.1's recovery owns what a restart does with it",
    });
    return { openRuns };
  }

  return {
    start,
    tick,
    schedule,
    pause,
    resume,
    edit,
    runNow,
    backlog,
    list,
    get,
    facts,
    arm,
    shutdown,
  };
}

/** The id shape `packages/storage/clients.ts` established for a record the documents gave no prefix: opaque, sortable by
 *  nothing, and honest about it. Injected in tests so a row can be recognised. */
function defaultOpaqueId(): string {
  return randomBytes(10).toString("base64url");
}
