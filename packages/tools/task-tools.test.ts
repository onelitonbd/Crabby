// The task executor: `PROVIDERS_AND_TOOLS.md` §4.2's three rows for acting on work rather than on files. Asserted as the
// sentences it enforces, which is what a separate file is for — `tools.test.ts`'s subject is a real filesystem and this
// one has no database, no runner and no Gateway in it. Its subject is what a model is offered, what it is told when an
// answer is no, and the two rules that make these three rows different from the other ten:
//
//   - **§4.2's second price on `task.cancel`.** `crossSession` and `all` are T2, and `packages/policy/escalation.ts`
//     already reads them out of the arguments to decide the tier. What policy cannot do is refuse the *act*: it prices a
//     call before the call runs, so the executor is the party that has to decline a crossing the declaration did not
//     cover. A tool that handed every id to the manager would make the T2 price a sentence in a table rather than a
//     control (D-099's rule, from the other side).
//   - **§6's "asks, then reports".** A cancellation request is not a stop. The output has to say which of the two
//     happened, because the reader here is a model that will tell the user what it did — and "I cancelled it" for a
//     request the loop has not settled yet is the exact lie §6.2's evidence exists to prevent.
//
// What is deliberately *not* asserted here: that a created task runs, that a cancellation reaches a real manager, that a
// read answers from a real journal. Those are the sinks, and they belong to the Gateway that owns them — which is why
// `tests/integration/task-tools.test.ts` composes the four surfaces the way `crabby gateway start` does and asserts the
// seam (D-105) instead of this file pretending a fake sink proves it.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { RunOrigin, ToolRunContext } from "@crabby/agent-runtime";
import type { TaskRecord } from "@crabby/api-contracts";
import { LIMITS_DEFAULTS } from "@crabby/core";
import { PENDING_RECORD_FIELDS } from "@crabby/policy";
import {
  combineToolSurfaces,
  createFileTools,
  createSchedulerTools,
  createSessionTools,
  createTaskTools,
  TASK_CANCEL_TOOL,
  TASK_CREATE_TOOL,
  TASK_HISTORY_EVENTS,
  TASK_STATUS_TOOL,
  type TaskToolCancelResult,
  type TaskToolCreateResult,
  type TaskToolOptions,
  type TaskToolRead,
} from "./index.ts";

const ORIGIN: RunOrigin = {
  clientId: "cli_1",
  clientName: "the owner",
  interface: "cli",
  capabilities: ["task.create", "task.read", "task.cancel"],
  sessionId: "ses_here",
};

function context(origin: RunOrigin | null = ORIGIN): ToolRunContext {
  return {
    taskId: "tsk_harness1",
    signal: new AbortController().signal,
    deadlineMs: undefined,
    ...(origin === null ? {} : { origin }),
  };
}

function record(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "tsk_one",
    sessionId: "ses_here",
    state: "queued",
    objective: "summarise the notes",
    createdAt: "2026-10-13T02:00:00.000Z",
    updatedAt: "2026-10-13T02:00:00.000Z",
    lastSeq: 0,
    ...overrides,
  };
}

/** A read of a task with `events` recorded, of which the newest `TASK_HISTORY_EVENTS` are carried — the shape the
 *  composition root answers from `getTask` and `readReplayWindow`. */
function readOf(task: TaskRecord, events: number): TaskToolRead {
  const from = Math.max(1, events - TASK_HISTORY_EVENTS + 1);
  return {
    task: { ...task, lastSeq: events },
    sessionId: task.sessionId,
    events: Array.from({ length: Math.max(0, events - from + 1) }, (_, index) => ({
      type: "step.recorded",
      ts: "2026-10-13T02:00:01.000Z",
      seq: from + index,
    })),
    eventCount: events,
  };
}

interface Lab {
  /** Every argument set the sinks were handed, in order, so a test can assert what the executor *asked for* rather than
   *  only what it printed: the identity a cancellation is attributed to and the conversation a task is created in are
   *  facts about the sink call, and §14's audit is only as good as them. */
  readonly calls: { tool: string; args: Record<string, unknown> }[];
  createWith?: TaskToolCreateResult | undefined;
  readWith?: TaskToolRead | undefined;
  cancelWith?: TaskToolCancelResult | undefined;
  cancelAllWith?: { results: readonly TaskToolCancelResult[] } | undefined;
  readonly tools: ReturnType<typeof createTaskTools>;
}

