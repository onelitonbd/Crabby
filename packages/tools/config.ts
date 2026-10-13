// `config.get` and `config.set` — the two rows `PROVIDERS_AND_TOOLS.md` §4.2 prices for this install's own
// configuration, at **T0** for the read ("`config.write`-independent read", which is a statement that it needs *no*
// capability) and at **T3** for the write, which "includes changing permissions, roots, or retention". This file is
// their executor half.
//
// Why a model needs either is worth stating, because a settings tool with no caller is a tool with no reason to exist:
// an agent asked "why did that fetch need approving" cannot answer without reading `net.allowList`, and an agent that has
// just been told "always use the groq model" is the party holding the sentence a `defaultModel` override is made of.
// D-074's numbers are the same story from the other side — every timeout is "`limits.*` in `config.json`, visible
// through `crabby config get limits`", and a model that can read them can tell a user which number a refusal came from.
//
// The **T3** on the write is the interesting half, and it is a fact about who can answer rather than about how loud the
// prompt is: D-085 makes a T3 approval answerable in the TUI or the Web control UI only, and this build has neither, so a
// run whose model asks to change configuration parks at a prompt no CLI can sign. That is not a defect to work around and
// it is not hidden — the declaration says it in the description the model reads, the arbiter's refusal says it to whoever
// tries to answer from the CLI, and the user's own path to the same act is `crabby config set` or `PUT /api/v1/config`,
// which are user acts and not tool calls. Shipping the row anyway is the honest half of §4.2 listing it in M2's initial
// set: the executor exists, the tier is enforced, and what is absent is an interface, which M3 brings.
//
// What is deliberately not here:
//
//   - **No deletion.** A `value` is required, and removing a key stays `crabby config set` with nothing after the key.
//     Setting and unsetting are different acts on a document that decides permissions, and §4.2 prices the one it names.
//   - **No token in the schema.** The concurrency token §2 requires is read and presented by the *sink*, never supplied by
//     the model, for the reason D-099 gives for `facts`: a declared field is never an authority, and a token a caller
//     could choose is a write that could be aimed at a document nobody read.
//   - **No vault.** `provider.<id>.key` is a `vault://` reference in a valid file and nothing resolves one (F-56), so
//     there is no secret here to read — and §4.2's "secret *names* only, never values" is enforced on the way in by the
//     composition root's `configForReading`, the same scrub `GET /api/v1/config` answers with, rather than by this file
//     keeping a second copy of the rule.
import type { ToolOutcome, ToolRunContext, ToolSurface } from "@crabby/agent-runtime";
import {
  MAX_TOOL_OUTPUT_BYTES,
  type Problem,
  type ToolDeclaration,
  Type,
  validateToolArguments,
} from "@crabby/api-contracts";
import { LIMITS_DEFAULTS } from "@crabby/core";
import type { ToolCall } from "@crabby/policy";
import type { ProviderToolSpec } from "@crabby/providers";
import { assertRegistrable } from "./declare.ts";
import { cutAtByteBoundary } from "./untrusted.ts";

export const CONFIG_GET_TOOL = "config.get";
export const CONFIG_SET_TOOL = "config.set";

/** The refusals this executor answers with. `unavailable` is the sink's absence, `stale` is §2's concurrency rule
 *  arriving through a tool, `invalid` is the schema refusing the document the write would produce, and `not-found` is a
 *  key nobody wrote — which is an answer rather than an empty one, because a model that asked for `limits.nope` and got
 *  nothing back would ask again. */
export const CONFIG_TOOL_CODES = {
  notDeclared: "not-declared",
  aborted: "aborted",
  invalidArguments: "invalid-arguments",
  unavailable: "unavailable",
  notFound: "not-found",
  invalid: "invalid",
  stale: "stale",
  unwritable: "unwritable",
} as const;
export type ConfigToolCode = (typeof CONFIG_TOOL_CODES)[keyof typeof CONFIG_TOOL_CODES];

const DECLARATION_GET =
  "Read this install's configuration, as `config.get` in `PROVIDERS_AND_TOOLS.md` §4.2 (T0, and the row's own words are " +
  "that it needs no capability). Ask for one dotted key — `limits.fsTimeoutMs`, `net.allowList`, `defaultModel`, " +
  "`workspace.roots`, `provider` — or for nothing and get the whole document, one line per leaf, each marked as a default " +
  "or as an override the user wrote. Values are what the process runs on, so a number here is the number a deadline or a " +
  "cap was enforced with. Secret values are never in the answer: `provider.<id>.key` is a `vault://` name in a valid " +
  "file, anything else in that field is withheld and named in the answer's `redacted` list. This tool changes nothing.";

