// D-065's saved state over SQLite, asserted as the four properties a Map cannot give a reviewer: the row survives closing
// the file (a checkpoint exists precisely for the moment after a restart), it is redacted on the way *in* like every other
// payload this directory writes, one row per task is enforced by the primary key rather than by discipline, and it leaves
// with the task. The last test is the one that makes the slice real: a gated run driven by the loop against this database,
// so the boundary and the events that make the step committed are one commit rather than two stories.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  createApprovals,
  createCheckpoints,
  createLoop,
  type ToolOutcome,
} from "@crabby/agent-runtime";
import { createScriptedProvider, WORKSPACE } from "@crabby/agent-runtime/loop-harness";
import { newId } from "@crabby/api-contracts";
import { dataLayout } from "@crabby/platform";
import type { EvalContext, ToolCall } from "@crabby/policy";
import { FAKE_TOOL_MODEL_ID } from "@crabby/providers";
import { createSqliteApprovalStore } from "./approvals.ts";
import { createSqliteCheckpointStore, readCheckpoint } from "./checkpoints.ts";
import { openDatabase, type SqliteDb } from "./db.ts";
import { readEvents } from "./events.ts";
import { createSqliteJournal } from "./journal.ts";
import { migrate } from "./migrate.ts";
import { createTask, getTask } from "./tasks.ts";

const T0 = 1_700_000_000_000;
const PATH_ARGS = { type: "object", properties: { path: { type: "string" } } } as const;

function tempDb(): { db: SqliteDb; dir: string; file: string; close(): void } {
  const dir = mkdtempSync(path.join(tmpdir(), "crabby-checkpoint-"));
  const file = path.join(dir, "crabby.sqlite3");
  const handle = openDatabase(file);
  migrate(handle.db);
  return { db: handle.db, dir, file, close: () => handle.close() };
}

function manager(db: SqliteDb, dir: string, taskId?: string) {
  const journal = createSqliteJournal({ db, layout: dataLayout(dir) });
  const checkpoints = createCheckpoints({
    store: createSqliteCheckpointStore(db),
    journal,
    eventsAfter: (id, afterSeq) => readEvents(db, id, { afterSeq, limit: 10_000 }),
  });
  return { journal, checkpoints, taskId };
}

