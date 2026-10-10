// M2d: the caller §5's rule 1 was waiting for. Until this file existed, `packages/policy` could answer "what tier is
// this" and `packages/agent-runtime/approvals.ts` could arbitrate an answer, but nothing *asked*: a task that reached a
// gated action had no way to get a prompt, and `packages/gateway/app.ts`'s header said so out loud. This is the loop
// that closes that gap, and it runs the pipeline in the order `PROVIDERS_AND_TOOLS.md` §4.4 fixes — schema validation →
// capability check → tier/approval → execution — with `AGENT_RUNTIME.md` §5's six runtime rules as the behaviour around
// it: evaluate before executing (1), explain the action when asking (2, which is `packages/policy` building §6.3's
// fields), keep the request with its task and action (3, the binding), never treat one approval as blanket
// authorization (4, `consume` re-compares at execution), respect denials (5), and re-evaluate when the action
// materially changes (6).
//
// Five properties are decisions rather than conveniences, and each is argued where it is enforced:
//
//   - **The approval is consumed before the action runs, never after.** A crash between the two must not leave a usable
//     approval for an action that already happened — that is the duplicate side effect §7.3 prohibits. The other order
//     buys nothing: an execution that fails still spent its `once` (D-052).
//   - **A transaction is synchronous, so no effect happens inside one.** `packages/storage`'s `transact` wraps a
//     better-sqlite3 transaction, which cannot span an `await`; every provider call and every tool execution therefore
//     happens *between* write phases, and each phase writes the row and its events together (§9's pairing invariant).
//   - **A task record is never carried across an `await`.** Another client can move a task while this loop is waiting on
//     a provider, so every phase re-reads the record and `transition()` is asked about the state that is true now.
//   - **A refused action spends the step budget.** §5.2's per-task step limit is what stops a loop of proposals that are
//     all denied, so counting only executed calls would leave unbounded the one case the limit exists for.
//   - **Two refusals of the same tool pause the task** (D-086). `SECURITY.md` §6.3 says "repeated denial … should pause
//     the task and surface it to the user rather than loop" and prices no number, and the arbiter already refuses the
//     *exact* re-request of a denied binding — so the only way to reach a second refusal is a materially different
//     action for the same tool, and a third ask is the loop arguing with the user.
//
// What is deliberately NOT here, because a stub of it would be worse than its absence:
//
//   - **No tools.** `ToolSurface` is the seam `ARCHITECTURE.md` §18's `packages/tools` will implement; nothing in this
//     build can execute a `file.write`, so the loop offers the model only what an executor declares it can run.
//   - **No retry ladder.** A provider error fails the task on the first error, and the event says that no retry was
//     attempted. D-043's five attempts inside D-064's schedule and jitter, and the `provider.retry.*` events, are their
//     own slice.
//   - **No cancellation settle.** An abort moves the task to `cancelling` and stops, because §6.2 requires the record to
//     say whether the operation was confirmed to stop and whether its effects are uncertain, and only §6's manager can
//     know that. Entering `cancelled` without it is exactly what `transition()` refuses.
//   - **No conversation store.** A suspended run carries its messages in process memory. That is honest rather than
//     durable: after a restart §7.1 marks the task `interrupted` and §7.2 decides what may resume, and a loop that
//     pretended to rebuild a conversation from the event log would be inventing §8's compaction.
//   - **No streaming.** The loop calls `generate()`, so assistant text arrives whole and is logged as `message.added`;
//     §5.3's `message.stream.delta` path belongs to the streaming slice.
//   - **No result validation.** §4.4's fifth step has nothing to validate against until a tool declares an output
//     schema, and `PROVIDERS_AND_TOOLS.md` §4.1 lists `outputSchema` among the fields the runtime owes (F-41's
//     neighbour): a check with no schema is a check that always passes.
import {
  type ErrorClass,
  type Event,
  type EventType,
  isTerminal,
  newId,
  type TaskRecord,
  type TaskState,
} from "@crabby/api-contracts";
import {
  availabilityFor,
  type ClientKind,
  deferralFor,
  type EvalContext,
  enabledFor,
  evaluate,
  holdsGrant,
  type PlatformFactsLike,
  type PolicySubject,
  rank,
  resolveTool,
  type Tier,
  type ToolCall,
} from "@crabby/policy";
import {
  type Provider,
  ProviderError,
  type ProviderMessage,
  type ProviderToolCall,
  type ProviderToolSpec,
} from "@crabby/providers";
import type { ApprovalRecord, Approvals } from "./approvals.ts";
import { type TransitionEvidence, transition } from "./transitions.ts";

/** §5.2's limits, priced by D-088. Each one is a `limits.*` key in `config.json` (D-074's override path), and the
 *  failure it produces names the limit and how to change it — §5.2's own sentence, "when a limit trips, the failure
 *  names the limit and how to change it". */
export interface LoopLimits {
  /** Tool calls one task may put through the gate, executed or refused. The header says why a refusal counts. */
  readonly stepsPerTask: number;
  /** Tool calls one completion may propose. D-074 already priced parallel tool steps in one task at 2, so a response
   *  asking for more is asking for parallelism the device budget does not have. */
  readonly toolCallsPerResponse: number;
  /** D-074's "Provider — absolute" row, enforced here because §3.1 makes timeouts the runtime wrapper's job and not the
   *  adapter's. */
  readonly providerCallMs: number;
  /** D-086's reading of §6.3's "repeated denial". */
  readonly refusalsBeforePause: number;
  /** Per-tool deadlines in milliseconds, keyed by tool name — the `limits.*` overrides D-074 promises are editable in
   *  `config.json`. An override wins over the class default; a tool with neither runs under the caller's signal alone. */
  readonly toolDeadlines?: Readonly<Record<string, number>> | undefined;
}

export const LOOP_LIMITS: LoopLimits = {
  stepsPerTask: 25,
  toolCallsPerResponse: 2,
  providerCallMs: 300_000,
  refusalsBeforePause: 2,
};

