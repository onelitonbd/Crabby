// The task state machine, asserted as the four things `AGENT_RUNTIME.md` says about it rather than as a list of happy
// paths: the lifecycle has exactly §4.1's nine states, terminal states are absorbing, a cancellation is not a
// completion (§4.1), recovery is not authorization (§7.2), and an uncertain external outcome has to be written down
// rather than defaulted (§6.2). D-083 is the decision that fixed the table; this file is what keeps it a table.
import assert from "node:assert/strict";
import { test } from "node:test";
import { TASK_STATES, type TaskState, TERMINAL_STATES } from "@crabby/api-contracts";
import {
  canTransition,
  isKnownState,
  PERMITTED_TRANSITIONS,
  permittedFrom,
  recoveryTarget,
  transition,
} from "./transitions.ts";

const CANCELLED = { terminated: true, effectsUncertain: false };

test("the table is keyed by §4.1's nine states and reaches only states §4.1 names", () => {
  assert.deepEqual(Object.keys(PERMITTED_TRANSITIONS).sort(), [...TASK_STATES].sort());
  for (const [from, targets] of Object.entries(PERMITTED_TRANSITIONS)) {
    assert.ok(isKnownState(from), `${from} is not in §4.1's lifecycle`);
    for (const to of targets) {
      assert.ok(isKnownState(to), `${from} → ${to} targets a state §4.1 does not define`);
      assert.notEqual(to, from, `${from} → ${from} would make a no-op look like progress`);
    }
  }
});

test("the three terminal states absorb, because §4.1 keeps success apart from cancellation and failure forever", () => {
  for (const terminal of TERMINAL_STATES) {
    assert.deepEqual(permittedFrom(terminal), [], `\`${terminal}\` must permit nothing`);
    for (const to of TASK_STATES) {
      const result = transition(terminal, to, { cancellation: CANCELLED });
      assert.equal(result.ok, false, `${terminal} → ${to} must be refused`);
      if (!result.ok) assert.match(result.reason, /terminal and absorbing/);
    }
  }
});

test("Plan → Execute is enforced, not advised: nothing runs without having been planned", () => {
  const result = transition("queued", "running");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /permitted targets are/);
    // A refusal that lists what *is* possible is the difference between a policy and a shrug, and §7.1's
    // auto-resume and M3's four interfaces both have to print this sentence to a user.
    assert.match(result.reason, /`planning`/);
  }
  assert.ok(canTransition("queued", "planning"));
  assert.ok(canTransition("planning", "running"));
});

test("a cancellation never becomes a completion, but a step finishing during cancellation is not an error either", () => {
  assert.ok(
    !canTransition("cancelling", "completed"),
    "§6.1's step 6 marks the task cancelled once the step settles",
  );
  assert.ok(canTransition("cancelling", "cancelled"));
  assert.ok(
    canTransition("cancelling", "failed"),
    "a step that errored while winding down stays a failure",
  );
  assert.ok(canTransition("cancelling", "interrupted"), "the process can still die mid-drain");
  assert.ok(
    !canTransition("cancelling", "running"),
    "§6.1's last line: no new ordinary step just because the current one finished",
  );

  const ok = transition("cancelling", "cancelled", {
    cancellation: { terminated: false, effectsUncertain: true },
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.event, "task.cancelled");
  if (ok.ok) {
    assert.deepEqual(ok.cancellation, { terminated: false, effectsUncertain: true });
  }
});

test("`cancelled` has exactly one way in, and that way requires §6.2's outcome in the record", () => {
  // No state enters `cancelled` directly: the request is what every state may do, and the terminal mark belongs to the
  // state that means "the request was made and the permitted work has settled".
  for (const from of [
    "queued",
    "planning",
    "awaiting_approval",
    "running",
    "interrupted",
  ] as const) {
    assert.ok(
      !canTransition(from, "cancelled"),
      `${from} → cancelled must be refused by §4.1's table`,
    );
    const result = transition(from, "cancelled", { cancellation: CANCELLED });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /not a permitted transition/);
  }

  const unmarked = transition("cancelling", "cancelled");
  assert.equal(unmarked.ok, false, "an uncertain external outcome is written down, not defaulted");
  if (!unmarked.ok) assert.match(unmarked.reason, /§6\.2/);

  const recorded = transition("cancelling", "cancelled", { cancellation: CANCELLED });
  assert.equal(recorded.ok, true);
  assert.equal(recorded.event, "task.cancelled");
});

