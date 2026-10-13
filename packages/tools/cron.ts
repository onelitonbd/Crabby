// `cron.schedule` — the tool `PROVIDERS_AND_TOOLS.md` §4.2 classifies at **T2** with the note "creating a timer is T2,
// and every step inside the job is still evaluated against policy **each time it runs** — a schedule never inherits or
// pre-buys approval". This file is the executor half of that row, and it is the *only* way a job comes into existence in
// this build, which is a decision rather than a gap: `docs/review/CLI.md` C12-09 records that there is deliberately no
// `crabby job create`, because "two creation paths with different approval semantics is how a schedule escapes review",
// and the two paths the inventories do accept are this tool and a task-detail action in the Web UI (W16-10, M3). A
// `POST /jobs` route would be a third path with no approval at all — the exact escape C12-09 names — so there is no such
// route, and F-57's `schedule` field on `POST /tasks` stays absent for the same reason: a route cannot open an approval,
// because the arbiter's requests are opened by the loop and only by it (D-084).
//
// What that means in practice, and why the T2 is doing real work here: calling this tool parks the task at a prompt. The
// user reads the expression, the objective and the identity it will run under, and answers `once` (D-052). Nothing about
// that answer authorises a single step of any future run — each fire creates a task through the same runner a
// `POST /tasks` reaches, and the loop evaluates every step of it again (§4.5's first rule, kept by the scheduler's shape
// rather than by a promise in this file).
//
// Two things this executor deliberately does not do:
//
//   - **No editing.** §4.2's second sentence — "Editing an existing job to add T3 steps, or changing what it targets, is
//     **T3**" — has no reachable trigger here, because the tool creates and never modifies. `packages/policy/escalation.ts`
//     carries the rule and reads it off `args`, which is a channel the model writes; the day an edit argument exists, that
//     branch has to move to `facts` (D-099: a field that decides a tier is not a field the caller may declare), and the
//     executor is the party that would have to observe them. Recorded rather than implemented, because implementing an
//     edit path means implementing §4.5's re-approval, and re-approval needs a prompt nobody is running.
//   - **No model argument.** §4.5 makes a model or provider change material, and F-57 records that no per-task pin exists
//     to change: a fire runs on whatever `defaultModel` selects. An argument that could not be honoured would be a control
//     the user believes in.
import {
  localStamp,
  type ScheduleInput,
  type ScheduleResult,
  type ToolOutcome,
  type ToolRunContext,
  type ToolSurface,
} from "@crabby/agent-runtime";
import { MAX_TOOL_OUTPUT_BYTES, type ToolDeclaration, Type } from "@crabby/api-contracts";
import { LIMITS_DEFAULTS } from "@crabby/core";
import type { ToolCall } from "@crabby/policy";
import type { ProviderToolSpec } from "@crabby/providers";
import { assertRegistrable } from "./declare.ts";

export const SCHEDULER_TOOL = "cron.schedule";

const GRAMMAR =
  "five fields — minute hour day-of-month month day-of-week — each a comma list of `*`, `*/n`, `a`, `a-b` or `a-b/n`, " +
  "with month and day names allowed (jan-dec, sun-sat)";

const DECLARATION_DESCRIPTION =
  "Create a scheduled job: a task that is created again every time this expression matches, running the objective given " +
  "here. Creating it is a T2 action, so the user approves this call before the job exists. The expression is " +
  `${GRAMMAR}. It is evaluated against the device's own wall clock, not UTC, so \`0 7 * * *\` is seven in the morning ` +
  "where the Gateway runs; a `7` in the day-of-week field is refused rather than read as Sunday, and a seconds field or " +
  "an `@daily` word is refused rather than guessed at. Every run is a fresh policy evaluation: a gated step inside a run " +
  "asks again at run time, and a run that cannot get approval stops and records that it is waiting rather than " +
  "proceeding unattended. Occurrences that pass while the device is off are recorded and never fired in a burst. The job " +
  "runs under the identity that created it and carries only that identity's recorded capabilities, so it gains nothing " +
  "by being a timer. There is no model argument: a run uses the configured default model, because no per-task pin exists " +
  "yet (docs/CONSISTENCY_REVIEW.md F-57). The user's handles afterwards are `crabby job ls`, `crabby job pause <id>` and " +
  "`crabby job backlog <id>`.";

