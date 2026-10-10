# Crabby — UI/UX Specification

> **Document status:** Planning draft. This document defines layout, screens, and interactions only. Capability
> definitions belong to `docs/INTERFACES_AND_API.md` §8; visual tokens belong to `docs/DESIGN_SYSTEM.md`.
>
> **Design case:** a 360×800 phone browser and a ~40-column Termux terminal. Desktop is the same product with
> more room, never a different product (D-005).
>
> **Review status:** this document is a summary draft. Per D-055 the authoritative review happens element by element
> in `docs/review/`; once every element is approved, this file and `docs/DESIGN_SYSTEM.md` are regenerated from those
> inventories. Until then, treat the tables below as an index, not as an approved spec. As of this round all four
> inventories are drafted — Web 161, TUI 185, CLI 138, Telegram 106 elements — and none is approved yet.

## 1. Principles

01. **One hand, one thumb.** Primary actions live in the bottom half of the phone screen. A destructive action may
    live further away on purpose.
02. **Nothing requires a keyboard more than once.** Ids are tappable, models are pickable, and a suggested action
    is offered instead of making the user type a path.
03. **Status is never decoration.** Model in use, provider, tunnel on/off, vault locked, pending approvals — each
    is visible at all times, because each changes what the user is agreeing to.
04. **Explain the refusal.** An empty error box is a bug. Every denial states what was blocked, which rule blocked
    it, and what would change the outcome (`PROVIDERS_AND_TOOLS.md` §5.2, `SECURITY.md` §14).
05. **Approval prompts are the most-designed screens in the product.** A rubber-stamped approval is worse than no
    approval (`SECURITY.md` §4, T-05), so prompts are short, concrete, and never buried behind a tap.
06. **Quiet by default, loud on demand.** Streaming and progress update smoothly; a failure or an expired approval
    interrupts.
07. **Recoverable presentation.** If the stream drops, the screen shows it says "reconnecting" and reconciles from
    `GET /tasks/{id}` (`docs/INTERFACES_AND_API.md` §5.4) rather than freezing a stale "running" badge.
08. **Bengali and English are both first-class.** Longer strings must not break layouts, and copy is written to
    survive translation (`docs/DESIGN_SYSTEM.md` §3).

## 2. Web UI — Structure

Single app shell, one URL, no multi-page navigation. Left nav collapses into a bottom bar under `md`; the layout
must be usable at 360px without horizontal scroll.

```
+--------------------------------------------------+
| Crabby        <session title>     ● model ▾  ⌾ ⚙ |  status bar (§2.1)
+--------------------------------------------------+
|                                                  |
|              MAIN AREA (per section)             |
|                                                  |
+--------------------------------------------------+
| [▶ new]  [chats]  [tasks]  [ext]        ⚠ 2  ⓘ   |  bottom bar (mobile)
+--------------------------------------------------+
```

### 2.1 Persistent status bar

Model + provider (with a fallback-switch marker when the ladder fired), tunnel indicator (dim when off, colored and
labeled when on), vault state (locked/unlocked), pending-approval count, connection state (`live` /
`reconnecting` / `offline`), and Gateway version. Every one of these is a control, not a label: tap to change.

### 2.2 Screens

| Screen | Contains | Primary actions |
| --- | --- | --- |
| **Chat** | message list, streaming assistant turn, inline tool-call rows (collapsed, expandable), approval cards inline in the timeline | send, stop, pin context, compact, retry last, switch model for next turn |
| **Tasks** | list with state chips (`queued`, `planning`, `running`, `awaiting_approval`, `cancelling`, terminal states), progress bar distinguishing measured vs estimated | new, open, cancel, resume, watch |
| **Task detail** | plan with steps and dependencies, step log, tool calls with tier chips, checkpoint state, error/retry history, "what changed the plan" | cancel, resume, approve from here, retry failed step |
| **Approvals** | queue + history; each card shows tool, tier, exact args/command/path/host, reversibility, and expiry countdown | approve once, deny, view related task |
| **Sessions** | session list, rename, delete with typed confirm, export | export, delete, switch |
| **Context** | current budget usage bar, what was compacted, pinned items, provenance of injected memory | pin/unpin, remove from context, force compact |
| **Memory** | entries with provenance and trust label, search, edit, delete; auto-memory toggle | forget, review pending auto-memories |
| **Providers** | provider list incl. user-defined endpoints, add/edit/remove, base URL masked but visible, key shown as `vault://name` | add endpoint, test connection, probe |
| **Models** | per-model capability table: `reported` vs `effective` with overrides highlighted | toggle capability, set context ceiling, probe, reset overrides |
| **Tools** | registry with tier, capability, availability per platform, deferred marker | inspect schema, copy example call |
| **Extensions** | installed list with tier/source, validate a folder or URL, conversion report + update diff, capability grants | install content-only, revoke, uninstall, purge data |
| **Config** | schema-driven form, dirty diff, "this change is T3" notice | apply, revert, open file |
| **Logs / Audit** | two tabs: operational logs (filtered, redacted) and audit records (decisions + approvals) | tail, filter, export sanitized |
| **Access** | paired clients, last seen, granted caps; tunnel panel with URL, on/off, reachable-identity list | pair, revoke, enable tunnel (T3) |
| **Onboarding** | first-run wizard (§5) | configure provider, enable tool access, pair a client |

