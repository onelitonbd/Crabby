// The scheduled job's wire shape: one record four surfaces read (`GET /jobs`, `crabby job ls`, the TUI's jobs pane and
// the Web's Scheduled screen — D-057's decision that a job is a first-class surface and not a row in the task list), and
// one record per evaluation of it, because `PROVIDERS_AND_TOOLS.md` §4.5 makes the *runs* the auditable thing: "every
// execution of a scheduled job is a fresh policy evaluation", and a run that could not get approval "stops and records"
// why. A job whose history lived only in the log would be a standing authority nobody could review a month later, which
// is the harm W16-09's "approval trail per run" exists to prevent.
//
// Two shapes here are decisions rather than transcriptions, and both are D-103's:
//
//   - `utcOffsetMinutes` is the offset the expression was written against. §4.5 says nothing about time zones and no
//     other document does either, so a schedule is evaluated against the device's own wall clock and the offset it was
//     created at is recorded beside it — a phone that crosses a time zone then renders "next run" in a zone the user can
//     compare with the one they wrote the expression in, instead of silently moving 07:00 by four hours.
//   - `missed` counts the occurrences §4.5 refuses to fire. "A device killed overnight … must not fire a burst of
//     backlogged runs on resume without telling the user" needs a number to tell them with, and the number is on the
//     record rather than in a log line because C12-06 asks a command to print it and W16-08 asks a sheet to.
//
// What is deliberately *not* here: a model pin. §4.5 lists a model or provider change as a material one, and F-57
// records that no per-task pin exists to change — so a job runs on whatever `defaultModel` selects at each fire, and a
// field promising a pin would promise a control this build does not have.
import { type Static, Type } from "@sinclair/typebox";
import type { ClientInterface } from "./clients.ts";

/** A job is either firing on its schedule or not firing at all. There is no third state on the row, and the reason is
 *  that the words a client renders — `waiting-approval`, `failing`, `deferred:vault-locked` — are facts about the job's
 *  *last run* rather than about its authority to fire, so `jobStateWord` computes them from the pair instead of storing
 *  a second opinion beside the run rows that produced it. */
export const JOB_STATES = ["active", "paused"] as const;
export type JobState = (typeof JOB_STATES)[number];

/** What one evaluation of a job ended as. Six of these are the task's own outcomes read back, because §4.5's rule is
 *  that a scheduled run is a task and not a special kind of work — so the words are §4.1's, and the two that are the
 *  scheduler's own are the two the schedule creates: `missed` (an occurrence that passed while nothing could fire it)
 *  and `skipped` (an occurrence that passed while the job's previous run was still open). */
/** The guard a query string needs. Written out rather than inlined at each caller because `JOB_STATES` is a tuple and
 *  `includes` on it demands a cast: four interfaces filtering by state would each write that cast, and one of them would
 *  eventually cast the wrong way. */
export function isJobState(value: string): value is JobState {
  return (JOB_STATES as readonly string[]).includes(value);
}

export const JOB_RUN_OUTCOMES = [
  /** Open: the task this run created has not settled. The only outcome a `job ls` state word reads as work in flight. */
  "fired",
  /** §4.5's sentence, recorded rather than implied: "If a scheduled run cannot obtain approval within its window, it
   *  stops and records 'waiting on approval'; it must not proceed unattended." */
  "waiting_on_approval",
  /** The occurrence came due while the job's previous run was still open. One run at a time per job is D-103's answer
   *  to §4.5's no-burst rule inside a live process: a job that piled up runs would be a burst of a different shape. */
  "skipped",
  /** The occurrence passed while nothing could fire it — the host was down, or the tick woke late. Recorded and never
   *  fired, which is §4.5's rule and C12-06's subject. */
  "missed",
  /** The fire itself was refused: the identity that created the job is gone, this Gateway drives no tasks, or the run
   *  could not be recorded. A refusal is written down because a job that silently stops firing is the outage §4.5's
   *  "rather than failing opaquely" clause is about. */
  "refused",
  "completed",
  "failed",
  "cancelled",
  /** §7.1's recovery marked the task interrupted when the process died, so the run's outcome is the task's. */
  "interrupted",
] as const;
export type JobRunOutcome = (typeof JOB_RUN_OUTCOMES)[number];

