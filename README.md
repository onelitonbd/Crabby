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
| [`docs/UI_UX_SPEC.md`](docs/UI_UX_SPEC.md) | Interaction rules per surface, states, accessibility, first run. Regenerated from `docs/review/` once the element review is done. |
| [`docs/DESIGN_SYSTEM.md`](docs/DESIGN_SYSTEM.md) | Tokens, type, spacing, color tiers, motion. §2.3 holds the palette with its measured contrast. |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Phases M0–M6, entry and exit conditions, and which open items block which phase. |
| [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) | Environment, scripts, testing, CI, release and Termux development rules. |
| [`docs/review/`](docs/review/README.md) | **The gate in front of M0:** 675 elements across the four interfaces, one status per row, reviewed element by element (D-055). `docs/review/mockups/crabby-web-ui.html` is the Web UI as one file, generated from the inventory. |
| [`docs/CONSISTENCY_REVIEW.md`](docs/CONSISTENCY_REVIEW.md) | What the cross-document review found (F-01…F-21), what it could not verify, and the owner's checklist. |
| [`AGENTS.md`](AGENTS.md) | The rules a coding agent works under, including the forbidden shortcuts. |

`python3 scripts/check-docs.py` lints this planning set — decision-ID references, cross-links, section anchors,
capability coverage, the review-progress counts, the palette's contrast arithmetic, and the rule that no planning
document may claim an implementation exists. `python3 scripts/count-inventory.py` prints the numbers §4B of
`DECISIONS.md` states, so progress is pasted rather than remembered.

`CHANGELOG.md` and `LICENSE` are the two files this set deliberately does not have yet: the first is written at the
first release, the second at the moment code is distributed.

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
