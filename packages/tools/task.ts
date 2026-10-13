// `task.create`, `task.status` and `task.cancel` — the three rows `PROVIDERS_AND_TOOLS.md` §4.2 prices for a run that
// wants to act on work rather than only on files, at **T1**, **T0** and **T1**. This file is their executor half.
//
// Two of the three are already priced a second time by `packages/policy/escalation.ts`, and this executor is the party
// that has to *honour* those prices rather than merely exist beside them: `task.cancel` with `crossSession` or `all` is
// **T2** ("cross-session or cancel-all, §4.2"), so a run that did not declare the argument gets a refusal naming the
// argument instead of a cancellation it was not approved for. That is D-099's rule from the other side — the escalation
// reads the intent the model declared, and the executor refuses the act the declaration did not cover.
//
// What this file deliberately does not do:
//
//   - **It does not create a task itself.** `create` is a sink, bound by `packages/gateway/app.ts` to the same
//     `recordAndDriveTask` that `POST /api/v1/tasks` and the scheduler's `fire` reach, because a task created by a tool
//     has to arrive with the same journal, the same arbiter, the same queue limits and the same policy evaluation as one
//     a client asked for. A second creation path in here would be the defect C12-09 refuses for jobs, wearing a different
//     noun (D-105).
//   - **It does not read the database.** `read` is a sink too, so the state and history a model is told about are the
//     state and history the routes answer with — one derivation, one owner of both tables.
//   - **It never claims a stop it did not see.** §6's rule for `crabby task cancel` is that the command asks and then
//     reports, and a tool that answered "cancelled" for a request the loop has not settled yet would be the same lie with
//     a model as its audience. The output says which of the two happened, in the manager's own words.
import type { ToolOutcome, ToolRunContext, ToolSurface } from "@crabby/agent-runtime";
import {
  type ClientInterface,
  MAX_TOOL_OUTPUT_BYTES,
  type TaskRecord,
  type ToolDeclaration,
  Type,
} from "@crabby/api-contracts";
import { LIMITS_DEFAULTS } from "@crabby/core";
import type { ToolCall } from "@crabby/policy";
import type { ProviderToolSpec } from "@crabby/providers";
import { assertRegistrable } from "./declare.ts";

export const TASK_CREATE_TOOL = "task.create";
export const TASK_STATUS_TOOL = "task.status";
export const TASK_CANCEL_TOOL = "task.cancel";

/** How much of a task's history `task.status` carries. §4.2's alias for the row is `task.history`, so the events are the
 *  point of the call, but a task at step forty has forty of them and a tool output is read by a model with a budget: eight
 *  is enough to see what a run is doing and what it just did, and the row says where the rest are. Exported, and named in
 *  the declaration's own text below, so the number a model is promised and the number the sink is asked for cannot drift —
 *  a description that said "eight" over a limit of twenty would be the tool lying about its own output. */
export const TASK_HISTORY_EVENTS = 8;

/** Every way one of the three can refuse. Kept in one union because the routes price refusals by class
 *  (`packages/gateway/errors.ts`) and a tool that invented a code per call site would give a model twelve words for two
 *  ideas. */
export const TASK_TOOL_CODES = [
  "not-found",
  "terminal",
  "cross-session",
  "no-drive",
  "unavailable",
  "refused",
] as const;
export type TaskToolCode = (typeof TASK_TOOL_CODES)[number];

/** What a read answers with: the record, the conversation it belongs to (which is what the cross-session guard compares),
 *  and a bounded tail of its history. The shape is deliberately structural rather than imported from `packages/gateway`,
 *  because §19's dependency direction forbids the tool package from knowing what a route is (D-105): the composition root
 *  answers it from `getTask` and `readReplayWindow`, the same two reads the task routes answer with. */
export interface TaskToolRead {
  readonly task: TaskRecord;
  readonly sessionId: string;
  /** The newest events, oldest first, as `readReplayWindow` returns them. */
  readonly events: readonly { readonly type: string; readonly ts: string; readonly seq: number }[];
  /** How many the task has recorded in total, which is `task.lastSeq`: §5.2's counter starts at 1 (D-079), so `lastSeq`
   *  *is* the count and no second query has to agree with it. */
  readonly eventCount: number;
}

