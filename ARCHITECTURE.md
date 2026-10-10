# Crabby — System Architecture

> **Document status:** Architecture draft updated from confirmed project requirements; technical validation remains pending.
>
> **Project:** Crabby
>
> **Primary runtime:** Node.js + TypeScript
>
> **Web frontend:** React + Vite
>
> **License:** MIT (planned)

## 1. Purpose

This document defines Crabby's system architecture, component responsibilities, communication model, runtime boundaries, and cross-platform requirements.

Crabby is a mobile-first, local-first, open-source AI harness. It provides one shared agent runtime through four interfaces:

- CLI
- TUI
- Web UI
- Telegram

All interfaces connect to one central Gateway, which manages incoming requests, routing, sessions, tasks, events, approvals, and responses.

The initial architecture prioritizes Android through Termux while targeting Linux and macOS. Windows support, initially potentially through WSL, remains subject to validation.

This document defines architectural requirements without pretending that every implementation detail has already been selected or tested.

## 2. Architectural Principles

01. **One shared runtime:** All interfaces use the same application services and agent execution engine.
02. **One central Gateway:** The Gateway coordinates all interface traffic and runtime interactions.
03. **Single-process initial architecture:** The Gateway and core run in the same application process.
04. **HTTP plus streaming:** Interfaces communicate through a shared HTTP API and a suitable streaming mechanism.
05. **Feature parity:** Every supported user-facing capability must be available through all four interfaces, with an appropriate interaction for each interface.
06. **Local-first execution:** Crabby must support local operation without a mandatory cloud backend.
07. **Optional remote access:** Users may enable Cloudflare Quick Tunnel for remote access, subject to authentication and security requirements.
08. **Persistent context:** Conversation history, memory, and task state must survive applicable restarts and support context recovery.
09. **Independent task lifecycle:** Tasks, events, cancellation, and checkpoints have explicit and separate responsibilities.
10. **Lightweight extensibility:** Prefer a small native extension contract, compatibility checks, and adapters over an unnecessarily heavy plugin framework.
11. **Centralized security policy:** Interfaces and extensions cannot bypass authorization and tool policies.
12. **Platform-aware implementation:** Platform-specific behavior must be isolated and documented.
13. **Documented uncertainty:** Unresolved decisions must remain explicitly open until evaluated.

## 3. High-Level Architecture

```
+------------------------------------------------------+
|                    User Interfaces                   |
|                                                      |
|    CLI        TUI        React Web UI      Telegram  |
+---------------------------+--------------------------+
                            |
                    HTTP + Streaming
                            |
+---------------------------v--------------------------+
|                    Crabby Gateway                    |
|                                                      |
|  Authentication and Authorization                    |
|  Request Routing and Interface Adapters              |
|  Session and Task Coordination                      |
|  Event Delivery and Reconnection                    |
|  Approval Coordination and Audit                    |
|  Configuration and Diagnostics                      |
+---------------------------+--------------------------+
                            |
                  In-process service calls
                            |
+---------------------------v--------------------------+
|                     Shared Core                      |
|                                                      |
|  Agent Orchestrator          Task Manager             |
|  Context and Memory          Tool Executor            |
|  Model Provider Registry     Policy Engine            |
|  Skill and Extension Manager Storage Services         |
|  Event System                Scheduler / Jobs         |
|  Cancellation Manager        Checkpoint Manager       |
+---------------------------+--------------------------+
                            |
+---------------------------v--------------------------+
|                 Infrastructure Adapters              |
|                                                      |
|  Model APIs / Local Models    Filesystem / Shell     |
|  SQLite or selected storage   MCP Client              |
|  Platform Adapters            Extension Adapters     |
|  Cloudflare Quick Tunnel (optional)                   |
+------------------------------------------------------+
```

The diagram represents logical responsibilities, not separate mandatory processes.

Initially, the Gateway and shared core run in the same process. Internal communication should use typed service interfaces rather than unnecessary network calls between internal components.

The architecture should preserve the option to split selected components into separate processes in the future if reliability, security, or scalability requires it.

## 4. Gateway Responsibilities

The Gateway is Crabby's central coordination point and the only public application API through which the four interfaces access shared runtime capabilities.

Its responsibilities include:

- Receiving requests from authenticated or otherwise appropriately authorized clients.
- Identifying the requesting interface and user or configured identity.
- Routing requests to the correct application services.
- Creating and accessing sessions.
- Creating, tracking, and cancelling tasks.
- Coordinating approval requests.
- Delivering streaming responses and task events.
- Managing event subscriptions and reconnections.
- Exposing relevant task status and execution results.
- Enforcing authorization at the API boundary.
- Recording security-relevant and operational events.
- Managing configuration, health checks, and diagnostics.

