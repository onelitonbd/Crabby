// M2's approval service: the half that turns `SECURITY.md` §6.3 from requirements into something that can refuse.
//
// `packages/policy` already builds the request — every field §6.3 demands, under §6.3's names, because a second
// spelling of the same idea is where an interface starts inventing its own. What was missing is everything that happens
// *after* a request exists: who may answer, what an answer binds, when it stops being usable, and what two clients
// answering at the same moment produce. Those rules live here, in the framework-free runtime zone `docs/DEVELOPMENT.md`
// §4 names (D-014), rather than in the Gateway — so the TUI, the Web UI, Telegram and a scheduled job all get the same
// answer, because "answer from anywhere" is only true if the arbiter is not one of the answerers.
//
// Not here yet, on purpose: persistence and the routes. `ApprovalStore` is the seam `packages/storage` implements, and
// `GET /approvals` + `POST /approvals/{id}/decision` (`docs/INTERFACES_AND_API.md` §4.3) are the surface. Neither is
// written until it can be written with its migration and its tests, because a route over a table nobody has made is a
// demo, not a feature.
import type { ApprovalRequest } from "@crabby/policy";

export type ApprovalDecision = "approve" | "deny";
export type ApprovalState = "pending" | "approved" | "denied" | "expired" | "consumed";

/** The event kind each operation owes the task's log (`docs/INTERFACES_AND_API.md` §5.2's `approval.*` set). Returned
 *  rather than appended, because this module owns no database: the caller writes the record and its event in one
 *  transaction, which is what makes "the row says consumed and the log says nothing" impossible. */
export type ApprovalEventKind =
  | "approval.requested"
  | "approval.answered"
  | "approval.expired"
  | "approval.re-requested";

export interface ApprovalRecord {
  readonly id: string;
  readonly request: ApprovalRequest;
  /** When the request was opened, on the caller's clock. Kept beside the request because §6.3 measures the TTL from the
   *  request and not from the answer, and "answered a minute before the deadline" is a different fact from "answered
   *  after it". */
  readonly requestedAt: number;
  state: ApprovalState;
  answeredAt?: number;
  /** Which client answered. Not for enforcement — the binding does that — but because a user who approved something on
   *  a phone and finds it denied on a desktop needs the record to say who answered. */
  answeredBy?: string;
  consumedAt?: number;
  /** Set when a request supersedes an answered one, so a re-ask is a visible chain rather than an unrelated row. */
  supersedes?: string;
}

/** Four methods, one of them a full scan: a pending approval queue is a handful of rows on a device, and inventing a
 *  keyed query API before the table exists is how an interface ends up depending on an index M2 has not decided to
 *  build. `packages/storage` will implement `all()` with one `SELECT` and no cache, because a cached queue is a queue
 *  that lies to the second client. */
export interface ApprovalStore {
  insert(record: ApprovalRecord): void;
  update(record: ApprovalRecord): void;
  get(id: string): ApprovalRecord | undefined;
  all(): readonly ApprovalRecord[];
}

/** A state change and the event that carries it, so a caller can write both in one transaction and a sweep can report
 *  what it did without the reader guessing which rows moved. */
export interface ApprovalChange {
  readonly record: ApprovalRecord;
  readonly event: ApprovalEventKind;
}

export type ApprovalFailureCode =
  | "incomplete-request"
  | "ttl-not-as-decided"
  | "already-answered"
  | "expired"
  | "denied"
  | "not-pending"
  | "not-found"
  | "scope-unsupported"
  | "materially-changed"
  | "consumed";

/** A refusal can carry an event too, and that is deliberate: `answer` on a request whose deadline has passed *changes*
 *  the row to `expired` while refusing the answer, and a rule that says "every state change has an event" cannot be
 *  honoured by a result type that only has room for events on the success path. */
