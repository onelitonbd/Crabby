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
records findings F-01…F-59 with what each one changed. M0 is the phase that closes what remains, because those items
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
`limits.*` did not reach the loop at this slice, because `limits.providerAbsoluteMs` and `LoopLimits.providerCallMs`
were taken as not one budget under two names and only `cancellationSettleMs` was read, for the drain budget; the
thirty-sixth slice found they are one budget — `LOOP_LIMITS` has always read that number from
`LIMITS_DEFAULTS.providerAbsoluteMs` — and wired the eight keys the loop enforces, so this sentence records what was
true then rather than what is true now. There is no `--wait-approval` on `task run`: it is in no registry, and exit
`3` beside the command that answers is the behaviour D-063 asked for. There is no `POST /api/v1/tasks/{id}/resume` and
`crabby task resume` stays `planned`, because §7.1's recovery must not become a way past an approval (F-47). The
scheduler D-046 and D-057 ship with M2 — `cron.schedule`, `GET /jobs`, `job pause` — and that is what §4's list names
next, beside the remaining initial tools: `shell.run` behind §9's opt-in, `net.fetch`, `session.*`, `task.*` and
`config.*`. F-57 still needs schema version 5 for a per-task model pin, per-task narrowing and a schedule. And
`task show`'s ordering flaw, named in the seventeenth slice, is still there at this slice: it is a wart about a
different verb, and fixing it inside a slice about the handoff is how a wart stops being visible. (It has since been
closed on its own, after the thirty-sixth: the id check moved ahead of `connect` beside `cancel`'s, `watch`'s and
`run`'s, so a missing id answers exit 2 on a machine whose Gateway is down instead of a connection failure — the
seventeenth slice was right to leave it named rather than fold it into a cancellation slice, and right that it
needed closing somewhere.)

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

**Twenty-seventh slice — four defects that only running the system could find, all in the verb the handoff shipped.**
The owner asked to check the system, so the check was run rather than read: a Gateway started from `config.json` with a
workspace root, a keyless provider entry and a selected default model — a runner composed for real, with the endpoint
pointed at a port nothing listens on, because there is no model server here and inventing one would have made the demo a
fiction. Four things fell out, and none of them is visible in a diff.

`crabby task run` exited `0` for a run that had ended `failed`, which is §7.1's contract inverted: the one thing an exit
code exists to prevent is a caller continuing as though work had finished. The cause was underneath it and worse —
`followTask` read the task's state from `payload.state`, but every transition frame reports `{from, to}`, so the command
held the state the task was *created* in and never updated it. `task.created` carries `state` and the terminal
`task.failed` does not, which is why the frame that said so was read and then not believed. Both are fixed: the state
comes from `to` and is checked against §4.1's list before it is acted on, because `approval.requested` carries a `state`
too and it is the *approval's*, and `task run` now answers with the run's outcome — `completed` exits `0`, `failed`,
`cancelled` and `interrupted` exit `1`, a stop at an approval still exits `3`. `task watch` deliberately does not inherit
the outcome: a read reports its subject's failure rather than becoming it, which is the rule `task show` has always
followed, and §7.1's rows now say which verb does which.

`--detach` had never worked. `parseTail` puts a registry entry written without an argument into a switch set, and the
verb read `values.detach`, which is never anything — so the flag the registry advertised and §7.1 calls "the script
path" was parsed, then ignored, and the command followed the run anyway. It is the CLI's first boolean tail flag, which
is why there was no neighbouring call to copy: every other switch in the registry belongs to a verb still `planned`, and
a convention with one member is a convention nobody has had to follow yet. Detached, the verb also rendered *two* JSON
documents — a compact record and an indented summary — which no script can parse either way, so it now renders one.

