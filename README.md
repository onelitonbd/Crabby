# Crabby

**Mobile-first · Cross-platform · Open-source AI harness**

Crabby is a terminal-first AI agent platform: one shared core runtime, one central Gateway, and four
equal-capability interfaces — **CLI · TUI · Web UI · Telegram** — that Android users can run in Termux and
that work the same way on Linux and macOS.

It is not a mobile app and not a chatbot wrapper. It is a harness: model providers, multi-step agents,
tools, memory, skills, plugins, and permission-controlled execution — all behind a single local-first Gateway.

## Install

The path is a checkout plus `npm install` — no global install, no package repository, no self-updater (D-050).
**[`docs/INSTALL.md`](docs/INSTALL.md)** has it per platform (Termux, Linux, macOS), the "from clone to first
conversation" commands, and what was rehearsed. In short:

```sh
git clone https://github.com/onelitonbd/Crabby.git && cd Crabby
npm install                                   # Termux: npm install --build-from-source
node apps/cli/crabby.ts doctor                # the green-light check, and the recovery tool forever
node apps/cli/crabby.ts init
node apps/cli/crabby.ts gateway start         # loopback; prints the pairing code for the next client
```

The model attaches by URL and key — any OpenAI-compatible endpoint, no code change (D-041) — with the key in the
vault (`crabby vault set groq`, then `config set provider.groq.key vault://groq`), never in a config file.

## Using it

| You want | Reach for |
| --- | --- |
| One question, one answer | `crabby chat "…"` |
| A multi-step task with approvals | `crabby task run "…"`, `crabby task watch <id>` |
| A full terminal UI | `crabby tui` |
| A browser | `crabby web open` — served by the Gateway itself, one origin |
| Telegram | `crabby telegram start` (pairing happens in-chat) |
| Another device | `crabby tunnel on` — one confirmed decision, the URL printed fresh every start (§13) |
| A timer | `cron.schedule` from a task, then `crabby job ls` |
| Memory | it accumulates; `crabby memory list/search/forget` |
| Skills from another harness | `crabby ext install <path>` — inert import, honest report, granted nothing (D-035) |
| Before you panic | `crabby doctor` — and [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) |

**Honest limitations, collected in one page:** [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md) — what Crabby does
not promise, from the no-sandbox sentence on Termux to what the tunnel does and refuses to do. The release bar is
that a new user hits nothing that page did not already mention.

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
| [`docs/CONSISTENCY_REVIEW.md`](docs/CONSISTENCY_REVIEW.md) | What the cross-document review found (F-01…F-62), what it could not verify, and the owner's checklist. |
| [`AGENTS.md`](AGENTS.md) | The rules a coding agent works under, including the forbidden shortcuts. |

`python3 scripts/check-docs.py` lints this planning set — decision-ID references, cross-links, section anchors,
capability coverage, the review-progress counts, the palette's contrast arithmetic, and the rule that no planning
document may claim an implementation exists. `python3 scripts/count-inventory.py` prints the numbers §4B of
`DECISIONS.md` states, so progress is pasted rather than remembered, and `python3 scripts/review-scan.py` re-runs the
element-review criteria a row at a time whenever an inventory changes.

`LICENSE` (MIT) and `CHANGELOG.md` (D-143) now exist; `THIRD-PARTY-NOTICES.md` is generated by
`npm run license:audit` (D-144) and re-generated at release.

## Where the work stands

**M0 through M5 are complete on the container/CI side** — the seven probes ran (`probes/RESULTS.md`; the phone
column is still owed), the contracts and skeleton shipped (M1), the whole runtime and Gateway exist (M2), all four
interfaces are built (M3), providers/memory/skills/MCP/extensions landed with their conformance suites (M4), and
security hardening is in: the vault (D-139), the quick tunnel (§13), the O-008 gate made final (D-140), the §17
injection corpus, and `crabby doctor --security`'s plain-language posture. **M6 — release readiness — is
underway:** backup/restore shipped (D-142), the changelog exists (D-143), the license audit runs (D-144), and the
install path is written and rehearsed (`docs/INSTALL.md`).

Still owed, and by whom:

- **The owner's device:** the Telegram wire check (`TG_BOT_TOKEN=… npm run telegram:check`) and with it the M3
  four-interface demo — a task started on Telegram, watched from Web, approved in the TUI, cancelled from the CLI;
  the Termux install rehearsal (also O-001's last clause); the performance pass (memory, startup, idle CPU,
  battery, WAL growth); the phone column of the probes (P-003/P-004/P-010/P-011).
- **This repository:** the release pages (this file, limitations, troubleshooting), then the `v0.1.0` cut at M6's
  exit bar — a new user, following only the docs on a phone, reaches a completed multi-step task with approvals,
  and hits nothing the limitations page did not already mention.

`docs/ROADMAP.md` has one paragraph per slice (39–82); `HANDOVER.md` is where the next agent starts; `WORKLOG.md`
is the running logbook.

## Non-negotiable principles

- Mobile-first: Android + Termux is a first-class target, not an afterthought.
- Free-first: open-source dependencies, local models and free-tier APIs where practical — never a promise of unlimited free inference.
- One core: no interface implements its own agent loop, memory engine, or permission rules.
- Secure by default: loopback only, risk-based approvals, centrally enforced policy, secrets out of logs.
- Documented uncertainty: an open decision stays open until researched or prototyped. An answer recorded under the
  owner's delegation is marked `(R)`, carries its evidence, and can be reversed one row at a time — delegation is not
  drift (`DECISIONS.md` D-059, `docs/review/DECISION-QUEUE.md`).

## License

MIT — see [`LICENSE`](LICENSE). Third-party notices: [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
