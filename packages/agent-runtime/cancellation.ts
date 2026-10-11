// M2e: §6's two halves, which the state machine could already refuse and nothing could yet produce. `transition()` has
// required §6.2's evidence for an entry into `cancelled` since D-083 — "entering `cancelled` without saying which of the
// two happened is refused, not defaulted" — and M2d's loop therefore stopped at `cancelling` and said out loud that the
// settle was not in that build. This is the settle, and the request that precedes it.
//
// §6.1's six steps map onto two methods, and the split is the document's own:
//
//   `request()` is steps 1 and 2 — record the request, and stop scheduling new execution steps for the task. The
//     recording is durable without a new table, which is a decision and not an omission: the task's state *is* the record
//     that survives a restart (`cancelling`, which §7.1 turns into `interrupted` and §7.2 then refuses to resume into
//     `running`), and the event log carries who asked, when, in which mode and why. What stays in process memory is the
//     only thing that cannot be durable — the `AbortController` for the run in flight.
//   `settle()` is steps 4 to 6 — capture the status, save what there is to save, and mark the task cancelled once the
//     permitted work has settled. Step 3, "allow the current step to finish when it can safely and reasonably do so", is
//     the loop's, because only the party running the step knows whether it finished: this manager decides *whether* to
//     wait, and `CancellationMode` is that decision.
//
// Two modes, because §6.2 requires both. `finish-step` is the default and is §6.1's policy: the in-flight step keeps the
// deadline it was already given (D-074's per-tool number, or the provider's absolute ceiling) and no second clock is
// invented for it. `immediate` is §6.2's safety-critical override — "MUST override the normal finish-current-step
// behavior when continuing an operation would create unacceptable harm or leak sensitive data" — and it aborts the
// in-flight call rather than waiting for it. Escalating from the first to the second is allowed and is recorded, because
// an override that a second request could not deliver would be an override in name only.
//
// What is deliberately NOT here: a cancellation *route*. Nothing in this build drives a task from the Gateway (M2d's
// header says why), so `POST /tasks/{id}/cancel` would be a verb with no run to stop — the surface arrives with the
// runner. §6.1's step 5 is honoured by reading rather than by writing: the loop commits D-065's boundary inside the phase
// that records each step (M2i), so this manager's job is to say in the settle event where the run stood when the user
// stopped it — and to say plainly when no boundary was ever committed, rather than implying one was written.
import {
  type CancellationInFlight,
  type ClientInterface,
  type Event,
  isTerminal,
  type TaskCancellation,
  type TaskRecord,
} from "@crabby/api-contracts";
import type { CheckpointReader } from "./checkpoint.ts";
import { createPhaseWriter, type PhaseWriter, type TaskJournal } from "./journal.ts";

// The mode *names* are the contract's, because `TaskCancellation.mode` and the body a cancellation route will someday
// validate have to agree with them — the same split `approvals.ts` makes for `ApprovalState`. §6.1's policy and §6.2's
// override are the two names; D-090 is the rule about what each one costs.
export type { CancellationMode } from "@crabby/api-contracts";

import type { CancellationMode } from "@crabby/api-contracts";

export interface CancellationRequest {
  readonly taskId: string;
  readonly mode: CancellationMode;
  readonly requestedAt: number;
  readonly byClientId?: string | undefined;
  readonly via?: ClientInterface | undefined;
  readonly reason?: string | undefined;
}

/** §6.2's two facts, plus the third one a reader needs to judge them. `terminated` is "the underlying operation was
 *  confirmed to stop", which is a stronger claim than "we stopped waiting for it" — the distinction the section exists
 *  to force. `effectsUncertain` is "an external action may already have taken effect", and D-089 says when the runtime
 *  must answer `true` rather than guess. `inFlight` is what the request interrupted, because a reader who cannot see
 *  that cannot disagree with either boolean. */
export interface CancellationEvidence {
  readonly terminated: boolean;
  readonly effectsUncertain: boolean;
  /** The contract's vocabulary, including `unknown` — which only §7's recovery can honestly supply, because a dead
   *  process cannot say what it was running (D-092). */
  readonly inFlight: CancellationInFlight;
  readonly step?: { readonly tool?: string; readonly ok?: boolean; readonly code?: string };
}

