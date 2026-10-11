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
| `running` | `completed`, `awaiting_approval`, `failed`, `cancelling`, `interrupted` | The only edge into `completed` in the whole table, and §6.1's step 6 is why `cancelled` is reached through `cancelling` and never from here. `awaiting_approval` is D-087's amendment, and M2d's loop is what made it unavoidable: §5's rule 1 evaluates *every* action, so a task that executed one step and then meets a gated one must be able to ask again — as the table stood, a second approval in one task had no legal representation and the only way to request one was to fail or interrupt the task |
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

**Decided in M2 (D-095) — where the checkpoint's owner sits, and what the row refuses to hold.** The owner is
`packages/agent-runtime/checkpoint.ts`: it commits D-065's boundary at each step the run commits, it commits a second kind
of boundary when a run suspends at an approval, and it computes the verdict a resume reads. The row holds the run's working
context — the messages a continuation would be built from — plus the step count, the model, and the sequence number the
boundary was written at; it holds **no grants and no action arguments**, and that absence is the second column of the table
above made concrete. A record that could hand back a grant is a record that authorizes, which §7.2 forbids; a record that
copied an approved action's arguments is an action the arbiter never saw, which §5's rule 4 forbids. The third column is
honoured the same way: the checkpoint does not promise an effect can be undone, it reports whether the log shows one was
*recorded*, and where the log is silent the answer is `re-ask`. Nothing in this table is enforced by prose: `verdictFor` is
one function, its four answers are `RESUME_VERDICTS` in `@crabby/api-contracts`, and `checkpoint.test.ts` asserts each one
against a sentence above.

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

Signing is a surface question and the arbiter decides it, so `answer` takes `via` — the interface the answer arrived
on — and refuses a tier that surface may not sign (D-085, `SECURITY.md` §6.2). Refusing changes nothing: the row stays
`pending` for a surface that may sign it, and no event is written for a refusal that moved no state. The two §4.3
routes (`GET /approvals`, `POST /approvals/{id}/decision`) call this same object rather than querying the table, which
is the only reason "answer from anywhere" is a fact and not a hope; `Idempotency-Key` is accepted on the decision route
and not required, because the row itself refuses a second answer, so a replay is a convenience and not a guard.

The risk tiers and their per-tool assignment are decided (`SECURITY.md` §6, `PROVIDERS_AND_TOOLS.md` §4.2, D-046), and so is the classifier that nudges `shell.run` upward (D-066, closing O-032 — an escalation hint, never the boundary). Approval **durability** is real from M2 on — one row per request in `crabby.sqlite3`, which is what makes `once` mean
once *across a restart* (`SECURITY.md` §17) — while approval **reuse** ("remember this") is decided as absent in v1
(D-052); the two were one word in this paragraph until the table existed, and the sentence is now split so the second
meaning cannot be read as the first. Policy configuration is one file in one format, `config.json`, whose schema is the artifact `crabby config schema --json` prints (D-060). What remains open in this area is a number, not a design: the timeout thresholds and escalation tuning that M2 sets against real usage. `SECURITY.md` owns the policy and threat-model definition.

### 5.2 The loop that asks

The arbiter answers; something has to ask. `packages/agent-runtime/loop.ts` is that something, and it lives in this
package for the reason in D-003 — a rule the Gateway owns is a rule only the Gateway can follow. Per action it runs
`PROVIDERS_AND_TOOLS.md` §4.4's pipeline in order (schema validation → capability check → tier/approval → execution),
and the six rules above are its behaviour rather than its aspirations: it evaluates before executing (1), the request it
opens carries §6.3's fields because `packages/policy` builds them (2), the request keeps its task and its binding (3),
one approval is spent on one action (4), a denial is respected *and the model is told what was refused* so it can plan
around a fact instead of guessing why nothing happened (5), and the action is re-evaluated at the moment of execution
(6).

Four properties of that last rule are worth stating, because each is a way the loop could have been written more
conveniently and less safely:

- **The approval is consumed before the action runs, never after.** The other order buys nothing — a failed execution
  still spent its `once` (D-052) — and it costs a duplicate side effect if the process dies in between, which is what
  §7.3 forbids. `consumed` is a state of the row, so it carries an event of its own rather than reusing `answered`.
