// The scheduler, asserted as `PROVIDERS_AND_TOOLS.md` §4.5's seven rules rather than as a timer with getters: what a job
// is authorised for, that every execution is a fresh evaluation, what a run that cannot get an approval records, that a
// job inherits no ambient authority, that it is cancellable like a task, that a paused job defers with a visible reason,
// and that a device killed overnight comes back to a record rather than to a burst.
//
// Two properties of the harness are the reason these tests exist in this package rather than in `tests/integration`. The
// clock is injected, so a tick is a function call and not a minute of waiting — a test that had to sleep to prove a
// scheduler works is a test nobody runs. And the timers are injected, so nothing here holds the event loop open: the
// production arm is `unref`ed for the same reason, and a test that leaked a live timer would hang `node --test` after its
// last assertion passed.
//
// The zone is pinned to UTC so that a wall-clock minute in a fixture is the minute a reader computes from it.
process.env.TZ = "UTC";

import assert from "node:assert/strict";
import { test } from "node:test";
import type { JobRecord, TaskState } from "@crabby/api-contracts";
import {
  createMemoryJobStore,
  createScheduler,
  type FireRequest,
  MISSED_COUNT_CAP,
  type Scheduler,
} from "./scheduler.ts";

const MINUTE = 60_000;
/** A Monday at noon, so a fixture can name a weekday without a reader opening a calendar. 2026-10-12 is a Monday. */
const T0 = new Date(2026, 9, 12, 12, 0, 0, 0).getTime();

interface Harness {
  readonly scheduler: Scheduler;
  readonly store: ReturnType<typeof createMemoryJobStore>;
  /** Every fire the scheduler asked for, in order — the evidence for "what a run is authorised for". */
  readonly fires: FireRequest[];
  /** The identities that still exist. Deleting one is a revocation, which `packages/storage/clients.ts` does by removing
   *  the row (O-071). */
  readonly identities: Map<string, { name: string; interface: "cli"; capabilities: string[] }>;
  /** The state each fired task is in, which is what a run is reconciled against. */
  readonly tasks: Map<string, TaskState>;
  /** The timers the scheduler armed: `{ms, run}`. Nothing here is a real timer. */
  readonly armed: { ms: number; run: () => void; cleared: boolean }[];
  /** What the next fire answers with. A refusal is a fact the composition root reports rather than an exception. */
  fireResult: (
    request: FireRequest,
  ) => { ok: true; taskId: string } | { ok: false; code: string; reason: string };
  /** The clock the scheduler reads. Moved through `moveTo` rather than assigned, because a test that set a field the
   *  scheduler does not read would be a test about its own fixture. */
  readonly at: number;
  moveTo(at: number): void;
  tick(at?: number): ReturnType<Scheduler["tick"]>;
  /** Create a job through the scheduler's own write path, which is the only one there is (C12-09). */
  schedule(overrides?: Partial<Parameters<Scheduler["schedule"]>[0]>): JobRecord;
  job(id: string): JobRecord;
  runs(id: string): ReturnType<ReturnType<typeof createMemoryJobStore>["runsFor"]>;
}