describe("the checkpoint table (D-065, D-095)", () => {
  it("writes a boundary and reads it back after the file is reopened", () => {
    const { db, dir, file, close } = tempDb();
    const task = createTask(db, { objective: "tidy up the build directory" });
    const { checkpoints, journal } = manager(db, dir, task.id);
    journal.append({
      taskId: task.id,
      type: "tool.execution.completed",
      payload: { tool: "file.read", output: "notes.md" },
      at: T0,
    });
    const written = checkpoints.commit({
      taskId: task.id,
      boundary: "step",
      step: 1,
      modelId: FAKE_TOOL_MODEL_ID,
      messages: [
        { role: "user", content: "tidy up the build directory" },
        { role: "tool", content: "notes.md", toolCallId: "call_1" },
      ],
    });

    close();
    const reopened = openDatabase(file);
    try {
      const stored = readCheckpoint(reopened.db, task.id);
      assert.deepEqual(
        stored,
        written,
        "a checkpoint exists precisely for the moment after a restart, so the record that survives the reopen has to be " +
          "the record that was written — columns and all, including the working context a resume continues from",
      );
      assert.equal(stored?.messages?.length, 2);
      assert.equal(
        readCheckpoint(reopened.db, task.id)?.writtenAt,
        written.writtenAt,
        "read through the *new* connection, because the point of the row is that a different process finds it: the view " +
          "is computed at read time precisely so it cannot outlive the state it describes",
      );
    } finally {
      reopened.close();
    }
  });

  it("redacts on the way in, so a secret never exists in the file at all", () => {
    const { db, dir, file, close } = tempDb();
    const task = createTask(db, { objective: "check the provider quota" });
    const { checkpoints } = manager(db, dir, task.id);
    checkpoints.commit({
      taskId: task.id,
      boundary: "step",
      step: 1,
      modelId: FAKE_TOOL_MODEL_ID,
      messages: [
        { role: "user", content: "check the provider quota" },
        {
          role: "tool",
          content: "usage reported for Authorization: Bearer sk-live0123456789abcd",
          toolCallId: "call_1",
        },
      ],
    });

    const raw = readFileSync(file, "utf8");
    assert.ok(
      !raw.includes("sk-live0123456789abcd"),
      "`SECURITY.md` §7 puts redaction at the serialization layer, and a checkpoint that interleaved a provider key with " +
        "task records is the exact arrangement §7's first bullet refuses",
    );
    const stored = readCheckpoint(db, task.id);
    assert.match(
      String(stored?.messages?.[1]?.content),
      /\[redacted\]/,
      "the resumed run continues with the marker rather than the secret, which is why the view reports `redacted: true` " +
        "and why a checkpoint is never the authority for an action",
    );
    close();
  });

  it("keeps one row per task, so a boundary replaces the one before it", () => {
    const { db, dir, close } = tempDb();
    const task = createTask(db, { objective: "two steps" });
    const { checkpoints } = manager(db, dir, task.id);
    checkpoints.commit({
      taskId: task.id,
      boundary: "step",
      step: 1,
      modelId: FAKE_TOOL_MODEL_ID,
      messages: [{ role: "user", content: "two steps" }],
    });
    checkpoints.commit({
      taskId: task.id,
      boundary: "prompt",
      step: 2,
      modelId: FAKE_TOOL_MODEL_ID,
      messages: [{ role: "user", content: "two steps" }],
      pending: { tool: "file.delete", toolCallId: "call_2", approvalId: "apv_1" },
    });

    const rows = db.prepare("SELECT COUNT(*) AS c FROM checkpoint").get() as { c: number };
    assert.equal(
      rows.c,
      1,
      "D-095's first rule, enforced by the primary key rather than by discipline",
    );
    const stored = readCheckpoint(db, task.id);
    assert.equal(stored?.step, 2);
    assert.equal(stored?.boundary, "prompt");
    assert.deepEqual(stored?.pending, {
      tool: "file.delete",
      toolCallId: "call_2",
      approvalId: "apv_1",
    });
    const row = db.prepare("SELECT bytes, record_json FROM checkpoint").get() as {
      bytes: number;
      record_json: string;
    };
    assert.equal(
      row.bytes,
      row.record_json.length,
      "the size a client is shown is the size of the bytes this file wrote, redaction included — a stored number " +
        "computed from the caller's unredacted object would be a size the row does not have",
    );
    close();
  });

  it("leaves with the task, because a checkpoint is saved state for one and not a record about it", () => {
    const { db, dir, close } = tempDb();
    const task = createTask(db, { objective: "delete me" });
    const { checkpoints } = manager(db, dir, task.id);
    checkpoints.commit({
      taskId: task.id,
      boundary: "step",
      step: 1,
      modelId: FAKE_TOOL_MODEL_ID,
      messages: [],
    });

    db.prepare("DELETE FROM task WHERE id = ?").run(task.id);

    assert.equal(
      readCheckpoint(db, task.id),
      undefined,
      "`docs/DATA_AND_MEMORY.md` §2.2's limit is that a checkpoint outliving its task becomes a transcript, and §7's " +
        "deletion rules are the reason the cascade is the answer rather than a prune job",
    );
    close();
  });

  it("re-asks when a step started and never reported, reading the real log tail", () => {
    const { db, dir, close } = tempDb();
    const task = createTask(db, { objective: "delete build/" });
    const { checkpoints, journal } = manager(db, dir, task.id);
    const boundary = journal.append({
      taskId: task.id,
      type: "tool.execution.completed",
      payload: { tool: "file.read", output: "notes.md" },
      at: T0,
    });
    checkpoints.commit({
      taskId: task.id,
      boundary: "step",
      step: 1,
      modelId: FAKE_TOOL_MODEL_ID,
      messages: [{ role: "user", content: "delete build/" }],
    });
    assert.equal(
      checkpoints.verdict(task.id).verdict,
      "resume",
      "with nothing after the boundary the run is free to continue from it",
    );

    const started = journal.append({
      taskId: task.id,
      type: "tool.execution.started",
      payload: { tool: "file.delete", args: { path: `${WORKSPACE}/build` } },
      at: T0 + 1_000,
    });

    const answer = checkpoints.verdict(task.id);
    assert.equal(
      answer.verdict,
      "re-ask",
      "the started event with no outcome beside it is the process kill \u00a77.3 was written for, and the verdict changes " +
        "without a new checkpoint \u2014 which is why D-095 computes it at read time instead of storing it",
    );
    assert.deepEqual(answer.inFlight, { tool: "file.delete", startedSeq: started.seq });
    assert.equal(
      checkpoints.view(task.id)?.lastSeq,
      boundary.seq,
      "the boundary stays where it was committed, and the log after it is what carries the news",
    );

    journal.append({
      taskId: task.id,
      type: "tool.execution.completed",
      payload: { tool: "file.delete", output: "removed build/" },
      at: T0 + 2_000,
    });
    assert.equal(
      checkpoints.verdict(task.id).verdict,
      "resume",
      "one event later and the answer flips back: the log decides, not a guess",
    );
    close();
  });

  it("commits a boundary inside the phase that records each step of a real gated run", async () => {
    const { db, dir, close } = tempDb();
    const task = createTask(db, { objective: "delete build/" });
    const journal = createSqliteJournal({ db, layout: dataLayout(dir) });
    const checkpoints = createCheckpoints({
      store: createSqliteCheckpointStore(db),
      journal,
      eventsAfter: (id, afterSeq) => readEvents(db, id, { afterSeq, limit: 10_000 }),
    });
    const approvals = createApprovals({
      store: createSqliteApprovalStore(db),
      newId: () => newId("apr"),
    });
    let ran = 0;
    const tools = {
      specs: () => [{ name: "file.delete", description: "delete a path", parameters: PATH_ARGS }],
      run: async (call: ToolCall): Promise<ToolOutcome> => {
        ran += 1;
        return { ok: true, output: `removed ${String(call.args.path)}` };
      },
    };
    const provider = createScriptedProvider([
      [{ kind: "tool-call", name: "file.delete", arguments: { path: `${WORKSPACE}/build` } }],
      [{ kind: "text", text: "deleted build/" }],
    ]);
    const loop = createLoop({
      journal,
      approvals,
      provider,
      tools,
      platform: { isTermux: false },
      checkpoints,
      publish: () => {},
      now: () => T0,
    });
    const ctx: EvalContext = {
      grants: ["fs.read", "fs.write"],
      paths: { home: "/home/user", dataDir: dir, roots: [WORKSPACE] },
      realpathOf: (absolute: string) => absolute,
    };

    const suspended = await loop.start({
      taskId: task.id,
      modelId: FAKE_TOOL_MODEL_ID,
      subject: { grants: ["fs.read", "fs.write"], clientKind: "cli" },
      ctx,
    });
    assert.equal(
      suspended.kind,
      "awaiting-approval",
      "file.delete is T3 inside the workspace's parent scope",
    );
    if (suspended.kind !== "awaiting-approval") return;

    const prompt = readCheckpoint(db, task.id);
    assert.equal(prompt?.boundary, "prompt");
    assert.equal(prompt?.state, "awaiting_approval");
    assert.equal(prompt?.pending?.approvalId, suspended.run.approvalId);
    assert.equal(
      prompt?.lastSeq,
      getTask(db, task.id)?.lastSeq,
      "the boundary's sequence number is the one the event store assigned, taken inside the same transaction as the " +
        "`approval.requested` event that opened the prompt — which is the whole of §5.1's pairing rule applied to a " +
        "checkpoint, and the reason the loop calls `commit` from inside a phase instead of after one",
    );
    assert.equal(
      checkpoints.view(task.id)?.resume.verdict,
      "resume",
      "nothing executed, so a runner handed this record has a step to continue rather than a step to repeat",
    );

    approvals.answer({
      id: suspended.run.approvalId,
      decision: "approve",
      scope: "once",
      via: "tui",
      at: T0 + 1_000,
    });
    const finished = await loop.resume(suspended.run);
    assert.equal(finished.kind, "completed", JSON.stringify(finished));
    assert.equal(ran, 1);

    const done = readCheckpoint(db, task.id);
    assert.equal(done?.boundary, "step");
    assert.equal(done?.step, 1, "one committed tool step, and the boundary says so");
    assert.equal(
      done?.messages?.length,
      3,
      "the objective, the round that proposed the step, and the step's own result — exactly what a resume needs to " +
        "continue from, and nothing the run did afterwards, because the boundary is the step and not the answer",
    );
    assert.equal(
      done?.state,
      "running",
      "the state at the boundary, not the state now: `completed` arrived after it, and \u00a74.4 makes the record a fact " +
        "about the moment it was written",
    );
    assert.equal(
      checkpoints.view(task.id)?.resume.verdict,
      "none",
      "the task completed, so nothing resumes from the boundary the run left behind",
    );
    close();
  });
});
