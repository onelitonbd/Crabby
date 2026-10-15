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
//   - **No tools of its own.** `ToolSurface` is the seam `ARCHITECTURE.md` §18's `packages/tools` implements, and since
//     M2k it does: eight file tools with §4.1's record filled in, which a runner composes into a loop. The loop still ships
//     none and still offers the model only what the executor it was given declares it can run — the seam is a dependency
//     injected at construction, so this file has no import of `packages/tools` and no opinion about which tools exist.
//   - **The ladder has two rungs, and the second one asks.** D-043's stage 1 is here — the same model and provider,
//     transient classes only, on D-064's schedule with its jitter, `Retry-After` overriding upward, and a
//     `provider.retry.*` event per rung. D-044's stage 2 arrived with the answer surface (INTERFACES §4.3's
//     `POST /tasks/{id}/resume`): a retryable class that spends the budget stops the run in `awaiting_approval` and
//     emits `provider.switch.proposed` with the candidates, and `answerModel` records the switch and continues from the
//     boundary the run had reached. What that answer reaches is *this process's* park, not a cross-process rebuild — the
//     run's messages live in memory here, and while they do, §7.1 marks an ask `interrupted` on the next start, which is
//     F-47's remaining half and the reason no route claims to resume across a restart yet. Tool steps are still never
//     retried at all — see `callProvider` for why that is §7.3's answer and not an omission.
//   - **No cancellation policy of its own** — that is `cancellation.ts`, added in the next slice (M2e). This loop supplies
//     what only the party running a step can know: what was in flight, and whether the step reported back or was walked
//     away from. It stops scheduling steps the moment a request is recorded (§6.1's step 2, and the MUST NOT that follows
//     it), and an abort with no request behind it still stops at `cancelling`, because settling without one would be the
//     runtime inventing a requester.
//   - **No conversation store, and nothing that resumes from a restart.** A suspended run carries its messages in process
//     memory; since M2i a redacted copy of them is durable at each committed step boundary (`checkpoint.ts`, D-095), which
//     is what a runner would rebuild a `RunInput` from — but there is no runner and no product provider adapter, so §7.1
//     still marks the task `interrupted` and §7.2 still decides what may resume. A loop that
//     rebuilt a conversation from the event log instead would be inventing §8's compaction, with the log's redaction and
//     64 KiB truncation already applied to it.
//   - **No streaming.** The loop calls `generate()`, so assistant text arrives whole and is logged as `message.added`;
//     §5.3's `message.stream.delta` path belongs to the streaming slice.
//   - **No result validation.** §4.4's fifth step has nothing to validate against until a tool declares an output
//     schema, and `PROVIDERS_AND_TOOLS.md` §4.1 lists `outputSchema` among the fields the runtime owes (F-41's
//     neighbour): a check with no schema is a check that always passes.
import {
  type CheckpointBoundary,
  type CheckpointPending,
  type ClientInterface,
  type ErrorClass,
  type Event,
  isTerminal,
  newId,
  type TaskModelSwitch,
  type TaskRecord,
  type ToolDeclaration,
  validateToolArguments,
} from "@crabby/api-contracts";
import { LIMITS_DEFAULTS, type LimitsConfig } from "@crabby/core";
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
  retryDelayMs,
  shouldRetry,
} from "@crabby/providers";
import type { ApprovalRecord, Approvals } from "./approvals.ts";
import type { CancellationEvidence, CancellationGate } from "./cancellation.ts";
import type { CheckpointGate, CheckpointRecord } from "./checkpoint.ts";
import { createPhaseWriter, type Emit, type TaskJournal } from "./journal.ts";
import type { MessageWriter } from "./messages.ts";
import type { TransitionEvidence } from "./transitions.ts";

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
  /** D-074's three priced tool classes, so a runner can hand the loop what `config.json` says instead of the defaults. */
  readonly fsTimeoutMs: number;
  readonly netFetchTimeoutMs: number;
  readonly shellRunTimeoutMs: number;
  /** D-086's reading of §6.3's "repeated denial". */
  readonly refusalsBeforePause: number;
  /** D-090: how long an `immediate` cancellation waits for a step that will not stop, before it stops waiting and records
   *  §6.2's uncertainty instead. `finish-step` gets no second clock. */
  readonly cancellationSettleMs: number;
  /** D-043's attempt budget, as `limits.providerAttempts` in `config.json` — whose schema floors it at 5, because D-043's
   *  sentence is "at least 5 attempts per failing stage (configurable)" and the configurable half may not be used to
   *  configure the ladder out of existence. */
  readonly providerAttempts: number;
  /** Per-tool deadlines in milliseconds, keyed by tool name. An override wins over the class default; a tool with
   *  neither runs under the caller's signal alone. There is no `limits.toolDeadlines` key in `config.json` in this
   *  build — D-074's table prices classes, not individual tools — so this field arrives from a composition that
   *  computes it (or a test that needs one clock short), and `loopLimitsOf` below leaves it alone rather than
   *  inventing a key no schema carries. */
  readonly toolDeadlines?: Readonly<Record<string, number>> | undefined;
}

/** D-088's and D-090's numbers, read out of `LIMITS_DEFAULTS` rather than restated: `config.json` is the override and
 *  this is the default, so a second copy here is a number that drifts from the one `crabby config get limits` prints.
 *  `refusalsBeforePause` is the exception, and deliberately: D-086's threshold is a policy floor rather than a timeout or
 *  a budget, and §5.2's `limits.*` list is about the second kind. */
export const LOOP_LIMITS: LoopLimits = {
  stepsPerTask: LIMITS_DEFAULTS.stepsPerTask,
  toolCallsPerResponse: LIMITS_DEFAULTS.parallelToolSteps,
  providerCallMs: LIMITS_DEFAULTS.providerAbsoluteMs,
  fsTimeoutMs: LIMITS_DEFAULTS.fsTimeoutMs,
  netFetchTimeoutMs: LIMITS_DEFAULTS.netFetchTimeoutMs,
  shellRunTimeoutMs: LIMITS_DEFAULTS.shellRunTimeoutMs,
  cancellationSettleMs: LIMITS_DEFAULTS.cancellationSettleMs,
  providerAttempts: LIMITS_DEFAULTS.providerAttempts,
  refusalsBeforePause: 2,
};

/** One key, translated, or nothing: an absent key means the default stands, and the merge below is a spread, so a
 *  present `undefined` would erase the number it meant to override. */
function when<K extends keyof LoopLimits>(
  key: K,
  value: LoopLimits[K] | undefined,
): Partial<LoopLimits> {
  return value === undefined ? {} : ({ [key]: value } as Partial<LoopLimits>);
}

/** D-074's override path, wired: `config.json`'s `limits.*` become the loop's numbers, one key per field, with the one
 *  name the two documents disagree about (`providerAbsoluteMs` vs `providerCallMs`) translated here rather than at each
 *  caller. Every key that maps is a key the loop enforces; the ones that do not map are enforced elsewhere and are named
 *  rather than dropped in silence — the three provider timings and the pool size by §3.1's wrapper and the Gateway's
 *  pool, the SQLite busy timeout by the storage layer, the extension overhead by M4's host, the queued-tasks refusal by
 *  the task manager. `refusalsBeforePause` has no key at all (D-086's floor is a policy, and §5.2's `limits.*` list is
 *  about timeouts and budgets), and `toolDeadlines` has none either: a per-tool override no document prices is a knob
 *  no document describes, so the class table stands alone until one does. */
export function loopLimitsOf(limits: LimitsConfig | undefined): Partial<LoopLimits> {
  if (limits === undefined) return {};
  return {
    ...when("stepsPerTask", limits.stepsPerTask),
    ...when("toolCallsPerResponse", limits.parallelToolSteps),
    ...when("providerCallMs", limits.providerAbsoluteMs),
    ...when("fsTimeoutMs", limits.fsTimeoutMs),
    ...when("netFetchTimeoutMs", limits.netFetchTimeoutMs),
    ...when("shellRunTimeoutMs", limits.shellRunTimeoutMs),
    ...when("cancellationSettleMs", limits.cancellationSettleMs),
    ...when("providerAttempts", limits.providerAttempts),
  };
}

