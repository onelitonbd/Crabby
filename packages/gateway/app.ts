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
// `config.json`'s `limits.*` are not wired into the loop either, because `limits.providerAbsoluteMs` and
// `LoopLimits.providerCallMs` are not one budget under two names and half-mapping them would put a number in the run
// that no document promises; the gap is recorded in the slice that composed the runner rather than papered over. And
// there is no `POST /api/v1/tasks/{id}/resume` (F-47): §7.1's recovery marks an interrupted task and sweeps the prompts
// whose deadlines passed, and never resurrects a run, because a recovery that could resume work would be a way past an
// approval.
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
  type Approvals,
  type Cancellation,
  type Checkpoints,
  createApprovals,
  createCancellation,
  createCheckpoints,
  createRecovery,
  createRunner,
  type LoopSubject,
  type Runner,
  type ToolSurface,
} from "@crabby/agent-runtime";
import type { ApprovalState, ToolDeclaration } from "@crabby/api-contracts";
import {
  APPROVAL_STATES,
  ApprovalDecisionBody,
  ApprovalListQuery,
  CancelTaskBody,
  CreateTaskBody,
  type Event,
  errorEnvelope,
  ListQuery,
  newId,
  PairCodeRequestBody,
  PairRequestBody,
  SCHEMA_VERSION,
  TaskId,
  type TaskState,
  validate,
} from "@crabby/api-contracts";
import type { Logger } from "@crabby/core";
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
import type { Provider, ProviderComposition } from "@crabby/providers";
import {
  appendEvent,
  authenticate,
  createSqliteApprovalStore,
  createSqliteCheckpointStore,
  createSqliteJournal,
  createTask,
  getTask,
  type Identity,
  listIdentities,
  listTasks,
  mintPairingCode,
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
  notFound,
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
  // request, and two managers would each hold half of it. `POST /api/v1/tasks/{id}/cancel` requests through it, a runner
  // would pass its `signalFor` to the loop, and the settle writes the evidence the record carries — three parties, one
  // request row. Note what this does *not* need: no provider, no executor and no grants, because stopping work is not
  // the same act as doing it. That is why this route is real in a build where the task handoff is not (F-52).
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
          modelId: deps.drive.modelId,
          ctx: deps.drive.ctx,
          log,
        });
  if (runner === undefined)
    // Logged rather than inferred from an absence: a Gateway that records tasks and drives none answers every caller
    // with `queued`, and the difference between "no provider was configured" and "the runner is broken" is a sentence
    // the startup log can carry and a task record cannot.
    log.info("no runner composed", {
      reason: "POST /api/v1/tasks will record a task and nothing in this process will drive it",
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

  registerSystemRoutes(app, deps, bus, runner);
  registerPolicyRoutes(app, deps, platform);
  registerAuthRoutes(app, deps, bus);
  registerTaskRoutes(app, deps, bus, checkpoints, cancellation, runner);
  registerApprovalRoutes(app, deps, bus, approvals);
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
        "run; what is still absent is a per-task model pin, per-task narrowing and a schedule — F-57's fields, which " +
        "need schema version 5 — and a way to ask for a resume of an interrupted run (F-47)"
      : "the adapter is ready and a runner exists (M2n), but this Gateway composed none, because that takes an " +
        "executor over a configured workspace root and a selected default model together: a task created over HTTP is " +
        "recorded and stays `queued`, and `GET /api/v1/diagnostics` reports `runs.composed` " +
        "(docs/ROADMAP.md §4)",
  };
}

// ------------------------------------------------------------------ system (§4.1)

