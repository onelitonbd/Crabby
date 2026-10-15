// The Gateway: one Fastify instance, every route under `/api/v1` (D-067's versioning-by-path), validation wired to
// the same TypeBox schemas the clients use (D-069's `validatorCompiler` rule — one schema, one validator, no ajv
// dialect beside ours), and errors leaving through §6's envelope with the status mapped by the table in `errors.ts`.
//
// Two things are absent on purpose. There is no policy *enforcement* here: `@crabby/policy` answers "what tier is this
// and who may do it" and `GET /api/v1/tools` publishes that registry, but no route grants anything, because "an
// interface may request, display, and relay; it may never grant" (`SECURITY.md` §6.1) would break at the first attempt
// if a Gateway endpoint could wave a T3 through. The approval queue and its two §4.3 routes are in this build, and they
// only *answer*: nothing here opens a request. The loop opens them, from `policy.evaluate`'s verdict (D-084, D-086).
//
// `POST /api/v1/tasks` does hand its task over, and that handoff is the last thing M2's Exit criterion was waiting on.
// The route records the task, turns the identity's recorded capabilities into a `PolicySubject` — `grantsFor` expands a
// root-scoped name against the roots this install configured and reports as *withheld*, rather than silently dropping,
// the ones no configuration could honour — adds `removedGrantsFor`'s set so that a narrowed client is told §13's "not
// available to this client" instead of a denial that reads as something it could go and grant, and then calls
// `runner.start`. A Gateway composed with no drive (no workspace root, or no selected default model) has no runner at
// all, and says so where a client can ask before it commits: `GET /api/v1/diagnostics` reports `runs.composed` and
// `runs.inFlight`, which is what lets `crabby task run` refuse to create a task that nothing would move rather than
// create one and let the client discover it. The route still answers 201 when `start` refuses, because a task that is
// already in flight or parked is a fact about the record and not a failure of the request, and logs the reason.
//
// What is still absent here, and deliberately. Nothing at this route tests whether the identity holds `task.create`:
// every identity paired before capability assignment holds an empty set, so a grant test would lock an owner out of
// their own Gateway — the outage D-097 named — and the check belongs beside the socket guard it replaces.
// `config.json`'s `limits.*` reach the loop through `drive.limits`, translated by `loopLimitsOf` at the composition
// root: the eight keys the loop enforces map one each, and the rest belong to the parties that enforce them (§3.1's
// wrapper, the storage layer, the task manager), so a key the loop does not read is never handed to it to no effect.
// And
// `POST /api/v1/tasks/{id}/resume` *is* wired, and it does not resurrect anything: §7.1's recovery still marks every
// non-terminal task `interrupted` and still sweeps the prompts whose deadlines passed, because a recovery that resumed on
// its own would be a way past an approval. What the route adds is the half §7.2 withholds from automation — a human
// answering, for a run rebuilt from D-095's boundary and refused on D-065's verdict (F-47, D-111).
//
// §6's cancellation *is* wired, because stopping work is not the same act as doing it and needs no grants: `buildApp`
// composes the process's one manager and `POST /api/v1/tasks/{id}/cancel` requests through it. A `queued` task has
// nothing in flight, so that route settles at once and answers with §6.2's evidence already on the record.
//
// What this file *does* own at startup is §7's recovery, beside D-065's retention prune, and it is the reading side of
// the checkpoint: `GET /api/v1/tasks/{id}/checkpoint` reports the boundary the run last committed and D-065's verdict on
// it, while the *writing* side is the loop's and happens inside the phase that commits each step (D-095). `createRecovery` marks every
// non-terminal task `interrupted`, settles a cancellation that was requested before the process died instead of
// resurrecting it, and sweeps the prompts whose deadlines passed while nobody was watching (D-092). The sweep also runs on
// `GET /approvals`, because the count that route returns is the number `crabby status` prints as "N waiting" and a stale
// prompt in it is a lie a user acts on (D-093, F-48). And there is no second listener: §2's loopback default is what
// `listen` is given, and `crabby gateway start` refuses a non-loopback host until pairing has something to protect.

import {
  type ApprovalRecord,
  type Approvals,
  type BudgetDescriptor,
  type Cancellation,
  type Checkpoints,
  contextBudget,
  contextLimits,
  createApprovals,
  createCancellation,
  createCheckpoints,
  createContextManager,
  createRecovery,
  createRunner,
  createScheduler,
  DEFAULT_RUN_HISTORY,
  estimateFromChars,
  type JobActionCode,
  type JobStore,
  type LoopLimits,
  type LoopSubject,
  localStamp,
  type MessageWriter,
  type RestartFailureCode,
  type RestartResult,
  type ResumeFailureCode,
  type Runner,
  type Scheduler,
  type StartResult,
  type ToolSurface,
} from "@crabby/agent-runtime";
import type { ApprovalState, MessageRecord, ToolDeclaration } from "@crabby/api-contracts";
import {
  APPROVAL_STATES,
  ApprovalDecisionBody,
  ApprovalListQuery,
  CancelTaskBody,
  type ClientInterface,
  COMPACTION_REFUSAL_NOTES,
  CONFIG_REFUSAL_CLASS,
  type CompactionRefusalName,
  type CompactSessionBody,
  type ConfigReadBody,
  type ConfigWriteBody,
  CreateSessionBody,
  CreateTaskBody,
  configETag,
  type Event,
  errorEnvelope,
  isJobState,
  JOB_STATES,
  type JobActionBody,
  JobBacklogBody,
  type JobDetailBody,
  type JobListBody,
  type JobRecord,
  type JobRow,
  jobRow,
  ListQuery,
  type MessageListBody,
  newId,
  PairCodeRequestBody,
  PairRequestBody,
  PatchJobBody,
  PatchSessionBody,
  PutConfigBody,
  parseConfigIfMatch,
  parseIfMatch,
  ResumeTaskBody,
  SCHEMA_VERSION,
  SESSION_ORIGINS,
  type SessionActionBody,
  type SessionActionCode,
  type SessionDetailBody,
  type SessionListBody,
  type SessionTaskFacts,
  sessionETag,
  sessionRow,
  TaskId,
  type TaskRecord,
  type TaskState,
  validate,
} from "@crabby/api-contracts";
import {
  type ConfigFile,
  type ContextLimitsConfig,
  configDocument,
  configSchema,
  differingPaths,
  type Logger,
  loadConfig,
  writeConfig,
} from "@crabby/core";
import type { DataLayout } from "@crabby/platform";
import { detectProcess } from "@crabby/platform";
import {
  allToolRecords,
  CAPABILITIES,
  type ClientKind,
  capabilitiesFor,
  type EvalContext,
  grantsFor,
  type PlatformFactsLike,
  registryDigest,
  removedGrantsFor,
  restrictCapabilities,
  TIERS,
  TOOL_REGISTRY,
} from "@crabby/policy";
import {
  composeAskCandidates,
  type ModelDescriptor,
  type Provider,
  type ProviderComposition,
  selectPinnedModel,
} from "@crabby/providers";
import {
  appendEvent,
  appendMessage,
  authenticate,
  createSession,
  createSqliteApprovalStore,
  createSqliteCheckpointStore,
  createSqliteJobStore,
  createSqliteJournal,
  createTask,
  ensureSession,
  getIdentity,
  getMessage,
  getSession,
  getTask,
  type Identity,
  listIdentities,
  listMessages,
  listSessions,
  listTasks,
  messageCharCount,
  mintPairingCode,
  patchSession,
  pruneEvents,
  REPLAY_WINDOW_EVENTS,
  readEvents,
  recall,
  redeemPairingCode,
  remember,
  requestHash,
  revoke,
  type SqliteDb,
  schemaVersion,
  sessionTaskCount,
  sessionTaskFacts,
  sessionTaskFactsFor,
  sessionTasks,
  stateCounts,
  taskScratch,
  transact,
} from "@crabby/storage";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { createEventBus } from "./bus.ts";
import {
  APPROVAL_REFUSAL_CLASS,
  authError,
  CANCEL_REFUSAL_CLASS,
  GatewayError,
  JOB_REFUSAL_CLASS,
  notFound,
  RESUME_REFUSAL_CLASS,
  SESSION_REFUSAL_CLASS,
  validationError,
} from "./errors.ts";
import { comment, frame, gapFrame, HEARTBEAT_MS, openStream, type StreamState } from "./sse.ts";

/** What a run needs that only the party that started the process knows. These four arrive together or not at all, and
 *  the bundling is the point: an executor with no model, or a model with no executor, is not a runner, and four
 *  independent optionals would let that combination be written down and then discovered at the first task.
 *
 *  `ctx` is `EvalContext` minus `grants` because the two halves have different owners: the roots, the egress allow-list
 *  and the symlink resolver are facts about the install, so the composition root resolves them once, while `grants` are
 *  facts about the identity that asked, so they arrive per run (F-52's third question, answered at the route, D-102). */
export interface DriveFacts {
  /** §4.1's executor. The type is `packages/agent-runtime`'s seam rather than `packages/tools`' class, which is what
   *  keeps this package free of a dependency on the executor: which one a process has is a fact about the composition
   *  root that ran, for the reason `declares` is handed in. */
  readonly tools: ToolSurface;
  readonly provider: Provider;
  /** §3.6's selection, resolved by the caller and not chosen here: a provider must not be able to alter a task's
   *  permissions (§3.1's third rule), and a loop that picked its own model would be one step from that. */
  readonly modelId: string;
  readonly ctx: Omit<EvalContext, "grants">;
  /** §5.2's `limits.*` from `config.json`, already translated into the loop's own field names by the composition root
   *  (`loopLimitsOf`). Absent means the class defaults stand, which is what a Gateway built without a config file gets;
   *  present means a user who raised `limits.netFetchTimeoutMs` sees the loop raise the clock with it, because the
   *  numbers are enforced by the core and never by a caller (§5.2, `SECURITY.md` §12) — a Gateway that read the keys
   *  into its own banner but handed the loop the defaults would be a configuration that answers questions and changes
   *  nothing. */
  readonly limits?: Partial<LoopLimits> | undefined;
}

export interface GatewayDeps {
  readonly db: SqliteDb;
  readonly layout: DataLayout;
  readonly log: Logger;
  readonly version: string;
  readonly startedAt: Date;
  /** What the listener is reachable as: `local` for loopback, `tunnel` once a tunnel exists. */
  readonly listenerMode: "local" | "tunnel";
  /** Injected only by tests. `GET /api/v1/tools` reports platform availability, and a route whose availability answer
   *  comes from `process.env` cannot be tested on both sides of the predicate — which is the half that matters, since
   *  the desktop CI run is exactly where a Termux-only row has to show up as unavailable rather than broken. */
  readonly platformFacts?: { isTermux: boolean };
  /** What the composition root made of `config.json`'s `provider.*` entries — §3.3's "Configured through `crabby
   *  provider add` **or configuration**", the second half, composed by `packages/providers/compose.ts`. Handed in rather
   *  than read here for the reason `platformFacts` is injected: this file has no opinion about where configuration comes
   *  from, and a Gateway that loaded its own could not be tested against a second configuration. Refusals travel with the
   *  list, because `GET /api/v1/status` owes a caller the reason an entry did not compose and not only its absence. */
  readonly providers?: readonly ProviderComposition[] | undefined;
  /** The composed executor's half of §4.1's record, so `GET /api/v1/tools` can answer the five fields
   *  `PENDING_RECORD_FIELDS` names from the party that executes them instead of printing them as pending (F-55). Handed
   *  in for the reason `providers` is: `packages/gateway` has no dependency on `packages/tools` and should not grow one,
   *  because which executor a process has is a fact about the composition root that ran. Absent means no executor was
   *  composed, and then every row keeps naming all five — which is a true statement about this process rather than a
   *  default invented to fill a response. */
  readonly declares?: ((tool: string) => ToolDeclaration | undefined) | undefined;
  /** The handoff's ingredients. Absent means this process cannot drive a task, and `POST /api/v1/tasks` then records one
   *  and the startup banner says so — which is the honest answer for an install that configured no workspace root or
   *  selected no default model, and the reason the field is one bundle rather than four optionals. */
  readonly drive?: DriveFacts | undefined;
  /** D-115's `limits.context.*`, handed in rather than read here for the reason `drive` is: this file has no
   *  opinion about where configuration comes from, and a Gateway that loaded its own could not be tested
   *  against a second configuration. Absent means the defaults (compact at 0.8, six verbatim turns, and the
   *  run's own model as the summarizer) — which is also what a Gateway started without a config file gets. */
  readonly context?: ContextLimitsConfig | undefined;
}

export interface BuiltApp {
  readonly app: FastifyInstance;
  readonly bus: ReturnType<typeof createEventBus>;
  /** A pairing code minted in the Gateway's own terminal, printed at first run. It is not a route: §3.1 requires
   *  that a code be "generated inside the Gateway's own host/terminal, never accepted from an unauthenticated network
   *  caller", and a bootstrap can hardly require the credential it exists to create. */
  readonly bootstrap?: { code: string; clientId: string; expiresAt: string };
  /** The process's one runner, when the composition root supplied what one needs. Exposed because D-066's drain is a
   *  *sequence* and the sequence belongs to whoever owns the exit path: runs settle before streams close and before
   *  SQLite does, and a run still writing when the database closes is a crash wearing a drain's clothes. Absent means
   *  nothing in this process can move a task, which the banner reports rather than hides. */
  readonly runner?: Runner | undefined;
  /** The process's one scheduler, when a runner exists to fire into. Exposed for the same reason as the runner and with
   *  the same rule about ordering: `shutdown()` is the manager whose arm has to stop *before* the runs settle and before
   *  SQLite closes, because an arm that fires after the drain began would create a task nobody is going to watch
   *  (`packages/core/shutdown.ts`). Absent means the jobs table is read-only in this process, which `GET /api/v1/status`
   *  reports and the banner prints rather than leaving a caller to discover at the next fire. */
  readonly scheduler?: Scheduler | undefined;
  /** The job table itself, read by the routes either way. Handed back so the composition root can answer `job ls`
   *  questions from the same rows the routes answer them from, instead of opening a second reader. */
  readonly jobStore: JobStore;
  /** The one act that turns an objective into a task and a run, exposed so a composition root can bind `task.create`'s
   *  sink to it (D-105). `POST /api/v1/tasks`, the scheduler's `fire` and a tool call inside a run are three callers of
   *  one act, and the act is this file's: it writes the record, ensures the conversation row, appends the `task.created`
   *  event, expands the identity's capabilities into §6.1's grants and hands the run to the runner. A second copy of it
   *  in `packages/tools` would be a second writer of `task.last_seq` and a second opinion about which grants a run holds
   *  — and `packages/gateway` cannot import `packages/tools` to compose the tool itself, because §19's dependency
   *  direction runs the other way (ARCHITECTURE.md §18). So the seam is an act handed out, not a tool built in.
   *  `runner === undefined` is visible on the returned record rather than hidden in a refusal: the task is created and
   *  nothing will move it, which the tool's output has to say. */
  readonly driveTask: (input: DriveTaskInput) => DrivenTask;
  /** The process's one cancellation manager, exposed for the same reason and with the same rule: `task.cancel` must ask
   *  through the manager the routes ask through, because §6.1's step 2 and §6.2's evidence are about *one* request, and a
   *  tool that built its own would hold half of it. Nothing here is a second opinion about stopping work — it is the same
   *  instance, reachable from the party that composes the executor. */
  readonly cancellation: Cancellation;
}

const REDEEM_PATH = "/api/v1/auth/pair";
const MINT_PATH = "/api/v1/auth/pair-codes";
// Listing and revoking identities share a path prefix and a rule, so the guard is one prefix test rather than two
// entries a later route can forget to add itself to.
const CLIENTS_PATH = "/api/v1/auth/clients";

