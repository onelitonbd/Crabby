// The loop's test harness, and the reason `packages/agent-runtime/loop.test.ts` can assert behaviour instead of wiring.
//
// `loop.ts` has four seams — a journal, an arbiter, a provider and an executor — and a test that built all four by hand
// would spend its lines on plumbing and its reviewer's attention on the plumbing too. This file composes the real ones
// where real ones exist: `createApprovals` over `createMemoryApprovalStore` is the arbiter itself (D-084), the provider
// is `packages/providers`' fake held to the same §7 conformance suite a real adapter must pass, and the journal is the one
// thing this build genuinely does not have in-process — `packages/storage`'s SQLite journal is a Gateway-side composition.
// The executor is a recording stand-in, and `options.surface` replaces it with a real one: `packages/tools` exists since
// M2k, and importing it *here* would be a cycle (it implements this package's `ToolSurface`), so the composition happens in
// the test that wants it rather than in the harness.
//
// What it does NOT model, stated because a harness that quietly stands in for a missing subsystem is how a mock gets
// shipped as a product:
//
//   - `transact` runs its body and returns. There is no rollback here, so a throw inside a write phase leaves this
//     journal half-written; atomicity is a property of `packages/storage`'s SQLite transaction and is observable in
//     `tests/integration`, not in a Map.
//   - Events are not redacted, and neither is the checkpoint. Redaction is a write-path concern of the SQLite adapters
//     (`SECURITY.md` §7; `packages/storage/events.ts` and `packages/storage/checkpoints.ts` both do it on the way in), so
//     a harness that redacted would be asserting a property of itself. What the harness *does* assert is the checkpoint's
//     transaction rule, through `guardCheckpoints`: a boundary written outside a phase throws.
//   - The executor records. By default it runs no filesystem, no network and no shell, and it declares only the tools a
//     test gives it — which is the point: the loop offers the model nothing an executor cannot run. A test that passes
//     `surface` gets that executor's real behaviour *and* the recording, because a test that swapped in a filesystem and
//     lost `executions` would have to re-derive them from the event log.
//
// It also owns the §6 manager, wired to the same journal and the same subscriber as the loop, so a test can request a
// cancellation from the outside the way an interface would and watch the loop honour it: `harness.cancel({ mode })` is
// §6.1's step 1, and the run's outcome says whether the step in flight was finished or abandoned.
//
// Run it directly for the trace of one gated task, start to finish: `node packages/agent-runtime/loop-harness.ts`.
import { pathToFileURL } from "node:url";
import {
  type ClientInterface,
  type Event,
  type EventType,
  SCHEMA_VERSION,
  type TaskRecord,
  type TaskState,
} from "@crabby/api-contracts";
import type { EvalContext } from "@crabby/policy";
import {
  FAKE_MODEL_ID,
  FAKE_TOOL_MODEL_ID,
  type FakeCall,
  FakeProvider,
  type FakeStep,
  type Provider,
  type ProviderConfig,
  type ProviderContext,
  type ProviderRequest,
  type ProviderToolSpec,
  type StreamEvent,
} from "@crabby/providers";
import {
  type ApprovalDecision,
  type ApprovalRecord,
  type ApprovalResult,
  type Approvals,
  createApprovals,
  createMemoryApprovalStore,
} from "./approvals.ts";
import { type Cancellation, type CancellationMode, createCancellation } from "./cancellation.ts";
import {
  type CheckpointRecord,
  type Checkpoints,
  createCheckpoints,
  type StepFacts,
} from "./checkpoint.ts";
import type { ContextManager } from "./compact.ts";
import type { TaskJournal } from "./journal.ts";
import {
  type AskCandidates,
  createLoop,
  type Loop,
  type LoopLimits,
  type LoopOutcome,
  type LoopSubject,
  type ModelAnswer,
  type ModelSuspendedRun,
  type RunOrigin,
  type SuspendedRun,
  type ToolInvocationAudit,
  type ToolOutcome,
  type ToolRunContext,
  type ToolSurface,
} from "./loop.ts";
import type { MessageWriter, RecordedMessage } from "./messages.ts";
import { createRunner, type Runner, type RunnerDeps } from "./runner.ts";

/** One tool the harness's executor can run. `parameters` defaults to a declaration of *no* arguments, which is the
 *  strict default: `PROVIDERS_AND_TOOLS.md` §4.3 rejects arguments a tool did not declare, so a test that wants to pass
 *  arguments has to declare them and therefore has to say what the tool takes. */
export interface HarnessTool {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
  readonly output?: string;
  readonly ok?: boolean;
  readonly code?: string;
  /** Ignores its signal for this long. With `honoursSignal: false` this is how a test makes the loop's own D-074
   *  deadline fire in milliseconds instead of the ten seconds the class default costs. */
  readonly hangMs?: number;
  readonly honoursSignal?: boolean;
}