/** D-074's per-tool deadlines, for the three classes the table actually prices: `fs.*` 10 s, `net.fetch` 20 s total,
 *  `shell.run` 120 s wall clock. `undefined` means the table prices no row for that tool, which is F-41's third clause
 *  recorded rather than filled in — a deadline invented for `memory.save` would be a number nobody decided and nobody
 *  could defend. An unpriced tool runs under the caller's signal alone, and its `tool.execution.started` event carries
 *  `deadlineMs: null` so a reader can see that no clock was set. */
export function toolDeadlineMs(tool: string): number | undefined {
  if (tool.startsWith("file.") || tool.startsWith("fs.")) return 10_000;
  if (tool === "net.fetch") return 20_000;
  if (tool === "shell.run") return 120_000;
  return undefined;
}

/** The deadline that applies to one tool: D-074's class default, unless `config.json` overrode it for this tool. Kept
 *  beside the class table rather than inside it, because the override is a user's number and the class default is a
 *  decided one, and a reader should be able to see which of the two is in force. */
export function deadlineFor(
  tool: string,
  overrides?: Readonly<Record<string, number>> | undefined,
): number | undefined {
  return overrides?.[tool] ?? toolDeadlineMs(tool);
}

/** What a tool execution owes the loop. `output` is the text the model sees next and the text the event carries;
 *  `packages/storage` applies §5.2's 64 KiB cap and the scratch reference on write, so a large output is not this
 *  type's problem. */
export interface ToolOutcome {
  readonly ok: boolean;
  readonly output: string;
  /** D-074's rule that a timeout is "a distinct code, never `failure`" — an executor that knows why it failed says so
   *  here, and the loop's own deadline produces `timeout` rather than borrowing the executor's vocabulary. */
  readonly code?: string | undefined;
}

export interface ToolRunContext {
  readonly taskId: string;
  /** Already combined with the deadline when D-074 prices one, so an executor that honours its signal is *enforced*
   *  rather than merely asked. */
  readonly signal: AbortSignal;
  readonly deadlineMs: number | undefined;
}

/** The seam `packages/tools` will fill (`ARCHITECTURE.md` §18, and §19's "the Agent Orchestrator depends on provider,
 *  tool, policy, storage, and event abstractions"). Two methods and no defaults: a tool the executor does not declare is
 *  a tool the loop will not offer the model and will not run, because the alternative is a registry of names with
 *  nothing behind them — the mock this build refuses to ship. */
export interface ToolSurface {
  readonly specs: () => readonly ProviderToolSpec[];
  readonly run: (call: ToolCall, ctx: ToolRunContext) => Promise<ToolOutcome> | ToolOutcome;
}

export interface JournalEventInput {
  readonly taskId: string;
  readonly type: EventType;
  readonly payload: Record<string, unknown>;
  readonly at: number;
  readonly correlationId?: string | undefined;
}

/** The loop's write side: four synchronous methods, because a transaction that spans an `await` is not a transaction
 *  here. `packages/storage` can implement this over `transact`/`setState`/`appendEvent` without distortion and a test
 *  can implement it over Maps — the same seam style as the arbiter's `ApprovalStore` (D-084). */
export interface LoopJournal {
  readonly task: (taskId: string) => TaskRecord | undefined;
  /** Writes the state the loop has already checked against `transition()`; the error is the one `GET /tasks/{id}` shows. */
  readonly setState: (
    taskId: string,
    state: TaskState,
    error?: { code: string; message: string },
  ) => void;
  /** Appends and returns the event with its `seq`, so the caller publishes the frame that was actually stored. */
  readonly append: (input: JournalEventInput) => Event;
  readonly transact: <T>(body: () => T) => T;
}

/** Who is asking: `PolicySubject` minus the `taskId` the loop fills in from the task it is running. */
export interface LoopSubject {
  readonly grants: readonly string[];
  /** Optional in the same sense `PolicySubject` makes it, so the loop can spread this into a subject without
   *  `exactOptionalPropertyTypes` turning an absent field into an explicit `undefined`. */
  readonly removedGrants?: readonly string[];
  readonly clientKind: ClientKind;
}

export interface RunInput {
  readonly taskId: string;
  /** The model this run uses, resolved from `config.json` by the caller (D-060) and not chosen here: §3.1's third rule
   *  is that a provider "must not be able to alter the tool set, permission state, or approval outcome of a task", and a
   *  loop that picked its own model would be one step from a provider picking one. */
  readonly modelId: string;
  readonly subject: LoopSubject;
  readonly ctx: EvalContext;
  readonly signal?: AbortSignal | undefined;
  readonly correlationId?: string | undefined;
}

/** A run stopped at a prompt. Process memory, not durable state — the header says why, and §7.1/§7.2 own the restart. */
export interface SuspendedRun {
  readonly taskId: string;
  readonly approvalId: string;
  readonly call: ToolCall;
  readonly toolCallId: string;
  readonly messages: readonly ProviderMessage[];
  readonly steps: number;
  readonly input: RunInput;
}

export type LoopOutcome =
  | {
      readonly kind: "completed";
      readonly task: TaskRecord;
      readonly steps: number;
      readonly text: string;
    }
  /** A prompt is open and the task is in `awaiting_approval`. The runner answers through the arbiter — the §4.3 route, a
   *  TUI, Telegram — and then calls `resume`. */
  | { readonly kind: "awaiting-approval"; readonly run: SuspendedRun; readonly task: TaskRecord }
  /** D-086's pause: the task is in `awaiting_approval` with **no pending request**, and the reason is in the log. */
  | {
      readonly kind: "paused";
      readonly task: TaskRecord;
      readonly tool: string;
      readonly refusals: number;
      readonly reason: string;
    }
  | {
      readonly kind: "failed";
      readonly task: TaskRecord;
      readonly code: string;
      readonly reason: string;
    }
  /** §6's settle is not this slice: a cancellation was requested, the task is in `cancelling`, and nothing else moved. */
  | { readonly kind: "cancelling"; readonly task: TaskRecord; readonly reason: string }
  /** The loop declined to act and wrote nothing: a pending approval is not an approved one (§7.2), a terminal task does
   *  not resume (§4.1), an already-consumed approval is a duplicate `resume`. */
  | {
      readonly kind: "refused";
      readonly task: TaskRecord | undefined;
      readonly code: string;
      readonly reason: string;
    };