### 2.3 Empty states

Every empty state teaches one command, not a marketing sentence: "No tasks yet — press **New task** or run
`crabby task run \"…\"` from Termux."

## 3. Cross-Interface Interaction Patterns

| Pattern | Behavior in every interface |
| --- | --- |
| **Send** | Optimistic bubble → assistant streams → tool rows appear as they run. Send while a task runs queues rather than interrupting; queue length is visible. |
| **Streaming** | Append-only; `stop` = `POST …/cancel` (finish current step), never a local-only hide. A stalled stream shows "still working / no output for Ns" after a threshold, because silence on a phone reads as a hang. |
| **Approval** | One card per action, containing action, target, consequence, tier chip, expiry. Approve is `once` only in v1. Same card in TUI modal, Web dialog, Telegram inline buttons. |
| **Cancel** | Instantly: "cancellation requested". Then: "finishing current step". Then terminal state. The three phases are always distinct — a silent cancel is indistinguishable from a hang (`ARCHITECTURE.md` §10). |
| **Retry ladder** | Visible as `retry 3/5 on groq/llama-3.3-70b` during stage 1, then an explicit "which model instead?" chooser at stage 2, then `resumed from checkpoint` at stage 3. Never a silent switch (D-043). |
| **Failure** | Error code + human line + what completed + what did not + whether it is resumable + the action to take (`AGENT_RUNTIME.md` §9.3). |
| **Gap/reconnect** | "reconnecting…" chip; on reconnect, reconciliation replaces the view and a subtle note says what changed while disconnected. |
| **Destructive confirm** | Typed confirmation for conversation deletion, extension purge, config reset, tunnel enable. |
| **Copy** | Task id, message id, error code, model string are each one tap to copy — support conversations depend on this. |

## 4. TUI

Target: 40 columns minimum, 24 rows usable. The renderer is a reconciling one (Ink, P-010), so the flexbox model
is assumed available and the layout must be expressed in weights rather than fixed column counts where possible. Every view must be functional at that size; wider sizes only add
columns, never require them.

- **Single primary pane** with mode switching (`Tab` or `1-5`) instead of always-visible side panes.
- Panes: chat, tasks, task detail, approvals, logs, providers/models. Approvals steal focus with a modal and beep
  (bell) only if enabled.
- Streaming renders line-buffered, no re-layout of the whole screen per token (flicker on slow terminals is a real
  usability bug, not a cosmetic one).
- Status line pinned at the bottom: model, tunnel, connection, pending approvals.
- Keys: `Ctrl-C` cancel task (not quit); `Ctrl-Q` quit; `Esc` close pane/modal; `?` help; `↑↓` select;
  `Enter` open; `a` approve; `d` deny; `x` cancel task; `r` resume; `m` switch model.
- Copy on Termux is via long-press selection; therefore ids and commands must fit on one short line so they are
  selectable without wrapping into uselessness.

## 5. First-Run Experience

The setup path decides whether anyone gets this far, so it is specified like a screen, not a README:

```
crabby init
  1. environment check      Node version, Termux detected?, build tools present?, storage space
  2. pick a model path      free endpoint (paste base URL + key) · local (Ollama URL) · skip for now
  3. create workspace root  default: $HOME/crabby-workspace, with the deny-list shown
  4. shell access           default OFF, with an explanation of what enabling changes
  5. pair an interface      show TUI ready; offer Web URL + Telegram steps as optional
  6. first task             a one-command task that finishes in seconds, to prove the loop works
```

- `crabby doctor` re-runs the same checks at any time and prints fixes, not findings.
- Every step states the security consequence in one line, e.g. "Enabling shell access lets the agent run commands
  as your Termux user. That is not a sandbox."
- Skipping is a supported path: Crabby must be usable in a read-only, approval-for-everything mode right after
  `init`, so a nervous first-time user is not forced into the risky configuration to see value.

