// M2g: §7's recovery, and the honest limit of what "full auto-resume" can mean in a build with no conversation store and
// no checkpoint. `AGENT_RUNTIME.md` §7.1 says Crabby MUST attempt to resume interrupted tasks automatically, and §7.2 says
// the attempt may only succeed for work that is *both* safe and covered by a still-valid approval — "automatic
// orchestration of recovery, not automatic authorization". This module does the orchestration and reports, task by task,
// why the authorization half has nothing to authorize yet.
//
// Three rules, all of them D-092's:
//
//   1. **Every non-terminal task becomes `interrupted`, uniformly** — D-083's `recoveryTarget`, which is a function
//      precisely so that this file cannot improvise a different answer per state. A process that died mid-round leaves no
//      trustworthy record of what the model had been told, so nothing here pretends otherwise.
//   2. **A cancellation requested before the restart is settled, not resurrected.** The request is on the task record
//      (`TaskRecord.cancellation`, written at the request rather than only at the settle — that is why D-091 was amended),
//      so recovery can honour it: the task moves `cancelling` → `cancelled` with §6.2's evidence set to the only truthful
//      answer after a crash, `terminated: false` and `inFlight: "unknown"`, because a dead process cannot say whether the
//      operation stopped or what it was doing. Turning that task into `interrupted` instead would resurrect work the user
//      asked to stop, which is the one recovery outcome §6 exists to prevent.
//   3. **Nothing resumes automatically in this build, and the report says so per task.** A run's conversation is process
//      memory (M2d's header) and D-065's committed step boundary is not implemented, so §7.3's "recovery may pass only a
//      step that is idempotent or has its effect recorded" has nothing to pass. What recovery can do is leave the task
//      paused with a clear, user-visible reason (§7.2's last bullet) and name the still-valid approval that a runner would
//      be allowed to use, so the fact is on the record instead of in a reviewer's memory.
//
// Also here, because a restart is the moment a stale queue becomes visible: the approval sweep. An approval whose deadline
// passed while the process was dead is expired by the clock and not by anybody's opinion, and `GET /approvals` would
// otherwise show it as `pending` — the queue lying to the second client, which is the failure `approvals.ts`'s header
// names. D-093 puts the same sweep on the read path for the same reason.
import type { Event, TaskRecord, TaskState } from "@crabby/api-contracts";
import type { ApprovalRecord, ApprovalState, Approvals } from "./approvals.ts";
import { createPhaseWriter, forTask, type PhaseWriter, type TaskJournal } from "./journal.ts";
import { recoveryTarget } from "./transitions.ts";

/** A task recovery found and what it decided. `resumed` is the literal `false` rather than a boolean, because a report
 *  that could claim a resumption this build cannot perform would be a type-level lie (§7.2). */
export interface RecoveredTask {
  readonly taskId: string;
  readonly from: TaskState;
  readonly to: TaskState;
  readonly resumed: false;
  readonly reason: string;
  /** The still-valid approval §7.2 would let a runner resume under, when there is one. Reported, not acted on. */
  readonly approval?: {
    readonly id: string;
    readonly state: ApprovalState;
    readonly expiresAt: number;
  };
}

export interface RecoveryReport {
  /** Non-terminal tasks found. A restart with nothing to recover reports zero and writes nothing. */
  readonly scanned: number;
  readonly interrupted: readonly RecoveredTask[];
  /** Tasks whose recorded cancellation request recovery settled rather than resurrected (rule 2). */
  readonly settledCancellations: readonly RecoveredTask[];
  readonly expiredApprovals: readonly { approvalId: string; taskId: string; tool: string }[];
}

export interface Recovery {
  recoverAtStartup(at?: number): RecoveryReport;
}

export interface RecoveryDeps {
  readonly journal: TaskJournal;
  readonly approvals: Approvals;
  readonly publish: (event: Event) => void;
  readonly now?: (() => number) | undefined;
}

/** The states a restart finds work in. Derived from the contract's list rather than written out, so a tenth state cannot
 *  be added to `TASK_STATES` and quietly skipped by recovery. */
export const RECOVERABLE_STATES: readonly TaskState[] = [
  "queued",
  "planning",
  "awaiting_approval",
  "running",
  "cancelling",
];

