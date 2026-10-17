// `crabby gateway start|status` — the lifecycle verbs §7.1's Gateway row names. `start` is foreground on purpose: a
// supervised daemon, plus `stop`/`restart`, belong with the runtime that has something to supervise, and backgrounding
// a process the CLI cannot find again afterwards is a half-truth that costs a week in M2. What this build does honor
// is D-066: Ctrl-C drains the live streams and closes the listener within 5 s.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { type CancellationFailureCode, loopLimitsOf } from "@crabby/agent-runtime";
import {
  type ClientInterface,
  EXIT,
  type ExitCode,
  isTerminal,
  TASK_STATES,
  type TaskState,
} from "@crabby/api-contracts";
import {
  applyConfigKey,
  type ConfigFile,
  configDocument,
  createLogger,
  createShutdown,
  egressHosts,
  LIMITS_DEFAULTS,
  type LogLevel,
  loadConfig,
  writeConfig,
} from "@crabby/core";
import {
  buildApp,
  clearGatewayInfo,
  type GatewayInfo,
  readGatewayInfo,
  writeGatewayInfo,
} from "@crabby/gateway";
import { type DataLayout, homeDirectory } from "@crabby/platform";
import { composeProviders, selectDefaultModel } from "@crabby/providers";
import {
  createMemoryStore,
  DB_FILE_NAME,
  getSession,
  getTask,
  listSessions,
  migrate,
  openDatabase,
  patchSession,
  readReplayWindow,
  schemaVersion,
  sessionRowOf,
  sessionRows,
  taskScratch,
  tasksInStates,
} from "@crabby/storage";
import {
  combineToolSurfaces,
  createConfigTools,
  createFileTools,
  createHttpTools,
  createMemoryTools,
  createNetTools,
  createSchedulerTools,
  createSessionTools,
  createTaskTools,
  defaultRealpathOf,
  SCHEDULER_TOOL,
  type SchedulerToolOptions,
  SESSION_LIST_TOOL,
  SESSION_RENAME_TOOL,
  TASK_CANCEL_TOOL,
  TASK_CREATE_TOOL,
  TASK_HISTORY_EVENTS,
  TASK_STATUS_TOOL,
  type TaskToolCode,
  type TaskToolOptions,
} from "@crabby/tools";
import { createShellTools } from "@crabby/tools/shell";
import { parseTail, unknownFlagMessage } from "../args.ts";
import type { Renderer } from "../output.ts";
import { findCommand } from "../registry.ts";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

/** What `task.cancel`'s `all: true` reaches, derived from the contract's own two lists rather than retyped. `interrupted`
 *  is excluded on purpose and the exclusion is a decision, not an oversight: §7.1's recovery already ended that task and
 *  recorded *why* (the process died), and settling it to `cancelled` would rewrite a crash as a choice the user made —
 *  which is the one thing §4.1's "success is not cancellation, which is not failure, which is incomplete execution"
 *  forbids confusing. The three terminal states are excluded because the manager refuses them anyway, and filtering here
 *  keeps the answer's count honest: every task `all` reports is one it actually asked. */
const CANCELLABLE_STATES: readonly TaskState[] = TASK_STATES.filter(
  (state) => !isTerminal(state) && state !== "interrupted",
);

/** The refusal both cancellation sinks give before `buildApp` has returned the manager. Unreachable in a Gateway that
 *  declared the tools — see `taskTools` above — and reachable in a composition test, where hanging would be the worse
 *  answer. */
const NO_CANCELLATION =
  "this process composed no cancellation manager, so there is nothing to ask: `task.cancel` is declared only inside a " +
  "Gateway, because §6.1's request row, state move and event are the manager's to write";

export type GatewayVerb = "start" | "status";

export async function runGateway(
  verb: GatewayVerb | undefined,
  argv: readonly string[],
  layout: DataLayout,
  renderer: Renderer,
  logLevel: LogLevel | undefined,
): Promise<ExitCode> {
  if (verb === "start") return runStart(argv, layout, renderer, logLevel);
  if (verb === "status") return runStatus(layout, renderer);
  renderer.line("gateway", "which verb? `crabby gateway start` or `crabby gateway status`");
  return EXIT.usage;
}

