// The loop, asserted as the sentences it implements rather than as a state dump: what §5's six rules require of a run,
// what §6.3 requires of a prompt, what D-087's edge makes reachable, what D-043's ladder climbs and refuses to climb, and
// what the loop still refuses to pretend it has (no executor, no D-044 rung). Every message names the rule it is arguing
// for, because the same sentence is what a reviewer reads when one of these goes red in a year's time.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validate } from "@crabby/api-contracts";
import { LIMITS_DEFAULTS, LimitsConfig } from "@crabby/core";
import { type EvalContext, evaluate } from "@crabby/policy";
import { MAX_ATTEMPTS } from "@crabby/providers";
import {
  LOOP_LIMITS,
  type LoopLimits,
  type LoopOutcome,
  loopLimitsOf,
  type SuspendedRun,
  toolDeadlineMs,
  withheldReason,
} from "./loop.ts";
import {
  createHarness,
  createScriptedProvider,
  guardApprovals,
  type Harness,
  type HarnessTool,
  WORKSPACE,
} from "./loop-harness.ts";

const PATH_ARGS = { type: "object", properties: { path: { type: "string" } } } as const;
const BUILD = `${WORKSPACE}/build`;
const T2_TTL = 10 * 60_000; // D-064's T2 window, restated as the number a test moves the clock by.

/** §3.6 stage 2's labelled option, as the composition root would hand it over: the pair spelled the way an answer takes
 *  it, the cost class, the window, and the capabilities this candidate would *lose* against the model the run is on. */
const SECOND_CANDIDATE = {
  model: "second/fake-tools",
  provider: "second",
  cost: "free-tier",
  contextWindow: 8_192,
  losses: ["no tool calling", "a smaller context window (8,192 of 128,000)"],
} as const;
const T3_TTL = 5 * 60_000; // D-064's T3 window.

/** The `EvalContext` half of a run input, and the grants the harness composes its own runs with — written once here so a
 *  `restart` test is not a second copy of what `createHarness` already decides. */
const harnessCtx = {
  // `grants` is the harness's own subject list, because `RunInput.ctx` carries it and a second list here would be a
  // second opinion about what the identity in these tests holds.
  grants: ["fs.read", "fs.write", "net.egress", "task.read"],
  paths: { home: "/home/user", dataDir: "/home/user/.crabby", roots: [WORKSPACE] },
  realpathOf: (absolutePath: string): string => absolutePath,
};
const harnessSubject = {
  grants: ["fs.read", "fs.write", "net.egress", "task.read"],
  clientKind: "cli",
} as const;

function fileTools(): HarnessTool[] {
  return [
    { name: "file.read", parameters: PATH_ARGS, output: "notes.md, as read" },
    { name: "file.delete", parameters: PATH_ARGS, output: "removed build/" },
  ];
}

const readRound = [
  { kind: "tool-call", name: "file.read", arguments: { path: "notes.md" } },
] as const;
const deleteRound = [
  { kind: "tool-call", name: "file.delete", arguments: { path: BUILD } },
] as const;
const doneRound = [{ kind: "text", text: "read notes.md and deleted build/" }] as const;

function suspended(outcome: LoopOutcome): SuspendedRun {
  if (outcome.kind !== "awaiting-approval") {
    assert.fail(`expected the run to stop at a prompt; it ended \`${outcome.kind}\``);
  }
  return outcome.run;
}

