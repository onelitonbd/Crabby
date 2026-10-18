// The app itself, driven by bytes — the slice of the TUI no unit test can reach.
//
// Slice fifty-sixth built the renderer's plan, slice fifty-seventh built the pane's projection, and neither one can answer
// "what happens when a person presses a key": the renderer has no keys, the projection has no terminal. `runTui` takes its
// stdin and stdout as **parameters**, so this file drives the whole loop with a fake stream — which is how the two bugs that
// only a real run could find are now permanent tests rather than stories:
//
//   1. **`listTasks` answers an envelope.** The first `TaskReader` promised `{ items }` and the app crashed on its first
//      frame against a real Gateway, because the cast that let the pane compile was the cast that hid the `{ ok, status,
//      body }` shape. The reader is the client's shape now, and the fake below returns an envelope.
//   2. **Tab was the wrong key for the pane you wanted.** Opening on `tasks` meant Tab cycled to `jobs`; §4's pane list
//      starts with chat, so the app opens on chat and `1`–`6` jump.
//
// What is *not* here: the event stream (it needs a live Gateway, and `transcript.test.ts` already covers what frames do to a
// transcript), and any assertion about a Gateway's behaviour.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { dataLayout } from "@crabby/platform";
import { runTui } from "./main.ts";
import type { TaskReader, TaskSummary } from "./panes.ts";

/** A stdin that is a TTY, records `setRawMode`, and lets the test push bytes and end the stream. A pty would be more honest
 *  about *terminal behaviour* and it is also unavailable on this platform — so the fake covers the contract (bytes in, mode
 *  toggled, `end` ends the loop) and a real device run covers the rest, which is why the run notes in the ROADMAP say what was
 *  verified where. */
class FakeStdin extends EventEmitter {
  isTTY = true;
  raw = false;
  resumed = false;
  paused = false;
  setRawMode(mode: boolean): this {
    this.raw = mode;
    return this;
  }
  resume(): this {
    this.resumed = true;
    return this;
  }
  pause(): this {
    this.paused = true;
    return this;
  }
  type(text: string): void {
    this.emit("data", Buffer.from(text, "utf8"));
  }
  end(): void {
    this.emit("end");
  }
}

interface Run {
  readonly out: () => string;
  readonly code: Promise<number>;
  readonly codeSettled: () => boolean;
  readonly stdin: FakeStdin;
  readonly created: { objective: string; key: string; model: string | undefined }[];
  readonly cancelled: string[];
  readonly patched: { id: string; title: string | undefined; ifMatch: number }[];
  readonly revoked: string[];
  readonly finish: () => Promise<void>;
  /** Resolves once the app has written its first frame. Every test waits for this rather than a tick, because `runTui`
   *  awaits `connect` and the first read before it attaches its `end` listener — so a test that ends the stream too early
   *  ends it to nobody and then waits forever. */
  ready(): Promise<void>;
}

