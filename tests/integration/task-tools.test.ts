// §4.2's three task rows over real HTTP, against a Gateway composed the way `crabby gateway start` composes one: four
// tool surfaces in the runner's one executor, a runner, the scheduler `buildApp` creates beside it, and the two acts this
// file exists to assert are *shared* — `built.driveTask` and `built.cancellation`.
//
// The question a unit test cannot answer is D-105's: a task a model creates has to arrive with the same journal, the same
// idempotency store, the same arbiter and the same policy evaluation as one a client asked for, because the alternative is
// a second creation path with different approval semantics — the defect C12-09 records for jobs, wearing a different noun.
// So what is asserted here is the seam and not the rendering: that the nested task really runs, that a read answers from
// the same rows the routes answer from, that a cancellation asked from inside a run is attributed to the *identity* rather
// than to "a tool call" (§14), that §4.2's second price on `task.cancel` is a control rather than a sentence in a table —
// an undeclared crossing is refused by the executor and a declared one parks at a T2 approval the user has to read — and
// that `all: true` reaches every cancellable task while leaving an `interrupted` one exactly as §7.1's recovery left it.
//
// What is *not* asserted here, and why: the shape of each tool's output (that is `packages/tools/task-tools.test.ts`,
// against sinks a test can tell what to answer), and the manager's own decisions about modes, deduplication and evidence
// (`packages/agent-runtime/cancellation.test.ts`, against an injected clock). This file composes them and asks whether the
// composition is one act.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { CancellationFailureCode } from "@crabby/agent-runtime";
import { createScriptedProvider } from "@crabby/agent-runtime/loop-harness";
import {
  type ClientInterface,
  isTerminal,
  TASK_STATES,
  type TaskRecord,
  type TaskState,
} from "@crabby/api-contracts";
import {
  applyConfigKey,
  type ConfigFile,
  configDocument,
  createLogger,
  loadConfig,
  writeConfig,
} from "@crabby/core";
import { type BuiltApp, buildApp, createClient, type GatewayClient } from "@crabby/gateway";
import { dataLayout, homeDirectory } from "@crabby/platform";
import { capabilitiesFor } from "@crabby/policy";
import { composeProviders, FAKE_TOOL_MODEL_ID, type FakeStep } from "@crabby/providers";
import {
  createTask,
  getSession,
  getTask,
  listSessions,
  migrate,
  mintPairingCode,
  openDatabase,
  patchSession,
  readEvents,
  readReplayWindow,
  redeemPairingCode,
  type SqliteDb,
  sessionRowOf,
  sessionRows,
  setState,
  taskScratch,
  tasksInStates,
} from "@crabby/storage";
import {
  combineToolSurfaces,
  createConfigTools,
  createFileTools,
  createNetTools,
  createSchedulerTools,
  createSessionTools,
  createTaskTools,
  defaultRealpathOf,
  type SchedulerToolOptions,
  TASK_CANCEL_TOOL,
  TASK_CREATE_TOOL,
  TASK_HISTORY_EVENTS,
  TASK_STATUS_TOOL,
  type TaskToolCode,
  type TaskToolOptions,
} from "@crabby/tools";
import { createShellTools, SHELL_RUN_TOOL } from "@crabby/tools/shell";

/** What `task.cancel`'s `all: true` reaches, derived the way `apps/cli/commands/gateway.ts` derives it — the same filter,
 *  restated here because a test that imported the composition root's constant would be asserting a file's spelling rather
 *  than a rule, and the rule is what §4.1's "success is not cancellation, which is not failure, which is incomplete
 *  execution" makes worth breaking. */
const CANCELLABLE_STATES: readonly TaskState[] = TASK_STATES.filter(
  (state) => !isTerminal(state) && state !== "interrupted",
);

interface Harness {
  readonly cli: GatewayClient;
  readonly db: SqliteDb;
  readonly url: string;
  readonly root: string;
  readonly creator: { clientId: string; name: string; token: string };
  readonly runner: BuiltApp["runner"];
  readonly scheduler: BuiltApp["scheduler"];
  /** The task seeded before the listener opened, when the script asked for one. Its id has to exist before the provider's
   *  rounds are written, because a `task.status` call names an id and a script cannot learn one mid-run. */
  readonly seeded: readonly TaskRecord[];
  close(): Promise<void>;
}

interface BootOptions {
  /** One script per provider round. A function when the script has to name a seeded task's id: the rounds are written
   *  after the database exists, which is the only moment an id is knowable. */
  readonly rounds:
    | readonly (readonly FakeStep[])[]
    | ((seeded: readonly TaskRecord[]) => readonly (readonly FakeStep[])[]);
  /** Tasks written straight into the database before the listener opens, so a run has something to read, stop or miss.
   *  Created through `createTask` and never through `POST /api/v1/tasks`, because a task the runner has not been handed is
   *  the only deterministic `queued` there is: one created over HTTP is picked up within milliseconds, and a test that
   *  raced the runner would be asserting a scheduler it does not control. */
  readonly seed?: readonly { objective: string; state?: TaskState }[] | undefined;
  readonly capabilities?: readonly string[] | undefined;
  /** Compose the shell executor (with a spawn that never forks) and grant the identity `shell.run`, so a test can
   *  ask what changes when the install opted in. Absent by default: most boots prove the shell-off composition. */
  readonly withShell?: boolean | undefined;
  /** Compose no runner: no scheduler, no combined surface, and §4.2's three task rows back to pending. */
  readonly noRunner?: boolean | undefined;
}

