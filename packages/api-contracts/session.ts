// What a conversation is, as bytes four interfaces can agree on. `docs/DATA_AND_MEMORY.md` §3 lists "Conversations and
// messages" as persistent by default and §2.1 requires messages to keep "association with the correct conversation", but
// until schema version 6 a conversation existed only as an id on a task: `createTask` minted `ses_…` values that nothing
// owned, so there was no title to list (C11-01), no origin to notice (W15-11), no last activity to sort by and no token to
// rename against (§2's concurrency row). This module is the record those four needs read from.
//
// Three shapes here are decisions rather than conveniences, and D-104 is where they are recorded:
//
//   - **`title` is optional and its absence is a fact.** W15-03: "the new session starts empty and un-named, and the title
//     becomes the first question asked in it." So `title: undefined` means un-named and `titleShown` is what a list prints
//     for one — a client that rendered `undefined` as an empty label would show a row with nothing on it, and a client that
//     rendered it as `"undefined"` would be worse.
//   - **`origin` is optional.** W15-11 wants "which interface created it", and the conversations schema version 6 backfilled
//     from the task table have no recorded origin: they were minted by whatever created their first task, in a build that
//     did not write the fact down. `undefined` is rendered as `unknown`, because a guess would read as an attribution.
//   - **`revision` is the whole of the concurrency control.** §2 asks for "`If-Match`-style version tokens on config and
//     session mutations, so two interfaces editing the same thing do not silently overwrite", and a title is the one field
//     four interfaces can edit inline at the same moment (W1-02, W15-04, T16-05). A monotonic integer rather than a hash of
//     the row: the token has to be comparable by a client that only ever saw the row once, and a hash would make "which of
//     us is newer" unanswerable.

import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { CLIENT_INTERFACES, type ClientInterface } from "./clients.ts";
import { MessageId, SessionId, TaskId } from "./ids.ts";
import type { TaskRecord } from "./task.ts";

/** A conversation, as stored. Every field here is a column; nothing is derived, so a record and a row cannot disagree
 *  about what the database holds. */
export interface SessionRecord {
  readonly id: string;
  /** Absent while the session is un-named (W15-03), and never an empty string: a blank title is a title. */
  readonly title?: string;
  /** §3.6's per-session override, in the `<provider>/<modelId>` form `defaultModel` uses. Absent means the install's
   *  default, which is a different fact from "no model" and is rendered with W10-03's override marker only when present. */
  readonly model?: string;
  /** W15-11's attribution. Absent for a conversation that predates the record. */
  readonly origin?: ClientInterface;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** What C11-01 sorts by and W15-01 renders as "last activity": the moment a task was created or moved in this
   *  conversation, which is the only activity this build records. A rename does not move it — renaming is a change to the
   *  label, not something that happened *in* the conversation, and a list sorted by edits would bury a session somebody is
   *  working in under one somebody tidied. */
  readonly lastActivityAt: string;
  /** The `If-Match` token, and the row's own count of how many times it has been written. */
  readonly revision: number;
}

/** W15-03's word for a session with no title, so that four interfaces print one thing rather than four approximations. */
export const UNNAMED_TITLE = "un-named";

/** The state word C11-01 asks a list line to carry. Derived rather than stored, for the reason `jobStateWord` is: it is a
 *  claim about two tables at once, and four clients deriving it separately would derive four answers. */
export const SESSION_STATE_WORDS = ["waiting-approval", "running", "idle"] as const;
export type SessionStateWord = (typeof SESSION_STATE_WORDS)[number];

/** The task facts a state word is computed from. Counted by the party that holds both tables rather than passed in by a
 *  client, because a client that could declare them could declare a session idle while a prompt waits on the user. */
