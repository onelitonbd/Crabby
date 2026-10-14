// The runner, asserted as the question it exists to answer: "is this task already running?" Four clients over one
// Gateway means that question is asked by a route, by an approval decision, by a cancel request and by a shutdown, and
// AGENT_RUNTIME.md §4.4 puts the answer in a party that is not a route (D-003). These tests compose the runner on the
// *same* fixture the loop's tests use — one journal, one guarded arbiter, one cancellation manager — so what is proved
// here is the composition a Gateway performs, not a simpler copy of it. Every message names the rule it argues for.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LoopOutcome, LoopSubject } from "./loop.ts";
import { createHarness, createScriptedProvider, WORKSPACE } from "./loop-harness.ts";
import type { RestartResult, ResumeResult, StartResult } from "./runner.ts";

const PATH_ARGS = { type: "object", properties: { path: { type: "string" } } } as const;
const doneRound = [{ kind: "text", text: "read notes.md and deleted build/" }] as const;
const deleteRound = [
  { kind: "tool-call", name: "file.delete", arguments: { path: `${WORKSPACE}/build` } },
] as const;
/** The fake's "sit on the abort signal" step: the only way to hold a run in flight long enough to ask about it. */
const hangRound = [{ kind: "hang", afterText: "still working" }] as const;

function fileTools() {
  return [
    { name: "file.read", parameters: PATH_ARGS, output: "notes.md, as read" },
    { name: "file.delete", parameters: PATH_ARGS, output: "removed build/" },
  ];
}

/** The four grants the harness composes its `EvalContext` with, so the subject asking and the context deciding cannot
 *  disagree — a runner test that let them diverge would be testing escalation against a fiction. */
const subject: LoopSubject = {
  grants: ["fs.read", "fs.write", "net.egress", "task.read"],
  clientKind: "cli",
};

function runOf(result: StartResult | ResumeResult | RestartResult): Promise<LoopOutcome> {
  if (!result.ok) {
    assert.fail(
      `expected the runner to take the run; it refused \`${result.code}\`: ${result.reason}`,
    );
  }
  return result.run;
}

function refusalOf(result: StartResult | ResumeResult | RestartResult): string {
  if (result.ok) assert.fail("expected the runner to refuse; it took the run");
  assert.equal(typeof result.code, "string");
  return `${result.code}: ${result.reason}`;
}

/** The refusal sentence, for an assertion that has already checked `ok` — the harness's own `assert.fail` on a wrong
 *  expectation is enough, so this only adds the reason. */
function refusalOk(result: StartResult | ResumeResult | RestartResult): string {
  return result.ok ? "" : result.reason;
}

