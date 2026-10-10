# Crabby — Interfaces and API Specification

> **Document status:** Planning draft. Endpoint and event shapes are proposed contracts; no transport choice is
> final until `DECISIONS.md` O-004 and O-010 are closed.
>
> **Owns:** the Gateway API surface, authentication and pairing flow, event envelope, reconnect and replay rules,
> CLI/TUI/Web/Telegram command mapping, the feature-parity matrix, and interface-specific constraints.
>
> **Related:** `ARCHITECTURE.md` §6/§7/§9/§10, `SECURITY.md` §5, `PROVIDERS_AND_TOOLS.md` §4.2,
> `docs/UI_UX_SPEC.md` (presentation only)

## 1. Purpose

Define the single contract that all four interfaces implement against. If this document and the core services
disagree, this document is wrong — interfaces never grow private shortcuts into the runtime (`ARCHITECTURE.md` §2
rule 01).

Three properties every design choice below must keep:

- **Parity:** a capability reachable in one interface is reachable in all four (D-005).
- **Attribution:** every request names the paired client identity that sent it (D-030).
- **Recoverability:** a dropped connection on a phone network never loses task state or duplicates side effects.

## 2. General API Rules

| Rule | Requirement |
| --- | --- |
| Base path | `/api/v1/...`; breaking changes require a new version, additive changes do not. |
| Content type | `application/json; charset=utf-8`. UTF-8 is assumed everywhere — Bengali content is a first-class case, not an edge case. |
| Validation | Every body and query is schema-validated before routing; unknown fields are rejected with the field named. |
| Idempotency | Any request that can cause a side effect accepts `Idempotency-Key`; a replayed key returns the recorded result, never a second execution. |
| Correlation | Every request carries or receives `X-Crabby-Request-Id`, echoed in errors and audit records. |
| Errors | One envelope (§6); no stack traces, no provider bodies containing credentials (`SECURITY.md` §14). |
| Pagination | Cursor-based (`?cursor=&limit=`), ordered by stable id, so a list does not shift while a task appends records. |
| Concurrency | `If-Match`-style version tokens on config and session mutations, so two interfaces editing the same thing do not silently overwrite. |
| Loopback default | The listener binds `127.0.0.1`/`::1` only; `--host` requires an explicit remote-mode acknowledgment (`SECURITY.md` §13). |
| No ambient auth | No cookie jar, no automatic credential sending from a browser. Bearer token from the paired identity, explicitly delivered. |

## 3. Authentication and Pairing

### 3.1 Flow

```
crabby auth pair --name <label> --interface cli|tui|web|telegram [--restrict caps]
        │
        ├── Gateway creates a client identity: { id, name, interface, capabilities, createdAt }
        ├── prints a one-time pairing code (TTL ~120s, single use)
        │
        └── client redeems it ──► POST /api/v1/auth/pair { code }
                                        │
                                        └── returns { clientId, token } once, never stored server-side in plaintext
```

Requirements:

- The pairing code is generated inside the Gateway's own host/terminal, never accepted from an unauthenticated
  network caller. Redeeming a stolen code is therefore bounded by the TTL and the single-use rule.
- Token storage: owner-only permissions in the client's config location; secrets follow `SECURITY.md` §7/D-031. A
  credential is checked once at request start and again when a live event stream is upgraded to an action, so a
  revoked identity cannot keep acting on an open stream.
- Managing identities requires `auth.manage` (`SECURITY.md` §6.1), which exists only on a local paired client. This
  is the single legitimate asymmetry in the parity matrix: minting or revoking identities from a network-facing
  interface would let a stolen remote token create a second one. It is recorded in §8 rather than hidden.
- `crabby auth list` shows name, interface, created, last used, granted capabilities, and whether it is currently
  connected. `crabby auth revoke <clientId>` must be effective on the next request **and** must terminate live event
  streams for that client.
- A Web UI session uses the same identity model: `crabby web open` obtains a short-lived pairing artifact for the
  browser rather than introducing a second, browser-specific trust mechanism.
- Remote (tunnel) clients use the same tokens. Enabling a tunnel lists which identities become reachable
  (`SECURITY.md` §13), because that is the moment a local identity becomes a network-facing one.
- Unauthenticated responses must not reveal which routes exist, and `GET /health` is authenticated too (it leaks
  too much about configuration to be public).

### 3.2 Open detail