async function boot(options: BootOptions): Promise<Harness> {
  const dir = mkdtempSync(path.join(tmpdir(), "crabby-task-tools-"));
  const layout = dataLayout(dir);
  // A sibling of the data dir and never inside it: §8's deny-list refuses everything under `dataDir`, and
  // `dataLayout(dir).stateDir` *is* `dir`, so a root at `dir/work` would measure the deny-list instead of the routes.
  const root = mkdtempSync(path.join(tmpdir(), "crabby-task-tools-work-"));
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "notes.md"), "# notes\n", "utf8");

  const handle = openDatabase(path.join(dir, "crabby.sqlite3"));
  migrate(handle.db);
  const paths = { home: homeDirectory(), dataDir: layout.stateDir, roots: [root] };
  const files = createFileTools({ paths, scratchDirFor: (taskId) => taskScratch(layout, taskId) });

  /** The provider's script, filled after `buildApp` returns. Mutable and filled late for a reason that is the shape of
   *  this whole harness: a `task.status` or `task.cancel` call names an id, the seeded tasks have to exist *after* §7.1's
   *  recovery has run (recovery marks every non-terminal task `interrupted`, so a task seeded before `buildApp` is a task
   *  no run can find still queued), and `createScriptedProvider` reads `rounds[index]` at call time — so the array is
   *  handed over empty and written once the ids are knowable. */
  const scripts: (readonly FakeStep[])[] = [];

  // `apps/cli/commands/gateway.ts`'s composition, mirrored rather than approximated: the two parties need each other and
  // one of them has to be a holder, because the runner needs an executor to run with and the acts the executor's sinks
  // reach — `driveTask`, the cancellation manager — are composed *inside* `buildApp` (D-105).
  let scheduleSink: SchedulerToolOptions["schedule"] | undefined;
  const schedulerTools = createSchedulerTools({
    schedule: (input) =>
      scheduleSink === undefined
        ? { ok: false, code: "unavailable", reason: "this process composed no scheduler" }
        : scheduleSink(input),
  });
  let driveSink: TaskToolOptions["create"] | undefined;
  let askCancel: TaskToolOptions["cancel"] | undefined;
  let askCancelAll: TaskToolOptions["cancelAll"] | undefined;
  const unavailable = (what: string): { ok: false; code: TaskToolCode; reason: string } => ({
    ok: false,
    code: "unavailable",
    reason: `this process composed no ${what}`,
  });
  const taskTools = createTaskTools({
    create: (input) => driveSink?.(input) ?? unavailable("task handoff"),
    read: (taskId) => {
      const task = getTask(handle.db, taskId);
      if (task === undefined) return undefined;
      return {
        task,
        sessionId: task.sessionId,
        events: readReplayWindow(handle.db, taskId, TASK_HISTORY_EVENTS),
        eventCount: task.lastSeq,
      };
    },
    cancel: (input) => askCancel?.(input) ?? unavailable("cancellation manager"),
    cancelAll: (input) =>
      askCancelAll?.(input) ?? { results: [unavailable("cancellation manager")] },
  });
  const composed = options.noRunner
    ? undefined
    : combineToolSurfaces([
        files,
        // The shell row, composed exactly where the CLI composes it when the install opted in — and only then. The
        // spawn never forks: a harness that ran real commands would make a red line depend on the device, and the
        // executor's own tests already prove framing against a scripted child (`packages/tools/shell.test.ts`). What
        // this composition proves instead is the seam: the declaration merges into `GET /tools`, the grant reaches
        // the run, and a gated call parks at an approval rather than running or failing.
        ...(options.withShell === true
          ? [
              createShellTools({
                paths,
                scratchDirFor: (taskId: string) => taskScratch(layout, taskId),
                spawn: () => ({
                  stdout: (async function* (): AsyncGenerator<Uint8Array> {})(),
                  stderr: (async function* (): AsyncGenerator<Uint8Array> {})(),
                  waitExit: async () => ({ exitCode: 0, signal: null }),
                  killGroup: () => {},
                }),
              }),
            ]
          : []),
        // The network row, composed exactly where the CLI composes it, with a transport that refuses: no test in this
        // file asks a run to fetch, and a harness that could reach the network would make a red line depend on one. The
        // executor's own tests script `Response` objects instead (`packages/tools/net.test.ts`).
        createNetTools({
          scratchDirFor: (taskId) => taskScratch(layout, taskId),
          fetch: async () => {
            throw new Error("this harness makes no real request");
          },
        }),
        // The two configuration rows, composed where the CLI composes them: the read sink is the same `configDocument`
        // `GET /api/v1/config` answers from, and the write sink owns §2's token rather than asking the model for one
        // (D-099: a declared field is never an authority). They are here so the count below stays a fact about a real
        // install, and so the composition a T3 park happens in is the one `crabby gateway start` makes.
        createConfigTools({
          read: () => configDocument(layout),
          write: ({ key, value }) => {
            const before = loadConfig(layout);
            const written = writeConfig(
              layout,
              applyConfigKey(before.file, key, value) as ConfigFile,
              undefined,
              { token: before.token },
            );
            if (!written.ok)
              return {
                ok: false as const,
                code: written.code ?? ("unwritable" as const),
                reason: written.message,
              };
            const after = loadConfig(layout);
            return {
              ok: true as const,
              token: after.token,
              changed: before.token !== after.token,
              path: layout.configPath,
            };
          },
          limits: loadConfig(layout).limits,
        }),
        schedulerTools,
        // The two surfaces the CLI composes beside these, so that the `GET /api/v1/tools` count below is a fact about a
        // real install rather than about a fixture that happens to omit three tools.
        createSessionTools({
          list: () => sessionRows(handle.db, listSessions(handle.db)),
          rename: ({ id, title }) => {
            const current = getSession(handle.db, id);
            if (current === undefined)
              return { ok: false as const, code: "not-found" as const, reason: `no session ${id}` };
            const patched = patchSession(handle.db, id, {
              title,
              expectedRevision: current.revision,
            });
            if (!patched.ok) return patched;
            return { ok: true as const, session: sessionRowOf(handle.db, patched.session) };
          },
        }),
        taskTools,
      ]);
  const drive =
    composed === undefined
      ? undefined
      : {
          tools: composed,
          provider: createScriptedProvider(scripts),
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
    log: createLogger({ level: "error", write: () => {} }, "task-tools-test"),
    version: "test",
    startedAt: new Date(),
    listenerMode: "local",
    declares: composed === undefined ? files.declares : composed.declares,
    ...(drive === undefined ? {} : { drive }),
  });
  scheduleSink = (input) => {
    const scheduler = built.scheduler;
    return scheduler === undefined
      ? { ok: false as const, code: "unavailable" as const, reason: "no scheduler" }
      : scheduler.schedule(input);
  };
  // D-105's binding, and the whole subject of this file: the same act `POST /api/v1/tasks` and the scheduler's `fire`
  // reach, and the same cancellation manager the cancel route requests through. Nothing here re-implements either.
  driveSink = ({ objective, sessionId, origin }) => {
    const driven = built.driveTask({ objective, sessionId, origin, source: "tool" });
    return {
      ok: true,
      task: driven.task,
      driven: built.runner !== undefined,
      withheld: driven.withheld,
      ...(driven.started === undefined || driven.started.ok
        ? {}
        : { startRefused: { code: driven.started.code, reason: driven.started.reason } }),
    };
  };
  const codeFor = (code: CancellationFailureCode): TaskToolCode =>
    code === "not-found" ? "not-found" : "terminal";
  const request = (input: {
    taskId: string;
    mode?: "finish-step" | "immediate";
    reason?: string;
    origin: { clientId: string; interface: ClientInterface };
  }) => {
    const result = built.cancellation.request({
      taskId: input.taskId,
      ...(input.mode === undefined ? {} : { mode: input.mode }),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      byClientId: input.origin.clientId,
      via: input.origin.interface,
    });
    return result.ok
      ? {
          ok: true as const,
          task: result.task,
          settled: result.settled,
          ...(result.deduplicated === undefined ? {} : { deduplicated: result.deduplicated }),
          ...(result.escalated === undefined ? {} : { escalated: result.escalated }),
        }
      : { ok: false as const, code: codeFor(result.code), reason: result.reason };
  };
  askCancel = (input) => request(input);
  askCancelAll = ({ mode, reason, origin }) => ({
    results: tasksInStates(handle.db, CANCELLABLE_STATES).map((task) =>
      request({
        taskId: task.id,
        ...(mode === undefined ? {} : { mode }),
        ...(reason === undefined ? {} : { reason }),
        origin,
      }),
    ),
  });

  // Seeded here, after recovery and after the sinks are bound, for the reason `scripts` is filled late: §7.1's recovery
  // marks every non-terminal task `interrupted` at startup, so a task written before `buildApp` would be a task no run
  // could find still `queued` — and "still queued" is the fact three of these tests are about.
  const seeded = (options.seed ?? []).map((entry) => {
    const created = createTask(handle.db, { objective: entry.objective });
    if (entry.state !== undefined && entry.state !== "queued")
      setState(handle.db, created.id, entry.state);
    return getTask(handle.db, created.id) ?? created;
  });
  scripts.push(...(typeof options.rounds === "function" ? options.rounds(seeded) : options.rounds));

  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const address = built.app.server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const url = `http://127.0.0.1:${port}`;

  const minted = mintPairingCode(handle.db, {
    name: "the owner",
    interface: "cli",
    // The shell grant is never in a baseline (D-102: §9 withholds it until an explicit act), so a boot that wants
    // the shell says so: the grant list is the opt-in, the same way `crabby init --enable-shell` records it.
    capabilities:
      options.capabilities ??
      (options.withShell === true
        ? [...capabilitiesFor("cli"), "shell.run"]
        : capabilitiesFor("cli")),
  });
  const redeemed = redeemPairingCode(handle.db, minted.code);
  assert.ok(redeemed.ok && redeemed.token, "the harness's identity has to pair");
  const creator = {
    clientId: redeemed.clientId as string,
    name: "the owner",
    token: redeemed.token as string,
  };
  return {
    cli: createClient({ url, token: creator.token }),
    db: handle.db,
    url,
    root,
    creator,
    runner: built.runner,
    scheduler: built.scheduler,
    seeded,
    close: async () => {
      await built.scheduler?.shutdown();
      // D-066's order, and this file needs it more than the others: a decision answered over HTTP now *starts* a run
      // (F-58's fix), so the drain is what keeps a woken run from writing to a database the next line closes. A run parked
      // at a prompt is not in the runner's `running` set, so the two tests that leave one parked do not wait on it.
      await built.runner?.shutdown(5_000);
      await built.app.close();
      handle.close();
    },
  };
}

