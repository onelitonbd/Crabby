// `docs/INTERFACES_AND_API.md` §4.3's seven job paths over real HTTP, against a Gateway composed the way
// `crabby gateway start` composes one: an executor, a model, a runner, the scheduler `buildApp` creates beside it, and
// `cron.schedule` combined into the one surface the runner is given.
//
// The questions this file asks are the ones a route can only answer by existing: does a list print the columns §7.1
// promises, does a write answer with the scheduler's own sentence, does `run` hand back a task that really runs, does a
// refusal arrive as the class §4.3 names (404, 409, 400, 501) rather than as a 500, do the read paths keep answering from
// the table on a Gateway that composed nothing to drive them, and does `GET /tools` count `cron.schedule` as implemented
// exactly when a job could fire. The scheduler's *decisions* — what a tick fires, what a restart records, what an
// intersection narrows — are asserted in `packages/agent-runtime/scheduler.test.ts` against an injected clock, because a
// test that had to wait sixty seconds to prove a timer works is a test nobody runs. What is asserted here is the seam: the
// same `fire` a `POST /api/v1/tasks` reaches, so a timer cannot gain an authority its creator never held (§4.5's first and
// fourth rules, kept by composition rather than by a promise).
//
// Jobs are created through `scheduler.schedule` and never through a route, because there is no such route: C12-09 records
// that two creation paths with different approval semantics is how a schedule escapes review, and F-57 records why
// `POST /tasks`'s `schedule` field is absent for the same reason — a route cannot open the T2 approval `cron.schedule` is
// gated behind (D-084). A fixture that invented a `POST /jobs` to make this file shorter would be testing an interface
// this build refuses to have.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { Scheduler } from "@crabby/agent-runtime";
import { createScriptedProvider } from "@crabby/agent-runtime/loop-harness";
import type {
  JobActionBody,
  JobDetailBody,
  JobListBody,
  JobRecord,
  TaskRecord,
} from "@crabby/api-contracts";
import { createLogger } from "@crabby/core";
import { type BuiltApp, buildApp, createClient, type GatewayClient } from "@crabby/gateway";
import { dataLayout, homeDirectory } from "@crabby/platform";
import { capabilitiesFor } from "@crabby/policy";
import { composeProviders, FAKE_TOOL_MODEL_ID, type FakeStep } from "@crabby/providers";
import {
  migrate,
  mintPairingCode,
  openDatabase,
  redeemPairingCode,
  revoke,
  type SqliteDb,
  taskScratch,
} from "@crabby/storage";
import {
  combineToolSurfaces,
  createFileTools,
  createSchedulerTools,
  defaultRealpathOf,
  SCHEDULER_TOOL,
  type SchedulerToolOptions,
} from "@crabby/tools";

interface Harness {
  readonly cli: GatewayClient;
  readonly db: SqliteDb;
  readonly url: string;
  readonly root: string;
  /** The paired identity every job in this file is created under. */
  readonly creator: { clientId: string; name: string; token: string };
  /** A second live identity, so a test can revoke the creator and still ask a question — which is the real scenario: an
   *  operator revokes an old phone from the TUI and then wants to know why the job stopped. */
  readonly second: { clientId: string; name: string; token: string };
  /** Absent exactly when the Gateway composed no runner, which is the rule `buildApp` applies and §4.3 reports. */
  readonly scheduler: BuiltApp["scheduler"];
  readonly jobStore: BuiltApp["jobStore"];
  close(): Promise<void>;
}

interface BootOptions {
  /** One script per provider round: a fired job's task consumes rounds like any other run. */
  readonly rounds: readonly (readonly FakeStep[])[];
  readonly capabilities?: readonly string[] | undefined;
  /** Compose no runner, which means no scheduler, no combined tool surface and no armed timer. */
  readonly noRunner?: boolean | undefined;
}

