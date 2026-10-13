# Crabby — Data and Memory Specification

**Status:** Planning draft

**Database implementation:** SQLite proposed as leading candidate; not finalized (`DECISIONS.md` §5)

**Related documents:** `PROJECT_BRIEF.md`, `ARCHITECTURE.md`, `DECISIONS.md`, `AGENT_RUNTIME.md`, `SECURITY.md`

## 1. Purpose

Define how Crabby stores conversation history, task state, events, checkpoints, long-term memory, and configuration.

The design must support local-first operation, Android through Termux, safe recovery, user control, and future storage changes without unnecessary architectural rewrites.

## 2. Core Requirements

### 2.1 Conversation History

- Conversation history persists across process restarts by default.
- Users can delete their conversation history.
- Messages must retain their role, ordering, relevant timestamps, and association with the correct conversation.
- Tool calls and their results must remain associated with the relevant assistant turn or task where applicable.
- Generated summaries must not silently replace or destroy original conversation records.
- Data deletion must define how related summaries, indexes, and derived memory are handled.

**Decided (D-104).** The conversation itself is a record from schema version 6, and three of the bullets above are
answered by it rather than by a message store that does not exist yet. History persists across restarts because a
conversation now has a row that survives one, with the title W15-03 describes ("the new session starts empty and un-named,
and the title becomes the first question asked in it"), the interface that created it (W15-11), and the moment something
last happened in it — which is a task being created or changing state, the only activity this build records. Users can
delete their conversation history through one command and one tier (`history.deleteConversation`, T3), and the repository
prepares no `DELETE` statement so a second path cannot appear quietly. What is *not* decided here is the message half:
"messages must retain their role, ordering, relevant timestamps" has no table yet, so `GET /sessions/{id}` names
`messages`, `context` and `pins` in an `absent` list rather than answering `0 turns`, and a task's events remain the only
per-turn record that exists (§2.5). Deletion's derived-data question — "how related summaries, indexes, and derived memory
are handled" — is still D-065's answer, and still unreachable in a build with no summaries and no memory store.

**Decided (D-065).** Export is one artifact for all four interfaces (the per-session export W14-05, `crabby history export` and the memory export share a serializer), so "my export" is one thing to reason about. Retention is 30 days or 5 000 events per task, whichever comes first, with the count visible in the task record — a phone has the least free storage and a runaway job must not be able to fill it. Backup is `db.backup()` plus the config directory into a timestamped archive; restore is a documented manual step behind an integrity check.

### 2.2 Task State and Checkpoints

- Long-running tasks must have persistent state sufficient to support recovery.
- Checkpoints should capture the task's progress, completed steps, pending steps, and relevant execution metadata.
- Recovery must distinguish confirmed completed actions from actions whose outcome is uncertain.
- A resumed task must not blindly repeat non-idempotent external actions.
- Tasks that cannot safely resume should be marked for review or user intervention.
- Cancellation state must remain distinguishable from successful completion and failure.
- Recovery of task state is a distinct problem from database transaction recovery (`AGENT_RUNTIME.md` §7.4).

Checkpointing does not guarantee that every external operation can be resumed automatically.

**Decided (D-065).** A checkpoint is written at committed step boundaries, which the task model already defines, so "checkpoint frequency" is not a tuning knob. The resume policy is one conservative rule: resume may pass a step only if that step's tool declares itself idempotent or the step recorded its external effect; anything else re-asks rather than repeating. That is the whole of O-013, and it is what makes "resumes mid-way, never restarts" (D-044) safe to promise.

**Implemented (M2i, D-095).** One row per task, at schema version 4: `packages/storage/checkpoints.ts` owns the table and
`packages/agent-runtime/checkpoint.ts` owns the rule, and the write happens *inside* the transaction that records the step —
which is what makes "committed" in that phrase a property rather than an intention, and why there is no checkpoint for a
step that only started. The record holds the run's working context (redacted on the way in, like every other payload that
reaches this file), the step count, the model the boundary was written against, and the sequence number the event store had
reached when it committed; it holds **no grants and no action arguments**, because a record that could restore authority
would turn §7.2's "automatic orchestration of recovery, not automatic authorization" into a sentence about a field, and a
second copy of an approved action would be an action the arbiter never saw. D-065's rule above is computed when somebody
reads it — from the boundary, the task's state and the log tail after the boundary's sequence number — and its four answers
are `RESUME_VERDICTS` in the contract. That reading is also what makes a lagging boundary safe: a step that started and
never reported needs no second record, because the missing outcome *is* the evidence. What a client sees is
`GET /tasks/{id}/checkpoint`, which reports the boundary, its size and the verdict and not the transcript; what a runner
would use is the record itself, read in its own process. The row leaves with the task by `ON DELETE CASCADE`, which is §7's
deletion rule applied to a category §8.2 lists separately — in a build with no conversation store, a checkpoint that
outlived its task would quietly *become* one.