export type TaskToolCreateResult =
  | {
      readonly ok: true;
      readonly task: TaskRecord;
      /** Whether this Gateway composed a runner. `false` means the task was recorded and nothing will move it, which the
       *  output has to say: a model that believed it had started work would report work that is not happening. */
      readonly driven: boolean;
      readonly withheld: readonly { readonly capability: string; readonly reason: string }[];
      /** Present when a runner exists but declined to start this run — D-023's queue limits, or a drain already under
       *  way. The task stays `queued`, which is the truth rather than a shrug (§7.1's recovery marks it `interrupted` on
       *  the next start), and a tool that printed "created and running" would be reporting a run nobody is executing. */
      readonly startRefused?: { readonly code: string; readonly reason: string } | undefined;
    }
  | { readonly ok: false; readonly code: TaskToolCode; readonly reason: string };

/** `CancellationResult` as a tool may see it: the manager's own refusal sentence is carried through verbatim, and its four
 *  failure codes are narrowed to two because a model has no use for the difference between "already terminal" and "the
 *  settle already happened" — both mean §4.1's absorbing state got there first, and the sentence says which. */
export type TaskToolCancelResult =
  | {
      readonly ok: true;
      readonly task: TaskRecord;
      /** True when this call moved the task to `cancelled`; false when the settle is the loop's to make (§6.2). */
      readonly settled: boolean;
      readonly deduplicated?: boolean;
      readonly escalated?: boolean;
    }
  | { readonly ok: false; readonly code: TaskToolCode; readonly reason: string };

export interface TaskToolOptions {
  readonly create: (input: {
    readonly objective: string;
    readonly sessionId: string;
    readonly origin: TaskToolOrigin;
  }) => TaskToolCreateResult;
  readonly read: (taskId: string) => TaskToolRead | undefined;
  readonly cancel: (input: {
    readonly taskId: string;
    readonly mode?: "finish-step" | "immediate";
    readonly reason?: string;
    readonly origin: TaskToolOrigin;
  }) => TaskToolCancelResult;
  /** `all: true` is §4.2's T2 half, and it is a separate sink because "cancel every non-terminal task" is one decision
   *  about the whole queue rather than a loop the model has to drive: the answer has to say how many it reached, and a
   *  model that had to enumerate ids first would need a list of every running task before it could stop them. Refusals
   *  travel inside the list, per task, because one task that had already settled must not hide the four that were asked. */
  readonly cancelAll: (input: {
    readonly mode?: "finish-step" | "immediate";
    readonly reason?: string;
    readonly origin: TaskToolOrigin;
  }) => { readonly results: readonly TaskToolCancelResult[] };
  readonly limits?: {
    readonly sqliteBusyTimeoutMs?: number;
    readonly maxOutputBytes?: number;
  };
}

/** The identity a call acts under, taken from the run's own origin. It arrives through the context and never through the
 *  arguments, for the reason `cron.schedule`'s does: a field the model could write would be a field the model could
 *  widen, and here it would decide whose task a cancellation is recorded against (§14). */
export interface TaskToolOrigin {
  readonly clientId: string;
  readonly clientName: string;
  /** The interface the identity was paired for, as the run's origin recorded it. Typed as the contract's own union rather
   *  than as `string` because the sink hands it to `DriveTaskInput.origin`, and a wider type here would make the honest
   *  composition fail to typecheck while a narrower one would let an executor invent a fifth interface. */
  readonly interface: ClientInterface;
  readonly capabilities: readonly string[];
  readonly sessionId: string;
}

export interface TaskToolExecutor extends ToolSurface {
  readonly declarations: () => readonly ToolDeclaration[];
  readonly declares: (tool: string) => ToolDeclaration | undefined;
}

const DECLARATION_CREATE =
  "Create a task and hand it to this Gateway's runner, as `task.create` in `PROVIDERS_AND_TOOLS.md` §4.2 (T1, needs " +
  "`task.create`). The new task is priced on its own steps and does not inherit this run's tier, so a task that needs a " +
  "T2 step will ask the user for it itself. It runs in this conversation unless `sessionId` names another one, under the " +
  "same identity that started this run — a tool call cannot create work for somebody else. The answer says whether this " +
  "Gateway is driving tasks at all, because a recorded task in a Gateway with no runner is a task that will never move. " +
  "Prefer finishing the step you are on: a task per sub-step fills the queue with work nobody asked to watch.";