export async function buildApp(deps: GatewayDeps): Promise<BuiltApp> {
  const { db, log } = deps;
  const bus = createEventBus();
  /** §4.1's `availability` predicate needs a fact this file must not read from `process.env` inside a handler, and a
   *  runner needs the same fact for the same reason — so it is resolved once, at composition, and both read the answer
   *  rather than each asking the process again (`RunnerDeps.platform`, `deps.platformFacts`). */
  const platform = deps.platformFacts ?? detectProcess();
  const pruned = pruneEvents(db);
  if (pruned.deleted > 0) log.info("event retention pruned rows", { deleted: pruned.deleted });

  // One arbiter for the whole process: the routes answer through it, the read path sweeps through it, and recovery
  // expires through it, because a second instance over the same rows would be a second opinion about the same queue
  // (D-084). It is built here rather than inside the route registration for that reason.
  const approvals = createApprovals({
    store: createSqliteApprovalStore(db),
    newId: () => newId("apr"),
  });

  // One journal and one checkpoint manager for the whole process, for the reason the arbiter is one: the route reads the
  // view, recovery reads the verdict, and a runner would read the record — three readers, and three instances over one row
  // would be three opinions about where a run stopped. Nothing in this file *writes* a boundary: that is the loop's, and
  // the loop has no home in the Gateway yet (see the header). The log tail is the event store's own read, bounded
  // generously because D-065's retention is 5 000 events per task and a verdict that saw half of it would answer for the
  // half it saw.
  const journal = createSqliteJournal({ db, layout: deps.layout });
  const checkpoints: Checkpoints = createCheckpoints({
    store: createSqliteCheckpointStore(db),
    journal,
    eventsAfter: (taskId, afterSeq) => readEvents(db, taskId, { afterSeq, limit: 10_000 }),
  });

  // One cancellation manager for the whole process, composed here for the reason the arbiter, the journal and the
  // checkpoint manager are: §6.1's step 2 ("stop scheduling new steps") and §6.2's evidence have to be about *one*
  // request, and two managers would each hold half of it. `POST /api/v1/tasks/{id}/cancel` requests through it, the runner passes its
  // `signalFor` to the loop, and the settle writes the evidence the record carries — three parties, one
  // request row. Note what this does *not* need: no provider, no executor and no grants, because stopping work is not
  // the same act as doing it — which is why the manager is composed even when `deps.drive` is absent, and this route
  // answers in a Gateway that drives nothing. When a runner *is* composed it is handed this same instance, and
  // `BuiltApp.cancellation` hands it to the composition root so a `task.cancel` executor asks through it too (D-105):
  // three callers, one request row.
  const cancellation: Cancellation = createCancellation({
    journal,
    checkpoints,
    // Published through the same bus every other writer uses, and the manager's own `phase` writer commits before it
    // publishes — §9's pairing rule is the manager's to keep, not this file's to re-implement.
    publish: (event) => bus.publish(event),
  });

  // The handoff, composed here rather than handed in whole, and the reason is the same one that puts the cancellation
  // manager here: `runner.start` can only honour "one task has one run" (§4.4) and §6.1's step 2 if it holds the *same*
  // manager the cancel route requests through, the same journal the routes read, and the same arbiter the approval
  // routes answer through. A runner composed by the caller would have to be given all four, and then two compositions
  // could disagree about which manager a stop goes through — two parties each holding half of one request, which is
  // exactly what the manager's own comment forbids. So the composition root hands in what only it knows (the executor,
  // the provider, §3.6's model, the install's half of `EvalContext`) and this file wires the rest.
  const runner: Runner | undefined =
    deps.drive === undefined
      ? undefined
      : createRunner({
          journal,
          approvals,
          provider: deps.drive.provider,
          tools: deps.drive.tools,
          platform,
          // Fan-out only. The loop appends its own events through `journal.append`, which returns the frame with the
          // `seq` that was actually stored, so publishing here is the same pairing §9 asks of every other writer:
          // commit, then publish what was committed. A second writer of `task.last_seq` is how a counter starts lying.
          publish: (event) => bus.publish(event),
          cancellation,
          checkpoints,
          // D-112's conversation store, composed here because this is where the database is, and handed to the loop
          // through the same phase that completes a task: the turn and the frame that announces it commit together or not
          // at all, which is what makes §2.5's record and §5.2's log one fact rather than two that may disagree.
          messages: conversationWriter(deps.db),
          modelId: deps.drive.modelId,
          ctx: deps.drive.ctx,
          // D-044's stage 2, as a seam rather than a pool: the Gateway is the only party that knows which providers
          // composed, and the loop is handed the labels rather than the providers, so D-101 keeps holding — it can name a
          // candidate in a prompt and cannot call one. Resolved per ask rather than per run, because the pool a task was
          // started with may have changed by the time its budget runs out, and a prompt listing models that are no longer
          // configured is a prompt offering an answer that would be refused.
          askCandidates: (current) => composeAskCandidates(composedPool(deps), current),
          // D-117's context manager, composed here for the same reason the writer above is: this is where the
          // database is and where the pool lives. The summarizer is D-115's `limits.context.summaryModel`
          // resolved against that pool, or the run's own provider and model when the key is absent — which is
          // a default rather than a switch, since the same model already in use learns nothing new. Both
          // descriptors are read per compaction, not cached, for `composeAskCandidates`'s reason.
          context: createContextManager({
            resolveRun: async () => {
              const described = await describedModel(deps.drive?.provider, deps.drive?.modelId);
              return described === undefined ? undefined : budgetDescriptorOf(described);
            },
            resolveSummarizer: async () => {
              const configured = deps.context?.summaryModel;
              if (configured !== undefined) {
                const [providerId, ...rest] = configured.split("/");
                const modelId = rest.join("/");
                const provider = composedPool(deps).find(
                  (candidate) => candidate.id === providerId,
                );
                if (provider === undefined) return undefined;
                const described = await describedModel(provider, modelId);
                if (described === undefined) return undefined;
                return { provider, descriptor: { ...budgetDescriptorOf(described), modelId } };
              }
              const provider = deps.drive?.provider;
              const modelId = deps.drive?.modelId;
              if (provider === undefined || modelId === undefined) return undefined;
              const described = await describedModel(provider, modelId);
              if (described === undefined) return undefined;
              return { provider, descriptor: { ...budgetDescriptorOf(described), modelId } };
            },
            messages: conversationWriter(deps.db),
            limits: contextLimits(deps.context),
          }),
          limits: deps.drive.limits,
          log,
        });
  if (runner === undefined)
    // Logged rather than inferred from an absence: a Gateway that records tasks and drives none answers every caller
    // with `queued`, and the difference between "no provider was configured" and "the runner is broken" is a sentence
    // the startup log can carry and a task record cannot.
    log.info("no runner composed", {
      reason: "POST /api/v1/tasks will record a task and nothing in this process will drive it",
    });

  /** The job table is read by the routes whether or not anything is composed to drive them, so it is built here rather
   *  than inside the scheduler's `then`: D-057 makes scheduled work a first-class surface, and a surface that only exists
   *  when a provider is configured would hide the jobs a user already has (and hide them best exactly when the provider
   *  broke, which is when a paused list matters). */
  const jobStore = createSqliteJobStore(db);

  // The scheduler is composed beside the runner and for the same reason: a fired job *is* a task handoff, so it has to
  // reach the same runner, the same journal and the same arbiter — and a scheduler built by the caller would have to be
  // handed all four, which is how two compositions end up disagreeing about which manager a stop goes through. It is
  // absent exactly when the runner is, because a timer that creates tasks nothing drives is a queue that grows on a
  // schedule: work nobody asked for yet, arriving at a minute nobody chose (docs/ROADMAP.md §4's "recorded, not driven",
  // applied to work the process cannot do at all).
  const scheduler: Scheduler | undefined =
    runner === undefined
      ? undefined
      : createScheduler({
          store: jobStore,
          fire: (request) => {
            const driven = recordAndDriveTask(deps, bus, runner, {
              objective: request.job.objective,
              // A fresh session per fire rather than the job's own. A job that appended every run to one conversation
              // would grow it without bound, and the session a job belongs to stays on the job row, which is what ties
              // the timer back to the conversation that authorised it (§4.5: "no ambient authority").
              origin: {
                clientId: request.job.createdBy.clientId,
                clientName: request.job.createdBy.name,
                interface: request.job.createdBy.interface,
                capabilities: request.capabilities,
              },
              source: "job",
            });
            if (driven.started === undefined)
              return {
                ok: false,
                code: "no-drive",
                reason:
                  "this Gateway composed no runner, so a fired job would create a task that nothing moves",
              };
            if (!driven.started.ok)
              return { ok: false, code: driven.started.code, reason: driven.started.reason };
            return { ok: true, taskId: driven.task.id };
          },
          identityOf: (clientId) => {
            const identity = getIdentity(db, clientId);
            return identity === undefined
              ? undefined
              : {
                  name: identity.name,
                  interface: identity.interface,
                  capabilities: identity.capabilities,
                };
          },
          taskStateOf: (taskId) => getTask(db, taskId)?.state,
          log,
        });
  if (scheduler === undefined)
    log.info("no scheduler composed", {
      reason:
        "GET /api/v1/jobs answers from the table and nothing fires: a job is a task that runs later, and this process drives no tasks",
    });

  // §7.1's recovery, at the same place the retention prune runs: a restart is one operation, and both halves are about
  // making the file match the world. Recovery marks every non-terminal task `interrupted`, settles a cancellation that
  // was requested before the process died rather than resurrecting it, expires the prompts whose deadline passed while
  // nobody was watching, and reports — per task — why nothing resumed (D-092). It resumes nothing, and the reason is in
  // the event a user reads rather than in this comment.
  const recovered = createRecovery({
    journal,
    approvals,
    checkpoints,
    publish: (event) => bus.publish(event),
  }).recoverAtStartup();
  if (recovered.scanned > 0 || recovered.expiredApprovals.length > 0) {
    log.info("startup recovery", {
      scanned: recovered.scanned,
      interrupted: recovered.interrupted.length,
      settledCancellations: recovered.settledCancellations.length,
      expiredApprovals: recovered.expiredApprovals.length,
      resumable: recovered.interrupted.filter((task) => task.approval !== undefined).length,
    });
  }

  const app = Fastify({ logger: false, bodyLimit: 1_048_576, trustProxy: false });

  // D-069's rule, applied: Fastify asks for a compiler per route context and hands the schema back as an opaque
  // `FastifySchema`, which is exactly the TypeBox schema we registered — so one cast at the seam, and the only
  // validator in the process is the contract's `validate()`.
  app.setValidatorCompiler(({ schema }) => {
    const asSchema = schema as Parameters<typeof validate>[0];
    return (data: unknown) => {
      const result = validate(asSchema, data);
      return result.ok ? { value: data } : { error: validationError(result.problems) };
    };
  });

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const inbound = request.headers["x-crabby-request-id"];
    const requestId = typeof inbound === "string" && inbound.length > 0 ? inbound : newId("req");
    reply.header("x-crabby-request-id", requestId);
    request.crabbyRequestId = requestId;

    const route = request.url.split("?")[0] ?? request.url;
    if (route === REDEEM_PATH) return;
    if (route === MINT_PATH) {
      requireLoopback(request, "pairing");
      requireToken(db, request);
      return;
    }
    // Everything else needs a token, health included: §3.1 says `GET /health` is authenticated "too", and
    // `SECURITY.md` §13 states the rule as "without a valid token, the Gateway must reject every route, including
    // health and SSE". A local caller without credentials therefore gets `401`, which is also the honest answer to
    // "is a Gateway running here?" — it is, and you are not paired to it.
    // §3.1's asymmetry, enforced the way the same section enforces it for minting: identity management is local, because
    // a token stolen off a network-facing path must not be able to lock the owner out of their own device by revoking —
    // and revoking is the irreversible half, since the row is deleted (O-071). The section names `auth.manage` as the
    // capability that decides this, and no code in this build grants capabilities at pairing, so the check is the socket
    // (F-52 records the gap and what closes it). `trustProxy: false` above is what makes it a control rather than a
    // suggestion: a forwarded header cannot move `request.ip`, so a caller behind a tunnel cannot present itself as the
    // machine the Gateway runs on.
    if (route === CLIENTS_PATH || route.startsWith(`${CLIENTS_PATH}/`)) {
      requireLoopback(request, "identity management");
    }
    request.crabbyClient = requireToken(db, request);
  });

  app.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    const requestId = request.crabbyRequestId;
    const gatewayError =
      error instanceof GatewayError
        ? error
        : new GatewayError({
            code: "internal_error",
            message: firstLine(error),
            class: "internal",
            retryable: false,
          });
    reply
      .code(gatewayError.status)
      .type("application/json; charset=utf-8")
      .send(
        errorEnvelope({ ...gatewayError.body, ...(requestId === undefined ? {} : { requestId }) }),
      );
  });

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    // One message whether the path is unknown or merely not built yet, so an unauthenticated probe learns nothing
    // about which routes exist (§3.1).
    const error = notFound("that path", request.crabbyRequestId);
    reply
      .code(error.status)
      .type("application/json; charset=utf-8")
      .send(errorEnvelope(error.body));
  });

  registerSystemRoutes(app, deps, bus, runner, scheduler, jobStore);
  registerPolicyRoutes(app, deps, platform);
  registerConfigRoutes(app, deps);
  registerAuthRoutes(app, deps, bus);
  registerTaskRoutes(app, deps, bus, checkpoints, cancellation, approvals, runner);
  registerJobRoutes(app, deps, jobStore, scheduler);
  registerSessionRoutes(app, deps);
  registerApprovalRoutes(app, deps, bus, approvals, runner);
  registerEventStream(app, deps, bus);

  const bootstrap =
    listIdentities(db).length === 0
      ? mintPairingCode(db, {
          name: "first client",
          interface: "cli",
          capabilities: capabilitiesFor("cli"),
        })
      : undefined;
  return {
    app,
    bus,
    ...(bootstrap ? { bootstrap } : {}),
    ...(runner === undefined ? {} : { runner }),
    ...(scheduler === undefined ? {} : { scheduler }),
    jobStore,
    driveTask: (input: DriveTaskInput) => recordAndDriveTask(deps, bus, runner, input),
    cancellation,
  };
}

/** §4.1's `GET /status` providers row, answered from what the composition root handed in rather than from what the
 *  build contains. `contract-only` was true until M2l landed an adapter and M2m gave it §3.3's other configuration path,
 *  and a row that kept saying so is exactly the claim `docs/CONSISTENCY_REVIEW.md` exists to catch.
 *
 *  Three cases, and the middle one is why this is a function rather than a ternary: an entry that *refused* is not an
 *  absent provider, and the difference is the whole content of the reason. "You have not configured one" and "the one you
 *  configured needs a vault this build does not have" lead to different next commands, and §4.1's row exists so a client
 *  can tell a subsystem that is missing from one that is misconfigured. */
function providersRow(
  composed: readonly ProviderComposition[] | undefined,
  runnerComposed: boolean,
) {
  const entries: { readonly id: string; readonly models: readonly string[] }[] = [];
  const refused: { readonly id: string; readonly reason: string }[] = [];
  for (const entry of composed ?? []) {
    if (entry.ok) entries.push({ id: entry.id, models: entry.modelIds });
    else refused.push({ id: entry.id, reason: entry.reason });
  }
  if (entries.length === 0) {
    return {
      state: "absent",
      reason:
        refused.length > 0
          ? `no provider entry composes — ${refused.map((row) => `${row.id}: ${row.reason}`).join("; ")}`
          : "no provider is configured; §3.3's configuration path is `crabby config set provider.<id>.baseUrl …`, and an " +
            "endpoint that needs a key waits for the vault (M5, docs/CONSISTENCY_REVIEW.md F-56)",
      ...(refused.length === 0 ? {} : { refused }),
    };
  }
  return {
    state: "ready",
    entries,
    ...(refused.length === 0 ? {} : { refused }),
    // What `ready` does not imply, stated because a client that infers it will POST a task and then watch it sit — or,
    // since the handoff, will watch it run and be told it cannot. The adapter composing is a fact about `describe()` and
    // `listModels()`; whether a task is *driven* is a fact about the runner, which exists only when an executor and a
    // selected default model both do. Two notes rather than one, because the two states lead to different next commands:
    // an install that composes a runner is being told what it still cannot pin per task (F-57), and one that does not is
    // being told why its task is sitting in `queued` and where to look (D-098's roots, D-101's default).
    note: runnerComposed
      ? "the adapter is composed into the runner this Gateway drives tasks with, so `POST /api/v1/tasks` is handed a " +
        "run, and a task's model may be pinned per task (D-108, D-110) — what is still absent is per-task narrowing and " +
        "a schedule (F-57's remaining fields), and a resume across a restart: `POST /tasks/{id}/resume` answers a " +
        "ladder ask this process is holding, and `POST /tasks/{id}/resume` continues a task a restart left `interrupted` " +
        "from the checkpoint it committed (F-47) — what is still absent is per-task narrowing and a schedule (F-57's " +
        "remaining fields)"
      : "the adapter is ready and a runner exists (M2n), but this Gateway composed none, because that takes an " +
        "executor over a configured workspace root and a selected default model together: a task created over HTTP is " +
        "recorded and stays `queued`, and `GET /api/v1/diagnostics` reports `runs.composed` " +
        "(docs/ROADMAP.md §4)",
  };
}

// ------------------------------------------------------------------ the handoff, as one act rather than two copies

/** Every provider this Gateway can resolve a `<provider>/<modelId>` pair against: the entries that composed, with the
 *  runner's own provider unioned in so a composition root that hands the two on separately cannot refuse its own default.
 *
 *  One function because there are now two callers with a security argument to share — a per-task pin on `POST /tasks`
 *  (D-110) and the options D-044's ask offers — and they must agree exactly. A resume route that resolved its pin
 *  against a *different* pool than the ask was built from would refuse an answer the prompt had just offered, which is
 *  the kind of failure that looks like a bug and is actually two pools. */
/** D-112's and D-116's one writer, as a function rather than an inline object because **two** consumers need it:
 *  the loop, which records turns as they happen, and the context manager, which records a summary. One
 *  implementation is what makes "a conversation has one writer" true for both kinds of row — an inline copy
 *  for the summary would be a second writer that happened to be spelled the same way, and §2.5's "must not
 *  silently replace or destroy original conversation records" is decided at this seam rather than in prose. */
