# Element Review — TUI

> **Purpose:** the same treatment as `docs/review/WEB.md`, for the terminal interface. Every screen, every region,
> every element — one row at a time, read, edited, approved. Small things (the bell, the cursor glyph, one space of
> indentation) carry the same weight as big things (the message pane), because that is what D-055 says.
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
> **IDs:** `T` = TUI · region number (or `-letter` for a named region) · element number. Quote an ID when you want to
> change one thing.
>
> **The binding size case is 40 columns × 24 rows** (`docs/UI_UX_SPEC.md` §4). A row whose `Sizes` cell does not
> say what happens at 40 columns is not finished.
>
> **Review medium, and why it is not HTML:** a terminal screen cannot honestly be reviewed in a browser — the
> questions here are about reflow at 40 columns, what survives 8 colors, and whether a line can be selected and
> copied in Termux. So this inventory is reviewed as text. A mockup for it, if one is wanted, is an ANSI/plain-text
> rendering generated from these same rows — no such rendering exists yet, and nothing here claims one does.

---

## 1. App frame

### Region T1 — Root layout and pane switching

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| T1-01 | Root container | one primary pane plus the pinned status line (T2) | 40×24 minimum; grows | never two always-visible side panes at 40 columns | ACCEPTED |
| T1-02 | Pane switch row | `chat · tasks · jobs · approvals · logs · models` | one line; abbreviates to 3 chars at 40 columns | `Tab` cycles, `1`–`6` jumps; hidden while the help overlay is open, never while an approval waits | ACCEPTED |
| T1-03 | Active pane marker | the current pane name carries the marker | 1 char before the name | underline or `>` prefix depending on charset tier (T10-04) | ACCEPTED |
| T1-04 | Buffer choice | which screen buffer the app draws in and what the user keeps afterwards | whole screen | Open question **T1-A**; whichever is chosen, the help sheet states it — decided in D-061 | ACCEPTED |
| T1-05 | Resize handling | reflow on terminal size change | any width ≥40 | no crash, no lost scroll position; reflow debounced so dragging a desktop terminal does not redraw every frame | ACCEPTED |
| T1-06 | Below-40-column state | narrower than the design case | <40 columns | do not reflow into unreadability: status line + one pane, plus one line naming the minimum | ACCEPTED |
| T1-07 | Focus model | where keys go when a modal is up | n/a | the approvals modal takes focus; `Esc` closes only what is closable — a blocking approval is not closable (Web W-A11 parity) | ACCEPTED |
| T1-08 | Suspend and quit | `Ctrl-Z`, `Ctrl-Q`, quitting while a task runs | n/a | `Ctrl-C` cancels the task and does not quit (`docs/UI_UX_SPEC.md` §4); quitting with a running task confirms once and says in words whether the task survives | ACCEPTED |
| T1-09 | Startup before first frame | what is on screen while the Gateway starts | n/a | never a blank terminal: one line, then the frame; no fake progress bar | ACCEPTED |
| T1-10 | Reconnect inside the frame | Gateway unreachable while the TUI is open | one line in T2 | same meaning as Web W1-04: exact restart command, never a spinner pretending freshness (`docs/UI_UX_SPEC.md` §8) | ACCEPTED |

**Open question T1-A:** does the TUI draw in the alternate screen (clean, restores the shell afterwards, but the user
loses scrollback for output they wanted to copy) or inline (scrollback keeps everything, but the app does not clear
itself on exit)? Termux users live in scrollback; an approval modal wants a stable frame. Proposal: inline rendering
plus an explicit "print to scrollback" action for tool output, decided together with the O-051 measurement on a phone.

### Region T2 — Status line (pinned, every pane)

> **T1-A — closed (D-061).** Decided: **inline**. The frame draws in the normal buffer with Ink's line-diffed incremental mode, so scrollback survives, and any block can be pushed there explicitly with `print to scrollback`. Ink's own README states the scrollback buffer is unavailable while the alternate screen is active, and a phone user has no tmux to fall back to — so the alternate screen is the wrong default on the target device. A `alternateScreen` config key exists for a later measurement without a release, and T-O9 names the active mode, which is what this question was really guarding against.

| ID | Element | Content | Sizes | Behavior | Placement | Status |
| --- | --- | --- | --- | --- | --- | --- |
| T2-01 | Model field | `provider/model` + override marker + fallback marker when the ladder fired (D-043) | ≤18 columns at 40, provider abbreviated | no click target; `m` switches | left | ACCEPTED |
| T2-02 | Connection field | `live` / `reconnecting` / `offline` + last confirmed time | ≤12 columns | the word is always present, never color-only | right | ACCEPTED |
| T2-03 | Pending approvals count | number + the word `approval(s)` | ≤10 columns | non-zero is impossible to miss; `a` from any pane opens it | right | ACCEPTED |
| T2-04 | Tunnel field | `off` / `on:<short host>` | ≤14 columns | reserved color in the 16-color tier, word in the 8-color tier (`docs/DESIGN_SYSTEM.md` §2.1, §9) | right | ACCEPTED |
| T2-05 | Vault field | `locked` / `ok` | ≤8 columns | while locked, everything needing a secret says so instead of appearing to hang | right | ACCEPTED |
| T2-06 | Task state field | running task + state word + step `12/17` | ≤22 columns, ellipsis in the middle | present only when this session has a task | left, after model | ACCEPTED |
| T2-07 | Elapsed and queue field | elapsed of the running task; queued count when more than one | ≤10 columns | one field, not two, so 40 columns survives | left | ACCEPTED |
| T2-08 | Drop order at 40 columns | which fields disappear when they do not fit | 40 columns | drop: queue → tunnel → vault → task state; model, connection and approvals never drop | whole line | ACCEPTED |
| T2-09 | Copyable identifiers | task id and request id live on their own short line | one line each | because copying in Termux is long-press selection (`docs/UI_UX_SPEC.md` §4) | either end | ACCEPTED |