const DECLARATION_STATUS =
  "Read one task's state and the tail of its history, as `task.status` in `PROVIDERS_AND_TOOLS.md` §4.2 (T0, needs " +
  "`task.read`; §4.2's alias for this row is `task.history`, and the events are why). The answer carries the state, " +
  "the objective, when it moved last, any error or cancellation evidence on the record, and the last " +
  String(TASK_HISTORY_EVENTS) +
  " events with their `seq` numbers. It reads the same record `GET /api/v1/tasks/{id}` answers with, so what you " +
  "are told is what a user watching the same task is shown. This tool changes nothing.";

const DECLARATION_CANCEL =
  "Ask for one task to stop, as `task.cancel` in `PROVIDERS_AND_TOOLS.md` §4.2 (T1, needs `task.cancel`). This *asks*: " +
  "§6.1's default mode finishes the step in flight and the loop settles the task, so the answer says whether the stop " +
  'already happened or is the loop\'s to make, and never claims a cancellation it did not see. `mode: "immediate"` is ' +
  "§6.2's override for a safety-critical intervention and abandons the step in flight, which is why the answer then " +
  "reports what was in flight and whether the effects are certain. `reason` goes on the record with the request. By " +
  "default the task must be in *this* conversation: cancelling one in another conversation needs `crossSession: true`, " +
  "and cancelling every non-terminal task needs `all: true` — both are **T2** (§4.2), so both need an approval the user " +
  "read, and declaring one you were not approved for gets a refusal naming the argument.";

const CREATE_SCHEMA = Type.Object(
  {
    objective: Type.String({
      minLength: 1,
      maxLength: 4000,
      description:
        "What the new task is for, in the words a user would recognise: this becomes the task's objective and, if the " +
        "conversation has no title yet, its title (W15-03).",
    }),
    sessionId: Type.Optional(
      Type.String({
        minLength: 4,
        maxLength: 64,
        description:
          "Another conversation to create the task in. Absent means this run's own conversation, which is what a " +
          "sub-step of the current question belongs in.",
      }),
    ),
  },
  { additionalProperties: false },
);

const STATUS_SCHEMA = Type.Object(
  {
    taskId: Type.String({
      minLength: 4,
      maxLength: 64,
      description: "The `tsk_…` id, as `task.create` answered with or as the user gave it.",
    }),
  },
  { additionalProperties: false },
);

const CANCEL_SCHEMA = Type.Object(
  {
    taskId: Type.Optional(
      Type.String({
        minLength: 4,
        maxLength: 64,
        description: "The task to stop. Required unless `all` is true.",
      }),
    ),
    all: Type.Optional(
      Type.Boolean({
        description:
          "Cancel every non-terminal task in this install. **T2** (§4.2): an approval the user read has to cover it.",
      }),
    ),
    crossSession: Type.Optional(
      Type.Boolean({
        description:
          "Allow a `taskId` that belongs to another conversation. **T2** (§4.2). Without it a task outside this " +
          "conversation is refused, because the approval this run holds was for the work in front of the user.",
      }),
    ),
    mode: Type.Optional(
      Type.Union([Type.Literal("finish-step"), Type.Literal("immediate")], {
        description:
          "§6.1's default is `finish-step`; `immediate` is §6.2's override and abandons the step in flight, so the " +
          "answer reports what was in flight and whether its effects are certain.",
      }),
    ),
    reason: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 500,
        description: "Why, in words a user will read on the record beside the request (§14).",
      }),
    ),
  },
  { additionalProperties: false },
);

