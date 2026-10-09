# Crabby — Decision Register

**Status:** Living document — the single source of truth for what is decided and what is not.

**Purpose:** Record accepted decisions, proposals, unresolved choices, and validation requirements before implementation begins.

## 1. Decision Status Definitions

- **Accepted** — Explicitly approved by the project owner.
- **Proposed** — Recommended candidate awaiting approval.
- **Open** — Multiple options remain under consideration.
- **Needs Validation** — Requires research, compatibility testing, or a prototype before confirmation.
- **Superseded** — Replaced by a newer decision.

A recommendation must not be treated as an accepted decision without approval.

## 2. Accepted Decisions

| ID | Decision | Status |
| --- | --- | --- |
| D-001 | Crabby is a mobile-first, cross-platform, open-source AI harness. | Accepted |
| D-002 | Android through Termux is the primary platform target. | Accepted |
| D-003 | Linux and macOS are intended target platforms. | Accepted |
| D-004 | CLI, TUI, Web UI, and Telegram are the initial interfaces. | Accepted |
| D-005 | All four interfaces must provide equivalent capabilities, adapted to each interface's interaction model. | Accepted |
| D-006 | Core and Gateway initially run in the same process. | Accepted |
| D-007 | All interfaces connect through one central Gateway. | Accepted |
| D-008 | HTTP request/response and streaming communication are required. | Accepted |
| D-009 | Local access is the default; remote access is optional. | Accepted |
| D-010 | Cloudflare Quick Tunnel is an optional remote-access approach. | Accepted |
| D-011 | Tasks, events, cancellation, and checkpoints have separately defined responsibilities and lifecycles. | Accepted |
| D-012 | Persistent conversation history, long-term memory, context management, and task recovery are core requirements. | Accepted |
| D-013 | External extensions require compatibility checks and must not be assumed to run unchanged on every platform. | Accepted |
| D-014 | AI may assist with extension adaptation, but safety must not depend solely on AI judgment. | Accepted |
| D-015 | Backend runtime: Node.js with TypeScript. | Accepted |
| D-016 | Complete planning documentation before implementation begins. | Accepted |
| D-017 | Conversation history persists by default; users can delete it. | Accepted |
| D-018 | Interrupted tasks should recover from checkpoints where safe and possible. | Accepted |
| D-019 | Long-term memory uses a hybrid approach: automatic memory creation with user control. | Accepted |
| D-020 | Necessary event records are retained; the precise retention period remains undecided. | Accepted |
| D-021 | Start with ordinary text search for memory; consider vector/semantic search later if justified. | Accepted |
| D-022 | Agent execution strategy: Plan → Execute. | Accepted |
| D-023 | Task concurrency: Controlled parallelism with configurable limits. | Accepted |
| D-024 | Approval policy: Risk-based approval. | Accepted |
| D-025 | Cancellation policy: Finish the current step, with safety override. | Accepted |
| D-026 | Recovery policy: Full auto-resume, which must never bypass approvals or blindly repeat uncertain external actions. | Accepted |
| D-027 | Context management: Hybrid compaction that never destroys original conversation records. | Accepted |
| D-028 | Error handling: bounded retries, verification where practical, no security bypass to make a task succeed. | Accepted |
| D-029 | Task, Event, Cancellation, and Checkpoint ownership is separated per `AGENT_RUNTIME.md` §4.4. | Accepted |

## 3. Proposed Technical Choices

These choices are recommendations, not accepted technical decisions.

| ID | Area | Candidate | Status |
| --- | --- | --- | --- |
| P-001 | Gateway framework | Fastify | Proposed |
| P-002 | Streaming | SSE for server-to-client updates, ordinary HTTP endpoints for client actions | Proposed |
| P-003 | Database engine | SQLite | Proposed — leading candidate, reported Termux validation |
| P-004 | Database driver | `better-sqlite3` (source build on Termux) | Proposed default |
| P-005 | Workspace tooling | npm workspaces | Proposed |
| P-006 | Schema validation | Zod | Proposed |
| P-007 | Web frontend | React + Vite | Proposed |
| P-008 | Test framework | Vitest | Proposed |
| P-009 | Telegram library | grammY | Proposed |