- **Policy is asked again at the moment of execution instead of being trusted from the moment the prompt was built.**
  Two things can change while a prompt is open: the identity's grants — a `crabby auth revoke` landing mid-prompt has to
  be honoured by *this* execution — and since M2j the *watching* half is answered too, outside this document, because a
  revoked identity's live streams are ended by the route that owns delivery (`docs/INTERFACES_AND_API.md` §3.1, D-096) —
  and the tier, because §8's re-check after resolution
  means a path that resolves outside the workspace is not the action that was signed. In both cases the signed row is left **unspent**: it expires
  inside D-064's window, and per D-084 an approval the runtime never ran is not a refusal, so it does not count toward
  the ladder below.
- **A transaction is synchronous, so no effect happens inside one.** Each write phase commits a state and its events
  together, and the provider call and the tool execution happen *between* phases — §5.1's pairing rule, and the reason a
  stream never learns about a write that a rollback took back.
- **The model is offered only the tools policy has cleared for this identity**, which is §4.4's rule applied to the offer
  list and not only to the call: a model told about a tool its identity cannot use proposes it, and the user is then
  shown a refusal for something they were never able to ask for. The withheld reasons are ordered by whether the reader
  can act on them — no Termux on this device, and not shipped in this release, come before a grant the user could add,
  because a reason that suggests a repair which cannot work is worse than no reason.

**The ladder.** `SECURITY.md` §6.3 requires that repeated denial of the same class pause the task and surface it to the
user rather than loop, and prices no number; D-086 prices it at **two refusals of the same tool in one task**. The
arbiter reports the count and the loop decides what the count means, which is D-084's split kept intact. A pause is not
a tenth state — the nine states of §4.1 are decided — so a paused task sits in `awaiting_approval`, the one non-terminal
state that means "a human must act", with **no pending request in the queue** and a `task.progress` event naming the
tool, the count, the reason and the next action. That last field is what makes a pause visible rather than mysterious:
§7.2 requires a paused task to carry a clear, user-visible reason, and a state with an empty queue and no explanation is
precisely the silence §6.3 forbids.

The step budget is the other half of "rather than loop", and it counts a refused call as well as an executed one
(`PROVIDERS_AND_TOOLS.md` §5.2, D-088): a budget that only counted executions would leave unbounded the exact case the
pause exists for.

What this loop does not have, and does not pretend to: **the retry-then-ask ladder** — a provider error fails the task
and the `task.failed` event says that no retry was attempted, because D-043's five attempts inside D-064's schedule are
their own slice; **§6's cancellation settle** — an abort moves the task to `cancelling` and stops, since §6.2's evidence
about whether the operation stopped is the cancellation manager's to produce and `transition()` refuses the entry
without it; **§8's context budgeting and compaction**; **a conversation store** — a run suspended at a prompt holds its
messages in process memory, so a restart is §7.1's and §7.2's business rather than something the loop reconstructs; and
**any tools at all**, because `ARCHITECTURE.md` §18's `packages/tools` does not exist yet. The executor is a seam, and
the loop offers a model nothing an executor cannot run.

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

**Decided in M2 (D-089, D-090).** The six steps are `packages/agent-runtime/cancellation.ts` and the loop's cooperation
with it, split the way this section splits them: the manager records the request and is what stops new work being
scheduled (1, 2), the loop is what allows a step to finish and captures its output (3, 4) because only the party running
the step knows whether it finished, and the manager writes the outcome once the loop reports (5, 6).

**A request is recorded durably without a new table.** The task's state *is* the record that survives a restart —
`cancelling`, which §7.1 turns into `interrupted` and §7.2 then refuses to resume into `running` — and the event log
carries who asked, when, in which mode, and why. Only the `AbortController` for the run in flight is process memory,
because a signal is not a fact about the task and there is nothing to recover. A second request for one task is the same
fact relayed again and produces no second event, except when it escalates the mode, which §6.2 requires and the log
records. Step 5's checkpoint half is real since M2i, and the settle
event reports it rather than promising it: the boundary was written by the loop inside the phase that recorded the step, so
the manager's job at the settle is to say **where the run stood** — the step, the boundary kind, its sequence number — or to
say plainly that no boundary was ever committed, which is the sentence that keeps a payload from reading as "there was
nothing to save". Reading rather than writing is the point: a second writer of one row is how a resume point comes to
disagree with the log, and §4.4 already gave the two halves different owners.

