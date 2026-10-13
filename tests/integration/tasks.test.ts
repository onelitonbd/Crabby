// M2's Exit criterion, over real HTTP and a real filesystem: "a multi-step task started from a stub CLI completes,
// streams, persists … and its state matches `GET /tasks/{id}` from a second client. Policy denies what policy must
// deny, in tests." Every other integration file here tests a route against a Gateway that records tasks and drives
// none, because until the handoff that was the whole truth about the build. This one composes the runner the way
// `crabby gateway start` does — an executor over a real workspace root, §3.6's model, and the install's half of
// `EvalContext` — and then asks the only questions that matter about it: did the task move, did the tool really run, is
// the evidence on the record, does a second client see the same thing, and does a capability removed at pairing
// actually stop the write.
//
// The provider is `packages/providers`' fake, which D-081 makes the conformance reference rather than a stub: it is the
// same adapter §7's shared test set holds every real one to, so a run that completes here completes for the reason a run
// completes, and not because a fixture agreed to it.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { type LoopLimits } from "@crabby/agent-runtime";
import { createScriptedProvider } from "@crabby/agent-runtime/loop-harness";
import { type Event, isTerminal, type TaskRecord } from "@crabby/api-contracts";
import { createLogger } from "@crabby/core";
import { buildApp, createClient, type GatewayClient } from "@crabby/gateway";
import { dataLayout, homeDirectory } from "@crabby/platform";
import { capabilitiesFor } from "@crabby/policy";
import { composeProviders, FAKE_TOOL_MODEL_ID, type FakeStep } from "@crabby/providers";
import {
  migrate,
  mintPairingCode,
  openDatabase,
  readEvents,
  redeemPairingCode,
  type SqliteDb,
  taskScratch,
} from "@crabby/storage";
import { createFileTools, defaultRealpathOf } from "@crabby/tools";

interface Harness {
  /** The identity that creates tasks. It holds §6.1's `cli` baseline, which is what the bootstrap identity `crabby
   *  gateway start` pairs first holds: an identity holding nothing would be refused every tool it proposed, and then the
   *  test would be about the refusal rather than about the handoff. */
  readonly cli: GatewayClient;
  /** A second paired client, so "its state matches `GET /tasks/{id}` from a second client" is asserted rather than
   *  assumed — a different identity, a different token, the same record. */
  readonly second: GatewayClient;
  readonly db: SqliteDb;
  readonly url: string;
  /** The second identity's own token. The stream test authenticates with a header rather than with a `GatewayClient`,
   *  because an SSE body is not a document a buffered client can hand back, and because the point is that the identity
   *  watching is not the identity that created. */
  readonly secondToken: string;
  /** A real directory with a real file in it. The executor's roots, policy's `PathContext` and the assertions below all
   *  name this one path, which is what makes "the tool ran" a fact about the filesystem rather than about a mock. */
  readonly root: string;
  close(): Promise<void>;
}

interface BootOptions {
  /** One script per provider round: the fake replays a round per `generate` call, so a two-round script is a tool call
   *  followed by the completion that ends the run. */
  readonly rounds: readonly (readonly FakeStep[])[];
  /** What the creating identity holds. Defaults to `capabilitiesFor("cli")`, the baseline D-102 assigns at pairing. */
  readonly capabilities?: readonly string[] | undefined;
  /** A workspace root to use instead of one made inside the data dir. A test that names a path inside the root in its
   *  provider script needs the path before the harness exists, and inventing it afterwards would mean booting twice. */
  readonly workspace?: string | undefined;
  /** Compose no runner at all — what an install with no workspace root, or no selected default model, gets. */
  readonly noRunner?: boolean | undefined;
  /** §5.2's limits, as the composition root hands them to the runner after `loopLimitsOf` translates them. Absent
   *  means the loop's class defaults, which is what the other tests in this file run under. */
  readonly limits?: Partial<LoopLimits> | undefined;
  /** Restart over a data dir that already exists instead of making one. §7.1's recovery is a property of a second
   *  process reading the first one's database, so a test about a kill and a restart has to boot twice over one file. */
  readonly dataDir?: string | undefined;
}

