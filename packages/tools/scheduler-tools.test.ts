// The scheduler executor and the combination of executors, asserted as the sentences they enforce rather than as a
// registry with getters:
//
//   - `cron.schedule` is `PROVIDERS_AND_TOOLS.md` §4.2's T2 row, and this file is the only way a job comes into
//     existence in this build (`docs/review/CLI.md` C12-09, `docs/CONSISTENCY_REVIEW.md` F-57).
//   - §4.5's audit rule — a job "runs under the identity that created it, so audit records name a person rather than
//     'cron'" — is enforced here by *refusing* a run that carries no identity, because the alternative is an executor
//     inventing a `createdBy` and a job that runs under nobody.
//   - §4.1's registration rules are applied to a *composition* of surfaces, which is the point where two executors would
//     otherwise begin silently shadowing each other.
//
// A separate file from `tools.test.ts` on purpose: that one builds a real directory tree because its subject is the hop
// between a string and a syscall, and this one has no filesystem in it at all — its subject is who a write is attributed
// to and what a composition declares.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type {
  RunOrigin,
  ScheduleInput,
  ScheduleResult,
  ToolRunContext,
} from "@crabby/agent-runtime";
import { LIMITS_DEFAULTS } from "@crabby/core";
import { PENDING_RECORD_FIELDS } from "@crabby/policy";
import {
  combineToolSurfaces,
  createFileTools,
  createSchedulerTools,
  SCHEDULER_TOOL,
} from "./index.ts";

const FIXED_NOW = new Date(2026, 9, 12, 12, 0).getTime();

const ORIGIN: RunOrigin = {
  clientId: "cli_1",
  clientName: "the owner",
  interface: "cli",
  capabilities: ["task.create", "file.read"],
  sessionId: "ses_1",
};

/** A run context, with the origin as a parameter rather than as an override: `origin` is optional on the type, and
 *  `exactOptionalPropertyTypes` means "absent" and "present but undefined" are two different fixtures — the second of
 *  which no composition can produce and the first of which is the case this suite has to refuse. */
/** A run context, with the origin as a parameter rather than as an override: `origin` is optional on the type, and
 *  `exactOptionalPropertyTypes` means "absent" and "present but undefined" are two different fixtures — the second of
 *  which no composition can produce and the first of which is the case this suite has to refuse. `null` rather than
 *  `undefined` for "no identity", because `undefined` would be the parameter's default and a call that passed it would
 *  silently get the fixture identity back: a test that proves nothing and reads as though it proved something. */
function context(origin: RunOrigin | null = ORIGIN): ToolRunContext {
  return {
    taskId: "tsk_harness1",
    signal: new AbortController().signal,
    deadlineMs: undefined,
    ...(origin === null ? {} : { origin }),
  };
}

interface Lab {
  /** Every `ScheduleInput` the executor handed the scheduler, in order. */
  readonly inputs: ScheduleInput[];
  /** A refusal for the *next* call, consumed by it. Absent means the fixture writes the job the input asked for, which
   *  is the honest default: the executor's success path is what most of these tests are about, and a fixture that had to
   *  be told which call may succeed would make every refusal test depend on the order of the ones before it. */
  // `| undefined` because `exactOptionalPropertyTypes` otherwise forbids the one-shot assignment that consumes a refusal.
  refuseNext?: ScheduleResult | undefined;
  readonly scheduler: ReturnType<typeof createSchedulerTools>;
  readonly files: ReturnType<typeof createFileTools>;
  readonly root: string;
}