export function taskToolDeclarations(
  limits: TaskToolOptions["limits"] = {},
): readonly ToolDeclaration[] {
  const budget = {
    timeoutMs: limits?.sqliteBusyTimeoutMs ?? LIMITS_DEFAULTS.sqliteBusyTimeoutMs,
    maxOutputBytes: limits?.maxOutputBytes ?? MAX_TOOL_OUTPUT_BYTES,
  };
  return [
    {
      name: TASK_CREATE_TOOL,
      description: DECLARATION_CREATE,
      inputSchema: CREATE_SCHEMA,
      limits: budget,
      // Calling it twice creates two tasks, and both run: §7.3's resume may not repeat a step whose evidence is
      // ambiguous, and a queue with a duplicate in it is work the user did not ask for twice.
      idempotent: false,
      sideEffects: "local",
    },
    {
      name: TASK_STATUS_TOOL,
      description: DECLARATION_STATUS,
      inputSchema: STATUS_SCHEMA,
      limits: budget,
      idempotent: true,
      sideEffects: "none",
    },
    {
      name: TASK_CANCEL_TOOL,
      description: DECLARATION_CANCEL,
      inputSchema: CANCEL_SCHEMA,
      limits: budget,
      // A second request for the same task returns the first one rather than conflicting, which is what makes this safe to
      // repeat — but "safe to repeat" is not "does nothing", so the flag says idempotent and the output still says which
      // of the two happened.
      idempotent: true,
      sideEffects: "local",
    },
  ];
}