/** Typed, per `docs/DEVELOPMENT.md` §4: a §6 `code`, never a string. Thrown only where the loop's own invariants broke —
 *  a task that vanished mid-run, or a state move the machine refused — because those are bugs in this file and not
 *  conditions a caller can be told how to fix. */
export class LoopError extends Error {
  readonly code: string;
  readonly class: ErrorClass;
  constructor(input: { code: string; message: string; class?: ErrorClass }) {
    super(input.message);
    this.name = "LoopError";
    this.code = input.code;
    this.class = input.class ?? "internal";
  }
}

export interface LoopDeps {
  readonly journal: LoopJournal;
  readonly approvals: Approvals;
  readonly provider: Provider;
  readonly tools: ToolSurface;
  /** §4.1's `availability` predicate needs a fact this package must not read from `process.env` (D-014's framework-free
   *  zone), so it arrives the way the Gateway's `GET /api/v1/tools` gets it. */
  readonly platform: PlatformFactsLike;
  /** Called after each transaction commits, never inside one (§9's invariant, and the reason a stream cannot learn
   *  about a write that a rollback later took back). */
  readonly publish: (event: Event) => void;
  readonly limits?: Partial<LoopLimits> | undefined;
  readonly now?: (() => number) | undefined;
}

export interface Loop {
  start(input: RunInput): Promise<LoopOutcome>;
  resume(run: SuspendedRun): Promise<LoopOutcome>;
}

type Emit = (type: EventType, payload: Record<string, unknown>, at: number) => void;

/** What one proposed call produced: either the run stops, or it continues with these messages. A union rather than an
 *  optional field, so a caller cannot continue after a prompt by forgetting to check one branch. */
type StepResult =
  | { readonly stop: LoopOutcome }
  | { readonly messages: readonly ProviderMessage[]; readonly steps: number };

interface RunState {
  readonly input: RunInput;
  readonly subject: PolicySubject;
  readonly messages: readonly ProviderMessage[];
  readonly steps: number;
}

interface ProviderTurn {
  readonly text: string;
  readonly toolCalls: readonly ProviderToolCall[];
  readonly usage: { inputTokens: number; outputTokens: number };
  readonly finishReason: string;
}

/** §4.4's "an adapter receives only tools policy has already cleared", applied to the *offer* list and not only to the
 *  call: a model told about a tool its identity cannot use will propose it, and the user is then shown a refusal for
 *  something they were never able to ask for. Returns the reason a declared tool is withheld, so the answer is the one
 *  §4.1's `availability` field requires — "false yields a documented reason instead of a broken tool" — and a test can
 *  ask about the reason rather than only about the absence.
 *
 *  The registry comes first because a name with no row has no tier to enforce (§4.4's step 2 cannot run without it).
 *  After that the order is **by whether the reader can do anything about it**: a platform this device does not have, and
 *  a release that does not ship the tool, are answered before a grant the user could add and before a default the user
 *  could change. The alternative reads better in a table and worse on a phone — "needs `device.notify`, which this
 *  identity does not hold" invites a desktop user to grant a capability for a Termux binary that is not installed, and a
 *  reason that suggests a repair which cannot work is worse than no reason. A tool that *is* offered is still gated per
 *  call: this filter decides what the model may ask for, never what it may do. */
export function withheldReason(
  name: string,
  subject: Pick<PolicySubject, "grants" | "removedGrants">,
  platform: PlatformFactsLike,
): string | undefined {
  const spec = resolveTool(name);
  if (!spec)
    return `'${name}' is not in the tool registry, so it has no capability and no tier to enforce`;
  const available = availabilityFor(spec, platform);
  if (!available.available) return `'${name}' is not offered: ${available.reason}`;
  const deferred = deferralFor(spec);
  if (deferred) return `'${name}' is not offered in the first release: ${deferred.reason}`;
  const enabled = enabledFor(spec);
  if (!enabled.enabled) return `'${name}' is not offered: ${enabled.reason}`;
  for (const grant of spec.capabilities) {
    if (holdsGrant(subject.grants, grant)) continue;
    const base = grant.split(":")[0];
    const removed = (subject.removedGrants ?? []).some((entry) => entry.split(":")[0] === base);
    return removed
      ? `'${name}' is not available to this client: '${grant}' was removed when this identity was paired (SECURITY.md §13)`
      : `'${name}' needs '${grant}', which this identity does not hold (PROVIDERS_AND_TOOLS.md §4.2)`;
  }
  return undefined;
}

