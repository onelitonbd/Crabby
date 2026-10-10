# AGENT_RUNTIME.md

> **Document status:** Planning draft. Requirements below are user-approved; implementation mechanisms remain open.
>
> **Related:** `ARCHITECTURE.md`, `DECISIONS.md`, `SECURITY.md`, `docs/DATA_AND_MEMORY.md`

## 1. Purpose

This document defines the requirements and expected behavior of the Crabby Agent Runtime.

The Agent Runtime is responsible for planning and executing tasks, coordinating tools, managing task state, handling errors, reporting progress, recovering interrupted work, and maintaining useful context throughout execution.

This document specifies approved requirements separately from implementation decisions that remain open.

## 2. Approved Requirements

The following requirements have been approved by the project owner.

| Area | Approved decision |
| --- | --- |
| Execution strategy | Plan → Execute |
| Task concurrency | Controlled parallelism |
| Approval policy | Risk-based approval |
| Cancellation | Finish the current step |
| Recovery | Full auto-resume |
| Context management | Hybrid compaction |

These requirements guide the design of the runtime. They do not finalize the underlying implementation technologies or algorithms.

## 3. Execution Model

### 3.1 Plan → Execute

The Agent MUST follow a plan-then-execute workflow for multi-step tasks.

1. Understand the user's objective and constraints.
2. Identify the expected outcome and relevant risks.
3. Create an actionable plan with identifiable steps and dependencies.
4. Determine which actions require approval.
5. Execute eligible steps in the correct order.
6. Verify results where practical.
7. Update task progress and adjust the plan when necessary.
8. Report the final outcome, including incomplete work and relevant errors.

Simple tasks MAY use a lightweight plan rather than exposing a detailed plan to the user.

The Agent MUST NOT interpret a plan as permission to perform actions that independently require approval.

### 3.2 Plan updates

The Agent MAY revise its plan when new information, tool results, or errors change the execution strategy.

Significant changes to scope, risk, cost, or externally visible consequences MUST trigger the appropriate approval checks.

The runtime SHOULD preserve enough task history to explain important changes to the plan.

## 4. Task Lifecycle and Concurrency

### 4.1 Task lifecycle

Every managed task MUST have a stable unique identifier and a clearly defined state.

The initial logical lifecycle SHOULD support states equivalent to:

- `queued`
- `planning`
- `awaiting_approval`
- `running`
- `cancelling`
- `completed`
- `failed`
- `cancelled`
- `interrupted`

Exact state names and transition rules remain implementation decisions.

**Decided in M2 (D-083).** The names above are the names, and the table below is the whole set of moves. It is written
here rather than only in `packages/agent-runtime/transitions.ts` because this document owns the lifecycle, and
`scripts/parity.ts` diffs the two — a rule that exists in code and not here is a rule no interface author reads, which is
the F-08/F-10/F-11 pattern this set has been built to refuse.

| From | May move to | Why that set and not a larger one |
| --- | --- | --- |
| `queued` | `planning`, `awaiting_approval`, `cancelling`, `failed`, `interrupted` | §3.1's Plan → Execute is the reason `running` is not reachable from here: nothing executes without a plan, even a one-step plan. A task may need approval before its first step, so `awaiting_approval` is |
| `planning` | `awaiting_approval`, `running`, `cancelling`, `failed`, `interrupted` | The plan is what the executor consumes; `completed` is unreachable because a plan that finished describing work has not done it |
| `awaiting_approval` | `running`, `planning`, `cancelling`, `failed`, `interrupted` | `running` only on an answer naming the action it approves (§5.3, D-052's `once` scope); `planning` because a denial that leaves other work possible re-plans rather than dies (§5.5, D-043's ladder) |
| `running` | `completed`, `failed`, `cancelling`, `interrupted` | The only edge into `completed` in the whole table, and §6.1's step 6 is why `cancelled` is reached through `cancelling` and never from here |
| `cancelling` | `cancelled`, `failed`, `interrupted` | No `completed`: §6.1 allows the current step to finish, capture its output, and then **marks the task cancelled**, which is how a cancellation stays a cancellation. No return to `running`: "the runtime MUST NOT start another ordinary execution step merely because the current step completed after cancellation was requested" |
| `completed`, `failed`, `cancelled` | — | Terminal and absorbing. §4.1's "distinguish successful completion from cancellation, failure, and incomplete execution" is only true at the end of a task's life if nothing moves it afterwards; a retry is a new task with its own history, not a resurrection |
| `interrupted` | `queued`, `planning`, `awaiting_approval`, `running`, `cancelling`, `failed` | §7.1 restores "the latest valid task state" and §7.2 decides which of these is reachable for a given task: `running` is legal **only** when the recovery record carries a still-valid approval covering the step, which is why the edge exists in the table and is refused by the runtime otherwise. `completed` is not an option — a task that was interrupted did not complete |