function lab(): Lab {
  const root = mkdtempSync(path.join(tmpdir(), "crabby-scheduler-tools-"));
  // Siblings rather than nested: §8's deny-list covers everything under the data directory, so a workspace root inside it
  // would be a root no tool may touch and every fixture would fail for a reason that is not the subject.
  const home = path.join(root, "home");
  const dataDir = path.join(root, "state");
  const self: Lab = {
    inputs: [],
    refuseNext: undefined,
    get scheduler() {
      return scheduler;
    },
    get files() {
      return files;
    },
    root,
  };
  const scheduler = createSchedulerTools({
    schedule: (input) => {
      self.inputs.push(input);
      // A faithful success: the job the scheduler would have written, built from what the executor asked for, so an
      // assertion about the output is an assertion about the attribution rather than about a fixture's own constants.
      const refusal = self.refuseNext;
      if (refusal !== undefined) {
        self.refuseNext = undefined;
        return refusal;
      }
      return {
        ok: true,
        job: {
          id: "job_fixture1",
          name: input.name,
          schedule: input.schedule,
          objective: input.objective,
          state: "active",
          createdBy: input.createdBy,
          capabilities: [...input.capabilities],
          sessionId: input.sessionId,
          createdAt: new Date(FIXED_NOW).toISOString(),
          updatedAt: new Date(FIXED_NOW).toISOString(),
          nextRunAt: new Date(FIXED_NOW + 60_000).toISOString(),
          missed: 0,
          utcOffsetMinutes: 360,
        },
      };
    },
    now: () => FIXED_NOW,
  });
  const files = createFileTools({
    paths: { home, dataDir, roots: [path.join(root, "workspace")] },
    scratchDirFor: (taskId) => path.join(dataDir, "scratch", taskId),
    now: () => FIXED_NOW,
  });
  return self;
}

const call = (args: Record<string, unknown>, tool = SCHEDULER_TOOL) => ({ tool, args });

test("the declaration says what §4.2's row says, including the two fields a recovery path acts on", () => {
  const instance = lab();
  const [declaration] = instance.scheduler.declarations();
  assert.equal(declaration?.name, SCHEDULER_TOOL);
  assert.equal(
    declaration?.idempotent,
    false,
    "calling it twice creates two jobs that both fire, so §7.3's resume may not repeat it",
  );
  assert.equal(
    declaration?.sideEffects,
    "local",
    "`local` and not `none`: what it creates is work that has not happened yet, so §6.2's evidence for a step abandoned here has to stay uncertain",
  );
  assert.equal(
    declaration?.limits.timeoutMs,
    LIMITS_DEFAULTS.sqliteBusyTimeoutMs,
    "D-074's `SQLite busy` row, because §5.2 prices no `cron.*` class and the tool's whole cost is two statements against the job table",
  );
  assert.equal(declaration?.outputSchema, undefined);
  // F-55's asymmetry, from this row's side: the runtime answers four of the five fields it owns and names the fifth as
  // pending, so `GET /tools` reports the row as implemented without reporting it as described. The cast is the price of
  // asking "which of these five does this record answer" about a record whose fields are each their own type.
  const answered = declaration as unknown as Record<string, unknown>;
  assert.deepEqual(
    PENDING_RECORD_FIELDS.filter((field) => answered[field] === undefined),
    ["outputSchema"],
  );
  assert.match(
    declaration?.description ?? "",
    /T2/,
    "the description tells the model the call needs a user, and why",
  );
  assert.match(
    declaration?.description ?? "",
    /fresh policy evaluation/,
    "and that the approval it gets authorises nothing later",
  );
  assert.match(
    declaration?.description ?? "",
    /no model argument/,
    "and that there is no model argument, because a control that could not be honoured is a control the user believes in",
  );
});

test("a run with no recorded identity is refused rather than attributed to somebody invented", () => {
  const instance = lab();
  const outcome = instance.scheduler.run(
    call({ name: "morning summary", schedule: "0 7 * * *", objective: "summarise" }),
    context(null),
  );
  assert.ok(
    !("then" in outcome),
    "the executor answers synchronously: it writes two rows and searches a bounded window",
  );
  const result = outcome as { ok: boolean; output: string; code?: string };
  assert.equal(result.ok, false);
  assert.equal(result.code, "no-identity");
  assert.match(
    result.output,
    /names a person rather than 'cron'/,
    "§4.5's sentence, in the refusal",
  );
  assert.equal(
    instance.inputs.length,
    0,
    "and nothing was written: a refusal is not a job with an empty creator",
  );
});