async function boot(options: BootOptions): Promise<Harness> {
  const dir = options.dataDir ?? mkdtempSync(path.join(tmpdir(), "crabby-tasks-"));
  const layout = dataLayout(dir);
  // A sibling of the data dir and never inside it, which is §8 rather than tidiness: the deny-list refuses anything
  // under `dataDir` outright, and `dataLayout(dir).stateDir` *is* `dir`, so a root at `dir/work` would put every path
  // in it on the list and arrive at T3. A harness that quietly measured the deny-list instead of the handoff would
  // still produce a parked task and a plausible-looking red, so the rule is written down where the next test will read
  // it rather than left as a fixture nobody can explain.
  const root = options.workspace ?? mkdtempSync(path.join(tmpdir(), "crabby-work-"));
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "notes.md"), "# notes\n", "utf8");

  const handle = openDatabase(path.join(dir, "crabby.sqlite3"));
  migrate(handle.db);
  const paths = { home: homeDirectory(), dataDir: layout.stateDir, roots: [root] };
  const executor = createFileTools({
    paths,
    // D-064's over-cap output and §8's trash-or-rename land in the task's scratch directory, and `packages/storage`
    // owns that layout — so the executor is handed the rule rather than deriving one of its own.
    scratchDirFor: (taskId) => taskScratch(layout, taskId),
  });
  const drive = options.noRunner
    ? undefined
    : {
        tools: executor,
        provider: createScriptedProvider(options.rounds),
        modelId: FAKE_TOOL_MODEL_ID,
        limits: options.limits,
        // The same §8 resolver the executor defaults to, so the two halves of one path judgement cannot disagree.
        ctx: { paths, realpathOf: defaultRealpathOf },
      };
  const built = await buildApp({
    db: handle.db,
    layout,
    // §4.1's providers row reports the *configured* adapters, and the runner is composed from the selected one, so a
    // real install hands `buildApp` both. This harness drives with the fake — D-081's conformance reference, not a
    // stub — while reporting one configured local endpoint. Without the pair the row would answer `absent` in a Gateway
    // that is plainly driving tasks, and the note's driven branch would be the one no test reads.
    providers: composeProviders({
      local: {
        baseUrl: "http://127.0.0.1:8080/v1",
        // A whole descriptor, because §3.2's capability questions are answered from it and the adapter refuses one it
        // cannot parse: `contextWindow` is required, and an entry that declares no models is refused for the reason
        // `compose.ts` gives. The shape is the one `tests/integration/gateway.test.ts` composes, so the two harnesses
        // report the same subsystem from the same kind of configuration.
        models: {
          "qwen2.5:3b": {
            contextWindow: 4096,
            maxOutputTokens: 512,
            supports: {
              streaming: true,
              toolCalling: true,
              parallelToolCalls: false,
              systemRole: true,
              structuredOutput: false,
              imageInput: false,
              audioInput: false,
              reasoning: false,
              promptCaching: false,
              jsonSchemaValidation: false,
            },
            cancellation: "best-effort",
            rateLimits: null,
            cost: "local",
            batching: null,
          },
        },
      },
    }),
    log: createLogger({ level: "error", write: () => {} }, "tasks-test"),
    version: "test",
    startedAt: new Date(),
    listenerMode: "local",
    ...(drive === undefined ? {} : { drive }),
  });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const address = built.app.server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const url = `http://127.0.0.1:${port}`;

  const creator = pair(handle.db, "creator", "cli", options.capabilities ?? capabilitiesFor("cli"));
  const reader = pair(handle.db, "reader", "tui", capabilitiesFor("tui"));
  return {
    cli: createClient({ url, token: creator.token }),
    second: createClient({ url, token: reader.token }),
    db: handle.db,
    url,
    secondToken: reader.token,
    root,
    async close() {
      // D-066's order restated in a fixture: runs settle before streams close and before SQLite does. Every task this file
      // creates is driven by a run the route started and did not await, so a close that skipped the drain would be racing
      // the loop's last write against `handle.close()`.
      await built.runner?.shutdown(5_000);
      await built.app.close();
      handle.close();
    },
  };
}

