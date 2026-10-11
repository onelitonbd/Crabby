// `GET /events` as SSE over `reply.hijack()` — D-069's chosen mechanism, and §5.1's four requirements written as code:
// heartbeat comments on a fixed interval, buffering disabled for proxies, a stream that can never block a task, and
// an explicit gap when a reconnect lands outside the replay window (§5.4's `stateAt`, verbatim).
//
// The two named frames at the bottom of this file are the whole of the channel's control vocabulary, and they are named
// rather than silent because both describe something a client must not treat as a network blip: `gap` says "what you
// missed is not recoverable here, go ask `GET /tasks/{id}`", and `end` says "this stream was closed on purpose, by the
// Gateway, for a reason that will still be true when you reconnect". The second one is what makes `SECURITY.md` §3.1's
// "revocation … must also terminate live event streams" a control a client can obey rather than an outage it retries
// through (D-096).
import { type Event, SCHEMA_VERSION } from "@crabby/api-contracts";
import type { FastifyReply } from "fastify";

export const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store, no-transform",
  connection: "keep-alive",
  // §5.1: "SSE responses must disable proxy buffering (`X-Accel-Buffering: no`) and stay correct behind a Cloudflare
  // tunnel." A tunnel is exactly the proxy that would otherwise hold the stream until it ends.
  "x-accel-buffering": "no",
} as const;

/** §5.1 asks for a heartbeat on a fixed interval and prices none. 15 s is under D-074's 45 s idle-stream timeout, so
 *  an idle connection is demonstrably alive rather than merely quiet, and it is a value a client may rely on. */
export const HEARTBEAT_MS = 15_000;

/** Why the Gateway ended a stream it did not have to. `revoked` is `SECURITY.md` §3.1's control — the identity that
 *  opened this stream no longer exists, so the next request will be refused and a reconnect is not a recovery;
 *  `shutdown` is D-066's drain, where the same advice applies until the process comes back. Both are delivered in an
 *  `end` frame before the socket closes, because the alternative — silence — is what a client is *designed* to
 *  reconnect through. */
export const STREAM_END_REASONS = ["revoked", "shutdown"] as const;
export type StreamEndReason = (typeof STREAM_END_REASONS)[number];

export interface StreamState {
  closed: boolean;
  timer?: ReturnType<typeof setInterval>;
}

export function openStream(
  reply: FastifyReply,
  state: StreamState,
): { write(raw: string): void; close(reason?: StreamEndReason): void } {
  const response = reply.raw;
  response.writeHead(200, SSE_HEADERS);
  // `writeHead` only queues the status line, so without this the client's first byte is its first event and a
  // `fetch()` on the other end sits in `await` — indistinguishable from a hung server. `flushHeaders` is how a stream
  // says "I am open" before it has anything to say.
  response.flushHeaders();
  reply.hijack();
  // Frames go to the `ServerResponse`, never to `response.socket`. The difference is not cosmetic: a hijacked reply
  // still has chunked transfer-encoding negotiated, and `socket.write` bypasses the encoder, so the client's parser
  // reads a frame's text where a chunk size belongs — undici calls it `HPE_INVALID_CHUNK_SIZE` and drops the stream.
  // Writing through `response` keeps the framing honest, which is also what makes the same bytes survive a proxy.
  const write = (raw: string): void => {
    if (state.closed || response.writableEnded || response.destroyed) return;
    response.write(raw);
  };
  return {
    write,
    close(reason?: StreamEndReason) {
      if (state.closed) return;
      // The frame goes out *before* the socket ends, while `write` still accepts it: a close that says nothing is a
      // stream that stopped, and a client's entire §5.4 machinery for "a stream that stopped" is a reconnect.
      if (reason !== undefined) write(endFrame(reason));
      state.closed = true;
      if (state.timer) clearInterval(state.timer);
      if (!response.writableEnded && !response.destroyed) response.end();
    },
  };
}

/** The frame. `id` is what `Last-Event-ID` comes back as, and it is the event id rather than the `seq` because a
 *  client that reconnects for a *task* needs the task's seq, which the envelope carries anyway. */
export function frame(event: Event): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function comment(text: string): string {
  return `: ${text}\n\n`;
}

/** §5.4's outside-the-window response. The event id doubles as the cursor, so the marker is delivered as a named
 *  SSE event: a client that understands only the data field still sees `gap` in the event name, and one that parses
 *  the JSON gets `stateAt` to reconcile from. */
export function gapFrame(taskId: string): string {
  const payload = { gap: true, stateAt: taskId, schemaVersion: SCHEMA_VERSION };
  return `event: gap\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** §5.4's second control frame: the stream's own last words. No `id:` line, because neither frame is an event and
 *  neither is replayable — a `Last-Event-ID` pointing at a control frame would be a cursor into a stream that has
 *  already told the client to stop coming back. */
export function endFrame(reason: StreamEndReason): string {
  const payload = {
    end: true,
    reason,
    at: new Date().toISOString(),
    schemaVersion: SCHEMA_VERSION,
  };
  return `event: end\ndata: ${JSON.stringify(payload)}\n\n`;
}