## 6. CLI Output Conventions

- No color or Unicode box-drawing when not a TTY or when `NO_COLOR`/`TERM=dumb`; `--plain` forces ASCII.
- Symbols degrade: `✓ ✗ ● ▶` on capable terminals, `ok/err/-/>` otherwise. Never encode meaning in color alone.
- Tables are compact by default; `--wide` adds columns rather than wrapping cells.
- `--json` on every read command, stable keys, snake_case, plus `--quiet` for ids only (so scripts can pipe).
- Long-running commands print progress to stderr and results to stdout.
- Exit codes follow `docs/INTERFACES_AND_API.md` §7.1 so scripts can branch on "needs approval".

## 7. Telegram

- Message shape: short first line with the outcome, details in the same message only when they change a decision.
  Everything else links to a task id, not to a URL with a token in it.
- Inline keyboards for approve/deny and for model choice; the callback carries an opaque id only.
- Progress: one edited message per task with a coalescing interval, plus a terminal message that cannot be missed.
  No more than one edit per few seconds (`docs/INTERFACES_AND_API.md` §7.4).
- Long output: split with `(2/3)` markers, or send a file. Truncation is always labeled.
- The bot never reveals whether an id exists, and does not answer unauthorized senders at all.
- Approvals expire visibly: "expired — send /approve <id> again" rather than silently dead buttons.

## 8. States and Edge Cases

Every screen must define all of these; a missing state is a defect, not a follow-up.

| State | Requirement |
| --- | --- |
| Loading | Skeletons for lists, never a blank panel or a spinner that hides content length. |
| Empty | Teach one action (§2.3). |
| Streaming | Content grows; scroll stays pinned unless the user scrolls up, then a "new content ↓" affordance appears. |
| Awaiting approval | Persistent, non-dismissable until answered, expired, or delegated to another interface. |
| Cancelled | Distinct from failed, with the reason and the partial output shown. |
| Interrupted | Restart-recovered tasks are labeled "auto-resumed from checkpoint"; a task that auto-resume declined says why. |
| Reconnecting | Chip + last-confirmed state; no fake freshness. |
| Offline / Gateway down | Explicit, with the exact command to restart, because on Termux the process may have been killed by Android. |
| Vault locked | Everything needing secrets is visibly unavailable with an unlock action (`SECURITY.md` §7). |
| Partial capability | "tool calling unsupported on this model" chips rather than mysterious failures (D-045). |
| Error | §3 error pattern, with `code` and copyable request id. |
| Long strings | 300-character code blocks, Bengali paragraphs, and file paths must not break the layout. |
| Slow device | Reduced animation and lower event frequency under the documented low-resource mode. |

## 9. Accessibility and Input

- WCAG 2.2 AA contrast for text and for tier chips; tier is never color-only (each chip carries its label `T0`…`T3`).
- Touch targets ≥44px in the Web UI; TUI key hints always visible on narrow screens.
- Full keyboard operation in the browser; visible focus rings; logical tab order inside approval dialogs, with the
  destructive option never pre-focused.
- `prefers-reduced-motion` respected; streaming never animates decorative effects.
- Screen-reader labels for streaming regions use polite live regions, and tool-call rows announce their tier.
- All user-visible strings are in one translation layer; no string concatenation across languages, and Bengali
  rendering is tested rather than assumed.

## 10. Brand and Voice

- Name: **Crabby**. Playful is allowed; cute at the expense of clarity is not — an approval prompt must never be
  ambiguous for the sake of a joke.
- Copy voice: direct, plain, second person, no hedging about security. "This will send a message to +880…" not
  "Crabby may perform an external action".
- Iconography: a claw/crab motif is fine. OpenClaw's branding, logo, and iconography are not to be imitated
  (`PROJECT_BRIEF.md` §14).
- No emoji in machine-facing output (exit codes, `--json`, audit records). Emoji are allowed in human chat
  responses where they aid scanning.

## 11. UX Acceptance Criteria

01. Every screen in §2.2 has a defined empty, loading, error, and degraded state.
02. The §3 patterns are implemented identically in all four interfaces, verified by the parity test
    (`docs/INTERFACES_AND_API.md` §11).
03. Every approval surface can be understood and answered on a 360px screen without scrolling horizontally.
04. On a 40-column terminal, no required content is unreachable.
05. Cancel, retry-ladder, and reconnect flows are visibly distinct from success and from failure.
06. First-run completes with `init` + `doctor` alone; nothing in the setup path requires reading source code.
07. Accessibility requirements in §9 are testable, not aspirational: contrast and focus order have checks.

---

**End of UI/UX Specification**
