// `session.list` and `session.rename` — the two rows `PROVIDERS_AND_TOOLS.md` §4.2 prices for conversations, at **T0** and
// **T1**. This file is their executor half.
//
// Why a model needs either is worth stating, because a read tool with no caller is a tool with no reason to exist: the
// agent that is asked "carry on from where we left off" cannot answer it without a list of conversations, and the agent
// that has just finished forty minutes of work in a session called `un-named` is the party best placed to give it a title.
// C11's reason for the noun is the same one from the other side — "without `session ls` the only way to resume on a phone
// is to remember an id, which is how people end up with forty sessions they cannot tell apart".
//
// What is deliberately not here:
//
//   - **No `session.delete`.** Deleting a conversation is `history.deleteConversation` at **T3** (§4.2), which C11-05 keeps
//     as the one command that destroys history and W15-07 prices with the title typed back. A rename tool that grew a
//     `delete` argument would be a second path to an irreversible act with no confirmation on it, and §4.2's own rule is
//     that "editing an existing job to add T3 steps … is T3" — the tier follows the act, not the tool that carries it.
//   - **No `session.create`.** W15-03's creation is a user act (`POST /api/v1/sessions`, `crabby session new`), and a
//     conversation is also created implicitly by the first task in it. A model that could open conversations at will would
//     fill the list C11-01 exists to keep readable.
//   - **No message or context tools.** `session.list` answers what a conversation is called and what is happening in it;
//     reading its turns needs a message store this build does not have, and `GET /api/v1/sessions/{id}` names that absence
//     in its `absent` list rather than answering `0 turns`.
import type { ToolOutcome, ToolRunContext, ToolSurface } from "@crabby/agent-runtime";
import {
  MAX_TOOL_OUTPUT_BYTES,
  SESSION_ORIGINS,
  type SessionActionCode,
  type SessionRow,
  type ToolDeclaration,
  Type,
  UNNAMED_TITLE,
} from "@crabby/api-contracts";
import { LIMITS_DEFAULTS } from "@crabby/core";
import type { ToolCall } from "@crabby/policy";
import type { ProviderToolSpec } from "@crabby/providers";
import { assertRegistrable } from "./declare.ts";

export const SESSION_LIST_TOOL = "session.list";
export const SESSION_RENAME_TOOL = "session.rename";

/** How many conversations one answer carries. A list a model reads is a list a phone renders, and both have the same
 *  problem with an install that has been running for a year: the tail is not interesting and it costs tokens. */
const LIST_LIMIT = 20;

const DECLARATION_LIST =
  "List this install's conversations, newest activity first, as `session.list` in `PROVIDERS_AND_TOOLS.md` §4.2 (T0, " +
  "needs `session.read`). Each line carries the id, the title, a state word, how many tasks the conversation holds and " +
  "how many are still moving, when it was last active, and which interface created it. Use it to answer 'which " +
  "conversation was that' or to find the id a later action needs — there is no tool that reads a conversation's messages, " +
  "because this build stores no message rows: a conversation's history is its tasks. Filtering by origin is optional and " +
  "takes one of cli, tui, web, telegram. This tool changes nothing.";

const DECLARATION_RENAME =
  "Rename one conversation, as `session.rename` in `PROVIDERS_AND_TOOLS.md` §4.2 (T1, needs `session.write`). The title is " +
  "1-120 characters and replaces the whole title: it is what a person reads in `crabby session ls`, the Web sidebar and " +
  "the TUI switcher, so make it describe the conversation rather than the moment. A conversation with no title yet is " +
  `listed as "${UNNAMED_TITLE}" and takes its title from the first task asked in it, so renaming one is how a user's own ` +
  "words replace that. There is no delete here: destroying a conversation is `history.deleteConversation` at T3 and needs " +
  "a typed confirmation, and a rename tool that could delete would be a second path to an irreversible act.";

const LIST_SCHEMA = Type.Object(
  {
    origin: Type.Optional(
      Type.Union(
        SESSION_ORIGINS.map((name) => Type.Literal(name)),
        {
          description:
            "Only conversations created from this interface. W15-11's attribution, and the filter a user reaches for " +
            "when the list has something in it they did not create.",
        },
      ),
    ),
  },
  { additionalProperties: false },
);

