# Crabby

**Mobile-first · Cross-platform · Open-source AI harness**

Crabby is a terminal-first AI agent platform: one shared core runtime, one central Gateway, and four
equal-capability interfaces — **CLI · TUI · Web UI · Telegram** — that Android users can run in Termux and
that work the same way on Linux and macOS.

It is not a mobile app and not a chatbot wrapper. It is a harness: model providers, multi-step agents,
tools, memory, skills, plugins, and permission-controlled execution — all behind a single local-first Gateway.

> **Current phase: planning.** Implementation has not started. The documents below are the specification that
> later code must follow, and `DECISIONS.md` records what is still deliberately undecided.

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
| [`docs/CONSISTENCY_REVIEW.md`](docs/CONSISTENCY_REVIEW.md) | What the cross-document review found (F-01…F-26), what it could not verify, and the owner's checklist. |
| [`AGENTS.md`](AGENTS.md) | The rules a coding agent works under, including the forbidden shortcuts. |

`python3 scripts/check-docs.py` lints this planning set — decision-ID references, cross-links, section anchors,
capability coverage, the review-progress counts, the palette's contrast arithmetic, and the rule that no planning
document may claim an implementation exists. `python3 scripts/count-inventory.py` prints the numbers §4B of
`DECISIONS.md` states, so progress is pasted rather than remembered, and `python3 scripts/review-scan.py` re-runs the
element-review criteria a row at a time whenever an inventory changes.

`CHANGELOG.md` and `LICENSE` are the two files this set deliberately does not have yet: the first is written at the
first release, the second at the moment code is distributed.

## Before implementation starts

Nothing in this repository needs another planning document. What is scheduled, in order:

01. **M0 — in progress.** The seven probes are written and run from one command (`npm run probe`, contract in
    `probes/README.md`): `P1` the Node baseline that decides `engines`, `P2` the Fastify Gateway and its SSE channel,
    `P3` `better-sqlite3` build and WAL torture, `P4` the framework-free Web bundle, `P5` Ink 8 at 40×24, `P6` Android
    process lifetime, `P7` a hostile extension against the sandbox; `P8` then regenerates `docs/UI_UX_SPEC.md` and
    `docs/DESIGN_SYSTEM.md` from the accepted inventories. Each one says which machine it ran on: the container half is
    generated into `probes/RESULTS.md`, and the phone's column — `npm run test:termux` — is what M0 is waiting for.
    Two of them already contradicted the plan in ways worth reading before the first line of M1 (`docs/CONSISTENCY_REVIEW.md`).

02. **Then M1** (contracts and skeleton), and from there every step that ships carries its own owner review:
    the running screen or command plus the element IDs it implements, one unit at a time (`D-076`). An answer becomes a
    code change *and* an inventory-row change in the same commit; no answer is recorded as `unreviewed`, never as
    accepted.
03. **Eight tracked questions stay open until a device or a real user answers them**: O-001, O-002 (driver build, WAL),
    O-006, O-051 (terminal rendering on a phone), O-008 (extension isolation), O-064 (signing), O-065 (Termux
    sandbox), and O-052 (remembered approvals, post-v1 by choice). Each states the measurement that closes it.

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
