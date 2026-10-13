// §6 as behaviour. The manager half — what a request records, what a settle writes, and the two refusals §4.1 forces —
// and the loop half, which is the part a table cannot carry: the step in flight is allowed to finish, the one after it is
// never started, and the uncertainty §6.2 demands is written down rather than assumed away.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LoopOutcome } from "./loop.ts";
import { createHarness, WORKSPACE } from "./loop-harness.ts";

const PATH_ARGS = { type: "object", properties: { path: { type: "string" } } } as const;
const BUILD = `${WORKSPACE}/build`;

const twoReads = [
  { kind: "tool-call", name: "file.read", arguments: { path: "a.md" } },
  { kind: "tool-call", name: "file.read", arguments: { path: "b.md" } },
] as const;
const deleteRound = [
  { kind: "tool-call", name: "file.delete", arguments: { path: BUILD } },
] as const;
const doneRound = [{ kind: "text", text: "finished" }] as const;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for a fact instead of sleeping a guessed amount: a test that races its own fixture is a test that goes red on a
 *  loaded machine, which is how a suite teaches people to re-run it. */
async function until(predicate: () => boolean, what: string, ms = 1_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) await sleep(5);
  assert.ok(predicate(), `timed out waiting for ${what}`);
}

function cancelled(outcome: LoopOutcome): Extract<LoopOutcome, { kind: "cancelled" }> {
  if (outcome.kind !== "cancelled") {
    assert.fail(`expected the task to be cancelled; the run ended \`${outcome.kind}\``);
  }
  return outcome;
}