function conversationWriter(db: SqliteDb): MessageWriter {
  return {
    record: ({ sessionId, taskId, role, content, at }) =>
      appendMessage(db, {
        sessionId,
        ...(taskId === undefined ? {} : { taskId }),
        role,
        content,
        now: new Date(at).toISOString(),
      }),
    summarize: ({ sessionId, taskId, content, covers, at }) =>
      appendMessage(db, {
        sessionId,
        ...(taskId === undefined ? {} : { taskId }),
        role: "system",
        content,
        covers,
        now: new Date(at).toISOString(),
      }),
  };
}

/** §3.2's descriptor, read once per need and answering `undefined` when it is absent — a provider that
 *  cannot describe a model has, per §3.2, disabled it, and a compactor with no descriptor has no budget to
 *  enforce rather than a budget of zero it would compact against forever. */
async function describedModel(
  provider: Provider | undefined,
  modelId: string | undefined,
): Promise<ModelDescriptor | undefined> {
  if (provider === undefined || modelId === undefined) return undefined;
  try {
    return (await provider.describe())[modelId];
  } catch {
    return undefined;
  }
}

/** The two fields §3.4's budget is derived from, and nothing else: a descriptor carries capabilities this
 *  has no use for, and handing a context manager the whole record would let a future field quietly become
 *  a rule nobody priced. */
function budgetDescriptorOf(descriptor: ModelDescriptor): BudgetDescriptor {
  return { contextWindow: descriptor.contextWindow, maxOutputTokens: descriptor.maxOutputTokens };
}

function composedPool(deps: GatewayDeps): readonly Provider[] {
  const composed = (deps.providers ?? []).flatMap((entry) => (entry.ok ? [entry.provider] : []));
  const drive = deps.drive;
  if (drive === undefined || composed.some((candidate) => candidate.id === drive.provider.id))
    return composed;
  return [...composed, drive.provider];
}

/** Recording a task and handing it to the runner, in one function because two callers need it to be the *same* act:
 *  `POST /api/v1/tasks` for a task a client asked for, and the scheduler's `fire` for a task a job asked for. §4.5's
 *  "every execution of a scheduled job is a fresh policy evaluation" is only true if a fired run is built the way an
 *  asked-for one is, and two copies of this sequence would be two opinions about where a run's grants come from — the
 *  second one being the place a timer quietly gained authority its creator never held.
 *
 *  What it owns, in the order §5.1's pairing rule requires: the task row, the `task.created` event appended through the
 *  journal's own writer (which advances `task.last_seq`, so nothing here touches that counter), the publish *after* the
 *  commit, and — when this process has a runner — the `PolicySubject` built from the identity's recorded capabilities.
 *  The withheld half of that expansion is logged rather than dropped, and a `start` that refuses is logged rather than
 *  retried, because the task row is already the truth and §7.1's recovery marks it `interrupted` on the next start.
 *
 *  `origin` is the audit half, and it is why this function takes a person rather than a subject: `RunOrigin` travels to
 *  every tool the run executes, which is what lets `cron.schedule` write a job naming whoever asked for it instead of
 *  naming the process (§4.5's "audit records name a person rather than 'cron'"). */
export interface DriveTaskInput {
  readonly objective: string;
  readonly sessionId?: string | undefined;
  /** §3.6's per-task pin (D-108), stored on the task exactly as it was asked, for §4.3's record to return. Absent
   *  means no pin was asked for. */
  readonly model?: string | undefined;
  /** The same pin already resolved to the pair it names (D-110): the provider the run calls and the bare modelId. The
   *  route resolved it against every composed provider before the task row existed, so a caller that passes a pin
   *  string passes its resolution beside it; a caller that passes only `model` gets that model on the composed
   *  default, which is all a raw string could mean before `pin` existed. */
  readonly pin?: { readonly provider: Provider; readonly modelId: string } | undefined;
  readonly origin: {
    readonly clientId: string;
    readonly clientName: string;
    readonly interface: ClientInterface;
    /** The §6.1 names recorded on the identity — not the grants they expand into, which are computed here. */
    readonly capabilities: readonly string[];
  };
  readonly correlationId?: string | undefined;
  /** Which caller asked, for the log line: a client over HTTP, a job on its schedule, or a tool call inside a run that
   *  is already moving. All three are the same act and different stories, and §14's audit records are only useful if a
   *  reader can tell them apart — `tool` in particular, because a task a model created is work the user did not ask for
   *  by name and the log is where that shows up. */
  readonly source: "client" | "job" | "tool";
}

export interface DrivenTask {
  readonly task: TaskRecord;
  /** The capabilities this identity holds that produced no grant, each with the reason. Returned rather than only logged
   *  so a caller that owes the user an answer — `crabby task run`, or a job's `refused` run row — can give one. */
  readonly withheld: readonly { readonly capability: string; readonly reason: string }[];
  readonly started: StartResult | undefined;
}

/** F-47's continuation, as a route performs it: the run no longer exists, so the question is not "which park is this"
 *  but "whose run was it", and D-111's answer is that the record knows — the origin written with the row.
 *
 *  The identity is then **looked up**, not trusted from the row, which is the same rule a scheduled job's fire follows
 *  (D-054: "a job inherits no ambient authority beyond its own recorded capability set", re-read at fire time so a
 *  revocation is not undone by a timer). O-071's revocation deletes the identity's row, so a revoked creator answers
 *  `undefined` here and the continuation is refused rather than performed under authority that no longer exists.
 *
 *  Who answered is recorded on the route's event and in the log as §14's `by`/`via`, and it is not who the run belongs to:
 *  the run belongs to the creator, which is what `RunInput.origin` has always said about a human answering a prompt in the
 *  middle of a run. */
function restartTask(
  deps: GatewayDeps,
  runner: Runner,
  task: TaskRecord,
  client: { readonly id: string; readonly interface: ClientInterface },
  pair: { readonly provider: string; readonly modelId: string } | undefined,
  provider: Provider | undefined,
): RestartResult {
  const origin = task.origin;
  if (origin === undefined) {
    return {
      ok: false,
      code: "not-interrupted",
      reason:
        `task ${task.id} records no origin, so the run that was on it cannot be rebuilt under an identity anybody can name: ` +
        'rows written before schema version 9 keep answering "no origin" rather than a guess, and a resumption ' +
        "attributed to whoever is asking would be authority a dead process handed over",
    };
  }
  const identity = getIdentity(deps.db, origin.clientId);
  if (identity === undefined) {
    return {
      ok: false,
      code: "not-interrupted",
      reason:
        `task ${task.id} was created by client ${origin.clientId}, which no longer exists — §3.1's revocation took effect ` +
        "and deleted the row, so §7.2's 'recovery never authorizes itself' has nothing left to authorize a continuation " +
        "with. The task can be cancelled, or started again by an identity that still exists",
    };
  }
  // `Identity.interface` is a `string` in storage and a `ClientInterface` everywhere else, so the narrowing happens here
  // rather than by a cast: an interface this build does not know is an identity whose removal rules cannot be computed, and
  // it is refused as the unknown thing it is.
  const iface = identity.interface;
  if (iface !== "cli" && iface !== "tui" && iface !== "web" && iface !== "telegram") {
    return {
      ok: false,
      code: "not-interrupted",
      reason:
        `client ${origin.clientId} was paired for interface \`${iface}\`, which this build does not know, so the grants a ` +
        "continuation would run under cannot be computed (SECURITY.md §13)",
    };
  }
  const { subject } = subjectFor(
    deps,
    { capabilities: identity.capabilities, interface: iface },
    task.id,
  );
  const restart = runner.restart({
    taskId: task.id,
    subject,
    origin: {
      clientId: origin.clientId,
      clientName: origin.clientName,
      interface: origin.interface,
      capabilities: identity.capabilities,
      sessionId: task.sessionId,
    },
    ...(pair === undefined ? {} : { modelId: pair.modelId }),
    ...(provider === undefined ? {} : { provider }),
  });
  if (restart.ok) {
    deps.log.info("task resumed after a restart", {
      task: task.id,
      by: client.id,
      via: client.interface,
      origin: origin.clientId,
    });
  }
  return restart;
}

/** The in-process refusal, in the route's own words where the world disagreed and the runner's where it did not —
 *  the split `CANCEL_REFUSAL_CLASS` already draws. `not-parked` is the world's: a task in `awaiting_approval` with no
 *  pending approval and no run here is a refusal pause or a run this process never held, and neither is the runner's fault. */
function resumeRefusal(
  result: { readonly ok: false; readonly code: ResumeFailureCode; readonly reason: string },
  requestId: string | undefined,
  taskId: string,
): GatewayError {
  return new GatewayError({
    code: `resume_${result.code}`,
    message:
      result.code === "not-parked"
        ? `task ${taskId} is in \`awaiting_approval\` with no pending approval and no run of it in this process: ` +
          "it is D-086's refusal pause, which a materially different action or a cancellation resolves, or a run this " +
          "process does not hold"
        : result.reason,
    class: RESUME_REFUSAL_CLASS[result.code],
    retryable: false,
    ...(requestId === undefined ? {} : { requestId }),
  });
}

/** The runner's own sentences, verbatim, for the refusal classes F-47 added. A route that rephrased them would be a second
 *  voice telling a user why their task will not continue, and the one that knows is the party that read D-065's verdict. */
function restartRefusal(result: {
  readonly ok: false;
  readonly code: RestartFailureCode;
  readonly reason: string;
}): GatewayError {
  return new GatewayError({
    code: `resume_${result.code}`,
    message: result.reason,
    // `re-ask` is a conflict with the *world* (a step whose effect cannot be established), not with the request, and the
    // other two are the same shape as the in-process refusals beside them.
    class: result.code === "no-checkpoint" ? "not-found" : "conflict",
    retryable: false,
  });
}

const NO_RUNNER_SENTENCE =
  "this Gateway composed no runner, so no run of this task exists to rebuild; GET /api/v1/diagnostics reports " +
  "runs.composed and says what is missing";

/** §13's expansion of an identity into a run's `PolicySubject`, in one function because there are now two callers and
 *  they must not disagree: a task that started and a task that continues after a restart are the same act of authority, and
 *  two copies would be two opinions about which capabilities a client holds.
 *
 *  The capabilities passed in are the identity's **current** ones, never a copy from the task row: D-111 stores the
 *  identity and deliberately not its capabilities, so a revocation between the task's creation and its resumption takes
 *  effect on the resumption — which is the whole point of §13's "next request" and the reason a resume is not a replay.
 *  `withheld` comes back because the operator is owed the same log line either way. */
function subjectFor(
  deps: GatewayDeps,
  identity: { readonly capabilities: readonly string[]; readonly interface: ClientInterface },
  taskId: string,
  source?: string,
): {
  readonly subject: LoopSubject;
  readonly withheld: readonly { readonly capability: string; readonly reason: string }[];
} {
  const expansion = grantsFor(identity.capabilities, {
    roots: deps.drive?.ctx.paths?.roots ?? [],
  });
  for (const withheld of expansion.withheld) {
    deps.log.info("capability held, no grant emitted", {
      task: taskId,
      capability: withheld.capability,
      reason: withheld.reason,
      ...(source === undefined ? {} : { source }),
    });
  }
  return {
    subject: {
      grants: expansion.grants,
      // The other half of `PolicySubject`, and the reason a narrowed client gets §13's sentence instead of a denial that
      // reads as repairable: what a restriction removed is not discoverable from `grants`, because an absent grant and a
      // removed one are the same absence. Only the party that knows which interface the identity was paired for can
      // compute the difference.
      removedGrants: removedGrantsFor(identity.capabilities, identity.interface),
      // `ClientInterface` is a subset of policy's `ClientKind` — the same four names — so the kind arrives as the
      // interface that was paired rather than as a guess about the transport. That matters beyond bookkeeping: the kind
      // is what decides whether a T3 prompt may be answered from here at all (D-085).
      clientKind: identity.interface satisfies ClientKind,
    } satisfies LoopSubject,
    withheld: expansion.withheld,
  };
}

function recordAndDriveTask(
  deps: GatewayDeps,
  bus: ReturnType<typeof createEventBus>,
  runner: Runner | undefined,
  input: DriveTaskInput,
): DrivenTask {
  const created = createTask(deps.db, {
    objective: input.objective,
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ...(input.model === undefined ? {} : { model: input.model }),
    // D-111: the identity, written with the row rather than left in the act's arguments. The run below already has it in
    // hand, and the only reader a restart will have is the record — so a task whose origin lives only in the act that
    // created it is a task that cannot be continued by the next process, and cannot be attributed by anything but the log.
    origin: {
      clientId: input.origin.clientId,
      clientName: input.origin.clientName,
      interface: input.origin.interface,
    },
  });
  // The conversation record behind the id, written in the same act as the task rather than left to a route: `createTask`
  // has minted `ses_…` values since schema version 1 and nothing owned them, so an install could hold forty conversations
  // that no list could print (C11-01) and no sidebar could render (W15-01). `ensureSession` creates the row when nothing
  // owns the id, names an un-named one from this objective — W15-03's "the title becomes the first question asked in it",
  // and in a build with no message store the first question is the first task's — and records the activity either way. It
  // never overwrites a title the user chose.
  ensureSession(deps.db, {
    id: created.sessionId,
    titleFrom: input.objective,
    origin: input.origin.interface,
    now: created.createdAt,
  });
  const event: Event = {
    id: newId("evt"),
    schemaVersion: SCHEMA_VERSION,
    type: "task.created",
    ts: new Date().toISOString(),
    sessionId: created.sessionId,
    taskId: created.id,
    seq: 0,
    payload: { objective: created.objective, state: created.state },
  };
  // `appendEvent` advances `task.last_seq` itself, so nothing here duplicates that bookkeeping: two writers of one
  // counter is how a counter starts lying.
  const appended = appendEvent(deps.db, {
    event,
    scratchDir: taskScratch(deps.layout, created.id),
  });
  bus.publish({ ...event, seq: appended.seq });
  const task = getTask(deps.db, created.id) ?? created;
  if (runner === undefined) return { task, withheld: [], started: undefined };

  const { subject, withheld } = subjectFor(deps, input.origin, created.id, input.source);
  // §3.6's per-task pin (D-108's A, D-110's B): the route resolved it against every composed provider before the task
  // was created, so the run uses the pair the pin named — the provider and the bare modelId — instead of the composed
  // default, which is `RunnerDeps.provider` under `RunnerDeps.modelId`. Absent pin means that default, and a caller
  // that passed a raw `model` without resolving it keeps the model on the composed provider: half a pin is still the
  // model it spelled.
  const pinnedModelId =
    input.pin?.modelId ??
    (input.model === undefined ? undefined : input.model.slice(input.model.indexOf("/") + 1));
  const started = runner.start({
    taskId: created.id,
    subject,
    origin: {
      clientId: input.origin.clientId,
      clientName: input.origin.clientName,
      interface: input.origin.interface,
      capabilities: input.origin.capabilities,
      sessionId: created.sessionId,
    },
    ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
    ...(input.pin === undefined ? {} : { provider: input.pin.provider }),
    ...(pinnedModelId === undefined ? {} : { modelId: pinnedModelId }),
  });
  if (!started.ok)
    // Reachable while the process is draining, and for a fired job also when the runner has one run per task and this
    // task somehow already has one. The task stays `queued`, which is the truth rather than a shrug — §7.1's recovery
    // marks it `interrupted` on the next start, and the caller's own record says so beside this line.
    deps.log.warn("run not started", {
      task: created.id,
      code: started.code,
      reason: started.reason,
      source: input.source,
    });
  // Not awaited, because the caller's answer is the record it just wrote and the run moves the task on its own clock. A
  // handler is attached anyway: a rejection nobody owns takes the Gateway down with it, and a dead Gateway is a worse
  // answer than a failed task — the runner's own rule, kept at its caller too.
  else
    void started.run.then(
      (outcome) =>
        deps.log.info("run settled", {
          task: created.id,
          kind: outcome.kind,
          source: input.source,
        }),
      (error: unknown) =>
        deps.log.error("run rejected", {
          task: created.id,
          reason: error instanceof Error ? error.message : String(error),
          source: input.source,
        }),
    );
  return { task, withheld, started };
}

// ------------------------------------------------------------------ system (§4.1)

