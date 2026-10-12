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
records findings F-01…F-57 with what each one changed. M0 is the phase that closes what remains, because those items
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
cancellation route are not `ready`:** nothing in the Gateway that drives a task — so a route that started a run, or one
that cancelled a run nobody started, would be the demo this phase has refused to ship. That list had three items, and two
slices removed two of them: `ARCHITECTURE.md` §18's `packages/tools`, which the eleventh slice built, and a product
provider adapter, which the twelfth built for §3.3's first and widest family (its other three arrive when something calls
them). F-46 was the debt that slice
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

The eleventh slice is that third item: `packages/tools`, the executor §18 reserved a directory for, with eight of §4.2's
forty-five rows behind it — `file.read`, `file.list`, `file.stat`, `file.write`, `file.edit`, `file.delete`, `file.move`,
`fs.search` — each declaring the five fields of §4.1's record that belong to a runtime rather than to a registry (D-098).
Declaring them is what turned two constants into facts: §6.2's `effectsUncertain` is now derived from `sideEffects`, so a
cancellation that arrives during a read is recorded as certain and one that arrives during a delete as in doubt, which is
the first measurement that field has ever been; and D-065's first permission has a witness, so `verdictFor` answers `pass`
for a step killed mid-`file.edit` and `re-ask` for one killed mid-`file.move`, with `stepFactsFromDeclarations` as the
bridge from a declaration to the checkpoint's `StepFacts` — one source for two rules, because a second copy of "is this
tool idempotent" would be a second opinion about the same permission. That closes F-47's other half only as far as a
declaration can: the half that remains is still a runner that would call `loop.resume`. Writing bytes rather than prose is
what forced the rules that follow, and each is a decision rather than a default. **`file.write` is create-only**: it refuses
a path that exists and names `file.edit`, because §4.2 prices those as two rows at two tiers and an executor that quietly
overwrote would have merged them. **Both writers are atomic** — a temporary file in the target's own directory and a rename
over it — and `file.write` creates through a *hard link* onto the destination, which is the only create that fails
atomically when the path appeared between the check and the write; where a filesystem has no hard links (Termux's shared
storage is a FUSE mount that often does not) it renames instead and the outcome says which happened, rather than implying a
guarantee the device did not give. **`file.delete` trashes by rename** into the task's scratch directory, which D-064 prunes
24 h after the task ends, and refuses a cross-device directory by naming `hard: true` — the option §4.2 prices and §8 calls
T2/T3 — instead of choosing a hard delete on the user's behalf. **`fs.search` is bounded** by the output cap and the 10 s
`fs.*` deadline and follows no symlink, so a walk that would take longer ends as a partial result that says it is partial.
§4.4's two output rules got numbers at the same time: the cap is 64 KiB of the **wrapped** text — storage's own inline
limit, so an overflow is cut once by the executor rather than twice by whoever stores it — the cut falls on a UTF-8
boundary, the whole result goes to scratch with its path printed in the label, and the label sits outside the delimiter
because a note inside untrusted content is content; and §10's marker got a shape, `<external-content source subject
trust="untrusted" at nonce>` closed by the same nonce, re-rolled up to six times if the content contains the closer and
thrown rather than emitted if six rolls collide, because a wrapper its own content can close is a wrapper in name only. One
design change came from a refusal rather than a preference, and it is the slice's most consequential sentence: §4.3's two
file escalations turn on facts about the filesystem — a path that already exists, a destination that is occupied — and
merging an observation into `args` is denied by §4.3's own undeclared-argument rule, while letting it through would mean
declaring that key in the model-visible schema, which §10's "a declared field is never an authority" forbids outright. So
facts travel on a second channel, `ToolCall.facts`, filled by the executor before `evaluate` is asked, recorded in
`tool.call.proposed` so the prompt shows what policy saw, and hashed into the approval's binding so D-084's comparison at
the moment of execution covers the observation as well as the request (D-099). `preExistingUserFile` means *the path
exists*, which is weaker than §4.2's "a file Crabby did not create" and deliberately so: this build keeps no created-by
ledger, and the conservatism is one-sided, costing one prompt for a file the agent wrote itself rather than lowering a tier
on evidence that does not exist. `validateToolArguments` landed in `packages/api-contracts` with it — §4.4's step 1, and
the one place a schema's two spellings (typebox where it is checked, JSON Schema where it is published) are reconciled; a
schema that arrived as data is name-checked and not type-checked, which is F-54 recorded rather than a validator that
quietly passed. The other thirty-seven rows stay absent because each needs a subsystem this build does not have — no memory
store, no scheduler, no shell policy with a runner to enforce it, no egress allow-list with a writer — and a name with
nothing behind it is the mock this phase has refused to ship; `GET /tools` still prints the five executor fields as pending
for the same composition reason, which is F-55 rather than an omission. The review surface is `node packages/tools/demo.ts`:
one task over a real directory tree, a T0 read, a T1 create, an edit that stops at a T2 prompt *because the runtime
observed the file*, the answer from a TUI-shaped client, the resume, the workspace afterwards, and then the two
cancellations and the three verdicts that the declarations make different from each other.

The twelfth slice is that adapter: `openai-compatible`, §3.3's first row and deliberately its widest rather than its most
famous, because "implement families, not N vendors" means one adapter now serves Groq, OpenRouter, Together, Fireworks,
LM Studio, vLLM, Ollama's compatibility layer, GitHub Models and D-041's user-defined endpoint — and a **preset is the
same adapter under a different `id`**, which is what §3.3's "presets carry no privileged behavior" means once there is
nothing else about them that could differ. What the user supplies is the base URL, the key, the model names and a §3.2
descriptor per model, and that last one is a decision rather than an omission: `GET /models` in this family returns ids
and nothing else, so discovery would have produced exactly what the conformance suite refuses — a model `listModels()`
names whose limits are unknowable. §3.5's `timeout` row finally means what it says, and the split is three-to-one: the
adapter arms connect, first-token and stall because only the party holding the socket can tell them apart, reading D-074's
numbers out of `packages/core` rather than retyping them, while the absolute deadline arrives as `ctx.timeoutMs` and is
reported under its own label — §3.1 makes timeouts the runtime wrapper's job, and "the endpoint never answered" is a
different fact from "the call ran out of budget". Writing that split caught the slice's own worst bug, worth recording
because it is invisible in a unit test: a deadline whose abort stops reaching the socket once headers have arrived is a
hang wearing a timeout's clothes, so the propagation now lives for the whole request. `cancellation` is declared
`best-effort` for the honest reason — aborting closes this side of the socket and stops the task waiting, and cannot stop
a remote server generating tokens it will bill for, which is more than `supported` would let §6.2's evidence claim. A
stream that carries no usage reports **zeros rather than an estimate**, because §3.4's budget spends these numbers and
`Usage` has no "unknown"; the honest fix is a `reported` flag on `Usage`, which belongs to §3.4's owner and not to an
adapter, and D-100 records it so the zero reads as a decision. §3.3's custom-provider rules became one implementation
both adapters call, and the fake now delegates to it, because a reference adapter that validates configuration
differently from the product one teaches the wrong thing about what "an actionable reason" means; `ConfigValidation`
gained a `warnings` channel for the same section's plain-HTTP requirement, which is a warning and not a refusal — a LAN
`llama-server` on plain HTTP is a setup §3.3 accepts and the user chooses, while credentials embedded in a base URL are
refused outright, because a key in a URL is a key in every log and shell history that records one. What §3.7 promises and
this build does not have is stated in the document rather than left to a reader: there is no vault code, so the key is a
plain string in the adapter's configuration, F-56 records the gap in F-52's shape, and the two duties that follow — never
a log line, never model context — sit with whoever composes an adapter. Testing is §7's rule taken literally: the shared
conformance suite passes for this adapter against a **local server speaking the real wire protocol** (SSE frames, a
keep-alive comment, a tool call streamed in three fragments, `retry-after`, four `finish_reason` values, a socket closed
before headers, a body that is HTML), because a stub *server* is not a stub *provider* and §7 forbids the alternative;
forty-three cases in the adapter's own file, and not one of them reaches the internet. Absent on purpose: `ollama`'s
native API, `anthropic`'s tool blocks and `gemini`'s streaming metadata, because each differs genuinely and none has a
caller in this build; adapter-side retries, because D-043's ladder is the loop's and an adapter that retried would double
it; and `countTokens`, because §3.1 says absence means §3.4's own estimation, and an estimate dressed as a count would be
spent as if it were one.

The thirteenth slice is the configuration a run is made of, and it landed before the runner for a reason worth stating:
a runner composed with no provider to call is a demo, and `crabby gateway start` had never loaded `config.json` at all —
so D-074's `limits.sqliteBusyTimeoutMs` was an override that changed a screen and not a socket, and §3.3's "Configured
through `crabby provider add` **or configuration**" was a path with no code on it. Three namespaces enter the file, each a
spelling a document already uses rather than a shape this slice invented: `provider.<id>.*` (§3.7's own example,
`provider.groq.key = vault://groq`), `defaultModel` (§3.6's selection, in the `<provider>/<modelId>` form §7.1's `/model`
command takes), and `workspace.roots` (`SECURITY.md` §8's "one or more **configured workspace roots**", which §4.2's
`config.set` row already names). `packages/providers/compose.ts` turns an entry into an adapter and refuses four ways,
each with the sentence that owns it. **An inline key never reaches the file**: the schema requires `^vault://`, because
§3.3's "never inline in … an ordinary config file" cannot be enforced after a mode-`0644` file exists and `crabby config
get` prints what is in it. **A `vault://` reference is refused by composition**, naming M5 and F-56 — an adapter composed
with a dropped credential answers `401` from the endpoint and reads as a broken network. **`mock` is refused from user
configuration** although §3.3 lists it as a preset, because `SECURITY.md` §17 makes it the instrument that keeps tests off
live APIs and composing it would let a task reach `completed` with no model behind it. **§3.3's other three families are
refused by name** rather than coerced into the one adapter this build has, since pointing it at another wire protocol
produces a failure that reads as a broken endpoint. What composes is therefore a keyless endpoint, which on the primary
platform is the supported path and not a consolation prize: D-066 and O-034 both settle local inference on Android as an
external server the user runs, and a `llama-server` on `127.0.0.1` asks for no key. `crabby init` does §5's step 3 — it
creates `$HOME/crabby-workspace` and records what it created, which is a fact about this install rather than a default, so
every D-074 number still lives in code — and `crabby doctor` re-runs §5's steps 2 and 3 as checks, **failing a root that is
the home directory**, because §8 says the home directory is not a workspace and a root that wide leaves the sensitive
deny-list, a floor rather than a containment rule, as the only boundary. `GET /api/v1/status`'s providers row stopped
saying `contract-only`, which M2l had already made false, and reports what composed beside what refused. **Still absent:
the runner.** A composed adapter is *reported* and not yet *called*, so `POST /api/v1/tasks` still records a task nothing
moves, and `crabby task run` and a cancellation route stay `planned` for the reason §4 gives. F-57 records the body drift
a runner will have to answer: §4.3 documents a model pin the contract refuses, and §3.6's per-task half now has a default
with nothing able to override it (D-101).