The Gateway is the coordination authority for application state, but individual services remain responsible for their own business logic.

For example, the Gateway routes a cancellation request; the Task Manager, Cancellation Manager, and relevant executors perform the cancellation process.

The Gateway must not rely on an interface to enforce security correctly. Authorization and policy checks must also be enforced by the shared backend.

## 5. Single-Process Runtime

The initial deployment runs the Gateway and core services together in one Node.js process.

The runtime should initialize in a controlled order:

1. Load and validate configuration.
2. Initialize logging and error handling.
3. Initialize storage and perform required migrations.
4. Initialize core services and registries.
5. Initialize the task, event, cancellation, and checkpoint systems.
6. Initialize the Gateway and interface adapters.
7. Start accepting requests after required services are ready.
8. Run restart recovery (see `AGENT_RUNTIME.md` §7) before resuming normal scheduling.
9. Shut down gracefully when requested.

Graceful shutdown should stop accepting new work, request cancellation or controlled completion where appropriate, persist recoverable task state, close resources, and terminate cleanly.

The exact behavior for interrupted or non-cancellable external operations requires implementation-level definition and testing.

## 6. Interface Architecture and Feature Parity

All four interfaces must expose the same supported application capabilities.

The presentation and interaction methods may differ because the interfaces have different technical constraints.

### 6.1 CLI

The CLI provides command-based interaction, scripting, automation, task management, configuration, and access to supported agent capabilities.

It must not become a reduced implementation of the agent runtime.

### 6.2 TUI

The TUI provides interactive terminal-based conversation, task monitoring, streaming output, tool activity, approvals, and supported administrative operations.

It must remain usable in constrained terminal environments, including Android through Termux.

### 6.3 Web UI

The Web UI provides responsive browser-based access to conversations, tasks, tool activity, approvals, configuration, memory controls, extension management, and other supported capabilities.

React and Vite are the proposed frontend technologies. Vite is a build tool and development server, not the production agent backend.

The production Web UI should be served as built assets through the Gateway or its associated local serving mechanism.

The backend must remain usable without the Web UI or Vite development server.

### 6.4 Telegram

Telegram provides conversational and supported administrative interactions through a bot.

It should support applicable features such as task creation, task progress, cancellation, results, and approvals using Telegram-compatible commands, messages, and buttons.

Telegram's platform restrictions must be documented. If a capability cannot be represented directly, Crabby must provide an appropriate alternative interaction where technically feasible.

### 6.5 Feature-parity requirement

Feature parity means equivalent capability and access to the same underlying application state, not pixel-identical interfaces.

A capability is not considered complete if it is available only in one interface without an explicitly documented platform limitation and an accepted alternative.

The project must maintain a feature-parity matrix in the interface specification and test supported capabilities across all four interfaces.

## 7. API and Communication Model

The shared API uses HTTP for requests and responses, with streaming for ongoing execution output and events.

The initial API should support:

- Conversation and session operations.
- Task creation and status retrieval.
- Task cancellation.
- Tool and approval interactions.
- Configuration and supported administrative operations.
- Memory and extension management.
- Health and diagnostic operations.
- Event subscriptions and streaming output.

The API must use versioned contracts and validated request and response schemas.

### Streaming

The architecture requires live delivery of streaming output and events.

SSE over HTTP is the current recommended candidate; WebSocket remains an alternative (see `DECISIONS.md` P-002 / O-004). The final transport and reconnect semantics remain open until the relevant requirements are evaluated.

The selected transport must support the required behavior for:

- Streaming agent responses.
- Tool execution updates.
- Task state changes.
- Approval requests and decisions.
- Cancellation status.
- Error reporting.
- Event subscription and reconnection.

### Event envelope

Events should use a common envelope containing fields such as:

- Event ID.
- Event type and schema version.
- Timestamp.
- Session ID, when applicable.
- Task ID, when applicable.
- Correlation ID.
- Event payload.

The exact schema will be specified in `docs/INTERFACES_AND_API.md`.

Events are informational and operational messages, not authorization grants. Receiving an event must never automatically grant permission to execute a tool or perform a protected operation.

## 8. Task Lifecycle

The Task Manager owns task identity, state transitions, and recoverable task progress. Cancellation requests are owned by the Cancellation Manager and consumed by the Task Manager; both write to the Event System as records.

A task should have a stable identifier and explicit lifecycle state.

An initial lifecycle model is:

