# Element Review — Web UI

> **Purpose:** every screen, every region, every element of Crabby's Web UI, one row at a time, so the owner can read
> it, edit it, and approve it. Nothing here is decorative and nothing here is minor: every row gets the same
> attention, which is why small things (a `redacted` marker, a connection chip) are listed with the same weight as
> big things (the chat pane).
>
> **Reviewed 2026-10-10 by the delegated reviewer (D-075)** — the owner delegated this pass for lack of time and kept
> review at the point of implementation, one step at a time (D-076). Criteria, the scan that applied them, and the
> exceptions are in `docs/review/README.md`; nothing here is unchangeable, and a veto follows the same procedure as
> an (R) row.
>
> **Status legend for the `Status` column**
> `PROPOSED` = awaiting review · `ACCEPTED` = approved and locked for implementation (by the owner, or by the
> D-075 pass) · `EDIT` = reviewer changed it, text is being updated · `CUT` = removed, with the capability's new home
> named · `?` = a blocking question. `ACCEPTED` never means unchangeable: D-076 reopens a row at the step that builds it.
>
> **IDs:** `W` = Web · region number · element number. Quote an ID when you want to change one thing.
>
> **How to review this file:** `python3 docs/review/mockups/build.py` then open
> `docs/review/mockups/crabby-web-ui.html` (see `docs/review/mockups/README.md`). Every element in that page is one row here,
> and clicking it shows the row. Changing a status in the page does not change this file: the page exports
> paste-ready rows, and `build.py` refuses to build if the two ever disagree about what exists.
>
> **Cross-cutting rule inherited from `docs/UI_UX_SPEC.md`:** a capability that exists anywhere must be present here,
> and every element must have a defined loading, empty, error, and degraded state (`docs/UI_UX_SPEC.md` §8).

---

## 1. App shell

### Region W1 — Persistent status bar (top, always visible on every screen)

| ID | Element | Content | Sizes | Behavior | Placement | Status |
| --- | --- | --- | --- | --- | --- | --- |
| W1-01 | Brand | "Crabby" wordmark, no logo image (bandwidth, Termux browser) | text 16px | tap → home/chat | left | ACCEPTED |
| W1-02 | Session title | editable inline | up to 24ch, ellipsis | click to rename, `Enter` saves, `Esc` cancels | left, after brand | ACCEPTED |
| W1-03 | Model badge | `provider / model` + override marker + fallback marker when the ladder fired (D-043) | fits 360px by abbreviating provider | tap → model picker; long-press → full descriptor | right group | ACCEPTED |
| W1-04 | Connection chip | `live` / `reconnecting` / `offline` + last confirmed timestamp | compact dot+word | tap → `GET /health`; never color-only | right | ACCEPTED |
| W1-05 | Approvals chip | pending count | number | tap → approvals screen; pulses once on new item, never loops | right | ACCEPTED |
| W1-06 | Tunnel chip | `off` / `on: <short host>` — reserved color, nothing else may use it (`docs/DESIGN_SYSTEM.md` §2.1) | compact | tap → Access screen; while on, a page-level banner is unavoidable | right | ACCEPTED |
| W1-07 | Vault chip | `locked` / `unlocked` | icon+word | tap → unlock dialog; locks the whole T2/T3 surface with a reason, not a spinner (`SECURITY.md` §7) | right | ACCEPTED |
| W1-08 | Resource chip | memory / storage / queue pressure, plain numbers | hidden below 480px, reachable from menu | tap → status screen | right | ACCEPTED |
| W1-09 | Version + update note | `v0.x.y` | 12px | tap → copy; shows only the fact that a newer tag exists, no auto-update (D-050) | right | ACCEPTED |
| W1-10 | Status bar container | the bar itself: horizontal padding, wraps to a second line rather than truncating chip text, honours the top safe-area inset, and stays rendered while a route transition is in flight | one line ≥480px, two lines below | wraps, never ellipsis-fills; tapping empty bar space does nothing | full width | ACCEPTED |
| W1-11 | Overflow "more" sheet | the bar items that did not fit, each with its full text, plus a marker on any item that has escaped the sheet into the bar (locked vault, offline) | full-height sheet, one item per row, 44px rows | opened from the trailing `⋯`; keeps the same tap targets as the inline chips; closes on `Esc` and on choosing an item | from the right, under W1-10 | ACCEPTED |

