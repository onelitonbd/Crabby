# Element Review — Telegram

> **Purpose:** the Telegram interface, element by element, with the same weight for the small things (a `(2/3)`
> marker, escaping a single underscore, when the keyboard is removed) as for the big ones (`/task`, approvals), per
> D-055.
>
> **Status legend for the `Status` column**
> `PROPOSED` = awaiting owner review · `ACCEPTED` = owner approved, spec locks · `EDIT` = owner changed it, text is
> being updated · `CUT` = owner removed it · `?` = owner asked a question, blocking
>
> **IDs:** `G` = Telegram (the `T` prefix belongs to the TUI) · region number, or `-letter` for a named region ·
> element number. Quote an ID when you want to change one thing.
>
> **The binding case here is not a screen, it is a chat on a phone with a flaky connection.** Every row has to answer
> the same question twice: what does the user see when it works, and what do they see when Telegram's API says no.
>
> **Platform numbers used in this file** are Telegram's documented Bot API limits (4 096 characters of message text
> after entity parsing, 1 024 in a caption, ~1 message/second per chat and ~20/minute per group, `callback_data`
> ≤64 bytes, bot upload 50 MB / `getFile` download 20 MB). They are not Crabby's choices — the choices are what the
> rows say (split, coalesce, opaque id, file instead of text). Re-verify the numbers at implementation time, because
> a limit that changes silently turns these rows into bugs.

---

## 1. Getting in

### Region G1 — Access, pairing, and the two kinds of chat

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| G1-01 | Allow-list gate | user id and chat id check before anything else | n/a | an unauthorized sender gets nothing at all — no refusal, no "unknown user", no reaction (`docs/INTERFACES_AND_API.md` §7.4) | PROPOSED |
| G1-02 | First /start from an allowed user | the pairing step for a new chat | ≤6 lines | the pairing UX on a phone is decided in D-067; what is fixed is that the code is short-lived, single-use, and never logged (`SECURITY.md` §5.1) — decided in D-067 | ACCEPTED |
| G1-03 | Bot token handling | stored in the vault, referenced as `vault://telegram` | one line in config | never in argv, never in a URL, never printed by any command (the same rule as CLI C7-02) | PROPOSED |
| G1-04 | One identity per chat | which session this chat belongs to | n/a | a chat maps to one session; `/new` starts another, and the audit record says `telegram` plus the chat, not "the owner" | PROPOSED |
| G1-05 | Group registration | adding the bot to a group | 2 lines | refused unless the group id is on the allow-list; the refusal explains what to change, in the owner's chat, not in the group | PROPOSED |
| G1-06 | Group privacy mode | what the bot can see in a group | n/a | built for Telegram's default privacy mode (mentions and commands only), and the help text says so instead of assuming it sees everything | PROPOSED |
| G1-07 | Mention policy | reply only when mentioned or commanded | n/a | no chatter about unrelated messages; a mention of the bot's name inside someone else's sentence is not a command | PROPOSED |
| G1-08 | Its own messages | messages sent by the bot itself | n/a | never re-ingested as input, and never reacts to its own reply in a group | PROPOSED |
| G1-09 | User deletes or edits their message | input no longer matches | n/a | the task keeps running; a deleted prompt does not cancel work, and cancelling is a command (`/cancel`) | PROPOSED |
| G1-10 | Chat migrated or supersession | forwarded task, old chat dead | n/a | if the progress message cannot be edited any more, the next update is a new message in the same chat and the stream continues — a lost edit is never a lost task | PROPOSED |
| G1-11 | User blocked the bot | send fails | n/a | logged with the exact reason, approvals then expire unanswered, and nothing is retried into a wall; the status screen shows `delivery-failed` | PROPOSED |
| G1-12 | Two chats open at once | same user, different chats | n/a | two sessions, no cross-talk; `/status` in one does not reveal the other's content | PROPOSED |

---

## 2. Getting text out