/** The outcomes that mean a run is still open, so a reader can tell "still going" from "ended" without a second list. */
export const OPEN_RUN_OUTCOMES = [
  "fired",
  "waiting_on_approval",
] as const satisfies readonly JobRunOutcome[];

export function isOpenRunOutcome(outcome: JobRunOutcome): boolean {
  return (OPEN_RUN_OUTCOMES as readonly string[]).includes(outcome);
}

/** How the run came to exist. `schedule` is the tick, `run-now` is C12-04's explicit act outside the schedule, and
 *  `backlog` is C12-06's "run the latest only" — three triggers rather than one, because an audit trail that could not
 *  distinguish a timer from a person would be a trail about nothing. */
export const JOB_RUN_TRIGGERS = ["schedule", "run-now", "backlog"] as const;
export type JobRunTrigger = (typeof JOB_RUN_TRIGGERS)[number];

/** The state word C12-01 and W16-02 both require, and both require as *words* rather than colours so a terminal can
 *  grep them. `deferred:vault-locked` is in the vocabulary and nothing in this build can produce it: §4.5's deferred
 *  run needs a vault to be locked (§3.7), and F-56 records that there is no vault — so a key cannot be stored, a
 *  provider cannot need one at fire time, and the word arrives with M5 rather than being faked now. */
export const JOB_STATE_WORDS = [
  "active",
  "paused",
  "waiting-approval",
  "failing",
  "deferred:vault-locked",
] as const;
export type JobStateWord = (typeof JOB_STATE_WORDS)[number];

/** §4.5's "it runs under the identity that created it, so audit records name a person rather than 'cron'". The three
 *  fields are the person, and they are stored on the job rather than joined from the identity table because a revocation
 *  deletes the identity row (O-071): a job's record of who authorised it has to outlive the credential that was. */
export interface JobCreatedBy {
  readonly clientId: string;
  readonly name: string;
  readonly interface: ClientInterface;
}

export interface JobRecord {
  /** Opaque, and not `newId("job")`: `packages/api-contracts/ids.ts` documents five prefixes and none of them is a
   *  scheduled job, so minting a sixth here would be a wire-format change smuggled in through a milestone. This is
   *  `packages/storage/clients.ts`'s precedent and O-070's open question, which now has two subjects instead of one. */
  readonly id: string;
  readonly name: string;
  /** The five-field expression exactly as it was recorded at creation. Never normalised: §4.5 authorises "the job as
   *  described at creation time", and a rewritten expression would be a description the user did not approve. */
  readonly schedule: string;
  /** The task each fire creates. Changing it is §4.5's material change, which is why no patch field carries it. */
  readonly objective: string;
  readonly state: JobState;
  readonly createdBy: JobCreatedBy;
  /** The job's own recorded capability set — §4.5's "a job inherits no ambient authority from the user who created it
   *  beyond its own recorded capability set". Re-intersected with the identity's current set at every fire, so it can
   *  narrow and never widen, which is D-054's rule applied to a timer. */
  readonly capabilities: readonly string[];
  /** The conversation the schedule was created in. Each fire creates its *own* session rather than appending to this
   *  one, because a job that ran every minute into a single conversation would grow it without bound and D-065's
   *  retention is priced per task. */
  readonly sessionId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Absent while paused, and the absence is the fact C12-03 asks a command to state: a paused job has no next fire,
   *  rather than a next fire it is pretending to ignore. */
  readonly nextRunAt?: string;
  readonly lastRunAt?: string;
  /** Occurrences recorded as `missed` and not yet acknowledged (C12-06's subject). Acknowledging does not delete the
   *  rows: D-065's rule that the system does not quietly edit its own past applies to a timer's history too. */
  readonly missed: number;
  readonly utcOffsetMinutes: number;
}

