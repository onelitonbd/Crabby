// `packages/tools` — the executor `ARCHITECTURE.md` §18 lists, which `AGENT_RUNTIME.md` §4.4 described as a seam until M2k
// and now describes as a surface the loop never imports ("the loop has an executor interface and no tools built into it").
// §19 fixes the direction of the dependency — "adapters implement the runtime's abstractions" — so this package implements
// `ToolSurface` and nothing in `packages/agent-runtime` knows it exists; the composition that joins them lives in this
// package's `demo.ts` and in `tests/integration/tools.test.ts`, because the other direction would be the cycle §19
// forbids.
//
// What is here is the eight file tools `PROVIDERS_AND_TOOLS.md` §4.2 classifies (`file.read`, `file.list`, `file.stat`,
// `file.write`, `file.edit`, `file.delete`, `file.move`, `fs.search`), the scheduler's one row (`cron.schedule`), the two
// conversation rows (`session.list`, `session.rename`), the three task rows (`task.create`, `task.status`, `task.cancel`)
// the network's one row (`net.fetch`) and the two configuration rows (`config.get`, `config.set`), with §4.1's record
// filled in for each. Every one of them is an executor over a
// sink rather than a subsystem of its own: the file tools do their own I/O because §8's containment is a property of
// paths and this package owns the path rules, `net.fetch` does its own because the two judgements it owes are about a
// destination and a byte count and no other party sees either, and the remaining four ask a party that owns a store — the
// scheduler, the session table, the Gateway's one task act — and render the answer, because a second writer of a fact is
// how two interfaces start disagreeing (§9).
//
// What is still absent, and why, rather than a list that reads as an oversight: `memory.*` has no store to read —
// `docs/ROADMAP.md` §6 gives the persistent memory subsystem to M4, and a `memory.search` over nothing would answer
// "nothing remembered" forever, which is the mock this repository refuses. `config.*` waits on the same slice that gives
// `config.json` a writer with a concurrency token (§2's other half) — which it now has, so `config.get` and `config.set`
// are built and that sentence is history rather than a plan. §4.2's `http.request` row stays absent beside the
// `net.fetch` that is now built: a method that mutates remote state is a different act, and it cannot share a tier or an
// idempotency declaration with a GET. And §4.2's remaining rows need a tunnel, an extension registry, a provider or
// Termux's own API. Absent rows stay absent in
// `crabby tools ls`, which prints them from the registry as planned rather than from an executor as broken.
//
// `shell.run` is deliberately not here either. §4.2 says its "capability itself is off by default" and `docs/ROADMAP.md` §4
// says it ships in this phase but stays off until `crabby init` opts in — an executor for it is a slice that has to arrive
// with that opt-in path, and arriving before it would be a T2-per-command classifier with no way to be turned off.
//
// Two members beyond `ToolSurface`'s `specs`/`run` are the reason this package is more than a bag of functions:
//
//   - `declarations()` is §4.1's record as data, so whoever serves `GET /tools` can merge it with the registry rows
//     instead of the registry guessing at fields it does not own (`PENDING_RECORD_FIELDS` in `packages/policy`).
//   - `facts(call)` answers the questions §4.3's escalations ask about arguments that only a runtime can supply —
//     `preExistingUserFile` for `file.edit`, `overwrites` for `file.move`. Without it, §4.2's T2 for "overwriting a file
//     Crabby did not create" is unreachable the moment an executor exists to overwrite one, because the only party who
//     could have supplied the fact is the party asking for the permission (D-099).

import { realpathSync } from "node:fs";
import path from "node:path";
import type { ToolOutcome, ToolRunContext, ToolSurface } from "@crabby/agent-runtime";
import { MAX_TOOL_OUTPUT_BYTES, type ToolDeclaration } from "@crabby/api-contracts";
import { LIMITS_DEFAULTS } from "@crabby/core";
import type { PathContext, ToolCall } from "@crabby/policy";
import type { ProviderToolSpec } from "@crabby/providers";
import { assertRegistrable, fileToolDeclarations } from "./declare.ts";
import { type FileToolEnv, fileFacts, runFileTool } from "./fs.ts";
import { defaultNonce } from "./untrusted.ts";