```
Created
   |
   v
Queued
   |
   v
Planning
   |
   v
Running <----------------+
   |                     |
   v                     |
Awaiting Approval -------+
   |
   +-- Approved --> continues Running
   +-- Rejected --> Failed or Cancelled
   |
   v
Cancelling (finish current step)
   |
   v
Completed / Failed / Cancelled / Interrupted
```

The exact transition rules are formalized in `AGENT_RUNTIME.md` §4.

Task state must distinguish successful completion, failure, cancellation, waiting for approval, and interruption.

The Task Manager must prevent invalid transitions and provide a consistent status to all interfaces.

## 9. Event System

The event system distributes state changes and execution information to interested components and interfaces.

It is responsible for:

- Publishing task lifecycle events.
- Publishing tool execution and approval events.
- Publishing agent progress and streaming updates.
- Correlating events with sessions and tasks.
- Supporting event delivery to multiple interfaces.
- Handling subscription lifecycle and delivery failures.
- Supporting reconnection and recovery through persisted or queryable state where appropriate.

Events must not be the sole source of truth for task state.

If a client disconnects or misses an event, it should be able to retrieve the current task state and resume updates without assuming that every event was received.

**Boundary rule:** an event record describes what happened; it is not the authoritative current state, and it is not an approval grant. The retention, replay, ordering, and delivery guarantees remain implementation decisions to be specified and validated.

## 10. Cancellation Architecture

Cancellation is a separate subsystem from ordinary task-state updates and from the event log.

A cancellation request must identify the task or supported execution scope to cancel.

The cancellation process should:

1. Validate that the requesting identity may cancel the target.
2. Record the cancellation request.
3. Notify the Task Manager and relevant execution components.
4. Stop scheduling additional work for the cancelled execution.
5. Allow the current step to finish where safe (approved policy: **finish the current step**).
6. Propagate cancellation to model calls and tools when supported.
7. Persist the resulting task state and checkpoint.
8. Publish cancellation-related events.
9. Return the current cancellation status to interfaces.

Cancellation is cooperative where required by the underlying provider or process.

A request to cancel a task does not guarantee that an already-running external API call or operating-system process stops immediately. The runtime must distinguish cancellation requested, cancellation in progress, and cancellation completed.

Where an external action's outcome becomes uncertain during cancellation, that uncertainty must be recorded on the task and must not be silently resolved by re-executing the action.

Cancellation of one task must not accidentally cancel unrelated tasks or an entire shared session unless explicitly requested and supported.

## 11. Agent Runtime and Context Management

The Agent Orchestrator manages planning, model interactions, tool execution, observations, and task completion. Its detailed behavior is specified in `AGENT_RUNTIME.md`.

A typical execution cycle is:

01. Receive a validated task request.
02. Load session and relevant persisted state.
03. Construct a model context within the provider's token budget.
04. Request a plan or next action from the selected model.
05. Validate proposed tool calls against schemas and policy.
06. Obtain approval when required.
07. Execute permitted actions.
08. Record results and update task state.
09. Refresh relevant context and continue if necessary.
10. Persist the final result and publish completion events.

The runtime must support bounded retries, timeouts, error handling, and cancellation.

### Context and memory

The architecture separates:

- Persistent conversation history.
- Working context supplied to individual model calls.
- Long-term memory and retrieval.
- Task checkpoints and execution state.
- Temporary tool outputs and artifacts.

Context management must include token budgeting, relevant-history selection, compaction, retrieval, and recovery — without compaction ever destroying original conversation records.

Memory retrieval must be selective: not all stored information should be included in every model call.

The exact compaction algorithm, retrieval method, memory format, and token-budget strategy remain open for the runtime specification and later validation.

## 12. Model Provider Architecture

Model access must use a shared provider interface.

Provider adapters are responsible for translating between Crabby's internal request model and the capabilities of individual providers.

The provider abstraction should account for:

- Model discovery and configuration.
- Text generation.
- Streaming responses.
- Tool calling.
- Model metadata and capability declaration.
- Token and usage metadata.
- Provider errors, timeouts, and rate limits.
- Provider-specific context limits.
- Cancellation where supported.
- Fallback policies.

Provider-specific capabilities must be declared rather than assumed.

Local and remote models should use the same high-level orchestration flow wherever their capabilities permit.

A model's declared capabilities are user-overridable, in the order **user override → bundled preset → provider
discovery → adapter default** (`DECISIONS.md` D-045), and an override never exempts a capability from runtime
verification. Recovery from a provider failure follows the retry-then-ask ladder in
`PROVIDERS_AND_TOOLS.md` §3.6, which resumes from a checkpoint rather than restarting the task (D-044).