Token format and expiry are settled by D-051: an opaque random token with no expiry by default, since revocation is
the control and a phone cannot reliably run a rotation UX. **O-019 now has one remainder: pairing UX on a phone** —
a code that is readable, typeable, and copyable in one screen. On Termux the code must be readable
and typeable in one screen; copy/paste is not guaranteed to work.

## 4. Endpoints

Names below are the proposed contract; exact paths may be adjusted during implementation as long as capability
coverage does not shrink.

### 4.1 System and diagnostics

| Method + path | Purpose |
| --- | --- |
| `GET /health` | Liveness, version, uptime, listener mode (local/tunnel), vault locked state. |
| `GET /status` | Service readiness per subsystem: storage, scheduler, providers, extensions, tunnel. |
| `GET /diagnostics` | Sanitized runtime report, safe to paste into a bug report. |
| `POST /admin/shutdown` · `POST /admin/restart` | Graceful lifecycle; T3 (`config.write`). |
| `GET /logs?cursor=&level=` | Structured operational logs, redacted. |
| `GET /audit?cursor=&taskId=` | Security-relevant records (`SECURITY.md` §14). |

### 4.2 Sessions and messages

| Method + path | Purpose |
| --- | --- |
| `GET /sessions` · `POST /sessions` | List and create conversations/sessions. |
| `GET /sessions/{id}` · `PATCH /sessions/{id}` · `DELETE /sessions/{id}` | Read, rename, delete (delete is `history.deleteConversation`, T3). |
| `GET /sessions/{id}/messages?cursor=` | Ordered history with tool calls attached to their turn. |
| `POST /sessions/{id}/messages` | Add a user message; returns `messageId` and the resulting `taskId` when a task is implied. |
| `POST /sessions/{id}/compact` | Ask for compaction now rather than at the budget limit (D-027). |
| `POST /sessions/{id}/export` · `POST /export` | Render a sanitized export (`json`, `md`, or `jsonl`) and return a download handle for the artifact, which lives in a temp directory with the §5.2 output caps. `history.export` is T2, so this route creates a task-shaped action rather than streaming bytes blindly (`PROVIDERS_AND_TOOLS.md` §4.2). |
| `GET /sessions/{id}/context` | Current working-context view: what is in budget, what was compacted, what is pinned. |
| `POST /sessions/{id}/pin` | Protect important context from compaction. |

### 4.3 Tasks, events, approvals

| Method + path | Purpose |
| --- | --- |
| `POST /tasks` | Create a task. Body: objective, optional session, model pin, capability narrowing, schedule. Idempotency key required. |
| `GET /tasks?state=&sessionId=&cursor=` | Filtered listing. |
| `GET /tasks/{id}` | Authoritative current state (the fallback a client uses after a missed event). |
| `GET /tasks/{id}/steps` | Step-level plan and outcomes. |
| `POST /tasks/{id}/cancel` | Cancellation request; returns `cancelling` and, once settled, the terminal state (`ARCHITECTURE.md` §10). |
| `POST /tasks/{id}/resume` | Explicit resume, for the cases auto-resume declined (§7.2 of the runtime doc). |
| `GET /tasks/{id}/events?cursor=` | Historical events for a task; replay window is per-task and count-bounded (D-049). |
| `GET /approvals?state=pending` | Approval queue for this client. |
| `POST /approvals/{id}/decision` | `{ decision: approve|deny, scope: once }`. Only `once` exists in the first release for T2/T3 per `SECURITY.md` §6. |
| `GET /tasks/{id}/checkpoint` | Checkpoint view for recovery transparency. |
| `GET /jobs` · `PATCH /jobs/{id}` · `POST /jobs/{id}/pause` | Scheduled jobs (`PROVIDERS_AND_TOOLS.md` §4.5). |

### 4.4 Providers, models, memory, extensions, config, tunnel