### 2.3 Long-Term Memory

Crabby uses a hybrid memory approach (D-019):

- The agent may propose or create useful memories automatically within configured policy.
- Users retain control over reviewing, correcting, deleting, or disabling automatic memory.
- Memory entries should have identifiable provenance, such as their originating conversation or task where feasible.
- Derived memories and summaries must be distinguishable from original conversation records.
- Memory retrieval should be relevant to the current task and respect access and deletion rules.
- Automatic memory creation must be possible to disable entirely for users who require that.

**Decided (D-073).** A memory carries **provenance, not a confidence score**: how it was learned (`stated` by the user /
`confirmed` by an outcome / `inferred` from a pattern), which task or conversation it came from, how many independent
sources support it, and when it was last confirmed. Rank is shown as a word, never a percentage — a model-written float
cannot be calibrated by anyone, and an uncalibrated number is trusted anyway, which makes it worse than no number.
Conflicts: a newer `stated` supersedes an older `stated`; `inferred` never overrides or deletes `stated`; anything the
two rules cannot settle is **displayed** as two entries with timestamps, matching the no-silent-edit rule for deletions
below. Automatic extraction is off by default, and when enabled each candidate is a diff the user can refuse before it
is written — a memory written silently is a personality change nobody approved.
**What stays open is one number:** the promotion threshold for `inferred` entries, tuned in M2 against the reviewed
acceptance list (`docs/review/`), one value per rule with the case that motivated it. Memory categories and the
user-facing controls are not open in the same sense: they are specified by the inventories (`docs/review/WEB.md`
regions W7/W8, `docs/review/TUI.md` region T9), which were reviewed under delegation on 2026-10-10 (D-075) and are
reviewed again per implemented screen (D-076). "Specified and awaiting a look" was never "undecided", and now it is
neither: those rows are accepted specifications.

### 2.4 Memory Search

- The first version should support ordinary text-based search (D-021).
- Vector or semantic search is not required for the initial release.
- Search functionality should be designed so that semantic retrieval can be added later if justified.
- Search indexes must not become an uncontrolled source of stale or undeletable personal data.
- Indexes should be rebuildable from authoritative records.

**Decided (D-065).** SQLite FTS5, indexed from the authoritative records and rebuildable from them. Bengali and English share one tokenizer, and because FTS5's `unicode61` does not segment Bangla the way a purpose-built library might, the index is documented as *recall-imperfect* rather than quietly patched with a hand-written splitter nobody tested. A vector index needs a measured need and a model nobody has chosen; until then the UI says "text search", not "search" (O-015).

### 2.5 Events and Audit Records

- Persist events required for task recovery, debugging, approval history, and important state transitions.
- Events should be associated with stable task, conversation, and event identifiers where applicable.
- Event records must distinguish meaningful lifecycle transitions, including start, progress, completion, failure, and cancellation.
- Event retention must balance recovery needs, storage consumption, privacy, and user control.
- Event records are descriptive, not authoritative for current task state (`AGENT_RUNTIME.md` §4.4).

**Decided (D-065).** Retention 30 days or 5 000 events per task. Pruning runs at startup and after a task completes — never lazily during replay, because a replay that prunes while it replays lies about what it showed. Payload limit is the same 64 KiB inline cap as tool output (D-064), overflow written to the session scratch and referenced by path. Export includes a task's event list, so "what happened" is portable.

### 2.6 Configuration and Secrets

- Persist non-secret configuration and user preferences as appropriate.
- Provider credentials and other secrets require separate secure handling.
- Secrets must not be exposed in ordinary logs, conversation exports, or memory search results.
- Configuration migrations must be considered when upgrading Crabby.

