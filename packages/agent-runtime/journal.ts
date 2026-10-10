// The write-phase discipline, in one place, because two modules now need it and a second copy is how the two drift:
// `loop.ts` drives a task and `cancellation.ts` settles one, and both write the task's state beside the events that
// carry it. What they must not do — and what this file makes hard to do — is write one without the other, publish before
// the commit, or ask a task record it read before an `await`.
//
// The three rules are `AGENT_RUNTIME.md` §5.1's, stated there for the arbiter and true of every runtime write:
//
//   - **A state change and its event are one transaction.** `transition()` (D-083) is asked first and its answer is
//     written as both halves, so "the row says cancelled and the log says nothing" is not a reachable state.
//   - **Publishing happens after the commit, never inside it.** A subscriber that learned about a write a rollback later
//     took back is a client that has to be told the opposite, and §5.4 has no frame for that.
//   - **A transaction is synchronous.** `packages/storage`'s `transact` wraps better-sqlite3, which cannot span an
//     `await`, so effects (a provider call, a tool run) belong between phases and never inside one.
//
// The seam is `TaskJournal`: four methods, all synchronous. `packages/storage` can implement them over
// `transact`/`setState`/`appendEvent` without distortion, and a harness can implement them over Maps — the same shape as
// the arbiter's `ApprovalStore` (D-084), and for the same reason: the runtime zone owns the abstraction, so an adapter
// imports it rather than the other way round (`ARCHITECTURE.md` §19).
import type {
  ErrorClass,
  Event,
  EventType,
  TaskCancellation,
  TaskRecord,
  TaskState,
} from "@crabby/api-contracts";
import { type TransitionEvidence, transition } from "./transitions.ts";

export interface JournalEventInput {
  readonly taskId: string;
  readonly type: EventType;
  readonly payload: Record<string, unknown>;
  readonly at: number;
  readonly correlationId?: string | undefined;
}

export interface TaskJournal {
  readonly task: (taskId: string) => TaskRecord | undefined;
  /** Writes the state the caller has already checked against `transition()`, plus the two things a record carries that an
   *  event cannot: the failure a client reads on `GET /tasks/{id}`, and §6.2's cancellation evidence (F-46). Omitting
   *  `error` clears whatever a previous state left, because that is what the columns do; omitting `cancellation` leaves
   *  what is there alone, because only the settle has an opinion about it. */
  readonly setState: (
    taskId: string,
    state: TaskState,
    record?: {
      error?: { code: string; message: string };
      cancellation?: TaskCancellation;
    },
  ) => void;
  /** Appends and returns the event with its `seq`, so the caller publishes the frame that was actually stored. */
  readonly append: (input: JournalEventInput) => Event;
  readonly transact: <T>(body: () => T) => T;
}

export type Emit = (type: EventType, payload: Record<string, unknown>, at: number) => void;

/** Typed, per `docs/DEVELOPMENT.md` §4: a §6 `code`, never a string. Thrown only where the runtime's own invariants
 *  broke — a task that vanished mid-run, or a state move the machine refused — because those are bugs in this package and
 *  not conditions a caller can be told how to fix. Throwing *inside* a phase is deliberate: the transaction rolls back,
 *  so a refused move leaves nothing half-written. */
export class RuntimeError extends Error {
  readonly code: string;
  readonly class: ErrorClass;
  constructor(input: { code: string; message: string; class?: ErrorClass }) {
    super(input.message);
    this.name = "RuntimeError";
    this.code = input.code;
    this.class = input.class ?? "internal";
  }
}

/** What a move may write beside the state: the two record fields a client reads on `GET /tasks/{id}`, and the payload the
 *  event carries. Kept as a named type because three modules pass it and a fourth shape would be a fourth opinion. */
export interface MoveRecord {
  readonly error?: { code: string; message: string };
  /** §6.2's evidence, on the record as well as in the event (F-46). */
  readonly cancellation?: TaskCancellation;
  readonly payload?: Record<string, unknown>;
}

export interface FailedTask {
  readonly task: TaskRecord;
  readonly code: string;
  readonly reason: string;
}

export interface PhaseWriter {
  /** One transaction: every row and event this step owes, committed together and published after. The staged list is why
   *  `publish` cannot be called from inside `body`. */
  phase<T>(taskId: string, correlationId: string | undefined, body: (emit: Emit) => T): T;
  /** Asks the machine and writes both halves of the answer. `record.error` and `record.cancellation` are what
   *  `GET /tasks/{id}` shows; `record.payload` is what the event carries beside `from` and `to`. */
  move(
    task: TaskRecord,
    to: TaskState,
    evidence: TransitionEvidence,
    emit: Emit,
    at: number,
    record?: MoveRecord,
  ): void;
  /** Reads the record rather than trusting one a caller carried here: a provider call is an `await`, and another client
   *  can move a task during it. */
  currentTask(taskId: string): TaskRecord;
  /** The terminal failure both modules need: the move, the error on the record, and the event, in one phase. */
  failTask(
    taskId: string,
    code: string,
    reason: string,
    errorClass: ErrorClass,
    correlationId: string | undefined,
    extra?: Record<string, unknown>,
  ): FailedTask;
}

export function createPhaseWriter(deps: {
  readonly journal: TaskJournal;
  readonly publish: (event: Event) => void;
  readonly now: () => number;
}): PhaseWriter {
  const { journal, publish, now } = deps;

  function phase<T>(taskId: string, correlationId: string | undefined, body: (emit: Emit) => T): T {
    const staged: Event[] = [];
    const emit: Emit = (type, payload, at) => {
      staged.push(
        journal.append({
          taskId,
          type,
          payload,
          at,
          ...(correlationId === undefined ? {} : { correlationId }),
        }),
      );
    };
    const result = journal.transact(() => body(emit));
    for (const event of staged) publish(event);
    return result;
  }

  function move(
    task: TaskRecord,
    to: TaskState,
    evidence: TransitionEvidence,
    emit: Emit,
    at: number,
    record?: MoveRecord,
  ): void {
    const result = transition(task.state, to, evidence);
    if (!result.ok) {
      throw new RuntimeError({
        code: "runtime.transition_refused",
        message:
          `the runtime tried to move task ${task.id} from \`${result.from}\` to \`${result.to}\` and the state machine ` +
          `refused: ${result.reason}`,
      });
    }
    journal.setState(
      task.id,
      to,
      record === undefined || (record.error === undefined && record.cancellation === undefined)
        ? undefined
        : {
            ...(record.error === undefined ? {} : { error: record.error }),
            ...(record.cancellation === undefined ? {} : { cancellation: record.cancellation }),
          },
    );
    emit(result.event, { from: result.from, to: result.to, ...(record?.payload ?? {}) }, at);
  }

  function currentTask(taskId: string): TaskRecord {
    const task = journal.task(taskId);
    if (task === undefined) {
      throw new RuntimeError({
        code: "runtime.task_missing",
        message: `task ${taskId} is not in the journal; a pending approval is deleted with its task, and so is its run`,
      });
    }
    return task;
  }

  function failTask(
    taskId: string,
    code: string,
    reason: string,
    errorClass: ErrorClass,
    correlationId: string | undefined,
    extra: Record<string, unknown> = {},
  ): FailedTask {
    const at = now();
    const task = currentTask(taskId);
    phase(taskId, correlationId, (emit) => {
      move(task, "failed", {}, emit, at, {
        error: { code, message: reason },
        payload: { code, reason, class: errorClass, ...extra },
      });
    });
    return { task: currentTask(taskId), code, reason };
  }

  return { phase, move, currentTask, failTask };
}