The fourteenth slice is the runner, and it landed in `packages/agent-runtime` rather than in the Gateway for the reason the package index gives: a rule the Gateway owns is a rule only the Gateway can follow (D-003). §4.4 splits ownership — the lifecycle to the Task Manager, the transition rules to `transitions.ts` — and the question nothing could answer was "is this task already running?", which four clients over one Gateway ask constantly. `createRunner` composes `createLoop` behind two maps rather than one, because *moving* and *waiting for a human* are different facts with different answers: a run in flight refuses a second start and can be cancelled, while a run parked at an approval refuses a start naming the approval, is woken by an answer, and has nothing for §6.1's step 2 to stop. It registers a run before the loop's first `await` — the bug M2l's adapter taught, restated as a rule — and calls `begin()` synchronously inside a `try`, so a cancel issued in the same tick as a start finds a controller to stop and a throw while composing the run's arguments still becomes an answer instead of an exception reaching a route. It writes nothing: every state change stays the loop's or the cancellation manager's, one writer per fact (§9), and a run that throws is answered `refused{runner.threw}` with the task left where it was. `shutdown` spends D-066's budget waiting rather than killing and reports `{drained, abandoned, parked}`, leaving abandoned runs to §7.1's recovery because a shutdown that also wrote `cancelled` would be a second party settling one task. And `resume` with nothing parked says why — §7 keeps `call.args` out of the checkpoint, D-065's verdict for that boundary is `re-ask`, and `POST /tasks/{id}/resume` is not in this build — which is F-47's remaining half, reported rather than papered over.

