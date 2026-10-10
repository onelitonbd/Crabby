// M2's first module: `AGENT_RUNTIME.md` §4.1's nine states as a *machine*, not a list. The states themselves live in
// `@crabby/api-contracts` and are deliberately not restated here (a contract that re-declares them becomes a second
// state machine — the note at the top of `packages/api-contracts/task.ts`), so this file owns exactly one thing: which
// move from one state to another is permitted, and what has to be true in the record before it is.
//
// Why the rules are data and not code comments: four interfaces and a recovery path all need to answer "may this task
// move?", and an answer that exists only in a reviewer's memory is how a runtime ends up marking a cancelled task
// `completed`. Every refusal below names the section it comes from, because a refusal an operator can read is the
// difference between a policy and a surprise (`docs/DEVELOPMENT.md` §14's sixth criterion, tested from the docs side).
import { isTerminal, TASK_STATES, type TaskState } from "@crabby/api-contracts";

/** The one entry per state, from `AGENT_RUNTIME.md` §4.1's lifecycle. An empty array means absorbing — the three
 *  terminal states, which §4.1 insists stay distinguishable forever after: "the runtime MUST distinguish successful
 *  completion from cancellation, failure, and incomplete execution". */
export const PERMITTED_TRANSITIONS = {
  // §3.1's Plan → Execute is the reason `running` is not reachable from `queued`: the only way into execution is
  // through a plan, so a task that skips `planning` would be an unexecuted idea with a green tick.
  queued: ["planning", "awaiting_approval", "cancelling", "failed", "interrupted"],
  planning: ["awaiting_approval", "running", "cancelling", "failed", "interrupted"],
  // §5's rules 1–2 and §7.2's "a pending approval MUST NOT be treated as approved": the only forward edge out of
  // `awaiting_approval` is an *answered* approval, and `transition()` refuses it without the answer in hand. A denial
  // that leaves other work possible re-plans (§5.4's rule, D-043's ladder) rather than dying here.
  awaiting_approval: ["running", "planning", "cancelling", "failed", "interrupted"],
  running: ["completed", "failed", "cancelling", "interrupted"],
  // §6.1's Finish-the-Current-Step: after the permitted step settles, the task is marked *cancelled*, never
  // `completed` — the step's output is captured as an event, and the task's outcome stays a cancellation.
  cancelling: ["cancelled", "failed", "interrupted"],
  completed: [],
  failed: [],
  cancelled: [],
  // §7.1 restores the latest valid state, and the edge into `running` exists in the table only because some recoveries
  // are covered by a still-valid approval; §7.2 is why `transition()` refuses that edge unless the record says so.
  // `completed` is not an option: a task that was interrupted did not complete.
  interrupted: ["queued", "planning", "awaiting_approval", "running", "cancelling", "failed"],
} as const satisfies Record<TaskState, readonly TaskState[]>;

/** What `transition()` needs besides two states, and only where a move is otherwise unverifiable. Both fields exist
 *  because §6.2 and §7.2 forbid the machine from *assuming* the thing they demand it record. */
export interface TransitionEvidence {
  /** §6.2: "the runtime MUST distinguish between a cancellation request and confirmed termination of the underlying
   *  operation", and where an external action may already have taken effect "that uncertainty MUST be recorded
   *  explicitly". So entering `cancelled` without saying which of the two happened is refused, not defaulted. */
  readonly cancellation?: {
    readonly terminated: boolean;
    readonly effectsUncertain: boolean;
  };
  /** §5's rule 5 and §7.2's second bullet: entering `running` out of `awaiting_approval` is the one edge that implies
   *  an answer, so the answer has to be in the record. */
  readonly approvalAnswered?: "approved" | "denied" | "expired";
  /** §7.2's first bullet: "only work that is both safe and already covered by an existing, still-valid approval may
   *  resume automatically". A recovery that cannot say that must route through `awaiting_approval` instead, which is
   *  why this field is an opt-in rather than a lookup the machine performs for you. */
  readonly resumeApprovalValid?: boolean;
}

export type TaskEventType =
  | "task.state.changed"
  | "task.completed"
  | "task.failed"
  | "task.cancelled"
  | "task.resumed"
  | "task.interrupted";

export type TransitionResult =
  | {
      readonly ok: true;
      readonly from: TaskState;
      readonly to: TaskState;
      /** The `task.*` event that carries this move (`docs/INTERFACES_AND_API.md` §5.2). A state change nobody can
       *  replay is a state change that will be re-done by the next client to look. */
      readonly event: TaskEventType;
      /** §6.2's uncertainty, kept beside the move rather than only in the event log, because the interface that shows
       *  "cancelled" has to be able to show "…and we cannot confirm whether it stopped". */
      readonly cancellation?: { readonly terminated: boolean; readonly effectsUncertain: boolean };
    }
  | {
      readonly ok: false;
      readonly from: TaskState;
      readonly to: TaskState;
      readonly reason: string;
    };

