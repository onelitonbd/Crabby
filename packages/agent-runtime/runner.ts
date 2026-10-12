// The runner: the party that turns "a task exists" into "a task is being run", and the only party that knows which
// tasks are in flight in *this* process. `AGENT_RUNTIME.md` §4.4 splits ownership — the lifecycle belongs to the Task
// Manager and the transition rules to `transitions.ts` — and this is the half that was missing. The loop can drive one
// task, the cancellation manager can stop one, the checkpoint manager can save one, and none of them can answer
// "is this task already running?", which is the question every second interface asks.
//
// It lands in this package rather than in the Gateway for the reason the package index gives: "a rule the Gateway owns
// is a rule only the Gateway can follow" (D-003). **One run per task** is exactly such a rule — four clients over one
// Gateway is the product's whole shape, so a second `POST /tasks` for a moving task, a `resume` racing a run that is
// already awake, and a shutdown that abandons a step all have to be answered by something that is not a route.
//
// What this file does *not* do is write. Every state change here is the loop's or the cancellation manager's, both of
// which own their own transaction and their own event, so there is one writer per fact (§9's invariant, and the reason
// a runner that "helpfully" moved a task to `running` would be a second opinion about the same state). The runner's
// own bookkeeping is two maps that no reader outside this process can see, and it is deliberately weaker than the
// journal: after a restart both are empty, and the honest consequence is that a task parked at an approval cannot be
// resumed by this process — which is F-47's remaining half, answered below rather than papered over.

import type { Event } from "@crabby/api-contracts";
import type { Logger } from "@crabby/core";
import type { EvalContext, PlatformFactsLike } from "@crabby/policy";
import type { Provider } from "@crabby/providers";
import type { Approvals } from "./approvals.ts";
import type { Cancellation, CancellationResult, RequestInput } from "./cancellation.ts";
import type { CheckpointGate } from "./checkpoint.ts";
import type { TaskJournal } from "./journal.ts";
import {
  createLoop,
  type LoopLimits,
  type LoopOutcome,
  type LoopSubject,
  type RunOrigin,
  type SuspendedRun,
  type ToolSurface,
} from "./loop.ts";

export interface RunnerDeps {
  readonly journal: TaskJournal;
  readonly approvals: Approvals;
  readonly provider: Provider;
  readonly tools: ToolSurface;
  /** §4.1's `availability` predicate needs a fact this package must not read from `process.env`, so it arrives the way
   *  it arrives for the loop. */
  readonly platform: PlatformFactsLike;
  readonly publish: (event: Event) => void;
  /** The *same* manager the caller's cancel route uses, never a second one: §6.1's step 2 (stop scheduling new steps)
   *  and §6.2's evidence have to be about one request, and two managers would each hold half of it. */
  readonly cancellation: Cancellation;
  readonly checkpoints?: CheckpointGate | undefined;
  readonly limits?: Partial<LoopLimits> | undefined;
  /** §3.6's selection, resolved from `config.json` by the composition root (D-101). `RunInput.modelId` states the rule
   *  this obeys: the caller resolves it and the loop does not choose, because §3.1's third rule is that a provider must
   *  not be able to alter a task's permissions — and a loop that picked its own model would be one step from that. */
  readonly modelId: string;
  /** The half of `EvalContext` that is a fact about the install rather than about the identity asking: workspace roots,
   *  the egress allow-list, the symlink resolver. `grants` arrives per run, from the identity that created the task. */
  readonly ctx: Omit<EvalContext, "grants">;
  readonly log?: Logger | undefined;
  readonly now?: (() => number) | undefined;
}

export interface StartInput {
  readonly taskId: string;
  readonly subject: LoopSubject;
  readonly correlationId?: string | undefined;
  /** The identity the run belongs to, handed to every tool this run executes (`RunOrigin`). Optional for the reason the
   *  loop's own field is: a harness has no identity to record, and a run started by the scheduler carries the job's
   *  creator rather than the process's. */
  readonly origin?: RunOrigin | undefined;
}

export type StartCode = "in-flight" | "parked" | "not-found" | "failed";

export type StartResult =
  | { readonly ok: true; readonly taskId: string; readonly run: Promise<LoopOutcome> }
  | { readonly ok: false; readonly code: StartCode; readonly reason: string };

/** What `resume` answers, and the reason it is not the same type as `start`: a resume that finds nothing parked is not
 *  a failure of the caller's, it is a fact about this process, and the sentence has to say which. */
export type ResumeResult =
  | { readonly ok: true; readonly taskId: string; readonly run: Promise<LoopOutcome> }
  | {
      readonly ok: false;
      readonly code: "in-flight" | "not-parked" | "not-found";
      readonly reason: string;
    };

