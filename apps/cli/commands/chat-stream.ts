// The stream half of `crabby chat`, in its own file for one reason: it is a *different* consumer of `GET /events` from
// `task watch`, and sharing the reader would have meant sharing a printing policy too.
//
// `task watch` prints whatever the user asked to see (`--types`), one frame per line, in the vocabulary of events — which
// is what a person watching a task wants. `chat` prints **one thing**: the text the model produced, as it arrives. The
// difference is not cosmetic: C5-01's row says "plain question, no task, no plan", and a stream that prints
// `task.state.changed` has already printed a task and a plan whatever the verb's name says.
//
// So this reader takes `message.added` frames and prints `payload.content` for the roles that speak — `assistant` and
// `tool` results, because a chat that read a file and then answered should show the answer, not a plan of how it would
// read it. `user` and `system` frames are the user's own words and the summary D-116 writes; neither belongs in an
// answer.
//
// The terminal frames are the same three every follower watches for (`task.completed`, `task.failed`,
// `task.cancelled`), plus `task.interrupted` — because §7.1's exit codes read off a *state*, and a chat whose Gateway
// died must exit as what happened rather than waiting for an event that will never arrive. A stream that ends without a
// terminal frame is reported as `interrupted`, which is the honest reading of "the connection closed mid-run".
import { readCredentials } from "@crabby/gateway";
import type { DataLayout } from "@crabby/platform";
import type { Renderer } from "../output.ts";

export interface ChatStreamOutcome {
  readonly state: "completed" | "failed" | "cancelled" | "interrupted";
  /** The approval a chat hit, if any: C5-01's "no plan" cannot mean "no prompt", because the tier belongs to the action
   *  and a chat that read a file outside its grants is the same event as a task that tried. */
  readonly needsApproval?: string | undefined;
  readonly turns: number;
}

const TERMINAL = new Set(["task.completed", "task.failed", "task.cancelled", "task.interrupted"]);

export async function followChatStream(input: {
  readonly url: string;
  readonly layout: DataLayout;
  readonly renderer: Renderer;
  readonly taskId: string;
}): Promise<ChatStreamOutcome> {
  const { url, layout, renderer, taskId } = input;
  const credentials = readCredentials(layout);
  if (credentials === undefined) return { state: "interrupted", turns: 0 };
  const response = await fetch(
    `${url}/api/v1/events?taskId=${encodeURIComponent(taskId)}&types=${encodeURIComponent(
      ["message.added", "approval.requested", ...TERMINAL].join(","),
    )}`,
    { headers: { authorization: `Bearer ${credentials.token}`, accept: "text/event-stream" } },
  );
  if (!response.ok || response.body === null) return { state: "interrupted", turns: 0 };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let turns = 0;
  let needsApproval: string | undefined;
  let state: ChatStreamOutcome["state"] = "interrupted";
  outer: for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    for (;;) {
      const separator = buffer.indexOf("\n\n");
      if (separator === -1) break;
      const frame = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      const dataLines: string[] = [];
      let name: string | undefined;
      for (const line of frame.split("\n")) {
        if (line.startsWith(":")) continue;
        if (line.startsWith("event:")) name = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length === 0) continue;
      const parsed = JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
      const payload = (parsed.payload ?? {}) as Record<string, unknown>;
      if (name === "gap" || parsed.gap === true) {
        // §5.4's gap is a fact, and a chat that hid it would look like a quiet model rather than a lost window.
        renderer.line(
          "gap",
          "the stream's window moved; the run continues and `crabby task show` has the state",
        );
        continue;
      }
      if (name === "approval.requested") {
        needsApproval = typeof payload.approvalId === "string" ? payload.approvalId : undefined;
        renderer.line(
          "approval needed",
          `turn ${String(payload.tool ?? "a tool")} needs approving before it runs`,
        );
        continue;
      }
      if (name !== undefined && TERMINAL.has(name)) {
        state =
          name === "task.completed"
            ? "completed"
            : name === "task.failed"
              ? "failed"
              : name === "task.cancelled"
                ? "cancelled"
                : "interrupted";
        break outer;
      }
      if (name === "message.added") {
        const role = typeof payload.role === "string" ? payload.role : "";
        const content = typeof payload.content === "string" ? payload.content : "";
        // The user's own words and a summary are not the answer; a `tool` frame is the file the answer came from, which
        // C5-01's "the answer streams" does not ask for and which would bury it on a phone.
        if (role !== "assistant" && role !== "tool") continue;
        if (content.trim().length === 0) continue;
        turns += 1;
        for (const line of content.split("\n")) renderer.raw(line);
      }
    }
  }
  await reader.cancel().catch(() => undefined);
  return { state, turns, ...(needsApproval === undefined ? {} : { needsApproval }) };
}