**Open question W1-A:** mobile bar at 360px cannot show nine chips. Proposal: show W1-02, W1-03, W1-05, W1-06 inline
and collapse W1-04, W1-07, W1-08, W1-09 into a single "more" sheet (W1-11) — with the caveat that a *locked vault* and
*offline* must force themselves out of the sheet, because both change what the user can trust on screen.

### Region W2 — Bottom navigation (mobile) / left rail (≥960px)

> **W1-A — closed (D-067).** Decided: **four chips inline — model, connection, approvals, vault — and the rest in the `more` sheet (W1-11)**, with one exception written into the layout rule rather than left to taste: a locked vault and an offline state escape the sheet into the bar, because those are the two states where the bar is the only place a user looks. The rule lives in `docs/UI_UX_SPEC.md` §2.

| ID | Element | Items | Behavior | Status |
| --- | --- | --- | --- | --- |
| W2-01 | Primary nav | Chat · Tasks · Scheduled · Extensions · Settings | 5 tabs at 360px = 72px each, still ≥44px (D-057); approvals reachable from W1-05 and always from tab 2 badge | ACCEPTED |
| W2-02 | New task action | `+` first position, thumb-reachable | opens the new-task sheet (§4) | ACCEPTED |
| W2-03 | Nav badge | approvals count on Tasks, extension suspension count on Extensions | zero = hidden | ACCEPTED |
| W2-04 | Keyboard shortcuts | `g c` chat, `g t` tasks, `g j` scheduled, `g e` extensions, `g s` settings, `n` new | documented in `?` help; desktop affordance, never required on mobile | ACCEPTED |
| W2-05 | Safe-area handling | respects notched-device insets | bottom bar and modal actions only | ACCEPTED |
| W2-06 | Nav container | bottom bar on mobile, left rail at ≥960px | safe-area bottom inset; never overlaps the composer (W4-11); focus order tab → page content; badge clipping is defined, not accidental | ACCEPTED |

---

## 1A. Sessions (`/sessions`)

> Added during the CLI/Telegram parity pass: `docs/UI_UX_SPEC.md` §2.2 has always listed a Sessions screen, and
> `docs/INTERFACES_AND_API.md` §8 has always required "list/switch sessions" on every interface — but until this
> region existed, nothing in the review said *how*. A screen with no elements is a screen that gets dropped when the
> spec is regenerated from these files (F-10).

### Region W15 — Session list, switching, and deletion

| ID | Element | Content | Sizes | Behavior | Placement | Status |
| --- | --- | --- | --- | --- | --- | --- |
| W15-01 | Session row | title, last activity (relative), running-task badge, model in use | full width, 2 lines at 360px | the model shown is the effective one, including an override marker (W10-03) | list | ACCEPTED |
| W15-02 | Current-session marker | which row this tab is looking at | 1 char + label | word + mark, never color alone (`docs/DESIGN_SYSTEM.md` §5) | left of title | ACCEPTED |
| W15-03 | New session | creates one and switches to it | 44px target | `POST /sessions`; the new session starts empty and un-named, and the title becomes the first question asked in it | header, and in the nav `+` menu | ACCEPTED |
| W15-04 | Rename | inline edit of the title | ≤40 chars | the same control as the title in the status bar (W1-02) — one path, two entry points, never two dialogs; `PATCH /sessions/{id}` | row, on hover/long-press | ACCEPTED |
| W15-05 | Switch | tap a row to make it current | n/a | the stream follows the session, not the tab: events for the old one stop being rendered, and the row's badge updates from them | row | ACCEPTED |
| W15-06 | Switch while a task runs | what the confirmation says | ≤3 lines | says the task keeps running in the background and where to find it; a switch is never a cancel, and this is the sentence that makes that obvious | sheet | ACCEPTED |
| W15-07 | Delete | typed confirm with the count of turns and tasks it will remove | one line + input | T3, `history.deleteConversation`; the typed word is the session's title, not "yes" — deleting the wrong session is unrecoverable | row menu | ACCEPTED |
| W15-08 | Export | per-session export to file | 1 line | the same artifact as the Download button in a session (W14-05) and `history export` (T2); no second export path | row menu | ACCEPTED |
| W15-09 | Filter and search | text search over titles, plus a "has running task" filter | one line | search is local to the list; it is not a memory search, and the UI must not imply it is | above the list | ACCEPTED |
| W15-10 | Empty state | no other sessions yet | 2 lines | teaches the one command (`crabby chat "…"` starts a fresh session), per §2.3's rule about empty states | list | ACCEPTED |
| W15-11 | Origin of a session | which interface created it | one short word | `cli` / `tui` / `web` / `telegram`, same attribution the audit record carries — the list is where a user notices "this appeared on its own" | row, second line | ACCEPTED |

