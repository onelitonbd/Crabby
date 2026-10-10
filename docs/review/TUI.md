# Element Review — TUI

> **Purpose:** the same treatment as `docs/review/WEB.md`, for the terminal interface. Every screen, every region,
> every element — one row at a time, read, edited, approved. Small things (the bell, the cursor glyph, one space of
> indentation) carry the same weight as big things (the message pane), because that is what D-055 says.
>
> **Status legend for the `Status` column**
> `PROPOSED` = awaiting owner review · `ACCEPTED` = owner approved, spec locks · `EDIT` = owner changed it, text is
> being updated · `CUT` = owner removed it · `?` = owner asked a question, blocking
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
| T1-01 | Root container | one primary pane plus the pinned status line (T2) | 40×24 minimum; grows | never two always-visible side panes at 40 columns | PROPOSED |
| T1-02 | Pane switch row | `chat · tasks · approvals · logs · models` | one line; abbreviates to 3 chars at 40 columns | `Tab` cycles, `1`–`5` jumps; hidden while the help overlay is open, never while an approval waits | PROPOSED |
| T1-03 | Active pane marker | the current pane name carries the marker | 1 char before the name | underline or `>` prefix depending on charset tier (T10-04) | PROPOSED |
| T1-04 | Buffer choice | which screen buffer the app draws in and what the user keeps afterwards | whole screen | see open question **T1-A**; whichever is chosen, the help sheet states it | PROPOSED |
| T1-05 | Resize handling | reflow on terminal size change | any width ≥40 | no crash, no lost scroll position; reflow debounced so dragging a desktop terminal does not redraw every frame | PROPOSED |
| T1-06 | Below-40-column state | narrower than the design case | <40 columns | do not reflow into unreadability: status line + one pane, plus one line naming the minimum | PROPOSED |
| T1-07 | Focus model | where keys go when a modal is up | n/a | the approvals modal takes focus; `Esc` closes only what is closable — a blocking approval is not closable (Web W-A11 parity) | PROPOSED |
| T1-08 | Suspend and quit | `Ctrl-Z`, `Ctrl-Q`, quitting while a task runs | n/a | `Ctrl-C` cancels the task and does not quit (`docs/UI_UX_SPEC.md` §4); quitting with a running task confirms once and says in words whether the task survives | PROPOSED |
| T1-09 | Startup before first frame | what is on screen while the Gateway starts | n/a | never a blank terminal: one line, then the frame; no fake progress bar | PROPOSED |
| T1-10 | Reconnect inside the frame | Gateway unreachable while the TUI is open | one line in T2 | same meaning as Web W1-04: exact restart command, never a spinner pretending freshness (`docs/UI_UX_SPEC.md` §8) | PROPOSED |

**Open question T1-A:** does the TUI draw in the alternate screen (clean, restores the shell afterwards, but the user
loses scrollback for output they wanted to copy) or inline (scrollback keeps everything, but the app does not clear
itself on exit)? Termux users live in scrollback; an approval modal wants a stable frame. Proposal: inline rendering
plus an explicit "print to scrollback" action for tool output, decided together with the O-051 measurement on a phone.

### Region T2 — Status line (pinned, every pane)

| ID | Element | Content | Sizes | Behavior | Placement | Status |
| --- | --- | --- | --- | --- | --- | --- |
| T2-01 | Model field | `provider/model` + override marker + fallback marker when the ladder fired (D-043) | ≤18 columns at 40, provider abbreviated | no click target; `m` switches | left | PROPOSED |
| T2-02 | Connection field | `live` / `reconnecting` / `offline` + last confirmed time | ≤12 columns | the word is always present, never color-only | right | PROPOSED |
| T2-03 | Pending approvals count | number + the word `approval(s)` | ≤10 columns | non-zero is impossible to miss; `a` from any pane opens it | right | PROPOSED |
| T2-04 | Tunnel field | `off` / `on:<short host>` | ≤14 columns | reserved color in the 16-color tier, word in the 8-color tier (`docs/DESIGN_SYSTEM.md` §2.1, §9) | right | PROPOSED |
| T2-05 | Vault field | `locked` / `ok` | ≤8 columns | while locked, everything needing a secret says so instead of appearing to hang | right | PROPOSED |
| T2-06 | Task state field | running task + state word + step `12/17` | ≤22 columns, ellipsis in the middle | present only when this session has a task | left, after model | PROPOSED |
| T2-07 | Elapsed and queue field | elapsed of the running task; queued count when more than one | ≤10 columns | one field, not two, so 40 columns survives | left | PROPOSED |
| T2-08 | Drop order at 40 columns | which fields disappear when they do not fit | 40 columns | drop: queue → tunnel → vault → task state; model, connection and approvals never drop | whole line | PROPOSED |
| T2-09 | Copyable identifiers | task id and request id live on their own short line | one line each | because copying in Termux is long-press selection (`docs/UI_UX_SPEC.md` §4) | either end | PROPOSED |

