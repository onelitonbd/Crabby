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

Planned next: `EXTENSIONS.md`, `PROVIDERS_AND_TOOLS.md`, `docs/INTERFACES_AND_API.md`,
`docs/UI_UX_SPEC.md`, `docs/DESIGN_SYSTEM.md`, `docs/ROADMAP.md`, `docs/DEVELOPMENT.md`, `AGENTS.md`.

## Non-negotiable principles

- Mobile-first: Android + Termux is a first-class target, not an afterthought.
- Free-first: open-source dependencies, local models and free-tier APIs where practical — never a promise of unlimited free inference.
- One core: no interface implements its own agent loop, memory engine, or permission rules.
- Secure by default: loopback only, risk-based approvals, centrally enforced policy, secrets out of logs.
- Documented uncertainty: an open decision stays open until researched or prototyped.

## License

MIT (planned).