The fifteenth slice is the half of §6 a Gateway can honour without a run. `buildApp` now composes the process's one cancellation manager beside its arbiter, journal and checkpoint manager, because §6.1's step 2 and §6.2's evidence have to be about *one* request and two managers would each hold half of it, and `POST /api/v1/tasks/{id}/cancel` requests through it. The route needs no provider, no executor and no grants — stopping work is not the same act as doing it — so it is real in a build where the task handoff is not: a `queued` task has nothing in flight, so the manager settles at once and the answer is already `cancelled`, with §6.2's evidence on the record (`inFlight: "none"`, `effectsUncertain: false`) beside §14's `by`, and a double-tap returns the request it recorded rather than a `409`, because a phone that taps stop twice is relaying one fact and not asking twice. `CancelTaskBody` carries an optional `mode` for the reason §6.2 gives, and there is no `Idempotency-Key` on this route by decision rather than oversight: deduplication and escalation are two different readings of a second request, and a key cache would have to pick one and get the other wrong. **The handoff is still absent, and F-52 is why** — `LoopSubject.grants` would come from `Identity.capabilities`, which no code in the build writes, so a run started from a route would hold no grants and policy would refuse every tool it proposed. The runner therefore exists and nothing composes it; `crabby task run` stays `planned` because nothing can drive a run, and `crabby task cancel` stays `planned` only because the command is unwritten — the route it would call now exists, which is M2o's work.

The sixteenth slice narrows F-55 rather than closing it, and the honest account is in the finding's amendment:
`crabby gateway start` composes `createFileTools` from `config.json`'s `workspace.roots` and hands its `declares` to
`buildApp`, so `GET /tools` answers §4.1's runtime fields for the seven registry rows an executor implements and prints
`runtime: {implemented: 7, described: 0, pending: 38}` beside them. `PENDING_RECORD_FIELDS` did not shrink — each row's own
list did, to `["outputSchema"]` on the seven and all five on the rest — and `described` is 0 because no declaration carries
an output schema. An install with no configured workspace composes no executor at all, since `WorkspaceConfig` forbids
inventing a root the user never chose, and the Gateway prints that once at startup instead of leaving a route to explain it
later. The same slice paid a debt the runner created: five claims in `packages/agent-runtime/recovery.ts` and the Gateway's
provider `note` still said "there is no runner", which stopped being true in M2n, so each now names the party that *is*
missing — nothing composes the runner into a Gateway, because no code writes `Identity.capabilities` (F-52).

**Still absent: the handoff.** `POST /api/v1/tasks` records a task and nothing drives it, and the reason is F-52 rather than
a missing file: a run started from a route would take its grants from `Identity.capabilities`, no code in this build writes
that column, and a run holding no grants would be refused every tool it proposed. `crabby task run` and `crabby task cancel`
are therefore not `ready` in §8 even though the cancellation route they would call is real and tested.

The seventeenth slice writes the command the previous two slices made possible: `crabby task cancel <id>`, with `--mode`
and `--reason`, `ready` in the registry because the rule that decides that word is whether a route stands behind the verb
and `POST /api/v1/tasks/{id}/cancel` has stood behind it since the fifteenth slice. It closes the two claims above it —
`crabby task cancel` was `planned` at the fifteenth slice only because the command was unwritten, and the sixteenth's "still
absent" paragraph named it alongside `task run`; only `task run` is still absent now, and for F-52's reason rather than for
want of typing. Three things the slice turned up are recorded because they were bugs rather than details. **The registry held
two entries for one verb** — the new `ready` one and a `planned` one left from M1b whose milestone, "cancellation manager",
had been delivered two slices earlier — so `--help` printed `task cancel` twice, once as ready and once as planned, and
whichever `findCommand` reached first decided which flags the verb accepted. **Argument validation ran after the Gateway was
contacted**, so a malformed cancel on a machine whose Gateway was down exited `1` (failure) instead of `2` (usage); §7.1's
exit codes are a contract about the command, not about the process it would have talked to, and the checks now run before
`connect`. **`task show` still has that ordering flaw**, and is left with it named rather than quietly fixed in a slice about
cancellation. The command prints §6.2's evidence on one line — mode, whether the operation stopped, whether an external
effect is in doubt — because those three facts are what a user judges a cancellation by, and `cancelling` prints as
*requested, not settled* rather than as a stop, since D-090/D-091 make present-without-`settledAt` mean the former.
`tests/integration/gateway.test.ts`'s spawned-gateway-and-CLI test now cancels a real task across two real processes and
reads the settled record back through `task ls --json`, which is the assertion that makes "four interfaces, one behaviour" a
tested claim for this verb rather than an aspiration.