async function boot(options: BootOptions): Promise<Harness> {
  const dir = mkdtempSync(path.join(tmpdir(), "crabby-jobs-http-"));
  const layout = dataLayout(dir);
  // A sibling of the data dir and never inside it: §8's deny-list refuses everything under `dataDir`, and
  // `dataLayout(dir).stateDir` *is* `dir`, so a root at `dir/work` would put every path in it on the deny-list and the
  // test would measure the deny-list instead of the routes.
  const root = mkdtempSync(path.join(tmpdir(), "crabby-jobs-work-"));
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "notes.md"), "# notes\n", "utf8");

  const handle = openDatabase(path.join(dir, "crabby.sqlite3"));
  migrate(handle.db);
  const paths = { home: homeDirectory(), dataDir: layout.stateDir, roots: [root] };
  const files = createFileTools({ paths, scratchDirFor: (taskId) => taskScratch(layout, taskId) });

  // `apps/cli/commands/gateway.ts`'s composition, mirrored rather than approximated: the two parties need each other and
  // one of them has to be a holder, because the runner needs an executor to run with and the scheduler is composed
  // *inside* `buildApp` — a fired job needs the runner, the journal and the arbiter that `buildApp` owns.
  let scheduleSink: SchedulerToolOptions["schedule"] | undefined;
  const schedulerTools = createSchedulerTools({
    schedule: (input) =>
      scheduleSink === undefined
        ? {
            ok: false,
            code: "unavailable",
            reason: "this process composed no scheduler, so there is nothing to create a job in",
          }
        : scheduleSink(input),
  });
  const composed = options.noRunner ? undefined : combineToolSurfaces([files, schedulerTools]);
  const drive =
    composed === undefined
      ? undefined
      : {
          tools: composed,
          provider: createScriptedProvider(options.rounds),
          modelId: FAKE_TOOL_MODEL_ID,
          ctx: { paths, realpathOf: defaultRealpathOf },
        };

  const built = await buildApp({
    db: handle.db,
    layout,
    providers: composeProviders({
      local: {
        baseUrl: "http://127.0.0.1:8080/v1",
        models: {
          "qwen2.5:3b": {
            contextWindow: 4096,
            maxOutputTokens: 512,
            supports: {
              streaming: true,
              toolCalling: true,
              parallelToolCalls: false,
              systemRole: true,
              structuredOutput: false,
              imageInput: false,
              audioInput: false,
              reasoning: false,
              promptCaching: false,
              jsonSchemaValidation: false,
            },
            cancellation: "best-effort",
            rateLimits: null,
            cost: "local",
            batching: null,
          },
        },
      },
    }),
    log: createLogger({ level: "error", write: () => {} }, "jobs-test"),
    version: "test",
    startedAt: new Date(),
    listenerMode: "local",
    // F-55's merge: the combined surface when a runner exists, so `cron.schedule` is reported as implemented exactly when
    // a job could fire, and the file executor alone when it does not.
    declares: composed === undefined ? files.declares : composed.declares,
    ...(drive === undefined ? {} : { drive }),
  });
  scheduleSink = (input) => {
    const scheduler = built.scheduler;
    return scheduler === undefined
      ? {
          ok: false as const,
          code: "unavailable" as const,
          reason: "this process composed no scheduler, so there is nothing to create a job in",
        }
      : scheduler.schedule(input);
  };

  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const address = built.app.server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const url = `http://127.0.0.1:${port}`;

  const minted = mintPairingCode(handle.db, {
    name: "the owner",
    interface: "cli",
    capabilities: options.capabilities ?? capabilitiesFor("cli"),
  });
  const redeemed = redeemPairingCode(handle.db, minted.code);
  assert.ok(redeemed.ok && redeemed.token, "the harness's identity has to pair");
  const creator = {
    clientId: redeemed.clientId as string,
    name: "the owner",
    token: redeemed.token as string,
  };
  const secondMint = mintPairingCode(handle.db, {
    name: "a second phone",
    interface: "tui",
    capabilities: capabilitiesFor("tui"),
  });
  const secondRedeemed = redeemPairingCode(handle.db, secondMint.code);
  assert.ok(secondRedeemed.ok && secondRedeemed.token, "the second identity has to pair too");
  const second = {
    clientId: secondRedeemed.clientId as string,
    name: "a second phone",
    token: secondRedeemed.token as string,
  };
  return {
    cli: createClient({ url, token: creator.token }),
    db: handle.db,
    url,
    root,
    creator,
    second,
    scheduler: built.scheduler,
    jobStore: built.jobStore,
    async close() {
      // The scheduler's arm before the listener and the database, which is `packages/core/shutdown.ts`'s order restated in
      // a fixture: an arm that fires after the drain began would create a task nobody is going to watch.
      built.scheduler?.shutdown();
      await built.app.close();
      handle.close();
    },
  };
}

/** The scheduler, asserted present. A test in the first `describe` that got a Gateway with no scheduler would be testing
 *  the wrong composition, and saying so loudly is cheaper than a `?.` that turns every assertion into a no-op. */
function schedulerOf(h: Harness): Scheduler {
  assert.ok(h.scheduler !== undefined, "this test needs a Gateway that composed a scheduler");
  return h.scheduler;
}

/** A job created the only way this build allows one to be: through the scheduler's write path, which is what
 *  `cron.schedule` calls from inside an approved run. */
function scheduleJob(
  h: Harness,
  overrides: Partial<Parameters<Scheduler["schedule"]>[0]> = {},
): JobRecord {
  const result = schedulerOf(h).schedule({
    name: "morning summary",
    schedule: "0 7 * * *",
    objective: "summarise what needs an answer",
    sessionId: "ses_1",
    createdBy: { clientId: h.creator.clientId, name: h.creator.name, interface: "cli" },
    capabilities: ["task.create", "file.read"],
    ...overrides,
  });
  assert.ok(result.ok, `the fixture's job must be creatable: ${result.ok ? "" : result.reason}`);
  return result.job;
}

/** The arm is a real timer, `unref`ed so it cannot hold the process open but live all the same. A test that left it
 *  running would be racing a tick it never asked for, so the ones that assert on run rows stop it first — and stopping it
 *  changes nothing about the routes, because a tick is a function the arm happens to call. */
function disarm(h: Harness): void {
  schedulerOf(h).shutdown();
}

/** A raw request, for the two facts `GatewayClient` does not carry: a `201`'s `location` header, and a status the client
 *  would otherwise turn into a thrown envelope. */