Free-tier API availability and local inference support are optional capabilities, not guarantees of unlimited free usage.

## 13. Tools and Policy Engine

All tools must be registered through a common tool interface.

A tool definition should include:

- Stable identifier.
- Description.
- Validated input schema.
- Execution handler.
- Required permissions.
- Timeout and resource limits.
- Risk classification.
- Optional output schema.

The shared Policy Engine evaluates whether an operation is permitted, before execution.

The policy layer should support:

- Capability and permission checks.
- Filesystem and workspace restrictions.
- Shell execution rules.
- User approval requirements.
- Execution limits and timeouts.
- Extension-specific permissions.
- Audit records for security-sensitive operations.

All interfaces must use the same backend policy. An action rejected by policy in one interface must not become permitted merely because it was requested through another.

## 14. Extension Architecture

Crabby should provide extensibility without requiring a large plugin framework in the initial release.

The architecture distinguishes:

- **Skills:** reusable instructions and workflows.
- **Tools:** callable capabilities.
- **Native plugins:** extensions implementing Crabby's supported extension contract.
- **MCP integrations:** external tools and resources accessed through compatible MCP clients.
- **Compatibility adapters:** components that inspect, import, or translate selected external formats (OpenClaw, Claude Code, and others).

### Compatibility-first installation

An extension installation flow should:

1. Identify its format and declared metadata.
2. Inspect dependencies and platform requirements.
3. Check compatibility with the current runtime and platform.
4. Identify permissions and security-sensitive capabilities.
5. Report compatible, partially compatible, unsupported, or unsafe conditions.
6. Offer a warning, safe import option, alternative, or rejection as appropriate.
7. Require any necessary user approval before installation or execution.

AI assistance may explain compatibility problems, suggest alternatives, adapt portable skills, or generate a new extension scaffold.

AI judgments must not replace deterministic checks where those checks are available. Unknown or untrusted code must not be treated as safe merely because an AI model recommends it.

Imported extensions must not bypass Crabby's Policy Engine.

Manifest fields, lifecycle states, verdict semantics, and the external-harness conversion plan are specified in `EXTENSIONS.md`.

### Lightweight implementation strategy

The initial implementation should favor a documented manifest, a narrow native extension interface, capability declarations, and adapters for selected external formats.

Arbitrary extension code should not automatically run with unrestricted access to the host. The required isolation mechanism depends on the extension type and threat model and must be evaluated before untrusted code execution is supported.

## 15. Storage and Persistence

Storage is accessed through a common storage interface so that application services do not depend directly on a particular database binding.

The persistence model must account for:

- Sessions and conversation messages.
- Task records and recoverable checkpoints.
- Relevant event and audit records.
- Approval requests and outcomes.
- Memory entries and metadata.
- Configuration and extension metadata.

Conversation history, derived summaries, long-term memory, and transient working context must be distinguishable.

SQLite is the proposed initial database with `better-sqlite3` as the proposed driver (see `DECISIONS.md`: reported Termux validation complete, independent reproduction pending).

Persistent state must be sufficient to support the documented recovery behavior without claiming that every interrupted external operation can be resumed exactly where it stopped.

Data-level requirements are specified in `docs/DATA_AND_MEMORY.md`.

## 16. Local and Remote Access

### Local mode

Local mode is the default.

The Gateway should bind to loopback interfaces unless a different exposure mode is explicitly configured. Access from local clients must still follow the relevant authentication and authorization requirements: every client uses a per-client paired identity (`DECISIONS.md` D-030), and the Gateway resolves that identity before routing. Authentication requirements are owned by `SECURITY.md` §5.

The runtime must not require a cloud service to start or use supported local functionality.

### Optional Cloudflare Quick Tunnel

Users may choose to expose the local Gateway through Cloudflare Quick Tunnel for remote access.

Remote mode must be explicitly enabled and must not silently change local networking defaults.

Before remote access is allowed, Crabby must establish appropriate authentication, authorization, and access restrictions. Sensitive administrative operations and tools must remain protected.

The architecture must account for tunnel availability, changing public URLs, interrupted connections, and remote-access shutdown.

Quick Tunnel is an optional convenience mechanism, not a promise of permanent hosting, production availability, or end-to-end security by itself.

The tunnel lifecycle, authentication arrangement, and remote-access safeguards are specified in `SECURITY.md`.

## 17. Platform Architecture

Platform-specific functionality should be isolated behind adapters where practical.