const INPUT_SCHEMA = Type.Object(
  {
    name: Type.String({
      minLength: 1,
      maxLength: 80,
      description:
        "What the user will see in `crabby job ls` and in the approval prompt for every later run. Short and specific: " +
        "a name is how a person recognises a standing authority a month later.",
    }),
    schedule: Type.String({
      minLength: 9,
      maxLength: 120,
      description:
        `The cron expression, ${GRAMMAR}. Refused if this parser cannot read it or if it has no occurrence in ` +
        'the next 1500 days, because a job that can never fire is a row that reads as "soon" forever.',
    }),
    objective: Type.String({
      minLength: 1,
      maxLength: 2000,
      description:
        "The task each run creates, in the words a task takes: what to do, not how. Changing it later is a material " +
        "change that needs re-approval (PROVIDERS_AND_TOOLS.md §4.5), and this tool cannot make one.",
    }),
  },
  { additionalProperties: false },
);

export interface SchedulerToolOptions {
  /** The scheduler's write path. Handed in rather than imported because `ARCHITECTURE.md` §19 runs the dependency the
   *  other way — an executor implements the runtime's abstractions — and because the party that composes a process is the
   *  party that knows whether a scheduler exists in it at all. An executor with no scheduler does not declare this tool,
   *  which is §5.1's "hidden is better than failing" applied to a subsystem rather than to a permission. */
  readonly schedule: (input: ScheduleInput) => ScheduleResult;
  /** D-074's `SQLite busy` row, which is the class this tool's whole cost belongs to: two statements against the job
   *  table and a bounded search for the next occurrence. §5.2 prices no `cron.*` class and its closing paragraph says
   *  what follows from that — "a tool in no class runs under cancellation alone" — so the loop arms no deadline here and
   *  this number is the declaration's own statement of the budget the store gives it, not a second clock. */
  readonly limits?: {
    readonly sqliteBusyTimeoutMs?: number;
    readonly maxOutputBytes?: number;
  };
  readonly now?: () => number;
}

export interface SchedulerToolExecutor extends ToolSurface {
  readonly declarations: () => readonly ToolDeclaration[];
  readonly declares: (tool: string) => ToolDeclaration | undefined;
}

export function schedulerToolDeclarations(
  limits: SchedulerToolOptions["limits"] = {},
): readonly ToolDeclaration[] {
  return [
    {
      name: SCHEDULER_TOOL,
      description: DECLARATION_DESCRIPTION,
      inputSchema: INPUT_SCHEMA,
      limits: {
        timeoutMs: limits?.sqliteBusyTimeoutMs ?? LIMITS_DEFAULTS.sqliteBusyTimeoutMs,
        maxOutputBytes: limits?.maxOutputBytes ?? MAX_TOOL_OUTPUT_BYTES,
      },
      // Not idempotent, and the reason is the timer rather than the row: calling it twice with the same arguments creates
      // two jobs that both fire, and §7.3's resume may only repeat a step whose tool declares itself safe to repeat.
      idempotent: false,
      // `local` and not `none`. The write is to this device's database, but what it creates is work that has not happened
      // yet, so §6.2's cancellation evidence for a step abandoned here must stay uncertain: a job may exist that no
      // outcome reported, and `none` would tell a user nothing was left behind.
      sideEffects: "local",
    },
  ];
}

