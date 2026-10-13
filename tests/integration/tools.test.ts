// The loop and a real executor, composed — the properties that live *across* the seam and therefore in neither package's
// own tests:
//
//   - A tier that only becomes T2 because the runtime answered a question the model was not asked (§4.3's
//     argument-dependent escalation, D-099). `packages/policy` can prove it reads `preExistingUserFile`; `packages/tools`
//     can prove it computes it; only a composition proves the fact reaches the arbiter before the decision, and that the
//     approval it produces is still spendable at the moment of execution.
//   - A resume verdict that only becomes `pass` because a tool declared itself idempotent (§7.3, D-065, D-098). Until M2k
//     the first of D-065's two permissions had no possible witness, so every in-flight step answered `re-ask`.
//   - §6.2's uncertainty, which D-089 made a constant `true` because nothing declared `sideEffects`.
//
// `packages/agent-runtime`'s own tests run against a recording executor on purpose — the loop must not know which tools
// exist (`ARCHITECTURE.md` §19: adapters implement the runtime's abstractions) — and `packages/tools`' own tests run
// against a real directory with no loop at all. This file is where the two meet, over a real workspace in `os.tmpdir()`.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
  type CancellationEvidence,
  type LoopOutcome,
  type SuspendedRun,
  stepFactsFromDeclarations,
  type ToolSurface,
  verdictFor,
} from "@crabby/agent-runtime";
import { createHarness, type Harness } from "@crabby/agent-runtime/loop-harness";
import { type Event, MAX_TOOL_OUTPUT_BYTES, newId, SCHEMA_VERSION } from "@crabby/api-contracts";
import { LIMITS_DEFAULTS } from "@crabby/core";
import type { PathContext } from "@crabby/policy";
import type { FakeStep } from "@crabby/providers";
import {
  createFileTools,
  defaultRealpathOf,
  type FileToolExecutor,
  fileToolDeclarations,
} from "@crabby/tools";

const bases: string[] = [];

after(() => {
  for (const base of bases) rmSync(base, { recursive: true, force: true });
});

interface Composed {
  readonly root: string;
  readonly scratch: string;
  readonly tools: FileToolExecutor;
  readonly harness: Harness;
}

/** One workspace, one executor, one harness, all reading the same `PathContext`. That last part is the point: policy's
 *  containment judgement and §8's adapter-side check are two calls over one set of roots, and a test that let them
 *  disagree would be measuring a fiction. */
function compose(
  rounds: readonly (readonly FakeStep[])[],
  options: {
    readonly grants?: readonly string[];
    readonly stepFacts?: (tool: string) => { idempotent: boolean; effectRecorded: boolean };
    /** Called after the executor answered and before the loop recorded what happened — the window §6.2's evidence is
     *  computed in, and the only place a cancellation can arrive while a step's outcome is still on the record. */
    readonly duringStep?: (harness: Harness) => void;
    /** Makes the executor throw instead of answering, which is a seam any future adapter could break. */
    readonly throwOn?: string;
  } = {},
): Composed {
  const base = mkdtempSync(path.join(tmpdir(), "crabby-integration-tools-"));
  bases.push(base);
  const root = path.join(base, "workspace");
  const home = path.join(base, "home");
  const dataDir = path.join(base, "state");
  mkdirSync(root, { recursive: true });
  mkdirSync(home, { recursive: true });

  const paths: PathContext = { home, dataDir, roots: [root] };
  const tools = createFileTools({
    paths,
    scratchDirFor: (taskId) => {
      const dir = path.join(dataDir, "scratch", taskId);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      return dir;
    },
    realpathOf: defaultRealpathOf,
  });
  const grants = options.grants ?? ["fs.read", "fs.write"];

  // The hook has to exist before the harness does and fire after it does, so the closure reads a variable assigned below.
  let built: Harness | undefined;
  const surface: ToolSurface = {
    specs: tools.specs,
    facts: tools.facts,
    declares: tools.declares,
    run: async (call, ctx) => {
      if (options.throwOn === call.tool) throw new Error("the adapter exploded");
      const outcome = await tools.run(call, ctx);
      if (built !== undefined) options.duringStep?.(built);
      return outcome;
    },
  };

  const harness = createHarness({
    rounds,
    surface,
    grants,
    ...(options.stepFacts === undefined ? {} : { stepFacts: options.stepFacts }),
    ctx: { grants, paths, realpathOf: defaultRealpathOf },
  });
  built = harness;
  return { root, scratch: path.join(dataDir, "scratch", harness.taskId), tools, harness };
}