export interface HarnessOptions {
  readonly objective?: string;
  /** One script per provider round, because the fake replays its whole script on every request. */
  readonly rounds: readonly (readonly FakeStep[])[];
  readonly tools?: readonly HarnessTool[];
  /** A real executor to run instead of the recording one — `packages/tools`' `createFileTools`, in
   *  `tests/integration/tools.test.ts`. Its `specs`, `facts` and `declarations` are used as declared, so a test that
   *  composes one is testing §4.3's escalations and §6.2's evidence against a runtime that answers them, rather than
   *  against this harness's silence. */
  readonly surface?: ToolSurface;
  readonly grants?: readonly string[];
  readonly removedGrants?: readonly string[];
  readonly clientKind?: LoopSubject["clientKind"];
  readonly isTermux?: boolean;
  readonly ctx?: EvalContext;
  readonly limits?: Partial<LoopLimits>;
  /** §3.6 stage 2's options, injected the way the Gateway composes them: a harness that had a pool would describe its
   *  own alternatives, and a test that wants the ask to carry candidates says what they are rather than letting the
   *  loop invent them. Absent means the ask with no options, which is also what a single-model install gets. */
  readonly askCandidates?: AskCandidates;
  /** D-112's conversation store. Absent (the default) is the loop-with-no-writer case: no row and no `message.added`,
   *  which is the rule D-112 records and the loop test below asserts. Present composes the memory writer, so a test that
   *  wants to read a transcript gets one. */
  readonly messages?: boolean;
  /** D-117's context manager, injected rather than composed for the same reason `askCandidates` is: a harness
   *  that built its own compactor would be testing the harness's opinion about when a conversation is full.
   *  A test that wants automatic compaction says what its compactor decides, round by round. */
  readonly context?: ContextManager | undefined;
  /** D-064's jitter source and the backoff wait, both injected so a ladder test asserts the *schedule* instead of
   *  sleeping through it: five rungs cost 31 real seconds, and a test that slow is a test nobody runs twice. */
  readonly random?: () => number;
  readonly wait?: (ms: number, signal?: AbortSignal | undefined) => Promise<void>;
  /** D-065's two permissions to pass a step that was in flight. The harness's own executor declares neither, so a test
   *  that wants the `pass` branch supplies the declaration and therefore says which tool it is inventing it for; a test
   *  that composes a real one with `surface` gets `idempotent` from §4.1's record instead
   *  (`stepFactsFromDeclarations`). */
  readonly stepFacts?: (tool: string) => StepFacts;
  /** §14's `tool_invocation` seam: supplied, the loop's audit callback lands here instead of the default collector. */
  readonly auditToolInvocation?: ((entry: ToolInvocationAudit) => void) | undefined;
  readonly modelId?: string;
  readonly models?: readonly string[];
  /** The clock the loop, the arbiter and the events all read. Injectable because D-064's TTLs are the rule under test. */
  readonly start?: number;
  readonly taskId?: string;
  readonly sessionId?: string;
}

export interface Execution {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly outcome: ToolOutcome;
  readonly deadlineMs: number | undefined;
  readonly aborted: boolean;
}

export interface AnswerInput {
  readonly via?: ClientInterface;
  readonly byClientId?: string;
  readonly at?: number;
  readonly scope?: string;
}

