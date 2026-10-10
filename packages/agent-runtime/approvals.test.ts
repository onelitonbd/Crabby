// The approval service, asserted as `SECURITY.md` §6.3's sentences rather than as a queue with getters: what a request
// must carry, who may answer, what an answer binds, when it stops being usable, that `once` means once, and what two
// clients answering at the same moment produce. Every refusal also has to be readable, because the same sentence is what
// an interface shows a user who was denied.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClientInterface } from "@crabby/api-contracts";
import type { ApprovalRequest } from "@crabby/policy";
import { createApprovals, createMemoryApprovalStore } from "./approvals.ts";

const T3_TTL = 5 * 60_000; // D-064's T3 expiry, restated here as the number the test moves the clock by.
const T0 = 1_700_000_000_000;

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    taskId: "tsk_01",
    tool: "shell.run",
    tier: "T3",
    summary: "run `rm -rf target` in the workspace root",
    exact: "rm -rf target",
    effects: "deletes the build directory",
    reversibility: "irreversible",
    whatCouldGoWrong: "uncommitted files under target/ are lost",
    scope: "once",
    ttlMs: T3_TTL,
    expiresAt: T0 + T3_TTL,
    binding: "sha256:aaa1",
    ...overrides,
  };
}

// `evaluate()` computes `expiresAt` from the moment it answers, so a test that opens a request later has to move the
// deadline with it — the service refuses a caller-chosen window, and a fixture that faked one would hide that rule.
function harness() {
  const store = createMemoryApprovalStore();
  // Ids come from a counter rather than a `+=` inside a template, because an expression with a side effect is exactly
  // what `lint/suspicious/noAssignInExpressions` exists to keep out of a fixture that reads as a value.
  let next = 0;
  function newId(): string {
    next += 1;
    return `apv_${next}`;
  }
  const approvals = createApprovals({ store, newId });
  const open = (at = T0, overrides: Partial<ApprovalRequest> = {}) =>
    approvals.open(request(overrides), at);
  // `via` defaults to the TUI because the fixture's request is T3, and D-085 confines a T3 signature to the TUI and the
  // Web UI. A test that wanted a permissive surface would be a test that never exercised the rule.
  const approve = (
    id: string,
    at = T0 + 1_000,
    byClientId?: string,
    via: ClientInterface = "tui",
  ) =>
    approvals.answer({
      id,
      decision: "approve",
      scope: "once",
      via,
      at,
      ...(byClientId === undefined ? {} : { byClientId }),
    });
  const deny = (id: string, at = T0 + 1_000, byClientId?: string, via: ClientInterface = "tui") =>
    approvals.answer({
      id,
      decision: "deny",
      scope: "once",
      via,
      at,
      ...(byClientId === undefined ? {} : { byClientId }),
    });
  const consume = (
    id: string,
    at = T0 + 2_000,
    overrides: { taskId?: string; tool?: string; binding?: string } = {},
  ) =>
    approvals.consume({
      id,
      taskId: overrides.taskId ?? "tsk_01",
      tool: overrides.tool ?? "shell.run",
      binding: overrides.binding ?? "sha256:aaa1",
      at,
    });
  return { approvals, store, open, approve, deny, consume };
}

function opened(
  h: ReturnType<typeof harness>,
  at?: number,
  overrides: Partial<ApprovalRequest> = {},
) {
  const result = h.open(at, overrides);
  assert.ok(result.ok, JSON.stringify(result));
  return result.record;
}

test("a request that cannot say what could go wrong is not an approval request", () => {
  const h = harness();
  for (const field of ["whatCouldGoWrong", "effects", "exact", "summary"] as const) {
    const result = h.open(T0, { [field]: "   " } as Partial<ApprovalRequest>);
    assert.ok(!result.ok, `\`${field}\` blank must be refused`);
    if (!result.ok) {
      assert.equal(result.code, "incomplete-request");
      assert.match(result.reason, /§6\.3/);
      assert.match(result.reason, new RegExp(field), "the refusal names the field it is missing");
    }
  }
  assert.equal(h.store.all().length, 0, "a refused request leaves no row behind");
});

test("the deadline is D-064's, not the caller's", () => {
  const h = harness();
  const stretched = h.open(T0, { expiresAt: T0 + 60 * 60_000 });
  assert.ok(!stretched.ok, "a request may not widen its own window");
  if (!stretched.ok) {
    assert.equal(stretched.code, "ttl-not-as-decided");
    assert.match(stretched.reason, /D-064/);
  }
  assert.ok(opened(h));
});

test("`scope: once` is the only shape, in the request and in the answer", () => {
  const h = harness();
  const remembered = h.open(T0, { scope: "always" as ApprovalRequest["scope"] });
  assert.ok(!remembered.ok);
  if (!remembered.ok) {
    assert.equal(remembered.code, "scope-unsupported");
    assert.match(remembered.reason, /D-052/);
  }

  const record = opened(h);
  const widened = h.approvals.answer({
    id: record.id,
    decision: "approve",
    scope: "session" as "once",
    via: "tui",
    at: T0 + 1,
  });
  assert.ok(!widened.ok, "a client cannot widen the scope while answering either");
  assert.equal(h.store.get(record.id)?.state, "pending", "a refused answer changes nothing");
});