test("the job is attributed to the run's origin, and to nothing the model wrote", () => {
  const instance = lab();
  const result = instance.scheduler.run(
    call({
      name: "  morning summary  ",
      schedule: "0 7 * * *",
      objective: "summarise what needs an answer",
      // Fields the schema does not admit, sent anyway: `additionalProperties: false` is a contract with the provider,
      // and an executor that read an undeclared field would be honouring a channel the user never saw.
      createdBy: { clientId: "cli_attacker", name: "somebody else", interface: "web" },
      capabilities: ["shell.run", "file.delete"],
    }),
    context(),
  );
  assert.equal((result as { ok: boolean }).ok, true);
  assert.equal(instance.inputs.length, 1);
  const input = instance.inputs[0] as ScheduleInput;
  assert.deepEqual(
    input.createdBy,
    { clientId: "cli_1", name: "the owner", interface: "cli" },
    "the creator is the run's own origin — a `createdBy` in `args` is a widening, and §10's rule that a declared field is never an authority applies with full force to a field that decides who authorises a standing timer",
  );
  assert.deepEqual(
    [...input.capabilities],
    ["task.create", "file.read"],
    "and the capability set is the identity's recorded one, so a timer gains nothing by being a timer (§4.5)",
  );
  assert.equal(
    input.name,
    "morning summary",
    "trimmed, because a name is what a person reads a month later",
  );
  assert.equal(input.sessionId, "ses_1");
  assert.equal(input.at, FIXED_NOW);

  const output = (result as { output: string }).output;
  assert.match(output, /scheduled job job_fixture1/);
  assert.match(
    output,
    /the owner \(cli\)/,
    "the output names the person, which is the fact a user compares against their approval",
  );
  assert.match(output, /2 capabilities recorded/, "and how much authority the job carries");
  assert.match(
    output,
    /UTC\+06:00/,
    "D-103: the offset the schedule was read against, in the sign a person writes",
  );
  assert.match(output, /next run/, "and the next fire, rendered on the device's wall clock");
  assert.match(
    output,
    /crabby job ls/,
    "plus the handles the user has afterwards, in the sentence that creates the standing authority",
  );
  assert.match(
    output,
    /fresh policy evaluation/,
    "and the sentence that says the approval for this call authorises no later run",
  );
});

test("an argument the schema would have refused is refused here too, and the scheduler's own sentence is passed through", () => {
  const instance = lab();
  for (const field of ["name", "schedule", "objective"] as const) {
    for (const value of [undefined, "", "   ", 7]) {
      const args: Record<string, unknown> = {
        name: "morning summary",
        schedule: "0 7 * * *",
        objective: "summarise",
      };
      args[field] = value;
      const result = instance.scheduler.run(call(args), context()) as {
        ok: boolean;
        code?: string;
        output: string;
      };
      assert.equal(result.ok, false, `a '${field}' of ${JSON.stringify(value)} must be refused`);
      assert.equal(result.code, "bad-argument");
      assert.match(
        result.output,
        new RegExp(field),
        "and the refusal names the field, because the model has to fix it",
      );
    }
  }
  assert.equal(instance.inputs.length, 0, "no refusal reached the scheduler");

  // The executor validates the shape; the scheduler validates the meaning. Its sentence arrives unedited, because a tool
  // that rephrased a refusal would be a second voice telling the model why it was denied.
  const invalid = "'7' is not a day-of-week this parser reads: 0-6 or a name";
  instance.refuseNext = { ok: false, code: "invalid_schedule", reason: invalid };
  const unreadable = instance.scheduler.run(
    call({ name: "x", schedule: "0 7 * * 7", objective: "y" }),
    context(),
  ) as { ok: boolean; code?: string; output: string };
  assert.equal(unreadable.ok, false);
  assert.equal(
    unreadable.code,
    "invalid_schedule",
    "the refusal code is the scheduler's, which is what makes it a class a client can act on",
  );
  assert.equal(unreadable.output, invalid, "the sentence is the scheduler's own, word for word");

  instance.refuseNext = {
    ok: false,
    code: "no_occurrence",
    reason: "'0 0 30 2 *' has no occurrence in the 1500 days after …",
  };
  const impossible = instance.scheduler.run(
    call({ name: "x", schedule: "0 0 30 2 *", objective: "y" }),
    context(),
  ) as { ok: boolean; code?: string };
  assert.equal(impossible.ok, false);
  assert.equal(impossible.code, "no_occurrence");

  // A tool that is not this executor's is refused rather than forwarded, so a misrouted call cannot become a write.
  const wrong = instance.scheduler.run(call({ path: "a.md" }, "file.read"), context()) as {
    ok: boolean;
    code?: string;
    output: string;
  };
  assert.equal(wrong.ok, false);
  assert.equal(wrong.code, "unknown-tool");
  assert.match(
    wrong.output,
    new RegExp(SCHEDULER_TOOL.replace(".", "\\.")),
    "and says what it does declare",
  );
});