function harness(start = T0): Harness {
  const store = createMemoryJobStore();
  const fires: FireRequest[] = [];
  const identities = new Map<string, { name: string; interface: "cli"; capabilities: string[] }>();
  const tasks = new Map<string, TaskState>();
  const armed: Harness["armed"] = [];
  let clock = start;
  let taskCount = 0;
  let jobCount = 0;
  let runCount = 0;

  const self: Harness = {
    store,
    fires,
    identities,
    tasks,
    armed,
    get at(): number {
      return clock;
    },
    moveTo(at: number) {
      clock = at;
    },
    fireResult: () => {
      taskCount += 1;
      return { ok: true, taskId: `tsk_${taskCount}` };
    },
    // The harness's own clock, read through a getter rather than a value: `at` is a field so a test can read it, and the
    // scheduler reads the function, so moving the clock is one assignment.
    get scheduler(): Scheduler {
      return scheduler;
    },
    tick(at) {
      if (at !== undefined) clock = at;
      return scheduler.tick(clock);
    },
    schedule(overrides = {}) {
      const result = scheduler.schedule({
        name: "morning summary",
        schedule: "0 7 * * *",
        objective: "summarise what needs an answer",
        sessionId: "ses_1",
        createdBy: { clientId: "cli_1", name: "the owner", interface: "cli" },
        capabilities: ["task.create", "file.read"],
        at: clock,
        ...overrides,
      });
      assert.ok(
        result.ok,
        `the fixture's own job must be creatable: ${result.ok ? "" : result.reason}`,
      );
      return result.job;
    },
    job(id) {
      const job = store.get(id);
      assert.ok(job !== undefined, `job ${id} must exist`);
      return job as JobRecord;
    },
    runs: (id) => store.runsFor(id, 50),
  };

  const scheduler = createScheduler({
    store,
    fire: (request) => {
      fires.push(request);
      return self.fireResult(request);
    },
    identityOf: (clientId) => {
      const identity = identities.get(clientId);
      return identity === undefined
        ? undefined
        : {
            name: identity.name,
            interface: identity.interface,
            capabilities: identity.capabilities,
          };
    },
    taskStateOf: (taskId) => tasks.get(taskId),
    now: () => clock,
    newJobId: () => {
      jobCount += 1;
      return `job_${jobCount}`;
    },
    newRunId: () => {
      runCount += 1;
      return `run_${runCount}`;
    },
    timers: {
      set: (fn, ms) => {
        const entry = { ms, run: fn, cleared: false };
        armed.push(entry);
        return entry;
      },
      clear: (handle) => {
        const entry = handle as { cleared: boolean };
        entry.cleared = true;
      },
    },
  });

  // The default fixture identity: the person who asked for the job, holding what the mint gave them.
  identities.set("cli_1", {
    name: "the owner",
    interface: "cli",
    capabilities: ["task.create", "file.read", "file.write"],
  });
  return self;
}

/** Move the clock to the instant a job is due, and one millisecond past it, because a tick standing exactly on the
 *  occurrence is the case a scheduler has to get right most often. */
function dueAt(job: JobRecord): number {
  assert.ok(job.nextRunAt !== undefined, "the fixture's job is active and has a next fire");
  return Date.parse(job.nextRunAt as string);
}

test("creation refuses an expression it cannot read, and one with no occurrence left, and writes nothing either way", () => {
  const h = harness();
  const unreadable = h.scheduler.schedule({
    name: "bad",
    schedule: "0 7 * * 7",
    objective: "x",
    sessionId: "ses_1",
    createdBy: { clientId: "cli_1", name: "the owner", interface: "cli" },
    capabilities: [],
    at: T0,
  });
  assert.equal(unreadable.ok, false);
  if (!unreadable.ok)
    assert.equal(
      unreadable.code,
      "invalid_schedule",
      "D-103 refuses a `7` in the day-of-week field rather than reading it as Sunday",
    );

  const impossible = h.scheduler.schedule({
    name: "impossible",
    schedule: "0 0 30 2 *",
    objective: "x",
    sessionId: "ses_1",
    createdBy: { clientId: "cli_1", name: "the owner", interface: "cli" },
    capabilities: [],
    at: T0,
  });
  assert.equal(impossible.ok, false);
  if (!impossible.ok) {
    assert.equal(impossible.code, "no_occurrence");
    assert.match(
      impossible.reason,
      /1500/,
      "the refusal names the bound the search stopped at, so a user learns the search was finite rather than that it failed",
    );
  }
  assert.equal(
    h.store.all().length,
    0,
    "a refused creation writes no row: a job that can never fire is a row that reads as 'soon' forever",
  );
});

test("a job records who authorised it, what it holds, and the offset its schedule was read against", () => {
  const h = harness();
  const job = h.schedule();
  // §4.5: "it runs under the identity that created it, so audit records name a person rather than 'cron'".
  assert.deepEqual(job.createdBy, { clientId: "cli_1", name: "the owner", interface: "cli" });
  // "A job inherits no ambient authority from the user who created it beyond its own recorded capability set": the set is
  // the one the caller passed, not the identity's whole baseline — the fixture identity holds `file.write` and the job
  // does not.
  assert.deepEqual([...job.capabilities], ["task.create", "file.read"]);
  assert.equal(
    job.utcOffsetMinutes,
    0,
    "D-103 records the offset at creation, in the sign a person writes — and as `0` rather than the `-0` a negation " +
      "produces, which serialises the same and compares differently",
  );
  assert.equal(job.state, "active");
  assert.equal(job.missed, 0);
  assert.equal(
    job.nextRunAt,
    new Date(2026, 9, 13, 7, 0).toISOString(),
    "the next fire is tomorrow at seven, the wall clock's seven",
  );
  assert.equal(h.store.all().length, 1);
});