function lab(): Lab {
  const calls: Lab["calls"] = [];
  const self: Lab = {
    calls,
    createWith: undefined,
    readWith: undefined,
    cancelWith: undefined,
    cancelAllWith: undefined,
    get tools() {
      return tools;
    },
  };
  const options: TaskToolOptions = {
    create: (input) => {
      calls.push({ tool: TASK_CREATE_TOOL, args: { ...input } as Record<string, unknown> });
      return (
        self.createWith ?? {
          ok: true,
          task: record({ id: "tsk_new", objective: input.objective, sessionId: input.sessionId }),
          driven: true,
          withheld: [],
        }
      );
    },
    read: (taskId) => {
      calls.push({ tool: TASK_STATUS_TOOL, args: { taskId } });
      return self.readWith;
    },
    cancel: (input) => {
      calls.push({ tool: TASK_CANCEL_TOOL, args: { ...input } as Record<string, unknown> });
      return (
        self.cancelWith ?? {
          ok: true,
          task: record({ id: input.taskId, state: "cancelling" }),
          settled: false,
        }
      );
    },
    cancelAll: (input) => {
      calls.push({
        tool: `${TASK_CANCEL_TOOL}#all`,
        args: { ...input } as Record<string, unknown>,
      });
      return (
        self.cancelAllWith ?? {
          results: [
            { ok: true, task: record({ id: "tsk_a", state: "cancelling" }), settled: false },
            { ok: true, task: record({ id: "tsk_b", state: "cancelled" }), settled: true },
          ],
        }
      );
    },
  };
  const tools = createTaskTools(options);
  return self;
}

async function output(
  tools: Lab["tools"],
  tool: string,
  args: Record<string, unknown>,
  ctx = context(),
) {
  const outcome = await tools.run({ tool, args }, ctx);
  return outcome;
}

test("declares §4.2's three task rows, with the fields only a runtime can answer", () => {
  const tools = lab().tools;
  const declarations = tools.declarations();
  assert.deepEqual(
    declarations.map((row) => row.name),
    [TASK_CREATE_TOOL, TASK_STATUS_TOOL, TASK_CANCEL_TOOL],
    "the three names §4.2 prices, and no fourth: a `task.resume` here would be F-47's absent route wearing a tool's " +
      "clothes, and §7.1's recovery marks an interrupted task rather than resurrecting it",
  );
  for (const declaration of declarations) {
    assert.equal(
      declaration.limits.timeoutMs,
      LIMITS_DEFAULTS.sqliteBusyTimeoutMs,
      `${declaration.name} costs statements against this device's database, so D-074's \`SQLite busy\` row is the ` +
        "budget it declares — §5.2 prices no `task.*` class, and inventing one here would be a number no document " +
        "promises",
    );
    assert.equal(
      declaration.outputSchema,
      undefined,
      `${declaration.name} declares no outputSchema: §4.1 makes it optional, and an empty one would pretend to validate ` +
        "an answer these tools render as prose for a model to read",
    );
    const answered = declaration as unknown as Record<string, unknown>;
    assert.deepEqual(
      PENDING_RECORD_FIELDS.filter((field) => answered[field] === undefined),
      ["outputSchema"],
      `${declaration.name} answers four of §4.1's five runtime fields and names the fifth as pending, which is F-55's ` +
        "asymmetry rather than a gap: `GET /tools` merges what an executor owns and prints the rest as pending",
    );
  }
  const byName = new Map(declarations.map((row) => [row.name, row]));
  // `task.status` is the one of the three that changes nothing, and §6.2's cancellation evidence is decided by exactly
  // this field: a step abandoned while a read was in flight has no external effects to be uncertain about.
  assert.equal(byName.get(TASK_STATUS_TOOL)?.sideEffects, "none");
  assert.equal(byName.get(TASK_STATUS_TOOL)?.idempotent, true);
  // Creating a task twice creates two tasks, and both run — so the flag has to be false and §7.3's resume may not repeat
  // the step. The scheduler's `cron.schedule` declares the same thing for the same reason.
  assert.equal(byName.get(TASK_CREATE_TOOL)?.sideEffects, "local");
  assert.equal(byName.get(TASK_CREATE_TOOL)?.idempotent, false);
  // Cancelling twice is one fact: the manager deduplicates the request rather than conflicting, so the flag is true — but
  // `sideEffects` stays `local` because a stop that abandons a step in flight is exactly the case §6.2 prices as uncertain.
  assert.equal(byName.get(TASK_CANCEL_TOOL)?.sideEffects, "local");
  assert.equal(byName.get(TASK_CANCEL_TOOL)?.idempotent, true);
  // The tier is in each description, because §4.3's price is a fact a model can act on: a call that costs the user an
  // approval prompt is a different decision from one that does not, and the model is the party making it.
  assert.match(byName.get(TASK_CREATE_TOOL)?.description ?? "", /T1/);
  assert.match(byName.get(TASK_STATUS_TOOL)?.description ?? "", /T0/);
  assert.match(byName.get(TASK_CANCEL_TOOL)?.description ?? "", /T1/);
  const cancel = byName.get(TASK_CANCEL_TOOL)?.description ?? "";
  for (const word of ["crossSession", "all", "T2"])
    assert.ok(
      cancel.includes(word),
      `task.cancel's description names ${word}, because a model that does not know the argument is priced at T2 will ` +
        "declare it casually and spend an approval the user has to read (§4.2)",
    );
  const status = byName.get(TASK_STATUS_TOOL)?.description ?? "";
  assert.ok(
    status.includes(String(TASK_HISTORY_EVENTS)),
    "the number of events the description promises is the number the constant says, so the two cannot drift",
  );
});