### Region G2 — Message shape and formatting

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| G2-01 | Turn reply | short first line with the outcome | ≤1 line, ≤120 chars | details follow only when they change a decision; everything else is a task id, not a URL (`docs/UI_UX_SPEC.md` §7) | PROPOSED |
| G2-02 | Splitting long output | `(2/3)` markers, or a file | 4 096 chars max per message | split at a line boundary, never mid-code-block; the marker count is the real count | PROPOSED |
| G2-03 | Truncation label | when something was cut | one line at the end | says it was truncated and what the omitted part was, because the API rejects an over-long message rather than shortening it for us | PROPOSED |
| G2-04 | Markdown entities | what formatting survives | n/a | emits a conservative subset (code spans, bold) and escapes everything else; if escaping fails, it sends plain text rather than broken formatting | PROPOSED |
| G2-05 | Code blocks | fenced code | 4 096 per message | monospace entity, no syntax coloring claim; on a phone the copy action is Telegram's own long-press | PROPOSED |
| G2-06 | Table-shaped output | the "table" a Web screen would draw | n/a | rendered as aligned plain text or as a file, never as a grid that wraps on a narrow screen | PROPOSED |
| G2-07 | Link policy | URLs in output | n/a | a link never carries a token or a pairing code in its query string (D-051); the local Web URL is offered as text only, from a local command | PROPOSED |
| G2-08 | Bengali and other non-Latin text | message body in the user's language | n/a | Telegram shapes it properly, so unlike the TUI there is no degradation to design around; the copy strings follow the same language setting as Web | PROPOSED |
| G2-09 | Timestamps | times quoted in replies | one short line | labeled with the Gateway's timezone when a task time is quoted, because "21:44" between two devices is how people misread logs | PROPOSED |
| G2-10 | Ids as text | task id, approval id | own line | copyable in one tap; never embedded inside a sentence on a phone where selection is a fight | PROPOSED |
| G2-11 | Reply threading | which message a reply refers to | n/a | a decision or a cancel quotes the originating message where the platform allows it, so two tasks in one chat stay distinguishable | PROPOSED |
| G2-12 | Error text shape | `code` plus one human line | ≤3 lines | the same envelope as every other interface; a Telegram-only phrasing of an error is a defect | PROPOSED |
| G2-13 | No ambient formatting | emoji and decorative glyphs | n/a | none as structure: state is carried by words, matching the "never color-only" rule the other interfaces have | PROPOSED |

### Region G3 — Commands

The command surface is `docs/INTERFACES_AND_API.md` §7.4: one command per parity-matrix capability, 28 of
them, plus the three ways a message arrives that is not a command. That
is deliberately not a curated short list: on Telegram a missing command is a missing capability, and the interface
stays small by making the common paths *not* need typing (inline keyboards, reply targets, `/tasks` numbering so an id
is one tap away) rather than by cutting commands.

Rows are in the order a person meets them: conversation → tasks → approvals → sessions and context → models and
tools → data and settings → self-description.

| ID | Element | Content | Sizes | Behavior | Status |
 | --- | --- | --- | --- | --- | --- |