Each proposal remains pending until explicitly accepted or validated as required.

## 4. Open Decisions and Validation Requirements

| ID | Topic | Status / Next action |
| --- | --- | --- |
| O-001 | Database engine | Largely informed: SQLite is the leading candidate after comparison against `docs/DATA_AND_MEMORY.md` §4. Final confirmation still requires reproduction on a clean environment. |
| O-002 | Database driver | Needs Validation: reproduce `better-sqlite3` build and runtime behaviour on a clean Termux environment; pin supported version range. |
| O-003 | npm vs pnpm | Open: compare installation, reproducibility, workspace workflow, and Termux compatibility. |
| O-004 | SSE vs WebSocket | Open: evaluate streaming, reconnection, bidirectional control, and event replay. |
| O-005 | Zod vs TypeBox | Open: confirm schema validation and API contract requirements. |
| O-006 | TUI library | Open: compare terminal UI libraries for mobile terminal usability and platform support. |
| O-007 | Windows support | Open: define the initial WSL support boundary and assess native Windows support. |
| O-008 | Extension isolation | Needs Validation: evaluate permissions, process isolation, and practical sandboxing on Termux. |
| O-009 | Remote authentication | Open: define authentication, authorization, and tunnel lifecycle. `SECURITY.md` §5 states the requirements; the concrete token scheme is unselected. |
| O-010 | Event replay | Open: define event IDs, ordering, retention window, replay, and reconnection semantics. |
| O-011 | Context management algorithms | Needs Validation: evaluate token budgeting, compaction, retrieval, checkpointing, and recovery. |
| O-012 | Installation and upgrades | Open: define installation, upgrade, rollback, backup, and recovery requirements per platform. |
| O-013 | Checkpoint recovery semantics | Needs Validation: establish safe resume rules, idempotency, and handling of partially completed external actions. |
| O-014 | Event retention policy | Open: determine retention duration, storage limits, and deletion rules. |
| O-015 | Memory retrieval implementation | Open: define text-search implementation, indexing, and criteria for introducing vector search. |
| O-016 | Memory deletion and privacy | Open: specify how deleting conversations affects summaries, memories, and derived records. |
| O-017 | Backup and restore | Open: define a reliable, portable backup and restore procedure for persistent data. |
| O-018 | Secrets storage mechanism | Open: `SECURITY.md` §7 states requirements; OS keychain vs encrypted file vs Termux-specific fallback is unselected. |
| O-019 | Local client authentication method | Open: pair-token vs OS-user trust vs per-client identity — decision required before Gateway implementation. |
| O-020 | Risk classification levels for tools | Open: `SECURITY.md` §6 proposes four tiers; tier assignment per tool is undecided. |
| O-021 | Prompt-injection hardening depth for imported content | Open: instruction-source tagging vs full isolation. |
| O-022 | Audit log redaction rules | Open: which payload fields are stripped vs hashed vs retained. |

## 5. Database Evaluation Record

**Evidence source:** User-provided Termux validation report.

**Evaluation status:** Reported validation complete; independent reproduction not performed by this project.

### 5.1 Engine comparison

| Option | Assessment | Status |
| --- | --- | --- |
| SQLite | Strong fit for local-first persistence; transactions, constraints, WAL, online backup reported working on Termux. | Proposed — leading candidate |
| PostgreSQL | Technically capable, especially for higher concurrency via MVCC; server administration and backup tooling add unnecessary initial complexity. | Open — fallback candidate |
| File-based storage | Useful for exports and artifacts; not preferred as the primary transactional store. | Open |

### 5.2 Driver comparison