const DECLARATION_SET =
  "Change one key of this install's configuration, as `config.set` in `PROVIDERS_AND_TOOLS.md` §4.2 — **T3**, needs " +
  "`config.write`, and the row says why: it includes changing permissions, roots or retention. Expect a human to have to " +
  "approve it, and expect that a T3 approval is answerable in the TUI or the Web control UI only (SECURITY.md §6.2, " +
  "D-085), so on an install with neither the request will park and expire rather than run — which is the rule working, " +
  "not a fault to retry around. Prefer telling the user the exact command (`crabby config set <key> <value>`) when what " +
  "they asked for is a change to their own settings. The write replaces one key of the document and validates the whole " +
  "of it, so a value the schema refuses changes nothing; a document somebody else wrote since this run read it is " +
  "refused as stale rather than overwritten (§2's concurrency rule). Nothing is deleted by this tool, and a successful " +
  "write applies at the next Gateway start, because this process composed its providers, roots, limits and egress " +
  "allow-list at startup.";

const GET_SCHEMA = Type.Object(
  {
    key: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "A dotted path into the document — `limits.fsTimeoutMs`, `net.allowList`, `provider.groq.baseUrl`. Absent " +
          "means the whole configuration, which is small enough to read and is marked default-or-override per line.",
      }),
    ),
  },
  { additionalProperties: false },
);

const SET_SCHEMA = Type.Object(
  {
    key: Type.String({
      minLength: 1,
      description:
        "The dotted path to write. It has to be a key `config.schema` knows: an unknown one is refused by the schema " +
        "before anything is written, because a configuration file with a key nobody reads is a typo that looks like a " +
        "setting.",
    }),
    value: Type.Unknown({
      description:
        "The value to write, as JSON — a number for `limits.*`, a string for `defaultModel`, an array for " +
        "`workspace.roots` or `net.allowList`. Required: this tool sets and never unsets, so removing a key is " +
        "`crabby config set` in a terminal.",
    }),
  },
  { additionalProperties: false },
);

/** §4.1's records for the two rows. */
export function configToolDeclarations(
  limits: ConfigToolOptions["limits"] = {},
): readonly ToolDeclaration[] {
  const toolLimits = {
    // §5.2 prices `fs.*` at 10 s, and the act here is a file read and a file write, so this tool takes the file class's
    // clock rather than inventing a fifth number for a document that lives on the same disk. The store-backed tools take
    // `sqliteBusyTimeoutMs` for the same reason from the other side: they borrow the clock of the thing they touch.
    timeoutMs: limits.fsTimeoutMs ?? LIMITS_DEFAULTS.fsTimeoutMs,
    maxOutputBytes: limits.maxOutputBytes ?? MAX_TOOL_OUTPUT_BYTES,
  };
  return [
    {
      name: CONFIG_GET_TOOL,
      description: DECLARATION_GET,
      inputSchema: GET_SCHEMA,
      limits: toolLimits,
      idempotent: true,
      sideEffects: "none",
    },
    {
      name: CONFIG_SET_TOOL,
      description: DECLARATION_SET,
      inputSchema: SET_SCHEMA,
      limits: toolLimits,
      // Not idempotent, and the reason is the token rather than the file: a second run writes the same key and the same
      // value, so the document ends in the same state, but the write it performs is a *new* write over a document that
      // may have moved since the first one, and §7.3's question is whether repeating a step is safe without asking
      // again. For a T3 act on the file that decides permissions, the honest answer is "ask again".
      idempotent: false,
      // `local` and not `irreversible`: the previous document is not kept, so a wrong value is not undoable by this
      // tool, but nothing outside this install moves and the user's own `crabby config set` can write it back. §6.2's
      // evidence is about effects that may have landed where a cancellation cannot see, and this one lands in a file the
      // process owns.
      sideEffects: "local",
    },
  ];
}

/** The document as the sink read it, already scrubbed: §4.2's "secret *names* only, never values" is enforced by
 *  `configForReading` in `packages/core`, which `GET /api/v1/config` also answers with, so the rule has one
 *  implementation and two callers. */
export interface ConfigToolRead {
  /** What the file says, with no defaults folded in. */
  readonly file: Readonly<Record<string, unknown>>;
  /** Defaults applied — what the process runs on, and what a `key` is read from. */
  readonly config: Readonly<Record<string, unknown>>;
  /** §2's version token. Reported to the model so an answer can say which document it read, and never accepted back:
   *  the sink presents its own. */
  readonly token: string;
  readonly path: string;
  readonly exists: boolean;
  readonly problems: readonly Problem[];
  readonly redacted: readonly string[];
}

export type ConfigToolWriteResult =
  | {
      readonly ok: true;
      readonly token: string;
      readonly changed: boolean;
      readonly path: string;
    }
  | {
      readonly ok: false;
      readonly code: Extract<ConfigToolCode, "invalid" | "stale" | "unwritable" | "unavailable">;
      readonly reason: string;
    };