test("a due job fires exactly one run, named for the occurrence it was due at rather than for the tick that woke", () => {
  const h = harness();
  const job = h.schedule();
  const due = dueAt(job);
  // Waking three seconds late is the normal case: the arm sleeps until the minute and a process is not a crystal.
  const report = h.tick(due + 3_000);
  assert.deepEqual(
    report.fired.map((row) => row.jobId),
    [job.id],
  );
  assert.equal(h.fires.length, 1, "one occurrence, one run");
  assert.equal(
    h.fires[0]?.at,
    due,
    "the fire carries the instant the schedule named, not the moment the tick happened to wake",
  );
  assert.equal(h.fires[0]?.trigger, "schedule");
  assert.deepEqual([...(h.fires[0]?.capabilities ?? [])], ["task.create", "file.read"]);

  const runs = h.runs(job.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.outcome, "fired");
  assert.equal(runs[0]?.dueAt, new Date(due).toISOString());
  assert.equal(
    runs[0]?.taskId,
    "tsk_1",
    "the run points at the task it created, which is the link a client follows to a stream",
  );
  assert.equal(runs[0]?.occurrences, 1);
  assert.equal(h.job(job.id).lastRunAt, new Date(due + 3_000).toISOString());
  assert.equal(
    h.job(job.id).nextRunAt,
    new Date(2026, 9, 14, 7, 0).toISOString(),
    "and the schedule advanced, because a job that stays due fires twice for one occurrence",
  );
  assert.deepEqual(report.missed, [], "waking three seconds late is not a missed occurrence");
});

test("a run gets the intersection of the job's recorded set and what the identity holds now, and the narrowing is written down", () => {
  const h = harness();
  const job = h.schedule();
  // D-054 applied to a timer: `file.read` is taken away from the identity between creation and the fire.
  h.identities.set("cli_1", { name: "the owner", interface: "cli", capabilities: ["task.create"] });
  h.tick(dueAt(job));
  assert.deepEqual(
    [...(h.fires[0]?.capabilities ?? [])],
    ["task.create"],
    "§4.5's intersection, computed at fire time rather than trusted from creation",
  );
  assert.deepEqual(
    [...h.job(job.id).capabilities],
    ["task.create"],
    "and written to the row, so the narrowing outlives the run — a capability an identity lost does not come back because a job once held it",
  );
});

test("a creator whose identity was revoked refuses the fire, names the person, and pauses the job", () => {
  const h = harness();
  const job = h.schedule();
  h.identities.delete("cli_1");
  const report = h.tick(dueAt(job));
  assert.equal(
    h.fires.length,
    0,
    "nothing is handed to the composition root: there is no capability set to run under",
  );
  assert.equal(report.refused.length, 1);
  assert.match(
    report.refused[0]?.reason ?? "",
    /the owner/,
    "§4.5's audit sentence names a person rather than 'cron'",
  );
  assert.match(report.refused[0]?.reason ?? "", /revoked/);
  const after = h.job(job.id);
  assert.equal(
    after.state,
    "paused",
    "paused rather than left active, because firing it every minute to record a refusal each time is a log with nothing to say",
  );
  assert.equal(
    after.nextRunAt,
    undefined,
    "and a paused job has no next fire rather than a next fire it is ignoring",
  );
  const runs = h.runs(job.id);
  assert.equal(runs[0]?.outcome, "refused");
  assert.ok(runs[0]?.reason?.includes("revoked"), "the row carries the reason a reader can act on");
});

test("a tick that woke late fires one run and records the rest as missed, which is §4.5's rule inside a live process", () => {
  const h = harness();
  const job = h.schedule({ schedule: "* * * * *" });
  const due = dueAt(job);
  // Five minutes late on a per-minute expression: one run, four recorded occurrences, and no burst.
  const report = h.tick(due + 4 * MINUTE);
  assert.equal(h.fires.length, 1, "one run for the occurrence that was due");
  assert.equal(report.missed.length, 1);
  assert.equal(report.missed[0]?.occurrences, 4);
  assert.equal(report.missed[0]?.capped, false);
  const missed = h.runs(job.id).filter((run) => run.outcome === "missed");
  assert.equal(missed.length, 1, "one row standing for four occurrences, not four rows");
  assert.equal(missed[0]?.occurrences, 4);
  assert.match(missed[0]?.reason ?? "", /recorded rather than fired/);
  assert.equal(
    h.job(job.id).missed,
    4,
    "the counter a list prints so a user is told rather than left to notice",
  );
  // The cap is a floor and says so: a per-minute expression left for a year is half a million occurrences, and the answer
  // §4.5 needs is "more than you want to run".
  assert.ok(MISSED_COUNT_CAP > 0);
  const huge = h.tick(due + 4 * MINUTE + 60 * 24 * 400 * MINUTE);
  const capped = huge.missed[0];
  assert.equal(
    capped?.capped,
    true,
    "a count that stopped at the cap is reported as capped rather than passed off as a total",
  );
  assert.equal(capped?.occurrences, MISSED_COUNT_CAP);
});