export interface Harness {
  readonly loop: Loop;
  readonly approvals: Approvals;
  readonly taskId: string;
  readonly sessionId: string;
  /** The `tool_invocation` facts the loop emitted — the rows §14's trail would hold, collected by default. */
  readonly invocations: readonly ToolInvocationAudit[];
  readonly clock: { now(): number; advance(ms: number): void; set(ms: number): void };
  /** Everything the journal stored, in order. */
  readonly events: Event[];
  /** Everything handed to `publish`, in order. Equal to `events` by construction, and the equality is the assertion:
   *  an event that was stored and never published is a client that never learned the truth, and one published from
   *  inside its transaction throws above. */
  readonly published: Event[];
  /** Every state the task record held, in order, so a test asserts the path and not just the destination. */
  readonly states: TaskState[];
  /** Every backoff the loop asked for, in order. Empty unless a `wait` was injected that records. */
  readonly waits: number[];
  /** D-065's manager, wired to the same journal and clock as the loop and to the same subscriber, so a test reads the
   *  verdict the Gateway's route would read. */
  readonly checkpoints: Checkpoints;
  /** Every boundary the loop committed, in order. The count is the assertion: one write per committed step, and none for
   *  a round that only produced text. */
  readonly checkpointWrites: CheckpointRecord[];
  /** D-112: every turn the run wrote, as the loop was told about it. A harness run has one conversation, so the turns are
   *  the conversation — the storage layer's own rows are asserted where the storage layer is the subject. */
  readonly turns: readonly RecordedMessage[];
  readonly executions: Execution[];
  readonly provider: Provider & { readonly calls: FakeCall[] };
  /** The §6 manager, wired to the same journal and subscriber as the loop, so a test can request a cancellation from
   *  the outside the way an interface would and watch the loop honour it. */
  readonly cancellation: Cancellation;
  /** The runner, composed on this fixture's own journal, executor, subscriber and managers — the same wiring a Gateway
   *  does. A runner test that built its own deps would prove the runner works against a fiction. */
  runner(overrides?: Partial<RunnerDeps>): Runner;
  task(): TaskRecord | undefined;
  /** The latest boundary, or `undefined` when the run never committed one. */
  checkpoint(): CheckpointRecord | undefined;
  eventsOfType(type: EventType): Event[];
  payloadOf(type: EventType): Record<string, unknown> | undefined;
  pending(): readonly ApprovalRecord[];
  start(input?: {
    subject?: Partial<LoopSubject>;
    correlationId?: string;
    /** The origin a real caller carries — a route run, a fired job — so an audit row can name who drove the task. */
    origin?: RunOrigin;
    /** A cancellation the loop must pass to the provider and to every tool (`docs/DEVELOPMENT.md` §4: cancellation via
     *  `AbortSignal` everywhere). Aborting it is how a test reaches §6's half-built door. */
    signal?: AbortSignal;
  }): Promise<LoopOutcome>;
  resume(run: SuspendedRun): Promise<LoopOutcome>;
  /** D-044's answer, straight onto the loop the way the route reaches it through the runner. The harness does not wrap
   *  it: the point of a unit test here is that the loop's own refusals (a pair the ask never offered, a park that is not
   *  an ask, a terminal task) are the loop's, and a wrapper would be somewhere for them to hide. */
  answerModel(run: ModelSuspendedRun, answer?: ModelAnswer): Promise<LoopOutcome>;
  /** What `createRecovery` does at startup, written through the same journal it uses. Present because F-47's rebuild is
   *  only reachable from `interrupted`, and a harness that could not put a task there would test the entry point's
   *  refusals and never its continuation. No event, because this fixture does not need one — the state is the part the
   *  loop reads. */
  interrupt(): void;
  /** §6.1's step 1 from the outside: record a request, and let the manager decide whether anything is in flight. */
  cancel(input?: {
    mode?: CancellationMode;
    byClientId?: string;
    via?: ClientInterface;
    reason?: string;
    at?: number;
  }): ReturnType<Cancellation["request"]>;
  /** Answers through the arbiter the way `POST /api/v1/approvals/{id}/decision` does, and writes the event that route
   *  writes in the same transaction — so a trace from this harness has the same shape as one from the Gateway. */
  answer(approvalId: string, decision: ApprovalDecision, input?: AnswerInput): ApprovalResult;
}

/** D-112's message writer, over one array — the same trick as the checkpoint store below: a harness run is one
 *  conversation with one task, so the turns it wrote are the table. No redaction here (the fake's texts carry no
 *  credentials and the masking is `packages/storage`'s rule on write), and no ordinal arithmetic beyond the next number,
 *  because an ordinal the storage layer computes and a harness one computes are the same sentence in two places. */
function createMemoryMessageStore(sessionId: string): {
  writer: MessageWriter;
  turns: RecordedMessage[];
} {
  const turns: RecordedMessage[] = [];
  let counter = 0;
  return {
    turns,
    writer: {
      record: (input) => {
        counter += 1;
        const recorded = { id: `msg_harness_${counter}`, ordinal: counter };
        turns.push(recorded);
        // The session id is asserted by the test rather than trusted here: a harness writer that wrote turns into any
        // conversation would make "the turn belongs to the right conversation" untestable at this level.
        void sessionId;
        void input;
        return recorded;
      },
      // Present because the seam requires it, and doing nothing is the honest answer for a harness that
      // never compacts: a loop with no compactor wired must not be able to write a summary, and a
      // harness that pretended to would let a test pass against a write that never happened.
      summarize: (input) => {
        counter += 1;
        const recorded = { id: `msg_harness_${counter}`, ordinal: counter };
        turns.push(recorded);
        void sessionId;
        void input;
        return recorded;
      },
    },
  };
}

/** The checkpoint store, over one variable: D-095's first rule is one row per task replaced at each boundary, and a
 *  harness run is one task, so the latest record *is* the table. `writes` keeps the history the table deliberately does
 *  not, because a test has to be able to assert how many boundaries a run committed and in what order. */
function createMemoryCheckpointStore(): {
  readonly writes: CheckpointRecord[];
  read(taskId: string): CheckpointRecord | undefined;
  write(record: CheckpointRecord): void;
} {
  const writes: CheckpointRecord[] = [];
  let current: CheckpointRecord | undefined;
  return {
    writes,
    read: (taskId) => (current !== undefined && current.taskId === taskId ? current : undefined),
    write: (record) => {
      writes.push(record);
      current = record;
    },
  };
}

/** The checkpoint's version of `guardApprovals`, and the reason the harness can assert D-095's second rule instead of
 *  trusting it: a boundary is written *inside* the phase that commits the step, so a write outside a transaction is a
 *  resume point that could exist for a step a rollback took back. */
export function guardCheckpoints(
  store: {
    read(taskId: string): CheckpointRecord | undefined;
    write(record: CheckpointRecord): void;
  },
  insideTransaction: () => boolean,
): typeof store {
  return {
    read: (taskId) => store.read(taskId),
    write: (record) => {
      if (!insideTransaction()) {
        throw new Error(
          `the checkpoint at step ${record.step} was written outside a transaction, so it could survive a rollback of ` +
            "the step it claims is committed (D-095's rule 2)",
        );
      }
      store.write(record);
    },
  };
}