export interface SessionTaskFacts {
  readonly tasks: number;
  /** Tasks in a non-terminal state, which is W15-01's running-task badge and W15-09's "has running task" filter. */
  readonly running: number;
  /** Tasks parked at a prompt. Counted separately from `running` because the two need different words: one is work in
   *  motion and the other is work stalled on a human, and W16-02's principle — the state that must never be hidden — is
   *  the reason a session with a prompt waiting says so in a list. */
  readonly waitingApproval: number;
}

export function sessionStateWord(facts: SessionTaskFacts): SessionStateWord {
  if (facts.waitingApproval > 0) return "waiting-approval";
  if (facts.running > 0) return "running";
  return "idle";
}

/** The row a route answers: the record plus the three things a list line needs and only the Gateway can compute. */
export interface SessionRow extends SessionRecord {
  /** What to print where a title goes. `title` when there is one, W15-03's word when there is not. */
  readonly titleShown: string;
  readonly stateWord: SessionStateWord;
  readonly tasks: number;
  readonly runningTasks: number;
}

export function sessionRow(record: SessionRecord, facts: SessionTaskFacts): SessionRow {
  return {
    ...record,
    titleShown: record.title ?? UNNAMED_TITLE,
    stateWord: sessionStateWord(facts),
    tasks: facts.tasks,
    runningTasks: facts.running,
  };
}

/** `POST /sessions`'s body. Both fields optional, so `{}` is a valid creation: W15-03's new session "starts empty and
 *  un-named", and a form that demanded a title would be a form that invented one. */
export const CreateSessionBody = Type.Object(
  {
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    model: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  },
  { additionalProperties: false },
);
export type CreateSessionBody = Static<typeof CreateSessionBody>;

/** `PATCH /sessions/{id}`'s body: a title and a model override, which are the two things W15-04 and W10-03 edit inline.
 *  `model: null` clears the override and returns the session to the install's default, which is a different act from
 *  setting it to the default's current value — the second pins a session to a model that stops existing when the default
 *  moves, and the first does not.
 *
 *  Nothing else is patchable here. Deleting a conversation is `history.deleteConversation` at **T3** (W15-07, C11-05), so
 *  there is no `DELETE /sessions/{id}` in this build and no field that implies one: §4.2's tier for that act is the reason
 *  a rename route may not grow a `deleted` flag. */
export const PatchSessionBody = Type.Object(
  {
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    model: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 120 }), Type.Null()])),
  },
  { additionalProperties: false },
);
export type PatchSessionBody = Static<typeof PatchSessionBody>;

/** The roles §4.4's provider messages carry and §2.5's "role" bullet asks a store to keep. Read from the provider
 *  package's own vocabulary where it exists, so a role a provider adds is a decision here rather than a widening. */
export const MESSAGE_ROLES = ["system", "user", "assistant", "tool"] as const;

export interface SessionListBody {
  readonly items: readonly SessionRow[];
  readonly count: number;
  /** C11-01's order, stated rather than left to be inferred from the first item: last activity, newest first. A client
   *  that re-sorted by creation would show the order a person does not remember in. */
  readonly sortedBy: "lastActivity";
}

/** One turn of a conversation (D-112), as §2.5 lists what a message must keep: role, its place, when it happened, and
 *  which conversation — and which task, where there was one — it belongs to.
 *
 *  `content` is the redacted text: SECURITY.md §7 puts a credential out of every stored record, and §8.2 counts conversation
 *  records as a category of their own rather than a place where the event log's redaction may be skipped. */
