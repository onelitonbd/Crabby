// M1a's contract tests: one runner file for the package (`docs/ROADMAP.md` M1), and every assertion
// below cites the § of `docs/INTERFACES_AND_API.md` that makes it a requirement rather than a preference.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ACTIONABLE_EVENT_TYPES,
  CreateTaskBody,
  ERROR_CLASSES,
  ErrorEnvelope,
  Event,
  EXIT,
  errorEnvelope,
  exitCodeForErrorClass,
  ID_PREFIXES,
  idPattern,
  isId,
  isSecretShaped,
  isTerminal,
  newId,
  payloadTooBig,
  ResumeTaskBody,
  SCHEMA_VERSION,
  TASK_STATES,
  TaskRecord,
  TERMINAL_STATES,
  validate,
} from "@crabby/api-contracts";

const NOW = "2026-10-10T12:00:00.000Z";

function task(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: newId("tsk"),
    sessionId: newId("ses"),
    state: "queued",
    objective: "read the roadmap",
    createdAt: NOW,
    updatedAt: NOW,
    lastSeq: 0,
    ...over,
  };
}

describe("identifiers", () => {
  it("mints exactly the prefixes §6 lists, and nothing else", () => {
    // Five until D-112 added `msg_` for a conversation turn, six until D-135 added `mem_` for a memory entry; the
    // assertion is the list rather than a count, so the next decision that adds a prefix has to touch this line on
    // purpose rather than by accident.
    assert.deepEqual([...ID_PREFIXES], ["evt", "ses", "apr", "req", "tsk", "msg", "mem", "aud"]);
    for (const prefix of ID_PREFIXES) {
      const id = newId(prefix);
      assert.ok(isId(prefix, id), `${id} must match ${idPattern(prefix)}`);
      assert.match(id, new RegExp(`^${prefix}_[0-9a-z]{26}$`));
    }
  });

  it("sorts by creation time, which is a convenience and not a sequence", () => {
    const older = newId("evt", Date.parse("2026-01-01T00:00:00.000Z"));
    const newer = newId("evt", Date.parse("2026-06-01T00:00:00.000Z"));
    assert.ok(older < newer, "an id minted earlier has to sort first");
    assert.notEqual(older.slice(4, 14), newer.slice(4, 14));
  });

  it("refuses a foreign prefix instead of guessing", () => {
    assert.equal(isId("evt", newId("tsk")), false);
    assert.equal(isId("evt", "evt_SHORT"), false);
    assert.equal(
      isId("evt", "EVT_0123456789abcdefghjkmnpq"),
      false,
      "uppercase is not the contract",
    );
  });
});

describe("task records", () => {
  it("accepts a well-formed record and rejects an invented field by name", () => {
    const ok = validate(TaskRecord, task());
    assert.equal(ok.ok, true, ok.ok ? "" : JSON.stringify(ok.problems));
    const bad = validate(TaskRecord, task({ priority: "high" }));
    assert.equal(bad.ok, false);
    if (!bad.ok) {
      assert.ok(
        bad.problems.some((p) => p.kind === "unknown-field" && p.message.includes("'priority'")),
        `the field has to be named: ${JSON.stringify(bad.problems)}`,
      );
    }
  });

  it("carries the nine states §4.1 lists and knows which ones end a task", () => {
    assert.deepEqual(
      [...TASK_STATES],
      [
        "queued",
        "planning",
        "awaiting_approval",
        "running",
        "cancelling",
        "completed",
        "failed",
        "cancelled",
        "interrupted",
      ],
    );
    assert.deepEqual([...TERMINAL_STATES], ["completed", "failed", "cancelled"]);
    assert.ok(
      isTerminal("completed") && !isTerminal("interrupted"),
      "incomplete is not the same as ended",
    );
    for (const state of [...TASK_STATES, "bogus"]) {
      const res = validate(TaskRecord, task({ state }));
      assert.equal(
        res.ok,
        state !== "bogus",
        `${state} must ${state === "bogus" ? "not " : ""}validate`,
      );
    }
  });

  it("keeps a create body to what §4.3 names", () => {
    assert.equal(validate(CreateTaskBody, { objective: "x" }).ok, true);
    assert.equal(
      validate(CreateTaskBody, { objective: "" }).ok,
      false,
      "an empty objective is not a task",
    );
    assert.equal(
      validate(CreateTaskBody, { objective: "x", idempotencyKey: "abc" }).ok,
      false,
      "idempotency is a header (§2), not a body field",
    );
    assert.equal(validate(CreateTaskBody, { objective: "x", granted: true }).ok, false);
  });

  it("carries the identity a task belongs to, and refuses one that names no interface", () => {
    const origin = { clientId: "cli_01h", clientName: "phone", interface: "tui" };
    assert.equal(validate(TaskRecord, task({ origin })).ok, true);
    assert.equal(
      validate(TaskRecord, task({ origin: { ...origin, capabilities: ["fs.write"] } })).ok,
      false,
      "the capabilities are evaluated when a run starts; storing them here would be a past fact where a reader would " +
        "take it for a current one",
    );
    assert.equal(
      validate(TaskRecord, task({ origin: { ...origin, interface: "carrier-pigeon" } })).ok,
      false,
    );
    assert.equal(
      validate(TaskRecord, task()).ok,
      true,
      "absent is a real answer: a row written before version 9, or by a root that had no identity to record",
    );
  });

  it("carries §3.6 stage 3's switch fact on the record, and refuses a switch that names no pair", () => {
    const switchFact = {
      from: "local/qwen2.5:3b",
      to: "groq/llama-3.1-8b",
      reason: "D-043's ladder spent 5 attempts on `overloaded`",
      stage: 2,
      reAttempted: false,
      attempts: 5,
      at: "2026-03-04T10:00:00.000Z",
      by: "cli_local",
      via: "telegram",
    };
    assert.equal(
      validate(TaskRecord, task({ model: switchFact.to, modelSwitch: switchFact })).ok,
      true,
      "the record shows the switch: original model, chosen model, reason, stage, re-attempted",
    );
    for (const [what, bad] of [
      ["a missing original model", { ...switchFact, from: undefined }],
      ["a stage that is not the number §3.6 prices", { ...switchFact, stage: "two" }],
      ["a `reAttempted` that is not a fact", { ...switchFact, reAttempted: "no" }],
      ["a timestamp that is not one", { ...switchFact, at: "yesterday" }],
      ["an invented field", { ...switchFact, note: "looks fine" }],
    ] as const) {
      const res = validate(TaskRecord, task({ modelSwitch: bad }));
      assert.equal(res.ok, false, `${what} must not validate`);
    }
  });

  it("answers an ask with a model or with nothing, and names nothing else", () => {
    assert.equal(
      validate(ResumeTaskBody, {}).ok,
      true,
      "an answer with no body resumes on the model the run already used (§3.6 stage 2)",
    );
    assert.equal(validate(ResumeTaskBody, { model: "groq/llama-3.1-8b" }).ok, true);
    assert.equal(
      validate(ResumeTaskBody, { model: "q" }).ok,
      false,
      "the ceiling on a pin is a length here, exactly as on `CreateTaskBody` — whether the pair is spelled right and " +
        "whether the model is composed is the route's question (`selectPinnedModel`), not the body's",
    );
    assert.equal(
      validate(ResumeTaskBody, { model: undefined }).ok,
      true,
      "an absent pin is not the same spelling as a malformed one",
    );
    assert.equal(
      validate(ResumeTaskBody, { reason: "no model" }).ok,
      false,
      "declining is not an answer, and no interface has priced an act for it (DECISIONS.md O-073)",
    );
    assert.equal(validate(ResumeTaskBody, { objective: "start over" }).ok, false);
  });
});

