# Crabby — Roadmap

> **Document status:** Planning draft. This is the ordered path from finished documentation to a usable release.
> Each phase has an **entry gate** and an **exit gate**; a phase is not "done" because its code exists, only when
> its exit gate passes.
>
> **Related:** `PROJECT_BRIEF.md` §14, `ARCHITECTURE.md` §22, `DECISIONS.md` §8

## 0. Current Position

```
Documentation ────────────────────────────► [YOU ARE HERE: M-D review] ─► M0 ─► M1 ─► M2 ─► …
 PROJECT_BRIEF ✓   ARCHITECTURE ✓   AGENT_RUNTIME ✓   SECURITY ✓   EXTENSIONS ✓
 PROVIDERS_AND_TOOLS ✓   DECISIONS ✓ (68 accepted · 10 proposed · 13 open)   README ✓
 docs/  DATA_AND_MEMORY ✓   INTERFACES_AND_API ✓   UI_UX_SPEC ✓   DESIGN_SYSTEM ✓
        ROADMAP ✓   DEVELOPMENT ✓            AGENTS.md ✓
```

All 16 planning documents now exist. What remains in this phase:

01. The **element-by-element interface review** required by D-055 (`docs/review/`), starting with the Web UI —
    the owner reviews every screen and every element, with equal weight given to small and large ones.
02. `docs/UI_UX_SPEC.md` and `docs/DESIGN_SYSTEM.md` are **regenerated from the approved inventories** rather than
    hand-edited, so the spec cannot drift from what was actually agreed.
03. Closing or consciously deferring the remaining implementation-blocking decisions in §11.

Implementation has not started. M-D (documentation close-out) is **in progress**: its mechanical half is written up
in `docs/CONSISTENCY_REVIEW.md`, and four of the six original blockers were closed this round (D-048…D-051). M0 is
the phase that closes the rest, because those remaining items are measurements, not opinions — it stays gated on
the owner's go-ahead.

## 1. Phase M-D — Documentation close-out

**Goal:** the planning set is complete, consistent, and usable as instructions for a coding agent.

| Item | Detail |
| --- | --- |
| Entry | This document, `docs/DEVELOPMENT.md`, `AGENTS.md` written. |
| Work | Cross-document review of all planning files; resolve terminology drift; verify every acceptance criteria list is checkable; ensure each open decision has an owner-visible status. Element-by-element review of the four interfaces (`docs/review/`, D-055) with the single-file Web mockup as the review instrument (D-056). The (R) round of 2026-10-10 recorded the answers to everything research could settle (D-059…D-068) and left the rest as measurements. |
| Exit | `python3 scripts/check-docs.py` clean — which now also means the §4B review counts and the §2.3 palette ratios are recomputed rather than asserted; `python3 scripts/count-inventory.py --markdown` agrees with `DECISIONS.md` §4B; every `Accepted` decision reflected in the document that enforces it; no document claims implementation; and every item still open in §11 is open because it needs a device, real extensions, or a post-v1 design (not because nobody reached it). |
| Left to the owner | The 650 `PROPOSED` element rows: a question of judgement about how a screen reads, which no research settles. Work them in `docs/review/mockups/crabby-web-ui.html`; `docs/review/DECISION-QUEUE.md` is the veto surface for the 25 rows the (R) round moved. |
| Deliberately not here | Any product code, any package, any dependency installation. |

## 2. Phase M0 — Termux validation prototype

**Goal:** prove the riskiest assumptions with throwaway code, before anything is built on top of them. This is
the phase that prevents an expensive rewrite; `ARCHITECTURE.md` §22 makes it an architecture acceptance condition.