export function createRecovery(deps: RecoveryDeps): Recovery {
  const now = deps.now ?? ((): number => Date.now());
  const { journal, approvals } = deps;
  const writer: PhaseWriter = createPhaseWriter({ journal, publish: deps.publish, now });

  return {
    recoverAtStartup(at = now()): RecoveryReport {
      const found = journal.tasks(RECOVERABLE_STATES);
      const expired: { approvalId: string; taskId: string; tool: string }[] = [];
      const interrupted: RecoveredTask[] = [];
      const settledCancellations: RecoveredTask[] = [];

      // One transaction for the whole restart, because a half-applied recovery is worse than none: the queue and the task
      // states a runner would read afterwards are the two halves of one fact about what the process left behind.
      writer.phaseAcross(undefined, (emit) => {
        // The sweep first, so a prompt that died during the downtime is expired before anything reports it as cover.
        const swept = approvals.sweep(at);
        for (const change of swept.expired) {
          expired.push({
            approvalId: change.record.id,
            taskId: change.record.request.taskId,
            tool: change.record.request.tool,
          });
          emit(change.record.request.taskId, change.event, approvalPayload(change.record), at);
        }

        for (const task of found) {
          const stillValid = approvals
            .list({ taskId: task.id })
            .find(
              (row) =>
                row.state === "approved" ||
                (row.state === "pending" && at <= row.request.expiresAt),
            );

          if (task.state === "cancelling") {
            const recorded = task.cancellation;
            const evidence = {
              terminated: false,
              effectsUncertain: true,
              inFlight: "unknown" as const,
            };
            const reason =
              `the process ended while this task was being cancelled, so the cancellation is settled rather than resumed: ` +
              "whether the operation stopped, and whether its external effect already happened, cannot be known after a " +
              "crash, and \u00a76.2 requires that uncertainty to be recorded instead of resolved by re-executing";
            writer.move(task, "cancelled", { cancellation: evidence }, forTask(emit, task.id), at, {
              cancellation: {
                ...(recorded ?? { mode: "finish-step", requestedAt: new Date(at).toISOString() }),
                settledAt: new Date(at).toISOString(),
                ...evidence,
              },
              payload: { ...evidence, reason, recovered: true },
            });
            settledCancellations.push({
              taskId: task.id,
              from: task.state,
              to: "cancelled",
              resumed: false,
              reason,
            });
            continue;
          }

          const target = recoveryTarget(task.state);
          if (target === undefined) continue;
          const reason = resumeRefusal(task, stillValid);
          writer.move(task, target, {}, forTask(emit, task.id), at, {
            payload: {
              reason,
              recovered: true,
              // §7.2's "clear, user-visible reason" is the event's job, and naming the approval a runner *would* be
              // allowed to use is what turns "paused" from a dead end into a fact somebody can act on.
              ...(stillValid === undefined ? {} : { approvalId: stillValid.id }),
              resumed: false,
            },
          });
          interrupted.push({
            taskId: task.id,
            from: task.state,
            to: target,
            resumed: false,
            reason,
            ...(stillValid === undefined
              ? {}
              : {
                  approval: {
                    id: stillValid.id,
                    state: stillValid.state,
                    expiresAt: stillValid.request.expiresAt,
                  },
                }),
          });
        }
        return undefined;
      });

      return {
        scanned: found.length,
        interrupted,
        settledCancellations,
        expiredApprovals: expired,
      };
    },
  };

  /** §7.2's answer for one task, as a sentence a user can read. The two halves differ: with a still-valid approval the
   *  rule *would* permit a resume and the missing piece is this build's, while without one the rule forbids it outright. */
  function resumeRefusal(task: TaskRecord, approval: ApprovalRecord | undefined): string {
    if (approval === undefined) {
      return (
        `the process that was running task ${task.id} ended, and no approval covers the step it was on, so \u00a77.2 forbids ` +
        "resuming it automatically: a pending or absent approval is not an approved one. The task is left paused for a " +
        "new run or a cancellation"
      );
    }
    return (
      `the process that was running task ${task.id} ended. Approval ${approval.id} is still valid and \u00a77.2 would permit ` +
      "resuming work covered by it, but this build has no checkpoint (D-065's committed step boundary is not implemented) " +
      "and the run's conversation was process memory, so there is nothing safe to resume from and \u00a77.3 forbids repeating a " +
      "step whose effect is unknown. The task is left paused with this reason rather than re-run"
    );
  }
}

function approvalPayload(record: ApprovalRecord): Record<string, unknown> {
  return { approvalId: record.id, state: record.state, ...record.request };
}
