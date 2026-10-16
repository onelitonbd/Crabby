// Region G4 — watching a task from a chat. One progress message per task, edited in place (G4-01); the newest state
// wins while the coalescer holds the edit (G4-02); the terminal outcome is **its own message**, not an edit, so a
// scrollback read of the outcome is reliable (G4-03); silence is labeled, never mistaken for success (G4-07); and
// `/unwatch` stops the edits without touching the task (G4-08). The stream is the Gateway's own SSE (`GET /events`),
// the same frames the TUI follows, reconnected with `Last-Event-ID` and a gap frame honored.
import { truncationLabel } from "./format.ts";

export interface TaskFrame {
  readonly type: string;
  readonly seq?: number | undefined;
  readonly id?: string | undefined;
  readonly payload: Record<string, unknown>;
}

export interface ProgressView {
  readonly text: string;
  readonly terminal:
    | {
        readonly state: "completed" | "failed" | "cancelled" | "interrupted";
        readonly line: string;
      }
    | undefined;
}

/** G4-04: the human line, ≤2 lines, carrying the measured-vs-estimated distinction (W5-02/T6-03's rule). A step count
 *  only exists when the task reported one; an estimate says it is an estimate. */
export function progressLine(input: {
  readonly state: string;
  readonly step?: { readonly index: number; readonly total: number } | undefined;
  readonly elapsedSeconds?: number | undefined;
  readonly lastTool?: string | undefined;
  readonly tokens?:
    | { readonly count: number; readonly source: "measured" | "estimated" }
    | undefined;
}): string {
  const parts = [`state: ${input.state}`];
  if (input.step !== undefined)
    parts.push(`step ${String(input.step.index)}/${String(input.step.total)}`);
  if (input.elapsedSeconds !== undefined) parts.push(`${String(input.elapsedSeconds)}s`);
  if (input.lastTool !== undefined) parts.push(`last tool: ${input.lastTool}`);
  if (input.tokens !== undefined) {
    parts.push(
      input.tokens.source === "measured"
        ? `${String(input.tokens.count)} tokens (measured)`
        : `~${String(input.tokens.count)} tokens (estimate)`,
    );
  }
  return parts.join(" · ");
}

/** The SSE frame → the next progress view. Terminal frames produce their own message (G4-03), so `terminal` is set
 *  exactly once and the watcher sends it as a new message before detaching. */
export function nextProgressView(
  views: readonly TaskFrame[],
  lastSentAtSeconds: number,
  nowSeconds: number,
): ProgressView {
  const terminalFrame = [...views]
    .reverse()
    .find((frame) =>
      ["task.completed", "task.failed", "task.cancelled", "task.interrupted"].includes(frame.type),
    );
  if (terminalFrame !== undefined) {
    const word = terminalFrame.type.replace("task.", "");
    const outcome =
      word === "completed"
        ? "completed"
        : word === "failed"
          ? "failed"
          : word === "cancelled"
            ? "cancelled"
            : "interrupted";
    const summary =
      typeof terminalFrame.payload.summary === "string" ? terminalFrame.payload.summary : "";
    return {
      text: `task ${word}${summary.length > 0 ? ` — ${summary}` : ""}`,
      terminal: {
        state: outcome,
        line: `task ${word}${summary.length > 0 ? ` — ${summary}` : ""}`,
      },
    };
  }
  const toolStarted = [...views].reverse().find((frame) => frame.type === "tool.started");
  const messageAdded = [...views].reverse().find((frame) => frame.type === "message.added");
  const approval = [...views].reverse().find((frame) => frame.type === "approval.requested");
  const pieces: string[] = [];
  if (
    messageAdded !== undefined &&
    typeof messageAdded.payload.content === "string" &&
    messageAdded.payload.role === "assistant"
  ) {
    pieces.push(`working: ${messageAdded.payload.content.slice(0, 80)}`);
  }
  if (toolStarted !== undefined && typeof toolStarted.payload.name === "string") {
    pieces.push(`last tool: ${toolStarted.payload.name} (running)`);
  }
  if (approval !== undefined) pieces.push("waiting for an approval — /approvals shows it");
  const silence = nowSeconds - lastSentAtSeconds;
  if (silence >= 30) {
    // G4-07: "no output for Ns" — the same disclosure as TUI T4-06.
    pieces.push(`no output for ${String(Math.floor(silence))}s`);
  }
  return {
    text: pieces.length > 0 ? pieces.join("\n") : "running…",
    terminal: undefined,
  };
}

