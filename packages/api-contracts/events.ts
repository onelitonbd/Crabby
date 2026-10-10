// The event envelope (`docs/INTERFACES_AND_API.md` §5.2), the families a client can filter on, and the two rules that
// make the stream safe to
// build on: `seq` monotonic per task (gap detection does not trust the wall clock), and events as informative records
// rather than authorization grants (`ARCHITECTURE.md` §7).
import { type Static, Type } from "@sinclair/typebox";
import { EventId, RequestId, SessionId, TaskId } from "./ids.ts";

export const SCHEMA_VERSION = 1;

export const EVENT_FAMILIES = [
  "task",
  "message",
  "tool",
  "approval",
  "provider",
  "extension",
  "system",
] as const;
export type EventFamily = (typeof EVENT_FAMILIES)[number];

/** The initial sets named in §5.2, kept as data so a client can offer them and a test can fail when a producer
 *  invents a type outside the families. `task.*` and `message.*` stay open-ended (a new kind of progress note is an
 *  addition), which is why the schema enforces the family and the shape rather than a closed list. */
export const EVENT_TYPES = [
  "task.created",
  "task.planning.updated",
  "task.state.changed",
  "task.progress",
  "task.completed",
  "task.failed",
  "task.cancelled",
  "task.resumed",
  "task.interrupted",
  "message.added",
  "message.stream.started",
  "message.stream.delta",
  "message.stream.completed",
  "message.stream.aborted",
  "tool.call.proposed",
  "tool.execution.started",
  "tool.execution.output",
  "tool.execution.completed",
  "tool.execution.failed",
  "tool.execution.blocked",
  "approval.requested",
  "approval.answered",
  "approval.expired",
  "approval.re-requested",
  "provider.retry.scheduled",
  "provider.retry.attempt",
  "provider.switch.proposed",
  "provider.switch.accepted",
  "extension.validate.started",
  "extension.validate.completed",
  "extension.installed",
  "extension.suspended",
  "extension.uninstalled",
  "system.ready",
  "system.shutting-down",
  "system.restarted",
  "system.tunnel.started",
  "system.tunnel.stopped",
  "system.vault.locked",
  "system.vault.unlocked",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EventFamilies = Type.Union(EVENT_FAMILIES.map((name) => Type.Literal(name)));

export const Event = Type.Object(
  {
    id: EventId,
    schemaVersion: Type.Literal(SCHEMA_VERSION),
    type: Type.String({
      pattern: "^(task|message|tool|approval|provider|extension|system)\\.[a-z][a-z.-]{1,62}$",
    }),
    ts: Type.String({ format: "date-time" }),
    sessionId: SessionId,
    taskId: TaskId,
    correlationId: Type.Optional(RequestId),
    seq: Type.Integer({ minimum: 0 }),
    payload: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
);

export type Event = Static<typeof Event>;

/** §5.2 requires "a payload size cap with a truncation marker; large tool output is referenced by id, not inlined",
 *  and the number is already decided: O-035 closed as D-064's "64 KiB inline; the rest to the session scratch
 *  directory with the path printed", and D-065 says the event payload limit is that same cap. `TruncationMarker` is
 *  what a client reads when bytes were moved out, and `reference` names where they went. */
export const MAX_EVENT_PAYLOAD_BYTES = 64 * 1024;

export function payloadTooBig(
  payload: Record<string, unknown>,
  capBytes = MAX_EVENT_PAYLOAD_BYTES,
): boolean {
  if (!Number.isInteger(capBytes) || capBytes <= 0)
    throw new TypeError("payload cap must be a positive byte count");
  return JSON.stringify(payload).length > capBytes;
}

export const TruncationMarker = Type.Object(
  {
    truncated: Type.Literal(true),
    bytes: Type.Integer({ minimum: 0 }),
    reference: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type TruncationMarker = Static<typeof TruncationMarker>;

/** §5.2's last rule: anything a client must act on has to be recoverable by polling `GET /tasks/{id}` — §4.3 calls
 *  that route "the fallback a client uses after a missed event" — so a dropped SSE frame costs latency and never
 *  truth. This is the rule as data so that M1b's route test can assert its own routes answer it — the list is the
 *  thing to check against, not a comment reminding someone to check. */
export const ACTIONABLE_EVENT_TYPES: readonly EventType[] = [
  "approval.requested",
  "approval.answered",
  "approval.expired",
  "approval.re-requested",
  "task.completed",
  "task.failed",
  "task.cancelled",
];