test("one run at a time per job: an open run makes the next occurrence a single `skipped` row that counts what it stands for", () => {
  const h = harness();
  const job = h.schedule({ schedule: "* * * * *" });
  const due = dueAt(job);
  h.tasks.set("tsk_1", "running");
  h.tick(due);
  assert.equal(h.fires.length, 1);
  // Two more minutes pass while the first run is still moving.
  const report = h.tick(due + 2 * MINUTE);
  assert.equal(h.fires.length, 1, "no second run beside one that is still open");
  assert.equal(report.skipped.length, 1);
  assert.equal(
    report.skipped[0]?.occurrences,
    2,
    "the row it writes stands for the occurrence that came due plus the one that passed beside it",
  );
  const skipped = h.runs(job.id).filter((run) => run.outcome === "skipped");
  assert.equal(skipped.length, 1);
  assert.match(skipped[0]?.reason ?? "", /one run at a time per job/);
  assert.equal(
    skipped[0]?.taskId,
    undefined,
    "a skipped row names no task, because nothing ran — the absence is the record",
  );
  assert.ok(
    dueAt(h.job(job.id)) > due + 2 * MINUTE,
    "and the schedule still advanced, so the next tick does not re-decide the same minute",
  );
});

test("a run that cannot get an approval stops and records that it is waiting, and stays open so nothing fires beside it", () => {
  const h = harness();
  const job = h.schedule({ schedule: "* * * * *" });
  const due = dueAt(job);
  h.tick(due);
  // §4.5's third rule, from the state the loop already moved the task into: the scheduler reads the fact rather than
  // forming an opinion of its own.
  h.tasks.set("tsk_1", "awaiting_approval");
  const report = h.tick(due + MINUTE);
  assert.deepEqual(
    report.reconciled.map((row) => row.outcome),
    ["waiting_on_approval"],
  );
  const waiting = h.runs(job.id).find((run) => run.outcome === "waiting_on_approval");
  assert.ok(waiting !== undefined);
  assert.equal(
    waiting?.settledAt,
    undefined,
    "still open: a prompt nobody answered is not a finished run",
  );
  assert.match(waiting?.reason ?? "", /does not proceed unattended/);
  assert.equal(h.fires.length, 1, "and the job does not pile up work behind that prompt");
  assert.equal(
    h.tick(due + 2 * MINUTE).reconciled.length,
    0,
    "a run already recorded as waiting is not reconciled again every tick",
  );
});

test("a run whose task ended takes the task's own outcome, keeps the wait beside it, and frees the job in one tick", () => {
  const h = harness();
  const job = h.schedule({ schedule: "* * * * *" });
  const due = dueAt(job);
  h.tasks.set("tsk_1", "running");
  h.tick(due);
  h.tasks.set("tsk_1", "awaiting_approval");
  h.tick(due + MINUTE);
  // Somebody answered later and the task finished: the record keeps the wait beside the outcome, because that is the fact
  // §4.5 asked to have — a prompt answered late should still be visible as a prompt that was waited on.
  h.tasks.set("tsk_1", "completed");
  const report = h.tick(due + 2 * MINUTE);
  assert.deepEqual(
    report.reconciled.map((row) => row.outcome),
    ["completed"],
  );
  const settled = h.runs(job.id).find((run) => run.outcome === "completed");
  assert.ok(settled?.settledAt !== undefined, "a settled run says when it stopped being open");
  assert.match(settled?.reason ?? "", /waited on an approval/);
  // Reconciliation happens before the fire decision inside one tick, so a job whose run just settled is free to fire the
  // occurrence that came due while it was waiting — one tick, not two, and no occurrence lost between them. The open run
  // the store still holds is therefore the *new* one, which is the fact worth pinning: a scheduler that reconciled after
  // deciding would have skipped this occurrence and recorded it as missed instead.
  assert.deepEqual(
    report.fired.map((row) => row.taskId),
    ["tsk_2"],
  );
  assert.equal(h.fires[1]?.trigger, "schedule");
  assert.deepEqual(
    h.store.openRuns().map((run) => run.taskId),
    ["tsk_2"],
    "the settled run is closed and the only open one is the run this same tick fired",
  );
});