/** The wait a ladder test does not inject: no sleep at all, so five rungs cost nothing. A test that wants real time
 *  passes its own. */
async function defaultWait(_ms: number, _signal?: AbortSignal): Promise<void> {}

/** The fake replays its entire script on every request, which is what makes it a fixture rather than a conversation:
 *  one round of a multi-round task needs one script. So each round gets its own `FakeProvider` and the wrapper supplies
 *  only the sequencing — the descriptor checks, the abort handling and the error translation are still the fake's, which
 *  is the property `PROVIDERS_AND_TOOLS.md` §7 cares about ("`mock/fake` implements it too, as the reference"). A run
 *  that outlives the scripts repeats the last one, which is how a step-limit test is written: a round that keeps
 *  proposing a call is a task that runs out of budget. */
export function createScriptedProvider(
  rounds: readonly (readonly FakeStep[])[],
  options: { readonly models?: readonly string[]; readonly id?: string } = {},
): Provider & { readonly calls: FakeCall[] } {
  const models = options.models ?? [FAKE_MODEL_ID, FAKE_TOOL_MODEL_ID];
  const id = options.id === undefined ? {} : { id: options.id };
  const base = new FakeProvider({ models, ...id });
  const calls: FakeCall[] = [];
  let round = 0;
  return {
    id: base.id,
    calls,
    describe: () => base.describe(),
    listModels: () => base.listModels(),
    validateConfig: (config: ProviderConfig) => base.validateConfig(config),
    stream: (request: ProviderRequest, ctx: ProviderContext): AsyncIterable<StreamEvent> =>
      base.stream(request, ctx),
    cancel: (handle) => base.cancel(handle),
    countTokens: (text: string) => base.countTokens(text),
    async generate(request, ctx) {
      const index = Math.min(round, rounds.length - 1);
      round += 1;
      // A missing script is an empty round, which the fake answers with its own default text step rather than with an
      // invented reply: the harness never has to guess what a model would have said.
      const one = new FakeProvider({ script: rounds[index] ?? [], models, ...id });
      try {
        return await one.generate(request, ctx);
      } finally {
        // In a `finally`, because a failed attempt is still an attempt: the ladder's whole claim is that it made N calls to
        // the same model, and a record that only kept the ones that succeeded would prove nothing.
        calls.push(...one.calls);
      }
    },
  };
}

/** The journal, over Maps: `seq` starts at 1 and is monotone per task (D-079), `lastSeq` moves with the event because
 *  `packages/storage`'s `appendEvent` is the one writer of that counter, and `ts` comes from the harness clock so an
 *  event's timestamp and an approval's deadline are the same clock a test is moving. */
function createMemoryJournal(input: {
  taskId: string;
  sessionId: string;
  objective: string;
  clock: { now(): number };
}): {
  journal: TaskJournal;
  events: Event[];
  states: TaskState[];
  task(): TaskRecord | undefined;
  insideTransaction(): boolean;
} {
  const events: Event[] = [];
  const states: TaskState[] = [];
  let record: TaskRecord = {
    id: input.taskId,
    sessionId: input.sessionId,
    state: "queued",
    objective: input.objective,
    createdAt: new Date(input.clock.now()).toISOString(),
    updatedAt: new Date(input.clock.now()).toISOString(),
    lastSeq: 0,
  };
  let seq = 0;
  let counter = 0;
  let inTransaction = false;
  const journal: TaskJournal = {
    task: () => record,
    // One task, because a harness run is one task: a recovery test that needs several composes several harnesses rather
    // than pretending one journal holds a database.
    tasks: (states) => (states === undefined || states.includes(record.state) ? [record] : []),
    setState: (taskId, state, patch) => {
      if (taskId !== record.id)
        throw new Error(`the harness journal holds one task, not ${taskId}`);
      // Rebuilt field by field rather than spread, and with the three different omission rules `packages/storage`'s
      // `setState` has: a move that carries no error *clears* the one a previous state left, because a record keeping a
      // reason for a state it is no longer in is a reason nobody can act on; a move that carries no cancellation *keeps*
      // the one that is there, because only the settle writes it and it is written once (F-46); and the same is true of
      // the switch, because the answer that caused it is the only writer (D-044).
      record = {
        id: record.id,
        sessionId: record.sessionId,
        objective: record.objective,
        createdAt: record.createdAt,
        state,
        updatedAt: new Date(input.clock.now()).toISOString(),
        lastSeq: record.lastSeq,
        ...(record.model === undefined ? {} : { model: record.model }),
        ...(patch?.error === undefined ? {} : { error: patch.error }),
        ...(patch?.cancellation === undefined
          ? record.cancellation === undefined
            ? {}
            : { cancellation: record.cancellation }
          : { cancellation: patch.cancellation }),
        // The same two different omission rules for the pair, because SQLite's `COALESCE` is the rule being mirrored: a
        // move that names no switch keeps whatever is there, and one that names a model keeps the switch beside it.
        ...(patch?.model === undefined
          ? record.model === undefined
            ? {}
            : { model: record.model }
          : { model: patch.model }),
        ...(patch?.modelSwitch === undefined
          ? record.modelSwitch === undefined
            ? {}
            : { modelSwitch: record.modelSwitch }
          : { modelSwitch: patch.modelSwitch }),
      };
      states.push(state);
    },
    append: ({ taskId, type, payload, at, correlationId }) => {
      if (taskId !== record.id)
        throw new Error(`the harness journal holds one task, not ${taskId}`);
      seq += 1;
      counter += 1;
      const event: Event = {
        id: `evt_${counter}`,
        schemaVersion: SCHEMA_VERSION,
        type,
        ts: new Date(at).toISOString(),
        sessionId: record.sessionId,
        taskId,
        seq,
        ...(correlationId === undefined ? {} : { correlationId }),
        payload,
      };
      events.push(event);
      record = { ...record, lastSeq: seq, updatedAt: event.ts };
      return event;
    },
    // No rollback: see the header. The seam exists so the loop's write phases are the same shape here as they are over
    // SQLite, and so a test can assert that a phase's row and events were written together rather than separately.
    transact: <T>(body: () => T): T => {
      if (inTransaction) throw new Error("nested transaction: the loop writes one phase at a time");
      inTransaction = true;
      try {
        return body();
      } finally {
        inTransaction = false;
      }
    },
  };
  return { journal, events, states, task: () => record, insideTransaction: () => inTransaction };
}