test("a composition of two executors declares both, routes each call to its owner, and refuses a duplicate name at startup", async () => {
  const instance = lab();
  const combined = combineToolSurfaces([instance.files, instance.scheduler]);
  const names = combined.specs().map((spec) => spec.name);
  assert.equal(
    names.includes(SCHEDULER_TOOL),
    true,
    "F-55's eighth implemented row is the scheduler's",
  );
  assert.equal(
    names.length,
    9,
    "eight from the file executor plus this one, with nothing counted twice",
  );
  assert.equal(
    new Set(names).size,
    names.length,
    "and no name appears twice in what a provider is offered",
  );
  assert.equal(combined.declares(SCHEDULER_TOOL)?.name, SCHEDULER_TOOL);
  assert.equal(combined.declares("file.read")?.sideEffects, "none");

  // `run` routes to the owner rather than to the first surface, which is the difference between a composition and a
  // fallback chain.
  const unknown = (await combined.run(call({}, "shell.run"), context())) as {
    ok: boolean;
    code?: string;
    output: string;
  };
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, "not-declared");
  assert.match(
    unknown.output,
    /not declared by any executor in this composition/,
    "§4.1's rule that a name with nothing behind it is not offered at all",
  );
  assert.match(
    unknown.output,
    new RegExp(SCHEDULER_TOOL.replace(".", "\\.")),
    "and the answer names what the composition does have",
  );

  // Facts are merged rather than first-answer-wins: §4.3's escalations ask different executors about different arguments,
  // and a fact answered by one surface must not be hidden by another that has nothing to say. Asserted as "the composition
  // answers what the owner answers" rather than as a literal, because the literal is the file executor's business and is
  // pinned in `tools.test.ts` against a real tree.
  const fileCall = { tool: "file.write", args: { path: "a.md", content: "x" } };
  assert.deepEqual(
    combined.facts(fileCall),
    instance.files.facts(fileCall),
    "combining surfaces does not change, hide or invent a fact the owner answers",
  );
  assert.deepEqual(
    combined.facts({ tool: SCHEDULER_TOOL, args: {} }),
    {},
    "the scheduler has no argument-dependent escalation to answer, and saying so is an answer rather than a hole",
  );
  // The merge itself, against two surfaces that each have something to say about different arguments.
  const stub = (name: string, fact: string) => ({
    specs: () => [{ name, description: name, parameters: { type: "object", properties: {} } }],
    run: () => ({ ok: true as const, output: "" }),
    facts: () => ({ [fact]: true }),
  });
  assert.deepEqual(
    combineToolSurfaces([stub("stub.one", "one"), stub("stub.two", "two")]).facts({
      tool: "stub.one",
      args: {},
    }),
    { one: true, two: true },
    "both surfaces are asked, so a fact one of them owns survives a composition that also holds another",
  );

  // A duplicate name is fatal at composition. `assertRegistrable` runs over the merge as well, so §4.1's registration
  // rules are applied to the thing a provider is actually offered rather than to each executor separately.
  assert.throws(
    () => combineToolSurfaces([instance.scheduler, instance.scheduler]),
    /declared by two executors in one composition/,
  );
  assert.throws(
    () => combineToolSurfaces([instance.files, instance.files]),
    /declared by two executors in one composition/,
  );
  // A surface with no declarations at all still combines: `ToolSurface.declares` is optional, and an executor that has not
  // caught up to D-098 must not stop a composition from running.
  const bare = combineToolSurfaces([
    instance.scheduler,
    { specs: () => [], run: () => ({ ok: true, output: "" }) },
  ]);
  assert.equal(bare.specs().length, 1);
  assert.equal(bare.declarations().length, 1);
});