### Region T3 — Key hints and help

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| T3-01 | Hint strip | the keys for what is actually possible right now | one line; 6 hints max at 40 columns | always visible on narrow screens (`docs/UI_UX_SPEC.md` §9), not hidden behind `?` | ACCEPTED |
| T3-02 | Help overlay | every key, every slash command, and what happens to scrollback | full pane | `?` toggles, `Esc` closes; content matches the Web help sheet (W-O9) — same capability, different presentation | ACCEPTED |
| T3-03 | Unknown key feedback | what happens when a key does nothing | n/a | one line naming the key and the closest real binding; silence here reads as a hang | ACCEPTED |
| T3-04 | Per-pane re-binding | keys that mean something different per pane | n/a | `a` approves in approvals and is a literal in the composer; the hint strip is the authority and must be true in every pane | ACCEPTED |
| T3-05 | Dumb-terminal hints | when ANSI keys are not reportable | n/a | `TERM=dumb` drops the hint strip and prints the key list once at start instead of pretending | ACCEPTED |

**Open question T3-A:** are keys configurable in v1 at all? No decision in `DECISIONS.md` covers it, and the parity
rule (`docs/INTERFACES_AND_API.md` §8) forbids a shortcut-only capability either way. This stays a question for you
rather than becoming a spec line by accident.

---

> **T3-A — closed (D-061).** Decided: **not configurable in v1**. The hint strip is the authority on what a key does right now; a binding file would be a second source of truth for the same line, and `docs/INTERFACES_AND_API.md` §7.2 keeps one list. Revisit with a real conflict, not in advance.

## 2. Chat pane

### Region T4 — Message list

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| T4-01 | User message | text, timestamp, request id when asked for | full width, wrapped at current width | leading gutter ≤2 chars, so long-press selection lands on the whole message | ACCEPTED |
| T4-02 | Assistant message | markdown rendered to terminal text; model+provider on the first line of the turn | full width | emphasis and code become attributes when the charset tier allows, never literal asterisks | ACCEPTED |
| T4-03 | Code block | fenced block with language label | no reflow; horizontal scroll by line | a 300-character identifier must not break the frame (T1-05) | ACCEPTED |
| T4-04 | Diff view | unified at every width | full width | split view is a Web affordance (W3-10); 40 columns cannot hold two columns | ACCEPTED |
| T4-05 | Streaming text | grows line-buffered | n/a | no full-screen re-layout per token — flicker on a phone terminal is a usability defect (`docs/UI_UX_SPEC.md` §4) | ACCEPTED |
| T4-06 | Stream stall marker | `no output for Ns` | one line | replaces the cursor glyph while stalled; the glyph is hidden, not left blinking | ACCEPTED |
| T4-07 | Tool call line, collapsed | `tool · tier · status · duration` | one line | expands to T4-08; policy-blocked calls stay listed forever | ACCEPTED |
| T4-08 | Tool call line, expanded | args with `redacted` markers, output with truncation label, exit/cancel state | up to 20 lines, then paged | `redacted` printed as a word so the user learns something was there (W14-02 parity) | ACCEPTED |
| T4-09 | Approval card in the list | the same card as Web W3-06, rendered as text | up to 12 lines | answering from any interface wins; a stale answer prints `conflict` and changes nothing (W-A10) | ACCEPTED |
| T4-10 | System event line | compaction, memory injection, mid-task model switch (D-043), auto-resume after restart | one line, subtle attribute | never reachable only by scrolling back: it sits in the stream where it happened | ACCEPTED |
| T4-11 | Error panel | code, one human line, what completed, what is pending, resumable, request id | up to 8 lines | there is no toast in a terminal: the panel stays in the list (`docs/UI_UX_SPEC.md` §3) | ACCEPTED |
| T4-12 | Scroll position held | user scrolled up while content arrives | n/a | position held, plus a one-line `new content (3)` note — the Web W3-13 affordance expressed as text | ACCEPTED |
| T4-13 | Reconnect reconciliation | what changed while the terminal was disconnected | up to 4 lines | truth comes from `GET /tasks/{id}`, not from replayed events alone (D-049) | ACCEPTED |
| T4-14 | Task link line | which task this turn belongs to | one line | `Enter` opens the task detail pane (T7) | ACCEPTED |
| T4-15 | Long non-Latin text | Bengali paragraphs, combining marks, very long paths | full width | governed by open question **T-C2-B**; the row exists so the limit is a decision and not a surprise — decided in D-062 | ACCEPTED |

**Open question T4-A:** does the TUI render markdown at all, or pass text through raw? Rendering costs a re-layout
per token batch and can mangle code; raw text is cheap and copyable. Proposal: render only emphasis and code spans,
leave headings as text, and never touch fenced blocks.

### Region T5 — Composer