test("a task record that is gone closes the run as interrupted rather than leaving the job blocked forever", () => {
  const h = harness();
  const job = h.schedule();
  h.tick(dueAt(job));
  assert.equal(h.store.openRuns().length, 1);
  // `docs/DATA_AND_MEMORY.md` §7 deletes a conversation's tasks; a run whose task is gone cannot be reconciled against it.
  h.tasks.delete("tsk_1");
  const report = h.tick(dueAt(job) + MINUTE);
  assert.deepEqual(
    report.reconciled.map((row) => row.outcome),
    ["interrupted"],
  );
  assert.equal(h.store.openRuns().length, 0);
  assert.ok(
    h.job(job.id) !== undefined,
    "the job itself is untouched: the loss was the task's, not the schedule's",
  );
});

test("start() after a kill records what passed and fires nothing, which is §4.5's sixth rule", () => {
  // A job created at noon yesterday, three occurrences of a per-minute expression passed while the process was dead.
  const h = harness(T0);
  const job = h.schedule({ schedule: "* * * * *", at: T0 });
  const due = dueAt(job);
  const restart = due + 3 * MINUTE;
  h.moveTo(restart);
  const report = h.scheduler.start();
  assert.equal(h.fires.length, 0, "not one of the missed occurrences fired");
  assert.equal(report.missed.length, 1);
  assert.equal(
    report.missed[0]?.occurrences,
    4,
    "the occurrence that was due plus the three that passed beside it",
  );
  assert.equal(
    report.missed[0]?.name,
    "morning summary",
    "the report names the job, because the banner prints it to a person",
  );
  assert.equal(report.missed[0]?.jobId, job.id);
  const row = h.runs(job.id).find((run) => run.outcome === "missed");
  assert.match(row?.reason ?? "", /while this process was not running/);
  assert.match(row?.reason ?? "", /crabby job backlog/, "and names the verb that answers for them");
  assert.equal(h.job(job.id).missed, 4);
  assert.ok(dueAt(h.job(job.id)) > restart, "the next fire is in the future again");
  assert.equal(report.active, 1);
  assert.equal(report.paused, 0);
});

test("start() closes the runs a dead process left open, against the states recovery gave their tasks", () => {
  const h = harness();
  const job = h.schedule({ schedule: "* * * * *" });
  h.tick(dueAt(job));
  assert.equal(
    h.store.openRuns().length,
    1,
    "the fixture now holds what a killed process would have left behind",
  );
  // §7.1's recovery marked the task interrupted before the scheduler started, and the scheduler reads that rather than
  // guessing: `start()` runs after recovery in the composition root for exactly this reason.
  h.tasks.set("tsk_1", "interrupted");
  h.moveTo(h.at + MINUTE);
  const report = h.scheduler.start();
  assert.equal(report.reconciled, 1);
  assert.equal(h.store.openRuns().length, 0);
  // By id rather than by position: `runsFor` answers newest-due first, and `start()` wrote a `missed` row beside the run
  // it closed, so the first element of the history is not the run this test is about.
  assert.equal(
    h.runs(job.id).find((run) => run.id === "run_1")?.outcome,
    "interrupted",
    "the run the dead process left open took the state §7.1's recovery gave its task",
  );
});