function stateMoves(harness: Harness): string[] {
  return harness.events
    .filter((event) => event.payload.to !== undefined)
    .map((event) => `${String(event.payload.from)} → ${String(event.payload.to)}`);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("§14's tool_invocation trail (D-133)", () => {
  it("records an ok row for a tool that ran, argument-free, with the act's shape", async () => {
    const harness = createHarness({ rounds: [readRound, doneRound], tools: fileTools() });
    const outcome = await harness.start({
      origin: {
        clientId: "cli_tester",
        clientName: "the tester",
        interface: "cli",
        capabilities: ["fs.read"],
        sessionId: "ses_loop_audit",
      },
    });
    assert.equal(outcome.kind, "completed");
    assert.equal(harness.invocations.length, 1, "one tool act, one row");
    const entry = harness.invocations[0];
    assert.equal(entry?.taskId, harness.taskId);
    assert.equal(entry?.tool, "file.read");
    assert.equal(entry?.outcome, "ok");
    assert.equal(entry?.tier, "T0");
    assert.equal(entry?.code, undefined);
    assert.ok((entry?.durationMs ?? 0) >= 0);
    assert.ok(!("args" in (entry as unknown as Record<string, unknown>)),
      "the trail carries no arguments — SECURITY.md §7 keeps the model's words out of the record that outlives the task");
    assert.equal(entry?.origin?.interface, "cli", "the origin names who drove the task");
    assert.equal(entry?.origin?.clientId, "cli_tester");
  });

  it("records a rejected row when the arbiter refuses the act at the moment of execution", async () => {
    const harness = createHarness({ rounds: [deleteRound, doneRound], tools: fileTools() });
    const run = suspended(await harness.start());
    harness.answer(run.approvalId, "approve", { via: "web" });
    // The grant is gone when the run resumes, so policy refuses the act the prompt had already cleared — the same
    // moment the existing blocked-event test pins, now asserted from the trail's side.
    const revoked: SuspendedRun = {
      ...run,
      input: { ...run.input, subject: { ...run.input.subject, grants: ["fs.read"] } },
    };
    const outcome = await harness.resume(revoked);
    assert.equal(outcome.kind, "completed");
    const entry = harness.invocations.find((candidate) => candidate.tool === "file.delete");
    assert.ok(entry !== undefined, "the refused act is on the trail");
    assert.equal(entry.outcome, "rejected", "nothing ran, and the row says so");
    assert.equal(entry.tier, "T2", "file.delete inside the workspace prices at T2 in this harness");
    assert.equal(entry.approvalId, run.approvalId, "the row names the approval it was refused under");
    assert.equal(harness.executions.length, 0, "the executor was never touched");
  });
});

describe("the loop that opens a request (§5's rule 1, PROVIDERS_AND_TOOLS.md §4.4)", () => {
  it("completes a task that needs nothing approved, passing through `running` because §4.1 has no shortcut", async () => {
    const harness = createHarness({ messages: true, rounds: [doneRound], tools: [] });
    const outcome = await harness.start();

    assert.equal(
      outcome.kind,
      "completed",
      "a text answer with no gated action is a finished task",
    );
    assert.deepEqual(
      harness.states,
      ["planning", "running", "completed"],
      "`completed` is reachable only from `running`, because a plan that finished describing work has not done it " +
        "(AGENT_RUNTIME.md §4.1) — so a task that only ever answered still runs before it completes",
    );
    assert.equal(harness.approvals.list().length, 0, "nothing was gated, so nothing was queued");
    assert.equal(harness.executions.length, 0, "no executor was asked for anything");
    assert.equal(
      harness.payloadOf("message.added")?.content,
      "read notes.md and deleted build/",
      "the answer is logged as a message, because §10.1 requires progress to reflect recorded state rather than claims. " +
        "The harness composes a message writer (`messages: true`) because D-112 made the store a seam: without one there is " +
        "no turn and therefore no frame, which the next test asserts",
    );
  });

  it("executes an auto-allowed action with no prompt, which is §6.2's T0 row", async () => {
    const harness = createHarness({ rounds: [readRound, doneRound], tools: fileTools() });
    const outcome = await harness.start();

    assert.equal(outcome.kind, "completed");
    assert.equal(
      harness.approvals.list().length,
      0,
      "T0 is auto-allow when the grant is held; a prompt here is noise",
    );
    assert.deepEqual(
      harness.executions.map((run) => run.tool),
      ["file.read"],
    );
    assert.equal(harness.payloadOf("tool.call.proposed")?.outcome, "allow");
    assert.equal(harness.payloadOf("tool.call.proposed")?.tier, "T0");
  });

  it("opens a request carrying every field §6.3 demands, and moves the task in the same phase", async () => {
    const harness = createHarness({ rounds: [deleteRound, doneRound], tools: fileTools() });
    const outcome = await harness.start();
    const run = suspended(outcome);

    assert.equal(harness.task()?.state, "awaiting_approval");
    const rows = harness.pending();
    assert.equal(rows.length, 1, "one action, one prompt");
    const request = rows[0]?.request;
    assert.equal(
      request?.tier,
      "T2",
      "deleting inside the workspace is §6.2's T2 row: per-action approval",
    );
    assert.equal(request?.scope, "once", "D-052: v1 has exactly one answer shape");
    assert.equal(request?.taskId, harness.taskId, "§5's rule 3 keeps the request with its task");
    assert.ok(
      Math.abs((request?.expiresAt ?? 0) - (harness.clock.now() + T2_TTL)) <= 1_000,
      `the deadline is D-064's T2 window from the request, not a window the caller chose`,
    );
    for (const field of ["summary", "exact", "effects", "whatCouldGoWrong", "binding"] as const) {
      const value = request?.[field];
      assert.ok(
        typeof value === "string" && value.trim().length > 0,
        `§6.3 requires \`${field}\` to carry something a user can read`,
      );
    }
    assert.equal(
      harness.payloadOf("approval.requested")?.exact,
      request?.exact,
      "the event carries what the user was shown, so the stream alone can render the prompt (§5.2)",
    );
    assert.deepEqual(
      stateMoves(harness),
      ["queued → planning", "planning → awaiting_approval"],
      "a gated first action goes straight from planning, which is why §4.1's `planning` row lists awaiting_approval",
    );
    assert.equal(run.approvalId, rows[0]?.id);
  });

  it("reaches a second approval from `running` — the edge D-087 added because the table could not express it", async () => {
    const harness = createHarness({
      rounds: [readRound, deleteRound, doneRound],
      tools: fileTools(),
    });
    suspended(await harness.start());

    assert.ok(
      stateMoves(harness).includes("running → awaiting_approval"),
      "§5's rule 1 evaluates *every* action, so a task that already executed one step must still be able to ask. " +
        "Before D-087 `running` could only end, and the second approval in one task had no legal representation",
    );
    assert.deepEqual(harness.states, ["planning", "running", "awaiting_approval"]);
    assert.equal(harness.executions.length, 1, "the allowed step ran; the gated one is waiting");
  });

  it("consumes the approval before the action runs, and logs the consumption as its own event", async () => {
    const harness = createHarness({ rounds: [deleteRound, doneRound], tools: fileTools() });
    const run = suspended(await harness.start());
    harness.answer(run.approvalId, "approve", { via: "web", byClientId: "cln_web" });
    const outcome = await harness.resume(run);

    assert.equal(outcome.kind, "completed");
    const consumed = harness.eventsOfType("approval.consumed");
    const started = harness.eventsOfType("tool.execution.started");
    assert.equal(
      consumed.length,
      1,
      "`consumed` is a state of the row, so it gets an event (F-42)",
    );
    assert.equal(started.length, 1);
    const consumedSeq = consumed[0]?.seq ?? 0;
    const startedSeq = started[0]?.seq ?? 0;
    assert.ok(
      consumedSeq < startedSeq,
      `the approval was consumed at seq ${consumedSeq} and the action started at ${startedSeq}: a crash between the two ` +
        "must not leave a usable approval for an action that already happened (§7.3's no-blind-repeat, D-052's once)",
    );
    assert.equal(
      harness.approvals.list({ taskId: harness.taskId })[0]?.state,
      "consumed",
      "the row says it was used, which is the only place `once` can be read after a restart",
    );
    assert.ok(
      stateMoves(harness).includes("awaiting_approval → running"),
      "the edge into `running` needs the answer in the record, and `transition()` refuses it without one (§7.2)",
    );
    assert.deepEqual(
      harness.executions.map((execution) => execution.args),
      [{ path: BUILD }],
      "the action that ran is the action that was signed",
    );
  });

  it("does not open a second prompt for an action that is already pending", async () => {
    const ctx: EvalContext = {
      grants: ["fs.write"],
      paths: { home: "/home/user", dataDir: "/home/user/.crabby", roots: [WORKSPACE] },
      realpathOf: (absolutePath: string) => absolutePath,
    };
    const harness = createHarness({ rounds: [deleteRound, doneRound], tools: fileTools(), ctx });
    // A second opener is the only way a duplicate can arrive: a recovery path re-proposing the step, or a scheduler and
    // a manual run meeting on the same action. The arbiter deduplicates it, and the loop must then emit nothing.
    const decision = evaluate(
      { tool: "file.delete", args: { path: BUILD } },
      { grants: ["fs.write"], clientKind: "cli", taskId: harness.taskId },
      ctx,
      harness.clock.now(),
    );
    assert.equal(decision.outcome, "require-approval");
    if (decision.outcome !== "require-approval") return;
    const already = harness.approvals.open(decision.approval, harness.clock.now());
    assert.equal(
      already.ok,
      true,
      "the fixture's own pre-condition: one row is pending before the loop runs",
    );

    const run = suspended(await harness.start());

    assert.equal(
      run.approvalId,
      already.ok ? already.record.id : "",
      "the loop returns the row that already exists rather than adding a second one for the same binding",
    );
    assert.equal(harness.pending().length, 1, "still one row, so still one prompt");
    assert.equal(
      harness.eventsOfType("approval.requested").length,
      0,
      "a deduplicated open emits no `approval.requested` at all: two frames for one prompt is how a queue starts " +
        "showing a user the same decision twice, and the first opener is the one that announced it",
    );
    assert.ok(
      stateMoves(harness).includes("planning → awaiting_approval"),
      "the task still says where it is, because the state and the queue are two views of one fact",
    );
  });

  it("respects a denial by re-planning, and tells the model what was refused", async () => {
    const harness = createHarness({ rounds: [deleteRound, doneRound], tools: fileTools() });
    const run = suspended(await harness.start());
    harness.answer(run.approvalId, "deny", { via: "tui", byClientId: "cln_tui" });
    const outcome = await harness.resume(run);

    assert.equal(
      outcome.kind,
      "completed",
      "§5's rule 5 respects a denial; it does not end the task",
    );
    assert.ok(
      stateMoves(harness).includes("awaiting_approval → planning"),
      "§4.1's `awaiting_approval` row: a denial that leaves other work possible re-plans rather than dies",
    );
    assert.equal(harness.executions.length, 0, "the refused action never reached an executor");
    const secondRound = harness.provider.calls[1]?.messages as
      | { role: string; content: string }[]
      | undefined;
    assert.ok(
      secondRound?.some((message) => message.role === "tool" && message.content.includes("denied")),
      "the refusal is the tool's answer, so the model plans around a fact instead of guessing why nothing happened",
    );
  });

  it("pauses after two refusals of the same tool, and leaves nothing to answer (D-086)", async () => {
    const otherTarget = [
      { kind: "tool-call", name: "file.delete", arguments: { path: `${WORKSPACE}/dist` } },
    ] as const;
    const harness = createHarness({
      rounds: [deleteRound, otherTarget, doneRound],
      tools: fileTools(),
    });

    const first = suspended(await harness.start());
    harness.answer(first.approvalId, "deny", { via: "tui" });
    const second = suspended(await harness.resume(first));
    assert.notEqual(
      second.approvalId,
      first.approvalId,
      "a materially different target is a different binding (§6.3)",
    );
    harness.answer(second.approvalId, "deny", { via: "tui" });
    const outcome = await harness.resume(second);

    assert.equal(outcome.kind, "paused");
    assert.equal(
      harness.task()?.state,
      "awaiting_approval",
      "a pause is not a tenth state: it is the one non-terminal state that means a human must act",
    );
    assert.equal(
      harness.pending().length,
      0,
      "and there is nothing in the queue, which is what makes it a pause and not a prompt",
    );
    assert.equal(
      harness.approvals.refusalCount(harness.taskId, "file.delete"),
      2,
      "the arbiter reports the count and the loop decides what it means (§6.3's 'repeated denial', priced by D-086)",
    );
    const progress = harness.payloadOf("task.progress");
    assert.equal(progress?.paused, true);
    assert.equal(progress?.refusals, 2);
    assert.ok(
      typeof progress?.reason === "string" && progress.reason.length > 0,
      "§6.3 asks for the pause to be surfaced, and §7.2 for the reason to be user-visible",
    );
    assert.equal(
      harness.approvals.list({ taskId: harness.taskId }).length,
      2,
      "a third request was never opened: asking again is the loop arguing with the user",
    );
  });

  it("re-requests when the deadline passed with nobody answering, instead of executing on a stale approval", async () => {
    const harness = createHarness({ rounds: [deleteRound, doneRound], tools: fileTools() });
    const run = suspended(await harness.start());
    harness.clock.advance(T2_TTL + 1_000);
    const outcome = await harness.resume(run);

    const again = suspended(outcome);
    assert.notEqual(
      again.approvalId,
      run.approvalId,
      "§6.3: an expired action needs a *fresh* request",
    );
    const rows = harness.approvals.list({ taskId: harness.taskId });
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.state, "expired");
    assert.equal(rows[1]?.state, "pending");
    assert.equal(
      rows[1]?.supersedes,
      rows[0]?.id,
      "the re-ask is a visible chain rather than an unrelated row",
    );
    assert.equal(harness.eventsOfType("approval.expired").length, 1);
    assert.equal(harness.eventsOfType("approval.re-requested").length, 1);
    assert.equal(harness.executions.length, 0, "nothing ran on an approval the user let lapse");
    assert.equal(
      stateMoves(harness).filter((move) => move.endsWith("→ awaiting_approval")).length,
      1,
      "the task was already awaiting approval, and a self-transition is not progress (§4.1's third untabled rule)",
    );
    assert.ok(
      Math.abs((rows[1]?.request.expiresAt ?? 0) - (harness.clock.now() + T2_TTL)) <= 1_000,
      "the fresh deadline is D-064's window from the fresh request, not the old row's",
    );
  });

  it("will not act on a pending approval, and writes nothing while it declines", async () => {
    const harness = createHarness({ rounds: [deleteRound, doneRound], tools: fileTools() });
    const run = suspended(await harness.start());
    const events = harness.events.length;
    const states = harness.states.length;

    const outcome = await harness.resume(run);

    assert.equal(outcome.kind, "refused");
    assert.equal(
      outcome.kind === "refused" ? outcome.code : "",
      "approval.pending",
      "§7.2: a pending approval must not be treated as approved — not because a restart occurred, and not because a runner asked",
    );
    assert.equal(harness.events.length, events, "a refusal that moved nothing logs nothing");
    assert.equal(harness.states.length, states);
    assert.equal(harness.executions.length, 0);
    assert.equal(harness.pending()[0]?.state, "pending");
  });

  it("does not spend a T2 signature on an action that became T3 while the prompt was open", async () => {
    let resolved = BUILD;
    const ctx: EvalContext = {
      grants: ["fs.write"],
      paths: { home: "/home/user", dataDir: "/home/user/.crabby", roots: [WORKSPACE] },
      // §8's re-check after resolution: the path a symlink resolves to is the path being approved.
      realpathOf: (absolutePath: string) => (absolutePath === BUILD ? resolved : absolutePath),
    };
    const harness = createHarness({ rounds: [deleteRound, doneRound], tools: fileTools(), ctx });
    const run = suspended(await harness.start());
    assert.equal(
      harness.pending()[0]?.request.tier,
      "T2",
      "the prompt was signed as a workspace deletion",
    );
    harness.answer(run.approvalId, "approve", { via: "web" });

    resolved = "/home/user/outside/build";
    const outcome = await harness.resume(run);

    const again = suspended(outcome);
    assert.notEqual(
      again.approvalId,
      run.approvalId,
      "§6.2's T3 row: re-prompt on every material change",
    );
    assert.equal(
      harness.pending()[0]?.request.tier,
      "T3",
      "the fresh request carries the tier the action now has",
    );
    assert.equal(harness.executions.length, 0, "the signed T2 was not spent on a T3 action");
    const rows = harness.approvals.list({ taskId: harness.taskId });
    assert.equal(
      rows[0]?.state,
      "approved",
      "the unspent signature stays approved and expires inside D-064's window",
    );
    assert.equal(
      harness.approvals.refusalCount(harness.taskId, "file.delete"),
      0,
      "an approval the runtime never ran is our lateness, not a user's refusal (D-084) — so this does not count toward the pause",
    );
    assert.equal(rows[1]?.supersedes, rows[0]?.id);
  });

  it("honours a grant revoked while the prompt was open, at the moment of execution", async () => {
    const harness = createHarness({ rounds: [deleteRound, doneRound], tools: fileTools() });
    const run = suspended(await harness.start());
    harness.answer(run.approvalId, "approve", { via: "web" });

    // A runner re-reads the identity when it resumes, because `crabby auth revoke` landing while a prompt is open has to
    // be honoured by the execution and not only by the next one (§5's rule 1 applies to every action).
    const revoked: SuspendedRun = {
      ...run,
      input: { ...run.input, subject: { ...run.input.subject, grants: ["fs.read"] } },
    };
    const outcome = await harness.resume(revoked);

    assert.equal(
      outcome.kind,
      "completed",
      "the task re-plans around the refusal rather than dying",
    );
    assert.equal(harness.executions.length, 0, "the action never reached an executor");
    const blocked = harness.payloadOf("tool.execution.blocked");
    assert.ok(
      typeof blocked?.reason === "string" && blocked.reason.includes("fs.write"),
      "the reason names the grant that is missing, so a user can tell a revocation from a denial",
    );
    assert.equal(
      harness.approvals.list({ taskId: harness.taskId })[0]?.state,
      "approved",
      "the approval is left unspent: policy now refuses the action, and a signature is not a licence (§6.3)",
    );
  });

  it("never queues a T3 request from Telegram, and never lets Telegram sign one", async () => {
    const outside = [
      { kind: "tool-call", name: "file.delete", arguments: { path: "/etc/motd" } },
    ] as const;
    const harness = createHarness({
      rounds: [outside, doneRound],
      tools: fileTools(),
      clientKind: "telegram",
    });
    const outcome = await harness.start();

    assert.equal(
      outcome.kind,
      "completed",
      "the refusal is the answer, not a deadlock: §13's shape, §6.2's reason",
    );
    assert.equal(
      harness.approvals.list().length,
      0,
      "a prompt a client cannot answer is never queued",
    );
    const blocked = harness.payloadOf("tool.execution.blocked");
    assert.ok(
      typeof blocked?.reason === "string" && blocked.reason.includes("TUI"),
      "the sentence says where to go, which is the difference between a refusal and a wait",
    );

    // The other half of D-085: the same T3 request opened by a client that may queue it, answered by one that may not
    // sign it. The arbiter refuses and the loop declines to proceed — the row stays pending for a surface that may.
    const tui = createHarness({
      rounds: [outside, doneRound],
      tools: fileTools(),
      clientKind: "cli",
    });
    const run = suspended(await tui.start());
    assert.equal(
      tui.pending()[0]?.request.tier,
      "T3",
      "outside the workspace, `file.delete` escalates (§4.2's note)",
    );
    assert.ok(
      Math.abs((tui.pending()[0]?.request.expiresAt ?? 0) - (tui.clock.now() + T3_TTL)) <= 1_000,
      "and the countdown every interface renders (§6.3) is D-064's T3 window rather than the T2 one: the more an " +
        "approval grants, the less time an unattended prompt stays answerable",
    );
    const refused = tui.answer(run.approvalId, "approve", { via: "telegram" });
    assert.equal(refused.ok, false);
    assert.equal(
      refused.ok ? "" : refused.code,
      "surface-not-allowed",
      "D-085: reach is not authority",
    );
    assert.equal(
      tui.pending()[0]?.state,
      "pending",
      "the refusal changed nothing, so the TUI can still sign it",
    );
    const after = await tui.resume(run);
    assert.equal(
      after.kind,
      "refused",
      "and the loop will not execute on an answer that was never recorded",
    );
  });

  it("offers the model only the tools policy has cleared for this identity", async () => {
    const harness = createHarness({
      rounds: [readRound, doneRound],
      grants: ["fs.read", "fs.write"],
      tools: [
        ...fileTools(),
        {
          name: "shell.run",
          parameters: { type: "object", properties: { command: { type: "string" } } },
        },
        {
          name: "net.fetch",
          parameters: { type: "object", properties: { url: { type: "string" } } },
        },
        {
          name: "termux-notify",
          parameters: { type: "object", properties: { text: { type: "string" } } },
        },
      ],
    });
    await harness.start();

    assert.deepEqual(
      harness.provider.calls[0]?.tools,
      ["file.read", "file.delete"],
      "§4.4: an adapter receives only tools policy has already cleared. A model told about `shell.run` proposes it, and " +
        "the user is shown a refusal for something they were never able to ask for",
    );
    const subject = { grants: ["fs.read", "fs.write"] as const };
    const platform = { isTermux: false };
    assert.match(
      withheldReason("shell.run", subject, platform) ?? "",
      /off by default/,
      "`shell.run` is the one capability §4.2 ships disabled, and that reason outranks the missing grant — F-34's open " +
        "question is about a capability that ships off, so the sentence a user reads has to be the one about the default",
    );
    assert.match(
      withheldReason("net.fetch", subject, platform) ?? "",
      /net\.egress/,
      "an ungranted capability is a denial the user can fix, and the reason says which grant is missing",
    );
    assert.match(
      withheldReason("termux-notify", subject, platform) ?? "",
      /Termux/,
      "§4.1's availability rule: false yields a documented reason instead of a broken tool — and the platform reason " +
        "outranks the missing `device.notify` grant, because granting it on a desktop would repair nothing",
    );
    assert.equal(
      withheldReason("ext.install", { grants: ["ext.install"] }, platform),
      undefined,
      "Pinned as reachable-today rather than asserted as right: D-038 blocks the *executable kind* of `ext.install`, and " +
        "that block lives on the second of §4.2's two `ext.install` rows — a row no name-keyed `resolveTool` can return, " +
        "with no argument rule behind it (`packages/policy/escalation.ts` has none for `ext.install`). Recorded as " +
        "docs/CONSISTENCY_REVIEW.md F-43 instead of guessed at, because nothing in this build declares an `ext.install` " +
        "executor, and a filter that withheld the content-only kind too would be refusing a tool v1 does ship",
    );
    assert.equal(
      withheldReason("file.read", { grants: ["fs.read"] }, { isTermux: true }),
      undefined,
      "and a cleared tool is offered",
    );
    assert.match(
      // A removed grant is *not* in `grants` — that is `PolicySubject`'s own contract, and the whole reason the two
      // fields exist separately.
      withheldReason("file.read", { grants: [], removedGrants: ["fs.read:workspace"] }, platform) ??
        "",
      /removed when this identity was paired/,
      "§13's distinction survives into the offer list: a restricted capability is not available to this client, which " +
        "is not the same sentence as an ungranted one",
    );
    assert.match(
      withheldReason("file.read", { grants: [] }, platform) ?? "",
      /does not hold/,
      "and the ungranted case still reads as a thing the user can fix",
    );
  });

  it("refuses a tool no executor declares, and keeps going", async () => {
    const chmod = [{ kind: "tool-call", name: "file.chmod", arguments: { path: BUILD } }] as const;
    const harness = createHarness({ rounds: [chmod, doneRound], tools: fileTools() });
    const outcome = await harness.start();

    assert.equal(outcome.kind, "completed");
    assert.equal(
      harness.executions.length,
      0,
      "§3.1's third rule: a completion may propose tool calls, and only that",
    );
    assert.equal(harness.payloadOf("tool.call.proposed")?.outcome, "not-declared");
    assert.equal(harness.payloadOf("tool.execution.blocked")?.class, "validation");
    assert.equal(
      harness.approvals.list().length,
      0,
      "policy was never asked about a tool this build cannot run, so no prompt was queued for one",
    );
  });

  it("stops at the per-task step limit, and the failure names the knob (D-088)", async () => {
    const undeclared = [{ kind: "tool-call", name: "file.chmod", arguments: {} }] as const;
    const harness = createHarness({
      rounds: [undeclared],
      tools: fileTools(),
      limits: { stepsPerTask: 3 },
    });
    const outcome = await harness.start();

    assert.equal(outcome.kind, "failed");
    assert.equal(outcome.kind === "failed" ? outcome.code : "", "limits.steps_per_task");
    const reason = outcome.kind === "failed" ? outcome.reason : "";
    assert.match(
      reason,
      /step limit of 3/,
      "§5.2: when a limit trips, the failure names the limit",
    );
    assert.match(
      reason,
      /limits\.stepsPerTask/,
      "and how to change it, because every row is a `limits.*` key (D-074)",
    );
    assert.equal(harness.task()?.state, "failed");
    assert.equal(
      harness.task()?.error?.code,
      "limits.steps_per_task",
      "so `GET /tasks/{id}` shows it without the log",
    );
    assert.equal(
      harness.eventsOfType("tool.call.proposed").length,
      3,
      "a refused call spends the budget too: counting only executed calls would leave unbounded the one case the limit exists for",
    );
    assert.equal(
      LOOP_LIMITS.stepsPerTask,
      25,
      "D-088's default, pinned so a change is a decision and not a typo",
    );
  });

  it("refuses a completion that proposes more calls than the device budget", async () => {
    const three = [
      { kind: "tool-call", name: "file.read", arguments: { path: "a" } },
      { kind: "tool-call", name: "file.read", arguments: { path: "b" } },
      { kind: "tool-call", name: "file.read", arguments: { path: "c" } },
    ] as const;
    const harness = createHarness({ rounds: [three, doneRound], tools: fileTools() });
    const outcome = await harness.start();

    assert.equal(outcome.kind, "failed");
    assert.equal(outcome.kind === "failed" ? outcome.code : "", "limits.tool_calls_per_response");
    assert.equal(
      harness.executions.length,
      0,
      "none of the three ran: the response was refused, not trimmed",
    );
    assert.equal(
      LOOP_LIMITS.toolCallsPerResponse,
      2,
      "D-074 already priced parallel tool steps in one task at 2, so the per-response cap is that number and not a new one",
    );
  });

  it("fails at once on a class that is not retryable, and says the ladder never started", async () => {
    const waits: number[] = [];
    const harness = createHarness({
      rounds: [[{ kind: "fail", class: "auth" }], doneRound],
      tools: fileTools(),
      wait: async (ms) => {
        waits.push(ms);
      },
    });
    const outcome = await harness.start();

    assert.equal(outcome.kind, "failed");
    assert.equal(outcome.kind === "failed" ? outcome.code : "", "provider.auth");
    const payload = harness.payloadOf("task.failed");
    assert.equal(payload?.attempts, 1);
    assert.equal(payload?.retried, 0);
    assert.match(
      String(payload?.ladder),
      /not retryable/,
      "§9.2: invalid requests and denied permissions must not be retried, and the event says which of the two reasons the " +
        "ladder did not climb — a budget spent and a class that never qualified read the same otherwise",
    );
    assert.equal(waits.length, 0, "and it did not wait, because there was nothing to wait for");
    assert.equal(harness.eventsOfType("provider.retry.scheduled").length, 0);
    assert.equal(harness.task()?.state, "failed");
    assert.equal(
      harness.task()?.error?.code,
      "provider.auth",
      "the reason is on the record, so a phone that missed the event still sees why (§5.2's polling rule)",
    );
  });

  it("climbs D-043's ladder on D-064's schedule, logs every rung, and finishes when an attempt succeeds", async () => {
    const harness = createHarness({
      rounds: [
        [{ kind: "fail", class: "rate-limit" }],
        [{ kind: "fail", class: "overloaded" }],
        doneRound,
      ],
      tools: fileTools(),
      // `random()` at 0.5 puts the jitter at exactly zero drift: (0.5 × 2 − 1) × 0.25 × base. A schedule a test cannot
      // pin is a schedule nobody verifies, which is why the source takes the generator at all.
      random: () => 0.5,
    });
    const outcome = await harness.start();

    assert.equal(
      outcome.kind,
      "completed",
      "the third attempt answered, so the task is not a failure",
    );
    assert.deepEqual(
      harness.waits,
      [1_000, 2_000],
      "D-064's schedule inside D-043's floor: 1s, 2s, 4s, 8s, 16s with ±25% jitter, pinned here at zero drift",
    );
    const scheduled = harness.eventsOfType("provider.retry.scheduled");
    assert.equal(
      scheduled.length,
      2,
      "one event per rung, because a retry nobody can see is a retry nobody can bound",
    );
    assert.equal(scheduled[0]?.payload.attempt, 1);
    assert.equal(scheduled[0]?.payload.delayMs, 1_000);
    assert.equal(scheduled[0]?.payload.source, "schedule");
    assert.equal(scheduled[0]?.payload.class, "rate-limit");
    assert.equal(scheduled[1]?.payload.attempt, 2);
    assert.equal(scheduled[1]?.payload.delayMs, 2_000);
    assert.equal(harness.eventsOfType("provider.retry.attempt").length, 2);
    assert.deepEqual(
      harness.provider.calls.map((call) => call.modelId),
      ["fake-tools", "fake-tools", "fake-tools"],
      "the same model and the same provider on every attempt: never a silent switch (D-043)",
    );
  });

  it("lets a provider's Retry-After override the schedule upward, and ignores a shorter one", async () => {
    const longer = createHarness({
      rounds: [[{ kind: "raw", status: 429, body: "slow down", retryAfterMs: 30_000 }], doneRound],
      tools: fileTools(),
      random: () => 0.5,
    });
    await longer.start();
    assert.deepEqual(
      longer.waits,
      [30_000],
      "D-064: a `Retry-After` value always overrides the schedule upward — the provider asked for a window, and a client " +
        "that shaves it down is a client that keeps getting 429s",
    );
    assert.equal(
      longer.eventsOfType("provider.retry.scheduled")[0]?.payload.source,
      "provider-hint",
    );
    assert.equal(longer.eventsOfType("provider.retry.scheduled")[0]?.payload.retryAfterMs, 30_000);

    const shorter = createHarness({
      rounds: [[{ kind: "raw", status: 429, body: "slow down", retryAfterMs: 50 }], doneRound],
      tools: fileTools(),
      random: () => 0.5,
    });
    await shorter.start();
    assert.deepEqual(
      shorter.waits,
      [1_000],
      "and a hint shorter than the schedule is ignored rather than honoured",
    );
    assert.equal(shorter.eventsOfType("provider.retry.scheduled")[0]?.payload.source, "schedule");
  });

  it("spends exactly the configured budget, then asks instead of failing — and D-043's floor is a schema minimum", async () => {
    const harness = createHarness({
      rounds: [[{ kind: "fail", class: "overloaded" }]],
      tools: fileTools(),
      limits: { providerAttempts: 5 },
      random: () => 0.5,
    });
    const outcome = await harness.start();

    // D-044's second rung, and the whole of it: a spent budget on a retryable class asks. §4.1 makes `failed` absorbing,
    // so failing first would be a task nothing could ever answer (F-50).
    assert.equal(outcome.kind, "awaiting-model");
    assert.equal(harness.task()?.state, "awaiting_approval");
    assert.equal(
      harness.pending().length,
      0,
      "D-086's shape: the state says a human must act and the queue holds nothing to approve — there is no prompt to " +
        "deny, because what is being asked is a model",
    );
    assert.equal(
      harness.payloadOf("task.failed"),
      undefined,
      "no terminal event, so nothing anywhere claims the task ended",
    );
    assert.deepEqual(
      harness.waits,
      [1_000, 2_000, 4_000, 8_000],
      "four waits between five attempts, and the fifth failure asks rather than waits again",
    );
    const ask = harness.payloadOf("provider.switch.proposed");
    assert.equal(ask?.attempts, 5, "five attempts and no sixth: the budget is the caller's");
    assert.equal(ask?.limit, 5);
    assert.equal(ask?.code, "provider.overloaded");
    assert.match(
      String(ask?.reason),
      /overloaded|overload/i,
      "the provider's own words are carried, because the prompt has to tell the user what the model did",
    );
    assert.equal(
      ask?.current,
      `${harness.provider.id}/fake-tools`,
      'the ask names the pair that ran, not the word "default"',
    );
    assert.deepEqual(
      ask?.candidates,
      [],
      "this harness composed no pool, so the honest answer is an ask with no options — the single-model install's case",
    );
    assert.match(
      String(ask?.next),
      /POST \/api\/v1\/tasks\/tsk_harness\/resume/,
      "§3.6 stage 2's prompt names the act that answers it, because a client that does not know the route cannot help",
    );
    // The transition frame carries the same facts, so a client that filters `provider.switch.*` away still learns why the
    // task stopped — §5.2's retrievable-by-polling rule, for the half polling cannot carry.
    const move = harness.eventsOfType("task.state.changed").at(-1)?.payload;
    assert.equal(move?.to, "awaiting_approval");
    assert.equal((move?.ladder as { attempts?: number } | undefined)?.attempts, 5);
    assert.equal(move?.current, ask?.current);

    assert.equal(LOOP_LIMITS.providerAttempts, LIMITS_DEFAULTS.providerAttempts);
    assert.equal(
      LOOP_LIMITS.providerAttempts,
      MAX_ATTEMPTS,
      "the loop's default is the provider package's, not a copy",
    );
    assert.equal(
      validate(LimitsConfig, { providerAttempts: 4 }).ok,
      false,
      "D-043 says *at least* five attempts, so the configurable half may lengthen the ladder or shorten it to the floor and " +
        "no further — a knob that could turn the ladder off would be a knob against the decision",
    );
    assert.equal(validate(LimitsConfig, { providerAttempts: 5 }).ok, true);
  });

  it("continues an interrupted run from the boundary the dead process committed, and does not re-run its step", async () => {
    const harness = createHarness({
      rounds: [
        [{ kind: "tool-call", name: "file.read", arguments: { path: "notes.md" } }],
        // Whatever the restarted process would do next — this fixture's script never reaches it, because the first
        // process is interrupted after its step and the second starts from the saved context rather than from the start.
        doneRound,
      ],
      tools: fileTools(),
    });
    const first = await harness.start();
    assert.equal(first.kind, "completed");
    assert.equal(harness.executions.length, 1, "the read ran once, in the first process");

    // Now the restart: the same task, the state recovery leaves behind, and the boundary it left.
    const saved = harness.checkpoint();
    assert.ok(saved !== undefined, "a committed step is a committed boundary (D-095)");
    harness.interrupt();
    assert.equal(harness.task()?.state, "interrupted");
    const executionsBefore = harness.executions.length;

    const continued = await harness.loop.restart(
      {
        taskId: harness.taskId,
        modelId: saved.modelId,
        subject: harnessSubject,
        ctx: harnessCtx,
        signal: new AbortController().signal,
      },
      saved,
    );

    assert.equal(continued.kind, "completed");
    assert.equal(
      harness.executions.length,
      executionsBefore,
      "the committed step did not run again",
    );
    const resumed = harness.eventsOfType("task.resumed");
    assert.equal(
      resumed.length,
      1,
      "the move out of `interrupted` has its own event, so a client watching across the restart can tell it from a new run",
    );
    assert.deepEqual(
      resumed[0]?.payload.resumed as
        | { step?: number; boundary?: string; model?: string }
        | undefined,
      {
        boundary: saved.boundary,
        step: saved.step,
        lastSeq: saved.lastSeq,
        model: saved.modelId,
        writtenAt: saved.writtenAt,
      },
      "the coordinates of what was continued ride on it: a resume and a fresh task both move a task, and only one of them is a continuation",
    );
  });

  it("records the proposal and its result as turns, not only the completion (D-117)", async () => {
    // §2.5's second bullet: tool calls and their results stay associated with the turn they belong to. A
    // run that recorded only its completion would leave a cancelled task with a transcript that starts at the end.
    const harness = createHarness({
      rounds: [readRound, doneRound],
      tools: [{ name: "file.read", output: "notes" }],
      messages: true,
    });
    const outcome = await harness.start();
    assert.equal(outcome.kind, "completed");
    assert.deepEqual(
      harness.turns.map((turn) => turn.ordinal),
      [1, 2, 3],
      "the proposal, the result and the completion are three turns in the order they happened",
    );
    const frames = harness.eventsOfType("message.added");
    assert.equal(frames.length, 3, "each one is announced, because each one is retrievable");
    assert.equal(
      (frames[0]?.payload as { toolCalls?: unknown } | undefined)?.toolCalls !== undefined,
      true,
      "the proposal's frame names the calls it proposed — the association §2.5 asks for is not in the row",
    );
    assert.equal((frames[1]?.payload as { role: string } | undefined)?.role, "tool");
    assert.equal((frames[2]?.payload as { role: string } | undefined)?.role, "assistant");
  });

  it("compacts before the request is built, so the covered turns are not sent twice (D-113, D-117)", async () => {
    const calls: { readonly messages: readonly unknown[] }[] = [];
    const harness = createHarness({
      rounds: [readRound, doneRound],
      tools: [{ name: "file.read", output: "notes" }],
      messages: true,
      context: {
        compact: async (request) => {
          calls.push(request);
          // Nothing to do until the first turn has been recorded, which is what a real compactor sees:
          // D-117's ordinals exist only for turns the writer stored.
          if (request.messages.length < 3)
            return { kind: "unchanged", projected: 10, threshold: 5 };
          return {
            kind: "compacted",
            messages: [
              { role: "system", content: "summary of turns 1-2" },
              { role: "assistant", content: "the tail" },
            ],
            covers: { from: 1, through: 2 },
            turns: 2,
            tokensBefore: { tokens: 9000, source: "estimated" },
            stored: { id: "msg_summary", ordinal: 2 },
          };
        },
      },
    });
    const outcome = await harness.start();
    assert.equal(outcome.kind, "completed");
    const second = harness.provider.calls[1]?.messages as { role: string; content: string }[];
    assert.equal(second[0]?.role, "system", "the next request opens with the summary");
    assert.equal(second[0]?.content, "summary of turns 1-2");
    assert.equal(
      second.some((message) => message.content === "read the roadmap"),
      false,
      "and carries neither the opening message nor the turns the summary stands in for",
    );
  });

  it("surfaces a compaction that could not be written, rather than trimming quietly (D-115)", async () => {
    const harness = createHarness({
      rounds: [readRound, doneRound],
      tools: [{ name: "file.read", output: "notes" }],
      messages: true,
      context: {
        compact: async () => ({
          kind: "failed",
          reason: "compaction could not summarize the older turns after 2 attempts (rate-limit)",
        }),
      },
    });
    const outcome = await harness.start();
    assert.equal(
      outcome.kind,
      "failed",
      "the run stops rather than dropping turns nobody can see are gone",
    );
    if (outcome.kind !== "failed") return;
    assert.equal(outcome.code, "provider.context-overflow");
    assert.match(outcome.reason, /rate-limit/);
  });

  it("spends §3.4's overflow retry exactly once, and surfaces the second overflow (D-117)", async () => {
    let seen = 0;
    const harness = createHarness({
      // The fake replays its whole script per request, so a provider that reports an overflow every time is
      // what "the retry did not help" looks like from the runtime's side.
      rounds: [[{ kind: "fail", class: "context-overflow" }]],
      tools: [],
      context: {
        compact: async () => {
          seen += 1;
          return { kind: "unchanged", projected: 9000, threshold: 5734 };
        },
      },
    });
    const outcome = await harness.start();
    assert.equal(outcome.kind, "failed");
    assert.equal(harness.provider.calls.length, 2, "one attempt, one retry — and no more");
    assert.equal(seen, 2, "the compactor was asked before each of the two requests");
  });

  it("writes a turn and announces it in the same phase, or announces nothing at all (D-112)", async () => {
    const written = createHarness({ rounds: [doneRound], tools: [], messages: true });
    const outcome = await written.start();
    assert.equal(outcome.kind, "completed");
    assert.equal(written.turns.length, 1, "a completion is a turn, and it is stored");
    const frame = written.payloadOf("message.added");
    assert.equal(
      (frame as { messageId?: string } | undefined)?.messageId,
      written.turns[0]?.id,
      "D-112: the frame names the row, so a client that lost the stream can fetch the turn it announced",
    );
    assert.equal(
      (frame as { ordinal?: number } | undefined)?.ordinal,
      1,
      "and its place in the conversation",
    );

    // Without a writer: no row, and no frame either. §5.2's "anything a client must act on is also retrievable" read as a
    // rule about the announcement — a transcript built from the stream would otherwise show a turn nobody can fetch.
    const silent = createHarness({ rounds: [doneRound], tools: [] });
    assert.equal((await silent.start()).kind, "completed");
    assert.equal(silent.turns.length, 0);
    assert.equal(
      silent.payloadOf("message.added"),
      undefined,
      "a loop with no conversation store says nothing rather than saying something unretrievable — D-112's rule, and the " +
        "reason a store is a seam a caller wires rather than a global",
    );
  });

  it("refuses a rebuild that is not one, rather than rebuilding whatever it is handed", async () => {
    const harness = createHarness({ rounds: [doneRound], tools: fileTools() });
    const saved = harness.checkpoint();
    assert.equal(saved, undefined, "nothing committed, so this fixture builds the record by hand");
    const boundary = {
      taskId: harness.taskId,
      boundary: "step" as const,
      state: "running" as const,
      step: 1,
      lastSeq: 3,
      modelId: "fake-tools",
      messages: [{ role: "user" as const, content: "read the roadmap" }],
      writtenAt: 1_700_000_000_000,
    };
    const input = {
      taskId: harness.taskId,
      modelId: boundary.modelId,
      subject: { grants: ["fs.read"], clientKind: "cli" as const },
      ctx: harnessCtx,
      signal: new AbortController().signal,
    };

    const queued = await harness.loop.restart(input, boundary);
    assert.equal(queued.kind, "refused", "a queued task is not an interrupted one");
    if (queued.kind === "refused") assert.equal(queued.code, "task.not_interrupted");

    harness.interrupt();
    const foreign = await harness.loop.restart(input, { ...boundary, taskId: "tsk_someone_else" });
    assert.equal(foreign.kind, "refused", "a boundary for another task is another conversation");
    if (foreign.kind === "refused") assert.equal(foreign.code, "checkpoint.not_found");
    assert.equal(harness.task()?.state, "interrupted", "and neither refusal moved the task");

    harness.cancel({ mode: "immediate", byClientId: "cli_local", via: "cli" });
    assert.equal(harness.task()?.state, "cancelled");
    const settled = await harness.loop.restart(input, boundary);
    assert.equal(settled.kind, "refused", "§4.1: a settled task absorbs");
    if (settled.kind === "refused") assert.equal(settled.code, "task.terminal");
  });

  it("fails without asking when the class is not retryable, because another model has no better answer", async () => {
    const harness = createHarness({
      rounds: [[{ kind: "fail", class: "auth" }]],
      tools: fileTools(),
      limits: { providerAttempts: 5 },
    });
    const outcome = await harness.start();

    assert.equal(outcome.kind, "failed");
    assert.equal(
      harness.payloadOf("task.failed")?.attempts,
      1,
      "§9.2: an invalid request is not retried at all",
    );
    assert.equal(
      harness.payloadOf("provider.switch.proposed"),
      undefined,
      "no ask: a rejected key is rejected for every model, and offering a switch would be a question with no yes in it",
    );
    assert.match(String(harness.payloadOf("task.failed")?.ladder), /not retryable/);
  });

  it("records the switch and continues from the boundary, without re-running a committed step", async () => {
    const harness = createHarness({
      // A step that commits, then a ladder that runs out: the resume has to carry the read's result forward, which is
      // what "continues from the boundary" means and what a restart would have to rebuild from the checkpoint. The fake
      // replays its last round for every further call, so the second round fails as many times as the ladder needs.
      rounds: [
        [{ kind: "tool-call", name: "file.read", arguments: { path: "notes.md" } }],
        [{ kind: "fail", class: "rate-limit" }],
      ],
      tools: fileTools(),
      limits: { providerAttempts: 2 },
      random: () => 0.5,
      askCandidates: async () => [SECOND_CANDIDATE],
    });
    const outcome = await harness.start();
    assert.equal(outcome.kind, "awaiting-model");
    if (outcome.kind !== "awaiting-model") return;
    assert.deepEqual(harness.payloadOf("provider.switch.proposed")?.candidates, [SECOND_CANDIDATE]);
    assert.equal(
      harness.checkpointWrites.length,
      1,
      "the committed step wrote its boundary before the ladder ran out, and the ask wrote none — an ask is not a step",
    );
    const stepsBefore = harness.executions.length;
    assert.equal(stepsBefore, 1);

    const second = createScriptedProvider(
      [[{ kind: "text", text: "the notes are tidy; nothing else was in the way" }]],
      { id: "second" },
    );
    const answered = await harness.answerModel(outcome.run, {
      pair: { provider: "second", modelId: "fake-tools" },
      provider: second,
      byClientId: "cli_local",
      via: "telegram",
    });

    assert.equal(answered.kind, "completed");
    assert.equal(harness.task()?.state, "completed");
    assert.equal(
      harness.executions.length,
      stepsBefore,
      "the read did not run again: D-044 resumes at the boundary between completed and pending work (§3.9's first rule)",
    );
    assert.equal(
      JSON.stringify(second.calls[0]?.messages ?? []).includes("notes.md, as read"),
      true,
      "the second model was handed the context the first one had reached, which is the continuation",
    );
    assert.equal(
      second.calls[0]?.modelId,
      "fake-tools",
      "and it ran on the model the answer named",
    );
    assert.equal(
      harness.task()?.model,
      "second/fake-tools",
      "the record names what the task is using now",
    );
    assert.deepEqual(harness.task()?.modelSwitch, {
      from: `${harness.provider.id}/fake-tools`,
      to: "second/fake-tools",
      reason: String(harness.payloadOf("provider.switch.proposed")?.reason),
      stage: 2,
      reAttempted: false,
      attempts: 2,
      at: new Date(harness.clock.now()).toISOString(),
      by: "cli_local",
      via: "telegram",
    });
    const accepted = harness.payloadOf("provider.switch.accepted");
    assert.equal(
      (accepted?.model as { to?: string } | undefined)?.to,
      "second/fake-tools",
      "§3.6 stage 2: selecting an alternative counts as the user's approval for that switch, so the log carries it too",
    );
  });

  it("resumes on the same model without inventing a switch", async () => {
    const harness = createHarness({
      // Two failing rounds for the budget, then the completion — so the resumed call is the first one that succeeds, and
      // "the same model again" is a claim the fake's own call log can be asked about.
      rounds: [
        [{ kind: "fail", class: "overloaded" }],
        [{ kind: "fail", class: "overloaded" }],
        doneRound,
      ],
      tools: fileTools(),
      limits: { providerAttempts: 2 },
      random: () => 0.5,
      askCandidates: async () => [SECOND_CANDIDATE],
    });
    const outcome = await harness.start();
    assert.equal(outcome.kind, "awaiting-model");
    if (outcome.kind !== "awaiting-model") return;

    const answered = await harness.answerModel(outcome.run, {
      byClientId: "cli_local",
      via: "cli",
    });

    assert.equal(answered.kind, "completed");
    assert.equal(harness.task()?.model, undefined, "no switch means no pin on the record either");
    assert.equal(
      harness.task()?.modelSwitch,
      undefined,
      "an empty switch is not a switch to the same model",
    );
    assert.equal(harness.payloadOf("provider.switch.accepted"), undefined);
    const resumed = harness.eventsOfType("task.state.changed").at(-1)?.payload.resumed as
      | { switched?: boolean; from?: string }
      | undefined;
    assert.deepEqual(
      { switched: resumed?.switched, from: resumed?.from },
      { switched: false, from: `${harness.provider.id}/fake-tools` },
      "the answer is still an answer, and a reader asking what happened needs it to be distinguishable from continuing",
    );
    assert.deepEqual(
      harness.waits,
      [1_000],
      "a fresh stage gets a fresh budget: the ladder climbed twice and the resumed round climbs again",
    );
  });

  it("refuses an answer the ask did not ask for", async () => {
    const harness = createHarness({
      rounds: [[{ kind: "fail", class: "overloaded" }]],
      tools: fileTools(),
      limits: { providerAttempts: 2 },
      random: () => 0.5,
      askCandidates: async () => [SECOND_CANDIDATE],
    });
    const outcome = await harness.start();
    assert.equal(outcome.kind, "awaiting-model");
    if (outcome.kind !== "awaiting-model") return;
    const untouched = harness.task();

    const third = createScriptedProvider([[{ kind: "text", text: "never reached" }]], {
      id: "third",
    });
    const unoffered = await harness.answerModel(outcome.run, {
      pair: { provider: "third", modelId: "fake-tools" },
      provider: third,
    });
    assert.equal(unoffered.kind, "refused");
    if (unoffered.kind === "refused") assert.equal(unoffered.code, "model.not_offered");

    const unpaired = await harness.answerModel(outcome.run, {
      pair: { provider: SECOND_CANDIDATE.provider, modelId: "fake-tools" },
    });
    assert.equal(unpaired.kind, "refused");
    if (unpaired.kind === "refused") {
      assert.equal(
        unpaired.code,
        "model.no_provider",
        "a pair with no provider would call the old model under a new name",
      );
    }

    assert.equal(harness.task()?.state, "awaiting_approval", "refusals move nothing");
    assert.deepEqual(harness.task(), untouched);
    assert.equal(third.calls.length, 0, "and the model nobody was offered was never called");

    // The refusal that matters most: the task is terminal, so the ask is moot even though the park is still in memory.
    await harness.cancel({ mode: "immediate", byClientId: "cli_local", via: "cli" });
    assert.equal(harness.task()?.state, "cancelled");
    const afterCancel = await harness.answerModel(outcome.run, {
      pair: { provider: "second", modelId: "fake-tools" },
      provider: createScriptedProvider([[{ kind: "text", text: "never reached" }]], {
        id: "second",
      }),
    });
    assert.equal(afterCancel.kind, "refused");
    if (afterCancel.kind === "refused") {
      assert.equal(
        afterCancel.code,
        "task.terminal",
        "§4.1: a settled task absorbs, and an answer is not an exception",
      );
    }
  });

  it("stops climbing when a cancellation arrives during the backoff, and ends cancelled rather than failed", async () => {
    const harness = createHarness({
      rounds: [[{ kind: "fail", class: "rate-limit" }], doneRound],
      tools: fileTools(),
      random: () => 0.5,
      wait: async () => {
        // The user stops the task while the loop waits out a rung, which is the moment a 16 s backoff is most obviously a
        // step the runtime should not schedule.
        harness.cancel({ mode: "finish-step", reason: "stop retrying" });
      },
    });
    const outcome = await harness.start();

    assert.equal(
      outcome.kind,
      "cancelled",
      "§6.1's step 2 applies to a retry, because a retry is scheduled work",
    );
    assert.equal(harness.task()?.state, "cancelled");
    assert.equal(harness.provider.calls.length, 1, "and the second attempt was never made");
    assert.equal(harness.eventsOfType("provider.retry.attempt").length, 0);
    const evidence = outcome.kind === "cancelled" ? outcome.evidence : undefined;
    assert.equal(
      evidence?.inFlight,
      "none",
      "nothing was in flight: the ladder was between attempts",
    );
    assert.equal(evidence?.effectsUncertain, false);
  });

  it("never retries a tool step, because no tool declares itself idempotent", async () => {
    const harness = createHarness({
      rounds: [readRound, doneRound],
      tools: [
        {
          name: "file.read",
          parameters: PATH_ARGS,
          ok: false,
          output: "the read failed",
          code: "io",
        },
      ],
    });
    const outcome = await harness.start();

    assert.equal(
      outcome.kind,
      "completed",
      "the tool failed, the model was told, and the task finished",
    );
    assert.equal(
      harness.executions.length,
      1,
      "§7.3: a step whose effect is unknown is re-asked, never blindly repeated — and with `idempotent` in " +
        "`PENDING_RECORD_FIELDS` the answer is always re-ask",
    );
    assert.equal(
      harness.eventsOfType("provider.retry.scheduled").length,
      0,
      "the ladder is for provider calls",
    );
    assert.equal(harness.payloadOf("tool.execution.failed")?.code, "io");
    const secondRound = harness.provider.calls[1]?.messages as { role: string; content: string }[];
    assert.ok(
      secondRound.some(
        (message) => message.role === "tool" && message.content === "the read failed",
      ),
      "the failure is the tool's answer to the model, which is how a plan gets revised around it (§3.2)",
    );
  });

  it("stops at `cancelling` when the run is aborted, because §6's settle is not this slice", async () => {
    const harness = createHarness({ rounds: [doneRound], tools: fileTools() });
    const outcome = await harness.start({ signal: AbortSignal.abort() });

    assert.equal(outcome.kind, "cancelling");
    assert.equal(harness.task()?.state, "cancelling");
    assert.notEqual(
      harness.task()?.state,
      "cancelled",
      "§6.2 requires the record to say whether the operation stopped and whether its effects are uncertain; this loop " +
        "knows neither, and `transition()` refuses the entry without that evidence (D-083)",
    );
    assert.match(
      outcome.kind === "cancelling" ? outcome.reason : "",
      /cancellation manager/,
      "the reason names what is missing rather than leaving a task in a non-terminal state with no explanation",
    );
  });

  it("reports a tool that ignores its deadline as `timeout`, never as `failure` (D-074)", async () => {
    const stubborn = createHarness({
      rounds: [
        [{ kind: "tool-call", name: "file.read", arguments: { path: "notes.md" } }],
        doneRound,
      ],
      tools: [{ name: "file.read", parameters: PATH_ARGS, hangMs: 60, honoursSignal: false }],
      limits: { toolDeadlines: { "file.read": 15 } },
    });
    const outcome = await stubborn.start();

    assert.equal(
      outcome.kind,
      "completed",
      "a timed-out step is reported to the model, which re-plans; the task does not die for it",
    );
    const failed = stubborn.payloadOf("tool.execution.failed");
    assert.equal(
      failed?.code,
      "timeout",
      "D-074: 'it took too long' and 'it did not work' need different responses",
    );
    assert.match(String(failed?.output), /deadline/, "and the output says which clock fired");
    await sleep(90);
    assert.equal(
      stubborn.executions[0]?.aborted,
      false,
      "the executor never noticed: the loop stopped waiting for it, which is what enforcing a deadline means when the " +
        "other side will not cooperate",
    );

    const cooperative = createHarness({
      rounds: [
        [{ kind: "tool-call", name: "file.read", arguments: { path: "notes.md" } }],
        doneRound,
      ],
      tools: [{ name: "file.read", parameters: PATH_ARGS, hangMs: 5_000 }],
      limits: { toolDeadlines: { "file.read": 15 } },
    });
    await cooperative.start();
    assert.equal(
      cooperative.executions[0]?.aborted,
      true,
      "an executor that honours its signal is stopped by the same deadline, and says so itself",
    );
    assert.equal(cooperative.payloadOf("tool.execution.failed")?.code, "timeout");
  });

  it("prices D-074's three tool classes and no others, which is F-41's third clause", () => {
    assert.equal(toolDeadlineMs("file.read"), 10_000, "§5.2's `fs.*` row");
    assert.equal(toolDeadlineMs("fs.search"), 10_000);
    assert.equal(
      toolDeadlineMs("net.fetch"),
      20_000,
      "§5.2's `net.fetch` row: one request, redirects included",
    );
    assert.equal(
      toolDeadlineMs("http.request"),
      toolDeadlineMs("net.fetch"),
      "and its sibling row in the same class, from the same key: §5.2 prices the network class once, and a second " +
        "number for a second crossing of the same boundary would be a second opinion about how long a phone waits " +
        "on a stranger",
    );
    assert.equal(toolDeadlineMs("shell.run"), 120_000, "§5.2's `shell.run` row");
    assert.equal(
      toolDeadlineMs("memory.save"),
      undefined,
      "the table prices no row for this tool, so no deadline is invented for it — a number nobody decided is a number " +
        "nobody can defend",
    );
  });

  it("translates the eight `limits.*` keys the loop enforces, and omits the ones it does not (D-074's override path)", () => {
    const mapped = loopLimitsOf({
      stepsPerTask: 9,
      parallelToolSteps: 1,
      providerAbsoluteMs: 60_000,
      fsTimeoutMs: 2_000,
      netFetchTimeoutMs: 4_000,
      shellRunTimeoutMs: 30_000,
      cancellationSettleMs: 1_000,
      providerAttempts: 7,
      // The four the loop does not enforce, present in the schema and priced for other parties:
      providerConnectMs: 1,
      providerFirstTokenMs: 2,
      sqliteBusyTimeoutMs: 3,
      concurrentProviderRequests: 4,
    });
    assert.deepEqual(
      mapped,
      {
        stepsPerTask: 9,
        toolCallsPerResponse: 1,
        providerCallMs: 60_000,
        fsTimeoutMs: 2_000,
        netFetchTimeoutMs: 4_000,
        shellRunTimeoutMs: 30_000,
        cancellationSettleMs: 1_000,
        providerAttempts: 7,
      },
      "every key the loop enforces maps by its own name, and the translation `providerAbsoluteMs` → " +
        "`providerCallMs` — the two names one budget has been carried under — happens here rather than at each caller",
    );
    assert.equal(
      "refusalsBeforePause" in mapped,
      false,
      "D-086's floor has no `limits.*` key, so no config can price it: §5.2's list is timeouts and budgets, and a " +
        "policy threshold a file could lower would be a policy the file decides",
    );
    assert.equal(
      "toolDeadlines" in mapped,
      false,
      "a per-tool override no document prices is a knob no document describes, so the class table stands alone",
    );
    assert.deepEqual(
      loopLimitsOf(undefined),
      {},
      "no `limits` block means no overrides, not an error: `crabby init` writes an empty config on purpose",
    );
    const merged: LoopLimits = { ...LOOP_LIMITS, ...mapped };
    assert.equal(merged.stepsPerTask, 9, "and the merge the loop performs keeps what was set");
    assert.equal(merged.fsTimeoutMs, 2_000);
    assert.equal(
      merged.refusalsBeforePause,
      2,
      "while the fields the config cannot reach keep their defaults",
    );
  });

  it("publishes every event it stored, in order, and never from inside a transaction", async () => {
    const harness = createHarness({
      rounds: [readRound, deleteRound, doneRound],
      tools: fileTools(),
    });
    const run = suspended(await harness.start());
    harness.answer(run.approvalId, "approve", { via: "web" });
    await harness.resume(run);

    assert.deepEqual(
      harness.published.map((event) => event.id),
      harness.events.map((event) => event.id),
      "an event stored and never published is a client that never learned the truth; one published inside its own " +
        "transaction would have thrown in the harness's subscriber (§9's invariant)",
    );
    const moves = harness.events.filter((event) => event.payload.to !== undefined);
    assert.deepEqual(
      moves.map((event) => String(event.payload.to)),
      harness.states,
      "every state change has an event and every event belongs to a state change — the pairing is why `transact()` wraps both writes",
    );
    const seqs = harness.events.map((event) => event.seq);
    assert.equal(
      seqs[0],
      1,
      "`seq` starts at 1, so `lastSeq === 0` still means 'no events' (D-079)",
    );
    assert.deepEqual(
      [...seqs].sort((a, b) => a - b),
      seqs,
      "and it is monotone per task, which is what lets a client detect a gap without trusting the wall clock (§5.2)",
    );
  });

  it("reads its numbers out of config's defaults instead of keeping a second copy", () => {
    assert.equal(LOOP_LIMITS.stepsPerTask, LIMITS_DEFAULTS.stepsPerTask);
    assert.equal(
      LOOP_LIMITS.toolCallsPerResponse,
      LIMITS_DEFAULTS.parallelToolSteps,
      "D-088 reused D-074's parallel-steps number as the per-response cap, so it is one key and not two that can drift",
    );
    assert.equal(LOOP_LIMITS.providerCallMs, LIMITS_DEFAULTS.providerAbsoluteMs);
    assert.equal(LOOP_LIMITS.cancellationSettleMs, LIMITS_DEFAULTS.cancellationSettleMs);
    assert.equal(toolDeadlineMs("file.read"), LIMITS_DEFAULTS.fsTimeoutMs);
    assert.equal(toolDeadlineMs("net.fetch"), LIMITS_DEFAULTS.netFetchTimeoutMs);
    assert.equal(toolDeadlineMs("shell.run"), LIMITS_DEFAULTS.shellRunTimeoutMs);
    assert.equal(
      LOOP_LIMITS.refusalsBeforePause,
      2,
      "D-086's threshold is the one number that is *not* a config key: §5.2's `limits.*` list is about timeouts and " +
        "budgets, and a policy floor is neither",
    );
  });

  it("names config keys that exist, because a failure message is an instruction", () => {
    // F-30's rule turned on a message string: `crabby config set limits.nope` is refused by the schema's
    // `additionalProperties: false`, so a limit-trip failure that told a user to run it would be a lie with a command in
    // it. These are the three keys this package's messages name.
    for (const key of ["stepsPerTask", "parallelToolSteps", "cancellationSettleMs"]) {
      assert.equal(
        validate(LimitsConfig, { [key]: 3 }).ok,
        true,
        `limits.${key} must be settable through the schema, because a loop failure tells the user to set it`,
      );
    }
  });

  it("refuses an arbiter write that is not inside a write phase, which is how the pairing rule is checked", async () => {
    const harness = createHarness({ rounds: [deleteRound, doneRound], tools: fileTools() });
    const guarded = guardApprovals(harness.approvals, () => false);

    // Negative-tested, because a guard that cannot fire is a comment: every one of the 23 runs above passes through it,
    // and this is the assertion that says what they would have hit.
    assert.throws(
      () => guarded.sweep(harness.clock.now()),
      /outside a write phase/,
      "the arbiter's rows live in the same database as the task and its events, so a write outside the transaction is " +
        "how a row ends up saying `consumed` beside a log that says nothing (AGENT_RUNTIME.md §5.1)",
    );
    // And the reads are not guarded: a queue nobody can read between phases is a queue no interface can render.
    assert.deepEqual(guarded.list({ taskId: harness.taskId }), []);

    const run = suspended(await harness.start());
    harness.answer(run.approvalId, "approve", { via: "web" });
    const outcome = await harness.resume(run);
    assert.equal(
      outcome.kind,
      "completed",
      "the loop's own writes all pass the guard, so a full gated cycle is proof that none of them leaks outside a phase",
    );
  });

  it("refuses to start a task that is not queued, and to resume one that is terminal", async () => {
    const harness = createHarness({ rounds: [readRound, doneRound], tools: fileTools() });
    await harness.start();
    const second = await harness.start();

    assert.equal(second.kind, "refused");
    assert.equal(
      second.kind === "refused" ? second.code : "",
      "task.not_queued",
      "a task that is already moving is §7.1's recovery to resume, not a second `start` — two loops on one task is two writers of one record",
    );
    assert.equal(harness.task()?.state, "completed");
    assert.equal(
      harness.eventsOfType("task.created").length,
      0,
      "creating the task is the Gateway's route, not the loop's",
    );

    const stale = createHarness({ rounds: [deleteRound, doneRound], tools: fileTools() });
    const run = suspended(await stale.start());
    stale.answer(run.approvalId, "approve", { via: "web" });
    await stale.resume(run);
    const after = await stale.resume(run);
    assert.equal(after.kind, "refused");
    assert.equal(
      after.kind === "refused" ? after.code : "",
      "task.terminal",
      "§4.1: a completed task is absorbing, so the approval that was open for it cannot be spent — a retry is a new task",
    );
    assert.equal(stale.executions.length, 1, "and it was not executed twice by the second resume");
  });
});