| Method + path | Purpose |
| --- | --- |
| `GET /providers` · `POST /providers` · `DELETE /providers/{id}` | Manage provider entries, including user-defined OpenAI-compatible ones (D-041). Credentials are write-only references to the vault. |
| `GET /models?provider=` | Models with effective capability descriptors, `reported` vs `overrides` visible side by side (D-045). |
| `PUT /models/{provider}/{model}/overrides` | Capability override; T3. |
| `POST /models/{provider}/{model}/probe` | Run the conformance probe and report which claimed capabilities actually answered. |
| `GET /tools` | Registry with tier, capability, and platform availability; drives the parity matrix in tests. |
| `GET /memory` · `POST /memory` · `PATCH /memory/{id}` · `DELETE /memory/{id}` | Review, correct, and delete long-term memory (D-019). |
| `GET /memory/search?q=` | Text search only in the first release (D-021). |
| `GET /extensions` · `POST /extensions/validate` · `POST /extensions/install` · `DELETE /extensions/{id}` | Extension management against `EXTENSIONS.md` §5–§6, including `dryRun` validation. |
| `GET /extensions/{id}/reports` | Conversion report history and update diff (D-039). |
| `GET /config` · `PUT /config` · `GET /config/schema` | Configuration with the validation contract exposed. |
| `POST /tunnel` · `DELETE /tunnel` | Enable/disable remote exposure; T3; response includes the current public URL and the reachable-identity list. |

## 5. Events and Streaming

### 5.1 Transport

**Accepted (D-048):** `GET /events` returns an SSE stream (`text/event-stream`) filtered by query (`sessionId`,
`taskId`, `types`); the client sends `Last-Event-ID` on reconnect. Every client action is a plain HTTP request, so a
persistent bidirectional channel would buy Crabby little while adding reconnect, ordering, and lifecycle complexity
on mobile networks. WebSocket is therefore not in v1 — and because the transport is reached only through the event
publisher abstraction, adding it later must not require touching application logic.

Requirements on whichever transport ships:

- Heartbeat/keep-alive comments on a fixed interval so idle phone connections are detected rather than silently
  dropped.
- A stream must never block a task. If delivery is slow, events are buffered or dropped with a recorded gap — the
  task keeps running.
- SSE responses must disable proxy buffering (`X-Accel-Buffering: no`) and stay correct behind a Cloudflare tunnel.

### 5.2 Event envelope

```json
{
  "id": "evt_01H...",
  "schemaVersion": 1,
  "type": "tool.execution.started",
  "ts": "2026-10-09T12:00:00.000Z",
  "sessionId": "ses_…",
  "taskId": "tsk_…",
  "correlationId": "req_…",
  "seq": 1284,
  "payload": { }
}
```

`seq` is monotonic per task, which is what lets a client detect a gap without trusting wall-clock order.

Event families (initial set):

| Family | Examples |
| --- | --- |
| `task.*` | `created`, `planning.updated`, `state.changed`, `progress`, `completed`, `failed`, `cancelled`, `resumed`, `interrupted` |
| `message.*` | `added`, `stream.started`, `stream.delta`, `stream.completed`, `stream.aborted` |
| `tool.*` | `call.proposed`, `execution.started`, `execution.output`, `execution.completed`, `execution.failed`, `execution.blocked` |
| `approval.*` | `requested`, `answered`, `expired`, `re-requested` |
| `provider.*` | `retry.scheduled`, `retry.attempt`, `switch.proposed`, `switch.accepted` (feeds the §4.3 ladder) |
| `extension.*` | `validate.started`, `validate.completed`, `installed`, `suspended`, `uninstalled` |
| `system.*` | `ready`, `shutting-down`, `restarted`, `tunnel.started`, `tunnel.stopped`, `vault.locked`, `vault.unlocked` |

Rules:

- Payload size cap with a truncation marker; large tool output is referenced by id, not inlined.
- Events are informative records, never authorization grants (`ARCHITECTURE.md` §7).
- Anything a client must act on (approval request, cancellation settled, task terminal state) must also be
  retrievable by polling `GET /tasks/{id}` — a client that missed the event must still see the truth (§5.4).

### 5.3 Streamed assistant text

Assistant text is streamed as `message.stream.delta` events on the same channel, not as a second bespoke stream,
so all four interfaces render the identical mechanism. A stream is bounded by the task, and an aborted stream
records what was actually delivered versus generated.

### 5.4 Reconnect, replay, gap handling

```
stream drops
   │
   ├── client reconnects with Last-Event-ID (+ per-task seq)
   │
   ├── within replay window  → replay missed events in order, resume live tail
   │
   └── outside replay window → server responds { gap: true, stateAt: "tsk_…" }
                                client MUST fetch GET /tasks/{id} and rebuild view
```

- A gap is always explicit. Silently resuming a live tail as though nothing was missed is prohibited: an interface
  must never show a task as still running when it completed during the outage.
