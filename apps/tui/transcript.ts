// The chat pane's transcript: events in, lines out.
//
// This is the TUI's only pane that **renders model text**, and it is where three rules meet that pull against each other:
// D-061's named markdown subset (render, but only that subset), T4-05's no-full-repaint-per-token (the line-diffed renderer
// above), and T4-12's held scroll position (content arrives while the person is reading something else).
//
// **Events, not a second conversation store.** The pane's input is the same `GET /events` stream the CLI's `task watch`
// follows and the Web follows, and each frame is *derived* from the frames before it. It reads nothing else about the run,
// so a reconnect is a `GET /tasks/{id}` (T4-13's rule: truth comes from the task, not from replayed events alone) rather
// than a second transcript the pane maintains in step with the Gateway's.
//
// **A tool line is not a message.** T4-07/T4-08 ask for collapsed and expanded tool lines with a tier, a status and a
// duration, and §7.1's rule that a secret never reaches a screen is why the expanded form prints `redacted` **as a word** —
// a box is a mark nobody can read on a phone, and the row's reason is that the user learns something.
//
// **T4-12's held position is a first-class piece of state, not a scroll hack.** When the person has scrolled up, arriving
// content does not move them, and a one-line note says how much arrived. A pane that yanks the view back to the newest line
// while someone is reading an earlier one is the failure mode W3-13's affordance exists to prevent in the other interfaces.
import { type CharsetTier, redactedMarker, renderMarkdown, toolLine } from "./markdown.ts";
import { visibleWidth } from "./render.ts";

/** One event as the pane receives it. Deliberately the envelope's own fields and nothing derived: a pane that needs a
 *  field the envelope does not carry is a pane that needs its own protocol, which is how a second writer of conversation
 *  history starts. */
export interface EventFrame {
  readonly seq?: number | undefined;
  readonly type: string;
  readonly payload?: Record<string, unknown> | undefined;
}

export type TranscriptRow =
  | { readonly kind: "note"; readonly text: string }
  | {
      readonly kind: "turn";
      readonly role: "user" | "assistant";
      readonly ordinal: number;
      readonly lines: readonly string[];
      readonly width: number;
    }
  | { readonly kind: "system"; readonly text: string }
  | {
      readonly kind: "tool";
      readonly tool: string;
      readonly tier: string;
      readonly status: string;
      readonly expanded: boolean;
      readonly lines: readonly string[];
    }
  | {
      readonly kind: "error";
      readonly code: string;
      readonly line: string;
      readonly resumable: boolean;
    };

export interface TranscriptState {
  readonly rows: readonly TranscriptRow[];
  /** The ordinal of the turn being streamed, so a second `message.added` for the same turn appends rather than adding a
   *  row. D-117 records every turn as it happens, and two rows for one turn is a transcript with a hole in it. */
  readonly streaming?: { readonly ordinal: number; readonly text: string } | undefined;
  /** How many rows arrived while the view was held (T4-12's `new content (3)` note). */
  readonly held: number;
  readonly tier: CharsetTier;
  readonly columns: number;
}

export function emptyTranscript(columns: number, tier: CharsetTier): TranscriptState {
  return { rows: [], held: 0, tier, columns };
}

/** One system line added from *outside* the event fold — T16-07's switch note is the user's own act, not an event the
 *  Gateway streamed, but it belongs in the same subtle, in-order channel the fold uses (T4-10). Pure, like the fold. */