export type CancellationFailureCode =
  | "not-found"
  | "terminal"
  | "not-cancelling"
  | "already-settled";

export type CancellationResult =
  | {
      readonly ok: true;
      readonly request: CancellationRequest;
      readonly task: TaskRecord;
      /** True when this call moved the task to `cancelled`; false when the settle is the loop's to make. */
      readonly settled: boolean;
      /** True when a request was already recorded for this task, so the caller emits no second event: one cancellation
       *  is one fact, however many interfaces relay it. */
      readonly deduplicated?: boolean;
      /** True when an `immediate` request overrode an earlier `finish-step` one (§6.2's override sentence). */
      readonly escalated?: boolean;
    }
  | { readonly ok: false; readonly code: CancellationFailureCode; readonly reason: string };

export interface SettleInput {
  readonly taskId: string;
  readonly evidence: CancellationEvidence;
  readonly at?: number;
  readonly correlationId?: string | undefined;
}

export interface RequestInput {
  readonly taskId: string;
  readonly mode?: CancellationMode;
  readonly byClientId?: string;
  readonly via?: ClientInterface;
  readonly reason?: string;
  readonly at?: number;
  readonly correlationId?: string | undefined;
}

/** The half of the manager the loop consults, kept narrow so the loop cannot request or settle on a caller's behalf by
 *  accident: it asks whether a request exists, and it reports what the in-flight step did. */
export interface CancellationGate {
  requested(taskId: string): CancellationRequest | undefined;
  settle(input: SettleInput): CancellationResult;
}

export interface Cancellation extends CancellationGate {
  request(input: RequestInput): CancellationResult;
  /** The signal a runner passes to `loop.start()`. Created on first ask, so a task with no run has no controller and the
   *  manager can tell "nothing is in flight" from "something is". */
  signalFor(taskId: string): AbortSignal;
  outstanding(): readonly CancellationRequest[];
}

export interface CancellationDeps {
  readonly journal: TaskJournal;
  readonly publish: (event: Event) => void;
  /** §6.1's step 5 asks the runtime to save "the relevant task state and checkpoint information". The saving is the
   *  loop's — a boundary is committed inside the phase that records the step, and a second writer of that row is how a
   *  resume point comes to disagree with the log — so this manager only *reads* it, to say in the settle event where the
   *  run stood when the user stopped it. Optional because a settle with no manager wired still owes an honest sentence. */
  readonly checkpoints?: CheckpointReader | undefined;
  readonly now?: (() => number) | undefined;
}