export const MessageRecord = Type.Object(
  {
    id: MessageId,
    sessionId: SessionId,
    /** Absent for a turn no task produced. Every task in this build belongs to a session, so the column is nullable only
     *  because a one-shot chat turn (C4-02's `/ask`) has no task and pretending otherwise would make the absence illegal. */
    taskId: Type.Optional(TaskId),
    role: Type.Union(MESSAGE_ROLES.map((name) => Type.Literal(name))),
    content: Type.String(),
    /** The turn's place in the conversation, starting at 1. Not the id: ids minted in the same millisecond are ordered by
     *  nothing, and §2.5's "ordering" has to survive two turns written in one millisecond. */
    ordinal: Type.Integer({ minimum: 1 }),
    createdAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);
export type MessageRecord = Static<typeof MessageRecord>;

/** `GET /sessions/{id}/messages`'s body: §2's cursor pagination, ordered by ordinal so a page cannot shift under a reader
 *  that is appending. `nextCursor` is the ordinal to resume from, not an id — the ordinal is the stable thing. */
export interface MessageListBody {
  readonly items: readonly MessageRecord[];
  readonly count: number;
  readonly nextCursor?: string;
}

/** `GET /sessions/{id}`'s body. The tasks are bounded and the true total is beside them, for the reason a job's run
 *  history is: D-065 prices a task's retention, and a session a user has kept for a month can hold more of them than a
 *  phone should render in one answer. */
export interface SessionDetailBody {
  readonly session: SessionRow;
  readonly tasks: readonly TaskRecord[];
  readonly taskCount: number;
  /** What this build cannot answer about a conversation, named rather than omitted: C11-03's `session show` also asks for
   *  budget and pinned items, and both need D-027's context manager. `messages` left this list with D-112 — a detail body
   *  that simply omitted the field would let a client render `0 turns` for a conversation that has forty, which is why the
   *  absence is named in the first place. */
  readonly absent: readonly string[];
}

/** What a session mutation answers with: the row as it now stands, and the token the next mutation has to carry. */
export interface SessionActionBody {
  readonly session: SessionRow;
  readonly note: string;
}

/** Every way a session write can be refused, mapped to a class in `packages/gateway/errors.ts` — exhaustive over the
 *  union for the reason `JOB_REFUSAL_CLASS` is, so a new refusal fails to compile until somebody says what it means over
 *  HTTP. */
export const SESSION_ACTION_CODES = ["not-found", "stale", "no-change", "unwritable"] as const;
export type SessionActionCode = (typeof SESSION_ACTION_CODES)[number];

export type SessionActionResult =
  | { readonly ok: true; readonly session: SessionRecord }
  | { readonly ok: false; readonly code: SessionActionCode; readonly reason: string };

/** The `ETag` a session answer carries, and the value an `If-Match` has to equal. Quoted because RFC 9110 requires an
 *  entity-tag to be a quoted string, and a token a standard says is malformed is a token a proxy may rewrite. */
export function sessionETag(revision: number): string {
  return `"${revision}"`;
}

export type IfMatch =
  | { readonly ok: true; readonly revision: number }
  | { readonly ok: false; readonly reason: string };

/** Reads an `If-Match` header. `undefined` means the header was absent, which the caller decides about separately from a
 *  header that is present and unreadable — the two deserve different sentences, because one is a client that did not know
 *  the rule and the other is a client that tried and got it wrong. A weak comparator is accepted and its weakness ignored:
 *  the token is an integer this process wrote, so there is no byte-level equality left to weaken. */
export function parseIfMatch(header: string | undefined): IfMatch | undefined {
  if (header === undefined) return undefined;
  const text = header.trim().replace(/^W\//i, "");
  const match = /^"([0-9]+)"$/.exec(text) ?? /^([0-9]+)$/.exec(text);
  const value = match?.[1];
  if (value === undefined)
    return {
      ok: false,
      reason:
        `If-Match is '${header}', and the token for a session is the revision the answer carried — \`If-Match: "3"\` for ` +
        "a row whose `revision` is 3. A token this shape cannot be compared, so the write is refused rather than applied " +
        "on top of whatever the row now holds",
    };
  return { ok: true, revision: Number.parseInt(value, 10) };
}

/** The vocabulary a session's origin is rendered from, re-exported beside the record so a client that reads one finds the
 *  other. W15-11's four words and §3.1's four interfaces are the same list, which is the point of not writing a fifth. */
export const SESSION_ORIGINS = CLIENT_INTERFACES;