### Region T3 — Key hints and help

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| T3-01 | Hint strip | the keys for what is actually possible right now | one line; 6 hints max at 40 columns | always visible on narrow screens (`docs/UI_UX_SPEC.md` §9), not hidden behind `?` | PROPOSED |
| T3-02 | Help overlay | every key, every slash command, and what happens to scrollback | full pane | `?` toggles, `Esc` closes; content matches the Web help sheet (W-O9) — same capability, different presentation | PROPOSED |
| T3-03 | Unknown key feedback | what happens when a key does nothing | n/a | one line naming the key and the closest real binding; silence here reads as a hang | PROPOSED |
| T3-04 | Per-pane re-binding | keys that mean something different per pane | n/a | `a` approves in approvals and is a literal in the composer; the hint strip is the authority and must be true in every pane | PROPOSED |
| T3-05 | Dumb-terminal hints | when ANSI keys are not reportable | n/a | `TERM=dumb` drops the hint strip and prints the key list once at start instead of pretending | PROPOSED |

**Open question T3-A:** are keys configurable in v1 at all? No decision in `DECISIONS.md` covers it, and the parity
rule (`docs/INTERFACES_AND_API.md` §8) forbids a shortcut-only capability either way. This stays a question for you
rather than becoming a spec line by accident.

---

## 2. Chat pane

### Region T4 — Message list

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| T4-01 | User message | text, timestamp, request id when asked for | full width, wrapped at current width | leading gutter ≤2 chars, so long-press selection lands on the whole message | PROPOSED |
| T4-02 | Assistant message | markdown rendered to terminal text; model+provider on the first line of the turn | full width | emphasis and code become attributes when the charset tier allows, never literal asterisks | PROPOSED |
| T4-03 | Code block | fenced block with language label | no reflow; horizontal scroll by line | a 300-character identifier must not break the frame (T1-05) | PROPOSED |
| T4-04 | Diff view | unified at every width | full width | split view is a Web affordance (W3-10); 40 columns cannot hold two columns | PROPOSED |
| T4-05 | Streaming text | grows line-buffered | n/a | no full-screen re-layout per token — flicker on a phone terminal is a usability defect (`docs/UI_UX_SPEC.md` §4) | PROPOSED |
| T4-06 | Stream stall marker | `no output for Ns` | one line | replaces the cursor glyph while stalled; the glyph is hidden, not left blinking | PROPOSED |
| T4-07 | Tool call line, collapsed | `tool · tier · status · duration` | one line | expands to T4-08; policy-blocked calls stay listed forever | PROPOSED |
| T4-08 | Tool call line, expanded | args with `redacted` markers, output with truncation label, exit/cancel state | up to 20 lines, then paged | `redacted` printed as a word so the user learns something was there (W14-02 parity) | PROPOSED |
| T4-09 | Approval card in the list | the same card as Web W3-06, rendered as text | up to 12 lines | answering from any interface wins; a stale answer prints `conflict` and changes nothing (W-A10) | PROPOSED |
| T4-10 | System event line | compaction, memory injection, mid-task model switch (D-043), auto-resume after restart | one line, subtle attribute | never reachable only by scrolling back: it sits in the stream where it happened | PROPOSED |
| T4-11 | Error panel | code, one human line, what completed, what is pending, resumable, request id | up to 8 lines | there is no toast in a terminal: the panel stays in the list (`docs/UI_UX_SPEC.md` §3) | PROPOSED |
| T4-12 | Scroll position held | user scrolled up while content arrives | n/a | position held, plus a one-line `new content (3)` note — the Web W3-13 affordance expressed as text | PROPOSED |
| T4-13 | Reconnect reconciliation | what changed while the terminal was disconnected | up to 4 lines | truth comes from `GET /tasks/{id}`, not from replayed events alone (D-049) | PROPOSED |
| T4-14 | Task link line | which task this turn belongs to | one line | `Enter` opens the task detail pane (T7) | PROPOSED |
| T4-15 | Long non-Latin text | Bengali paragraphs, combining marks, very long paths | full width | governed by open question **T-C2-B**; the row exists so the limit is a decision and not a surprise | PROPOSED |

**Open question T4-A:** does the TUI render markdown at all, or pass text through raw? Rendering costs a re-layout
per token batch and can mangle code; raw text is cheap and copyable. Proposal: render only emphasis and code spans,
leave headings as text, and never touch fenced blocks.