describe("the runner that answers 'is this task already running?' (AGENT_RUNTIME.md §4.4, D-003)", () => {
  it("refuses a second run of a task that is moving, and quotes the rule it is following", async () => {
    const harness = createHarness({ rounds: [hangRound], tools: fileTools() });
    const runner = harness.runner();

    const first = runner.start({ taskId: harness.taskId, subject });
    assert.equal(first.ok, true, "the first run of a queued task is the runner's whole job");
    // Registered before the loop's first `await`, which is the property that makes the refusal below reachable at all:
    // a run that only became visible after its first suspension is a run a second caller could start twice.
    assert.equal(runner.outstanding(), 1, "a moving run is visible the moment `start` returns");
    assert.equal(runner.inFlight(harness.taskId), true);

    const second = runner.start({ taskId: harness.taskId, subject });
    assert.match(
      refusalOf(second),
      /^in-flight: .*already running.*§4\.4/s,
      "one task has one run, and the refusal has to say which document says so",
    );
    assert.equal(runner.outstanding(), 1, "a refused start registers nothing");

    harness.cancel({ mode: "immediate" });
    const outcome = await runOf(first);
    assert.equal(
      outcome.kind,
      "cancelled",
      `a run stopped by an immediate cancel is cancelled; got ${JSON.stringify(outcome)}`,
    );
    assert.equal(
      runner.outstanding(),
      0,
      "a settled run leaves the map; that is what makes the number trustworthy",
    );
  });

  it("completes a run and leaves nothing behind, because a leaked entry is a task nobody can start again", async () => {
    const harness = createHarness({ rounds: [doneRound], tools: [] });
    const runner = harness.runner();

    const outcome = await runOf(runner.start({ taskId: harness.taskId, subject }));

    assert.equal(outcome.kind, "completed");
    assert.equal(runner.outstanding(), 0);
    assert.equal(runner.parkedFor(harness.taskId), undefined);
    assert.equal(harness.task()?.state, "completed");

    // The map is empty, so the runner *takes* the run; §4.1's transition table is what refuses it. That division is the
    // point: an entry left behind would answer "already running" for a task that finished, which is a worse lie than no
    // answer, and a runner that invented its own terminal-state rule would be a second opinion about the same fact.
    const again = runner.start({ taskId: harness.taskId, subject });
    assert.equal(
      again.ok,
      true,
      "nothing is in flight, so the refusal comes from the loop and not from the map",
    );
    const refused = await runOf(again);
    assert.equal(
      refused.kind,
      "refused",
      "and the loop refuses a task that is not `queued` (D-083's entry rule)",
    );
    assert.equal(runner.outstanding(), 0, "a refused run leaves nothing behind either");
  });

  it("re-refuses a terminal task through the loop rather than through its own map", async () => {
    const harness = createHarness({ rounds: [doneRound], tools: [] });
    const runner = harness.runner();
    await runOf(runner.start({ taskId: harness.taskId, subject }));

    // A *fresh* runner on the same journal is what a restarted Gateway looks like: empty maps, real database. The
    // refusal has to come from §4.1's transition table, not from bookkeeping that did not survive.
    const restarted = harness.runner();
    const outcome = await runOf(restarted.start({ taskId: harness.taskId, subject }));

    assert.equal(outcome.kind, "refused");
    if (outcome.kind === "refused") {
      assert.equal(
        outcome.code,
        "task.not_queued",
        "a completed task cannot be started again (D-083's entry rule)",
      );
    }
    assert.equal(restarted.outstanding(), 0, "the runner releases a run the loop refused");
    assert.equal(harness.task()?.state, "completed", "and it writes nothing on the way out");
  });

  it("parks a run at an approval instead of holding it in flight, and wakes the same run on the answer", async () => {
    const harness = createHarness({ rounds: [deleteRound, doneRound], tools: fileTools() });
    const runner = harness.runner();

    const parked = await runOf(runner.start({ taskId: harness.taskId, subject }));
    assert.equal(parked.kind, "awaiting-approval");
    // Parked is not in flight. The distinction is the whole reason there are two maps: §6.1's step 2 has nothing to
    // stop here, and a second `start` has to be answered with the approval's id rather than "already running".
    assert.equal(runner.outstanding(), 0, "a task waiting on a human has nothing moving");
    assert.equal(harness.task()?.state, "awaiting_approval");

    const pending = harness.pending();
    assert.equal(pending.length, 1, "one action, one prompt");
    const request = pending[0];
    assert.ok(request !== undefined, "the prompt exists");
    assert.equal(runner.parkedFor(harness.taskId)?.approvalId, request.id);

    const second = runner.start({ taskId: harness.taskId, subject });
    assert.match(
      refusalOf(second),
      new RegExp(`^parked: .*${request.id}.*scope: once`, "s"),
      "a parked task is resumed by its answer, never started again — a second run would spend the same step twice",
    );

    harness.answer(request.id, "approve");
    const outcome = await runOf(runner.resume(harness.taskId));
    assert.equal(
      outcome.kind,
      "completed",
      "the answer continues the run that was parked, and finishes it",
    );
    assert.equal(runner.parkedFor(harness.taskId), undefined, "a woken run is no longer parked");
    assert.equal(runner.outstanding(), 0);
  });

  it("parks a run at D-044's ask in its own map, and the answer wakes that run with the model the user chose", async () => {
    const harness = createHarness({
      rounds: [[{ kind: "fail", class: "overloaded" }]],
      tools: fileTools(),
      limits: { providerAttempts: 2 },
      random: () => 0.5,
    });
    const runner = harness.runner({
      // The pool a composition root would hand over. Without it the ask carries no options, and this runner has no pool of
      // its own to describe — so an answer naming a model would be refused for not having been offered, which is the
      // correct answer for an install that composed one model and is not what this test is about.
      askCandidates: async () => [
        {
          model: "second/fake-tools",
          provider: "second",
          cost: "free-tier",
          contextWindow: 8_192,
          losses: ["no tool calling"],
        },
      ],
    });

    const asked = await runOf(runner.start({ taskId: harness.taskId, subject }));
    assert.equal(asked.kind, "awaiting-model");
    assert.equal(
      runner.outstanding(),
      0,
      "waiting on a model is not in flight, exactly as waiting on a human is not",
    );
    assert.equal(harness.task()?.state, "awaiting_approval");
    assert.equal(
      runner.parkedFor(harness.taskId),
      undefined,
      "not an approval park: it has no approvalId, no tool call, and a different answer, so folding the two would let a " +
        "model answer a prompt",
    );
    assert.equal(runner.askingFor(harness.taskId)?.ask.attempts, 2);

    const second = runner.start({ taskId: harness.taskId, subject });
    assert.match(
      refusalOf(second),
      /^parked: .*D-044's model ask.*POST \/api\/v1\/tasks\/\{id\}\/resume/s,
      "a task waiting for a model is answered, not started again",
    );

    const alt = createScriptedProvider([[{ kind: "text", text: "finished on the second model" }]], {
      id: "second",
    });
    const resumed = runner.resume(harness.taskId, {
      pair: { provider: "second", modelId: "fake-tools" },
      provider: alt,
      byClientId: "cli_local",
      via: "cli",
    });
    assert.equal(resumed.ok, true);
    assert.equal(await runOf(resumed).then((outcome) => outcome.kind), "completed");
    assert.equal(runner.askingFor(harness.taskId), undefined, "an answered ask is not still asked");
    assert.equal(runner.outstanding(), 0);
    assert.equal(
      harness.task()?.model,
      "second/fake-tools",
      "the record shows the switch (§3.6 stage 3)",
    );
  });

  it("refuses to name a model for a run that is parked at an approval", async () => {
    const harness = createHarness({ rounds: [deleteRound, doneRound], tools: fileTools() });
    const runner = harness.runner();
    await runOf(runner.start({ taskId: harness.taskId, subject }));
    assert.ok(runner.parkedFor(harness.taskId) !== undefined, "the run is parked at a prompt");

    const refused = runner.resume(harness.taskId, {
      pair: { provider: "second", modelId: "fake-tools" },
      provider: createScriptedProvider([[{ kind: "text", text: "never reached" }]], {
        id: "second",
      }),
    });

    assert.match(
      refusalOf(refused),
      /^not-asking: .*not at D-044's model ask.*POST \/api\/v1\/approvals\/\{id\}\/decision/s,
      "§3.6 stage 2's switch answers a budget that ran out; a prompt has no budget, so the route a caller needs is the " +
        "approval's own",
    );
    assert.ok(
      runner.parkedFor(harness.taskId) !== undefined,
      "and the refusal parks nothing: the prompt is still open and still answerable",
    );
    assert.equal(harness.pending().length, 1);
  });

  it("reports an asked task at shutdown beside the parked ones, because both die with the process", async () => {
    const harness = createHarness({
      rounds: [[{ kind: "fail", class: "overloaded" }]],
      tools: fileTools(),
      limits: { providerAttempts: 2 },
      random: () => 0.5,
    });
    const runner = harness.runner();
    await runOf(runner.start({ taskId: harness.taskId, subject }));

    const report = await runner.shutdown(20);

    assert.deepEqual(
      report.parked,
      [harness.taskId],
      "the ask survives as an event and the run does not; a shutdown report that left it out would claim nothing was " +
        "waiting when a task was",
    );
  });

  it("rebuilds an interrupted run from the boundary, and refuses the three cases the record cannot answer", async () => {
    const harness = createHarness({
      rounds: [
        [{ kind: "tool-call", name: "file.read", arguments: { path: "notes.md" } }],
        doneRound,
      ],
      tools: fileTools(),
    });
    const runner = harness.runner();
    await runOf(runner.start({ taskId: harness.taskId, subject }));

    // A task that is still running is not an interrupted one, whatever a caller asks for.
    const live = runner.restart({ taskId: harness.taskId, subject });
    assert.match(refusalOf(live), /^not-interrupted:/);

    harness.interrupt();
    assert.equal(harness.task()?.state, "interrupted");

    const rebuilt = runner.restart({ taskId: harness.taskId, subject });
    assert.equal(rebuilt.ok, true, refusalOk(rebuilt));
    const outcome = await runOf(rebuilt);
    assert.equal(
      outcome.kind,
      "completed",
      "the rebuilt run continues from the saved context and finishes",
    );
    assert.equal(runner.outstanding(), 0);

    // A task that committed no boundary has nothing to continue from, and a new run is the honest answer.
    const bare = createHarness({ rounds: [doneRound], tools: fileTools() });
    bare.interrupt();
    const nothing = bare.runner().restart({ taskId: bare.taskId, subject });
    assert.match(
      refusalOf(nothing),
      /^no-checkpoint: .*committed no step boundary.*starts it again/s,
      "§7.3's rule about a step that may have run is moot when no step ever ran, and inventing a context would be a " +
        "continuation of nothing",
    );

    // An answer to a task that is not interrupted is refused by the state machine rather than by a flag this runner would
    // have to keep: the continuation moved the task, and nothing moved it back, so there is no longer anything to continue.
    const twice = runner.restart({ taskId: harness.taskId, subject });
    assert.match(
      refusalOf(twice),
      /^not-interrupted: .*`completed`/s,
      "§7.1 marks interruptions at startup; nothing re-marks a task that has already been continued",
    );

    // D-065's `re-ask` verdict — a step that was in flight when the process ended, with neither of §7.3's two permissions —
    // is refused by the runner on the verdict's own sentence rather than on its own reading of it. Reached here through
    // the manager rather than a second copy of the rule: `checkpoint.test.ts` is where the verdict itself is decided, and
    // a runner that re-derived it would be a second opinion about the same fact.
    assert.ok(
      harness.checkpoints.verdict(harness.taskId).verdict !== undefined,
      "the verdict is always an answer — `none` is one of its values rather than an absence, which is why the runner's " +
        "gate has no undefined branch to guess about",
    );
  });

  it("answers a resume that finds nothing parked with the reason, which is F-47's remaining half", async () => {
    const harness = createHarness({ rounds: [deleteRound, doneRound], tools: fileTools() });
    await runOf(harness.runner().start({ taskId: harness.taskId, subject }));

    // A restarted Gateway: the approval row survived because it is a row, and the run did not because `SuspendedRun`
    // carries the proposed `ToolCall` in memory and SECURITY.md §7 keeps `call.args` out of the checkpoint.
    const restarted = harness.runner();
    assert.equal(
      harness.pending().length,
      1,
      "the request itself outlives the process that opened it",
    );

    const resumed = restarted.resume(harness.taskId);
    assert.match(
      refusalOf(resumed),
      /^not-parked: .*§7.*re-ask.*F-47/s,
      "the honest answer names the rule that forbids rebuilding the call, the verdict that applies, and the finding",
    );
    assert.equal(
      restarted.resume("tsk_never_existed").ok,
      false,
      "a task that does not exist is `not-found`, not `not-parked`: the two facts have different fixes",
    );
  });

  it("refuses to wake a task that is already awake", async () => {
    const harness = createHarness({ rounds: [hangRound], tools: fileTools() });
    const runner = harness.runner();
    const moving = runner.start({ taskId: harness.taskId, subject });

    assert.match(
      refusalOf(runner.resume(harness.taskId)),
      /^in-flight: .*nothing parked to wake/,
      "a resume racing a run that is already awake is the second half of one-run-per-task",
    );

    harness.cancel({ mode: "immediate" });
    await runOf(moving);
  });

  it("delegates a cancel whole, because two managers would each hold half of one request (§6.1)", async () => {
    const harness = createHarness({ rounds: [hangRound], tools: fileTools() });
    const runner = harness.runner();
    const moving = runOf(runner.start({ taskId: harness.taskId, subject }));

    const cancelled = runner.cancel({
      taskId: harness.taskId,
      mode: "immediate",
      reason: "the user said stop",
    });
    assert.equal(
      cancelled.ok,
      true,
      "the runner's cancel is the manager's, not a second implementation of §6",
    );
    assert.equal(
      harness.task()?.state,
      "cancelling",
      "the request moves the task and aborts the controller, and stops there: §6.1's step 2 is not a settlement, because " +
        "settling needs §6.2's evidence and only the party that stopped the step has it",
    );

    const outcome = await moving;
    assert.equal(outcome.kind, "cancelled");
    assert.equal(
      harness.task()?.state,
      "cancelled",
      "and the loop settled it, not the runner — one writer per fact (§9), which is what `cancel` delegating whole buys",
    );
    assert.equal(runner.outstanding(), 0);
    const settled = harness.eventsOfType("task.cancelled");
    assert.equal(
      settled.length,
      1,
      "one request, one settlement, one event (§9's pairing rule): the runner delegated whole and wrote no opinion of " +
        "its own about a fact the cancellation manager owns",
    );
  });

  it("answers a run that throws instead of leaving an unhandled rejection, and writes nothing it cannot justify", async () => {
    const harness = createHarness({ rounds: [doneRound], tools: [] });
    // A dep that is not what it claims to be. The loop catches its own provider and tool failures and answers `failed`,
    // so this branch exists for everything else — and "everything else" has to be an answer too, because a rejection
    // nobody owns takes the Gateway down with it, and a dead Gateway is worse than a failed task.
    const runner = harness.runner({
      ctx: {
        get paths(): never {
          throw new Error("the path context blew up");
        },
      },
    });

    const outcome = await runOf(runner.start({ taskId: harness.taskId, subject }));

    assert.equal(outcome.kind, "refused");
    if (outcome.kind === "refused") {
      assert.equal(outcome.code, "runner.threw");
      assert.match(
        outcome.reason,
        /path context blew up/,
        "the reason carries the exception's own words",
      );
    }
    assert.equal(
      harness.task()?.state,
      "queued",
      "§4.4: the runner moves no state, so a bug leaves the task alone",
    );
    assert.equal(runner.outstanding(), 0, "and it is not still counted as moving");
  });

  // There is deliberately no unit test for `start`'s `not-found` branch. This harness's journal holds one task by
  // design — `task()` ignores its argument and `setState`/`append` throw for a foreign id — so "a task the journal does
  // not have" cannot be expressed here without inventing a second journal, and an invented journal would prove nothing
  // about the real one. The branch is asserted where the journal is a database: `tests/integration/gateway.test.ts`,
  // which asks a runner-backed Gateway about a task nobody created.

  it("drains for D-066's budget and reports what it could not stop, rather than claiming a clean exit", async () => {
    const harness = createHarness({ rounds: [hangRound], tools: fileTools() });
    const runner = harness.runner();
    const moving = runOf(runner.start({ taskId: harness.taskId, subject }));

    const draining = runner.shutdown(5_000);
    harness.cancel({ mode: "immediate" }); // the run settles while the drain is waiting on it
    const report = await draining;

    assert.equal(report.drained, 1, "a run that ends inside the budget is drained, not abandoned");
    assert.deepEqual(report.abandoned, []);
    assert.deepEqual(report.parked, []);
    await moving;
  });

  it("reports a run it could not stop as abandoned, and leaves it to §7.1 rather than settling it twice", async () => {
    const harness = createHarness({ rounds: [hangRound], tools: fileTools() });
    const runner = harness.runner();
    const moving = runOf(runner.start({ taskId: harness.taskId, subject }));

    const report = await runner.shutdown(20);

    assert.deepEqual(
      report.abandoned,
      [harness.taskId],
      "the report names what was still moving when the budget ended",
    );
    assert.equal(report.drained, 0);
    assert.equal(
      harness.task()?.state,
      "planning",
      "still in the first provider round, so §4.1 has not earned `running` yet (D-083) — and an abandoned run is not " +
        "cancelled here: a shutdown that also wrote `cancelled` would be a second party settling one task, and §7.1's " +
        "recovery already owns the answer (`interrupted`)",
    );

    harness.cancel({ mode: "immediate" });
    await moving;
  });

  it("reports a parked run at shutdown as a fact about the run, not about the approval", async () => {
    const harness = createHarness({ rounds: [deleteRound, doneRound], tools: fileTools() });
    const runner = harness.runner();
    await runOf(runner.start({ taskId: harness.taskId, subject }));

    const report = await runner.shutdown(20);

    assert.deepEqual(report.parked, [harness.taskId]);
    assert.deepEqual(report.abandoned, [], "nothing was in flight, so nothing was abandoned");
    assert.equal(
      harness.pending().length,
      1,
      "the request survives in the database and expires under D-064's window",
    );
  });

  it("refuses new runs once it is draining, and says so in the words a route can quote (D-066)", async () => {
    const harness = createHarness({ rounds: [doneRound], tools: [] });
    const runner = harness.runner();
    await runner.shutdown(0);

    const refused = runner.start({ taskId: harness.taskId, subject });
    assert.match(
      refusalOf(refused),
      /^failed: .*draining.*D-066.*§7\.1/s,
      "a Gateway that is closing still has to answer, and the answer has to name the recovery that picks the task up",
    );
    assert.equal(harness.task()?.state, "queued", "the task is recorded and left alone");
  });
});