test("the backlog answer is recorded either way: `latest` fires one run, `skip` fires none", () => {
  const latest = harness();
  const job = latest.schedule({ schedule: "* * * * *" });
  latest.moveTo(dueAt(job) + 3 * MINUTE);
  latest.scheduler.start();
  assert.equal(latest.job(job.id).missed, 4);
  const answered = latest.scheduler.backlog(job.id, "latest");
  assert.ok(answered.ok, answered.ok ? "" : answered.reason);
  if (!answered.ok) return;
  assert.equal(
    answered.acknowledged,
    4,
    "the whole backlog is answered, not just the occurrence that ran",
  );
  assert.equal(
    answered.taskId,
    "tsk_1",
    "one run, for the most recent occurrence — `start()` fired none of the four",
  );
  assert.equal(latest.fires.length, 1);
  assert.equal(
    latest.fires[0]?.trigger,
    "backlog",
    "and the audit trail can tell a backlog run from a timer and from a person",
  );
  assert.equal(latest.job(job.id).missed, 0);
  const rows = latest.runs(job.id).filter((run) => run.outcome === "missed");
  assert.equal(rows.length, 1, "the missed row is still there");
  assert.ok(
    rows[0]?.acknowledgedAt !== undefined,
    "with the moment the user answered on it — D-065's rule about not editing the past applies to a timer's history too",
  );
  assert.equal(rows[0]?.occurrences, 4);

  const skipped = harness();
  const other = skipped.schedule({ schedule: "* * * * *" });
  skipped.moveTo(dueAt(other) + 3 * MINUTE);
  skipped.scheduler.start();
  const skip = skipped.scheduler.backlog(other.id, "skip");
  assert.ok(skip.ok);
  if (!skip.ok) return;
  assert.equal(skip.acknowledged, 4);
  assert.equal(skip.taskId, undefined, "`skip` fires nothing");
  assert.equal(skipped.fires.length, 0);
  assert.equal(skipped.job(other.id).missed, 0);
  // A second answer has nothing left to acknowledge, and that is an answer rather than a refusal: a monitoring script
  // that asks every morning must not be told it made a mistake.
  const again = skipped.scheduler.backlog(other.id, "skip");
  assert.ok(again.ok, again.ok ? "" : again.reason);
  if (again.ok) {
    assert.equal(again.acknowledged, 0);
    assert.match(again.note, /no backlog to answer for/);
  }
});

test("a paused job does not fire, and pausing takes effect before the next tick while a run in flight keeps going", () => {
  const h = harness();
  const job = h.schedule({ schedule: "* * * * *" });
  const due = dueAt(job);
  h.tasks.set("tsk_1", "running");
  h.tick(due);
  const paused = h.scheduler.pause(job.id, due + 30_000);
  assert.ok(paused.ok);
  if (!paused.ok) return;
  assert.equal(paused.job.state, "paused");
  assert.equal(paused.job.nextRunAt, undefined);
  assert.equal(
    paused.openRunTaskId,
    "tsk_1",
    "C12-03: the sentence names the task that keeps going",
  );
  assert.match(paused.note, /before the next tick/);
  assert.match(
    paused.note,
    /crabby task cancel tsk_1/,
    "and the command that stops it, because a pause is not a cancellation",
  );
  // The tick after the pause fires nothing, and the run that was already moving is untouched.
  const report = h.tick(due + 2 * MINUTE);
  assert.deepEqual(report.fired, []);
  assert.deepEqual(
    report.skipped,
    [],
    "a paused job is not even skipped: it is not on the clock at all",
  );
  assert.equal(h.store.openRuns().length, 1);
  // Pausing twice is an answer rather than an error, for the reason a second `cancel` is: the state the caller wanted is
  // the state the job is in, and a refusal would send them looking for a problem that does not exist.
  const again = h.scheduler.pause(job.id);
  assert.ok(again.ok);
  if (again.ok) assert.match(again.note, /already paused/);
});

test("resume re-evaluates the grants instead of trusting the last evaluation, and refuses when the creator is gone", () => {
  const h = harness();
  const job = h.schedule();
  h.scheduler.pause(job.id);
  // The identity lost a capability while the job was paused.
  h.identities.set("cli_1", { name: "the owner", interface: "cli", capabilities: ["task.create"] });
  const resumed = h.scheduler.resume(job.id, T0 + MINUTE);
  assert.ok(resumed.ok, resumed.ok ? "" : resumed.reason);
  if (!resumed.ok) return;
  assert.deepEqual(
    [...resumed.job.capabilities],
    ["task.create"],
    "C12-03's second half: the intersection is recomputed, and written to the row",
  );
  assert.equal(resumed.job.state, "active");
  assert.match(
    resumed.note,
    /file\.read/,
    "and the note names what the job lost, because a narrower job is a different job",
  );
  assert.ok(
    resumed.job.nextRunAt !== undefined,
    "resuming projects the schedule again, which pausing cleared",
  );

  h.scheduler.pause(job.id);
  h.identities.delete("cli_1");
  const refused = h.scheduler.resume(job.id);
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.code, "revoked");
    assert.match(
      refused.reason,
      /re-create the job from a live identity/,
      "a revocation is not undone by a resume, and the reason says what to do instead",
    );
  }
  assert.equal(
    h.job(job.id).state,
    "paused",
    "the job stays paused rather than becoming active with no authority behind it",
  );
});

