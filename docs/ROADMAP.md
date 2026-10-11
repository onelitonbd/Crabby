# Crabby — Roadmap

> **Document status:** Planning draft. This is the ordered path from finished documentation to a usable release.
> Each phase has an **entry gate** and an **exit gate**; a phase is not "done" because its code exists, only when
> its exit gate passes.
>
> **Related:** `PROJECT_BRIEF.md` §14, `ARCHITECTURE.md` §22, `DECISIONS.md` §8

## 0. Current Position

```
Documentation ────────────────────────────► [M-D complete · YOU ARE HERE: awaiting the go-ahead for M0] ─► M0 ─► M1 ─► M2 ─► …
 PROJECT_BRIEF ✓   ARCHITECTURE ✓   AGENT_RUNTIME ✓   SECURITY ✓   EXTENSIONS ✓
 PROVIDERS_AND_TOOLS ✓   DECISIONS ✓ (76 accepted · 10 proposed · 65 tracked, 8 open)   README ✓
 docs/  DATA_AND_MEMORY ✓   INTERFACES_AND_API ✓   UI_UX_SPEC ✓   DESIGN_SYSTEM ✓
        ROADMAP ✓   DEVELOPMENT ✓            AGENTS.md ✓
```

All 16 planning documents now exist. What remains in this phase:

01. ~~The **element-by-element interface review** required by D-055~~ — **done 2026-10-10 under delegation**
    (D-075): all 675 rows in `docs/review/` are `ACCEPTED`, with the criteria and the scan in
    `docs/review/README.md`, and review continues per implementation step (D-076) rather than as a table.
02. `docs/UI_UX_SPEC.md` and `docs/DESIGN_SYSTEM.md` are **regenerated from the approved inventories** rather than
    hand-edited, so the spec cannot drift from what was actually agreed. This is deliberately the *last* M0 task
    (P8 below) and not an M-D one: M0 P5 and P3 can still change TUI and storage rows, and regenerating a spec from
    numbers that are about to be measured would produce a document that needs regenerating again the same week.
03. Closing or consciously deferring the remaining implementation-blocking decisions in §11 — eight `O-` rows carry
    work, each with its measurement named, and none of them blocks starting M0.

Implementation has not started. M-D (documentation close-out) is **mechanically complete**: `scripts/check-docs.py`
is green over 22 documents, the human half was reviewed under delegation (D-075), and `docs/CONSISTENCY_REVIEW.md`
records findings F-01…F-53 with what each one changed. M0 is the phase that closes what remains, because those items
are measurements, not opinions — it stays gated on the owner's go-ahead, and the first M0 action is running the
probes, not writing more documents.

## 1. Phase M-D — Documentation close-out

**Goal:** the planning set is complete, consistent, and usable as instructions for a coding agent.

| Item | Detail |
| --- | --- |
| Entry | This document, `docs/DEVELOPMENT.md`, `AGENTS.md` written. |
| Work | Cross-document review of all planning files; resolve terminology drift; verify every acceptance criteria list is checkable; ensure each open decision has an owner-visible status. Element-by-element review of the four interfaces (`docs/review/`, D-055) with the single-file Web mockup as the review instrument (D-056). The (R) round of 2026-10-10 recorded the answers to everything research could settle (D-059…D-068) and left the rest as measurements. |
| Exit | `python3 scripts/check-docs.py` clean — which now also means the §4B review counts and the §2.3 palette ratios are recomputed rather than asserted; `python3 scripts/count-inventory.py --markdown` agrees with `DECISIONS.md` §4B; every `Accepted` decision reflected in the document that enforces it; no document claims implementation; and every item still open in §11 is open because it needs a device, real extensions, or a post-v1 design (not because nobody reached it). |
| Reviewed under delegation | The 650 rows that were `PROPOSED` (D-075, criteria and exceptions in `docs/review/README.md`, re-runnable with `python3 scripts/review-scan.py`). The judgement half now happens per implemented step (D-076), where the owner sees a screen instead of a row — that is the trade, and it is recorded rather than implied. The owner's own wording for the trade: review arrives while the work is in progress, one step at a time, and the changes follow. `docs/review/mockups/crabby-web-ui.html` and `docs/review/DECISION-QUEUE.md` stay the surfaces for it — the mockup because a screen should be seen as a screen, the queue because a veto has to be one row wide. |
| Deliberately not here | Any product code, any package, any dependency installation. |