---

## 1B. Scheduled jobs (`/jobs`)

> D-057 made this a screen of its own instead of a filter on Tasks, because a job is a *standing authority to run work
> later*: pausing it, seeing what it is allowed to touch, and reading why a run was deferred are not task-shaped
> questions. `PROVIDERS_AND_TOOLS.md` §4.5 is the policy; these rows are the surface that has to make that policy
> visible.

### Region W16 — Jobs list and detail

| ID | Element | Content | Sizes | Behavior | Placement | Status |
| --- | --- | --- | --- | --- | --- | --- |
| W16-01 | Job row | name, schedule in words, next run, last outcome | 2 lines at 360px | the schedule is written both ways (`every weekday 07:30` and `30 7 * * 1-5`), because a cron string is not reviewable on a phone | list | ACCEPTED |
| W16-02 | State word | `active` / `paused` / `waiting on approval` / `deferred: vault locked` / `failing` | one chip | words, not colors alone; `waiting on approval` is the state that must never be hidden, because it means work is stalled on a human | right of title | ACCEPTED |
| W16-03 | Capability set the job holds | fs roots, net, shell, tiers, the identity it runs as | ≤6 lines | shown on the list row's second line and in full on the detail — a job inherits nothing beyond what is written here (`PROVIDERS_AND_TOOLS.md` §4.5) | detail | ACCEPTED |
| W16-04 | Pause / resume | one tap each | 44px | pausing is immediate and says so; resuming re-checks the grants, it does not trust the last check | row action | ACCEPTED |
| W16-05 | Run now | executes the job once, outside its schedule | 1 line + confirm | still a fresh policy evaluation: T2/T3 steps ask at run time, exactly as a scheduled run would | detail | ACCEPTED |
| W16-06 | Edit | objective, schedule, model, recipients | form | saving shows what changed and names the steps that now need re-approval; a material change never rides on the old authorization | detail | ACCEPTED |
| W16-07 | Deferred-run reason | why nothing happened | ≤2 lines | vault locked, no approval inside the window, host offline — each with the fix, and never an empty log | under the state word | ACCEPTED |
| W16-08 | Missed-run backlog | `N runs missed while the device was off` | 3 lines | lists them and asks once what to do (run the latest only / run each / skip all); it must not fire a burst, and it must not silently drop them either | sheet | ACCEPTED |
| W16-09 | Run history | each execution as a task link with outcome, duration, who approved what | 1 line per run | paging; the approval trail per run is what makes this auditable a month later | detail | ACCEPTED |
| W16-10 | Schedule this | from a task's detail, creates a job from that objective | 2 lines | shows the creation card (what will run, how often, what it may touch) and that its tier floor is evaluated per run | W6-12 actions | ACCEPTED |
| W16-11 | Delete | removes the job and says what happens to its sessions | 2 lines | T3; the history of past runs is not deleted with the job unless asked, because that erases the audit trail of work that already happened | row menu | ACCEPTED |
| W16-12 | Empty state | no jobs yet | 2 lines | teaches the path (`crabby task run --schedule "…"`, or W16-10 from any task) rather than a marketing sentence | list | ACCEPTED |

---

## 2. Chat screen (`/chat`)