export {
  CONFIG_GET_TOOL,
  CONFIG_SET_TOOL,
  CONFIG_TOOL_CODES,
  type ConfigToolCode,
  type ConfigToolExecutor,
  type ConfigToolOptions,
  type ConfigToolRead,
  type ConfigToolWriteResult,
  configToolDeclarations,
  createConfigTools,
} from "./config.ts";
export {
  createSchedulerTools,
  SCHEDULER_TOOL,
  type SchedulerToolExecutor,
  type SchedulerToolOptions,
  schedulerToolDeclarations,
} from "./cron.ts";
export { assertRegistrable, fileToolDeclarations } from "./declare.ts";
export { type FileToolEnv, fileFacts, runFileTool } from "./fs.ts";
export {
  createNetTools,
  MAX_REDIRECTS,
  NET_FETCH_TOOL,
  NET_TOOL_CODES,
  type NetToolCode,
  type NetToolEnv,
  type NetToolExecutor,
  type NetToolOptions,
  netToolDeclarations,
  runNetTool,
} from "./net.ts";
export { writeOverflowFile } from "./overflow.ts";
export {
  createSessionTools,
  SESSION_LIST_TOOL,
  SESSION_RENAME_TOOL,
  type SessionRenameResult,
  type SessionToolExecutor,
  type SessionToolOptions,
  sessionToolDeclarations,
} from "./session.ts";
export {
  createTaskTools,
  TASK_CANCEL_TOOL,
  TASK_CREATE_TOOL,
  TASK_HISTORY_EVENTS,
  TASK_STATUS_TOOL,
  TASK_TOOL_CODES,
  type TaskToolCancelResult,
  type TaskToolCode,
  type TaskToolCreateResult,
  type TaskToolExecutor,
  type TaskToolOptions,
  type TaskToolOrigin,
  type TaskToolRead,
  taskToolDeclarations,
} from "./task.ts";
export {
  capWrapped,
  cutAtByteBoundary,
  EXTERNAL_CONTENT_TAG,
  labelForTruncation,
  TRUST_UNTRUSTED,
  wrapUntrusted,
} from "./untrusted.ts";

export interface FileToolOptions {
  /** §8's "one or more configured workspace roots", plus the home directory and the Crabby data directory the deny-list
   *  is measured against. Required, and required whole: a partial path context is the difference between "inside the
   *  workspace" and "somewhere we did not check". */
  readonly paths: PathContext;
  /** Where D-064's over-cap output and §8's trash-or-rename go: the task's scratch directory. Injected because
   *  `packages/storage/scratch.ts` owns that layout, and a tool package that computed it would be a second owner. */
  readonly scratchDirFor: (taskId: string) => string;
  /** §8's "re-checked *after* resolving links". Defaults to a resolver that walks up to the nearest existing ancestor,
   *  which is what a create needs: the file does not exist yet, and the link hop that matters is the directory it lands
   *  in. Injectable so the symlink rule is testable without building a symlink. */
  readonly realpathOf?: (absolutePath: string) => string;
  /** D-074's `fs.*` class deadline and D-064's inline cap, both read from `limits` in `config.json` so the declaration
   *  and the deadline the loop enforces are the same number by construction. */
  readonly limits?: { readonly fsTimeoutMs?: number; readonly maxOutputBytes?: number };
  readonly now?: () => number;
  readonly nonce?: () => string;
}

/** `ToolSurface` with this package's two optional members made definite: a file executor always declares its records and
 *  always answers the facts policy asks for, and a caller that only has a `ToolSurface` may still treat both as absent. */
export interface FileToolExecutor extends ToolSurface {
  readonly declarations: () => readonly ToolDeclaration[];
  /** Definite here and optional on `ToolSurface`: this executor always answers both, and a caller holding only the seam
   *  is allowed to find an executor that does not. */
  readonly facts: (call: ToolCall) => Record<string, unknown>;
  readonly declares: (tool: string) => ToolDeclaration | undefined;
}

/** The default §8 resolver. `realpathSync` throws for a path that does not exist, which is the normal case for a create,
 *  so the resolver walks up to the nearest ancestor that does and re-joins the rest: the containment question for a new
 *  file is about the directory it will land in, and that directory's links are resolvable. */
export function defaultRealpathOf(absolutePath: string): string {
  try {
    return realpathSync(absolutePath);
  } catch {
    const parent = path.dirname(absolutePath);
    if (parent === absolutePath) return absolutePath;
    return path.join(defaultRealpathOf(parent), path.basename(absolutePath));
  }
}