export function addSystem(state: TranscriptState, text: string): TranscriptState {
  return { ...state, rows: [...state.rows, { kind: "system", text }] };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/** One event folded into the transcript. Pure, so the tests can hand it a list of frames and read the rows — and so a
 *  reconnect can replay the frames it *did* keep and then reconcile with `GET /tasks/{id}` (T4-13). */
export function applyEvent(state: TranscriptState, frame: EventFrame): TranscriptState {
  const payload = frame.payload ?? {};
  switch (frame.type) {
    case "message.added": {
      const ordinal = asNumber(payload.ordinal);
      const role = asString(payload.role);
      const content = asString(payload.content) ?? "";
      if (ordinal === undefined || role === undefined) return state;
      if (role === "user") {
        // **The streaming turn is committed first.** A user message cannot arrive while the previous answer is still
        // streaming on a correct run, and when it does the two possibilities are "the answer arrived out of order" and "the
        // answer was lost". Dropping the buffer keeps the second possibility invisible and leaves a conversation with a hole
        // in it, which D-117's every-turn-is-a-record rule exists to prevent.
        const committed = commitStreaming(state);
        return {
          ...committed,
          streaming: undefined,
          rows: [
            ...committed.rows,
            {
              kind: "turn",
              role: "user",
              ordinal,
              lines: renderMarkdown(content, state.columns, state.tier).map((line) => line.text),
              width: visibleWidth(content),
            },
          ],
        };
      }
      if (role === "assistant") {
        // A turn that is still arriving is **not** a row yet: it is the streaming buffer, and it becomes a row when it ends
        // (T4-05's line-buffered growth). Writing it as a row on every frame is what produces a transcript of forty copies
        // of one answer.
        return { ...state, streaming: { ordinal, text: content } };
      }
      if (role === "tool") {
        const tool = asString(payload.tool) ?? "tool";
        const refused = payload.refused === true;
        const line = toolLine(
          tool,
          asString(payload.tier) ?? "T?",
          refused ? "refused" : "ok",
          asNumber(payload.durationMs),
        );
        return {
          ...state,
          rows: [
            ...state.rows,
            {
              kind: "tool",
              tool,
              tier: asString(payload.tier) ?? "T?",
              status: refused ? "refused" : "ok",
              expanded: false,
              lines: [line.text],
            },
          ],
        };
      }
      return state;
    }
    // T4-10's system line: compaction, memory injection, a mid-task model switch. One line, subtle attribute, and **never
    // reachable only by scrolling back** — which is why these rows sit in the transcript's own order and are not folded
    // into the next message.
    case "message.compacted":
    case "memory.injected":
    case "provider.switch.proposed": {
      const text = asString(payload.summary) ?? frame.type;
      return { ...state, rows: [...state.rows, { kind: "system", text }] };
    }
    // T4-11's error panel: there is no toast in a terminal, so the panel stays in the list.
    case "task.failed": {
      const code = asString(payload.code) ?? "failed";
      return {
        ...state,
        rows: [
          ...state.rows,
          {
            kind: "error",
            code,
            line: asString(payload.message) ?? "the run failed",
            resumable: payload.resumable === true,
          },
        ],
      };
    }
    case "task.completed":
      return commitStreaming(state);
    default:
      return state;
  }
}

/** Turn the streaming buffer into a row, if there is one. Called on completion **and** before a frame is drawn, because a
 *  person reading a finished answer should not have to wait for the next event to see it as a turn. */
export function commitStreaming(state: TranscriptState): TranscriptState {
  if (state.streaming === undefined) return state;
  const { ordinal, text } = state.streaming;
  return {
    ...state,
    streaming: undefined,
    rows: [
      ...state.rows,
      {
        kind: "turn",
        role: "assistant",
        ordinal,
        lines: renderMarkdown(text, state.columns, state.tier).map((line) => line.text),
        width: visibleWidth(text),
      },
    ],
  };
}

/** The rows to draw, with the streaming turn at the end. The view is the *tail* of this list, and `held` counts what arrived
 *  while the person was elsewhere (T4-12). */
export function visibleRows(state: TranscriptState, height: number): readonly TranscriptRow[] {
  const withStream =
    state.streaming === undefined ? state.rows : [...state.rows, streamingRow(state)];
  return withStream.slice(Math.max(0, withStream.length - Math.max(1, height)));
}

function streamingRow(state: TranscriptState): TranscriptRow {
  const streaming = state.streaming ?? { ordinal: 0, text: "" };
  const lines = renderMarkdown(streaming.text, state.columns, state.tier).map((line) => line.text);
  // T4-06: the stall marker replaces the cursor glyph while stalled, and the glyph is hidden rather than left blinking —
  // a blinking block that means nothing is worse than no block.
  return {
    kind: "turn",
    role: "assistant",
    ordinal: streaming.ordinal,
    lines:
      lines.length === 0 ? ["▏"] : [...lines.slice(0, -1), `${lines[lines.length - 1] ?? ""}▏`],
    width: visibleWidth(streaming.text),
  };
}

/** T4-08's expansion, and the only place a tool line is paged. `redacted` is printed as a word (see the header), and the
 *  output is truncated **with a label**, because an output that stops mid-word with no label reads as the whole output. */
export function expandTool(
  row: Extract<TranscriptRow, { kind: "tool" }>,
  maxLines = 20,
): TranscriptRow {
  return { ...row, expanded: true, lines: row.lines.slice(0, maxLines) };
}

export function truncationLabel(shownBytes: number, totalBytes: number): string {
  // Grouped, because a byte count is read at a glance and `64512` is harder to check against a limit than `64,512`.
  return totalBytes <= shownBytes
    ? `${shownBytes.toLocaleString("en-US")} bytes`
    : `first ${shownBytes.toLocaleString("en-US")} of ${totalBytes.toLocaleString("en-US")} bytes — the rest is in the session scratch`;
}

export { redactedMarker };

/** T4-12's note, as one line. `new content (3)` in the Web is this sentence here. */
export function heldNote(held: number): string {
  return held === 1
    ? "new content (1) — press End to follow"
    : `new content (${held}) — press End to follow`;
}

/** T5-10's estimate for the draft, using the same D-064 arithmetic the Gateway's `GET /sessions/{id}/context` uses. The
 *  client-side arithmetic is a *different* number from the server's (it has no conversation), and the row asks for an estimate
 *  that is labelled as one — so the label is part of the string, not a property of the rendering. */
export function draftEstimate(chars: number): string {
  // D-064: `max(chars/4, cluster count × 1.35)`. The cluster count is not computed on a phone keyboard for every keystroke,
  // so the divisor branch is the one that runs and the Bengali branch is the Gateway's — which is another reason the number is
  // labelled: it is the *client's* estimate, and the document's rule says an estimate is never shown as a count (O-031).
  return `~${Math.max(1, Math.round(chars / 4)).toLocaleString("en-US")} tokens (est, D-064 — the Gateway's own number may differ)`;
}