export function createSchedulerTools(options: SchedulerToolOptions): SchedulerToolExecutor {
  const declarations = schedulerToolDeclarations(options.limits);
  // §4.1's registration rules at construction, for the reason `createFileTools` runs them there: a duplicate id or an
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
    if (call.tool !== SCHEDULER_TOOL)
      return {
        ok: false,
        output: `'${call.tool}' is not this executor's; it declares ${declarations.map((row) => row.name).join(", ")}`,
        code: "unknown-tool",
      };
    const args = call.args as { name?: unknown; schedule?: unknown; objective?: unknown };
    for (const field of ["name", "schedule", "objective"] as const) {
      const value = args[field];
      if (typeof value !== "string" || value.trim() === "")
        return {
          ok: false,
          output:
            `'${call.tool}' needs a non-empty '${field}' as text` +
            (typeof value === "string" ? "" : ` and was given ${typeof value}`),
          code: "bad-argument",
        };
    }
    // §4.5's audit rule, enforced by refusing rather than by defaulting: a job must name a person, and the only party
    // that knows who asked is the run's own origin. A `createdBy` invented here would be a job that runs under nobody,
    // which is the substitution the sentence exists to forbid — and the identity is read from `ctx`, not from `call.args`,
    // because §10's rule that a declared field is never an authority applies with full force to a field that decides who
    // is authorising a standing timer.
    const origin = ctx.origin;
    if (origin === undefined)
      return {
        ok: false,
        output:
          `'${call.tool}' cannot record a job for this run: the run carries no identity, and §4.5 requires a job to run ` +
          "under the identity that created it so the audit record names a person rather than 'cron'. Ask for the schedule " +
          "from a task a paired client started.",
        code: "no-identity",
      };
    const result = options.schedule({
      name: (args.name as string).trim(),
      schedule: (args.schedule as string).trim(),
      objective: (args.objective as string).trim(),
      sessionId: origin.sessionId,
      createdBy: {
        clientId: origin.clientId,
        name: origin.clientName,
        interface: origin.interface,
      },
      capabilities: origin.capabilities,
      at: (options.now ?? Date.now)(),
    });
    if (!result.ok)
      return {
        ok: false,
        // The scheduler's own sentence, unedited: it names the grammar or the missing occurrence, and a tool that
        // rephrased a refusal would be a second voice telling the model why it was denied.
        output: result.reason,
        code: result.code,
      };
    const job = result.job;
    const stamp = job.nextRunAt === undefined ? "none" : localStamp(Date.parse(job.nextRunAt));
    // Not wrapped as untrusted content, and the distinction is §10's rather than a preference: this output is Crabby's
    // own state — an id, an expression the caller supplied, a timestamp this process computed — and not material from
    // outside the trust boundary. The objective text originated with the model, so echoing it back to the model cannot
    // teach it anything it did not already say.
    return {
      ok: true,
      output:
        `scheduled job ${job.id} — "${job.name}"\n` +
        `  schedule   ${job.schedule} (device local time, recorded at UTC${offsetStamp(job.utcOffsetMinutes)})\n` +
        `  next run   ${stamp}\n` +
        `  runs as    ${job.createdBy.name} (${job.createdBy.interface}), ` +
        `${job.capabilities.length} capabilities recorded\n` +
        `  objective  ${job.objective}\n` +
        "Every run is a fresh policy evaluation: a gated step inside one asks again at run time, and a run that cannot " +
        "get approval stops and records that it is waiting (§4.5). Occurrences missed while the device was off are " +
        "recorded and not fired. The user's handles are `crabby job ls`, `crabby job pause " +
        `${job.id}\` and \`crabby job backlog ${job.id}\`.`,
    };
  };

  return {
    specs,
    run,
    declarations: () => declarations,
    declares: (tool: string) => byName.get(tool),
  };
}

/** The recorded creation offset as a person writes it, beside a next fire rendered in the zone the schedule is evaluated
 *  in — the pair D-103 puts in front of a user whose device has since moved. */
function offsetStamp(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const absolute = Math.abs(minutes);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}
