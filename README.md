# Crabby

**Mobile-first · Cross-platform · Open-source AI harness**

Crabby is a terminal-first AI agent platform: one shared core runtime, one central Gateway, and four
equal-capability interfaces — **CLI · TUI · Web UI · Telegram** — that Android users can run in Termux and
that work the same way on Linux and macOS.

It is not a mobile app and not a chatbot wrapper. It is a harness: model providers, multi-step agents,
tools, memory, skills, plugins, and permission-controlled execution — all behind a single local-first Gateway.

> **Current phase: M2.** The planning set is what governs, and it is still the specification code must follow rather
> than a description of it: M1a shipped the contracts, platform, core and CLI skeleton, M1b shipped the Gateway and the
> state directory, and M1c shipped the policy engine, the provider contract, the parity generator and CI — so
> `crabby gateway start` answers HTTP, `crabby tools ls` answers policy, and `npm run test:parity` is what stops the
> documents drifting from either. `DECISIONS.md` records what is still deliberately undecided — including two shapes
> those builds found the documents had not defined (O-070, O-071), and two questions M1c chose not to answer with an
> inference (F-33, F-34).

## Planning documents

| Document | What it decides |
| --- | --- |
| [`PROJECT_BRIEF.md`](PROJECT_BRIEF.md) | Purpose, scope, target platforms, four interfaces, principles, release scope. |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Layers, Gateway responsibilities, API/streaming, task/event/cancellation boundaries, repository shape. |
| [`AGENT_RUNTIME.md`](AGENT_RUNTIME.md) | Plan → Execute, concurrency, approvals, cancellation, auto-recovery, compaction, error handling. |
| [`SECURITY.md`](SECURITY.md) | Trust boundaries, threat model, capabilities, risk tiers, secrets, injection, remote exposure. |
| [`DECISIONS.md`](DECISIONS.md) | Accepted vs proposed vs open decisions, validation records, decision process. |
| [`docs/DATA_AND_MEMORY.md`](docs/DATA_AND_MEMORY.md) | Persistence requirements, history, checkpoints, memory, search, deletion, backup. |
| [`PROVIDERS_AND_TOOLS.md`](PROVIDERS_AND_TOOLS.md) | Provider adapters, capability flags, tool contract, initial tool set with risk tiers. |
| [`EXTENSIONS.md`](EXTENSIONS.md) | Extension kinds, the skill format, validation gate, what may not run in v1. |
| [`docs/INTERFACES_AND_API.md`](docs/INTERFACES_AND_API.md) | The contract all four interfaces share: auth, routes, events, errors, and the parity matrix. |
| [`docs/UI_UX_SPEC.md`](docs/UI_UX_SPEC.md) | Interaction rules per surface, states, accessibility, first run. The element review is complete (D-075); this file is regenerated from `docs/review/` at `docs/ROADMAP.md` M0 P8, after the probes that could still change a row. |
| [`docs/DESIGN_SYSTEM.md`](docs/DESIGN_SYSTEM.md) | Tokens, type, spacing, color tiers, motion. §2.3 holds the palette with its measured contrast. |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Phases M0–M6, entry and exit conditions, and which open items block which phase. |
| [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) | Environment, scripts, testing, CI, release and Termux development rules. |
| [`docs/review/`](docs/review/README.md) | **M-D's element gate, now closed:** 675 elements across the four interfaces, every row reviewed (D-055, D-075) — the criteria and the scan are in that index, and review continues one implementation step at a time (D-076). `docs/review/mockups/crabby-web-ui.html` is the Web UI as one file, generated from the inventory. |
| [`docs/CONSISTENCY_REVIEW.md`](docs/CONSISTENCY_REVIEW.md) | What the cross-document review found (F-01…F-43), what it could not verify, and the owner's checklist. |
| [`AGENTS.md`](AGENTS.md) | The rules a coding agent works under, including the forbidden shortcuts. |

`python3 scripts/check-docs.py` lints this planning set — decision-ID references, cross-links, section anchors,
capability coverage, the review-progress counts, the palette's contrast arithmetic, and the rule that no planning
document may claim an implementation exists. `python3 scripts/count-inventory.py` prints the numbers §4B of
`DECISIONS.md` states, so progress is pasted rather than remembered, and `python3 scripts/review-scan.py` re-runs the
element-review criteria a row at a time whenever an inventory changes.

`CHANGELOG.md` and `LICENSE` are the two files this set deliberately does not have yet: the first is written at the
first release, the second at the moment code is distributed.

## Where the work stands

Nothing in this repository needs another planning document. Implementation has started, in the order the plan set;
what is scheduled from here:

01. **M0 — half done.** The seven probes are written and run from one command (`npm run probe`, contract in
    `probes/README.md`): `P1` the Node baseline that decides `engines`, `P2` the Fastify Gateway and its SSE channel,
    `P3` `better-sqlite3` build and WAL torture, `P4` the framework-free Web bundle, `P5` Ink 8 at 40×24, `P6` Android
    process lifetime, `P7` a hostile extension against the sandbox; `P8` then regenerates `docs/UI_UX_SPEC.md` and
    `docs/DESIGN_SYSTEM.md` from the accepted inventories. Each one says which machine it ran on: the container half is
    generated into `probes/RESULTS.md`, and the phone's column — `npm run test:termux` — is what M0 is waiting for.
    Two of them already contradicted the plan in ways worth reading before the first line of M1 (`docs/CONSISTENCY_REVIEW.md`).