export interface ConfigToolOptions {
  /** The document as it reads now. `undefined` means this process composed no configuration reader, which is an absence
   *  the tool reports rather than guesses at. */
  readonly read: () => ConfigToolRead | undefined;
  /** Writes one key. The sink owns the read-modify-write and the token that goes with it, for the reason the header
   *  gives: a token the model could choose would be a write aimed at a document nobody read. */
  readonly write: (input: { key: string; value: unknown }) => ConfigToolWriteResult;
  readonly limits?: { readonly fsTimeoutMs?: number; readonly maxOutputBytes?: number };
}

export interface ConfigToolExecutor extends ToolSurface {
  readonly declarations: () => readonly ToolDeclaration[];
  readonly declares: (tool: string) => ToolDeclaration | undefined;
}

export function createConfigTools(options: ConfigToolOptions): ConfigToolExecutor {
  const declarations = configToolDeclarations(options.limits);
  // §4.1's registration rules at construction, for the reason every other executor runs them there.
  assertRegistrable(declarations);
  const byName = new Map(declarations.map((declaration) => [declaration.name, declaration]));
  const maxOutputBytes = options.limits?.maxOutputBytes ?? MAX_TOOL_OUTPUT_BYTES;

  const specs = (): readonly ProviderToolSpec[] =>
    declarations.map((declaration) => ({
      name: declaration.name,
      description: declaration.description,
      parameters: declaration.inputSchema,
    }));

  const run = async (call: ToolCall, ctx: ToolRunContext): Promise<ToolOutcome> => {
    const declaration = declarations.find((entry) => entry.name === call.tool);
    if (declaration === undefined) {
      return {
        ok: false,
        code: CONFIG_TOOL_CODES.notDeclared,
        output:
          `'${call.tool}' reached the configuration executor, which declares ${declarations.length}: ` +
          `${declarations.map((entry) => entry.name).join(", ")}. §4.1 makes an undeclared tool unrunnable rather than ` +
          "tolerant.",
      };
    }
    // §4.1: "malformed arguments are rejected pre-execution". The loop already did this before policy; doing it again
    // here is the difference between a tool that can be misused by a caller and one that cannot.
    const checked = validateToolArguments(declaration.inputSchema, call.args);
    if (!checked.ok) {
      return {
        ok: false,
        code: CONFIG_TOOL_CODES.invalidArguments,
        output: `'${call.tool}' was called with arguments its own schema rejects: ${checked.problems
          .map((problem) => `${problem.path || "(root)"} ${problem.message}`)
          .join("; ")}`,
      };
    }
    if (ctx.signal.aborted) {
      return {
        ok: false,
        code: CONFIG_TOOL_CODES.aborted,
        output: `'${call.tool}' was signalled to stop before it touched the configuration (§6.1's step 2)`,
      };
    }
    const document = options.read();
    if (document === undefined) {
      return {
        ok: false,
        code: CONFIG_TOOL_CODES.unavailable,
        output: `this process composed no configuration reader, so there is no document to ${
          call.tool === CONFIG_GET_TOOL ? "read" : "write"
        }. The file is \`config.json\` in the state directory, and \`crabby config path\` prints where that is.`,
      };
    }
    return call.tool === CONFIG_GET_TOOL
      ? readConfig(call, document, maxOutputBytes)
      : writeConfigKey(call, document, options, maxOutputBytes);
  };

  return {
    specs,
    run,
    declarations: () => declarations,
    declares: (tool) => byName.get(tool),
    // No `facts`: §4.3 has no argument-dependent escalation for either row, so there is nothing only a runtime could
    // observe before the arbiter is asked. The T3 on `config.set` is the row's base tier and needs no observation at all.
  };
}

function readConfig(call: ToolCall, document: ConfigToolRead, maxOutputBytes: number): ToolOutcome {
  const key = typeof call.args.key === "string" ? call.args.key : undefined;
  if (key !== undefined) {
    const value = pick(document.config, key);
    if (value === undefined) {
      const siblings = siblingKeys(document.config, key);
      return {
        ok: false,
        code: CONFIG_TOOL_CODES.notFound,
        output:
          `there is no '${key}' in this install's configuration${
            siblings.length === 0 ? "" : ` — the keys beside it are ${siblings.join(", ")}`
          }. \`config.get\` with no key prints the whole document, and \`crabby config schema --json\` lists every key ` +
          "the schema knows.",
      };
    }
    const origin = pick(document.file, key) === undefined ? "a default (D-074)" : "config.json";
    return {
      ok: true,
      output: bounded(
        [`${key} = ${render(value)}`, `from ${origin}`, header(document)].join("\n"),
        document.path,
        maxOutputBytes,
      ),
    };
  }
  const lines = leaves(document.config).map(([path, value]) => {
    const overridden = pick(document.file, path) !== undefined;
    return `${path} = ${render(value)}${overridden ? "" : "  (default)"}`;
  });
  return {
    ok: true,
    output: bounded(
      [
        header(document),
        // The document as the process runs on it, with the defaults marked, because "is this my setting or theirs" is
        // the question a model asks a configuration and the merged view alone cannot answer.
        ...(lines.length === 0 ? ["(nothing set: every value is a default)"] : lines),
      ].join("\n"),
      document.path,
      maxOutputBytes,
    ),
  };
}

