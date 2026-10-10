// `GET /events` as SSE over `reply.hijack()` — D-069's chosen mechanism, and §5.1's four requirements written as code:
// heartbeat comments on a fixed interval, buffering disabled for proxies, a stream that can never block a task, and
// an explicit gap when a reconnect lands outside the replay window (§5.4's `stateAt`, verbatim).
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

export interface StreamState {
  closed: boolean;
  timer?: ReturnType<typeof setInterval>;
}

export function openStream(
  reply: FastifyReply,
  state: StreamState,
): { write(raw: string): void; close(): void } {
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
    close() {
      if (state.closed) return;
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