/** G4-05's delivery: the final answer is the same content the other interfaces show, through G2's split rules. */
export function finalAnswerText(answer: string, omittedNote: string | undefined): string {
  if (answer.length <= 3_800) return answer;
  const head = answer.slice(0, 3_800);
  return `${head}\n\n${truncationLabel(omittedNote ?? `${String(answer.length - 3_800)} chars of the answer`)}`;
}

/** G-T02: after the dark period, one line says what happened while updates could not arrive. */
export function darkPeriodLine(seconds: number): string {
  return `Telegram was unreachable for ${String(Math.floor(seconds))}s — queued outputs follow in order; the task never stopped`;
}

export interface WatchHandle {
  readonly taskId: string;
  detach(): void;
}

/** The watcher itself: one SSE reader per watched task, frames handed to the sender's coalesced editor. The reader
 *  reconnects with `Last-Event-ID`; a `gap` frame replays the task's events from the Gateway rather than guessing
 *  (`GET /tasks/{id}/events` is the replay window, D-049). */
export async function followTask(input: {
  readonly taskId: string;
  readonly url: string;
  readonly token: string;
  readonly lastEventId: string | undefined;
  readonly fetchImpl: typeof fetch;
  readonly onFrame: (frame: TaskFrame) => void;
  readonly onOpen: () => void;
  readonly onDown: () => void;
  readonly signal: AbortSignal;
}): Promise<void> {
  const types = [
    "message.added",
    "tool.started",
    "tool.finished",
    "approval.requested",
    "task.state.changed",
    "task.completed",
    "task.failed",
    "task.cancelled",
    "task.interrupted",
  ];
  const url = `${input.url}/api/v1/events?taskId=${encodeURIComponent(input.taskId)}&types=${encodeURIComponent(types.join(","))}`;
  for (;;) {
    if (input.signal.aborted) return;
    try {
      const response = await input.fetchImpl(url, {
        headers: {
          authorization: `Bearer ${input.token}`,
          accept: "text/event-stream",
          ...(input.lastEventId === undefined ? {} : { "last-event-id": input.lastEventId }),
        },
        signal: input.signal,
      });
      if (!response.ok || response.body === null)
        throw new Error(`stream answered ${String(response.status)}`);
      input.onOpen();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        for (;;) {
          const separator = buffer.indexOf("\n\n");
          if (separator === -1) break;
          const block = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          const lines = block.split("\n");
          const event = lines
            .find((line) => line.startsWith("event: "))
            ?.slice(7)
            .trim();
          const data = lines
            .find((line) => line.startsWith("data: "))
            ?.slice(6)
            .trim();
          if (event === undefined || data === undefined) continue;
          if (event === "gap") {
            // The Gateway said the replay window moved: re-read, never guess (the route is the record).
            input.onFrame({ type: "gap", payload: {} });
            continue;
          }
          let payload: Record<string, unknown> = {};
          try {
            const parsed: unknown = JSON.parse(data);
            if (typeof parsed === "object" && parsed !== null)
              payload = parsed as Record<string, unknown>;
          } catch {
            payload = {};
          }
          const id = lines
            .find((line) => line.startsWith("id: "))
            ?.slice(4)
            .trim();
          input.onFrame({ type: event, id, payload });
        }
      }
    } catch {
      // Down. G-T01's one line is the *sender's* business (it knows what the chat was last told); this loop just
      // comes back — the task never stopped because a stream did (§5.1's rule, restated in G-T02).
    }
    if (input.signal.aborted) return;
    input.onDown();
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}