function registerSystemRoutes(
  app: FastifyInstance,
  deps: GatewayDeps,
  bus: ReturnType<typeof createEventBus>,
  runner: Runner | undefined,
  scheduler: Scheduler | undefined,
  jobStore: JobStore,
): void {
  app.get("/api/v1/health", async (_request, reply) => {
    const listener = boundAddress(app);
    return reply.send({
      status: "ok",
      version: deps.version,
      uptimeMs: Math.max(0, Math.round(Date.now() - deps.startedAt.getTime())),
      listener: { mode: deps.listenerMode, host: listener.host, port: listener.port },
      // Reported as unmanaged rather than unlocked: this build has no vault code, and `locked: false` would claim a
      // protection that does not exist yet.
      vault: { managed: false },
      storage: { schemaVersion: schemaVersion(deps.db) },
    });
  });

  app.get("/api/v1/status", async (_request, reply) => {
    const subsystems = {
      storage: { state: "ready", schemaVersion: schemaVersion(deps.db) },
      scheduler:
        scheduler === undefined
          ? {
              state: "absent" as const,
              reason:
                "this process composed no runner, so nothing drives a fired job: GET /api/v1/jobs answers from the table " +
                "and no timer is armed (POST /api/v1/tasks would record a task and drive it to nothing either)",
            }
          : { state: "ready" as const },
      providers: providersRow(deps.providers, runner !== undefined),
      extensions: { state: "absent", reason: "arrives with M-Extensions" },
      tunnel: { state: "absent", reason: "arrives with the tunnel slice" },
    } as const;
    return reply.send({
      ready: Object.values(subsystems).every((row) => row.state === "ready"),
      subsystems,
    });
  });

  app.get("/api/v1/diagnostics", async (_request, reply) => {
    // Read once rather than per field: `facts()` counts rows, and a diagnostics answer whose four numbers came from four
    // passes over the table could disagree with itself about a job that fired in between.
    const jobFacts = scheduler?.facts();
    // §10's paste-safe view: whatever is in the state dir is fair game, and anything secret-shaped is filtered by the
    // same text scrub the logger uses, which `tests/integration/gateway.test.ts` proves rather than assumes.
    return reply.send({
      generatedAt: new Date().toISOString(),
      version: deps.version,
      listener: boundAddress(app),
      storage: { schemaVersion: schemaVersion(deps.db), stateDir: deps.layout.stateDir },
      tasks: stateCounts(deps.db),
      /** What *this process* is driving, kept apart from `tasks`, which is what the database holds. The two can
       *  disagree and the disagreement is the fact an operator needs: a task can sit `queued` in a Gateway that
       *  composed no runner, and `crabby task run` asks this before it agrees to block on a task nothing will move. */
      runs: { composed: runner !== undefined, inFlight: runner?.outstanding() ?? 0 },
      /** The scheduler's own facts rather than a row count, because the case a user hits after an overnight kill is not
       *  "no jobs" but "an armed timer whose identity was revoked mid-job" — and `missedUnacknowledged` is §4.5's sixth
       *  rule as a number: occurrences that passed while nothing was watching and nobody has answered for yet. */
      jobs: {
        composed: scheduler !== undefined,
        rows: jobStore.all().length,
        armed: jobFacts?.armed ?? false,
        openRuns: jobFacts?.openRuns ?? 0,
        missedUnacknowledged: jobFacts?.missedUnacknowledged ?? 0,
        ...(jobFacts?.nextRunAt === undefined ? {} : { nextRunAt: jobFacts.nextRunAt }),
      },
      streams: { subscribers: bus.subscriberCount },
    });
  });
}

// ------------------------------------------------------------------ policy registry (§8's "List tools + tiers" row)

function registerPolicyRoutes(
  app: FastifyInstance,
  deps: GatewayDeps,
  platform: PlatformFactsLike,
): void {
  app.get("/api/v1/tools", async (_request, reply) => {
    const records = allToolRecords(platform, deps.declares);
    // Two counts rather than one, because they answer different questions and collapsing them would overstate the merge:
    // `implemented` is how many rows a composed executor declares at all, `described` how many ended up with no §4.1 field
    // left pending. An executor that declares a tool without an `outputSchema` raises the first and not the second, and
    // that difference is the honest one — an absent output schema means no result check, not a completed record.
    const implemented = records.filter((record) => deps.declares?.(record.id) !== undefined);
    const described = records.filter((record) => record.pendingRecordFields.length === 0);
    return reply.send({
      items: records,
      count: records.length,
      tiers: [...TIERS],
      capabilities: CAPABILITIES.map((capability) => ({
        name: capability.name,
        grants: capability.grants,
      })),
      registry: {
        source: "PROVIDERS_AND_TOOLS.md §4.2",
        rows: TOOL_REGISTRY.length,
        // The digest `crabby tools ls` prints beside the list, so two devices can confirm they agree without a human
        // comparing 45 lines. Computed from the registry's own fields and deliberately *not* from the merged declarations:
        // the digest is an agreement about policy, and a device with a file executor composed and one without have the same
        // policy and different runtimes. A digest that moved with the executor would report that as a disagreement about
        // tiers, which is the one thing it exists to rule out.
        digest: registryDigest(records),
      },
      // §4.1's other half, reported rather than assumed. `pending` is the count F-55 asked to see shrink: the rows no
      // executor implements, whose records still name all five runtime fields rather than inventing values for them.
      runtime: {
        implemented: implemented.length,
        described: described.length,
        pending: records.length - implemented.length,
      },
    });
  });
}

// ------------------------------------------------------- config (§4.4's `/config` row, §2's concurrency row)

/** §4.4's three config paths: the document, a write of it, and the schema that decides what a key may be.
 *
 *  Three rules are worth stating before the code, because each is a choice a reviewer will ask about:
 *
 *  1. **Every answer is read from the file, not from what this process loaded at startup.** A settings screen that showed
 *     the startup copy would be showing a document that a `crabby config set` in another terminal had already changed, and
 *     the token beside it would be a token for bytes that no longer exist — which is the exact failure §2's concurrency row
 *     exists to refuse, arriving through a read instead of a write.
 *  2. **A write carries §2's token, and the running process does not change.** The Gateway composed its providers, its
 *     executor, its limits and its egress allow-list from the configuration it loaded at startup, and nothing here
 *     re-composes them. `changed` is therefore also the restart flag: a write that moved the file is a fact about the next
 *     start, and the note says so instead of letting a switch look like it took effect.
 *  3. **The route decides on the token, not on `config.write`.** §6.1 names a capability for changing configuration and no
 *     route tests it, which is F-52's shape again: a route has an identity and no `PolicySubject`, and D-097's migration is
 *     what stands between that and a grant test. The tool half is not like this — `config.set` inside a run *is* gated on
 *     `config.write` at **T3** (§4.2), by the arbiter, because a run is the one place this build has a subject.
 *
 *  Values never appear in a log line here, only key paths: §7 puts the obligation at the serializer, and a configuration
 *  value is the one thing in this file that §3.7 forbids in plaintext. */
function registerConfigRoutes(app: FastifyInstance, deps: GatewayDeps): void {
  /** One derivation of "what the file says", used by all three paths so a read and a write cannot disagree about the
   *  document, the token or the redaction. Both views are scrubbed: `file` is what a settings screen edits and `config` is
   *  what the process runs on, and §4.2's "secret *names* only, never values" applies to whichever one a client reads. */
  const answer = (): { body: ConfigReadBody; token: string; file: ConfigFile } => {
    const loaded = loadConfig(deps.layout);
    const document = configDocument(deps.layout);
    const note =
      `${document.exists ? "read" : "no file yet at"} ${document.path} — ` +
      "`file` is the document a write replaces and `config` has D-074's defaults folded in, so an override and a default " +
      `are distinguishable. A write carries this token back as \`If-Match: "${document.token}"\` (§2's concurrency ` +
      "row), and the running Gateway keeps the configuration it loaded at startup, so a change applies at the next start." +
      (document.redacted.length === 0
        ? ""
        : ` ${document.redacted.length} value(s) are withheld and named in \`redacted\`: §4.2's \`config.get\` row is ` +
          "secret *names* only, never values, and the file itself is the place to look at one.");
    return {
      token: document.token,
      file: loaded.file,
      body: {
        ...document,
        limits: document.limits as unknown as Readonly<Record<string, unknown>>,
        note,
      },
    };
  };

  app.get("/api/v1/config", async (_request, reply) => {
    const { body, token } = answer();
    return reply.header("etag", configETag(token)).send(body);
  });

  app.get("/api/v1/config/schema", async (_request, reply) => {
    return reply.send({
      // D-060's schema, and the same function `crabby config schema --json` calls: one opinion about what a key may be,
      // printed by a command and served by a route, rather than a route that transcribes what a command says.
      schema: configSchema(),
      note:
        "the JSON Schema `config.json` is validated against, which is what `PUT /config` and `crabby config set` both " +
        "refuse a document with — D-060 made the schema an output rather than a conversion, so a client can validate " +
        "before it writes instead of learning from a 400",
    });
  });

  app.put<{ Body: PutConfigBody }>(
    "/api/v1/config",
    { schema: { body: PutConfigBody } },
    async (request, reply) => {
      const header = request.headers["if-match"];
      const presented = parseConfigIfMatch(typeof header === "string" ? header : undefined);
      if (presented === undefined)
        // A distinct code rather than `validation_failed`, for the reason the session route gives: the fix is not in the
        // body, and a client that reads the code can act — read the document, take its `etag`, send it back.
        throw new GatewayError({
          code: "if_match_required",
          message:
            'a config mutation carries the document it read, as `If-Match: "9f2c…"` for the token `GET /api/v1/config` ' +
            "answered — §2's concurrency rule, so two interfaces editing one configuration do not silently overwrite " +
            "each other. The token is opaque: present it back unchanged rather than editing the document it names",
          class: "validation",
          retryable: false,
          ...(request.crabbyRequestId === undefined ? {} : { requestId: request.crabbyRequestId }),
        });
      if (!presented.ok)
        throw validationError(
          [{ path: "if-match", kind: "invalid", message: presented.reason }],
          request.crabbyRequestId,
        );

      const before = answer();
      const written = writeConfig(deps.layout, request.body.config as ConfigFile, undefined, {
        token: presented.token,
      });
      if (!written.ok) {
        const code = written.code ?? "unwritable";
        throw new GatewayError({
          code: `config_${code}`,
          message: written.message,
          class: CONFIG_REFUSAL_CLASS[code],
          retryable: false,
          ...(request.crabbyRequestId === undefined ? {} : { requestId: request.crabbyRequestId }),
        });
      }
      const after = answer();
      const changed = before.token !== after.token;
      const changedKeys = [...differingPaths(before.file, after.file, "")];
      const client = request.crabbyClient;
      deps.log.info("config written", {
        path: deps.layout.configPath,
        changed,
        // Key *paths* and never values, for the reason the section header gives: §7's obligation is at the serializer,
        // and §3.7 is why a configuration value is not a log field.
        ...(changedKeys.length === 0 ? {} : { keys: changedKeys.join(", ") }),
        // Named `etag` and not `token`, and the reason is the shared scrub rather than a preference: `redact` masks any
        // string under a key that looks like a credential, so a field called `token` reaches the log file as
        // `[redacted]` — and this line is the only record of which document a write produced, which is what D-107 points
        // a reader at when they ask which of two writers was newer. A config token is not a secret (it is a hash of a
        // document the client already holds), so the honest fix is a field name the scrub does not claim, not a weaker
        // scrub. It is the same string the response's `etag` header carries, which is what the name says.
        etag: after.token,
        ...(client === undefined ? {} : { by: client.id, via: client.interface }),
        ...(request.crabbyRequestId === undefined ? {} : { requestId: request.crabbyRequestId }),
      });
      const body: ConfigWriteBody = {
        ...after.body,
        changed,
        note: changed
          ? `written to ${deps.layout.configPath}: ${
              changedKeys.length === 0
                ? "the document changed"
                : `${changedKeys.join(", ")} changed`
            }. This Gateway keeps the configuration it loaded at startup — its providers, its workspace roots, its ` +
            "limits and its egress allow-list were all composed then — so the write applies at the next start, and " +
            "`changed` is the flag a restart banner reads."
          : `written to ${deps.layout.configPath} with no change: the document is byte-for-byte what the file already ` +
            "said, so there is nothing to restart for and the token did not move",
      };
      return reply.header("etag", configETag(after.token)).send(body);
    },
  );
}

// ------------------------------------------------------------------ auth (§3.1/§3.2)

function registerAuthRoutes(
  app: FastifyInstance,
  deps: GatewayDeps,
  bus: ReturnType<typeof createEventBus>,
): void {
  app.post<{ Body: { code: string } }>(
    REDEEM_PATH,
    {
      schema: { body: PairRequestBody },
    },
    async (request, reply) => {
      const result = redeemPairingCode(deps.db, request.body.code);
      if (!result.ok) {
        throw new GatewayError({
          code: `pairing_${result.reason ?? "unknown"}`,
          // §3.2: "failure text names the next action, never a bare 'invalid code'".
          message: pairingFailure(result.reason),
          class: "auth",
          retryable: false,
        });
      }
      return reply.send({ clientId: result.clientId, token: result.token });
    },
  );

  app.post<{ Body: PairCodeRequestBody }>(
    MINT_PATH,
    {
      schema: { body: PairCodeRequestBody },
    },
    async (request, reply) => {
      // F-52's first two questions, answered where an identity is created rather than in a paragraph: the baseline is
      // what `capabilitiesFor` gives this interface (§6.1's vocabulary, less §9's two shell capabilities and, for the
      // one interface whose requests do not originate on this host, the two §5.3 keeps local), and `restrict` narrows
      // it. This is the writer `capability_json` has had with no caller since M1b — until it ran, every identity held
      // an empty set, so a run started from a route would have been refused every tool it proposed and `auth.manage`
      // could not be the check SECURITY.md §6.1 writes it as.
      const baseline = capabilitiesFor(request.body.interface);
      const restricted =
        request.body.restrict === undefined
          ? { capabilities: baseline, refused: [] as readonly { name: string; reason: string }[] }
          : restrictCapabilities(baseline, request.body.restrict);
      if (restricted.refused.length > 0) {
        // Refusing the whole mint is §2's rule 03 (fail closed) rather than severity: the alternative is minting an
        // identity that quietly holds more or less than was asked for, and the operator's only way to find out would be
        // a later tool call.
        throw validationError(
          restricted.refused.map((row) => ({
            path: "restrict",
            message: row.reason,
            kind: "capability",
          })),
          request.crabbyRequestId,
        );
      }
      const minted = mintPairingCode(deps.db, {
        name: request.body.name,
        interface: request.body.interface,
        capabilities: restricted.capabilities,
      });
      // The answer carries the set because the call that created the identity is the one place that knows it without a
      // second read: a caller who asked for a narrowing has no other way to see that the narrowing took effect, and a
      // caller who did not ask has just learned what a fresh identity holds. `mintPairingCode` returns the pairing
      // record itself (`{code, clientId, expiresAt}`), which is about the code and not about the authority behind it —
      // so the field is added here rather than by widening a storage type whose name says what it is.
      return reply.code(201).send({ ...minted, capabilities: restricted.capabilities });
    },
  );

  app.get("/api/v1/auth/clients", async (_request, reply) =>
    reply.send({
      // §3.1 promises the list says "whether it is currently connected", and only the bus knows that — so the count is
      // read from the same registry a revocation closes streams through, rather than from a second book of who is
      // watching (D-096). Nothing here may leak a token: `listIdentities` does not select one, and the row shape is the
      // contract's `ClientRecord`, `additionalProperties: false` and all.
      items: listIdentities(deps.db).map((identity) => ({
        ...identity,
        liveStreams: bus.countFor(identity.id),
      })),
    }),
  );

  app.delete<{ Params: { id: string } }>("/api/v1/auth/clients/:id", async (request, reply) => {
    const { id } = request.params;
    // Revocation *deletes* the row: `DATA_AND_MEMORY.md` §4's client table has no revocation column, and inventing
    // one in a migration is a schema change the documents have not asked for. The durable record of "this identity
    // was ended on this date" belongs in §14's audit table, which is M2's — O-071 keeps that from being forgotten.
    if (!revoke(deps.db, id)) throw notFound(`client ${id}`);
    // §3.1's second half, and the reason the stream route records which identity opened it: a revoked client must not
    // keep watching a device it has just been told it may not touch. Each live stream gets an `end` frame naming the
    // reason before its socket closes, because a stream that simply stops is what §5.4 tells a client to recover from by
    // reconnecting — and a reconnect through a deleted identity is the one behaviour this rule exists to prevent.
    const ended = bus.closeFor(id, "revoked");
    deps.log.info("identity revoked; live streams ended", { id, streams: ended });
    // 200 with the count rather than 204 with nothing, because `docs/review/CLI.md` C8-10 asks `crabby auth revoke` to
    // print how many streams it terminated — and a number that exists only in the Gateway's log is a number no operator
    // ever sees, which is how a control comes to be quietly unwired again (F-51's shape, one layer up).
    return reply.send({ revoked: id, streamsEnded: ended });
  });
}

// ------------------------------------------------------------------ tasks (§4.3)