| # | Probe | Pass condition |
| --- | --- | --- |
| P1 | Node.js LTS install + `npm install` + a plain TS build on Termux | Installs and runs from a clean Termux; no glibc-only assumption |
| P2 | Fastify Gateway binding `127.0.0.1`, one `GET /health`, one SSE stream | Streams to a local client; survives a forced process kill and restarts cleanly |
| P3 | Storage: `better-sqlite3` source build, WAL, crash-during-write | Reproduces the report in `DECISIONS.md` §5 on a clean environment; `integrity_check` ok; compare against `node:sqlite` for the same case |
| P4 | The Web UI built and served by the Gateway — **not** a React/Vite build: D-068 chose framework-free custom elements, so P4 compiles the small no-dependency bundle the design actually specifies and serves it from the Gateway origin | Built assets load from a phone browser at 360px from the same origin as the API, with no dev server and no second listener; `tokens.css`-equivalent values are the §2.3 palette, and the 360px bar holds exactly four chips plus the `more` sheet (D-067) |
| P5 | TUI candidate at 40 columns — Ink 8 (P-010), with the `node:readline` fallback as a control | Renders; token-by-token streaming holds ≤4 fps repaint without dropping input; **`Ctrl+J` inserts a newline on Termux**, and whether `Shift+Enter` can be negotiated after a `CSI ? u` query is *recorded*, not assumed (D-061 decided the design so this measurement can only widen the hint text, never rewrite it); `Ctrl-C` maps to cancel not quit; 8-color fallback usable with every state word readable; Bengali pasted into the composer truncates at a cluster boundary and does not shift the frame (D-062); no native build step. Result decides OpenTUI's deferral (O-051) and Ink's adoption (O-006) |
| P6 | Background behavior | Document what Android does to a long-running Termux process (wakelock requirement, kill under pressure) and whether recovery is adequate |
| P7 | Hostile extension probe (informs O-008) | Attempt `fs`/`net`/`child_process` access from a restricted candidate; record what is and is not enforceable |

Exit: each probe has a written result (pass / fail / platform-specific) recorded in `DECISIONS.md`, and every
`Proposed` choice it touched becomes `Accepted`, changes, or is explicitly rejected. A failure here is a *good
outcome* — it is why the phase exists.

## 3. Phase M1 — Contracts and skeleton

**Goal:** the shape of the system exists and compiles, so four interface workstreams can start in parallel.

- Repository per `ARCHITECTURE.md` §18, with only the packages that actually hold code.
- `api-contracts`: schemas, event envelope, error codes, exit codes (`docs/INTERFACES_AND_API.md` §2/§5/§6).
- Configuration loading + validation, logging with redaction, platform detection, graceful shutdown, startup order
  (`ARCHITECTURE.md` §5).
- Storage abstraction with migrations, plus the repositories of `docs/DATA_AND_MEMORY.md` §5.
- Policy engine skeleton with the capability vocabulary and tier model enforced (`SECURITY.md` §6), and the fake
  provider (`PROVIDERS_AND_TOOLS.md` §3.3) so tests need no live API.
- Test scaffolding for the parity and contract suites — before interfaces exist.
- CI per `docs/DEVELOPMENT.md` §12 (D-060): the ubuntu matrix plus `termux/termux-docker` for the toolchain half, with
  `scripts/check-docs.py` a **required** job. `scripts/count-inventory.py` is what keeps the review-progress table honest.
- The parity generator (D-067): `docs/INTERFACES_AND_API.md` §8 emitted from the tool registry plus annotations, with
  rules 10–12 of `scripts/check-docs.py` retiring the day the generator lands — not before, because until the
  generator exists the checker is the only thing standing between three lists and drift.

Exit: `crabby init`, `crabby status`, `crabby doctor` work against a real local Gateway; the contract test harness
runs; a task can be created and read back with an id, and nothing else.

## 4. Phase M2 — Core runtime and Gateway

**Goal:** one shared runtime that four clients can drive.

- Session, task, event, cancellation, and checkpoint managers with the §4.4 ownership split enforced.
- Task state machine + controlled parallelism (D-023) with configurable limits.
- Agent loop: Plan → Execute, bounded retries, the retry-then-ask ladder (D-043/D-044), context budgeting and
  hybrid compaction (D-027/D-045).
- Approval service: request, bind, expire, answer-from-anywhere, conflict on double-answer.
- Auto-recovery on restart that cannot bypass approvals (`AGENT_RUNTIME.md` §7.2).
- Event delivery with gap handling and reconciliation-by-`GET`.
- Scheduler for `cron.schedule` (T2, D-046): every run is a fresh policy evaluation, a run that cannot get approval
  stops and records why, and a device killed overnight must not fire a backlog burst (§4.5 of
  `PROVIDERS_AND_TOOLS.md`). `GET /jobs` and the pause verb ship *with* this, not after it — a job the user cannot
  pause from an interface is a standing authority with no off switch (D-057).
