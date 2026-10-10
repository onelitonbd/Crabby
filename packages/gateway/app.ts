// The Gateway: one Fastify instance, every route under `/api/v1` (D-067's versioning-by-path), validation wired to
// the same TypeBox schemas the clients use (D-069's `validatorCompiler` rule — one schema, one validator, no ajv
// dialect beside ours), and errors leaving through §6's envelope with the status mapped by the table in `errors.ts`.
//
// Two things are absent on purpose. There is no policy *enforcement* here: `@crabby/policy` answers "what tier is this
// and who may do it" and `GET /api/v1/tools` publishes that registry, but no route grants anything, because "an
// interface may request, display, and relay; it may never grant" (`SECURITY.md` §6.1) would break at the first attempt
// if a Gateway endpoint could wave a T3 through. The approval queue and its two §4.3 routes are in this build, and
// they only *answer*: nothing here opens a request, and no route drives a task. The party that opens one exists —
// `packages/agent-runtime/loop.ts` calls `policy.evaluate` and hands the result to the arbiter (D-084, D-086) — but it
// has no tools to run, no provider adapter to call and no runner here to start it, so a task created over HTTP is still
// recorded and read back while nothing moves it, and `docs/ROADMAP.md` §4 names the three. Wiring a route to the loop
// against the fake provider would be the demo this phase has refused to ship.
//
// What this file *does* own at startup is §7's recovery, beside D-065's retention prune: `createRecovery` marks every
// non-terminal task `interrupted`, settles a cancellation that was requested before the process died instead of
// resurrecting it, and sweeps the prompts whose deadlines passed while nobody was watching (D-092). The sweep also runs on
// `GET /approvals`, because the count that route returns is the number `crabby status` prints as "N waiting" and a stale
// prompt in it is a lie a user acts on (D-093, F-48). And there is no second listener: §2's loopback default is what
// `listen` is given, and `crabby gateway start` refuses a non-loopback host until pairing has something to protect.

import { type Approvals, createApprovals, createRecovery } from "@crabby/agent-runtime";
import type { ApprovalState, ClientInterface } from "@crabby/api-contracts";
import {
  APPROVAL_STATES,
  ApprovalDecisionBody,
  ApprovalListQuery,
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
import { allToolRecords, CAPABILITIES, registryDigest, TIERS, TOOL_REGISTRY } from "@crabby/policy";
import {
  appendEvent,
  authenticate,
  createSqliteApprovalStore,
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
  GatewayError,
  notFound,
  validationError,
} from "./errors.ts";
import { comment, frame, gapFrame, HEARTBEAT_MS, openStream, type StreamState } from "./sse.ts";

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
}

export interface BuiltApp {
  readonly app: FastifyInstance;
  readonly bus: ReturnType<typeof createEventBus>;
  /** A pairing code minted in the Gateway's own terminal, printed at first run. It is not a route: §3.1 requires
   *  that a code be "generated inside the Gateway's own host/terminal, never accepted from an unauthenticated network
   *  caller", and a bootstrap can hardly require the credential it exists to create. */
  readonly bootstrap?: { code: string; clientId: string; expiresAt: string };
}

const REDEEM_PATH = "/api/v1/auth/pair";
const MINT_PATH = "/api/v1/auth/pair-codes";