### Region W3 — Message list

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| W3-01 | Message row, user | text, timestamp, `requestId` on hover/long-press | full width on mobile, 72ch max on desktop | copy, quote into new message, delete own | ACCEPTED |
| W3-02 | Message row, assistant | markdown body, model + provider tag on the *first* line of each turn | same | copy, retry from here, pin, export selection | ACCEPTED |
| W3-03 | Streaming cursor | block glyph at end of streamed text; hidden while stalled, replaced by "no output for Ns" | 1ch | never animates for decoration | ACCEPTED |
| W3-04 | Tool call row (collapsed) | tool name, `TierChip`, status, duration | one line | expand → W3-05; policy-blocked rows stay visible forever | ACCEPTED |
| W3-05 | Tool call row (expanded) | args (secrets → `redacted` marker, not a blank), output with truncation marker, error, exit/cancel state | monospace, scrollable, wrap toggle | copy output, copy args, view audit record | ACCEPTED |
| W3-06 | Approval card, inline | action summary, exact target, reversibility, expiry countdown, approve-once / deny | full width | answering scrolls back to the card; already-answered shows `answered in TUI at 14:02` | ACCEPTED |
| W3-07 | Task link banner | "this turn belongs to task `tsk_…`" | one line | tap → task detail | ACCEPTED |
| W3-08 | System event line | compaction happened, memory injected, model switched mid-task (D-043), auto-resume after restart | subtle, but never hidden behind a click | tap → why this happened | ACCEPTED |
| W3-09 | Code block | language label, copy, wrap toggle, line numbers off by default | mono | copy must work on a phone browser (long-press fallback) | ACCEPTED |
| W3-10 | Diff view | unified below 600px, split/unified toggle above | mono | copy patch; each file line links to the tool call that wrote it | ACCEPTED |
| W3-11 | Error panel | `code`, one human line, what completed, what is pending, resumable?, request id | full width | copy diagnostics; never a bare toast | ACCEPTED |
| W3-12 | Date/session separators | only when >30min gap | caption | anchors for scroll restore | ACCEPTED |
| W3-13 | Scroll affordance | "new content ↓" when the user scrolled up during streaming | floating | clicking never loses the reading position permanently | ACCEPTED |
| W3-14 | Reconnect reconciliation | after a gap, changed messages get a brief highlight and a note says what changed while disconnected | per row | driven by `GET /tasks/{id}`, not by replayed events alone (D-049) | ACCEPTED |
| W3-15 | Message list container | the scroll box that holds W3-01 … W3-14: scroll restore to the last read row, stick-to-bottom only when already at the bottom, windowing above ~200 rows | height = viewport − status bar − composer | new content while scrolled up raises W3-13 instead of moving the viewport; reading position survives reload and reconnect | ACCEPTED |

### Region W4 — Composer

| ID | Element | Content | Behavior | Status |
| --- | --- | --- | --- | --- |
| W4-01 | Text input | multiline, `Enter` send / `Shift+Enter` newline on desktop; on mobile both keys send, newline via button | auto-grow to 8 lines then scroll; draft persisted per session | ACCEPTED |
| W4-02 | Attach file | pick from workspace roots only | path chips, not blobs; respects the `SECURITY.md` §8 deny-list | ACCEPTED |
| W4-03 | Command slash menu | `/model`, `/compact`, `/pin`, `/task`, `/cancel` | filtered list; discoverability without a keyboard cheat-sheet | ACCEPTED |
| W4-04 | Model override for this message | one-turn switch | shows capability delta warning if the target lacks tool calling | ACCEPTED |
| W4-05 | Task vs chat toggle | plain question vs multi-step task (which creates a task, `POST /tasks`) | default: last used, per session | ACCEPTED |
| W4-06 | Capability summary chip | what this turn may touch: fs root, net, shell off/on | tap → config; visible *before* sending, not after | ACCEPTED |
| W4-07 | Send / stop | one button, two states | stop = `POST /tasks/{id}/cancel` (finish current step), never a local hide | ACCEPTED |
| W4-08 | Queue indicator | "queued 2" while a task runs; send queues rather than interrupts | tap → list and reorder or drop | ACCEPTED |
| W4-09 | Character/token estimate | approximate context usage of the draft | estimate labeled as estimate (O-031 closed by D-064) | ACCEPTED |
| W4-10 | Bengali input | composition-safe; no submit on `Enter` while composing | tested on a phone keyboard, not assumed | ACCEPTED |
| W4-11 | Composer container | docked above the nav bar, grows to 8 lines then scrolls, keeps focus while the stream updates | never covers the last message row; survives route changes within a session (draft is per session) | ACCEPTED |

---

## 3. Tasks screen (`/tasks`) and task detail (`/tasks/:id`)

### Region W5 — Task list