export function createLoop(deps: LoopDeps): Loop {
  const limits: LoopLimits = { ...LOOP_LIMITS, ...(deps.limits ?? {}) };
  const now = deps.now ?? ((): number => Date.now());
  const { journal, approvals, provider, tools, publish } = deps;

  // ------------------------------------------------------------------ write phases

  /** One transaction: every row and event this step owes, committed together and published after. The staged list is why
   *  `publish` cannot be called from inside `body` — an event published before its commit is an event a rollback has to
   *  retract, and §5.4 has no frame for taking one back. */
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

  /** The machine is the only authority on whether a task may move (D-083), so the loop asks it and then writes both
   *  halves of the answer: the state, and the event that carries it. A refusal here is a bug in this file, and it throws
   *  *inside* the transaction so nothing is half-written. */
  function move(
    task: TaskRecord,
    to: TaskState,
    evidence: TransitionEvidence,
    emit: Emit,
    at: number,
    record?: { error?: { code: string; message: string }; payload?: Record<string, unknown> },
  ): void {
    const result = transition(task.state, to, evidence);
    if (!result.ok) {
      throw new LoopError({
        code: "loop.transition_refused",
        message:
          `the loop tried to move task ${task.id} from \`${result.from}\` to \`${result.to}\` and the state machine ` +
          `refused: ${result.reason}`,
      });
    }
    journal.setState(task.id, to, record?.error);
    emit(result.event, { from: result.from, to: result.to, ...(record?.payload ?? {}) }, at);
  }

  /** Reads the record rather than trusting the one a caller carried here: a provider call is an `await`, and another
   *  client can move a task during it (§4.1's states are the shared truth, not this loop's copy of them). */
  function currentTask(taskId: string): TaskRecord {
    const task = journal.task(taskId);
    if (task === undefined) {
      throw new LoopError({
        code: "loop.task_missing",
        message: `task ${taskId} is not in the journal; a pending approval is deleted with its task, and so is its run`,
      });
    }
    return task;
  }

  function fail(
    taskId: string,
    code: string,
    reason: string,
    errorClass: ErrorClass,
    correlationId: string | undefined,
    extra: Record<string, unknown> = {},
  ): LoopOutcome {
    const at = now();
    const task = currentTask(taskId);
    phase(taskId, correlationId, (emit) => {
      move(task, "failed", {}, emit, at, {
        error: { code, message: reason },
        payload: { code, reason, class: errorClass, ...extra },
      });
    });
    return { kind: "failed", task: currentTask(taskId), code, reason };
  }

  function refused(
    task: TaskRecord | undefined,
    code: string,
    reason: string,
  ): Extract<LoopOutcome, { kind: "refused" }> {
    return { kind: "refused", task, code, reason };
  }

  // ------------------------------------------------------------------ what the model is offered

  function offeredTools(subject: PolicySubject): readonly ProviderToolSpec[] {
    return tools
      .specs()
      .filter((spec) => withheldReason(spec.name, subject, deps.platform) === undefined);
  }

  function declaredSpec(name: string): ProviderToolSpec | undefined {
    return tools.specs().find((candidate) => candidate.name === name);
  }

  /** §4.3's step 1, read off the executor's own declaration: the argument names a tool declared are the only ones it may
   *  be given, and the check happens before policy so a schema mismatch can never be mistaken for a permission answer. */
  function toToolCall(proposed: ProviderToolCall): ToolCall {
    const properties = (
      declaredSpec(proposed.name)?.parameters as
        | { properties?: Record<string, unknown> }
        | undefined
    )?.properties;
    return {
      tool: proposed.name,
      args: proposed.arguments,
      ...(properties === undefined ? {} : { declaredArgs: Object.keys(properties) }),
    };
  }

  function toolMessage(toolCallId: string, content: string): ProviderMessage {
    return { role: "tool", content, toolCallId };
  }

  // ------------------------------------------------------------------ effects, outside any transaction

  /** D-074's deadline, enforced rather than announced. `AbortSignal.any` is the combination; the race is what bounds an
   *  executor that ignores its signal. The loser's rejection is swallowed on purpose — the abort was already signalled,
   *  and an unhandled rejection from a call this loop stopped waiting for would read as a crash. */
  async function withDeadline<T>(
    work: (signal: AbortSignal) => Promise<T>,
    deadlineMs: number | undefined,
    outer: AbortSignal | undefined,
    onTimeout: () => T,
  ): Promise<T> {
    const timeout = deadlineMs === undefined ? undefined : AbortSignal.timeout(deadlineMs);
    const signal =
      outer !== undefined && timeout !== undefined
        ? AbortSignal.any([outer, timeout])
        : (outer ?? timeout ?? new AbortController().signal);
    if (deadlineMs === undefined) return work(signal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const running = work(signal);
    try {
      return await Promise.race([
        running.then((value) => {
          settled = true;
          return value;
        }),
        new Promise<T>((resolve) => {
          timer = setTimeout(() => resolve(onTimeout()), deadlineMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (!settled) running.catch(() => undefined);
    }
  }

  async function callProvider(
    state: RunState,
    offered: readonly ProviderToolSpec[],
  ): Promise<ProviderTurn> {
    return withDeadline(
      async (signal) => {
        const result = await provider.generate(
          {
            modelId: state.input.modelId,
            messages: state.messages,
            ...(offered.length === 0 ? {} : { tools: offered }),
          },
          {
            signal,
            requestId: newId("req"),
            timeoutMs: limits.providerCallMs,
            taskId: state.input.taskId,
          },
        );
        return {
          text: result.text,
          toolCalls: result.toolCalls,
          usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
          finishReason: result.finishReason,
        };
      },
      limits.providerCallMs,
      state.input.signal,
      () => {
        throw new ProviderError(
          "timeout",
          `the provider call passed D-074's absolute ceiling of ${limits.providerCallMs} ms`,
          {},
        );
      },
    );
  }

  async function runTool(
    call: ToolCall,
    taskId: string,
    outer: AbortSignal | undefined,
  ): Promise<ToolOutcome> {
    const deadlineMs = deadlineFor(call.tool, limits.toolDeadlines);
    return withDeadline(
      async (signal) => tools.run(call, { taskId, signal, deadlineMs }),
      deadlineMs,
      outer,
      () => ({
        ok: false,
        // D-074: "the outcome is reported as `timeout` — a distinct code, never `failure`", because "it took too long"
        // and "it did not work" need different responses — and §7.3 makes the difference matter, since a timed-out side
        // effect is reconciled rather than blindly retried.
        output: `'${call.tool}' passed its ${deadlineMs} ms deadline (D-074) and was signalled to stop; whether its external effect already happened is not knowable from here`,
        code: "timeout",
      }),
    );
  }

  /** The one place a tool runs, and the reason both paths that reach an executor come through it: two copies of "log the
   *  start, run it, log the outcome" is how the two drift, and the drift would appear in the audit trail rather than in
   *  the behaviour. `begin` is the caller's last word before the effect, evaluated *inside* the transaction that writes
   *  `tool.execution.started` — which is where an approval consumption belongs, so the arbiter's row, the state move and
   *  the event commit together. A refusal from `begin` is logged as `tool.execution.blocked` and the executor is never
   *  touched, which is the whole difference between "consumed then ran" and "ran then consumed". */
  async function execute(
    state: RunState,
    input: {
      readonly call: ToolCall;
      readonly tier: Tier | undefined;
      readonly approvalId?: string;
      readonly evidence?: TransitionEvidence;
      readonly begin?: (emit: Emit, at: number) => { reason: string; code?: string } | undefined;
    },
  ): Promise<{
    readonly outcome?: ToolOutcome;
    readonly refusal?: { reason: string; code?: string };
  }> {
    const startedAt = now();
    const begun = phase(state.input.taskId, state.input.correlationId, (emit) => {
      const refusal = input.begin?.(emit, startedAt);
      if (refusal !== undefined) {
        emit(
          "tool.execution.blocked",
          {
            tool: input.call.tool,
            reason: refusal.reason,
            ...(refusal.code === undefined ? {} : { code: refusal.code }),
            ...(input.approvalId === undefined ? {} : { approvalId: input.approvalId }),
          },
          startedAt,
        );
        return { refusal };
      }
      const task = currentTask(state.input.taskId);
      // §4.1 has no `planning` → `completed` edge, and this is why: nothing has executed yet, so a task enters `running`
      // when its first action does rather than at the end. One already running does not move again — a self-transition is
      // how a runtime that lost an event looks like progress (§4.1's third untabled rule).
      if (task.state !== "running") move(task, "running", input.evidence ?? {}, emit, startedAt);
      emit(
        "tool.execution.started",
        {
          tool: input.call.tool,
          args: input.call.args,
          ...(input.tier === undefined ? {} : { tier: input.tier }),
          ...(input.approvalId === undefined ? {} : { approvalId: input.approvalId }),
          deadlineMs: deadlineFor(input.call.tool, limits.toolDeadlines) ?? null,
        },
        startedAt,
      );
      return {};
    });
    if (begun.refusal !== undefined) return begun;

    const outcome = await runTool(input.call, state.input.taskId, state.input.signal);
    const doneAt = now();
    phase(state.input.taskId, state.input.correlationId, (emit) => {
      emit(
        outcome.ok ? "tool.execution.completed" : "tool.execution.failed",
        {
          tool: input.call.tool,
          output: outcome.output,
          durationMs: doneAt - startedAt,
          ...(input.approvalId === undefined ? {} : { approvalId: input.approvalId }),
          ...(outcome.code === undefined ? {} : { code: outcome.code }),
        },
        doneAt,
      );
    });
    return { outcome };
  }

  // ------------------------------------------------------------------ the gated action

  function approvalPayload(record: ApprovalRecord): Record<string, unknown> {
    // §6.3's fields travel with the event, so a client can render the prompt from the stream alone and a reader a week
    // later can see what the user was actually shown (D-065's reasoning about the audit record keeping the exact
    // target in plaintext).
    return { approvalId: record.id, state: record.state, ...record.request };
  }

  /** Where a gated action becomes a prompt: `evaluate` answered `require-approval`, the arbiter opens the row, and the
   *  task moves to `awaiting_approval` in the same transaction as the event that says a prompt exists. */
  function openApproval(
    state: RunState,
    task: TaskRecord,
    proposed: ProviderToolCall,
    call: ToolCall,
    approval: Extract<ReturnType<typeof evaluate>, { outcome: "require-approval" }>["approval"],
    messages: readonly ProviderMessage[],
    steps: number,
  ): StepResult {
    const at = now();
    // The arbiter's write happens *inside* the transaction, with the state move and the event that announce it. In
    // production all three land in one SQLite commit (`packages/storage`'s `transact`), so a crash cannot leave a row
    // saying `pending` beside a task that never moved, nor a prompt in the log with nothing in the queue to answer:
    // §5.1's pairing rule, applied to the approval instead of to the task.
    const opened = phase(task.id, state.input.correlationId, (emit) => {
      const result = approvals.open(approval, at);
      if (!result.ok) return result;
      // A deduplicated open emits nothing: two `approval.requested` frames for one prompt is how a queue starts showing
      // a user the same decision twice, which is what the arbiter's `deduplicated` flag exists to prevent.
      if (result.deduplicated !== true) emit(result.event, approvalPayload(result.record), at);
      const fresh = currentTask(task.id);
      if (fresh.state !== "awaiting_approval") move(fresh, "awaiting_approval", {}, emit, at);
      return result;
    });
    if (!opened.ok) {
      // `denied` is the arbiter refusing the *exact* re-request of a denied binding (§6.3): a user decision, and
      // therefore the ladder's business. Any other code means policy built a request the arbiter will not carry, which
      // is a defect in this build — failing loudly is the only honest answer, and the sentence is the arbiter's.
      if (opened.code !== "denied") {
        return {
          stop: fail(
            task.id,
            `approval.${opened.code}`,
            opened.reason,
            "internal",
            state.input.correlationId,
            { tool: call.tool },
          ),
        };
      }
      const refusals = approvals.refusalCount(task.id, call.tool);
      if (refusals >= limits.refusalsBeforePause) {
        return { stop: pause(state, task.id, call.tool, opened.reason, refusals, at) };
      }
      phase(task.id, state.input.correlationId, (emit) => {
        emit("tool.execution.blocked", { tool: call.tool, reason: opened.reason, refusals }, at);
      });
      return { messages: [...messages, toolMessage(proposed.id, opened.reason)], steps };
    }
    return {
      stop: {
        kind: "awaiting-approval",
        task: currentTask(task.id),
        run: {
          taskId: task.id,
          approvalId: opened.record.id,
          call,
          toolCallId: proposed.id,
          messages,
          steps,
          input: state.input,
        },
      },
    };
  }

  /** §6.3's ladder. The arbiter reports the count and the loop is what decides the count means "stop asking"; a pause is
   *  D-086's shape — the task stays in `awaiting_approval`, the one non-terminal state that means "a human must act",
   *  with no pending request in the queue and the reason in the log. */
  function pause(
    state: RunState,
    taskId: string,
    tool: string,
    reason: string,
    refusals: number,
    at: number,
  ): LoopOutcome {
    phase(taskId, state.input.correlationId, (emit) => {
      const fresh = currentTask(taskId);
      if (fresh.state !== "awaiting_approval") move(fresh, "awaiting_approval", {}, emit, at);
      emit(
        "task.progress",
        {
          paused: true,
          tool,
          refusals,
          limit: limits.refusalsBeforePause,
          reason,
          // §6.3 asks for the pause to be *surfaced*, and §5.2's rule is that anything a client must act on is also
          // retrievable by polling: the polled state is `awaiting_approval`, and this event is the reason it is.
          next: "answer with a materially different action, change the objective, or cancel the task",
        },
        at,
      );
    });
    return { kind: "paused", task: currentTask(taskId), tool, refusals, reason };
  }

  /** One proposed call through §4.4's pipeline. */
  async function gateOne(
    state: RunState,
    proposed: ProviderToolCall,
    messages: readonly ProviderMessage[],
    steps: number,
  ): Promise<StepResult> {
    const at = now();
    const task = currentTask(state.input.taskId);
    const correlationId = state.input.correlationId;

    if (declaredSpec(proposed.name) === undefined) {
      // §3.1's third rule: a completion may propose tool calls, and only that. A name no executor declared has nothing
      // to run, and asking policy about it would produce an answer about a tool this build does not have.
      const reason = `'${proposed.name}' was proposed by the model, but no executor in this build declares it, so there is nothing to run`;
      phase(task.id, correlationId, (emit) => {
        emit(
          "tool.call.proposed",
          { tool: proposed.name, args: proposed.arguments, outcome: "not-declared" },
          at,
        );
        emit("tool.execution.blocked", { tool: proposed.name, reason, class: "validation" }, at);
      });
      return { messages: [...messages, toolMessage(proposed.id, reason)], steps };
    }

    const call = toToolCall(proposed);
    const decision = evaluate(call, state.subject, state.input.ctx, at);
    phase(task.id, correlationId, (emit) => {
      emit(
        "tool.call.proposed",
        {
          tool: call.tool,
          args: call.args,
          outcome: decision.outcome,
          ...(decision.outcome === "unavailable" ? {} : { tier: decision.tier }),
          ...(decision.outcome === "allow" || decision.outcome === "require-approval"
            ? { behavior: decision.behavior }
            : { reason: decision.reason }),
        },
        at,
      );
    });

    if (decision.outcome === "require-approval") {
      return openApproval(state, task, proposed, call, decision.approval, messages, steps);
    }

    if (decision.outcome === "deny" || decision.outcome === "unavailable") {
      // §13's distinction survives into the event: a capability this identity does not hold is a denial the user can
      // fix, and one removed at pairing is a feature this client does not have. The same sentence for both is the defect
      // `packages/policy`'s own header refuses.
      // `unavailable` carries no tier on purpose: a tool this client does not have was never classified for it, and
      // printing one would suggest the platform was the reason rather than the pairing.
      const tier = decision.outcome === "deny" ? decision.tier : undefined;
      phase(task.id, correlationId, (emit) => {
        emit(
          "tool.execution.blocked",
          {
            tool: call.tool,
            reason: decision.reason,
            class: decision.outcome === "unavailable" ? "platform-unsupported" : "policy",
            ...(tier === undefined ? {} : { tier }),
          },
          at,
        );
      });
      return { messages: [...messages, toolMessage(proposed.id, decision.reason)], steps };
    }

    // ---- allowed: execute, through the one function that runs a tool
    const executed = await execute(state, { call, tier: decision.tier });
    const output = executed.outcome?.output ?? executed.refusal?.reason ?? "";
    return { messages: [...messages, toolMessage(proposed.id, output)], steps };
  }

  // ------------------------------------------------------------------ the drive

  async function drive(state: RunState): Promise<LoopOutcome> {
    let current = state;
    for (;;) {
      const task = currentTask(current.input.taskId);
      if (isTerminal(task.state)) {
        return refused(
          task,
          "task.terminal",
          `task ${task.id} is \`${task.state}\`, which is terminal and absorbing (AGENT_RUNTIME.md §4.1): a retry is a new task, not a resurrection`,
        );
      }

      const offered = offeredTools(current.subject);
      let turn: ProviderTurn;
      try {
        turn = await callProvider(current, offered);
      } catch (error) {
        return providerFailure(current, error);
      }

      if (turn.toolCalls.length === 0) return complete(current, turn);
      if (turn.toolCalls.length > limits.toolCallsPerResponse) {
        return fail(
          task.id,
          "limits.tool_calls_per_response",
          `the completion proposed ${turn.toolCalls.length} tool calls and the limit is ${limits.toolCallsPerResponse} ` +
            "(D-074's parallel tool steps in one task, priced as a per-response cap by D-088); change it with " +
            "`crabby config set limits.toolCallsPerResponse`",
          "resource-limit",
          current.input.correlationId,
          { proposed: turn.toolCalls.length, limit: limits.toolCallsPerResponse },
        );
      }

      let messages: readonly ProviderMessage[] = [
        ...current.messages,
        { role: "assistant", content: turn.text, toolCalls: turn.toolCalls },
      ];
      let steps = current.steps;
      for (const proposed of turn.toolCalls) {
        steps += 1;
        if (steps > limits.stepsPerTask) {
          return fail(
            task.id,
            "limits.steps_per_task",
            `task ${task.id} reached the per-task step limit of ${limits.stepsPerTask} (PROVIDERS_AND_TOOLS.md §5.2, ` +
              "priced by D-088); change it with `crabby config set limits.stepsPerTask`",
            "resource-limit",
            current.input.correlationId,
            { steps: steps - 1, limit: limits.stepsPerTask },
          );
        }
        const gated = await gateOne({ ...current, messages, steps }, proposed, messages, steps);
        if ("stop" in gated) return gated.stop;
        messages = gated.messages;
        steps = gated.steps;
      }
      current = { ...current, messages, steps };
    }
  }

  function complete(state: RunState, turn: ProviderTurn): LoopOutcome {
    const at = now();
    const taskId = state.input.taskId;
    phase(taskId, state.input.correlationId, (emit) => {
      if (turn.text.length > 0) {
        emit(
          "message.added",
          {
            role: "assistant",
            content: turn.text,
            usage: turn.usage,
            finishReason: turn.finishReason,
          },
          at,
        );
      }
      let task = currentTask(taskId);
      if (task.state === "planning") {
        // The one place the loop makes two moves for what a user sees as one thing, and §4.1 is the reason: `completed`
        // is reachable only from `running`, because "a plan that finished describing work has not done it". The round
        // that produced this answer is the work, so it runs and then completes.
        move(task, "running", {}, emit, at);
        task = currentTask(taskId);
      }
      move(task, "completed", {}, emit, at);
    });
    return { kind: "completed", task: currentTask(taskId), steps: state.steps, text: turn.text };
  }

  function providerFailure(state: RunState, error: unknown): LoopOutcome {
    const at = now();
    const taskId = state.input.taskId;
    const providerError = error instanceof ProviderError ? error : undefined;
    if (providerError?.class === "cancelled") {
      // §6.2 requires the record to say whether the operation was confirmed to stop and whether its effects may already
      // have happened. This loop knows neither — what was aborted is a provider call, not the tool whose side effect is
      // in question — so it moves to `cancelling` and stops, which is the half of §6.1 it can honestly do.
      const reason = `the provider call was cancelled (${providerError.message}); §6's settle — whether the operation stopped, and whether its effects are uncertain — belongs to the cancellation manager, which is not in this build`;
      phase(taskId, state.input.correlationId, (emit) => {
        const task = currentTask(taskId);
        if (task.state !== "cancelling") move(task, "cancelling", {}, emit, at);
      });
      return { kind: "cancelling", task: currentTask(taskId), reason };
    }
    const code = providerError === undefined ? "provider.error" : `provider.${providerError.class}`;
    const reason =
      providerError === undefined
        ? `the provider call failed with something that is not a ProviderError: ${String(error)}`
        : providerError.message;
    return fail(
      taskId,
      code,
      reason,
      providerError === undefined ? "internal" : "provider",
      state.input.correlationId,
      {
        // Naming the absence is the point: a reader of this event knows the task failed on the first error and that
        // D-043's ladder is not wired yet, rather than wondering whether five attempts happened somewhere.
        retried: false,
        ladder:
          "D-043's retry ladder is not in this build; the task failed on the first provider error",
        ...(providerError === undefined ? {} : { retryable: providerError.retryable }),
      },
    );
  }

  // ------------------------------------------------------------------ the two entry points

  async function start(input: RunInput): Promise<LoopOutcome> {
    const existing = journal.task(input.taskId);
    if (existing === undefined) {
      return refused(
        undefined,
        "task.not_found",
        `no task ${input.taskId} in the journal, so there is nothing to run`,
      );
    }
    if (existing.state !== "queued") {
      return refused(
        existing,
        "task.not_queued",
        `task ${existing.id} is \`${existing.state}\`, and this loop starts a \`queued\` task; one that was already moving is ` +
          "§7.1's recovery to resume, not a second `start` (AGENT_RUNTIME.md §4.1)",
      );
    }
    const at = now();
    phase(input.taskId, input.correlationId, (emit) => {
      // §3.1's Plan → Execute is a rule and not advice, which is why `running` is unreachable from `queued` (D-083): the
      // plan is the first provider round, and the task says it is planning before that round is made.
      move(currentTask(input.taskId), "planning", {}, emit, at);
    });
    const task = currentTask(input.taskId);
    return drive({
      input,
      subject: { ...input.subject, taskId: task.id },
      // The objective is the user's own sentence, so it is the first message. Treating whatever comes back from a tool
      // or a file as data rather than instructions is D-065's rule and the executor's job; the loop cannot add it here.
      messages: [{ role: "user", content: task.objective }],
      steps: 0,
    });
  }

  async function resume(run: SuspendedRun): Promise<LoopOutcome> {
    const at = now();
    const existing = journal.task(run.taskId);
    if (existing === undefined) {
      return refused(
        undefined,
        "task.not_found",
        `no task ${run.taskId} in the journal; a pending approval is deleted with its task (docs/DATA_AND_MEMORY.md §7)`,
      );
    }
    if (isTerminal(existing.state)) {
      return refused(
        existing,
        "task.terminal",
        `task ${existing.id} is \`${existing.state}\`, which is terminal and absorbing (AGENT_RUNTIME.md §4.1), so the approval that was open for it cannot be spent`,
      );
    }
    const row = approvals
      .list({ taskId: run.taskId })
      .find((record) => record.id === run.approvalId);
    if (row === undefined) {
      return refused(
        existing,
        "approval.not_found",
        `approval ${run.approvalId} is not in the queue for task ${run.taskId}, so there is no answer to act on`,
      );
    }
    const state: RunState = {
      input: run.input,
      subject: { ...run.input.subject, taskId: run.taskId },
      messages: run.messages,
      steps: run.steps,
    };

    if (row.state === "pending") {
      if (at <= row.request.expiresAt) {
        // §7.2's second bullet, and the reason `resume` writes nothing on this path: a pending approval is not an
        // approved one because a restart occurred, and it is not an approved one because a runner asked either.
        return refused(
          existing,
          "approval.pending",
          `approval ${row.id} is still pending and expires at ${new Date(row.request.expiresAt).toISOString()}; a pending ` +
            "approval must not be treated as approved (AGENT_RUNTIME.md §7.2)",
        );
      }
      // The deadline passed with nobody answering. `sweep` is the arbiter's, so the row and its event are written by the
      // object that owns them and this loop gets no second opinion about expiry.
      phase(run.taskId, run.input.correlationId, (emit) => {
        // Inside the transaction for the same reason as `open`: the rows that expire and the events that say so commit
        // together, or a client can read a queue the log disagrees with.
        const swept = approvals.sweep(at);
        for (const change of swept.expired) {
          if (change.record.request.taskId !== run.taskId) continue;
          emit(change.event, approvalPayload(change.record), at);
        }
      });
      return reRequest(state, run, "the request expired unanswered");
    }

    if (row.state === "expired") return reRequest(state, run, "the request had already expired");

    if (row.state === "denied") {
      const reason = `approval ${row.id} was denied${row.answeredBy === undefined ? "" : ` by ${row.answeredBy}`}; a denial is respected rather than retried into an approval (AGENT_RUNTIME.md §5's rule 5)`;
      const refusals = approvals.refusalCount(run.taskId, run.call.tool);
      if (refusals >= limits.refusalsBeforePause) {
        return pause(state, run.taskId, run.call.tool, reason, refusals, at);
      }
      // §4.1's `awaiting_approval` → `planning` edge: a denial that leaves other work possible re-plans rather than dies.
      phase(run.taskId, run.input.correlationId, (emit) => {
        emit(
          "tool.execution.blocked",
          { tool: run.call.tool, reason, refusals, approvalId: row.id },
          at,
        );
        const task = currentTask(run.taskId);
        if (task.state === "awaiting_approval") move(task, "planning", {}, emit, at);
      });
      return drive({
        ...state,
        messages: [...state.messages, toolMessage(run.toolCallId, reason)],
      });
    }

    if (row.state === "consumed") {
      return refused(
        existing,
        "approval.consumed",
        `approval ${row.id} has already been used, so this run was already resumed; \`scope: once\` means once (D-052)`,
      );
    }

    // ---- approved: the moment of execution.
    // §5's rule 6 and §6.3's material-change rule can only be checked against the action as it stands *now*, so policy is
    // asked again on this line instead of being trusted from the moment the prompt was built. The case that matters is a
    // grant revoked while the prompt was pending: the user approved, and the answer is still no.
    const decision = evaluate(run.call, state.subject, run.input.ctx, at);
    if (decision.outcome === "deny" || decision.outcome === "unavailable") {
      const reason =
        `approval ${row.id} was approved, but re-evaluating at the moment of execution answers \`${decision.outcome}\`: ` +
        `${decision.reason} The approval is left unspent and expires under D-064's window rather than being used for an ` +
        "action policy now refuses";
      phase(run.taskId, run.input.correlationId, (emit) => {
        emit("tool.execution.blocked", { tool: run.call.tool, reason, approvalId: row.id }, at);
        const task = currentTask(run.taskId);
        if (task.state === "awaiting_approval") move(task, "planning", {}, emit, at);
      });
      return drive({
        ...state,
        messages: [...state.messages, toolMessage(run.toolCallId, reason)],
      });
    }
    if (decision.outcome === "require-approval" && rank(decision.tier) > rank(row.request.tier)) {
      // §6.2's T3 row says "re-prompt on every material change", and §8's re-check-after-resolution rule is how a change
      // can arrive this late: the path a symlink resolves to is the path being approved, and a resolution that lands
      // outside the workspace raises the tier between the prompt and the execution. Spending a T2 signature on a T3
      // action would be the blanket authorization §5's rule 4 forbids, so the signed row is left unspent — it expires
      // inside D-064's window, and an approval this loop never ran is not a refusal (D-084).
      const reason =
        `approval ${row.id} was signed as \`${row.request.tier}\`, but re-evaluating at the moment of execution answers ` +
        `\`${decision.tier}\`: ${decision.reasons.at(-1) ?? "the action's risk rose while the prompt was open"}. A higher tier ` +
        "needs its own signature (SECURITY.md §6.2), so this one is left unspent and a fresh request is opened";
      phase(run.taskId, run.input.correlationId, (emit) => {
        emit(
          "tool.execution.blocked",
          { tool: run.call.tool, reason, approvalId: row.id, tier: decision.tier },
          at,
        );
      });
      return reRequest(state, run, reason);
    }
    // When policy still requires an approval, the binding it computes *now* is the one compared against the row: that
    // comparison is the material-change rule, and it is the arbiter's to make (D-084), not this loop's.
    const binding =
      decision.outcome === "require-approval" ? decision.approval.binding : row.request.binding;
    // The consumption, the state move and the `tool.execution.started` event are one transaction, because the arbiter's
    // write is a row in the same database: an approval that says `consumed` beside a log that says nothing is the bug
    // §5.1's pairing rule exists to make impossible. And it is committed *before* the effect, never after — see the
    // header. A crash between the commit and the completion event leaves `tool.execution.started` with no outcome, which
    // is §7.3's uncertain case and D-065's checkpoint boundary; the checkpoint manager owns the reconciliation and this
    // loop does not pretend to.
    const executed = await execute(state, {
      call: run.call,
      tier: row.request.tier,
      approvalId: row.id,
      // §4.1's one edge into `running` that requires evidence, and the evidence is the answer the arbiter recorded:
      // §5's rule 5 and §7.2 both refuse to let a pending approval act as an approved one, and `transition()` enforces it.
      evidence: { approvalAnswered: "approved" },
      begin: (emit, beginAt) => {
        const consumed = approvals.consume({
          id: row.id,
          taskId: run.taskId,
          tool: run.call.tool,
          binding,
          at: beginAt,
        });
        if (!consumed.ok) {
          // A refusal that moved the row carries its event, and the loop owes the log that entry (D-084).
          if (consumed.event !== undefined) emit(consumed.event, approvalPayload(row), beginAt);
          return { reason: consumed.reason, code: consumed.code };
        }
        emit(
          consumed.event,
          { ...approvalPayload(consumed.record), tool: run.call.tool, binding },
          beginAt,
        );
        return undefined;
      },
    });
    if (executed.outcome === undefined) {
      const reason = executed.refusal?.reason ?? "";
      // A binding that no longer matches, or a deadline that passed between the answer and the execution, both mean the
      // action needs a fresh request — and the loop is the only party allowed to make one.
      if (executed.refusal?.code === "materially-changed" || executed.refusal?.code === "expired") {
        return reRequest(state, run, reason);
      }
      return drive({
        ...state,
        messages: [...state.messages, toolMessage(run.toolCallId, reason)],
      });
    }
    return drive({
      ...state,
      messages: [...state.messages, toolMessage(run.toolCallId, executed.outcome.output)],
    });
  }

  /** §6.3's "the action needs a fresh request", made by the only party allowed to make one: policy is asked again, so the
   *  deadline is D-064's and the tier is today's; the arbiter records `supersedes` and answers `approval.re-requested`;
   *  and the task stays where a prompt puts it. */
  function reRequest(state: RunState, run: SuspendedRun, why: string): LoopOutcome {
    const at = now();
    const decision = evaluate(run.call, state.subject, run.input.ctx, at);
    if (decision.outcome !== "require-approval") {
      return fail(
        run.taskId,
        "approval.re-request_refused",
        `the action behind approval ${run.approvalId} cannot be re-requested, because policy now answers ` +
          `\`${decision.outcome}\` (${why})` +
          (decision.outcome === "deny" || decision.outcome === "unavailable"
            ? `: ${decision.reason}`
            : ""),
        decision.outcome === "unavailable" ? "platform-unsupported" : "policy",
        run.input.correlationId,
        { tool: run.call.tool },
      );
    }
    const proposed: ProviderToolCall = {
      id: run.toolCallId,
      name: run.call.tool,
      arguments: { ...run.call.args },
    };
    const step = openApproval(
      state,
      currentTask(run.taskId),
      proposed,
      run.call,
      decision.approval,
      run.messages,
      run.steps,
    );
    return "stop" in step
      ? step.stop
      : refused(currentTask(run.taskId), "approval.re-request_failed", why);
  }

  return { start, resume };
}