export function createCancellation(deps: CancellationDeps): Cancellation {
  const now = deps.now ?? ((): number => Date.now());
  const { journal } = deps;
  const writer: PhaseWriter = createPhaseWriter({ journal, publish: deps.publish, now });
  const { phase, move } = writer;
  const requests = new Map<string, CancellationRequest>();
  const controllers = new Map<string, AbortController>();

  function controllerFor(taskId: string): AbortController | undefined {
    return controllers.get(taskId);
  }

  /** §6.1's step 5, as the sentence a user reads in the `task.cancelled` event. Three cases, and each is a different
   *  fact rather than a different wording: no manager wired (nothing was ever going to be saved), a manager and no
   *  boundary (the run never committed a step, so there is nothing to resume from and nothing external to repeat), and a
   *  boundary (saved, at this step, and still not resumable — §4.1 makes `cancelled` terminal and absorbing, which is the
   *  point of stopping work rather than an accident of it). */
  function checkpointLine(taskId: string): string {
    if (deps.checkpoints === undefined) {
      return "no checkpoint manager is wired to this run, so no saved state exists: a restart re-asks rather than resumes (D-065)";
    }
    const record = deps.checkpoints.latest(taskId);
    if (record === undefined) {
      return "no checkpoint was committed — the run never reached a step boundary, so there is no saved state and nothing external to repeat";
    }
    return (
      `saved at step ${record.step} (a \`${record.boundary}\` boundary, event seq ${record.lastSeq}, ` +
      `${new Date(record.writtenAt).toISOString()}); the task is now \`cancelled\`, which is terminal and absorbing ` +
      "(AGENT_RUNTIME.md §4.1), so nothing resumes from it"
    );
  }

  function requestPayload(request: CancellationRequest): Record<string, unknown> {
    return {
      mode: request.mode,
      requestedAt: new Date(request.requestedAt).toISOString(),
      ...(request.byClientId === undefined ? {} : { by: request.byClientId }),
      ...(request.via === undefined ? {} : { via: request.via }),
      ...(request.reason === undefined ? {} : { reason: request.reason }),
    };
  }

  function request(input: RequestInput): CancellationResult {
    const at = input.at ?? now();
    const task = journal.task(input.taskId);
    if (task === undefined) {
      return {
        ok: false,
        code: "not-found",
        reason: `no task ${input.taskId} in the journal, so there is nothing to cancel`,
      };
    }
    // A recorded request outranks the terminal check, because the state it produced *is* the record: a phone that
    // double-taps cancel is relaying one fact, and answering the second tap with "terminal and absorbing" would read as a
    // refusal of something that already happened.
    if (isTerminal(task.state) && requests.get(task.id) === undefined) {
      // §4.1: the three terminal states are absorbing, and §6 is about stopping work rather than rewriting an outcome.
      // "Cancel a completed task" is a deletion or a new task, and saying so is the difference between a refusal and a
      // silent no-op.
      return {
        ok: false,
        code: "terminal",
        reason:
          `task ${task.id} is \`${task.state}\`, which is terminal and absorbing (AGENT_RUNTIME.md §4.1): its outcome ` +
          "is recorded and cancellation does not rewrite it",
      };
    }
    const existing = requests.get(task.id);
    if (existing !== undefined) {
      // §6.2's override has to be deliverable by a second request, or "MUST override" is advice — but only while there is
      // something to override. Once the task has settled, an escalation would write an event about stopping work that has
      // already stopped, so a settled task is answered with the request it has. Anything else about a repeat is the same
      // fact again, and a second event would tell every client that the user asked twice.
      if (
        existing.mode === "immediate" ||
        input.mode !== "immediate" ||
        task.state === "cancelled"
      ) {
        return {
          ok: true,
          request: existing,
          task,
          settled: task.state === "cancelled",
          deduplicated: true,
        };
      }
      const escalated: CancellationRequest = { ...existing, mode: "immediate" };
      requests.set(task.id, escalated);
      controllerFor(task.id)?.abort();
      phase(task.id, input.correlationId, (emit) => {
        emit(
          "task.progress",
          {
            cancellation: "escalated",
            ...requestPayload(escalated),
            reason:
              input.reason ??
              "a safety-critical intervention overrides finish-the-current-step (AGENT_RUNTIME.md §6.2)",
          },
          at,
        );
      });
      return { ok: true, request: escalated, task, settled: false, escalated: true };
    }

    const request_: CancellationRequest = {
      taskId: task.id,
      mode: input.mode ?? "finish-step",
      requestedAt: at,
      ...(input.byClientId === undefined ? {} : { byClientId: input.byClientId }),
      ...(input.via === undefined ? {} : { via: input.via }),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    };
    requests.set(task.id, request_);
    phase(task.id, input.correlationId, (emit) => {
      // Step 1 and step 2 of §6.1 in one commit: the state says a cancellation was requested, and the event says who
      // asked, in which mode, and why. `transition()` supplies `task.state.changed`, so no second event type is invented
      // for a request — §5.2's family already carries it and `task.cancelled` is the settle.
      if (task.state !== "cancelling") {
        move(task, "cancelling", {}, emit, at, {
          // §6.1's step 1 on the record and not only in the log, so §7.1's recovery can honour a request whose process is
          // gone (D-092). The evidence fields stay absent: they do not exist until the step settles.
          cancellation: {
            mode: request_.mode,
            requestedAt: new Date(at).toISOString(),
            ...(request_.byClientId === undefined ? {} : { by: request_.byClientId }),
            ...(request_.reason === undefined ? {} : { reason: request_.reason }),
          },
          payload: requestPayload(request_),
        });
      } else {
        emit("task.progress", { cancellation: "recorded", ...requestPayload(request_) }, at);
      }
    });

    if (request_.mode === "immediate") controllerFor(task.id)?.abort();

    // Nothing is in flight when no run holds a controller, or when the task has not started or is waiting on a human — a
    // prompt is not an execution step, so there is no step to finish and §6.1's step 6 applies at once.
    const inFlight = controllerFor(task.id) !== undefined;
    const waiting = task.state === "queued" || task.state === "awaiting_approval";
    if (!inFlight || waiting) {
      const settled = settle({
        taskId: task.id,
        at,
        correlationId: input.correlationId,
        evidence: {
          terminated: true,
          effectsUncertain: false,
          inFlight: "none",
        },
      });
      return settled.ok ? { ...settled, request: request_ } : settled;
    }
    return { ok: true, request: request_, task: writer.currentTask(task.id), settled: false };
  }

  function settle(input: SettleInput): CancellationResult {
    const at = input.at ?? now();
    const task = journal.task(input.taskId);
    if (task === undefined) {
      return {
        ok: false,
        code: "not-found",
        reason: `no task ${input.taskId} in the journal, so there is nothing to settle`,
      };
    }
    if (task.state === "cancelled") {
      const recorded = requests.get(task.id);
      return recorded === undefined
        ? {
            ok: false,
            code: "already-settled",
            reason: `task ${task.id} is already \`cancelled\`, and this manager recorded no request for it`,
          }
        : { ok: true, request: recorded, task, settled: true, deduplicated: true };
    }
    if (task.state !== "cancelling") {
      // §4.1 gives `cancelled` exactly one way in, and this is the manager honouring it: a task nobody asked to cancel is
      // not this module's to end, and a settle from `running` would be the runtime cancelling work on its own initiative.
      return {
        ok: false,
        code: "not-cancelling",
        reason:
          `task ${task.id} is \`${task.state}\`, and \`cancelled\` is reachable only from \`cancelling\` ` +
          "(AGENT_RUNTIME.md §4.1, D-083): record the request first",
      };
    }
    const recorded = requests.get(task.id);
    const { evidence } = input;
    // F-46's fix: §6.2 says the uncertainty is recorded "on the task", and an event is not the task. So one phase writes
    // both — the record a client reads when it polls `GET /tasks/{id}`, and the event that says when it happened — and a
    // reader of either gets the two booleans, the mode, who asked, and what was in flight.
    const onRecord: TaskCancellation = {
      mode: recorded?.mode ?? "finish-step",
      requestedAt: new Date(recorded?.requestedAt ?? at).toISOString(),
      settledAt: new Date(at).toISOString(),
      terminated: evidence.terminated,
      effectsUncertain: evidence.effectsUncertain,
      inFlight: evidence.inFlight,
      ...(recorded?.byClientId === undefined ? {} : { by: recorded.byClientId }),
      ...(recorded?.reason === undefined ? {} : { reason: recorded.reason }),
    };
    phase(task.id, input.correlationId, (emit) => {
      move(task, "cancelled", { cancellation: evidence }, emit, at, {
        cancellation: onRecord,
        payload: {
          // §6.2's requirement is that the uncertainty is recorded *on the task*, so it travels with the event and with
          // the record rather than living only in the outcome a caller happened to keep.
          terminated: evidence.terminated,
          effectsUncertain: evidence.effectsUncertain,
          inFlight: evidence.inFlight,
          ...(evidence.step === undefined ? {} : { step: evidence.step }),
          ...(recorded === undefined ? {} : requestPayload(recorded)),
          // §6.1's step 5 asks for checkpoint information, and the honest answer differs by what the run reached: a
          // boundary that was committed and is now terminal, or no boundary at all. Omitting the field would read as
          // "there was nothing to save", which is a claim this manager is not entitled to make without looking.
          checkpoint: checkpointLine(task.id),
        },
      });
    });
    controllers.delete(task.id);
    return {
      ok: true,
      request: recorded ?? {
        taskId: task.id,
        // A settle with no recorded request is possible — a run aborted by its own deadline, or a caller that moved the
        // task to `cancelling` directly — and the evidence still has to be written down. Inventing a requester would be
        // worse than showing that there was none.
        mode: "finish-step",
        requestedAt: at,
      },
      task: writer.currentTask(task.id),
      settled: true,
    };
  }

  return {
    request,
    settle,
    requested: (taskId) => requests.get(taskId),
    signalFor: (taskId) => {
      const existing = controllerFor(taskId);
      if (existing !== undefined) return existing.signal;
      const controller = new AbortController();
      controllers.set(taskId, controller);
      return controller.signal;
    },
    outstanding: () =>
      [...requests.values()].filter((entry) => journal.task(entry.taskId)?.state === "cancelling"),
  };
}