describe("D-065's boundary, as the loop commits it (D-095)", () => {
  it("writes one boundary per committed step and none for a round that only produced text", async () => {
    const harness = createHarness({ rounds: [readRound, doneRound], tools: fileTools() });

    const finished = await harness.start();
    assert.equal(finished.kind, "completed");

    assert.equal(
      harness.checkpointWrites.length,
      1,
      "the run committed one tool step and the answering round committed nothing, because D-065's boundary is a *step* " +
        "boundary and not a checkpoint per round \u2014 an event per round would be \u00a74.4's confusion of the checkpoint " +
        "with the log, and at 5 000 events per task (D-065's own retention) it would be a storage decision wearing the " +
        "name of a safety one",
    );
    const saved = harness.checkpoint();
    assert.equal(saved?.boundary, "step");
    assert.equal(saved?.step, 1);
    assert.equal(saved?.state, "running", "the state the task was in when the step committed");
    assert.equal(
      saved?.messages.length,
      3,
      "the objective, the round that asked, and the step's result",
    );
    assert.equal(
      harness.events.filter((event) => event.type.includes("checkpoint")).length,
      0,
      "and no event of any kind: `checkpoint` is not in the contract's `EventType` union at all, which is the assertion " +
        "that matters — adding a `task.checkpointed` frame to keep a comment honest would be letting the implementation " +
        "write the contract, and at one frame per step it would spend D-065's 5 000-event budget on saved state the log " +
        "already implies (§4.4's two owners, kept separate)",
    );
  });

  it("writes a prompt boundary for a gated step, and points at the approval instead of copying the action", async () => {
    const harness = createHarness({ rounds: [deleteRound, doneRound], tools: fileTools() });

    const outcome = await harness.start();
    assert.equal(outcome.kind, "awaiting-approval");
    const run = suspended(outcome);

    const saved = harness.checkpoint();
    assert.equal(
      saved?.boundary,
      "prompt",
      "the run is suspended *at* a step, which is a boundary and not a step",
    );
    assert.equal(
      saved?.step,
      1,
      "the gated step counts against D-088's budget, and the boundary says so",
    );
    assert.deepEqual(saved?.pending, {
      tool: "file.delete",
      toolCallId: run.toolCallId,
      approvalId: run.approvalId,
    });
    assert.deepEqual(
      Object.keys(saved?.pending ?? {}).sort(),
      ["approvalId", "tool", "toolCallId"],
      "three fields and no arguments: the record names the action and points at the row that authorises it, because " +
        "the arguments live in exactly one place \u2014 which is what makes D-084's binding comparison at the moment of " +
        "execution mean anything, and what keeps a redacted copy of them from being executed as if it were the original",
    );
    assert.equal(
      harness.checkpoints.view(harness.taskId)?.resume.verdict,
      "resume",
      "nothing executed, so a runner handed this record has a step to continue rather than one to repeat",
    );

    harness.answer(run.approvalId, "approve", { via: "web" });
    const after = await harness.resume(run);
    assert.equal(after.kind, "completed");
    assert.equal(
      harness.checkpoint()?.boundary,
      "step",
      "and the answered step commits its own boundary on the way out, replacing the prompt one rather than joining it: " +
        "one row per task, which is D-095's first rule",
    );
  });

  it("commits a boundary for a step policy refused, because the refusal is the step's outcome", async () => {
    const denied = createHarness({
      rounds: [deleteRound, doneRound],
      tools: fileTools(),
      // No `fs.write`, so `file.delete` is a capability this identity does not hold: `deny`, not a prompt.
      grants: ["fs.read", "task.read"],
    });
    assert.equal((await denied.start()).kind, "completed");
    assert.equal(
      denied.checkpointWrites.length,
      1,
      "a denied action is a committed boundary too \u2014 the model was told why, the step count moved, and a resume from " +
        "here repeats nothing",
    );
    assert.equal(denied.executions.length, 0, "and the refusal is not an effect to reconcile");

    const undeclared = createHarness({
      rounds: [[{ kind: "tool-call", name: "browser.open", arguments: {} }], doneRound],
      tools: fileTools(),
    });
    assert.equal((await undeclared.start()).kind, "completed");
    assert.equal(
      undeclared.checkpointWrites.length,
      1,
      "a tool no executor declares is the same case: the step has an outcome (\u00a73.1's third rule, refused), the run " +
        "continues from it, and a resume would see the same refusal",
    );
  });

  it("writes nothing for D-086's pause, because a pause is a state and not a step", async () => {
    const otherTarget = [
      { kind: "tool-call", name: "file.delete", arguments: { path: `${WORKSPACE}/dist` } },
    ] as const;
    const harness = createHarness({
      rounds: [deleteRound, otherTarget, doneRound],
      tools: fileTools(),
    });
    const first = suspended(await harness.start());
    harness.answer(first.approvalId, "deny", { via: "tui" });
    const second = suspended(await harness.resume(first));
    harness.answer(second.approvalId, "deny", { via: "tui" });
    const before = harness.checkpointWrites.length;

    const paused = await harness.resume(second);

    assert.equal(paused.kind, "paused");
    assert.equal(
      harness.checkpointWrites.length,
      before,
      "the pause adds a `task.progress` frame and no boundary: no step committed, so D-065 has nothing to write, and a " +
        "pause that moved the resume point would be a pause that repeated the work it stopped",
    );
  });

  it("refuses to commit a boundary outside the phase that records the step", async () => {
    const harness = createHarness({ rounds: [doneRound], tools: [] });
    await harness.start();

    assert.throws(
      () =>
        harness.checkpoints.commit({
          taskId: harness.taskId,
          boundary: "step",
          step: 9,
          modelId: "fake-tools",
          messages: [],
        }),
      /outside a transaction/,
      "the harness guards the checkpoint the way it guards the arbiter, so \u00a7D-095's second rule is enforced in a test " +
        "rather than requested in a comment: a boundary written after the commit could exist for a step a rollback took " +
        "back, and that is a resume point that lies",
    );
  });
});