export async function buildApp(deps: GatewayDeps): Promise<BuiltApp> {
  const { db, log } = deps;
  const bus = createEventBus();
  const pruned = pruneEvents(db);
  if (pruned.deleted > 0) log.info("event retention pruned rows", { deleted: pruned.deleted });

  // One arbiter for the whole process: the routes answer through it, the read path sweeps through it, and recovery
  // expires through it, because a second instance over the same rows would be a second opinion about the same queue
  // (D-084). It is built here rather than inside the route registration for that reason.
  const approvals = createApprovals({
    store: createSqliteApprovalStore(db),
    newId: () => newId("apr"),
  });

  // §7.1's recovery, at the same place the retention prune runs: a restart is one operation, and both halves are about
  // making the file match the world. Recovery marks every non-terminal task `interrupted`, settles a cancellation that
  // was requested before the process died rather than resurrecting it, expires the prompts whose deadline passed while
  // nobody was watching, and reports — per task — why nothing resumed (D-092). It resumes nothing, and the reason is in
  // the event a user reads rather than in this comment.
  const recovered = createRecovery({
    journal: createSqliteJournal({ db, layout: deps.layout }),
    approvals,
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
      requireLoopback(request);
      requireToken(db, request);
      return;
    }
    // Everything else needs a token, health included: §3.1 says `GET /health` is authenticated "too", and
    // `SECURITY.md` §13 states the rule as "without a valid token, the Gateway must reject every route, including
    // health and SSE". A local caller without credentials therefore gets `401`, which is also the honest answer to
    // "is a Gateway running here?" — it is, and you are not paired to it.
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

  registerSystemRoutes(app, deps, bus);
  registerPolicyRoutes(app, deps);
  registerAuthRoutes(app, deps);
  registerTaskRoutes(app, deps, bus);
  registerApprovalRoutes(app, deps, bus, approvals);
  registerEventStream(app, deps, bus);

  const bootstrap =
    listIdentities(db).length === 0
      ? mintPairingCode(db, { name: "first client", interface: "cli" })
      : undefined;
  return { app, bus, ...(bootstrap ? { bootstrap } : {}) };
}

// ------------------------------------------------------------------ system (§4.1)

function registerSystemRoutes(
  app: FastifyInstance,
  deps: GatewayDeps,
  bus: ReturnType<typeof createEventBus>,
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
      // Three states, because "absent" would be false: the contract, the fake adapter, and the conformance suite are
      // in the build now, and what M2 adds is the registry that selects among real adapters.
      providers: {
        state: "contract-only",
        reason:
          "the §3.1 contract, §3.2 descriptors, and §7 conformance suite are in place; adapters arrive with M2",
      },
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
      streams: { subscribers: bus.subscriberCount },
    });
  });
}

// ------------------------------------------------------------------ policy registry (§8's "List tools + tiers" row)

function registerPolicyRoutes(app: FastifyInstance, deps: GatewayDeps): void {
  app.get("/api/v1/tools", async (_request, reply) => {
    const facts = deps.platformFacts ?? detectProcess();
    const records = allToolRecords(facts);
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
        // comparing 45 lines.
        digest: registryDigest(records),
      },
    });
  });
}

// ------------------------------------------------------------------ auth (§3.1/§3.2)

function registerAuthRoutes(app: FastifyInstance, deps: GatewayDeps): void {
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

  app.post<{ Body: { name: string; interface: ClientInterface } }>(
    MINT_PATH,
    {
      schema: { body: PairCodeRequestBody },
    },
    async (request, reply) => {
      const minted = mintPairingCode(deps.db, {
        name: request.body.name,
        interface: request.body.interface,
      });
      return reply.code(201).send(minted);
    },
  );

  app.get("/api/v1/auth/clients", async (_request, reply) =>
    reply.send({ items: listIdentities(deps.db) }),
  );

  app.delete<{ Params: { id: string } }>("/api/v1/auth/clients/:id", async (request, reply) => {
    const { id } = request.params;
    // Revocation *deletes* the row: `DATA_AND_MEMORY.md` §4's client table has no revocation column, and inventing
    // one in a migration is a schema change the documents have not asked for. The durable record of "this identity
    // was ended on this date" belongs in §14's audit table, which is M2's — O-071 keeps that from being forgotten.
    if (!revoke(deps.db, id)) throw notFound(`client ${id}`);
    // §3.1 also demands that a revoked identity cannot keep acting on an open stream. Streams are not yet tied to
    // identities, so this says so in the log the operator reads rather than implying a control that is not there.
    deps.log.warn("identity revoked; live streams are not yet bound to identities", { id });
    return reply.code(204).send();
  });
}

// ------------------------------------------------------------------ tasks (§4.3)

function registerTaskRoutes(
  app: FastifyInstance,
  deps: GatewayDeps,
  bus: ReturnType<typeof createEventBus>,
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
      return reply.code(201).header("location", `/api/v1/tasks/${created.id}`).send(record);
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
      close() {
        close();
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

function requireLoopback(request: FastifyRequest): void {
  if (!isLoopback(request.ip)) {
    throw new GatewayError({
      code: "pairing_is_local",
      message:
        "pairing codes are minted on the machine the Gateway runs on (`docs/INTERFACES_AND_API.md` §3.1)",
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

function isLoopback(ip: string): boolean {
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