/** D-074's per-tool deadlines, for the classes the table actually prices: `fs.*` 10 s, the network class (`net.fetch`
 *  and, since its own slice, `http.request`) 20 s total, `shell.run` 120 s wall clock. `undefined` means the table
 *  prices no row for that tool, which is F-41's third clause
 *  recorded rather than filled in — a deadline invented for `memory.save` would be a number nobody decided and nobody
 *  could defend. An unpriced tool runs under the caller's signal alone, and its `tool.execution.started` event carries
 *  `deadlineMs: null` so a reader can see that no clock was set. */
export function toolDeadlineMs(tool: string, limits: LoopLimits = LOOP_LIMITS): number | undefined {
  if (tool.startsWith("file.") || tool.startsWith("fs.")) return limits.fsTimeoutMs;
  if (tool === "net.fetch" || tool === "http.request") return limits.netFetchTimeoutMs;
  if (tool === "shell.run") return limits.shellRunTimeoutMs;
  return undefined;
}

/** The deadline that applies to one tool: D-074's class default, unless `config.json` overrode it for this tool. Kept
 *  beside the class table rather than inside it, because the override is a user's number and the class default is a
 *  decided one, and a reader should be able to see which of the two is in force. */
export function deadlineFor(tool: string, limits: LoopLimits = LOOP_LIMITS): number | undefined {
  return limits.toolDeadlines?.[tool] ?? toolDeadlineMs(tool, limits);
}

/** What a tool execution owes the loop. `output` is the text the model sees next and the text the event carries. Two caps
 *  apply to it, and they are not the same cap: §4.4's output limit belongs to the executor, which since M2k truncates and
 *  labels the **wrapped** text at 64 KiB and puts the whole result in scratch with its path in the label (D-098), while
 *  §5.2's inline limit belongs to `packages/storage`, which spills an over-cap event *payload* to a scratch reference on
 *  write. The second one still runs, because an executor is not the only producer of an event and a payload is more than
 *  one tool's output — so a large result is no longer none of this type's problem, and was never only storage's. */
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
  /** Who the run belongs to, when the party that started it recorded one. An executor reads it and can never invent it,
   *  which is why it arrives through this context rather than as a tool argument: `cron.schedule` writes a job that
   *  §4.5 requires to name "a person rather than 'cron'" and to carry only the capability set that person held, and a
   *  field the model could write would be a field the model could widen. Absent means the run has no recorded identity —
   *  a harness, or a composition that predates the field — and a tool that needs one refuses instead of guessing. */
  readonly origin?: RunOrigin;
}

/** The identity a run belongs to, as five facts rather than as a `PolicySubject`: policy decides with *grants*, and this
 *  is the audit half §4.5 asks a scheduled job to carry. The two are kept apart on purpose, because an executor that
 *  could read a subject's grants would be able to reason about authority it does not hold, and a job that recorded grants
 *  instead of capability names would record an expansion that only made sense against the roots of the install that
 *  created it. */
export interface RunOrigin {
  readonly clientId: string;
  readonly clientName: string;
  readonly interface: ClientInterface;
  /** The §6.1 names as recorded on the identity, not the grants they expanded into. */
  readonly capabilities: readonly string[];
  readonly sessionId: string;
}

/** The seam `packages/tools` will fill (`ARCHITECTURE.md` §18, and §19's "the Agent Orchestrator depends on provider,
 *  tool, policy, storage, and event abstractions"). Two methods and no defaults: a tool the executor does not declare is
 *  a tool the loop will not offer the model and will not run, because the alternative is a registry of names with
 *  nothing behind them — the mock this build refuses to ship. */
