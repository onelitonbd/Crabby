#!/usr/bin/env node
// The CLI entry point, and — because the runtime runs `.ts` with no loader (D-070) and the bin field points at this
// file — the only build step Crabby needs is the one it never has.
//
// Two boundaries this file respects. It reads files through `@crabby/core`'s public entry and paths through
// `@crabby/platform`, never into either package's internals (docs/DEVELOPMENT.md §2), and it holds no policy of its
// own: exit codes, schemas and error classes all come from `@crabby/api-contracts`, because
// `docs/INTERFACES_AND_API.md` §7.1's rule is that a
// command cannot exist in one interface only.
import process from "node:process";
import { EXIT, type ExitCode } from "@crabby/api-contracts";
import { dataLayout, detectProcess, homeDirectory, resolveDataDir } from "@crabby/platform";
import { createRenderer } from "./output.ts";

/** §7.1: "Output must be pipeable." `crabby config get limits | head -4` closes the pipe while there is still output
 *  buffered, and Node raises an async EPIPE on the socket — which surfaces as an unhandled error and a stack trace
 *  over the user's terminal. The pipe closing is the reader's decision, so the writer's only correct response is to
 *  stop quietly. */
function writeStdout(text: string): void {
  try {
    process.stdout.write(text);
  } catch (error) {
    if (!isPipeError(error)) throw error;
  }
}

function isPipeError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: string }).code === "EPIPE"
  );
}

import { type ApprovalVerb, runApproval } from "./commands/approval.ts";
import { type AuthVerb, runAuth } from "./commands/auth.ts";
import { type ConfigVerb, runConfig } from "./commands/config.ts";
import { runDiagnostics } from "./commands/diagnostics.ts";
import { runDoctor } from "./commands/doctor.ts";
import { type GatewayVerb, runGateway } from "./commands/gateway.ts";
import { runInit } from "./commands/init.ts";
import { type JobVerb, runJob } from "./commands/job.ts";
import { runSession, type SessionVerb } from "./commands/session.ts";
import { runStatus } from "./commands/status.ts";
import { runTask, type TaskVerb } from "./commands/task.ts";
import { runTools } from "./commands/tools.ts";
import { readVersion, runVersion } from "./commands/version.ts";
import { commandName, findCommand, helpText, suggest } from "./registry.ts";

interface Parsed {
  readonly dataDir?: string;
  /** The global `--log-level`, forwarded to the one command that starts a long-lived process. */
  readonly logLevel?: "debug" | "info" | "warn" | "error";
  readonly json: boolean;
  readonly help: boolean;
  /** `--version`/`-v` is a flag rather than an alias the grammar must know, because someone typing it wants the one
   *  line that identifies the build. §7.1's `crabby version` stays the noun-verb form the other interfaces share. */
  readonly version: boolean;
  readonly positionals: string[];
  /** Everything after the noun and verb, untouched — what the command's own flag parser reads. */
  readonly rest: string[];
  readonly unknown: string[];
}