test("refuses all three when the run has no recorded identity", async () => {
  const tools = lab().tools;
  for (const [tool, args] of [
    [TASK_CREATE_TOOL, { objective: "summarise the notes" }],
    [TASK_STATUS_TOOL, { taskId: "tsk_one" }],
    [TASK_CANCEL_TOOL, { taskId: "tsk_one" }],
  ] as const) {
    const outcome = await output(tools, tool, { ...args }, context(null));
    assert.equal(outcome.ok, false, `${tool} refuses rather than guessing whose act this is`);
    if (outcome.ok) continue;
    assert.equal(
      outcome.code,
      "no-identity",
      `${tool}'s refusal is the same code cron.schedule gives, so a composition that forgot the origin is one failure ` +
        "with one shape rather than three",
    );
    assert.match(outcome.output, /§14/, "the reason names the section that requires a person");
  }
});

test("creates in the caller's own conversation unless the arguments name another", async () => {
  const tools = lab();
  await output(tools.tools, TASK_CREATE_TOOL, { objective: "  summarise the notes  " });
  await output(tools.tools, TASK_CREATE_TOOL, { objective: "elsewhere", sessionId: "ses_other" });
  assert.deepEqual(
    tools.calls.map((call) => (call.args as { sessionId?: string }).sessionId),
    ["ses_here", "ses_other"],
    "the default is the conversation the run belongs to — a sub-step of this question belongs in this conversation — and " +
      "an explicit id is passed through rather than corrected, because which conversation a task belongs to is the " +
      "model's declared intent and §4.2 prices the crossing on `task.cancel`, not here",
  );
  const firstCall = tools.calls[0];
  assert.ok(firstCall, "the first call reached the sink, so there is an argument set to read");
  assert.equal(
    (firstCall.args as { objective?: string }).objective,
    "summarise the notes",
    "the objective is trimmed: it becomes the task's objective and, for an un-named conversation, its title (W15-03), " +
      "and a title with two spaces in front of it is a defect a user sees in a sidebar",
  );
});

test("says so when the task it created will never move", async () => {
  const tools = lab();
  tools.createWith = {
    ok: true,
    task: record({ id: "tsk_new", state: "queued" }),
    driven: false,
    withheld: [],
  };
  const outcome = await output(tools.tools, TASK_CREATE_TOOL, { objective: "summarise the notes" });
  assert.equal(outcome.ok, true, "the task exists, so the call succeeded");
  if (!outcome.ok) return;
  assert.match(
    outcome.output,
    /no runner|nothing will move it/,
    "a recorded task in a Gateway that drives nothing has to be reported as recorded, because the model will otherwise " +
      "tell the user the work is running — and §5.1's rule that hidden is better than failing is about not advertising " +
      "the tool at all, not about staying quiet when a composition does",
  );
});