function createRecordingTools(
  declared: readonly HarnessTool[],
  delegate?: ToolSurface,
): {
  surface: ToolSurface;
  executions: Execution[];
} {
  const executions: Execution[] = [];
  const surface: ToolSurface = {
    specs: (): readonly ProviderToolSpec[] =>
      delegate?.specs() ??
      declared.map((tool) => ({
        name: tool.name,
        description: tool.description ?? `${tool.name}, as the harness declares it`,
        parameters: tool.parameters ?? { type: "object", properties: {} },
      })),
    // D-099's facts and D-098's declarations are forwarded rather than reimplemented: the whole reason a test composes a
    // real executor is that these two answers come from a party that touches the filesystem, and a harness that invented
    // them would be asserting its own fiction twice.
    ...(delegate?.facts === undefined ? {} : { facts: delegate.facts }),
    ...(delegate?.declares === undefined ? {} : { declares: delegate.declares }),
    run: async (call, ctx: ToolRunContext): Promise<ToolOutcome> => {
      if (delegate !== undefined) {
        const outcome = await delegate.run(call, ctx);
        executions.push({
          tool: call.tool,
          args: call.args,
          outcome,
          deadlineMs: ctx.deadlineMs,
          aborted: ctx.signal.aborted,
        });
        return outcome;
      }
      const tool = declared.find((candidate) => candidate.name === call.tool);
      if (tool === undefined) {
        // Unreachable through the loop — it refuses a name no executor declares before policy is asked — and still
        // answered rather than thrown, because an executor that invented a result for an undeclared tool would be the
        // mock this harness is not.
        return {
          ok: false,
          output: `'${call.tool}' is not declared by this executor`,
          code: "not-declared",
        };
      }
      let aborted = false;
      if (tool.hangMs !== undefined) {
        const honours = tool.honoursSignal !== false;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            ctx.signal.removeEventListener("abort", onAbort);
            resolve();
          }, tool.hangMs);
          function onAbort(): void {
            aborted = true;
            clearTimeout(timer);
            resolve();
          }
          if (honours) ctx.signal.addEventListener("abort", onAbort, { once: true });
        });
      }
      const outcome: ToolOutcome =
        aborted && tool.honoursSignal !== false
          ? {
              ok: false,
              output: `'${call.tool}' stopped when its deadline or cancellation signalled it`,
              code: "timeout",
            }
          : {
              ok: tool.ok !== false,
              output: tool.output ?? `${call.tool} ran on ${JSON.stringify(call.args)}`,
              ...(tool.code === undefined ? {} : { code: tool.code }),
            };
      executions.push({
        tool: call.tool,
        args: call.args,
        outcome,
        deadlineMs: ctx.deadlineMs,
        aborted,
      });
      return outcome;
    },
  };
  return { surface, executions };
}

/** The arbiter the *loop* sees: the real one, wrapped in a single check. Every write it makes must happen inside a write
 *  phase, because in production those writes are rows in the same SQLite file the task and its events live in, and a
 *  caller that writes the row outside the transaction gets exactly the disagreement §5.1's pairing rule forbids — an
 *  approval that says `consumed` beside a log that says nothing. The reads are passed through untouched: a queue that
 *  cannot be read between phases is a queue no interface can render.
 *
 *  `harness.approvals` stays the unwrapped arbiter on purpose, so a test can be the *other* opener — a recovery path, a
 *  scheduler — without tripping a guard that is about the loop's discipline and not about the world's. */
