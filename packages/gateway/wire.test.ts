// The two things the routes lean on but cannot be tested through HTTP from inside this process: the SSE frame shapes (an
// event frame is replayable and carries an `id`; the two control frames are not and must not pretend otherwise), and
// `isLoopback`, which is the whole of §3.1's "local only" and is measured on a socket a test cannot obtain from here.
//
// The reason these are unit-tested instead of integration-tested is honesty about the limit: `trustProxy: false` in
// `app.ts` means `request.ip` is the kernel's answer rather than a header's, so no request this suite can send will ever
// look remote — and a test that forged its way to a `401` would be testing the forge rather than the guard. What is
// asserted here is the predicate and the frames; `tests/integration/gateway.test.ts` asserts the behaviour they produce.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Event } from "@crabby/api-contracts";
import { isLoopback } from "./app.ts";
import { comment, endFrame, frame, gapFrame, SSE_HEADERS } from "./sse.ts";

const event: Event = {
  id: "evt_01abcdefgh0123456789abcdef",
  schemaVersion: 1,
  type: "task.created",
  ts: "2026-10-11T00:00:00.000Z",
  sessionId: "ses_01abcdefgh0123456789abcdef",
  taskId: "tsk_01abcdefgh0123456789abcdef",
  seq: 7,
  payload: { state: "queued" },
};

describe("the SSE frames", () => {
  it("carries the event id, the type, and the whole envelope — in that order", () => {
    const text = frame(event);
    assert.equal(
      text,
      `id: ${event.id}\nevent: task.created\ndata: ${JSON.stringify(event)}\n\n`,
      "a client's `Last-Event-ID` is the id it was given, so the line order is the reconnect contract and not cosmetics",
    );
    assert.match(
      text,
      /\n\n$/,
      "and a frame ends at a blank line, which is what lets a reader find the next one",
    );
  });

  it("names the control frames and gives them no id, because neither is replayable", () => {
    const gap = gapFrame(event.taskId ?? "tsk_none");
    const end = endFrame("revoked");

    assert.ok(
      !gap.startsWith("id:"),
      "a cursor into a stream that told you to go and fetch the truth is a bug",
    );
    assert.ok(!end.startsWith("id:"));
    assert.match(gap, /^event: gap\ndata: /);
    assert.match(end, /^event: end\ndata: /);
    const payload = JSON.parse(end.slice("event: end\ndata: ".length).trim()) as {
      end: boolean;
      reason: string;
      at: string;
      schemaVersion: number;
    };
    assert.deepEqual(
      { end: payload.end, reason: payload.reason, schemaVersion: payload.schemaVersion },
      { end: true, reason: "revoked", schemaVersion: 1 },
      "§3.1's termination has to be legible without parsing prose: `end` plus the reason is all a client needs to decide " +
        "not to reconnect, and anything more in the frame is a second copy of a fact it can already fetch",
    );
    assert.ok(
      !Number.isNaN(Date.parse(payload.at)),
      "the timestamp is there for the log a user reads afterwards, not for a client's decision",
    );
  });

  it("writes heartbeats as comments, so a keep-alive is never mistaken for data", () => {
    assert.equal(comment("ping"), ": ping\n\n");
    assert.equal(
      SSE_HEADERS["x-accel-buffering"],
      "no",
      "§5.1: a proxy that buffers the stream until it ends turns a live tail into a download",
    );
  });
});

describe("the local-only predicate (§3.1's asymmetry)", () => {
  it("recognises the three shapes a loopback socket actually arrives in", () => {
    for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      assert.equal(
        isLoopback(ip),
        true,
        `\`${ip}\` is what this machine's own socket looks like — the IPv4-mapped form is the one Node reports on a ` +
          "dual-stack listener, and a guard that missed it would refuse the owner's own CLI",
      );
    }
  });

  it("refuses the addresses a forwarded header would arrive as, and the ones a LAN hands out", () => {
    for (const ip of [
      "203.0.113.9",
      "10.0.0.5",
      "192.168.1.7",
      "0.0.0.0",
      "127.0.0.2",
      "localhost",
    ]) {
      assert.equal(
        isLoopback(ip),
        false,
        `\`${ip}\` is refused, and \`127.0.0.2\` among them: the range inside \`127/8\` that is not the bound address can ` +
          "only be reached by a client that went looking for it, so failing closed there costs nothing and trusting it " +
          "would make the guard a prefix a caller chooses",
      );
    }
  });
});