const RENAME_SCHEMA = Type.Object(
  {
    id: Type.String({
      minLength: 4,
      maxLength: 64,
      description: "The `ses_…` id, as `session.list` prints it.",
    }),
    title: Type.String({
      minLength: 1,
      maxLength: 120,
      description:
        "The whole new title. Stored as given, clipped by no rule of this tool's: W15-04's 40 characters is the Web " +
        "control's own limit and W1-02's 24 is a rendering ellipsis, neither of which is a storage rule.",
    }),
  },
  { additionalProperties: false },
);

export type SessionRenameResult =
  | { readonly ok: true; readonly session: SessionRow }
  | { readonly ok: false; readonly code: SessionActionCode; readonly reason: string };

export interface SessionToolOptions {
  /** The page of conversations to answer with, already carrying the state word and title a list line prints. Handed in
   *  rather than imported because `packages/tools` reads no database: the derivation belongs to whoever owns both tables,
   *  and a tool that queried one of them would be a second opinion about what `waiting-approval` means. */
  readonly list: (origin?: string) => readonly SessionRow[];
  /** The write, with the revision comparison inside it. The model never sees a revision: a token it could choose would be
   *  a token it could reuse, and §2's concurrency rule is about two *interfaces*, not about a caller picking a version. */
  readonly rename: (input: { id: string; title: string }) => SessionRenameResult;
  /** D-074's `SQLite busy` row again: both tools cost statements against this device's database and §5.2 prices no
   *  `session.*` class, so the declaration states the budget the store gives them rather than arming a second clock. */
  readonly limits?: {
    readonly sqliteBusyTimeoutMs?: number;
    readonly maxOutputBytes?: number;
  };
}

export interface SessionToolExecutor extends ToolSurface {
  readonly declarations: () => readonly ToolDeclaration[];
  readonly declares: (tool: string) => ToolDeclaration | undefined;
}

export function sessionToolDeclarations(
  limits: SessionToolOptions["limits"] = {},
): readonly ToolDeclaration[] {
  const budget = {
    timeoutMs: limits?.sqliteBusyTimeoutMs ?? LIMITS_DEFAULTS.sqliteBusyTimeoutMs,
    maxOutputBytes: limits?.maxOutputBytes ?? MAX_TOOL_OUTPUT_BYTES,
  };
  return [
    {
      name: SESSION_LIST_TOOL,
      description: DECLARATION_LIST,
      inputSchema: LIST_SCHEMA,
      limits: budget,
      // A read with no writes in it, so §7.3's resume may repeat it as often as it likes and §6.2's evidence for a step
      // abandoned here is that nothing was left behind.
      idempotent: true,
      sideEffects: "none",
    },
    {
      name: SESSION_RENAME_TOOL,
      description: DECLARATION_RENAME,
      inputSchema: RENAME_SCHEMA,
      limits: budget,
      // Idempotent in the sense §7.3 cares about: writing the same title twice ends at the same title. The revision moves,
      // and a client holding the older token learns that from a `stale` refusal rather than from a corrupted row.
      idempotent: true,
      // `local`: the write is to this device's database and leaves it nowhere, but it is a write, and `none` would tell a
      // recovery path there was nothing to be uncertain about.
      sideEffects: "local",
    },
  ];
}