function registerTaskRoutes(
  app: FastifyInstance,
  deps: GatewayDeps,
  bus: ReturnType<typeof createEventBus>,
  checkpoints: Checkpoints,
  cancellation: Cancellation,
  /** The process's one arbiter, passed in rather than built here because §6.3's queue and §5's pairing rule are both about
   *  there being exactly one: the resume route reads it to tell a pending approval from D-044's ask, which parks in the
   *  same state with no row behind it. A second arbiter over the same rows would answer `pending` for an approval this
   *  process never opened (D-084). */
  approvals: Approvals,
  /** The process's one runner, or nothing: absent means a task this route creates is recorded and not driven, which is
   *  reported at startup and is a true statement about the install rather than a gap in the route. */
  runner: Runner | undefined,
): void {
  app.post<{ Body: { objective: string; sessionId?: string; model?: string } }>(
    "/api/v1/tasks",
    { schema: { body: CreateTaskBody } },
    async (request, reply) => {
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string" || key.length === 0) {
        throw new GatewayError({
          code: "idempotency_key_required",
          message:
            "POST /api/v1/tasks needs an `Idempotency-Key` header — the same key returns the same task (§2, §4.3)",
          class: "validation",
          retryable: false,
        });
      }
      const body = request.body;
      const hash = requestHash(body);
      const cached = recall(deps.db, key, "POST /api/v1/tasks", hash);
      if (cached.found && "mismatch" in cached) {
        throw new GatewayError({
          code: "idempotency_conflict",
          message:
            "that `Idempotency-Key` was already used with a different body; use a new key to create a second task",
          class: "conflict",
          retryable: false,
        });
      }
      if (cached.found && "record" in cached) return reply.code(201).send(cached.record.response);

      // Read before the record is written rather than after: the run's grants come from this identity, and a caller the
      // guard could not resolve must not leave a task behind that nothing can drive. The check mirrors the cancel
      // route's, because `crabbyClient` is optional on the request type — the one route that answers without a token
      // is `POST /auth/pair`, and this is not it.
      const client = request.crabbyClient;
      if (client === undefined) throw authError("missing", request.crabbyRequestId);
      // §3.6's per-task pin (D-108's A, D-110's B, F-57). Validated here, before the task is created, against every
      // provider this Gateway composed — the usable `deps.providers` entries, with the runner's own provider unioned in
      // so a composition root that hands the two on separately cannot refuse its own default. A pin no entry answers is
      // refused with the reason rather than accepted and left to fail at the first provider call. A Gateway with no
      // drive has no runner and no provider to resolve against — the task is recorded and never runs either way, so the
      // pin is stored inert rather than refused against nothing (D-108's rule, unchanged). The resolution travels into
      // the act as `pin`, because D-101's rule is that the caller resolves and the loop does not: the provider is
      // chosen here, at the same gate that chose the model.
      const drive = deps.drive;
      let pin: { readonly provider: Provider; readonly modelId: string } | undefined;
      if (body.model !== undefined && drive !== undefined) {
        const pinned = await selectPinnedModel(composedPool(deps), body.model);
        if (!pinned.ok) {
          throw new GatewayError({
            code: "invalid_model_pin",
            message: pinned.reason,
            class: "validation",
            retryable: false,
          });
        }
        pin = { provider: pinned.provider, modelId: pinned.modelId };
      }
      const driven = recordAndDriveTask(deps, bus, runner, {
        objective: body.objective,
        ...(body.sessionId === undefined ? {} : { sessionId: body.sessionId }),
        ...(body.model === undefined ? {} : { model: body.model }),
        ...(pin === undefined ? {} : { pin }),
        // The identity the guard resolved, which is the only party that knows who asked. F-52's third question — how
        // `capability_json` becomes a run's grants — is answered inside the shared act rather than here, so that a task a
        // job fires is built the same way as a task a client asks for (§4.5's "every execution is a fresh policy
        // evaluation", D-102).
        origin: {
          clientId: client.id,
          clientName: client.name,
          interface: client.interface,
          capabilities: client.capabilities,
        },
        ...(request.crabbyRequestId === undefined
          ? {}
          : { correlationId: request.crabbyRequestId }),
        source: "client",
      });
      const record = driven.task;
      remember(deps.db, { key, route: "POST /api/v1/tasks", requestHash: hash, response: record });
      return reply.code(201).header("location", `/api/v1/tasks/${record.id}`).send(record);
    },
  );

  /** §6.1's request as a route. It delegates whole to the process's one manager, because the manager owns the request
   *  row, the state move, the event and the abort — a route that re-implemented any of them would be a second writer of
   *  one fact (§9).
   *
   *  What this can do today, stated rather than implied: a task in `queued` or `awaiting_approval` has nothing in
   *  flight, so the manager settles at once and this route answers with a task that is already `cancelled`, carrying
   *  §6.2's evidence on the record (`inFlight: "none"`, `effectsUncertain: false`). A *moving* task answers
   *  `cancelling` and settles when its run stops, which the handoff makes reachable rather than hypothetical:
   *  `recordAndDriveTask` turns the identity that asked into a `PolicySubject` — §6.1's grants from `grantsFor`,
   *  §13's `removedGrants`, the paired interface as `clientKind` — and hands the run to the runner, so a run started
   *  from this route holds the grants its identity was paired for and the loop can signal the step in flight. F-52's
   *  remaining question is the socket guard on `auth.manage`, not this route.
   *
   *  §6.1 names `task.cancel` as the capability that decides who may stop a task. Since the mint route assigns §6.1's
   *  baseline, every paired client in this build *holds* it — but holding is not checking: this route has no subject to
   *  ask, so the control it actually has is still the token the guard demanded before it ran, which is the same
   *  substitution `auth.manage` makes with the socket. F-52 records that gap rather than this comment pretending the
   *  assignment is an enforcement. */
  app.post<{ Params: { id: string }; Body: CancelTaskBody | undefined }>(
    "/api/v1/tasks/:id/cancel",
    { schema: { body: CancelTaskBody } },
    async (request, reply) => {
      const client = request.crabbyClient;
      if (client === undefined) throw authError("missing", request.crabbyRequestId);
      const body = request.body;
      const result = cancellation.request({
        taskId: request.params.id,
        // `mode` is the body's whole reason to exist: without it §6.2's override ("a safety-critical intervention MUST
        // override finish-the-current-step") would be unreachable over HTTP, and a phone's stop button could only ever
        // ask for the polite half of §6.1.
        ...(body?.mode === undefined ? {} : { mode: body.mode }),
        ...(body?.reason === undefined ? {} : { reason: body.reason }),
        // §14's audit fields, which the manager puts in the event payload: who asked, from which interface, and the
        // request id that ties the answer back to the log line a user reads.
        byClientId: client.id,
        via: client.interface,
        at: Date.now(),
        correlationId: request.crabbyRequestId,
      });
      if (!result.ok) {
        throw new GatewayError({
          code: `cancel_${result.code}`,
          // The manager's own sentence, verbatim, for the reason the decision route gives: it already names the section
          // that refused and what the caller can do about it, and a route that rephrased it would be a second voice
          // telling a user why they were denied.
          message: result.reason,
          class: CANCEL_REFUSAL_CLASS[result.code],
          retryable: false,
          ...(request.crabbyRequestId === undefined ? {} : { requestId: request.crabbyRequestId }),
        });
      }
      // Read back rather than returned: §4.3 promises this route answers with the state — `cancelling` while a step
      // finishes, the terminal state once it has — and the record is where §6.2's evidence lands (D-091). A fresh read is
      // also what the invariant demands: never carry a `TaskRecord` across an `await`.
      return reply.send(getTask(deps.db, request.params.id) ?? result.task);
    },
  );

  /** D-044's answer, and the surface §8's matrix row has named since the parity table was written
   *  (`| Resume task | POST /tasks/{id}/resume | task resume | r in detail | Resume | /resume <id> |`).
   *
   *  What it can reach, stated before what it cannot: a ladder ask **this process is holding**. The run's messages live in
   *  the runner's memory — that is what makes the continuation a continuation rather than a rebuild — and a task whose ask
   *  was parked by a process that has since ended is `interrupted` (§7.1), which this route refuses with the sentence
   *  below rather than pretending. The cross-process half arrived with F-47: an `interrupted` task is rebuilt from
   *  D-095's boundary in the same route, under the identity its own record names (D-111) and refused on D-065's verdict.
   *
   *  The ordering of the checks is the design, not an accident. The pin is resolved *before* anything moves, because a
   *  route that accepted an answer and then discovered the model does not exist would have woken a run for nothing. The
   *  pending-approval check comes before the runner call because a task in `awaiting_approval` with a row is waiting for
   *  an approval, and this route is not where that is answered — a client that guessed wrong is told which route to use
   *  rather than being handed a refusal about a park it does not hold.
   *
   *  §6.1 names no capability for this act, and none is invented here. The answer is bound the way an approval decision is
   *  bound — by the token the guard demanded and by the record the runtime holds — which is the same control the decision
   *  route has (F-52's third question, about capabilities becoming a run's grants, is recorded rather than papered over). */
  app.post<{ Params: { id: string }; Body: ResumeTaskBody | undefined }>(
    "/api/v1/tasks/:id/resume",
    { schema: { body: ResumeTaskBody } },
    async (request, reply) => {
      const client = request.crabbyClient;
      if (client === undefined) throw authError("missing", request.crabbyRequestId);
      if (!isTaskId(request.params.id) || getTask(deps.db, request.params.id) === undefined) {
        throw notFound(`task ${request.params.id}`, request.crabbyRequestId);
      }
      const task = getTask(deps.db, request.params.id);
      if (task === undefined) throw notFound(`task ${request.params.id}`, request.crabbyRequestId);
      // Two positions, two mechanisms, one route. `awaiting_approval` is a park this process still holds, so `resume`
      // answers it; `interrupted` is a park a process that has ended was holding, so the run has to be rebuilt from
      // D-095's boundary first (F-47). Both are "waiting for a human", which is why they share a route — and they must be
      // told apart by the record rather than by the caller's guess, because a task that answered the wrong one would move
      // a state machine that does not know about the mistake.
      const afterRestart = task.state === "interrupted";
      if (task.state !== "awaiting_approval" && !afterRestart) {
        // One sentence per position, because the fixes are four different commands and a generic "cannot resume" sends a
        // user looking in the wrong place.
        const where =
          task.state === "queued"
            ? "a queued task has not run far enough to spend a ladder budget, and it starts on its own when a runner picks it up"
            : `it is \`${task.state}\`, which is not a pause waiting on a human: a moving task is not interrupted, and a settled one is terminal and absorbing (AGENT_RUNTIME.md §4.1)`;
        throw new GatewayError({
          code: "not_resumable",
          message: `task ${task.id} cannot be resumed by this route: ${where}`,
          class: "conflict",
          retryable: false,
          ...(request.crabbyRequestId === undefined ? {} : { requestId: request.crabbyRequestId }),
        });
      }
      const pending = afterRestart
        ? undefined
        : approvals.list({ taskId: task.id }).find((row) => row.state === "pending");
      if (pending !== undefined) {
        throw new GatewayError({
          code: "approval_pending",
          message:
            `task ${task.id} is waiting on approval ${pending.id}, and an approval is answered at ` +
            `POST /api/v1/approvals/${pending.id}/decision — D-044's ask parks in the same state with no row behind it, so ` +
            "the row is how a client tells the two apart",
          class: "conflict",
          retryable: false,
          ...(request.crabbyRequestId === undefined ? {} : { requestId: request.crabbyRequestId }),
        });
      }
      const model = request.body?.model;
      let pair: { readonly provider: string; readonly modelId: string } | undefined;
      let provider: Provider | undefined;
      if (model !== undefined) {
        const pinned = await selectPinnedModel(composedPool(deps), model);
        if (!pinned.ok) {
          throw new GatewayError({
            code: "invalid_model_pin",
            message: pinned.reason,
            class: "validation",
            retryable: false,
            ...(request.crabbyRequestId === undefined
              ? {}
              : { requestId: request.crabbyRequestId }),
          });
        }
        pair = { provider: pinned.providerId, modelId: pinned.modelId };
        provider = pinned.provider;
      }
      if (runner === undefined) {
        // The same condition `POST /tasks` answers by recording a task and leaving it `queued` (D-098's roots): there is no
        // run to wake, so nothing here would move, and refusing says why.
        throw new GatewayError({
          code: "no_runner",
          message: `task ${task.id} is paused, but ${NO_RUNNER_SENTENCE}`,
          class: "conflict",
          retryable: false,
          ...(request.crabbyRequestId === undefined ? {} : { requestId: request.crabbyRequestId }),
        });
      }
      if (afterRestart) {
        const rebuilt = restartTask(deps, runner, task, client, pair, provider);
        if (!rebuilt.ok) throw restartRefusal(rebuilt);
      } else {
        const woken = runner.resume(task.id, {
          ...(pair === undefined ? {} : { pair }),
          ...(provider === undefined ? {} : { provider }),
          byClientId: client.id,
          via: client.interface,
        });
        if (!woken.ok) throw resumeRefusal(woken, request.crabbyRequestId, task.id);
      }
      deps.log.info("task resumed", {
        task: task.id,
        ...(model === undefined ? {} : { model }),
        by: client.id,
        via: client.interface,
        ...(request.crabbyRequestId === undefined ? {} : { requestId: request.crabbyRequestId }),
      });
      // Fresh read rather than the outcome's own record: the run has already been launched, so the state this answers with
      // is the one the answer produced — `running` with the switch recorded — and carrying the runner's stale copy across
      // this `await` would be the invariant's violation with a `TaskRecord` instead of a `PolicySubject`.
      return reply.send(getTask(deps.db, task.id) ?? task);
    },
  );

  app.get("/api/v1/tasks", async (request, reply) => {
    const options = parseListQuery(request.query);
    const page = listTasks(deps.db, options);
    return reply.send({
      items: page.items,
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    });
  });

  app.get<{ Params: { id: string } }>("/api/v1/tasks/:id", async (request, reply) => {
    const { id } = request.params;
    if (!isTaskId(id)) throw notFound(`task ${id}`);
    const record = getTask(deps.db, id);
    if (!record) throw notFound(`task ${id}`);
    return reply.send(record);
  });

  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>(
    "/api/v1/tasks/:id/events",
    async (request, reply) => {
      const { id } = request.params;
      if (!isTaskId(id) || !getTask(deps.db, id)) throw notFound(`task ${id}`);
      const raw = Number.parseInt(request.query.cursor ?? "", 10);
      const events = readEvents(deps.db, id, Number.isNaN(raw) ? {} : { afterSeq: raw });
      return reply.send({ items: events, replayWindow: REPLAY_WINDOW_EVENTS });
    },
  );

  // §4.3's "checkpoint view for recovery transparency" (D-065, D-095). A route of its own rather than a field on
  // `GET /tasks/{id}` for two reasons: the record behind it holds a run's working context, which `AGENT_RUNTIME.md` §8.2
  // counts as a different category from the task record, and the view is computed at read time — D-065's verdict depends on the task's
  // state now and on the log tail after the boundary, so storing it would be storing a guess. What comes back is the
  // boundary, its size and the verdict; what does not is the transcript, because a redacted working context handed to
  // four interfaces would be a fourth copy of a conversation nobody owns (`packages/api-contracts/checkpoint.ts`).
  app.get<{ Params: { id: string } }>("/api/v1/tasks/:id/checkpoint", async (request, reply) => {
    const { id } = request.params;
    if (!isTaskId(id) || !getTask(deps.db, id)) throw notFound(`task ${id}`);
    const view = checkpoints.view(id);
    if (view === undefined) {
      // Not an empty object, and not the same 404 as a missing task. "No saved state" is an answer D-065 gives — the run
      // never reached a committed step boundary — and the reason is the part a user can act on, so it rides in `details`
      // while the message stays the uniform sentence §3.1 requires.
      const answer = checkpoints.verdict(id);
      throw new GatewayError({
        code: "not_found",
        message: `a checkpoint for task ${id} was not found. \`GET /api/v1/health\` answers for a live Gateway.`,
        class: "not-found",
        retryable: false,
        details: { verdict: answer.verdict, reason: answer.reason },
        taskId: id,
        ...(request.crabbyRequestId === undefined ? {} : { requestId: request.crabbyRequestId }),
      });
    }
    return reply.send(view);
  });
}

/** §6.3's expiry, applied on the read path (D-093). Rows and events commit together and are published after, which is the
 *  same discipline the decision route keeps; a row expired without its event would be a queue and a log disagreeing about
 *  whether a prompt is still open. */
function sweepApprovals(
  deps: GatewayDeps,
  approvals: Approvals,
  bus: ReturnType<typeof createEventBus>,
): number {
  const at = Date.now();
  const staged = transact(deps.db, () => {
    const swept = approvals.sweep(at);
    const events: Event[] = [];
    for (const change of swept.expired) {
      const task = getTask(deps.db, change.record.request.taskId);
      if (task === undefined) {
        // Unreachable while the foreign key holds, and still the right answer if it ever becomes reachable: an approval
        // that moved with no task to log against cannot be described in an event, so nothing moves.
        throw new GatewayError({
          code: "approval_without_task",
          message: `approval ${change.record.id} refers to task ${change.record.request.taskId}, which is not in the database`,
          class: "internal",
          retryable: false,
        });
      }
      const event: Event = {
        id: newId("evt"),
        schemaVersion: SCHEMA_VERSION,
        type: change.event,
        ts: new Date(at).toISOString(),
        sessionId: task.sessionId,
        taskId: task.id,
        seq: 0,
        payload: {
          approvalId: change.record.id,
          tool: change.record.request.tool,
          tier: change.record.request.tier,
          binding: change.record.request.binding,
          expiresAt: new Date(change.record.request.expiresAt).toISOString(),
          // The event's `ts` is when the sweep ran, and this is when the row actually died: a prompt that expired
          // overnight is logged in the morning, and a reader has to be able to tell the two times apart.
          expiredAt: new Date(change.record.request.expiresAt).toISOString(),
          outcome: "expired",
        },
      };
      const appended = appendEvent(deps.db, {
        event,
        scratchDir: taskScratch(deps.layout, task.id),
      });
      events.push({ ...event, seq: appended.seq });
    }
    return events;
  });
  for (const event of staged) bus.publish(event);
  return staged.length;
}

