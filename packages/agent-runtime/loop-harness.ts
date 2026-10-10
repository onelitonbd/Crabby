// The loop's test harness, and the reason `packages/agent-runtime/loop.test.ts` can assert behaviour instead of wiring.
//
// `loop.ts` has four seams — a journal, an arbiter, a provider and an executor — and a test that built all four by hand
// would spend its lines on plumbing and its reviewer's attention on the plumbing too. This file composes the real ones
// where real ones exist: `createApprovals` over `createMemoryApprovalStore` is the arbiter itself (D-084), the provider
// is `packages/providers`' fake held to the same §7 conformance suite a real adapter must pass, and the journal and the
// executor are the two things this build genuinely does not have yet — `packages/storage`'s SQLite journal is a
// Gateway-side composition, and `ARCHITECTURE.md` §18's `packages/tools` does not exist.
//
// What it does NOT model, stated because a harness that quietly stands in for a missing subsystem is how a mock gets
// shipped as a product:
//
//   - `transact` runs its body and returns. There is no rollback here, so a throw inside a write phase leaves this
//     journal half-written; atomicity is a property of `packages/storage`'s SQLite transaction and is observable in
//     `tests/integration`, not in a Map.
//   - Events are not redacted. Redaction is a write-path concern of the SQLite journal (`SECURITY.md` §7, and
//     `packages/storage/events.ts` does it on the way in), so a harness that redacted would be asserting a property of
//     itself.
//   - The executor records. It runs no filesystem, no network and no shell, and it declares only the tools a test gives
//     it — which is the point: the loop offers the model nothing an executor cannot run.
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
import type { TaskJournal } from "./journal.ts";
import {
  createLoop,
  type Loop,
  type LoopLimits,
  type LoopOutcome,
  type LoopSubject,
  type SuspendedRun,
  type ToolOutcome,
  type ToolRunContext,
  type ToolSurface,
} from "./loop.ts";

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
  readonly grants?: readonly string[];
  readonly removedGrants?: readonly string[];
  readonly clientKind?: LoopSubject["clientKind"];
  readonly isTermux?: boolean;
  readonly ctx?: EvalContext;
  readonly limits?: Partial<LoopLimits>;
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
  readonly clock: { now(): number; advance(ms: number): void; set(ms: number): void };
  /** Everything the journal stored, in order. */
  readonly events: Event[];
  /** Everything handed to `publish`, in order. Equal to `events` by construction, and the equality is the assertion:
   *  an event that was stored and never published is a client that never learned the truth, and one published from
   *  inside its transaction throws above. */
  readonly published: Event[];
  /** Every state the task record held, in order, so a test asserts the path and not just the destination. */
  readonly states: TaskState[];
  readonly executions: Execution[];
  readonly provider: Provider & { readonly calls: FakeCall[] };
  /** The §6 manager, wired to the same journal and subscriber as the loop, so a test can request a cancellation from
   *  the outside the way an interface would and watch the loop honour it. */
  readonly cancellation: Cancellation;
  task(): TaskRecord | undefined;
  eventsOfType(type: EventType): Event[];
  payloadOf(type: EventType): Record<string, unknown> | undefined;
  pending(): readonly ApprovalRecord[];
  start(input?: {
    subject?: Partial<LoopSubject>;
    correlationId?: string;
    /** A cancellation the loop must pass to the provider and to every tool (`docs/DEVELOPMENT.md` §4: cancellation via
     *  `AbortSignal` everywhere). Aborting it is how a test reaches §6's half-built door. */
    signal?: AbortSignal;
  }): Promise<LoopOutcome>;
  resume(run: SuspendedRun): Promise<LoopOutcome>;
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
      const result = await one.generate(request, ctx);
      calls.push(...one.calls);
      return result;
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
    setState: (taskId, state, error) => {
      if (taskId !== record.id)
        throw new Error(`the harness journal holds one task, not ${taskId}`);
      // Rebuilt field by field rather than spread, because `packages/storage`'s `setState` writes the error columns on
      // every call: a move that carries no error clears the one a previous state left, and a record that kept it would
      // show a reason for a state that no longer has one.
      record = {
        id: record.id,
        sessionId: record.sessionId,
        objective: record.objective,
        createdAt: record.createdAt,
        state,
        updatedAt: new Date(input.clock.now()).toISOString(),
        lastSeq: record.lastSeq,
        ...(error === undefined ? {} : { error }),
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

function createRecordingTools(declared: readonly HarnessTool[]): {
  surface: ToolSurface;
  executions: Execution[];
} {
  const executions: Execution[] = [];
  const surface: ToolSurface = {
    specs: (): readonly ProviderToolSpec[] =>
      declared.map((tool) => ({
        name: tool.name,
        description: tool.description ?? `${tool.name}, as the harness declares it`,
        parameters: tool.parameters ?? { type: "object", properties: {} },
      })),
    run: async (call, ctx: ToolRunContext): Promise<ToolOutcome> => {
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
  const tools = createRecordingTools(options.tools ?? []);
  const provider = createScriptedProvider(options.rounds, {
    ...(options.models === undefined ? {} : { models: options.models }),
  });
  const published: Event[] = [];
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
  const cancellation = createCancellation({
    journal: memory.journal,
    publish: publishEvent,
    now: clock.now,
  });
  const loop = createLoop({
    journal: memory.journal,
    approvals: guardApprovals(approvals, memory.insideTransaction),
    cancellation,
    provider,
    tools: tools.surface,
    platform: { isTermux: options.isTermux ?? false },
    // A real subscriber, so the invariant is checked rather than assumed: §9's rule is that publishing happens after the
    // transaction commits and never inside it, and a stream that learned about a write a rollback later took back is a
    // client that has to be told the opposite.
    publish: publishEvent,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
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

  const harness: Harness = {
    loop,
    cancellation,
    approvals,
    taskId,
    sessionId,
    clock,
    events: memory.events,
    published,
    states: memory.states,
    executions: tools.executions,
    provider,
    task: memory.task,
    eventsOfType: (type) => memory.events.filter((event) => event.type === type),
    payloadOf: (type) => memory.events.find((event) => event.type === type)?.payload,
    pending: () => approvals.pending(taskId),
    start: (input = {}) =>
      loop.start({
        taskId,
        modelId: options.modelId ?? FAKE_TOOL_MODEL_ID,
        subject: subject(input.subject),
        ctx: ctxFor(input.subject),
        ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
        // The manager's controller is what an `immediate` cancellation aborts; a test that supplies its own signal is
        // testing the abort itself rather than §6's policy.
        signal: input.signal ?? cancellation.signalFor(taskId),
      }),
    resume: (run) => loop.resume(run),
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
