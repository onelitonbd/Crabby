// `crabby gateway start|status` — the lifecycle verbs §7.1's Gateway row names. `start` is foreground on purpose: a
// supervised daemon, plus `stop`/`restart`, belong with the runtime that has something to supervise, and backgrounding
// a process the CLI cannot find again afterwards is a half-truth that costs a week in M2. What this build does honor
// is D-066: Ctrl-C drains the live streams and closes the listener within 5 s.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { EXIT, type ExitCode } from "@crabby/api-contracts";
import { createLogger, createShutdown, type LogLevel, loadConfig } from "@crabby/core";
import {
  buildApp,
  clearGatewayInfo,
  type GatewayInfo,
  readGatewayInfo,
  writeGatewayInfo,
} from "@crabby/gateway";
import { type DataLayout, homeDirectory } from "@crabby/platform";
import { composeProviders, selectDefaultModel } from "@crabby/providers";
import { DB_FILE_NAME, migrate, openDatabase, schemaVersion, taskScratch } from "@crabby/storage";
import { createFileTools } from "@crabby/tools";
import { parseTail, unknownFlagMessage } from "../args.ts";
import type { Renderer } from "../output.ts";
import { findCommand } from "../registry.ts";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

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

  const log = createLogger({ ...(logLevel === undefined ? {} : { level: logLevel }) }, "gateway");
  const loaded = loadConfig(layout);
  const dbFile = path.join(layout.stateDir, DB_FILE_NAME);
  // D-074 makes `limits.sqliteBusyTimeoutMs` the override for the busy timeout, and `openDatabase` reads it out of
  // `options.limits` — so until this line the composition root opened the database without the loaded config and that
  // one key changed nothing except the screen that printed it. The rest of `limits.*` waits for the runtime that
  // consumes it; this one already had a consumer and was not being handed to it.
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
  const startedAt = new Date();
  const built = await buildApp({
    db: handle.db,
    layout,
    log,
    version: readVersion(),
    startedAt,
    listenerMode: "local",
    providers,
    ...(executor === undefined ? {} : { declares: executor.declares }),
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
  const selected = selectDefaultModel(providers, loaded.config.defaultModel);
  renderer.line(
    "default model",
    selected.ok
      ? `${selected.providerId}/${selected.modelId}`
      : `not selected — ${selected.reason}`,
  );
  // Printed because it is the difference between a Gateway that can describe its tools and one that can only classify
  // them, and `GET /api/v1/tools` answers it too — this line just answers it once, at startup, where a user can act on it.
  if (executor === undefined) {
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
      `${executor.declarations().length} declared by the file executor over ${roots.length} root(s); ` +
        "the rows nothing implements still name their runtime fields as pending (F-55)",
    );
  }
  renderer.line(
    "tasks",
    "recorded, not driven: the runner exists (M2n) and `POST /api/v1/tasks/{id}/cancel` stops a task, but nothing " +
      "composes the runner into `POST /api/v1/tasks`, because no code in this build writes `Identity.capabilities` and a " +
      "run started from a route would hold no grants and be refused every tool it proposed (F-52)",
  );
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
  renderer.line("stop", "Ctrl-C — streams drain, then the listener closes (D-066's 5 s budget)");
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