| G3-01 | /ask | one question, no task | ≤1 message | the same capability as Web chat and `crabby chat`; runs without a plan and without tool escalation | PROPOSED |
| G3-02 | /task | objective in one line | 1–2 messages | starts a task through the same route as the Web; the reply carries the id, plus `/watch` and `/cancel` spelled out, because a phone loses the terminal often | PROPOSED |
| G3-03 | /tasks | active and recent tasks | ≤10 lines | numbered, so a later command can say `2` instead of an id a user has to select and copy; pending-approval tasks marked first | PROPOSED |
| G3-04 | /watch | attach progress to this chat | one line | one edited message per task (G4-01); a second `/watch` on the same task is a no-op that says so | PROPOSED |
| G3-05 | /unwatch | stop the edits, keep the task | one line | the difference between watching and running is stated, because `cancel` is the other thing a panicking user reaches for | PROPOSED |
| G3-06 | /cancel | the running task, or `/cancel 2` | 2 lines | reports the three-phase stop as it settles (requested → finishing current step → settled) | PROPOSED |
| G3-07 | /resume | a suspended or failed task by number or id | 2 lines | resumes from the checkpoint and prints what will be skipped vs repeated (D-044); never restarts the objective | PROPOSED |
| G3-08 | /approve | `/approve <id>` for a pending item | one line | the typed path beside the keyboard (G-A2), so a missing or stale keyboard is never a dead end; approval is once-only (D-052) | PROPOSED |
| G3-09 | /deny | `/deny <id> [reason]` | one line | the reason lands on the task record, and the reply says what will not happen | PROPOSED |
| G3-10 | /approvals | the pending queue | ≤10 lines | the read-only list; answering still goes through a keyboard or the typed commands, so there is exactly one way to say yes | PROPOSED |
| G3-11 | /sessions | this chat's sessions | ≤10 lines | the same rows as `GET /sessions`; a group sees the group's sessions only (G7-07) | PROPOSED |
| G3-12 | /new | start another session in this chat | one line | and the chat now points at the new one — the old session keeps its history and is reachable via `/sessions` | PROPOSED |
| G3-13 | /context | what is in the working context | ≤15 lines | sections with cost, what was compacted, what is pinned; the phone version of Web W7 and TUI T8, same numbers | PROPOSED |
| G3-14 | /compact | force compaction now | 2 lines | prints what was summarized and where the originals live; never implies the original text is gone (D-027) | PROPOSED |
| G3-15 | /model | list and switch models | inline keyboard | shows the override marker and capability deltas; switching across the privacy boundary repeats the boundary sentence (G6-05) | PROPOSED |
| G3-16 | /providers | the configured providers, no secrets | ≤10 lines | list-only here: adding or editing an endpoint is refused with the reason and the local command (the documented §8 limitation, not a gap) | PROPOSED |
| G3-17 | /probe | `/probe <model>` capability probe | ≤8 lines | same probe the Web button triggers, so a pass in one interface means a pass in all of them | PROPOSED |
| G3-18 | /tools | tools with tier and enabled state | ≤20 lines | the same list as `tools ls` and Web W11-01, including deferred tools with their reason | PROPOSED |
| G3-19 | /memory | review, search, forget | ≤10 lines per action | `/memory search <text>`, `/memory forget <n>`; forgetting shows what referenced the entry first, matching Web W8-08 | PROPOSED |
| G3-20 | /ext | list, info, validate | ≤12 lines | install is a multi-step confirmation and this interface carries the approval message only when a verdict exists (D-038: no third-party executable kinds, and the help says so rather than failing mysteriously) | PROPOSED |
| G3-21 | /config | read a key, or set one | 2 lines | reads print the value with secrets `redacted`; a T3 change confirms in-chat with the diff shown before it is written, exactly like the Web | PROPOSED |
| G3-22 | /logs | tail of the log, redacted | ≤4 096 chars | the newest lines with a truncation label (G2-03); the full file is fetched from the Web or CLI, not paged through a chat | PROPOSED |
| G3-23 | /export | this session as a file | one file | the same artifact as `history export` and the Web download (T2, so a task-shaped action), sent as a document with the format in the caption | PROPOSED |
| G3-24 | /delete | `/delete <n>` then the session title typed back | 2 lines | same rule as Web W15-07 and TUI T16-06: the typed word is the **title**, not `yes`, because a chat has no undo affordance and the point of the friction is proving you meant *this* session | PROPOSED |
| G3-25 | /tunnel | `/tunnel on`, `/tunnel off` | ≤3 lines | T3: says which identities become reachable before it does it, and confirms; the URL is printed as text, never as a link with a token (D-051) | PROPOSED |
| G3-26 | /status | Gateway, vault, tunnel, queue, pending approvals | ≤8 lines | the phone version of `crabby status`, same facts, so a bug report from either reads the same | PROPOSED |
| G3-27 | /health | reachable, and since when | one line | deliberately boring and safe to ask at any moment; it does not reveal anything about other chats | PROPOSED |
| G3-28 | /help | every command, restrictions, and what cannot be done here | ≤2 messages | lists all 28 commands; states G7-03 and G3-16 as limitations; an undocumented command is worse than a missing one, and a documented one that is not implemented is a lie | PROPOSED |
| G3-29 | unknown command | typo, or a command from another version | one line | names the closest real command — the one case where silence is not allowed here, because a real answer and "you are not on the allow-list" must not look identical | PROPOSED |
| G3-30 | bare text, no command | a paragraph sent without a slash | n/a | treated as `/ask`, and the reply says it was treated as a question so the guess is visible instead of silent | PROPOSED |
| G3-32 | /rename | `/rename <n> <title>`; bare `/rename` asks for the new title | one line | renames the session this chat points at (`PATCH /sessions/{id}`) — without it, rename exists on three interfaces and not here, which is a capability gap rather than a smaller screen | PROPOSED |
| G3-33 | /jobs | the schedule list | ≤10 lines | name, words-schedule, next run, state word; a chat is where a user first notices a job is stalled, so this is a list-and-open command, not a report | PROPOSED |
| G3-34 | /job | `/job <n>` opens one job with a keyboard | ≤1 message + keyboard | pause · resume · run now · edit · delete · show last runs as buttons; edit asks one field at a time, because a phone can edit a schedule and the re-approval notice must appear in the same message where the change is confirmed (D-057) | PROPOSED |
| G3-35 | /report | the sanitized diagnostics bundle as a file | one document | `GET /diagnostics` is already redacted and safe to paste into a bug report, so a phone can produce it from the chat it is already in; the caption names the Gateway version and the time range it covers | PROPOSED |
| G3-31 | refused command | `/pair`, `/auth`, `/provider add` | one line | refused with the reason and the local alternative — the two documented limitations, surfaced in the interface that has them rather than left to be discovered | PROPOSED |