**Still absent: the handoff, and now only the handoff.** `crabby task run` stays `planned` for F-52's reason — nothing writes
`Identity.capabilities`, so a run started from a route would hold no grants — and with `cancel` written, cancellation is the
whole of §6 that four interfaces can reach today: request and report, never drive.

**Eighteenth slice — `crabby task watch`, and the two bugs a streaming verb turned up.** The events were never the missing
part: `GET /api/v1/events` has filtered by `taskId`, replayed from `Last-Event-ID` and answered an out-of-window cursor with
§5.4's `gap` frame since D-048, and the registry entry this verb replaces carried a milestone naming "event delivery and gap
handling" — both halves already delivered server-side. What was missing was a terminal that could follow them, so the entry is
`ready` and the milestone is gone. The verb is also the first streaming command in the CLI, and it reaches for a raw `fetch`
rather than a client method because `GatewayClient` is buffered by design: every other route answers with one document, and
giving it a streaming member would mean two lifecycles behind one interface. It reads the task once *before* opening a stream,
so an already-terminal task is answered at once instead of hanging on a stream that can never publish; it exits when a terminal
state arrives rather than tailing until interrupted, and `interrupted` deliberately does not end a watch because §4.1 makes it
non-terminal and resumable; it prints §5.4's `gap` frame and the stream's `end` frame as visible facts, because turning either
into a silent EOF would convert an outage into a prompt that simply never returns; and it prints the last event id without ever
reconnecting on it, handing `Last-Event-ID` to whoever is driving rather than hiding the outage that made a reconnect
necessary.

Two real bugs came out of writing it, and both are recorded because each is a fact about a component that outlives this verb.
The first is in the CLI's own renderer: `done()` serialises with two-space indentation, which is right for a snapshot and wrong
for a command whose §7.1 contract is NDJSON, so the legitimate "already terminal" answer arrived as dozens of lines that no
script parsing one-document-per-line could read. §7.1's sentence "a `--json` snapshot stays one document" is what makes the fix
a correction rather than a preference, and the verb now emits that refusal through `raw()` as a single line carrying
`streamed: false` and `events: 0`, with the §4.1 rule travelling in `fixes[]` because a script has no ordering to read. The
second is in the Gateway's stream: history is replayed only to a request carrying *both* a `taskId` filter *and* a non-empty
`Last-Event-ID`, so a subscriber with no cursor receives nothing at all until a new event is published — not even a `gap` frame.
That is defensible on the wire and decisive for a test, because a freshly created task publishes `task.created` before a watcher
can attach, so waiting for the first line waits forever; the assertion therefore polls `GET /api/v1/diagnostics` until
`streams.subscribers` reaches one, which is the Gateway's own account of the stream existing, and only then cancels the task so
the watcher has something new to see. The end-to-end claim is the one that matters: the spawned watcher exits by itself, with
status zero, having printed one parseable event per line in a monotonic per-task `seq`, because `isTerminal` is what makes
`task watch` a command that returns rather than a tail that only Ctrl-C ends.

**Nineteenth slice — `crabby task watch --types`, and what a filter must not be allowed to hide.** The flag is not a new
promise: D-048 already accepted that `GET /events` is filtered by query (`sessionId`, `taskId`, `types`), and the Gateway has
split that value on commas and matched each token as a prefix since the route was written. What was missing was a terminal that
could ask for the filter it was already entitled to, so the registry entry now names `--types <a,b>` and nothing server-side
changed to accommodate it.

The decision this slice turns on is that the flag narrows what a watch *prints* and never what it can see about its own ending.
A `--types task.progress` watch that asked the Gateway for only what the user typed would never be told `task.cancelled`, and
the command would hold a stream open forever — §7.1's "a command that returns" broken by a flag whose whole job is to hide
things. So the query is widened with the three terminal types and the narrowing happens at print time, matched the way the
Gateway matches: an exact type, or a prefix ending in a dot, so `task` follows `task.state.changed` without swallowing anything
else that merely starts with the same letters. The three are derived from `TERMINAL_STATES` rather than retyped, because a state
added to the runtime must not leave this filter behind, and the failure mode of that drift is a hang no user can diagnose. The
cursor still advances for an event that is not printed, since §5.1's reconnect contract is about the stream's position and not
about what one client chose to look at. An empty filter — `--types ""`, or commas and spaces naming nothing — is answered
locally with exit 2 for the reason the seventeenth slice established: it would ask for no events at all and then wait forever,
and the user should learn that from the command that mistyped it rather than from a stream that never answers.