- Initial tools with tiers: `file.*`, `session.*`, `task.*`, `net.fetch`, `memory.*`, `config.*`
  (`PROVIDERS_AND_TOOLS.md` §4.2). `shell.run` ships in this phase but is **not enabled by default**: it is off until the user opts in during
`crabby init`, and M2's exit demo is run once with it off and once with it on (`SECURITY.md` §9).

Exit: a multi-step task started from a stub CLI completes, streams, persists, survives a kill + restart, and its
state matches `GET /tasks/{id}` from a second client. Policy denies what policy must deny, in tests.

## 5. Phase M3 — Four interfaces in parallel

Workstreams share contracts and fixtures, so they proceed independently; none of them may add core logic
(`ARCHITECTURE.md` §6).

| Workstream | Deliverable | Definition of done |
| --- | --- | --- |
| CLI | Command grammar of `docs/INTERFACES_AND_API.md` §7.1 | `--json` everywhere, documented exit codes, scriptable, no TTY assumptions |
| TUI | §4 panes, modal approvals, cancel-on-`Ctrl-C` | Fully usable at 40 columns; no full-screen repaint per token; 8-color fallback |
| Web UI | §2 screens, §8 states | Every screen has empty/loading/error/degraded states, **including** `Sessions` (W15) and `Scheduled` (W16) — neither is an add-on; 360px layout complete; served as built assets |
| Telegram | Commands, inline approvals, coalesced progress | No capability of its own; unauthorized senders get nothing; approvals expire visibly |

Phase exit: the parity test walks `docs/INTERFACES_AND_API.md` §8 and passes with every blank cell carrying an
accepted limitation. One task, started on Telegram, watched from Web, approved in the TUI, cancelled from the CLI —
in one demo, documented as the release test.

## 6. Phase M4 — Providers, memory, extensions

- Provider adapters: `openai-compatible` (+ user-defined endpoints, D-041), `ollama`, `anthropic`, `gemini`, each
  passing the conformance suite (§7) before it is listed as supported.
- Per-model capability overrides with `reported` vs `effective` (`PROVIDERS_AND_TOOLS.md` §3.8).
- Persistent memory with text search, provenance, review/edit/forget, and deletion semantics
  (`docs/DATA_AND_MEMORY.md` §7).
- Skills and command templates: content-only path of `EXTENSIONS.md` (D-035) — inert import, manifest validation,
  conversion reports, `crabby ext init/validate/check-compat`.
- MCP client: config import, stdio + HTTP/SSE transports, tier-classified tools, capped output.
- Compatibility importer phase C-1 and C-2 (portable skills, MCP config) with real conversion reports.

Exit gate: a user imports an OpenClaw/Claude-style `SKILL.md`, sees exactly what transferred and what did not, and
the imported content cannot elevate anything. Third-party executable loading remains blocked (D-038) unless M5
changed that with evidence.

## 7. Phase M5 — Security hardening, remote access, isolation decision

- Secrets vault: OS keychain where available, encrypted-file fallback with lock state everywhere (D-031).
- Pairing and revocation finished across all four interfaces (D-030), plus `crabby auth list` last-seen data.
- Cloudflare Quick Tunnel mode: enable as T3, identity list, URL discovery, teardown that truly closes listeners
  (`SECURITY.md` §13).
- Scheduled jobs with runtime re-evaluation (`PROVIDERS_AND_TOOLS.md` §4.5).
- Extension isolation decision (O-008) executed: child process + capability RPC, or a written decision that
  untrusted executable extensions stay out of scope with a documented reason.
- Full `SECURITY.md` §17 suite on Termux: redaction, injection fixtures, auth rejection, escalation, resource caps.
- Audit log completion and `crabby doctor --security` reporting a plain-language posture summary.

Exit: every threat row T-01…T-15 has a mitigation and a test; no open security decision is silently resolved by an
implementer.

## 8. Phase M6 — Release readiness

- Install path for Termux, Linux, macOS written and rehearsed from a clean device; O-012 closed (install, update,
  rollback, backup, recovery).
- Backup/restore per `docs/DATA_AND_MEMORY.md` §8; migration failure behavior tested.
- Performance pass on a low-resource phone: memory, startup time, idle CPU, battery impact of each interface, WAL
  growth; caps tuned (O-035).