- **Accepted (D-049):** replay is per-task and count-bounded, not time-bounded — what a client needs after a
  three-second phone-network blip is *this task's* tail, not every event from the last hour. Outside the window the
  response carries the explicit gap marker and the client reconciles from `GET /tasks/{id}`.
- The client-visible contract is: **events for display, GET for truth.**

## 6. Error Envelope

```json
{
  "error": {
    "code": "approval.required",
    "message": "This step needs your approval before it can run.",
    "class": "policy",
    "taskId": "tsk_…",
    "retryable": false,
    "details": { "tier": "T2", "tool": "git.push", "approvalId": "apr_…" },
    "requestId": "req_…"
  }
}
```

Classes: `validation`, `auth`, `policy`, `not-found`, `conflict`, `rate-limit`, `provider`, `resource-limit`,
`platform-unsupported`, `internal`. HTTP status maps from the class; the `code` is the stable machine-facing value,
because a status alone cannot express "denied by policy" versus "needs approval".

## 7. Interface Mapping

### 7.1 CLI

Non-interactive, scriptable, and the reference implementation of the command grammar.

Conventions: `crabby <noun> <verb> [args] [--flags]`; `--json` for machine output on every read command; exit
code `0` success, `1` failure, `2` usage/validation, `3` needs-approval, `4` platform-unsupported. Output must be
pipeable and free of color when not a TTY.

| Area | Commands |
| --- | --- |
| Setup | `init`, `doctor`, `status`, `version` |
| Chat | `chat "…"` (one-shot), `chat --session <id>` |
| Tasks | `task run "…"`, `task ls`, `task show <id>`, `task watch <id>`, `task cancel <id>`, `task resume <id>` |
| Approvals | `approval ls`, `approval approve <id>`, `approval deny <id>` |
| Providers | `provider add/list/remove`, `model list`, `model edit <p>/<m>`, `model probe <p>/<m>` |
| Auth | `auth pair`, `auth list`, `auth revoke <id>` |
| Config | `config get/set/path/schema` |
| Extensions | `ext init`, `ext validate`, `ext check-compat`, `ext install`, `ext list`, `ext info`, `ext update`, `ext uninstall` |
| Interfaces | `gateway start/stop/status`, `web open`, `telegram start`, `tui`, `tunnel on/off/status` |
| Data | `history export`, `history delete-session`, `memory list/search/forget`, `logs`, `audit` |
| Context | `context show <id>`, `context pin <id> [ref]`, `session compact <id>`, `tools ls` |

Rule: `crabby --help` and `crabby <noun> --help` are generated from the same contract that the Web UI and Telegram
use, so a command cannot exist in one interface only (the D-005 test).

### 7.2 TUI

Interactive terminal client over `/events` + HTTP.

- Layout on a narrow screen (Termux ~40–60 columns) is the design case: one primary pane, with side panes toggled
  rather than assumed.
- Required views: conversation with streaming, task list, task detail (plan/steps/state), approval prompt, tool
  activity, session switcher, provider/model picker with the override screen (`PROVIDERS_AND_TOOLS.md` §3.8).
- Keys: `Ctrl-C` cancels the current task (mapped to `POST /tasks/{id}/cancel`, not to killing the process),
  `Esc` closes a pane, `?` help. The terminal's own interrupt must never be the only way to stop work.
- Must degrade honestly: no colors/Unicode on dumb terminals, and `TERM=dumb` is a supported mode with reduced
  chrome rather than a crash.
- Approval prompts are blocking-modal with a visible expiry, since approving a stale prompt is a real risk
  (`SECURITY.md` §4, T-05).

### 7.3 Web UI

React + Vite per `ARCHITECTURE.md` §6.3; served as built assets by the Gateway in production.

- Consumes only `/api/v1` and `/events`; no direct core imports, no separate backend.
- Mobile viewport is the primary layout (a phone browser pointed at a Termux Gateway), desktop is the wider case.
- All four interfaces' capabilities must exist here: sessions, tasks, approvals, providers and model overrides,
  extensions, memory review, config, logs/audit, tunnel control.
- Origin checks and the token model of §3.1; the token never lands in a URL or a query string, because URLs get
  logged by intermediaries — a tunnel public URL makes that mistake expensive.

### 7.4 Telegram

Adapter over grammY (P-009); translates Telegram updates into the same internal requests.

