// M2's approval service: the half that turns `SECURITY.md` §6.3 from requirements into something that can refuse.
//
// `packages/policy` already builds the request — every field §6.3 demands, under §6.3's names, because a second
// spelling of the same idea is where an interface starts inventing its own. What was missing is everything that happens
// *after* a request exists: who may answer, what an answer binds, when it stops being usable, and what two clients
// answering at the same moment produce. Those rules live here, in the framework-free runtime zone `docs/DEVELOPMENT.md`
// §4 names (D-014), rather than in the Gateway — so the TUI, the Web UI, Telegram and a scheduled job all get the same
// answer, because "answer from anywhere" is only true if the arbiter is not one of the answerers.
//
// The seam is `ApprovalStore` below, and `packages/storage/approvals.ts` implements it — which is `ARCHITECTURE.md`
// §19's direction and not an accident ("Infrastructure adapters implement those abstractions"): this module owns the
// abstraction and imports no database, so an adapter can import the abstraction it serves. The two surfaces are
// `GET /approvals` and `POST /approvals/{id}/decision` (`docs/INTERFACES_AND_API.md` §4.3), and neither one grants
// anything: a route calls the same four methods a TUI calls, which is what makes D-084's "one arbiter" checkable
// instead of rhetorical.
import type { ApprovalState, ClientInterface } from "@crabby/api-contracts";
import type { ApprovalRequest, Tier } from "@crabby/policy";

export type ApprovalDecision = "approve" | "deny";
// The state *names* are the contract's, because `GET /approvals?state=` and the schema's `CHECK` constraint have to
// agree with them, and D-083's rule is that names live in `@crabby/api-contracts` while the edges live here.
export type { ApprovalState } from "@crabby/api-contracts";

/** The event kind each operation owes the task's log (`docs/INTERFACES_AND_API.md` §5.2's `approval.*` set). Returned
 *  rather than appended, because this module owns no database: the caller writes the record and its event in one
 *  transaction, which is what makes "the row says consumed and the log says nothing" impossible. */
export type ApprovalEventKind =
  | "approval.requested"
  | "approval.answered"
  | "approval.consumed"
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
  | "surface-not-allowed"
  | "consumed";

/** Which tiers a given surface may sign. A `Record` with only the restricted keys, so widening an approval to a new
 *  interface is a change to a line that cites a rule rather than a default that happens to allow it.
 *
 *  This is D-085's answer to a contradiction the code had been carrying quietly: `packages/policy` refused to *queue*
 *  a T3 approval for a Telegram client and cited §6.2, while §6.3's own sentence says an approval "must be answerable
 *  from all four interfaces" — and no document anywhere said which surface may sign which tier. A rule that lives in
 *  one package's `if` and contradicts another package's prose gets deleted by the next person reading the prose, so
 *  §6.2 now states it, and it is enforced here rather than in the route: the queue is shared across surfaces
 *  ("answer from anywhere"), so a T3 row opened for the TUI is sitting in the Telegram client's list too, and a
 *  restriction the Gateway alone applied would be gone the moment a TUI called the service directly.

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
    /** Which interface the answer arrived on. Required, not optional: an answer that does not say where it came from
     *  cannot be checked against §6.2, and a `via` that defaults to something permissive is how a restriction becomes
     *  a caller's courtesy. A caller with no surface at all is a caller that skipped the rule. */
    readonly via: ClientInterface;
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
  /** The queue view every surface reads, including the answered history a `?state=` filter asks for. It is on the
   *  arbiter and not a `SELECT` the route writes, because "answer from anywhere" only holds if the phone and the
   *  desktop are reading the same list out of the same function — a second query path is a second opinion. */
  list(filter?: {
    readonly state?: ApprovalState;
    readonly taskId?: string;
  }): readonly ApprovalRecord[];
  /** D-043's ladder needs a count and not a verdict: repeated refusal of the same class is what pauses a task, the loop
   *  decides what "repeated" means, and this reports what happened. An expiry counts only when nobody answered it —
   *  a lapsed approval the runtime never executed is the runtime's lateness, not a user's refusal. */
  refusalCount(taskId: string, tool: string): number;
}

/** §6.3's mandatory text. Checked trimmed rather than merely present, because "expected effects" satisfied by a string
 *  that renders as nothing is the same defect as a missing field, and this list is short enough to read against the
 *  sentence it comes from. */
const ANSWERABLE_FROM: Partial<Record<Tier, readonly ClientInterface[]>> = {
  T3: ["tui", "web"],
};

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

    answer({ id, decision, scope, byClientId, via, at }) {
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
      const allowed = ANSWERABLE_FROM[record.request.tier];
      if (allowed !== undefined && !allowed.includes(via)) {
        // Refused *without* touching the row, which is the part a route-level check would get wrong by accident: the
        // TUI is still expected to answer this one, so a refusal from a phone must neither expire it nor consume it.
        return {
          ok: false,
          code: "surface-not-allowed",
          reason:
            `approval ${id} is \`${record.request.tier}\`, and \`${record.request.tier}\` is answerable on ${allowed
              .map((surface) => `\`${surface}\``)
              .join(
                " or ",
              )} only — the request stays pending there (SECURITY.md §6.2, D-085). This interface may ` +
            "display an approval and relay an answer made elsewhere; it may not sign this one",
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
      // `approval.consumed`, not a second `approval.answered`: the answer was already logged by whoever recorded it
      // (the §4.3 decision route, or a TUI calling this same arbiter), and one event per state change is the rule this
      // module exists to keep. Reusing `answered` here is what F-42 found — a client watching the stream saw two
      // identical frames and could not tell "the user approved this" from "the runtime has now used it".
      return commit(record, "approval.consumed");
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

    list(filter = {}) {
      const { state, taskId } = filter;
      return store
        .all()
        .filter((record) => state === undefined || record.state === state)
        .filter((record) => taskId === undefined || record.request.taskId === taskId);
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