export function permittedFrom(state: TaskState): readonly TaskState[] {
  return PERMITTED_TRANSITIONS[state];
}

export function isKnownState(value: string): value is TaskState {
  return (TASK_STATES as readonly string[]).includes(value);
}

export function canTransition(from: TaskState, to: TaskState): boolean {
  return permittedFrom(from).includes(to);
}

/** The machine's only writer. It never mutates: a caller applies the result to its record and appends `event`, which
 *  is what keeps §4.4's boundary true — the state is the current fact, the event is the history, and neither is
 *  derived from the other by guesswork. */
export function transition(
  from: TaskState,
  to: TaskState,
  evidence: TransitionEvidence = {},
): TransitionResult {
  if (!isKnownState(from) || !isKnownState(to)) {
    return {
      ok: false,
      from,
      to,
      reason: `'${to}' is not a state in AGENT_RUNTIME.md §4.1's lifecycle`,
    };
  }
  if (isTerminal(from)) {
    return {
      ok: false,
      from,
      to,
      reason: `\`${from}\` is terminal and absorbing (AGENT_RUNTIME.md §4.1): a completed, failed or cancelled task does not resume, it is superseded by a new task`,
    };
  }
  if (from === to) {
    return {
      ok: false,
      from,
      to,
      reason: `\`${from}\` to \`${from}\` is not a transition; the record's \`updatedAt\` moves and its state does not (AGENT_RUNTIME.md §10.1)`,
    };
  }
  if (!canTransition(from, to)) {
    const allowed = permittedFrom(from);
    return {
      ok: false,
      from,
      to,
      reason:
        `\`${from}\` → \`${to}\` is not a permitted transition (AGENT_RUNTIME.md §4.1). ` +
        (allowed.length > 0
          ? `From \`${from}\` the permitted targets are: ${allowed.map((name) => `\`${name}\``).join(", ")}.`
          : `From \`${from}\` nothing is permitted.`),
    };
  }
  if (to === "cancelled" && evidence.cancellation === undefined) {
    return {
      ok: false,
      from,
      to,
      reason:
        "entering `cancelled` requires the record to say whether the underlying operation was confirmed to stop, and " +
        "whether its external effects may already have happened (AGENT_RUNTIME.md §6.2) — an uncertain outcome is written down, not defaulted",
    };
  }
  if (to === "running" && from === "awaiting_approval") {
    if (evidence.approvalAnswered === undefined) {
      return {
        ok: false,
        from,
        to,
        reason:
          "`awaiting_approval` → `running` needs the approval's answer in the record: a pending approval is not an " +
          "approved one (AGENT_RUNTIME.md §7.2, §5's rule 5)",
      };
    }
    if (evidence.approvalAnswered !== "approved") {
      return {
        ok: false,
        from,
        to,
        reason: `the approval was \`${evidence.approvalAnswered}\`, and a denial is respected rather than retried into an approval (AGENT_RUNTIME.md §5's rule 5)`,
      };
    }
  }

  if (to === "running" && from === "interrupted" && evidence.resumeApprovalValid !== true) {
    return {
      ok: false,
      from,
      to,
      reason:
        "recovering straight into `running` requires a still-valid approval covering the step in the record; " +
        "otherwise §7.2 sends the task through `awaiting_approval` — automatic orchestration is not automatic authorization",
    };
  }

  return {
    ok: true,
    from,
    to,
    event: eventFor(from, to),
    ...(evidence.cancellation === undefined ? {} : { cancellation: evidence.cancellation }),
  };
}

function eventFor(from: TaskState, to: TaskState): TaskEventType {
  if (to === "completed") return "task.completed";
  if (to === "failed") return "task.failed";
  if (to === "cancelled") return "task.cancelled";
  if (to === "interrupted") return "task.interrupted";
  // §7.1's auto-resume: the move *out of* `interrupted` is the resumption, and it is an event of its own so a client
  // that was watching across the restart can tell "started again" from "changed".
  if (from === "interrupted") return "task.resumed";
  return "task.state.changed";
}

/** What recovery does to a state found in the database after a restart: every non-terminal state becomes
 *  `interrupted`, uniformly, and no state becomes anything else. Terminal rows are left exactly as they are, because
 *  rewriting a completed task during recovery would be the first bug in the ledger. */
export function recoveryTarget(state: TaskState): TaskState | undefined {
  if (isTerminal(state) || !isKnownState(state)) return undefined;
  return state === "interrupted" ? undefined : "interrupted";
}