test("run-now is outside the schedule: it moves nothing, refuses a paused job, and refuses to run beside an open run", () => {
  const h = harness();
  const job = h.schedule();
  const before = job.nextRunAt;
  const ran = h.scheduler.runNow(job.id, T0 + MINUTE);
  assert.ok(ran.ok, ran.ok ? "" : ran.reason);
  if (!ran.ok) return;
  assert.equal(ran.taskId, "tsk_1");
  assert.equal(ran.run?.trigger, "run-now");
  assert.equal(
    h.job(job.id).nextRunAt,
    before,
    "C12-04: the schedule is unchanged by an explicit run",
  );
  assert.match(
    ran.note,
    /fresh policy evaluation/,
    "the sentence says what the run is, because that is what the user is relying on",
  );

  // A second run-now while the first is open is the same protection an idempotency key would give, and it also covers a
  // client that lost its key.
  h.tasks.set("tsk_1", "running");
  const inFlight = h.scheduler.runNow(job.id);
  assert.equal(inFlight.ok, false);
  if (!inFlight.ok) {
    assert.equal(inFlight.code, "in-flight");
    assert.match(
      inFlight.reason,
      /crabby task cancel/,
      "and it names the command that ends the first run",
    );
  }

  h.scheduler.pause(job.id);
  const paused = h.scheduler.runNow(job.id);
  assert.equal(paused.ok, false);
  if (!paused.ok) {
    assert.equal(paused.code, "paused");
    assert.match(
      paused.reason,
      /a pause an explicit verb could step around is a pause with a hole in it/,
    );
  }
  assert.equal(h.fires.length, 1, "one fire across all three attempts");

  const missing = h.scheduler.runNow("job_nobody_made");
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.code, "not-found");
    assert.match(
      missing.reason,
      /crabby job ls/,
      "a refusal names the command that would have found the id",
    );
  }
});

test("a fire the composition root refuses is recorded, and the job keeps its schedule", () => {
  const h = harness();
  const job = h.schedule({ schedule: "* * * * *" });
  h.fireResult = () => ({
    ok: false,
    code: "queued_tasks",
    reason: "five tasks are already queued and the runner refuses a sixth (D-074's queue row)",
  });
  const report = h.tick(dueAt(job));
  assert.equal(report.refused.length, 1);
  assert.match(
    report.refused[0]?.reason ?? "",
    /five tasks are already queued/,
    "the composition root's own sentence, not a paraphrase",
  );
  const runs = h.runs(job.id);
  assert.equal(runs[0]?.outcome, "refused");
  assert.equal(
    runs[0]?.settledAt !== undefined,
    true,
    "a refusal is settled the moment it is recorded: nothing is running",
  );
  assert.equal(
    h.job(job.id).state,
    "active",
    "a transient refusal does not pause a job — the next occurrence is a fresh evaluation",
  );
});

test("an expression this build cannot read on a stored row is refused, recorded and paused at the next tick", () => {
  const h = harness();
  const job = h.schedule();
  // The row as an older build or a hand-edited file would leave it: `JobPatch` cannot write an unreadable schedule, so
  // the fixture writes the store directly, which is the only way this state exists.
  h.store.update(job.id, {
    schedule: "0 7 * * 7",
    nextRunAt: new Date(T0 + MINUTE).toISOString(),
    updatedAt: new Date(T0).toISOString(),
  });
  const report = h.tick(T0 + MINUTE);
  assert.equal(report.refused.length, 1);
  assert.equal(h.fires.length, 0);
  assert.equal(
    h.job(job.id).state,
    "paused",
    "refused once and paused, rather than evaluated every tick and refused every tick",
  );
  assert.match(
    h.runs(job.id)[0]?.reason ?? "",
    /paused until its schedule is one this build can read/,
  );
});