export function createSessionTools(options: SessionToolOptions): SessionToolExecutor {
  const declarations = sessionToolDeclarations(options.limits);
  // §4.1's registration rules at construction, for the reason the other executors run them there: a duplicate id or an
  // unparsable schema is fatal at startup rather than a refusal discovered mid-task.
  assertRegistrable(declarations);
  const byName = new Map(declarations.map((declaration) => [declaration.name, declaration]));

  const specs = (): readonly ProviderToolSpec[] =>
    declarations.map((declaration) => ({
      name: declaration.name,
      description: declaration.description,
      parameters: declaration.inputSchema,
    }));

  const run = (call: ToolCall, ctx: ToolRunContext): ToolOutcome => {
    if (call.tool === SESSION_LIST_TOOL) return list(call);
    if (call.tool === SESSION_RENAME_TOOL) return rename(call, ctx);
    return {
      ok: false,
      output: `'${call.tool}' is not this executor's; it declares ${declarations
        .map((row) => row.name)
        .join(", ")}`,
      code: "unknown-tool",
    };
  };

  function list(call: ToolCall): ToolOutcome {
    const args = call.args as { origin?: unknown };
    if (args.origin !== undefined) {
      if (typeof args.origin !== "string")
        return {
          ok: false,
          output: `'${SESSION_LIST_TOOL}' takes 'origin' as text and was given ${typeof args.origin}`,
          code: "bad-argument",
        };
      if (!(SESSION_ORIGINS as readonly string[]).includes(args.origin))
        return {
          ok: false,
          output:
            `'${args.origin}' is not an interface this install records: ${SESSION_ORIGINS.join(", ")} (W15-11's four, ` +
            "and a filter nobody can spell is a list nobody can trust)",
          code: "bad-argument",
        };
    }
    const rows = options.list(args.origin as string | undefined);
    if (rows.length === 0)
      return {
        ok: true,
        output:
          "no conversations yet. One is created by the first task asked in it, and `crabby session new` creates an empty " +
          "one on purpose — so an empty list here is a fresh install, not a failure",
      };
    const shown = rows.slice(0, LIST_LIMIT);
    const lines = shown.map((row) => {
      const parts = [
        row.id,
        `"${row.titleShown}"`,
        row.stateWord,
        `${row.tasks} task${row.tasks === 1 ? "" : "s"}` +
          (row.runningTasks > 0 ? ` (${row.runningTasks} moving)` : ""),
        `last activity ${row.lastActivityAt}`,
        // W15-11's attribution, and `unknown` for the conversations schema version 6 backfilled from the task table: they
        // were minted by whatever created their first task, in a build that did not write the fact down, and a guess here
        // would read as an attribution.
        row.origin ?? "unknown origin",
        ...(row.model === undefined ? [] : [`model ${row.model}`]),
      ];
      return `  ${parts.join("  ")}`;
    });
    const rest = rows.length - shown.length;
    return {
      ok: true,
      // Not wrapped as untrusted content: this is Crabby's own state — ids, titles, counts and timestamps — and not
      // material from outside the trust boundary (§10). A title did originate with a user, which is inside the boundary
      // too; the model's own objective text is what a session is titled from.
      output:
        `${rows.length} conversation${rows.length === 1 ? "" : "s"}, newest activity first:\n${lines.join("\n")}` +
        (rest > 0
          ? `\n  … and ${rest} more; the list is bounded at ${LIST_LIMIT} because the tail of a year of conversations is not what a question is about`
          : ""),
    };
  }

  function rename(call: ToolCall, ctx: ToolRunContext): ToolOutcome {
    const args = call.args as { id?: unknown; title?: unknown };
    for (const field of ["id", "title"] as const) {
      const value = args[field];
      if (typeof value !== "string" || value.trim() === "")
        return {
          ok: false,
          output:
            `'${SESSION_RENAME_TOOL}' needs a non-empty '${field}' as text` +
            (typeof value === "string" ? "" : ` and was given ${typeof value}`),
          code: "bad-argument",
        };
    }
    const result = options.rename({
      id: (args.id as string).trim(),
      title: (args.title as string).trim(),
    });
    if (!result.ok)
      return {
        ok: false,
        // The store's own sentence, unedited, and its code as the outcome's: `stale` and `not-found` are different fixes
        // and a tool that flattened them would send the model to re-read a row that was never there.
        output: result.reason,
        code: result.code,
      };
    const askedBy = ctx.origin;
    return {
      ok: true,
      output:
        `renamed ${result.session.id} to "${result.session.titleShown}" (revision ${result.session.revision})` +
        (askedBy === undefined
          ? ""
          : `, asked by ${askedBy.clientName} over ${askedBy.interface}`) +
        ". The title is what `crabby session ls`, the Web sidebar and the TUI switcher print, so the change is already " +
        "visible in every interface — nothing to publish and nothing to sync (§14's audit record carries the ask).",
    };
  }

  return {
    specs,
    run,
    declarations: () => declarations,
    declares: (tool: string) => byName.get(tool),
  };
}