Two facts are recorded here rather than fixed in passing, because each is a claim a reader would otherwise trust. `crabby
--help` prints a command and its summary and never the registry's `flags`, which makes the fix line at `apps/cli/crabby.ts:158`
— "`crabby --help` lists the flags this build understands" — inaccurate; it predates this slice and correcting it would widen
the work into the help renderer, so the test asserts the property that array really controls instead, which is whether
`parseTail` accepts a flag or reports it unknown. And §8's matrix names `POST /tasks/{id}/resume` as the API behind
`task resume`, but no such route exists in `packages/gateway/app.ts`: the only `resume` there is a comment recording that the
recovery route deliberately resumes nothing (D-092). `task resume` therefore stays `planned` — `runner.resume` exists and
answers `not-parked` with SECURITY §7, D-065's `re-ask`, §4.3 of this document and F-47 behind it, but nothing composes a
runner into the Gateway, so no task can ever be parked and the verb would be scaffolding with nothing behind it. Parity tolerates
the gap because its route check runs in one direction only: it fails when a registered route is undocumented, not when a
documented route is unregistered.

**Twentieth slice — `crabby approval ls|approve|deny`, and the terminal can now say yes.** The approval service was
composed into the Gateway before this slice: `createApprovals` is built in `buildApp`, `registerApprovalRoutes` registers
both §4.3 routes, the queue sweeps before it reads (D-093), `GatewayClient` already carried `approvals()` and
`decideApproval()`, and nine integration tests answered the routes over HTTP from three identities. The registry entries
for these three verbs named a milestone reading "M2 (the approval service)", which had been delivered, and the thing
actually absent was `apps/cli/commands/approval.ts` — the file did not exist. The consequence was concrete: `crabby
status` could print "N waiting" while no command could answer one, so a prompt raised over HTTP could only be answered
over HTTP. Cancellation had reached all four interfaces and approval had reached none of them, which is the same "one
behaviour, four surfaces" rule broken at the other end — three interfaces could stop work and not one could authorise
it. All three verbs are `ready`, and the milestone is gone.

Three flags are deliberately absent, and each absence is a claim about the route rather than an oversight. No `--scope`:
`ApprovalDecisionBody` types `scope` as a string rather than the literal `"once"` precisely so that D-052's refusal of a
remembered approval arrives from the arbiter citing §6.3 instead of from a schema, and the HTTP surface already has a test
that provokes it — but this release admits one answer shape, so a flag whose every non-default value is a refusal would
advertise an override that does not exist, which is the opposite of `--mode` on `task cancel`, where the override is real
and leaving it unreachable from a terminal would have made §6.2 advice. No `--yes`, which the entry used to advertise: it
would have skipped a confirmation prompt, and no code asks for one, so its only effect would have been to tell a user that
a prompt exists. No `--reason` on `deny`, and for that one the registry's own summary was narrowed rather than the flag
added: it promised "deny one action and record why", and §4.3's body has no reason field, so a reason typed at a terminal
would have been read, accepted, and dropped on the floor. What the record does hold is §14's audit fields — `actor`,
`via`, `outcome` — written by the route from the answering identity, and the summary now says only what the route can
keep. Both refused flags are asserted as unknown in the unit tests, so neither can come back as a silently ignored
argument.

The refusal a terminal deserves is the one D-085 makes it earn: a T3 signature is confined to the TUI and the Web UI, so
`crabby approval approve <a T3>` exits 1 printing the arbiter's own sentence citing §6.2, and the row stays pending for a
surface that may sign it — neither consumed nor expired, with nothing written to the log. That is asserted end to end
from a spawned CLI against the same arbiter the HTTP tests use, beside its counterpart: a T2 from the same terminal is
accepted, which is what makes the restriction the tier and not the transport. The queue renders §6.3's countdown against
the Gateway's `serverTime` rather than the terminal's clock, because the Gateway is the party that decides expiry, and it
prints the exact target whole beside the summary, since approving what a summary says is how a binding comes to cover
something nobody meant.

One fact about testing this codebase came out of writing those assertions and is recorded because it will otherwise be
rediscovered the slow way: a spawned CLI cannot be driven with `spawnSync` against an *in-process* Gateway. The child
waits on an HTTP answer from the parent's event loop, and a synchronous spawn blocks that loop until the child exits, so
the pair deadlocks and the whole file times out instead of failing one test. `P-003` gets away with `spawnSync` because its
Gateway is a separate spawned process; the approval harness is `buildApp` plus `listen` inside the test, so its CLI helper
spawns asynchronously and carries a deadline. With `gateway restart` still `planned` on a milestone reading "needs the
approval service", that dependency is now met for the first half of its sentence and unmet for the second — restart is
T3, and a T3 is exactly what a terminal may not sign.

**Twenty-first slice — a workspace root behind a symlink was refused as an escape, and it was the reason macOS CI
had been red since M2k.** `checkPath` resolved the *target* through links and then compared it against the workspace
roots exactly as configured — `path.resolve`, which is lexical and follows nothing. So a root that is itself behind a
link refused every file inside it, with the reason `'x' resolves through a link to '/private/var/...', outside every
workspace root`: a sentence that reads like containment working while describing a file that never left the root. The
fix resolves both sides of the re-check, falling back to the lexical root only when the resolver throws, which it does
for a root that does not exist yet.

Two shapes make this a defect rather than a CI inconvenience. macOS hands `os.tmpdir()` out as `/var/folders/...`
where the real directory is `/private/var/folders/...`, so on a macOS runner every temporary root the file executor's
suite builds is behind a link; and Termux's `/sdcard` — the primary platform's most obvious place to put a workspace
— is a link to `/storage/emulated/0`. That is also the whole explanation of the CI history: `macos-arm64` has failed
on every commit of this branch since `2c605d9` (M2k, the slice that introduced `packages/tools` and its real-filesystem
suite) while `linux-x64` and `main` stayed green, because `/tmp` on Linux is a real directory and the two names are the
same string.