export interface ToolSurface {
  readonly specs: () => readonly ProviderToolSpec[];
  readonly run: (call: ToolCall, ctx: ToolRunContext) => Promise<ToolOutcome> | ToolOutcome;
  /** The facts §4.3's argument-dependent escalations need and only a runtime can supply (D-099): `preExistingUserFile`
   *  for `file.edit`, `overwrites` for `file.move`. Asked for before the arbiter is. The answer travels as `ToolCall.facts`
   *  and never as an argument, because §10's rule that "a declared field is never an authority" applies with full force to
   *  a field that decides a tier: a completion that wanted T1 would simply declare `preExistingUserFile: false`, and a
   *  channel the model can write to is not an observation. Optional because an executor with no argument-dependent
   *  escalations has nothing to answer, and an absent answer leaves §4.2's base tier standing rather than inventing a
   *  fact. */
  readonly facts?: (call: ToolCall) => Record<string, unknown>;
  /** §4.1's record as the executor declares it (D-098). The loop reads exactly one field of it — `sideEffects`, for
   *  §6.2's cancellation evidence — and the rest is for whoever serves `GET /tools`, because the registry in
   *  `packages/policy` cannot answer fields that are properties of the runtime (`PENDING_RECORD_FIELDS`). Optional for the
   *  same reason, and its absence is D-089's fail-closed default rather than a guess. */
  readonly declares?: (tool: string) => ToolDeclaration | undefined;
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
  /** The provider this run calls, resolved from §3.6's pin by the caller beside `modelId` and never chosen here
   *  (D-101's rule extended from the model to the pair, D-110). Absent means `LoopDeps.provider`, the composed
   *  default — the same fallback `modelId` takes from `RunnerDeps`, so a run without a pin is the run before this
   *  existed. It travels inside `RunInput` so a `SuspendedRun`'s resume keeps calling the provider that started it. */
  readonly provider?: Provider | undefined;
  readonly subject: LoopSubject;
  readonly ctx: EvalContext;
  readonly signal?: AbortSignal | undefined;
  readonly correlationId?: string | undefined;
  /** Carried through to every `ToolRunContext` this run produces, and through a `SuspendedRun` into its resume, because
   *  the identity a run belongs to does not change when a human answers a prompt in the middle of it. */
  readonly origin?: RunOrigin | undefined;
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

/** §3.6 stage 2's option as a client reads it, and the whole of what the loop knows about models other than the one this
 *  run is using. The loop receives these as *data* from whoever composed the pool and names them in the ask; it never
 *  picks one, because D-101's rule is that a provider must not be able to alter what a task does, and a loop that chose
 *  its own fallback would be one step from choosing it on the model's say-so. The answer arrives as
 *  `POST /api/v1/tasks/{id}/resume` (INTERFACES §4.3) and comes back as a pair on `ModelAnswer`.
 *
 *  `losses` is §3.6's "capability loss it would entail", pre-computed against the model the run is on: what the user is
 *  choosing *not* to have. Stating it as a list of sentences rather than two descriptors is deliberate — the same
 *  descriptor for both models would be a fact, and the thing the prompt has to carry is a comparison, and a comparison is
 *  only true relative to something. */
export interface SwitchCandidate {
  /** The `<provider>/<modelId>` pair, spelled the way the answer takes it (D-108, D-110). */
  readonly model: string;
  readonly provider: string;
  readonly cost: string;
  readonly contextWindow: number;
  /** Capabilities this candidate lacks that the current model has, each a sentence a prompt can print verbatim. Empty
   *  means the candidate is not a reduction, which is a fact worth printing too. */
  readonly losses: readonly string[];
}

/** The seam, named so the runner's deps can say the same thing without restating it: given the pair this run is on, hand
 *  back §3.6 stage 2's options. Async because answering it means reading each composed provider's descriptor, and that
 *  read belongs to whoever holds the pool. */
export type AskCandidates = (current: {
  readonly providerId: string;
  readonly modelId: string;
}) => Promise<readonly SwitchCandidate[]>;

/** D-044's second rung: the ladder spent its budget on a retryable class, so the run stops in `awaiting_approval` with
 *  no approval row and asks which model to use instead. `spent` is what the resume reads back to report the rung, and it
 *  is kept on the park rather than recomputed because a reader comparing the answer with the log should find the same
 *  number in both. */
export interface ModelAsk {
  readonly attempts: number;
  readonly limit: number;
  readonly code: string;
  readonly reason: string;
  /** The `<provider>/<modelId>` pair the run was on when the budget ran out, which for a task with no pin is what it
   *  actually called rather than the word "default". */
  readonly current: string;
  readonly candidates: readonly SwitchCandidate[];
}

/** The run held across the ask. Deliberately *not* a `SuspendedRun`: that shape is an approval's (it names a `call`, a
 *  `toolCallId` and a row), and a model ask parks between two provider rounds with no tool call in flight at all. */
export interface ModelSuspendedRun {
  readonly taskId: string;
  readonly messages: readonly ProviderMessage[];
  readonly steps: number;
  readonly input: RunInput;
  readonly ask: ModelAsk;
}

/** What the answer carries. An absent `model` is a real answer rather than an empty body — the budget was spent and the
 *  same model may well answer on a fresh attempt — which is why `pair` rather than a pair is what is optional here. The
 *  provider itself is not part of it: the loop is handed a `Provider`, not told which one to load, because resolving a
 *  `<provider>/<modelId>` pair against the composed pool is the caller's job (D-110) and this package does not hold the
 *  pool (D-101). */
export interface ModelAnswer {
  readonly pair?: { readonly provider: string; readonly modelId: string } | undefined;
  readonly provider?: Provider | undefined;
  readonly byClientId?: string | undefined;
  readonly via?: ClientInterface | undefined;
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
  /** D-044's second rung: the task is in `awaiting_approval` with no pending request, because what it is waiting for is a
   *  *model* rather than an approval, and the runner holds the run until `answerModel` is called with what the user chose
   *  (INTERFACES §4.3's `POST /tasks/{id}/resume`). Kept apart from `paused` — which is a refusal pause with no run to
   *  wake — because this one has a continuation and that one does not, and a caller that conflated them would either lose
   *  the run or wake something that was never asked. */
  | {
      readonly kind: "awaiting-model";
      readonly run: ModelSuspendedRun;
      readonly task: TaskRecord;
      readonly ask: ModelAsk;
    }
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
  /** §6.1's step 6: the permitted work settled, the task is `cancelled`, and §6.2's evidence is on the record. */
  | {
      readonly kind: "cancelled";
      readonly task: TaskRecord;
      readonly evidence: CancellationEvidence;
    }
  /** An abort with no recorded request behind it: the task is in `cancelling` and this loop cannot settle it, because
   *  §6.2's evidence is a fact about a cancellation and nobody asked for one. */
  | { readonly kind: "cancelling"; readonly task: TaskRecord; readonly reason: string }
  /** The loop declined to act and wrote nothing: a pending approval is not an approved one (§7.2), a terminal task does
   *  not resume (§4.1), an already-consumed approval is a duplicate `resume`. */
  | {
      readonly kind: "refused";
      readonly task: TaskRecord | undefined;
      readonly code: string;
      readonly reason: string;
    };

export interface LoopDeps {
  readonly journal: TaskJournal;
  readonly approvals: Approvals;
  readonly provider: Provider;
  readonly tools: ToolSurface;
  /** §4.1's `availability` predicate needs a fact this package must not read from `process.env` (D-014's framework-free
   *  zone), so it arrives the way the Gateway's `GET /api/v1/tools` gets it. */
  readonly platform: PlatformFactsLike;
  /** Called after each transaction commits, never inside one (§9's invariant, and the reason a stream cannot learn
   *  about a write that a rollback later took back). */
  readonly publish: (event: Event) => void;
  /** §6.1's step 2 — stop scheduling new steps — needs a party that knows a cancellation was requested, and §6.2's
   *  evidence needs a party that can record it. A runner wires the same `createCancellation` manager here and to its
   *  callers. Without one the loop still refuses to act on a terminal task, and an abort stops at `cancelling` rather
   *  than settling, because settling with no recorded request would be the runtime cancelling work on its own. */
  readonly cancellation?: CancellationGate | undefined;
  /** D-065's checkpoint, written at each committed step boundary and inside the transaction that commits it. Optional for
   *  the reason `cancellation` is: a loop with no checkpoint manager still runs, and what it loses is a resume point, not
   *  a step. A runner wires the same `createCheckpoints` manager here, to `GET /tasks/{id}/checkpoint`, and to recovery. */
  readonly checkpoints?: CheckpointGate | undefined;
  /** D-112's conversation store. Optional for the reason `checkpoints` is: a loop with no message writer still runs, and
   *  what it loses is a conversation's history, not a step. What it does *not* do is announce a turn it did not store —
   *  §5.2's "anything a client must act on is also retrievable" — so with no writer there is no `message.added` either,
   *  and a transcript built from the stream shows nothing rather than showing something unretrievable. */
  readonly messages?: MessageWriter | undefined;
  readonly limits?: Partial<LoopLimits> | undefined;
  readonly now?: (() => number) | undefined;
  /** D-064's jitter source, injected for the reason `now` is: a jittered schedule a test cannot pin is a schedule nobody
   *  verifies, and "±25%" is a claim about bounds rather than a vibe. */
  readonly random?: (() => number) | undefined;
  /** The backoff wait, injected so a ladder test does not spend 31 real seconds proving five delays were computed. The
   *  default is abortable, because a wait that ignores a cancellation is a wait the user cannot end. */
  readonly wait?: ((ms: number, signal?: AbortSignal | undefined) => Promise<void>) | undefined;
  /** §3.6 stage 2's options, computed where the pool exists and handed to the ask as data — the Gateway composes this
   *  from its own providers (D-110's resolution, done once per ask rather than per run, because the pool a run was handed
   *  may have changed by the time its budget runs out). The loop names what it returns in the ask and cannot act on it,
   *  so D-101 stays true: no dispatch table, no fallback picked here, no capability this loop could have widened.
   *
   *  Optional, and absent means an ask with no options — which is the honest answer for a single-model install and for a
   *  harness, not a degraded one: the ask still names the spent budget and still accepts "the same model again". */
  readonly askCandidates?: AskCandidates | undefined;
}

export interface Loop {
  start(input: RunInput): Promise<LoopOutcome>;
  resume(run: SuspendedRun): Promise<LoopOutcome>;
  /** F-47's resumption: §7.1's obligation, performed rather than reported. The saved boundary arrives as an argument
   *  because this package holds no checkpoint store — `restart` is told what to continue from by the party that read it,
   *  which is the same split D-095 drew between the loop's write and everyone else's read. */
  restart(input: RunInput, saved: CheckpointRecord): Promise<LoopOutcome>;
  /** D-044's answer. Only a run parked at an ask may be answered this way, and `transition()` enforces that in the
   *  record's own terms (§5's rule 5): the move out of `awaiting_approval` carries `modelAnswered` as its evidence, so a
   *  caller cannot present this for a run that is holding an approval instead. */
  answerModel(run: ModelSuspendedRun, answer: ModelAnswer): Promise<LoopOutcome>;
}

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

/** The default backoff: a sleep that ends when the signal does, because a wait that ignores a cancellation is a wait the
 *  user cannot end — and D-064's longest rung is 16 s, which is a long time to hold a task nobody can stop. */
async function waitFor(ms: number, signal?: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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
  const random = deps.random ?? Math.random;
  const wait = deps.wait ?? waitFor;
  const { journal, approvals, provider, tools, publish } = deps;

  // ------------------------------------------------------------------ write phases
  // The discipline — one transaction per phase, both halves of a state move, publishing after the commit, and never
  // trusting a task record read before an `await` — is `journal.ts`'s, shared with the cancellation manager so that two
  // modules writing task state cannot drift apart about how.

  const writer = createPhaseWriter({ journal, publish, now });
  const { phase, move, currentTask } = writer;

  function fail(
    taskId: string,
    code: string,
    reason: string,
    errorClass: ErrorClass,
    correlationId: string | undefined,
    extra: Record<string, unknown> = {},
  ): LoopOutcome {
    return {
      kind: "failed",
      ...writer.failTask(taskId, code, reason, errorClass, correlationId, extra),
    };
  }

  /** §6.1's steps 2 and 6, and the reason the loop and the manager are two objects: only the party running a step knows
   *  what was in flight when the request arrived, so the loop supplies §6.2's evidence, and only the party that recorded
   *  the request may end the task, so the manager owns the write. Returns `undefined` when no cancellation was requested,
   *  which keeps the call sites to one line each. */
  function cancelledWith(state: RunState, evidence: CancellationEvidence): LoopOutcome | undefined {
    const gate = deps.cancellation;
    if (gate === undefined) return undefined;
    const task = currentTask(state.input.taskId);
    if (gate.requested(task.id) === undefined && task.state !== "cancelling") return undefined;
    const settled = gate.settle({
      taskId: task.id,
      evidence,
      correlationId: state.input.correlationId,
    });
    if (settled.ok) return { kind: "cancelled", task: settled.task, evidence };
    const after = currentTask(task.id);
    // Someone else settled it first — a runner, a second interface — which is the same fact rather than an error.
    if (after.state === "cancelled") return { kind: "cancelled", task: after, evidence };
    return {
      kind: "refused",
      task: after,
      code: `cancellation.${settled.code}`,
      reason: settled.reason,
    };
  }

  /** D-089's answer to §6.2's "that uncertainty MUST be recorded explicitly": a tool step was in flight, so its external
   *  effect may already have happened. When M2e wrote this, nothing declared `sideEffects` — every one of §4.1's record
   *  fields was in `PENDING_RECORD_FIELDS` — so the answer was a constant `true` and the comment said why. `packages/tools`
   *  declares one now (D-098), so the constant became a question: a step whose tool says `none` cannot have left an effect
   *  behind, and reporting uncertainty for a `file.read` is how a user learns to ignore the word. Everything else —
   *  `local`, `external`, `irreversible`, and an executor that declares nothing at all — stays uncertain, which is D-089's
   *  fail-closed default and the whole of what changed here. */
  function toolEvidence(
    outcome: ToolOutcome | undefined,
    abandoned: boolean,
    tool: string,
  ): CancellationEvidence {
    return {
      // Confirmed termination means the operation reported that it stopped. A step the loop walked away from reported
      // nothing, and §6.2 forbids resolving that by pretending it stopped.
      terminated: outcome !== undefined && !abandoned,
      effectsUncertain: tools.declares?.(tool)?.sideEffects !== "none",
      inFlight: "tool",
      step: {
        tool,
        ...(outcome === undefined ? {} : { ok: outcome.ok }),
        ...(outcome?.code === undefined ? {} : { code: outcome.code }),
      },
    };
  }

  /** D-065's committed step boundary, written from inside the phase that records the step — because "committed" is the
   *  operative word in that sentence. A checkpoint written after the phase could exist for a step a rollback took back, or
   *  be missing for a step that happened, and either one is a resume point that disagrees with the log the verdict reads.
   *  The `state` and `lastSeq` the record carries are read by the manager rather than passed in, so a boundary cannot
   *  claim a sequence number the event store did not assign. */
  function checkpointAt(
    state: RunState,
    boundary: CheckpointBoundary,
    messages: readonly ProviderMessage[],
    steps: number,
    pending?: CheckpointPending,
  ): void {
    deps.checkpoints?.commit({
      taskId: state.input.taskId,
      boundary,
      step: steps,
      modelId: state.input.modelId,
      messages,
      ...(pending === undefined ? {} : { pending }),
    });
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

  /** §4.1's `inputSchema`, checked against what the model actually sent. Returns the refusal text, or `undefined` when
   *  there is nothing to check with — a tool whose spec carries no `parameters` takes no arguments, and a name no
   *  executor declared was already refused before this ran. */
  function validateCallArguments(call: ToolCall): string | undefined {
    const spec = declaredSpec(call.tool);
    if (spec === undefined) return undefined;
    const checked = validateToolArguments(spec.parameters, call.args);
    if (checked.ok) return undefined;
    return `'${call.tool}' was called with arguments its own schema rejects: ${checked.problems
      .map((problem) => `${problem.path === "" ? "(root)" : problem.path} ${problem.message}`)
      .join("; ")} (§4.1 validates the schema before policy is asked)`;
  }

  /** D-099's one place where a runtime observation becomes part of what policy judges. Two channels, and each party gets
   *  one: the arbiter sees the arguments *and* the facts, the executor sees only the arguments it declared. A fact placed
   *  in `args` instead would be rejected by §4.3's own undeclared-argument rule — which is that rule working, and the
   *  reason this is a field rather than a merge. Both are logged separately in `tool.call.proposed`, because an audit
   *  record that could not tell what was asked for from what was observed could not answer the one question it exists
   *  for. */
  function withRuntimeFacts(call: ToolCall): { call: ToolCall; facts: Record<string, unknown> } {
    const facts = tools.facts?.(call) ?? {};
    if (Object.keys(facts).length === 0) return { call, facts };
    return { call: { ...call, facts }, facts };
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
  ): Promise<{ value: T; abandoned: boolean }> {
    const timeout = deadlineMs === undefined ? undefined : AbortSignal.timeout(deadlineMs);
    const signal =
      outer !== undefined && timeout !== undefined
        ? AbortSignal.any([outer, timeout])
        : (outer ?? timeout ?? new AbortController().signal);
    if (deadlineMs === undefined) return { value: await work(signal), abandoned: false };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reported = false;
    const running = work(signal);
    try {
      // `abandoned` is the difference §6.2 insists on: the runtime stopped *waiting*, which is not the same fact as the
      // operation stopping. A caller that flattened the two would record a termination nobody confirmed.
      return await Promise.race([
        running.then((value) => {
          reported = true;
          return { value, abandoned: false };
        }),
        new Promise<{ value: T; abandoned: boolean }>((resolve) => {
          timer = setTimeout(() => resolve({ value: onTimeout(), abandoned: true }), deadlineMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      // The loser's rejection is swallowed on purpose: the abort was already signalled, and an unhandled rejection from a
      // call this loop stopped waiting for would read as a crash.
      if (!reported) running.catch(() => undefined);
    }
  }

  /** D-043's ladder stage 1: the same model, the same provider, up to `limits.providerAttempts` attempts, transient
   *  classes only, on D-064's schedule with its jitter, and a provider's own `Retry-After` overriding the schedule
   *  *upward*. Never a silent model switch — D-044's ask-the-user half is the next rung and is not built, so a budget
   *  exhausted is a failure that says how many attempts it took.
   *
   *  Retrying a provider call needs no reconciliation, and that is a fact worth stating rather than assuming: §9.2 asks
   *  the runtime to establish whether an operation succeeded before retrying a step that may have had an external side
   *  effect, and a completion request has none on the user's device beyond the provider having seen a prompt it was
   *  already sent (the same classification D-089 makes for cancellation). A *tool* step is the opposite case and this loop
   *  never retries one, and that is D-094's decision rather than a gap in the record: `packages/tools` declares
   *  `idempotent` for every file tool now (D-098), and the declaration is read where §7.3 reads it — by a resume deciding
   *  whether a step may be repeated (`checkpoint.ts`'s verdict), not by a retry ladder deciding whether to guess. A failed
   *  tool result goes back to the model to plan around, which is the ladder's rung for an action with consequences. */
  async function callProvider(
    state: RunState,
    offered: readonly ProviderToolSpec[],
  ): Promise<
    | { ok: true; turn: ProviderTurn; attempts: number }
    | { ok: false; error: unknown; attempts: number }
  > {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        return {
          ok: true,
          turn: await oneProviderCall(state, offered, attempt),
          attempts: attempt,
        };
      } catch (error) {
        const retryable =
          error instanceof ProviderError &&
          shouldRetry(error, attempt, limits.providerAttempts) &&
          // §6.1's step 2 applies to a retry as much as to a step: a retry is scheduled work, and a cancellation asked for
          // no more of it. Waiting out a 16 s backoff for a task the user has already stopped is the ladder doing exactly
          // what §6.3 accuses a loop of doing.
          deps.cancellation?.requested(state.input.taskId) === undefined &&
          state.input.signal?.aborted !== true;
        if (!retryable) return { ok: false, error, attempts: attempt };

        const providerError = error as ProviderError;
        const delay = retryDelayMs(attempt, providerError.retryAfterMs, random);
        phase(state.input.taskId, state.input.correlationId, (emit) => {
          emit(
            "provider.retry.scheduled",
            {
              attempt,
              maxAttempts: limits.providerAttempts,
              delayMs: delay.ms,
              source: delay.source,
              class: providerError.class,
              reason: providerError.message,
              ...(providerError.retryAfterMs === undefined
                ? {}
                : { retryAfterMs: providerError.retryAfterMs }),
            },
            now(),
          );
        });
        await wait(delay.ms, state.input.signal);
        // A cancellation may have arrived during the backoff, and the wait returns early when it does; asking the provider
        // again after that would be the step §6.1 forbids scheduling.
        if (
          deps.cancellation?.requested(state.input.taskId) !== undefined ||
          state.input.signal?.aborted
        ) {
          return { ok: false, error, attempts: attempt };
        }
        phase(state.input.taskId, state.input.correlationId, (emit) => {
          emit(
            "provider.retry.attempt",
            { attempt: attempt + 1, class: providerError.class, waitedMs: delay.ms },
            now(),
          );
        });
      }
    }
  }

  async function oneProviderCall(
    state: RunState,
    offered: readonly ProviderToolSpec[],
    attempt: number,
  ): Promise<ProviderTurn> {
    const { value } = await withDeadline(
      async (signal) => {
        const result = await (state.input.provider ?? provider).generate(
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
            attempt,
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
          { attempt },
        );
      },
    );
    return value;
  }

  async function runTool(
    call: ToolCall,
    taskId: string,
    outer: AbortSignal | undefined,
    origin: RunOrigin | undefined,
  ): Promise<{ outcome: ToolOutcome; abandoned: boolean }> {
    const priced = deadlineFor(call.tool, limits);
    // D-090: an `immediate` request is §6.2's safety-critical override, so the runtime stops waiting for a step that will
    // not stop even when the step's own class has no deadline — and records the uncertainty instead of claiming a
    // termination nobody confirmed. `finish-step` gets no second clock: the step keeps the budget it was already given,
    // which is the whole of §6.1's "when it can safely and reasonably do so".
    const abandon =
      deps.cancellation?.requested(taskId)?.mode === "immediate"
        ? limits.cancellationSettleMs
        : undefined;
    const deadlineMs =
      priced !== undefined && abandon !== undefined
        ? Math.min(priced, abandon)
        : (priced ?? abandon);
    const { value, abandoned } = await withDeadline(
      async (signal) => {
        try {
          return await tools.run(call, {
            taskId,
            signal,
            deadlineMs,
            ...(origin === undefined ? {} : { origin }),
          });
        } catch (error) {
          // An executor that throws is a failed step, not a crashed task. Without this the promise `start()` returned
          // would reject with the task still in `running` and nobody left to drive it, which is a state with no terminal
          // edge taken and no event for it — the two things §5.1's pairing rule and §4.1's table both forbid. The model
          // gets the reason and can plan around it, exactly as it does for a refusal.
          return {
            ok: false,
            output: `'${call.tool}' threw instead of returning an outcome: ${
              error instanceof Error ? error.message : String(error)
            }`,
            code: "executor-error",
          };
        }
      },
      deadlineMs,
      outer,
      () => ({
        ok: false,
        // D-074: "the outcome is reported as `timeout` — a distinct code, never `failure`", because "it took too long"
        // and "it did not work" need different responses — and §7.3 makes the difference matter, since a timed-out side
        // effect is reconciled rather than blindly retried.
        output: `'${call.tool}' passed its ${deadlineMs} ms deadline (D-074 for the class, D-090 for an immediate cancellation) and was signalled to stop; whether its external effect already happened is not knowable from here`,
        code: "timeout",
      }),
    );
    return { outcome: value, abandoned };
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
      /** The provider's id for this call, so the result message that closes it is the one the model asked for. */
      readonly toolCallId: string;
      /** The conversation and the step counter as they stand. Both arrive because D-065's boundary is written *inside*
       *  the phase that records this step's outcome, and a boundary that could not name the conversation it committed
       *  would be a resume point with nothing to resume. */
      readonly messages: readonly ProviderMessage[];
      readonly steps: number;
      readonly approvalId?: string;
      readonly evidence?: TransitionEvidence;
      readonly begin?: (emit: Emit, at: number) => { reason: string; code?: string } | undefined;
    },
  ): Promise<{
    readonly outcome?: ToolOutcome;
    /** True when the loop stopped waiting rather than the executor reporting: §6.2's distinction, carried to the party
     *  that has to record it. */
    readonly abandoned: boolean;
    readonly refusal?: { reason: string; code?: string };
    /** The conversation with this step's result appended — built inside the phase that commits the boundary, so the
     *  checkpoint and the run cannot disagree about what the step said. */
    readonly nextMessages: readonly ProviderMessage[];
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
        // A refusal is a committed boundary too: the step has an outcome (the reason), the model will be told it, and the
        // run continues from there. Nothing external happened, which is what makes it the easy case for §7.3.
        const next = [...input.messages, toolMessage(input.toolCallId, refusal.reason)];
        checkpointAt(state, "step", next, input.steps);
        return { refusal, nextMessages: next };
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
          deadlineMs: deadlineFor(input.call.tool, limits) ?? null,
        },
        startedAt,
      );
      // The start is not a boundary: nothing is committed yet, and a checkpoint written here would be a resume point that
      // claims a step the executor has not run. The conversation is carried through unchanged so both branches of this
      // phase return the same shape.
      return { nextMessages: input.messages };
    });
    if (begun.refusal !== undefined) return { ...begun, abandoned: false };

    const ran = await runTool(
      input.call,
      state.input.taskId,
      state.input.signal,
      state.input.origin,
    );
    const outcome = ran.outcome;
    const doneAt = now();
    const next = [...input.messages, toolMessage(input.toolCallId, outcome.output)];
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
      // The outcome event first and the boundary second, in that order and in one transaction: the boundary's `lastSeq`
      // has to be the sequence number of the event that made the step committed, because the verdict's whole question is
      // "what does the log say happened after this point".
      checkpointAt(state, "step", next, input.steps);
    });
    return { outcome, abandoned: ran.abandoned, nextMessages: next };
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
      // D-065's other boundary, and the only durable trace of a `SuspendedRun`: the step is proposed and gated, the
      // request is open, and nothing has executed. The record names the step and points at the arbiter's row; it does not
      // carry the action's arguments, because they are redacted on write like everything else in it and because a second
      // copy of an approved action would be an action the arbiter never saw (D-084's binding comparison).
      checkpointAt(state, "prompt", messages, steps, {
        tool: call.tool,
        toolCallId: proposed.id,
        approvalId: result.record.id,
      });
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
      const next = [...messages, toolMessage(proposed.id, opened.reason)];
      phase(task.id, state.input.correlationId, (emit) => {
        emit("tool.execution.blocked", { tool: call.tool, reason: opened.reason, refusals }, at);
        checkpointAt(state, "step", next, steps);
      });
      return { messages: next, steps };
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