function harness(
  options: {
    readonly tasks?: readonly TaskSummary[];
    readonly sessions?: readonly {
      readonly id: string;
      readonly titleShown: string;
      readonly stateWord: string;
      readonly revision: number;
    }[];
    readonly suspend?: () => void;
    /** A config.json for the tests that touch the models pane's data (`/model`, T5-05). Written before `runTui` so the
     *  startup read sees it. */
    readonly config?: Record<string, unknown>;
    readonly columns?: number;
    readonly rows?: number;
  } = {},
): Run {
  const dir = mkdtempSync(path.join(tmpdir(), "crabby-tui-"));
  const layout = dataLayout(dir);
  mkdirSync(layout.stateDir, { recursive: true, mode: 0o700 });
  if (options.config !== undefined) {
    writeFileSync(layout.configPath, `${JSON.stringify(options.config)}\n`, { mode: 0o600 });
  }
  const out: string[] = [];
  const stdout = {
    columns: options.columns ?? 40,
    rows: options.rows ?? 24,
    isTTY: true,
    write: (text: string) => {
      out.push(text);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  const stdin = new FakeStdin();
  const created: { objective: string; key: string; model: string | undefined }[] = [];
  const cancelled: string[] = [];
  const patched: { id: string; title: string | undefined; ifMatch: number }[] = [];
  const revoked: string[] = [];
  const tasks = options.tasks ?? [];
  const client: TaskReader = {
    listTasks: async () => ({ ok: true, status: 200, body: { items: tasks } }),
    cancelTask: async (id: string) => {
      cancelled.push(id);
      return { ok: true, status: 202, body: {} };
    },
    createTask: async (
      body: { readonly objective: string; readonly model?: string | undefined },
      key: string,
    ) => {
      created.push({ objective: body.objective, key, model: body.model });
      return { ok: true, status: 201, body: { id: "tsk_sent" } };
    },
    // T16's reads and writes, as envelopes like every other fake here.
    sessions: async () => ({ ok: true, status: 200, body: { items: options.sessions ?? [] } }),
    createSession: async () => ({ ok: true, status: 201, body: { session: {}, note: "created" } }),
    patchSession: async (id: string, body: { readonly title?: string }, ifMatch: number) => {
      patched.push({ id, title: body.title, ifMatch });
      return { ok: true, status: 200, body: { session: {}, note: "renamed" } };
    },
    sessionContext: async () => ({
      ok: true,
      status: 200,
      body: {
        sessionId: "s_1",
        projected: { tokens: 900, source: "estimated" },
        budget: {
          window: 1000,
          reserveForOutput: 100,
          tokens: 900,
          compactAtTokens: 800,
          compactAt: 0.8,
        },
        turns: 1,
      },
    }),
    compactSession: async () => ({ ok: true, status: 200, body: { note: "compacted" } }),
    pinMessages: async () => ({ ok: true, status: 200, body: { note: "pinned" } }),
    // T12/T14's reads and writes.
    tools: async () => ({
      ok: true,
      status: 200,
      body: {
        items: [
          {
            id: "shell.run",
            capabilities: ["shell.run"],
            riskTier: "T3",
            tierText: "T3",
            tierRules: ["every call asks, unless the session already holds it"],
            enabled: true,
            availability: { available: true, requires: "any" },
            pendingRecordFields: [],
            inputSchema: { type: "object", properties: { command: { type: "string" } } },
            limits: { timeoutMs: 120000, maxOutputBytes: 65536 },
          },
          {
            id: "fs.read",
            capabilities: ["fs.read"],
            riskTier: "T0",
            tierText: "T0",
            tierRules: [],
            enabled: true,
            availability: { available: true, requires: "any" },
            pendingRecordFields: [],
          },
        ],
        registry: { source: "PROVIDERS_AND_TOOLS.md §4.2", rows: 2, digest: "d1g3st" },
      },
    }),
    authList: async () => ({
      ok: true,
      status: 200,
      body: {
        items: [
          {
            id: "cli_1",
            name: "pixel 8a",
            interface: "cli",
            capabilities: ["session.read", "task.create"],
            createdAt: "2026-10-01T09:00:00Z",
            lastUsedAt: "2026-10-15T22:10:00Z",
            liveStreams: 2,
          },
        ],
      },
    }),
    authRevoke: async (id: string) => {
      revoked.push(id);
      return { ok: true, status: 200, body: { streamsEnded: 2 } };
    },
    pairCode: async () => ({
      ok: true,
      status: 201,
      body: { code: "824199", expiresAt: "2026-10-16T10:30:00Z", capabilities: ["a", "b"] },
    }),
    diagnostics: async () => ({
      ok: true,
      status: 200,
      body: { listener: { host: "127.0.0.1", port: 8734 } },
    }),
  };
  let settled = false;
  const code = runTui({
    dataDir: dir,
    columns: options.columns ?? 40,
    rows: options.rows ?? 24,
    env: { TERM: "xterm-256color" },
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout,
    client,
    suspend: options.suspend,
    // `now` is frozen so the repaint cap cannot swallow a frame the test is waiting for; the cap itself is tested in
    // `render.test.ts`, and here it would only make this file flaky.
    now: () => 0,
  }).then(
    (value) => {
      settled = true;
      return value;
    },
    (error: unknown) => {
      settled = true;
      throw error;
    },
  );
  return {
    out: () => out.join(""),
    code,
    /** Whether the run has already exited — a quit assertion's negative, without awaiting the exit. */
    codeSettled: () => settled,
    stdin,
    created,
    cancelled,
    patched,
    revoked,
    finish: async () => {
      stdin.end();
      await code;
    },
    ready: async () => {
      for (let attempt = 0; attempt < 2000; attempt += 1) {
        if (out.length > 0) return;
        await new Promise((resolve) => setImmediate(resolve));
      }
      throw new Error("the app wrote no frame in 2000 turns of the event loop");
    },
  };
}

const plain = (text: string): string =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the frame's own escape sequences, stripped for reading
  text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");

describe("crabby tui, driven by bytes", () => {
  it("draws a frame with the pane row, the status line and the hint strip", async () => {
    const run = harness();
    await run.ready();
    const text = plain(run.out());
    // 40 columns abbreviates every name to three characters, which is T1-02's own rule — so the assertion is on the
    // abbreviated row, and the wide row is what a wider terminal shows.
    assert.match(
      text,
      />cha {2}tas {2}job {2}app {2}log {2}mod/,
      "T1-02: one line, abbreviated at 40 columns",
    );
    assert.match(text, /fs: workspace · net: off · shell: off/, "T5-06's capability line");
    assert.match(text, /q quit/, "T3-01's hint strip");
    await run.finish();
  });

  it("puts the terminal in raw mode on the way in and restores it on the way out", async () => {
    const run = harness();
    await run.ready();
    assert.equal(
      run.stdin.raw,
      true,
      "T1-08's Ctrl-C bind only exists if the terminal's default is off",
    );
    await run.finish();
    assert.equal(
      run.stdin.raw,
      false,
      "and a TUI that leaves the shell in raw mode is a broken shell",
    );
  });

  it("typing lands in the composer and Enter sends it as a task", async () => {
    const run = harness();
    await run.ready();
    run.stdin.type("what is in the roadmap");
    await new Promise((resolve) => setImmediate(resolve));
    run.stdin.type("\r");
    // The send is a promise the pane awaits; two turns of the event loop is enough for the fake client to answer and the
    // frame to be written again.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(run.created.length, 1, "Enter sends");
    assert.equal(run.created[0]?.objective, "what is in the roadmap");
    assert.match(
      plain(run.out()),
      /sent as task tsk_sent/,
      "and the pane names the task so a shell can follow it",
    );
    // T2-09: the copyable facts get lines of their own — a bare id line, then the exact watch command — because Termux
    // copies by long-press and an id inside a sentence is an id that gets clipped.
    const lines = plain(run.out())
      .split(/[\r\n]/)
      .map((line) => line.trim());
    assert.ok(lines.includes("tsk_sent"), "the task id lives on its own line");
    assert.ok(
      lines.includes("crabby task watch tsk_sent"),
      "the watch command lives whole on its own line",
    );
    await run.finish();
  });

  it("a keyboard's CRLF Enter is one press, not a send plus a stray newline", async () => {
    const run = harness();
    await run.ready();
    // Some keyboards deliver Enter as `\r\n` in one chunk. The `\r` sends; the `\n` is the same press's tail —
    // without the guard it lands as Ctrl+J in the composer the send just emptied, and the next draft starts life
    // with a blank first line that shows up as a broken-looking composer and a token estimate for a line of nothing.
    run.stdin.type("hello\r\n");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(run.created.length, 1);
    run.stdin.type("next");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      run.created.length,
      1,
      "the guard must not have turned the CRLF into a second send",
    );
    const lines = plain(run.out()).split(/[\r\n]/);
    assert.ok(
      lines.some((line) => line.includes("❯ next")),
      `the composer shows the draft once, with no leading blank line: ${lines.filter((l) => l.includes("❯")).join(" | ")}`,
    );
    await run.finish();
  });

  it("Enter on an empty composer says so instead of reading as a hang (T3-03)", async () => {
    const run = harness();
    await run.ready();
    run.stdin.type("\r");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(run.created.length, 0, "nothing was typed, nothing was sent");
    assert.match(plain(run.out()), /nothing to send yet/);
    await run.finish();
  });

  it("Ctrl-J inserts a newline instead of sending", async () => {
    const run = harness();
    await run.ready();
    run.stdin.type("first");
    run.stdin.type("\n");
    run.stdin.type("second");
    run.stdin.type("\r");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(run.created.length, 1);
    assert.equal(run.created[0]?.objective, "first\nsecond", "D-061's asymmetry, end to end");
    await run.finish();
  });

  it("Ctrl-C cancels the running task and does not quit", async () => {
    const run = harness({
      tasks: [{ id: "tsk_running", state: "running", objective: "x", model: "local/q" }],
    });
    await run.ready();
    run.stdin.type("\u0003");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(
      run.cancelled,
      ["tsk_running"],
      "cancel goes through the route, not through a local flag",
    );
    assert.equal(run.stdin.paused, false, "the app is still running");
    await run.finish();
  });

  it("Tab switches panes and 1-6 jump", async () => {
    const run = harness();
    await run.ready();
    run.stdin.type("\t");
    await new Promise((resolve) => setImmediate(resolve));
    // 40 columns abbreviates the row to three characters (T1-02, asserted by the first test in this file), so the cursor
    // is read off the abbreviated row: `>tas` is tasks selected, `>cha` is chat again.
    assert.match(plain(run.out()), />tas /, "Tab cycles forward from chat");
    run.stdin.type("1");
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(plain(run.out()), />cha /, "and a number jumps");
    await run.finish();
  });

  it("`s` opens the session switcher, Enter switches, `t` renames through PATCH (T16)", async () => {
    const run = harness({
      sessions: [
        { id: "ses_a", titleShown: "first conversation", stateWord: "idle", revision: 2 },
        { id: "ses_b", titleShown: "second conversation", stateWord: "running", revision: 5 },
      ],
    });
    await run.ready();
    run.stdin.type("\t"); // to tasks, where `s` is the switcher and not a literal (T16-01)
    await new Promise((resolve) => setImmediate(resolve));
    run.stdin.type("s");
    // The overlay draws open, then the list read lands and draws again — the same two-frame pattern the tasks poll has.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.match(
      plain(run.out()),
      /Enter switch/,
      "the overlay is up, with its own hint line (T16-04)",
    );
    assert.match(
      plain(run.out()),
      /ses_a/,
      "and the highlighted session's id is on its own line (T16-08)",
    );
    run.stdin.type("j"); // down to the running one
    run.stdin.type("\r"); // switch
    await new Promise((resolve) => setTimeout(resolve, 50));
    run.stdin.type("1"); // to chat, where the switch note went
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(
      plain(run.out()),
      /session ses_b/,
      "the composer now points at the switched conversation",
    );
    assert.match(
      plain(run.out()),
      /now in second conversation/,
      "T16-07: switching away from a running task says so, in words (clipped at 40 columns)",
    );
    run.stdin.type("\t"); // tasks
    run.stdin.type("s"); // overlay again
    await new Promise((resolve) => setTimeout(resolve, 50));
    run.stdin.type("t"); // rename the highlighted row
    await new Promise((resolve) => setImmediate(resolve));
    run.stdin.type("renamed");
    run.stdin.type("\r");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(
      run.patched,
      [{ id: "ses_b", title: "renamed", ifMatch: 5 }],
      "T16-05: one write path, carrying the row's revision as If-Match",
    );
    await run.finish();
  });

  it("a send while a task runs queues, `q` lists it, `d` drops it (T5-08)", async () => {
    const run = harness({
      tasks: [{ id: "tsk_running", state: "running", objective: "x", model: "local/q" }],
    });
    await run.ready();
    run.stdin.type("summarise this later");
    run.stdin.type("\r");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(run.created.length, 0, "a send during a run does not start a second task");
    // 40 columns clips the message before its last word, so the clause is what the assertion reads.
    assert.match(plain(run.out()), /queued — it sends when the run/, run.out());
    run.stdin.type("q"); // the queue list, because the chat hint says `q queue` now
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(
      plain(run.out()),
      /q queue/,
      "T3-04: the strip is the authority, so it changed first",
    );
    assert.match(
      plain(run.out()),
      /summarise this later/,
      "the queued words are the list's content",
    );
    run.stdin.type("d");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.match(plain(run.out()), /dropped: summarise this later/);
    await run.finish();
  });

  it("/model sets this turn's pin with D-045's delta named, and the send carries it (T5-05)", async () => {
    const run = harness({
      config: {
        provider: {
          local: {
            baseUrl: "http://127.0.0.1:9",
            models: {
              "q/tools": {
                contextWindow: 4096,
                maxOutputTokens: 512,
                supports: { streaming: true, toolCalling: true },
                cancellation: "best-effort",
                rateLimits: null,
                cost: "local",
                batching: null,
              },
              "q/plain": {
                contextWindow: 4096,
                maxOutputTokens: 512,
                supports: { streaming: true, toolCalling: false },
                cancellation: "best-effort",
                rateLimits: null,
                cost: "local",
                batching: null,
              },
            },
          },
        },
      },
    });
    await run.ready();
    // Typing the command draws the menu (T5-03); Enter runs it and names D-045's delta.
    run.stdin.type("/model local/q/plain");
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(plain(run.out()), /pick the model/, "the menu is up as typed");
    run.stdin.type("\r");
    await new Promise((resolve) => setTimeout(resolve, 30));
    // 40 columns clips the message mid-clause, so the assertion reads the clause that survives (the extras rule again).
    assert.match(
      plain(run.out()),
      /would use a model without/,
      "D-045's delta, named before the turn is spent",
    );
    // The next draft carries the override as a visible fact until the send spends it.
    run.stdin.type("hello there");
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(
      plain(run.out()),
      /this turn on local\/q\/plain/,
      "the override is a visible draft fact",
    );
    run.stdin.type("\r");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(run.created.length, 1);
    assert.equal(run.created[0]?.model, "local/q/plain", "the pin rides the create call");
    // At 40 the confirmation clips after the model — the id and the pin fact are what survives, which is the row's own
    // claim (T5-05: the warning and the one-turn draft fact; the mortality is the draft line's words).
    assert.match(plain(run.out()), /sent as task tsk_sent — this turn on/, run.out());
    await run.finish();
  });

  it("/attach checks the §8 path rules and rides the next send as text (T5-04)", async () => {
    // A short root on purpose: at 40 columns a mkdtemp path clips before `notes.txt` ends, and the assertion would be
    // reading the frame's ellipsis instead of the fact. `/tmp/crabby-ws-<pid>/notes.txt` fits the design case whole.
    const root = path.join(tmpdir(), `ws${String(process.pid)}`);
    mkdirSync(root, { recursive: true });
    const run = harness({
      config: { workspace: { roots: [root] } },
    });
    await run.ready();
    // A path inside the configured root is accepted, as text.
    run.stdin.type(`/attach ${path.join(root, "notes.txt")}`);
    run.stdin.type("\r");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.match(plain(run.out()), /attached .*notes\.txt/, run.out());
    // One on the deny-list is refused, root or no root — §8's deny applies to read as well as write.
    run.stdin.type("/attach ~/.ssh/id.pem");
    run.stdin.type("\r");
    await new Promise((resolve) => setTimeout(resolve, 30));
    // 40 columns clips the refusal mid-sentence; the quoted path is what survives, and the expanded `~` is what the
    // check judged — a literal directory named `~` inside the root would have been accepted, which is the bug this
    // assertion would have worn otherwise.
    assert.match(
      plain(run.out()),
      /refused: '[^']*\.ssh\/id\.pem'/,
      "the §8 deny-list is the second gate",
    );
    // The send carries the attachment as marked text, and nothing rides the next one.
    run.stdin.type("read the notes");
    run.stdin.type("\r");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(run.created.length, 1);
    assert.match(run.created[0]?.objective ?? "", /\[attached files: .*notes\.txt\]/);
    assert.match(plain(run.out()), /attached: .*notes\.txt/, "the draft shows what will ride");
    await run.finish();
  });

  it("`t` opens the tools view in the models pane, sorted dangerous-first (T12)", async () => {
    const run = harness();
    await run.ready();
    // Tab leaves chat first: in chat the composer owns every printable key (T3-04), so `6` is a literal there.
    run.stdin.type("\t6"); // to models
    await new Promise((resolve) => setImmediate(resolve));
    run.stdin.type("t");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const text = plain(run.out());
    assert.match(text, /tools — 2 · registry d1g3st/, text);
    // Dangerous first: T3 sorts above T0.
    const shellAt = text.indexOf("T3 shell.run");
    const fsAt = text.indexOf("T0 fs.read");
    assert.ok(shellAt >= 0 && fsAt > shellAt, `T3 should sort first: ${text}`);
    // The escalation rule travels with the selection.
    assert.match(text, /every call asks/, text);
    // Enter expands the schema; a second press folds it.
    run.stdin.type("\r");
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(plain(run.out()), /"command"/, "the schema page draws");
    run.stdin.type("\r");
    await new Promise((resolve) => setImmediate(resolve));
    run.stdin.type("\u001b"); // back to the models list
    await new Promise((resolve) => setImmediate(resolve));
    // The tools view swallows every key (no quit inside it), so a `q` that lands proves the pane is models again.
    run.stdin.type("q");
    const code = await Promise.race([
      run.code,
      new Promise<number>((resolve) => setTimeout(() => resolve(-1), 2000)),
    ]);
    assert.equal(code, 0, "Esc left the tools view — q quits the app again");
  });

  it("`v` walks to the access view: r prints first, r again revokes (T14)", async () => {
    const run = harness();
    await run.ready();
    run.stdin.type("\t5"); // out of chat (T3-04), then to logs
    await new Promise((resolve) => setImmediate(resolve));
    run.stdin.type("v"); // log → audit
    run.stdin.type("v"); // → decisions
    run.stdin.type("v"); // → clients
    await new Promise((resolve) => setTimeout(resolve, 50));
    const text = plain(run.out());
    assert.match(text, /bind 127\.0\.0\.1:8734 · loopback only/, text);
    assert.match(text, /pixel 8a \(cli\) · connected · 2 streams/, text);
    assert.match(text, /T14-04/, "the carried gaps are named in the view");
    run.stdin.type("r"); // first press: the print
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(plain(run.out()), /2 streams end/, "the count prints before the act");
    assert.deepEqual(run.revoked, [], "nothing is revoked on the first press");
    run.stdin.type("r"); // second press: the act
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(run.revoked, ["cli_1"]);
    assert.match(plain(run.out()), /revoked cli_1/, run.out());
    await run.finish();
  });

  it("the composer drives the real cursor, and ↑ walks the session's inputs (T5-02 + T5-09)", async () => {
    const run = harness();
    await run.ready();
    run.stdin.type("omega");
    await new Promise((resolve) => setImmediate(resolve));
    const raw = run.out();
    // T5-02: with a TTY the block glyph is gone and the terminal's own cursor is placed and shown.
    assert.doesNotMatch(raw, /\u258f/, "no drawn block on the primary platform");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the escape sequences under test
    assert.match(raw, /\u001b\[\?25h/, "the real cursor is shown");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the escape sequences under test
    assert.match(raw, /\u001b\[\d+G/, "placed at a column, absolutely within the row");
    run.stdin.type("\r");
    await new Promise((resolve) => setTimeout(resolve, 60));
    run.stdin.type("zeta");
    await new Promise((resolve) => setTimeout(resolve, 60));
    run.stdin.type("\r");
    await new Promise((resolve) => setTimeout(resolve, 60));
    // T5-09: the walk. ↑ once recalls the newest input; ↑ again walks to the one before it.
    run.stdin.type("\u001b[A");
    await new Promise((resolve) => setImmediate(resolve));
    const withZeta = plain(run.out()).match(/zeta/g)?.length ?? 0;
    assert.ok(withZeta >= 2, "the newest input is recalled into the composer");
    run.stdin.type("\u001b[A");
    await new Promise((resolve) => setImmediate(resolve));
    const withOmega = plain(run.out()).match(/omega/g)?.length ?? 0;
    assert.ok(withOmega >= 2, "the walk continues to the input before it");
    const draftsBeforeWalk = (plain(run.out()).match(/the draft is/g) ?? []).length;
    run.stdin.type("\u001b[B\u001b[B"); // ↓ to the newest, ↓ again steps out to the empty buffer
    await new Promise((resolve) => setImmediate(resolve));
    // An empty buffer draws no draft line. The two ↓ wrote exactly one fresh "the draft is" — the intermediate stop on
    // the newest input — and the exit past it wrote none, which is the empty buffer the walk started from.
    const draftsAfterWalk = (plain(run.out()).match(/the draft is/g) ?? []).length;
    assert.equal(draftsAfterWalk, draftsBeforeWalk + 1, "the walk exits to the empty buffer");
    await run.finish();
  });

  it("warns before the send when the next turn exceeds the window, with the two fixes (T8-08)", async () => {
    const run = harness({
      // The refresh reads the switcher's session when no frame has named one yet.
      sessions: [{ id: "s_1", titleShown: "main", stateWord: "active", revision: 1 }],
    });
    await run.ready();
    run.stdin.type("warm up");
    await new Promise((resolve) => setImmediate(resolve));
    run.stdin.type("\r");
    await new Promise((resolve) => setTimeout(resolve, 80)); // the send resolves, the context refresh runs
    // 900 projected + 125 for this draft = 1,025 of the fake's 1,000-token window: over.
    run.stdin.type("x".repeat(500));
    await new Promise((resolve) => setImmediate(resolve));
    const text = plain(run.out());
    assert.match(text, /next turn may not fit: ~1,025 of 1,000/, text);
    assert.match(text, /fixes: \/compact now · \/model wider/, text);
    await run.finish();
  });

  it("quitting with a task running asks once, in words, then quits (T1-08)", async () => {
    const run = harness({
      tasks: [{ id: "tsk_running", state: "running", objective: "x", model: "local/q" }],
    });
    await run.ready();
    run.stdin.type("q"); // first press: the words
    await new Promise((resolve) => setImmediate(resolve));
    const text = plain(run.out());
    assert.match(text, /the task survives — q again to quit/, text);
    assert.equal(run.codeSettled(), false, "the first q does not quit");
    run.stdin.type("q"); // second press: the quit
    const code = await Promise.race([
      run.code,
      new Promise<number>((resolve) => setTimeout(() => resolve(-1), 2000)),
    ]);
    assert.equal(code, 0, "the second q quits");
  });

  it("Ctrl-Q quits an idle app at once, and Ctrl-Z suspends through the injected hook (T1-08)", async () => {
    let suspended = 0;
    const run = harness({
      suspend: () => {
        suspended += 1;
      },
    });
    await run.ready();
    run.stdin.type("\u001a"); // Ctrl-Z (0x1A, the C0 the shell's suspend maps to)
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(suspended, 1, "the injected suspend ran");
    assert.match(
      plain(run.out()),
      /suspended — the run keeps going on the gateway/,
      "the scrollback says what the suspend means",
    );
    run.stdin.type("\u0011"); // Ctrl-Q, no task running: quits at once
    const code = await Promise.race([
      run.code,
      new Promise<number>((resolve) => setTimeout(() => resolve(-1), 2000)),
    ]);
    assert.equal(code, 0, "Ctrl-Q quits an idle app without a confirmation");
  });

  it("the tasks pane filters on f, one field at a time (T6-01)", async () => {
    const run = harness({
      tasks: [
        {
          id: "tsk_run",
          state: "running",
          objective: "the running ask",
          sessionId: "s_1",
          model: "local/q",
        },
        {
          id: "tsk_done",
          state: "completed",
          objective: "the finished ask",
          sessionId: "s_2",
          model: "local/q",
        },
      ],
    });
    await run.ready();
    run.stdin.type("\t2"); // out of chat, to tasks
    await new Promise((resolve) => setImmediate(resolve));
    run.stdin.type("f"); // edit mode, state field
    await new Promise((resolve) => setImmediate(resolve));
    const doneBefore = (plain(run.out()).match(/the finished ask/g) ?? []).length;
    run.stdin.type("run");
    await new Promise((resolve) => setImmediate(resolve));
    const text = plain(run.out());
    assert.match(text, /filter \[state: run▏\] · session: —/, text);
    assert.match(text, /the running ask/, text);
    // The accumulated buffer keeps the pre-filter frames, so "filtered out" means: the narrowing wrote no new card for
    // the completed task — the count of its objective is exactly what it was before the filter bit.
    assert.equal(
      (plain(run.out()).match(/the finished ask/g) ?? []).length,
      doneBefore,
      "the completed task is filtered out",
    );
    run.stdin.type("f"); // toggle to the session field
    await new Promise((resolve) => setImmediate(resolve));
    run.stdin.type("s_9");
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(plain(run.out()), /no tasks match — Esc clears the filter/);
    run.stdin.type("\u001b"); // Esc clears
    await new Promise((resolve) => setImmediate(resolve));
    const after = plain(run.out());
    assert.match(after, /filter cleared/, after);
    assert.match(after, /the finished ask/, "both tasks are back");
    await run.finish();
  });

  it("`q` quits, and a gateway that is not there never blocks that", async () => {
    const run = harness();
    await run.ready();
    run.stdin.type("q");
    const code = await Promise.race([
      run.code,
      new Promise<number>((resolve) => setTimeout(() => resolve(-1), 2000)),
    ]);
    assert.equal(code, 0, "a TUI that will not quit is a TUI nobody can get out of");
  });

  it("says what it cannot do rather than pretending: a Gateway that is not there names the command that starts one", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "crabby-tui-bare-"));
    mkdirSync(dataLayout(dir).stateDir, { recursive: true, mode: 0o700 });
    const out: string[] = [];
    const stdout = {
      columns: 40,
      rows: 24,
      isTTY: true,
      write: (text: string) => {
        out.push(text);
        return true;
      },
    } as unknown as NodeJS.WriteStream;
    const stdin = new FakeStdin();
    const code = runTui({
      dataDir: dir,
      columns: 40,
      rows: 24,
      env: { TERM: "xterm-256color" },
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout,
      now: () => 0,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(plain(out.join("")), /crabby gateway start/);
    stdin.end();
    assert.equal(await code, 0);
  });
});