function registerSystemRoutes(
  app: FastifyInstance,
  deps: GatewayDeps,
  bus: ReturnType<typeof createEventBus>,
  runner: Runner | undefined,
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
      scheduler: { state: "absent", reason: "arrives with M2's runtime" },
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
  /** The process's one runner, or nothing: absent means a task this route creates is recorded and not driven, which is
   *  reported at startup and is a true statement about the install rather than a gap in the route. */
  runner: Runner | undefined,
): void {
  app.post<{ Body: { objective: string; sessionId?: string } }>(
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
      const created = createTask(deps.db, {
        objective: body.objective,
        ...(body.sessionId === undefined ? {} : { sessionId: body.sessionId }),
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
      // `appendEvent` advances `task.last_seq` itself, so the route does not duplicate the bookkeeping: two writers
      // of one counter is how a counter starts lying.
      const appended = appendEvent(deps.db, {
        event,
        scratchDir: taskScratch(deps.layout, created.id),
      });
      const record = getTask(deps.db, created.id) ?? created;
      remember(deps.db, { key, route: "POST /api/v1/tasks", requestHash: hash, response: record });
      bus.publish({ ...event, seq: appended.seq });

      // The handoff. F-52's third question — how `capability_json` becomes `PolicySubject.grants` — is answered here
      // rather than in the runner, because the grants belong to the identity that asked and only this route knows which
      // one that was. `client.capabilities` are the ones D-102 assigned at pairing, and `grantsFor` expands them
      // against the roots this install configured: a run started anywhere else would have to guess its caller, and a
      // guess about authority is the one thing §2's rule 01 cannot absorb.
      if (runner !== undefined) {
        const expansion = grantsFor(client.capabilities, {
          roots: deps.drive?.ctx.paths?.roots ?? [],
        });
        // Withheld rather than dropped, and logged rather than silent: an identity that holds `fs.write` and can write
        // nowhere is a fact an operator should be able to find, instead of having to read a denied tool call backwards
        // and wonder whether the capability or the configuration was missing.
        for (const withheld of expansion.withheld)
          deps.log.info("capability held, no grant emitted", {
            task: created.id,
            capability: withheld.capability,
            reason: withheld.reason,
          });
        const started = runner.start({
          taskId: created.id,
          subject: {
            grants: expansion.grants,
            // The other half of `PolicySubject`, and the reason a narrowed client gets §13's sentence instead of a
            // denial that reads as repairable: what a restriction removed is not discoverable from `grants`, because an
            // absent grant and a removed one are the same absence. The route is the only party that knows which
            // interface the identity was paired for, which is what makes the difference computable at all.
            removedGrants: removedGrantsFor(client.capabilities, client.interface),
            // `ClientInterface` is a subset of policy's `ClientKind` — the same four names — so the kind arrives as the
            // interface that was paired rather than as a guess about the transport. That matters beyond bookkeeping:
            // the kind is what decides whether a T3 prompt may be answered from here at all (D-085).
            clientKind: client.interface satisfies ClientKind,
          } satisfies LoopSubject,
          correlationId: request.crabbyRequestId,
        });
        if (!started.ok)
          // Reachable only while the process is draining: a task this route just created cannot already be in flight or
          // parked, and the journal has been written, so it cannot be missing. The task stays `queued`, which is the
          // truth rather than a shrug — §7.1's recovery marks it `interrupted` on the next start, and the runner's own
          // sentence says so in the log beside this one.
          deps.log.warn("run not started", {
            task: created.id,
            code: started.code,
            reason: started.reason,
          });
        // Not awaited, because the route's answer is the record it just wrote and the run moves the task on its own
        // clock. A handler is attached anyway: a rejection nobody owns takes the Gateway down with it, and a dead
        // Gateway is a worse answer than a failed task — the runner's own rule, kept at its caller too.
        else
          void started.run.then(
            (outcome) => deps.log.info("run settled", { task: created.id, kind: outcome.kind }),
            (error: unknown) =>
              deps.log.error("run rejected", {
                task: created.id,
                reason: error instanceof Error ? error.message : String(error),
              }),
          );
      }
      return reply.code(201).header("location", `/api/v1/tasks/${created.id}`).send(record);
    },
  );

  /** §6.1's request as a route. It delegates whole to the process's one manager, because the manager owns the request
   *  row, the state move, the event and the abort — a route that re-implemented any of them would be a second writer of
   *  one fact (§9).
   *
   *  What this can do today, and what it cannot, stated rather than implied: a task in `queued` or `awaiting_approval`
   *  has nothing in flight, so the manager settles at once and this route answers with a task that is already
   *  `cancelled`, carrying §6.2's evidence on the record (`inFlight: "none"`, `effectsUncertain: false`). A *moving*
   *  task answers `cancelling` and settles when its run stops — which needs the task handoff, and the handoff waits on
   *  F-52's last question: no code turns the identity that asked into a `PolicySubject`, so a run started from a route
   *  would hold no grants and policy would refuse every tool in it.
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

// ------------------------------------------------------------------ approvals (§4.3, SECURITY.md §6.3)

/** The two routes §4.3 names for the queue. There is no third one that *creates* an approval, and that absence is the
 *  security model: §6.1 lets an interface "request, display, and relay" and never grant, so the only writer of a
 *  request is the runtime that evaluated the policy. A client asks for an action; whether a prompt exists is what
 *  `packages/policy` computed, not something a route can be talked into.
 *
 *  The service is built here rather than reached for a `packages/storage` query, because the rules and the queue view
 *  belong to one arbiter (D-084): `?state=` reads `approvals.list`, the same function a TUI consults, so a phone
 *  cannot be shown a different set of live prompts than the surface that answers them. */
function registerApprovalRoutes(
  app: FastifyInstance,
  deps: GatewayDeps,
  bus: ReturnType<typeof createEventBus>,
  approvals: Approvals,
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

      const response = { record: outcome.result.record, approvalId: outcome.result.record.id };
      if (hasKey && typeof key === "string") {
        remember(deps.db, { key, route, requestHash: hash, response });
      }
      // Published after the transaction, never inside it: a stream that learned about an answer a rollback later is a
      // client that has to be told the opposite, and §5.4 has no frame for taking an event back.
      if (outcome.published !== undefined) bus.publish(outcome.published);
      return reply.send(response);
    },
  );
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