/** A request through `fetch` rather than the client, for the assertions whose subject *is* the status code: the client
 *  turns a 404 into a thrown `GatewayError`, which is the right behaviour for a command and the wrong one for a test that
 *  wants to read the class off the wire. */
async function raw(
  h: Harness,
  route: string,
  init: { method?: string; body?: unknown; token?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${h.url}${route}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${init.token ?? h.creator.token}`,
      "content-type": "application/json; charset=utf-8",
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text.length === 0 ? null : JSON.parse(text) };
}

/** The `output` a tool call left on the record, found by tool name rather than by step number: which seq a call lands on
 *  depends on how many events the run wrote before it, and a test that hard-coded a number would break on an unrelated
 *  change to the loop's journal. */
function toolOutput(db: SqliteDb, taskId: string, tool: string): string | undefined {
  const events = readEvents(db, taskId, { limit: 10_000 });
  for (const event of events) {
    const payload = event.payload as { tool?: string; output?: string };
    if (
      (event.type === "tool.execution.completed" || event.type === "tool.execution.failed") &&
      payload.tool === tool
    )
      return typeof payload.output === "string" ? payload.output : undefined;
  }
  return undefined;
}

function toolCode(db: SqliteDb, taskId: string, tool: string): string | undefined {
  const events = readEvents(db, taskId, { limit: 10_000 });
  for (const event of events) {
    const payload = event.payload as { tool?: string; code?: string };
    if (event.type === "tool.execution.failed" && payload.tool === tool) return payload.code;
  }
  return undefined;
}

async function untilTerminal(h: Harness, id: string, deadlineMs = 20_000): Promise<TaskRecord> {
  const started = Date.now();
  for (;;) {
    const record = (await h.cli.getTask(id)).body as TaskRecord;
    if (isTerminal(record.state)) return record;
    if (Date.now() - started > deadlineMs)
      assert.fail(
        `task ${id} was still \`${record.state}\` after ${deadlineMs}ms — the events on its record are ` +
          `${
            readEvents(h.db, id, { limit: 10_000 })
              .map((event) => event.type)
              .join(", ") || "none"
          }`,
      );
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A run parked at an approval has stopped moving and stays stopped until somebody answers, so `untilTerminal` would poll
 *  it to its deadline. The two waits ask different questions. */
async function untilState(
  h: Harness,
  id: string,
  wanted: string,
  deadlineMs = 20_000,
): Promise<TaskRecord> {
  const started = Date.now();
  for (;;) {
    const record = (await h.cli.getTask(id)).body as TaskRecord;
    if (record.state === wanted) return record;
    if (isTerminal(record.state))
      assert.fail(
        `task ${id} reached ${record.state} instead of ${wanted} — the events are ` +
          `${
            readEvents(h.db, id, { limit: 10_000 })
              .map((event) => event.type)
              .join(", ") || "none"
          }`,
      );
    if (Date.now() - started > deadlineMs)
      assert.fail(`task ${id} was still \`${record.state}\` after ${deadlineMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Waiting for a fact that is not a state: a cancellation the loop settles on its own clock, or a nested task the runner
 *  has to pick up. Polls the record rather than the events, because the record is what a client reads. */
async function until(
  h: Harness,
  id: string,
  wanted: (record: TaskRecord) => boolean,
  what: string,
  deadlineMs = 20_000,
): Promise<TaskRecord> {
  const started = Date.now();
  for (;;) {
    const record = getTask(h.db, id) as TaskRecord | undefined;
    if (record !== undefined && wanted(record)) return record;
    if (Date.now() - started > deadlineMs)
      assert.fail(
        `task ${id} never satisfied "${what}" — it is \`${record?.state ?? "absent"}\` with ` +
          `${record?.lastSeq ?? 0} event(s)`,
      );
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const harnesses: Harness[] = [];
async function booted(options: BootOptions): Promise<Harness> {
  const harness = await boot(options);
  harnesses.push(harness);
  return harness;
}
after(async () => {
  for (const harness of harnesses.splice(0)) await harness.close();
  // undici's global dispatcher keeps sockets alive past the last assertion, and `node --test` waits for the loop to empty.
  const dispatcher = (globalThis as Record<symbol, unknown>)[
    Symbol.for("undici.globalDispatcher.1")
  ] as { close?: () => Promise<void> } | undefined;
  await dispatcher?.close?.();
});

describe("§4.2's task rows, composed the way a Gateway composes them", () => {
  it("counts the three rows as implemented exactly when a runner exists to run what they create", async () => {
    const driven = await booted({ rounds: [[{ kind: "text", text: "nothing to do" }]] });
    const body = (await driven.cli.tools()).body as {
      runtime: { implemented: number; described: number; pending: number };
      items: { id: string; pendingRecordFields: string[]; riskTier: string }[];
    };
    assert.equal(
      body.runtime.implemented,
      16,
      "seven file rows, `cron.schedule`, the two conversation rows, the three task rows, `net.fetch` and the two " +
        "configuration rows: F-55's count is a fact about an install, and it rose by two because §4.2's `config.get` " +
        "and `config.set` have an executor behind them — the second of which is priced at T3 and parks rather than runs " +
        "on a build with no TUI or Web control UI (D-085)",
    );
    const byName = new Map(body.items.map((row) => [row.id, row]));
    for (const tool of [TASK_CREATE_TOOL, TASK_STATUS_TOOL, TASK_CANCEL_TOOL])
      assert.deepEqual(
        byName.get(tool)?.pendingRecordFields,
        ["outputSchema"],
        `${tool} answers §4.1's four other runtime fields from the executor that runs it, so the row is merged rather ` +
          "than pending — which is F-55's closing condition, per row",
      );
    assert.equal(
      byName.get(TASK_CANCEL_TOOL)?.riskTier,
      "T1",
      "and the tier the registry printed is still §4.2's base price: an executor arriving does not get to reprice a row",
    );

    const idle = await booted({
      noRunner: true,
      rounds: [[{ kind: "text", text: "never called" }]],
    });
    const idleBody = (await idle.cli.tools()).body as {
      runtime: { implemented: number };
      items: { id: string; pendingRecordFields: string[] }[];
    };
    assert.equal(
      idleBody.runtime.implemented,
      7,
      "and on a Gateway that drives nothing the three rows go back to pending with the file executor's seven, because " +
        "§5.1's rule is that hidden is better than failing: a `task.create` nobody would run is worse than no " +
        "`task.create`",
    );
    assert.deepEqual(
      new Map(idleBody.items.map((row) => [row.id, row.pendingRecordFields])).get(TASK_CREATE_TOOL),
      ["inputSchema", "outputSchema", "limits", "idempotent", "sideEffects"],
      "all five fields pending again, because the row is answered by an executor and this Gateway composed none",
    );
  });

  it("creates a task through the Gateway's own act, and the runner really drives it", async () => {
    const h = await booted({
      rounds: [
        // The parent's first step asks for a task; its second ends the run. The nested run consumes a round of its own, and
        // which of the two generates first is the runner's business — so both remaining rounds are text-only endings and
        // the assertions are about records rather than about who said what.
        [
          {
            kind: "tool-call",
            name: TASK_CREATE_TOOL,
            arguments: { objective: "read the notes and say what they are about" },
          },
        ],
        [{ kind: "text", text: "asked for it" }],
        [{ kind: "text", text: "the notes are about gardening" }],
      ],
    });
    const created = await h.cli.createTask({ objective: "the parent question" }, "task-tools-1");
    const parent = created.body as TaskRecord;
    const settled = await untilTerminal(h, parent.id);
    assert.equal(
      settled.state,
      "completed",
      "the parent run finished rather than dying on its own tool call",
    );

    const output = toolOutput(h.db, parent.id, TASK_CREATE_TOOL);
    assert.ok(output, "the tool call left an outcome on the parent's record");
    const match = /created task (tsk_[a-z0-9]+)/.exec(output ?? "");
    assert.ok(match, `the answer names the id it created, and said: ${output}`);
    const nestedId = match?.[1] as string;

    // D-105's whole content, as an assertion: the nested task is a row in the same table, in the same conversation, with a
    // `task.created` event behind it and a run that moved it — not a promise in a tool's output.
    const nestedRecord = getTask(h.db, nestedId) as TaskRecord;
    assert.equal(
      nestedRecord.sessionId,
      parent.sessionId,
      "a sub-step of this question belongs in this conversation, which is the default the executor applies",
    );
    assert.equal(nestedRecord.objective, "read the notes and say what they are about");
    const nestedSettled = await untilTerminal(h, nestedId);
    assert.equal(
      nestedSettled.state,
      "completed",
      "and the runner drove it: a task created by a tool that nobody ran would be the mock this repository refuses",
    );
    const nestedEvents = readEvents(h.db, nestedId, { limit: 10_000 }).map((event) => event.type);
    assert.ok(
      nestedEvents.includes("task.created"),
      `the nested task was journalled like any other — its events are ${nestedEvents.join(", ")}`,
    );
    assert.equal(
      new Set(nestedEvents).has("task.completed"),
      true,
      "one act, so one set of events: the nested task is indistinguishable on the record from one a client created",
    );
    const sessions = sessionRows(h.db, listSessions(h.db));
    assert.equal(
      sessions.length,
      1,
      "and both tasks landed in the one conversation schema version 6 gave a record, rather than in two rows a sidebar " +
        "would render as unrelated work",
    );
  });

  it("reads the record the routes read, and says how much history it did not carry", async () => {
    const h = await booted({
      seed: [{ objective: "a task nobody has driven yet" }],
      rounds: (seeded) => [
        [{ kind: "tool-call", name: TASK_STATUS_TOOL, arguments: { taskId: seeded[0]?.id } }],
        [{ kind: "text", text: "read it" }],
      ],
    });
    const seededTask = h.seeded[0] as TaskRecord;
    const created = await h.cli.createTask({ objective: "the reading question" }, "task-tools-2");
    const parent = created.body as TaskRecord;
    await untilTerminal(h, parent.id);

    const output = toolOutput(h.db, parent.id, TASK_STATUS_TOOL);
    assert.ok(output, "the read left an outcome on the record");
    assert.match(output ?? "", /queued/, "the state the route would answer with");
    assert.match(
      output ?? "",
      /a task nobody has driven yet/,
      "and the objective, which is what an id is a name for",
    );
    assert.match(
      output ?? "",
      /no events recorded yet/,
      "a task written straight into the table has no journal behind it, and the honest answer says so instead of " +
        "printing an empty list a model would read as a run that did nothing",
    );
    assert.match(
      output ?? "",
      new RegExp(seededTask.sessionId),
      "the conversation is in the answer, because it is the fact §4.2's T2 crossing is measured against",
    );
    // The same read, over HTTP, from the party that owns the table: if the tool's answer and the route's answer disagreed
    // about a state, one of the two interfaces would be lying to its reader.
    const routed = (await h.cli.getTask(seededTask.id)).body as TaskRecord;
    assert.equal(routed.state, "queued");
    assert.equal(routed.objective, seededTask.objective);
  });

  it("attributes a cancellation asked from inside a run to the identity, and settles it with §6.2's evidence", async () => {
    const h = await booted({
      seed: [{ objective: "a queued task in the same conversation" }],
      rounds: (seeded) => [
        [
          {
            kind: "tool-call",
            name: TASK_CANCEL_TOOL,
            arguments: { taskId: seeded[0]?.id, reason: "the user asked from inside a run" },
          },
        ],
        [{ kind: "text", text: "stopped it" }],
      ],
    });
    const seededTask = h.seeded[0] as TaskRecord;
    // The same conversation on purpose: the cross-session guard is the next test's subject, and this one is about what a
    // permitted cancellation records.
    const created = await h.cli.createTask(
      { objective: "the cancelling question", sessionId: seededTask.sessionId },
      "task-tools-3",
    );
    const parent = created.body as TaskRecord;
    assert.equal(
      parent.sessionId,
      seededTask.sessionId,
      "the run belongs to the seeded task's conversation",
    );
    await untilTerminal(h, parent.id);

    const stopped = await until(
      h,
      seededTask.id,
      (record) => record.state === "cancelled",
      "the manager settling a task with nothing in flight",
    );
    const cancellation = stopped.cancellation;
    assert.ok(cancellation, "§6.2's evidence is on the record, not only in the log (F-46)");
    assert.equal(
      cancellation?.by,
      h.creator.clientId,
      '§14\'s attribution names the identity whose approval let the run happen — never "a tool call", which is the one ' +
        "answer that would make a cancellation nobody could be asked about",
    );
    assert.equal(cancellation?.reason, "the user asked from inside a run");
    assert.equal(
      cancellation?.mode,
      "finish-step",
      "§6.1's default, since the arguments declared no override",
    );
    assert.equal(
      cancellation?.inFlight,
      "none",
      "a queued task has nothing in flight, and the manager looked",
    );
    assert.equal(
      cancellation?.effectsUncertain,
      false,
      "and so no external effect is uncertain — the distinction §6.2 exists to force, answered rather than guessed",
    );
    assert.equal(
      toolCode(h.db, parent.id, TASK_CANCEL_TOOL),
      undefined,
      "the call succeeded, so no failure code was recorded beside it",
    );
    const output = toolOutput(h.db, parent.id, TASK_CANCEL_TOOL) ?? "";
    assert.match(
      output,
      /is `cancelled`/,
      "and the answer says the stop happened, which it did: the manager settled a task with nothing in flight at once",
    );
    const cancelEvents = readEvents(h.db, seededTask.id, { limit: 10_000 }).filter((event) =>
      event.type.startsWith("task.cancel"),
    );
    assert.ok(
      cancelEvents.length > 0,
      "the request and the settle are events on the cancelled task's own record, so a second client sees them too (§9)",
    );
    const payload = cancelEvents.at(-1)?.payload as { checkpoint?: string };
    assert.ok(
      typeof payload.checkpoint === "string" && payload.checkpoint.length > 0,
      "§6.1's step 5 asks for checkpoint information in the settle, and the manager answers with a sentence rather than " +
        'an absent field — omitting it would read as "there was nothing to save", a claim it is not entitled to make',
    );
  });

  it("refuses an undeclared crossing itself, and parks a declared one at a T2 approval", async () => {
    const h = await booted({
      seed: [{ objective: "a task in somebody else's conversation" }],
      rounds: (seeded) => [
        // One run, two calls: the first is refused by the executor and the second is priced by policy. Both are §4.2's
        // second price on `task.cancel`, seen from the two parties that enforce it.
        [{ kind: "tool-call", name: TASK_CANCEL_TOOL, arguments: { taskId: seeded[0]?.id } }],
        [
          {
            kind: "tool-call",
            name: TASK_CANCEL_TOOL,
            arguments: { taskId: seeded[0]?.id, crossSession: true },
          },
        ],
        [{ kind: "text", text: "never reached: the T2 call parks the run" }],
      ],
    });
    const seededTask = h.seeded[0] as TaskRecord;
    const created = await h.cli.createTask({ objective: "the crossing question" }, "task-tools-4");
    const parent = created.body as TaskRecord;
    assert.notEqual(
      parent.sessionId,
      seededTask.sessionId,
      "the harness's premise: two conversations, so the crossing is real",
    );

    const parked = await untilState(h, parent.id, "awaiting_approval");
    assert.equal(
      parked.state,
      "awaiting_approval",
      "the declared crossing costs an approval the user has to read",
    );

    const refused = toolCode(h.db, parent.id, TASK_CANCEL_TOOL);
    assert.equal(
      refused,
      "cross-session",
      'the undeclared call was refused by the executor with its own code, so a model can tell "declare the argument" ' +
        'from "the manager said no"',
    );
    const stillQueued = getTask(h.db, seededTask.id) as TaskRecord;
    assert.equal(
      stillQueued.state,
      "queued",
      "and the refusal happened before the sink: a request recorded for a task the run had no approved business stopping " +
        "would be §6.1's step 1 spent on nothing",
    );

    const queue = (await h.cli.approvals({ state: "pending" })).body as {
      items: {
        id: string;
        state: string;
        request: { tier: string; tool: string; reason?: string };
      }[];
    };
    const row = queue.items.find((item) => item.request.tool === TASK_CANCEL_TOOL);
    assert.ok(
      row,
      "the second call opened a prompt rather than running: D-084's rule that only the loop can open one",
    );
    assert.equal(
      row?.request.tier,
      "T2",
      "§4.2's second price on `task.cancel`, arrived at from the argument the model declared and read back to the user",
    );
    assert.equal(
      (await raw(h, `/api/v1/tasks/${seededTask.id}`)).status,
      200,
      "and the task the approval is about is still readable while the run waits, so the user can see what they are " +
        "being asked to authorise",
    );
  });

  it("reaches every cancellable task with `all`, and leaves an interrupted one as recovery left it", async () => {
    const h = await booted({
      seed: [
        { objective: "the first queued task" },
        { objective: "the second queued task" },
        { objective: "a task the process died inside", state: "interrupted" },
      ],
      rounds: [
        [
          {
            kind: "tool-call",
            name: TASK_CANCEL_TOOL,
            arguments: { all: true, reason: "the user said stop" },
          },
        ],
        [{ kind: "text", text: "the run's own ending, which `all` may or may not reach first" }],
      ],
    });
    const [first, second, dead] = h.seeded as [TaskRecord, TaskRecord, TaskRecord];
    const created = await h.cli.createTask({ objective: "the stopping question" }, "task-tools-5");
    const parent = created.body as TaskRecord;

    // §4.2 prices `all` at T2, so the run parks before the executor is ever reached — which is the point of the price:
    // "stop everything on this device" is a sentence a user reads and answers, not a step a model spends quietly.
    const parked = await untilState(h, parent.id, "awaiting_approval");
    assert.equal(parked.state, "awaiting_approval");
    const before = (await h.cli.approvals({ state: "pending" })).body as {
      items: {
        id: string;
        request: { tool: string; tier: string; exact: string; whatCouldGoWrong: string };
      }[];
    };
    const prompt = before.items.find((item) => item.request.tool === TASK_CANCEL_TOOL);
    assert.ok(prompt, "the declared `all` opened a prompt (D-084: only the loop can open one)");
    assert.equal(
      prompt?.request.tier,
      "T2",
      "§4.2's second price, read off the argument the model declared",
    );
    assert.ok(
      (prompt?.request.exact ?? "").length > 0,
      "§6.3's exact target reaches the user: a prompt that said only `cancel tasks` would be a consent nobody " +
        "could give",
    );
    for (const task of [first, second, dead])
      assert.equal(
        (getTask(h.db, task.id) as TaskRecord).state,
        task.id === dead.id ? "interrupted" : "queued",
        "and nothing was asked to stop while the prompt was open — the tier is a gate, not a warning printed afterwards",
      );

    // `all` reaches the parent run's own task too, and which of the two settles first is the loop's business — so the
    // assertions are about the three seeded records and not about the parent's ending. That is not a gap: a run that
    // cancels every task cancels itself, and §6's rule is that the manager settles each one on its own evidence.
    // F-58's fix, asserted from the only place it can be: over HTTP, with no `runner.resume` anywhere in this test
    // body. The answer is recorded *and* spent, and the response says which happened, so a client can tell "the run
    // continues" from "nothing was parked in this process to wake".
    const decided = (await h.cli.decideApproval(prompt?.id as string, { decision: "approve" }))
      .body as {
      record: { state: string };
      resumed: boolean;
      note: string;
    };
    assert.equal(decided.record.state, "approved");
    assert.equal(
      decided.resumed,
      true,
      'the run that parked on this prompt is woken by the answer, so §6.3\'s "answer from anywhere" means the work ' +
        "continues and not only that the row moved",
    );
    assert.match(
      decided.note,
      /running again/,
      "and the sentence a phone prints is the Gateway's own rather than the verb's guess about what happened",
    );

    await until(
      h,
      first.id,
      (record) => record.state === "cancelled",
      "`all` reaching the first queued task",
    );
    await until(
      h,
      second.id,
      (record) => record.state === "cancelled",
      "`all` reaching the second queued task",
    );
    const untouched = getTask(h.db, dead.id) as TaskRecord;
    assert.equal(
      untouched.state,
      "interrupted",

      "§7.1's recovery already ended this task and recorded why — the process died — and settling it to `cancelled` " +
        "would rewrite a crash as a choice the user made, which is the one confusion §4.1 forbids",
    );
    assert.equal(
      untouched.cancellation,
      undefined,
      "and no request was recorded against it either, so the record still says what happened to it",
    );
    const firstStopped = getTask(h.db, first.id) as TaskRecord;
    assert.equal(
      firstStopped.cancellation?.by,
      h.creator.clientId,
      "§14's attribution, on every task `all` reached",
    );
    assert.equal(firstStopped.cancellation?.reason, "the user said stop");
    assert.ok(
      parent.id !== first.id,
      "the parent is its own task, so `all` asked at least four — three seeded and the run that asked",
    );
  });

  it("wakes the run on a denial too, and the run ends on the refusal instead of waiting for an answer", async () => {
    const h = await booted({
      seed: [{ objective: "a task in somebody else's conversation" }],
      rounds: (seeded) => [
        // One gated call, then the round the loop drives after the denial is spent: §4.1's `awaiting_approval` →
        // `planning` edge means a denial that leaves other work possible re-plans rather than dies.
        [
          {
            kind: "tool-call",
            name: TASK_CANCEL_TOOL,
            arguments: { taskId: seeded[0]?.id, crossSession: true },
          },
        ],
        [{ kind: "text", text: "then I will leave it alone" }],
      ],
    });
    const seededTask = h.seeded[0] as TaskRecord;
    const created = await h.cli.createTask({ objective: "the denied question" }, "task-tools-7");
    const parent = created.body as TaskRecord;
    await untilState(h, parent.id, "awaiting_approval");
    const queue = (await h.cli.approvals({ state: "pending" })).body as {
      items: { id: string; request: { tool: string; tier: string } }[];
    };
    const prompt = queue.items.find((item) => item.request.tool === TASK_CANCEL_TOOL);
    assert.ok(prompt, "the declared crossing parked the run at a T2 prompt");

    const decided = (await h.cli.decideApproval(prompt?.id as string, { decision: "deny" }))
      .body as {
      record: { state: string };
      resumed: boolean;
      note: string;
    };
    assert.equal(decided.record.state, "denied");
    assert.equal(
      decided.resumed,
      true,
      "a denial wakes the run as well, because `loop.resume` spends both answers: waking only approvals would leave a " +
        "denied task parked on a question already answered, which is the same defect with the opposite sign",
    );
    assert.match(decided.note, /refusal is the step's result/);

    const settled = await untilTerminal(h, parent.id);
    assert.equal(
      settled.state,
      "completed",
      "and the run continued on the refusal rather than hanging: a denied step is an input to the run, not an end of it",
    );
    assert.equal(
      (getTask(h.db, seededTask.id) as TaskRecord).state,
      "queued",
      "the task the user refused to let it stop is untouched, which is the whole content of the refusal",
    );
    const blocked = readEvents(h.db, parent.id, { limit: 10_000 }).filter(
      (event) => event.type === "tool.execution.blocked",
    );
    assert.equal(blocked.length, 1, "the denial is one event on the record, with the reason in it");
    const blockedPayload = blocked[0]?.payload as { reason?: string } | undefined;
    assert.match(
      String(blockedPayload?.reason ?? ""),
      /was denied/,
      "and the reason names the denial and §5's rule that a denial is respected rather than retried into an approval",
    );
  });

  it("answers a task that does not exist from the same table the routes answer from", async () => {
    const h = await booted({
      rounds: [
        [{ kind: "tool-call", name: TASK_STATUS_TOOL, arguments: { taskId: "tsk_neverexisted" } }],
        [{ kind: "text", text: "asked about nothing" }],
      ],
    });
    const created = await h.cli.createTask(
      { objective: "the absent-task question" },
      "task-tools-6",
    );
    const parent = created.body as TaskRecord;
    const settled = await untilTerminal(h, parent.id);
    assert.equal(settled.state, "completed", "a refused tool call is a result, not a failed run");
    assert.equal(
      toolCode(h.db, parent.id, TASK_STATUS_TOOL),
      "not-found",
      "the read the cross-session guard needs is the same read that answers existence, so one absence is one code",
    );
    const routed = await raw(h, "/api/v1/tasks/tsk_neverexisted");
    assert.equal(
      routed.status,
      404,
      "and the route says the same thing about the same id: one derivation of a record, two interfaces reading it (§9)",
    );
  });
});

describe("shell.run off vs on (§4.2, D-066/D-080/D-102)", () => {
  it("reports shell.run as pending (not offered) when the install never opted in", async () => {
    // `GET /tools` lists every registry row — the shell rows included — so absence is the wrong assertion. What
    // shell-off means is that no executor answers §4.1's runtime fields for them: all five pend, the same shape the
    // noRunner count above asserts for the task rows. Not offering the row to the model (the loop's specs come from
    // the composed executor, never from the registry) is §5.1's "hidden is better than failing", stated where a
    // client can read it rather than as a stub that would fail at the act.
    const h = await booted({ rounds: [[{ kind: "text", text: "nothing to do" }]] });
    const body = (await h.cli.tools()).body as {
      items: { id: string; pendingRecordFields: string[] }[];
    };
    const shellRows = body.items.filter((row) => row.id === SHELL_RUN_TOOL);
    assert.equal(shellRows.length, 2, "both §4.2 shell rows are listed, base and elevated");
    for (const row of shellRows)
      assert.deepEqual(
        row.pendingRecordFields,
        ["inputSchema", "outputSchema", "limits", "idempotent", "sideEffects"],
        "all five runtime fields pending: no executor in this composition answers them",
      );
  });

  it("lists shell.run at its base tier once the install opts in, and parks a gated call at T2", async () => {
    const h = await booted({
      withShell: true,
      rounds: [
        // An unknown command is the deterministic T2: not on the read-only list, no destructive pattern, and no
        // filesystem fact the test would have to arrange — the tier comes from the arguments alone.
        [{ kind: "tool-call", name: SHELL_RUN_TOOL, arguments: { argv: ["frobnicate", "--xyz"] } }],
        [{ kind: "text", text: "after the answer" }],
      ],
    });
    const body = (await h.cli.tools()).body as {
      runtime: { implemented: number };
      items: { id: string; pendingRecordFields: string[]; riskTier: string }[];
    };
    assert.equal(
      body.runtime.implemented,
      18,
      "the sixteen this file already counts plus the two §4.2 shell rows — base and elevated share the name " +
        "`shell.run` and the executor's one declaration merges into both records, so the count moves by rows " +
        "rather than by declarations",
    );
    const shellRows = body.items.filter((row) => row.id === SHELL_RUN_TOOL);
    assert.equal(shellRows.length, 2, "both §4.2 shell rows are answered by the one declaration");
    for (const row of shellRows)
      assert.deepEqual(
        row.pendingRecordFields,
        ["outputSchema"],
        "the executor answers §4.1's other four runtime fields, so the rows merge rather than pend (F-55's condition)",
      );
    assert.deepEqual(
      shellRows.map((row) => row.riskTier).sort(),
      ["T2", "T3"],
      "and the tiers printed are still §4.2's own prices — base T2 per command beside elevated T3: an executor " +
        "arriving does not reprice a row",
    );

    const created = await h.cli.createTask(
      { objective: "the shell question" },
      "task-tools-shell-1",
    );
    const parent = created.body as TaskRecord;
    const parked = await untilState(h, parent.id, "awaiting_approval");
    assert.equal(parked.state, "awaiting_approval");
    const queue = (await h.cli.approvals({ state: "pending" })).body as {
      items: { id: string; request: { tool: string; tier: string; exact: string } }[];
    };
    const prompt = queue.items.find((item) => item.request.tool === SHELL_RUN_TOOL);
    assert.ok(prompt, "the gated shell call opened a prompt (D-084: only the loop can open one)");
    assert.equal(prompt?.request.tier, "T2", "§4.2's price for an unclassified command");
    assert.ok(
      (prompt?.request.exact ?? "").length > 0,
      "§6.3's exact target reaches the user: a prompt that said only `run a command` would be a consent nobody " +
        "could give",
    );

    const decided = (await h.cli.decideApproval(prompt?.id as string, { decision: "approve" }))
      .body as { record: { state: string }; resumed: boolean };
    assert.equal(decided.record.state, "approved");
    assert.equal(
      decided.resumed,
      true,
      "the answer wakes the run it parked (F-58's fix holds for shell rows too)",
    );
    const settled = await untilTerminal(h, parent.id);
    assert.equal(
      settled.state,
      "completed",
      "the approved shell step ran against the scripted spawn and the run reached its ending text",
    );
    assert.ok(
      toolOutput(h.db, parent.id, SHELL_RUN_TOOL) !== undefined,
      "the shell step left its framed output on the record",
    );
  });

  it("ends the run on a denied shell call instead of waiting, with the refusal on the record", async () => {
    const h = await booted({
      withShell: true,
      rounds: [
        [{ kind: "tool-call", name: SHELL_RUN_TOOL, arguments: { argv: ["frobnicate", "--xyz"] } }],
        [{ kind: "text", text: "then I will leave it alone" }],
      ],
    });
    const created = await h.cli.createTask(
      { objective: "the refused shell question" },
      "task-tools-shell-2",
    );
    const parent = created.body as TaskRecord;
    await untilState(h, parent.id, "awaiting_approval");
    const queue = (await h.cli.approvals({ state: "pending" })).body as {
      items: { id: string; request: { tool: string } }[];
    };
    const prompt = queue.items.find((item) => item.request.tool === SHELL_RUN_TOOL);
    assert.ok(prompt, "the gated shell call parked the run at a prompt");
    const decided = (await h.cli.decideApproval(prompt?.id as string, { decision: "deny" }))
      .body as { record: { state: string }; resumed: boolean };
    assert.equal(decided.record.state, "denied");
    assert.equal(decided.resumed, true, "a denial wakes the run as well (F-58's other sign)");
    const settled = await untilTerminal(h, parent.id);
    assert.equal(
      settled.state,
      "completed",
      "a denied shell step is an input to the run, not an end of it",
    );
    const blocked = readEvents(h.db, parent.id, { limit: 10_000 }).filter(
      (event) =>
        event.type === "tool.execution.blocked" &&
        (event.payload as { tool?: string })?.tool === SHELL_RUN_TOOL,
    );
    assert.equal(blocked.length, 1, "the denial is one event on the record, naming the shell row");
  });
});