// ------------------------------------------------------------------ jobs (§4.3, PROVIDERS_AND_TOOLS.md §4.5, D-046/D-057)

/** Which of the four verbs a request asked for. A union rather than four near-identical handlers because they differ in
 *  the act and not in the shape of the answer, and the shape is what C12-03 and C12-04 print. */
type JobVerb = "pause" | "resume" | "run" | "backlog";

const JOB_VERB_LOGGED: Record<JobVerb, string> = {
  pause: "job paused",
  resume: "job resumed",
  run: "job run outside its schedule",
  backlog: "job backlog answered",
};

/** §4.3's conversation paths — four of the nine it lists, and the five that are not here are absent for a reason a client
 *  can see rather than for want of a file.
 *
 *  What exists: `GET /api/v1/sessions` (C11-01's list, W15-01's rows), `POST /api/v1/sessions` (W15-03's "starts empty and
 *  un-named"), `GET /api/v1/sessions/{id}` and `PATCH /api/v1/sessions/{id}` (W15-04 and T16-05's one write path with two
 *  entry points). What does not, and why: `DELETE /api/v1/sessions/{id}` is `history.deleteConversation` at **T3** (§4.2),
 *  which C11-05 keeps as the one command that destroys history and W15-07 prices with a typed confirmation — a delete this
 *  route could reach would be a second path to the same irreversible act with no confirmation on it; and `messages`,
 *  `compact`, `export`, `context` and `pin` all read a message store and D-027's context manager, neither of which exists,
 *  so `GET /api/v1/sessions/{id}` names them in its `absent` list instead of answering `0 turns` for a conversation that
 *  has forty.
 *
 *  `PATCH` requires an `If-Match` token and answers with an `ETag`, because §2's concurrency row asks for exactly that on
 *  session mutations: a title is the one field four interfaces can edit inline at the same moment (W1-02 in the status bar,
 *  W15-04 in the sidebar, T16-05 in the switcher), and last-write-wins there is a rename that silently disappears. The
 *  token is the row's `revision`, which counts edits and not activity: a task moving in a conversation touches
 *  `last_activity_at` without spending the token a phone is holding, so an inline rename does not fail because the agent
 *  answered a question while the user was typing. */
function registerSessionRoutes(app: FastifyInstance, deps: GatewayDeps): void {
  /** A session with no tasks yet, which is what W15-03 creates: the facts are zeroes rather than an absent lookup, so the
   *  state word is `idle` and a client has nothing to guess about. */
  const NO_TASKS: SessionTaskFacts = { tasks: 0, running: 0, waitingApproval: 0 };

  /** C11-03's columns this build cannot answer, named rather than omitted: turns need a message store, budget and pinned
   *  items need D-027's context manager. A detail body that left them out would let a client render a zero for something
   *  it never asked about, and `crabby session show` stays planned for the same reason. */
  /** What this build still cannot answer about a conversation (D-112 took `messages` off this list, and with it the
   *  "0 turns" render C11-03's `session show` was refused by name). `context` and `pins` need D-027's context manager, which
   *  is the next slice and not this one. */
  const ABSENT = ["context", "pins"] as const;
  /** The page size for a conversation's turns, with the true total beside it — the same reasoning as `TASK_LIMIT`, and the
   *  same shape: a conversation kept for a month holds more turns than a phone should render in one response. */
  const MESSAGE_LIMIT = 100;
  /** The bound on the tasks a detail answer carries, with the true total beside it — the same shape a job's run history
   *  uses, because a conversation kept for a month holds more tasks than a phone should render in one response. */
  const TASK_LIMIT = 20;

  const refusal = (
    result: { readonly code: SessionActionCode; readonly reason: string },
    requestId: string | undefined,
  ): GatewayError =>
    new GatewayError({
      code: `session_${result.code}`,
      message: result.reason,
      class: SESSION_REFUSAL_CLASS[result.code],
      retryable: false,
      ...(requestId === undefined ? {} : { requestId }),
    });

  app.get<{ Querystring: Record<string, string> }>("/api/v1/sessions", async (request, reply) => {
    const wanted = request.query.origin;
    if (wanted !== undefined && !(SESSION_ORIGINS as readonly string[]).includes(wanted))
      throw validationError(
        [
          {
            path: "origin",
            kind: "enum",
            message:
              `must be one of ${SESSION_ORIGINS.join(", ")} — W15-11's attribution is the four interfaces, and a ` +
              "filter nobody can spell is a list nobody can trust",
          },
        ],
        request.crabbyRequestId,
      );
    const records = listSessions(deps.db, {
      ...(wanted === undefined ? {} : { origin: wanted as ClientInterface }),
    });
    // One aggregate query for the page rather than one per row: C11-01's list is what a phone renders on a pull-down,
    // and a list that cost one query per line would not survive the render.
    const facts = sessionTaskFacts(deps.db);
    const items = records.map((record) => sessionRow(record, facts.get(record.id) ?? NO_TASKS));
    const body = {
      items,
      count: items.length,
      sortedBy: "lastActivity",
    } as const satisfies SessionListBody;
    return reply.send(body);
  });

  app.post<{ Body: CreateSessionBody }>(
    "/api/v1/sessions",
    { schema: { body: CreateSessionBody } },
    async (request, reply) => {
      const client = request.crabbyClient;
      const record = createSession(deps.db, {
        ...(request.body.title === undefined ? {} : { title: request.body.title }),
        ...(request.body.model === undefined ? {} : { model: request.body.model }),
        // W15-11's attribution comes from the credential and never from the body: an interface a caller declares is a
        // claim, and the list this row appears in is where a user notices "this appeared on its own".
        ...(client === undefined ? {} : { origin: client.interface }),
      });
      deps.log.info("session created", {
        session: record.id,
        ...(client === undefined ? {} : { by: client.id, via: client.interface }),
        ...(request.crabbyRequestId === undefined ? {} : { requestId: request.crabbyRequestId }),
        ...(record.title === undefined
          ? { title: "un-named, per W15-03 — it becomes the first question asked in it" }
          : { title: record.title }),
      });
      const body = {
        session: sessionRow(record, NO_TASKS),
        note:
          record.title === undefined
            ? "created empty and un-named: the title becomes the first question asked in it (W15-03), and until then " +
              "`crabby session ls` prints `un-named`"
            : `created as '${record.title}'`,
      } satisfies SessionActionBody;
      return reply
        .code(201)
        .header("location", `/api/v1/sessions/${record.id}`)
        .header("etag", sessionETag(record.revision))
        .send(body);
    },
  );

  app.get<{ Params: { id: string } }>("/api/v1/sessions/:id", async (request, reply) => {
    const record = getSession(deps.db, request.params.id);
    if (record === undefined)
      throw notFound(`session ${request.params.id}`, request.crabbyRequestId);
    const body = {
      session: sessionRow(record, sessionTaskFactsFor(deps.db, record.id)),
      tasks: sessionTasks(deps.db, record.id, TASK_LIMIT),
      taskCount: sessionTaskCount(deps.db, record.id),
      absent: ABSENT,
    } satisfies SessionDetailBody;
    return reply.header("etag", sessionETag(record.revision)).send(body);
  });

  /** §2.5's message half, as a route: C11-03's `session show` asks for turns and gets them here, one page at a time.
   *
   *  Three things are deliberately absent from the answer. There is no `summary` field, because §2.5's "generated summaries
   *  must not silently replace or destroy original conversation records" means a summary is *another* record and D-027's
   *  compaction is what would write one — a route that could show a summary would have to decide which one is authoritative,
   *  and that is §8.4's question rather than this route's. There is no `content` redaction parameter, because the stored text
   *  is already redacted on write (SECURITY.md §7) and a second knob over the same bytes is a way for a caller to ask for
   *  the unredacted one. And an unknown session is a `404` rather than an empty list, for the reason every other route here
   *  gives: "no such conversation" and "a conversation with nothing said yet" are different answers. */
  app.get<{ Params: { id: string }; Querystring: { cursor?: string; limit?: string } }>(
    "/api/v1/sessions/:id/messages",
    async (request, reply) => {
      const record = getSession(deps.db, request.params.id);
      if (record === undefined) {
        throw notFound(`session ${request.params.id}`, request.crabbyRequestId);
      }
      const limit = request.query.limit;
      if (
        limit !== undefined &&
        (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > MESSAGE_LIMIT)
      ) {
        throw validationError(
          [
            {
              path: "limit",
              message: `a page is 1..${MESSAGE_LIMIT} turns; the bound is this route's, and a caller asking for more gets pages`,
              kind: "range",
            },
          ],
          request.crabbyRequestId,
        );
      }
      const cursor = request.query.cursor;
      if (cursor !== undefined && !/^\d+$/.test(cursor)) {
        throw validationError(
          [
            {
              path: "cursor",
              message: "the cursor is the ordinal of the last turn a page carried",
              kind: "pattern",
            },
          ],
          request.crabbyRequestId,
        );
      }
      const page = listMessages(deps.db, record.id, {
        limit: limit === undefined ? MESSAGE_LIMIT : Number(limit),
        ...(cursor === undefined ? {} : { after: Number(cursor) }),
      });
      const last = page.items.at(-1);
      const body: MessageListBody = {
        items: page.items,
        count: page.count,
        ...(last !== undefined && last.ordinal < page.count
          ? { nextCursor: String(last.ordinal) }
          : {}),
      };
      return reply.send(body);
    },
  );

  /** D-027's route: compact a conversation now rather than at the budget, and §4.2's "the same act asked by
   *  hand" made literal — this calls `createContextManager`, the same function the loop calls before every
   *  provider request, so "compact now" and "compact at 0.8" cannot drift into two opinions about what a summary
   *  contains (D-113, D-117).
   *
   *  Three decisions the owner made in conversation, and none of them is this file's: **`session.write`, with no
   *  extra prompt** (SECURITY §6.1 already grants it, and a user pressing "compact" has already asked for it —
   *  the model call it costs is the price of that button), **a direct session mutation rather than a task** (a
   *  compaction has no steps to watch, nothing to cancel and no result to read, and making it a task would spend
   *  a T2 to create a record of an act that takes seconds), and **one writer, this loop's** — the same
   *  `conversationWriter(db)` the runtime records turns through.
   *
   *  The capability that would decide this is `session.write`, and the route is gated by the token exactly as
   *  `PATCH /sessions/{id}` is; F-52 records that no route enforces a capability by name yet, and a route that
   *  invented its own check would be one enforcement path the rest of this file does not have.
   */
  app.post<{ Params: { id: string } }>("/api/v1/sessions/:id/compact", async (request, reply) => {
    const session = getSession(deps.db, request.params.id);
    if (session === undefined)
      throw new GatewayError({
        code: "session_not_found",
        message: `no conversation ${request.params.id} is in this data directory`,
        class: "not-found",
        retryable: false,
        ...(request.crabbyRequestId === undefined ? {} : { requestId: request.crabbyRequestId }),
      });

    // §3.4's threshold needs the run's model: a conversation's own override if it has one, because a budget is a
    // fact about the model that has to carry the conversation, and the install's default otherwise.
    const modelId = session.model ?? deps.drive?.modelId;
    const descriptor = await describedModel(deps.drive?.provider, modelId);
    const limits = contextLimits(deps.context);
    if (descriptor === undefined)
      // §3.2 again: a model nobody can describe is disabled, so there is no window to compact against and a 503
      // that says so beats a 200 that claimed nothing needed doing.
      throw new GatewayError({
        code: "context_unavailable",
        message:
          `no descriptor for ${modelId ?? "the default model"}, so there is no context window to compact against ` +
          "(PROVIDERS_AND_TOOLS.md §3.2 disables a model that cannot describe itself)",
        class: "provider",
        retryable: true,
        ...(request.crabbyRequestId === undefined ? {} : { requestId: request.crabbyRequestId }),
      });
    const budget = contextBudget(budgetDescriptorOf(descriptor), limits);

    // The cheap read first (D-118): a length decides most conversations without loading a turn.
    const size = messageCharCount(deps.db, session.id);
    const projected = { tokens: estimateFromChars(size.chars), source: "estimated" as const };
    if (projected.tokens <= budget.compactAtTokens)
      return reply.send({
        sessionId: session.id,
        outcome: "not-needed",
        projected,
        threshold: budget.compactAtTokens,
        note:
          `this conversation holds ${size.rows} turn${size.rows === 1 ? "" : "s"} and costs about ` +
          `${projected.tokens.toLocaleString("en-US")} of an estimated ${budget.budget.toLocaleString("en-US")} ` +
          `tokens, under the ${limits.compactAt} threshold — nothing to summarize`,
      } satisfies CompactSessionBody);

    // The expensive read, page by page, because a conversation kept for a month can hold more turns than a phone
    // should hold in one array (§2's bounded-page rule, applied to a route that reads rather than renders).
    const rows: MessageRecord[] = [];
    let cursor: number | undefined;
    for (let page = 0; page < 50; page += 1) {
      const read = listMessages(deps.db, session.id, {
        limit: 200,
        ...(cursor === undefined ? {} : { after: cursor }),
      });
      rows.push(...read.items);
      if (read.items.length < 200) break;
      cursor = read.items.at(-1)?.ordinal;
    }
    const manager = createContextManager({
      resolveRun: async () => budgetDescriptorOf(descriptor),
      resolveSummarizer: async () => {
        const configured = deps.context?.summaryModel;
        const [providerId, ...rest] = (
          configured ?? `${deps.drive?.provider.id ?? ""}/${modelId ?? ""}`
        ).split("/");
        const wanted = configured === undefined ? modelId : rest.join("/");
        const provider = composedPool(deps).find((candidate) => candidate.id === providerId);
        if (provider === undefined || wanted === undefined) return undefined;
        const described = await describedModel(provider, wanted);
        return described === undefined
          ? undefined
          : { provider, descriptor: { ...budgetDescriptorOf(described), modelId: wanted } };
      },
      messages: conversationWriter(deps.db),
      limits,
    });
    const ordinals = new Map<{ role: string; content: string }, number>();
    const messages = rows.map((row) => {
      const message = { role: row.role, content: row.content } as { role: string; content: string };
      ordinals.set(message, row.ordinal);
      return message;
    });
    const result = await manager.compact({
      sessionId: session.id,
      // No `taskId`: a conversation can outgrow its budget with nothing running, and §2.5's rows have a nullable
      // `task_id` for exactly this conversation.
      messages: messages as never,
      ordinalOf: (message) => ordinals.get(message as { role: string; content: string }),
    });
    const client = request.crabbyClient;
    deps.log.info("session compacted", {
      session: session.id,
      outcome: result.kind,
      ...(result.kind === "compacted" ? { covers: result.covers, turns: result.turns } : {}),
      ...(result.kind === "refused" ? { reason: result.reason } : {}),
      ...(client === undefined ? {} : { by: client.id, via: client.interface }),
      ...(request.crabbyRequestId === undefined ? {} : { requestId: request.crabbyRequestId }),
    });
    if (result.kind === "failed")
      // §3.5's class for "the thing you asked for did not happen because a model call did not work", and retryable
      // because a summarizer that was rate-limited a minute ago may not be now.
      throw new GatewayError({
        code: "context_compaction_failed",
        message: result.reason,
        class: "provider",
        retryable: true,
        ...(request.crabbyRequestId === undefined ? {} : { requestId: request.crabbyRequestId }),
      });
    if (result.kind === "refused" && result.reason === "summarizer-unavailable")
      throw new GatewayError({
        code: "context_unavailable",
        message:
          "no model is configured to write a summary with; set one with " +
          "`crabby config set limits.context.summaryModel <provider>/<model>`, or configure a provider at all",
        class: "provider",
        retryable: false,
        ...(request.crabbyRequestId === undefined ? {} : { requestId: request.crabbyRequestId }),
      });
    if (result.kind === "unchanged")
      return reply.send({
        sessionId: session.id,
        outcome: "not-needed",
        projected,
        threshold: budget.compactAtTokens,
        note: "the turns this conversation holds do not reach the compaction threshold",
      } satisfies CompactSessionBody);
    if (result.kind === "refused") {
      // The fourth refusal (`summarizer-unavailable`) was answered above as an error, so what reaches here is
      // one of the three conversation-shaped names the contracts define — which is what makes the lookup total.
      const reason = result.reason as CompactionRefusalName;
      return reply.send({
        sessionId: session.id,
        outcome: "refused",
        reason,
        projected,
        threshold: budget.compactAtTokens,
        note: COMPACTION_REFUSAL_NOTES[reason],
      } satisfies CompactSessionBody);
    }
    const summary = getMessage(deps.db, result.stored.id);
    return reply.send({
      sessionId: session.id,
      outcome: "compacted",
      ...(summary === undefined ? {} : { summary }),
      covers: result.covers,
      turns: result.turns,
      projected,
      threshold: budget.compactAtTokens,
      note:
        `summarized turns ${result.covers.from}–${result.covers.through} into one summary; the ` +
        `${result.turns} turns they name are still readable at GET /api/v1/sessions/${session.id}/messages`,
    } satisfies CompactSessionBody);
  });

  app.patch<{ Params: { id: string }; Body: PatchSessionBody }>(
    "/api/v1/sessions/:id",
    { schema: { body: PatchSessionBody } },
    async (request, reply) => {
      const header = request.headers["if-match"];
      const token = parseIfMatch(typeof header === "string" ? header : undefined);
      if (token === undefined)
        // A distinct code rather than `validation_failed`, because the fix is not in the body and a client that reads the
        // code can act: fetch the row, take its `etag`, send it back.
        throw new GatewayError({
          code: "if_match_required",
          message:
            'a session mutation carries the revision it read, as `If-Match: "3"` for a row whose `revision` is 3 — ' +
            "§2's concurrency rule, so two interfaces editing one title do not silently overwrite each other. " +
            "`GET /api/v1/sessions/{id}` answers with the token in its `etag`, and every list row carries `revision`",
          class: "validation",
          retryable: false,
          ...(request.crabbyRequestId === undefined ? {} : { requestId: request.crabbyRequestId }),
        });
      if (!token.ok)
        throw validationError(
          [{ path: "if-match", kind: "invalid", message: token.reason }],
          request.crabbyRequestId,
        );
      const result = patchSession(deps.db, request.params.id, {
        ...(request.body.title === undefined ? {} : { title: request.body.title }),
        ...(request.body.model === undefined ? {} : { model: request.body.model }),
        expectedRevision: token.revision,
      });
      if (!result.ok) throw refusal(result, request.crabbyRequestId);
      const client = request.crabbyClient;
      deps.log.info("session edited", {
        session: result.session.id,
        revision: result.session.revision,
        ...(request.body.title === undefined ? {} : { title: request.body.title }),
        ...(request.body.model === undefined
          ? {}
          : { model: request.body.model ?? "install default (override cleared)" }),
        ...(client === undefined ? {} : { by: client.id, via: client.interface }),
        ...(request.crabbyRequestId === undefined ? {} : { requestId: request.crabbyRequestId }),
      });
      const titled =
        request.body.title === undefined ? "" : `the title is now '${request.body.title}'`;
      const model =
        request.body.model === undefined
          ? ""
          : request.body.model === null
            ? "the model override is cleared, so the session uses the install's default again"
            : `the model override is now ${request.body.model}`;
      const body = {
        session: sessionRow(result.session, sessionTaskFactsFor(deps.db, result.session.id)),
        note:
          `${titled}${titled !== "" && model !== "" ? " and " : ""}${model}` +
          ` — revision ${result.session.revision}, which is the token the next edit carries`,
      } satisfies SessionActionBody;
      return reply.header("etag", sessionETag(result.session.revision)).send(body);
    },
  );
}