test("an approval has to be answered before it can be run under — including after a restart", () => {
  const noAnswer = transition("awaiting_approval", "running");
  assert.equal(noAnswer.ok, false);
  if (!noAnswer.ok) assert.match(noAnswer.reason, /pending approval is not an approved one/);

  for (const answer of ["denied", "expired"] as const) {
    const result = transition("awaiting_approval", "running", { approvalAnswered: answer });
    assert.equal(result.ok, false, `a \`${answer}\` approval must not open the way to \`running\``);
    if (!result.ok) assert.match(result.reason, /§5's rule 5/);
  }

  const approved = transition("awaiting_approval", "running", { approvalAnswered: "approved" });
  assert.equal(approved.ok, true);
  assert.equal(approved.event, "task.state.changed");

  // §5's rule 5 respected the denial by ending or re-planning the work, and both routes exist: this is the shape
  // "denials narrow options" takes in the table.
  assert.ok(
    canTransition("awaiting_approval", "planning"),
    "a denial that leaves other work possible re-plans",
  );
  assert.ok(canTransition("awaiting_approval", "failed"));
  assert.ok(canTransition("awaiting_approval", "cancelling"));
  assert.ok(
    !canTransition("awaiting_approval", "cancelled"),
    "`cancelled` is entered from `cancelling` only — §6.1's shape is request, settle, mark",
  );
});

test("recovery marks a non-terminal task interrupted and never authorizes it", () => {
  for (const state of TASK_STATES) {
    const target = recoveryTarget(state);
    if (
      state === "completed" ||
      state === "failed" ||
      state === "cancelled" ||
      state === "interrupted"
    ) {
      assert.equal(target, undefined, `${state} must be left exactly as the record has it`);
      continue;
    }
    assert.equal(
      target,
      "interrupted",
      `${state} is incomplete execution, and §4.1 keeps that apart from failure`,
    );
    const move = transition(state, "interrupted");
    assert.equal(move.ok, true);
    assert.equal(move.event, "task.interrupted");
  }

  // §7.2: automatic orchestration, not automatic authorization. The edge exists, and it is refused until the record
  // says a still-valid approval covers the step — the difference between the two is one boolean the caller must own.
  const straightToRunning = transition("interrupted", "running");
  assert.ok(
    !straightToRunning.ok,
    "`interrupted` → `running` would restart work on an unanswered approval",
  );
  if (!straightToRunning.ok) assert.match(straightToRunning.reason, /§7\.2/);
  const covered = transition("interrupted", "running", { resumeApprovalValid: true });
  assert.equal(
    covered.ok,
    true,
    "the one recovery that may run directly, and it is stated as evidence",
  );
  // §7.2's pending-approval rule survives recovery: resume into `awaiting_approval` …
  assert.ok(canTransition("interrupted", "awaiting_approval"));
  // … and only an approval answered *after* the restart lets it proceed, because the transition function is the same
  // one the recovered path goes through.
  const resumedToApproval = transition("interrupted", "awaiting_approval");
  if (resumedToApproval.ok) {
    assert.equal(
      resumedToApproval.event,
      "task.resumed",
      "a task waking up announces a resumption, not a state change",
    );
  }
  assert.equal(
    transition("awaiting_approval", "running", { approvalAnswered: "expired" }).ok,
    false,
    "a restart does not turn a pending approval into an approved one",
  );
});

test("a refusal is only useful if it names the section that refused", () => {
  const cases: readonly [TaskState, TaskState][] = [
    ["queued", "running"],
    ["queued", "completed"],
    ["completed", "queued"],
    ["running", "queued"],
    ["cancelling", "completed"],
    ["interrupted", "running"],
    ["queued", "nope" as TaskState],
  ];
  for (const [from, to] of cases) {
    const result = transition(from, to);
    assert.equal(result.ok, false, `${from} → ${to} unexpectedly allowed`);
    if (!result.ok) {
      assert.match(
        result.reason,
        /§/,
        `the refusal for ${from} → ${to} cites nothing, so nobody can look up why: ${result.reason}`,
      );
    }
  }
});
