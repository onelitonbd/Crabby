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
| Base path | `/api/v1/...`, chosen in D-067 (closing O-039) over header-based versioning, because a path prefix is visible in a browser address bar, in a proxy log and in a `curl` example — three places a header is not. Breaking changes require a new version; additive changes do not. **The route tables here and in `docs/review/` omit the prefix on purpose**: every client builds URLs from a base URL that already contains it, so a path written in a table is a suffix, and nothing has to be re-edited when `/api/v2` exists. |
| Content type | `application/json; charset=utf-8`. UTF-8 is assumed everywhere — Bengali content is a first-class case, not an edge case. |
| Validation | Every body and query is schema-validated before routing; unknown fields are rejected with the field named. |
| Idempotency | Any request that can cause a side effect accepts `Idempotency-Key`; a replayed key returns the recorded result, never a second execution. |
| Correlation | Every request carries or receives `X-Crabby-Request-Id`, echoed in errors and audit records. |
| Errors | One envelope (§6); no stack traces, no provider bodies containing credentials (`SECURITY.md` §14). |
| Pagination | Cursor-based (`?cursor=&limit=`), ordered by stable id, so a list does not shift while a task appends records. A page defaults to 50 and may not exceed 200 (D-079); asking for more is a `validation` error naming the ceiling rather than a silent clamp, because a client that wanted 5 000 rows has a bug the server must not hide. |
| Concurrency | `If-Match`-style version tokens on config and session mutations, so two interfaces editing the same thing do not silently overwrite. Sessions carry one from D-104: every session answer has an `ETag` holding the row's `revision`, and `PATCH /sessions/{id}` refuses without a matching `If-Match` (400) or with a stale one (409, naming both numbers). Config carries one from D-107, and it is a hash rather than a counter: a file keeps no revision, and a counter stored inside `config.json` would be a field that is not configuration in a document `docs/DATA_AND_MEMORY.md` §4.1 says holds "Overrides only". `GET /config` answers an `ETag` holding sixteen hex characters of SHA-256 over the canonical document, and `PUT /config` refuses without a matching `If-Match` (400, `if_match_required`) or with a stale one (409, `config_stale`, naming both tokens). It is a compare-and-swap and not a transaction — a file has no isolation level — so the claim is that a silent overwrite becomes a refusal in every case a client can observe, and the document is checked against the schema *before* the token is compared, so a client told "stale" cannot re-read and resubmit the same invalid bytes. |
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
  revoked identity cannot keep acting on an open stream. **Both halves are mechanisms now (D-096).** The upgrade clause is
  satisfied by the transport's own rule — §5.1 makes every client action a plain HTTP request, so a stream is never
  anything but a read and there is no privileged moment left to re-check — and the open-stream clause is satisfied by
  termination: each `GET /events` subscriber records which identity opened it, and revoking that identity ends the stream
  with an `event: end` frame naming the reason before the socket goes.
- Managing identities requires `auth.manage` (`SECURITY.md` §6.1), which exists only on a local paired client. This
  is the single legitimate asymmetry in the parity matrix: minting or revoking identities from a network-facing
  interface would let a stolen remote token create a second one. It is recorded in §8 rather than hidden. Since the
  mint route began assigning capabilities, "only on a local paired client" is a property of the stored record and not
  only of the rule: `cli`, `tui` and `web` hold `auth.manage` and `telegram` does not (D-102). The routes still decide
  on the socket, for the reasons D-097 and D-102 give, and the grant is what replaces that decision once a route has a
  subject to ask.
- `crabby auth list` shows name, interface, created, last used, granted capabilities, and whether it is currently
  connected. "Granted capabilities" stopped being an empty list when pairing began assigning them, so the row is now a
  set an operator can read and compare against what `--restrict` asked for. `crabby auth revoke <clientId>` must be effective on the next request **and** must terminate live event
  streams for that client — asserted over a real socket in `tests/integration/gateway.test.ts`, which is the slice where
  the second half stopped being a `log.warn` (F-51). The "currently connected" column is the same binding read the other
  way: `GET /auth/clients` answers `liveStreams` per identity, counted by the live registry a revocation closes streams
  through, so the list and the control cannot disagree about who is watching (F-53). It is one number and not a number
  plus a boolean because `connected` computed from `liveStreams > 0` in two renderers is two definitions of the word — one
  fact, one place, which is the F-08 family of defect in a response shape.
- A Web UI session uses the same identity model: `crabby web open` obtains a short-lived pairing artifact for the
  browser rather than introducing a second, browser-specific trust mechanism.
- Remote (tunnel) clients use the same tokens. Enabling a tunnel lists which identities become reachable
  (`SECURITY.md` §13), because that is the moment a local identity becomes a network-facing one.
- Unauthenticated responses must not reveal which routes exist, and `GET /health` is authenticated too (it leaks
  too much about configuration to be public).

### 3.2 Pairing presentation (O-019 closed by D-067)

Token format and expiry are settled by D-051: an opaque random token with no expiry by default, since revocation is
the control and a phone cannot reliably run a rotation UX. The presentation question is answered the way the composer
question in the TUI is — by assuming nothing about a phone's clipboard:

- `crabby auth pair` prints the URL and the code **each on its own line**, with no other text on either line, so a
  long-press selects one of them without also selecting a sentence.
- The code is **8 characters** from an alphabet without `0/O` and `1/I`, typed once into the Web UI's first-run field.
  Short enough to read aloud, long enough not to be guessable at a few hundred attempts per minute against a
  single-use, short-lived record.
- The code is single-use and short-lived; the long-lived credential is delivered **once**, over the authenticated
  channel, and never written to a log, an audit payload or a diagnostic report (`SECURITY.md` §14).
- Failure text names the next action (`crabby auth pair` again), never a bare "invalid code".

## 4. Endpoints

Names below are the proposed contract; exact paths may be adjusted during implementation as long as capability
coverage does not shrink.

### 4.1 System and diagnostics

| Method + path | Purpose |
| --- | --- |
| `GET /health` | Liveness, version, uptime, listener mode (local/tunnel), vault locked state. |
| `GET /status` | Service readiness per subsystem: storage, scheduler, providers, extensions, tunnel, vault. A subsystem's `note` carries what its `state` cannot: the providers row is answered from the composition rather than from the build, so `ready` distinguishes an adapter a runner is built from — tasks this Gateway drives — from one nothing drives, where a task created over HTTP is recorded and stays `queued`. The scheduler row is answered from the same composition and for the same reason: `ready` when a timer is armed, `absent` when this process composed no runner to fire into, and the `absent` sentence names that condition rather than promising a milestone, because a job is a task that runs later and a Gateway that drives no tasks has nothing to run it with. |
| `GET /diagnostics` | Sanitized runtime report, safe to paste into a bug report: tasks, `runs` — whether a runner is composed and how many runs are in flight — `jobs`, and stream subscribers. `runs.composed` is a contract rather than a detail, because `crabby task run` reads it *before* it creates anything: an install that cannot drive a task says so instead of recording work nothing will do. `jobs` is the scheduler's own facts rather than a row count — `composed`, `rows`, `armed`, `openRuns`, `missedUnacknowledged`, and the soonest `nextRunAt` — because the case a user hits after an overnight kill is not "no jobs" but "an armed timer whose creator was revoked mid-job", and `missedUnacknowledged` is §4.5's sixth rule as a number: occurrences that passed while nothing was watching and nobody has answered for yet. |
| `POST /admin/shutdown` · `POST /admin/restart` | Graceful lifecycle; T3 (`config.write`). |
| `GET /logs?cursor=&level=` | Structured operational logs, redacted (built, D-133). Answers from the Gateway's ring buffer — the one the startup banner and every `log.*` line already feed, so a route that composed a second book would be a second opinion about what happened. `level` filters by the log's own ranking (`debug ≤ info ≤ warn ≤ error`, one exported rank so a route and the logger cannot disagree) and an unknown level is a named 400; `cursor` is the offset in the buffer, so a client that pages reads a stable window and `hasMore` says whether one exists; `limit` is bounded (1–500, default 200). The answer carries `records`, `cursor`, `hasMore`, `bufferLines` and `sortedBy: "ts"`. Redaction is not a parameter: §7's obligation is at the serializer, and a query key that could turn it off would be the copy §7 forbids. |
| `GET /audit?cursor=&taskId=&limit=` | Security-relevant records (`SECURITY.md` §14), built in D-133: one append-only row per security-relevant decision — `auth_attempt` (mint, redeem, revoke, and a rejection recorded by the guard before its 401 leaves), `approval`, `config_change`, `tool_invocation`, `extension_install`, `tunnel`, `job_delete`, `vault` (M5, D-139: the unlock/lock attempts and their outcomes — the passphrase never rides the row; schema v16 widened the kind list by that one word) — with the actor, the interface, the session and task it belongs to, the request correlation id, the outcome (`ok`/`rejected`/`error`) and a redacted detail payload written redacted or not at all. `cursor` is the last `aud_` id, `taskId` filters a task's rows, `limit` is bounded (1–500, default 100), and the rows answer in id order (`sortedBy: "id"`) because the prefix is time-sortable. The table has **no foreign key** on purpose: a revoked client or a deleted task must not take its history with it, which is the whole reason a trail and a live table are different tables. |
| `GET /whoami` | The paired client's own facts, built in D-133 (T5-06's capability line stops printing conservative defaults): the identity the token resolves to — `id`, `name`, `interface`, the capability **names** it holds, `createdAt` and `lastUsedAt` when one exists — plus the **tool surface** the composed executor actually declares (`fs` when a `fs.*` row is implemented, `net` when a `net.*`/`http.*` row is, `shell` when `shell.run` is). The surface comes from the executor, not from the identity's capability names, because the question a phone is asking is "what can this install actually do with me holding the token" and §4.1's availability is a fact about the process. No executor composed means no `surface` field and a `note` saying so — an absent fact is stated, never defaulted. |