> **T4-A — closed (D-061).** Decided: **a named subset**. Emphasis, code spans and fenced blocks render; tables, nested lists and inline HTML pass through as text; the `--plain` switch (C2-02) turns rendering off entirely, and the TUI honours it the same way. Rendering more buys a re-layout on every resize for formatting a phone terminal cannot show.

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| T5-01 | Input area | multiline, draft persisted per session | starts at 1 line, grows to 6 then scrolls | `Enter` sends; newline needs its own key because terminals mostly cannot report `Shift+Enter` (see **T5-A**) — decided in D-061 | ACCEPTED |
| T5-02 | Real cursor | terminal cursor at the edit position | 1 cell | not a drawn block: Termux's IME and its editing keys only behave around a real cursor | ACCEPTED |
| T5-03 | Slash command menu | `/model` `/compact` `/pin` `/task` `/cancel` | up to 6 lines under the input | filtered as typed; every command also has a visible control in Web (`docs/INTERFACES_AND_API.md` §8) | ACCEPTED |
| T5-04 | File attach | path typed or picked from workspace roots | one line per path | paths as text, no blob preview; the deny-list applies (`SECURITY.md` §8) | ACCEPTED |
| T5-05 | This-turn model switch | one-turn override | one line | prints the capability delta warning if the target lacks tool calling (D-045) | ACCEPTED |
| T5-06 | Capability summary before send | `fs: workspace · net: off · shell: off` | one line | visible before sending, exactly like Web W4-06 | ACCEPTED |
| T5-06a | Capability line's source | the composer's local facts; `GET /whoami` (D-133) states the same truth on the wire | — | a pane that wants the install's real surface reads the route rather than re-deriving one; deliberately verbless in the CLI (recorded there) | ACCEPTED |
| T5-07 | Send vs stop | one control, two states | one line | stop means the cancel endpoint's semantics: finish the current step, then settle — never a local hide | ACCEPTED |
| T5-08 | Queue | messages sent while a task runs | count + `q` lists them | queued, not interrupting; reorder and drop available in that list | ACCEPTED |
| T5-09 | Input history | previous inputs via `↑` when the composer is empty | n/a | per session, and it must not swallow `↑` for scrolling in a pane that scrolls | ACCEPTED |
| T5-10 | Token estimate of the draft | approximate, labeled as an estimate | one line | same honesty rule as W4-09 and O-031 — decided in D-064 | ACCEPTED |