test("reports a capability that produced no grant, and a runner that declined to start", async () => {
  const tools = lab();
  tools.createWith = {
    ok: true,
    task: record({ id: "tsk_new", state: "queued" }),
    driven: true,
    withheld: [{ capability: "fs.write", reason: "no configured root allows it" }],
    startRefused: { code: "at-limit", reason: "the queue is at limits.maxConcurrentRuns" },
  };
  const outcome = await output(tools.tools, TASK_CREATE_TOOL, { objective: "summarise the notes" });
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  assert.match(
    outcome.output,
    /fs\.write/,
    "the withheld capability is named, not dropped (D-102's rule for a route)",
  );
  assert.match(
    outcome.output,
    /stays `queued`/,
    "a run the runner declined is reported as waiting rather than as running: §7.1's recovery marks it `interrupted` on " +
      "the next start, and the record says `queued` until then",
  );
});

test("reads a task's state and the newest events, saying how many are earlier", async () => {
  const tools = lab();
  tools.readWith = readOf(record({ state: "running", lastSeq: 20 }), 20);
  const outcome = await output(tools.tools, TASK_STATUS_TOOL, { taskId: "tsk_one" });
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  assert.match(outcome.output, /running/, "the state is in the answer");
  assert.match(
    outcome.output,
    /summarise the notes/,
    "so is the objective — the question a reader asks of an id",
  );
  assert.match(
    outcome.output,
    /seq 13–20/,
    "the tail is named by seq range rather than by a count of lines, because §5.2's numbers are what a reader cross-reads " +
      "against `GET /api/v1/events`",
  );
  assert.match(
    outcome.output,
    /seq 1–12 are earlier on the record/,
    "and the part that was not carried is said to exist, since §4.2's alias for this row is `task.history` and a model " +
      "that believes eight events are the whole history will reason about a run it has only seen the end of",
  );
});

test("renders §6.2's evidence from the record, in both of its phases", async () => {
  const tools = lab();
  // The request phase: `cancellation` present with no `settledAt` is D-090's "asked, not stopped".
  tools.readWith = readOf(
    record({
      state: "cancelling",
      cancellation: { mode: "finish-step", requestedAt: "2026-10-13T02:01:00.000Z" },
    }),
    3,
  );
  const asked = await output(tools.tools, TASK_STATUS_TOOL, { taskId: "tsk_one" });
  assert.ok(asked.ok);
  if (asked.ok)
    assert.match(
      asked.output,
      /recorded, not settled yet/,
      "the two phases read differently, because a user who cannot tell them apart walks away from work still running",
    );
  // The settle phase, with the two booleans §6.2 exists to force apart.
  tools.readWith = readOf(
    record({
      state: "cancelled",
      cancellation: {
        mode: "immediate",
        requestedAt: "2026-10-13T02:01:00.000Z",
        settledAt: "2026-10-13T02:01:04.000Z",
        terminated: false,
        effectsUncertain: true,
        inFlight: "tool",
        by: "cli_1",
        reason: "the user asked",
      },
    }),
    5,
  );
  const settled = await output(tools.tools, TASK_STATUS_TOOL, { taskId: "tsk_one" });
  assert.ok(settled.ok);
  if (!settled.ok) return;
  assert.match(settled.output, /immediate/);
  assert.match(settled.output, /tool was in flight/);
  assert.match(
    settled.output,
    /terminated no/,
    "`terminated: false` is rendered as a no rather than omitted: §6.2's distinction between \"the operation reported " +
      'that it stopped" and "we stopped waiting for it" is the whole point of the field',
  );
  assert.match(settled.output, /effects uncertain yes/);
});

test("refuses to cancel into another conversation unless the argument declared it", async () => {
  const tools = lab();
  tools.readWith = readOf(record({ id: "tsk_far", sessionId: "ses_elsewhere" }), 1);
  const outcome = await output(tools.tools, TASK_CANCEL_TOOL, { taskId: "tsk_far" });
  assert.equal(
    outcome.ok,
    false,
    "the executor declines the act policy priced but could not refuse",
  );
  if (outcome.ok) return;
  assert.equal(
    outcome.code,
    "cross-session",
    'its own code rather than a flattened `refused`, so a model can tell "you named another conversation" from ' +
      '"the manager said no"',
  );
  assert.match(outcome.output, /ses_elsewhere/);
  assert.match(outcome.output, /ses_here/);
  assert.match(
    outcome.output,
    /T2/,
    "the refusal names the tier the crossing costs, which is the sentence that makes the next call declare it",
  );
  assert.equal(
    tools.calls.filter((call) => call.tool === TASK_CANCEL_TOOL).length,
    0,
    "and the manager was never asked: a refusal that reached the sink first would have recorded a request for a task " +
      "the run had no approved business stopping",
  );
});