export function guardApprovals(inner: Approvals, insideTransaction: () => boolean): Approvals {
  const guard = (name: string): void => {
    if (!insideTransaction()) {
      throw new Error(
        `approvals.${name} was called outside a write phase: the arbiter's row and the task's event commit together ` +
          "or not at all (AGENT_RUNTIME.md §5.1)",
      );
    }
  };
  return {
    ...inner,
    open: (request, at) => {
      guard("open");
      return inner.open(request, at);
    },
    answer: (input) => {
      guard("answer");
      return inner.answer(input);
    },
    consume: (input) => {
      guard("consume");
      return inner.consume(input);
    },
    sweep: (at) => {
      guard("sweep");
      return inner.sweep(at);
    },
  };
}

/** The workspace root the default `EvalContext` uses, and the root `PROVIDERS_AND_TOOLS.md` §4.2's `file.*` rows mean
 *  by "inside the workspace". */
export const WORKSPACE = "/home/user/workspace";

export function createHarness(options: HarnessOptions): Harness {
  let at = options.start ?? 1_700_000_000_000;
  const clock = {
    now: (): number => at,
    advance: (ms: number): void => {
      at += ms;
    },
    set: (ms: number): void => {
      at = ms;
    },
  };
  const taskId = options.taskId ?? "tsk_harness";
  const sessionId = options.sessionId ?? "ses_harness";
  const store = createMemoryApprovalStore();
  let approvalCounter = 0;
  const approvals = createApprovals({
    store,
    newId: () => {
      approvalCounter += 1;
      return `apv_${approvalCounter}`;
    },
  });
  const memory = createMemoryJournal({
    taskId,
    sessionId,
    objective: options.objective ?? "the harness objective",
    clock,
  });
  const tools = createRecordingTools(options.tools ?? [], options.surface);
  const provider = createScriptedProvider(options.rounds, {
    ...(options.models === undefined ? {} : { models: options.models }),
  });
  const published: Event[] = [];
  const waits: number[] = [];
  const recordWait = async (ms: number, signal?: AbortSignal): Promise<void> => {
    waits.push(ms);
    await (options.wait ?? defaultWait)(ms, signal);
  };
  /** One subscriber for both writers — the loop and this harness's `answer()` — so the ordering rule is checked on the
   *  path a real Gateway takes (`POST /api/v1/approvals/{id}/decision` publishes after its transaction commits) and not
   *  only on the loop's. */
  const publishEvent = (event: Event): void => {
    if (memory.insideTransaction()) {
      throw new Error(
        `${event.type} was published inside its own transaction (AGENT_RUNTIME.md §5.1's pairing rule)`,
      );
    }
    published.push(event);
  };
  const checkpointStore = createMemoryCheckpointStore();
  const messageStore = createMemoryMessageStore(sessionId);
  const checkpoints = createCheckpoints({
    // Guarded like the arbiter, so the harness fails a boundary written outside the phase that committed the step.
    store: guardCheckpoints(checkpointStore, memory.insideTransaction),
    journal: memory.journal,
    // The verdict's question is "what does the log say happened after this boundary", and in the harness the log is an
    // array: the same read `packages/storage`'s `readEvents(db, taskId, { afterSeq })` answers in the Gateway.
    eventsAfter: (taskId, afterSeq) =>
      memory.events.filter((event) => event.taskId === taskId && event.seq > afterSeq),
    ...(options.stepFacts === undefined ? {} : { stepFacts: options.stepFacts }),
    now: clock.now,
  });
  const cancellation = createCancellation({
    journal: memory.journal,
    publish: publishEvent,
    checkpoints,
    now: clock.now,
  });
  // Hoisted out of `createLoop`'s argument list so a runner composed on this fixture shares the *same* guarded arbiter
  // and the same platform fact. Two guards would be two opinions about whether a write happened inside a transaction,
  // and the point of `runner()` below is that a runner test is not testing a second, simpler copy of this wiring.
  const guardedApprovals = guardApprovals(approvals, memory.insideTransaction);
  const platform = { isTermux: options.isTermux ?? false };
  /** Every `tool_invocation` fact the loop emitted, collected so a test asserts the row the Gateway would write without
   *  owning a database (§19: the trail lives in another package). */
  const invocations: ToolInvocationAudit[] = [];
  const loop = createLoop({
    journal: memory.journal,
    approvals: guardedApprovals,
    cancellation,
    checkpoints,
    provider,
    tools: tools.surface,
    platform,
    auditToolInvocation: options.auditToolInvocation ?? ((entry) => invocations.push(entry)),
    // A real subscriber, so the invariant is checked rather than assumed: §9's rule is that publishing happens after the
    // transaction commits and never inside it, and a stream that learned about a write a rollback later took back is a
    // client that has to be told the opposite.
    publish: publishEvent,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.random === undefined ? {} : { random: options.random }),
    ...(options.askCandidates === undefined ? {} : { askCandidates: options.askCandidates }),
    ...(options.messages === true ? { messages: messageStore.writer } : {}),
    ...(options.context === undefined ? {} : { context: options.context }),
    wait: recordWait,
    now: clock.now,
  });

  const subject = (overrides: Partial<LoopSubject> = {}): LoopSubject => ({
    grants: options.grants ?? ["fs.read", "fs.write", "net.egress", "task.read"],
    clientKind: options.clientKind ?? "cli",
    ...(options.removedGrants === undefined ? {} : { removedGrants: options.removedGrants }),
    ...overrides,
  });
  // `EvalContext.grants` is the same list the subject holds, because escalation reads it and a harness that let the two
  // disagree would be testing a policy engine against a fiction.
  const ctxFor = (overrides: Partial<LoopSubject> = {}): EvalContext =>
    options.ctx ?? {
      grants: subject(overrides).grants,
      paths: { home: "/home/user", dataDir: "/home/user/.crabby", roots: [WORKSPACE] },
      // An identity resolver is a filesystem with no symlinks in it. That is a fiction, and it is declared rather than
      // omitted because omitting it is not neutral: `packages/policy` fails closed without a resolver and raises a
      // `file.delete` inside the workspace to T3, so a harness that passed no resolver would quietly make every test
      // about T2 a test about T3. A test that wants a symlink hop supplies its own resolver.
      realpathOf: (absolutePath: string) => absolutePath,
    };

  /** `RunnerDeps.ctx` is `EvalContext` minus `grants`, because the runner supplies grants per run from the identity
   *  that asks; this harness's `ctxFor()` includes them, so they are dropped here rather than passed twice. */
  function ctxWithoutGrants(): Omit<EvalContext, "grants"> {
    const base = ctxFor();
    return {
      ...(base.paths === undefined ? {} : { paths: base.paths }),
      ...(base.egressAllowList === undefined ? {} : { egressAllowList: base.egressAllowList }),
      ...(base.realpathOf === undefined ? {} : { realpathOf: base.realpathOf }),
      ...(base.schemasValidated === undefined ? {} : { schemasValidated: base.schemasValidated }),
    };
  }

  const harness: Harness = {
    loop,
    cancellation,
    runner: (overrides = {}) =>
      createRunner({
        journal: memory.journal,
        approvals: guardedApprovals,
        provider,
        tools: tools.surface,
        platform,
        publish: publishEvent,
        cancellation,
        checkpoints,
        modelId: options.modelId ?? FAKE_TOOL_MODEL_ID,
        ctx: ctxWithoutGrants(),
        now: clock.now,
        ...(options.limits === undefined ? {} : { limits: options.limits }),
        ...overrides,
      }),
    approvals,
    taskId,
    sessionId,
    clock,
    events: memory.events,
    published,
    waits,
    checkpoints,
    checkpointWrites: checkpointStore.writes,
    turns: messageStore.turns,
    states: memory.states,
    executions: tools.executions,
    invocations,
    provider,
    task: memory.task,
    checkpoint: () => checkpointStore.read(taskId),
    eventsOfType: (type) => memory.events.filter((event) => event.type === type),
    payloadOf: (type) => memory.events.find((event) => event.type === type)?.payload,
    pending: () => approvals.pending(taskId),
    start: (input = {}) =>
      loop.start({
        taskId,
        modelId: options.modelId ?? FAKE_TOOL_MODEL_ID,
        subject: subject(input.subject),
        ctx: ctxFor(input.subject),
        ...(input.origin === undefined ? {} : { origin: input.origin }),
        ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
        // The manager's controller is what an `immediate` cancellation aborts; a test that supplies its own signal is
        // testing the abort itself rather than §6's policy.
        signal: input.signal ?? cancellation.signalFor(taskId),
      }),
    resume: (run) => loop.resume(run),
    answerModel: (run, answer = {}) => loop.answerModel(run, answer),
    interrupt: () => memory.journal.setState(taskId, "interrupted"),
    cancel: (input = {}) =>
      cancellation.request({
        taskId,
        ...(input.mode === undefined ? {} : { mode: input.mode }),
        ...(input.byClientId === undefined ? {} : { byClientId: input.byClientId }),
        ...(input.via === undefined ? {} : { via: input.via }),
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        ...(input.at === undefined ? {} : { at: input.at }),
      }),
    answer: (approvalId, decision, input = {}) => {
      const answeredAt = input.at ?? clock.now();
      // One transaction for the answer and its event, which is what `POST /api/v1/approvals/{id}/decision` does: the row
      // and the log entry commit together or not at all.
      const outcome = memory.journal.transact(() => {
        // Read the row first, exactly as the route does: a refusal that still moved the row (`expired`) has to describe
        // the row it moved, and `ApprovalResult`'s failure arm carries no record on purpose.
        const before = approvals.list({ taskId }).find((row) => row.id === approvalId);
        const result = approvals.answer({
          id: approvalId,
          decision,
          scope: input.scope ?? "once",
          via: input.via ?? "tui",
          at: answeredAt,
          ...(input.byClientId === undefined ? {} : { byClientId: input.byClientId }),
        });
        const kind = result.event;
        if (kind === undefined || before === undefined) return { result, stored: undefined };
        const stored = memory.journal.append({
          taskId,
          type: kind,
          at: answeredAt,
          payload: {
            approvalId: before.id,
            tool: before.request.tool,
            tier: before.request.tier,
            binding: before.request.binding,
            summary: before.request.summary,
            exact: before.request.exact,
            via: input.via ?? "tui",
            outcome: result.ok ? decision : result.code,
            ...(result.ok ? { state: result.record.state } : {}),
          },
        });
        return { result, stored };
      });
      // After the commit, never inside it — the same line the decision route draws, for the same reason.
      if (outcome.stored !== undefined) publishEvent(outcome.stored);
      return outcome.result;
    },
  };
  return harness;
}