The runtime MUST distinguish successful completion from cancellation, failure, and incomplete execution.

Three rules the table cannot carry, so they are stated with it (all three are enforced in `transition()` and tested in
`packages/agent-runtime/agent-runtime.test.ts`): a move into `cancelled` must carry §6.2's explicit outcome (confirmed
stopped or effects uncertain) rather than a default; a move out of `awaiting_approval` into `running` must carry the
answer and the action it covers, because §5.4 forbids one approval becoming blanket authorization; and no state moves to
itself, because a self-transition is how a runtime that lost an event looks like progress to every client reading it.

### 4.4 Concept boundaries (cross-document rule)

To keep responsibilities from overlapping across `ARCHITECTURE.md`, `SECURITY.md`, and `docs/DATA_AND_MEMORY.md`:

| Concept | Owns | Must not be confused with |
| --- | --- | --- |
| **Task** | Identity, objective, current state, plan, outcome. | The log of what happened. |
| **Event** | An append-only record that something happened (step started, tool failed, approval answered). | Authoritative current task state, or an approval grant. |
| **Cancellation** | A request plus its progression against a running task. | Proof that the underlying external operation actually stopped. |
| **Checkpoint** | Saved state used to resume safely. | A guarantee that external side effects can be reversed or replayed. |

### 4.2 Controlled parallelism

Crabby MUST support controlled parallel execution of independent tasks or steps when dependencies and safety constraints permit it.

The runtime MUST:

- Respect explicit task dependencies.
- Avoid concurrent modifications that could corrupt shared state.
- Enforce configurable concurrency limits.
- Track the status and outcome of individual running steps.
- Coordinate cancellation and recovery across related tasks.
- Prevent duplicate scheduling of the same logical step when the runtime can reliably identify it.

Steps with dependencies MUST NOT execute before their prerequisites are satisfied.

Concurrency limits, scheduling algorithms, and resource allocation policies remain open implementation decisions.

## 5. Risk-Based Approval

Crabby MUST use a risk-based approval policy.

Routine, low-risk actions MAY execute automatically within the user's configured permissions.

Actions involving significant destructive changes, sensitive information, external side effects, elevated privileges, or unexpected costs MUST receive appropriate scrutiny and, when required by policy, explicit user approval.

Examples include:

- Deleting or overwriting important files.
- Running commands with potentially destructive consequences.
- Installing software or modifying system configuration.
- Sending messages or publishing content externally.
- Transmitting sensitive data to external services.
- Performing financial or other consequential actions.

The runtime MUST:

1. Evaluate applicable permissions and approval requirements before executing an action.
2. Explain the relevant action and consequences when requesting approval.
3. Keep an approval request associated with its task and intended action.
4. Avoid treating approval for one action as blanket authorization for unrelated actions.
5. Respect denials and existing security restrictions.
6. Re-evaluate approval when an action materially changes.

AI-based risk assessment MAY assist this process, but security enforcement MUST NOT depend exclusively on an AI model's judgment.

### 5.1 The arbiter

The object that decides whether a pending approval may be answered, and whether an answered approval still covers the
action in front of it, belongs to the runtime — `packages/agent-runtime/approvals.ts` — and not to the Gateway or to any
interface. Three reasons, all of them this document's own rules:

- **Answer from anywhere** (§5's rule that any surface may answer) is only true if the surfaces share one arbiter. Four
  queues with four first-wins rules is four answers, and the user learns which one counted from the outcome.
- **`scope: once`** (D-052) needs a single place that can say "that row has been used". The mark is `consumed`, and the
  rule that a second consume is refused rather than forgiven is the whole of "once".
- **A state change without its event is a lie in progress.** So an operation that moves a row returns the event it
  owes — including when it *refuses*: answering past the deadline flips the row to `expired` and hands back
  `approval.expired` beside the refusal. A caller that writes the row and not the log is then a bug a reviewer can see
  in the type, not one a user discovers in a stale queue.

Two refusals the arbiter makes that no table can: a **request whose deadline the caller stretched** (D-064's TTL is per
tier and computed by the policy engine; a longer window is refused, not truncated), and **the exact same action re-asked
after a denial**. The second is worth its limit stated plainly: a hash proves identity, not intent, so what this
enforces is the literal repeat, and "must not rephrase a denied action" is enforced by `refusalCount` feeding D-043's
ladder — the loop pauses the task, which is the behaviour §6.3 actually asks for. A re-ask with materially different
arguments is legal, and it records `supersedes` so the chain is readable. An approval that expired *after* being
approved is the runtime's lateness and is deliberately **not** counted as a refusal, because a pause caused by our own
queueing would punish the user for it.

The risk tiers and their per-tool assignment are decided (`SECURITY.md` §6, `PROVIDERS_AND_TOOLS.md` §4.2, D-046), and so is the classifier that nudges `shell.run` upward (D-066, closing O-032 — an escalation hint, never the boundary). Approval **persistence** is decided as *absent* in v1 (D-052), and policy configuration is one file in one format, `config.json`, whose schema is the artifact `crabby config schema --json` prints (D-060). What remains open in this area is a number, not a design: the timeout thresholds and escalation tuning that M2 sets against real usage. `SECURITY.md` owns the policy and threat-model definition.

## 6. Cancellation Behavior

### 6.1 Finish the current step

When a user requests cancellation, Crabby MUST follow the approved **Finish the Current Step** policy.

The runtime MUST:

1. Record the cancellation request.
2. Stop scheduling new execution steps for the affected task.
3. Allow the current step to finish when it can safely and reasonably do so.
4. Capture the resulting status and available output.
5. Save the relevant task state and checkpoint information.
6. Mark the task as cancelled after the permitted in-progress work has settled.

The runtime MUST NOT start another ordinary execution step merely because the current step completed after cancellation was requested.

### 6.2 Cancellation limitations

Some tools and external operations cannot be stopped immediately or may continue after Crabby stops waiting for them.

The runtime MUST distinguish between a cancellation request and confirmed termination of the underlying operation.

Where an external action may already have taken effect when cancellation arrived (for example, a message that was already being sent), that uncertainty MUST be recorded explicitly on the task and MUST NOT be resolved by blindly re-executing the action.

Safety-critical intervention MUST override the normal finish-current-step behavior when continuing an operation would create unacceptable harm or leak sensitive data.

The definition of an atomic execution step is decided — it is the committed step boundary that D-065 resumes across and `SECURITY.md` §6.3 approves at — and the escalation mechanism is the tier ladder in `SECURITY.md` §6. Timeout thresholds remain a tuning value (the 64 KiB and temp-lifetime caps are decided in D-064; a per-tool duration is not), and that distinction is the point: an undecided number is a default to be measured, not a gap in the contract.

## 7. Automatic Recovery and Resume

### 7.1 Full auto-resume

Crabby MUST attempt to resume interrupted tasks automatically after a recoverable process interruption or restart, without requiring the user to manually initiate every recovery.

The runtime SHOULD restore the latest valid task state, inspect incomplete work, reconcile available execution records, and continue from the appropriate point.

Recovery MUST account for:

- Task and step status.
- Saved plans and checkpoints.
- Completed and incomplete tool calls.
- Pending approvals.
- Cancellation requests.
- Relevant errors and recovery attempts.
- External side effects that may already have occurred.

### 7.2 Approval interaction (amended rule)

Automatic recovery MUST NOT bypass the approval system. Specifically:

- Only work that is both safe and already covered by an existing, still-valid approval may resume automatically.
- A pending approval MUST NOT be treated as approved because a restart occurred.
- An action that policy forbids without approval MUST NOT execute automatically during recovery.
- Where the outcome of an external action is uncertain, blind retry is prohibited (see §7.3).
- Recovery that cannot proceed safely MUST leave the task paused with a clear, user-visible reason.

Full auto-resume therefore means *automatic orchestration of recovery*, not *automatic authorization*.

### 7.3 Safe recovery

Automatic recovery MUST NOT blindly repeat an action merely because its completion status is unknown.

Where a step may have caused an external side effect, Crabby SHOULD determine whether that effect already occurred before retrying it.

The runtime SHOULD use idempotency mechanisms, operation identifiers, or external-state checks where available.

If the runtime cannot determine whether retrying an action would cause a duplicate or unsafe effect, it MUST use a defined safe fallback rather than blindly repeating the action. Depending on the action and available evidence, this may mean reconciling state, seeking approval, or pausing that step while automatically recovering other safe work.

### 7.4 Recovery limitations

Task recovery is separate from database transaction recovery. A successfully recovered database does not prove that an interrupted external operation was completed correctly.

Crabby MUST NOT claim that every interrupted task can be resumed without information loss or duplicate side effects.

Checkpoint frequency is not a knob: a checkpoint is written at each committed step boundary (D-065), recovery may
pass only a step that is idempotent or has its effect recorded, and the retry ladder is D-043's floor with D-064's
schedule inside it. Recovery verification is the `integrity_check` and the committed-state comparison in
`docs/DATA_AND_MEMORY.md` §2.2. The per-tool timeout numbers are decided as defaults (D-074, table in
`PROVIDERS_AND_TOOLS.md` §5.2); what remains is re-measuring them on a device in M0, not choosing them, and none of it
touches the ordering rules above.

## 8. Context Management and Compaction

### 8.1 Hybrid compaction

Crabby MUST use a hybrid context-management strategy combining automatic compaction with user control over important context.

The runtime SHOULD monitor context usage and compact or summarize accumulated context when necessary to maintain reliable task execution.

Users SHOULD be able to protect important information and, where supported, review or correct relevant retained memories and summaries.

### 8.2 Preservation requirements

Context compaction MUST NOT silently replace the original conversation history with a summary.

The runtime MUST distinguish between:

- Original conversation records.
- Temporary working context.
- Generated summaries and checkpoints.
- Long-term memories.
- Task execution records and tool outputs.

Where supported, compaction SHOULD preserve task objectives, constraints, decisions, unresolved questions, relevant tool results, pending steps, and important error information.

The Agent SHOULD be able to recover relevant information from stored history when a summary is incomplete.

Crabby MUST NOT assume that a summary perfectly preserves all details from the original context.

### 8.3 Implementation independence

The context-management design MUST remain independent of a specific model provider's context window or compaction API.

Retrieval strategy is decided (D-065: SQLite FTS5, no vector index before a measured need) and the summary format follows the hybrid compaction design in D-027. Compaction thresholds and budget allocation stay tuning values validated against the acceptance list rather than a benchmark (D-065, closing O-011) — a threshold picked to look right in a plan is how a context system ends up discarding the thing the user pinned.

## 9. Error Handling

### 9.1 General requirements

Crabby MUST handle errors as explicit runtime events rather than silently ignoring failures.

When an error occurs, the runtime SHOULD:

1. Identify the failed task or step.
2. Record the error category and available diagnostic information.
3. Determine whether the failure is transient, permanent, permission-related, or caused by invalid input.
4. Retry only when appropriate.
5. Verify the result of a retry when practical.
6. Update task state and progress.
7. Continue independent, safe work where appropriate.
8. Report unresolved failures clearly.

### 9.2 Retry behavior

Retries MUST be bounded by configurable policies.

Transient failures MAY be retried with appropriate delays. Invalid requests, denied permissions, and other non-retryable failures MUST NOT be retried indefinitely.

Before retrying a step that may have produced an external side effect, the runtime SHOULD establish whether the original operation succeeded or remains in progress.

Repeated failures SHOULD trigger an alternative strategy only when that strategy respects the original objective, permissions, and safety requirements.

The Agent MUST NOT bypass security restrictions merely to make a failed task succeed.

## 10. Task Progress and Observability

### 10.1 Progress tracking

Crabby MUST maintain task progress throughout execution.

Where applicable, progress information SHOULD include:

- Task identifier and current status.
- Task objective and current plan.
- Completed, running, pending, and failed steps.
- Relevant tool calls and their outcomes.
- Approval requests and decisions.
- Cancellation or recovery status.
- Checkpoint information.
- Final outcome and outstanding issues.

Progress updates MUST reflect recorded runtime state rather than merely the Agent's claims.

The runtime SHOULD distinguish measured progress from estimated progress.

### 10.2 Interface compatibility

Task progress MUST be available through the shared runtime so that CLI, TUI, Web UI, and Telegram can present consistent task state.

The interfaces MAY display progress differently, but MUST NOT invent conflicting task statuses.

The exact event delivery, progress update frequency, and interface presentation are specified in the relevant interface and API documentation.

## 11. Runtime Boundaries

The Agent Runtime MUST operate through defined tool and permission boundaries.

It MUST NOT assume that a tool is safe, available, or supported merely because the model requests it.

Tool execution, approval enforcement, task persistence, event recording, cancellation, and recovery SHOULD have clearly separated responsibilities.

The runtime SHOULD remain independent of any single model provider and support the project's unified provider interface.

Implementation details MUST be documented in the relevant architecture, security, provider, data, and interface documents rather than unnecessarily duplicated here.

## 12. Open Decisions

This section once listed fifteen items that "require further research, design, or validation". Reading the list against
the document that grew around it, every one of them has an answer — here, in `SECURITY.md`, or in a numbered decision.
The list survived because nobody re-read it after writing the answers, which is the same failure mode as
`docs/CONSISTENCY_REVIEW.md` F-14 and F-17: a decision is not finished when it is made, it is finished when the last
document that disagrees with it is edited. The residue is measurement and tuning on a real phone, not design, so the
table below states each item's disposition instead of leaving a to-do list that invites a rewrite of settled rules:

| Item once listed as open | Decided in | What a phone still has to say |
| --- | --- | --- |
| Task state machine and permitted transitions | §4.1, §10.1 | — |
| Scheduler implementation and concurrency limits | §4.2; defaults in D-074 | whether 2 parallel steps and 4 provider requests survive real memory pressure (M0 P1/P5) |
| Definition and granularity of an execution step | §7.3, D-065 | — |
| Risk scoring, permission policy, approval workflow | §5, `SECURITY.md` §6, D-046 | a new tool's tier at review time, per the same table |
| Cancellation timeouts and escalation | §6; D-074 | nothing structural; the numbers are `limits.*` keys |
| Checkpoint format, frequency, persistence | §7.3, D-065 | write cost on device storage (M0 P3) |
| Restart detection and automatic recovery | §7.1 | Android's process-kill semantics (M0 P7) |
| Uncertain external side effects | §7.3, §7.4 | — |
| Idempotency and operation reconciliation | §7.3, tool `idempotent` flag in `PROVIDERS_AND_TOOLS.md` §4 | — |
| Retry limits, backoff, error classification | §9.1, §9.2, D-043, D-064 | provider-specific rate behavior, observed not assumed |
| Context compaction thresholds and summary structure | §8.1, §8.2, D-065 | tuned in M2 against the reviewed acceptance list |
| Context budgeting across providers | §8.2, D-064 | — |
| Progress event schema and delivery guarantees | §10, `docs/INTERFACES_AND_API.md` | interface-side buffer size for a dropped event (M1) |
| Logging, diagnostics, retention | `SECURITY.md` §14, D-065, D-058 | — |
| Recovery when stored state is corrupt or incomplete | §7.3 | whether WAL behaves identically on the device (**O-002**) |

A number that needs a phone is not a design gap. Writing it as one would either stall M1 or manufacture a figure
somebody then has to defend; each row above therefore says which milestone measures it and where the knob lives, so the
measurement changes a default in `config.json` rather than a page of this document.

## 13. Acceptance Criteria

The Agent Runtime design will be ready for implementation planning when:

- The Plan → Execute workflow is defined.
- Controlled parallelism and dependency handling are specified.
- Risk-based approvals have enforceable boundaries.
- Cancellation follows the finish-current-step policy, with safety override.
- Interrupted tasks support automatic recovery that cannot bypass approvals or blindly duplicate external actions.
- Hybrid compaction preserves the distinction between original history and summaries.
- Error handling and retries have bounded, observable behavior.
- Task progress is consistent across all supported interfaces.
- Task, event, cancellation, and checkpoint ownership is non-overlapping and consistent across documents.
- Remaining implementation decisions are documented and reviewed.

---

**End of Agent Runtime specification**