**Decided (D-066).** No secret material lives in the database at all: rows carry `vault://<name>` references and the values live in the vault `SECURITY.md` §7 describes. That keeps exports, backups and raw `sqlite3` inspection free of credentials without depending on redaction being correct at every call site (O-018).

## 3. Data Categories

| Category | Primary purpose | Persistence requirement |
| --- | --- | --- |
| Conversations and messages | Conversation continuity | Persistent by default |
| Tool calls and results | Explain execution and preserve context | Persistent where needed for history and recovery |
| Tasks | Track execution lifecycle | Persistent for recoverable tasks |
| Checkpoints | Resume work safely | Persistent for supported resumable tasks — one row per task, replaced at each committed step boundary, redacted on write, and deleted with the task (D-065, D-095) |
| Events | Recovery, auditing, and debugging | Required records retained; policy open |
| Approvals | Durable authorization decisions | Persistent while the linked action remains possible |
| Long-term memories | Reusable context | Persistent, user-controllable |
| Search indexes | Find relevant records | Rebuildable or maintainable from authoritative records |
| Configuration | User preferences and system settings | Persistent where appropriate |
| Secrets | Authentication and provider access | Secure storage; not ordinary plaintext configuration |

## 4. Database Requirements

The chosen storage solution should support, or be paired with mechanisms that support:

- Reliable local persistence.
- Transactions for related state changes.
- Structured querying and indexes.
- Consistent task and checkpoint updates.
- Recovery after unexpected process termination, including abrupt Android process kill.
- Backup and restore, including online backup while the Gateway runs.
- Data migration between schema versions.
- Controlled deletion of conversations and derived data.
- Acceptable storage and performance on low-resource Android devices.
- Compatibility with the selected Node.js runtime and Termux environment.

SQLite is a candidate, not a confirmed implementation choice. The comparison record is in `DECISIONS.md` §5.

Concurrency note: SQLite allows one writer at a time. Crabby's write path should therefore funnel persistence through a bounded, serialized write queue rather than assume free parallel writes (relevant to D-023 controlled parallelism).

### 4.1 Files in the state directory (D-078)

The names are here because a name that lives only in code is a name an interface eventually hard-codes. `<stateDir>` is
`~/.crabby` on Termux and Linux, and everything below is the whole footprint — a sixth file is a decision to record in
`DECISIONS.md`, not a constant to add quietly:

| File | Mode | What it is |
| --- | --- | --- |
| `config.json` | `0644` | Overrides only; the defaults stay in code (D-074). Since D-101 it also holds three things that are configuration rather than overrides and have no default to override — `provider.<id>` entries (§3.7's namespace, a `vault://` key reference at most and never a value), `defaultModel` (§3.6's selection), and `workspace.roots` (§8's containment, recorded by `crabby init` as the path it created). `AGENTS.md` names this file, so it is listed for completeness. Since D-106 it holds a fourth: `net.allowList`, the host set `SECURITY.md` §6.1's `net.egress:<hostset>` parameter names and `PROVIDERS_AND_TOOLS.md` §4.2's **T1** half is computed from — hosts rather than URLs, absent-and-empty meaning "nothing curated" rather than "no egress", and no default for the reason `workspace.roots` has none. |
| `crabby.sqlite3` | `0600` dir-inherited | One database: tasks (including §6.2's cancellation evidence, schema version 3), events, client identities, pairing codes, idempotency records, the approval queue (§6.3, schema version 2), D-065's checkpoint — one row per task, replaced at each committed step boundary, redacted on write (schema version 4), §4.5's scheduled jobs with their run history, including the UTC offset each job was created under (schema version 5, D-103), and the conversations §2.1's history is associated with, including each one's title, origin interface, last activity and the revision a rename has to carry (schema version 6, D-104 — backfilled from the `session_id` values the task table already held). `journal_mode = WAL`, `busy_timeout` from `limits.sqliteBusyTimeoutMs` (D-074). |
| `crabby.sqlite3-wal`, `crabby.sqlite3-shm` | — | SQLite's own siblings, present while a writer is open. Online backup takes a checkpoint first. |
| `scratch/<taskId>/` | `0700` | Overflow for a payload past D-064's 64 KiB inline cap, named `<eventId>.json`, pruned at startup past 24 h with the removal logged. One directory per task so a completed task's bytes leave as a unit. Since M2k it holds two more kinds of bytes, both under the same lifetime (D-098): a tool result past §4.4's output cap, written whole with its path printed in the label the model receives, and `trash/`, where `file.delete` renames a target instead of hard-deleting it (`SECURITY.md` §8) — so the file a task deleted leaves with the rest of that task's scratch, and the 24 h is a courtesy with an expiry rather than an undo the runtime may promise. |
| `vault/` | `0700` | D-066's secret store; the only directory whose contents may be referenced by name and never by value in a log line. |
| `gateway.json` | `0600` | What the running Gateway publishes about its own listener: host, port, pid, `startedAt`, version. Written at `listen`, **removed by a clean shutdown**, so "stale file" and "no Gateway" are different observable states. |
| `client.json` | `0600` | A paired client's own bearer token and the client id it belongs to. It is the client's config location in the same directory only because on a phone the client and the Gateway are one machine's two processes; the Gateway never reads it. |
| `last-exit.json` | — | D-066's shutdown record: how the process left and whether the drain finished, which is what lets `doctor` tell a crash from a Ctrl-C. |

## 5. Storage Architecture

The architecture should separate data access from the database engine.

Proposed repository boundaries:

- Conversation repository — implemented as `packages/storage/sessions.ts` over the `session` table at schema version 6
  (D-104). It is the one repository here that owns no abstraction in the runtime, because nothing in
  `packages/agent-runtime` needs to read a conversation: a task carries its `session_id` and the loop never asks what the
  conversation is called. What it does own is three rules the interfaces would otherwise each invent — the order a list is
  read in (`last_activity_at DESC`, C11-01's "the order a person remembers in"), the derivation of a state word from task
  counts (`sessionRowOf`/`sessionRows`, so a route and a tool cannot disagree about whether a parked task makes a
  conversation `waiting-approval`), and the revision comparison §2's concurrency row asks for, performed inside the
  `UPDATE`'s `WHERE` rather than as a read followed by a write. It also prepares no `DELETE` statement at all: destroying a
  conversation is `history.deleteConversation` at T3 (§4.2 of `PROVIDERS_AND_TOOLS.md`), and C11-05's "exactly one command
  that destroys history" is kept by an absence in this file rather than by a guard in a route. Migration 6 backfills one row
  per `session_id` the task table already carried, because an install that ran before this had conversations and no record
  of them, and an empty table would have upgraded the schema while leaving them just as invisible.
- Task and checkpoint repository — the task half is implemented twice over: `tasks.ts` for the record and
  `journal.ts` for the runtime's write seam, which is `TaskJournal` from `packages/agent-runtime` implemented the way
  §19 wants an adapter to implement an abstraction (`transact`/`setState`/`appendEvent` behind four synchronous methods,
  so the runtime's write phases commit a state and its events together). The checkpoint half arrived in M2i as
  `checkpoints.ts` over the `checkpoint` table, with the rule it enforces owned by the runtime's `checkpoint.ts` — so the
  repository boundary §5 proposed is now real for all three of these categories, and `AGENT_RUNTIME.md` §6.1's settle event
  reports a boundary that exists instead of naming one that does not.
- Event repository.
- Approval repository — implemented as `packages/storage/approvals.ts`, which is `SECURITY.md` §6.3's row plus §17's
  restart property, and which *implements* `ApprovalStore` from `packages/agent-runtime` rather than defining it
  (`ARCHITECTURE.md` §19: adapters implement abstractions). Its table is `approval`, at schema version 2.
- Job repository — implemented as `packages/storage/jobs.ts`, which *implements* `JobStore` from
  `packages/agent-runtime` the way the approval repository implements `ApprovalStore`, and for the same reason: the
  meaning of a row (what a `missed` occurrence is, what an open run is) belongs to the scheduler, and its bytes belong
  here. Two tables, `job` and `job_run`, at schema version 5. `JobPatch` carries no `objective` and no `createdBy`, so
  the statement the repository exposes cannot rewrite what the user approved or who approved it — §4.5's "a material
  change crosses into re-approval" as a property of the schema rather than only of a route that refuses. A job's
  `client_id` has no foreign key, because a revocation deletes the identity row (O-071) and must leave the job behind to
  be refused and paused with the reason on it: a cascade here would silently delete standing authority the user can no
  longer see, and a `SET NULL` would leave a job that runs as nobody.
- Memory repository.
- Configuration repository.

The precise repository interfaces and whether these are separate modules or grouped implementations remain open for the
four not yet named by a milestone. The approval repository is the first one M2 needed, and it is a module rather than a
split of `tasks.ts` because its row's meaning belongs to the runtime's arbiter and its bytes belong here.

The first implementation should avoid unnecessary distributed storage or a mandatory database server unless validation shows that a simpler solution cannot meet the requirements.

## 6. Consistency and Recovery Principles

01. Persist critical task state transitions before reporting them as durably recorded.
02. Use transactions for logically related updates where supported.
03. Record uncertain external action outcomes explicitly.
04. Prefer idempotency keys or equivalent safeguards where external systems support them.
05. Treat event replay and task recovery as separate concerns.
06. Preserve original records where required for reliable reconstruction.
07. Do not claim that a checkpoint can restore external side effects that the external system cannot reverse or verify.
08. WAL checkpointing, disk-space limits, and journal growth must be configured deliberately on mobile storage.

## 7. Privacy and Deletion

- Users must be able to delete conversation history.
- The deletion policy must explicitly address linked memories, summaries, search indexes, task artifacts, and exported backups.
- Deleting data from the active database does not automatically delete previously exported backups; exports must be listed so the user can act on them.
- Cascade deletion may be used for strictly derived, non-judgemental records (indexes, cached summaries). It must **not** be the automatic default for long-term memories, because a memory may be referenced by other conversations. Propagation is decided in D-065 (closing O-016) and stated below.
- Logs should avoid unnecessary message contents and secrets. The rule is in `SECURITY.md` §12 and D-065: no secret-shaped values in logs or exports, and the audit record keeps the exact target in plaintext.
- Data retention defaults are documented: 30 days or 5 000 events per task (D-065).

**Default (D-065):** deleting a conversation removes its messages and its derived search entries, and marks memories whose only provenance is that conversation for user review; memories with other sources are retained and re-attributed. Propagation happens **on read** — a summary whose source is gone is displayed as `source deleted` rather than rewritten, because rewriting derived text to match a deletion is how a memory system starts telling a story it never stored.

## 8. Backup, Restore, and Migration

Defined for release by D-065 (closing O-017); the bullets below are the requirements each answer meets.


- A backup method safe for the selected storage engine (online backup preferred over raw file copy).
- Restore validation and failure handling.
- Schema versioning and migrations, with an explicit failure behavior on downgrade.
- Whether backups include memory, checkpoints, configuration, and secrets (secrets should be excluded by default).
- Portability across supported platforms.
- Backup retention and whether deleted data can return from an old backup, which must be disclosed to the user.

## 9. Open Questions

01. Which database engine and driver are finally selected? (O-001, O-002)
02. What event retention period and storage limits are appropriate? (O-014)
03. How should conversation deletion propagate to derived memories and summaries? (O-016)
04. What checkpoint information is necessary for safe task recovery? (O-013)
05. Which text-search implementation should be used initially, and how is Bengali tokenization handled? (O-015)
06. What backup format and restore procedure are portable across supported platforms? (O-017)
07. How should sensitive configuration and provider credentials be protected on each platform? (O-018)
08. How should memory entries be reviewed and managed by users across all four interfaces?

## 10. Acceptance Criteria for This Specification

- Conversation history persists by default and users can delete it.
- Task recovery requirements explicitly address checkpoints and unsafe replay.
- Long-term memory supports automatic creation and user control.
- Necessary events are retained without prematurely fixing a retention period.
- Ordinary text search is sufficient for the initial release.
- Database and driver choices are made (D-066: SQLite with `better-sqlite3 ^13`, built from source on Termux); the
  evaluation that remains is the one on a device — a clean install and a crash-during-write, recorded as O-001/O-002.
- Deletion semantics for derived data are explicit rather than implied by cascade rules.

This document specifies intended behaviour, not a finalized database implementation.

---

**End of Data and Memory Specification**