async function runStart(
  argv: readonly string[],
  layout: DataLayout,
  renderer: Renderer,
  logLevel: LogLevel | undefined,
): Promise<ExitCode> {
  const spec = findCommand("gateway", "start");
  const tail = parseTail(argv, spec);
  if (tail.unknown.length > 0) {
    renderer.line("unknown flag(s)", tail.unknown.join(" "));
    renderer.fix(unknownFlagMessage(tail.unknown, spec));
    return EXIT.usage;
  }
  const host = tail.values.host ?? "127.0.0.1";
  if (!LOOPBACK.has(host)) {
    // `SECURITY.md` §13: "LAN exposure (non-loopback bind) … keep them out of the initial release unless requested,
    // and never offer them implicitly." A refusal with the reason is that sentence implemented.
    renderer.line("bind refused", `this build listens on loopback only, not ${host}`);
    renderer.fix("reach it from another device through an SSH tunnel to 127.0.0.1 on this one");
    return EXIT.usage;
  }
  const port = parsePort(tail.values.port);
  if (port === undefined) {
    renderer.line("bad --port", `"${tail.values.port ?? ""}" is not a port number`);
    renderer.fix(
      "example: crabby gateway start --port 8130 (leaving it out lets the OS choose a free one)",
    );
    return EXIT.usage;
  }
  // §5's setup steps left "who creates the state dir" open, and this was the visible cost: opening the database on a
  // directory that does not exist died with better-sqlite3's own error rather than with an answer a person can act
  // on. `crabby init` is the one command allowed to create files (init.ts's header), so a state dir that is not
  // there means init has not run — and this says so and names the command, rather than leaking a driver's message.
  if (!existsSync(layout.stateDir)) {
    renderer.line("no state dir", `${layout.stateDir} does not exist, so there is nothing to open`);
    renderer.fix("`crabby init` creates it (and the vault) before the Gateway is started");
    return EXIT.failure;
  }

  const log = createLogger({ ...(logLevel === undefined ? {} : { level: logLevel }) }, "gateway");
  const loaded = loadConfig(layout);
  const dbFile = path.join(layout.stateDir, DB_FILE_NAME);
  // D-074 makes `limits.sqliteBusyTimeoutMs` the override for the busy timeout, and `openDatabase` reads it out of
  // `options.limits` — so until this line the composition root opened the database without the loaded config and that
  // one key changed nothing except the screen that printed it. The loop's eight keys now reach it the same way,
  // translated once by `loopLimitsOf` on the runner below; what still has no consumer is `queuedTasksBeforeRefusal`
  // and `concurrentProviderRequests` (neither a queue nor a pool to configure exists in this build) and
  // `extensionAdapterOverheadMs` (M4's host reads it when one exists). The three provider timings go to
  // `composeProviders` two lines down.
  const handle = openDatabase(dbFile, { limits: loaded.limits });
  const migration = migrate(handle.db);
  // §3.3's other configuration path — "Configured through `crabby provider add` **or configuration**" — composed here
  // rather than inside the Gateway, because the party that starts the process is also the party that can print a
  // refusal and its fix once, at startup, instead of leaving it to a route to explain later.
  const providers = composeProviders(loaded.config.provider, loaded.limits);
  /** §4.1's other half — the executor's declarations, so `GET /api/v1/tools` can answer the five fields
   *  `PENDING_RECORD_FIELDS` names from the party that executes them instead of printing them as pending (F-55, D-098).
   *  Composed here rather than inside the Gateway for the reason the providers are: the party that starts the process is
   *  also the party that can print a refusal and its fix once, at startup, instead of leaving a route to explain later.
   *  No configured roots means no executor, and that is a decision rather than a gap: `WorkspaceConfig`'s own rule is that
   *  a root invented by a default "would be a path the agent may write to that the user never chose", and §8's deny-list is
   *  measured against `PathContext.home` and `dataDir` with those roots as the inside. An install that has chosen no
   *  workspace therefore describes its tools as pending and says so on the screen that started it, which is a truer answer
   *  than an executor whose every write would be refused anyway. */
  const roots = loaded.config.workspace?.roots ?? [];
  const executor =
    roots.length === 0
      ? undefined
      : createFileTools({
          paths: { home: homeDirectory(), dataDir: layout.stateDir, roots },
          // D-064's over-cap output and §8's trash-or-rename land in the task's scratch directory, and
          // `packages/storage/scratch.ts` owns that layout — so the executor is handed the rule rather than deriving it.
          scratchDirFor: (taskId) => taskScratch(layout, taskId),
          limits: loaded.limits,
        });
  /** §9's opt-in, read strictly: only `enabled: true` opts in, and anything else — absent, `false`, or a
   *  non-boolean the schema already refused — is off. Enabling additionally takes configured workspace roots (below):
   *  a command needs a root to be confined to (§8's cwd rule), so `true` with no roots still composes nothing, and the
   *  banner says which half is missing rather than leaving a row to explain it later. */
  const shellEnabled = loaded.config.shell?.enabled === true;
  const shellTools =
    shellEnabled && roots.length > 0
      ? createShellTools({
          paths: { home: homeDirectory(), dataDir: layout.stateDir, roots },
          // The same scratch layout and the same symlink resolver the file executor is handed: a policy that resolved
          // a link and an executor that did not would let the link decide a containment question between them.
          scratchDirFor: (taskId) => taskScratch(layout, taskId),
          realpathOf: defaultRealpathOf,
          // D-074's `shell.run` class deadline, read from `limits` so the declaration and the clock the loop enforces
          // are one number rather than two opinions about how long a command may run.
          limits: loaded.limits,
        })
      : undefined;
  /** The workspace-bound executors, composed whether or not anything drives them: `GET /api/v1/tools` answers §4.1's
   *  runtime fields for the file rows from the file executor alone when no runner exists, and the shell executor joins
   *  that half for the same reason — both are confined to the configured roots (§8), and neither is a way to create a
   *  timer nothing would fire, which is the row the combination below withholds. A duplicate id across the two stays
   *  fatal at startup (§4.1), because two executors answering one call would leave the outcome to whichever promise
   *  settled. */
  const workspaceTools =
    executor === undefined
      ? undefined
      : shellTools === undefined
        ? executor
        : combineToolSurfaces([executor, shellTools]);
  /** §3.6's selection, resolved here rather than inside the Gateway for the reason the providers and the executor are:
   *  the party that starts the process is the party that can print a refusal and its fix once, at startup, instead of
   *  leaving it to a route to explain later. It moved above `buildApp` when the runner arrived, because the runner needs
   *  the answer; the banner still prints it below, beside what refused (D-101). */
  const selected = selectDefaultModel(providers, loaded.config.defaultModel);
  /** The handoff's ingredients, bundled because they are all-or-nothing: `buildApp` composes the runner only when every
   *  one of them exists, and a Gateway with an executor but no model would be a Gateway that accepts a task and then
   *  fails it at the first provider call, which is a worse answer than refusing to drive at all. Absent means
   *  `POST /api/v1/tasks` records a task and nothing moves it, and the `tasks` line below says so in as many words. */
  /** `cron.schedule`'s sink, bound after `buildApp` returns, because the two parties need each other and one of them has
   *  to be a holder: the runner needs an executor to run with, and the scheduler is composed *inside* `buildApp` because a
   *  fired job needs the runner, the journal and the arbiter it composes. The refusal below is unreachable in a Gateway
   *  that declared the tool at all — the surface is composed only when a runner is, and a runner means a scheduler — and
   *  reachable in a test that composes the tools on their own, which is the case it exists to answer rather than hang. */
  let scheduleSink: SchedulerToolOptions["schedule"] | undefined;
  const schedulerTools = createSchedulerTools({
    schedule: (input) =>
      scheduleSink === undefined
        ? {
            ok: false,
            code: "unavailable",
            reason:
              "this process composed no scheduler, so there is nothing to create a job in: a job is a task that runs " +
              "later, and `cron.schedule` is declared only beside a runner that can run it",
          }
        : scheduleSink(input),
    limits: loaded.limits,
  });
  /** §4.2's two conversation rows, composed beside the scheduler's. Unlike `cron.schedule` these need no late binding:
   *  they read and write the session table, which this process opened before `buildApp` and which exists whether or not a
   *  runner does. The revision comparison lives in the sink rather than in the tool's schema, because a token a model could
   *  choose is a token a model could reuse — §2's concurrency rule is about two interfaces, and the executor's job is to
   *  read the row it is about to write. */
  const sessionTools = createSessionTools({
    list: (origin) =>
      sessionRows(
        handle.db,
        listSessions(handle.db, {
          ...(origin === undefined ? {} : { origin: origin as ClientInterface }),
        }),
      ),
    rename: ({ id, title }) => {
      const current = getSession(handle.db, id);
      if (current === undefined)
        return {
          ok: false as const,
          code: "not-found" as const,
          reason: `no session ${id} — \`${SESSION_LIST_TOOL}\` prints the conversations this install holds`,
        };
      const patched = patchSession(handle.db, id, {
        title,
        expectedRevision: current.revision,
      });
      if (!patched.ok) return patched;
      return { ok: true as const, session: sessionRowOf(handle.db, patched.session) };
    },
    limits: loaded.limits,
  });
  /** §4.2's three task rows. Two of their sinks are late-bound holders for the reason `scheduleSink` is one: the acts
   *  they reach are composed *inside* `buildApp` — the runner, the journal, the arbiter and the process's one
   *  cancellation manager — while the runner needs its executor *before* `buildApp` can run. So the executor is built
   *  first against holders and the holders are filled from `built` below, which is D-105's whole content: one act, reached
   *  by three callers, rather than a second creation path in the tool package. The refusals are unreachable in a Gateway
   *  that declared these tools at all — the surface is composed only when a runner is — and reachable in a test that
   *  composes them on their own, which is the case they exist to answer rather than hang. */
  let driveSink: TaskToolOptions["create"] | undefined;
  let askCancel: TaskToolOptions["cancel"] | undefined;
  let askCancelAll: TaskToolOptions["cancelAll"] | undefined;
  const taskTools = createTaskTools({
    create: (input) =>
      driveSink === undefined
        ? {
            ok: false,
            code: "unavailable",
            reason:
              "this process composed no task handoff, so there is nothing to create a task in: `task.create` is " +
              "declared only beside a runner that can run what it creates",
          }
        : driveSink(input),
    /** The one sink that needs no holder: `getTask` and `readReplayWindow` are the two reads `GET /api/v1/tasks/{id}`
     *  answers with, over the database this process opened before `buildApp`. Reading them here rather than through the
     *  Gateway's own route keeps §9's rule — one derivation of a record — without making a tool call an HTTP client of
     *  the process it is running inside. */
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
    cancel: (input) =>
      askCancel === undefined
        ? { ok: false, code: "unavailable", reason: NO_CANCELLATION }
        : askCancel(input),
    cancelAll: (input) =>
      askCancelAll === undefined
        ? { results: [{ ok: false, code: "unavailable", reason: NO_CANCELLATION }] }
        : askCancelAll(input),
    limits: loaded.limits,
  });
  /** §4.2's `net.fetch`, the one row in this composition whose subject is not this device. It needs no late binding and
   *  no workspace root: the two judgements it makes are about a URL and a byte count, and both are its own. What it does
   *  need is the scratch directory, because D-064's over-cap output goes there exactly as the file tools' does, and
   *  §5.2's class deadline from `config.json` so the declaration and the clock the loop enforces are one number. The
   *  allow-list is deliberately *not* passed: `escalation.ts` reads it out of `EvalContext` below, and a second copy in
   *  the executor would be a second opinion about which hosts are cheap (D-106). */
  const netTools = createNetTools({
    scratchDirFor: (taskId) => taskScratch(layout, taskId),
    limits: loaded.limits,
  });
  /** §4.2's `http.request` row, composed beside `net.fetch` for the reason the two rows are two rows: the same grant
   *  (`net.egress`) and the same destination judgements, but `idempotent: false` and **T2 with no T1** — a mutating
   *  request cannot share a tier or a resume permission with a read. It takes `limits.netFetchTimeoutMs` like its
   *  sibling (§5.2 prices the network class as one row) and the same scratch directory, because D-064's over-cap
   *  response body goes where every other capped output goes. */
  const httpTools = createHttpTools({
    scratchDirFor: (taskId) => taskScratch(layout, taskId),
    limits: loaded.limits,
  });
  /** §4.2's two configuration rows. Both sinks read the file at call time rather than the copy this process loaded at
   *  startup, because a settings answer that described yesterday's document would be a wrong answer with a confident shape
   *  — and the token beside it would be a token for bytes that no longer exist. The write sink owns §2's
   *  read-modify-write and the token that goes with it, which is D-099's rule about a declared field: a token the model
   *  could choose would be a write aimed at a document nobody read. What the write does *not* do is change this running
   *  process, and the tool says so in its answer rather than letting a switch look like it took effect. */
  /** §4.2's three memory rows, over the same database every route reads. The mode is D-073's kill switch as the
   *  composition read it — `off` unless the document says otherwise — and it is read here rather than inside the tool
   *  so that a mode change is a restart fact like every other configuration change, not a per-call opinion. */
  const memoryTools = createMemoryTools({
    store: createMemoryStore(handle.db),
    mode: loaded.config.memory?.autoMemory ?? "off",
  });
  const configTools = createConfigTools({
    read: () => configDocument(layout),
    write: ({ key, value }) => {
      const before = loadConfig(layout);
      const written = writeConfig(
        layout,
        applyConfigKey(before.file, key, value) as ConfigFile,
        undefined,
        {
          token: before.token,
        },
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
    limits: loaded.limits,
  });
  /** The one executor the runner is given, which is a *combination* rather than the file tools alone: §4.1 registers a
   *  tool by name across the whole composition and `combineToolSurfaces` makes a duplicate fatal at startup instead of
   *  last-one-wins. Composed only when a runner will exist, for the reason `createSchedulerTools`'s own header gives —
   *  §5.1's "hidden is better than failing" applied to a subsystem: a Gateway that drives no tasks must not advertise a
   *  way to create a timer nothing would ever fire, because the row it creates would read as "soon" forever. */
  const composed =
    workspaceTools === undefined || !selected.ok
      ? undefined
      : combineToolSurfaces([
          workspaceTools,
          netTools,
          httpTools,
          memoryTools,
          configTools,
          schedulerTools,
          sessionTools,
          taskTools,
        ]);
  // Both halves of the condition are named again here, for the reason the banner below names them: `composed` is built
  // from `selected`, so "there is an executor" and "a model was selected" are the same fact seen from two places, and
  // TypeScript narrows the second only from a test that mentions it.
  const drive =
    composed === undefined || !selected.ok
      ? undefined
      : {
          tools: composed,
          provider: selected.provider,
          modelId: selected.modelId,
          // §8's resolver, and the *same* one the executor defaults to: a policy that resolved a symlink and an
          // executor that did not would let the link decide a containment question between them, which is the defect the
          // twenty-first slice took out of `checkPath` from the other side.
          ctx: {
            paths: { home: homeDirectory(), dataDir: layout.stateDir, roots },
            realpathOf: defaultRealpathOf,
            /** §4.3's escalation by destination, wired at last: `EvalContext.egressAllowList` existed before any
             *  composition filled it, so every host arrived at the same price and §4.2's "**T1** only for a
             *  user-curated allow-list" had no way to happen. The set is `net.allowList` from `config.json` (D-106),
             *  normalized once by `egressHosts` because `escalation.ts` compares against a lowercased hostname. An empty
             *  set is not a refusal and not a hole: it is the state §4.3 describes, where every destination is a new
             *  host and is priced T2 with that host named in the prompt. */
            egressAllowList: egressHosts(loaded.config),
          },
          /** §5.2's override path, translated once: `loopLimitsOf` maps the eight `limits.*` keys the loop enforces
           *  onto its own field names, so a user who raised `limits.providerAbsoluteMs` in `config.json` gets the
           *  longer clock in the run that follows and not just in the banner that printed it. Absent keys stay absent
           *  rather than arriving as `undefined`, because the loop merges this over its defaults with a spread. */
          limits: loopLimitsOf(loaded.config.limits),
        };
  const startedAt = new Date();
  // D-067: the client the Gateway serves at `/web` ships beside this code. Its absence is not an error — a Gateway
  // composed without the directory simply has no web surface, and `/web/*` answers like any other unauthenticated
  // path (the guard's 401), which is the honest answer rather than a broken page.
  const webRoot = path.resolve(new URL("../../../apps/web", import.meta.url).pathname);
  const built = await buildApp({
    ...(existsSync(webRoot) ? { webRoot } : {}),
    db: handle.db,
    layout,
    log,
    version: readVersion(),
    startedAt,
    listenerMode: "local",
    providers,
    // D-115's context section, handed to the Gateway rather than read there (the same rule `drive` follows):
    // this command is the composition root, and a Gateway that loaded its own configuration could not be
    // tested against a second one. Absent when the file has none, which is exactly the defaults.
    context: loaded.config.limits?.context,
    // The declarations `GET /api/v1/tools` merges §4.1's runtime fields from: the combined surface when a runner exists,
    // so `cron.schedule` is reported as implemented exactly when a job could fire, and the workspace executors alone
    // when it does not — a count that rose on a Gateway that drives nothing would be F-55's number lying.
    ...(composed === undefined
      ? workspaceTools === undefined
        ? {}
        : { declares: workspaceTools.declares }
      : { declares: composed.declares }),
    ...(drive === undefined ? {} : { drive }),
  });

  try {
    await built.app.listen({ host, port });
  } catch (error) {
    renderer.line("listen failed", error instanceof Error ? error.message : String(error));
    renderer.fix(
      port === 0
        ? "no ephemeral port was available — this is odd, rerun with --port"
        : `crabby gateway start --port 0 picks a free port for you`,
    );
    handle.close();
    return EXIT.failure;
  }
  const bound = built.app.server.address();
  const boundPort = typeof bound === "object" && bound !== null ? bound.port : port;
  const url = `http://${host}:${boundPort}`;
  const info: GatewayInfo = {
    host,
    port: boundPort,
    pid: process.pid,
    startedAt: startedAt.toISOString(),
    version: readVersion(),
  };
  writeGatewayInfo(layout, info);

  renderer.line("gateway", `${url} (pid ${process.pid})`);
  renderer.line(
    "storage",
    `${dbFile} at schema v${schemaVersion(handle.db)}${
      migration.applied.length > 0 ? `, applied ${migration.applied.join(", ")}` : ""
    }`,
  );
  for (const problem of loaded.problems)
    renderer.line("config", `${problem.path || "<root>"} ${problem.message}`);
  if (loaded.problems.length > 0)
    renderer.fix(
      "`crabby doctor` prints the fix for each one; the keys that are valid still apply",
    );
  for (const entry of providers) {
    if (!entry.ok) {
      renderer.line("provider refused", `${entry.id}: ${entry.reason}`);
      continue;
    }
    renderer.line("provider", `${entry.id}: ${entry.modelIds.join(", ")}`);
    // §3.3's warning is a warning: the user chose a LAN endpoint on plain HTTP and the answer is to show it on the
    // screen that started the process, not to refuse the configuration (D-100).
    for (const warning of entry.warnings) renderer.fix(warning);
  }
  if (providers.length === 0) {
    renderer.line("provider", "none configured");
    renderer.fix(
      "`crabby config set provider.local.baseUrl http://127.0.0.1:8080/v1` plus a `models` entry — an endpoint that " +
        "needs no key composes today, and one that does waits for the vault (M5, F-56)",
    );
  }
  renderer.line(
    "default model",
    selected.ok
      ? `${selected.providerId}/${selected.modelId}`
      : `not selected — ${selected.reason}`,
  );
  // Printed because it is the difference between a Gateway that can describe its tools and one that can only classify
  // them, and `GET /api/v1/tools` answers it too — this line just answers it once, at startup, where a user can act on it.
  if (workspaceTools === undefined) {
    renderer.line(
      "tools",
      "no executor composed: no workspace roots are configured, so every row reports §4.1's runtime fields as pending",
    );
    renderer.fix(
      "`crabby init` creates a workspace and records the root it created, or " +
        "`crabby config set workspace.roots '[\"/path/to/work\"]'` names one; until then no tool has an executor (F-55)",
    );
  } else {
    renderer.line(
      "tools",
      `${workspaceTools.declarations().length} declared by ${
        shellTools === undefined ? "the file executor" : "the file and shell executors"
      } over ${roots.length} root(s)` +
        (composed === undefined
          ? ", and nothing else: a Gateway that drives no tasks declares no way to create a timer, no way to read a " +
            "conversation and no way to act on a task, because all of them belong to the runner's one surface (§5.1)"
          : `, plus ${SCHEDULER_TOOL} from the scheduler it drives jobs through — the only path that creates one, ` +
            "because a route or a verb that made a job would be a creation path with no approval in it (C12-09) — " +
            `${SESSION_LIST_TOOL} and ${SESSION_RENAME_TOOL} for the conversations schema version 6 gave a record, and ` +
            `${TASK_CREATE_TOOL}, ${TASK_STATUS_TOOL} and ${TASK_CANCEL_TOOL}, whose sinks are the Gateway's own task act ` +
            "and its one cancellation manager rather than a second copy of either (D-105)"),
    );
    renderer.line(
      "tools",
      "the rows nothing implements still name their runtime fields as pending (F-55)",
    );
  }
  // Printed beside `tools` because it is the same question for a different row: whether a `shell.run` call has an
  // executor behind it, and if not, which half is missing — the opt-in (§9, `docs/ROADMAP.md` §4) or a root to be
  // confined to (§8). `GET /api/v1/tools` answers the counts; this line answers it once, at startup, where a user
  // can act on it.
  if (!shellEnabled) {
    renderer.line(
      "shell",
      "not composed: `shell.run` is off by default (§4.2), so no command runs through it",
    );
    renderer.fix(
      "`crabby init --enable-shell` opts in on a fresh install, `crabby config set shell.enabled true` after",
    );
  } else if (shellTools === undefined) {
    renderer.line(
      "shell",
      "opted in but not composed: no workspace root is configured, so `shell.run` has no root to run in",
    );
    renderer.fix(
      "`crabby config set workspace.roots '[\"/path/to/work\"]'` names one; a command needs a root to be confined " +
        "to (§8)",
    );
  } else {
    renderer.line(
      "shell",
      `${shellTools.declarations().length} declared by the shell executor over ${roots.length} root(s), ` +
        "base T2 per command with §4.3's escalation deciding what needs a human",
    );
  }
  // Both halves of the condition are named because TypeScript cannot infer one from the other, and neither can a
  // reader: `drive` is built from `selected`, so "there is a runner" and "a model was selected" are the same fact seen
  // from two places, and writing it twice is what keeps the line below from printing a model that does not exist.
  if (drive !== undefined && selected.ok) {
    renderer.line(
      "tasks",
      `driven: a task created over HTTP is handed to the runner, whose grants are expanded from the identity that ` +
        `asked it (§6.1, D-102) — ${selected.providerId}/${selected.modelId} over ${roots.length} root(s)`,
    );
    renderer.fix(
      "`crabby task run` with an objective creates a task and follows it to its end; a run that parks at an approval " +
        "waits there for `crabby approval approve <id>`, and `limits.*` does not reach the loop yet",
    );
  } else {
    renderer.line(
      "tasks",
      "recorded, not driven: the runner is composed only when an executor and a selected model both exist, and " +
        (executor === undefined && !selected.ok
          ? "neither does here — no workspace root is configured and no default model is selected"
          : executor === undefined
            ? "no workspace root is configured"
            : "no default model is selected"),
    );
    renderer.fix(
      "`POST /api/v1/tasks` still answers 201 and the task stays `queued`, which is the truth rather than a shrug: " +
        "§7.1's recovery marks it `interrupted` on the next start",
    );
  }
  // Started here rather than inside `buildApp`, and the reason is the timer: `start()` arms one, and a composition that
  // armed it on behalf of every caller would hang every test that builds an app (`node --test` waits for the event loop
  // to empty). Whoever owns the process's exit path owns the arm, and that is this command.
  if (built.scheduler === undefined) {
    renderer.line(
      "scheduler",
      "not composed: a job is a task that runs later, and this process drives no tasks, so no timer is armed",
    );
    renderer.fix(
      "`GET /api/v1/jobs` still answers from the table with `driven:false` beside the rows, and `crabby job ls` reads it",
    );
  } else {
    const managed = built.scheduler;
    // Bound before `start()`, not after: the first tick can fire 250 ms later, and a fire that found no sink would be a
    // job that ran and created nothing — the one failure §4.5's sixth rule exists to prevent.
    scheduleSink = (input) => managed.schedule(input);
    const startup = managed.start();
    renderer.line(
      "scheduler",
      `${startup.active} active job(s), ${startup.paused} paused` +
        `, next fire ${startup.nextRunAt ?? "none scheduled"}` +
        (startup.reconciled > 0
          ? `, ${startup.reconciled} run(s) the previous process left open are now closed against the state §7.1 gave them`
          : ""),
    );
    // §4.5's sixth rule, printed rather than logged: after an overnight kill the occurrences that passed are recorded as
    // `missed` rows and *not* fired, and the rule's whole content is that the user is told. A line per job, with the verb
    // that answers it, is the telling — and the answer is recorded either way (C12-06).
    for (const missed of startup.missed) {
      renderer.line(
        "missed runs",
        `${missed.name} (${missed.jobId}): ${missed.occurrences} occurrence(s) passed while nothing was watching` +
          (missed.capped ? ", counted to the cap rather than to the last one" : ""),
      );
      renderer.fix(
        `crabby job backlog ${missed.jobId} --latest   (one run for the most recent, the rest acknowledged)`,
      );
      renderer.fix(`crabby job backlog ${missed.jobId} --skip   (acknowledge them, fire nothing)`);
    }
    if (startup.active > 0)
      renderer.fix(
        "a run stops and records `waiting on approval` if it cannot get one; nobody is answered on its behalf (§4.5)",
      );
  }
  // D-105's binding, and the reason it is here rather than in `packages/tools`: `built.driveTask` *is*
  // `recordAndDriveTask`, the act `POST /api/v1/tasks` and the scheduler's `fire` already reach, so a task a model
  // creates is recorded, journalled, priced and handed to the runner exactly as one a user created is. Nothing below
  // re-implements any of it; the only thing this composition adds is the rendering, which the tool owns.
  {
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
    // The manager's four failure codes, narrowed to the two a model can act on: `not-found` is "you named a task that
    // does not exist" and the other three are all §4.1's absorbing states getting there first — `terminal`,
    // `not-cancelling` and `already-settled` differ in which caller moved the record, and the manager's own sentence (which
    // travels through verbatim) is the place that difference is stated. A fourth code here would be a fourth wording of
    // one refusal.
    const codeFor = (code: CancellationFailureCode): TaskToolCode =>
      code === "not-found" ? "not-found" : "terminal";
    const request = (input: {
      taskId: string;
      mode?: "finish-step" | "immediate";
      reason?: string;
      origin: { clientId: string; interface: ClientInterface };
    }): ReturnType<NonNullable<typeof askCancel>> => {
      const result = built.cancellation.request({
        taskId: input.taskId,
        ...(input.mode === undefined ? {} : { mode: input.mode }),
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        // §14's audit fields, taken from the run's origin and never from the arguments: who asked and from which
        // interface. The manager puts both in the `task.cancelling` event's payload, so a cancellation a model requested
        // is attributable to the identity whose approval let it run.
        byClientId: input.origin.clientId,
        via: input.origin.interface,
      });
      return result.ok
        ? {
            ok: true,
            task: result.task,
            settled: result.settled,
            ...(result.deduplicated === undefined ? {} : { deduplicated: result.deduplicated }),
            ...(result.escalated === undefined ? {} : { escalated: result.escalated }),
          }
        : { ok: false, code: codeFor(result.code), reason: result.reason };
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
  }
  if (built.bootstrap) {
    renderer.line("", "");
    renderer.line(
      "first client",
      "pair with this code — single use, and it expires in ~2 minutes (§3.2)",
    );
    renderer.raw(built.bootstrap.code);
  }
  renderer.line("", "");
  renderer.fix("crabby auth pair --code <code>");
  renderer.fix("crabby status");
  renderer.line(
    "stop",
    drive === undefined
      ? "Ctrl-C — streams drain, then the listener closes (D-066's 5 s budget)"
      : "Ctrl-C — runs settle inside D-066's 5 s budget, then streams drain, then the listener closes",
  );
  log.info("gateway listening", { url, ...info });

  const shutdown = createShutdown(layout);
  let finish!: () => void;
  const stopped = new Promise<void>((resolve) => {
    finish = resolve;
  });
  // Order is registration order, and it matters: streams first so a client is disconnected while the server is still
  // answering, then the listener, then the file other processes read, then SQLite — WAL is only safe to drop last.
  // D-066's drain has to fit a live stream in it, so the bus ends them with the reason that makes a reconnect
  // deliberate rather than reflexive (`docs/INTERFACES_AND_API.md` §5.4's `end` frame, D-096).
  // Runs first, and the order is the whole point: a run writes through the journal, so a step still moving when SQLite
  // closes is a crash wearing a drain's clothes, and a stream closed while its task is still emitting leaves a client
  // reconnecting to a cursor nothing will advance. D-066's budget is spent waiting rather than killing, and what is
  // still moving when the budget ends is printed rather than dropped, because §7.1's recovery owns it next and an
  // operator who does not know a task was cut off cannot tell an interruption from a hang.
  // Registered before `runs`, and the order is the point: a tick that fired while the runner was already draining would
  // create a task nobody is left to watch, and §4.5's "cancellable like a task" presumes a party there to cancel it.
  // Stopping the arm first is what makes "runs settle, then streams drain, then SQLite closes" true rather than nearly.
  shutdown.onShutdown("scheduler", async () => {
    if (built.scheduler === undefined) return;
    const report = built.scheduler.shutdown();
    log.info("scheduler stopped", { ...report });
    if (report.openRuns > 0)
      renderer.line(
        "scheduler",
        `${report.openRuns} job run(s) were still open when the timer stopped; a run is a task, and ` +
          "`crabby task cancel <taskId>` is how one is stopped (§4.5)",
      );
  });
  shutdown.onShutdown("runs", async () => {
    if (built.runner === undefined) return;
    // D-066's budget read out of `limits.*` and defaulted from `LIMITS_DEFAULTS` rather than restated here: a second
    // copy of the number is a number that drifts from the one `crabby config get limits` prints.
    const report = await built.runner.shutdown(
      loaded.limits.cancellationSettleMs ?? LIMITS_DEFAULTS.cancellationSettleMs,
    );
    log.info("runs drained", { ...report });
    if (report.abandoned.length > 0 || report.parked.length > 0) {
      renderer.line(
        "runs",
        `${report.drained} settled, ${report.abandoned.length} still moving when the budget ended, ` +
          `${report.parked.length} parked at an approval`,
      );
      renderer.fix(
        "§7.1's recovery marks a task that was moving `interrupted` on the next start; a parked run cannot be resumed " +
          "by a new process, and its approval still expires under D-064's window (F-47)",
      );
    }
  });
  shutdown.onShutdown("streams", () => built.bus.closeAll("shutdown"));
  shutdown.onShutdown("listener", async () => {
    await built.app.close();
  });
  shutdown.onShutdown("gateway.json", () => clearGatewayInfo(layout));
  shutdown.onShutdown("sqlite", () => handle.close());
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void shutdown.run("signal", signal).then((result) => {
        for (const step of result.errors) log.warn("drain step failed", step);
        finish();
      });
    });
  }
  await stopped;
  renderer.line("gateway", "stopped cleanly");
  return EXIT.success;
}