export type ApprovalResult =
  | {
      readonly ok: true;
      readonly record: ApprovalRecord;
      readonly event: ApprovalEventKind;
      /** True when `open` found the identical request already pending and returned *that* row instead of adding a
       *  second one. The caller must not emit an event for it: two `approval.requested` rows for one prompt is how a
       *  queue starts showing a user the same decision twice. */
      readonly deduplicated?: boolean;
    }
  | {
      readonly ok: false;
      readonly code: ApprovalFailureCode;
      readonly reason: string;
      /** Set when the refusal *moved* the row: the caller appends this event beside the refusal, so a queue
       *  and a log never disagree about whether an approval is still open. */
      readonly event?: ApprovalEventKind;
    };

export interface Approvals {
  open(request: ApprovalRequest, at: number): ApprovalResult;
  answer(input: {
    readonly id: string;
    readonly decision: ApprovalDecision;
    readonly scope: string;
    readonly byClientId?: string;
    readonly at: number;
  }): ApprovalResult;
  /** The consume-once step the runtime performs immediately before executing an approved action. */
  consume(input: {
    readonly id: string;
    readonly taskId: string;
    readonly tool: string;
    readonly binding: string;
    readonly at: number;
  }): ApprovalResult;
  /** Expiry, applied to the whole set and reported, because an approval that expires only when someone looks at it is
   *  an approval that can be answered late by a client reading a stale queue. `answer` refuses an expired row too, so
   *  the two paths agree whichever runs first. */
  sweep(at: number): { readonly expired: readonly ApprovalChange[] };
  pending(taskId?: string): readonly ApprovalRecord[];
  /** D-043's ladder needs a count and not a verdict: repeated refusal of the same class is what pauses a task, the loop
   *  decides what "repeated" means, and this reports what happened. An expiry counts only when nobody answered it —
   *  a lapsed approval the runtime never executed is the runtime's lateness, not a user's refusal. */
  refusalCount(taskId: string, tool: string): number;
}

/** §6.3's mandatory text. Checked trimmed rather than merely present, because "expected effects" satisfied by a string
 *  that renders as nothing is the same defect as a missing field, and this list is short enough to read against the
 *  sentence it comes from. */
const REQUIRED_TEXT: readonly (keyof ApprovalRequest)[] = [
  "taskId",
  "tool",
  "summary",
  "exact",
  "effects",
  "whatCouldGoWrong",
  "binding",
];

