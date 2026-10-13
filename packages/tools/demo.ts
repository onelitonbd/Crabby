// Run this: `node packages/tools/demo.ts`.
//
// It is the review surface for M2k — one task driven end to end by the real loop against a real executor over a real
// directory tree in `os.tmpdir()`, printing what each party decided and why. `packages/agent-runtime/loop-harness.ts` has
// its own demo, and it deliberately runs against a *recording* executor: the loop must not know which tools exist
// (`ARCHITECTURE.md` §19). This file is the other half of that sentence — the executor that fills the seam — and it cannot
// live inside `packages/agent-runtime`, because that would be the cycle §19 forbids.
//
// What it shows, in order: a T0 read and a T1 create running with no prompt and writing real bytes; an edit of a file that
// was already on disk stopping at a T2 prompt *because the runtime observed the file* (§4.3, D-099), with the prompt naming
// the sentence that raised it; that approval still spendable at the moment of execution (D-084's binding covers the
// observation, not just the request); §6.2's cancellation evidence differing between a read and a delete because §4.1's
// `sideEffects` is finally declared (D-098, which amends D-089's constant); and D-065's resume verdict answering `pass` for
// a tool that declares itself idempotent and `re-ask` for one that cannot.
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type CancellationEvidence,
  stepFactsFromDeclarations,
  type ToolSurface,
  verdictFor,
} from "@crabby/agent-runtime";
import {
  createHarness,
  type Harness,
  type HarnessOptions,
} from "@crabby/agent-runtime/loop-harness";
import { type Event, MAX_TOOL_OUTPUT_BYTES, newId, SCHEMA_VERSION } from "@crabby/api-contracts";
import { createFileTools, defaultRealpathOf } from "./index.ts";

const bases: string[] = [];

interface Workspace {
  readonly base: string;
  readonly root: string;
  readonly paths: { home: string; dataDir: string; roots: string[] };
  readonly tools: ReturnType<typeof createFileTools>;
}

/** A fresh device: one workspace root with a file the user already had in it, one home directory that is *not* a
 *  workspace, and a state directory the deny-list covers. Every section of this demo gets its own, so nothing one section
 *  writes can be mistaken for something another section found. */
function workspace(): Workspace {
  const base = mkdtempSync(path.join(tmpdir(), "crabby-tools-demo-"));
  bases.push(base);
  const root = path.join(base, "workspace");
  mkdirSync(path.join(root, "notes"), { recursive: true });
  mkdirSync(path.join(base, "home"), { recursive: true });
  writeFileSync(path.join(root, "notes/todo.md"), "buy rice\ncall the dentist\n", "utf8");
  writeFileSync(path.join(root, "notes/shopping.md"), "rice, lentils\n", "utf8");
  const paths = { home: path.join(base, "home"), dataDir: path.join(base, "state"), roots: [root] };
  return {
    base,
    root,
    paths,
    tools: createFileTools({
      paths,
      scratchDirFor: (taskId) => {
        const dir = path.join(paths.dataDir, "scratch", taskId);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        return dir;
      },
      realpathOf: defaultRealpathOf,
    }),
  };
}

/** An executor with one hook in it: called after the tool answered and before the loop wrote down what happened, which is
 *  the window §6.2's evidence is computed in and the only place a cancellation can arrive while a step's outcome is still
 *  on the record. */
function composed(
  device: Workspace,
  rounds: HarnessOptions["rounds"],
  duringStep?: (harness: Harness) => void,
): Harness {
  // Assigned after `createHarness` returns and read from inside a tool call, so the hook can only fire once there is a
  // harness to fire it at.
  let instance: Harness | undefined;
  const surface: ToolSurface = {
    specs: device.tools.specs,
    facts: device.tools.facts,
    declares: device.tools.declares,
    run: async (call, ctx) => {
      const outcome = await device.tools.run(call, ctx);
      if (instance !== undefined) duringStep?.(instance);
      return outcome;
    },
  };
  const harness = createHarness({
    rounds,
    // Today's date rather than the harness's fixed 2023 clock: a demo that prints an approval expiring three years in
    // the past invites the question "is this a stale fixture?" instead of the one it is meant to invite.
    start: Date.UTC(2026, 9, 11, 7, 0, 0),
    surface,
    grants: ["fs.read", "fs.write"],
    stepFacts: stepFactsFromDeclarations(device.tools.declares),
    ctx: { grants: ["fs.read", "fs.write"], paths: device.paths, realpathOf: defaultRealpathOf },
  });
  instance = harness;
  return harness;
}