- Commands, one per capability in §8 rather than a hand-picked subset: `/ask <text>`, `/task <objective>`, `/tasks`,
  `/watch <id>`, `/unwatch <id>`, `/cancel [id]`, `/resume <id>`, `/approve <id>`, `/deny <id>`, `/approvals`,
  `/sessions`, `/new`, `/context`, `/compact`, `/model <provider/model>`, `/providers`, `/probe <model>`, `/tools`,
  `/memory`, `/ext`, `/config`, `/logs`, `/export`, `/delete <id>`, `/tunnel on|off`, `/status`, `/health`, `/help`.
  A command may not be dropped from this list to save typing: dropping one removes a capability from the interface,
  which is the D-005 test failing. What *is* Telegram's to choose is how little of it needs typing — inline keyboards
  and reply targets carry the common paths, and the two documented limitations in §8 (provider add, identity
  minting) are refusals with an alternative, not silence.
- Approvals use inline keyboards; a callback must be verified against requester, chat, and originating message
  (`SECURITY.md` §5.2). Callback data carries an opaque approval id, never the action itself.
- Long output is chunked at Telegram's limit with explicit continuation, or delivered as a file; a truncated reply
  must say it was truncated.
- Progress updates are coalesced (edit-in-place with a minimum interval) rather than one message per event, so a
  busy task cannot become a notification flood or hit rate limits.
- If an approval cannot be represented, the fallback is a plain message with the id to reply with — capability
  parity by an alternative interaction, never by omission.
- Access is allow-listed by user/chat id; unauthorized senders get no information.

## 8. Feature Parity Matrix

Every capability must exist on all four rows. A blank cell is a defect unless it carries a documented platform
limitation **and** an accepted alternative interaction, which is what `ARCHITECTURE.md` §6.5 requires.

| Capability | API | CLI | TUI | Web | Telegram |
| --- | --- | --- | --- | --- | --- |
| Chat / one-shot prompt | `POST /sessions/{id}/messages` | `chat` | chat pane | chat view | `/ask` |
| Create multi-step task | `POST /tasks` | `task run` | `n` in tasks pane | New task | `/task` |
| Watch task + live progress | `GET /events`, `GET /tasks/{id}` | `task watch` | task detail | task view | `/watch` + edits |
| Cancel task | `POST /tasks/{id}/cancel` | `task cancel` | `Ctrl-C` | Cancel button | `/cancel` |
| Resume task | `POST /tasks/{id}/resume` | `task resume` | `r` in detail | Resume | `/resume <id>` |
| Answer approval | `POST /approvals/{id}/decision` | `approval approve/deny` | modal | dialog | inline buttons |
| Pending approval queue | `GET /approvals` | `approval ls` | status bar | approvals panel | `/approvals` |
| List/switch sessions | `GET /sessions` | `chat --session` | session switcher | sidebar | `/sessions` |
| Context view + pin | `GET /sessions/{id}/context`, `POST …/pin` | `context show/pin` | context pane | context drawer | `/context` |
| Force compaction | `POST /sessions/{id}/compact` | `session compact` | `c` | Compact | `/compact` |
| Provider add/remove | `POST/DELETE /providers` | `provider add` | provider screen | settings | `/providers` (add is Web/CLI-only if typing a URL on a phone is impractical — needs an accepted limitation, not a gap) |
| Model list + override | `GET /models`, `PUT …/overrides` | `model edit` | model picker | model editor | `/model` |
| Probe model capabilities | `POST /models/…/probe` | `model probe` | action in picker | Probe button | `/probe <model>` |
| List tools + tiers | `GET /tools` | `tools ls` | tools pane | tools view | `/tools` |
| Memory review/search/forget | `/memory…` | `memory …` | memory pane | memory view | `/memory` |
| Extension validate/install | `/extensions…` | `ext …` | extensions pane | extensions view | `/ext` (install requires a confirming approval message) |
| Config get/set | `/config` | `config …` | settings | settings | `/config` (T3 changes confirm in-chat) |
| Logs / audit | `/logs`, `/audit` | `logs`, `audit` | log pane | logs view | `/logs` (tail + file export) |
| Tunnel on/off | `POST/DELETE /tunnel` | `tunnel on/off` | status + action | settings | `/tunnel on` (T3 confirm) |
| Pair / revoke client | `/auth…` | `auth pair/revoke` | settings | settings | revoke from a trusted local client only — a remote client must not be able to mint identities; **documented limitation with local-only alternative** |
| History export | `POST /sessions/{id}/export` (`history.export`) | `history export` | export action | Download | `/export` as a file |
| Delete conversation | `DELETE /sessions/{id}` | `history delete-session` | `d` | Delete | `/delete <id>` with typed confirm |