/** Pairing an identity the way the mint route does, capabilities and all: `mintPairingCode` writes what it is given, so
 *  a harness that passed none would hold an empty set and every tool in the run would be refused — a fixture that
 *  quietly tests the wrong thing, which is the mistake F-52's own row describes. */
function pair(
  db: SqliteDb,
  name: string,
  iface: "cli" | "tui",
  capabilities: readonly string[],
): { token: string; clientId: string } {
  const minted = mintPairingCode(db, { name, interface: iface, capabilities });
  const redeemed = redeemPairingCode(db, minted.code);
  assert.ok(redeemed.ok && redeemed.token, `the harness's ${iface} identity has to pair`);
  return { token: redeemed.token as string, clientId: redeemed.clientId as string };
}

/** Polling rather than streaming, because a test that waits on a socket for a fact it can also read is a test that can
 *  hang for a reason unrelated to what it asserts. The deadline *is* the assertion: a task still `queued` when it
 *  expires is the handoff not happening, and the message says that instead of letting the runner time out silently. */
async function untilTerminal(h: Harness, id: string, deadlineMs = 20_000): Promise<TaskRecord> {
  const started = Date.now();
  for (;;) {
    const record = (await h.cli.getTask(id)).body as TaskRecord;
    if (isTerminal(record.state)) return record;
    if (Date.now() - started > deadlineMs)
      // The events are in the message because "nothing drove it" has two very different causes and they need different
      // fixes: a task with only `task.created` behind it was never handed to a runner, and one with a blocked tool call
      // or an open prompt behind it was driven and stopped for a reason the record already states.
      assert.fail(
        `task ${id} was still \`${record.state}\` after ${deadlineMs}ms — the events on its record are ` +
          `${typesOf(readEvents(h.db, id)).join(", ") || "none"}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Waiting for a state that is *not* an end. A run parked at an approval has stopped moving and stays stopped until
 *  somebody answers, so `untilTerminal` would poll it to its deadline: the two waits ask different questions, and a test
 *  that reached for the wrong one would fail on the clock rather than on the behaviour. */
async function untilState(
  h: Harness,
  id: string,
  wanted: string,
  deadlineMs = 20_000,
): Promise<TaskRecord> {
  const started = Date.now();
  for (;;) {
    const record = (await h.cli.getTask(id)).body as TaskRecord;
    if (record.state === wanted) return record;
    if (isTerminal(record.state))
      assert.fail(
        `task ${id} reached ${record.state} instead of ${wanted} — the events are ` +
          `${typesOf(readEvents(h.db, id)).join(", ") || "none"}`,
      );
    if (Date.now() - started > deadlineMs)
      assert.fail(
        `task ${id} was still \`${record.state}\` after ${deadlineMs}ms and never reached ${wanted} — the events are ` +
          `${typesOf(readEvents(h.db, id)).join(", ") || "none"}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function typesOf(events: readonly Event[]): readonly string[] {
  return events.map((event) => event.type);
}

// Node's `fetch` keeps the global undici dispatcher's sockets open for ~72 s after the last response, so a finished file
// looks like a hung one. The same disarm the other integration files carry.
after(async () => {
  const dispatcher = (globalThis as Record<symbol, unknown>)[
    Symbol.for("undici.globalDispatcher.1")
  ] as { close?: () => Promise<void> } | undefined;
  await dispatcher?.close?.();
});

describe("the task handoff over http (M2's Exit criterion)", () => {
  // Booted per test rather than shared, because the fake replays its script round by round: two tasks over one provider
  // would run the second on whatever rounds the first left behind.
  it("drives a task one client creates to `completed`, really runs the tool, and shows a second client the same state", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "crabby-work-"));
    const target = path.join(workspace, "out.md");
    const h = await boot({
      workspace,
      rounds: [
        [
          {
            kind: "tool-call",
            name: "file.write",
            arguments: { path: target, content: "written\n" },
          },
        ],
        [{ kind: "text", text: "wrote out.md" }],
      ],
    });
    try {
      const created = await h.cli.createTask(
        { objective: "write out.md in the workspace" },
        "idem-1",
      );
      assert.equal(created.status, 201, "§4.5's create row answers 201 with a location");
      const record = created.body as TaskRecord;
      assert.equal(
        record.state,
        "queued",
        "the route answers with the record it just wrote and the run moves it after, which is why the next line polls",
      );

      const final = await untilTerminal(h, record.id);
      assert.equal(
        final.state,
        "completed",
        `the run reached ${final.state} rather than completing — ${JSON.stringify(final.error ?? null)}`,
      );
      assert.equal(
        readFileSync(target, "utf8"),
        "written\n",
        "the executor ran for real: the bytes are on the filesystem, which no mock can claim",
      );

      const events = readEvents(h.db, record.id);
      const types = typesOf(events);
      for (const wanted of ["task.created", "tool.execution.started", "task.completed"])
        assert.ok(
          types.includes(wanted),
          `${wanted} is on the record — the events that got the task there persist beside its state, and what was ` +
            `actually written is ${types.join(", ")}`,
        );
      assert.ok(
        events.every((event) => typeof event.seq === "number" && event.seq >= 0),
        "every event carries the per-task `seq` §5.4 gives a client to notice a gap with",
      );

      const second = (await h.second.getTask(record.id)).body as TaskRecord;
      assert.equal(
        second.state,
        final.state,
        "a second identity with a second token reads the state the first one watched the run reach",
      );
      assert.equal(second.id, record.id);

      const diagnostics = (await h.cli.diagnostics()).body as {
        runs: { composed: boolean; inFlight: number };
      };
      assert.equal(
        diagnostics.runs.composed,
        true,
        "this Gateway says it can drive a task, and it just did",
      );
      assert.equal(
        diagnostics.runs.inFlight,
        0,
        "the run settled instead of leaking: `outstanding()` counts what this process is still moving",
      );

      // The same fact on the row a client reads before it posts anything, and the mirror of the case
      // `tests/integration/gateway.test.ts` pins: with no drive composed the note says so, and with one it says the
      // adapter is in use. Two branches of one wire field, because "ready" means different things in the two.
      const status = (await h.cli.status()).body as {
        subsystems: {
          providers?: { state: string; note?: string; entries?: { id: string }[] };
        };
      };
      assert.deepEqual(
        status.subsystems.providers?.entries?.map((entry) => entry.id),
        ["local"],
        "the configured adapter is reported by id, which is what tells an operator which entry composed",
      );
      assert.equal(status.subsystems.providers?.state, "ready");
      assert.match(
        status.subsystems.providers?.note ?? "",
        /composed into the runner this Gateway drives tasks with/,
        "§4.1's row answers from the composition rather than from the build: with a runner composed, `ready` may mean " +
          "a task will run, and the note names what is still absent instead — F-57's per-task fields and F-47's resume",
      );
    } finally {
      await h.close();
    }
  });

  it("hands the runner the `limits.*` the composition root translated, so a raised clock is a raised clock (D-074)", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "crabby-limits-"));
    const target = path.join(workspace, "notes.md");
    const h = await boot({
      workspace,
      // One executed step and a second proposal: with `stepsPerTask: 1` the second is refused by the loop's own
      // budget, and the failure names the limit and the key — which is only true if the number travelled from this
      // body through `DriveFacts.limits` and into the runner rather than the runner keeping its default of 25.
      limits: { stepsPerTask: 1 },
      rounds: [
        [
          {
            kind: "tool-call",
            name: "file.read",
            arguments: { path: target },
          },
        ],
        [
          {
            kind: "tool-call",
            name: "file.read",
            arguments: { path: target },
          },
        ],
      ],
    });
    try {
      const created = await h.cli.createTask(
        { objective: "read notes.md twice" },
        "idem-limits",
      );
      const final = await untilTerminal(h, (created.body as TaskRecord).id);
      assert.equal(
        final.state,
        "failed",
        `the run ended ${final.state}, and with a one-step budget it cannot complete two calls — ` +
          `${JSON.stringify(final.error ?? null)}`,
      );
      assert.equal(
        final.error?.code,
        "limits.steps_per_task",
        "the failure is §5.2's limit with its own code, so a client sees the class without the log",
      );
      assert.match(
        final.error?.message ?? "",
        /step limit of 1/,
        "the number that tripped is the number this body set, so the override reached the loop rather than stopping " +
          "at the composition root's own reading",
      );
      assert.match(
        final.error?.message ?? "",
        /limits\.stepsPerTask/,
        "and §5.2's own sentence: the failure names the limit and how to change it",
      );
    } finally {
      await h.close();
    }
  });

  it("refuses a capability removed at pairing, and §13's own sentence is what the record says", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "crabby-narrow-"));
    const target = path.join(workspace, "never.md");
    const h = await boot({
      workspace,
      // The objective, the script and the workspace are the same as the test above; the only difference is what the
      // identity holds. That is the point: D-054 makes `--restrict` a removal, so a narrowed identity proposes the same
      // tool and policy answers differently — and §13 says how the answer has to read.
      capabilities: ["task.create", "task.read", "session.read"],
      rounds: [
        [
          {
            kind: "tool-call",
            name: "file.write",
            arguments: { path: target, content: "should never exist\n" },
          },
        ],
        [{ kind: "text", text: "I could not write it" }],
      ],
    });
    try {
      const created = await h.cli.createTask({ objective: "write never.md" }, "idem-2");
      const record = created.body as TaskRecord;
      const final = await untilTerminal(h, record.id);
      assert.equal(
        existsSync(target),
        false,
        "policy refused the write, so the executor was never touched — the file does not exist",
      );
      assert.ok(
        isTerminal(final.state),
        `a refusal the client cannot escalate ends the run rather than hanging it (reached ${final.state})`,
      );

      const events = readEvents(h.db, record.id);
      const blocked = events.find((event) => event.type === "tool.execution.blocked");
      assert.ok(
        blocked !== undefined,
        `the refusal is on the record as an event and not only as an absent file — what was written is ` +
          `${typesOf(events).join(", ")}`,
      );
      const payload = blocked?.payload as { reason?: string; tool?: string; class?: string };
      assert.equal(payload.tool, "file.write");
      assert.match(
        String(payload.reason),
        /not available to this client/,
        '§13: a removed capability is reported as "not available to this client" with the reason',
      );
      assert.match(
        String(payload.reason),
        /fs\.write/,
        "and the reason names the capability that was missing, so an operator can tell a pairing restriction from a " +
          "path refusal without reading the code",
      );
      assert.equal(
        payload.class,
        "platform-unsupported",
        "§13 asks for `platform-unsupported`-style reporting of a removed capability, and `unavailable` is what " +
          "`packages/policy` answers when the subject does not hold the grant",
      );
      assert.ok(
        !typesOf(events).includes("tool.execution.completed"),
        "nothing completed the refused call: a blocked step has no output event beside it",
      );
    } finally {
      await h.close();
    }
  });

  it("streams the same task to a client that did not create it, and what arrives is what the record holds", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "crabby-stream-"));
    const notes = path.join(workspace, "notes.md");
    const h = await boot({
      workspace,
      rounds: [
        // `file.read` inside a workspace of its own, at T0: a read the identity holds a grant for and that is neither
        // sensitive nor outside a root needs no approval, so the run reaches its end and the stream has something to
        // carry. The alternative fixture — the same relative path against the harness's data dir — parks the task at a
        // T3 approval, because §8 refuses anything under `dataDir`; that is the deny-list working, and it is the wrong
        // thing for a test about streaming to be measuring.
        [{ kind: "tool-call", name: "file.read", arguments: { path: notes } }],
        [{ kind: "text", text: "read it" }],
      ],
    });
    // Declared outside the `try` so the `finally` can release the socket whatever happened in between. An SSE response
    // the test forgets to cancel is not a tidy-up problem: `app.close()` waits on open connections, so a failure in the
    // middle of this test would otherwise outlive its own deadline and hang the whole file.
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      // The stream opens *before* the task exists, and with the second identity's token. A reconnect with
      // `Last-Event-ID` cannot stand in for this: the Gateway replays only from an id it recognises and answers anything
      // else with §5.4's `gap` frame, which is the right behaviour for a client that dropped but the wrong fixture for
      // a test claiming a second client watched a task run. Watching is what `crabby task watch` does, so this does it.
      const response = await fetch(`${h.url}/api/v1/events`, {
        headers: { authorization: `Bearer ${h.secondToken}`, accept: "text/event-stream" },
      });
      assert.equal(
        response.status,
        200,
        "the stream opens for an identity that has created nothing",
      );
      assert.equal(
        response.headers.get("content-type"),
        "text/event-stream; charset=utf-8",
        "§5.1's content type, which is what tells a client this is a channel and not a document",
      );
      reader = response.body?.getReader();
      assert.ok(reader, "the stream has a body to read");

      const created = await h.cli.createTask({ objective: "read notes.md" }, "idem-3");
      assert.equal(created.status, 201);
      const record = created.body as TaskRecord;

      const decoder = new TextDecoder();
      let buffer = "";
      const seen: string[] = [];
      const deadline = Date.now() + 20_000;
      outer: for (;;) {
        if (Date.now() > deadline)
          assert.fail(
            `the stream never carried task.completed; what arrived was ${seen.join(", ") || "nothing"}`,
          );
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        for (;;) {
          const separator = buffer.indexOf("\n\n");
          if (separator === -1) break;
          const frame = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          // `data:` carries a space after the colon, and the 15 s heartbeat arrives as a comment frame with no data at
          // all — both are §5.1's, and a parser that assumed otherwise would either mis-read a payload or hang on an
          // idle channel that is demonstrably alive.
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("\n");
          if (data.length === 0) continue;
          const parsed = JSON.parse(data) as { type?: string; taskId?: string };
          if (parsed.taskId !== record.id) continue;
          if (typeof parsed.type === "string") seen.push(parsed.type);
          if (parsed.type === "task.completed") break outer;
        }
      }

      assert.ok(
        seen.includes("task.created"),
        `the stream carried the creation to a client that did not create it; what arrived was ${seen.join(", ")}`,
      );
      assert.ok(
        seen.includes("tool.execution.started"),
        `and the tool actually running, which is the part a client cannot infer from the end state alone; what arrived ` +
          `was ${seen.join(", ")}`,
      );
      assert.ok(
        seen.includes("task.completed"),
        `and the end; what arrived was ${seen.join(", ")}`,
      );

      const final = await untilTerminal(h, record.id);
      assert.equal(final.state, "completed");
      const persisted = typesOf(readEvents(h.db, record.id));
      for (const type of seen)
        assert.ok(
          persisted.includes(type),
          `every frame the stream carried is a row on the record — ${type} arrived and was not persisted`,
        );
    } finally {
      await reader?.cancel().catch(() => undefined);
      await h.close();
    }
  });

  it("records a task and drives nothing when no runner was composed, and says so instead of leaving a client to guess", async () => {
    const h = await boot({ rounds: [[{ kind: "text", text: "never called" }]], noRunner: true });
    try {
      const diagnostics = (await h.cli.diagnostics()).body as {
        runs: { composed: boolean; inFlight: number };
      };
      assert.equal(
        diagnostics.runs.composed,
        false,
        "the Gateway answers the question `crabby task run` asks before it creates anything: an install with no " +
          "executor, or no selected model, composes no runner",
      );
      const created = await h.cli.createTask({ objective: "nothing will run this" }, "idem-4");
      assert.equal(created.status, 201, "the route still does its own job: a task is recorded");
      const record = created.body as TaskRecord;
      assert.equal(record.state, "queued");
      // Not polled to a deadline here: the claim is that nothing moves it, and the honest way to assert that is to look
      // twice with a gap and find the same state, rather than to wait for a change this build cannot produce.
      await new Promise((resolve) => setTimeout(resolve, 200));
      const again = (await h.cli.getTask(record.id)).body as TaskRecord;
      assert.equal(
        again.state,
        "queued",
        "and it is still `queued`, which is the truth rather than a shrug",
      );
      assert.equal(
        readEvents(h.db, record.id).length,
        1,
        "one event: the creation, and nothing after it",
      );
    } finally {
      await h.close();
    }
  });

  it("leaves a run the process died during interrupted, which is the last clause of M2's Exit criterion", async () => {
    // One data dir and two processes over it, because that is what a restart *is*: not a second harness, but a second
    // `buildApp` reading the database the first one left behind. `tests/integration/recovery.test.ts` asserts this for a
    // task whose state the test wrote directly; this asserts it for a task a real run was in the middle of, which is the
    // case M2's Exit criterion names and which nothing could test before the handoff existed.
    const dataDir = mkdtempSync(path.join(tmpdir(), "crabby-restart-"));
    const workspace = mkdtempSync(path.join(tmpdir(), "crabby-parked-"));
    // A write outside every root, which policy raises to T2: the loop opens an approval and parks, and a run parked on a
    // question nobody has answered is precisely the state a process can die in with work half done.
    const outside = path.join(mkdtempSync(path.join(tmpdir(), "crabby-outside-")), "nope.md");
    const first = await boot({
      dataDir,
      workspace,
      rounds: [
        [
          {
            kind: "tool-call",
            name: "file.write",
            arguments: { path: outside, content: "never written\n" },
          },
        ],
        [{ kind: "text", text: "not reached" }],
      ],
    });
    const id: string = await (async () => {
      try {
        const created = await first.cli.createTask(
          { objective: "write outside the root" },
          "idem-5",
        );
        const record = created.body as TaskRecord;
        await untilState(first, record.id, "awaiting_approval");
        assert.equal(
          existsSync(outside),
          false,
          "the write did not happen: a T2 outside every root waits for an answer that has not arrived",
        );
        return record.id;
      } finally {
        // `close()` runs the shutdown hook and drains, which a `SIGKILL` would not. What §7.1 promises is a property of
        // the database the *next* process reads, and a parked run is left parked by both: `shutdown` reports it as
        // `parked` rather than abandoning or cancelling it, so the record this test restarts over is the record a crash
        // would have left.
        await first.close();
      }
    })();

    const second = await boot({
      dataDir,
      workspace,
      rounds: [[{ kind: "text", text: "nothing to resume" }]],
    });
    try {
      const record = (await second.cli.getTask(id)).body as TaskRecord;
      assert.equal(
        record.state,
        "interrupted",
        "§7.1 restores the latest valid state and D-083's `recoveryTarget` is uniform: a process that died mid-round " +
          "leaves no trustworthy record of what the model had been told, so the second process says that instead of " +
          "resuming into it",
      );
      const events = readEvents(second.db, id);
      const interrupted = events.find((event) => event.type === "task.interrupted");
      assert.ok(
        interrupted !== undefined,
        "the move has its own event, because a state change nobody can replay gets re-done by the next client — what is " +
          `on the record is ${typesOf(events).join(", ")}`,
      );
      assert.equal(
        (interrupted.payload as { resumed?: boolean }).resumed,
        false,
        "§7.2: automatic orchestration of recovery is not automatic authorization, and the parked approval is still " +
          "unanswered — a resumed run here would be the bug this clause exists to prevent",
      );
      const reason = String((interrupted.payload as { reason?: string }).reason ?? "");
      assert.match(
        reason,
        /there is no `POST \/api\/v1\/tasks\/\{id\}\/resume`/,
        "the reason names the party that is actually missing. A runner *is* composed in this Gateway — it is what parked " +
          "the run — so a sentence blaming the composition would be the lie, and what stands between this durable " +
          "checkpoint and a resumed run is F-47's absent route",
      );
      assert.match(
        reason,
        /D-065's verdict on it is `resume`/,
        "and it reports the boundary the dead run really committed, which is a fact only a run that executed a step can " +
          "produce: §7.2's answer is worth reading because it says what could be resumed, not merely that nothing was",
      );
    } finally {
      await second.close();
    }
  });
});