Why nothing caught it is the more useful half of the record. The policy tests injected *constant* resolvers —
`() => "/etc/hosts"` — and a resolver that answers every path with the same string is not a resolver: it collapses the
root onto the target, so containment holds for anything asked of it and the case "the root itself resolves somewhere
else" was never modelled. Those three fixtures now name the one path that hops and leave every other path alone, which
is what `realpathSync` does; **the assertions are unchanged**, and what they test is the rule rather than the artifact.
This is recorded explicitly because making a fixture faithful is not the same move as softening a red — the fixtures
were proving less than their test names claimed, and the fix is what exposed that.

Two regression tests were added, one in each place the bug could hide: `packages/policy` asserts the containment
judgement with a resolver that maps the root to its real location, and `packages/tools` asserts a real `file.write` and
`file.read` inside a root addressed through an actual `symlinkSync` link, using the default resolver. Each was verified
red with the fix reverted and green with it restored, because a regression test that was never seen failing is a claim
about a bug rather than evidence of one.

One property was decided rather than discovered along the way: the root a verdict reports back is now the *resolved*
one. The file executor's `relative()` measures `path.relative(root, resolved)` to build the path it shows a user, and a
lexical root beside a resolved target emits `..` segments that name no location on disk — so the two must come from the
same resolution or the string shown to a user describes nothing. On Linux and on a Termux home directory that is not
linked, nothing changes at all.

**Twenty-second slice — the previous paragraph claimed to be the whole explanation of the macOS failures, and it was
not.** Resolving both sides of the re-check fixed the refusals, and `macos-arm64` stayed red. The job log could not be
read from here — GitHub redirects it to a blob host this sandbox cannot reach — so instead of guessing, the macOS
condition was reproduced on Linux: `os.tmpdir()` honours `TMPDIR` on both platforms, so pointing `TMPDIR` at a symlink
makes every temporary root in the suite sit behind a link, exactly as `/var/folders/...` does on a macOS runner. The
full suite of 482 tests then failed three, all in the file executor's, and all for the same second reason.

Each of the three asserted a path built from `instance.root` — the configured string — against output that carries the
*resolved* path: the `file.stat` metadata's `"path"` after a link hop, the frame's `subject=` attribute on a
`file.read`, and the destination `defaultRealpathOf` computes for a create whose ancestor is a link. On Linux the two
strings are identical, so every one of them passed while asserting nothing about the platform it ran on; on macOS the
metadata names `/private/var/...` and the expectation names `/var/...`. Two of the three even argued for the resolved
path in their own failure messages — "the metadata is about the file it resolved to", "§6.3's rule about the exact
target in plaintext is why it is the resolved path" — and then compared against the name the caller used, which is the
file the call never opened. The expectations now resolve the root with `realpathSync` before comparing, so they are
claims about §8 rather than about the shape of the runner's temporary directory, and they still demand an exact path.

Two properties are worth keeping from this. A test that passes on one platform because two different things have the
same name there is not testing either of them; the way to find out is to make the names differ, which on this codebase
costs one environment variable. And a red CI job whose log cannot be read is still diagnosable: the first commit that
turned it red narrows the change to one slice, and the platform's own difference — here, a temporary directory that is
a link — can be reproduced deliberately rather than waited for. All 482 tests now pass under both shapes, the linked
one and the real one.

**Twenty-third slice — an identity now holds capabilities, and `--restrict` is the flag §3.1 has advertised since
M1.** This section has said since the runner landed that the one thing absent is the handoff from an HTTP request to a
runner, and it named F-52 as the reason rather than a missing file. F-52 asked three questions — what a restriction
means, who may set one, and how `capability_json` becomes `PolicySubject.grants` — and this slice answers the first
two where an identity is created, which is the only moment the build gets to decide them. The decision is D-102.