/** D-066's drain, as a report rather than a promise that everything stopped. `abandoned` are the runs still moving when
 *  the budget ran out; they are *not* cancelled here, because §7.1's recovery marks every non-terminal task
 *  `interrupted` on the next start and a shutdown that also wrote `cancelled` would be two parties settling one task. */
export interface ShutdownReport {
  readonly drained: number;
  readonly abandoned: readonly string[];
  /** Runs parked at an approval when the process ended. A pending request survives in the database and expires under
   *  D-064's window; the *run* does not survive, which is the fact `resume` reports after a restart. */
  readonly parked: readonly string[];
}

export interface Runner {
  start(input: StartInput): StartResult;
  resume(taskId: string): ResumeResult;
  /** §6.1, delegated whole: the manager owns the request row, the event, the abort and the settle. A runner that
   *  re-implemented any of it would be a second writer of the same fact. */
  cancel(input: RequestInput): CancellationResult;
  /** Runs moving in this process. Not the same number as `cancellation.outstanding()`, which counts tasks with a
   *  controller — a task can have one and be parked at an approval with nothing in flight. */
  outstanding(): number;
  inFlight(taskId: string): boolean;
  parkedFor(taskId: string): SuspendedRun | undefined;
  shutdown(budgetMs: number): Promise<ShutdownReport>;
}