02. **M1a — shipped, and it is the first product code.** `packages/api-contracts` is the shared shape four interfaces
    have to agree on before any of them exists: identifiers, the §5.2 event envelope, the §6 error envelope, task
    records, the five exit codes, and one `validate()` that rejects an unknown field *by name* the way §2 demands.
    `packages/platform` resolves the data directory and detects Termux from its own markers; `packages/core` loads and
    validates `config.json`, redacts before anything is written down, and records how the last process exited;
    `apps/cli` runs as `crabby init | doctor | version` and `crabby config path | get | set | schema` — after
    `npm install`, `npx crabby doctor`, since D-050 promises no global install and no self-updater. `crabby status`
    and the contract harness need a Gateway to read, so they are M1b; what M1a found unanswered is opened as
    O-066…O-069 rather than filled in with plausible numbers (`docs/ROADMAP.md` §3, and F-27 in
    `docs/CONSISTENCY_REVIEW.md` for why a citation here means a line `grep` can find).

03. **M1b — shipped: the Gateway and the state directory.** `packages/storage` owns the one SQLite file, the migration
    ledger, per-task `seq` numbering, redaction on write, and the 64 KiB overflow rule that moves a payload into
    `scratch/<taskId>/` with a marker in its place. `packages/gateway` is Fastify 5 validating with the contract's own
    `validate()`, pairing over a single-use 8-character code, tokens stored as digests, `Idempotency-Key` replay that
    returns the recorded answer, and SSE with a 15 s heartbeat plus §5.4's explicit gap frame; every route needs a
    token, health included. On the CLI side: `crabby gateway start` (loopback, Ctrl-C drains it, and it publishes and
    removes `gateway.json` so other processes discover the port instead of assuming one), `gateway status`, `status`,
    `auth pair|list|revoke`, `task ls`, `task show`. `tests/integration/gateway.test.ts` asserts the routes over a real
    socket and drives one spawned CLI against one spawned Gateway — P-003's lifecycle half, as a test. What is
    *absent* on purpose: `task run` (an executor is M2's), `POST /admin/*` (M2's policy engine — an interface may
    request and relay, never grant), and any bind beyond loopback.
03b. **M1c — shipped: policy, providers, the parity generator, CI.** `packages/policy` is `SECURITY.md` §6 as code —
    the 32-capability vocabulary, the four tiers, every §4.2 tool row transcribed with its base tier and grants,
    argument-dependent escalation, and a `registryDigest` so a stored answer says *which* policy gave it (D-080).
    `packages/providers` is the adapter contract with a fake provider that is held to the same conformance suite a real
    adapter will be, which is why no test in this repository needs a provider key (D-081). `GET /api/v1/tools` and
    `crabby tools ls` expose the registry to the four interfaces, `crabby diagnostics` writes the sanitized report as a
    0600 temp file and refuses a leaky one rather than redacting it after the fact, and `scripts/parity.ts` generates
    `docs/INTERFACES_AND_API.md` §8 while failing on any route, command, tier or capability the documents and the code
    disagree about. `.github/workflows/ci.yml` runs the seven legs that pass today and §12 names the ones that need a
    milestone first, the Termux container among them (D-082). Writing that generator found six findings — F-32…F-37 —
    three of them defects in the documents, which is the argument for a check that reads code and prose instead of two
    prose files.
04. **From there, every step that ships carries its own owner review:** the running screen or command plus the element
    IDs it implements, one unit at a time (`D-076`). An answer becomes a code change *and* an inventory-row change in
    the same commit; no answer is recorded as `unreviewed`, never as accepted.
05. **Nine rows are open** until a device, a real user, or a policy nobody has written yet answers them: O-006 and
    O-051 (terminal rendering on a phone), O-008 (extension isolation), O-064 (signing a distribution tier), O-065
    (what a Termux sandbox can enforce), O-052 (remembered approvals, post-v1 by choice), O-070 and O-071 — two shapes
    the contracts require and the documents never defined, a client id with no prefix and `system.*` events that must
    carry a `taskId` — and O-072, two §11 auth tests that each need a rule the spec has not written. Two more (O-001,
    O-002) are closed on everything but one measurement each: a clean Termux build and a WAL torture. Each row states
    what closes it, and none of them is closed by writing code that assumes an answer.

The element review (675 rows in `docs/review/`) is complete: 25 rows moved by D-059's narrow exception and 650 by the
delegated pass in D-075, whose criteria and re-runnable scan live in `docs/review/README.md`. To reopen any of it —
one row at a time, then `python3 scripts/count-inventory.py --markdown`, paste, `python3 scripts/check-docs.py`.

## Non-negotiable principles

- Mobile-first: Android + Termux is a first-class target, not an afterthought.
- Free-first: open-source dependencies, local models and free-tier APIs where practical — never a promise of unlimited free inference.
- One core: no interface implements its own agent loop, memory engine, or permission rules.
- Secure by default: loopback only, risk-based approvals, centrally enforced policy, secrets out of logs.
- Documented uncertainty: an open decision stays open until researched or prototyped. An answer recorded under the
  owner's delegation is marked `(R)`, carries its evidence, and can be reversed one row at a time — delegation is not
  drift (`DECISIONS.md` D-059, `docs/review/DECISION-QUEUE.md`).

## License

MIT (planned).