**Two modes, because §6.2 requires both.** `finish-step` is this section's policy and the default: the step in flight
keeps the deadline it was already given (D-074's per-tool number, or the provider's absolute ceiling) and gets no second
clock. `immediate` is §6.2's safety-critical override: it aborts the in-flight call, and it bounds how long the runtime
waits for a step that will not stop at `limits.cancellationSettleMs` (D-090) — after which it stops waiting and records
the uncertainty rather than claiming a termination nobody confirmed. An `immediate` request over a recorded `finish-step`
one escalates and is logged; the reverse is not a thing a second tap may do.

### 6.2 Cancellation limitations

Some tools and external operations cannot be stopped immediately or may continue after Crabby stops waiting for them.

The runtime MUST distinguish between a cancellation request and confirmed termination of the underlying operation.

Where an external action may already have taken effect when cancellation arrived (for example, a message that was already being sent), that uncertainty MUST be recorded explicitly on the task and MUST NOT be resolved by blindly re-executing the action.

**What the two facts mean, decided in M2 (D-089).** §6.2 requires the distinction and does not say how a runtime is
supposed to *know* either half, which is the question that had to be answered before a row could be written.
`terminated` is true only when the operation **reported** that it stopped — an executor that returned after its signal, or
a step that was never started. A step the runtime walked away from, because a deadline fired or an `immediate`
cancellation stopped the waiting, is `terminated: false`: "we stopped waiting" is a fact about the runtime and this
sentence is about the operation. `effectsUncertain` is true for **every tool step** that was in flight, because §4.1's
tool record includes `sideEffects` and no tool in this build declares it (`PENDING_RECORD_FIELDS`), so the runtime cannot
tell a read from a send and fails closed; a tool declaring `sideEffects: none` is the only thing that should ever make it
false, and that is a change to make in the registry rather than in the manager. A **provider call** in flight is recorded
as `effectsUncertain: false` — a completion request affects nothing on the user's device beyond the provider having seen a
prompt it was already sent — and because that is a classification rather than a measurement, `inFlight` travels in the
event payload beside both booleans, so a reader who disagrees can see which judgement was made.

The evidence is written once, by the manager, into **both** places a reader looks: the `task.cancelled` event, and
`TaskRecord.cancellation` on the task itself (D-091, closing F-46). The second is the one §6.2's wording asks for and
§5.2's recovery rule needs — a client that missed the event polls `GET /tasks/{id}`, and a client that has to read the
event log to learn whether an external effect is in doubt is a client one step from re-running the action, which §7.3
prohibits. It is written at the settle and is absent while the task is merely `cancelling`, because the state already says
a request was recorded and the evidence does not exist until the step in flight has settled: a record showing
`terminated: false` before anything had terminated would be a guess in a field a user reads.

Safety-critical intervention MUST override the normal finish-current-step behavior when continuing an operation would create unacceptable harm or leak sensitive data.

The definition of an atomic execution step is decided — it is the committed step boundary that D-065 resumes across and `SECURITY.md` §6.3 approves at — and the escalation mechanism is the tier ladder in `SECURITY.md` §6. Timeout thresholds are defaults with a named override path rather than undecided: the 64 KiB and temp-lifetime caps are D-064's, three tool classes have durations in D-074's table (`fs.*` 10 s, `net.fetch` 20 s, `shell.run` 120 s) which `packages/agent-runtime` enforces, and the rest of §4.2's tools have no priced duration at all (F-41, F-44) — an unpriced tool runs under cancellation alone and its `tool.execution.started` event carries `deadlineMs: null` so the absence is visible instead of implied. That distinction is still the point: an undecided number is a default to be measured, not a gap in the contract, and inventing one for `memory.save` would be a number nobody decided and nobody could defend.

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