| Driver | Reported result | Remaining action |
| --- | --- | --- |
| `node:sqlite` (`DatabaseSync`) | Available in the tested Node.js environment; experimental status must be confirmed for the pinned version. | Confirm API stability and support policy for the selected Node.js version. |
| `better-sqlite3` | Source build and runtime reported successful on Termux; supports schemas, CHECK, NOT NULL, FOREIGN KEY, transactions, and user-defined functions. | Reproduce in the project environment; document build prerequisites (compiler, `python`, `make`). |

### 5.3 Reported validation results

| Test area | Reported outcome |
| --- | --- |
| Node.js runtime | Tested on Node.js v26.4.0 under Termux (Android Bionic libc); v22.x–v26.x reported supported |
| Transactions and constraints | Successful |
| WAL concurrent reads and writes | Successful |
| Abrupt termination and `PRAGMA integrity_check` | Successful — automatic rollback of incomplete transactions |
| WAL checkpoint persistence and restart recovery | Successful |
| Online backup and restore (`db.backup()`) | Successful, row counts preserved |
| Bulk insert throughput | ~38,000–45,000 rows/sec inside transactions |
| Storage footprint | ~104 KB per 1,000 structured conversation rows with indexes |

The reported performance figures are environment-specific measurements, not performance guarantees.

### 5.4 Design notes from this evaluation

- `npm rebuild better-sqlite3 --build-from-source` is required on Termux because prebuilt binaries target glibc rather than Android Bionic.
- WAL mode improves reader/writer concurrency but does not allow multiple simultaneous writers; commits still serialize.
- Cascade deletion (`ON DELETE CASCADE`) is acceptable for indexes and strictly derived records, but automatic cascade of long-term memories from a deleted conversation is **not** an accepted default — deletion propagation must follow an explicit policy (O-016).

### 5.5 Decision gate

Select the database engine and driver only after the remaining checks pass and the project owner approves. **No implementation is authorized by this evaluation record.**

## 6. Architecture Constraints

Future technical decisions must respect these requirements:

01. Keep business logic independent of the selected Gateway framework.
02. Use shared contracts between the core and all interfaces.
03. Keep storage behind an abstraction where practical.
04. Preserve task state and important events for diagnosis and recovery.
05. Do not assume cancellation immediately terminates every external operation.
06. Treat external extensions as untrusted until their compatibility and permissions are evaluated.
07. Do not assume a remote tunnel alone provides adequate authentication or security.
08. Validate platform-specific assumptions before committing to dependencies that could block Termux support.
09. Preserve original conversation records separately from generated summaries or memory extracts.
10. Resume checkpointed tasks only when the remaining actions can be evaluated for safety and duplicate-execution risk.
11. Never let recovery, automation, or an AI recommendation weaken an approval requirement.
12. Security policy is enforced centrally in the core, not in any interface.

## 7. Decision Process

For each open item:

1. Define requirements and constraints.
2. Compare realistic alternatives.
3. Make a recommendation with trade-offs.
4. Obtain project-owner approval for product-level choices.
5. Perform research or validation where compatibility is uncertain.
6. Update the status here and record the rationale.
7. Propagate the change to every affected document.

## 8. Current Next Actions

1. Review `SECURITY.md` and decide O-009, O-018, O-019, O-020, O-021, O-022.
2. Write `EXTENSIONS.md`, then `PROVIDERS_AND_TOOLS.md`.
3. Write `docs/INTERFACES_AND_API.md`, `docs/UI_UX_SPEC.md`, `docs/DESIGN_SYSTEM.md`.
4. Write `docs/ROADMAP.md` and `docs/DEVELOPMENT.md`.
5. Write `AGENTS.md` for AI coding agents.
6. Run a final cross-document consistency review of all planning documents.
7. Only then begin the implementation blueprint and the Termux validation prototype.

**Implementation remains out of scope until the planning documents and required decisions have been reviewed.**