async function raw(
  h: Harness,
  route: string,
  init: { method?: string; body?: unknown; token?: string } = {},
): Promise<{ status: number; location: string | null; body: unknown }> {
  const response = await fetch(`${h.url}${route}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${init.token ?? h.creator.token}`,
      "content-type": "application/json; charset=utf-8",
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    location: response.headers.get("location"),
    body: text.length === 0 ? null : JSON.parse(text),
  };
}

interface ErrorEnvelope {
  error: { class: string; code: string; message: string };
}

async function untilTerminal(h: Harness, id: string, deadlineMs = 20_000): Promise<TaskRecord> {
  const started = Date.now();
  for (;;) {
    const record = (await h.cli.getTask(id)).body as TaskRecord;
    if (record.state === "completed" || record.state === "failed") return record;
    if (Date.now() - started > deadlineMs)
      assert.fail(`task ${id} was still \`${record.state}\` after ${deadlineMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("the job routes on a Gateway that drives", () => {
  it("lists §7.1's columns for a job, computed by the party that holds both halves", async () => {
    const h = await boot({ rounds: [[{ kind: "text", text: "nothing to do" }]] });
    try {
      const job = scheduleJob(h);
      disarm(h);
      const body = (await h.cli.jobs()).body as JobListBody;
      assert.equal(body.count, 1);
      assert.equal(
        body.driven,
        true,
        "a Gateway that composed a scheduler says so, because `false` means read-only",
      );
      assert.equal(
        body.note,
        undefined,
        "and the note that explains a `false` is absent when it is true",
      );
      assert.equal(body.missedUnacknowledged, 0);
      assert.equal(
        body.nextRunAt,
        job.nextRunAt,
        "the soonest next fire, which is what a Scheduled pane sorts by",
      );

      const [row] = body.items;
      assert.equal(row?.id, job.id);
      assert.equal(row?.name, "morning summary");
      assert.equal(row?.schedule, "0 7 * * *");
      assert.equal(
        row?.stateWord,
        "active",
        "C12-01's greppable word and W16-02's chip: one derivation for four interfaces rather than four derivations",
      );
      assert.equal(
        row?.lastOutcome,
        undefined,
        "a job that has never run has no last outcome, and the absence is the honest reading of 'never'",
      );
      assert.match(
        row?.nextRunLocal ?? "",
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}[+-]\d{2}:\d{2}$/,
        "D-103's stamp: the wall clock the schedule is evaluated against with the offset beside it, rendered by the " +
          "Gateway because the Gateway is the party that reads the clock",
      );
      assert.equal(
        Date.parse(row?.nextRunAt as string),
        Date.parse(job.nextRunAt as string),
        "and the stamp and the instant are the same moment, which is what a client on another machine relies on",
      );
    } finally {
      await h.close();
    }
  });

  it("filters by state, and refuses a state word that is not in the vocabulary", async () => {
    const h = await boot({ rounds: [[{ kind: "text", text: "nothing to do" }]] });
    try {
      const active = scheduleJob(h, { name: "active one" });
      const paused = scheduleJob(h, { name: "paused one", schedule: "0 8 * * *" });
      schedulerOf(h).pause(paused.id);
      disarm(h);

      const only = (await h.cli.jobs({ state: "paused" })).body as JobListBody;
      assert.deepEqual(
        only.items.map((row) => row.id),
        [paused.id],
        "the filter is applied by the route rather than by a client that fetched everything and picked",
      );
      assert.equal(only.count, 1);
      const both = (await h.cli.jobs()).body as JobListBody;
      assert.deepEqual(both.items.map((row) => row.id).sort(), [active.id, paused.id].sort());
      assert.equal(
        both.items.find((row) => row.id === paused.id)?.stateWord,
        "paused",
        "`paused` wins over every other word, because it describes the job's authority rather than its last run",
      );

      const bad = await raw(h, "/api/v1/jobs?state=running");
      assert.equal(
        bad.status,
        400,
        "a state word outside the vocabulary is a body the caller can fix",
      );
      const envelope = bad.body as ErrorEnvelope;
      assert.equal(envelope.error.class, "validation");
      assert.match(
        envelope.error.message,
        /active/,
        "and the refusal names the words it does accept",
      );
      assert.match(envelope.error.message, /paused/);
    } finally {
      await h.close();
    }
  });

  it("answers one job with its history and its unacknowledged backlog in one request, and 404s an id it does not hold", async () => {
    const h = await boot({ rounds: [[{ kind: "text", text: "nothing to do" }]] });
    try {
      const job = scheduleJob(h);
      disarm(h);
      const body = (await h.cli.job(job.id)).body as JobDetailBody;
      assert.equal(body.job.id, job.id);
      assert.equal(body.driven, true);
      assert.deepEqual(
        body.runs,
        [],
        "no run has happened, and an empty history is an answer rather than an absence",
      );
      assert.equal(body.lastRun, undefined);
      assert.deepEqual(body.missedUnacknowledged, []);

      // Three occurrences recorded as missed the way a restart records them: one row standing for a count, not three rows
      // a phone has to carry (§4.5's sixth rule).
      h.jobStore.insertRun({
        id: "run_backlog1",
        jobId: job.id,
        dueAt: new Date(Date.now() - 3 * 60_000).toISOString(),
        recordedAt: new Date().toISOString(),
        outcome: "missed",
        trigger: "schedule",
        occurrences: 3,
        reason: "three occurrences passed while this process was not running",
      });
      h.jobStore.update(job.id, { missed: 3, updatedAt: new Date().toISOString() });

      const withBacklog = (await h.cli.job(job.id)).body as JobDetailBody;
      assert.equal(withBacklog.missedUnacknowledged.length, 1);
      assert.equal(withBacklog.missedUnacknowledged[0]?.occurrences, 3);
      assert.equal(
        withBacklog.job.lastOutcome,
        "missed",
        "C12-01's last-outcome column reads the last run, and a missed occurrence is a thing that happened",
      );
      assert.equal(withBacklog.job.missed, 3);
      const list = (await h.cli.jobs()).body as JobListBody;
      assert.equal(
        list.missedUnacknowledged,
        3,
        "the list carries the count too, so a user is told before they open a job",
      );

      const missing = await raw(h, "/api/v1/jobs/job_nobody_made");
      assert.equal(missing.status, 404);
      assert.equal((missing.body as ErrorEnvelope).error.class, "not-found");
      assert.match(
        (missing.body as ErrorEnvelope).error.message,
        /job_nobody_made/,
        "a read answers from the store and says which id it could not find; the scheduler's own sentence — the one that " +
          "names `crabby job ls` — belongs to the verbs, and is asserted where a verb refuses",
      );
    } finally {
      await h.close();
    }
  });

  it("edits a name and a schedule, and refuses a body that reaches for what §4.5 calls material", async () => {
    const h = await boot({ rounds: [[{ kind: "text", text: "nothing to do" }]] });
    try {
      const job = scheduleJob(h);
      disarm(h);
      const renamed = (await h.cli.patchJob(job.id, { name: "evening summary" }))
        .body as JobActionBody;
      assert.equal(renamed.job.name, "evening summary");
      assert.equal(renamed.job.schedule, job.schedule);
      assert.equal(renamed.job.objective, job.objective);
      assert.match(
        renamed.note,
        /not editable here/,
        "the answer says what the verb cannot do, so a user learns it from the response rather than from a refusal later",
      );

      const moved = (await h.cli.patchJob(job.id, { schedule: "*/5 * * * *" }))
        .body as JobActionBody;
      assert.equal(moved.job.schedule, "*/5 * * * *");
      assert.match(
        moved.note,
        /[+-]\d{2}:\d{2}/,
        "and the next fire is rendered on the device's wall clock beside the instant, per D-103",
      );

      // The structural guarantee, over HTTP: `objective` is not a field of the body schema, so `additionalProperties:
      // false` turns "change what the job does" into a named refusal quoting §4.5's re-approval rule rather than into a
      // write nobody reviewed.
      const smuggled = await raw(h, `/api/v1/jobs/${job.id}`, {
        method: "PATCH",
        body: { objective: "delete everything under /data" },
      });
      assert.equal(smuggled.status, 400);
      assert.equal((smuggled.body as ErrorEnvelope).error.class, "validation");
      assert.match(
        (smuggled.body as ErrorEnvelope).error.message,
        /objective/i,
        "the refusal names the field it refused, which is how a user learns the field does not exist rather than that they typo'd",
      );
      assert.equal(
        ((await h.cli.job(job.id)).body as JobDetailBody).job.objective,
        "summarise what needs an answer",
        "and nothing was written while the body was being refused",
      );

      const empty = await raw(h, `/api/v1/jobs/${job.id}`, { method: "PATCH", body: {} });
      assert.equal(empty.status, 400, "an edit with nothing in it is not an edit");
      assert.equal((empty.body as ErrorEnvelope).error.code, "job_unfireable");

      const unfireable = await raw(h, `/api/v1/jobs/${job.id}`, {
        method: "PATCH",
        body: { schedule: "0 0 30 2 *" },
      });
      assert.equal(
        unfireable.status,
        400,
        "an expression with no occurrence left is a body the caller can fix, not a fact about the world",
      );
      assert.equal(
        (unfireable.body as ErrorEnvelope).error.code,
        "job_unfireable",
        "and the code is the scheduler's own, prefixed as §6's envelope requires, so a client can branch on it",
      );
    } finally {
      await h.close();
    }
  });

  it("pauses before the next tick, resumes by re-evaluating the grants, and refuses a creator who is gone", async () => {
    const h = await boot({ rounds: [[{ kind: "text", text: "nothing to do" }]] });
    try {
      const job = scheduleJob(h);
      disarm(h);
      const paused = (await h.cli.pauseJob(job.id)).body as JobActionBody;
      assert.equal(paused.job.state, "paused");
      assert.equal(paused.job.stateWord, "paused");
      assert.equal(
        paused.job.nextRunAt,
        undefined,
        "the next fire is cleared rather than ignored: nothing is scheduled while it is paused",
      );
      assert.equal(paused.job.nextRunLocal, undefined);
      assert.match(
        paused.note,
        /before the next tick/,
        "C12-03's sentence, from the party that owns the tick",
      );

      const again = (await h.cli.pauseJob(job.id)).body as JobActionBody;
      assert.match(again.note, /already paused/, "pausing twice is an answer rather than an error");

      // The identity lost a capability while the job was paused, and D-054's rule is that the narrower set wins.
      h.db
        .prepare("UPDATE client_identity SET capability_json = ? WHERE id = ?")
        .run(JSON.stringify(["task.create"]), h.creator.clientId);
      const resumed = (await h.cli.resumeJob(job.id)).body as JobActionBody;
      assert.equal(resumed.job.state, "active");
      assert.deepEqual(
        [...resumed.job.capabilities],
        ["task.create"],
        "a resume re-evaluates the grants rather than trusting the last evaluation, and writes the narrowing to the row",
      );
      assert.match(
        resumed.note,
        /file\.read/,
        "and names what the job lost, because a narrower job is a different job",
      );
      assert.ok(
        resumed.job.nextRunAt !== undefined,
        "resuming projects the schedule again, which pausing cleared",
      );
      assert.match(resumed.job.nextRunLocal ?? "", /[+-]\d{2}:\d{2}$/);

      // O-071: revoking deletes the identity row, and the job survives it so that it can be refused *with a name in the
      // record* rather than vanishing. A cascade here would silently delete standing authority; `SET NULL` would leave a
      // job that runs as nobody.
      assert.equal(revoke(h.db, h.creator.clientId), true);
      schedulerOf(h).pause(job.id);
      // Asked by a *different* live identity, because revoking the creator also revoked the token this harness has been
      // using: a 401 here would be the auth hook doing its job and would tell the test nothing about the job.
      const refused = await raw(h, `/api/v1/jobs/${job.id}/resume`, {
        method: "POST",
        body: {},
        token: h.second.token,
      });
      assert.equal(
        refused.status,
        409,
        "a revocation is a fact about the world rather than a mistake in the body",
      );
      const envelope = refused.body as ErrorEnvelope;
      assert.equal(envelope.error.class, "conflict");
      assert.equal(envelope.error.code, "job_revoked");
      assert.match(
        envelope.error.message,
        /the owner/,
        "§4.5's audit sentence names the person the job ran as",
      );
      assert.match(
        envelope.error.message,
        /re-create the job from a live identity/,
        "and says what to do instead, because a revocation is not undone by a resume",
      );
      // Read with the second identity's token as well: the revoked one now answers 401, which is the auth hook doing its
      // job and not a fact about the job.
      const after = await raw(h, `/api/v1/jobs/${job.id}`, { token: h.second.token });
      assert.equal(
        (after.body as JobDetailBody).job.state,
        "paused",
        "the job stays paused rather than becoming active with no authority behind it",
      );

      const missing = await raw(h, "/api/v1/jobs/job_nobody_made/pause", {
        method: "POST",
        body: {},
        token: h.second.token,
      });
      assert.equal(missing.status, 404);
      assert.equal((missing.body as ErrorEnvelope).error.code, "job_not-found");
      assert.match(
        (missing.body as ErrorEnvelope).error.message,
        /crabby job ls/,
        "a verb answers with the scheduler's own sentence, and that one names the command that would have found the id",
      );
    } finally {
      await h.close();
    }
  });

  it("runs a job now, answers 201 with the task's location, and the task really runs", async () => {
    const h = await boot({
      rounds: [
        [{ kind: "tool-call", name: "file.read", arguments: { path: "notes.md" } }],
        [{ kind: "text", text: "read the notes" }],
        [{ kind: "text", text: "the second run finished" }],
      ],
    });
    try {
      const job = scheduleJob(h);
      disarm(h);
      const before = job.nextRunAt;
      const ran = await raw(h, `/api/v1/jobs/${job.id}/run`, { method: "POST", body: {} });
      assert.equal(ran.status, 201, "a run creates a task, and §4.3 answers a creation with 201");
      const body = ran.body as JobActionBody;
      assert.ok(body.taskId !== undefined, "and names it");
      assert.equal(
        ran.location,
        `/api/v1/tasks/${body.taskId as string}`,
        "the `location` header points at the task, so a client holding only this response can follow it",
      );
      assert.equal(
        body.run?.trigger,
        "run-now",
        "C12-04's trigger, which is what lets an audit trail tell a person from a timer",
      );
      assert.match(
        body.note,
        /fresh policy evaluation/,
        "the answer says what the run is, because that is what the user relies on",
      );
      assert.equal(body.job.nextRunAt, before, "and the schedule is untouched by an explicit run");

      // One run at a time per job, asserted before anything reconciles the first: the run row is open from the moment it
      // is written, so a second ask is refused without a race and without waiting for the task to finish.
      const inFlight = await raw(h, `/api/v1/jobs/${job.id}/run`, { method: "POST", body: {} });
      assert.equal(inFlight.status, 409);
      assert.equal((inFlight.body as ErrorEnvelope).error.code, "job_in-flight");
      assert.match(
        (inFlight.body as ErrorEnvelope).error.message,
        /one run at a time per job/,
        "§4.5's rule, in the words the scheduler used",
      );
      assert.match((inFlight.body as ErrorEnvelope).error.message, /crabby task cancel/);

      // The seam rather than the scheduler's own decisions: a fired job reaches the same runner, the same journal and the
      // same policy evaluation a `POST /api/v1/tasks` reaches, so the task really moves.
      const record = await untilTerminal(h, body.taskId as string);
      assert.equal(
        record.state,
        "completed",
        "the task a timer created is a task, and it ran to its end",
      );
      assert.equal(
        record.objective,
        job.objective,
        "carrying the objective the user approved, word for word",
      );

      // Nothing about the task record says it came from a timer, and that is the point: provenance lives on the run row
      // (`job_run.task_id`) and in the log, because a scheduled run is a task and not a special kind of work. A second
      // shape for a second source is how four interfaces end up rendering two ideas of a task.
      const openDetail = (await h.cli.job(job.id)).body as JobDetailBody;
      assert.equal(
        openDetail.lastRun?.outcome,
        "fired",
        "the run row is open until something reconciles it",
      );
      assert.equal(
        openDetail.lastRun?.taskId,
        body.taskId,
        "and it is the row that ties the task back to the timer",
      );
      assert.equal(openDetail.job.stateWord, "active");

      // The tick is the party that reconciles, and it is the same function the arm calls.
      schedulerOf(h).tick();
      const settled = (await h.cli.job(job.id)).body as JobDetailBody;
      assert.equal(
        settled.lastRun?.outcome,
        "completed",
        "the run takes its task's own outcome, because a scheduled run is a task and not a special kind of work",
      );
      assert.equal(
        settled.job.lastOutcome,
        "completed",
        "and C12-01's last-outcome column reads it",
      );
      assert.ok(
        settled.lastRun?.settledAt !== undefined,
        "a settled run says when it stopped being open",
      );

      // A pause beside an open run is not a cancellation: the answer names the task that keeps going, and the command that
      // would stop it.
      const third = await raw(h, `/api/v1/jobs/${job.id}/run`, { method: "POST", body: {} });
      assert.equal(
        third.status,
        201,
        "with the first run settled, a fresh one is a creation again",
      );
      const pause = (await h.cli.pauseJob(job.id)).body as JobActionBody;
      assert.equal(pause.openRunTaskId, (third.body as JobActionBody).taskId);
      assert.match(
        pause.note,
        /crabby task cancel/,
        "§4.5: a pause is not a cancellation, and the answer says how to make one",
      );
      const stepped = await raw(h, `/api/v1/jobs/${job.id}/run`, { method: "POST", body: {} });
      assert.equal(stepped.status, 409, "a paused job refuses an explicit run");
      assert.equal((stepped.body as ErrorEnvelope).error.code, "job_paused");
      assert.match(
        (stepped.body as ErrorEnvelope).error.message,
        /a pause an explicit verb could step around is a pause with a hole in it/,
      );
    } finally {
      await h.close();
    }
  });

  it("answers a backlog with a record either way: `latest` fires one run, `skip` fires none", async () => {
    const h = await boot({ rounds: [[{ kind: "text", text: "caught up" }]] });
    try {
      const job = scheduleJob(h);
      disarm(h);
      // The rows a restart writes: one row standing for four occurrences (§4.5's sixth rule), which is the state a user is
      // in when they run `crabby job backlog`.
      h.jobStore.insertRun({
        id: "run_missed1",
        jobId: job.id,
        dueAt: new Date(Date.now() - 4 * 60_000).toISOString(),
        recordedAt: new Date().toISOString(),
        outcome: "missed",
        trigger: "schedule",
        occurrences: 4,
        reason: "four occurrences passed while this process was not running",
      });
      h.jobStore.update(job.id, { missed: 4, updatedAt: new Date().toISOString() });

      const noAction = await raw(h, `/api/v1/jobs/${job.id}/backlog`, { method: "POST", body: {} });
      assert.equal(
        noAction.status,
        400,
        "C12-06's two answers are the only two, and the route will not guess between them",
      );
      assert.match(
        (noAction.body as ErrorEnvelope).error.message,
        /action/,
        "the refusal names the field it needs",
      );

      const each = await raw(h, `/api/v1/jobs/${job.id}/backlog`, {
        method: "POST",
        body: { action: "each" },
      });
      assert.equal(
        each.status,
        400,
        "and `each` is refused rather than honoured: four runs for four missed occurrences is the burst §4.5 forbids",
      );

      const latest = await raw(h, `/api/v1/jobs/${job.id}/backlog`, {
        method: "POST",
        body: { action: "latest" },
      });
      assert.equal(latest.status, 201, "one run was created, so the answer is a creation");
      const body = latest.body as JobActionBody;
      assert.equal(latest.location, `/api/v1/tasks/${body.taskId as string}`);
      assert.equal(
        body.acknowledged,
        4,
        "the whole backlog is answered, not just the occurrence that ran",
      );
      assert.equal(
        body.run?.trigger,
        "backlog",
        "the third trigger, so an audit trail can tell a catch-up from a timer and from a person",
      );
      assert.equal(
        body.job.missed,
        0,
        "the counter a list prints is cleared, because the user has now been told",
      );
      assert.match(
        body.note,
        /not fired/,
        "and the note says the rest were recorded rather than fired",
      );

      const detail = (await h.cli.job(job.id)).body as JobDetailBody;
      assert.deepEqual(
        detail.missedUnacknowledged,
        [],
        "nothing is left to answer for, so the sheet W16-08 would open is empty",
      );
      const missed = detail.runs.filter((run) => run.outcome === "missed");
      assert.equal(missed.length, 1, "the row is still there");
      assert.ok(
        missed[0]?.acknowledgedAt !== undefined,
        "with the moment the user answered on it — D-065's rule about not editing the past applies to a timer's history too",
      );
      assert.equal(missed[0]?.occurrences, 4);

      // `skip` with nothing left to skip is an answer rather than a refusal, because a client that asks every morning must
      // not be told it made a mistake.
      const other = scheduleJob(h, { name: "second", schedule: "0 8 * * *" });
      const empty = (await h.cli.jobBacklog(other.id, { action: "skip" })).body as JobActionBody;
      assert.equal(empty.acknowledged, 0);
      assert.equal(empty.taskId, undefined, "`skip` creates nothing");
      assert.match(empty.note, /no backlog to answer for/);

      // And `skip` on a backlog that exists: recorded, acknowledged, and no task at all.
      h.jobStore.insertRun({
        id: "run_missed2",
        jobId: other.id,
        dueAt: new Date(Date.now() - 60_000).toISOString(),
        recordedAt: new Date().toISOString(),
        outcome: "missed",
        trigger: "schedule",
        occurrences: 2,
        reason: "two occurrences passed while this process was not running",
      });
      h.jobStore.update(other.id, { missed: 2, updatedAt: new Date().toISOString() });
      const skipped = (await h.cli.jobBacklog(other.id, { action: "skip" })).body as JobActionBody;
      assert.equal(skipped.acknowledged, 2);
      assert.equal(skipped.taskId, undefined);
      assert.equal(skipped.job.missed, 0);
      assert.match(skipped.note, /none of them fired/);

      const missing = await raw(h, "/api/v1/jobs/job_nobody_made/backlog", {
        method: "POST",
        body: { action: "skip" },
      });
      assert.equal(missing.status, 404);
    } finally {
      await h.close();
    }
  });

  it("counts `cron.schedule` as implemented exactly when a job could fire (F-55)", async () => {
    const h = await boot({ rounds: [[{ kind: "text", text: "nothing to do" }]] });
    try {
      const body = (await h.cli.tools()).body as {
        items: {
          id: string;
          pendingRecordFields: string[];
          idempotent?: boolean;
          sideEffects?: string;
        }[];
        runtime: { implemented: number; described: number; pending: number };
      };
      assert.equal(
        body.runtime.implemented,
        8,
        "seven rows the file executor declares plus `cron.schedule`, which this Gateway can really run",
      );
      assert.equal(
        body.runtime.described,
        0,
        "and `described` stays 0, because no declaration in this build carries an `outputSchema` — the two counts exist to keep that difference visible",
      );
      const cron = body.items.find((item) => item.id === SCHEDULER_TOOL);
      assert.ok(
        cron !== undefined,
        "§4.2's row is answered, so a client can render the tool the user is approving",
      );
      assert.deepEqual(
        cron?.pendingRecordFields,
        ["outputSchema"],
        "the row names the one field nothing answers rather than all five, which is the narrowing F-55's first item is about",
      );
      assert.equal(cron?.idempotent, false);
      assert.equal(cron?.sideEffects, "local");
    } finally {
      await h.close();
    }
  });

  it("reports the scheduler in /status and its facts in /diagnostics, from the composition rather than from a milestone", async () => {
    const h = await boot({ rounds: [[{ kind: "text", text: "nothing to do" }]] });
    try {
      const started = schedulerOf(h).start();
      assert.equal(started.jobs, 0);
      const status = (await h.cli.status()).body as {
        ready: boolean;
        subsystems: Record<string, { state: string; reason?: string }>;
      };
      assert.equal(
        status.subsystems.scheduler?.state,
        "ready",
        "§4.1's scheduler row is ready when a timer is armed — a fact about this process rather than about a milestone",
      );
      assert.equal(
        status.subsystems.scheduler?.reason,
        undefined,
        "and a ready row has nothing to explain",
      );

      const job = scheduleJob(h);
      const diagnostics = (await h.cli.diagnostics()).body as {
        runs: { composed: boolean };
        jobs: {
          composed: boolean;
          rows: number;
          armed: boolean;
          openRuns: number;
          missedUnacknowledged: number;
          nextRunAt?: string;
        };
      };
      assert.equal(diagnostics.runs.composed, true);
      assert.equal(diagnostics.jobs.composed, true);
      assert.equal(diagnostics.jobs.rows, 1);
      assert.equal(
        diagnostics.jobs.armed,
        true,
        "the arm is the fact that distinguishes 'a scheduler exists' from 'a timer is running'",
      );
      assert.equal(diagnostics.jobs.openRuns, 0);
      assert.equal(diagnostics.jobs.missedUnacknowledged, 0);
      assert.equal(
        diagnostics.jobs.nextRunAt,
        job.nextRunAt,
        "the soonest next fire, which is what `crabby status` prints when it says what happens next",
      );
    } finally {
      await h.close();
    }
  });
});