export function createTaskTools(options: TaskToolOptions): TaskToolExecutor {
  const declarations = taskToolDeclarations(options.limits);
  assertRegistrable(declarations);
  const byName = new Map(declarations.map((declaration) => [declaration.name, declaration]));

  const specs = (): readonly ProviderToolSpec[] =>
    declarations.map((declaration) => ({
      name: declaration.name,
      description: declaration.description,
      parameters: declaration.inputSchema,
    }));

  const run = (call: ToolCall, ctx: ToolRunContext): ToolOutcome => {
    const origin = originOf(ctx);
    if (origin === undefined)
      return {
        ok: false,
        output:
          `'${call.tool}' needs the identity this run belongs to and the context carries none. §14's audit records name ` +
          'a person rather than "a tool call": a task created by nobody would run under no authority, and a cancellation ' +
          "recorded against nobody could not be answered for later.",
        code: "no-identity",
      };
    if (call.tool === TASK_CREATE_TOOL) return create(call, origin);
    if (call.tool === TASK_STATUS_TOOL) return status(call);
    if (call.tool === TASK_CANCEL_TOOL) return cancel(call, origin);
    return {
      ok: false,
      output: `'${call.tool}' is not this executor's; it declares ${declarations
        .map((row) => row.name)
        .join(", ")}`,
      code: "unknown-tool",
    };
  };

  function create(call: ToolCall, origin: TaskToolOrigin): ToolOutcome {
    const args = call.args as { objective?: unknown; sessionId?: unknown };
    if (typeof args.objective !== "string" || args.objective.trim() === "")
      return {
        ok: false,
        output:
          `'${TASK_CREATE_TOOL}' needs an 'objective' as non-empty text — it is what the new task is for, and a ` +
          "task with no objective has nothing for policy to price",
        code: "bad-argument",
      };
    if (args.sessionId !== undefined && typeof args.sessionId !== "string")
      return {
        ok: false,
        output: `'${TASK_CREATE_TOOL}' takes 'sessionId' as text and was given ${typeof args.sessionId}`,
        code: "bad-argument",
      };
    const result = options.create({
      objective: args.objective.trim(),
      sessionId: (args.sessionId as string | undefined)?.trim() || origin.sessionId,
      origin,
    });
    if (!result.ok) return { ok: false, output: result.reason, code: result.code };
    const lines = [
      `created task ${result.task.id} in session ${result.task.sessionId}`,
      `state ${result.task.state}`,
    ];
    if (!result.driven)
      lines.push(
        "this Gateway composed no runner, so the task is recorded and nothing will move it — report that rather than " +
          "the work as done",
      );
    if (result.startRefused !== undefined)
      lines.push(
        `the runner declined to start this run (${result.startRefused.code}): ${result.startRefused.reason} — the task ` +
          "stays `queued`, so report it as waiting rather than as running",
      );
    for (const held of result.withheld)
      lines.push(`capability held with no grant: ${held.capability} — ${held.reason}`);
    lines.push(
      `a fresh policy evaluation prices every step it takes, so it will ask the user for whatever it needs; ` +
        `\`task.status\` on ${result.task.id} reads how it is going`,
    );
    return { ok: true, output: lines.join("\n") };
  }

  function status(call: ToolCall): ToolOutcome {
    const args = call.args as { taskId?: unknown };
    if (typeof args.taskId !== "string" || args.taskId.trim() === "")
      return {
        ok: false,
        output: `'${TASK_STATUS_TOOL}' needs a 'taskId' as text — the \`tsk_…\` id \`task.create\` answered with`,
        code: "bad-argument",
      };
    const read = options.read(args.taskId.trim());
    if (read === undefined)
      return {
        ok: false,
        output: `no task ${args.taskId.trim()} — \`crabby task ls\` prints the ids this install holds`,
        code: "not-found",
      };
    const { task } = read;
    const lines = [
      `task ${task.id}  ${task.state}  session ${read.sessionId}`,
      `objective: ${task.objective}`,
      `created ${task.createdAt}, last moved ${task.updatedAt}, last event seq ${task.lastSeq}`,
    ];
    if (task.error !== undefined) lines.push(`error: ${task.error.code} — ${task.error.message}`);
    if (task.cancellation !== undefined) {
      const { cancellation } = task;
      lines.push(
        `cancellation: ${cancellation.mode} requested at ${cancellation.requestedAt}` +
          (cancellation.settledAt === undefined
            ? " — recorded, not settled yet (§6.1's request phase)"
            : ` — settled at ${cancellation.settledAt}, ${cancellation.inFlight ?? "unknown"} was in flight, ` +
              `terminated ${cancellation.terminated === true ? "yes" : "no"}, ` +
              `effects uncertain ${cancellation.effectsUncertain === true ? "yes" : "no"}`),
      );
    }
    if (read.events.length === 0) lines.push("history: no events recorded yet");
    else {
      const first = read.events[0]?.seq ?? 0;
      const last = read.events[read.events.length - 1]?.seq ?? first;
      lines.push(
        `history: seq ${first}–${last}, the newest ${read.events.length} of ${read.eventCount} recorded, oldest first`,
        ...read.events.map((event) => `  seq ${event.seq}  ${event.type}  ${event.ts}`),
      );
      if (first > 1)
        lines.push(
          `  … seq 1–${first - 1} are earlier on the record (or were pruned by D-065's retention); ` +
            "`GET /api/v1/events?taskId=` streams them and `crabby task show` prints the tail",
        );
    }
    return { ok: true, output: lines.join("\n") };
  }

  function cancel(call: ToolCall, origin: TaskToolOrigin): ToolOutcome {
    const args = call.args as {
      taskId?: unknown;
      all?: unknown;
      crossSession?: unknown;
      mode?: unknown;
      reason?: unknown;
    };
    const all = args.all === true;
    const crossSession = args.crossSession === true;
    if (!all && (typeof args.taskId !== "string" || args.taskId.trim() === ""))
      return {
        ok: false,
        output:
          `'${TASK_CANCEL_TOOL}' needs a 'taskId' as text, or \`all: true\` to cancel every non-terminal task — and ` +
          "`all` is T2 (§4.2), so it needs an approval that covered it",
        code: "bad-argument",
      };
    if (args.mode !== undefined && args.mode !== "finish-step" && args.mode !== "immediate")
      return {
        ok: false,
        output: `'${args.mode}' is not a cancellation mode: §6.1's default is 'finish-step' and §6.2's override is 'immediate'`,
        code: "bad-argument",
      };
    if (args.reason !== undefined && typeof args.reason !== "string")
      return {
        ok: false,
        output: `'${TASK_CANCEL_TOOL}' takes 'reason' as text and was given ${typeof args.reason}`,
        code: "bad-argument",
      };
    const mode = args.mode as "finish-step" | "immediate" | undefined;
    const reason = args.reason as string | undefined;

    if (all) {
      // §4.2's T2 half. The executor cannot check the approval — policy already did, before this call was allowed to run
      // — but it can refuse to *widen* it: `all` reaches tasks in every conversation, so the guard below is about the
      // argument that was declared, and an undeclared `all` never gets here at all.
      const result = options.cancelAll({
        ...(mode === undefined ? {} : { mode }),
        ...(reason === undefined ? {} : { reason }),
        origin,
      });
      const asked = result.results.filter((entry) => entry.ok);
      const refused = result.results.filter((entry) => !entry.ok);
      const conversations = new Set(asked.map((entry) => (entry.ok ? entry.task.sessionId : "")));
      const lines = [
        `asked every non-terminal task to stop: ${asked.length} request(s) recorded across ` +
          `${conversations.size} conversation(s), ${refused.length} refused`,
        ...asked.map((entry) =>
          entry.ok
            ? `  ${entry.task.id} (session ${entry.task.sessionId}) — ${
                entry.settled
                  ? "already `cancelled`"
                  : "requested; the loop settles it at the step boundary (§6.1)"
              }${entry.deduplicated === true ? " (a request was already recorded)" : ""}`
            : "",
        ),
        ...refused.map((entry) => (entry.ok ? "" : `  refused: ${entry.reason}`)),
      ];
      if (asked.length === 0 && refused.length === 0)
        lines.push("no task in this install was non-terminal, so nothing was asked to stop");
      lines.push(
        "a request is not a stop: §6.2's evidence for each task says what was in flight when it was asked, and " +
          "`task.status` reads whether the settle happened",
      );
      return { ok: true, output: lines.filter((line) => line !== "").join("\n") };
    }

    const taskId = (args.taskId as string).trim();
    // The cross-session guard, in the executor rather than in the sink: the fact it compares is the conversation the run
    // belongs to, which only the context carries, and a sink that guessed it would be a second place the rule could be
    // wrong. §4.2 prices crossing at T2, so an undeclared crossing is refused with the argument named — the same shape as
    // a capability the identity does not hold.
    const read = options.read(taskId);
    if (read === undefined)
      return {
        ok: false,
        output: `no task ${taskId} — \`crabby task ls\` prints the ids this install holds`,
        code: "not-found",
      };
    if (read.sessionId !== origin.sessionId && !crossSession)
      return {
        ok: false,
        output:
          `task ${taskId} belongs to session ${read.sessionId} and this run belongs to ${origin.sessionId}: cancelling ` +
          "across conversations is T2 (§4.2), so it needs `crossSession: true` and an approval that covered it. The " +
          "approval this run holds was for the work in front of the user, not for every conversation on the device",
        code: "cross-session",
      };
    const result = options.cancel({
      taskId,
      ...(mode === undefined ? {} : { mode }),
      ...(reason === undefined ? {} : { reason }),
      origin,
    });
    if (!result.ok) return { ok: false, output: result.reason, code: result.code };
    const lines = [
      result.settled
        ? `task ${result.task.id} is \`cancelled\``
        : `asked task ${result.task.id} to stop; the loop settles it at the step boundary (§6.1)`,
    ];
    if (result.deduplicated === true)
      lines.push(
        "a request was already recorded for this task, so no second event was emitted — one cancellation is one fact",
      );
    if (result.escalated === true)
      lines.push("an earlier finish-step request was overridden by this immediate one (§6.2)");
    // §6.2's evidence is rendered from the record the manager wrote rather than from a sentence this file invents: when
    // the settle has happened the record carries what was in flight and whether the effects are certain, and when it has
    // not, saying so *is* the honest answer — a tool that printed "stopped" for a request the loop has not reached yet
    // would be the lie §6 exists to prevent, with a model as its audience.
    const evidence = result.task.cancellation;
    if (!result.settled)
      lines.push(
        "the task is `cancelling`: the step in flight finishes, then the loop settles it and writes §6.2's evidence to " +
          "the record — `task.status` reads it back",
      );
    else if (evidence !== undefined)
      lines.push(
        `§6.2's evidence on the record: ${evidence.inFlight ?? "unknown"} was in flight, terminated ` +
          `${evidence.terminated === true ? "yes" : "no"}, effects uncertain ` +
          `${evidence.effectsUncertain === true ? "yes" : "no"}; the \`task.cancelled\` event carries §6.1's checkpoint ` +
          "sentence beside it",
      );
    return { ok: true, output: lines.join("\n") };
  }

  return {
    specs,
    run,
    declarations: () => declarations,
    declares: (tool: string) => byName.get(tool),
  };
}

function originOf(ctx: ToolRunContext): TaskToolOrigin | undefined {
  const origin = ctx.origin;
  if (origin === undefined) return undefined;
  return {
    clientId: origin.clientId,
    clientName: origin.clientName,
    interface: origin.interface,
    capabilities: [...origin.capabilities],
    sessionId: origin.sessionId,
  };
}