export function createFileTools(options: FileToolOptions): FileToolExecutor {
  const fsTimeoutMs = options.limits?.fsTimeoutMs ?? LIMITS_DEFAULTS.fsTimeoutMs;
  const maxOutputBytes = options.limits?.maxOutputBytes ?? MAX_TOOL_OUTPUT_BYTES;
  const declarations = fileToolDeclarations({ fsTimeoutMs, maxOutputBytes });
  // §4.1's registration rules run at construction, which is startup for a Gateway: a duplicate id or an unparsable schema
  // is fatal here rather than a refusal discovered by a user mid-task.
  assertRegistrable(declarations);

  const env: FileToolEnv = {
    paths: options.paths,
    realpathOf: options.realpathOf ?? defaultRealpathOf,
    scratchDirFor: options.scratchDirFor,
    maxOutputBytes,
    declarations,
    now: options.now ?? (() => Date.now()),
    nonce: options.nonce ?? defaultNonce,
  };

  const byName = new Map(declarations.map((declaration) => [declaration.name, declaration]));

  const specs = (): readonly ProviderToolSpec[] =>
    declarations.map((declaration) => ({
      name: declaration.name,
      description: declaration.description,
      parameters: declaration.inputSchema,
    }));

  const run = async (call: ToolCall, ctx: ToolRunContext): Promise<ToolOutcome> => {
    if (!byName.has(call.tool)) {
      return {
        ok: false,
        // The loop refuses an undeclared name before policy is asked, so this branch is for a caller that did not go
        // through the loop. It is an answer rather than a throw for the same reason every other failure here is.
        output: `'${call.tool}' is not a file tool; this executor declares ${declarations.length}: ${declarations
          .map((declaration) => declaration.name)
          .join(", ")}`,
        code: "not-declared",
      };
    }
    return runFileTool(call, ctx, env);
  };

  return {
    specs,
    run,
    declarations: () => declarations,
    facts: (call) => fileFacts(call, env),
    declares: (tool) => byName.get(tool),
  };
}

/** One executor made of several, and the reason it is a function rather than a convention: the loop holds a single
 *  `ToolSurface`, so a composition with a file executor and a scheduler executor has to answer `specs`, `run`, `facts`
 *  and `declares` as one party — and four hand-written merges in four composition roots would be four places for the
 *  routing rule to drift. The rule is the one §4.1 already states: a tool belongs to the surface that *declares* it, so
 *  the map below is built from `specs()` and a call for a name nobody declares is refused rather than broadcast to every
 *  surface in turn (which would let two executors answer one call and leave the outcome to whichever promise settled).
 *
 *  `assertRegistrable` runs over the merged declarations for the same reason it runs inside each one: §4.1 makes a
 *  duplicate id fatal at startup, and a duplicate across two executors is the same defect with a wider blast radius. */
export interface CombinedToolExecutor extends ToolSurface {
  readonly declarations: () => readonly ToolDeclaration[];
  readonly declares: (tool: string) => ToolDeclaration | undefined;
  readonly facts: (call: ToolCall) => Record<string, unknown>;
}

export function combineToolSurfaces(surfaces: readonly ToolSurface[]): CombinedToolExecutor {
  const owner = new Map<string, ToolSurface>();
  for (const surface of surfaces)
    for (const spec of surface.specs()) {
      if (owner.has(spec.name))
        throw new Error(
          `tool '${spec.name}' is declared by two executors in one composition; §4.1 makes a duplicate id fatal at ` +
            "startup rather than a last-one-wins registry",
        );
      owner.set(spec.name, surface);
    }
  const declarations = (): readonly ToolDeclaration[] => [
    ...surfaces.flatMap((surface) => {
      const declared = surface as { declarations?: () => readonly ToolDeclaration[] };
      return declared.declarations === undefined ? [] : [...declared.declarations()];
    }),
  ];
  const merged = declarations();
  assertRegistrable(merged);
  const byName = new Map(
    merged.map((declaration) => [declaration.name, declaration] as [string, ToolDeclaration]),
  );
  return {
    specs: () => surfaces.flatMap((surface) => [...surface.specs()]),
    run: async (call, ctx) => {
      const surface = owner.get(call.tool);
      if (surface === undefined)
        return {
          ok: false,
          output:
            `'${call.tool}' is not declared by any executor in this composition; the ones it has are ` +
            `${[...owner.keys()].join(", ")}`,
          code: "not-declared",
        };
      return surface.run(call, ctx);
    },
    declarations,
    declares: (tool) => byName.get(tool),
    facts: (call) => {
      // Merged rather than first-answer-wins, because §4.3's escalations ask different executors about different
      // arguments and a fact answered by one surface must not be hidden by another that has nothing to say.
      const merged: Record<string, unknown> = {};
      for (const surface of surfaces) Object.assign(merged, surface.facts?.(call) ?? {});
      return merged;
    },
  };
}