Two entries deliberately carry a limitation instead of pretending to parity: minting identities from Telegram is a
security hole, and pasting a URL on a phone is genuinely awkward. Both are recorded here so nobody "discovers"
them later as an implementation shortcut.

## 9. Interface Behavior Rules

01. Interfaces may **request**, render, and relay. They may not decide: no local permission check is ever the only
    check (`SECURITY.md` §2 rule 02).
02. Optimistic UI is allowed for rendering only; task state always reconciles from `GET /tasks/{id}`.
03. Any interface can answer an approval started by another one, because the queue is shared state.
04. A client that loses its connection must keep working after reconnect: no task may depend on a live stream to
    finish.
05. Every interface shows which model + provider is currently answering, and flags a fallback switch (D-043) — the
    user always knows who saw their data.
06. Destructive actions confirm with a typed token on small screens where a checkbox is too easy to tap.
07. All four interfaces render the same `code`s from §6 with the same meaning, so scripts and support docs can
    name one error across surfaces.

## 10. Mobile and Tunnel Constraints

- Reconnect must assume a hostile network: on Termux, network switches (Wi-Fi ↔ mobile data) drop sockets, and
  Android may freeze a backgrounded process entirely. Therefore: short-lived streams, explicit resume by `taskId`,
  and no reliance on a connection to make progress.
- Battery: an idle interface must not poll aggressively. Default backoff when backgrounded, tightened further in a
  documented low-resource mode (`SECURITY.md` §12).
- Through a Quick Tunnel the public URL changes on restart: clients must discover the current URL from the Gateway
  rather than storing one permanently, and stale URLs must fail with an actionable error.
- Latency: typing on a phone is expensive. Command names stay short, ids are copyable, and defaults are meaningful
  so `crabby task run "…"` needs no flags for the common path.

## 11. Contract Testing

- **Contract tests** generated from the same schema the adapters use: each endpoint validated for every interface.
- **Parity test:** walk §8 and assert each row's capability is reachable programmatically per interface. A missing
  row fails CI, which is what keeps D-005 from rotting.
- **Reconnect tests:** simulated stream drop mid-task, inside and outside the replay window; assert gap handling and
  correct final state after reconnect.
- **Approval race tests:** two interfaces answering the same approval; the second gets `conflict`, and the action
  runs exactly once.
- **Idempotency tests:** replayed `Idempotency-Key` returns the recorded result without re-executing.
- **Auth tests:** expired/revoked token, wrong origin, unauthorized Telegram sender — all rejected before routing.
- Fixtures and fakes come from the `mock/fake` provider so no test depends on a live API (`SECURITY.md` §17).

## 12. Open Decisions

Recorded in `DECISIONS.md`: **O-004** and **O-010** are closed by D-048/D-049; **O-019** keeps only its pairing-UX
remainder; still open here: **O-009** remainder (tunnel lifecycle), **O-036** (doc checker in CI), plus:

Decided with this document's review round: transport (D-048) and replay semantics (D-049). Still open:

- **O-039** — URL scheme: `/api/v1` prefix vs header-based versioning.
- **O-040** — whether the Web UI is served by the Gateway or by a separate static step in `crabby web open`.
- **O-041** — approval expiry duration, and whether expiry is per tier (a T3 prompt should not age on the same
  clock as a T2 one).
- **O-042** — whether the §8 parity matrix is generated from the tool registry plus annotations rather than
  hand-maintained. Recommended, because a hand-maintained table is how drift starts.

## 13. Acceptance Criteria

01. Every capability in `PROVIDERS_AND_TOOLS.md` §4.2 appears in the §8 matrix with a real command per interface or a
    documented limitation.
02. The event envelope, `seq` rule, and gap-handling contract are agreed (D-049); retention *size* tuning stays open.
03. Pairing and revocation are specified well enough that no implementer invents a trust rule (D-030, D-051).
04. Error classes and codes are frozen enough to build a CLI exit-code convention against.
05. The Telegram adapter has no capability of its own: everything is expressible through §4 endpoints.
06. Tests in §11 exist before the second interface is written, so parity is proven, not asserted.

---

**End of Interfaces and API Specification**