/** §4.5's surface over HTTP, and the read half of D-057's "first-class": a Web `Scheduled` pane, a sixth TUI pane and
 *  Telegram's `/jobs` all answer from these six paths rather than each opening the database.
 *
 *  Six paths and no seventh, and the missing one is the one a reader looks for first: there is no `POST /api/v1/jobs`.
 *  Creation is `cron.schedule`, a T2 tool call whose arguments the user read and approved, and a route that created a job
 *  would be a second creation path with no approval anywhere in it — the shape C12-09 refuses for `crabby job create` and
 *  the reason F-57's `schedule` field on `POST /api/v1/tasks` is still unbuilt instead of quietly built here.
 *
 *  What these routes may change is priced by §4.5's first rule. Name and schedule are the non-material half, so `PATCH`
 *  takes exactly those two and `packages/storage/jobs.ts`'s `JobPatch` has no `objective` field to take: the material half
 *  (steps, targets, recipients, model or provider) "crosses into re-approval", and nothing outside the loop can open one
 *  (D-084), so the honest surface is one that cannot perform the change rather than one that performs it and calls it
 *  reviewed.
 *
 *  Authority is the token the guard demanded and nothing else. `SECURITY.md` §6.1's table names no job capability, so
 *  there is no name to check — and inventing one here would build a Gateway that refuses its own paired owner's
 *  `crabby job ls`. That is the same substitution `auth.manage` makes with the socket, and F-52 records the gap rather
 *  than this comment pretending the absence is an enforcement.
 *
 *  No `job.*` events are published. `Event.taskId` is required (O-070) and a pause is not a task, so the link a client
 *  needs is the one the record already carries: `job_run.taskId`, from which W16's pane opens the task stream that does
 *  exist. A pane that wants to notice a pause without polling waits on the taskless-envelope question O-070 asks.
 *
 *  Reads answer from the store whether or not a scheduler was composed, and say so in the payload. A list that 501'd
 *  because no provider is configured would hide the jobs a user has exactly when they most need to see what is paused. */
function registerJobRoutes(
  app: FastifyInstance,
  deps: GatewayDeps,
  jobs: JobStore,
  scheduler: Scheduler | undefined,
): void {
  const NOT_DRIVEN =
    "recorded, not driven: this Gateway composed no runner, so no timer is armed and nothing fires. " +
    "`GET /api/v1/diagnostics` reports `runs.composed` and `jobs.composed`, which is the fact that explains these rows";

  /** 501 rather than 503: the missing party is a composition this process does not have, not a service that is down, and
   *  `platform-unsupported` is §6's class for "this Gateway cannot do that here". A client that treated it as transient
   *  would retry forever. */
  const absent = (requestId: string | undefined) =>
    new GatewayError({
      code: "scheduler_absent",
      message:
        "this Gateway composed no scheduler, because it composed no runner, and a job is a task that runs later: nothing " +
        "here drives tasks. `GET /api/v1/jobs` still answers from the table, and `GET /api/v1/diagnostics` reports " +
        "`runs.composed:false`. A provider and a workspace root configured together are what `crabby gateway start` " +
        "composes a runner from",
      class: "platform-unsupported",
      retryable: false,
      ...(requestId === undefined ? {} : { requestId }),
    });

  /** The scheduler's own sentence, verbatim, for the reason the cancellation route gives: it already names the rule that
   *  refused and what the caller can do about it, and a route that rephrased it would be a second voice explaining one
   *  denial. The class comes from the exhaustive map, so a new refusal fails `errors.ts` until somebody says what it
   *  means over HTTP. */
  const refusal = (
    result: { readonly code: JobActionCode; readonly reason: string },
    requestId: string | undefined,
  ) =>
    new GatewayError({
      code: `job_${result.code}`,
      message: result.reason,
      class: JOB_REFUSAL_CLASS[result.code],
      retryable: false,
      ...(requestId === undefined ? {} : { requestId }),
    });

  /** The row every read answers with, through `jobRow` rather than by hand: the wall-clock stamp and the state word are
   *  each a claim about two records at once, and four clients deriving them separately would derive four answers (D-103). */
  const row = (job: JobRecord): JobRow => {
    const at = job.nextRunAt === undefined ? Number.NaN : Date.parse(job.nextRunAt);
    return jobRow(job, jobs.lastRun(job.id), Number.isNaN(at) ? undefined : localStamp(at));
  };

  /** §14's audit fields for a write no loop performed. Logged as well as returned, because a pause asked for from a phone
   *  at two in the morning has to be findable in the log by whoever reads it, not remembered by whoever asked. */
  const audit = (
    what: string,
    jobId: string,
    request: FastifyRequest,
    extra: Record<string, unknown> = {},
  ): void => {
    const client = request.crabbyClient;
    deps.log.info(what, {
      job: jobId,
      ...(client === undefined ? {} : { by: client.id, via: client.interface }),
      ...(request.crabbyRequestId === undefined ? {} : { requestId: request.crabbyRequestId }),
      ...extra,
    });
  };

  app.get<{ Querystring: Record<string, string> }>("/api/v1/jobs", async (request, reply) => {
    const wanted = request.query.state;
    if (wanted !== undefined && !isJobState(wanted))
      throw validationError(
        [
          {
            path: "state",
            kind: "enum",
            message: `must be one of ${JOB_STATES.join(", ")} — a filter nobody can spell is a list nobody can trust`,
          },
        ],
        request.crabbyRequestId,
      );
    const items = jobs
      .all()
      .filter((job) => wanted === undefined || job.state === wanted)
      .map(row);
    const facts = scheduler?.facts();
    // `satisfies` rather than a bare literal: the body is a contract four interfaces read (`JobListBody`), and a route
    // that drifted from it would still typecheck, because `reply.send` accepts anything.
    return reply.send({
      items,
      count: items.length,
      driven: scheduler !== undefined,
      ...(scheduler === undefined ? { note: NOT_DRIVEN } : {}),
      // §4.5's sixth rule is about *telling* the user, and a list is where a user looks: one total here saves C12-01 a
      // request per job, and a job whose overnight occurrences nobody answered for is the row that needs the sentence.
      missedUnacknowledged: items.reduce((total, job) => total + job.missed, 0),
      ...(facts?.nextRunAt === undefined ? {} : { nextRunAt: facts.nextRunAt }),
    } satisfies JobListBody);
  });

  app.get<{ Params: { id: string } }>("/api/v1/jobs/:id", async (request, reply) => {
    const { id } = request.params;
    const job = jobs.get(id);
    if (job === undefined) throw notFound(`job ${id}`, request.crabbyRequestId);
    const lastRun = jobs.lastRun(id);
    return reply.send({
      job: row(job),
      ...(lastRun === undefined ? {} : { lastRun }),
      // The same limit the scheduler's own `get` uses, imported rather than repeated: two numbers for one history is how
      // a pane ends up rendering a list the API called complete.
      runs: jobs.runsFor(id, DEFAULT_RUN_HISTORY),
      // C12-06's subject and W16-08's sheet, on the answer that already carries the history: a user deciding what to do
      // about a backlog should not have to ask twice, and these are the rows `backlog` will acknowledge.
      missedUnacknowledged: jobs.unacknowledgedMissed(id),
      driven: scheduler !== undefined,
      ...(scheduler === undefined ? { note: NOT_DRIVEN } : {}),
    } satisfies JobDetailBody);
  });

  app.patch<{ Params: { id: string }; Body: PatchJobBody | undefined }>(
    "/api/v1/jobs/:id",
    { schema: { body: PatchJobBody } },
    async (request, reply) => {
      if (scheduler === undefined) throw absent(request.crabbyRequestId);
      const body = request.body ?? {};
      const result = scheduler.edit(request.params.id, body);
      if (!result.ok) throw refusal(result, request.crabbyRequestId);
      audit("job edited", result.job.id, request, {
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.schedule === undefined ? {} : { schedule: body.schedule }),
      });
      // `driven: true` on every write answer rather than only on reads, because a client that patched a job is about to
      // tell the user when it fires next — and the row it prints is only a promise if a timer is armed to keep it.
      return reply.send({
        job: row(result.job),
        note: result.note,
        driven: true,
      } satisfies JobActionBody);
    },
  );

  /** One handler for the four verbs. They differ in the act and not in the answer, and the answer is what C12-03 and
   *  C12-04 print: one id in, one refusal mapped by `JOB_REFUSAL_CLASS`, one audit line, one row back with the
   *  scheduler's own sentence beside it. */
  const act = (
    verb: JobVerb,
    request: FastifyRequest<{ Params: { id: string }; Body: JobBacklogBody | undefined }>,
    reply: FastifyReply,
    managed: Scheduler,
  ): FastifyReply => {
    const id = request.params.id;
    const result =
      verb === "pause"
        ? managed.pause(id)
        : verb === "resume"
          ? managed.resume(id)
          : verb === "run"
            ? managed.runNow(id)
            : // No default action. `latest` fires work, so a body that forgot to choose would fire work the user did not
              // ask for — and §4.5's sixth rule is precisely that a backlog must not run without being announced.
              // The schema makes `action` required, so a missing one is a 400 from the validator before this line.
              managed.backlog(id, (request.body as JobBacklogBody | undefined)?.action ?? "latest");
    if (!result.ok) throw refusal(result, request.crabbyRequestId);
    audit(JOB_VERB_LOGGED[verb], result.job.id, request, {
      ...(verb === "backlog"
        ? { action: (request.body as JobBacklogBody | undefined)?.action }
        : {}),
      ...(result.taskId === undefined ? {} : { task: result.taskId }),
      ...(result.acknowledged === undefined ? {} : { acknowledged: result.acknowledged }),
    });
    const payload = {
      job: row(result.job),
      note: result.note,
      driven: true,
      ...(result.run === undefined ? {} : { run: result.run }),
      ...(result.taskId === undefined ? {} : { taskId: result.taskId }),
      ...(result.acknowledged === undefined ? {} : { acknowledged: result.acknowledged }),
      ...(result.openRunTaskId === undefined ? {} : { openRunTaskId: result.openRunTaskId }),
    } satisfies JobActionBody;
    // 201 with a location when the verb created a task, because that is what `POST /api/v1/tasks` answers with and a
    // client that means to follow the run should not have to guess which verb made one: `run` and `backlog --latest` do.
    if (result.taskId !== undefined)
      return reply.code(201).header("location", `/api/v1/tasks/${result.taskId}`).send(payload);
    return reply.send(payload);
  };

  const withScheduler =
    (verb: JobVerb) =>
    (
      request: FastifyRequest<{ Params: { id: string }; Body: JobBacklogBody | undefined }>,
      reply: FastifyReply,
    ): FastifyReply => {
      if (scheduler === undefined) throw absent(request.crabbyRequestId);
      return act(verb, request, reply, scheduler);
    };

  app.post<{ Params: { id: string }; Body: JobBacklogBody | undefined }>(
    "/api/v1/jobs/:id/pause",
    withScheduler("pause"),
  );
  app.post<{ Params: { id: string }; Body: JobBacklogBody | undefined }>(
    "/api/v1/jobs/:id/resume",
    withScheduler("resume"),
  );
  app.post<{ Params: { id: string }; Body: JobBacklogBody | undefined }>(
    "/api/v1/jobs/:id/run",
    withScheduler("run"),
  );
  app.post<{ Params: { id: string }; Body: JobBacklogBody | undefined }>(
    "/api/v1/jobs/:id/backlog",
    { schema: { body: JobBacklogBody } },
    withScheduler("backlog"),
  );
}

// ------------------------------------------------------------------ approvals (§4.3, SECURITY.md §6.3)

/** The two routes §4.3 names for the queue. There is no third one that *creates* an approval, and that absence is the
 *  security model: §6.1 lets an interface "request, display, and relay" and never grant, so the only writer of a
 *  request is the runtime that evaluated the policy. A client asks for an action; whether a prompt exists is what
 *  `packages/policy` computed, not something a route can be talked into.
 *
 *  The service is built here rather than reached for a `packages/storage` query, because the rules and the queue view
 *  belong to one arbiter (D-084): `?state=` reads `approvals.list`, the same function a TUI consults, so a phone
 *  cannot be shown a different set of live prompts than the surface that answers them. */
/** The arbiter's two routes, and the runner beside them.
 *
 *  The runner is a new party here and F-58 is the finding that put it in: §6.3's promise is "answer from anywhere", and
 *  until this slice an answer was *recorded* from anywhere and spent nowhere — the row moved to `approved`, the
 *  `approval.answered` event was appended, the queue emptied, and the run that had parked stayed `awaiting_approval`
 *  forever, because `Runner.resume` had no caller outside tests. D-084's rule that only the loop may open a prompt has as
 *  its corollary that only the loop can spend one, and the loop is the one party a route cannot reach without being handed
 *  it. So it is handed it. Absent means this process composes no runner, and then the answer says that in as many words
 *  rather than reporting a resume that cannot happen. */