**Decided in M2 (D-092).** Recovery is `packages/agent-runtime/recovery.ts`, called by the Gateway at startup beside
D-065's retention prune, and it does three things. **Every non-terminal task becomes `interrupted`, uniformly** — D-083's
`recoveryTarget` is a function precisely so this cannot improvise a different answer per state, and a process that died
mid-round leaves no trustworthy record of what the model had been told. **A cancellation requested before the restart is
settled rather than resurrected**: the request is on the record (§6.1's step 1, written at the request and not only at the
settle — that is why D-091 was amended), so recovery moves the task `cancelling` → `cancelled` with §6.2's evidence set to
the only truthful answer after a crash, `terminated: false`, `effectsUncertain: true` and `inFlight: "unknown"`. Routing it
through `interrupted` instead would put a task the user asked to stop back in the state a runner resumes from, which is the
one recovery outcome §6 exists to prevent. **Nothing resumes automatically in this build**, and the report says so per task.
The saved state is no longer the missing piece — M2i made D-065's boundary durable and recovery reads its verdict — and what
is missing is the party that would use it: nothing in this Gateway drives a task, so §7.1's "attempt to resume" is
orchestration without an executor, and `packages/tools` and a product provider adapter arrive with it. What recovery does —
and does per task — is leave the task paused with a clear, user-visible reason in the `task.interrupted` event, name the
still-valid approval a runner *would* be allowed to resume under, and carry D-065's verdict on the boundary (`resume`,
`pass`, `re-ask` or `none`, with the reason beside it), so §7.2's permission, the saved state and the judgement on it are
three facts on the record instead of inferences a reviewer has to draw. The restart also sweeps the approval queue, because a deadline that passed while the process was dead is expired
by the clock and not by anybody's opinion.

### 7.2 Approval interaction (amended rule)

Automatic recovery MUST NOT bypass the approval system. Specifically:

- Only work that is both safe and already covered by an existing, still-valid approval may resume automatically.
- A pending approval MUST NOT be treated as approved because a restart occurred.
- An action that policy forbids without approval MUST NOT execute automatically during recovery.
- Where the outcome of an external action is uncertain, blind retry is prohibited (see §7.3).
- Recovery that cannot proceed safely MUST leave the task paused with a clear, user-visible reason.

Full auto-resume therefore means *automatic orchestration of recovery*, not *automatic authorization*. In this build the orchestration is real, and what is empty is not the authorization alone:
`packages/agent-runtime/recovery.ts` reports, for each interrupted task, whether a still-valid approval covers it, D-065's
verdict on the boundary the run left behind (`resume`, `pass`, `re-ask` or `none`, in the `task.interrupted` payload as well
as in the report), and resumes none — a report whose `resumed` field is the literal `false` rather than a boolean, so no
caller can read a resumption that did not happen. Since M2i the saved state a resume would need exists; the party that would
use it does not, and that is the difference this section's rule is about: even a `resume` verdict is not an authorization,
and the two documents that could have confused them (§7.1's "MUST attempt to resume" and §3.6's stage 3) are kept apart by
`verdictFor` being a *reading* of the record rather than an act on it.

### 7.3 Safe recovery

Automatic recovery MUST NOT blindly repeat an action merely because its completion status is unknown.

Where a step may have caused an external side effect, Crabby SHOULD determine whether that effect already occurred before retrying it.

The runtime SHOULD use idempotency mechanisms, operation identifiers, or external-state checks where available.

If the runtime cannot determine whether retrying an action would cause a duplicate or unsafe effect, it MUST use a defined safe fallback rather than blindly repeating the action. Depending on the action and available evidence, this may mean reconciling state, seeking approval, or pausing that step while automatically recovering other safe work.

**Decided in M2 (D-065, D-095).** The reconciliation is one function — `verdictFor` in
`packages/agent-runtime/checkpoint.ts` — and its four answers are the contract's `RESUME_VERDICTS`. It reads three things:
the boundary the run last committed, the task's state now, and the log tail after the boundary's sequence number. Nothing
after the boundary was left unanswered → `resume`. A `tool.execution.started` with no outcome beside it → `pass` if that
tool's runtime declares it idempotent or its external effect is on the record (D-065's two permissions, both of which
belong to `packages/tools`, which does not exist yet: `PENDING_RECORD_FIELDS` lists `idempotent` and `sideEffects` as
fields the registry cannot answer, so the default declares neither), and `re-ask` otherwise. No boundary at all, or a task
that has ended → `none`, because §4.1's terminal states are absorbing and a `re-ask` on a finished task would be an offer
nothing can accept. Two properties of the reading matter more than the answers. **The verdict is computed at read time**,
never stored: all three inputs can move after the boundary is written, and a stored verdict is a guess in the one field a
recovery path acts on. **The log is the evidence, not a second record**: a step that started and died without reporting
needs no checkpoint of its own, because *the missing outcome is the finding* — which is also what makes it safe that a
provider call, an event-less round, is classified as nothing in flight (D-089's classification, the same one cancellation
uses).