### Region T5 — Composer

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| T5-01 | Input area | multiline, draft persisted per session | starts at 1 line, grows to 6 then scrolls | `Enter` sends; newline needs its own key because terminals mostly cannot report `Shift+Enter` (see **T5-A**) | PROPOSED |
| T5-02 | Real cursor | terminal cursor at the edit position | 1 cell | not a drawn block: Termux's IME and its editing keys only behave around a real cursor | PROPOSED |
| T5-03 | Slash command menu | `/model` `/compact` `/pin` `/task` `/cancel` | up to 6 lines under the input | filtered as typed; every command also has a visible control in Web (`docs/INTERFACES_AND_API.md` §8) | PROPOSED |
| T5-04 | File attach | path typed or picked from workspace roots | one line per path | paths as text, no blob preview; the deny-list applies (`SECURITY.md` §8) | PROPOSED |
| T5-05 | This-turn model switch | one-turn override | one line | prints the capability delta warning if the target lacks tool calling (D-045) | PROPOSED |
| T5-06 | Capability summary before send | `fs: workspace · net: off · shell: off` | one line | visible before sending, exactly like Web W4-06 | PROPOSED |
| T5-07 | Send vs stop | one control, two states | one line | stop means the cancel endpoint's semantics: finish the current step, then settle — never a local hide | PROPOSED |
| T5-08 | Queue | messages sent while a task runs | count + `q` lists them | queued, not interrupting; reorder and drop available in that list | PROPOSED |
| T5-09 | Input history | previous inputs via `↑` when the composer is empty | n/a | per session, and it must not swallow `↑` for scrolling in a pane that scrolls | PROPOSED |
| T5-10 | Token estimate of the draft | approximate, labeled as an estimate | one line | same honesty rule as W4-09 and O-031 | PROPOSED |