---

## 3. Approvals

### Region G-A — Inline keyboard, and everything that can go wrong with it

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| G-A1 | Approval message | action summary, exact target, consequence, reversibility, tier, expiry | ≤4 096 chars | the same fields as Web W-A1…W-A5 and TUI T-A1…T-A5 — a shorter explanation on the smallest screen is not acceptable | PROPOSED |
| G-A2 | Approve / Deny buttons | two buttons, one row | 64-byte callback each | `Approve once` and `Deny`; there is no third "always allow" button in v1 (D-052) | PROPOSED |
| G-A3 | Callback payload | opaque approval id only | ≤64 bytes | the action is never in the payload, so a replayed or forged callback cannot carry a different decision (`SECURITY.md` §5.2) | PROPOSED |
| G-A4 | Callback verification | requester, chat, originating message | n/a | all three must match the pending item; a wrong user tapping the button in a group gets nothing, not an error | PROPOSED |
| G-A5 | Button removed after answering | edit the reply markup | n/a | the keyboard is replaced by a text line saying who answered, when, from which client — a stale button is a trap | PROPOSED |
| G-A6 | Expired approval | countdown ended | one line | `expired — send /approve <id> again`, never dead buttons pretending to work (`docs/UI_UX_SPEC.md` §7) | PROPOSED |
| G-A7 | Answered elsewhere | CLI/TUI/Web answered first | one line | the message is edited to `answered in <client> at <time>` and the tap reports the conflict; nothing runs twice | PROPOSED |
| G-A8 | Tap before the answer lands | double tap, or two users | n/a | first wins, the second gets a "already answered" toast-style edit; approval is idempotent per item | PROPOSED |
| G-A9 | No keyboard possible | a chat or client that cannot render one | n/a | falls back to a plain message with the id to reply with; the capability stays, the interaction changes (`docs/INTERFACES_AND_API.md` §7.4) | PROPOSED |
| G-A10 | Exact target too long for one message | a 3 KB command line | split | the target is sent whole as its own message before the keyboard message, so nobody approves a truncated string | PROPOSED |
| G-A11 | Why am I being asked | a third button or a `/why <id>` | ≤3 lines | same content as Web W-A12 and TUI T-A12, reachable without leaving the chat | PROPOSED |
| G-A12 | Approval while the Gateway is unreachable | nothing can be answered | one line when it returns | the prompt is not marked answered on a half-delivered path; on reconnect the state is re-read from the Gateway, not from the last successful edit | PROPOSED |
| G-A13 | Edit rate versus urgency | an approval in a busy, coalesced stream | n/a | approval messages bypass the progress coalescer — a decision waits for nobody, a progress tick can | PROPOSED |

---

## 4. Progress, media, models

