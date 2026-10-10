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
import { dataLayout, detectProcess, resolveDataDir } from "@crabby/platform";
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

import { type ConfigVerb, runConfig } from "./commands/config.ts";
import { runDoctor } from "./commands/doctor.ts";
import { runInit } from "./commands/init.ts";
import { readVersion, runVersion } from "./commands/version.ts";
import { commandName, findCommand, helpText, suggest } from "./registry.ts";

interface Parsed {
  readonly dataDir?: string;
  readonly json: boolean;
  readonly help: boolean;
  /** `--version`/`-v` is a flag rather than an alias the grammar must know, because someone typing it wants the one
   *  line that identifies the build. §7.1's `crabby version` stays the noun-verb form the other interfaces share. */
  readonly version: boolean;
  readonly positionals: string[];
  readonly unknown: string[];
}

const VALUE_FLAGS = new Set(["--data-dir", "--log-level", "--log-file"]);

export function parseArgs(argv: readonly string[]): Parsed {
  const positionals: string[] = [];
  const unknown: string[] = [];
  let dataDir: string | undefined;
  let json = false;
  let help = false;
  let version = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
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
    unknown,
    ...(dataDir === undefined ? {} : { dataDir }),
  };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<ExitCode> {
  const parsed = parseArgs(argv);
  const facts = detectProcess();
  const home = process.env.HOME ?? process.cwd();
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

  const [noun, verb, ...rest] = parsed.positionals;

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

  switch (noun) {
    case "init": {
      return runInit(layout, renderer);
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
  }

  const spec = findCommand(noun ?? "", verb);
  if (spec && spec.status === "planned") {
    renderer.line(commandName(spec), `not implemented yet — planned for ${spec.milestone}`);
    renderer.fix("crabby --help lists what this build can actually run");
    return EXIT.usage;
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

// No signal handlers are installed here, because no long-lived process starts in M1a; the Gateway registers its
// own through `createShutdown` in `packages/core` when it exists (D-066's 5 s drain).

process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(EXIT.success);
  throw error;
});
process.exitCode = await main();