describe("events", () => {
  const base = {
    id: newId("evt"),
    schemaVersion: SCHEMA_VERSION,
    type: "task.state.changed",
    ts: NOW,
    sessionId: newId("ses"),
    taskId: newId("tsk"),
    seq: 1,
    payload: {},
  };

  it("accepts §5.2's shape and rejects a second schema version", () => {
    assert.equal(validate(Event, base).ok, true);
    assert.equal(validate(Event, { ...base, schemaVersion: 2 }).ok, false);
    assert.equal(
      validate(Event, { ...base, granted: true }).ok,
      false,
      "an event that grants authority is the failure §7 forbids",
    );
  });

  it("ties ordering to seq and families to the seven names", () => {
    assert.equal(validate(Event, { ...base, seq: -1 }).ok, false);
    for (const type of [
      "task.created",
      "approval.requested",
      "system.vault.locked",
      "provider.switch.accepted",
    ]) {
      assert.equal(validate(Event, { ...base, type }).ok, true, type);
    }
    for (const type of ["browser.closed", "task", "TASK.created", "task.Created"]) {
      assert.equal(validate(Event, { ...base, type }).ok, false, type);
    }
  });

  it("makes an actionable event readable by GET, which is the recovery rule", () => {
    assert.deepEqual(
      [...ACTIONABLE_EVENT_TYPES].sort(),
      [
        "approval.answered",
        "approval.expired",
        "approval.re-requested",
        "approval.requested",
        "task.cancelled",
        "task.completed",
        "task.failed",
      ].sort(),
    );
  });

  it("requires a cap for the payload rule rather than inventing one", () => {
    assert.equal(payloadTooBig({ a: "x".repeat(500) }, 100), true);
    assert.equal(payloadTooBig({ a: "x" }, 100), false);
    assert.throws(() => payloadTooBig({ a: 1 }, 0), TypeError);
  });
});

describe("errors and exit codes", () => {
  it("keeps the ten classes §6 names", () => {
    assert.deepEqual(
      [...ERROR_CLASSES],
      [
        "validation",
        "auth",
        "policy",
        "not-found",
        "conflict",
        "rate-limit",
        "provider",
        "resource-limit",
        "platform-unsupported",
        "internal",
      ],
    );
  });

  it("builds an envelope that carries the two fields a client acts on", () => {
    const env = errorEnvelope({
      code: "approval.required",
      message: "needs you",
      class: "policy",
      retryable: false,
    });
    assert.equal(
      validate(ErrorEnvelope, env).ok,
      true,
      JSON.stringify(validate(ErrorEnvelope, env)),
    );
    assert.equal(env.error.retryable, false);
    assert.ok(!("stack" in env.error), "no stack traces in the envelope");
    assert.ok(!("providerBody" in env.error));
  });

  it("maps the classes a script branches on", () => {
    assert.equal(exitCodeForErrorClass("validation"), EXIT.usage);
    assert.equal(exitCodeForErrorClass("policy"), EXIT.needsApproval);
    assert.equal(exitCodeForErrorClass("platform-unsupported"), EXIT.platformUnsupported);
    assert.equal(exitCodeForErrorClass("not-found"), EXIT.failure);
  });

  it("spots a credential-shaped string before a log line or an export sees it", () => {
    assert.ok(isSecretShaped("authorization: Bearer abc123"));
    assert.ok(isSecretShaped("sk-abcdefghijklmnop"));
    assert.ok(isSecretShaped('password="hunter2hunter2"'));
    assert.equal(isSecretShaped("approved the git.push call"), false);
  });
});