### Region G4 — Watching a task

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| G4-01 | One progress message per task | state, step `12/17`, elapsed, last tool | edited in place | edit-interval is a floor, not a target: ~1 edit/second per chat maximum, and the group figure is lower (`docs/INTERFACES_AND_API.md` §7.4) | PROPOSED |
| G4-02 | Coalescing under load | many events, one edit | n/a | newest state wins; intermediate steps are dropped from the message but are never lost as records | PROPOSED |
| G4-03 | Terminal message | completed / failed / cancelled | its own message | cannot be missed and is not an edit of the progress message, so a scrollback read of the outcome is reliable | PROPOSED |
| G4-04 | Progress text | human line, ≤2 lines | n/a | carries the same measured-vs-estimated distinction as Web W5-02 and TUI T6-03 | PROPOSED |
| G4-05 | Final answer delivery | the result text or file | G2-02 rules | the same content the other interfaces show; a summary-only delivery is a capability gap | PROPOSED |
| G4-06 | 429 backoff | `retry_after` from Telegram | n/a | honor it, keep working the task, and never let notification limits turn into a stopped task | PROPOSED |
| G4-07 | Silence is not success | no events for a while | one edit | the progress message says `no output for Ns`, the same disclosure as TUI T4-06 | PROPOSED |
| G4-08 | Unwatch | `/unwatch` or `/cancel` detaching | one line | stops edits; the task is unaffected — the difference between watching and running is stated, not assumed | PROPOSED |
| G4-09 | Quiet hours / mute | user-level mute of progress | n/a | not offered in v1; approvals and the terminal message are never muted, and the row exists so a "make it shut up" feature is a decision rather than a patch | PROPOSED |

### Region G5 — Files and media

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| G5-01 | Receiving a document | user uploads a file | ≤20 MB via `getFile` | saved into the session's scratch area inside a granted root, with the deny-list applied; the path is echoed | PROPOSED |
| G5-02 | Receiving a photo | image input for a vision-capable model | n/a | runs only when the effective capability says vision; otherwise a one-line refusal that names the switch (D-045), not a silent downscale | PROPOSED |
| G5-03 | Unsupported input | voice, sticker, video, contact | one line | says it is not accepted and what to send instead; voice transcription is deferred and listed as deferred (`EXTENSIONS.md` §3 pattern) | PROPOSED |
| G5-04 | Sending a file back | produced artifact | ≤50 MB upload | caption states size and truncation; the file is read from a granted root only | PROPOSED |
| G5-05 | File too large for Telegram | over the limit | one line | says how to fetch it instead (the local path, or the export endpoint from the Web), and never splits a binary into two messages | PROPOSED |
| G5-06 | Download expiry | Telegram's file handle is temporary | n/a | the bot fetches when needed rather than storing a `file_path` across restarts; a lost download says so and re-fetches | PROPOSED |
| G5-07 | Retention of received files | scratch cleanup | n/a | cleaned on task end like every other scratch artifact, with the leftover disclosure (Web W6-10) | PROPOSED |
| G5-08 | Caption limits | 1 024 characters | n/a | caption carries the outcome line; the rest goes in the message text, never clipped from the caption silently | PROPOSED |

### Region G6 — Choosing a model, crossing a boundary

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| G6-01 | /model keyboard | provider/model list with cost class | one button per row | `auto` plus the configured list; long names abbreviated with the full descriptor on tap | PROPOSED |
| G6-02 | Switch confirmation | which model is now in effect | one line | names the session and the duration (this chat, or until changed), so the state is never a guess | PROPOSED |
| G6-03 | Capability delta warning | target lacks tool calling | ≤3 lines | the same sentence as Web W4-04 and TUI T5-05 | PROPOSED |
| G6-04 | Ladder fired | provider out of retries mid-task | one message | the ask-prompt arrives as its own message with the model options (D-043/D-044), and says a resume continues from the checkpoint, not from the start | PROPOSED |
| G6-05 | Privacy boundary disclosure | local → cloud switch | same message | the disclosure is in the prompt itself, because a boundary crossed quietly from a phone is the worst case | PROPOSED |
| G6-06 | No provider editing | adding an endpoint from Telegram | n/a | refused with the reason and the local command; a documented limitation, not a gap (`docs/INTERFACES_AND_API.md` §8) | PROPOSED |
| G6-07 | Override refusal | an agent asking the user to type `/model` to widen itself | n/a | config writes stay T3 and cannot be driven through chat by the agent; the refusal explains where the control lives | PROPOSED |

