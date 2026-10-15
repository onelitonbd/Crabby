// D-112's write seam: one turn, one writer, one transaction with the event that announces it.
//
// The interface is deliberately tiny — the loop hands over a role, the text and a clock, and gets back the stored row's id
// and ordinal so it can put them on the frame. A seam this small is the point: a message store that the loop could also
// *read*, *rewrite* or *summarize* would be a context manager (D-027) wearing a store's name, and D-027's own rules about
// what may summarize are not this interface's to make.
import type { MESSAGE_ROLES } from "@crabby/api-contracts";

/** The contract's own list, re-exported because two packages need the type and neither may own it: `packages/storage` writes
 *  the column and this package hands the value over. */
export type MessageRole = (typeof MESSAGE_ROLES)[number];

export interface RecordMessageInput {
  readonly sessionId: string;
  /** Absent for a turn no task produced — a `/ask` in a session, which has no task because one-shot chat is not a task. */
  readonly taskId?: string | undefined;
  readonly role: MessageRole;
  readonly content: string;
  readonly at: number;
}

/** What the caller needs back to write the announcement: the id a client fetches and the ordinal that is the turn's place. */
export interface RecordedMessage {
  readonly id: string;
  readonly ordinal: number;
}

/** D-116's input. `role` is deliberately absent: a summary is a `system` row and always will be, so a
 *  caller that could pass another role would be able to state coverage for a turn that stands for
 *  nothing — and the migration's CHECK refuses that at the last possible moment instead of here. */
export interface SummarizeMessageInput {
  readonly sessionId: string;
  readonly taskId?: string | undefined;
  readonly content: string;
  /** The turn ordinals this summary stands in for, inclusive at both ends. §2.5's "must not silently
   *  replace or destroy original conversation records" is why these rows stay and this one points at
   *  them; D-115's second answer (the verbatim tail) is why the range stops before the recent turns. */
  readonly covers: { readonly from: number; readonly through: number };
  readonly at: number;
}

/** The seam, named as a writer for the same reason `CheckpointGate` is one: the loop writes and nobody else does, and a
 *  reader is a different interface (`GET /sessions/{id}/messages`, over HTTP, with the redaction already applied).
 *
 *  `summarize` sits beside `record` rather than replacing it, and for one reason: D-113's "the route is the same
 *  act asked by hand" only holds if there is one act. Two methods on one seam, one implementation, one
 *  transaction per write — where a compaction that could *not* have gone through this seam would be a
 *  second writer of a conversation's history, which is the rule D-112 exists to keep. */
export interface MessageWriter {
  record(input: RecordMessageInput): RecordedMessage;
  summarize(input: SummarizeMessageInput): RecordedMessage;
}