function runStatus(layout: DataLayout, renderer: Renderer): ExitCode {
  const info = readGatewayInfo(layout);
  if (info.state === "absent") {
    renderer.line("gateway", "not running — no gateway.json in this data dir");
    renderer.fix("crabby gateway start");
    return EXIT.failure;
  }
  renderer.line("gateway", `http://${info.info.host}:${info.info.port}`);
  renderer.line(
    "pid",
    `${info.info.pid} (${info.state === "live" ? "alive" : "gone — the file is left over"})`,
  );
  renderer.line("started", info.info.startedAt);
  renderer.line("version", info.info.version);
  if (info.state === "stale")
    renderer.fix("crabby gateway start, or delete gateway.json if you mean to leave it down");
  return renderer.done({ state: info.state, ...info.info });
}

function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined) return 0;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 && value <= 65535 ? value : undefined;
}

function readVersion(): string {
  // The CLI is run from the repo in M1 (`npm link`/`npx`), so the root manifest is the version of record; a packaged
  // build gets `npm_package_version` instead. Neither is a guess baked into a string literal.
  if (process.env.npm_package_version) return process.env.npm_package_version;
  const manifest = new URL("../../../package.json", import.meta.url).pathname;
  if (!existsSync(manifest)) return "0.0.0";
  try {
    return String(
      (JSON.parse(readFileSync(manifest, "utf8")) as { version?: string }).version ?? "0.0.0",
    );
  } catch {
    return "0.0.0";
  }
}

// `gateway.json` is a convention *between processes on one machine* rather than an HTTP concern, so both halves of it
// live in `@crabby/gateway`'s client module: the writer here, the reader in every interface.