export interface JobRunRecord {
  readonly id: string;
  readonly jobId: string;
  /** The instant the schedule named. For a `missed` row standing for several occurrences it is the first of them, and
   *  `occurrences` says how many the row is. */
  readonly dueAt: string;
  readonly recordedAt: string;
  /** When the outcome stopped being open. Absent on a run still in flight, which is how a reader tells the two apart
   *  without consulting `isOpenRunOutcome`. */
  readonly settledAt?: string;
  readonly outcome: JobRunOutcome;
  readonly trigger: JobRunTrigger;
  /** The task this run created, when it created one. A `missed` or `skipped` row has none, and that absence is the
   *  record §4.5 asks for: nothing ran, and the row says so instead of pointing at a task that means something else. */
  readonly taskId?: string;
  readonly reason?: string;
  readonly occurrences: number;
  /** C12-06's "the answer is recorded": the moment the user said what to do about the backlog, whether the answer was
   *  `run the latest only` or `skip all`. */
  readonly acknowledgedAt?: string;
}

/** The job as a route answers it: the record, plus the next fire rendered in the zone the schedule is evaluated in.
 *  Rendered by the Gateway rather than by each client because the Gateway is the party that reads the wall clock — a
 *  browser on another machine would otherwise print a next run in its own zone, which is not the zone the timer fires in
 *  (D-103). Absent while the job is paused, exactly as `nextRunAt` is. */
export interface JobRow extends JobRecord {
  readonly nextRunLocal?: string;
  /** C12-01's greppable word and W16-02's chip, computed by the party that holds both halves — the job and its last run —
   *  rather than by four clients each deriving it from the same two fields and each free to derive it differently. */
  readonly stateWord: JobStateWord;
  /** C12-01 asks the list line to carry the last outcome beside the state word, and the two are not the same fact: the
   *  word is a verdict (`failing` covers both `failed` and `refused`) while the outcome is what the run recorded. On the
   *  row rather than fetched per job, because a list that cost one request per line would be a list a phone does not
   *  render. Absent for a job that has never run, which is the honest reading of "last outcome: never". */
  readonly lastOutcome?: JobRunOutcome;
}

/** `GET /jobs/{id}`'s body: the job with the runs a reviewer asks for. `runs` is bounded by the route rather than
 *  paged, because D-065's retention prices a task's history and a job's is the same order of magnitude on a phone, and
 *  W16-09's paging is a Web concern over the same bounded read. */
export interface JobView {
  readonly job: JobRecord;
  readonly lastRun?: JobRunRecord;
  readonly runs: readonly JobRunRecord[];
}

/** The row a route answers, from the two records that decide it. One function rather than four clients composing the same
 *  three fields, because `stateWord` is a claim about a job and a client that derived it itself could derive a different
 *  one — and the stamp is passed in rather than computed here because the party that renders a wall clock is the one that
 *  evaluates schedules against it (`packages/agent-runtime/cron.ts`), which a contract may not import. */
export function jobRow(
  job: JobRecord,
  lastRun: JobRunRecord | undefined,
  nextRunLocal?: string,
): JobRow {
  return {
    ...job,
    stateWord: jobStateWord(job, lastRun),
    ...(lastRun === undefined ? {} : { lastOutcome: lastRun.outcome }),
    ...(nextRunLocal === undefined ? {} : { nextRunLocal }),
  };
}

/** The state word, computed from the pair rather than stored. `paused` wins over everything because it is the only word
 *  that describes the job's authority rather than its last run; `waiting-approval` wins over `failing` because W16-02
 *  calls it "the state that must never be hidden, because it means work is stalled on a human". */
export function jobStateWord(
  job: Pick<JobRecord, "state">,
  lastRun: Pick<JobRunRecord, "outcome"> | undefined,
): JobStateWord {
  if (job.state === "paused") return "paused";
  if (lastRun?.outcome === "waiting_on_approval") return "waiting-approval";
  if (lastRun?.outcome === "failed" || lastRun?.outcome === "refused") return "failing";
  return "active";
}

/** `GET /jobs`'s body. One shape for the route that writes it and the four interfaces that read it, for the reason the
 *  schemas below are TypeBox rather than prose: a terminal and a browser deriving the same answer from the same fields
 *  are two parties that can drift, and D-069's rule is that the contract is the only place the shape is stated. */