export function createRunner(deps: RunnerDeps): Runner {
  const now = deps.now ?? ((): number => Date.now());
  const loop = createLoop({
    journal: deps.journal,
    approvals: deps.approvals,
    provider: deps.provider,
    tools: deps.tools,
    platform: deps.platform,
    publish: deps.publish,
    cancellation: deps.cancellation,
    ...(deps.checkpoints === undefined ? {} : { checkpoints: deps.checkpoints }),
    ...(deps.limits === undefined ? {} : { limits: deps.limits }),
    now,
  });

  /** One run per task, as two maps rather than one, because "moving" and "waiting for a human" are different facts with
   *  different answers: a task in `running` refuses a second start and can be cancelled; a task in `parked` refuses a
   *  start, is resumed by an approval decision, and has nothing in flight for §6.1's step 2 to stop. */
  const running = new Map<string, Promise<LoopOutcome>>();
  const parked = new Map<string, SuspendedRun>();
  let draining = false;

  /** Registered *before* the first `await` inside it, which is the bug M2l's adapter taught: a run that becomes visible
   *  only after its first suspension is a run a second caller can start twice. */
  function launch(taskId: string, begin: () => Promise<LoopOutcome>): Promise<LoopOutcome> {
    // `begin()` is called synchronously, in a `try`, for two reasons that pull in opposite directions. Synchronous, so
    // the loop reaches its own first `await` — and therefore `cancellation.signalFor`, which creates the controller —
    // before `start` returns: a cancel issued in the same tick as a start has to find something to stop rather than
    // race a run that has not begun. In a `try`, because evaluating a run's arguments can throw (a dep that is not what
    // it claims to be) and a synchronous throw out of `start()` would reach the caller as an exception rather than as
    // an answer. Registration below is synchronous either way, which is the property that makes "one run per task"
    // true: a second `start` sees this run before the loop's first `await`.
    let begun: Promise<LoopOutcome>;
    try {
      begun = begin();
    } catch (error) {
      begun = Promise.reject(error);
    }
    const run = begun.then(
      (outcome) => settleWith(taskId, outcome),
      (error: unknown) => {
        // The loop catches its own failures and answers `failed`, so a throw here is a bug in this file or in a
        // manager it called. It is logged and answered rather than left to become an unhandled rejection, because a
        // rejection nobody owns takes the Gateway down with it — and a dead Gateway is a worse answer than a failed
        // task. The task is *not* moved: writing a state this runner cannot justify is the one thing §4.4 forbids it.
        const reason = error instanceof Error ? error.message : String(error);
        deps.log?.error("run threw", { taskId, reason });
        running.delete(taskId);
        return {
          kind: "refused",
          task: deps.journal.task(taskId),
          code: "runner.threw",
          reason: `the run ended in an exception rather than an outcome: ${reason}`,
        } satisfies LoopOutcome;
      },
    );
    running.set(taskId, run);
    return run;
  }

  function settleWith(taskId: string, outcome: LoopOutcome): LoopOutcome {
    running.delete(taskId);
    if (outcome.kind === "awaiting-approval") {
      // Parked, not running: the step is committed, the prompt is open, and the only thing that can move this task is
      // an answer. Holding the `SuspendedRun` is what makes `resume` possible at all, and losing it at a restart is
      // what makes the honest answer below necessary.
      parked.set(taskId, outcome.run);
      deps.log?.debug("run parked at an approval", { taskId, approvalId: outcome.run.approvalId });
      return outcome;
    }
    parked.delete(taskId);
    deps.log?.debug("run ended", { taskId, kind: outcome.kind });
    return outcome;
  }

  function start(input: StartInput): StartResult {
    if (draining) {
      return {
        ok: false,
        code: "failed",
        reason:
          "this Gateway is draining for shutdown (D-066), so it is not accepting runs; a task created now is recorded " +
          "and §7.1's recovery picks it up on the next start",
      };
    }
    if (running.has(input.taskId)) {
      return {
        ok: false,
        code: "in-flight",
        reason: `task ${input.taskId} is already running in this process; one task has one run (§4.4)`,
      };
    }
    const suspended = parked.get(input.taskId);
    if (suspended !== undefined) {
      return {
        ok: false,
        code: "parked",
        reason:
          `task ${input.taskId} is waiting on approval ${suspended.approvalId}, and answering it continues the run that ` +
          "is already parked — a second run of one task would spend the same step twice (§4.4, D-052's `scope: once`)",
      };
    }
    if (deps.journal.task(input.taskId) === undefined) {
      return {
        ok: false,
        code: "not-found",
        reason: `no task ${input.taskId} in the journal, so there is nothing to run`,
      };
    }
    const run = launch(input.taskId, () =>
      loop.start({
        taskId: input.taskId,
        modelId: deps.modelId,
        subject: input.subject,
        // `grants` twice is not a mistake: `EvalContext.grants` is what escalation reads to decide whether a restricted
        // client may be pushed into an approval it cannot answer (D-060), and `LoopSubject.grants` is what policy
        // evaluates against. One identity, two readers, and a runner that supplied only one would silently widen or
        // narrow the other.
        ctx: { ...deps.ctx, grants: input.subject.grants },
        // `signalFor` creates the controller on first ask, so asking here is also how the cancellation manager learns
        // that something is in flight — which is what lets it tell "nothing to stop" from "a step is moving".
        signal: deps.cancellation.signalFor(input.taskId),
        ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
        ...(input.origin === undefined ? {} : { origin: input.origin }),
      }),
    );
    return { ok: true, taskId: input.taskId, run };
  }

  function resume(taskId: string): ResumeResult {
    if (running.has(taskId)) {
      return {
        ok: false,
        code: "in-flight",
        reason: `task ${taskId} is already running in this process, so there is nothing parked to wake`,
      };
    }
    const suspended = parked.get(taskId);
    if (suspended === undefined) {
      // The honest answer after a restart, and the reason F-47 stays open rather than closing here. The approval row
      // survived — it is in the database, and `loop.resume` would spend it — but the run that was going to spend it did
      // not: `SuspendedRun` carries the proposed `ToolCall` in memory, and SECURITY.md §7 keeps `call.args` out of the
      // checkpoint, so there is nothing to rebuild it from. D-065's verdict for a step killed at a prompt boundary is
      // `re-ask`, and re-asking needs a provider round this build does not start on a recovered task.
      const task = deps.journal.task(taskId);
      if (task === undefined) {
        return { ok: false, code: "not-found", reason: `no task ${taskId} in the journal` };
      }
      return {
        ok: false,
        code: "not-parked",
        reason:
          `no run of task ${taskId} is parked in this process. The run that opened its approval lived in the memory of ` +
          "the process that started it, and §7 keeps `call.args` out of the checkpoint, so a restarted Gateway cannot " +
          "rebuild it — D-065's verdict for that boundary is `re-ask`, and `POST /tasks/{id}/resume` " +
          "(docs/INTERFACES_AND_API.md §4.3) is not in this build (docs/CONSISTENCY_REVIEW.md F-47)",
      };
    }
    parked.delete(taskId);
    const run = launch(taskId, () => loop.resume(suspended));
    return { ok: true, taskId, run };
  }

  return {
    start,
    resume,
    cancel: (input) => deps.cancellation.request(input),
    outstanding: () => running.size,
    inFlight: (taskId) => running.has(taskId),
    parkedFor: (taskId) => parked.get(taskId),
    async shutdown(budgetMs) {
      draining = true;
      const started = [...running.keys()];
      if (started.length > 0) {
        // D-066's budget, spent waiting rather than killing: a step that is mid-write when the process ends is §7.3's
        // uncertain case, and the difference between "we waited 5 s" and "we cut it off" is the difference between a
        // drain and a crash. What is still moving when the budget ends is reported, and §7.1's recovery owns it.
        await Promise.race([
          Promise.allSettled([...running.values()]),
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, Math.max(0, budgetMs));
            // The timer must not hold the process open past its own budget, which is what an exit path is waiting on.
            timer.unref?.();
          }),
        ]);
      }
      const abandoned = [...running.keys()];
      return {
        drained: started.length - abandoned.length,
        abandoned,
        parked: [...parked.keys()],
      };
    },
  };
}