| ID | Element | Content | Status |
| --- | --- | --- | --- |
| W5-01 | Filter row | state chips (queued, planning, running, awaiting_approval, cancelling, terminal×3) + session filter | ACCEPTED |
| W5-02 | Task card | title, `state chip`, progress bar with measured-vs-estimated distinction, model+provider, pending-approval badge, elapsed | ACCEPTED |
| W5-03 | Inline actions | cancel, resume, open, watch — no modal needed for cancel | ACCEPTED |
| W5-04 | New task button | opens the new-task sheet | ACCEPTED |
| W5-05 | Empty state | "No tasks yet — press New task, or run `crabby task run "…"` from Termux" | ACCEPTED |
| W5-06 | Bulk selection | deliberately absent in v1 (a bulk cancel would break `task.cancel` per-task semantics, `ARCHITECTURE.md` §10) | ACCEPTED |

### Region W6 — Task detail

| ID | Element | Content | Status |
| --- | --- | --- | --- |
| W6-01 | Header | objective (editable until running), id (copyable), state, tier floor, created/updated | ACCEPTED |
| W6-02 | Plan tree | ordered steps with dependencies drawn as indentation, not a graph (mobile legibility) | ACCEPTED |
| W6-03 | Step row | status, tool, tier chip, duration, attempt count `3/5` from the ladder | ACCEPTED |
| W6-04 | Step log | expandable per-step output, truncation-labeled | ACCEPTED |
| W6-05 | Approval panel | pending here, plus "answered elsewhere" history | ACCEPTED |
| W6-06 | Cancellation panel | three explicit phases: requested → finishing current step → terminal state (`docs/UI_UX_SPEC.md` §3) | ACCEPTED |
| W6-07 | Checkpoint panel | what is saved, when, and what a resume would repeat vs skip (D-044) | ACCEPTED |
| W6-08 | Provider ladder panel | retries used per stage, the ask-prompt that appeared, chosen model, resumed-from-checkpoint confirmation | ACCEPTED |
| W6-09 | Error & retry history | every failure with class (`PROVIDERS_AND_TOOLS.md` §3.5) and outcome | ACCEPTED |
| W6-10 | Artifacts | files written, links to their tool call, sizes, cleanup state of scratch | ACCEPTED |
| W6-11 | Result | final output, partial-completion disclosure, "what did not happen" list | ACCEPTED |
| W6-12 | Actions | cancel · resume · retry failed step · duplicate task · export · delete | ACCEPTED |
| W6-13 | Live tail toggle | subscribe to this task's events only; default on while visible, off when backgrounded (battery) | ACCEPTED |

---

## 4. Approvals (`/approvals`)

### Region W-A — Approvals queue and card internals

| ID | Element | Content | Status |
| --- | --- | --- | --- |
| W-A1 | Queue list | pending cards, oldest first, each with task, tool, tier chip, exact target, reversibility | ACCEPTED |
| W-A2 | Card: action summary | one sentence, second person, no hedging (`docs/UI_UX_SPEC.md` §10) | ACCEPTED |
| W-A3 | Card: exact target | the real command / path / recipient / URL / SQL — never a paraphrase | ACCEPTED |
| W-A4 | Card: consequence + reversibility | what changes, whether undo exists, what an undo costs | ACCEPTED |
| W-A5 | Expiry countdown | with the reason it expires; per-tier duration decided in D-064 | ACCEPTED |
| W-A6 | Approve once | only affirmative action in v1 (D-052) | ACCEPTED |
| W-A7 | Deny | with optional reason field; reason is recorded on the task | ACCEPTED |
| W-A8 | Show related task | deep link, keeps context available without leaving the decision | ACCEPTED |
| W-A9 | History tab | every past decision, who/which client answered, when — the audit trail made readable | ACCEPTED |
| W-A10 | Stale-answer conflict | second answer from another interface → `conflict`, first answer wins, nothing runs twice | ACCEPTED |
| W-A11 | Global blocking | a pending approval is never dismissible; it stays in the tray across all screens (`docs/UI_UX_SPEC.md` §2.1) | ACCEPTED |
| W-A12 | "Why am I being asked?" | links to the rule and tier that produced the prompt, so the user can change configuration instead of resenting the prompt | ACCEPTED |

---

## 5. Context & memory

### Region W7 — Context drawer (`/chat` side sheet, `/context` full page)