test("hands a declared crossing, and an `all`, to the sink", async () => {
  const tools = lab();
  tools.readWith = readOf(record({ id: "tsk_far", sessionId: "ses_elsewhere" }), 1);
  const crossed = await output(tools.tools, TASK_CANCEL_TOOL, {
    taskId: "tsk_far",
    crossSession: true,
    mode: "immediate",
    reason: "the user asked from the phone",
  });
  assert.ok(crossed.ok, "the guard is about the argument, and the argument was declared");
  assert.deepEqual(
    tools.calls.at(-1)?.args,
    {
      taskId: "tsk_far",
      mode: "immediate",
      reason: "the user asked from the phone",
      origin: {
        clientId: ORIGIN.clientId,
        clientName: ORIGIN.clientName,
        interface: ORIGIN.interface,
        capabilities: [...ORIGIN.capabilities],
        sessionId: ORIGIN.sessionId,
      },
    },
    "the sink gets the mode, the reason and the run's own identity — and never a `by` the model could have written, " +
      "because §14's attribution is the one field a tool call must not be able to choose",
  );
  const all = await output(tools.tools, TASK_CANCEL_TOOL, { all: true });
  assert.ok(all.ok);
  assert.equal(tools.calls.at(-1)?.tool, `${TASK_CANCEL_TOOL}#all`);
  if (!all.ok) return;
  assert.match(
    all.output,
    /2 request\(s\) recorded across 1 conversation\(s\)/,
    "`all` reports what it reached, per task, because one cancellation is one fact and a summary count is not enough for " +
      "a model to tell the user which work stopped",
  );
});

test("says which of the two a cancellation did", async () => {
  const tools = lab();
  tools.readWith = readOf(record({ id: "tsk_one" }), 1);
  tools.cancelWith = { ok: true, task: record({ state: "cancelling" }), settled: false };
  const asked = await output(tools.tools, TASK_CANCEL_TOOL, { taskId: "tsk_one" });
  assert.ok(asked.ok);
  if (asked.ok) {
    assert.match(asked.output, /asked task tsk_one to stop/);
    assert.match(
      asked.output,
      /the task is `cancelling`/,
      "§6.1's default finishes the step in flight, and the output says the settle is still owed rather than claiming it",
    );
    assert.doesNotMatch(
      asked.output,
      /is `cancelled`/,
      "the one sentence this tool must not print for a request the loop has not reached",
    );
  }
  tools.cancelWith = {
    ok: true,
    task: record({
      state: "cancelled",
      cancellation: {
        mode: "finish-step",
        requestedAt: "2026-10-13T02:01:00.000Z",
        settledAt: "2026-10-13T02:01:01.000Z",
        terminated: true,
        effectsUncertain: false,
        inFlight: "none",
      },
    }),
    settled: true,
  };
  const settled = await output(tools.tools, TASK_CANCEL_TOOL, { taskId: "tsk_one" });
  assert.ok(settled.ok);
  if (settled.ok) {
    assert.match(settled.output, /task tsk_one is `cancelled`/);
    assert.match(
      settled.output,
      /none was in flight, terminated yes, effects uncertain no/,
      "and when the manager did settle it, §6.2's evidence travels with the answer instead of staying in the event log",
    );
  }
});

test("carries the manager's own sentence through when it refuses", async () => {
  const tools = lab();
  tools.readWith = readOf(record({ id: "tsk_done", state: "completed" }), 4);
  tools.cancelWith = {
    ok: false,
    code: "terminal",
    reason: "task tsk_done is `completed`, which is terminal and absorbing (AGENT_RUNTIME.md §4.1)",
  };
  const outcome = await output(tools.tools, TASK_CANCEL_TOOL, { taskId: "tsk_done" });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.code, "terminal");
  assert.equal(
    outcome.output,
    tools.cancelWith.ok ? "" : tools.cancelWith.reason,
    "verbatim, for the reason the cancellation route gives its own: the manager already names the section that refused, " +
      "and a second wording of one refusal is how two interfaces start disagreeing about why",
  );
});