    // §6.1's rule the table cannot carry: the runtime MUST NOT start another ordinary execution step merely because the
    // previous one completed after cancellation was requested. The proposal is not logged, because policy was never asked
    // about it and a `tool.call.proposed` with no decision behind it would be a claim this loop did not make.
    const stopping = cancelledWith(state, {
      terminated: true,
      effectsUncertain: false,
      inFlight: "none",
    });
    if (stopping !== undefined) return { stop: stopping };

    if (declaredSpec(proposed.name) === undefined) {
      // §3.1's third rule: a completion may propose tool calls, and only that. A name no executor declared has nothing
      // to run, and asking policy about it would produce an answer about a tool this build does not have.
      const reason = `'${proposed.name}' was proposed by the model, but no executor in this build declares it, so there is nothing to run`;
      const next = [...messages, toolMessage(proposed.id, reason)];
      phase(task.id, correlationId, (emit) => {
        emit(
          "tool.call.proposed",
          { tool: proposed.name, args: proposed.arguments, outcome: "not-declared" },
          at,
        );
        emit("tool.execution.blocked", { tool: proposed.name, reason, class: "validation" }, at);
        checkpointAt(state, "step", next, steps);
      });
      return { messages: next, steps };
    }

    const call = toToolCall(proposed);

    // §4.4's first step, complete: `toToolCall` compared the argument *names* against the declaration, and this compares
    // their shapes. Both run before the arbiter is asked, because §4.1 says so in terms ("`inputSchema` validated before
    // policy evaluation; malformed arguments are rejected pre-execution") and §4.3 gives the reason — "so a schema
    // mismatch can never be mistaken for permission". A `path` holding a number is not a tier question.
    const malformed = validateCallArguments(call);
    if (malformed !== undefined) {
      const next = [...messages, toolMessage(proposed.id, malformed)];
      phase(task.id, correlationId, (emit) => {
        emit(
          "tool.call.proposed",
          { tool: call.tool, args: call.args, outcome: "invalid-arguments" },
          at,
        );
        emit(
          "tool.execution.blocked",
          { tool: call.tool, reason: malformed, class: "validation" },
          at,
        );
        // A refusal is a committed boundary for the same reason a denial is: the step has an outcome, the model will be
        // told it, and nothing external happened (D-095).
        checkpointAt(state, "step", next, steps);
      });
      return { messages: next, steps };
    }