describe("the cancellation manager (§6.1's request, §6.2's evidence)", () => {
  it("records a request for a task with nothing in flight, and settles it in the same breath", () => {
    const harness = createHarness({ rounds: [doneRound], tools: [] });
    const result = harness.cancel({
      mode: "finish-step",
      byClientId: "cln_phone",
      via: "telegram",
      reason: "not now",
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(
      result.ok && result.settled,
      true,
      "§6.1's step 3 has no step to wait for, so step 6 applies at once",
    );
    assert.equal(harness.task()?.state, "cancelled");
    assert.deepEqual(
      harness.states,
      ["cancelling", "cancelled"],
      "§4.1 gives `cancelled` exactly one way in",
    );
    const payload = harness.payloadOf("task.cancelled");
    assert.equal(
      payload?.terminated,
      true,
      "§6.2: the request is distinguished from confirmed termination, and here it is confirmed",
    );
    assert.equal(
      payload?.effectsUncertain,
      false,
      "nothing was running, so no external effect is in doubt",
    );
    assert.equal(payload?.inFlight, "none");
    assert.equal(payload?.by, "cln_phone", "§6.1's step 1 is a *record*, and a record says who");
    assert.equal(payload?.via, "telegram");
    assert.equal(payload?.reason, "not now");
    assert.equal(payload?.mode, "finish-step");
    assert.match(
      String(payload?.checkpoint),
      /no checkpoint was committed/,
      "§6.1's step 5 asks for checkpoint information, and this run never reached a committed step boundary: saying so is " +
        "the honest version of the step, while omitting the field would read as 'there was nothing to save'",
    );
  });

  it("refuses to cancel a task whose outcome is already recorded", async () => {
    const harness = createHarness({ rounds: [doneRound], tools: [] });
    const finished = await harness.start();
    assert.equal(finished.kind, "completed");

    const result = harness.cancel({});

    assert.equal(result.ok, false);
    assert.equal(result.ok ? "" : result.code, "terminal");
    assert.match(
      result.ok ? "" : result.reason,
      /terminal and absorbing/,
      "§4.1: cancellation stops work, it does not rewrite an outcome — a retry is a new task",
    );
    assert.equal(
      harness.eventsOfType("task.cancelled").length,
      0,
      "nothing was written by the refusal",
    );
    assert.equal(harness.task()?.state, "completed");
  });

  it("records one request however many interfaces relay it", () => {
    const harness = createHarness({ rounds: [deleteRound, doneRound], tools: [] });
    const first = harness.cancel({ via: "tui", byClientId: "cln_a" });
    const second = harness.cancel({ via: "web", byClientId: "cln_b" });

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.ok && second.deduplicated, true);
    assert.equal(
      harness.eventsOfType("task.state.changed").length,
      1,
      "one cancellation is one fact: a second `cancelling` frame would tell every client the user asked twice",
    );
    assert.equal(
      second.ok && second.settled,
      true,
      "and the answer says the task is already cancelled, which is what a double-tap on a phone needs to hear",
    );
    assert.equal(harness.eventsOfType("task.cancelled").length, 1);
  });

  it("lets an immediate request override a finish-step one, because §6.2 says MUST", async () => {
    const harness = createHarness({
      rounds: [twoReads, doneRound],
      tools: [{ name: "file.read", parameters: PATH_ARGS, hangMs: 5_000 }],
    });
    const running = harness.start();
    await until(
      () => harness.eventsOfType("tool.execution.started").length === 1,
      "the step to start",
    );

    const first = harness.cancel({ mode: "finish-step", byClientId: "cln_phone" });
    assert.equal(first.ok, true);
    assert.equal(
      first.ok && first.settled,
      false,
      "finish-the-current-step waits, so the task is in `cancelling` and not yet `cancelled`",
    );
    assert.equal(harness.task()?.state, "cancelling");

    const second = harness.cancel({
      mode: "immediate",
      reason: "it is reading a file it should not",
    });
    assert.equal(second.ok, true);
    assert.equal(
      second.ok && second.escalated,
      true,
      "§6.2: the override has to be deliverable by a second request, or MUST is advice",
    );
    assert.equal(second.ok && second.request.mode, "immediate");
    const progress = harness.payloadOf("task.progress");
    assert.equal(progress?.cancellation, "escalated");
    assert.equal(progress?.reason, "it is reading a file it should not");
    assert.equal(
      harness.events.filter((event) => event.payload.to === "cancelling").length,
      1,
      "the escalation is a fact about the request, not a second move into `cancelling`",
    );

    const outcome = cancelled(await running);
    assert.equal(
      harness.executions[0]?.aborted,
      true,
      "the override aborted the step the first request would have let finish",
    );
    assert.equal(outcome.evidence.inFlight, "tool");
    assert.equal(harness.task()?.state, "cancelled");
  });

  it("does not escalate once the task has settled, because there is nothing left to override", () => {
    const harness = createHarness({ rounds: [deleteRound, doneRound], tools: [] });
    const first = harness.cancel({ mode: "finish-step" });
    assert.equal(first.ok, true);
    assert.equal(
      first.ok && first.settled,
      true,
      "nothing was in flight, so the first request settled it",
    );

    const second = harness.cancel({ mode: "immediate", reason: "stop now" });

    assert.equal(second.ok, true);
    assert.equal(second.ok && second.deduplicated, true);
    assert.notEqual(second.ok && second.escalated, true);
    assert.equal(
      harness.eventsOfType("task.progress").length,
      0,
      "an event about stopping work that has already stopped is noise in the one log a user reads afterwards",
    );
  });

  it("will not settle a task nobody asked to cancel", () => {
    const harness = createHarness({ rounds: [doneRound], tools: [] });
    const result = harness.cancellation.settle({
      taskId: harness.taskId,
      evidence: { terminated: true, effectsUncertain: false, inFlight: "none" },
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok ? "" : result.code, "not-cancelling");
    assert.match(
      result.ok ? "" : result.reason,
      /record the request first/,
      "`cancelled` is reachable only from `cancelling` (D-083), so a settle from `queued` would be the runtime ending work on its own initiative",
    );
    assert.equal(harness.task()?.state, "queued");
    assert.equal(harness.events.length, 0, "and the refusal wrote nothing");
  });

  it("lists only the tasks still waiting to settle", async () => {
    const harness = createHarness({
      rounds: [[{ kind: "tool-call", name: "file.read", arguments: { path: "a.md" } }], doneRound],
      tools: [{ name: "file.read", parameters: PATH_ARGS, hangMs: 120 }],
    });
    assert.deepEqual(harness.cancellation.outstanding(), []);
    const running = harness.start();
    await until(
      () => harness.eventsOfType("tool.execution.started").length === 1,
      "the step to start",
    );
    harness.cancel({ mode: "finish-step" });
    assert.equal(
      harness.cancellation.outstanding().length,
      1,
      "a task in `cancelling` with a step still running is the one thing this list exists to show",
    );
    await running;
    assert.deepEqual(
      harness.cancellation.outstanding(),
      [],
      "and it empties when the task settles",
    );
  });
});

describe("the loop honouring a cancellation (§6.1's steps 2 to 6)", () => {
  it("lets the step in flight finish, then cancels instead of scheduling another", async () => {
    const harness = createHarness({
      rounds: [twoReads, doneRound],
      tools: [{ name: "file.read", parameters: PATH_ARGS, hangMs: 120, output: "read a.md" }],
    });
    const running = harness.start();
    await until(
      () => harness.eventsOfType("tool.execution.started").length === 1,
      "the first step to start",
    );

    const requested = harness.cancel({
      mode: "finish-step",
      byClientId: "cln_phone",
      reason: "stop after this",
    });
    assert.equal(requested.ok, true);
    assert.equal(
      requested.ok && requested.settled,
      false,
      "§6.1's step 3: a step is in flight, so the manager waits for the loop instead of settling over it",
    );

    const outcome = cancelled(await running);
    assert.equal(harness.executions.length, 1, "the round proposed two calls and exactly one ran");
    assert.equal(
      harness.provider.calls.length,
      1,
      "and no new provider round was scheduled: §6.1's MUST NOT — a step completing after the request is not a reason to start another",
    );
    assert.equal(
      harness.executions[0]?.aborted,
      false,
      "finish-the-current-step means the step was *not* aborted: it kept the deadline it was already given (D-074) and no second clock was invented",
    );
    assert.equal(
      harness.eventsOfType("tool.execution.completed").length,
      1,
      "§6.1's step 4: the resulting status and available output are captured before the task is marked cancelled",
    );
    assert.equal(outcome.evidence.inFlight, "tool");
    assert.equal(
      outcome.evidence.terminated,
      true,
      "the executor returned, so the operation is confirmed stopped",
    );
    assert.equal(
      outcome.evidence.effectsUncertain,
      true,
      "§6.2: a tool step may already have taken effect, and no tool in this build declares `sideEffects`, so the runtime records the doubt instead of guessing (D-089)",
    );
    assert.equal(harness.task()?.state, "cancelled");
    assert.equal(harness.eventsOfType("task.cancelled").length, 1);
    assert.deepEqual(
      harness.states.slice(-3),
      ["running", "cancelling", "cancelled"],
      "and the path is the one §4.1 permits",
    );
  });

  it("aborts the step in flight when the request is safety-critical", async () => {
    const harness = createHarness({
      rounds: [twoReads, doneRound],
      tools: [{ name: "file.read", parameters: PATH_ARGS, hangMs: 5_000 }],
    });
    const running = harness.start();
    await until(
      () => harness.eventsOfType("tool.execution.started").length === 1,
      "the step to start",
    );

    const requested = harness.cancel({
      mode: "immediate",
      reason: "it is reading a file it should not",
    });
    assert.equal(requested.ok, true);
    const outcome = cancelled(await running);

    assert.equal(
      harness.executions[0]?.aborted,
      true,
      "§6.2's override: continuing would create unacceptable harm or leak sensitive data, so the step is stopped rather than finished",
    );
    assert.equal(harness.executions.length, 1, "and the second call in the round never started");
    assert.equal(outcome.evidence.inFlight, "tool");
    assert.equal(
      outcome.evidence.terminated,
      true,
      "the executor honoured its signal and reported back",
    );
    assert.equal(outcome.evidence.effectsUncertain, true);
    assert.equal(harness.task()?.state, "cancelled");
  });

  it("records that an executor which ignores its signal may still be running", async () => {
    const harness = createHarness({
      rounds: [twoReads, doneRound],
      tools: [{ name: "file.read", parameters: PATH_ARGS, hangMs: 80, honoursSignal: false }],
      limits: { toolDeadlines: { "file.read": 20 } },
    });
    const running = harness.start();
    await until(
      () => harness.eventsOfType("tool.execution.started").length === 1,
      "the step to start",
    );
    harness.cancel({ mode: "immediate" });
    const outcome = cancelled(await running);

    assert.equal(
      outcome.evidence.terminated,
      false,
      "§6.2's other half: the loop stopped *waiting*, which is not the same as the operation stopping, and the difference is recorded rather than flattened",
    );
    assert.equal(outcome.evidence.effectsUncertain, true);
    assert.equal(outcome.evidence.step?.code, "timeout");
  });

  it("cancels a task waiting on a prompt, and the answer that arrives afterwards cannot be spent", async () => {
    const harness = createHarness({
      rounds: [deleteRound, doneRound],
      tools: [{ name: "file.delete", parameters: PATH_ARGS, output: "removed build/" }],
    });
    const outcome = await harness.start();
    assert.equal(outcome.kind, "awaiting-approval");
    if (outcome.kind !== "awaiting-approval") return;

    const requested = harness.cancel({ mode: "finish-step", reason: "do not delete anything" });
    assert.equal(requested.ok, true);
    assert.equal(
      requested.ok && requested.settled,
      true,
      "a prompt is not an execution step, so there is nothing to finish",
    );
    assert.equal(harness.task()?.state, "cancelled");

    const after = await harness.resume(outcome.run);
    assert.equal(after.kind, "refused");
    assert.equal(
      after.kind === "refused" ? after.code : "",
      "task.terminal",
      "§4.1: the task is absorbing now, so the approval that was open for it cannot be spent",
    );
    assert.equal(
      harness.pending()[0]?.state,
      "pending",
      "the row is left as it stands and expires inside D-064's window: withdrawing it would need a sixth approval state, and inventing one to tidy a queue is not the trade this project makes",
    );
    assert.equal(harness.executions.length, 0);
  });

  it("still stops at `cancelling` when an abort arrives with no request behind it", async () => {
    const harness = createHarness({ rounds: [doneRound], tools: [] });
    const outcome = await harness.start({ signal: AbortSignal.abort() });

    assert.equal(outcome.kind, "cancelling");
    assert.equal(harness.task()?.state, "cancelling");
    assert.match(
      outcome.kind === "cancelling" ? outcome.reason : "",
      /no cancellation was recorded/,
      "§6.2's evidence is a fact about a cancellation; with nobody asking, settling would be the runtime inventing a requester",
    );
  });
});