### 7.4 Recovery limitations

Task recovery is separate from database transaction recovery. A successfully recovered database does not prove that an interrupted external operation was completed correctly.

Crabby MUST NOT claim that every interrupted task can be resumed without information loss or duplicate side effects.

Checkpoint frequency is not a knob: a checkpoint is written at each committed step boundary (D-065), there is no
`limits.*` key that makes it less frequent (D-095 writes one row per task and replaces it, because "the latest valid state"
is what recovery restores), recovery may pass only a step that is idempotent or has its effect recorded, and the retry
ladder is D-043's floor with D-064's schedule inside it. Recovery verification is the `integrity_check` and the committed-state comparison in
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

**Implemented in M2 (D-094).** The ladder is `packages/agent-runtime/loop.ts`'s provider path, and every number in it was
already decided: D-043's floor of five attempts per failing stage, D-064's `1s, 2s, 4s, 8s, 16s` with ±25% jitter, a
`Retry-After` value overriding the schedule *upward* and never downward, and `packages/providers`' `shouldRetry` deciding
which classes are transient — the loop calls that function rather than restating it, so there is one opinion in the codebase
about what is retryable. Three things about the wiring are decisions rather than details.

- **The ladder retries provider calls and never tool steps.** The sentence above about establishing whether an operation
  succeeded applies to a step that may have had an external side effect; a completion request has none on the user's device
  beyond the provider having seen a prompt it was already sent (the same classification D-089 makes for cancellation). A
  tool step is the opposite case, and no tool declares `idempotent` (`PENDING_RECORD_FIELDS`), so §7.3's answer is always
  "re-ask rather than repeat": a failed tool result goes back to the model as that tool's answer, which is how §3.2's plan
  revision happens rather than how a retry loop starts.
- **A retry is scheduled work, so §6.1 stops it.** A cancellation recorded during a backoff ends the ladder at once and the
  task settles as `cancelled` rather than `failed`, because waiting out a 16 s rung for a task the user has already stopped
  is exactly the behaviour §6.3 accuses a loop of.
- **The budget is a `limits.*` key with D-043's floor in the schema.** `limits.providerAttempts` defaults to `MAX_ATTEMPTS`
  (6 — one attempt plus the five delays D-064 priced) and cannot be set below 5, because "at least 5 attempts
  (configurable)" states a floor and not a suggestion; a knob that could turn the ladder off would be a knob against the
  decision.

What is **not** here is D-044's rung: after the budget is spent, Crabby asks the user which model to use instead and resumes
from the checkpoint. The checkpoint is durable now (D-095, and `GET /tasks/{id}/checkpoint` reports the verdict on it), so
what the rung still waits on is a switch surface to ask on and a runner to answer to — and one more thing the documents
disagree about: an exhausted budget fails the task, `failed` is terminal and absorbing, and a resume would need an edge out
of it that §4.1 does not have (F-50). The ordering that reconciles them is D-086's — the exhaustion *pauses* and asks, and
only an ask that goes unanswered or is refused moves the task to `failed` — which is the runner's slice to implement, not
this one's to assume. So an exhausted budget fails the task today, and the `task.failed` event says how many attempts it
took and names the missing rung, which is the difference between "we gave up" and "we ran out of ladder". Every rung is logged, `provider.retry.scheduled`
then `provider.retry.attempt`, because a retry a client cannot see is a retry nobody can bound, and §5.2's `provider.*`
family exists for exactly that.

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
| Checkpoint format, frequency, persistence | §7.3, D-065, D-095 | write cost on device storage (M0 P3) |
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