test("an approval is consumed by the action it bound, exactly once", () => {
  const h = harness();
  const record = opened(h);
  assert.equal(record.state, "pending");

  const answer = h.approve(record.id);
  assert.ok(answer.ok);
  if (answer.ok) assert.equal(answer.event, "approval.answered");

  const used = h.consume(record.id);
  assert.ok(used.ok, JSON.stringify(used));
  assert.equal(used.ok && used.record.state, "consumed");

  const again = h.consume(record.id, T0 + 3_000);
  assert.ok(!again.ok);
  if (!again.ok) {
    assert.equal(again.code, "consumed");
    assert.match(again.reason, /means once/);
  }
});

test("the binding is compared against the action about to run, not the one that was shown", () => {
  const h = harness();
  const record = opened(h);
  h.approve(record.id);

  const cases = [
    { binding: "sha256:bbb2", why: "different arguments" },
    { tool: "file.delete", why: "a different tool" },
    { taskId: "tsk_02", why: "the same action in another task" },
  ] as const;
  for (const change of cases) {
    const result = h.consume(record.id, T0 + 2_000, change);
    assert.ok(!result.ok, `${change.why} must not run on this approval`);
    if (!result.ok) {
      assert.equal(result.code, "materially-changed");
      assert.match(result.reason, /not a licence/);
    }
  }
});

test("two surfaces, one pending row: the first answer wins and says who won", () => {
  const h = harness();
  const record = opened(h);

  const phone = h.deny(record.id, T0 + 1_000, "client_phone");
  assert.ok(phone.ok);

  const desktop = h.approve(record.id, T0 + 1_001, "client_desktop");
  assert.ok(!desktop.ok, "a second answer must not overwrite the first");
  if (!desktop.ok) {
    assert.equal(desktop.code, "already-answered");
    assert.match(desktop.reason, /already `denied`/);
    assert.match(
      desktop.reason,
      /client_phone/,
      "the winner is named, so the loser can explain itself",
    );
    assert.match(desktop.reason, /new request rather than an override/);
  }

  const run = h.consume(record.id, T0 + 1_002);
  assert.ok(!run.ok, "the denial that won is what the runtime honours");
  if (!run.ok) assert.match(run.reason, /denial is respected/);
});

test("a denied action is not re-asked with the same words, and a real change is a visible chain", () => {
  const h = harness();
  const first = opened(h);
  h.deny(first.id);

  const sameAgain = h.open(T0 + 2_000, { expiresAt: T0 + 2_000 + T3_TTL });
  assert.ok(
    !sameAgain.ok,
    "the literal repeat is refused by the arbiter, not by a note in the loop's docs",
  );
  if (!sameAgain.ok) {
    assert.equal(sameAgain.code, "denied");
    assert.match(sameAgain.reason, /§6\.3/);
  }

  const changed = h.open(T0 + 3_000, {
    binding: "sha256:ccc3",
    exact: "rm -rf target/dist",
    expiresAt: T0 + 3_000 + T3_TTL,
  });
  assert.ok(changed.ok, "a materially different action may ask again");
  if (changed.ok) {
    assert.equal(changed.event, "approval.re-requested");
    assert.equal(changed.record.supersedes, first.id);
  }

  assert.equal(
    h.approvals.refusalCount("tsk_01", "shell.run"),
    1,
    "the count is what D-043's ladder reads",
  );
});

test("an open request is not duplicated, because two rows would mean two prompts and two answers", () => {
  const h = harness();
  const record = opened(h);
  const again = h.open(T0 + 500);
  assert.ok(again.ok);
  if (again.ok) {
    assert.equal(again.record.id, record.id, "the same request returns the same row");
    assert.equal(
      again.deduplicated,
      true,
      "and says so, so the caller does not emit a second event",
    );
  }
  assert.equal(h.store.all().length, 1);
});