function tree(dir: string, indent = "  "): string[] {
  const lines: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    const stats = statSync(full);
    lines.push(
      stats.isDirectory()
        ? `${indent}${entry}/`
        : `${indent}${entry}  (${stats.size} bytes)  ${JSON.stringify(readFileSync(full, "utf8").slice(0, 44))}`,
    );
    if (stats.isDirectory()) lines.push(...tree(full, `${indent}  `));
  }
  return lines;
}

function summarize(event: Event): string {
  const payload = event.payload;
  if (payload.tool !== undefined) {
    const detail =
      payload.outcome !== undefined
        ? ` ${String(payload.outcome)}`
        : payload.reason !== undefined
          ? ` ${String(payload.reason).slice(0, 60)}…`
          : payload.output !== undefined
            ? ` ${String(payload.output).slice(0, 52).replace(/\n/g, " ")}…`
            : "";
    return `${String(payload.tool)}${payload.tier === undefined ? "" : ` [${String(payload.tier)}]`}${detail}`;
  }
  if (payload.to !== undefined) return `${String(payload.from)} → ${String(payload.to)}`;
  if (payload.content !== undefined) return String(payload.content).slice(0, 64);
  return JSON.stringify(payload).slice(0, 76);
}

// ------------------------------------------------------------------ 1. one task, three steps, one prompt

const device = workspace();
console.log("the workspace a user already had:");
for (const line of tree(device.root)) console.log(line);
console.log("");

const harness = composed(device, [
  [{ kind: "tool-call", name: "file.read", arguments: { path: "notes/todo.md" } }],
  [
    {
      kind: "tool-call",
      name: "file.write",
      arguments: { path: "notes/errands.md", content: "post office\nbuy mustard oil\n" },
    },
  ],
  [
    {
      kind: "tool-call",
      name: "file.edit",
      arguments: { path: "notes/todo.md", content: "buy rice (done)\ncall the dentist\n" },
    },
  ],
  [
    {
      kind: "text",
      text: "read the list, wrote notes/errands.md, and marked the rice as bought",
    },
  ],
]);

const started = await harness.start();
console.log(`start       → ${started.kind}`);
console.log(`states      → ${harness.states.join(" → ")}`);
console.log("");
console.log("the stream a client saw:");
for (const event of harness.events) {
  console.log(`  ${String(event.seq).padStart(3)}  ${event.type.padEnd(26)} ${summarize(event)}`);
}
console.log("");
for (const event of harness.eventsOfType("tool.call.proposed")) {
  const observed = event.payload.facts as Record<string, unknown> | undefined;
  console.log(
    `proposal    → ${String(event.payload.tool)} [${String(event.payload.tier ?? "—")}] ${String(event.payload.outcome)}` +
      (observed === undefined
        ? ""
        : `   observed by the runtime: ${JSON.stringify(observed)}  (D-099)`),
  );
}

if (started.kind !== "awaiting-approval") {
  console.log(`expected the edit to stop at a prompt; the run ended \`${started.kind}\``);
  process.exitCode = 1;
} else {
  const prompt = harness.pending()[0];
  if (prompt === undefined) {
    console.log("no prompt was opened, so there is nothing to answer");
    process.exitCode = 1;
  } else {
    console.log("");
    console.log(
      `prompt      → ${prompt.request.tool} [${prompt.request.tier}] ${prompt.request.exact}`,
    );
    console.log(`              effects: ${prompt.request.effects}`);
    console.log(
      `              what could go wrong: ${prompt.request.whatCouldGoWrong.slice(0, 108)}…`,
    );
    console.log(
      `              expires ${new Date(prompt.request.expiresAt).toISOString()} (D-064's ${prompt.request.tier} window)`,
    );
    console.log(`              binding: ${prompt.request.binding}`);
    const suspendedAt = harness.checkpoint();
    console.log(
      `checkpoint  → ${suspendedAt?.boundary} at step ${suspendedAt?.step} (seq ${suspendedAt?.lastSeq}) — verdict ` +
        `\`${harness.checkpoints.view(harness.taskId)?.resume.verdict}\`, because a prompt boundary is committed before ` +
        "the gated action runs and nothing was in flight to repeat (D-095)",
    );

    const answered = harness.answer(prompt.id, "approve", { via: "tui", byClientId: "cln_demo" });
    console.log(`answer      → ${answered.ok ? answered.record.state : answered.code} (via tui)`);
    const resumed = await harness.resume(started.run);
    console.log(`resume      → ${resumed.kind}`);
    console.log(`states      → ${harness.states.join(" → ")}`);
    console.log(
      `executed    → ${harness.executions
        .map(
          (run) => `${run.tool}: ${run.outcome.ok ? "ok" : `refused (${run.outcome.code ?? "?"})`}`,
        )
        .join("  |  ")}`,
    );
    console.log("");
    console.log("the workspace after:");
    for (const line of tree(device.root)) console.log(line);
    const trashed = path.join(device.paths.dataDir, "scratch", harness.taskId);
    console.log(
      `scratch     → ${readdirSync(trashed).length === 0 ? "empty" : readdirSync(trashed).join(", ")} (D-064 prunes it 24 h after the task ends)`,
    );
  }
}