## 2. Phase M0 — Termux validation prototype

**Goal:** prove the riskiest assumptions with throwaway code, before anything is built on top of them. This is
the phase that prevents an expensive rewrite; `ARCHITECTURE.md` §22 makes it an architecture acceptance condition.
The harness is in `probes/` (one file per row, `npm run probe`, contract in `probes/README.md`). Its container results
are generated into `probes/RESULTS.md`, and they are *not* M0's exit: the device column is, and the checks that found
the plan's own gaps are recorded as F-25 and F-26 in `docs/CONSISTENCY_REVIEW.md` rather than smoothed over here.

| # | Probe | Pass condition |
| --- | --- | --- |
| P1 | Node.js LTS install + `npm install` on Termux, then the runtime assumption of D-070: `node file.ts` and `node --test` with no flags, no loader, no esbuild | Installs and runs from a clean Termux; type stripping works on the Node the Termux package actually ships, and `npm run test` passes there. Record the Node version — this is the number that becomes `engines`, and no document restates it |
| P2 | Fastify Gateway (D-069) binding `127.0.0.1`, one `GET /health`, one SSE stream via `reply.hijack()` | Streams to a local client; survives a forced process kill and restarts cleanly |
| P3 | Storage: `better-sqlite3` source build, WAL, crash-during-write | Reproduces the report in `DECISIONS.md` §5 on a clean environment; `integrity_check` ok; compare against `node:sqlite` for the same case |
| P4 | The Web UI built and served by the Gateway — **not** a React/Vite build: D-068 chose framework-free custom elements, so P4 compiles the small no-dependency bundle the design actually specifies and serves it from the Gateway origin | Built assets load from a phone browser at 360px from the same origin as the API, with no dev server and no second listener; the colour values are `docs/DESIGN_SYSTEM.md` §2.3's palette, read from the document rather than copied into a fixture, and the 360px bar holds exactly four chips plus the `more` sheet (D-067) |
| P5 | TUI candidate at 40 columns — Ink 8 (P-010), with the `node:readline` fallback as a control | Renders; token-by-token streaming holds ≤4 fps repaint without dropping input; **`Ctrl+J` inserts a newline on Termux**, and whether `Shift+Enter` can be negotiated after a `CSI ? u` query is *recorded*, not assumed (D-061 decided the design so this measurement can only widen the hint text, never rewrite it); `Ctrl-C` maps to cancel not quit; 8-color fallback usable with every state word readable; Bengali pasted into the composer truncates at a cluster boundary and does not shift the frame (D-062); no native build step. Result decides OpenTUI's deferral (O-051) and Ink's adoption (O-006) |
| P6 | Background behavior | Document what Android does to a long-running Termux process (wakelock requirement, kill under pressure) and whether recovery is adequate |
| P7 | Hostile extension probe (informs O-008) | Attempt `fs`/`net`/`child_process` access from a restricted candidate; record what is and is not enforceable |
| P8 | Spec regeneration (document task, not a probe) | Regenerate `docs/UI_UX_SPEC.md` and `docs/DESIGN_SYSTEM.md` from the accepted inventories (D-075), then re-run `python3 scripts/check-docs.py` and `docs/CONSISTENCY_REVIEW.md` §7. It sits here, not in M-D, because P3 and P5 can change rows the specs would otherwise be written from |