test("expiry is a deadline and not a grace period, on either side of the queue", () => {
  const h = harness();
  const answered = opened(h);
  h.approve(answered.id);
  const tooLate = h.consume(answered.id, T0 + T3_TTL + 500);
  assert.ok(!tooLate.ok, "approved but never run inside the window is not executable afterwards");
  if (!tooLate.ok) {
    assert.equal(tooLate.code, "expired");
    assert.equal(tooLate.event, "approval.expired");
  }
  assert.equal(
    h.approvals.refusalCount("tsk_01", "shell.run"),
    0,
    "a row the user approved and the runtime failed to run in time is not a refusal",
  );

  const unanswered = opened(h, T0 + 4_000, {
    binding: "sha256:ddd4",
    expiresAt: T0 + 4_000 + T3_TTL,
  });
  const late = h.approvals.answer({
    id: unanswered.id,
    decision: "approve",
    scope: "once",
    via: "tui",
    at: T0 + 4_000 + T3_TTL + 1,
  });
  assert.ok(!late.ok, "an answer that arrives after the deadline is refused");
  if (!late.ok) {
    assert.equal(late.code, "expired");
    // …and the row still moved, so the refusal carries the event: a queue that stops showing a request while the log
    // says nothing about why is the disagreement this type exists to prevent.
    assert.equal(late.event, "approval.expired");
  }

  // A row nobody touched is what a sweep is for; the one `answer` just expired is not swept twice.
  const untouched = opened(h, T0 + 5_000, {
    binding: "sha256:eee5",
    expiresAt: T0 + 5_000 + T3_TTL,
  });
  const swept = h.approvals.sweep(T0 + 4_000 + T3_TTL + 10_000);
  assert.deepEqual(
    swept.expired.map((change) => [change.record.id, change.event]),
    [[untouched.id, "approval.expired"]],
    "the sweep returns the change *and* its event, so a caller can write both or neither",
  );
  assert.equal(unanswered.state, "expired");
  assert.deepEqual(h.approvals.pending(), []);
  assert.equal(
    h.approvals.refusalCount("tsk_01", "shell.run"),
    2,
    "both rows the user left unanswered count, and the one they approved does not",
  );
});

test("a T3 signature is refused on a surface §6.2 excludes, and the row is left for the surface that counts", () => {
  const h = harness();
  const record = opened(h);

  // Both directions of the answer, because what §6.2 restricts is the *signature* and not the polarity: a denial is
  // also a decision recorded against a binding, and a surface that may not grant is a surface that may not decide.
  for (const decision of ["approve", "deny"] as const) {
    const wrong = h.approvals.answer({
      id: record.id,
      decision,
      scope: "once",
      via: "telegram",
      at: T0 + 1_000,
    });
    assert.ok(!wrong.ok, `a T3 \`${decision}\` must not be answerable from Telegram`);
    if (!wrong.ok) {
      assert.equal(wrong.code, "surface-not-allowed");
      assert.match(wrong.reason, /§6\.2/);
      assert.match(wrong.reason, /D-085/);
      assert.equal(
        wrong.event,
        undefined,
        "a refusal from the wrong surface changes no state, so it owes no event",
      );
    }
  }

  assert.equal(
    h.store.get(record.id)?.state,
    "pending",
    "the refusal must not consume or expire the row",
  );
  assert.deepEqual(
    h.approvals.pending().map((row) => row.id),
    [record.id],
    "…and the TUI still finds it in the queue it is allowed to answer",
  );
  // Nothing was recorded on the refused path either, so a stale queue and a log cannot disagree about a refusal.
  assert.equal(h.approvals.refusalCount("tsk_01", "shell.run"), 0);
  assert.deepEqual(
    h.approvals.list({ state: "pending" }).map((row) => row.id),
    h.approvals.pending().map((row) => row.id),
    "the queue a client reads is the arbiter's own list, so `?state=pending` and a TUI's view cannot diverge",
  );

  const right = h.approve(record.id);
  assert.ok(right.ok, "the same answer on the permitted surface is accepted");
});

test("the surface rule is a table and not a mood: T2 is signable from a chat surface", () => {
  const h = harness();
  const T2_TTL = 10 * 60_000; // D-064's T2 expiry, so the TTL guard has nothing to refuse
  const openedT2 = h.open(T0, {
    tier: "T2",
    ttlMs: T2_TTL,
    expiresAt: T0 + T2_TTL,
    binding: "sha256:bbb2",
  });
  assert.ok(openedT2.ok, JSON.stringify(openedT2));
  if (!openedT2.ok) return;
  const answered = h.approvals.answer({
    id: openedT2.record.id,
    decision: "approve",
    scope: "once",
    via: "telegram",
    at: T0 + 1_000,
  });
  assert.ok(answered.ok, "a restriction that widens to every tier is a rule nobody wrote down");
});

test("a refusal a user might see cites the sentence that produced it", () => {
  const h = harness();
  const record = opened(h);
  const refusals = [
    h.open(T0, { summary: "" }),
    h.approvals.answer({
      id: "apv_missing",
      decision: "approve",
      scope: "once",
      via: "tui",
      at: T0,
    }),
    h.consume(record.id),
    h.approve(record.id),
  ].filter((result) => !result.ok) as readonly { readonly code: string; readonly reason: string }[];

  // An incomplete request, an unknown id, and `consume` on a row nobody answered yet. The approve that follows them
  // succeeds on purpose: the point of the loop is that these three sentences are readable, not that they are numerous.
  assert.equal(refusals.length, 3, JSON.stringify(refusals));
  for (const refusal of refusals) {
    assert.match(refusal.reason, /§[0-9]|D-0\d\d/, `${refusal.code}: ${refusal.reason}`);
  }
});