test("refuses a task that does not exist, and an argument that is not one", async () => {
  const tools = lab();
  tools.readWith = undefined;
  const missing = await output(tools.tools, TASK_STATUS_TOOL, { taskId: "tsk_gone" });
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.code, "not-found");
    assert.match(
      missing.output,
      /crabby task ls/,
      "the refusal names the verb that prints the ids this install holds",
    );
  }
  const missingCancel = await output(tools.tools, TASK_CANCEL_TOOL, { taskId: "tsk_gone" });
  assert.equal(missingCancel.ok, false);
  if (!missingCancel.ok)
    assert.equal(
      missingCancel.code,
      "not-found",
      "the read that the cross-session guard needs is the same read that answers existence, so one absence is one code",
    );
  for (const [tool, args, word] of [
    [TASK_CREATE_TOOL, {}, "objective"],
    [TASK_CREATE_TOOL, { objective: "   " }, "objective"],
    [TASK_STATUS_TOOL, {}, "taskId"],
    [TASK_CANCEL_TOOL, {}, "taskId"],
    [TASK_CANCEL_TOOL, { taskId: "tsk_one", mode: "now" }, "cancellation mode"],
    [TASK_CANCEL_TOOL, { taskId: "tsk_one", reason: 7 }, "reason"],
    [TASK_CREATE_TOOL, { objective: "x", sessionId: 7 }, "sessionId"],
  ] as const) {
    tools.readWith = readOf(record(), 1);
    const outcome = await output(tools.tools, tool, { ...args });
    assert.equal(outcome.ok, false, `${tool} ${JSON.stringify(args)} is refused`);
    if (outcome.ok) continue;
    assert.equal(
      outcome.code,
      "bad-argument",
      `${tool} ${JSON.stringify(args)} names the argument, not the tool`,
    );
    assert.match(
      outcome.output,
      new RegExp(word),
      `${tool} ${JSON.stringify(args)} says which argument was wrong`,
    );
  }
  assert.equal(
    tools.calls.filter((call) => call.tool === TASK_CREATE_TOOL).length,
    0,
    "no malformed call reached a sink: a refusal answered after the act would be a task created by a typo",
  );
});

test("joins the other three surfaces without shadowing a name", () => {
  const root = mkdtempSync(path.join(tmpdir(), "crabby-task-tools-combined-"));
  const paths = { home: tmpdir(), dataDir: path.join(root, "state"), roots: [root] };
  const combined = combineToolSurfaces([
    createFileTools({
      paths,
      // D-064's over-cap output and §8's trash-or-rename land in the task's scratch directory. Nothing in this test runs a
      // file tool — it is here so the composition has a real second surface to combine with — but the option is required
      // rather than defaulted, and a default invented here would be a second opinion about where an overflow goes.
      scratchDirFor: (taskId) => path.join(root, ".scratch", taskId),
    }),
    createSchedulerTools({
      schedule: () => ({
        ok: false as const,
        code: "unavailable" as const,
        reason: "not composed",
      }),
    }),
    createSessionTools({
      list: () => [],
      rename: () => ({ ok: false as const, code: "not-found" as const, reason: "no session" }),
    }),
    lab().tools,
  ]);
  const names = combined.specs().map((spec) => spec.name);
  assert.equal(
    names.length,
    new Set(names).size,
    "one name per tool across the whole composition: `combineToolSurfaces` makes a duplicate fatal at startup rather " +
      "than last-one-wins (§4.1)",
  );
  assert.equal(
    names.filter((name) => name.startsWith("task.")).length,
    3,
    "the fourth surface the CLI composes, so a Gateway that drives tasks declares 14 tools and `GET /api/v1/tools` " +
      "counts 13 of them as implemented — `file.stat` has no §4.2 row to answer (F-55)",
  );
  assert.equal(
    combined.declares?.(TASK_CANCEL_TOOL)?.name,
    TASK_CANCEL_TOOL,
    "and the combined surface answers §4.1's record for the new rows from the executor that runs them",
  );
});