/** D-098's declarations, through the bridge a runner would use. Built from the same function the executor builds them
 *  with, so the verdict here is the verdict a composed Gateway would compute. */
function declaredStepFacts(): (tool: string) => { idempotent: boolean; effectRecorded: boolean } {
  const byName = new Map(
    fileToolDeclarations({
      fsTimeoutMs: LIMITS_DEFAULTS.fsTimeoutMs,
      maxOutputBytes: MAX_TOOL_OUTPUT_BYTES,
    }).map((declaration) => [declaration.name, declaration]),
  );
  return stepFactsFromDeclarations((tool) => byName.get(tool));
}

function suspended(outcome: LoopOutcome): SuspendedRun {
  if (outcome.kind !== "awaiting-approval") {
    assert.fail(`expected the run to stop at a prompt; it ended \`${outcome.kind}\``);
  }
  return outcome.run;
}

function cancelled(outcome: LoopOutcome): CancellationEvidence {
  if (outcome.kind !== "cancelled") {
    assert.fail(`expected the run to settle as cancelled; it ended \`${outcome.kind}\``);
  }
  return outcome.evidence;
}

const writeRound = (relative: string, content: string): readonly FakeStep[] => [
  { kind: "tool-call", name: "file.write", arguments: { path: relative, content } },
];
const editRound = (relative: string, content: string): readonly FakeStep[] => [
  { kind: "tool-call", name: "file.edit", arguments: { path: relative, content } },
];
const doneRound: readonly FakeStep[] = [{ kind: "text", text: "done" }];

function place(root: string, relative: string, content: string): string {
  const full = path.join(root, relative);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
  return full;
}

