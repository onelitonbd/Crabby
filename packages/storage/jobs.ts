// The job repository: `PROVIDERS_AND_TOOLS.md` §4.5's record of what a timer may do, who authorised it, and what each
// evaluation of it ended as — in the two tables schema version 5 creates.
//
// `ARCHITECTURE.md` §19 is why this file imports an interface from the runtime and not the other way round: the
// abstraction is `JobStore`, owned by `packages/agent-runtime/scheduler.ts`, and the runtime imports no database at all.
// It is the same split `approvals.ts` set, and for the same reason — the party that decides whether a job may fire cannot
// be the party that stores it, or "one run at a time per job" becomes a rule each writer interprets.
//
// Three decisions worth having in the file rather than in a migration log:
//
//   - **`update` has no `objective`, no `createdBy` and no `createdAt` in its `SET` list.** That is not an oversight:
//     §4.5 makes a material change to what a job does a re-approval, and the cleanest way to guarantee that no code path
//     here performs one is to give the statement no columns to perform it with. A rename and a new schedule are the two
//     edits this build admits, and both are about *when* and *what it is called* rather than *what it runs*.
//   - **The capability set is one JSON column.** No query filters on a single capability, and a column nobody filters on
//     is cheap to move later — the reason `approval.request_json` and `task.cancellation_json` are shaped the same way.
//   - **A stored state this build does not know is an error, not a string.** SQLite stores any `TEXT` in a `CHECK`ed
//     column when the file was written by another build or edited by hand, and reading it back as an arbitrary outcome
//     would put a word in a client's hands that no scheduler produced — the failure `approvals.ts` refuses for the same
//     reason.
import type { JobPatch, JobStore, RunPatch } from "@crabby/agent-runtime";
import {
  CLIENT_INTERFACES,
  JOB_RUN_OUTCOMES,
  JOB_RUN_TRIGGERS,
  JOB_STATES,
  type JobRecord,
  type JobRunRecord,
  OPEN_RUN_OUTCOMES,
} from "@crabby/api-contracts";
import { type SqliteDb, transact } from "./db.ts";

export const JOB_TABLE = "job";
export const JOB_RUN_TABLE = "job_run";

const JOB_COLUMNS = `id, name, schedule, objective, state, session_id, client_id, client_name,
       client_interface, capability_json, utc_offset_minutes, created_at, updated_at, next_run_at,
       last_run_at, missed`;

const RUN_COLUMNS = `id, job_id, due_at, recorded_at, settled_at, outcome, triggered_by, task_id,
       reason, occurrences, acknowledged_at`;

interface JobRow {
  readonly id: string;
  readonly name: string;
  readonly schedule: string;
  readonly objective: string;
  readonly state: string;
  readonly session_id: string;
  readonly client_id: string;
  readonly client_name: string;
  readonly client_interface: string;
  readonly capability_json: string;
  readonly utc_offset_minutes: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly next_run_at: string | null;
  readonly last_run_at: string | null;
  readonly missed: number;
}

interface RunRow {
  readonly id: string;
  readonly job_id: string;
  readonly due_at: string;
  readonly recorded_at: string;
  readonly settled_at: string | null;
  readonly outcome: string;
  readonly triggered_by: string;
  readonly task_id: string | null;
  readonly reason: string | null;
  readonly occurrences: number;
  readonly acknowledged_at: string | null;
}

function oneOf<T extends string>(value: string, vocabulary: readonly T[], what: string): T {
  if (!(vocabulary as readonly string[]).includes(value)) {
    throw new Error(
      `${what} is stored as \`${value}\`, which is not one of ${vocabulary.join(", ")} — restore from backup or ` +
        "delete the row (`docs/DATA_AND_MEMORY.md` §8)",
    );
  }
  return value as T;
}

function toJob(row: JobRow): JobRecord {
  return {
    id: row.id,
    name: row.name,
    schedule: row.schedule,
    objective: row.objective,
    state: oneOf(row.state, JOB_STATES, `job ${row.id}'s state`),
    createdBy: {
      clientId: row.client_id,
      name: row.client_name,
      interface: oneOf(row.client_interface, CLIENT_INTERFACES, `job ${row.id}'s creator`),
    },
    capabilities: JSON.parse(row.capability_json) as string[],
    sessionId: row.session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.next_run_at === null ? {} : { nextRunAt: row.next_run_at }),
    ...(row.last_run_at === null ? {} : { lastRunAt: row.last_run_at }),
    missed: row.missed,
    utcOffsetMinutes: row.utc_offset_minutes,
  };
}