All four are pinned by a new integration block that spawns a Gateway which really drives tasks: the failed run exits
`1` and says whose outcome it reported, `--detach` exits `0` without a `watching` line and answers `--json` with one
document carrying `following: false` and the idempotency key it generated, and `task watch` plus `task show` on that same
failed task both exit `0` and both say `failed`. The lesson is recorded rather than only fixed: a refusal path had tests
and an outcome path had none, and the difference is that the outcome path needed a running Gateway to be reachable at
all. `crabby gateway start --data-dir <a directory that does not exist>` died with better-sqlite3's `TypeError`
instead of a shaped error naming `crabby init`, because who creates the state dir was a question §5's setup steps had
not made explicit. (It has since been closed on its own: the owner settled that `crabby init` is the one command that
creates the state dir, so `gateway start` now checks for it before opening the database and answers a shaped error
naming `crabby init` — exit `1` with the fix line, not a driver's message.) The scheduler D-046 and D-057 remain what
§4's list names
next.
**The scheduler (twenty-eighth slice).** §4's list ended with the scheduler and with two decisions that had already
priced it: D-046 put `cron.schedule` at **T2** with an empty capability list, and D-057 made scheduled work a first-class
surface in all four interfaces with `GET /jobs` and the pause verb shipping beside the subsystem rather than after it.
What landed is the subsystem minus the two things a route cannot do, and the minus is the interesting part.
`packages/agent-runtime/cron.ts` owns the grammar and the clock; `packages/agent-runtime/scheduler.ts` owns the decisions
and defines `JobStore` as the seam it reads through (`ARCHITECTURE.md` §19's direction, the same split `approvals.ts` set);
schema version 5 adds `job` and `job_run`; `packages/tools/cron.ts` is the executor half of §4.2's row and the only way a
job comes into existence in this build; §4.3's seven paths answer over HTTP; and `crabby job` gains the six verbs C12
describes, with `edit` left planned for the reason C12-05 gives. `/status`'s scheduler row and a `jobs` block in
`/diagnostics` report the subsystem from the composition, and `crabby status` prints both plus the fix line for a backlog
nobody has answered.

Seven things about a schedule were undecided, because §4.2 says "cron expression" and stops, and a timer is standing
authority: an expression that comes to mean something other than what the user approved is a grant nobody gave. **D-103**
records them — five fields at minute resolution with seconds refused rather than truncated, `@daily` and `L W #` and `a/n`
and a reversed range refused with the grammar in the sentence; the device's own wall clock, so `utc_offset_minutes` is
written at creation and every rendering of a next fire carries the stamp beside the instant, rendered by the Gateway
because the Gateway is the party that reads the clock; a local minute the zone skips is **skipped, never moved, and records
nothing**; Vixie's OR when both day fields are restricted, with a bare `*` unrestricted and `*/2` a restriction; a `7` in
the day-of-week column refused rather than read as Sunday; the forward search bounded at 1500 days, the bound arriving as
a `no_occurrence` refusal at creation; missed occurrences capped at 1000 with the cap reported beside the count; and the
tick interval internal, because §5.2's limits table prices no scheduler row and a knob no document priced is a knob that
changes behaviour no document describes.

§4.5's seven rules are kept by shape rather than by promise, and the shape is worth stating because it is the part a
later slice would otherwise rebuild. A fire goes through the *same* `recordAndDriveTask` a `POST /api/v1/tasks` reaches,
extracted in this slice so that one act has one implementation: that is what makes "every execution is a fresh policy
evaluation" true rather than intended, and what stops a timer from gaining an authority its creator never held. A run that
cannot get an approval stops and is recorded as `waiting_on_approval` from the state the loop already moved the task into
— the scheduler reads the fact instead of forming an opinion — and the run stays open, which is also what keeps the job
from firing another run beside a prompt nobody answered. The capabilities a run gets are the intersection of the job's
recorded set and what its creator's identity holds *now*, computed at every fire and again at every resume (D-054), and
the narrowing is written to the row so it outlives the run. A revoked creator is refused with the person's name in the
record and the job paused, because O-071 deletes the identity row and a job that cannot name a person cannot be audited.
A pause is not a cancellation and says so in as many words, naming `crabby task cancel <id>` for the run already in
flight. And a device killed overnight comes back to one `missed` row per job standing for a counted number of
occurrences, printed by the startup banner and by `crabby status`, answered by `crabby job backlog <id> --latest|--skip`
and recorded either way — with the rows keeping their outcome and gaining the moment the user answered, because D-065's
rule about not quietly editing the past applies to a timer's history too.

The questions a reviewer would ask, and the answers this slice committed to. **Why is there no `POST /api/v1/jobs`?**
Because a route cannot open an approval — only the loop does, and only from `policy.evaluate`'s verdict (D-084) — so a
creation route would either write a job nobody reviewed or refuse after accepting the request. That is C12-09's reasoning
for refusing `crabby job create`, and it is why F-57's `schedule` field on `POST /tasks` stays absent: amended in this
slice, its absence stopped being an unbuilt milestone and became a decision with a closing condition (give the route a way
to open the T2 approval the field implies, which is also what `job edit` waits on). **Why does `GET /api/v1/jobs` answer
on a Gateway that composed no runner?** Because the rows belong to the install rather than to the process, and a list that
501'd would hide them exactly when a provider broke — which is when a paused list matters most. Reads therefore answer from
the table with `driven: false` and the sentence that explains it; writes answer `501 platform-unsupported`, the class §6
gives "this Gateway cannot do that here", because a client that read it as transient would retry forever. **Why is the
scheduler composed inside `buildApp` while `cron.schedule`'s sink is bound after it returns?** A fired job needs the
runner, the journal and the arbiter that `buildApp` owns, and a scheduler built by the caller would have to be handed all
four — which is how two compositions end up disagreeing about which manager a stop goes through. The two parties need each
other, so one of them is a holder. **Why does `cron.schedule` appear in `GET /api/v1/tools` only when a runner exists?**
§5.1's "hidden is better than failing" applied to a subsystem rather than to a permission: a row advertising a timer
nothing would ever fire is a promise the process cannot keep, so F-55's count is 8 where a runner was composed and 7 where
it was not, and `combineToolSurfaces` makes a duplicate name fatal at composition instead of last-one-wins. **Why has
`job.client_id` no foreign key?** A cascade would delete standing authority the user can no longer see, and `SET NULL`
would leave a job that runs as nobody; what has to survive a revocation is the job, so that it can be refused with a name
in the record. `job_run.task_id` does cascade — to `SET NULL` — because §7 deletes a conversation's tasks and a run row
that vanished with its task would take the outcome of work that already happened with it. **Why has `JobPatch` no
`objective` and no `createdBy`?** So that no code path in the repository can perform a material change: the `SET` list has
no column to perform it with, and the test smuggles one past the type to prove the statement refuses it. **Why are there no
`job.*` events?** `Event.taskId` is required, so `POST /jobs/{id}/pause` has nothing to publish under; O-070 is amended
with the two closers (a taskless `sys_` envelope, or a session-scoped `job.*` broadcast) and a Scheduled pane polls until
one of them lands.

One defect the tests found and the slice fixed, recorded because the shape of the mistake is the reason it survived until
now: `parseTail` puts a boolean flag in `tail.booleans` *with its `--` prefix*, so `crabby job backlog <id> --latest`
looked for `latest`, found nothing, and told a user who had answered the question that they had not answered it. A Set
whose keys carry a prefix is not discoverable by reading the verb; it is discoverable by running it, which is what the
nine CLI tests in `tests/unit/cli.test.ts` now do for every usage path this noun has.

Deliberately not here: `crabby job edit` and the re-approval it implies (C12-05, D-084); any creation path outside
`cron.schedule` (C12-09); a per-job model pin, which needs a `modelId` column and schema version 6 (F-57); deferral for a
paused or locked vault, whose state word exists in the vocabulary and which no code in this build can produce because
there is no vault (F-56); a `limits.*` key for the tick; an `--each` answer to a backlog, which is the burst §4.5 forbids;
Telegram's `/jobs` (§7.4) and the TUI's sixth pane (P-010 gates Ink 8) and the Web `Scheduled` pane, all three being M3's
parallel surfaces over the routes that now exist; and a `job.*` event, for the reason O-070 now carries. Documents moved
beside the code: `docs/INTERFACES_AND_API.md` §4.1's two rows, §4.3's job row rewritten around the seven paths, §7.1's
inventory and a new behaviour row for all six verbs, and §8 regenerated to 25 rows; `docs/DATA_AND_MEMORY.md` §2's
`crabby.sqlite3` row at version 5 and a Job repository bullet in §5; `DECISIONS.md` with D-103, O-070 amended, §4A's map
and the counter at 103; `docs/CONSISTENCY_REVIEW.md` with F-55 and F-57 amended rather than closed; and `scripts/parity.ts`'
matrix row for "Review scheduled jobs", which is what makes §8 say the same thing as the routes. Gates: `typecheck`,
`lint`, `format:check`, `npm test` 561/561 (62 new: 9 cron, 21 scheduler, 8 storage, 5 tool-and-composition, 10 route, 9
CLI), `test:security` 138/138, `test:parity` and `docs:check` green.


**Conversations become records (twenty-ninth slice).** §4's tool bullet names `session.*` next after the scheduler, and
§4.2 prices exactly two rows for it — `session.list` at **T0** and `session.rename` at **T1**. What the slice found
before it built anything is that the two tools were the small half: `createTask` has minted `ses_…` ids since schema
version 1 and `task.session_id` is `NOT NULL`, so every install already held conversations that nothing owned — no title
for C11-01 to print, no origin for W15-11 to attribute, no last activity to sort by, and no token for §2's concurrency row
to compare. A tool that read that table would have been the mock this build refuses to ship, so the record came first:
schema version 6 adds `session`, `packages/storage/sessions.ts` is the conversation repository §5 proposed,
`packages/api-contracts/session.ts` holds the shapes four interfaces read, four of §4.2's nine session paths answer over
HTTP, `crabby session ls|new|rename` runs, and both tools join the composition a runner is given.

**D-104** records the six properties the documents had not decided, and three of them are worth repeating here because
they are the kind a later slice would otherwise rediscover by reading a column and guessing. The title is nullable and
its absence is a fact — W15-03's "the new session starts empty and un-named, and the title becomes the first question
asked in it" — so the first task in a conversation names it, clipped to eighty *code points* because a Bengali objective's
fortieth character is not at byte forty, and no later task renames it, because a name the user chose is not a
placeholder. The origin is nullable with no foreign key: the rows the migration backfills were minted by whatever created
their first task in a build that did not write the fact down, and `unknown` is the honest rendering while a guess would
read as an attribution. And there are **two clocks**, which is the decision the whole `If-Match` question turns on:
`last_activity_at` moves when a task is created or changes state, because that is what C11-01 sorts by, while `updated_at`
and `revision` move only on an edit — so a rename does not push a conversation to the top of a list somebody is working
from, and a task finishing does not spend the token a phone is holding.

The questions a reviewer would ask. **Why is the backfill part of the migration rather than a repair at startup?**
Because a database that has been upgraded and a database that has been repaired are two different facts about the same
file, and only the first is recorded in the ledger: a startup repair would run on every start, would be invisible in
`crabby doctor`'s schema line, and would leave a backup taken between the two looking like an install with tasks and no
conversations. **Why does the repository prepare no `DELETE` at all?** Destroying a conversation is
`history.deleteConversation` at **T3** (§4.2), which C11-05 keeps as the one command that does it and W15-07 prices with
the title typed back rather than "yes". A `DELETE /sessions/{id}` would be a second route to the same irreversible act
with no confirmation on it, so the absence is in the code where a test can see it, and the CLI test that asserts it reads
the help rather than a refusal: one destructive verb in the whole grammar, under `history`, and none under `session`.
**Why is `If-Match` required rather than honoured when present?** §2's concurrency row exists because a title is the one
field four interfaces can edit inline at the same moment (W1-02, W15-04, T16-05), and an optional token is a token the
client that most needs it forgets. So `crabby session rename` makes two requests — read the row, then write with the
revision it read — and a race answers `409` with both numbers in the sentence rather than silently overwriting. The
comparison is inside the `UPDATE`'s `WHERE` rather than a read followed by a write, because two saves in the same instant
must not both pass. **Why do the session routes answer on a Gateway that composed no runner?** A conversation is a record
and not a privilege, and a list that 501'd would hide a user's conversations exactly when their provider broke — the same
reasoning that keeps `GET /jobs` answering from the table. The integration tests assert the routes on a Gateway with no
runner on purpose, so that property is pinned rather than incidental. **Why is the state word derived and not stored?**
It is a claim about two tables at once, and `sessionRowOf` computes it in one place so a route and a tool cannot disagree
about whether a parked task makes a conversation `waiting-approval` — W16-02's rule, that work stalled on a human is the
state that must never be hidden, applied to a list of conversations. **Why are five of §4.2's nine session paths still
unbuilt, and why does the detail route say so?** `messages`, `compact`, `export`, `context` and `pin` read a message store
and D-027's context manager, and neither exists. So `GET /sessions/{id}` answers `absent: ["messages", "context", "pins"]`
instead of `0 turns` for a conversation that has forty, `crabby session show` stays planned with that reason in its
registry row, and §4.2's table now says which paths answer and what each of the others is waiting for.

One defect the slice caught before it shipped, recorded because the shape of it is the reason to write the decoder once:
the conversation repository needed a session's tasks, and the first version of that read carried its own row-to-record
mapping — which disagreed with `tasks.ts`'s about §6.2's error shape (`errorCode` and `errorMessage` as siblings rather
than one `error` object) and about the cancellation column entirely. Neither copy had run yet, so nothing failed; the fix
was to export the column list and the decoder from `tasks.ts` and delete the second one, which is F-20's shape at the
scale of a single function.

Deliberately not here: a message store, so no `messages`, `compact`, `context`, `pin` or `export` path and no
`session show` verb (D-027 and D-065 own those); any deletion of a conversation (T3, C11-05); a per-session capability
set or a session-scoped grant, since §6.1 has no capability for a conversation and F-52's assignment question is about
identities; `session.create` as a *tool*, because a model that could open conversations at will would fill the list C11
exists to keep readable; and a `session.*` event, for the reason O-070 carries — `Event.taskId` is required and a rename
is not a task. Documents moved beside the code: `docs/INTERFACES_AND_API.md` §2's concurrency row, §4.2 rewritten to say
which four paths answer and what the other five wait for, §7.1's Sessions inventory row and a new behaviour row for the
three verbs, and §8 regenerated; `docs/DATA_AND_MEMORY.md` §2.1's new "Decided (D-104)" paragraph, §4.1's
`crabby.sqlite3` row at version 6 and §5's conversation repository; `DECISIONS.md` with D-104, §4A's map on four rows and
the counter at 104; `docs/CONSISTENCY_REVIEW.md` with F-55 amended a second time for the two new rows; and
`scripts/parity.ts`' matrix row for "List/switch sessions", which is what makes §8 name the four paths and the four verbs.
Gates: `typecheck`, `lint`, `format:check`, `npm test` 592/592 (31 new: 10 storage, 7 route and tool-over-HTTP, 5
executor and composition, 9 CLI), `test:security` 138/138, `test:parity` (24 routes, 45 tools, 32 capabilities, 25
features) and `docs:check` (104 accepted decisions) green.




**Slice 30 — §4.2's three task rows, composed against the Gateway's own acts (D-105).** `task.create` (T1), `task.status`
(T0, whose §4.2 alias is `task.history`) and `task.cancel` (T1, and **T2** for `crossSession` or `all`) are declared and
executed by `packages/tools/task.ts`, the fourth surface in the runner's one executor. The executor owns argument
validation, the cross-session guard and the rendering, and nothing else: it holds no database, no runner and no route,
because the acts it needs already exist and belong to the Gateway. Two new fields on `BuiltApp` are the slice's seam —
`driveTask`, which *is* `recordAndDriveTask`, the one act `POST /api/v1/tasks` and the scheduler's `fire` reach, and
`cancellation`, which is the process's one manager the cancel route requests through — and they are handed *out* rather
than composed in, because `ARCHITECTURE.md` §19's dependency direction forbids `packages/gateway` from importing
`packages/tools` (which is why `deps.declares` exists). `apps/cli/commands/gateway.ts` binds the four sinks against holders
filled after `buildApp` returns, exactly as `cron.schedule`'s sink is bound. Decided rather than fallen into: `source:
"tool"` as a third value on `DriveTaskInput.source`, so §14's log line can tell a task a model created from one a user asked
for and from one a timer fired; the identity a call acts under arrives as the run's `RunOrigin` and never as an argument,
so a created task runs under the capabilities of the identity that is already running and a cancellation is attributed to a
person; policy prices the crossing before the call and the executor refuses an undeclared one at it, since a price no party
honours at the act is a sentence in a table; `all` reaches the nine states minus the three terminal ones minus
`interrupted`, because §7.1's recovery already ended that task and recorded why, and settling it to `cancelled` would
rewrite a crash as a choice; `task.status` carries the newest eight events by `seq` range and names the ones it did not,
with the eight as one constant both the description and the sink read; and a cancellation output never claims a stop it did
not see — `settled: false` renders `cancelling`, and §6.2's evidence is rendered from the record once the manager has
written it. What this slice did **not** build: `task.resume`, because F-47's absent route is not something a tool gets to
substitute for; a wake for a parked run, which is the gap this slice's own T2 test found and **F-58** now records — an
answered approval is recorded and nothing spends it, so `tests/integration/task-tools.test.ts` asserts the gap and then
drives `runner.resume` itself with a comment saying whose job that becomes; and `memory.*`, `net.fetch`, `config.*` and
`shell.run`, which are the rest of §4's tools line. Documents moved beside the code: `DECISIONS.md` with D-105, §4A's map on
five rows and the counter at 105; `docs/CONSISTENCY_REVIEW.md` with F-55 amended a third time for the three new rows, F-57
amended for the schema version a model pin now needs, and F-58 opened; `docs/INTERFACES_AND_API.md` §4.3's decision row,
which now says the run stays parked, and its `GET /tools` row, which says where the count comes from; this file's finding
range, which the checker keeps equal to the highest finding open; and `packages/tools/index.ts`'s header, which named `task.*` and `session.*` as stores this build has
no manager for and now says what each remaining absence waits on. Gates: `typecheck`, `lint`, `format:check`, `npm test`
612/612 (20 new: 13 on the executor and the composition it joins, 7 over HTTP against a Gateway composed the way
`crabby gateway start` composes one), `test:security` 138/138, `test:parity` (24 routes, 45 tools, 32 capabilities, 25
features) and `docs:check` (105 accepted decisions) green.

**Slice 31 — an answered prompt is spent: the decision route wakes the run that parked on it (F-58, closed).** The
thirtieth slice opened F-58 by trying to use the thing it found missing: a `task.cancel` with `all: true` is §4.2's T2
half, so the run parks, the test approved the prompt over HTTP, and nothing happened — the row moved to `approved`, the
`approval.answered` event was appended, the queue emptied, and the task stayed `awaiting_approval` forever, because
`Runner.resume` had no caller outside tests. D-084's rule that only the loop may open a prompt has as its corollary that
only the loop can spend one, and the loop is the one party a route cannot reach without being handed it. So
`registerApprovalRoutes` is handed the runner the process composed, and one new function does the waking. Four properties
were decided rather than fallen into: **both** decisions wake, because `loop.resume` spends a denial by making it the
step's result and a denied task parked on an answered question is the same defect with the opposite sign; the wake happens
**after the answer's transaction commits**, because a run resumed against a rolled-back row would execute a step nobody
approved, which is D-084 inverted; **after the event is published**, so a client watching the task sees the reason before
the state moves; and it **reports what it did**, as `resumed` plus the Gateway's own `note` on the decision response,
because the three cases where nothing was woken — no runner in this process, no run parked in it (F-47's restart case, with
`Runner.resume`'s `not-parked` sentence carried through verbatim rather than flattened into a `false`), and one already
moving — need different next actions. The seam is the route rather than the arbiter, and §9 is the reason: `decide` owns one
row and one event, and a `decide` that also started runs would give it a second responsibility and a dependency on the
runtime it exists to be asked by. `crabby approval approve` and `deny` print the pair. What is still absent, named rather
than implied: a run parked in a *previous* process is unreachable, because `SuspendedRun` holds the proposed call in memory
and SECURITY.md §8.2 keeps `call.args` out of the checkpoint — that is F-47's `POST /tasks/{id}/resume`, and this slice is
not a substitute for it. Documents moved beside the code: `AGENT_RUNTIME.md` §5.2 with a fifth property of the loop that
asks; `docs/CONSISTENCY_REVIEW.md` with F-58's severity line and its closing amendment; `docs/INTERFACES_AND_API.md` §4.3's
decision row, which lost the sentence the thirtieth slice added and gained the two fields, and §7.1's approval row; and
this paragraph. Gates: `typecheck`, `lint`, `format:check`, `npm test` 613/613 (one new test — a denial answered over HTTP
wakes the run, which then completes on the refusal with one `tool.execution.blocked` event and the refused task untouched —
and the thirtieth slice's `all: true` test losing its manual `runner.resume`, which is the fix measured by a test that got
shorter), `test:security` 138/138, `test:parity` (24 routes, 45 tools, 32 capabilities, 25 features) and `docs:check` (105
accepted decisions) green.

**Thirty-second slice — `net.fetch`: the allow-list gets a home, and the first tool whose subject is not this device.**
§4.2's network row was the last of §4's initial tools that had a policy and no executor, and the two halves of the gap
made each other worse: `escalation.ts` already priced a destination against `EvalContext.egressAllowList`, a field no
composition ever filled, while `grantsFor` withheld every `net.egress` grant "because nothing in `config.json` supplies a
host set" — so the row's **T2** half was unreachable too, and a `net.fetch` call from a real identity could only ever be
denied. Three things landed. `net.allowList` is a key in `config.json` (D-106), hosts rather than URLs, normalized once by
`egressHosts` because `escalation.ts` compares a lowercased hostname, and absent-and-empty meaning "nothing curated"
rather than "no egress" — turning egress off is §13's `crabby auth pair --restrict net.egress`, which removes the name
instead of pricing it. `grantsFor` mints `net.egress:allow-list`: one grant naming the *set*, whether or not it is empty,
because per-host grants would have denied exactly the hosts §4.3 prices at **T2**, and the parameterization §4.2's
`net.egress:<host>` cell asks for is performed by the tier rather than by the grant list. And `packages/tools/net.ts`
executes the row — GET only, since a method that mutates remote state is the next row's `http.request` and cannot share a
tier or an idempotency declaration with a GET; `http:` and `https:` only, since a `file:` URL is a read spelled as a URL
and would walk past §8's containment and deny-list; redirects manual and followed while the host stays the host the
arbiter priced, refused the moment a server substitutes another, bounded at five same-host hops so one pricing buys a
bounded number of requests inside §5.2's one clock; `credentials: "omit"`, which F-56 makes a fact rather than a
restriction; §10's nonce-bearing frame around the body with the runtime's note outside it; and, the rule that is new
rather than borrowed, **the download stops at D-064's cap** instead of the framing cutting afterwards, because a response
body's length is chosen by whoever answers and a promise about what the model sees has to be a promise about what lands on
a phone too. `sideEffects: "external"` is declared for the first time, so §6.2's cancellation evidence can say an effect
may have landed somewhere this install cannot inspect. The executor is never given the allow-list, which is D-099's split
applied to a destination: policy prices the crossing, the executor refuses the act it was not handed, and a second copy of
the list would be a second opinion about which hosts are cheap. What is deliberately not here: `http.request`; retries and
a cache (§5.2 priced one request); `memory.*`, which §6 gives to M4; and any rule about *classes* of destination — a
loopback, link-local or metadata host is priced like any other new host, and the gap is recorded as F-59 rather than closed
inside an executor, because a refusal the arbiter did not ask for is a second policy with no document behind it. Documents
moved beside the code: `PROVIDERS_AND_TOOLS.md` §4.2's row, §4.3's destination bullet, §5.2's clock row and the "what this
build declares" count, which was M2k's eight and is now fourteen rows carried as fifteen declarations; `SECURITY.md` §6.1's
`net.egress` row, which now names the key that supplies its host set; `docs/DATA_AND_MEMORY.md` §4.1's `config.json` row;
`DECISIONS.md` with D-106, §4A's map on three rows and the counter at 106; `docs/CONSISTENCY_REVIEW.md` with F-52 amended
for the host set that now exists and F-59 opened; and this paragraph. Gates: `typecheck`, `lint`, `format:check`,
`npm test` 634/634 (19 new on the executor, over scripted `Response` objects and a real scratch directory; one policy test
that runs the whole chain from `capabilitiesFor("cli")` through `grantsFor` to a **T1** and a **T2** decision, which is the
reachability claim this slice rests on; and one on `egressHosts`, the normalization that **T1** half is a string
comparison away from losing), `test:security` 139/139, `test:parity` (24 routes, 45 tools, 32
capabilities, 25 features) and `docs:check` (106 accepted decisions) green.

**Thirty-third slice — `/config` and §4.2's two configuration rows: one document, one token, and a T3 nobody on this
build can sign (D-107).** §4.4's three `/config` paths were the last unbuilt row a settings screen needs, and §2's
concurrency row had been saying out loud why configuration had no token: "there is no config route … a token with nothing
to present it to is a control nobody can use". Building the routes removed the excuse, so the token's shape is a decision
rather than a default, and D-107 records it. Three things landed. `GET /api/v1/config` answers two views of one file —
`file`, which is what `PUT` replaces, and `config`, which has D-074's defaults folded in, so a client can tell an override
from a default — with the token as the `ETag`, the resolved `limits`, the problems `loadConfig`'s rule 2 kept beside the
usable part, and the dotted paths whose values were withheld; `GET /api/v1/config/schema` serves the same JSON Schema
`crabby config schema --json` prints (D-060), so a client can validate before it writes instead of learning from a 400.
`PUT /api/v1/config` takes a whole document and requires `If-Match`: absent is a 400 naming the header, a token that
cannot be compared is a 400 with a problem on `if-match`, a stale one is a 409 naming both tokens, and the document is
checked against the schema *before* the token is compared, because a client told "stale" would re-read and submit the same
invalid bytes again. Its answer carries `changed` and no second flag, since "the document moved" and "a restart is what
applies it" are one fact seen from two sides — this Gateway composed its providers, workspace roots, limits and egress
allow-list at startup. And §4.2's two configuration rows are executed in `packages/tools/config.ts` — the read at **T0**,
which the row's own words call `config.write`-independent, and the write at **T3** behind that same name — composed as the
sixth surface in `apps/cli/commands/gateway.ts`, with `crabby config set` now presenting the token it read, so a terminal
is one of the two interfaces §2's row is about rather than a writer that races them.

The token is sixteen hex characters of SHA-256 over the canonical document (keys sorted at every depth, arrays in order),
computed from the file and never from the merged view, because D-074's defaults are code and a release that moved one
would otherwise invalidate every token a client holds without anybody editing anything. D-104 chose an integer for a
conversation and gave a reason that holds for a row, where the database already keeps one; a file keeps nothing, and a
counter inside `config.json` would be a field that is not configuration in a document `docs/DATA_AND_MEMORY.md` §4.1 says
holds "Overrides only". The write is a compare-and-swap and not a transaction — a file has no isolation level to be — so
the claim is that a silent overwrite becomes a refusal in every case a client can *observe*, and the refusal names both
tokens so a client can tell an old document from the wrong install. The token is never a declared field: `config.set`'s
schema is `key` and `value` and nothing else, and the sink reads the token and presents it, for D-099's reason that a
declared field is never an authority and a token a model could choose would be a write aimed at a document nobody read.

Two false positives turned up while the tests were being written rather than while the code was being read, and both read
as security claims, which is why they are here. `redact` masks by key *name*, and D-074's `limits.providerFirstTokenMs` —
a clock whose name contains the word `token` — came back as `[redacted]`, so a configuration read hid a timeout the
documents promise is visible through `crabby config get limits`; `configForReading` now puts a non-string leaf back as it
read it and leaves every string to the shared scrub, which is untouched because four other surfaces depend on it erring
towards masking. And `differingPaths` compared by identity while `redact` copies every array it walks, so a file holding
`net.allowList` reported that list as withheld on a document where nothing was withheld, and a `PUT /config` log line
named keys that did not move; it now compares content and still names an array whole rather than per index, because which
element moved is a question a value would answer and §7 keeps values out of log fields.

A third leak of the same family turned up by *running* the slice rather than by reading it, and it was not in the new
code: `composeProviders` refused a keyed provider with the reason `'groq' supplies its key by reference (gsk_…)`, quoting
whatever the field held. On a valid file that is a `vault://` name and harmless, but `loadConfig`'s rule 2 keeps an invalid
one running, so the sentence printed a raw key on the startup banner — a serializer, and `redact` would not have caught it
either, because its secret-shaped pattern wants a delimiter after the prefix and `gsk_…` has an underscore. The refusal now
splits: a reference is named, and a value is withheld with the rule it broke (§3.7), the place the owner may look at it
(`crabby config get provider.<id>.key`, a terminal that owns the file rather than one with a longer reach) and the finding
that keeps the vault out of this build (F-56). `isVaultReference` moved into `packages/core` beside the schema pattern it
reads, so the question "is this §3.7's name or a secret" has one answer in the tree, and `SECURITY.md` §7 now names the
configuration answer among the serializers it obliges.

What is deliberately not here: no deletion, because setting and unsetting are different acts on the document that decides
permissions and §4.2 prices the one it names; no second writer, since the route, the command and the tool share one
read-modify-write against one token; no interface that can sign the **T3** — M3's TUI and Web control UI are what make
`config.set` usable from inside a run, and until then the honest behaviour is a park and a refusal that says so
(D-085); and no vault, because F-56 stands: `provider.<id>.key` is a name and nothing resolves one.

Documents moved beside the code: `docs/INTERFACES_AND_API.md` §2's concurrency row, which had been stating the absence,
§4.4's `/config` row, and §8's matrix cell for Telegram — the last regenerated with `npm run test:parity -- --write`,
because `scripts/parity.ts` is the source that table is rendered from; `PROVIDERS_AND_TOOLS.md` §4.2's two rows and the
"what this build declares" count, which was fourteen rows carried as fifteen declarations and is now sixteen carried as
seventeen; `docs/DATA_AND_MEMORY.md` §4.1's `config.json` row, which now says the file holds no revision counter and never
will; `DECISIONS.md` with D-107, §4A's map on four rows and the counter at 107; `docs/CONSISTENCY_REVIEW.md` with F-52
amended for the second path on which the same act is gated and not gated; and this paragraph. Gates: `typecheck`, `lint`,
`format:check`, `npm test` 666/666 (32 new: 4 on the token and the compare-and-swap, 12 on the executor against sinks a
test can tell what to answer, 15 over HTTP and inside a real run — the **T3** park, the withheld provider key, the stale
409 naming both tokens, the `changed: false` write that moves nothing, and the audit line a write makes — and one on the
provider refusal that used to quote a key; the task-tools harness composes the config surface too now, so its
`runtime.implemented` pin moved from 14 to 16), `test:security` 140/140, `test:parity` (26 routes, 45 tools, 32
capabilities, 25 features) and `docs:check` (107 accepted decisions) green.

**Thirty-fourth slice — `shell.run` has an executor, and the install decides whether it is composed.** §4's
remaining-initial-tools sentence named `shell.run` behind §9's opt-in beside `net.fetch`, `session.*`, `task.*` and
`config.*`; all five now have executors, and the shell's arrived with the enable path the `packages/tools` header said
it had to arrive with ("an executor for it is a slice that has to arrive with that opt-in path"). Three things landed
on three branches. `packages/tools/shell.ts` declares both §4.2 shell rows with §4.1's runtime fields — argv-form
`inputSchema` (`argv` plus an optional `cwd`, never a string assembled from untrusted content), D-074's 120 s
`shellRunTimeoutMs`, `idempotent: false`, `sideEffects: "external"` — with cwd resolved through the link re-check, a
fixed child-env allow-list, abort killing the process group, and D-064's wrapped cap with the nonce delimiter. The
composition (`apps/cli/commands/gateway.ts`) builds it only when `shell.enabled` is true **and** roots exist, joins it
to the workspace-executor half so `GET /tools` merges both shell records even without a runner, and prints a `shell`
banner line naming which half is missing; `crabby init --enable-shell` records the opt-in on fresh installs only, and
existing configs are reported rather than overwritten. The policy surface needed no production change — the classifier,
the escalation and the baselines already refused, priced and withheld exactly what the documents say — so the third
branch is tests asserting it: classifier floors and redirect branches in `packages/policy`, grant-before-tier and T3
refusals over the security surface, and an off-vs-on integration block where a gated unknown command parks at T2, an
approval resumes it to a completed run, and a denial ends it with one `tool.execution.blocked` event. `GET /tools`
`runtime.implemented` moves 16 → 18 on a composed install (two rows, one declaration) and both shell rows pend all
five fields where no executor was composed.

What is deliberately not here, named rather than implied. No D-row: the decision this slice would record is drafted
but unapproved, so `DECISIONS.md` is untouched and the draft waits with the owner rather than entering the register
as accepted. No `SECURITY.md` §9 sentence on the family scope of "off by default" (F-34 stays open: the enforced
behavior is the family reading, the owning sentence states the single). No `process.spawn` / `process.list`
executors. No T1 reachable from the classifier's read-only set that the documents print as T0/T1 (recorded, not
renamed). No doctor row for the shell half. Gates per branch: shell executor 25/25, policy 53/53, security 12/12,
task-tools 11/11, `typecheck` (TS 5.9.2 — repo TS 7 ships no android-arm64 binary) and `parity`/`docs:check` green;
full `npm test` is load-flaky on this phone in spawned-gateway files and green in isolation, and the release proof
moves to CI per the owner's call.

**Thirty-fifth slice — `http.request`, the row `net.fetch` could not hold.** §4.2 splits the two network rows because
one cell cannot carry three answers at once: a read is idempotent, a resume may pass it, and a curated host lowers it
to **T1** — a mutating request may be none of those. The executor (`packages/tools/http.ts`) is therefore a second
file rather than a `method` argument on the first, and it serves `POST`, `PUT`, `PATCH` and `DELETE` verbatim: a read
verb is refused with a pointer at `net.fetch`, a lowercase spelling is refused because §6.3's approval quotes `args`
as the user read them, and an unrecognised verb is refused rather than forwarded, since a method the prompt did not
name is a different act. The destination half moved into `net-shared.ts` when the second executor needed it — the
http(s)-only scheme list, the same-host redirect rule, D-106's five hops and D-064's capped read, which `net.ts` had
inline — because a redirect rule with two copies is a rule with two answers, and both rows now refuse a hop that
changes the host through the same function. Credential headers are refused with §3 rule 06 named rather than stripped
(F-56: no vault, nothing to attach, and a header a model wrote is a credential it invented); a 303/301/302 turns the
follow-up into a GET and drops the body, and the report states which method actually ran; an aborted POST reports
that the request *was sent* and the outcome unknown, the one sentence a mutating row owes that a GET never had to
say; and a redirect chain refused at the bound is honest that the original and its follow-ups already left the
device. The clock is the network class's own: `toolDeadlineMs` prices `http.request` from `limits.netFetchTimeoutMs`,
and §5.2's row now names the class rather than only its first member — a second number for a second crossing of the
same boundary would be a second opinion about how long a phone waits on a stranger, and the class is still three.
`runtime.implemented` moves 18 → 19 on an opt-in install (one row, one declaration), and the count in
`docs/INTERFACES_AND_API.md` §2 moved with it (13 → 17 had already been owed since the network and configuration rows
landed without the sentence following them; it now enumerates what a composed Gateway actually answers). What is
deliberately not here: no credential of any kind (F-56), no retries — a retry is a second order inside a budget
priced for one — no streaming parse of an SSE response body, no `HEAD`/`OPTIONS` aliasing onto this row, and no T1
form of it: `escalation.ts` has no branch for `http.request`, which is how §4.3's de-escalation stays the GET row's.
Gates: `packages/tools/http.test.ts` 21/21, `loop.test.ts`'s class-clock assertion, the `GET /tools` merge test,
`typecheck` (TS 5.9.2 — repo TS 7 ships no android-arm64 binary), `parity`/`docs:check`; full `npm test` remains
load-flaky on this phone and the release proof is CI, which is green on linux and macOS for the shell slice.

**Thirty-sixth slice — `config.json`'s `limits.*` reach the loop, and the reason they had not was wrong.** The
recorded reason was that `limits.providerAbsoluteMs` and `LoopLimits.providerCallMs` were "not one budget under two
names" and that mapping half of the keys would put a number in a run no document promises. They are one budget:
`LOOP_LIMITS.providerCallMs` has always read `LIMITS_DEFAULTS.providerAbsoluteMs`, §5.2 prices the row once, and the
failure text has always told the user to `crabby config set limits.providerAbsoluteMs` — the two names are one fact
carried from the config's vocabulary into the loop's, and the translation belonged in one function rather than in
nobody. `loopLimitsOf(limits)` is that function: eight keys map, one per `LoopLimits` field, with the one rename
written down once instead of at each caller. An absent key is *omitted* rather than passed as `undefined`, because
the loop merges this over its defaults with a spread and a present `undefined` would erase the number it meant to
override. The keys that do not map are named rather than dropped in silence — the three provider timings and the
pool size are §3.1's wrapper's and the Gateway's to enforce, the SQLite busy timeout is the storage layer's, the
extension overhead is M4's host's, and the queued-tasks refusal is the task manager's — because a key handed to a
party that does not enforce it is a configuration that answers questions and changes nothing. Two fields have no key
at all and keep it that way: `refusalsBeforePause`, because D-086's floor is a policy and §5.2's `limits.*` list is
about timeouts and budgets, and `toolDeadlines`, because D-074 prices classes rather than individual tools — its
doc-comment had claimed the overrides were editable in `config.json` all along, and no schema row ever carried one,
so the comment now says what is true. The wiring is three lines of fact: `DriveFacts` gained `limits`, the
composition root translates once beside the composition, and `createRunner` already accepted a `Partial<LoopLimits>`
and merged it. Wiring then made one latent gap load-bearing. A hand-edited out-of-range value — `providerAttempts: 1`,
below D-043's floor of 5 — used to reach no consumer that enforced a floor; now it would reach the loop and configure
the ladder out of existence, which the schema's `minimum` exists to forbid. The loader closes it where config becomes
runtime numbers: `limitsInRange` keeps every override that passes the schema and drops every one that does not, one
key at a time, so a valid `fsTimeoutMs` survives a defect in a different number and the default stands for a value the
schema refuses. Only the derived `limits` are filtered — `file` still shows what the user wrote and `problems` still
names the defect, because a floor that rewrote the document silently would be one the user could not see. The gateway
test that had parked `providerAttempts: 1` to make a run fail fast found the value had been inert all along (the loop
never read it before this slice), and its comment now says the run walks D-064's ladder because the schema forbids a
shorter one. What is deliberately not here: no new config key — a key no document prices is a key no document
describes; no per-tool override path until one does; and the un-mapped `limits.*` keys are still not read by the
loop, because a number the loop does not enforce must not appear in its run. Gates: `loop.test.ts` 37/37 (the new
mapper test asserts the eight keys land, the two keyless fields stay out, and a spread over the defaults keeps
both), `tasks.test.ts` 6/6 (a composition that hands the runner `stepsPerTask: 1` fails a second proposed call with
`limits.steps_per_task`, the message naming "step limit of 1" — the number travelled from the body to the loop or
the assertion is false), `core.test.ts` (the new loader test asserts an out-of-range `providerAttempts` reaches no
consumer while the file and the problem keep it), the spawned-gateway `task run` exit-code test (a dead-port run
walks the ladder and the verb follows it to `failed`), `typecheck`, `parity`, `docs:check`; CI is the release proof
as before.

**Thirty-seventh slice — §3.6's per-task model pin, scoped to the one provider a runner holds (D-108, F-57).** §4.3's
`POST /tasks` row has documented a "model pin" since M1c and `CreateTaskBody` has refused it since that same day — F-57's
finding — but the two never disagreed by accident: the pin hid a fork the documents never settled, because `createLoop`
holds *one* provider and a pin naming a second would need the loop to hold several. The owner chose the scoped half first,
with the cross-provider half named as a follow-up rather than smuggled in. So `CreateTaskBody` and `TaskRecord` gain an
optional `model`, schema version 7 adds `task.model` (nullable like `session.model`, so "no pin" stays a different fact
from "no model"), and a pin is the `<provider>/<modelId>` pair `defaultModel` and `/model` already speak. The refusal is
the part that matters: `selectPinnedModel` compares the pin's provider half against the composed provider's `id` and
answers 400 `invalid_model_pin` — naming the composed provider, listing what it declares, citing §4.3 — **before**
`recordAndDriveTask` writes a row, because the runner does not write state and a refusal at start would leave a `queued`
row nothing settles. Resolution stays with the caller (D-101): the route validates, `recordAndDriveTask` stores the pin
and extracts the model half, and `StartInput.modelId` carries it into `loop.start` over `RunnerDeps.modelId`. What is not
here: cross-provider pinning (option B, deferred under D-108 — it has since landed as the thirty-eighth slice, D-110),
per-task capability narrowing (still no carrier in the
body, F-57), and `schedule` (D-084's approval a route cannot open). §4.3's row now states the pin as accepted and the
other two as not-built, so the document and the contract describe the same body — which closes F-57. Gates:
`compose.test.ts` (the crossing refusal, the first-slash split, the malformed and unknown-model refusals),
`storage.test.ts` (the version-7 ledger and the round trip, plus the two upgrade fixtures that now drop `model` the way
they already dropped `cancellation_json`), `tasks.test.ts` 8/8 (a crossing pin refused with no row written, a scoped pin
stored and driven to `completed`), `typecheck`, `docs:check`; CI is the release proof as before.

**Thirty-eighth slice — the pin resolves against every composed provider (D-110, F-57's option B).** The owner chose to
start the half D-108 deferred, and D-110 records the mechanism as D-101's rule extended from the model to the pair —
the caller resolves, the loop does not choose. `selectPinnedModel` now takes the pool — every usable `deps.providers`
entry, with the runner's own provider unioned in so a composition root that hands the two on separately cannot refuse its
own default — and answers `ModelSelection`, the same shape `selectDefaultModel` gives, so `POST /tasks` passes
`selection.provider` into the run exactly where a selected default would ride. The resolution travels as data, one hop
per layer: `DriveTaskInput.pin` into `StartInput.provider` beside `modelId`, and into `RunInput.provider` beside the
model, so a `SuspendedRun`'s in-process resume keeps calling the provider that started it — the pair rides inside the
input the resume already replays. The loop's one provider call runs `state.input.provider ?? deps.provider`: it holds
the composed default and runs what it is handed, never comparing two providers. A pin naming any composed provider is
served and its run calls that provider; a pin nothing answers is refused 400 `invalid_model_pin` before a row exists,
with the composed ids in the sentence and §4.3 cited; a provider that refused composition is absent from the pool and
says why at startup and in `GET /api/v1/status` rather than being quoted a second time here. D-108's sketch said "the
loop holding every composed provider"; what shipped keeps the loop's deps untouched and puts the pool where D-101
already puts resolution — the caller's gate — and D-110 records that reading. What is not here: per-task capability
narrowing (unchanged, F-57) and `schedule` (D-084's approval a route cannot open). Gates: `compose.test.ts` 15/15 (a
pin naming a second composed provider resolves to that provider's own instance, a provider the pool does not hold is
refused listing what it does, the first-slash split and the malformed and unknown-model refusals unchanged),
`tasks.test.ts` 9/9 (an unanswered pin refused with no row written, a pin on the runner's own provider stored and driven
to `completed`, a pin naming a second composed provider driving the run on *that* provider's script — proven by its
text in the events, the default's empty script saying nothing), `loop.test.ts`, `runner.test.ts`, `gateway.test.ts`
green, `typecheck`, `parity`, `docs:check`; CI is the release proof as before.

**Thirty-ninth slice — the ladder asks instead of failing (D-044 stage 2, F-49's rung, F-50's ordering).** The owner's
call was to finish M2's remaining items one at a time, and this was the smallest of the three with every document already
settled. A retryable class that spends `limits.providerAttempts` now stops the run in `awaiting_approval` with **no
approval row** — D-086's shape, reused rather than reinvented, because §4.1's nine states are decided and a spent budget
is not a prompt — and appends `provider.switch.proposed`: the attempts, the budget, the class, the pair the run was on,
and each candidate labelled with its provider, its cost class and the capabilities choosing it would lose. The same facts
ride on the transition frame's payload, which is what lets the CLI's blocking verb say *which* pause it stopped at without
depending on event order; it exits §7.1's `3` and names the route that answers, because `crabby task resume` (C6-10) is
M3's grammar and a printed command that cannot run is worse than a printed route that can. The labels are computed in
`composeAskCandidates`, the only place that holds the pool, and handed to the loop as data through a seam
(`LoopDeps.askCandidates`) so D-101 survives intact: the loop names candidates in a prompt and cannot call one. The answer
is `POST /api/v1/tasks/{id}/resume` with an optional pin, resolved against **the same pool** the ask was built from
before anything moves; the runner holds the run in its own `asking` map (a third kind of "waiting", because an approval
park must not be resumable by naming a model and vice versa), and `answerModel` records §3.6 stage 3's facts on the task —
`model` and a new `modelSwitch` column, schema version 8 — moves to `running` with the new evidence field
`modelAnswered`, appends `provider.switch.accepted`, and continues from the boundary the run had reached. The refusal set
is the part worth keeping: a pin the ask never offered is refused (the prompt is the question), a pin with no resolved
provider is refused (the loop holds no pool, and a run asked to switch to a model nobody loaded would call the old one
under the new name), a terminal task is refused (§4.1), and a pending approval is refused by the route before the runner
is even asked, naming `POST /approvals/{id}/decision` instead — the row is how a client tells a prompt from an ask.
**What this slice does not do**: resume across a restart (F-47's rebuild, still missing, and now also the question of
where a rebuilt run's identity comes from, since `TaskRecord` carries no origin); name a candidate's **host**, which
§3.6's sentence asks for and the `Provider` interface cannot supply; and decide where an *unanswered* ask goes — F-50's
last clause has no priced destination, so it waits like D-086's pause and the question is registered as O-073 rather than
settled in a comment. Gates: `loop.test.ts` 41/41 (the budget spent then the ask, `auth` failing without one, the switch
recorded with the read's result carried forward and no step re-run, the same-model answer recording nothing, three
refusals), `runner.test.ts` 15/15 (the ask's own map, the answer waking it, `not-asking`, the shutdown report), `compose.
test.ts` 17/17 (labels computed against the current model, same provider first, a provider that cannot describe itself
not offered), `contracts.test.ts`, `agent-runtime.test.ts` (the `modelAnswered` edge), `tasks.test.ts` 12/12 (the whole
act over HTTP, including that a refused pin moves nothing), `gateway.test.ts` (a spawned Gateway that now fails fast on
an `auth` class instead of walking a ladder, plus a real ladder walk that stops at the ask and is answered over HTTP),
`typecheck`, `parity`, `docs:check`; CI is the release proof as before.

**Fortieth slice — a task a restart interrupted can be continued (F-47, D-111).** The owner asked for M2's remaining items
one at a time and this was the next; it is the finding that had been open "by choice" since M2g because §7.2's rule reads
like it forbids the act entirely. It does not. It forbids *automation* from authorizing — and the authorization arrives
here as an answer a person gives, which is the same shape as an approval decision. `POST /tasks/{id}/resume` now answers two
positions: a park this process holds (the thirty-ninth slice) and a task a restart left `interrupted`, which is rebuilt
from D-095's boundary rather than continued. The rebuild is `loop.restart(input, saved)` — the loop owns the round machinery
and the state move, the runner reads the record and owns the one-run-per-task rule, and the route owns the two questions that
are its own: *whose* run and *under which authority*. The first needed D-111: the task table now names the identity that
created the task (schema version 9, a nullable `origin_json`, no foreign key because O-071's revocation deletes an identity
and a task must outlive the name), and the route **looks that identity up** rather than trusting a stored copy of its
capabilities — the rule D-054 already follows for a job's fire, which is why a revoked creator is refused with 409 instead
of inheriting authority, and why the answerer's own identity is recorded beside the continuation as §14's audit rather than
becoming the author of someone else's task. The second is D-065's verdict, read **in the runner** so no route can rebuild
work the runtime would not have permitted: `resume` and `pass` continue, `re-ask` is refused with the verdict's own
sentence, and a task with no boundary is a 404 because there is nothing to continue from. The move is `interrupted` →
`planning` (the edge into `running` needs `resumeApprovalValid`, and claiming it would be §7.2's forbidden claim) and its
event is `task.resumed`, which the vocabulary has had since M2c. Three tests carry the weight, all over two real processes
on one data dir: a committed step continues and is **not run twice**; the F-47 scenario itself — a prompt a dead process
opened — now ends in a *fresh* prompt that can be answered, because SECURITY.md §7 keeps `call.args` out of the checkpoint
on purpose, so a continuation re-plans and asks again rather than spending a row it cannot read; and a revoked creator is
refused with the task untouched. Gates: `loop.test.ts` 43/43, `runner.test.ts` 16/16, `tasks.test.ts` 15/15 (including the
three above), `journal.test.ts`, `contracts.test.ts`, `storage` 68/68, `agent-runtime.test.ts`, `typecheck`, `parity`,
`docs:check`; CI is the release proof as before.
**Forty-first slice — a conversation's turns become records (D-112, closing O-074).** The owner chose O-074's option (a) — a
`message` table before compaction — and the slice is the table, the one writer, and the read. The table (schema version 10)
is §2.5's four bullets as columns: `role`, `ordinal`, `created_at`, and the two associations (a conversation always, a task
where there was one — nullable, because a `/ask` turn has no task and a NOT NULL column would have made the honest row
illegal). Both cascades are the deletion half: deleting a conversation deletes its history (C11-05's one T3 command), and
deleting one task takes that task's turns with it while the conversation and its other turns survive. Ordering is the
conversation's own counter rather than the id, because `ids.ts` says in words that its sortability is a convenience and two
turns written in one millisecond are ordered by nothing. The writer is a seam (`MessageWriter`, beside `Checkpoints`) and the
**loop is the only one**: it writes the turn inside the phase that completes the task and emits `message.added` in the same
transaction, carrying the row's `messageId` and `ordinal` so the record and the log are checkable against each other. Two
consequences worth arguing about, and both are in D-112: a loop with **no** writer emits no `message.added` at all, because
§5.2's "anything a client must act on is also retrievable" is a rule about the announcement — a transcript built from the
stream would otherwise show a turn nobody can fetch — and the frame still carries the text, because a live transcript (C4-05)
is a shipped surface and a truncated preview is a worse answer than the bytes it already had. What is deliberately *not*
duplicated is anything later derives: a summary is a row, never an event, and never a replacement (§2.5's fourth bullet, and
the reason the event is worth keeping beside the row). The read is `GET /sessions/{id}/messages?cursor=&limit=` — ordinal
cursors so a turn appended mid-read cannot shift a held page, the route's own bound, a `404` for a conversation nobody made
and an *empty page* for a quiet one — and `messages` has left `GET /sessions/{id}`'s `absent` list, which is the line C11-03's
sidebar was being protected from. Still not built, and named rather than omitted: `POST /sessions/{id}/messages` (a route that
wrote a turn would be a second writer, §9's rule), `session compact`, `context` and `pins` — D-027's compaction is the next
slice, and the records it will summarize now exist. Gates: storage `sessions.test.ts` 13/13 (four bullets as four assertions,
redaction on write, both cascades), `loop.test.ts` 44/44 (row and frame in one phase, and silence without a writer),
`tasks.test.ts` 17/17 (the route over a real run, the frame/row agreement, the ordinal page, the two refusals), integration
`sessions.test.ts` 7/7 (`absent` is two names now), `typecheck`, `parity` (28 routes), `docs:check`; CI is the release proof
as before.
**Forty-second slice — the context manager's arithmetic (D-027's four unpriced numbers, D-113, D-115).** The owner was
asked in conversation what D-027's "hybrid compaction" leaves open and answered four questions in one pass: compact
at **0.8 of the budget**, keep the most recent **6 turns** verbatim, let the user **configure the summarizer model**,
and **retry once then surface** when a summary cannot be written. The slice is the arithmetic and nothing else —
`packages/agent-runtime/context.ts`, pure, because a threshold is a decision about tokens and a decision that needs a
provider call or a row to be made is a decision that cannot be tested on its own. Three properties carry the answers. **The budget is derived and the threshold is a fraction**: §3.4's budget is `contextWindow` minus `maxOutputTokens`, so one `compactAt` of 0.8 is right for an 8 k window and a 200 k one alike, and the schema caps it below `1` because a threshold of 1 compacts *after* the ceiling — worse than having no setting. **An estimate says it is an estimate**: D-064's `max(chars / 4, clusters × 1.35)` is implemented as written, cluster count from `Intl.Segmenter`, and every
count carries `measured` or `estimated` so §3.4's "never shown as a count" is a type rather than a habit. Implemented
literally, that formula never selects its first term and prices Latin text about five times a Western tokenizer's
cost; it errs toward compacting early rather than toward an overflow mid-run, so it stands as accepted and the
coefficient is registered as **O-075** rather than repaired in passing. **A plan that cannot help refuses, in two named
ways**: `nothing-to-summarize`, and `verbatim-exceeds-budget` — the last six turns alone past the threshold is a fact
about a conversation, and dropping the user's recent turns to make a number look better is the opposite of what D-027
asks for. The summary's size is arithmetic too: a plan carries `summaryTokenAllowance`, the headroom between the
threshold and the verbatim tail, so the summarizer is given a number instead of "be brief". Configuration is
`limits.context.compactAt` / `verbatimTurns` / `summaryModel`, all three printable by `crabby config get limits`; the third has no default on purpose, and "absent" means the run's own model writes the summary. Still not built, and named rather than omitted: the summarizer call, the summary row and the covered range beside it, the automatic trigger inside the loop, `POST /sessions/{id}/compact`, and §8.1's pins — the next slices, in that order. Gates: `context.test.ts` 24/24 (D-064's Bengali case, the labelling rule, a counter that answers with nonsense, a budget that scales with the window, both refusals, the allowance), `core.test.ts` 26/26 (the dotted keys a user types, and `compactAt: 1` refused by the writer), `typecheck`, `lint`, `parity`, `docs:check`; CI is the release proof as before.
**Forty-third slice — a summary that names what it stands in for (D-116).** D-027 says compaction must never destroy original conversation records and §2.5's fourth bullet says the same about summaries, which leaves one question nobody had answered: how does a reader know which turns a summary replaced, if it replaced none? The record answers it. `message` gained `covers_from` / `covers_through` (schema version 11), so a compaction writes one `system` turn naming the range it stands in for and the turns inside that range stay where they were — readable, countable as turns, and deleted only when their conversation is. The range lives on the summary row rather than in a `compaction` table because a summary that carries its own range cannot disagree with itself, and a second table would be a second cascade and a second read. The migration rebuilds the table (SQLite cannot add a `CHECK` to one) and copies every row, and the `CHECK`s refuse the three rows that cannot be meant: half a range, a range that ends before it starts, and coverage claimed by a role other than `system`. The act is `compactConversation` beside D-115's arithmetic — one code path, so D-113's "the route is the same act asked by hand" is true rather than aspirational — and the summarizer is handed no tools, because a derived record that could call `file.write` while being written would be a second path to an effect D-101 does not allow. Failure is D-115's fourth answer made real: two attempts on D-064's schedule, then `failed` and a message the user sees, because the alternative the owner rejected — dropping the oldest turns quietly — is the one thing a context manager must never do quietly. Two refusals the owner did not have to price, found by building: a summarizer too small for the turns it was configured for is refused before the call, and an empty summary is a failure rather than a row covering four turns with nothing. One event, `message.compacted`, and deliberately not also `message.added`: one write, one announcement. Still not built, and named rather than omitted: the loop's automatic trigger, `POST /sessions/{id}/compact`, `GET /sessions/{id}/context`, and pins; and still not decided: whether a summary is ever deletable on its own, which D-113 already named. Gates: `compact.test.ts` 13/13 (the range, no tools, the allowance, both refusals, retry-once-then-surface, the empty summary), `sessions.test.ts` 16/16 (coverage round trip, the three refused rows, every turn surviving the rebuild), `context.test.ts` 24/24, `typecheck`, `lint`, `parity`, `docs:check`; CI is the release proof as before.
**Forty-fourth slice — every turn is a record, and the request is compacted before it is built (D-117).** D-116 left an uncomfortable gap: a summary could name the range it replaces, and in a run those turns were never records. D-112 wrote the completion only, right while a summary had nothing to point at. So the writer moves: the assistant's proposal, the tool's result, a refusal, a denial and a block are each written **as they happen**, inside the phase that already commits the fact they describe, so a rollback cannot keep a step's boundary and lose its turn. §2.5's second bullet stops being half-answered, and a cancelled task keeps the transcript of how far it got — the case a user most wants afterwards. The ordinal rides on the message **object** (a `WeakMap`), not on an index into `RunState.messages`: that array is rebuilt every tool round, and one forgotten index is a summary covering the wrong turns. The trigger moves with it: D-113's budget is checked at the top of every provider call, so a conversation that outgrows its window is summarized while it still can be, and §3.4's "retries once after compaction, then surfaces" is the backstop for an estimate that was wrong — spent once per call, because a compaction that did not shrink the request will not shrink the next one either. **A loop with no compactor changes nothing**: it keeps growing and reports `context-overflow`, because trimming a conversation to stay under a limit is §2.5's "silently replace or destroy" wearing a feature's name. The Gateway resolves the summarizer (D-115's key, else the run's own model) and reads descriptors per compaction, for `composeAskCandidates`'s reason. The writer is now one function beside the routes — `conversationWriter(db)` — because turns and summaries come from two callers and §9's one-writer rule is about the seam, not about how many times it was typed. Still not built: `POST /sessions/{id}/compact`, `GET /sessions/{id}/context`, and pins. Gates: `loop.test.ts` 48/48 (three turns in order, compaction before the request, a failed compaction surfacing as `provider.context-overflow`, exactly one overflow retry), `compact.test.ts` 17/17 (the manager's four answers, including `summarizer-unavailable` and a descriptor-less run), `journal.test.ts` 9/9 (one frame per turn, in order), `tasks.test.ts` 17/17 (three turns over HTTP and every frame naming its row), `typecheck`, `lint`, `parity`, `docs:check`; CI is the release proof as before.
**Forty-fifth slice — compaction by hand, over the same function the loop calls (D-118).** The owner answered two questions the documents had left open, in one pass: **`session.write` with no extra prompt**, and **a direct session mutation rather than a task**. `session.write` is already in §6.1's table and already means "modify conversation and session state", so the act needs no new capability; the route is gated by the token exactly as `PATCH /sessions/{id}` is, because F-52 records that no route enforces a capability by name yet and a check invented for one route would be a second mechanism rather than a first. No prompt is the owner's call, with its price named in the documents: compaction spends a model call and sends conversation text to the configured model, so an interface that wants a confirmation asks before it calls the route. A task was rejected for a reason worth writing down: a compaction has no steps to watch, nothing to cancel and no result to read, and a task row would spend a T2 `task.create` on a record of an act that takes seconds. What the route does is the part that matters — it calls `createContextManager`, the **same function** the loop calls before every provider request (D-117), which is what makes D-113's "the same act asked by hand" a fact rather than a hope. Two mechanisms keep it cheap on a phone: the **cheap read decides first** (`messageCharCount` answers a length without loading a turn, and `estimateFromChars` bounds §3.4's heuristic from above, so "under the threshold" is answered without reading anything), and the expensive read pages at 200. The three answers are one answer — `not-needed`, `compacted`, `refused` — a union of words rather than three status codes, because a client handed a 200/204/409 triple has three ways to be wrong about one fact; a refusal about the *conversation* is a 200 with one of three named reasons, and the two refusals that are about *this process* (`summarizer-unavailable`, and a summarizer that failed after D-115's retry) are 503s, the second retryable. Every refusal sentence lives in the contracts, so four interfaces render one wording. The CLI verb is `crabby session compact <id>`, printing the contracts' own sentence. Still not built, and named: `GET /sessions/{id}/context` and §8.1's pins. Gates: `sessions.test.ts` 10/10 (`not-needed` without reading a turn, a real compaction whose covered turns stay readable, 404), `compact.test.ts` 17/17, `loop.test.ts` 48/48, `typecheck`, `lint`, `parity`, `docs:check`; CI is the release proof as before.
**Forty-sixth slice — a pin protects a turn's own text, and the context view that shows it (D-119).** The last piece of D-027's hybrid compaction, and the half no threshold can be: §8.1's "users SHOULD be able to protect important information". The owner answered the two open questions directly — **a turn or a range of turns**, named by the **ordinals the transcript prints** (a protection a person cannot check against the transcript is one nobody will trust) — and **a pinned turn is sent as it is and never summarized, not even in part**. That is a real cost and the row says so: the summarizer is not even *sent* a pinned turn, so a conversation whose pins crowd its budget is **refused** with `verbatim-exceeds-budget` rather than quietly trimmed, and the run then fails the way §3.4 says one should. The flag lives on the turn (`message.pinned`, schema version 12) rather than in a `pin` table, for D-116's reason applied to a second flag: a pin that could outlive its turn would be a claim about a turn that is gone. Both callers read pins from **one** place — `createContextManager` takes a `resolvePins` resolver, so an *in-run* compaction honours a pin the user set minutes ago without the loop ever learning what a pin is. `POST /sessions/{id}/pin` takes a range and `from === through` is one turn; re-pinning answers `0 changed` and is not a failure, because that is how a client retries safely. **Unpinning exists, by turn id**: removing a range would have to guess whether it means "everything in it" or "what I added", and a wrong guess silently protects or drops turns the user did not name; a turn that is not pinned is 409 and an unknown turn is 404. `GET /sessions/{id}/context` answers §8.1's read half — cost against the window, every compaction with its range, the pinned ranges collapsed so a screen can print them — and names in `absent` the half it does not answer ("review or correct retained memories and summaries") rather than returning empty arrays. The CLI grows `session context`, `session pin <id> <turn|first..last>` and `session unpin`, and the registry's `compact` row leaves `planned`. With this, **M2 is complete**: hybrid compaction, automatic and by hand, with pins. Gates: `context.test.ts` 26/26 (a pinned turn is neither summarized nor dropped; pins that crowd the budget refuse), `sessions.test.ts` 13/13 (a pin makes the compaction refuse by name and writes no row, unpin, 409, 400 naming the range that exists, the context view), `storage` 71/71 (both rebuilds copy every row), `loop.test.ts` 48/48, `compact.test.ts` 17/17, `typecheck`, `lint`, `parity` (32 routes), `docs:check`; CI is the release proof as before.
**Forty-seventh slice — the context noun the element rows name, and a cost per section (D-120).** M3's first slice, and it begins by reading `docs/review/CLI.md` rather than the architecture, which is how two corrections came out. C10's rows say `crabby context show` and `crabby context pin`; the forty-sixth slice built `session context`, `session pin` and `session unpin` — three working verbs in the wrong place, which is how a noun ends up with two ways to say one thing and a reviewer with two things to reconcile. The verb moved to the noun the row names, and the session-level ones were **removed rather than aliased**: §9's one-path rule is about behaviour, and an alias is a second path nobody asked for. The second correction is the row's empties clause — "a section costing 0 prints `0` rather than being hidden" — which the route as built could not satisfy at all, because it answered with one aggregate and no per-section costs. `GET /sessions/{id}/context` now answers `sections` with three: what a compaction replaced, what the user pinned, and what would actually be sent, each with its **characters** beside its estimated tokens. The characters are not decoration — C10-05 asks for "byte counts and budget headroom in machine form, so a cron wrapper can stop filling a session it cannot see", and a heuristic's token count is not a byte count. The three are a **partition**, so they add up to the whole and a client renders "3,200 of 5,734" without knowing the formula; a summary row counts as *current*, being the newest thing in a conversation rather than a thing a compaction replaced. The costs come from one pass over three integers per turn, because three aggregates would each re-read the same rows to answer a question about a partition of them. `context pin` is three jobs in one verb (no ref lists, a ref pins, `--remove` clears) because C10-02 says so, and a ref is an **ordinal or `first..last`** because that is what `session messages` prints; `session compact` now prints where the originals live in every outcome, which is C10-03's clause. Recorded as **F-59**: an element inventory is a specification, and building a feature from the architecture instead of from the inventory produces working code in the wrong place. `session show` (C11-03) stays planned, and its milestone now names the reason: its five fields exist across three routes, and assembling them for one screen is a decision M3's four interfaces should earn. Also in this slice, a test-infrastructure fix with a diagnosis rather than a guess: two approval-queue tests failed on CI at the same 20.3 s, both green in isolation. They sat inside the guard that kills a spawned CLI child, and CI runs every suite file in parallel on a two-core runner — so the guard was sized for an unloaded machine, and a guard against a hang that fires on a loaded runner hides the one thing it exists to catch. Ninety seconds, and the comment says why the number is what it is. Gates: `sessions.test.ts` 13/13 (the sections are a partition of the conversation), `context.test.ts` 26/26, `typecheck`, `lint`, `parity` (32 routes), `docs:check`; CI is the release proof as before.
**Forty-eighth slice — `crabby task resume`, and two sentences that had become lies by age (D-121).** M3's second slice, and C6-10's row is one clause with an order in it that a straightforward implementation gets wrong: "resumes from the checkpoint and **prints what will be skipped vs repeated, so nothing re-runs silently**". So the checkpoint is read **before** the answer — after a resume the boundary has moved and D-065's verdict has been spent, and a resume that printed it afterwards would be printing a fact the user cannot act on. The three verdicts print as three different promises: `resume` (committed steps kept, none repeated), `re-ask` (nothing repeats, but a step whose effect cannot be established means the run asks again — and §7 is why its arguments are not in the checkpoint), and D-114's re-ask resolution. A missing checkpoint is **not** a failure of the command: §4.1 answers 404 for a task that never committed a step, and the line says so, the same reading `task show` gives it. `task resume <id> [provider/model]` also answers D-044's model ask, with no model meaning the same one again. The second half of the slice is a **correction**: the reattach line after `task run` named `task watch` *because* "the verb is M3's grammar and a printed command that cannot run is worse than one that can", and the exit-3 fix line for a ladder ask printed the HTTP route for the same reason. Both were true when written and are false now — the failure mode a dated comment would not catch and a built verb does. They name the verb, and the reattach line says why it still names `watch`: a resume continues a pause, a reattach follows work already in motion, and D-111's rebuild makes those different acts. The runtime did not change; this slice is the grammar the element rows were written around. Gates: `tasks.test.ts` 17/17, `typecheck`, `lint`, `parity`, `docs:check`; CI is the release proof as before.

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
