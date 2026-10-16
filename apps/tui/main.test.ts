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
import { mkdirSync, mkdtempSync } from "node:fs";
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
  readonly stdin: FakeStdin;
  readonly created: { objective: string; key: string }[];
  readonly cancelled: string[];
  readonly patched: { id: string; title: string | undefined; ifMatch: number }[];
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
    readonly columns?: number;
    readonly rows?: number;
  } = {},
): Run {
  const dir = mkdtempSync(path.join(tmpdir(), "crabby-tui-"));
  const layout = dataLayout(dir);
  mkdirSync(layout.stateDir, { recursive: true, mode: 0o700 });
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
  const created: { objective: string; key: string }[] = [];
  const cancelled: string[] = [];
  const patched: { id: string; title: string | undefined; ifMatch: number }[] = [];
  const tasks = options.tasks ?? [];
  const client: TaskReader = {
    listTasks: async () => ({ ok: true, status: 200, body: { items: tasks } }),
    cancelTask: async (id: string) => {
      cancelled.push(id);
      return { ok: true, status: 202, body: {} };
    },
    createTask: async (body: { readonly objective: string }, key: string) => {
      created.push({ objective: body.objective, key });
      return { ok: true, status: 201, body: { id: "tsk_sent" } };
    },
    // T16's reads and writes, as envelopes like every other fake here.
    sessions: async () => ({ ok: true, status: 200, body: { items: options.sessions ?? [] } }),
    createSession: async () => ({ ok: true, status: 201, body: { session: {}, note: "created" } }),
    patchSession: async (id: string, body: { readonly title?: string }, ifMatch: number) => {
      patched.push({ id, title: body.title, ifMatch });
      return { ok: true, status: 200, body: { session: {}, note: "renamed" } };
    },
    sessionContext: async () => ({ ok: true, status: 200, body: {} }),
    compactSession: async () => ({ ok: true, status: 200, body: { note: "compacted" } }),
    pinMessages: async () => ({ ok: true, status: 200, body: { note: "pinned" } }),
  };
  const code = runTui({
    dataDir: dir,
    columns: options.columns ?? 40,
    rows: options.rows ?? 24,
    env: { TERM: "xterm-256color" },
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout,
    client,
    // `now` is frozen so the repaint cap cannot swallow a frame the test is waiting for; the cap itself is tested in
    // `render.test.ts`, and here it would only make this file flaky.
    now: () => 0,
  });
  return {
    out: () => out.join(""),
    code,
    stdin,
    created,
    cancelled,
    patched,
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