function toRun(row: RunRow): JobRunRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    dueAt: row.due_at,
    recordedAt: row.recorded_at,
    ...(row.settled_at === null ? {} : { settledAt: row.settled_at }),
    outcome: oneOf(row.outcome, JOB_RUN_OUTCOMES, `run ${row.id}'s outcome`),
    trigger: oneOf(row.triggered_by, JOB_RUN_TRIGGERS, `run ${row.id}'s trigger`),
    ...(row.task_id === null ? {} : { taskId: row.task_id }),
    ...(row.reason === null ? {} : { reason: row.reason }),
    occurrences: row.occurrences,
    ...(row.acknowledged_at === null ? {} : { acknowledgedAt: row.acknowledged_at }),
  };
}

export function createSqliteJobStore(db: SqliteDb): JobStore {
  const insertJob = db.prepare(
    `INSERT INTO job (id, name, schedule, objective, state, session_id, client_id, client_name,
                      client_interface, capability_json, utc_offset_minutes, created_at, updated_at,
                      next_run_at, last_run_at, missed)
     VALUES (@id, @name, @schedule, @objective, @state, @session_id, @client_id, @client_name,
             @client_interface, @capability_json, @utc_offset_minutes, @created_at, @updated_at,
             @next_run_at, @last_run_at, @missed)`,
  );
  // The whole mutable row, from the record read back inside the same call: one statement, and a `SET` list that cannot
  // reach the columns §4.5 puts beyond a patch. `next_run_at` takes `null` because a paused job has no next fire and the
  // absence is the fact `crabby job ls` prints.
  const updateJob = db.prepare(
    `UPDATE job
        SET name = @name, schedule = @schedule, state = @state, capability_json = @capability_json,
            next_run_at = @next_run_at, last_run_at = @last_run_at, missed = @missed,
            updated_at = @updated_at
      WHERE id = @id`,
  );
  const insertRun = db.prepare(
    `INSERT INTO job_run (id, job_id, due_at, recorded_at, settled_at, outcome, triggered_by,
                          task_id, reason, occurrences, acknowledged_at)
     VALUES (@id, @job_id, @due_at, @recorded_at, @settled_at, @outcome, @triggered_by,
             @task_id, @reason, @occurrences, @acknowledged_at)`,
  );
  // `COALESCE` on the three columns a reconciliation may have nothing to say about, so an update that closes a run cannot
  // erase the reason it was opened with or the task it fired.
  const updateRun = db.prepare(
    `UPDATE job_run
        SET outcome = @outcome, reason = COALESCE(@reason, reason),
            task_id = COALESCE(@task_id, task_id), settled_at = COALESCE(@settled_at, settled_at)
      WHERE id = @id`,
  );

  function jobRow(job: JobRecord) {
    return {
      id: job.id,
      name: job.name,
      schedule: job.schedule,
      objective: job.objective,
      state: job.state,
      session_id: job.sessionId,
      client_id: job.createdBy.clientId,
      client_name: job.createdBy.name,
      client_interface: job.createdBy.interface,
      capability_json: JSON.stringify(job.capabilities),
      utc_offset_minutes: job.utcOffsetMinutes,
      created_at: job.createdAt,
      updated_at: job.updatedAt,
      next_run_at: job.nextRunAt ?? null,
      last_run_at: job.lastRunAt ?? null,
      missed: job.missed,
    };
  }

  function runRow(run: JobRunRecord) {
    return {
      id: run.id,
      job_id: run.jobId,
      due_at: run.dueAt,
      recorded_at: run.recordedAt,
      settled_at: run.settledAt ?? null,
      outcome: run.outcome,
      triggered_by: run.trigger,
      task_id: run.taskId ?? null,
      reason: run.reason ?? null,
      occurrences: run.occurrences,
      acknowledged_at: run.acknowledgedAt ?? null,
    };
  }

  function readJob(id: string): JobRecord | undefined {
    const row = db.prepare(`SELECT ${JOB_COLUMNS} FROM job WHERE id = ?`).get(id) as
      | JobRow
      | undefined;
    return row === undefined ? undefined : toJob(row);
  }

  function readRun(id: string): JobRunRecord | undefined {
    const row = db.prepare(`SELECT ${RUN_COLUMNS} FROM job_run WHERE id = ?`).get(id) as
      | RunRow
      | undefined;
    return row === undefined ? undefined : toRun(row);
  }

  return {
    insert(job) {
      // `INSERT` and never `INSERT OR REPLACE`, for the reason the approval store gives: a colliding id is a bug in the
      // caller, and replacing a row would silently withdraw a timer somebody is looking at.
      insertJob.run(jobRow(job));
    },
    get: readJob,
    all() {
      // Insertion order, which is `rowid` and survives a restart, so the list a client reads at 09:00 is the same list in
      // the same order at 09:05 whatever the planner does with the indexes.
      const rows = db
        .prepare(`SELECT ${JOB_COLUMNS} FROM job ORDER BY rowid ASC`)
        .all() as JobRow[];
      return rows.map(toJob);
    },
    update(id, patch: JobPatch) {
      const current = readJob(id);
      if (current === undefined) return undefined;
      // Written column by column from the pair (patch, current) rather than by building a record and serialising it, so
      // that "clear the next fire" stays expressible: `nextRunAt: null` in the patch is `NULL` in the row, and a record
      // built by spread could only say it by omitting a field the type makes optional.
      updateJob.run({
        id,
        name: patch.name ?? current.name,
        schedule: patch.schedule ?? current.schedule,
        state: patch.state ?? current.state,
        capability_json: JSON.stringify(patch.capabilities ?? current.capabilities),
        next_run_at: patch.nextRunAt === undefined ? (current.nextRunAt ?? null) : patch.nextRunAt,
        last_run_at: patch.lastRunAt ?? current.lastRunAt ?? null,
        missed: patch.missed ?? current.missed,
        updated_at: patch.updatedAt,
      });
      return readJob(id);
    },
    insertRun(run) {
      insertRun.run(runRow(run));
    },
    updateRun(id, patch: RunPatch) {
      const current = readRun(id);
      if (current === undefined) return undefined;
      updateRun.run({
        id,
        outcome: patch.outcome ?? current.outcome,
        reason: patch.reason ?? null,
        task_id: patch.taskId ?? null,
        settled_at: patch.settledAt ?? null,
      });
      return readRun(id);
    },
    runsFor(jobId, limit) {
      const rows = db
        .prepare(
          `SELECT ${RUN_COLUMNS} FROM job_run WHERE job_id = ? ORDER BY due_at DESC, rowid DESC LIMIT ?`,
        )
        .all(jobId, limit) as RunRow[];
      return rows.map(toRun);
    },
    lastRun(jobId) {
      const row = db
        .prepare(`SELECT ${RUN_COLUMNS} FROM job_run WHERE job_id = ? ORDER BY rowid DESC LIMIT 1`)
        .get(jobId) as RunRow | undefined;
      return row === undefined ? undefined : toRun(row);
    },
    openRuns() {
      // One query rather than a scan of every job's history, because this is the read a tick does before it decides
      // anything, and the vocabulary it filters on is the contract's own rather than a second copy here.
      const open = OPEN_RUN_OUTCOMES;
      const placeholders = open.map(() => "?").join(", ");
      const rows = db
        .prepare(
          `SELECT ${RUN_COLUMNS} FROM job_run WHERE outcome IN (${placeholders}) ORDER BY rowid ASC`,
        )
        .all(...open) as RunRow[];
      return rows.map(toRun);
    },
    unacknowledgedMissed(jobId) {
      const rows = db
        .prepare(
          `SELECT ${RUN_COLUMNS} FROM job_run
            WHERE job_id = ? AND outcome = 'missed' AND acknowledged_at IS NULL
            ORDER BY rowid ASC`,
        )
        .all(jobId) as RunRow[];
      return rows.map(toRun);
    },
    acknowledgeMissed(jobId, at) {
      // One transaction, because C12-06's "the answer is recorded" is a single fact: a backlog half-acknowledged by a
      // crash between the two statements would be a question the user answers twice.
      return transact(db, () => {
        const rows = db
          .prepare(
            `SELECT occurrences FROM job_run
              WHERE job_id = ? AND outcome = 'missed' AND acknowledged_at IS NULL`,
          )
          .all(jobId) as { occurrences: number }[];
        const total = rows.reduce((sum, row) => sum + row.occurrences, 0);
        db.prepare(
          `UPDATE job_run SET acknowledged_at = ?
            WHERE job_id = ? AND outcome = 'missed' AND acknowledged_at IS NULL`,
        ).run(at, jobId);
        return total;
      });
    },
    acknowledgeRun(runId, at) {
      // One row, and only a still-unacknowledged `missed` one: D-133's `each` chain answers an occurrence when it fires,
      // and a second answer for the same row (a retried backlog request) finds nothing left to answer.
      const changed = db
        .prepare(
          `UPDATE job_run SET acknowledged_at = ?
            WHERE id = ? AND outcome = 'missed' AND acknowledged_at IS NULL`,
        )
        .run(at, runId);
      return changed.changes > 0;
    },
    deleteJob(id, withHistory) {
      return transact(db, () => {
        // The history rows go only when asked: W16-11's sentence is that past runs are work which already happened, and
        // D-065's rule about not erasing it does not stop being true because the row that scheduled it is going. Since
        // v15 the table has no job foreign key to cascade on — v5's did, and the delete route would have erased the
        // history by default — so the survivor rows read as the history they are.
        if (withHistory) db.prepare("DELETE FROM job_run WHERE job_id = ?").run(id);
        const changed = db.prepare("DELETE FROM job WHERE id = ?").run(id);
        return changed.changes > 0;
      });
    },
  };
}