**Open question T5-A:** newline. Browsers distinguish `Shift+Enter`; terminals mostly cannot. Options: `Ctrl-J`, a
trailing `\` continuation, or an explicit multiline mode. The constraint is what a phone keyboard can actually send
from Termux, so this belongs with the M0 device measurements (O-002), not with taste.

---

## 3. Tasks

### Region T6 — Task list

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| T6-01 | Filter row | state filter + session filter | one line, two fields | at 40 columns one field at a time; `f` toggles which | PROPOSED |
| T6-02 | Task card | title, state word, progress, model, pending-approval mark, elapsed | 3 lines per card | no glyph soup: `12/17 (est +2)` is the fallback when blocks are unavailable | PROPOSED |
| T6-03 | Progress representation | measured vs estimated distinction | one line | the distinction is a rule, not a decoration (`docs/UI_UX_SPEC.md` §6) | PROPOSED |
| T6-04 | Inline actions | open · watch · cancel · resume | one line | cancelling needs no modal, same as Web W5-03 | PROPOSED |
| T6-05 | New task | opens the new-task form in-pane | n/a | equivalent of Web W5-04 and `crabby task run` | PROPOSED |
| T6-06 | Empty state | one action, one hint | up to 3 lines | teaches the key and the CLI equivalent; a blank pane is a defect | PROPOSED |
| T6-07 | Bulk selection | absent in v1, on purpose | n/a | recorded so it is not mistaken for an oversight (same rule as W5-06) | PROPOSED |
| T6-08 | Row selection cursor | which card the keys act on | n/a | must survive 8 colors: bold plus `>` prefix, never a highlight that vanishes | PROPOSED |

### Region T7 — Task detail

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| T7-01 | Header | objective (editable until running), id, state, tier floor, created/updated | 3 lines | the id gets its own selectable line (T2-09) | PROPOSED |
| T7-02 | Plan tree | ordered steps with dependencies as indentation | 1 line per step | indentation with spaces, not box-drawing, so the ASCII tier reads identically (T10-04) | PROPOSED |
| T7-03 | Step row | status, tool, tier, duration, attempt count `3/5` | one line | the attempt count names the ladder stage, not just a number | PROPOSED |
| T7-04 | Step log | per-step output, truncated with a label | paged | `Enter` on the step, `q` back; never dumps 200 KB into the terminal | PROPOSED |
| T7-05 | Approval panel | pending here + answered-elsewhere history | n/a | `a` from anywhere lands here | PROPOSED |
| T7-06 | Cancellation panel | requested → finishing current step → terminal state | 3 lines | three explicit phases, same as Web W6-06 | PROPOSED |
| T7-07 | Checkpoint panel | what is saved, when, and what a resume repeats vs skips | up to 4 lines | D-044 wording: resume continues, it never restarts | PROPOSED |
| T7-08 | Provider ladder panel | retries per stage, the ask-prompt that appeared, chosen model, resumed-from confirmation | up to 5 lines | the disclosure that a privacy boundary was crossed belongs in this panel, not in a footnote | PROPOSED |
| T7-09 | Error and retry history | every failure with class and outcome | paged | classes from `PROVIDERS_AND_TOOLS.md` §3.5, printed verbatim so they can be searched | PROPOSED |
| T7-10 | Artifacts | files written, sizes, scratch cleanup state | up to 4 lines | leftovers are reported, never silently deleted | PROPOSED |
| T7-11 | Result | final output, partial-completion disclosure, what did not happen | n/a | "what did not happen" is a required section, not an optional one | PROPOSED |
| T7-12 | Actions | cancel · resume · retry failed step · duplicate · export · delete | one line | destructive ones confirm (same rule as Web W-O4) | PROPOSED |
| T7-13 | Live tail toggle | this task's events only | n/a | on while the pane is visible, off when backgrounded — battery is a real constraint on a phone | PROPOSED |
| T7-14 | Narrow detail | what drops first as width shrinks | 40 columns | drop: created/updated → durations → artifact sizes; objective, state, approvals and error never drop | PROPOSED |

---

## 3A. Sessions

> `docs/INTERFACES_AND_API.md` §7.2 names "session switcher" as a required TUI view; region T16 is what makes that a
> thing with parts (F-10).

### Region T16 — Session switcher

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| T16-01 | Switcher overlay | all sessions of this identity, newest activity first | ≤10 rows, then scroll | `s` opens it from any pane; inside the composer `s` stays a literal (T3-04 is the rule that decides this) | PROPOSED |
| T16-02 | Row content | title, relative last activity, `running`/`awaiting approval` state word | 40 columns: title truncated in the middle, never the state word | the state word is the reason a user switches, so it wins the space fight | PROPOSED |
| T16-03 | Current session | marked with `>` and the word `current` | 1 line | both, because the marker alone is 1 column of ambiguity in a 40-column frame | PROPOSED |
| T16-04 | Overlay-local keys | `Enter` switch · `n` new · `t` title · `d` delete | one hint line | `d` denies outside this overlay and deletes inside it, exactly as `a` does in approvals; the hint line is the authority (T3-01) | PROPOSED |
| T16-05 | Rename | title edit on the row, no separate dialog | one line | writes `PATCH /sessions/{id}`; the same write as the status line's title, so one of them cannot be stale | PROPOSED |
| T16-06 | Delete confirm | counts turns and tasks, then asks for the title typed back | 3 lines | T3, and the typed word is the title, not `y` — at 40 columns a mistyped selection is plausible | PROPOSED |
| T16-07 | Switch while a task runs | what the frame says afterwards | one line | the task keeps running and its events stop rendering; returning re-reads state from the Gateway rather than replaying a buffer (the same reconciliation as T4-13) | PROPOSED |
| T16-08 | Session id line | the id of the highlighted session, on its own line | one line | long-press selectable (T2-09); a session that cannot be named has to be addressable in the CLI | PROPOSED |

---

## 4. Approvals

### Region T-A — Approvals: the modal, the only thing allowed to steal focus

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| T-A1 | Modal frame | the one pending item, oldest first | up to 20 rows in a 24-row terminal | everything else is inert while it is up; no scrolling the chat behind it | PROPOSED |
| T-A2 | Action summary | one sentence, second person, no hedging | up to 3 lines | same wording rule as Web W-A2 (`docs/UI_UX_SPEC.md` §10) | PROPOSED |
| T-A3 | Exact target | the real command / path / recipient / URL / SQL | own line, never paraphrased | if it exceeds the width it stays on its own line and wraps; it is never truncated in the middle | PROPOSED |
| T-A4 | Consequence and reversibility | what changes, whether undo exists, what an undo costs | 2 lines | both parts required; `reversible: unknown` is a legal value and must be printed as one | PROPOSED |
| T-A5 | Expiry countdown | remaining time + why it expires | one line | per-tier duration is still open (O-041) | PROPOSED |
| T-A6 | Approve once | `a` | one line | the only affirmative action in v1 (D-052) — there is no "always allow" key | PROPOSED |
| T-A7 | Deny | `d`, then an optional reason on the next line | one line | the reason is recorded on the task | PROPOSED |
| T-A8 | Show related task | `t` | one line | jumps to T7 without losing the pending item; answering from there is still one keystroke | PROPOSED |
| T-A9 | Bell | terminal bell on arrival | n/a | opt-in and off by default; when off, the status-line count (T2-03) is the only signal, and that trade is stated | PROPOSED |
| T-A10 | Stale-answer conflict | a second answer arriving from another interface | one line | prints `conflict`: first answer won, nothing ran twice (W-A10 parity) | PROPOSED |
| T-A11 | No dismissal | `Esc` inside the modal | n/a | `Esc` neither answers nor closes it; it can only move focus onto the buttons — a blocking thing stays blocking | PROPOSED |
| T-A12 | Why am I being asked | `?` inside the modal | up to 4 lines | names the rule and tier that produced the prompt and where to change it, so the user fixes config instead of resenting the prompt | PROPOSED |
| T-A13 | Typed answer as an alternative | typing `yes` / `no` besides the keys | one line | accepted, because one letter on a phone keyboard is a mis-tap risk; ambiguity (e.g. `y` meaning retry) is not allowed | PROPOSED |

**Open question T-A-A:** with two items pending, the modal shows one at a time. Alternative: a list with a cursor.
One-at-a-time is proposed because a queue invites answering without reading, and 24 rows cannot hold two full
readable cards anyway.

---

## 5. Context and memory

### Region T8 — Context

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| T8-01 | Budget line | used / available, counted-vs-estimated flag, reserve for output | one line | an estimate carries `~`, because that is the entire point (O-031) | PROPOSED |
| T8-02 | What is in context | system, pinned, recent turns, retrieved memory, tool results, each with cost | up to 6 lines | a section costing 0 shows `0` instead of hiding, so the shape is visible | PROPOSED |
| T8-03 | What was compacted | summary card + where the originals live | 3 lines | never implies the original is gone (D-027) | PROPOSED |
| T8-04 | Pin / unpin | per message, file, decision | one line | same three targets as Web W7-04 | PROPOSED |
| T8-05 | Remove from next turn | exclude one item without deleting it | one line | `x` on a context section | PROPOSED |
| T8-06 | Provenance of injected memory | which memory, which session, trust label | 1 line per item | low-trust items labeled, not mixed in silently (`SECURITY.md` §10) | PROPOSED |
| T8-07 | Force compact | with a preview of what it would summarize | n/a | same endpoint as Web W7-07; preview before it runs | PROPOSED |
| T8-08 | Overflow warning | next turn exceeds this model's window, plus the two fixes | 2 lines | shown before sending, not as an error afterwards | PROPOSED |

### Region T9 — Memory

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| T9-01 | Entry list | text, category, provenance, trust label, created/updated | 2 lines per entry | text search only in v1 (D-021) | PROPOSED |
| T9-02 | Search field | query | one line | results replace the list, and the line says how many entries were filtered out | PROPOSED |
| T9-03 | Edit | user edits are authoritative over agent-authored text | n/a | uses the terminal's own editing behavior with an explicit save; no half-modal editor | PROPOSED |
| T9-04 | Delete / forget | single entry, plus "forget everything about X" | n/a | the broad one is T3 and says what it means before asking | PROPOSED |
| T9-05 | Auto-memory toggle | on/off + confidence threshold | one line | one key, because a switch you have to hunt for is not a kill switch | PROPOSED |
| T9-06 | Pending queue | proposals awaiting review when policy says "propose, don't store" | 1 line per item | `y`/`n` per item; the count is in the pane title so it cannot be ignored | PROPOSED |
| T9-07 | External-content marker | memories derived from untrusted content are T2 until confirmed | one word | same rule as Web W8-07 | PROPOSED |
| T9-08 | Propagation preview | "deleting this affects N conversations' summaries" before committing | 2 lines | `docs/DATA_AND_MEMORY.md` §7 | PROPOSED |

---

## 6. Providers, models, tools

### Region T10 — Providers

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| T10-01 | Provider list | preset vs user-defined, base URL in full, model count, last success | 2 lines per provider | a base URL is not a secret and is never masked (`PROVIDERS_AND_TOOLS.md` §3.3) | PROPOSED |
| T10-02 | Add endpoint form | name, base URL, key reference, model ids | one line per field | adding an endpoint needs no code change and no release (D-041) | PROPOSED |
| T10-03 | Key entry | reference only: `vault://name` | one line | the typed key is never echoed and never read back; rotate and remove only | PROPOSED |
| T10-04 | Charset tier | which glyphs this terminal renders | n/a | box-drawing and `✓ ✗ ● ▶` when capable, `ok/err/-/>` and spaces otherwise; meaning never lives in the glyph (`docs/UI_UX_SPEC.md` §6) | PROPOSED |
| T10-05 | Test connection | latency + the error class name | one line | same result set as Web W9-04 | PROPOSED |
| T10-06 | Insecure-transport warning | plain HTTP, or non-loopback with a key present | 2 lines | explicit acceptance, not a color (D-041's rule applies in every interface) | PROPOSED |
| T10-07 | Remove provider | warns what falls over to the ask-prompt | one line | the warning names how many tasks are affected | PROPOSED |
| T10-08 | Default model selector | per identity and per session | n/a | `m` in the composer is the same action, not a second source of truth | PROPOSED |
| T10-09 | Fallback policy editor | off by default (D-047); per-identity ladder with class limits | up to 4 lines | the ≥5-retries-then-ask ladder is spelled out here so the behavior is not folklore | PROPOSED |

### Region T11 — Models and capability overrides

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| T11-01 | Model list | provider, model, context, output cap, cost class | 1 line per model | at 40 columns: `provider/model` + context, the rest on the detail line | PROPOSED |
| T11-02 | Capability matrix | reported vs effective per capability | 3 columns at 40 columns | highlighted override cells become a `*` suffix in the 8-color tier — never color alone | PROPOSED |
| T11-03 | Override control | auto / force on / force off, per capability | one line | available for every model, including built-ins (D-045) | PROPOSED |
| T11-04 | Limit inputs | context window, max output, reserve | 3 lines | numbers are typed, not stepped — 131072 is a lot of `+` presses | PROPOSED |
| T11-05 | Forced-on notice | explains runtime verification and the failure it can produce | 2 lines | the same sentence as Web W10-05, so the interfaces cannot drift | PROPOSED |
| T11-06 | Reset overrides | back to reported, per model | one line | says how many overrides will be lost | PROPOSED |
| T11-07 | Probe action | per-capability pass/fail table | up to 8 lines | the probe endpoint's result printed as text, not as a color | PROPOSED |
| T11-08 | Notes field | free text per model | one line | survives into the config file verbatim | PROPOSED |
| T11-09 | T3 gate notice | editing overrides is a config write; an agent cannot widen its own model | one line | present in the TUI too, because hiding it here would make the TUI the escape hatch | PROPOSED |

### Region T12 — Tools

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| T12-01 | Tool list | name, tier, capability, enabled, platform availability | 1 line per tool | sorted by tier then name, so the dangerous ones are together | PROPOSED |
| T12-02 | Tier column | base tier plus the escalation rule for that tool | up to 2 lines | argument-dependent escalation as text: `file.write` T1 → T2 outside the root | PROPOSED |
| T12-03 | Schema viewer | input/output schema, example call | paged | an example the user cannot copy is a screenshot, not a feature | PROPOSED |
| T12-04 | Deferred tools | "not in this version" plus the reason | 1 line each | listed so absence is not mistaken for a bug (`EXTENSIONS.md` §3) | PROPOSED |
| T12-05 | Shell toggle | off by default; enabling is a described action with the no-sandbox sentence | 2 lines | the sentence is in the confirm, not after it | PROPOSED |
| T12-06 | Workspace roots editor | add/remove roots, with the deny-list applied to each | 1 line per root | shows the deny-list rows the user would otherwise have to trust (`SECURITY.md` §8) | PROPOSED |
| T12-07 | Limits editor | timeouts, output caps, temp lifetime, parallel steps | up to 5 lines | the default is printed next to the current value | PROPOSED |
| T12-08 | Per-task narrowing | mandatory vs opt-in still open (O-025); present for both | 2 lines | the same open question as Web W11-08, closed for both interfaces at once | PROPOSED |

---

## 7. Extensions

### Region T-E — Extensions surface

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| T-E1 | Installed list | id, kind, version, source tier, verdict, enabled | 1–2 lines each | the verdict is a word, never a color | PROPOSED |
| T-E2 | Install flow | path or git URL → validate → verdict → capability diff → approval | step lines | same pipeline as Web W-E2; a step skipped in the TUI is a defect | PROPOSED |
| T-E3 | Verdict panel | compatible / partial / incompatible / unsafe + the exact failed check | up to 4 lines | `unsafe` cannot be overridden by anything, anywhere (D-036) | PROPOSED |
| T-E4 | Missing-features list | itemized, never a generic warning | 1 line per feature | same text as Web W-E4 | PROPOSED |
| T-E5 | Conversion report | mapped / dropped / reinterpreted / unknown, with version diff | paged | reports kept per version, never overwritten (D-039) | PROPOSED |
| T-E6 | Capability grants | per extension, with revoke | 1 line per grant | revoking says when it takes effect (the next call) | PROPOSED |
| T-E7 | Suspended state | reason, last error, re-enable that re-runs validation | up to 4 lines | prints the failing check, not "see the logs" | PROPOSED |
| T-E8 | Uninstall | residual data disclosure; the purge option shown as T3 | 2 lines | same disclosure wording as Web W-E8 | PROPOSED |
| T-E9 | MCP servers | transport, exact command line or URL, tool count, connection state, restart | 2 lines each | Crabby is a client only — no row here may imply it serves MCP (D-040) | PROPOSED |
| T-E10 | Executable-kinds lock notice | not available in this version (D-038) | 2 lines | visible honesty in every interface, or the TUI becomes the workaround | PROPOSED |
| T-E11 | Skill scaffold | create a skill skeleton in place | n/a | same as running the command in a shell, with no hidden extra step | PROPOSED |
| T-E12 | Size and dependency report | install size and dependency count before approval | one line | printed before the approve key is offered (`EXTENSIONS.md` §9) | PROPOSED |

---

## 8. Settings, access, logs

### Region T13 — Settings and config

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| T13-01 | Schema-driven form | no hand-coded fields; new keys appear automatically | 1 line per key | same source of truth as the Web form (W12-01) | PROPOSED |
| T13-02 | Section navigation | general · providers · models · tools · access · logs | one line | the TUI twin of Web W12-09, added for the same reason | PROPOSED |
| T13-03 | Diff before apply | exactly what changed | up to 6 lines | `-`/`+` lines, because that is what a user can paste into an issue | PROPOSED |
| T13-04 | T3 markers | security-relevant rows flagged before the edit, not after | 1 marker | the marker is a word plus an attribute, never color alone | PROPOSED |
| T13-05 | Density mode | comfortable / compact / reduced | one line | an explicit user choice, never auto-detected (`docs/DESIGN_SYSTEM.md` §8) | PROPOSED |
| T13-06 | Color tier override | force 8 / 16 / 256 regardless of detection | one line | the escape hatch for a wrong detection (O-046); without it a misdetection is unfixable | PROPOSED |
| T13-07 | Retention controls | event and history retention | 2 lines | shows the current size, because "30 days" means nothing without bytes | PROPOSED |
| T13-08 | Reset / export config | sanitized export only | n/a | the plaintext config never contains a key value | PROPOSED |
| T13-09 | Language | UI copy strings; Bengali first-class | one line | subject to the same shaping caveat as T4-15, so it depends on **T-C2-B** | PROPOSED |

### Region T14 — Access

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| T14-01 | Paired clients | name, interface, created, last seen, granted caps, connected | 2 lines each | "connected" is a word, not a green dot | PROPOSED |
| T14-02 | Pair new client | local-only action (D-053) | n/a | the panel states which host the Gateway process is on, so "local" cannot be guessed wrong over ssh | PROPOSED |
| T14-03 | Revoke | immediate, kills live streams | one line | prints how many streams it will kill first | PROPOSED |
| T14-04 | Restrict editor | add/remove capabilities per identity (D-054) | 1 line per capability | removing a capability never converts it into an approval the same client can answer | PROPOSED |
| T14-05 | Listener mode | bind address, loopback state, non-loopback warning | 2 lines | the warning names what becomes reachable | PROPOSED |
| T14-06 | Tunnel control | enable (T3), current URL, stop, status | 2 lines | the URL is on its own line so it can be selected whole (T-C8) | PROPOSED |
| T14-07 | Telegram allow-list | user/chat ids, group policy, "unauthorized get nothing" | up to 4 lines | same content as Web W13-07 | PROPOSED |
| T14-08 | Audit jump | goes to the log view filtered to this client | one line | the filter stays visible after the jump, so the user knows they are looking at a subset | PROPOSED |

### Region T15 — Logs and audit

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| T15-01 | Log view | level filter, text search, tail toggle | 1 line per entry | tail is the default and says `tail` while on, so silence is not mistaken for being dead | PROPOSED |
| T15-02 | Redaction visibility | `redacted` printed as a word | in place | the user must learn the marker means something was there (W14-02) | PROPOSED |
| T15-03 | Audit view | who, which client, action, decision, tier, outcome, timestamps | 2 lines per row | same fields as Web W14-03, same order | PROPOSED |
| T15-04 | Approval decisions view | every prompt and its answer, expired included | 1–2 lines | expired is its own outcome, not a denial | PROPOSED |
| T15-05 | Copy diagnostics | sanitized bundle written to a file, path printed | n/a | the clipboard is unreliable over ssh; a printed path always works | PROPOSED |
| T15-06 | Correlation jump | log line ↔ request id ↔ task ↔ tool call, both directions | n/a | `Enter` on an id jumps; the reverse jump exists too | PROPOSED |
| T15-07 | Redaction assurance note | verified by tests, not a scary disclaimer | one line | the same sentence as W14-07 | PROPOSED |
| T15-08 | Volume control | how much is kept on screen at once | n/a | paged by ~200 lines; a terminal buffering 100k lines is a memory leak with good manners | PROPOSED |

---

## 9. Terminal capability and degradation

### Region T-C — The rules every other region depends on

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| T-C1 | Color capability detection | 16 / 256 / 8-color paths, all required | n/a | the detection strategy is open (O-046); until it lands, T13-06 is mandatory, not nice | PROPOSED |
| T-C2 | `NO_COLOR` and `TERM=dumb` | no color, no box-drawing | n/a | meaning survives via words, punctuation, and placement (`docs/UI_UX_SPEC.md` §6) | PROPOSED |
| T-C3 | Width tiers | 40 / 60 / 80 / 120 columns | n/a | wider adds columns, narrower never requires them — the §4 rule stated per element | PROPOSED |
| T-C4 | Height tiers | 24 rows usable minimum | n/a | at 12 rows the modal (T-A1) switches to a compact card instead of clipping the target line | PROPOSED |
| T-C5 | Attributes as semantics | bold/underline carry tier and state where color cannot | n/a | must survive 8 colors and grayscale printing (`docs/DESIGN_SYSTEM.md` §11) | PROPOSED |
| T-C6 | Redraw cost | tokens per second the renderer can afford | n/a | measured on a phone in M0 P5 (O-051), not assumed; T4-05 and T15-08 depend on the number | PROPOSED |
| T-C7 | Resize and selection | what is preserved across a resize | n/a | selection is lost when the terminal reflows — the help sheet says so instead of letting the user fight it | PROPOSED |
| T-C8 | Selection and copy | everything meant to be copied fits on one line | n/a | ids, commands, URLs, and exact targets each get their own line for exactly this reason | PROPOSED |
| T-C9 | Bengali in a terminal | shaping of combining marks and conjuncts | n/a | see open question **T-C2-B**; the answer decides T4-15 and T13-09 | PROPOSED |
| T-C10 | Bell and noise | terminal bell, and nothing else that makes sound | n/a | bell only for approvals and only when enabled (T-A9) | PROPOSED |
| T-C11 | No mouse dependence | keys and typed commands cover everything | n/a | clicking is a Web affordance; every TUI action is reachable by keys (parity rule) | PROPOSED |
| T-C12 | Cell width assumptions | Bengali and emoji may not be one cell per character | n/a | wrapping is computed, never guessed from character count | PROPOSED |

**Open question T-C2-B:** a terminal does not shape Indic text the way a browser does — conjuncts and matras can
render as separated marks depending on font and emulator. Options: (a) accept pass-through and state the limitation,
(b) keep UI chrome English-only while user content passes through as-is, (c) validate on the target devices first.
Proposal: (b) now, plus (c) as an M0 measurement — "Bengali first-class" is a promise about the product, and a
promise a terminal cannot keep has to be narrowed in words, not silently.

---

## 10. First run and global surfaces

### Region T-O — Onboarding and global surfaces

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| T-O1 | First-run wizard | the six steps of `docs/UI_UX_SPEC.md` §5, in the TUI | one step per screen | each step prints its one-line security consequence — the same sentences as Web W-O1 | PROPOSED |
| T-O2 | Skip path | read-only mode with approvals for everything | one line | a nervous user must reach a working task without enabling anything risky | PROPOSED |
| T-O3 | Doctor | findings with fix actions, in-pane | 1–2 lines per finding | `crabby doctor` and this screen say the same thing; no separate dialect | PROPOSED |
| T-O4 | Confirm dialog | destructive actions | up to 4 lines | default focus on cancel; the rule is which key `Enter` triggers, not which one looks grey | PROPOSED |
| T-O5 | Notice rules | non-blocking notices are one line in the status area | one line | anything needing a decision uses the modal (T-A), never a fading line | PROPOSED |
| T-O6 | Command palette | absent; the slash menu and `?` cover it | n/a | recorded so the absence is deliberate (the Web has W-O6, desktop-only) | PROPOSED |
| T-O7 | Gateway down screen | the exact restart command for Termux | 3 lines | never a generic retry, because Android may have killed the process | PROPOSED |
| T-O8 | Unknown input | a typo in a slash command or config key | 2 lines | names the closest real option and keeps the bad input on screen, so the user sees what was parsed | PROPOSED |
| T-O9 | Help sheet | every key, every slash command, scrollback behavior, color tiers | full pane | states the T1-A choice explicitly | PROPOSED |
| T-O10 | Accessibility checklist | no color-only meaning, visible focus, readable in 8 colors, nothing beyond the documented key set required | n/a | the TUI's accessibility is mostly the degradation rules in T-C; this row is the checklist for them | PROPOSED |

---

## 11. Coverage check

| Screen | Regions | Elements | Every state defined? |
| --- | --- | --- | --- |
| Sessions | T16 | 8 | switch mid-task, typed-delete count, id selectable |
| App frame | T1, T2, T3 | 24 | resize, below-minimum, startup, reconnect, dumb terminal |
| Chat | T4, T5 | 25 | loading, streaming, stall, approval in list, error, reconnect, narrow |
| Tasks | T6, T7 | 22 | empty, no-bulk, cancel phases, checkpoint, ladder, 40-column drop order |
| Approvals | T-A | 13 | conflict, expiry, no-dismiss, bell-off, typed answer |
| Context & memory | T8, T9 | 16 | overflow warning, pending queue, propagation preview |
| Providers/models/tools | T10, T11, T12 | 26 | insecure transport, forced-on, deferred tools |
| Extensions | T-E | 12 | suspended, locked, verdict-failed, pre-approval size report |
| Settings/access/logs | T13, T14, T15 | 25 | diff-before-apply, redaction, paging, color-tier escape hatch |
| Capability rules | T-C | 12 | this region is the degraded-state contract |
| Onboarding | T-O | 10 | skip, gateway down, unknown input, help |
| **Total** | **20 regions** | **193 elements** | — |

Two things this file must satisfy before `docs/UI_UX_SPEC.md` is regenerated from it (per D-055): every `Sizes`
cell states the 40-column outcome, and every open question here has an owner decision.

**Open questions:** T1-A (buffer / scrollback) · T3-A (configurable keys in v1) · T4-A (how much markdown) ·
T5-A (newline key, tied to O-002) · T-A-A (one card vs a list) · T-C2-B (Bengali shaping).