test("edit changes the name and the schedule and nothing else, and refuses an edit with nothing in it", () => {
  const h = harness();
  const job = h.schedule();
  const empty = h.scheduler.edit(job.id, {});
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.match(empty.reason, /not an edit/);

  const renamed = h.scheduler.edit(job.id, { name: "evening summary" }, T0 + MINUTE);
  assert.ok(renamed.ok);
  if (!renamed.ok) return;
  assert.equal(renamed.job.name, "evening summary");
  assert.equal(renamed.job.schedule, job.schedule);
  assert.equal(renamed.job.nextRunAt, job.nextRunAt, "renaming does not move the next fire");
  assert.match(
    renamed.note,
    /not editable here/,
    "the note says what the verb cannot do, so a user does not discover it by trying",
  );

  // A daily job moved to every five minutes at 14:00 owes a fire within five minutes, not one tomorrow morning.
  const moved = h.scheduler.edit(
    job.id,
    { schedule: "*/5 * * * *" },
    new Date(2026, 9, 12, 14, 0).getTime(),
  );
  assert.ok(moved.ok);
  if (!moved.ok) return;
  assert.equal(moved.job.schedule, "*/5 * * * *");
  assert.equal(
    moved.job.nextRunAt,
    new Date(2026, 9, 12, 14, 5).toISOString(),
    "projected from now, because the next occurrence is a fact about the new expression",
  );
  assert.match(
    moved.note,
    /2026-10-12T14:05\+00:00/,
    "and the sentence carries D-103's wall-clock stamp beside the instant",
  );
  assert.equal(
    moved.job.objective,
    job.objective,
    "§4.5's material half has no field to change it with",
  );

  // A paused job keeps having no next fire: computing one would leave a paused row advertising a time it will not keep.
  h.scheduler.pause(job.id);
  const pausedEdit = h.scheduler.edit(job.id, { schedule: "0 8 * * *" });
  assert.ok(pausedEdit.ok);
  if (!pausedEdit.ok) return;
  assert.equal(pausedEdit.job.nextRunAt, undefined);
  assert.match(pausedEdit.note, /paused/, "and the note says the next fire waits on a resume");

  const unfireable = h.scheduler.edit(job.id, { schedule: "0 0 30 2 *" });
  assert.equal(
    unfireable.ok,
    false,
    "an expression with no occurrence is refused at edit time for the reason it is refused at creation",
  );
  const unreadable = h.scheduler.edit(job.id, { schedule: "@daily" });
  assert.equal(unreadable.ok, false);
});

test("the arm sleeps between a quarter second and thirty seconds, and shutdown stops it arming", () => {
  const h = harness();
  const job = h.schedule({ schedule: "* * * * *" });
  // Nothing due for at most thirty seconds: a bounded sleep is how a job another process created, and a clock that
  // jumped, get noticed without an event to announce them.
  assert.equal(h.armed.length, 1);
  assert.equal(
    h.armed[0]?.ms,
    30_000,
    "the next fire is a minute away and the sleep is capped at thirty seconds",
  );
  assert.equal(h.armed[0]?.cleared, false);

  // A job due in a tenth of a second does not arm a busy loop.
  h.store.update(job.id, {
    nextRunAt: new Date(h.at + 100).toISOString(),
    updatedAt: new Date(h.at).toISOString(),
  });
  h.scheduler.arm();
  assert.equal(
    h.armed[0]?.cleared,
    true,
    "arming clears the timer it replaces rather than leaving two",
  );
  assert.equal(
    h.armed[1]?.ms,
    250,
    "and the floor is what keeps a tick from waking immediately after a fire",
  );

  // Nothing scheduled at all still arms, at the cap.
  const empty = harness();
  empty.scheduler.arm();
  assert.equal(empty.armed[0]?.ms, 30_000);

  const stopped = h.scheduler.shutdown();
  assert.equal(stopped.openRuns, 0);
  assert.equal(h.armed[1]?.cleared, true, "shutdown clears the live arm");
  const before = h.armed.length;
  h.scheduler.arm();
  assert.equal(
    h.armed.length,
    before,
    "and a stopped scheduler arms nothing: a tick that fired after the drain began would create a task nobody is going to watch",
  );
  assert.equal(h.scheduler.facts().armed, false);
});

test("facts() is what a diagnostics row reports, and a run in flight is counted separately from a job on the clock", () => {
  const h = harness();
  const first = h.schedule({ name: "a", schedule: "* * * * *" });
  const second = h.schedule({ name: "b", schedule: "0 7 * * *", capabilities: [] });
  h.scheduler.pause(second.id);
  h.tasks.set("tsk_1", "running");
  h.tick(dueAt(first));
  const facts = h.scheduler.facts();
  assert.equal(facts.jobs, 2);
  assert.equal(facts.active, 1);
  assert.equal(facts.paused, 1);
  assert.equal(facts.openRuns, 1, "an open run is the fact that keeps its job from firing again");
  assert.equal(facts.missedUnacknowledged, 0);
  assert.equal(facts.armed, true);
  assert.equal(
    facts.nextRunAt,
    h.job(first.id).nextRunAt,
    "the soonest next fire across the active jobs, which is what the arm sleeps until",
  );
});