describe("a composed loop and executor (§4.4's order, over a real filesystem)", () => {
  it("runs a T1 create to the disk with no prompt, and commits one boundary for the step", async () => {
    const { root, harness } = compose([writeRound("notes/todo.md", "buy rice"), doneRound]);
    const outcome = await harness.start();

    assert.equal(outcome.kind, "completed", "§6.2's T1 row is auto-allow when the grant is held");
    assert.equal(
      readFileSync(path.join(root, "notes/todo.md"), "utf8"),
      "buy rice",
      "the executor is the party that touched the device: the bytes are on the disk, not in a recording",
    );
    assert.equal(
      harness.approvals.list().length,
      0,
      "a T1 create with `fs.write` granted opens no queue row",
    );
    assert.deepEqual(
      harness.executions.map((run) => [run.tool, run.outcome.ok, run.deadlineMs]),
      [["file.write", true, LIMITS_DEFAULTS.fsTimeoutMs]],
      "D-074's `fs.*` deadline reached the executor, so the class row is enforced rather than announced",
    );
    assert.deepEqual(
      harness.checkpointWrites.map((write) => [write.boundary, write.step]),
      [["step", 1]],
      "D-095's one boundary per committed step, written by the loop that committed it",
    );
    assert.equal(
      harness.payloadOf("tool.call.proposed")?.facts,
      undefined,
      "no fact was needed to price a create",
    );
  });

  it("escalates an edit of a file that was already there to T2, because the runtime answered the fact", async () => {
    const { root, harness } = compose([editRound("notes/todo.md", "sell rice"), doneRound]);
    place(root, "notes/todo.md", "buy rice");

    const outcome = await harness.start();
    assert.equal(
      outcome.kind,
      "awaiting-approval",
      "§4.2 bumps `file.edit` to T2 when the file is not Crabby's",
    );

    const row = harness.pending()[0];
    assert.ok(row, "a T2 step opens exactly one queue row");
    assert.equal(row.request.tier, "T2");
    assert.match(
      row.request.effects,
      /overwriting a file Crabby did not create/,
      "the prompt names the sentence of §4.2 that raised the tier, because §6.2's T2 row is 'explicit approval with full " +
        "context' and a tier with no reason is not context",
    );
    assert.equal(row.request.exact, "path: notes/todo.md", "§6.3's exact target, in plaintext");

    const proposed = harness.payloadOf("tool.call.proposed");
    assert.deepEqual(
      proposed?.facts,
      { preExistingUserFile: true },
      "D-099: what the runtime observed",
    );
    assert.deepEqual(
      proposed?.args,
      { path: "notes/todo.md", content: "sell rice" },
      "D-099: what the model asked for, kept separate — an audit record that merged the two could not answer the only " +
        "question it exists for",
    );
    assert.equal(
      readFileSync(path.join(root, "notes/todo.md"), "utf8"),
      "buy rice",
      "nothing was written while the prompt was open",
    );

    harness.answer(row.id, "approve", { via: "cli" });
    const resumed = await harness.resume(suspended(outcome));
    assert.equal(
      resumed.kind,
      "completed",
      resumed.kind === "refused" || resumed.kind === "failed" ? resumed.reason : "",
    );
    assert.equal(
      readFileSync(path.join(root, "notes/todo.md"), "utf8"),
      "sell rice",
      "the approval was spendable at the moment of execution, which is the property D-099's enrichment exists to keep: " +
        "the binding the user signed is the binding the re-evaluation computes",
    );
    assert.equal(
      harness.eventsOfType("approval.re-requested").length,
      0,
      "the fact did not change while the prompt was open, so §6.3's material-change rule had nothing to say",
    );
    assert.deepEqual(
      harness.checkpointWrites.map((write) => write.boundary),
      ["prompt", "step"],
      "D-095's second boundary is the durable trace of the suspension, and the committed step replaces it",
    );
  });

  it("keeps a create at T1 next to an edit of the same path at T2, so the tier is the fact's and not the tool's", async () => {
    const { root, harness } = compose([
      writeRound("notes/new.md", "x"),
      editRound("notes/new.md", "y"),
      doneRound,
    ]);
    const outcome = await harness.start();

    assert.deepEqual(
      harness
        .eventsOfType("tool.call.proposed")
        .map((event) => [String(event.payload.tool), String(event.payload.tier)]),
      [
        ["file.write", "T1"],
        ["file.edit", "T2"],
      ],
      "two rows of §4.2's table, one path, and the difference between them is a fact the runtime measured",
    );
    // No ledger of what Crabby created exists in this build, so "a file that is already there" is answered as "not ours".
    // D-099 records the conservatism and its direction: §4.2's escalations only ever move a tier up.
    assert.equal(outcome.kind, "awaiting-approval");
    assert.equal(
      readFileSync(path.join(root, "notes/new.md"), "utf8"),
      "x",
      "the create ran; the edit is waiting",
    );
    assert.deepEqual(
      harness.eventsOfType("tool.call.proposed")[1]?.payload.facts,
      { preExistingUserFile: true },
      "the second proposal is the edit, and the fact it carries is the one that raised its tier",
    );
  });

  it("rejects malformed arguments before policy is asked, and the run continues", async () => {
    const { root, harness } = compose([
      [{ kind: "tool-call", name: "file.read", arguments: { path: 42 } }],
      doneRound,
    ]);
    const outcome = await harness.start();

    assert.equal(
      outcome.kind,
      "completed",
      "a rejected step is an answer the model can plan around, not a dead task",
    );
    assert.equal(harness.payloadOf("tool.call.proposed")?.outcome, "invalid-arguments");
    assert.equal(harness.payloadOf("tool.execution.blocked")?.class, "validation");
    assert.match(
      String(harness.payloadOf("tool.execution.blocked")?.reason),
      /its own schema rejects/,
      "§4.1: 'malformed arguments are rejected pre-execution'; §4.3: 'so a schema mismatch can never be mistaken for " +
        "permission'",
    );
    assert.equal(
      harness.approvals.list().length,
      0,
      "the arbiter was never asked, so a number where a path belongs produced no tier and no queue row",
    );
    assert.equal(harness.executions.length, 0, "§4.4's first step happens before its fourth");
    assert.equal(existsSync(path.join(root, "42")), false);
  });

  it("reports §6.2's uncertainty from the declaration, so a read is not a rumour about side effects", async () => {
    const read = compose(
      [[{ kind: "tool-call", name: "file.read", arguments: { path: "notes/todo.md" } }], doneRound],
      {
        duringStep: (instance) => {
          instance.cancel({ mode: "finish-step" });
        },
      },
    );
    place(read.root, "notes/todo.md", "buy rice");
    const readEvidence = cancelled(await read.harness.start());
    assert.equal(readEvidence.step?.tool, "file.read");
    assert.equal(
      readEvidence.terminated,
      true,
      "the executor reported back, so the operation is confirmed stopped",
    );
    assert.equal(
      readEvidence.effectsUncertain,
      false,
      '`file.read` declares `sideEffects: "none"` (§4.1, D-098), and D-089\'s constant `true` was only honest while ' +
        "nothing declared one — reporting uncertainty for a read is how a user learns to ignore the word",
    );

    const removed = compose(
      [
        [{ kind: "tool-call", name: "file.delete", arguments: { path: "notes/todo.md" } }],
        doneRound,
      ],
      {
        duringStep: (instance) => {
          instance.cancel({ mode: "finish-step" });
        },
      },
    );
    place(removed.root, "notes/todo.md", "buy rice");
    const prompted = await removed.harness.start();
    assert.equal(
      prompted.kind,
      "awaiting-approval",
      "§4.2 prices `file.delete` at T2 before any argument is read, so a delete is prompted even inside the workspace",
    );
    const row = removed.harness.pending()[0];
    assert.ok(row);
    assert.equal(
      row.request.reversibility,
      "uncertain",
      "a trash-or-rename delete is not declared irreversible, and " +
        "`hard` is what would make it one",
    );
    removed.harness.answer(row.id, "approve", { via: "tui" });
    const deleteEvidence = cancelled(await removed.harness.resume(suspended(prompted)));
    assert.equal(deleteEvidence.step?.tool, "file.delete");
    assert.equal(
      deleteEvidence.effectsUncertain,
      true,
      "`file.delete` declares `irreversible`, so the honest answer to 'may an effect have happened' is yes — and the bytes " +
        "really were moved to scratch before the request was recorded",
    );
    assert.equal(existsSync(path.join(removed.root, "notes/todo.md")), false);
    const trash = readdirSafe(path.join(removed.scratch, "trash"));
    assert.equal(
      trash.length,
      1,
      "§8's trash-or-rename happened inside the task's own scratch directory",
    );
    assert.match(
      trash[0] ?? "",
      /-todo\.md$/,
      "the trashed name keeps the file's own basename and gains the time",
    );
    assert.equal(
      readFileSync(path.join(removed.scratch, "trash", trash[0] ?? ""), "utf8"),
      "buy rice",
      "the bytes survived the delete, which is the whole of what 'trash-or-rename in place of hard delete' promises",
    );
    assert.equal(
      removed.harness.task()?.cancellation?.effectsUncertain,
      true,
      "F-46's rule: the evidence is on the task record a client polls, not only in the event it may have missed",
    );
  });

  it("prompts before a move onto an occupied destination, because the runtime saw the destination", async () => {
    const move = compose([
      [
        {
          kind: "tool-call",
          name: "file.move",
          arguments: { path: "a.md", destination: "notes/todo.md" },
        },
      ],
      doneRound,
    ]);
    place(move.root, "notes/todo.md", "x");
    place(move.root, "a.md", "y");
    const outcome = await move.harness.start();

    assert.equal(outcome.kind, "awaiting-approval");
    assert.deepEqual(
      move.harness.payloadOf("tool.call.proposed")?.facts,
      { overwrites: true },
      "§4.2's T2 for 'moving onto an existing target' is a fact about the destination, and the runtime is the party that " +
        "looked",
    );
    assert.equal(move.harness.pending()[0]?.request.tier, "T2");
    assert.equal(
      move.harness.checkpoint()?.boundary,
      "prompt",
      "D-095's durable trace of the suspension",
    );
    assert.equal(
      readFileSync(path.join(move.root, "a.md"), "utf8"),
      "y",
      "the source is untouched while the prompt is open",
    );
  });

  it("answers D-065's resume verdict from a declaration, which is the permission §7.3 was missing", async () => {
    const facts = declaredStepFacts();
    // The bridge first, because everything below rests on it: §4.1's record is what D-065's first permission asks for, and
    // until M2k nothing in the build could answer it.
    assert.equal(
      facts("file.edit").idempotent,
      true,
      "re-running replaces the same file with the same bytes",
    );
    assert.equal(
      facts("file.move").idempotent,
      false,
      "a successful move removes its own precondition, so a re-run finds nothing to move",
    );
    assert.equal(
      facts("file.delete").idempotent,
      true,
      "an absent path is the end state a delete intended",
    );
    assert.equal(
      facts("shell.run").idempotent,
      false,
      "a tool no executor declares answers neither fact, which is §7.3's 'anything else re-asks'",
    );
    assert.equal(
      facts("file.edit").effectRecorded,
      false,
      "§7.3's second permission needs a receipt — an operation identifier or a reconciled external state — and this build " +
        "issues none, so the verdict is carried by the idempotence half alone",
    );

    // A run suspended at a prompt committed a `prompt` boundary, which D-095 writes *before* the gated action runs — so
    // the honest verdict is `resume`, not `pass`: nothing was in flight to repeat.
    const edit = compose([editRound("notes/todo.md", "y"), doneRound], { stepFacts: facts });
    place(edit.root, "notes/todo.md", "x");
    assert.equal((await edit.harness.start()).kind, "awaiting-approval");
    const record = edit.harness.checkpoint();
    assert.equal(record?.boundary, "prompt");
    assert.equal(
      edit.harness.checkpoints.verdict(edit.harness.taskId).verdict,
      "resume",
      "a prompt boundary is committed before the step starts, so there is no in-flight action for D-065 to judge",
    );

    // The case D-065's permissions exist for: a step whose `tool.execution.started` has no outcome beside it, which is what
    // a process killed mid-step leaves behind. Driven through the same pure verdict the route reads, over the boundary this
    // run really committed.
    assert.ok(record);
    const task = edit.harness.task();
    assert.ok(task);
    const inFlight = (tool: string): Event[] => [
      {
        id: newId("evt"),
        schemaVersion: SCHEMA_VERSION,
        type: "tool.execution.started",
        ts: new Date(edit.harness.clock.now()).toISOString(),
        sessionId: edit.harness.sessionId,
        taskId: edit.harness.taskId,
        seq: record.lastSeq + 1,
        payload: { tool },
      },
    ];
    assert.equal(
      verdictFor({ task, record, tail: inFlight("file.edit"), stepFacts: facts }).verdict,
      "pass",
      "`file.edit` declares itself idempotent, so §7.3's first permission is satisfied by a declaration rather than by a " +
        "guess — the branch that had no possible witness before M2k",
    );
    assert.equal(
      verdictFor({ task, record, tail: inFlight("file.move"), stepFacts: facts }).verdict,
      "re-ask",
      "`file.move` declares itself *not* idempotent, and D-065's rule is that anything else re-asks rather than repeating " +
        "an external action",
    );
    assert.equal(
      verdictFor({ task, record, tail: inFlight("file.delete"), stepFacts: facts }).verdict,
      "pass",
      "a delete may be repeated: an absent path is reported as the outcome the caller wanted, so a re-run cannot delete " +
        "twice",
    );
  });

  it("turns an executor that throws into a failed step instead of a task nobody is driving", async () => {
    const { root, harness } = compose([writeRound("notes/todo.md", "buy rice"), doneRound], {
      throwOn: "file.write",
    });
    const outcome = await harness.start();

    assert.equal(
      outcome.kind,
      "completed",
      "a rejected `start()` would have left the task in `running` with no terminal edge taken and no event for it — the " +
        "two things §5.1's pairing rule and §4.1's table both forbid",
    );
    const failed = harness.payloadOf("tool.execution.failed");
    assert.equal(failed?.code, "executor-error");
    assert.match(
      String(failed?.output),
      /the adapter exploded/,
      "the model is told what happened, in the adapter's words",
    );
    assert.equal(
      existsSync(path.join(root, "notes/todo.md")),
      false,
      "nothing was written by a call that threw",
    );
    assert.equal(harness.states.at(-1), "completed");
  });
});

/** Read a directory the way a test should: an absent directory is an empty list, not a thrown `ENOENT` that turns an
 *  assertion about a trash folder into a failure about a path. */
function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