The baseline is §6.1's vocabulary for the interface, less `shell.run` and `shell.privileged`, which §9 keeps off a
fresh install because "enabling it is an explicit act", and less `auth.manage` and `tunnel.enable` for `telegram`, the
one v1 interface whose requests do not originate on the Gateway's own host. So `cli`, `tui` and `web` hold 30 and
`telegram` holds 28, and the remote set is a subset of the local one — §5.3's rule asserted over the wire in
`tests/integration/gateway.test.ts` rather than argued in a comment. A restriction is an intersection and nothing else,
which is D-054 written as code: it "removes capabilities from an identity" and "never converts them into an approval
the same restricted client must answer", so `--restrict shell.run` is refused with the rule named instead of enabling
the shell, an unknown name is refused with the vocabulary named, and an empty list is refused because a restriction
that names nothing is not one. The whole mint fails rather than part of it being honoured (§2's rule 03), because a
silently dropped name would hand back an identity other than the one asked for and the operator would find that out
from a later tool call instead of from the answer. The refusal's fix text names §6.1 rather than `--help`, which
prints the shape of a flag and has never held the list of names.

Three things it deliberately did not do. It did not replace D-097's socket guard with a grant test, though D-097 says
the replacement arrives "when a pairing-time grant decision exists" and one now does: no migration gives capabilities
to an identity paired before assignment existed, so a grant test would refuse the owner's own CLI and lock them out of
the recovery path — the outage D-097 named, now reachable rather than hypothetical — and no route has a
`PolicySubject` to ask. It did not invent a workspace root when none is configured, nor a host set when no
configuration field supplies one: `grantsFor` withholds both with a reason on the record, because a default-invented
root would be a path the agent may write to that the user never chose. And it did not widen `CreateTaskBody` —
per-task narrowing is F-57's field and needs schema version 5, so this slice assigns at pairing and says so rather
than half-adding a field nothing reads.

What the slice makes visible is stated rather than demoed. `crabby auth list` prints a set instead of nothing, which
is what §3.1's row and `SECURITY.md` §5.1's own comment on that command asked for; `crabby auth pair --restrict
task.read,session.read` mints an identity holding exactly those two and prints the count beside the code, so a
narrowing is checkable at the moment it happens. The handoff still does not exist: a task created over HTTP is
recorded and read back while nothing moves it. That is the next slice, and it is the one this section has been
pointing at — compose a runner into `buildApp` so `POST /api/v1/tasks` can call `runner.start` with a subject built
from the identity that asked, which is where F-52's third question gets its answer and where the grant test can
finally replace the socket one.

**Twenty-fourth slice — the handoff: `POST /api/v1/tasks` drives what it records, and `crabby task run` exists.** §4's
last "still absent" sentence is gone, and the reason the handoff needed a slice of its own is that the missing piece was
a seam rather than a file: an executor (M2k), an adapter (M2l), a runner (M2n) and identities that hold capabilities
(D-102) all existed, and nothing joined them. `buildApp` now composes a runner when the composition root hands it a
`drive` — executor, adapter, selected model, and the install's half of `EvalContext` — between the cancellation manager
and recovery, and `crabby gateway start` builds that bundle from `config.json`: `createFileTools` over the configured
workspace roots (D-098) and `selectDefaultModel` over the composed provider entries (D-101), refusing to invent either,
so an install with no root or no selected model composes no runner at all and says so on its banner and in
`GET /api/v1/diagnostics`' new `runs.{composed,inFlight}`. The route reads the identity that asked *before* it writes
anything, expands its grants with `grantsFor` against those roots, logs every withheld grant with the reason
`packages/policy` produced rather than dropping it, adds `removedGrantsFor`'s set, and calls `runner.start`. When `start`
refuses — a task already in flight, or parked — the route still answers 201, because that refusal is a fact about the
record and not a failure of the request, and logs why. Shutdown drains runs before it closes streams and before it
closes the database, which registration order buys: `packages/core`'s manager runs its steps in the order they were
registered, and a run still writing would otherwise meet a closed handle (D-066).

`crabby task run` is `ready` on the strength of that, and it is built to refuse rather than to demo. It requires an
objective (exit `2`, with the shape of the command in the fix); it asks `runs.composed` *before* it creates anything, so
a Gateway that cannot drive never receives a task it would leave in `queued` (exit `1`, naming `crabby gateway start`);
it mints its idempotency key with `randomBytes(16).toString("base64url")`, because `newId` has no prefix for one and
inventing a prefix would put a fifth id shape on the record; and it follows the run with the watch verb's own loop,
factored into `followTask` rather than copied, so one rule about NDJSON, per-task `seq` and §5.4's gap frame governs both
verbs. A run that parks at an approval stops there with exit `3` and names the command that answers it, which is §7.1's
row below this one; `--detach` prints the record with a `task watch <id>` reattach line and exits `0`.

M2's Exit criterion now has a test per clause, in `tests/integration/tasks.test.ts`, over real HTTP, a real database and
a real filesystem. A multi-step task a stub client creates completes and really writes the file; a second identity with
a second token reads the same state; the events that got it there are persisted with the `seq` §5.4 gives a client to
notice a gap with; a stream opened by a client that created nothing carries the run, and every frame it carries is a row
on the record; policy denies what policy must deny, with §13's sentence and `platform-unsupported` as the class, and
nothing completes the refused call; a Gateway that composed no runner records a task, drives nothing, and says so rather
than leaving a client to guess; and a run the process died during is `interrupted` on the next start, with
`resumed: false` and a reason that names the absent resume route instead of the composition.

Three things the slice turned up are recorded because they were findings and not details. `PolicySubject.removedGrants`
had no writer either, and without one §13's own sentence is unreachable from a Gateway-composed run: an unheld
capability answers `deny` — "needs `fs.write`, which this identity does not hold" — which invites a user to grant what a
restriction deliberately took away and pushes a restricted client toward an approval it cannot answer, the thing D-054
forbids. `removedGrantsFor` is that writer, and only the integration test could have found the seam: reading the two
packages showed two correct halves and nothing between them. Two user-visible sentences then had to stop claiming the
composition was absent — `GET /api/v1/status`'s providers `note`, and recovery's per-task reason — and both were pinned
by tests, so both pins moved to the true sentence instead of being deleted: the providers note now has two branches,
because `ready` means different things when a runner is composed and when it is not, and recovery's reason names F-47's
absent route instead of an absent runner. Third, a harness fact that cost a run to learn and is written down where the
next one will read it: `dataLayout(dir).stateDir` *is* `dir`, and §8 denies everything under `dataDir`, so a workspace
root inside the data dir arrives at T3 and parks every run at an approval; and `Last-Event-ID: 0` does not replay,
because the Gateway matches an event id and answers anything else with §5.4's `gap` frame — so a test that watches a run
opens the stream first, which is also what `crabby task watch` does.

What is deliberately not here. `POST /api/v1/tasks` enforces nothing at the door: there is no `task.create` grant test,
because every identity paired before assignment holds `[]` and a check would lock an owner out of their own Gateway —
the outage D-097 named — so F-52's closing condition is now exactly that migration and nothing else. `config.json`'s
`limits.*` still do not reach the loop, because `limits.providerAbsoluteMs` and `LoopLimits.providerCallMs` are not one
budget under two names, and only `cancellationSettleMs` is read, for the drain budget; mapping half of them would put a
number in a run that no document promises. There is no `--wait-approval` on `task run`: it is in no registry, and exit
`3` beside the command that answers is the behaviour D-063 asked for. There is no `POST /api/v1/tasks/{id}/resume` and
`crabby task resume` stays `planned`, because §7.1's recovery must not become a way past an approval (F-47). The
scheduler D-046 and D-057 ship with M2 — `cron.schedule`, `GET /jobs`, `job pause` — and that is what §4's list names
next, beside the remaining initial tools: `shell.run` behind §9's opt-in, `net.fetch`, `session.*`, `task.*` and
`config.*`. F-57 still needs schema version 5 for a per-task model pin, per-task narrowing and a schedule. And
`task show`'s ordering flaw, named in the seventeenth slice, is still there: it is a wart about a different verb, and
fixing it inside a slice about the handoff is how a wart stops being visible.

**Twenty-fifth slice — `--restrict` reads a family, so §13's own example became typeable and its impossible half became
a rule.** `SECURITY.md` §13's narrowing bullet reads `crabby auth pair --restrict shell,config`, and neither of those
names is in §6.1's vocabulary: they are families, the prefixes the table's rows share. So the mint route the previous
slice wrote refused the document's own example, and refused it with the *typo* sentence — `'shell' is not in the
capability vocabulary` — which sends an operator to check a spelling they got right. Trying a document's example against
the code that implements it is the whole method of `docs/CONSISTENCY_REVIEW.md`, and this is what it found.

`restrictCapabilities` now expands a dot-less token to the family it names before it intersects, and the two refusals it
can give are separate sentences with separate repairs: a token that is neither a name nor a family is a typo, and a
family no baseline holds is a rule, listed member by member. Expansion cannot widen anything, which is the property that
makes it safe to add at all — what it puts in the set is still only what the baseline already held — so D-054, §5.3 and
D-102's "an intersection and nothing else" are untouched by it. The half of §13's example that cannot be honoured
anywhere stays unhonoured and now says why: §9 keeps `shell.run` and `shell.privileged` out of every baseline, so
`--restrict shell` is refused with §5.3's rule named and both members listed, rather than answered as a word nobody
typed. There is nothing in that family for an intersection to narrow to. §13's example is therefore amended to
`--restrict task,session`, which mints an identity that can read and drive tasks and sessions and nothing else — a
limited identity, which is what the bullet was illustrating.

Asserted by one policy test (a family expands to what the baseline holds; a family and one of its own members together
produce no duplicate; §13's example typed literally refuses on the `shell` half and names the token the operator typed
rather than a member they never wrote; the `auth` family is empty for a `telegram` baseline for a different reason and
says so; a nonsense token is told it is "not a family either") and by two cases over the wire in
`tests/integration/gateway.test.ts`: `restrict: ["config"]` answers 201 with exactly `config.read` and `config.write`,
and `restrict: ["shell"]` answers 400 naming the rule rather than the vocabulary.

Documents: §13's bullet, `docs/INTERFACES_AND_API.md` §4.5's mint row, and F-52 — recorded there rather than as a new
row, because what a restriction means and who may set it is F-52's subject and that row is where a reader looks.

What is not here. Nothing about what a restriction *means* changed: it is still an intersection, the whole mint is still
refused when any name is refused (§2's rule 03), and the CLI still does not validate the vocabulary, because §6.1 belongs
to the Gateway and a second validator is a second way to be wrong. The scheduler D-046 and D-057 ship with M2 —
`cron.schedule`, `GET /jobs`, `job pause` — and remain what §4's list names next, beside the initial tools that are still
absent: `shell.run` behind §9's opt-in, `net.fetch`, `session.*`, `task.*` and `config.*`.

**Twenty-sixth slice — two output lines that outlived their subject, and the measurement that replaces them.**
`crabby status` printed `crabby task run "…" — planned for the runtime slice` and `crabby task ls` printed that the verb
"comes with the runtime", and the handoff made both false without failing anything, because no test reads a prose string.
That is the defect F-38 and F-40 were written about and the one `apps/cli/commands/status.ts` argues against in its own
comments, arriving one screen at a time. Both lines now answer from the Gateway rather than from the build: the `runs`
half of `GET /api/v1/diagnostics` is read into a `runs` line on the screen and carried into the `--json` document beside
it, so the two renderings cannot disagree, and the fix under an empty task list is conditional on `runs.composed` and
therefore cannot go stale by the verb existing. A Gateway old enough not to report `runs` at all is answered as
"not reported — this Gateway predates the handoff", which is a measurement of the process answering and not a claim about
the repository. Pinned by one assertion in the spawned-gateway test, where an install with no workspace root and no
selected model has to print `runs not composed`.

Both were found by running the commands against a live Gateway rather than by reading them, which is the reason the demo
is part of the slice and not a courtesy after it: `crabby gateway start` on a fresh state dir, `auth pair` with the
bootstrap code, `auth pair --restrict task,session` answered with "5 granted, narrowed from the telegram baseline",
`--restrict shell` answered with §5.3's rule and both members listed, `task run` refusing with exit `1` before it created
anything, and `task ls` printing `none` to prove the refusal was before the write. The same run turned up one wart that
is recorded rather than fixed here, because it belongs to a different question: `crabby gateway start --data-dir <path>`
on a directory that does not exist dies with better-sqlite3's `TypeError` rather than with a shaped error naming
`crabby init`, and who creates the state dir is a decision §5's setup steps have not made explicitly. The scheduler
D-046 and D-057 ship with M2 and remain what §4's list names next.


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