    const gated = withRuntimeFacts(call);
    const decision = evaluate(gated.call, state.subject, state.input.ctx, at);
    phase(task.id, correlationId, (emit) => {
      emit(
        "tool.call.proposed",
        {
          tool: call.tool,
          args: call.args,
          ...(Object.keys(gated.facts).length === 0 ? {} : { facts: gated.facts }),
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
      const next = [...messages, toolMessage(proposed.id, decision.reason)];
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
        checkpointAt(state, "step", next, steps);
      });
      return { messages: next, steps };
    }

    // ---- allowed: execute, through the one function that runs a tool
    const executed = await execute(state, {
      call,
      tier: decision.tier,
      toolCallId: proposed.id,
      messages,
      steps,
    });
    // §6.1's steps 3 to 6: the step that was already running was allowed to finish, its output is captured above by
    // `execute`, and now the task is marked cancelled instead of looping for another round.
    const settled = cancelledWith(
      state,
      toolEvidence(executed.outcome, executed.abandoned, call.tool),
    );
    if (settled !== undefined) return { stop: settled };
    return { messages: executed.nextMessages, steps };
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

      // §6.1's step 2: no new execution step is scheduled for a task a cancellation was requested for. Nothing is in
      // flight between rounds, so the evidence is the easy case — there was no operation to stop and no effect to doubt.
      const stopping = cancelledWith(current, {
        terminated: true,
        effectsUncertain: false,
        inFlight: "none",
      });
      if (stopping !== undefined) return stopping;

      const offered = offeredTools(current.subject);
      const round = await callProvider(current, offered);
      if (!round.ok) return providerFailure(current, round.error, round.attempts);
      const turn = round.turn;

      if (turn.toolCalls.length === 0) return complete(current, turn);
      if (turn.toolCalls.length > limits.toolCallsPerResponse) {
        return fail(
          task.id,
          "limits.tool_calls_per_response",
          `the completion proposed ${turn.toolCalls.length} tool calls and the limit is ${limits.toolCallsPerResponse} ` +
            "(D-074's parallel tool steps in one task, priced as a per-response cap by D-088); change it with " +
            "`crabby config set limits.parallelToolSteps` — one key, because D-088 reused D-074's number rather than inventing a second one",
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
        // D-112: the turn is written here, inside the phase that completes the task, and the frame that announces it goes
        // out with it. Two writes, one transaction, one call — so the row and the log cannot disagree, which is the whole
        // reason the seam is a writer rather than something a route or a tool fills in afterwards. The role is the
        // assistant's even when the text is empty: an empty completion carries a `finishReason` a reader needs, and §2.5's
        // "role" bullet is about who spoke rather than whether it said anything.
        const task = currentTask(taskId);
        const stored = deps.messages?.record({
          sessionId: task.sessionId,
          taskId,
          role: "assistant",
          content: turn.text,
          at,
        });
        if (stored !== undefined) {
          emit(
            "message.added",
            {
              role: "assistant",
              // The text rides the frame as well as the row: a live transcript (C4-05) is a shipped surface and the bytes
              // were already here. `messageId` is what makes the pair checkable — D-112's "one fact, announced once".
              messageId: stored.id,
              ordinal: stored.ordinal,
              content: turn.text,
              usage: turn.usage,
              finishReason: turn.finishReason,
            },
            at,
          );
        }
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

  /** D-044's second rung, asked in D-086's shape: the task stops in `awaiting_approval` with **no pending request**,
   *  because what it now waits for is a model rather than an approval, and a `task.progress` frame is replaced by the
   *  `provider.switch.proposed` the event vocabulary reserved for exactly this moment.
   *
   *  Two events in one phase, and the order is the reason: the transition frame comes first so that a client watching
   *  state sees `awaiting_approval` before anything that claims a question is open, and the ask's facts ride on that
   *  frame's payload as well as on the dedicated one. §5.2's rule — anything a client must act on is also retrievable by
   *  polling — is satisfied by the state alone; a client that *filters* `provider.switch.*` would still see why it is
   *  stuck, which is the half a state alone cannot carry. */
  async function ask(
    state: RunState,
    spent: { readonly attempts: number; readonly code: string; readonly reason: string },
  ): Promise<LoopOutcome> {
    const at = now();
    const taskId = state.input.taskId;
    const provider = state.input.provider ?? deps.provider;
    const current = `${provider.id}/${state.input.modelId}`;
    const candidates =
      deps.askCandidates === undefined
        ? []
        : await deps.askCandidates({ providerId: provider.id, modelId: state.input.modelId });
    const next =
      `answer POST /api/v1/tasks/${taskId}/resume with one of the candidates, or with none to retry the same model, ` +
      "or cancel the task";
    const question: ModelAsk = {
      attempts: spent.attempts,
      limit: limits.providerAttempts,
      code: spent.code,
      reason: spent.reason,
      current,
      candidates,
    };
    phase(taskId, state.input.correlationId, (emit) => {
      const fresh = currentTask(taskId);
      if (fresh.state !== "awaiting_approval") {
        move(fresh, "awaiting_approval", {}, emit, at, {
          // The ladder's facts ride here as well as on `provider.switch.proposed`, because `task.state.changed` is the
          // frame every interface already follows and a client must be able to read *why* a task stopped without
          // subscribing to a family it may filter away.
          payload: {
            paused: true,
            ladder: {
              attempts: question.attempts,
              limit: question.limit,
              code: question.code,
              reason: question.reason,
            },
            current: question.current,
            candidates: question.candidates,
            next,
          },
        });
      }
      emit("provider.switch.proposed", { ...question, next }, at);
    });
    return {
      kind: "awaiting-model",
      task: currentTask(taskId),
      run: {
        taskId,
        messages: state.messages,
        steps: state.steps,
        input: state.input,
        ask: question,
      },
      ask: question,
    };
  }

  async function providerFailure(
    state: RunState,
    error: unknown,
    attempts: number,
  ): Promise<LoopOutcome> {
    const at = now();
    const taskId = state.input.taskId;
    const providerError = error instanceof ProviderError ? error : undefined;
    if (providerError?.class === "cancelled") {
      // §6.2 requires the record to say whether the operation was confirmed to stop and whether its effects may already
      // have happened. This loop knows neither — what was aborted is a provider call, not the tool whose side effect is
      // in question — so it moves to `cancelling` and stops, which is the half of §6.1 it can honestly do.
      // A completion request has no effect on the user's files or device beyond the provider having seen a prompt it was
      // already sent, so D-089 records `effectsUncertain: false` here and `true` for a tool step — and `inFlight` travels
      // with the event, so a reader who disagrees with that classification can see which one was made.
      const settled = cancelledWith(state, {
        terminated: true,
        effectsUncertain: false,
        inFlight: "provider",
      });
      if (settled !== undefined) return settled;
      const reason = `the provider call was cancelled (${providerError.message}), and no cancellation was recorded for this task, so the runtime stops at \`cancelling\`: §6.2's evidence about whether the operation stopped is the cancellation manager's to produce, and this build has none wired to this run`;
      phase(taskId, state.input.correlationId, (emit) => {
        const task = currentTask(taskId);
        if (task.state !== "cancelling") move(task, "cancelling", {}, emit, at);
      });
      return { kind: "cancelling", task: currentTask(taskId), reason };
    }
    // A cancellation recorded while the ladder was waiting, or between attempts, means the user stopped this task: the
    // provider's error is why the ladder was climbing, and reporting `failed` would tell the user the wrong thing
    // happened. Nothing was in flight at this point, so the evidence is the easy case.
    const stopping = cancelledWith(state, {
      terminated: true,
      effectsUncertain: false,
      inFlight: "none",
    });
    if (stopping !== undefined) return stopping;
    const code = providerError === undefined ? "provider.error" : `provider.${providerError.class}`;
    const reason =
      providerError === undefined
        ? `the provider call failed with something that is not a ProviderError: ${String(error)}`
        : providerError.message;
    // D-044's rung 2, reached only on the one condition it prices: a *retryable* class with the budget spent. Anything
    // else fails here, deliberately — a class that is not retryable has no better model to offer (an invalid request is
    // invalid for all of them, and §9.2 says never retry one), and a `ProviderError` this build cannot classify is
    // exactly the case D-043's "fail closed" sentence is for.
    if (providerError?.retryable === true && attempts >= limits.providerAttempts) {
      return ask(state, { attempts, code, reason });
    }
    return fail(
      taskId,
      code,
      reason,
      providerError === undefined ? "internal" : "provider",
      state.input.correlationId,
      {
        // How many attempts the ladder actually made, so a reader does not have to guess whether the budget was spent or
        // the class was never retryable.
        attempts,
        retried: attempts - 1,
        ladder:
          attempts > 1
            ? `D-043's ladder stopped after ${attempts} attempts without reaching the configured budget of ${limits.providerAttempts}, and §3.6's stage 2 asks only at the budget — so this failure is reported rather than offered as a switch`
            : "the class is not retryable, so D-043's ladder did not start (§9.2: invalid requests and denied permissions must not be retried)",
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

  /** §7.1's "attempt to resume interrupted tasks automatically", performed by a human's answer rather than by a timer —
   *  §7.2 withholds the automatic half, and this build has no timer to withhold anything from.
   *
   *  Four things happen here and none of them is the loop's choice. The task must be `interrupted`: recovery's uniform
   *  target (D-083's `recoveryTarget`) is what "a run that did not survive the process" looks like, and any other state is
   *  somebody else's business — a live run, a settled task, a prompt. The saved record must belong to this task, because a
   *  boundary for another task is a conversation the user never had with this one. The messages are the record's, whole: the
   *  committed context, not a summary and not the log (SECURITY.md §7 redacts what the log would have been needed for here).
   *  And the move is `interrupted` → `planning`, whose event is `task.resumed` — §4.1's table has no edge straight into
   *  `running` from here without `resumeApprovalValid`, and claiming that evidence would be §7.2's forbidden claim: no
   *  approval covers this task's step, because recovery just said so.
   *
   *  What is *not* re-decided: the identity (D-111 — the route rebuilt the subject from the record's own origin, so a
   *  human answering a prompt never becomes the author of a task), the grants (evaluated by that route from the client's
   *  *current* capabilities, §13), and whether continuing is safe at all — that is D-065's verdict, which the runner read
   *  before it called this and refuses on. */
  async function restart(input: RunInput, saved: CheckpointRecord): Promise<LoopOutcome> {
    const existing = journal.task(input.taskId);
    if (existing === undefined) {
      return refused(
        undefined,
        "task.not_found",
        `no task ${input.taskId} in the journal, so there is nothing to resume`,
      );
    }
    if (isTerminal(existing.state)) {
      return refused(
        existing,
        "task.terminal",
        `task ${existing.id} is \`${existing.state}\`, which is terminal and absorbing (AGENT_RUNTIME.md §4.1), so there is ` +
          "no interrupted work to continue",
      );
    }
    if (existing.state !== "interrupted") {
      return refused(
        existing,
        "task.not_interrupted",
        `task ${existing.id} is \`${existing.state}\` and this entry resumes what a restart interrupted; a task in flight is ` +
          "woken by its own park's answer, and a queued one starts where it started",
      );
    }
    if (saved.taskId !== input.taskId) {
      return refused(
        existing,
        "checkpoint.not_found",
        `the saved boundary belongs to task ${saved.taskId}, so continuing this task from it would replay a conversation ` +
          "the user did not have with it",
      );
    }
    const at = now();
    phase(input.taskId, input.correlationId, (emit) => {
      move(currentTask(input.taskId), "planning", {}, emit, at, {
        payload: {
          // The coordinates of what is being continued, so a client reading the log can tell this move from a new run:
          // §7.1's resume and `POST /tasks` both move a task, and only one of them is a continuation.
          resumed: {
            boundary: saved.boundary,
            step: saved.step,
            lastSeq: saved.lastSeq,
            // The model that produced the saved context. The answer may name another (§3.6's switch), and the client that
            // prints this line is the one place where "the task was on A and is now on B" is readable as a pair.
            model: saved.modelId,
            writtenAt: saved.writtenAt,
            ...(saved.pending === undefined ? {} : { pending: saved.pending.tool }),
          },
        },
      });
    });
    const task = currentTask(input.taskId);
    // The objective is *not* prepended again. `start` does that because it is building a conversation; here the
    // conversation is the record's, and a second copy of the user's opening sentence would be a second instruction in it.
    return drive({
      input,
      subject: { ...input.subject, taskId: task.id },
      messages: saved.messages,
      steps: saved.step,
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

    // A cancellation outranks an answer: a suspended run has nothing in flight, so §6.1's step 3 has nothing to wait for
    // and the task settles at once. The approval row is left as it stands — `pending` or `approved` — and expires inside
    // D-064's window, because withdrawing it would need a sixth state the arbiter does not have.
    const stopping = cancelledWith(state, {
      terminated: true,
      effectsUncertain: false,
      inFlight: "none",
    });
    if (stopping !== undefined) return stopping;

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
      const next = [...state.messages, toolMessage(run.toolCallId, reason)];
      phase(run.taskId, run.input.correlationId, (emit) => {
        emit(
          "tool.execution.blocked",
          { tool: run.call.tool, reason, refusals, approvalId: row.id },
          at,
        );
        const task = currentTask(run.taskId);
        if (task.state === "awaiting_approval") move(task, "planning", {}, emit, at);
        checkpointAt(state, "step", next, state.steps);
      });
      return drive({ ...state, messages: next });
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
    //
    // Enriched exactly as it was when the prompt was built, because §6.3's binding is computed from what policy sees and
    // D-084 compares that binding at the moment of execution: a re-evaluation on the bare arguments would fingerprint a
    // different action from the one the user signed, and spend the signature on a refusal. A fact that genuinely changed
    // while the prompt was open does produce a different binding, which is a material change and the arbiter's verdict to
    // give rather than this loop's.
    const decision = evaluate(withRuntimeFacts(run.call).call, state.subject, run.input.ctx, at);
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
      toolCallId: run.toolCallId,
      messages: state.messages,
      steps: state.steps,
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
      return drive({ ...state, messages: executed.nextMessages });
    }
    const settled = cancelledWith(
      state,
      toolEvidence(executed.outcome, executed.abandoned, run.call.tool),
    );
    if (settled !== undefined) return settled;
    return drive({ ...state, messages: executed.nextMessages });
  }

  /** D-044's answer, and §3.6 stage 3's three sentences in one place: the switch is recorded on the task, the run
   *  continues from the boundary it had reached, and the resume is not a restart.
   *
   *  Two refusals here are load-bearing and neither is politeness. A pair the ask did not offer is refused because the
   *  prompt is the question — a resume that could name any composed model would let the *answer* widen what the ask
   *  presented, which is the model steering the user rather than the user steering the model. A pair with no provider is
   *  refused because this package holds no pool (D-101): it is handed a `Provider`, and a run asked to switch to a model
   *  whose provider nobody resolved would silently keep calling the old one under the new name.
   *
   *  What is deliberately *not* re-decided here: the task's identity. The run belonged to an origin before the ask and
   *  belongs to it after, because a human answering a question in the middle of a run does not become the author of it
   *  (`RunInput.origin`). The answer is recorded as §14 audit beside the switch, not as a new authority. */
  async function answerModel(run: ModelSuspendedRun, answer: ModelAnswer): Promise<LoopOutcome> {
    const at = now();
    const existing = journal.task(run.taskId);
    if (existing === undefined) {
      return refused(
        undefined,
        "task.not_found",
        `no task ${run.taskId} in the journal, so there is no model ask to answer`,
      );
    }
    if (isTerminal(existing.state)) {
      return refused(
        existing,
        "task.terminal",
        `task ${existing.id} is \`${existing.state}\`, which is terminal and absorbing (AGENT_RUNTIME.md §4.1), so a model ask left open for it cannot be answered`,
      );
    }
    if (existing.state !== "awaiting_approval") {
      return refused(
        existing,
        "task.not_parked",
        `task ${run.taskId} is \`${existing.state}\`, not \`awaiting_approval\`, so it is not holding a model ask; a task in flight is answered by nothing until it moves, and a queued task has not run far enough to exhaust a budget`,
      );
    }
    const pair = answer.pair;
    const chosen = pair === undefined ? undefined : `${pair.provider}/${pair.modelId}`;
    if (
      chosen !== undefined &&
      !run.ask.candidates.some((candidate) => candidate.model === chosen)
    ) {
      return refused(
        existing,
        "model.not_offered",
        `the ask offered ${run.ask.candidates.length === 0 ? "no other composed model" : run.ask.candidates.map((candidate) => `\`${candidate.model}\``).join(", ")}, and \`${chosen}\` is not among them; resume with one of the candidates, or with no pin to retry the same model`,
      );
    }
    if (pair !== undefined && answer.provider === undefined) {
      return refused(
        existing,
        "model.no_provider",
        `\`${chosen}\` was chosen but no provider for it was resolved (D-101: the loop is handed a provider, it does not load one), so the run would call the old model under the new name`,
      );
    }
    const state: RunState = {
      input: run.input,
      subject: { ...run.input.subject, taskId: run.taskId },
      messages: run.messages,
      steps: run.steps,
    };
    // A cancellation outranks an answer, for the same reason and in the same words as `resume`: nothing was in flight when
    // the budget ran out, so §6.1's step 3 settles at once and the user's stop is the more recent instruction.
    const stopping = cancelledWith(state, {
      terminated: true,
      effectsUncertain: false,
      inFlight: "none",
    });
    if (stopping !== undefined) return stopping;

    // `reAttempted: false` is a guarantee here rather than an observation: the messages carried in the park are the ones
    // that existed at the last committed boundary, so nothing this run completed is handed to the provider a second time
    // (§3.9's first rule, D-044). What *is* re-issued is the call that failed, which is not a step and has no side effect
    // outside the provider.
    const switched = chosen !== undefined && chosen !== run.ask.current;
    const modelSwitch: TaskModelSwitch | undefined = switched
      ? {
          from: run.ask.current,
          to: chosen as string,
          reason: run.ask.reason,
          stage: 2,
          reAttempted: false,
          attempts: run.ask.attempts,
          at: new Date(at).toISOString(),
          ...(answer.byClientId === undefined ? {} : { by: answer.byClientId }),
          ...(answer.via === undefined ? {} : { via: answer.via }),
        }
      : undefined;
    phase(run.taskId, run.input.correlationId, (emit) => {
      const task = currentTask(run.taskId);
      // §5's rule 5 in its second form: the edge out of `awaiting_approval` names the answer that opened it, and
      // `transition()` refuses the move without it — so a task cannot be woken from an ask by anything but an answer.
      move(task, "running", { modelAnswered: true }, emit, at, {
        ...(modelSwitch === undefined ? {} : { model: modelSwitch.to, modelSwitch }),
        payload: {
          resumed: {
            asked: run.ask.attempts,
            limit: run.ask.limit,
            code: run.ask.code,
            from: run.ask.current,
            // Present whether or not a switch happened, because "resumed on the same model" is an answer the user gave
            // and a reader asking "what happened to this task" needs it to be distinguishable from "it just continued".
            switched: switched,
          },
          ...(modelSwitch === undefined ? {} : { model: modelSwitch }),
        },
      });
      if (modelSwitch !== undefined) {
        emit("provider.switch.accepted", { model: modelSwitch }, at);
      }
    });
    const input: RunInput =
      switched && pair !== undefined
        ? { ...run.input, modelId: pair.modelId, provider: answer.provider }
        : run.input;
    // The context is re-budgeted for the new limits from this line on: every count from here asks
    // `state.input.provider`, which is the model the user chose, so §3.6's "the context is re-budgeted for the new
    // limits" is a consequence of the swap rather than a pass someone remembered to make.
    return drive({
      input,
      subject: { ...input.subject, taskId: run.taskId },
      messages: run.messages,
      steps: run.steps,
    });
  }

  /** §6.3's "the action needs a fresh request", made by the only party allowed to make one: policy is asked again, so the
   *  deadline is D-064's and the tier is today's; the arbiter records `supersedes` and answers `approval.re-requested`;
   *  and the task stays where a prompt puts it. */
  function reRequest(state: RunState, run: SuspendedRun, why: string): LoopOutcome {
    const at = now();
    // The same enrichment as the moment of execution, so the fresh request carries the binding that execution will be
    // compared against — a re-ask built on the bare arguments would open a prompt the next resume could not spend (D-099).
    const decision = evaluate(withRuntimeFacts(run.call).call, state.subject, run.input.ctx, at);
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

  return { start, resume, answerModel, restart };
}
