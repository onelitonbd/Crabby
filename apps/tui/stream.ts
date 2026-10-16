// The TUI's one stream: `GET /api/v1/events`, and the two things it has to do that a buffered client cannot.
//
// **Why a raw fetch rather than `GatewayClient`.** Every method on that client is buffered by design — one request, one
// document — and a streaming member would mean two lifecycles behind one interface. The same reasoning is written out in
// `apps/cli/commands/task.ts`, which is where the CLI's first stream was; this file is the TUI's version, and it says so
// rather than inventing a new reason.
//
// **Two obligations, both about a stream on a phone.** The first is a **reconnect**: Termux backgrounds an app when the
// person switches away, the socket dies, and `GET /events` does not resume itself. §5.4's `gap` frame and T4-13's
// reconciliation are the answer — the gap is a *fact to report*, and the truth afterwards comes from `GET /tasks/{id}`
// rather than from replayed events. The second is a **stop**: the reader has to be cancellable, or a pane switch leaves a
// socket open reading into a pane nobody is looking at, which on a phone is battery and on a Gateway is a connection.
//
// **The frames are the envelope's own**, handed to `transcript.ts` as they arrive. The TUI does not parse, classify or
// reorder them: a second interpretation of the event vocabulary in a client is a second opinion about what a run did, and
// the pane's job is to draw them.

import { readCredentials } from "@crabby/gateway";
import type { DataLayout } from "@crabby/platform";
import type { EventFrame } from "./transcript.ts";

export interface StreamHandle {
  /** Stop reading. Idempotent, and it is the caller's job on a pane switch — a reader nobody cancels is a socket nobody
   *  closes. */
  close(): void;
}

export interface StreamOptions {
  readonly url: string;
  readonly layout: DataLayout;
  /** One frame at a time, already parsed. The consumer is `applyEvent`, which is pure, so nothing here decides anything. */
  readonly onFrame: (frame: EventFrame) => void;
  /** Called once when the socket ends for any reason, with the reason in words — T1-10's rule, and the reason a pane shows
   *  a stale list instead of an empty one. */
  readonly onClosed?: (reason: string) => void;
  /** Reconnect attempts after the first close. One by default: a phone that has lost its network should not be hammering a
   *  loopback address, and a person who walked out of range will be back or will not. */
  readonly reconnects?: number;
  readonly signal?: AbortSignal | undefined;
}

/** The event families the chat pane draws. **The terminal families are included on purpose**: T4-07 asks for a tool line, and
 *  a tool call is announced by `tool.started`/`tool.finished` rather than by a message — a transcript built from
 *  `message.added` alone would show the model's words and none of the work. */
export const CHAT_TYPES = [
  "message.added",
  "message.compacted",
  "memory.injected",
  "provider.switch.proposed",
  "tool.started",
  "tool.finished",
  "task.completed",
  "task.failed",
  "task.cancelled",
  "task.interrupted",
  "approval.requested",
] as const;

/** Synchronous on purpose: it opens a connection and hands back the handle, and the caller keeps drawing frames as they
 *  arrive. An `async` return would make every pane's "open the stream" a line of `await` before anything could be drawn, for a
 *  socket that is still connecting in the background — which is exactly the blank-terminal shape T1-09 refuses. */
export function followEvents(options: StreamOptions): StreamHandle {
  const controller = new AbortController();
  const attempts = (options.reconnects ?? 1) + 1;
  let closed = false;

  const run = async (): Promise<void> => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (closed) return;
      const credentials = readCredentials(options.layout);
      if (credentials === undefined) {
        options.onClosed?.("no credentials — pair this terminal with `crabby auth pair`");
        return;
      }
      const query = new URLSearchParams({ types: CHAT_TYPES.join(",") });
      let response: globalThis.Response;
      try {
        // Two signals, and both are real: the internal one is `close()`, and the caller's is the process being told to stop.
        // Aborting on either is the whole point — a reader nobody cancels is a socket nobody closes, and Termux backgrounds
        // an app the moment the person switches away (D-066's drain on the other end of the same rule).
        const external = options.signal;
        if (external !== undefined)
          external.addEventListener("abort", () => controller.abort(), { once: true });
        response = await fetch(`${options.url}/api/v1/events?${query.toString()}`, {
          headers: {
            authorization: `Bearer ${credentials.token}`,
            accept: "text/event-stream",
          },
          signal: controller.signal,
        });
      } catch (error) {
        options.onClosed?.(
          `the gateway could not be reached (${error instanceof Error ? error.message : String(error)})`,
        );
        continue;
      }
      if (!response.ok || response.body === null) {
        options.onClosed?.(`the gateway answered ${response.status} to the event stream`);
        continue;
      }
      const stopped = await read(response.body, options.onFrame);
      if (closed) return;
      options.onClosed?.(stopped);
      if (stopped !== "the stream closed") continue;
      return;
    }
    options.onClosed?.("the event stream is not available");
  };

  void run();
  return {
    close(): void {
      closed = true;
      controller.abort();
    },
  };
}

/** One connection's frames. The separator logic is the same as the CLI's `task watch` reader and for the same reason: a
 *  chunk boundary can fall inside a frame, so the buffer is consumed only up to the last complete separator — dropping the
 *  tail would lose an event and parsing early would invent one. */
async function read(
  body: ReadableStream<Uint8Array>,
  onFrame: (frame: EventFrame) => void,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return "the stream closed";
    buffer += decoder.decode(chunk.value, { stream: true });
    for (;;) {
      const separator = buffer.indexOf("\n\n");
      if (separator === -1) break;
      const frame = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      const parsed = parseFrame(frame);
      if (parsed !== undefined) onFrame(parsed);
    }
  }
}

/** One SSE frame into an `EventFrame`. A frame with no `data:` line is a keep-alive or a comment, and a frame whose JSON does
 *  not parse is **dropped with its text** rather than guessed at: a malformed frame in a transcript is a missing line, and a
 *  guessed line is a lie about what a run said. */
export function parseFrame(raw: string): EventFrame | undefined {
  const data: string[] = [];
  let type: string | undefined;
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) type = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trim());
  }
  if (data.length === 0) return undefined;
  try {
    const parsed = JSON.parse(data.join("\n")) as Record<string, unknown>;
    return {
      type: type ?? (typeof parsed.type === "string" ? parsed.type : "unknown"),
      ...(typeof parsed.seq === "number" ? { seq: parsed.seq } : {}),
      ...(typeof parsed.payload === "object" && parsed.payload !== null
        ? { payload: parsed.payload as Record<string, unknown> }
        : {}),
    };
  } catch {
    return undefined;
  }
}