function registerApprovalRoutes(
  app: FastifyInstance,
  deps: GatewayDeps,
  bus: ReturnType<typeof createEventBus>,
  approvals: Approvals,
  runner: Runner | undefined,
): void {
  app.get<{ Querystring: Record<string, string> }>("/api/v1/approvals", async (request, reply) => {
    const state = parseApprovalQuery(request.query);
    // D-093: the queue a client reads is the queue that is true. A deadline that passed while nobody was looking expired
    // the row by the clock and not by anybody's opinion, and §6.3's expire-on-timeout default is worth nothing if the
    // stale prompt is still shown as pending — the count on this route is what `crabby status` prints as "N waiting".
    // The sweep is not a timer because a timer needs an interval nobody has decided, and this needs no clock of its own.
    sweepApprovals(deps, approvals, bus);
    const items = approvals.list({ state });
    // `serverTime` is not decoration: §6.3 makes every interface render the countdown, and a countdown measured on a
    // phone whose clock is a minute fast turns a live prompt into an expired one on screen. The Gateway is the party
    // that decides expiry, so it publishes its own clock and a client renders the difference.
    return reply.send({ items, count: items.length, state, serverTime: new Date().toISOString() });
  });

  app.post<{ Params: { id: string }; Body: ApprovalDecisionBody }>(
    "/api/v1/approvals/:id/decision",
    { schema: { body: ApprovalDecisionBody } },
    async (request, reply) => {
      const client = request.crabbyClient;
      if (client === undefined) throw authError("missing", request.crabbyRequestId);
      const body = request.body;
      const route = "POST /api/v1/approvals/:id/decision";
      const key = request.headers["idempotency-key"];
      const hasKey = typeof key === "string" && key.length > 0;
      const hash = requestHash(body);
      // Optional here and required on `POST /tasks`, which is the difference between the two: a lost create response
      // leaves a task nobody asked for, while a lost answer leaves a queue row that already says `approved`. The key
      // is accepted so a phone that retried after a blip reads back its own answer instead of being told it answered
      // twice — and a *different* answer under the same key is the conflict §2 defines.
      if (hasKey && typeof key === "string") {
        const cached = recall(deps.db, key, route, hash);
        if (cached.found && "mismatch" in cached) {
          throw new GatewayError({
            code: "idempotency_conflict",
            message:
              "that `Idempotency-Key` was already used with a different body; a second answer to one approval is a new " +
              "request and not an override (SECURITY.md §6.3)",
            class: "conflict",
            retryable: false,
          });
        }
        if (cached.found && "record" in cached) return reply.send(cached.record.response);
      }

      // Read the row before answering, because a refusal that still moved it (`expired`) has to describe the row it
      // moved, and `ApprovalResult`'s failure arm deliberately carries no record: a caller that could read a record
      // off a refusal would be tempted to treat it as an accepted answer.
      const before = approvals.list().find((row) => row.id === request.params.id);
      const at = Date.now();
      const correlationId = request.crabbyRequestId;
      const outcome = transact(deps.db, () => {
        const result = approvals.answer({
          id: request.params.id,
          decision: body.decision,
          scope: body.scope ?? "once",
          byClientId: client.id,
          via: client.interface,
          at,
        });
        const kind = result.ok ? result.event : result.event;
        if (kind === undefined || before === undefined) {
          return { result, published: undefined as Event | undefined };
        }
        const task = getTask(deps.db, before.request.taskId);
        if (task === undefined) {
          // Unreachable while the foreign key holds, and the throw is still the right answer if it ever becomes
          // reachable: an approval that moved with no task to log against cannot be described in an event, so nothing
          // moves — the transaction rolls the row back with it.
          throw new GatewayError({
            code: "approval_without_task",
            message:
              `approval ${before.id} refers to task ${before.request.taskId}, which is not in the database — a pending ` +
              "approval is deleted with its task (docs/DATA_AND_MEMORY.md §7)",
            class: "internal",
            retryable: false,
          });
        }
        const event: Event = {
          id: newId("evt"),
          schemaVersion: SCHEMA_VERSION,
          type: kind,
          ts: new Date(at).toISOString(),
          sessionId: task.sessionId,
          taskId: task.id,
          seq: 0,
          ...(correlationId === undefined ? {} : { correlationId }),
          payload: {
            // §14's audit fields, and §14's rule that a payload keeps *what was attempted*: the exact target travels
            // with the outcome in plaintext, because an approval whose command was hashed cannot be reviewed a week
            // later (D-065's reasoning, applied to the one record that exists to be read after the fact).
            approvalId: before.id,
            tool: before.request.tool,
            tier: before.request.tier,
            binding: before.request.binding,
            summary: before.request.summary,
            exact: before.request.exact,
            actor: client.id,
            via: client.interface,
            outcome: result.ok ? body.decision : result.code,
            ...(result.ok ? { scope: body.scope ?? "once", state: result.record.state } : {}),
          },
        };
        const appended = appendEvent(deps.db, {
          event,
          scratchDir: taskScratch(deps.layout, task.id),
        });
        return { result, published: { ...event, seq: appended.seq } };
      });

      if (!outcome.result.ok) {
        const refusal = outcome.result;
        throw new GatewayError({
          code: `approval_${refusal.code}`,
          // The arbiter's own sentence, verbatim: it already names the section that refused and the next action, and a
          // route that rephrased it would be a second voice telling a user why they were denied.
          message: refusal.reason,
          class: APPROVAL_REFUSAL_CLASS[refusal.code],
          retryable: false,
          ...(correlationId === undefined ? {} : { requestId: correlationId }),
        });
      }

      // Published after the transaction, never inside it: a stream that learned about an answer a rollback later is a
      // client that has to be told the opposite, and §5.4 has no frame for taking an event back.
      if (outcome.published !== undefined) bus.publish(outcome.published);
      // Woken after the publish and after the commit, and in that order for two reasons. After the commit because
      // `loop.resume` *spends* the decision — a run resumed against a rolled-back row would execute a step nobody
      // approved, which is the exact inversion of D-084. After the publish because a client watching the task should see
      // the answer before it sees the state move, so the move arrives with its reason already on the stream.
      const woken = wakeParkedRun(runner, outcome.result.record, deps.log);
      const response = {
        record: outcome.result.record,
        approvalId: outcome.result.record.id,
        // Two fields rather than one, because "did the run continue" and "what should a user be told" are different
        // answers: `resumed` is a fact a client can branch on (`crabby approval approve` prints the sentence and a TUI
        // modal can close on it), and `note` is the Gateway's own sentence for the three cases where nothing was woken —
        // no runner in this process, no run parked in this process (F-47's restart case), or one already moving. A
        // response that said only `resumed: false` would leave a user who approved on a phone staring at a task that
        // never continued and no way to ask why.
        resumed: woken.resumed,
        note: woken.note,
      };
      if (hasKey && typeof key === "string") {
        remember(deps.db, { key, route, requestHash: hash, response });
      }
      return reply.send(response);
    },
  );
}

/** F-58's fix as one function: an answered prompt wakes the run that parked on it.
 *
 *  Both decisions wake it, and that is the part worth arguing for. `loop.resume` spends an approval *and* a refusal: on
 *  `approve` the gated step runs, and on `deny` the refusal becomes the tool's result, which the model reads and the run
 *  continues or ends on the strength of — §6.3's answer is an input to the run either way. Waking only the approvals would
 *  leave a denied task parked on a question already answered, which is the same defect with the opposite sign, and a user
 *  who denied something on a phone would watch a task hang instead of stop.
 *
 *  What this cannot do, and says rather than hides: a run parked in a *previous* process is not reachable, because
 *  `SuspendedRun` carries the proposed call in memory and SECURITY.md §8.2 keeps `call.args` out of the checkpoint, so
 *  there is nothing to rebuild it from. `Runner.resume` answers that case as `not-parked` with D-065's `re-ask` verdict
 *  beside it, and the note below carries the sentence through to the caller — a process holding no run cannot answer, and
 *  the route that would answer it, and this function is not a substitute for that route. */
function wakeParkedRun(
  runner: Runner | undefined,
  record: ApprovalRecord,
  log: GatewayDeps["log"],
): { resumed: boolean; note: string } {
  const taskId = record.request.taskId;
  if (runner === undefined)
    return {
      resumed: false,
      note:
        `the answer is recorded and this Gateway composed no runner, so no run was woken: task ${taskId} stays ` +
        "`awaiting_approval` until a process that drives tasks reads it (§7.1's recovery marks it `interrupted`)",
    };
  const result = runner.resume(taskId);
  if (!result.ok) {
    log.info("answered approval woke nothing", {
      approval: record.id,
      task: taskId,
      code: result.code,
      reason: result.reason,
    });
    return { resumed: false, note: result.reason };
  }
  // Attached rather than awaited: the caller's answer is the row it just wrote, and the run moves the task on its own
  // clock. A rejection nobody owns would take the Gateway down with it, and a dead Gateway is a worse answer than a
  // failed task — the same rule `recordAndDriveTask` keeps at its own call site.
  void result.run.then(
    (outcome) => log.info("woken run settled", { task: taskId, kind: outcome.kind }),
    (error: unknown) =>
      log.error("woken run rejected", {
        task: taskId,
        reason: error instanceof Error ? error.message : String(error),
      }),
  );
  log.info("answered approval woke the parked run", { approval: record.id, task: taskId });
  return {
    resumed: true,
    note: `task ${taskId} is running again and will spend this ${record.state} — ${
      record.state === "approved"
        ? "the gated step executes once, for that action with those arguments (§6.3)"
        : "the refusal is the step's result, so the run continues or ends on it rather than waiting for an answer " +
          "that has already been given"
    }`,
  };
}

// ------------------------------------------------------------------ events (SSE, §5.1/§5.4)

function registerEventStream(
  app: FastifyInstance,
  deps: GatewayDeps,
  bus: ReturnType<typeof createEventBus>,
): void {
  app.get("/api/v1/events", (request, reply) => {
    const query = (request.query ?? {}) as Record<string, string>;
    const taskId =
      typeof query.taskId === "string" && query.taskId.length > 0 ? query.taskId : undefined;
    const types =
      typeof query.types === "string"
        ? query.types
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        : [];
    const lastEventId = request.headers["last-event-id"];
    const state: StreamState = { closed: false };
    const { write, close } = openStream(reply, state);

    const matches = (event: Event): boolean =>
      (taskId === undefined || event.taskId === taskId) &&
      (types.length === 0 ||
        types.some((wanted) => event.type === wanted || event.type.startsWith(`${wanted}.`)));

    if (taskId !== undefined && typeof lastEventId === "string" && lastEventId.length > 0) {
      const history = readEvents(deps.db, taskId);
      const index = history.findIndex((event) => event.id === lastEventId);
      if (index === -1) {
        write(gapFrame(taskId));
      } else {
        for (const event of history.slice(index + 1)) write(frame(event));
      }
    }

    const unsubscribe = bus.subscribe({
      // The binding §3.1 needs. `requireToken` already resolved the identity for every route including this one, so the
      // only thing missing was a memory of it: without this line a revocation has no handle on a live stream at all,
      // which is what F-51 records about the five slices this promise sat unimplemented through.
      ...(request.crabbyClient === undefined ? {} : { clientId: request.crabbyClient.id }),
      matches,
      write(event) {
        write(frame(event));
      },
      fail() {
        // §5.1: "a stream must never block a task". A subscriber that cannot be written to is dropped and counted,
        // and the client learns about it on reconnect rather than by holding the publisher open.
        state.closed = true;
        unsubscribe();
      },
      close(reason) {
        close(reason);
      },
    });

    state.timer = setInterval(() => {
      if (state.closed) return;
      write(comment("ping"));
    }, HEARTBEAT_MS);
    state.timer.unref?.();

    // The close listener belongs to the *response*, not the request: `request.raw` emits `close` as soon as the
    // request body has been read, which for a GET with no body is immediately — so watching it there would end every
    // stream the moment it opened. `reply.raw` is the socket's own lifecycle, and that is the event a long-lived
    // response has to follow.
    reply.raw.on("close", () => {
      state.closed = true;
      if (state.timer) clearInterval(state.timer);
      unsubscribe();
    });
    return reply;
  });
}

// ------------------------------------------------------------------ helpers

declare module "fastify" {
  interface FastifyRequest {
    crabbyRequestId?: string;
    /** The paired identity the bearer token belongs to, resolved once by `onRequest`. §14 of `SECURITY.md` asks every
     *  audit record for an actor, and an actor reconstructed per route is an actor two routes can disagree about. */
    crabbyClient?: Identity;
  }
}

/** §3.1's "local only", measured on the socket rather than on a header. Two subjects share it — minting a pairing code
 *  and managing the identities a code creates — because both are the same power: the ability to make or unmake a
 *  credential. The code differs, because a client that is told "pairing is local" when it tried to revoke a client is
 *  sent to fix the wrong thing. */
function requireLoopback(request: FastifyRequest, what: "pairing" | "identity management"): void {
  if (!isLoopback(request.ip)) {
    throw new GatewayError({
      code: what === "pairing" ? "pairing_is_local" : "auth_manage_is_local",
      message:
        `${what} happens on the machine the Gateway runs on (` +
        "`docs/INTERFACES_AND_API.md` §3.1), and this request did not",
      class: "auth",
      retryable: false,
    });
  }
}

function requireToken(db: SqliteDb, request: FastifyRequest): Identity {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.toLowerCase().startsWith("bearer "))
    throw authError("missing");
  const identity = authenticate(db, header.slice(7).trim());
  if (!identity) throw authError("invalid");
  return identity;
}

function pairingFailure(reason: string | undefined): string {
  switch (reason) {
    case "expired":
      return "that pairing code aged out (single use, ~120 s); run `crabby auth pair` again for a fresh one";
    case "used":
      return "that pairing code was already redeemed; run `crabby auth pair` again for a fresh one";
    default:
      return "no pairing code matches what you sent; run `crabby auth pair` and use the code on its own line";
  }
}

/** §3.1's "on the machine the Gateway runs on", as three literal addresses rather than the `127.0.0.0/8` range. That is
 *  a decision and not laziness: the Gateway binds `127.0.0.1` and nothing else, so an address inside the range that is
 *  not the bound one can only be reached by a client that went looking for it, and the fail-closed answer to "is this
 *  the machine's own loopback?" costs nothing here while costing a lockout if it is ever wrong. `::1` and
 *  `::ffff:127.0.0.1` are in because a dual-stack listener reports the IPv4 loopback in the mapped form — leaving that
 *  out would refuse the owner's own CLI on the one platform the product runs on. Exported for `wire.test.ts`, because a
 *  test in this process cannot produce a non-loopback socket to refuse. */
export function isLoopback(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function isTaskId(id: string): boolean {
  return new RegExp(TaskId.pattern as string).test(id);
}

/** Query strings arrive as text, so the numbers are converted before the schema sees them and everything else —
 *  unknown keys included — goes through the same §2 validation as a body. No default is invented: the page size is
 *  50 up to a ceiling of 200, which is the number D-079 records. */
function parseListQuery(query: unknown): {
  limit: number;
  cursor?: string;
  state?: TaskState;
  sessionId?: string;
} {
  const raw = (query ?? {}) as Record<string, unknown>;
  // Every key the caller sent goes to the validator, so an unknown `?page=2` is rejected and named (§2) instead of
  // being quietly dropped for being unrecognised. Only `limit` is touched, because a query string has no types and
  // `Type.Integer` would refuse the text "50" that a URL necessarily carries.
  const candidate: Record<string, unknown> = { ...raw };
  for (const [key, value] of Object.entries(candidate)) {
    if (typeof value === "string" && value.length === 0) delete candidate[key];
  }
  if (raw.limit !== undefined) candidate.limit = Number(raw.limit);
  const result = validate(ListQuery, candidate);
  if (!result.ok) throw validationError(result.problems);
  const value = result.value as {
    limit?: number;
    cursor?: string;
    state?: TaskState;
    sessionId?: string;
  };
  return {
    limit: Math.min(Math.max(value.limit ?? 50, 1), 200),
    ...(value.cursor === undefined ? {} : { cursor: value.cursor }),
    ...(value.state === undefined ? {} : { state: value.state }),
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
  };
}

/** `GET /approvals?state=` (§4.3). Validated against the contract's list rather than ignored: a filter that silently
 *  matched nothing turns a typo into an empty queue, and an empty queue on a phone reads as "nothing needs you" — the
 *  one false negative an approval system cannot afford. `pending` is the default because it is the only state a client
 *  can still act on. */
function parseApprovalQuery(query: unknown): ApprovalState {
  const raw = (query ?? {}) as Record<string, unknown>;
  const candidate: Record<string, unknown> = { ...raw };
  for (const [key, value] of Object.entries(candidate)) {
    if (typeof value === "string" && value.length === 0) delete candidate[key];
  }
  const result = validate(ApprovalListQuery, candidate);
  if (!result.ok) {
    throw validationError([
      ...result.problems,
      {
        path: "state",
        message: `must be one of ${APPROVAL_STATES.join(", ")}`,
        kind: "approval-state",
      },
    ]);
  }
  return (result.value as { state?: ApprovalState }).state ?? "pending";
}

function boundAddress(app: FastifyInstance): { host: string; port: number | undefined } {
  const address = app.server.address();
  if (typeof address === "object" && address !== null)
    return { host: address.address, port: address.port };
  return { host: "unbound", port: undefined };
}

function firstLine(error: unknown): string {
  // §6 allows a message and forbids a stack trace or a provider body; the first line is the useful half.
  const text = error instanceof Error ? error.message : String(error);
  return text.split("\n")[0] ?? "the request failed";
}

export { STATUS_BY_CLASS } from "./errors.ts";