| Platform | Intended position | Validation required |
| --- | --- | --- |
| Android + Termux | Primary target | Installation, native dependencies, filesystem access, process behavior, background limits |
| Linux | First-class target | Distribution compatibility, installation, process management |
| macOS | First-class target | Dependencies, filesystem behavior, process management |
| Windows via WSL | Potential initial Windows path | Networking, filesystem integration, installation |
| Native Windows | Not yet committed | Runtime dependencies, shell adapters, packaging |

The runtime must not claim that all npm packages, native modules, shell operations, or extension dependencies behave identically across platforms.

Platform detection should support clear compatibility messages and graceful handling of unavailable capabilities.

iOS is outside the current committed scope.

## 18. Proposed Repository Structure

```
crabby/
├── apps/
│   ├── cli/
│   ├── tui/
│   ├── web/
│   └── telegram/
├── packages/
│   ├── core/
│   ├── gateway/
│   ├── api-contracts/
│   ├── agent-runtime/
│   ├── providers/
│   ├── tools/
│   ├── policy/
│   ├── memory/
│   ├── storage/
│   ├── skills/
│   ├── plugins/
│   ├── compatibility/
│   └── platform/
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── security/
│   └── fixtures/
├── docs/
├── scripts/
├── package.json
├── tsconfig.base.json
├── PROJECT_BRIEF.md
├── ARCHITECTURE.md
├── AGENT_RUNTIME.md
├── DECISIONS.md
├── SECURITY.md
├── AGENTS.md
└── LICENSE
```

This is a proposed logical structure, not a requirement to create every package immediately. Package boundaries should reflect real ownership and dependencies rather than creating unnecessary micro-packages.

The exact workspace tooling remains subject to the development specification and platform validation.

## 19. Dependency Direction

The intended dependency direction is:

- Interfaces depend on shared API contracts.
- The Gateway depends on core application services and API contracts.
- The Agent Orchestrator depends on provider, tool, policy, storage, and event abstractions.
- Infrastructure adapters implement those abstractions.
- Platform-specific implementations remain isolated behind appropriate interfaces.

Core application logic should not import UI components.

Provider-specific behavior should not leak into unrelated application services.

Extension adapters should translate external formats into supported Crabby capabilities rather than changing core policy rules.

## 20. Technical Stack

The current proposed stack is:

| Concern | Direction |
| --- | --- |
| Runtime | Node.js (accepted) |
| Language | TypeScript (accepted) |
| Web frontend | React (proposed) |
| Frontend build | Vite (proposed) |
| Gateway | Fastify (proposed) |
| API | HTTP with a versioned contract (accepted) |
| Streaming | SSE recommended, WebSocket alternative (proposed) |
| Validation | Zod (proposed) |
| Storage | SQLite behind an abstraction, driver `better-sqlite3` (proposed, validation reported) |
| Model integrations | Provider adapters (direction) |
| External tool integrations | MCP client (proposed) |
| Testing | Vitest + unit, integration, security, platform tests (proposed) |

The exact TUI library, workspace manager, and packaging approach are not finalized unless separately recorded as accepted decisions in `DECISIONS.md`.

## 21. Open Technical Decisions

The following topics require separate evaluation and must not be silently treated as finalized. They are tracked in `DECISIONS.md` §4, and at time of writing the key ones are:

01. Exact streaming transport, event ordering, replay, and reconnection semantics.
02. SQLite driver selection and Termux reproduction.
03. Context compaction, retrieval, and long-term memory algorithms.
04. Plugin execution isolation and supported trust levels.
05. External extension compatibility priorities and import behavior.
06. Cloudflare Quick Tunnel authentication and lifecycle management.
07. Windows support strategy beyond the initial WSL evaluation.
08. Packaging, dependency installation, upgrades, and recovery.
09. TUI library and terminal compatibility.
10. Task checkpoint format and recovery guarantees.

No open decision may be silently treated as final by an AI coding agent.

## 22. Architecture Acceptance Criteria

The architecture will be considered ready for implementation planning when:

- The single-process Gateway and core responsibilities are documented.
- All four interfaces have a defined shared capability model.
- API contracts and streaming requirements are specified.
- Task, event, cancellation, and checkpoint lifecycles have explicit and non-overlapping behavior.
- Persistence, context recovery, and memory responsibilities are separated.
- The extension installation and compatibility model is documented.
- Local and optional remote-access security requirements are defined.
- Platform support and limitations are explicit.
- Package boundaries and dependency direction are consistent.
- Unresolved decisions are tracked rather than disguised as final choices.
- Related Markdown documents agree on scope and terminology.

This document does not claim that the architecture has been implemented, that dependencies have been tested, or that every target platform has been verified.

---

**End of Architecture**