// ------------------------------------------------------------------ 2. §6.2's evidence, from a declaration

console.log("");
for (const step of [
  { tool: "file.read", args: { path: "notes/todo.md" } },
  { tool: "file.delete", args: { path: "notes/shopping.md" } },
]) {
  const victim = workspace();
  const instance = composed(
    victim,
    [
      [{ kind: "tool-call", name: step.tool, arguments: step.args }],
      [{ kind: "text", text: "done" }],
    ],
    (inner) => {
      inner.cancel({ mode: "finish-step" });
    },
  );
  const first = await instance.start();
  let evidence: CancellationEvidence | undefined;
  if (first.kind === "cancelled") {
    evidence = first.evidence;
  } else if (first.kind === "awaiting-approval") {
    // A delete is T2 before any argument is read (§4.2), so the step only runs once the prompt is answered — and the
    // cancellation still has to arrive while it is in flight, which is the same window one approval later.
    const row = instance.pending()[0];
    if (row !== undefined) {
      instance.answer(row.id, "approve", { via: "tui" });
      const second = await instance.resume(first.run);
      if (second.kind === "cancelled") evidence = second.evidence;
    }
  }
  console.log(
    `cancel      → ${step.tool.padEnd(12)} in flight when the user asked to stop: terminated=${String(
      evidence?.terminated,
    )} effectsUncertain=${String(evidence?.effectsUncertain)}   (§4.1 declares sideEffects ` +
      `"${victim.tools.declares(step.tool)?.sideEffects ?? "nothing"}")`,
  );
}

// ------------------------------------------------------------------ 3. D-065's verdict, from the same record

console.log("");
const judged = workspace();
const waiting = composed(judged, [
  [
    {
      kind: "tool-call",
      name: "file.move",
      arguments: { path: "notes/shopping.md", destination: "notes/todo.md" },
    },
  ],
  [{ kind: "text", text: "done" }],
]);
const suspendedRun = await waiting.start();
const boundary = waiting.checkpoint();
const judgedTask = waiting.task();
console.log(
  `verdict     → a move onto an occupied file stopped at ${String(suspendedRun.kind)} [${String(
    waiting.pending()[0]?.request.tier,
  )}] and committed a \`${boundary?.boundary}\` boundary at seq ${boundary?.lastSeq}`,
);
if (boundary !== undefined && judgedTask !== undefined) {
  const facts = stepFactsFromDeclarations(judged.tools.declares);
  const tail = (tool: string): Event[] => [
    {
      id: newId("evt"),
      schemaVersion: SCHEMA_VERSION,
      type: "tool.execution.started",
      ts: new Date(waiting.clock.now()).toISOString(),
      sessionId: waiting.sessionId,
      taskId: waiting.taskId,
      seq: boundary.lastSeq + 1,
      payload: { tool },
    },
  ];
  for (const tool of ["file.edit", "file.delete", "file.move"]) {
    const answer = verdictFor({
      task: judgedTask,
      record: boundary,
      tail: tail(tool),
      stepFacts: facts,
    });
    console.log(
      `              killed mid-\`${tool}\` → \`${answer.verdict}\`  (idempotent=${String(facts(tool).idempotent)}, ` +
        "D-065's first permission)",
    );
  }
}

// ------------------------------------------------------------------ 4. what the executor declares

console.log("");
const declared = device.tools.declarations();
console.log(
  `the executor declares ${declared.length} of §4.2's 45 rows, each with §4.1's five runtime fields and a ${MAX_TOOL_OUTPUT_BYTES}-byte output cap:`,
);
for (const declaration of declared) {
  console.log(
    `  ${declaration.name.padEnd(12)} ${String(declaration.limits.timeoutMs).padStart(6)} ms   idempotent=${String(
      declaration.idempotent,
    ).padEnd(5)}  sideEffects=${declaration.sideEffects}`,
  );
}
console.log("");
console.log(
  "the rest — session.*, task.*, memory.*, config.*, net.fetch, shell.run and §4.2's device rows — stay absent,",
);
console.log("because a name with nothing behind it is the mock this repository refuses to ship.");

for (const base of bases) rmSync(base, { recursive: true, force: true });
