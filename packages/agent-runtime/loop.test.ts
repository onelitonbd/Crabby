// The loop, asserted as the sentences it implements rather than as a state dump: what §5's six rules require of a run,
// what §6.3 requires of a prompt, what D-087's edge makes reachable, and what the loop refuses to pretend it has (no
// retry ladder, no cancellation settle, no executor). Every message names the rule it is arguing for, because the same
// sentence is what a reviewer reads when one of these goes red in a year's time.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validate } from "@crabby/api-contracts";
import { LIMITS_DEFAULTS, LimitsConfig } from "@crabby/core";
import { type EvalContext, evaluate } from "@crabby/policy";
import {
  LOOP_LIMITS,
  type LoopOutcome,
  type SuspendedRun,
  toolDeadlineMs,
  withheldReason,
} from "./loop.ts";
import {
  createHarness,
  guardApprovals,
  type Harness,
  type HarnessTool,
  WORKSPACE,
} from "./loop-harness.ts";

const PATH_ARGS = { type: "object", properties: { path: { type: "string" } } } as const;
const BUILD = `${WORKSPACE}/build`;
const T2_TTL = 10 * 60_000; // D-064's T2 window, restated as the number a test moves the clock by.
const T3_TTL = 5 * 60_000; // D-064's T3 window.

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

describe("the loop that opens a request (§5's rule 1, PROVIDERS_AND_TOOLS.md §4.4)", () => {
  it("completes a task that needs nothing approved, passing through `running` because §4.1 has no shortcut", async () => {
    const harness = createHarness({ rounds: [doneRound], tools: [] });
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
      "the answer is logged as a message, because §10.1 requires progress to reflect recorded state rather than claims",
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

  it("fails on the first provider error, and says out loud that no ladder ran", async () => {
    const harness = createHarness({
      rounds: [[{ kind: "fail", class: "rate-limit" }], doneRound],
      tools: fileTools(),
    });
    const outcome = await harness.start();

    assert.equal(outcome.kind, "failed");
    assert.equal(outcome.kind === "failed" ? outcome.code : "", "provider.rate-limit");
    assert.equal(harness.task()?.state, "failed");
    const payload = harness.payloadOf("task.failed");
    assert.equal(
      payload?.retried,
      false,
      "D-043's ladder is not in this build, and the event says so instead of implying five attempts",
    );
    assert.match(String(payload?.ladder), /D-043/);
    const recorded = harness.task()?.error?.message;
    assert.ok(
      typeof recorded === "string" && recorded.length > 0,
      "the reason is on the record, so a phone that missed the event still sees why (§5.2's polling rule)",
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
    assert.equal(toolDeadlineMs("shell.run"), 120_000, "§5.2's `shell.run` row");
    assert.equal(
      toolDeadlineMs("memory.save"),
      undefined,
      "the table prices no row for this tool, so no deadline is invented for it — a number nobody decided is a number " +
        "nobody can defend",
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