---

## 5. Constraints that are not about text

### Region G7 — Identity and what this chat may do

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| G7-01 | Telegram identity is restricted by default | capability set granted at pairing | ≤4 lines in /status | D-054: restrictions remove capabilities; they never turn a missing capability into an approval this chat can answer | PROPOSED |
| G7-02 | Shell and config from chat | what a remote-adjacent identity may trigger | n/a | whatever `--restrict` allows, and nothing more; the transport is not the hardening (`SECURITY.md` §13), so the identity carries the limits | PROPOSED |
| G7-03 | Pairing and revocation from chat | self-service access changes | n/a | refused: those actions are local-only (D-053) — this is the accepted parity exception, stated here so the exception is visible in the interface that has it | PROPOSED |
| G7-04 | T2/T3 actions from chat | writes outside roots, deletions, tunnel toggles | n/a | allowed only with the approval flow (G-A), and the tier is printed on the prompt itself | PROPOSED |
| G7-05 | Audit attribution | which chat, which user id, which message | n/a | every action records all three, so "who approved this" has an answer years later | PROPOSED |
| G7-06 | Multiple users in one group | one group, several humans | n/a | the allow-list decides who may act; a non-allow-listed member's approval tap gets nothing (G-A4), and the identity of the actor is the tapping user | PROPOSED |
| G7-07 | Session isolation for groups | what a group can see | n/a | a group's session is its own; `/status` in a group shows the group's tasks, not the owner's private ones | PROPOSED |
| G7-08 | Gateway restart from chat | `/restart`, `/shutdown` | one line | refused, and the reason is given: restarting the process that carries this interface over this link can lock the user out with no local client open — the same local-only logic as pairing (D-053, D-058) | PROPOSED |
| G7-09 | A job needing approval in a quiet chat | the run that is waiting | one message per wait | a scheduled run's approval request arrives as a normal approval message with the keyboard (G-A1), and the run stays waiting rather than proceeding; the job is not "late", and the wording must not imply it is | PROPOSED |