describe("the job routes on a Gateway that composed no runner", () => {
  it("answers reads from the table and refuses writes with 501, naming the half that is missing", async () => {
    const h = await boot({ rounds: [], noRunner: true });
    try {
      // A job row written by a process that *did* drive, read by one that does not: the rows belong to the install rather
      // than to the process, and a list that 501'd would hide them exactly when a provider broke — which is when a paused
      // list matters most.
      h.jobStore.insert({
        id: "job_from_before",
        name: "morning summary",
        schedule: "0 7 * * *",
        objective: "summarise what needs an answer",
        state: "active",
        createdBy: { clientId: "cli_gone", name: "the owner", interface: "cli" },
        capabilities: ["task.create"],
        sessionId: "ses_1",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        nextRunAt: new Date(Date.now() + 60_000).toISOString(),
        missed: 0,
        utcOffsetMinutes: 0,
      });
      assert.equal(
        h.scheduler,
        undefined,
        "no runner means no scheduler, which is the rule `buildApp` applies",
      );

      const list = (await h.cli.jobs()).body as JobListBody;
      assert.equal(list.count, 1, "the rows are still there");
      assert.equal(
        list.driven,
        false,
        "and the answer says plainly that this process drives none of them, rather than leaving a caller to discover it at the next fire",
      );
      assert.match(list.note ?? "", /composed no runner/, "the note explains the `false`");
      assert.equal(
        list.nextRunAt,
        undefined,
        "with no timer armed there is no soonest fire to promise",
      );
      assert.match(
        list.items[0]?.nextRunLocal ?? "",
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}[+-]\d{2}:\d{2}$/,
        "and the stamp is still rendered, because it is a rendering of the instant on the row rather than a promise from " +
          "a timer: D-103 puts the wall clock beside every next fire, and a read-only Gateway that dropped it would send " +
          "a user to a UTC instant to work out when their job was supposed to run",
      );

      const detail = (await h.cli.job("job_from_before")).body as JobDetailBody;
      assert.equal(detail.job.id, "job_from_before");
      assert.equal(detail.driven, false);
      assert.match(detail.note ?? "", /composed no runner/);

      for (const route of [
        "/api/v1/jobs/job_from_before/pause",
        "/api/v1/jobs/job_from_before/resume",
        "/api/v1/jobs/job_from_before/run",
      ]) {
        const refused = await raw(h, route, { method: "POST", body: {} });
        assert.equal(refused.status, 501, `${route} must answer 501 rather than pretend`);
        const envelope = refused.body as ErrorEnvelope;
        assert.equal(envelope.error.class, "platform-unsupported");
        assert.equal(envelope.error.code, "scheduler_absent");
        assert.match(
          envelope.error.message,
          /composed no runner/,
          "and the refusal names the missing half, which is the difference between 'this build has no scheduler' and " +
            "'this process could not compose one'",
        );
        assert.match(
          envelope.error.message,
          /still answers from the table/,
          "plus what still works, so a client does not conclude the read paths are absent too",
        );
      }
      const backlog = await raw(h, "/api/v1/jobs/job_from_before/backlog", {
        method: "POST",
        body: { action: "skip" },
      });
      assert.equal(
        backlog.status,
        501,
        "a backlog answer is a write, and a write needs the party that owns the schedule",
      );
      const patch = await raw(h, "/api/v1/jobs/job_from_before", {
        method: "PATCH",
        body: { name: "renamed" },
      });
      assert.equal(patch.status, 501, "so is an edit");

      const status = (await h.cli.status()).body as {
        subsystems: Record<string, { state: string; reason?: string }>;
      };
      assert.equal(status.subsystems.scheduler?.state, "absent");
      const diagnostics = (await h.cli.diagnostics()).body as {
        jobs: { composed: boolean; rows: number; armed: boolean };
      };
      assert.deepEqual(
        {
          composed: diagnostics.jobs.composed,
          rows: diagnostics.jobs.rows,
          armed: diagnostics.jobs.armed,
        },
        { composed: false, rows: 1, armed: false },
        "the rows exist and nothing is armed — two facts an operator needs, kept apart",
      );

      // §5.1's "hidden is better than failing", applied to a subsystem — and the hiding happens in the *runtime fields*,
      // not in the row. §4.2's registry is a document of what the product will do, so `cron.schedule` is listed here as it
      // is everywhere; what this process cannot do is answer for it, and F-20 is the finding about confusing two copies of
      // one list. A model in this Gateway is therefore offered the file executor's tools and no timer.
      const tools = (await h.cli.tools()).body as {
        items: { id: string; pendingRecordFields: string[]; idempotent?: boolean }[];
        runtime: { implemented: number };
      };
      assert.equal(
        tools.runtime.implemented,
        7,
        "F-55's count falls back to the file executor's seven",
      );
      const cron = tools.items.find((item) => item.id === SCHEDULER_TOOL);
      assert.ok(
        cron !== undefined,
        "§4.2's row is still listed, because the registry is not a statement about this process",
      );
      assert.equal(
        cron?.idempotent,
        undefined,
        "and it carries none of §4.1's runtime fields, because no executor in this process declares it",
      );
      assert.equal(
        cron?.pendingRecordFields.length,
        5,
        "all five are pending here, where the same row names one in a Gateway that composes a runner",
      );
    } finally {
      await h.close();
    }
  });
});

// Sockets opened by `fetch` outlive the tests that opened them, and an open handle keeps `node --test` alive after its
// last assertion has passed.
after(() => {
  const global = (globalThis as unknown as Record<symbol, { close?: () => Promise<void> }>)[
    Symbol.for("undici.globalDispatcher.1")
  ];
  if (global !== undefined && typeof global.close === "function") void global.close();
});