export function createApprovals(deps: {
  readonly store: ApprovalStore;
  readonly newId: () => string;
}): Approvals {
  const { store, newId } = deps;

  function commit(record: ApprovalRecord, event: ApprovalEventKind): ApprovalResult {
    store.update(record);
    return { ok: true, record, event };
  }

  function forTask(taskId: string): readonly ApprovalRecord[] {
    return store.all().filter((record) => record.request.taskId === taskId);
  }

  return {
    open(request, at) {
      const missing = REQUIRED_TEXT.filter((field) => {
        const value = request[field];
        return typeof value !== "string" || value.trim().length === 0;
      });
      if (missing.length > 0) {
        return {
          ok: false,
          code: "incomplete-request",
          reason:
            `an approval request must carry ${missing.map((field) => `\`${String(field)}\``).join(", ")} with something in ` +
            "them (SECURITY.md §6.3); a field that renders as nothing is a field the user was never told about",
        };
      }
      if (request.scope !== "once") {
        return {
          ok: false,
          code: "scope-unsupported",
          reason: `\`scope: ${request.scope}\` does not exist in the first release — one answer shape is supported, and it is "this action, once" (SECURITY.md §6.3, D-052)`,
        };
      }
      // The TTL is D-064's per tier and `evaluate()` already computed both numbers, so a request arriving with a longer
      // deadline is refused rather than trusted: the deadline is the protection, and the party asking for an approval
      // does not get to set how long it has. The 1 s slack is clock tolerance, not policy.
      if (
        request.ttlMs !== undefined &&
        Math.abs(request.expiresAt - (at + request.ttlMs)) > 1_000
      ) {
        return {
          ok: false,
          code: "ttl-not-as-decided",
          reason:
            `\`expiresAt\` is not this tier's TTL (${request.ttlMs} ms) from now, which is D-064's number for \`${request.tier}\` — ` +
            "re-request with the deadline the policy computed instead of one the caller chose",
        };
      }

      const history = forTask(request.taskId);
      const sameAction = history.find((record) => record.request.binding === request.binding);
      if (sameAction?.state === "pending") {
        // Two open rows for one action would give a user two prompts and the runtime two answers.
        return { ok: true, record: sameAction, event: "approval.requested", deduplicated: true };
      }
      // The chain is per tool rather than per binding, because what a re-ask supersedes is the *refused request*, and
      // a materially different action is by definition a different binding.
      const lastAnswered = history
        .filter((record) => record.request.tool === request.tool && record.state !== "pending")
        .at(-1);
      if (sameAction?.state === "denied") {
        // §6.3's last paragraph: "the agent must not rephrase a denied action to obtain a different answer". What a
        // hash *can* enforce is the literal repeat — a rephrasing is by definition a different binding — so the exact
        // re-request is refused here and the pattern is what `refusalCount` reports to the loop, which is where a pause
        // is decided. Claiming more than that is how a security rule becomes a comment.
        return {
          ok: false,
          code: "denied",
          reason:
            `\`${request.tool}\` with that exact binding was already denied in this task (approval ${sameAction.id}); ask ` +
            "again only with a materially different action, and expect the repeated refusal to pause the task (SECURITY.md §6.3)",
        };
      }

      const record: ApprovalRecord = {
        id: newId(),
        request,
        requestedAt: at,
        state: "pending",
        ...(lastAnswered === undefined ? {} : { supersedes: lastAnswered.id }),
      };
      store.insert(record);
      return {
        ok: true,
        record,
        event: lastAnswered === undefined ? "approval.requested" : "approval.re-requested",
      };
    },

    answer({ id, decision, scope, byClientId, at }) {
      const record = store.get(id);
      if (record === undefined) {
        return {
          ok: false,
          code: "not-found",
          reason:
            `no approval ${id} — either it was answered and left the queue or it belongs to another task; ` +
            "the list to answer from is `GET /approvals?state=pending` (docs/INTERFACES_AND_API.md §4.3)",
        };
      }
      if (scope !== "once") {
        return {
          ok: false,
          code: "scope-unsupported",
          reason: `\`scope: ${scope}\` is not an answer the first release accepts; "remember this" is out of scope (SECURITY.md §6.3, D-052)`,
        };
      }
      if (record.state === "pending" && at > record.request.expiresAt) {
        record.state = "expired";
        store.update(record);
        return {
          ok: false,
          code: "expired",
          event: "approval.expired",
          reason:
            `approval ${id} expired at ${new Date(record.request.expiresAt).toISOString()} before this answer arrived, ` +
            "so the action needs a fresh request (SECURITY.md §6.3's per-tier TTL)",
        };
      }
      if (record.state === "expired") {
        return {
          ok: false,
          code: "expired",
          reason:
            `approval ${id} expired at ${new Date(record.request.expiresAt).toISOString()}; the action needs a fresh ` +
            "request (SECURITY.md §6.3's per-tier TTL)",
        };
      }
      if (record.state !== "pending") {
        // "Answer from anywhere" across four surfaces means two clients can reach the same pending row at the same
        // moment. The first write wins and the second is told so, with the winner named: a conflict that resolves
        // silently is how a phone approves what a desktop denied.
        return {
          ok: false,
          code: "already-answered",
          reason:
            `approval ${id} was already \`${record.state}\`${record.answeredBy === undefined ? "" : ` by client ${record.answeredBy}`}; ` +
            "the first answer stands, and a change of mind is a new request rather than an override",
        };
      }
      record.state = decision === "approve" ? "approved" : "denied";
      record.answeredAt = at;
      if (byClientId !== undefined) record.answeredBy = byClientId;
      return commit(record, "approval.answered");
    },

    consume({ id, taskId, tool, binding, at }) {
      const record = store.get(id);
      if (record === undefined) {
        return {
          ok: false,
          code: "not-found",
          reason:
            `no approval ${id} — either it was answered and left the queue or it belongs to another task; ` +
            "the list to answer from is `GET /approvals?state=pending` (docs/INTERFACES_AND_API.md §4.3)",
        };
      }
      if (record.state === "consumed") {
        return {
          ok: false,
          code: "consumed",
          reason: `approval ${id} has already been used; \`scope: once\` means once (D-052), so the next action needs its own request`,
        };
      }
      if (record.state === "denied") {
        return {
          ok: false,
          code: "denied",
          reason: `approval ${id} was denied, and a denial is respected (SECURITY.md §6.3)`,
        };
      }
      if (record.state !== "approved") {
        return {
          ok: false,
          code: "not-pending",
          reason: `approval ${id} is \`${record.state}\`, and only an approved action may execute (SECURITY.md §6.2's tier rows)`,
        };
      }
      // The binding is compared at consumption and not at answering, because §6.3 asks for re-approval "when the action
      // materially changes", and the action about to run is the only version that can be compared for real.
      if (
        record.request.taskId !== taskId ||
        record.request.tool !== tool ||
        record.request.binding !== binding
      ) {
        return {
          ok: false,
          code: "materially-changed",
          reason:
            `approval ${id} binds \`${record.request.tool}\` in task ${record.request.taskId} to a different action than the one ` +
            `being executed (\`${tool}\` in ${taskId}); an approval is not a licence for "that kind of thing" (SECURITY.md §6.3)`,
        };
      }
      if (at > record.request.expiresAt) {
        // Approved but never run inside the window: the deadline governed the whole request, so the action is not
        // executable on an approval the user let time out.
        record.state = "expired";
        store.update(record);
        return {
          ok: false,
          code: "expired",
          event: "approval.expired",
          reason:
            `approval ${id} passed its deadline ${new Date(record.request.expiresAt).toISOString()} before the action ran; ` +
            "an approved-but-unexecuted approval expires with the request it belonged to (SECURITY.md §6.3)",
        };
      }
      record.state = "consumed";
      record.consumedAt = at;
      return commit(record, "approval.answered");
    },

    sweep(at) {
      const expired: ApprovalChange[] = [];
      for (const record of store.all()) {
        if (record.state === "pending" && at > record.request.expiresAt) {
          record.state = "expired";
          store.update(record);
          expired.push({ record, event: "approval.expired" });
        }
      }
      return { expired };
    },

    pending(taskId) {
      const records = taskId === undefined ? store.all() : forTask(taskId);
      return records.filter((record) => record.state === "pending");
    },

    refusalCount(taskId, tool) {
      // An expiry counts only when nobody answered it. A row the user *approved* that lapsed unexecuted is the
      // runtime being slow, and counting it as a refusal would let the loop pause a task because of its own latency —
      // which is the pause-and-surface rule (§6.3) turned into a false accusation.
      return forTask(taskId).filter(
        (record) =>
          record.request.tool === tool &&
          (record.state === "denied" ||
            (record.state === "expired" && record.answeredAt === undefined)),
      ).length;
    },
  };
}

/** The store a test or an early interface uses while there is no table: the same rules over a Map, with insertion order
 *  preserved because a queue that reorders itself makes "the first answer wins" unprovable. Not a fixture —
 *  `packages/storage` implements the identical four methods over its own migration, and a caller cannot tell the
 *  difference except by how long rows survive. */
export function createMemoryApprovalStore(): ApprovalStore {
  const order: ApprovalRecord[] = [];
  const byId = new Map<string, ApprovalRecord>();
  return {
    insert(record) {
      order.push(record);
      byId.set(record.id, record);
    },
    update(record) {
      byId.set(record.id, record);
    },
    get(id) {
      return byId.get(id);
    },
    all() {
      return [...order];
    },
  };
}