const VALUE_FLAGS = new Set(["--data-dir", "--log-level", "--log-file"]);
const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export function parseArgs(argv: readonly string[]): Parsed {
  const positionals: string[] = [];
  const unknown: string[] = [];
  const rest: string[] = [];
  let dataDir: string | undefined;
  let logLevel: "debug" | "info" | "warn" | "error" | undefined;
  let json = false;
  let help = false;
  let version = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    // Once the noun and the verb are both seen, the rest of the line belongs to that command and is forwarded
    // verbatim. Global flags and per-command flags cannot share one flat namespace: `crabby auth pair --code X` has
    // to reach `auth.ts` intact, and a parser that collected `--code` as an unknown global flag would reject a flag
    // the command itself declares in `registry.ts`.
    if (positionals.length >= 2) {
      if (arg === "--json") {
        json = true;
        continue;
      }
      if (arg === "--help" || arg === "-h") {
        help = true;
        continue;
      }
      if (VALUE_FLAGS.has(arg)) {
        const value = argv[i + 1];
        if (typeof value === "string") {
          i += 1;
          if (arg === "--data-dir") dataDir = value;
          if (arg === "--log-level" && LOG_LEVELS.includes(value as (typeof LOG_LEVELS)[number]))
            logLevel = value as "debug" | "info" | "warn" | "error";
          continue;
        }
      }
      rest.push(arg);
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--version" || arg === "-v") {
      version = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const next = argv[i + 1];
      if (VALUE_FLAGS.has(arg) && typeof next === "string" && !next.startsWith("--")) {
        i += 1;
        if (arg === "--data-dir") dataDir = next;
        if (arg === "--log-level" && LOG_LEVELS.includes(next as (typeof LOG_LEVELS)[number]))
          logLevel = next as "debug" | "info" | "warn" | "error";
        continue;
      }
      unknown.push(arg);
      continue;
    }
    positionals.push(arg);
  }
  // `exactOptionalPropertyTypes` is why an absent `--data-dir` is spread as nothing rather than as `undefined`.
  return {
    json,
    help,
    version,
    positionals,
    rest,
    unknown,
    ...(dataDir === undefined ? {} : { dataDir }),
    ...(logLevel === undefined ? {} : { logLevel }),
  };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<ExitCode> {
  const parsed = parseArgs(argv);
  const facts = detectProcess();
  const home = homeDirectory();
  const layout = dataLayout(
    resolveDataDir({
      home,
      cwd: process.cwd(),
      ...(parsed.dataDir ? { dataDir: parsed.dataDir } : {}),
    }),
  );
  const renderer = createRenderer(
    { write: writeStdout, err: (s) => process.stderr.write(s) },
    parsed.json,
  );
  const rootPackageJson = new URL("../../package.json", import.meta.url).pathname;

  if (parsed.unknown.length > 0) {
    renderer.line("unknown flag(s)", parsed.unknown.join(" "));
    renderer.fix("crabby --help lists the flags this build understands");
    return EXIT.usage;
  }

  const [noun, verb, ...extra] = parsed.positionals;
  // `crabby gateway start --port 8130` puts `--port` after the verb, so the tail the command sees is anything left
  // over in the positionals plus the forwarded rest — one array, in the order the person typed them.
  const rest = [...extra, ...parsed.rest];

  if (parsed.version) {
    return runVersion(facts, readVersion(rootPackageJson), renderer);
  }

  if (parsed.help && noun === undefined) {
    process.stdout.write(`${helpText()}\n`);
    return EXIT.success;
  }
  if (noun === undefined) {
    process.stdout.write(`${helpText()}\n`);
    // §7.1: `2` is the usage code. A bare invocation asked "what can I run", which is a usage question.
    return EXIT.usage;
  }

  if (parsed.help) {
    process.stdout.write(`${helpText()}\n`);
    return EXIT.success;
  }

  // The registry answers "does this verb exist yet?" before any command is consulted, which is what lets `crabby task
  // run` say *planned for M2* instead of being parsed by a command that has no such verb. A command therefore never
  // has to know that it is a placeholder, and no verb can be advertised as planned while quietly half-implemented.
  const declared = findCommand(noun ?? "", verb);
  if (declared && declared.status === "planned") {
    renderer.line(commandName(declared), `not implemented yet — planned for ${declared.milestone}`);
    renderer.fix("crabby --help lists what this build can actually run");
    return EXIT.usage;
  }

  switch (noun) {
    case "init": {
      // §5 step 3 puts the workspace root at `$HOME/crabby-workspace`, and the home this process resolved is the one
      // `--data-dir` did not override — so init gets the same `home` the layout was built from rather than reading the
      // environment a second time and risking two answers.
      return runInit(layout, renderer, home);
    }
    case "version": {
      return runVersion(facts, readVersion(rootPackageJson), renderer);
    }
    case "doctor": {
      return runDoctor(
        {
          layout,
          facts,
          rootPackageJson,
          nodeModulesRoot: new URL("../../node_modules", import.meta.url).pathname,
          home,
          termuxVersion: facts.termuxVersion,
        },
        renderer,
      );
    }
    case "config": {
      return runConfig(verb as ConfigVerb | undefined, rest, layout, renderer);
    }
    case "status": {
      return runStatus(layout, renderer);
    }
    case "gateway": {
      return runGateway(verb as GatewayVerb | undefined, rest, layout, renderer, parsed.logLevel);
    }
    case "auth": {
      return runAuth(verb as AuthVerb | undefined, rest, layout, renderer);
    }
    case "approval": {
      return runApproval(verb as ApprovalVerb | undefined, rest, layout, renderer);
    }
    case "task": {
      return runTask(verb as TaskVerb | undefined, rest, layout, renderer);
    }
    case "job": {
      return runJob(verb as JobVerb | undefined, rest, layout, renderer);
    }
    case "session": {
      return runSession(verb as SessionVerb | undefined, rest, layout, renderer);
    }
    case "diagnostics": {
      return runDiagnostics(rest, layout, renderer);
    }
    case "tools": {
      return runTools(verb, rest, layout, renderer);
    }
  }

  const name = verb ? `${noun} ${verb}` : (noun ?? "");
  const guess = suggest(noun ?? "", verb);
  renderer.line(
    `unknown command: crabby ${name}`,
    guess === undefined ? undefined : `did you mean \`crabby ${guess}\`?`,
  );
  renderer.fix("crabby --help prints the grammar this build implements");
  return EXIT.usage;
}

// The only long-lived process this binary starts is `crabby gateway start`, and it installs its own handlers through
// `createShutdown` in `packages/core` (D-066's 5 s drain) — see `commands/gateway.ts`. This file stays a dispatcher,
// so a signal path cannot be half-registered here and half-there.

process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(EXIT.success);
  throw error;
});
process.exitCode = await main();
