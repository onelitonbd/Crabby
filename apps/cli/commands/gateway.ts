// `crabby gateway start|status` — the lifecycle verbs §7.1's Gateway row names. `start` is foreground on purpose: a
// supervised daemon, plus `stop`/`restart`, belong with the runtime that has something to supervise, and backgrounding
// a process the CLI cannot find again afterwards is a half-truth that costs a week in M2. What this build does honor
// is D-066: Ctrl-C drains the live streams and closes the listener within 5 s.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { EXIT, type ExitCode } from "@crabby/api-contracts";
import { createLogger, createShutdown, type LogLevel } from "@crabby/core";
import {
  buildApp,
  clearGatewayInfo,
  type GatewayInfo,
  readGatewayInfo,
  writeGatewayInfo,
} from "@crabby/gateway";
import type { DataLayout } from "@crabby/platform";
import { DB_FILE_NAME, migrate, openDatabase, schemaVersion } from "@crabby/storage";
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
  const dbFile = path.join(layout.stateDir, DB_FILE_NAME);
  const handle = openDatabase(dbFile);
  const migration = migrate(handle.db);
  const startedAt = new Date();
  const built = await buildApp({
    db: handle.db,
    layout,
    log,
    version: readVersion(),
    startedAt,
    listenerMode: "local",
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