Exit: each probe has a written result (pass / fail / platform-specific) recorded in `DECISIONS.md`, and every
`Proposed` choice it touched becomes `Accepted`, changes, or is explicitly rejected; P8's regenerated specs are part
of the exit, because a phase that measures things and then leaves the spec behind has measured nothing. A failure here
is a *good* outcome — it is why the phase exists. Each step that ships after M0 carries its own owner review
(D-076), so the review D-075 delegated continues where it can actually be done.

## 3. Phase M1 — Contracts and skeleton

**Goal:** the shape of the system exists and compiles, so four interface workstreams can start in parallel.

- Repository per `ARCHITECTURE.md` §18, with only the packages that actually hold code.
- `api-contracts`: schemas, event envelope, error codes, exit codes (`docs/INTERFACES_AND_API.md` §2/§5/§6).
- Configuration loading + validation, logging with redaction, platform detection, graceful shutdown, startup order
  (`ARCHITECTURE.md` §5).
- Storage abstraction with migrations, plus the repositories of `docs/DATA_AND_MEMORY.md` §5.
- Policy engine skeleton with the capability vocabulary and tier model enforced (`SECURITY.md` §6), and the fake
  provider (`PROVIDERS_AND_TOOLS.md` §3.3) so tests need no live API.
- Test scaffolding for the parity and contract suites — before interfaces exist: `node:test`, one runner file per
  package, no runner configuration beyond globs (D-069).
- CI per `docs/DEVELOPMENT.md` §12 (D-060), **shipped in M1c as D-082**: seven legs on `linux-x64` and
  `macos-arm64`, with `scripts/check-docs.py` a **required** job — and the `termux/termux-docker` row that §12 also
  asked for deliberately *not* shipped, because the image has no Android runtime and `termux-api` does not work under
  proot, so the container would have measured the container and reported it as phone evidence
  (`docs/CONSISTENCY_REVIEW.md` F-37). `scripts/count-inventory.py` is what keeps the review-progress table honest.
- The parity generator (D-067), **shipped in M1c** as `scripts/parity.ts`: §8 is emitted from `apps/cli/registry.ts`
  and the tool registry rather than transcribed, and the same command compares §4's routes with
  `packages/gateway/app.ts`, §7.4 with `docs/review/TELEGRAM.md`, §4.2 with `TOOL_REGISTRY` and §6.1 with
  `CAPABILITIES`. Rules 10–12 retired as promised, and precisely: rule 10 left because a generator that can import the
  registry does a strictly better job of what it did, rules 11 and 12 stayed because inventory *completeness* is a
  property of the documents alone and no generator can supply it. The bullet's "not before" clause paid for itself the
  week it was honoured — the generator's first run found two documents that had agreed on leaving a route family
  undocumented (F-35).

Exit: `crabby init`, `crabby status`, `crabby doctor` work against a real local Gateway; the contract test harness
runs; a task can be created and read back with an id, and nothing else.

**Delivered so far — M1a, the slice before the Gateway.** `packages/api-contracts` (identifiers, the §5.2 event
envelope, the §6 error envelope, task records, the five exit codes, and the one `validate()` that rejects an unknown
field *by name*), `packages/platform` (data-dir resolution, Termux markers, the constraints §10 imposes),
`packages/core` (config load/validate/write, redaction that is not a log level, the logger, the shutdown record) and
`apps/cli` (`crabby init`, `doctor`, `version`, and `config path|get|set|schema`) are running code: one runner file per
package as M1 asks (`packages/api-contracts/contracts.test.ts`, `packages/platform/platform.test.ts`,
`packages/core/core.test.ts`), plus `tests/unit/cli.test.ts`, which spawns the real entry point because exit codes and
pipeability are properties of a process and not of a function. `crabby status` and the contract harness are
**not** in this slice: both read a Gateway, so they land with M1b, and until then `doctor` prints §10's three
Gateway-backed checks as `deferred` rather than as a tick. Four questions the slice found and deliberately did not
answer are recorded as **O-066…O-069** instead of being closed with plausible numbers; `crabby doctor` will keep
naming the largest of them (no `engines.node` pin) until M0's phone column is filled.