- Documentation: README, install, troubleshooting, platform limitations, and an honest "what Crabby does not
  promise" page.
- License audit of dependencies and bundled assets (`PROJECT_BRIEF.md` §14); third-party notices generated.
- Changelog, version tagging, package publishing, `0.x` policy for breaking changes.

Exit: a new user, following only the docs on a phone, reaches a completed multi-step task with approvals, and hits
nothing that the limitations page did not already mention. **That is the release bar, not "all features work."**

## 9. Later, explicitly not promised

Windows native support (beyond WSL evaluation) · vector/semantic memory (D-021 leaves the door open) · official
extension registry and signing · MCP server role (**non-goal**, D-040) · native Android app · local inference
bundled on Android (O-034) · GUI/browser automation tools · multi-tenant or remote-hosted deployments · iOS.

## 10. Cross-Cutting Rules

01. Every phase ships with tests written in the same change; a phase whose tests come "next week" is not finished.
02. Every decision that changes updates `DECISIONS.md` **and** the enforcing document in the same commit — the rule
    in `PROJECT_BRIEF.md` §16 and D-034.
03. Nothing is called "supported" for a platform until verified there (Brief §4).
04. Scope pressure resolves by cutting depth, never by cutting a boundary: fewer tools, not "permissions for later".
05. Each phase ends with a demo path that a real user can type, not a checklist review.
06. A phase may be re-ordered if M0 evidence says so; the roadmap records the change and why.

## 11. Decisions That Block Implementation

Blocking means the shape of code depends on it, so guessing would be expensive:

| ID | Why it blocks |
| --- | --- |
| O-001, O-002 (`better-sqlite3` on Termux) | Storage abstraction and migrations depend on the driver's build behaviour on a phone; the driver itself is chosen (D-066), so what is left is the measurement, not the decision |
| O-006 / O-051 (TUI: Ink 8 pending measurement) | P-010 stays Proposed until M0 P5 measures repaint cost; the TUI workstream waits on the result, not on a preference. Everything the measurement could change about *layout* is already decided (D-061), so a negative result costs a renderer, not a redesign |
| O-008 (extension isolation) | Deliberately open (D-038 keeps v1 free of third-party executable code), and it gates nothing before M4 |
| The 650 undecided rows in `docs/review/` | Rows still `PROPOSED` because they need the owner to look at them, not research. They block regenerating `docs/UI_UX_SPEC.md` and `docs/DESIGN_SYSTEM.md` from approved elements — M-D work — and they do not block running the M0 probes |

**Closed during M-D (2026-10-09):** O-004 transport → D-048 (SSE + HTTP, no WebSocket in v1); O-010 replay →
D-049 (per-task `seq`, count-bounded window, gap + reconcile-by-GET); O-012 install path → D-050; O-019
token/expiry → D-051.

**Closed in the (R) round (2026-10-10, D-059…D-068):** fifty of the sixty-three tracked items, including all eleven
questions the element review had raised (O-053…O-063) and everything the toolchain, terminal contract, provider
runtime policies, data policies, platform boundaries and interface shapes were waiting on. `docs/review/DECISION-QUEUE.md`
is the row-by-row record, with the evidence and the veto path.

What that leaves is a short list and an honest one: M0 is unblocked by decision, and the only way to close the items
above is to run the probes. Six items carry work in the register — O-006, O-051, O-008 and O-052 open, plus the one
measured clause left in O-001 and O-002 — and each is open because it needs a phone, needs real extensions, or is a
post-v1 design question (D-052), never because nobody got to it. `scripts/check-docs.py` counts the register on every
run, so a stale "still open" cannot survive a commit. The 63 `O-` rows are not 63 open questions: a closed question
keeps its number so that documents citing it stay true.

## 12. Roadmap Acceptance Criteria

01. Every phase has an entry gate, exit gate, and at least one demo path.
02. No phase depends on an undecided blocking item from §11 without naming it.
03. The four interfaces are planned concurrently from M1, per the owner's requirement, with parity as the phase
    gate rather than an aspiration.
04. M0 exists and is honest: it can invalidate proposed choices, and a negative result is recorded as a success.
05. Release is defined by a user reaching a working multi-step task on a phone, not by a feature count.
06. The "later" list is explicit, so deferral never reads as a promise.

---

**End of Roadmap**