function writeConfigKey(
  call: ToolCall,
  document: ConfigToolRead,
  options: ConfigToolOptions,
  maxOutputBytes: number,
): ToolOutcome {
  const key = String(call.args.key);
  const written = options.write({ key, value: call.args.value });
  if (!written.ok) {
    return {
      ok: false,
      code: written.code,
      output:
        written.code === CONFIG_TOOL_CODES.stale
          ? `${written.reason} Nothing was written, and the document this run read was ${document.path} at token ` +
            `${document.token}.`
          : `${written.reason} Nothing was written: §4.2's \`config.set\` row changes the file that decides permissions, ` +
            "so a refusal leaves it exactly as it was.",
    };
  }
  return {
    ok: true,
    output: bounded(
      [
        `${key} written to ${written.path}`,
        written.changed
          ? `the document's token is now ${written.token}, and this Gateway keeps the configuration it loaded at ` +
            "startup — the write applies at the next start"
          : `the document already said this, so nothing moved and the token is still ${written.token}`,
        document.problems.length === 0
          ? ""
          : `the file still carries ${document.problems.length} problem(s) the schema names: ` +
            document.problems
              .map((problem) => `${problem.path || "<root>"} ${problem.message}`)
              .join("; "),
      ]
        .filter((line) => line !== "")
        .join("\n"),
      written.path,
      maxOutputBytes,
    ),
  };
}

/** The lines every answer carries, so a model reading one knows which document it read and what was withheld from it. */
function header(document: ConfigToolRead): string {
  const parts = [
    `${document.exists ? "read" : "no file yet at"} ${document.path}`,
    `token ${document.token}`,
  ];
  if (document.redacted.length > 0) {
    parts.push(
      `${document.redacted.length} value(s) withheld: ${document.redacted.join(", ")} — §4.2's \`config.get\` row is ` +
        "secret *names* only, never values, and the file itself is the place to look at one",
    );
  }
  if (document.problems.length > 0) {
    parts.push(
      `${document.problems.length} problem(s) the schema names: ` +
        document.problems
          .map((problem) => `${problem.path || "<root>"} ${problem.message}`)
          .join("; "),
    );
  }
  return parts.join("; ");
}

/** A bound rather than a truncation-with-overflow: the whole document is already on disk at a path this answer names, so
 *  D-064's "the rest is in scratch" would be a second copy of a file that exists. What is cut is the render, and the note
 *  says where the rest is. */
function bounded(text: string, path: string, maxOutputBytes: number): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxOutputBytes) return text;
  const cut = cutAtByteBoundary(text, maxOutputBytes);
  return (
    `${cut}\n[cut at ${Buffer.byteLength(cut, "utf8")} of ${bytes} bytes: the whole document is ${path}, ` +
    "which `crabby config path` also prints]"
  );
}

function pick(document: Readonly<Record<string, unknown>>, dotted: string): unknown {
  let cursor: unknown = document;
  for (const segment of dotted.split(".")) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/** Every leaf of the document as a dotted path, so a whole-document answer is one line per setting rather than a nested
 *  object a model has to walk. Bounded at a depth, because `provider.<id>.models.<model>` is a document of its own and a
 *  render that descended into every model descriptor would be a page of JSON nobody asked for. */
function leaves(document: unknown, prefix = "", depth = 0): readonly [string, unknown][] {
  if (depth > 4 || typeof document !== "object" || document === null || Array.isArray(document)) {
    return prefix === "" ? [] : [[prefix, document]];
  }
  const out: [string, unknown][] = [];
  for (const [key, value] of Object.entries(document as Record<string, unknown>)) {
    out.push(...leaves(value, prefix === "" ? key : `${prefix}.${key}`, depth + 1));
  }
  return out;
}

/** The keys beside a path nobody wrote, which is the useful half of a `not-found`: a model that asked for
 *  `limits.noop` learns what `limits` does hold instead of learning nothing. */
function siblingKeys(
  document: Readonly<Record<string, unknown>>,
  dotted: string,
): readonly string[] {
  const segments = dotted.split(".");
  const parent = segments.slice(0, -1).join(".");
  const value = parent === "" ? document : pick(document, parent);
  if (typeof value !== "object" || value === null) return [];
  return Object.keys(value as Record<string, unknown>).slice(0, 12);
}

function render(value: unknown): string {
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return String(value);
}