export interface JobListBody {
  readonly items: readonly JobRow[];
  readonly count: number;
  /** Whether this Gateway composed a scheduler. `false` means the rows are true and read-only in this process: nothing
   *  is armed, nothing fires, and a verb that changes a job answers `501` rather than pretending. Reported rather than
   *  left to be discovered at the next fire, which is the same reason `runs.composed` exists. */
  readonly driven: boolean;
  /** The sentence that explains `driven: false`, present exactly when it is false. */
  readonly note?: string;
  /** §4.5's sixth rule as a number: occurrences recorded as `missed` and not yet answered for, across the listed jobs. */
  readonly missedUnacknowledged: number;
  /** The soonest next fire, when a scheduler is composed and one exists. */
  readonly nextRunAt?: string;
}

/** `GET /jobs/{id}`'s body: the row, the bounded run history, and the backlog rows C12-06 asks about — all in one
 *  answer, because a user deciding what to do about missed runs should not have to ask twice. */
export interface JobDetailBody {
  readonly job: JobRow;
  readonly lastRun?: JobRunRecord;
  readonly runs: readonly JobRunRecord[];
  readonly missedUnacknowledged: readonly JobRunRecord[];
  readonly driven: boolean;
  readonly note?: string;
}

/** What every job verb answers with: the row as it now stands, and the scheduler's own sentence beside it. The sentence
 *  is part of the body rather than a log line because C12-03 and C12-04 both ask a command to *say* what happened — that
 *  a pause takes effect before the next tick, that a run is a fresh evaluation — and only the scheduler knows those. */
export interface JobActionBody {
  readonly job: JobRow;
  readonly note: string;
  readonly driven: boolean;
  readonly run?: JobRunRecord;
  /** The task this verb created, when it created one: `run` always does, `backlog --latest` does, and the others do not. */
  readonly taskId?: string;
  readonly acknowledged?: number;
  /** The run still open when a pause was asked for, so the answer can name the task that keeps going (§4.5). */
  readonly openRunTaskId?: string;
}

/** `DELETE /jobs/{id}`'s answer (T17-05/W16-11, D-133): what went, what stayed, and the sentence that says both. The job
 *  row is the thing deleted; the run history is a choice the asker made and the answer records, because "the history of
 *  past runs is not deleted with the job unless asked" is W16-11's own third column and a body that did not say which
 *  happened would make every client guess. */
export interface JobDeleteBody {
  readonly deleted: string;
  readonly historyKept: boolean;
  readonly note: string;
}

/** `PATCH /jobs/{id}`'s body, and the fields it accepts are the ones §4.5 does not call material: a name is how the user
 *  refers to the job, and a schedule changes *when* it runs rather than *what* it does. `objective` is absent from the
 *  schema on purpose — `additionalProperties: false` turns "change what it targets" into a named refusal quoting §4.5's
 *  re-approval rule, rather than into a write nobody reviewed. That is the same structural guarantee
 *  `packages/storage/approvals.ts` gives an answer: the statement has no column to rewrite the approved thing with. */
export const PatchJobBody = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
    schedule: Type.Optional(Type.String({ minLength: 9, maxLength: 120 })),
  },
  { additionalProperties: false },
);
export type PatchJobBody = Static<typeof PatchJobBody>;

/** `POST /jobs/{id}/backlog`'s body: C12-06's three answers. `latest` fires one run for the most recent missed
 *  occurrence and acknowledges the rest; `skip` acknowledges them all and fires nothing; `each` (D-133) fires the
 *  earliest now and drains the rest one at a time — the tick fires the next occurrence only when the one before it has
 *  settled, so the no-burst rule holds and `skip` retires whatever remains. All three are recorded, because an
 *  acknowledgement nobody can find later is the same silence §4.5 forbids. */
export const JobBacklogBody = Type.Object(
  {
    action: Type.Union([Type.Literal("latest"), Type.Literal("skip"), Type.Literal("each")]),
  },
  { additionalProperties: false },
);
export type JobBacklogBody = Static<typeof JobBacklogBody>;