| ID | Element | Content | Status |
| --- | --- | --- | --- |
| W7-01 | Budget bar | used / available tokens, with estimate-vs-count flag (O-031 closed by D-064) and reserve-for-output — decided in D-064 | ACCEPTED |
| W7-02 | What is in context | sections: system, pinned, recent messages, retrieved memory, tool results — each with token cost | ACCEPTED |
| W7-03 | What was compacted | summary card linking to the original records; **never** implies the original is gone (D-027) | ACCEPTED |
| W7-04 | Pin / unpin | per message, per file, per decision | ACCEPTED |
| W7-05 | Remove from context | excludes one item from the next turn without deleting it | ACCEPTED |
| W7-06 | Provenance of injected memory | which memory, from which session, trust label (`SECURITY.md` §10) | ACCEPTED |
| W7-07 | Force compact | `POST /sessions/{id}/compact` with a preview of what it would summarize | ACCEPTED |
| W7-08 | Overflow warning | "the next turn exceeds this model's window" + the two ways to fix it | ACCEPTED |

### Region W8 — Memory (`/memory`)

| ID | Element | Content | Status |
| --- | --- | --- | --- |
| W8-01 | Entry list | text, category, provenance, trust label, created/updated | ACCEPTED |
| W8-02 | Search | text search only in v1 (D-021) | ACCEPTED |
| W8-03 | Edit | user edits are authoritative over agent-authored text | ACCEPTED |
| W8-04 | Delete / forget | single, plus "forget everything about X" which is T3 | ACCEPTED |
| W8-05 | Auto-memory toggle | on/off + confidence threshold; a kill switch must be one tap | ACCEPTED |
| W8-06 | Pending auto-memories | queue awaiting review when the policy says "propose, don't store" | ACCEPTED |
| W8-07 | External-content marker | memories derived from untrusted content are T2 until confirmed (`PROVIDERS_AND_TOOLS.md` §4.2) | ACCEPTED |
| W8-08 | Deletion propagation preview | "deleting this affects N conversations' summaries" before the user commits (`docs/DATA_AND_MEMORY.md` §7) | ACCEPTED |

---

## 6. Providers, models, tools

### Region W9 — Providers (`/settings/providers`)

| ID | Element | Content | Status |
| --- | --- | --- | --- |
| W9-01 | Provider list | preset vs user-defined badge (D-041), base URL shown in full (it is not a secret), model count, last success | ACCEPTED |
| W9-02 | Add provider form | name, base URL, key reference (`vault://name` — never a raw key field), models | ACCEPTED |
| W9-03 | Key handling | write-only field, "stored" state, rotate, remove; no read-back ever | ACCEPTED |
| W9-04 | Test connection | inline result with latency and the error class name | ACCEPTED |
| W9-05 | Insecure-transport warning | plain HTTP or non-loopback + key present → explicit warning (`PROVIDERS_AND_TOOLS.md` §3.3) | ACCEPTED |
| W9-06 | Remove provider | warns that tasks pinned to it will fail over to the ask-prompt | ACCEPTED |
| W9-07 | Default model selector | per identity and per session | ACCEPTED |
| W9-08 | Fallback policy editor | off by default (D-047); per-identity narrow ladder with class limits | ACCEPTED |

### Region W10 — Models & capability overrides (`/settings/models`)

| ID | Element | Content | Status |
| --- | --- | --- | --- |
| W10-01 | Model table | provider, model, context, output cap, cost class | ACCEPTED |
| W10-02 | Capability matrix | `reported` vs `effective`, override cells highlighted (D-045) | ACCEPTED |
| W10-03 | Override controls | per capability: auto / force on / force off | ACCEPTED |
| W10-04 | Limit inputs | context window, max output, reserve | ACCEPTED |
| W10-05 | "Forced on = unverified" notice | explains runtime verification and the `unsupported-capability` failure it can produce | ACCEPTED |
| W10-06 | Reset overrides | back to reported per model | ACCEPTED |
| W10-07 | Probe action | `POST /models/…/probe` with a per-capability pass/fail table | ACCEPTED |
| W10-08 | Notes field | free text, e.g. "proxy behind Cloudflare" | ACCEPTED |
| W10-09 | T3 gate notice | editing overrides is `config.write`: an agent cannot widen its own model (`PROVIDERS_AND_TOOLS.md` §3.8) | ACCEPTED |

### Region W11 — Tools (`/settings/tools`)