### Region G-S — Security specifics of this transport

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| G-S01 | Nothing in URLs | no token, no pairing code in any link | n/a | D-051 plus the rule from `docs/INTERFACES_AND_API.md` §7.3, restated here because Telegram rewrites and logs links in ways a local browser does not | PROPOSED |
| G-S02 | Webhook versus polling | how updates arrive | n/a | polling by default on a phone: no public HTTPS endpoint to maintain, and a restart resumes cleanly; the choice belongs with `SECURITY.md` §5 and is recorded here as a transport fact | PROPOSED |
| G-S03 | Update de-duplication | same `update_id` twice | n/a | processed once; a retried callback cannot approve twice (G-A8 is the same property from the user's side) | PROPOSED |
| G-S04 | Spoofed sender claims | text saying "I am the owner" | n/a | identity is the `from.id` on the update, never the message content; the model is told so in the prompt it receives | PROPOSED |
| G-S05 | Prompt injection from chat | user text is untrusted input to the agent | n/a | the same external-content tiering as everywhere else: instructions embedded in a chat message do not widen tools or tiers (`SECURITY.md` §10) | PROPOSED |
| G-S06 | Secrets in chat output | config reads, provider keys | n/a | never printed; `redacted` appears where a value would have been, and the marker is explained as it is in the logs (W14-02) | PROPOSED |
| G-S07 | Telegram-side retention | what the platform keeps | ≤3 lines | stated plainly in the help: using this interface means content transits Telegram's servers, and the privacy boundary sentence is the same one Web and TUI print before a cloud call | PROPOSED |
| G-S08 | Bot token rotation | changing the credential | one line | the token lives in the vault; the chat command cannot read it back, only test it | PROPOSED |
| G-S09 | Unknown approval id | `/approve abc123` that is not pending | one line | identical response whether it never existed, expired, or belongs to another chat; no enumeration channel | PROPOSED |
| G-S10 | Rate limiting inbound | a flood of commands from one chat | n/a | shed load with a single "slow down" line and keep the queue intact; the answer to spam is never a per-message error | PROPOSED |

### Region G-T — States the transport forces

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| G-T01 | Gateway unreachable | nothing to answer with | one line on the next command | says the Gateway is down and to run the start command from Termux; no false "working on it" | PROPOSED |
| G-T02 | Telegram API down | updates stop arriving | n/a | on recovery, queued outputs are delivered in order and one line says what happened while it was dark; the task never stopped | PROPOSED |
| G-T03 | Vault locked | any secret-dependent action | one line | refuses with the reason and the unlock path, exactly like Web W1-07 and TUI T2-05 | PROPOSED |
| G-T04 | Task needs an input | question mid-task | one message | asked in the chat with a reply target, and the answer continues the same task — a task that dies waiting is the failure this interface must not have | PROPOSED |
| G-T05 | Message ordering | two tasks finishing close together | n/a | each completion is its own message, labeled with the task id; no shared "done" that could be read against the wrong task | PROPOSED |
| G-T06 | Failed send of a result | API rejected the message | n/a | retried once within the backoff window, then written to the session log so the answer is not lost, and `/tasks` shows it | PROPOSED |
| G-T07 | Offline user during a long task | phone dead, chat silent | n/a | progress simply stops editing; on the next user message the state is re-read from the Gateway rather than replayed from memory | PROPOSED |
| G-T08 | Partial delivery | first of three messages sent, then a 429 | n/a | the remaining parts are delivered when the window opens; the `(2/3)` markers stay correct and never renumber after the fact | PROPOSED |

### Region G-O — First run and help in a chat

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| G-O01 | /start when not yet configured | the setup path, in chat | ≤10 lines | points at `crabby init` for the parts a chat cannot do (keys, roots), and does the rest from here; the six steps stay the six steps (`docs/UI_UX_SPEC.md` §5) | PROPOSED |
| G-O02 | Read-only first experience | user skipped setup | one line | `/ask` works if a model exists; everything else says what is missing in one line, matching the skip path the Web and TUI offer | PROPOSED |
| G-O03 | /help | commands, restrictions, and what this interface cannot do | ≤2 messages | states G7-03 and G6-06 explicitly, so limits are discoverable before they are frustrating | PROPOSED |
| G-O04 | setMyCommands menu | Telegram's command list | 10 entries max | the menu and G3 agree; a menu entry that is refused by policy is removed from the menu, not left to fail | PROPOSED |
| G-O05 | Bot description and about text | what strangers read | ≤256 chars | no security-relevant detail, no version promise, no "unlimited free" claim (`PROJECT_BRIEF.md`); one sentence about what it does | PROPOSED |

---

## 6. Coverage check

| Screen | Regions | Elements | Every state defined? |
| --- | --- | --- | --- |
| Access and pairing | G1 | 12 | blocked bot, deleted message, lost edit, two chats |
| Message shape | G2 | 13 | split, truncation, escape fallback, long-target |
| Commands | G3 | 35 | unknown command, bare text, refused command, one row per capability |
| Approvals | G-A | 13 | conflict, expiry, double tap, no-keyboard fallback |
| Progress | G4 | 9 | 429, stall, unwatch, silence-not-success |
| Files and media | G5 | 8 | size limits, expiry, cleanup, caption limit |
| Models and boundaries | G6 | 7 | delta warning, ladder ask, refused editing |
| Identity and transport | G7, G-S | 19 | spoofing, injection, retention, enumeration, inbound flood |
| Forced states | G-T | 8 | both sides down, partial delivery, offline user |
| First run and help | G-O | 5 | unconfigured, read-only, limits discoverable |
| **Total** | **11 regions** | **129 elements** | — |

Nothing in this file may become a capability the other three interfaces lack, and nothing may be cut here to mean
"less capable" — that is the parity rule, and `docs/INTERFACES_AND_API.md` §8 is where the two accepted limitations
(G6-06, G7-03) are already recorded.

**Open questions:** none that invent a feature. Both inherited unknowns are now decided: pairing UX (O-019) by D-067 and per-tier expiry (O-041) by D-064, so this inventory has no row waiting on a decision.