### 4.2 Sessions and messages

Five of these paths are answered and four are not, and the split is D-104 plus D-112 rather than a milestone boundary: a
conversation became a *record* in schema version 6, and its turns became records in schema version 10 (D-112, which took the
owner through O-074). The four that remain read D-027's context manager — budget, compaction, pins — which does not exist, so
`GET /sessions/{id}` names them in an `absent` list (`["context", "pins"]`) rather than answering `0 turns` for a
conversation that has forty, and `crabby session show` stays planned for the reason C11-03's five fields still name three
that are not there.

| Method + path | Purpose |
| --- | --- |
| `GET /sessions` · `POST /sessions` | List and create conversations. The list is C11-01's: id, title, last activity, a state word, the model, and the interface that created it (W15-11), in last-activity order and not creation order — "that is the order a person remembers in" — with the order stated in the body as `sortedBy` so a client cannot infer it wrongly. `?origin=` filters on W15-11's four words and refuses any other (400). Creation answers **201** with a `location` and an `ETag`, and `{}` is a valid body because W15-03's new session "starts empty and un-named": the title is optional and its absence is a fact a row renders as `un-named`, never as a blank. The origin comes from the credential and is not a field of the body, because an attribution a caller declares is a claim — and the list is where a user notices "this appeared on its own". |
| `GET /sessions/{id}` · `PATCH /sessions/{id}` | Read one conversation with its tasks (bounded, with the true total beside them, for the reason a job's run history is bounded) and its `ETag`; rename it or move its model override. `PATCH` **requires `If-Match`** and refuses without it (400 `if_match_required`), because §2's concurrency row asks for a version token on session mutations and a title is the one field four interfaces can edit inline at the same moment (W1-02, W15-04, T16-05). The token is the row's `revision`, which counts *edits* and not activity: a task moving in a conversation touches its last activity without spending the token a phone is holding, so an inline rename does not fail because the agent answered a question while the user was typing. A stale token is **409** `session_stale` stating both numbers; a patch carrying neither field is **400** `session_no-change`; an unknown id is **404**. `model: null` clears an override and returns the session to the install's default, which is not the same act as setting it to the default's current value — the second pins a conversation to a model that stops existing when the default moves. |
| `DELETE /sessions/{id}` | **Not built, by decision rather than by sequence.** Destroying a conversation is `history.deleteConversation` at **T3** (`PROVIDERS_AND_TOOLS.md` §4.2), which C11-05 keeps as the one command that does it and W15-07 prices with the title typed back rather than "yes". A delete on this path would be a second route to the same irreversible act with no confirmation on it, and `packages/storage/sessions.ts` accordingly prepares no `DELETE` statement at all — the absence is in the code, so it cannot be reached by a route added later without a test noticing. |
| `GET /sessions/{id}/messages?cursor=&limit=` | §2.5's turns (D-112): a conversation's own history, one page at a time, in the order they happened, with each row keeping its role, its place (`ordinal`, from 1), when it was written, which conversation it belongs to and — where there was one — which task produced it. That is the four bullets §2.5 lists, and it is a table rather than the event log because the log answers *what happened* under D-065's per-task retention while a conversation outlives every task in it. `cursor` is the ordinal of the last turn a page carried, so a turn appended while a client reads cannot shift the page it is holding; `limit` is the route's bound (100), and a caller past it gets a named 400 rather than a page it did not ask for. The text is redacted on write (SECURITY.md §7), so there is no "unredacted" knob — a second parameter over the same bytes is a way to ask for the copy §7 forbids. A compaction's summary is a row in this list with `role: "system"` and a `covers` range (D-116), which is how §2.5's "must not silently replace or destroy original conversation records" is kept: the covered turns are still here, in place, and the summary is retrievable beside them rather than instead of them. `404` for a conversation nobody created and an **empty page** for one that has said nothing, because C11-03's sidebar has to draw both and a `404` for a quiet conversation would make "quiet" look like "gone". No summary field: §2.5's "generated summaries must not silently replace or destroy original conversation records" makes a summary another record, and D-027's compaction is what writes one. |
| `POST /sessions/{id}/messages` | Add a user message; returns `messageId` and the resulting `taskId` when a task is implied. **Not built,** and deliberately not by accident of the store: D-112's one writer is the loop, inside the phase that completes a task, and a route that wrote a turn would be a second writer of a conversation's history (§9's one-writer rule, and the reason a store with an HTTP write path is a different product). Until it is, `POST /tasks` is the way a question enters a conversation, and it names the conversation in its `sessionId`. |
| `POST /sessions/{id}/compact` | Ask for compaction now rather than at the budget limit (D-027, D-118). **Built**, and it calls the same `createContextManager` the loop calls before every provider request — D-113's "the same act asked by hand", made literal rather than aspirational. Three answers in one body, because a client handed a 200/204/409 triple has three ways to be wrong about one fact: `not-needed` (with the estimated cost and the threshold beside it, §3.4's label included), `compacted` (the summary row and the `covers` range it stands in for, plus the count), and `refused` with one of three named reasons — a refusal about the *conversation* is a 200, because a user pressing a button deserves to be told which applies. Two refusals that are **503** because they are about this process rather than the conversation: `summarizer-unavailable` and a summarizer that failed after D-115's retry (the latter `retryable`). A conversation nobody created is **404**; a model nobody can describe is **503** too (§3.2 disables it). The capability is `session.write` with no extra prompt, the owner's call (D-118), and no `If-Match`: the act appends a row rather than editing the session, so there is nothing for a stale revision to lose. The cheap read comes first — a length, not a read — so a conversation that fits costs one aggregate and nothing else. |
| `POST /sessions/{id}/export` · `POST /export` | Render a sanitized export (`json`, `md`, or `jsonl`) and return a download handle for the artifact, which lives in a temp directory with the §5.2 output caps. `history.export` is T2, so this route creates a task-shaped action rather than streaming bytes blindly (`PROVIDERS_AND_TOOLS.md` §4.2). |
| `GET /sessions/{id}/context` | Current working-context view: what is in budget, what was compacted, what is pinned (D-119). **Built.** The three questions a user asks before trusting a long conversation, in the order they ask them: the conversation's estimated cost with §3.4's label and the window, reserve, budget, threshold and the configured fraction beside it; every compaction it has had, each with its summary row and the range it stands in for; and the pinned ranges, collapsed so a screen can print them. `budget` is **absent** when the conversation's model cannot describe itself (§3.2) — an absent budget says that, where a zero would say the window is empty. `sections` answers C10-01's "each section with its cost" with three costs — what a compaction replaced, what is pinned, and what would actually be sent — each carrying **characters as well as tokens**, because C10-05 asks for "byte counts and budget headroom in machine form, so a cron wrapper can stop filling a session it cannot see" and a heuristic's token count is not a byte count (D-120). The three are a **partition** of the conversation, so their costs add up to the whole and a client renders "3,200 of 5,734" without knowing the formula; a summary row counts as *current*, because it is the newest thing in a conversation rather than a thing a compaction replaced. `absent` names what this route does not answer (§8.1's "review or correct retained memories and summaries") rather than returning empty arrays for them, the same rule `GET /sessions/{id}`'s `absent` list follows. A read costs one pass of three integers per turn and never a model call. |
| `POST /sessions/{id}/pin` | Protect important context from compaction (D-119, §8.1). **Built.** The body is a range of **ordinals** — `{ from, through }`, and `from === through` is one turn — because ordinals are what `GET /sessions/{id}/messages` prints, and a protection a person cannot check against the transcript is one nobody will trust. The capability is `session.write` with no prompt (D-118's answer, applied to the same kind of button), and there is no `If-Match`: pinning changes which turns a *future* compaction may cover, never a turn's content, so two interfaces pinning at once lose nothing and the flag is idempotent per turn. **What a pin means was the owner's answer too, and it is the strict one: a pinned turn is sent as it is and is never summarized, not even "in part" — a pin whose content survives only as somebody else's summary of it is not protection. So a conversation whose pins crowd its budget is refused with `verbatim-exceeds-budget` rather than quietly trimmed. Re-pinning a pinned turn answers `0 changed` and is not a failure, because that is how a client retries safely. A range naming no turn of this conversation is **400** `session_pin_range`, naming the range that does exist. |
| `DELETE /sessions/{id}/pin/{messageId}` | Stop protecting a turn (D-119). **Built**, and by turn **id** rather than by range: removing a range would have to guess whether it means "everything in it" or "what I added", and a wrong guess there silently protects or drops turns the user did not name. Unpinning something that is not pinned is **409** `session_pin_not_set` and an unknown turn is **404** — two different answers, because one is a wrong turn and the other is nothing to undo. |

### 4.3 Tasks, events, approvals

| Method + path | Purpose |
| --- | --- |
| `POST /tasks` | Create a task. Body: objective, optional session, **model pin** (accepted since D-108, and since D-110 it resolves against every composed provider: a `<provider>/<modelId>` pair may name any provider this Gateway composed, and a pin no composed provider answers to is refused with 400 `invalid_model_pin` naming this section and listing the composed ids), capability narrowing (**not built** — no field in the body carries it, F-57), schedule (**not built** — it needs the T2 approval only `cron.schedule` can open, D-084). Idempotency key required. |
| `GET /tasks?state=&sessionId=&cursor=` | Filtered listing. |
| `GET /tasks/{id}` | Authoritative current state (the fallback a client uses after a missed event). |
| `GET /tasks/{id}/steps` | Step-level plan and outcomes. |
| `POST /tasks/{id}/cancel` | Cancellation request; returns `cancelling` and, once settled, the terminal state (`ARCHITECTURE.md` §10). Body `{ mode?: finish-step\|immediate, reason? }`, both optional because the manager defaults to `finish-step` and a stop button that had to name a mode would be a form rather than a button; `mode` is what makes §6.2's override reachable over HTTP at all, and an override nobody can ask for is advice. No `Idempotency-Key`, deliberately: the manager already answers a second request for one task with the request it recorded, and a second request that escalates to `immediate` is §6.2's override rather than a replay, so a key cache would have to choose between those two readings and would get one of them wrong. A task with nothing in flight settles at once — `queued`, and `awaiting_approval` too, because a prompt is not an execution step — so the answer is already `cancelled`, carrying §6.2's evidence on the record (`inFlight: "none"`, `effectsUncertain: false`) beside §14's `by`. A task with something in flight answers `cancelling` and settles when its run stops, which needs the task handoff this build does not have (F-52). Refusals: `404` for a task nobody created, `409` for one already terminal (§4.1's three terminal states are absorbing, and the manager's own sentence says so rather than a route rephrasing it) and for a settle asked of a task nobody requested a cancellation for. `task.cancel` (`SECURITY.md` §6.1) is the capability that decides who may stop a task and is enforceable by nothing here — no code writes `Identity.capabilities`, so the control is the token the guard demanded before the route ran (F-52). |
| `POST /tasks/{id}/resume` | The answer to both kinds of pause, and the route the §8 matrix row already named. Two positions share it and the **record** tells them apart, never the caller: a task in `awaiting_approval` is a park this process holds (D-044's ask with no row behind it, or D-086's refusal pause with one), and a task in `interrupted` is a park a process that has ended was holding — rebuilt rather than continued, because nothing is left in memory to continue. The loop reads D-065's boundary back and drives from it, with the objective *not* prepended again, because a second copy of the opening sentence would be a second instruction in the conversation; D-065's verdict is read in the **runner**, so no route can rebuild work the runtime would not have permitted (`409 resume_re-ask` is refused with the verdict's own sentence, and no interface has priced a *resolution* for that case yet). A rebuilt run belongs to the identity `origin` names and never to the identity that answered: the route looks that client up so §13's revocation applies to a restart the way it applies to every other request, and a revoked creator is refused (409) rather than inherited — the answerer is recorded beside the continuation as §14's `by`/`via` (F-47, D-111). Body `{ model? }`: an answer with **no** pin continues on the model the run was using, which is a real answer rather than a missing one — the budget was spent and the same model may well succeed on a fresh attempt — and is the only answer a single-model install can give. A pin names the model to switch to, is validated against **the same pool the ask was built from** before anything moves (`400 invalid_model_pin` otherwise), and the answer's own `provider` is resolved here, at the gate, because D-101's rule is that the caller resolves and the loop is handed what it answered with. A switch records on the task what `PROVIDERS_AND_TOOLS.md` §3.6 stage 3 requires: `model` becomes the chosen pair and `modelSwitch` carries the original pair, the reason, `stage: 2`, `reAttempted: false`, the attempts the ladder spent, and §14's `by`/`via` beside it — and `provider.switch.accepted` goes into the log, because §3.6 counts the selection as the user's approval for that switch. The run continues from the boundary it had reached: no committed step is issued to a provider twice. Refusals: `404` for a task nobody created, and for an `interrupted` task with no committed boundary (nothing was saved, so there is nothing to continue); `409` for a task in neither position (`queued` says it has not run far enough to have spent a budget, and a terminal state is absorbing); `409 approval_pending` when the task is waiting on an **approval** — the row is how a client tells a prompt from D-044's ask, which parks in the same state with nothing behind it — naming `POST /approvals/{id}/decision` as the route that answers this one; `409 no_runner` on a Gateway that composed no runner; `409 resume_not-asking` for a model named against a run parked at an approval. **What it still cannot do, stated rather than implied:** it cannot *spend* an approval a dead process opened. SECURITY.md §7 keeps `call.args` out of the checkpoint on purpose, so a continuation re-plans and asks again rather than executing the action a still-pending row covers — which is why the F-47 scenario ("a user answers a prompt on their phone and the action never runs") now ends with a fresh prompt rather than with the old one signed. `SECURITY.md` §6.1 names no capability for this act and none is invented: the control is the token the guard demanded plus the record the runtime holds, the same substitution `POST /jobs/{id}/pause` and the approval decision route make (F-52). What moves an *unanswered* ask is not priced by any document — no act declines it and no timer expires it — so a user who wants the task to stop cancels it; `DECISIONS.md` O-073 carries that as the open question it is, and the body schema has no field for it on purpose. |
| `GET /tasks/{id}/events?cursor=` | Historical events for a task; replay window is per-task and count-bounded (D-049). |
| `GET /approvals?state=pending` | Approval queue for this client. `state` defaults to `pending`, the only state a client can still act on, and an unrecognised value is a `400` that names the five — a filter that silently matched nothing would show an empty queue where a prompt is waiting. `serverTime` rides along so a client with a skewed clock renders the same countdown as the surface that decides expiry (§6.3). The read sweeps first (D-093): a deadline that passed while nobody was looking expired the row by the clock and not by anybody's opinion, and a queue that still showed it as `pending` would be the count `crabby status` prints as "N waiting". |
| `POST /approvals/{id}/decision` | `{ decision: approve\|deny, scope: once }`. Only `once` exists in the first release for T2/T3 per `SECURITY.md` §6, and the refusal of anything else is the arbiter's sentence citing D-052 rather than a schema error, so it arrives from an interface and not from a validator. An answer that is late, already recorded, or signed from a surface §6.2 excludes is refused — `409` for the first two, `403` for the last — and the row is left where it was unless the refusal itself moved it (a late answer expires it, and says so in the log). `Idempotency-Key` is accepted, not required. **The answer is spent, not only recorded:** the body gains `resumed` and `note`, because the route wakes the run that parked on the prompt after its transaction commits and after the `approval.answered` event is published, and a client has to be able to tell "the run continues" from "nothing in this process was parked to wake" — the three cases that answer `false` are a Gateway with no runner, a run parked in a *previous* process (§8.2 keeps `call.args` out of the checkpoint, so D-065's verdict is `re-ask` and F-47's route is still absent), and a run already moving, and `note` carries the Gateway's own sentence for whichever it was. Both decisions wake it: an approval executes the gated step once, and a denial becomes the step's result so the run continues or ends on it rather than waiting for an answer already given (`AGENT_RUNTIME.md` §5.2, `docs/CONSISTENCY_REVIEW.md` F-58). |
| `GET /tasks/{id}/checkpoint` | Checkpoint view for recovery transparency (D-065's boundary, D-095's shape): the step it was committed at, the kind (`step`, or `prompt` when the run is suspended at an approval), the sequence number it was written against, the model, the record's size in bytes and its message count, the pending gated step when there is one, and D-065's verdict — `resume`, `pass`, `re-ask` or `none` — with the reason beside it, so a client can render *why* a task is paused instead of guessing from its state. The working context itself is not in the body: it is redacted on write, §8.2 counts a checkpoint as a different category from the conversation record, and the party that resumes reads the record from the store in its own process rather than over a route. A task that never committed a boundary answers `404` with the verdict's reason in `details`, so "no saved state" and "no such task" stay different responses. |
| `GET /jobs?state=` · `GET /jobs/{id}` · `PATCH /jobs/{id}` · `DELETE /jobs/{id}?history=` · `POST /jobs/{id}/pause` · `POST /jobs/{id}/resume` · `POST /jobs/{id}/run` · `POST /jobs/{id}/backlog` | Scheduled jobs (`PROVIDERS_AND_TOOLS.md` §4.5, D-046/D-057) — the whole surface except creation. There is no `POST /jobs`, because `cron.schedule` is the one path that creates a job and it is a T2 call whose arguments the user approved: a route that created one would be a second creation path with no approval anywhere in it, which is the shape C12-09 refuses for `crabby job create` and the reason F-57's `schedule` field on `POST /tasks` is still unbuilt rather than quietly built here. `GET /jobs` answers from the table whether or not this Gateway composed a scheduler and says which (`driven`, with the reason in `note`), because a list that hid the jobs a user has would hide them best exactly when a provider broke; each row carries the next fire rendered in the zone the schedule is evaluated in (`nextRunLocal`, D-103), the state word C12-01 and W16-02 both ask for, and the last run's outcome, so a list costs one request rather than one per line. `GET /jobs/{id}` adds a bounded run history and the unacknowledged `missed` rows C12-06 asks about, on the same answer, because a user deciding what to do about a backlog should not have to ask twice. `PATCH` takes the non-material half only — `name` and `schedule`, with `objective` absent from the body schema rather than refused by a handler, so "change what it targets" is a named `400` quoting §4.5's re-approval rule and the statement has no column to rewrite the approved thing with. `pause` and `resume` answer with the scheduler's own sentence: a pause lands before the next tick while a run already in flight keeps going and is stopped through `POST /tasks/{id}/cancel` (§4.5's "cancellable like a task"), and a resume re-evaluates the creating identity's *current* capabilities against the ones the job recorded rather than restoring the old intersection (D-054), so a revocation is not undone by a timer. `run` is C12-04's explicit run outside the schedule — a fresh policy evaluation, never a replay — and answers `201` with a `location` naming the task it created, so the client that asked can follow it and exit `3` at an approval. `backlog` is §4.5's sixth rule as a verb: `{ action: latest\|each\|skip }`, required because two of the three fire work and a default would be the choice that runs a burst nobody was told about; `latest` fires one run for the most recent missed occurrence and acknowledges the rest, `skip` acknowledges them and fires nothing, and `each` (D-133) fires the earliest now and leaves the rest as the queue the scheduler's own tick drains one run at a time — each next occurrence only after the one before it settles, so the no-burst rule is the drain's own precondition, and `skip` retires whatever the chain has not reached (T17-07/W16-08/C12-06's three-way answer is what the rows say it is). Either way the answer is written onto the rows it covers rather than replacing them (D-065). `DELETE /jobs/{id}` (T17-05/W16-11, D-133) removes the row and refuses a job whose run is still open — a schedule does not abandon running work — and answers `{ deleted, historyKept, note }`; `?history=delete` is the explicit ask that takes the run history too, because the default keeps it: work that already happened is D-065's record, and a delete that erased it by default would be the audit trail erasing itself. The deletion writes §14's `job_delete` row, since an audit log that lost the fact of a deletion to the deletion would not be one. A Gateway that composed no scheduler still answers a delete through the store — a delete arms no timer, so the party `pause` needs is not the party this needs. Refusals: `404` for an id nobody created, `409` for a paused job asked to run, a creator whose identity was revoked and a run already open, `400` for an expression the parser cannot read or one with no occurrence left inside the bounded search, and `501` with class `platform-unsupported` for any write on a Gateway that composed no runner to fire into. `SECURITY.md` §6.1 names no job capability, so these routes are gated by the token the guard demanded and nothing else — the same substitution `auth.manage` makes with the socket, recorded by F-52 rather than papered over with a capability the table does not define. |

### 4.4 Providers, models, memory, extensions, config, tunnel

| Method + path | Purpose |
| --- | --- |
| `GET /providers` · `POST /providers` · `DELETE /providers/{id}` | Manage provider entries, including user-defined OpenAI-compatible ones (D-041). Credentials are write-only references to the vault. |
| `GET /models?provider=` | Models with effective capability descriptors, `reported` vs `overrides` visible side by side (D-045) — and the stored record and its provenance beside them (D-134), with a D-100 disabled entry named rather than hidden. |
| `PUT /models/{provider}/{model}/overrides` | Capability override; T3. The body is the answer shape D-127 records — `supports` values are `"true" \| "false" \| "auto"`, `clear` removes the record — and the write is `crabby model edit`'s own storage step (D-134), under the same `If-Match` rule `PUT /config` follows. Refusals have their own codes: `provider_unknown`, `model_unknown` (D-126 ignores a record for an undeclared model, so the route refuses to create a dead key), `override_unparsable` (a conflict that offers the clear). The answer's `changes` say what the effective descriptor moved, and `composed: false` names composition's own refusal beside the written file. |
| `POST /models/{provider}/{model}/probe` | Run the conformance probe and report which claimed capabilities actually answered. |
| `GET /tools` | Registry with tier, capability, and platform availability, merged with the composed executor's §4.1 fields; drives the parity matrix in tests. `runtime.implemented` is the count of rows an executor in *this* process declares, so it answers 20 on a Gateway that composes a runner — seven file rows, `net.fetch`, `http.request`, the three `memory.*` rows (D-136), the two `config.*` rows, `cron.schedule`, the two conversation rows and the three `task.*` rows — and 7 on one that does not, and the three task rows are answered by an executor whose sinks are this Gateway's own acts rather than a second copy of them (D-105). The two `shell.run` rows merge when the install opted in (`shell.enabled`, `crabby init --enable-shell`) and pend with all five runtime fields otherwise, so the count moves by rows rather than by declarations: one shell declaration answers both records. |
| `GET /memory` · `POST /memory` · `PATCH /memory/{id}` · `DELETE /memory/{id}` | Review, correct, and delete long-term memory (D-019). `GET` answers entries with `trust` — provenance read as a word (D-073), never a percentage — beside the pending queue's counts (W8-06). `POST` saves; `status: "pending"` is the only way a row starts proposed, because a memory written silently is a personality change nobody approved. `PATCH` takes corrected text and nothing else: W8-03 makes a user edit authoritative, so the store re-attributes the entry to `stated`/`user`. `DELETE` is `crabby memory forget`'s line rendered — the answer carries the entry and the references that named it. `GET /memory/{id}` is W8-08's preview (entry + references) a client shows *before* committing the delete, and `POST /memory/{id}/review` is the pending queue's one exit: `approve` activates, `reject` deletes and carries what was removed, and a review of anything not `pending` is `409 memory_not_pending` — an active entry needs no approval to be what it already is. Refusal codes: `memory_unknown` for an id nobody saved (a forgotten entry stays forgotten). |
| `GET /memory/search?q=` | Text search only in the first release (D-021), and the answer's `note` says so rather than pretending to be semantic. FTS5 over the authoritative rows; the index rebuilds from them, so it can never become an undeletable second copy (D-065, §2.4). |
| `GET /extensions` · `POST /extensions/validate` · `POST /extensions/install` · `DELETE /extensions/{id}` | Extension management against `EXTENSIONS.md` §5–§6, including `dryRun` validation. |
| `GET /extensions/{id}/reports` | Conversion report history and update diff (D-039). |
| `GET /vault` | §3.7's status: which store this device has (`keychain` / `file`), its state (`unset` / `locked` / `unlocked`), entry *names* when unlocked, and the §7 disclosure note when the encrypted file is the store. Names only — a status that carried values would undo §7 at the read. |
| `POST /vault/unlock` · `POST /vault/lock` | Open/close the Gateway's in-memory vault session (D-139). The passphrase rides the body once and is written nowhere — not the trail (the `vault` audit row records the attempt and its outcome), not a log, not an event. Unlock re-composes the provider list in place and the answer carries the per-entry decisions plus the runner sentence: composition is hot, the runner is not — a Gateway that started locked has no runner until `crabby gateway restart` arms one. A vault that does not exist yet is `409 vault_unset`: the create belongs to `crabby vault set`, where a person picks the passphrase. |
| `GET /config` · `PUT /config` · `GET /config/schema` | Configuration with the validation contract exposed. `GET` answers two views of one file — `file` is what the document says and is what `PUT` replaces, `config` has D-074's defaults folded in, so a client can tell an override from a default — with §2's token as the `ETag`, the resolved `limits`, the problems `loadConfig`'s rule 2 kept beside the usable part, and the dotted paths whose values were withheld, because `PROVIDERS_AND_TOOLS.md` §4.2's `config.get` row is secret *names* only and never values (D-107). `PUT` takes the whole document and requires `If-Match`; its answer carries `changed`, which is also the restart flag, because this Gateway composed its providers, roots, limits and egress allow-list at startup and a write is therefore a fact about the next start. `GET /config/schema` serves the same JSON Schema `crabby config schema --json` prints (D-060), so a client can validate before it writes instead of learning from a 400. |
| `POST /tunnel` | Enable remote exposure; T3 — the body carries `confirm: true` (the flag the interfaces' approval text ends in, after it lists the paired identities that become remotely reachable), and a body without it is `400`, because a tunnel that started on an unconfirmed request would be the one T3 the wire could flip by accident. The answer carries the fresh URL (§13: discovered, never assumed — it changes on every start and nothing redirects the old one) and the reachable-identity list. A tunnel already `ready` or `starting` is `409 tunnel_active`; a child that never produces a URL is `tunnel_start_failed` with the child's last words. `system.tunnel.started` publishes on the bus; the `tunnel` audit row records start and stop. |
| `DELETE /tunnel` | Revoke exposure (§13: fully — the child's process group is signalled, D-066's 5 s drain before the kill, so nothing listens after the decision). Idempotent truth: a second stop is `404`, because nodding would hide the state the caller thinks they are changing. |

### 4.5 Clients and pairing

| Method + path | Purpose |
| --- | --- |
| `POST /auth/pair-codes` | Mint a one-time pairing code for a named identity (`{ name, interface, restrict? }`), answering 201 with `{ code, clientId, expiresAt, capabilities }`. Requires a token *and* a loopback request: §3.2 forbids taking a code from an unauthenticated network caller, so the route that creates one is where both conditions apply. This is where an identity's capabilities are assigned, which is F-52's first two questions answered: the baseline is `SECURITY.md` §6.1's vocabulary for the interface, less the two §9 shell capabilities that no fresh install holds, less the two §6.1 marks local-only that `telegram` — the one v1 interface whose requests do not originate on the Gateway's own host — does not hold, so a remote client never receives a wider set than a local one (§5.3). `restrict` narrows that baseline and can only narrow it (D-054: a restriction removes capabilities and never converts one into an approval the restricted client must answer), so `restrict: ["shell.run"]` is a 400 naming the rule and not a way to enable the shell; an unknown name is a 400 naming the vocabulary, and so is an empty list, because a restriction that names nothing is not a restriction and an identity holding nothing can only fail. The whole mint is refused rather than part of it honoured (§2's rule 03), since a silently dropped name would hand back an identity other than the one asked for and the operator would learn about it from a later tool call. `auth.manage` is now a real property of the record — held by `cli`, `tui` and `web`, withheld from `telegram` — and is still enforced by the socket rather than by the grant, for the two reasons D-102 states. The response carries the set because the call that created the identity is the only one that knows it without a second read: `crabby auth pair` prints the count, `crabby auth list` prints the names, and a refusal's fix text names §6.1 rather than `--help`, which does not hold the vocabulary. A dot-less name in `restrict` is a family, and the mint route expands it to every name in that family the baseline holds — the shorthand §13 writes its example in — so `["config"]` mints `config.read` and `config.write`. Expansion is a shorter way to narrow and never a way to widen, which is why `["shell"]` is a 400 naming §9 rather than a 400 naming the vocabulary: no baseline holds that family, so there is nothing for the intersection to narrow to. |
| `POST /auth/pair` | Redeem a code for `{ clientId, token }`. The only route that answers without a token — it is how a client with no credential yet gets one — bounded by the code's 120 s TTL and single use (D-079). Failure text names the next action, never a bare "invalid code" (§3.1). |
| `GET /auth/clients` | Paired identities: name, interface, created, last used, granted capabilities, and `liveStreams` — how many open event subscriptions that identity holds, which is how "whether one is currently connected" is carried (§3.1, F-53) and how a client can name what a revocation will end before it ends it (`docs/review/TUI.md` T14-03). Token *and* loopback since M2j (D-097): this list is the map of what a stolen token could revoke, so it is not a read a network-facing caller gets for free. |
| `DELETE /auth/clients/{id}` | Revoke by deleting the identity. `DATA_AND_MEMORY.md` §4's client table has no revocation column, and the durable "ended on this date" record belongs in §14's audit table — O-071 keeps that from being forgotten. Local only, because `auth.manage` is a local capability: the guard is `requireLoopback` (D-097) until the grant model exists (F-52), and a revocation ends that identity's live streams before it answers, replying 200 with `{revoked, streamsEnded}` — the count rather than an empty 204, because C8-10 in `docs/review/CLI.md` asks the command to print it (§3.1, D-096). |

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
- SSE responses must disable proxy buffering (`X-Accel-Buffering: no`) and stay correct behind a Cloudflare tunnel. Interval: 15 s (D-079) — under D-074's 45 s idle-stream timeout on purpose, so a connection that
  has gone quiet is demonstrably alive rather than merely slow, and a phone that sleeps for a minute still sees two
  beats before anything declares the stream dead.

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
| `approval.*` | `requested`, `answered`, `consumed`, `expired`, `re-requested` |
| `provider.*` | `retry.scheduled`, `retry.attempt`, `switch.proposed`, `switch.accepted` (feeds the §4.3 ladder) |
| `extension.*` | `validate.started`, `validate.completed`, `installed`, `suspended`, `uninstalled` |
| `system.*` | `ready`, `shutting-down`, `restarted`, `tunnel.started`, `tunnel.stopped`, `vault.locked`, `vault.unlocked` |

Rules:

- One event per state change, and one state change per event. `approval.consumed` exists because the row's fifth state
  is a change of its own: reusing `answered` for it gave a client two identical frames for one decision, with nothing to
  say which had happened (F-42).
- Payload size cap with a truncation marker; large tool output is referenced by id, not inlined.
- Events are informative records, never authorization grants (`ARCHITECTURE.md` §7).
- Anything a client must act on (approval request, cancellation settled, task terminal state) must also be
  retrievable by polling `GET /tasks/{id}` — a client that missed the event must still see the truth (§5.4). The
  cancellation half of that rule is met in both places: `task.cancelled` carries `AGENT_RUNTIME.md` §6.2's evidence in its
  payload, and `TaskRecord.cancellation` carries it on the record, so a client that reads only `GET /tasks/{id}` learns
  whether the operation stopped and whether an external effect is in doubt (D-091, closing F-46).
- A cancellation *request* needs no event type of its own: it is a move into `cancelling`, so it travels as
  `task.state.changed` with the mode, the requester and the reason in the payload, and `task.cancelled` is the settle
  (§6.1's steps 1 and 6).

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
- The window is **200 events per task** (D-079), which is exactly one maximum-size page: a client reconnecting after
  any list fetch it could have made can be caught up in a single round trip, and a gap is therefore a statement about
  the tail rather than about how long the client was away.
- Two named control frames share the channel with events and carry no `id:`, because neither is an event and neither is
  replayable — a `Last-Event-ID` pointing at one would be a cursor into an instruction to go and fetch the truth. `gap` is
  §5.4's outside-the-window marker (`{gap: true, stateAt}`); `end` is the Gateway's last word before a socket *it* chose to
  close goes away, carrying `end`, a `reason` of `revoked` or `shutdown`, an `at`, and the schema version. The frame exists
  because the rule two lines above this one is a client rule — a stream that stopped is a stream to reconnect — and
  silence after a revocation would be that rule working as designed against the person it is meant to protect (D-096). A
  stream the client hung up on receives nothing.
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

The mapping is a table, not a convention, because two Gateways choosing two different statuses for `policy` is a
difference a client can only discover by breaking (O-066, closed as D-077):

| Class | Status | Why this one |
| --- | --- | --- |
| `validation` | `400` | The request was malformed; nothing about the server's state is implied. |
| `auth` | `401` | Pairing or the token is the problem, and `WWW-Authenticate`-style advice belongs in the body. |
| `policy` | `403` | A refusal, not a mystery: `402` is unused in practice, and what to do about it (answer the approval) is in `details`. |
| `not-found` | `404` | One answer for an unknown path and an unknown id, so probing reveals nothing. |
| `conflict` | `409` | The request was fine and the state was not — an `Idempotency-Key` reused with a different body is the case. |
| `rate-limit` | `429` | Retryable by definition; `retryable: true` and the body's wait time are the client's whole instruction. |
| `provider` | `502` | Upstream failed on our behalf; the caller's request was correct, which `500` would misattribute. |
| `resource-limit` | `507` | The one class where repeating the identical request after freeing space is the documented fix (D-064's caps). |
| `platform-unsupported` | `501` | "This device cannot", distinct from "you sent it wrong" — the same line D-074 draws between `timeout` and `failure`. |
| `internal` | `500` | Everything else, with a message that never carries a stack trace. |

`packages/gateway/errors.ts` holds the map and `tests/integration/gateway.test.ts` asserts all ten rows as one object,
so a re-ordering is a test failure rather than a client surprise.

## 7. Interface Mapping

### 7.1 CLI

Non-interactive, scriptable, and the reference implementation of the command grammar.

Conventions: `crabby <noun> <verb> [args] [--flags]`; `--json` for machine output on every read command; exit
code `0` success, `1` failure, `2` usage/validation, `3` needs-approval, `4` platform-unsupported. Output must be
pipeable and free of color when not a TTY.

| Area | Commands |
| --- | --- |
| Setup | `init`, `doctor` (`--security` prints the plain-language posture summary — M5), `status`, `version` |
| Chat | `chat "…"` (one-shot), `chat --session <id>` |
| Tasks | `task run "…"`, `task ls`, `task show <id>`, `task watch <id>`, `task cancel <id>`, `task resume <id>` |
| Approvals | `approval ls`, `approval approve <id>`, `approval deny <id>` |
| Providers | `provider add/list/remove`, `model list`, `model edit <p>/<m>`, `model probe <p>/<m>` |
| Auth | `auth pair`, `auth list`, `auth revoke <id>` |
| Vault (§3.7, M5/D-139) | `vault status`, `vault set <name>`, `vault get <name>`, `vault list`, `vault delete <name>`, `vault unlock`, `vault lock` — all ready; passphrase and value arrive on stdin, never argv, and `get` is the one surface that prints a value |
| Config | `config get/set/path/schema` |
| Extensions | `ext init`, `ext validate`, `ext check-compat`, `ext install`, `ext list`, `ext info`, `ext update`, `ext uninstall` — all ready except `ext update` (C-E10's show-the-diff-before-replacing needs the source re-run) |
| MCP (client only, D-040) | `mcp add <file>` — the C-2 import: names kept, env/header values dropped, report written, nothing approved by the act; `mcp list`; `mcp restart` stays planned until a runtime connects automatically (§10) |
| Interfaces | `gateway start/stop/restart/status`, `web open`, `telegram start`, `tui`, `tunnel on/off/status` — the tunnel verbs are **ready** (M5): `tunnel on` is the T3 prompt listing the reachable identities (`--yes` for scripts), `tunnel off` revokes the child for real, `tunnel status` reads the live state from the Gateway rather than remembering a URL |
| Data | `history export`, `history delete-session`, `memory list/search/forget`, `logs`, `audit` |
| Context | `context show <id>`, `context pin <id> [ref] [--remove]`, `session compact <id>`, `tools ls` — C10-01/C10-02/C10-05 (D-120) |
| Sessions | `session ls [--origin I] [--quiet]`, `session new [--title "…"]`, `session rename <id> "…"` — all three **ready** over §4.2's four paths (D-104). `session show <id>` stays **planned** for the release that stores messages, because C11-03's content is five fields and three of them (turns, budget, pinned items) need a message store and D-027's context manager; the dispatcher answers it from its registry row rather than the verb printing zeroes. Deletion stays `history delete-session`, so there is one destructive verb and no `session delete` (C11-05) |
| Jobs | `job ls`, `job show <id>`, `job pause <id>`, `job resume <id>`, `job run-now <id>`, `job backlog <id>`, `job edit <id>` |
| Diagnostics | `diagnostics` — writes the sanitized report and prints where it went |

Rule: `crabby --help` and `crabby <noun> --help` are generated from the same contract that the Web UI and Telegram
use, so a command cannot exist in one interface only (the D-005 test). Shell completion is generated from that same
registry in v1, and there is no man page (D-063, closing O-063) — a second reference surface is a second way to be
wrong.

Three CLI behaviors were open questions until D-063 closed them, and they belong to this contract rather than to the
terminal:

| Behavior | Contract |
| --- | --- |
| `task run "…"` | **Blocks**, printing `task <id>` and a reattach line first, so a dropped SSH session loses nothing. `--detach` is the script path. The reattach line names `task watch <id>`, not the `task resume <id>` this row once promised: resuming an interrupted run is F-47’s absent route, while reattaching to a live one is what `watch` has always done, and printing a command that answers `not implemented yet` is worse than printing one that works. Two refusals belong to the row now that the verb exists — an objective is required (exit `2`), and a Gateway that composed no runner refuses to create a task nothing would drive (exit `1`, answered from `runs.composed` before the POST). A run that parks at an approval exits `3` and names the command that answers it, which is the row below this one. The exit code is the run's outcome and not the stream's: `completed` exits `0`, a task that ended `failed`, `cancelled` or `interrupted` exits `1`, and a stop at an approval exits `3` — a verb that blocks has to answer with what happened, or a script reads a failure as a success. `--detach` returns at creation with exit `0`, follows nothing, and renders one document in `--json` rather than a record beside a summary. |
| `task watch <id> [--types <a,b>] [--json]` | **NDJSON**: one event per line, each carrying the per-task `seq` (§5.4) so a script notices a gap the way a browser does. A `--json` snapshot stays one document. `--types` narrows what is *printed*, matched the way D-048's query matches — an exact type, or a prefix ending in a dot, so `task` follows `task.state.changed` — while the events that end a task are requested whatever the filter names, because a watch that could not see its own ending would hold a stream open forever. An empty filter is **exit `2`**, answered without consulting the Gateway. A read reports its subject's outcome rather than inheriting it, so watching a task that ended `failed` exits `0` with the state on the record and on every line — the rule `task show` follows, and the reason `task run` is the verb whose exit code is the outcome. |
| `task cancel <id>` | **Asks, then reports** — it never claims a stop it did not see. Default mode is §6.1's finish-the-current-step; `--mode immediate` is §6.2's override and `--reason R` goes on the record with the request. `cancelling` prints as *requested, not settled* and `cancelled` prints §6.2's two facts (stopped, and whether an external effect is in doubt), because D-090/D-091 make present-without-`settledAt` mean requested and a user who reads that as stopped walks away from work still running. **Exit `2`** for a bad mode or a missing id, answered without consulting the Gateway; **exit `1`** for a refusal, carrying the manager's own reason verbatim. A second cancel of one task returns the request already recorded rather than an error. |
| `approval ls`, `approval approve <id>`, `approval deny <id>` | **Answers once, and reports a refusal it did not earn.** The queue renders §6.3's countdown against the Gateway's own `serverTime` rather than the terminal's clock, because the Gateway is the party that decides expiry and a phone running a minute fast would otherwise show a live prompt as an expired one. The exact target is printed whole beside its summary: a summary is written to describe an action, which is not the same thing as being the action, and approving what a summary says is how a binding comes to cover something nobody meant. `--state` is passed through unvalidated so a typo is refused by the Gateway naming all five states instead of being coerced into an empty queue, which is what a waiting prompt must never look like. There is no `--scope` (D-052 admits one answer shape in this release, so every other value is a refusal rather than an override), no `--yes` (an explicit `approve <id>` is already the deliberate act, and no code asks for a confirmation to skip), and no `--reason` on `deny` (§4.3's body carries no reason field, so one would be accepted and dropped — losing silently what the user offered). A refusal prints the arbiter's own sentence and exits `1`; a T3 asked of a terminal is refused by D-085 and the row stays pending for a surface that may sign it. An answer prints one more line pair than the state and the target: whether the run was woken, and the Gateway's sentence beside it, because `approved` on a screen and a task that never continues is the pair that reads as a hung agent — and the three answers that say "not woken" (no runner here, no run parked in this process, one already moving) need different next actions, so the verb prints the reason instead of inferring one from the state (F-58). |
| `job ls [--state S] [--quiet]`, `job show <id>`, `job pause\|resume <id>`, `job run-now <id> [--detach]`, `job backlog <id> --latest\|--skip` | **The standing-authority screen, and every line is the Gateway's sentence rather than the verb's opinion.** `ls` prints one line per job with the state word in the label column so a list greps by state without a second tool (`active`, `paused`, `waiting-approval`, `failing`, `deferred:vault-locked` — C12-01), carries name, schedule, next run and last outcome on that line, and `--quiet` prints ids only for §10's piping contract; `--state` is refused locally with both values named, because a job has two states and a typo answered by the Gateway costs a round trip to say the same thing. `show` is C12-02's "what did I authorize on that day" in ≤15 lines — the capability set the job holds, the identity it runs as, the next fire with the recorded UTC offset beside it (D-103), and the last four runs with their triggers and outcomes — and `--json` carries the route's whole bounded history rather than the screen's four. `pause` and `resume` print the scheduler's own sentence (C12-03): a pause takes effect before the next tick and names the task of any run already in flight with `task cancel` beside it, and a resume says that the grants were re-evaluated rather than trusted. `run-now` prints the run it created and then **follows the task exactly as `task run` does**, because C12-04's exit `3` is a fact about the run and not about the request: `completed` exits `0`, a task that ended `failed`, `cancelled` or `interrupted` exits `1`, and a stop at an approval exits `3` naming the command that answers it. `--detach` returns at creation with exit `0` and one document. `backlog` requires one of `--latest` or `--skip` and exits `2` without either, because one of the two fires work and §4.5's sixth rule is that a backlog must not run without the user being told; it prints the count acknowledged, the scheduler's sentence, and for `--latest` a `task watch <id>` line rather than blocking inside a verb whose subject was the backlog. All six exit `4` on a Gateway that composed no scheduler — `platform-unsupported`, the answer for "this Gateway cannot do that here", which retrying cannot fix. Two absences are decisions: there is no `job create` (C12-09 — scheduling is created from a task by `cron.schedule`, T2, and two creation paths with different approval semantics is how a schedule escapes review), and `job edit` stays planned because C12-05 documents it as editing the *material* half, which §4.5 prices as re-approval and no route here can open (D-084). |
| `session ls [--origin I] [--quiet]`, `session new [--title "…"]`, `session rename <id> "…"` | **The conversation list, and one round trip a client has to make twice.** `ls` prints C11-01's six fields on a line each in the route's own order — last activity, newest first, stated in the body as `sortedBy` so a client cannot infer it — with the state word in the label column so `crabby session ls \| grep waiting-approval` is one command, `unknown origin` for the conversations schema version 6 backfilled rather than a guess, and a fix line when any row is `waiting-approval` because W16-02's rule is that work stalled on a human is never hidden. `--quiet` is ids alone (§10's pipe). With nothing in it the verb says what creates a conversation rather than printing an empty page, and with no Gateway it exits `1` and never prints "no conversations" — an empty list and an unreachable one are different facts. `new` prints the id **and** the command that uses it, because C11-02's sentence is "a created thing you cannot address is a bug", and with no `--title` it says the session was created `un-named` and will take its title from the first question asked in it (W15-03). `rename` reads the row first and sends the revision it read as `If-Match`, so two interfaces editing one title cannot silently overwrite each other (§2, D-104): exit `1` with both numbers in the sentence when another interface won the race, and the flag questions — no id, no title, a title of whitespace, an `--origin` outside W15-11's four — are all answered locally at exit `2` before any request. There is no `session delete`: `crabby session delete` exits `2`, prints no deletion, and the help lists exactly one destructive verb, `history delete-session`. |
| Approval needed, no answer reachable | **Exit `3`** immediately. `--wait-approval <n>` is the opt-in to keep waiting, and only that; a command that silently blocks inside a cron job is an outage that waits to be discovered. |

### 7.2 TUI

Interactive terminal client over `/events` + HTTP.

- Layout on a narrow screen (Termux ~40–60 columns) is the design case: one primary pane, with side panes toggled
  rather than assumed.
- Required views: conversation with streaming, task list, task detail (plan/steps/state), approval prompt, tool
  activity, session switcher, scheduled jobs (D-057), provider/model picker with the override screen
  (`PROVIDERS_AND_TOOLS.md` §3.8).
- Keys: `Ctrl-C` cancels the current task (mapped to `POST /tasks/{id}/cancel`, not to killing the process),
  `Esc` closes a pane, `?` help. The terminal's own interrupt must never be the only way to stop work.
- Must degrade honestly: no colors/Unicode on dumb terminals, and `TERM=dumb` is a supported mode with reduced
  chrome rather than a crash.
- Approval prompts are blocking-modal with a visible expiry, since approving a stale prompt is a real risk
  (`SECURITY.md` §4, T-05).

### 7.3 Web UI

Served by the Gateway from its build directory (D-067, closing O-040): `crabby web open` starts no second process and
opens the same origin the API is on, so there is one port, one TLS story through the tunnel, and one thing to keep
alive on a phone. The client itself is framework-free — custom elements, `<dialog>`, CSS custom properties for tokens,
SSE for events (D-068, closing O-043) — because this interface is a consumer of the contract rather than an
application platform, and every dependency here is install weight and audit surface on the least powerful device in
the system.

Framework-free custom elements per `ARCHITECTURE.md` §6.3 (D-068), served as built assets by the Gateway in
production (D-067).

- Consumes only `/api/v1` and `/events`; no direct core imports, no separate backend.
- Mobile viewport is the primary layout (a phone browser pointed at a Termux Gateway), desktop is the wider case.
- All four interfaces' capabilities must exist here: sessions, tasks, approvals, providers and model overrides,
  extensions, memory review, config, logs/audit, tunnel control.
- Origin checks and the token model of §3.1; the token never lands in a URL or a query string, because URLs get
  logged by intermediaries — a tunnel public URL makes that mistake expensive.

### 7.4 Telegram

Adapter over grammY (P-009, Accepted in D-069); translates Telegram updates into the same internal requests, and
keeps `retry_after`/429 handling in Crabby's code rather than the library's.

- Commands, one per capability in §8 rather than a hand-picked subset: `/ask <text>`, `/task <objective>`, `/tasks`,
  `/watch <id>`, `/unwatch <id>`, `/cancel [id]`, `/resume <id>`, `/approve <id>`, `/deny <id>`, `/approvals`,
  `/sessions`, `/new`, `/rename <n> <title>`, `/context`, `/compact`, `/model <provider/model>`, `/providers`, `/probe <model>`, `/tools`,
  `/memory`, `/ext`, `/config`, `/logs`, `/export`, `/delete <n>`, `/tunnel on|off`, `/jobs`, `/job <id>`, `/report`,
  `/status`, `/health`, `/help`. `/start` is on the list for a different reason than the other twenty-eight: it is not
  a capability, it is Telegram's own handshake and the entry to pairing (G1-02, G-O01 in `docs/review/TELEGRAM.md`),
  and a bot that does not answer it cannot be paired from a phone at all.
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

This table is **generated** from the tool registry plus per-tool interface annotations (D-067, closing O-042); the
generator is committed, the output is checked in so a reviewer can read it, and CI fails on a diff. The reason is
history rather than taste: `docs/CONSISTENCY_REVIEW.md` F-08, F-10 and F-11 were the same defect three times — three
hand-maintained lists.

`scripts/parity.ts` is the generator, and it arrived in M1c with the registry it reads (`packages/policy`). What it
does, on every `npm run test:parity` and before every merge:

- renders this table from the rows in `scripts/parity.ts` and fails if the file in the repository differs — so a
  capability may not gain or lose an interface in prose alone;
- fails if `packages/gateway/app.ts` registers a route that §3 or §4 does not document, which is the direction a
  reviewer cannot see in a diff of the documents;
- fails if a CLI noun this table or §7.1 requires is absent from `apps/cli/registry.ts`, or if a command that registry
  marks `ready` appears in neither place — the D-005 test, in both directions, with `planned` as the answer for
  anything a later milestone owns;
- fails if `packages/policy`'s tool tiers or capability vocabulary disagree with `PROVIDERS_AND_TOOLS.md` §4.2 or
  `SECURITY.md` §6.1, either way round (F-32, a capability listed twice, was found this way);
- fails if `AGENT_RUNTIME.md` §4.1's transition table and `PERMITTED_TRANSITIONS` in `packages/agent-runtime` disagree
  in either direction, including a state with no row (D-083: the lifecycle document owns the rules, so the rules are
  checked against the document that states them);
- fails if a Telegram command in `docs/review/TELEGRAM.md` is absent from §7.4, or a command in §7.4 absent from the
  inventory.

Rules 11 and 12 of `scripts/check-docs.py` remain, because they ask whether `docs/review/*` inventories are *complete*
— a property of the documents alone. Rule 10 was retired when its comparison moved here: prose checked against prose
can be wrong together, and code checked against prose cannot.

<!-- parity:begin -->

| Capability | API | CLI | TUI | Web | Telegram |
| --- | --- | --- | --- | --- | --- |
| Chat / one-shot prompt | `POST /sessions/{id}/messages` | `chat` | chat pane | chat view | `/ask` |
| Create multi-step task | `POST /tasks` | `task run` | `n` in tasks pane | New task | `/task` |
| Watch task + live progress | `GET /events`, `GET /tasks/{id}` | `task watch` | task detail | task view | `/watch` + edits |
| Cancel task | `POST /tasks/{id}/cancel` | `task cancel` | `Ctrl-C` | Cancel button | `/cancel` |
| Resume task | `POST /tasks/{id}/resume` | `task resume` | `r` in detail | Resume | `/resume <id>` |
| Answer approval | `POST /approvals/{id}/decision` | `approval approve/deny` | modal | dialog | inline buttons |
| Pending approval queue | `GET /approvals` | `approval ls` | status bar | approvals panel | `/approvals` |
| List/switch sessions | `GET /sessions`, `POST /sessions`, `GET /sessions/{id}`, `PATCH /sessions/{id}` | `session ls`, `session new`, `session rename`, `chat --session` | session switcher | sidebar | `/sessions` |
| Context view + pin | `GET /sessions/{id}/context`, `POST …/pin` | `context show/pin` | context pane | context drawer | `/context` |
| Force compaction | `POST /sessions/{id}/compact` | `session compact` | `c` | Compact | `/compact` |
| Provider add/remove | `POST/DELETE /providers` | `provider add` | provider screen | settings | `/providers` (add is Web/CLI-only if typing a URL on a phone is impractical — needs an accepted limitation, not a gap) |
| Model list + override | `GET /models`, `PUT …/overrides` | `model edit` | model picker | model editor | `/model` |
| Probe model capabilities | `POST /models/…/probe` | `model probe` | action in picker | Probe button | `/probe <model>` |
| List tools + tiers | `GET /tools` | `tools ls` | tools pane | tools view | `/tools` |
| Memory review/search/forget | `/memory…` | `memory …` | memory pane | memory view | `/memory` |
| Extension validate/install | `/extensions…` | `ext …` | extensions pane | extensions view | `/ext` (install requires a confirming approval message) |
| Config get/set | `/config` | `config …` | settings | settings | `/config` (a **T3** change is displayed and may be relayed, never signed in chat — D-085 confines a T3 signature to the TUI and the Web control UI) |
| Logs / audit | `/logs`, `/audit` | `logs`, `audit` | log pane | logs view | `/logs` (tail + file export) |
| Tunnel on/off | `POST/DELETE /tunnel` | `tunnel on/off` | status + action | settings | `/tunnel on` (T3 confirm) |
| Pair / revoke client | `/auth…` | `auth pair/revoke` | settings | settings | revoke from a trusted local client only — a remote client must not be able to mint identities; **documented limitation with local-only alternative** |
| History export | `POST /sessions/{id}/export` (`history.export`) | `history export` | export action | Download | `/export` as a file |
| Delete conversation | `DELETE /sessions/{id}` | `history delete-session` | `d` | Delete | `/delete <n>` with the title typed back |
| Review scheduled jobs | `GET /jobs?state=`, `GET /jobs/{id}`, `PATCH /jobs/{id}`, `POST /jobs/{id}/pause`, `POST /jobs/{id}/resume`, `POST /jobs/{id}/run`, `POST /jobs/{id}/backlog` | `job …` | jobs pane | Scheduled screen | `/jobs`, `/job <id>` |
| Gateway lifecycle | `POST /admin/restart`, `POST /admin/shutdown` | `gateway restart` | status action | Access screen | refused here, local-only (like pairing, D-053) |
| Diagnostics report | `GET /diagnostics` | `diagnostics` | status action | Export sanitized | `/report` as a file |

<!-- parity:end -->

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
- Through a Quick Tunnel the public URL changes on restart — decided in D-066 (closing O-009): the Gateway prints the
  new URL on every start, never redirects or resurrects the old one, and shutdown drains in-flight requests for 5 s so
  a paired client sees a clean end rather than a hang. Clients must discover the current URL from the Gateway rather
  than storing one permanently, and stale URLs must fail with an actionable error. On the machine the Gateway runs
  on, that discovery is a read of `gateway.json` in the state directory (D-078), which a local CLI, the TUI and a
  browser page all use the same way; a tunnel URL is discovered from the Gateway itself, never from a remembered value.
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
  Two of those rows name a policy this document has not written: a token *expiry* needs a lifetime, which §3.1 does not
give one (revocation is the mechanism it specifies), and a *wrong origin* needs an `Origin` rule for the loopback
listener, which §2's `No ambient auth` makes unclear. Both are **O-072** rather than a test to invent, and the
unauthorized-sender row belongs to the Telegram slice that owns §3.3.
- Fixtures and fakes come from the `mock/fake` provider so no test depends on a live API (`SECURITY.md` §17).

## 12. Decisions that used to be open here

Nothing in this document is undecided. The list stays, with the answers, because "the spec stopped short of a call"
was the most common finding in `docs/CONSISTENCY_REVIEW.md` and a reader should be able to see which claims have moved:

- ~~**O-004**~~, ~~**O-010**~~ — transport and replay semantics: D-048, D-049 (§5).
- ~~**O-009**~~ — tunnel lifecycle: D-066 (§10).
- ~~**O-019**~~ — pairing presentation: D-067 (§3.2).
- ~~**O-036**~~ — the document checker is a required CI job: D-060, `docs/DEVELOPMENT.md` §12.
- ~~**O-039**~~ — `/api/v1` path prefix: D-067 (§2).
- ~~**O-040**~~ — the Web UI is served by the Gateway from its build directory; `crabby web open` starts nothing new
  and points the browser at the same origin, because a second server on a phone is a second certificate story and a
  second thing to keep alive (D-067, §7.3).
- ~~**O-041**~~ — approval expiry per tier (T1 15 min, T2 10 min, T3 5 min): D-064, `SECURITY.md` §6.3.
- ~~**O-042**~~ — this §8 is generated from the registry plus annotations: D-067.
- ~~**O-060**, **O-061**, **O-062**, **O-063**~~ — CLI blocking, NDJSON watch, exit `3`, completion-only docs: D-063 (§7.1).

## 13. Acceptance Criteria

01. Every capability in `PROVIDERS_AND_TOOLS.md` §4.2 appears in the §8 matrix with a real command per interface or a
    documented limitation.
02. The event envelope, `seq` rule, and gap-handling contract are agreed (D-049); the retention figures are decided
    (D-065: 30 days or 5 000 events per task), and what is left is tuning them against usage in M2, not choosing them.
03. Pairing and revocation are specified well enough that no implementer invents a trust rule (D-030, D-051).
04. Error classes and codes are frozen enough to build a CLI exit-code convention against.
05. The Telegram adapter has no capability of its own: everything is expressible through §4 endpoints.
06. Tests in §11 exist before the second interface is written, so parity is proven, not asserted.

---

**End of Interfaces and API Specification**