| ID | Element | Content | Status |
| --- | --- | --- | --- |
| W11-01 | Tool list | name, tier chip, capability, enabled toggle, platform availability | ACCEPTED |
| W11-02 | Tier column | always shows base tier and escalation rules for that tool | ACCEPTED |
| W11-03 | Schema viewer | input/output schema, copy example call | ACCEPTED |
| W11-04 | Deferred tools | greyed with "not in this version" and the reason, not silently missing (`EXTENSIONS.md` §3) | ACCEPTED |
| W11-05 | Shell toggle | off by default; enabling is a described, T2/T3 action with the no-sandbox sentence | ACCEPTED |
| W11-06 | Workspace roots editor | add/remove roots; shows the sensitive deny-list applied to each | ACCEPTED |
| W11-07 | Limits editor | timeouts, output caps, temp lifetime, parallel steps (O-035 closed by D-064) | ACCEPTED |
| W11-08 | Per-task narrowing | mandatory vs opt-in decided in D-066; UI present for both — decided in D-066 | ACCEPTED |

---

## 7. Extensions (`/extensions`)

### Region W-E — Extensions surface

| ID | Element | Content | Status |
| --- | --- | --- | --- |
| W-E1 | Installed list | id, kind, version, source tier, verdict chip, enabled state | ACCEPTED |
| W-E2 | Install flow | path or git URL → validate → verdict → capability diff → approval | ACCEPTED |
| W-E3 | Verdict panel | compatible / partial / incompatible / unsafe with the exact failed check (`EXTENSIONS.md` §6.1) | ACCEPTED |
| W-E4 | Missing-features list | what will not work, itemized — never a generic warning | ACCEPTED |
| W-E5 | Conversion report | mapped / dropped / reinterpreted / unknown, and version diff (D-039) | ACCEPTED |
| W-E6 | Capability grants | per extension, with revoke | ACCEPTED |
| W-E7 | Suspended state | reason, last error, re-enable action that re-runs validation | ACCEPTED |
| W-E8 | Uninstall | data residual disclosure; `--purge-data` shown as T3 | ACCEPTED |
| W-E9 | MCP servers | transport, exact command line or URL, tool count, connection state, restart action | ACCEPTED |
| W-E10 | Executable-kinds lock notice | "third-party executable extensions are not available in this version" (D-038) — visible honesty, not a broken flow | ACCEPTED |
| W-E11 | Scaffold generator | `crabby ext init` equivalent in-browser for skills | ACCEPTED |
| W-E12 | Size/dependency report | install size and dep count before the user approves (`EXTENSIONS.md` §9) | ACCEPTED |

---

## 8. Settings, access, logs

### Region W12 — Settings & config (`/settings`)

| ID | Element | Content | Status |
| --- | --- | --- | --- |
| W12-01 | Schema-driven form | no hand-coded fields; new config keys appear automatically | ACCEPTED |
| W12-02 | Diff-before-apply | shows exactly what changed | ACCEPTED |
| W12-03 | T3 markers | security-relevant rows flagged before edit, not after | ACCEPTED |
| W12-04 | Density mode | comfortable / compact / reduced, explicit user choice (`docs/DESIGN_SYSTEM.md` §8) | ACCEPTED |
| W12-05 | Theme | dark / light (O-045 closed by D-068), with contrast verified — decided in D-068 | ACCEPTED |
| W12-06 | Retention controls | event and history retention, `docs/DATA_AND_MEMORY.md` §7-§8 | ACCEPTED |
| W12-07 | Reset / export config | sanitized export; plaintext config never contains a key | ACCEPTED |
| W12-08 | Language | UI copy strings; Bengali first-class, not an afterthought | ACCEPTED |
| W12-09 | Section navigation | sub-tabs: general · providers · models · tools · access · logs | ACCEPTED |

### Region W13 — Access (`/settings/access`)