**Delivered since — M1b, the Gateway and the state directory.** `packages/storage` opens one SQLite file, runs the
migration ledger, and owns every statement: tasks with id-cursor paging, events with `seq` numbered per task from 1,
redaction applied *on write* so a secret never reaches the file, and a payload past D-064's 64 KiB moved to
`scratch/<taskId>/<eventId>.json` with a marker left behind instead of truncated bytes. `packages/gateway` is Fastify
5 with the contract's own `validate()` installed as its validator (D-069's reason for TypeBox: one schema, one
validator, no second dialect), pairing codes and bearer tokens as SHA-256 digests, an `Idempotency-Key` that replays
the recorded answer or says `409`, `GET /tasks/:id/events` as the polling fallback §5.4 makes mandatory, and
`GET /events` as SSE on a hijacked reply with a 15 s heartbeat and §5.4's explicit gap frame. Every route requires a
token except the pairing redeem, per `SECURITY.md` §13's "reject every route, including health and SSE". `crabby
gateway start`, `gateway status`, `status`, `auth pair|list|revoke`, `task ls` and `task show` are the CLI's side of
it, and `tests/integration/gateway.test.ts` runs the whole surface against a real socket plus one spawned pair of
processes. Three things this slice deliberately does **not** contain: `crabby task run`, because an executor is M2's
and a command that created a task nothing would move is a mock with an exit code; `POST /admin/*`, because approval
and policy are M2's engine and "an interface may request, display, and relay; it may never grant" has to be true from
the first route; and any binding beyond `127.0.0.1`, per §13's "never offer them implicitly". The four unpriced
numbers and the shapes the contracts required but the documents had not defined are recorded as D-077, D-078, D-079
and **O-070/O-071/O-072** — named rather than smoothed over, which is also how §11's two untestable auth rows stayed
untested instead of being satisfied by a check that asserted nothing.

**Delivered since — M1c, the half of M1 that was not a Gateway.** The plan's M1 bullets ask for a policy engine
skeleton with the vocabulary and tier model enforced, the fake provider so tests need no live API, the parity
generator, and CI; all four are now code, and none of them is a shell around nothing. `packages/policy` is
`SECURITY.md` §6 as data and functions — 32 capabilities, four tiers, every §4.2 tool row transcribed with its base
tier and its grants, argument-dependent escalation, and an answer that records which registry produced it
(`registryDigest`, D-080). `packages/providers` is the adapter contract, the descriptor that says what a provider
claims, and a fake provider run through the same conformance suite a real adapter will have to pass (D-081) — which is
what makes §12's "no job may require a live model provider" a buildable rule rather than a wish. The surfaces M1c owes
the interfaces: `GET /api/v1/tools` and `crabby tools ls`, so an interface asks the policy engine what is possible
instead of keeping its own list, and `crabby diagnostics`, which writes the Gateway's sanitized report to a 0600 file in
the temp directory and *refuses* a report that still carries a secret rather than redacting it after the write. Then the
two checks: `scripts/parity.ts` (above) and `tests/security/policy-surface.test.ts`, which walks every route the
Gateway prints and refuses an unauthenticated request, proves no T3 approval is answerable from a chat surface, and
reads the documents for the off-by-default sentences `OFF_BY_DEFAULT` claims — a list of one (`shell.run`), because
nothing documents `shell.privileged` that way and an inherited inference would have become a rule (F-34). What M1c did
**not** do: `crabby task run`, `POST /admin/*`, and the TUI/Web/Telegram surfaces, all of which belong to M2 and M3
(`docs/INTERFACES_AND_API.md` §8 marks their cells `planned`, and `scripts/parity.ts` fails a `ready` claim that has no
command behind it).

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

**In progress — the state machine first, because everything else in M2 is written in terms of it.** D-083 fixed §4.1's
transition table in the document that owns the lifecycle and in `packages/agent-runtime/transitions.ts`, with
`scripts/parity.ts` diffing the two in both directions (the same discipline §4.2's tier table gets), and the three rules
a table cannot carry are in the function's signature instead of a comment: an entry into `cancelled` names §6.2's
outcome, an entry into `running` out of an approval names the answer, and recovery may not authorize itself (§7.2).
`packages/agent-runtime/approvals.ts` is the second module, and D-084 is the reason it is a runtime object rather than
a Gateway handler: one arbiter for four answerers, `once` that means once because a single row says so, and an expiry
that arrives as an event whether or not an answer arrived with it. Its persistence and its two §4.3 routes landed with them:
schema version 2 is the `approval` table, `packages/storage/approvals.ts` implements the arbiter's `ApprovalStore`
seam, and the queue and the decision are `GET /approvals` and `POST /api/v1/approvals/{id}/decision` — a route over a
table nobody had written would have been a demo, so the table came first. Writing it against §6.2 also surfaced that
the tier-a-surface-may-sign rule had no document at all, which is F-39 and D-085. The loop that *opens* a request when a task
reaches a gated action landed next, in the same package: `packages/agent-runtime/loop.ts` runs §4.4's pipeline per action,
hands the request to the arbiter, consumes the approval at the moment of execution, and drives the task through D-083's
machine — which needed one amendment to do it (D-087: `running` → `awaiting_approval`, because §5's rule 1 evaluates every
action and the table could not express a second approval in one task). Writing it against the plan is what priced the two
limits §5.2 required and D-074 had not (D-088, F-41), what decided that "repeated denial" means two refusals and that a
pause is a readable state rather than a silence (D-086), and what found the fifth approval state had no event of its own
(F-42). Its harness runs a whole task end-to-end against the fake provider — plan, allowed step, gated step, answer,
consumption, completion — and `loop.test.ts` asserts the sentences rather than the trace.
Cancellation landed after it, in the same package:
`cancellation.ts` records §6.1's request and writes §6.2's outcome, and the loop stops scheduling steps the moment a
request exists, lets the step in flight finish under `finish-step` or aborts it under `immediate`, and reports what was in
flight so the manager can record `terminated` and `effectsUncertain` instead of guessing (D-089, D-090). Its twelve tests
drive a real run — a step that hangs, a request that arrives while it hangs, and the two modes answering differently.
Recovery landed with them: the Gateway runs §7.1's scan at
startup beside the retention prune, marks every non-terminal task `interrupted`, **settles** a cancellation that was
requested before the process died instead of resurrecting it, sweeps the prompts whose deadlines passed while nobody was
watching, and reports per task why nothing resumed (D-092, D-093) — proved over HTTP with the listener *and* the file
handle closed between the two halves of the test. The retry ladder landed after them, and it was wiring rather than
deciding: `packages/providers` had held D-064's schedule, its jitter and `shouldRetry` since M1c and the loop had never
called them, so `callProvider` is now D-043's stage 1 — same model, same provider, up to `limits.providerAttempts`
attempts, transient classes only, a `provider.retry.scheduled` and a `provider.retry.attempt` event per rung — and a
cancellation recorded while the ladder waits settles the task as `cancelled` rather than `failed`, because sitting out a
16 s rung for a task the user already stopped is the behaviour §6.3 forbids. D-094 records why the ladder climbs provider
calls and never tool steps, and F-49 the gap it closed: D-043's attempt count had been "configurable" with no config key
that reached it. The checkpoint manager landed next, in `packages/agent-runtime` rather than in the Gateway for the reason in
D-003: a rule the Gateway owns is a rule only the Gateway can follow. `checkpoint.ts` commits D-065's boundary inside the
transaction that records each step and a second kind of boundary for a run suspended at an approval,
`packages/storage/checkpoints.ts` keeps one row per task, `GET /tasks/{id}/checkpoint` reports the boundary and its verdict
without handing the transcript to a fourth interface, and recovery reports that verdict per task instead of saying it has
nothing to pass (D-095, closing half of F-47). D-044's second rung — ask the user which model to use instead — stays
absent, and building the checkpoint is what showed why: the saved state it resumes from now exists, but there is no switch
surface to ask on, no runner to answer to, and `failed` is terminal and absorbing, which is F-50. So an exhausted budget
fails the task and says how many attempts it took. **Still absent, and the reason `crabby task run` and a
cancellation route are not `ready`:** the loop has no tools to run (`ARCHITECTURE.md` §18's `packages/tools` does not
exist, so the executor is a seam), no provider adapter to call (`PROVIDERS_AND_TOOLS.md` §3.3's four arrive in M2/M4, and
the fake is a test reference rather than a product provider), and nothing in the Gateway that drives a task — so a route
that started a run, or one that cancelled a run nobody started, would be the demo this phase has refused to ship. F-46 was the debt that slice
named, and the next one closed it: schema version 3 is the `cancellation_json` column, `TaskRecord.cancellation` is the
contract, `packages/storage/journal.ts` is the runtime's write seam over the real database, and `crabby task show` prints
whether the operation stopped and whether an external effect is in doubt (D-091).
The tenth closed a promise the Gateway had been logging around since M1b: `GET /events` binds each live subscriber to the
identity that opened it, `closeFor` ends those streams in registration order and counts them, and a named `event: end`
frame says `revoked` before the socket goes — the frame is not decoration, because §5.4 already tells a client that a
stream which stopped is a stream to reconnect through (D-096, closing F-51). The same binding is what `crabby auth list`
and the TUI's confirmation prompt were missing: `liveStreams` per identity, counted by the bus rather than by a second
book of who is watching (F-53). The same slice put §3.1's "local only" on the
two identity routes that lacked it, measured on the socket rather than on `auth.manage`, for the reason F-52 states: no
code in this build assigns capabilities at pairing, so the capability the documents name has no writer — which is the same
unanswered question `POST /admin/*` waits on, and is why it is recorded rather than quietly defaulted (D-097).

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
| ~~The 650 undecided rows in `docs/review/`~~ — **closed by D-075** | Reviewed under delegation on 2026-10-10; they no longer block regeneration, which is scheduled as P8 so it happens after the measurements that could change a row. Owner review continues per step (D-076). Regenerating the two spec documents from approved elements is M-D work, and it never blocked running the M0 probes |

**Closed during M-D (2026-10-09):** O-004 transport → D-048 (SSE + HTTP, no WebSocket in v1); O-010 replay →
D-049 (per-task `seq`, count-bounded window, gap + reconcile-by-GET); O-012 install path → D-050; O-019
token/expiry → D-051.

**Closed in the (R) round (2026-10-10, D-059…D-068):** fifty of the then-63 tracked items, including all eleven
questions the element review had raised (O-053…O-063) and everything the toolchain, terminal contract, provider
runtime policies, data policies, platform boundaries and interface shapes were waiting on. `docs/review/DECISION-QUEUE.md`
is the row-by-row record, with the evidence and the veto path.

What that leaves is a short list and an honest one: M0 is unblocked by decision, and the only way to close the items
above is to run the probes. Eight items carry work: O-006 and O-051 (a phone render), O-008 (real extensions),
O-052 (post-v1 by choice), the one measured clause left in each of O-001 and O-002, and the two questions registered
while finalizing because they had no row at all — O-064 (signing mechanism) and O-065 (Termux sandbox). Each is open
because it needs a device, needs real extensions, or is a post-v1 design question (D-052) — never because nobody got
to it. The four questions that needed neither were decided instead, as D-071…D-074. `scripts/check-docs.py` counts the register on every
run, so a stale "still open" cannot survive a commit. The 65 `O-` rows are not 65 open questions: a closed question
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
