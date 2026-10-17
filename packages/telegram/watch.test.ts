// Region G4's rendering and G4's stream, without a live SSE: the progress line's measured-vs-estimated rule (G4-04),
// the terminal message's shape (G4-03), the 30s silence label (G4-07), the 3800-char final-answer cut (G4-05), the
// dark-period line (G-T02), and the SSE reader's reconnection grammar — Last-Event-ID out, gap honored, 1.5s back.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  darkPeriodLine,
  finalAnswerText,
  followTask,
  nextProgressView,
  progressLine,
  type TaskFrame,
} from "./watch.ts";

describe("progressLine (G4-04) — ≤2 lines, measured says measured, estimated says estimate", () => {
  it("assembles state, step, elapsed, tool, tokens", () => {
    const line = progressLine({
      state: "running",
      step: { index: 2, total: 5 },
      elapsedSeconds: 34,
      lastTool: "fs.write",
      tokens: { count: 4_200, source: "measured" },
    });
    assert.match(line, /state: running/);
    assert.match(line, /step 2\/5/);
    assert.match(line, /34s/);
    assert.match(line, /last tool: fs\.write/);
    assert.match(line, /4200 tokens \(measured\)/);
    assert.equal(line.split("\n").length, 1);
  });

  it("an estimated count carries the tilde and the word — a guess that reads like a measurement is a lie", () => {
    const line = progressLine({ state: "running", tokens: { count: 900, source: "estimated" } });
    assert.match(line, /~900 tokens \(estimate\)/);
  });

  it("absent facts are absent, not zeroed", () => {
    const line = progressLine({ state: "running" });
    assert.doesNotMatch(line, /step|tool|tokens|s$/);
  });
});

describe("nextProgressView (G4-02/G4-03/G4-07)", () => {
  it("a terminal frame becomes its own message, exactly once, with the outcome word", () => {
    const view = nextProgressView(
      [
        { type: "tool.started", payload: { name: "fs.write" } },
        { type: "task.completed", payload: { summary: "done well" } },
      ],
      0,
      5,
    );
    assert.match(view.text, /^task completed — done well/);
    assert.equal(view.terminal?.state, "completed");
  });

  it("a cancelled frame does not dress up as completed", () => {
    const view = nextProgressView([{ type: "task.cancelled", payload: {} }], 0, 5);
    assert.equal(view.terminal?.state, "cancelled");
    assert.match(view.text, /^task cancelled/);
  });

  it("silence past 30s is labeled, not invented around (G4-07)", () => {
    const quiet = nextProgressView([], 100, 135);
    assert.match(quiet.text, /no output for 35s/);
    const fresh = nextProgressView([], 100, 110);
    assert.equal(fresh.text, "running…");
  });

  it("an approval frame says where to look — the card comes from the push, not the progress line", () => {
    const view = nextProgressView([{ type: "approval.requested", payload: {} }], 0, 5);
    assert.match(view.text, /waiting for an approval — \/approvals shows it/);
  });

  it("an assistant message previews the thought, cut at 80 chars", () => {
    const view = nextProgressView(
      [{ type: "message.added", payload: { role: "assistant", content: "x".repeat(200) } }],
      0,
      5,
    );
    assert.match(view.text, /working: x{80}/);
  });
});

describe("finalAnswerText (G4-05) and darkPeriodLine (G-T02)", () => {
  it("the final answer goes whole under the cut, labeled above it", () => {
    assert.equal(finalAnswerText("the answer is 4", undefined), "the answer is 4");
    const long = finalAnswerText("y".repeat(5_000), "the file holds the rest");
    assert.ok(long.length < 4_000);
    assert.match(long, /the file holds the rest/);
    const unlabeled = finalAnswerText("z".repeat(5_000), undefined);
    assert.match(unlabeled, /1200 chars of the answer/);
  });

  it("the dark-period line names the outage and the order, never the task's death", () => {
    assert.match(darkPeriodLine(47.6), /unreachable for 47s/);
    assert.match(darkPeriodLine(47.6), /queued outputs follow in order/);
    assert.match(darkPeriodLine(47.6), /never stopped/);
  });
});

describe("followTask — the SSE grammar, over a scripted fetch", () => {
  function sseServer(config: { chunks: string[]; status?: number }) {
    const requests: { headers: Record<string, string>; url: string }[] = [];
    const encoder = new TextEncoder();
    let index = 0;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      requests.push({ headers: (init?.headers ?? {}) as Record<string, string>, url: String(url) });
      const chunk = config.chunks[index];
      index += 1;
      const status = config.status ?? (chunk === undefined ? 503 : 200);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (chunk !== undefined) controller.enqueue(encoder.encode(chunk));
          else controller.error(new Error("connection dropped"));
          // A stream between messages stays open; the abort is what ends it, like a real one.
          init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")), {
            once: true,
          });
        },
      });
      return { ok: status < 400, status, body: status < 400 ? body : null };
    }) as typeof fetch;
    return { fetchImpl, requests };
  }

  it("parses SSE blocks into frames, keeps id, and flags a gap frame", async () => {
    const server = sseServer({
      chunks: [
        'event: tool.started\ndata: {"name":"fs.write"}\nid: 41\n\n' +
          "event: gap\ndata: {}\n\n" +
          'event: task.completed\ndata: {"summary":"done"}\nid: 44\n\n',
      ],
    });
    const controller = new AbortController();
    const frames: TaskFrame[] = [];
    const running = followTask({
      taskId: "tsk_1",
      url: "http://127.0.0.1:5000",
      token: "tok",
      lastEventId: "40",
      fetchImpl: server.fetchImpl,
      onFrame: (frame) => {
        frames.push(frame);
        if (frame.type === "task.completed") controller.abort();
      },
      onOpen: () => {},
      onDown: () => {},
      signal: controller.signal,
    });
    await running;
    assert.equal(frames[0]?.type, "tool.started");
    assert.equal(frames[0]?.id, "41");
    assert.equal(
      frames[1]?.type,
      "gap",
      "the gap frame reaches the bot, which replays via the events route",
    );
    assert.equal(frames[2]?.type, "task.completed");
    assert.match(server.requests[0]?.url ?? "", /taskId=tsk_1/);
    assert.match(server.requests[0]?.url ?? "", /types=/);
    assert.equal(
      server.requests[0]?.headers["last-event-id"],
      "40",
      "the reconnect resumes where the chat left off",
    );
    assert.match(server.requests[0]?.headers.authorization ?? "", /^Bearer tok$/);
  });

  it("a dead stream reconnects after the 1.5s pause (the task never stopped because a stream did)", async () => {
    const server = sseServer({ chunks: [], status: 503 });
    const controller = new AbortController();
    let downs = 0;
    const running = followTask({
      taskId: "tsk_1",
      url: "http://127.0.0.1:5000",
      token: "tok",
      lastEventId: undefined,
      fetchImpl: server.fetchImpl,
      onFrame: () => {},
      onOpen: () => {},
      onDown: () => {
        downs += 1;
        if (downs >= 2) controller.abort();
      },
      signal: controller.signal,
    });
    const started = Date.now();
    await running;
    assert.ok(
      Date.now() - started >= 2_500,
      "two downs means two 1.5s waits — the loop does not spin",
    );
    assert.equal(server.requests.length, downs + 1 >= 2 ? downs : downs, "each down is one retry");
  });
});