| ID | Element | Content | Status |
| --- | --- | --- | --- |
| W13-01 | Paired clients | name, interface, created, last seen, granted caps, currently connected | ACCEPTED |
| W13-02 | Pair new client | local-only action (D-053) — the UI explains why it is unavailable from a remote session | ACCEPTED |
| W13-03 | Revoke | immediate effect, also kills live streams | ACCEPTED |
| W13-04 | Restrict editor | add/remove capabilities per identity (D-054) | ACCEPTED |
| W13-05 | Listener mode | loopback state, bind address, warning if non-loopback | ACCEPTED |
| W13-06 | Tunnel control | enable (T3) with the reachable-identity list, current URL, stop, status | ACCEPTED |
| W13-07 | Telegram allow-list | user/chat ids, group policy, "unauthorized get nothing" note | ACCEPTED |
| W13-08 | Audit link | jumps to the audit tab with this client filtered | ACCEPTED |
| W13-09 | Gateway lifecycle | restart and shutdown buttons, both T3; restart names who gets disconnected (open task streams, this browser), and the UI shows `reconnecting` until the port answers — a restart with no visible reconnect state reads as a crash (D-058) | ACCEPTED |

### Region W14 — Logs & audit (`/logs`)

| ID | Element | Content | Status |
| --- | --- | --- | --- |
| W14-01 | Log view | level filter, text search, cursor paging, tail toggle | ACCEPTED |
| W14-02 | Redaction visibility | `redacted` markers shown as such — the user must learn the marker means "something was there" | ACCEPTED |
| W14-03 | Audit tab | who, which client, action, decision, tier, outcome, timestamps | ACCEPTED |
| W14-04 | Approval decisions tab | every prompt and its answer, including expired ones | ACCEPTED |
| W14-05 | Export sanitized diagnostics | copy-to-clipboard bundle, secret-scanned (`SECURITY.md` §14) | ACCEPTED |
| W14-06 | Correlation jump | log line ↔ request id ↔ task ↔ tool call, in both directions | ACCEPTED |
| W14-07 | Redaction assurance marker | a small "verified by tests" note rather than a scary disclaimer: redaction is a tested property (`SECURITY.md` §17), so this screen should not read like a warning nobody verified | ACCEPTED |

---

## 9. Onboarding & global surfaces

### Region W-O — Onboarding and global surfaces

| ID | Element | Content | Status |
| --- | --- | --- | --- |
| W-O1 | First-run wizard | the six steps of `docs/UI_UX_SPEC.md` §5, each with its one-line security consequence | ACCEPTED |
| W-O2 | Skip-everything path | read-only mode with approvals for all, so a nervous user still sees it work | ACCEPTED |
| W-O3 | Doctor panel | `crabby doctor` output in-page, each finding with a fix action | ACCEPTED |
| W-O4 | Modal/sheet rules | destructive action never pre-focused; mobile sheet, desktop modal | ACCEPTED |
| W-O5 | Toast rules | non-blocking only; anything needing a decision uses a banner or modal | ACCEPTED |
| W-O6 | Command palette | `Ctrl/Cmd-K` for actions, desktop only | ACCEPTED |
| W-O7 | Offline page | Gateway unreachable: exact restart command for Termux, not a generic retry | ACCEPTED |
| W-O8 | 404 / unknown route | redirect home with a note, no dead end | ACCEPTED |
| W-O9 | Help / shortcuts sheet | `?`; lists every key and every slash command | ACCEPTED |
| W-O10 | Accessibility | focus order, live regions for streaming, contrast, no color-only meaning (`docs/UI_UX_SPEC.md` §9) | ACCEPTED |

---

## 10. Coverage check

| Screen | Regions | Elements | Every state defined? |
| --- | --- | --- | --- |
| App shell | W1, W2 | 17 | W1 rows state degraded behavior; W2 trivial; containers listed as elements too |
| Sessions | W15 | 11 | switch mid-task, typed-delete count, origin attribution |
| Scheduled | W16 | 12 | paused/deferred/waiting states, backlog on resume, per-run approval trail |
| Chat | W3, W4 | 26 | yes (§2.3 empty, streaming, reconnect, error) |
| Tasks | W5, W6 | 19 | yes |
| Approvals | W-A | 12 | yes, incl. `conflict` and expired |
| Context & memory | W7, W8 | 16 | yes |
| Providers/models/tools | W9, W10, W11 | 25 | yes; deferred states included  |
| Extensions | W-E | 12 | yes, incl. quarantined and lock notice |
| Settings/access/logs | W12, W13, W14 | 25 | yes  |
| Onboarding/global | W-O | 10 | yes |
| **Total** | **19 regions** | **185 elements** | — |

Nothing in this file is optional by size. The count of rows still awaiting review is not repeated here — it is in `DECISIONS.md` §4B, computed by `scripts/check-docs.py`, because this sentence carried a number that had been stale for two rounds.