**Open question T5-A:** newline. Browsers distinguish `Shift+Enter`; terminals mostly cannot. Options: `Ctrl-J`, a
trailing `\` continuation, or an explicit multiline mode. The constraint is what a phone keyboard can actually send
from Termux, so this belongs with the M0 device measurements (O-002), not with taste.

---

> **T5-A — closed (D-061).** Decided: **`Ctrl+J` is the newline key, always available**, `Shift+Enter` and `Alt+Enter` are enabled only when the terminal answers an extended-key query, and `Enter` always sends. A legacy terminal reports `Shift+Enter` as `CR`, byte-identical to send, and Termux's own support is documented as unclear — a composer whose newline depends on negotiation breaks on the primary platform. Whether negotiation succeeds on a real device stays a measurement (O-002's list), but the design no longer waits on it, because `Ctrl+J` works either way.

## 3. Tasks

### Region T6 — Task list

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| T6-01 | Filter row | state filter + session filter | one line, two fields | at 40 columns one field at a time; `f` toggles which | ACCEPTED |
| T6-02 | Task card | title, state word, progress, model, pending-approval mark, elapsed | 3 lines per card | no glyph soup: `12/17 (est +2)` is the fallback when blocks are unavailable | ACCEPTED |
| T6-03 | Progress representation | measured vs estimated distinction | one line | the distinction is a rule, not a decoration (`docs/UI_UX_SPEC.md` §6) | ACCEPTED |
| T6-04 | Inline actions | open · watch · cancel · resume | one line | cancelling needs no modal, same as Web W5-03 | ACCEPTED |
| T6-05 | New task | opens the new-task form in-pane | n/a | equivalent of Web W5-04 and `crabby task run` | ACCEPTED |
| T6-06 | Empty state | one action, one hint | up to 3 lines | teaches the key and the CLI equivalent; a blank pane is a defect | ACCEPTED |
| T6-07 | Bulk selection | absent in v1, on purpose | n/a | recorded so it is not mistaken for an oversight (same rule as W5-06) | ACCEPTED |
| T6-08 | Row selection cursor | which card the keys act on | n/a | must survive 8 colors: bold plus `>` prefix, never a highlight that vanishes | ACCEPTED |

### Region T7 — Task detail

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| T7-01 | Header | objective (editable until running), id, state, tier floor, created/updated | 3 lines | the id gets its own selectable line (T2-09) | ACCEPTED |
| T7-02 | Plan tree | ordered steps with dependencies as indentation | 1 line per step | indentation with spaces, not box-drawing, so the ASCII tier reads identically (T10-04) | ACCEPTED |
| T7-03 | Step row | status, tool, tier, duration, attempt count `3/5` | one line | the attempt count names the ladder stage, not just a number | ACCEPTED |
| T7-04 | Step log | per-step output, truncated with a label | paged | `Enter` on the step, `q` back; never dumps 200 KB into the terminal | ACCEPTED |
| T7-05 | Approval panel | pending here + answered-elsewhere history | n/a | `a` from anywhere lands here | ACCEPTED |
| T7-06 | Cancellation panel | requested → finishing current step → terminal state | 3 lines | three explicit phases, same as Web W6-06 | ACCEPTED |
| T7-07 | Checkpoint panel | what is saved, when, and what a resume repeats vs skips | up to 4 lines | D-044 wording: resume continues, it never restarts | ACCEPTED |
| T7-08 | Provider ladder panel | retries per stage, the ask-prompt that appeared, chosen model, resumed-from confirmation | up to 5 lines | the disclosure that a privacy boundary was crossed belongs in this panel, not in a footnote | ACCEPTED |
| T7-09 | Error and retry history | every failure with class and outcome | paged | classes from `PROVIDERS_AND_TOOLS.md` §3.5, printed verbatim so they can be searched | ACCEPTED |
| T7-10 | Artifacts | files written, sizes, scratch cleanup state | up to 4 lines | leftovers are reported, never silently deleted | ACCEPTED |
| T7-11 | Result | final output, partial-completion disclosure, what did not happen | n/a | "what did not happen" is a required section, not an optional one | ACCEPTED |
| T7-12 | Actions | cancel · resume · retry failed step · duplicate · export · delete | one line | destructive ones confirm (same rule as Web W-O4) | ACCEPTED |
| T7-13 | Live tail toggle | this task's events only | n/a | on while the pane is visible, off when backgrounded — battery is a real constraint on a phone | ACCEPTED |
| T7-14 | Narrow detail | what drops first as width shrinks | 40 columns | drop: created/updated → durations → artifact sizes; objective, state, approvals and error never drop | ACCEPTED |

---

## 3A. Sessions

> `docs/INTERFACES_AND_API.md` §7.2 names "session switcher" as a required TUI view; region T16 is what makes that a
> thing with parts (F-10).

### Region T16 — Session switcher

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| T16-01 | Switcher overlay | all sessions of this identity, newest activity first | ≤10 rows, then scroll | `s` opens it from any pane; inside the composer `s` stays a literal (T3-04 is the rule that decides this) | ACCEPTED |
| T16-02 | Row content | title, relative last activity, `running`/`awaiting approval` state word | 40 columns: title truncated in the middle, never the state word | the state word is the reason a user switches, so it wins the space fight | ACCEPTED |
| T16-03 | Current session | marked with `>` and the word `current` | 1 line | both, because the marker alone is 1 column of ambiguity in a 40-column frame | ACCEPTED |
| T16-04 | Overlay-local keys | `Enter` switch · `n` new · `t` title · `d` delete | one hint line | `d` denies outside this overlay and deletes inside it, exactly as `a` does in approvals; the hint line is the authority (T3-01) | ACCEPTED |
| T16-05 | Rename | title edit on the row, no separate dialog | one line | writes `PATCH /sessions/{id}`; the same write as the status line's title, so one of them cannot be stale | ACCEPTED |
| T16-06 | Delete confirm | counts turns and tasks, then asks for the title typed back | 3 lines | T3, and the typed word is the title, not `y` — at 40 columns a mistyped selection is plausible | ACCEPTED |
| T16-07 | Switch while a task runs | what the frame says afterwards | one line | the task keeps running and its events stop rendering; returning re-reads state from the Gateway rather than replaying a buffer (the same reconciliation as T4-13) | ACCEPTED |
| T16-08 | Session id line | the id of the highlighted session, on its own line | one line | long-press selectable (T2-09); a session that cannot be named has to be addressable in the CLI | ACCEPTED |

---

## 3B. Scheduled jobs

> Region T17 is the pane D-057 requires. Everything here is measured against `PROVIDERS_AND_TOOLS.md` §4.5: the
> point of the pane is that a user can see, from a phone, what a standing schedule is allowed to do and why it did not
> run.

### Region T17 — Jobs pane

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| T17-01 | Pane entry | `jobs` in the pane row, `3` jumps to it | one line | one of the six panes in T1-02; it is not a filter on the task list | ACCEPTED |
| T17-02 | Job row | name, schedule in words, next run, state word | 40 columns: `name` + `state`, schedule on the line below | the cron string is on the detail line, never the only representation | ACCEPTED |
| T17-03 | State words | `active` / `paused` / `waiting on approval` / `deferred: vault locked` / `failing` | one word | words only, no color dependence (T-C1), and `waiting on approval` is never truncated away | ACCEPTED |
| T17-04 | Detail view | capability set the job holds, its identity, last runs with outcomes | ≤12 rows | what it may touch, as granted — the TUI answer to "what did I authorize weeks ago" | ACCEPTED |
| T17-05 | Row keys | `p` pause/resume · `n` run now · `e` edit · `d` delete | one hint line | per-pane rebinding is legal here (T3-04) and the hint line is the authority; delete asks for the job name typed back | ACCEPTED |
| T17-06 | Edit flow | schedule and objective, then the re-approval notice | 4–6 lines | saving names which steps now need approval again, because editing a job changes what the standing authorization covers | ACCEPTED |
| T17-07 | Missed-run backlog | `N runs missed while Termux was killed` | 3 lines | one prompt with three answers (latest / each / skip all); it never fires a burst and never drops them silently — this is the Android failure mode §4.5 was written for | ACCEPTED |
| T17-08 | Run waiting for a human | the run that cannot proceed | 1 line in the row, plus T2-03's count | a deferred run raises the pending-approval count on the status line, so the pane is not the only place the stall is visible | ACCEPTED |

---

## 4. Approvals

### Region T-A — Approvals: the modal, the only thing allowed to steal focus

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| T-A1 | Modal frame | the one pending item, oldest first | up to 20 rows in a 24-row terminal | everything else is inert while it is up; no scrolling the chat behind it | ACCEPTED |
| T-A2 | Action summary | one sentence, second person, no hedging | up to 3 lines | same wording rule as Web W-A2 (`docs/UI_UX_SPEC.md` §10) | ACCEPTED |
| T-A3 | Exact target | the real command / path / recipient / URL / SQL | own line, never paraphrased | if it exceeds the width it stays on its own line and wraps; it is never truncated in the middle | ACCEPTED |
| T-A4 | Consequence and reversibility | what changes, whether undo exists, what an undo costs | 2 lines | both parts required; `reversible: unknown` is a legal value and must be printed as one | ACCEPTED |
| T-A5 | Expiry countdown | remaining time + why it expires | one line | per-tier duration is decided in D-064 | ACCEPTED |
| T-A6 | Approve once | `a` | one line | the only affirmative action in v1 (D-052) — there is no "always allow" key | ACCEPTED |
| T-A7 | Deny | `d`, then an optional reason on the next line | one line | the reason is recorded on the task | ACCEPTED |
| T-A8 | Show related task | `t` | one line | jumps to T7 without losing the pending item; answering from there is still one keystroke | ACCEPTED |
| T-A9 | Bell | terminal bell on arrival | n/a | opt-in and off by default; when off, the status-line count (T2-03) is the only signal, and that trade is stated | ACCEPTED |
| T-A10 | Stale-answer conflict | a second answer arriving from another interface | one line | prints `conflict`: first answer won, nothing ran twice (W-A10 parity) | ACCEPTED |
| T-A11 | No dismissal | `Esc` inside the modal | n/a | `Esc` neither answers nor closes it; it can only move focus onto the buttons — a blocking thing stays blocking | ACCEPTED |
| T-A12 | Why am I being asked | `?` inside the modal | up to 4 lines | names the rule and tier that produced the prompt and where to change it, so the user fixes config instead of resenting the prompt | ACCEPTED |
| T-A13 | Typed answer as an alternative | typing `yes` / `no` besides the keys | one line | accepted, because one letter on a phone keyboard is a mis-tap risk; ambiguity (e.g. `y` meaning retry) is not allowed | ACCEPTED |
| T-A14 | Queue walk | `n` next, `p` previous, header reads `2 of 5` | one char each, plus the count line | the consequence of one-card display (D-061): the queue has to be walkable without dismissing the item in front of you, and the count has to stay visible while it is walked, or "how many am I ignoring" becomes unanswerable at exactly the moment it matters | ACCEPTED |

**Open question T-A-A:** with two items pending, the modal shows one at a time. Alternative: a list with a cursor.
One-at-a-time is proposed because a queue invites answering without reading, and 24 rows cannot hold two full
readable cards anyway.

---

> **T-A-A — closed (D-061).** Decided: **one card at a time**, header `2 of 5`, `n`/`p` to walk the queue, and the count also sits in the status line so the queue size is visible from any pane. Twenty-four rows cannot hold two readable cards, and a readable risk line is the one thing an approval may not lose.

## 5. Context and memory

### Region T8 — Context

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| T8-01 | Budget line | used / available, counted-vs-estimated flag, reserve for output | one line | an estimate carries `~`, because that is the entire point (O-031 closed by D-064) | ACCEPTED |
| T8-02 | What is in context | system, pinned, recent turns, retrieved memory, tool results, each with cost | up to 6 lines | a section costing 0 shows `0` instead of hiding, so the shape is visible | ACCEPTED |
| T8-03 | What was compacted | summary card + where the originals live | 3 lines | never implies the original is gone (D-027) | ACCEPTED |
| T8-04 | Pin / unpin | per message, file, decision | one line | same three targets as Web W7-04 | ACCEPTED |
| T8-05 | Remove from next turn | exclude one item without deleting it | one line | `x` on a context section | ACCEPTED |
| T8-06 | Provenance of injected memory | which memory, which session, trust label | 1 line per item | low-trust items labeled, not mixed in silently (`SECURITY.md` §10) | ACCEPTED |
| T8-07 | Force compact | with a preview of what it would summarize | n/a | same endpoint as Web W7-07; preview before it runs | ACCEPTED |
| T8-08 | Overflow warning | next turn exceeds this model's window, plus the two fixes | 2 lines | shown before sending, not as an error afterwards | ACCEPTED |

### Region T9 — Memory

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| T9-01 | Entry list | text, category, provenance, trust label, created/updated | 2 lines per entry | text search only in v1 (D-021) | ACCEPTED |
| T9-02 | Search field | query | one line | results replace the list, and the line says how many entries were filtered out | ACCEPTED |
| T9-03 | Edit | user edits are authoritative over agent-authored text | n/a | uses the terminal's own editing behavior with an explicit save; no half-modal editor | ACCEPTED |
| T9-04 | Delete / forget | single entry, plus "forget everything about X" | n/a | the broad one is T3 and says what it means before asking | ACCEPTED |
| T9-05 | Auto-memory toggle | on/off + confidence threshold | one line | one key, because a switch you have to hunt for is not a kill switch | ACCEPTED |
| T9-06 | Pending queue | proposals awaiting review when policy says "propose, don't store" | 1 line per item | `y`/`n` per item; the count is in the pane title so it cannot be ignored | ACCEPTED |
| T9-07 | External-content marker | memories derived from untrusted content are T2 until confirmed | one word | same rule as Web W8-07 | ACCEPTED |
| T9-08 | Propagation preview | "deleting this affects N conversations' summaries" before committing | 2 lines | `docs/DATA_AND_MEMORY.md` §7 | ACCEPTED |

---

## 6. Providers, models, tools

### Region T10 — Providers

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| T10-01 | Provider list | preset vs user-defined, base URL in full, model count, last success | 2 lines per provider | a base URL is not a secret and is never masked (`PROVIDERS_AND_TOOLS.md` §3.3) | ACCEPTED |
| T10-02 | Add endpoint form | name, base URL, key reference, model ids | one line per field | adding an endpoint needs no code change and no release (D-041) | ACCEPTED |
| T10-03 | Key entry | reference only: `vault://name` | one line | the typed key is never echoed and never read back; rotate and remove only | ACCEPTED |
| T10-04 | Charset tier | which glyphs this terminal renders | n/a | box-drawing and `✓ ✗ ● ▶` when capable, `ok/err/-/>` and spaces otherwise; meaning never lives in the glyph (`docs/UI_UX_SPEC.md` §6) | ACCEPTED |
| T10-05 | Test connection | latency + the error class name | one line | same result set as Web W9-04 | ACCEPTED |
| T10-06 | Insecure-transport warning | plain HTTP, or non-loopback with a key present | 2 lines | explicit acceptance, not a color (D-041's rule applies in every interface) | ACCEPTED |
| T10-07 | Remove provider | warns what falls over to the ask-prompt | one line | the warning names how many tasks are affected | ACCEPTED |
| T10-08 | Default model selector | per identity and per session | n/a | `m` in the composer is the same action, not a second source of truth | ACCEPTED |
| T10-09 | Fallback policy editor | off by default (D-047); per-identity ladder with class limits | up to 4 lines | the ≥5-retries-then-ask ladder is spelled out here so the behavior is not folklore | ACCEPTED |

### Region T11 — Models and capability overrides

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| T11-01 | Model list | provider, model, context, output cap, cost class | 1 line per model | at 40 columns: `provider/model` + context, the rest on the detail line | ACCEPTED |
| T11-02 | Capability matrix | reported vs effective per capability | 3 columns at 40 columns | highlighted override cells become a `*` suffix in the 8-color tier — never color alone | ACCEPTED |
| T11-03 | Override control | auto / force on / force off, per capability | one line | available for every model, including built-ins (D-045) | ACCEPTED |
| T11-04 | Limit inputs | context window, max output, reserve | 3 lines | numbers are typed, not stepped — 131072 is a lot of `+` presses | ACCEPTED |
| T11-05 | Forced-on notice | explains runtime verification and the failure it can produce | 2 lines | the same sentence as Web W10-05, so the interfaces cannot drift | ACCEPTED |
| T11-06 | Reset overrides | back to reported, per model | one line | says how many overrides will be lost | ACCEPTED |
| T11-07 | Probe action | per-capability pass/fail table | up to 8 lines | the probe endpoint's result printed as text, not as a color | ACCEPTED |
| T11-08 | Notes field | free text per model | one line | survives into the config file verbatim | ACCEPTED |
| T11-09 | T3 gate notice | editing overrides is a config write; an agent cannot widen its own model | one line | present in the TUI too, because hiding it here would make the TUI the escape hatch | ACCEPTED |

### Region T12 — Tools

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| T12-01 | Tool list | name, tier, capability, enabled, platform availability | 1 line per tool | sorted by tier then name, so the dangerous ones are together | ACCEPTED |
| T12-02 | Tier column | base tier plus the escalation rule for that tool | up to 2 lines | argument-dependent escalation as text: `file.write` T1 → T2 outside the root | ACCEPTED |
| T12-03 | Schema viewer | input/output schema, example call | paged | an example the user cannot copy is a screenshot, not a feature | ACCEPTED |
| T12-04 | Deferred tools | "not in this version" plus the reason | 1 line each | listed so absence is not mistaken for a bug (`EXTENSIONS.md` §3) | ACCEPTED |
| T12-05 | Shell toggle | off by default; enabling is a described action with the no-sandbox sentence | 2 lines | the sentence is in the confirm, not after it | ACCEPTED |
| T12-06 | Workspace roots editor | add/remove roots, with the deny-list applied to each | 1 line per root | shows the deny-list rows the user would otherwise have to trust (`SECURITY.md` §8) | ACCEPTED |
| T12-07 | Limits editor | timeouts, output caps, temp lifetime, parallel steps | up to 5 lines | the default is printed next to the current value | ACCEPTED |
| T12-08 | Per-task narrowing | mandatory vs opt-in decided in D-066; present for both | 2 lines | the same open question as Web W11-08, closed for both interfaces at once — decided in D-066 | ACCEPTED |

---

## 7. Extensions

### Region T-E — Extensions surface

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| T-E1 | Installed list | id, kind, version, source tier, verdict, enabled | 1–2 lines each | the verdict is a word, never a color | ACCEPTED |
| T-E2 | Install flow | path or git URL → validate → verdict → capability diff → approval | step lines | same pipeline as Web W-E2; a step skipped in the TUI is a defect | ACCEPTED |
| T-E3 | Verdict panel | compatible / partial / incompatible / unsafe + the exact failed check | up to 4 lines | `unsafe` cannot be overridden by anything, anywhere (D-036) | ACCEPTED |
| T-E4 | Missing-features list | itemized, never a generic warning | 1 line per feature | same text as Web W-E4 | ACCEPTED |
| T-E5 | Conversion report | mapped / dropped / reinterpreted / unknown, with version diff | paged | reports kept per version, never overwritten (D-039) | ACCEPTED |
| T-E6 | Capability grants | per extension, with revoke | 1 line per grant | revoking says when it takes effect (the next call) | ACCEPTED |
| T-E7 | Suspended state | reason, last error, re-enable that re-runs validation | up to 4 lines | prints the failing check, not "see the logs" | ACCEPTED |
| T-E8 | Uninstall | residual data disclosure; the purge option shown as T3 | 2 lines | same disclosure wording as Web W-E8 | ACCEPTED |
| T-E9 | MCP servers | transport, exact command line or URL, tool count, connection state, restart | 2 lines each | Crabby is a client only — no row here may imply it serves MCP (D-040) | ACCEPTED |
| T-E10 | Executable-kinds lock notice | not available in this version (D-038) | 2 lines | visible honesty in every interface, or the TUI becomes the workaround | ACCEPTED |
| T-E11 | Skill scaffold | create a skill skeleton in place | n/a | same as running the command in a shell, with no hidden extra step | ACCEPTED |
| T-E12 | Size and dependency report | install size and dependency count before approval | one line | printed before the approve key is offered (`EXTENSIONS.md` §9) | ACCEPTED |

---

## 8. Settings, access, logs

### Region T13 — Settings and config

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| T13-01 | Schema-driven form | no hand-coded fields; new keys appear automatically | 1 line per key | same source of truth as the Web form (W12-01) | ACCEPTED |
| T13-02 | Section navigation | general · providers · models · tools · access · logs | one line | the TUI twin of Web W12-09, added for the same reason | ACCEPTED |
| T13-03 | Diff before apply | exactly what changed | up to 6 lines | `-`/`+` lines, because that is what a user can paste into an issue | ACCEPTED |
| T13-04 | T3 markers | security-relevant rows flagged before the edit, not after | 1 marker | the marker is a word plus an attribute, never color alone | ACCEPTED |
| T13-05 | Density mode | comfortable / compact / reduced | one line | an explicit user choice, never auto-detected (`docs/DESIGN_SYSTEM.md` §8) | ACCEPTED |
| T13-06 | Color tier override | force 8 / 16 / 256 regardless of detection | one line | the escape hatch for a wrong detection (O-046 closed by D-068); without it a misdetection is unfixable — decided in D-068 | ACCEPTED |
| T13-07 | Retention controls | event and history retention | 2 lines | shows the current size, because "30 days" means nothing without bytes | ACCEPTED |
| T13-08 | Reset / export config | sanitized export only | n/a | the plaintext config never contains a key value | ACCEPTED |
| T13-09 | Language | UI copy strings; Bengali first-class | one line | subject to the same shaping caveat as T4-15, so it depends on **T-C2-B** — decided in D-062 | ACCEPTED |

### Region T14 — Access

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| T14-01 | Paired clients | name, interface, created, last seen, granted caps, connected | 2 lines each | "connected" is a word, not a green dot | ACCEPTED |
| T14-02 | Pair new client | local-only action (D-053) | n/a | the panel states which host the Gateway process is on, so "local" cannot be guessed wrong over ssh | ACCEPTED |
| T14-03 | Revoke | immediate, kills live streams | one line | prints how many streams it will kill first | ACCEPTED |
| T14-04 | Restrict editor | add/remove capabilities per identity (D-054) | 1 line per capability | removing a capability never converts it into an approval the same client can answer | ACCEPTED |
| T14-05 | Listener mode | bind address, loopback state, non-loopback warning | 2 lines | the warning names what becomes reachable | ACCEPTED |
| T14-06 | Tunnel control | enable (T3), current URL, stop, status | 2 lines | the URL is on its own line so it can be selected whole (T-C8) | ACCEPTED |
| T14-07 | Telegram allow-list | user/chat ids, group policy, "unauthorized get nothing" | up to 4 lines | same content as Web W13-07 | ACCEPTED |
| T14-09 | Gateway lifecycle | restart / shutdown, both T3 | 2 lines | restart warns which streams it kills and then the status line shows `reconnecting` — the terminal must not look dead while the Gateway comes back (D-058) | ACCEPTED |
| T14-08 | Audit jump | goes to the log view filtered to this client | one line | the filter stays visible after the jump, so the user knows they are looking at a subset | ACCEPTED |

### Region T15 — Logs and audit

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| T15-01 | Log view | level filter, text search, tail toggle | 1 line per entry | tail is the default and says `tail` while on, so silence is not mistaken for being dead | ACCEPTED |
| T15-02 | Redaction visibility | `redacted` printed as a word | in place | the user must learn the marker means something was there (W14-02) | ACCEPTED |
| T15-03 | Audit view | who, which client, action, decision, tier, outcome, timestamps | 2 lines per row | same fields as Web W14-03, same order | ACCEPTED |
| T15-04 | Approval decisions view | every prompt and its answer, expired included | 1–2 lines | expired is its own outcome, not a denial | ACCEPTED |
| T15-05 | Copy diagnostics | sanitized bundle written to a file, path printed | n/a | the clipboard is unreliable over ssh; a printed path always works | ACCEPTED |
| T15-06 | Correlation jump | log line ↔ request id ↔ task ↔ tool call, both directions | n/a | `Enter` on an id jumps; the reverse jump exists too | ACCEPTED |
| T15-07 | Redaction assurance note | verified by tests, not a scary disclaimer | one line | the same sentence as W14-07 | ACCEPTED |
| T15-08 | Volume control | how much is kept on screen at once | n/a | paged by ~200 lines; a terminal buffering 100k lines is a memory leak with good manners | ACCEPTED |

---

## 9. Terminal capability and degradation

### Region T-C — The rules every other region depends on

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| T-C1 | Color capability detection | 16 / 256 / 8-color paths, all required | n/a | the detection strategy is open (O-046 closed by D-068); until it lands, T13-06 is mandatory, not nice — decided in D-068 | ACCEPTED |
| T-C2 | `NO_COLOR` and `TERM=dumb` | no color, no box-drawing | n/a | meaning survives via words, punctuation, and placement (`docs/UI_UX_SPEC.md` §6) | ACCEPTED |
| T-C3 | Width tiers | 40 / 60 / 80 / 120 columns | n/a | wider adds columns, narrower never requires them — the §4 rule stated per element | ACCEPTED |
| T-C4 | Height tiers | 24 rows usable minimum | n/a | at 12 rows the modal (T-A1) switches to a compact card instead of clipping the target line | ACCEPTED |
| T-C5 | Attributes as semantics | bold/underline carry tier and state where color cannot | n/a | must survive 8 colors and grayscale printing (`docs/DESIGN_SYSTEM.md` §11) | ACCEPTED |
| T-C6 | Redraw cost | tokens per second the renderer can afford | n/a | measured on a phone in M0 P5 (O-051), not assumed; T4-05 and T15-08 depend on the number | ACCEPTED |
| T-C7 | Resize and selection | what is preserved across a resize | n/a | selection is lost when the terminal reflows — the help sheet says so instead of letting the user fight it | ACCEPTED |
| T-C8 | Selection and copy | everything meant to be copied fits on one line | n/a | ids, commands, URLs, and exact targets each get their own line for exactly this reason | ACCEPTED |
| T-C9 | Bengali in a terminal | shaping of combining marks and conjuncts | n/a | Open question **T-C2-B**; the answer decides T4-15 and T13-09 — decided in D-062 | ACCEPTED |
| T-C10 | Bell and noise | terminal bell, and nothing else that makes sound | n/a | bell only for approvals and only when enabled (T-A9) | ACCEPTED |
| T-C11 | No mouse dependence | keys and typed commands cover everything | n/a | clicking is a Web affordance; every TUI action is reachable by keys (parity rule) | ACCEPTED |
| T-C12 | Cell width assumptions | Bengali and emoji may not be one cell per character | n/a | wrapping is computed, never guessed from character count | ACCEPTED |

**Open question T-C2-B:** a terminal does not shape Indic text the way a browser does — conjuncts and matras can
render as separated marks depending on font and emulator. Options: (a) accept pass-through and state the limitation,
(b) keep UI chrome English-only while user content passes through as-is, (c) validate on the target devices first.
Proposal: (b) now, plus (c) as an M0 measurement — "Bengali first-class" is a promise about the product, and a
promise a terminal cannot keep has to be narrowed in words, not silently.

---

> **T-C2-B — closed (D-062).** Decided: **measure clusters, align nothing.** Widths come from grapheme clusters (`Intl.Segmenter`, present in Node 22 — measured, not assumed) and truncation happens only at cluster boundaries. Measured here: `দিয়েছি` is 7 code units and 7 code points but 3 clusters and 6 cells; `কিন্তু` is 6 units and 4 cells; cutting `দিয়েছি` at 3 code units yields `দিয` with the conjunct torn. Terminals disagree about Indic spacing marks, so no grid, ruler or box may contain non-Latin text: chrome stays English, content passes through unshaped, and the limit is stated in help rather than discovered.

## 10. First run and global surfaces

### Region T-O — Onboarding and global surfaces

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| T-O1 | First-run wizard | the six steps of `docs/UI_UX_SPEC.md` §5, in the TUI | one step per screen | each step prints its one-line security consequence — the same sentences as Web W-O1 | ACCEPTED |
| T-O2 | Skip path | read-only mode with approvals for everything | one line | a nervous user must reach a working task without enabling anything risky | ACCEPTED |
| T-O3 | Doctor | findings with fix actions, in-pane | 1–2 lines per finding | `crabby doctor` and this screen say the same thing; no separate dialect | ACCEPTED |
| T-O4 | Confirm dialog | destructive actions | up to 4 lines | default focus on cancel; the rule is which key `Enter` triggers, not which one looks grey | ACCEPTED |
| T-O5 | Notice rules | non-blocking notices are one line in the status area | one line | anything needing a decision uses the modal (T-A), never a fading line | ACCEPTED |
| T-O6 | Command palette | absent; the slash menu and `?` cover it | n/a | recorded so the absence is deliberate (the Web has W-O6, desktop-only) | ACCEPTED |
| T-O7 | Gateway down screen | the exact restart command for Termux | 3 lines | never a generic retry, because Android may have killed the process | ACCEPTED |
| T-O8 | Unknown input | a typo in a slash command or config key | 2 lines | names the closest real option and keeps the bad input on screen, so the user sees what was parsed | ACCEPTED |
| T-O9 | Help sheet | every key, every slash command, scrollback behavior, color tiers | full pane | states the T1-A choice explicitly — decided in D-061 | ACCEPTED |
| T-O10 | Accessibility checklist | no color-only meaning, visible focus, readable in 8 colors, nothing beyond the documented key set required | n/a | the TUI's accessibility is mostly the degradation rules in T-C; this row is the checklist for them | ACCEPTED |

---

## 11. Coverage check

| Screen | Regions | Elements | Every state defined? |
| --- | --- | --- | --- |
| Sessions | T16 | 8 | switch mid-task, typed-delete count, id selectable |
| Scheduled jobs | T17 | 8 | deferred/waiting states, backlog after a kill, per-run re-approval |
| App frame | T1, T2, T3 | 24 | resize, below-minimum, startup, reconnect, dumb terminal |
| Chat | T4, T5 | 25 | loading, streaming, stall, approval in list, error, reconnect, narrow |
| Tasks | T6, T7 | 22 | empty, no-bulk, cancel phases, checkpoint, ladder, 40-column drop order |
| Approvals | T-A | 14 | conflict, expiry, no-dismiss, bell-off, typed answer, queue walk |
| Context & memory | T8, T9 | 16 | overflow warning, pending queue, propagation preview |
| Providers/models/tools | T10, T11, T12 | 26 | insecure transport, forced-on, deferred tools |
| Extensions | T-E | 12 | suspended, locked, verdict-failed, pre-approval size report |
| Settings/access/logs | T13, T14, T15 | 26 | diff-before-apply, redaction, paging, color-tier escape hatch |
| Capability rules | T-C | 12 | this region is the degraded-state contract |
| Onboarding | T-O | 10 | skip, gateway down, unknown input, help |
| **Total** | **21 regions** | **203 elements** | — |

Two things this file must satisfy before `docs/UI_UX_SPEC.md` is regenerated from it (per D-055): every `Sizes`
cell states the 40-column outcome, and every open question here has an owner decision.

**Open questions:** all six are closed by the review round of 2026-10-10 — T1-A, T3-A, T4-A, T5-A and T-A-A by D-061, T-C2-B by D-062. Nothing in this inventory waits on a decision any more; what still waits is measurement on a physical phone (O-006 and O-051 for rendering cost and flicker, O-002 for the key negotiation), and those rows are labelled as unvalidated rather than accepted.