/** The trace of one gated task, printed. This is the "running thing" a reviewer of M2d can watch without reading a
 *  test file: a task plans, reads a file the policy allows, asks for a deletion it may not do alone, is answered on the
 *  Web UI, consumes the approval at the moment of execution, and completes. */
async function main(): Promise<void> {
  const harness = createHarness({
    objective: "tidy the workspace: read notes.md, then delete build/",
    rounds: [
      [{ kind: "tool-call", name: "file.read", arguments: { path: "notes.md" } }],
      [{ kind: "tool-call", name: "file.delete", arguments: { path: "build" } }],
      [{ kind: "text", text: "read notes.md and deleted build/; nothing else was in the way" }],
    ],
    tools: [
      {
        name: "file.read",
        parameters: { type: "object", properties: { path: { type: "string" } } },
        output: "# notes\n- the build directory is disposable",
      },
      {
        name: "file.delete",
        parameters: { type: "object", properties: { path: { type: "string" } } },
        output: "removed build/",
      },
    ],
  });

  const started = await harness.start();
  console.log(`start       → ${started.kind}`);
  console.log(`states      → ${harness.states.join(" → ")}`);
  if (started.kind !== "awaiting-approval") {
    console.log(`expected a prompt, got ${started.kind}`);
    process.exitCode = 1;
    return;
  }
  const prompt = harness.pending()[0];
  if (prompt === undefined) {
    console.log("no prompt was opened, so there is nothing to answer");
    process.exitCode = 1;
    return;
  }
  console.log(
    `prompt      → ${prompt.request.tool} [${prompt.request.tier}] ${prompt.request.exact}`,
  );
  console.log(`              ${prompt.request.whatCouldGoWrong.slice(0, 96)}…`);
  console.log(
    `              expires ${new Date(prompt.request.expiresAt).toISOString()} (D-064's ${prompt.request.tier} window)`,
  );

  // D-065's boundary, at the moment it exists: the run is suspended *at* a step rather than inside one, so the record
  // names the approval that covers it and the verdict says a restart has something to continue from.
  const suspended = harness.checkpoint();
  console.log(
    `checkpoint  → ${suspended?.boundary} at step ${suspended?.step} (seq ${suspended?.lastSeq}, ` +
      `${suspended?.messages.length} messages) — verdict \`${String(
        harness.checkpoints.view(harness.taskId)?.resume.verdict,
      )}\` (D-065: nothing executed, so there is nothing to repeat)`,
  );

  const answered = harness.answer(prompt.id, "approve", { via: "web", byClientId: "cln_demo" });
  console.log(`answer      → ${answered.ok ? answered.record.state : answered.code} (via web)`);

  const resumed = await harness.resume(started.run);
  console.log(`resume      → ${resumed.kind}`);
  console.log(`states      → ${harness.states.join(" → ")}`);
  console.log(
    `executed    → ${harness.executions.map((run) => `${run.tool}(${JSON.stringify(run.args)})`).join(", ")}`,
  );
  const row = harness.approvals.list({ taskId: harness.taskId })[0];
  console.log(`approval    → ${row?.state ?? "absent"} (once means once, D-052)`);
  const settled = harness.checkpoint();
  console.log(
    `checkpoint  → ${harness.checkpointWrites.length} boundaries written (${harness.checkpointWrites
      .map((one) => `step ${one.step}/${one.boundary}`)
      .join(", ")}); the last is seq ${settled?.lastSeq} and its verdict is \`${String(
      harness.checkpoints.view(harness.taskId)?.resume.verdict,
    )}\`, because the task is \`${harness.task()?.state}\` and §4.1 makes that terminal state absorbing`,
  );
  console.log("");
  console.log("the stream a client saw:");
  for (const event of harness.events) {
    console.log(`  ${String(event.seq).padStart(3)}  ${event.type.padEnd(28)} ${summarize(event)}`);
  }
}

function summarize(event: Event): string {
  const payload = event.payload as Record<string, unknown>;
  if (event.type === "task.state.changed" || event.type === "task.completed") {
    return payload.from === undefined
      ? String(payload.to ?? "")
      : `${payload.from} → ${payload.to}`;
  }
  if (event.type.startsWith("approval."))
    return `${payload.approvalId} ${payload.tool} [${payload.tier}]`;
  if (event.type.startsWith("tool."))
    return `${payload.tool}${payload.output === undefined ? "" : ` — ${String(payload.output).slice(0, 48)}`}`;
  if (event.type === "message.added") return String(payload.content).slice(0, 64);
  return "";
}

const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  await main();
}
