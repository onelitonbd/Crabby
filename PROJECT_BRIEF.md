# Crabby — Project Brief

> **Status:** Project brief finalized; implementation has not started.
>
> **License:** MIT (planned)
>
> **Project type:** Open-source, local-first, cross-platform AI harness.

## 1. Project Overview

**Crabby** is a mobile-first, open-source AI harness designed to make capable AI agents accessible from Android phones, personal computers, and other supported environments.

Inspired by projects such as OpenClaw, Crabby aims to provide a unified environment where AI agents can understand requests, plan multi-step tasks, use tools, work with files, conduct research, maintain useful memory, and execute approved actions.

Crabby is not a dedicated mobile application or a single-purpose chatbot. It is a reusable AI runtime with multiple interfaces sharing the same underlying core.

The project prioritizes Android through Termux while also targeting Linux and macOS. Windows support will be evaluated, with WSL as a potential initial route.

Crabby should remain useful without requiring a paid subscription, mandatory cloud infrastructure, or a proprietary service.

## 2. Vision

Make powerful, extensible AI agents practical, affordable, and accessible on everyday devices, including low-resource Android phones.

Crabby should give users control over their models, data, tools, execution environment, and interfaces while allowing developers to extend its capabilities through an open ecosystem.

## 3. Core Goals

Crabby aims to:

01. Provide a shared AI agent runtime accessible through multiple interfaces.
02. Make Android/Termux a first-class development and execution environment.
03. Support local models and remote model APIs through a unified provider system.
04. Enable agents to plan and execute multi-step tasks with appropriate safeguards.
05. Provide controlled access to shell commands, files, research tools, and other capabilities.
06. Support persistent conversations, configurable memory, and long-running tasks.
07. Offer extensibility through skills, plugins, tools, and Model Context Protocol (MCP) integrations.
08. Investigate compatibility with selected external harness ecosystems.
09. Remain lightweight, maintainable, secure, and accessible to self-hosting users.
10. Support community contributions through an open-source development process.

## 4. Target Platforms

### Primary platform

**Android through Termux**

Termux is the primary platform for design and compatibility decisions. Installation, dependency management, filesystem access, process execution, resource usage, and background operation must account for Android-specific constraints.

### Additional platforms

- **Linux:** First-class support.
- **macOS:** First-class support where dependencies permit.
- **Windows:** Support to be evaluated, with WSL considered as a potential initial approach.

Platform-specific functionality must be isolated behind appropriate abstractions wherever practical.

A feature should not be described as supported on a platform until its compatibility has been verified.

## 5. User Interfaces

Crabby will provide four interfaces sharing the same core runtime and application services.

### 5.1 CLI — Command-Line Interface

The CLI will provide direct access to conversations, tasks, configuration, tools, sessions, and administrative commands.

It should remain usable on systems without a graphical interface.

### 5.2 TUI — Terminal User Interface

The TUI will provide a richer interactive terminal experience, including conversation display, task progress, tool activity, and approval interactions.

It should be suitable for terminal-based workflows on Android and desktop systems.

### 5.3 Web UI

The Web UI will provide a responsive browser-based interface for conversations, task monitoring, configuration, and supported administrative operations.

It must work on mobile browsers as well as desktop browsers. React and Vite are the proposed frontend technologies.

### 5.4 Telegram

The Telegram interface will let users interact with Crabby through a Telegram bot, subject to Telegram's capabilities and limitations.

It should reuse the same sessions, agent runtime, permissions, and task-management services as the other interfaces.

### Interface consistency

All four interfaces are part of the intended initial product scope and should be developed against shared API contracts.

They must not implement separate agent engines, memory systems, or permission policies.

## 6. AI Models and Providers

Crabby will use a unified provider architecture that supports both local and remote models.

The intended model strategy is:

- Local models where the hardware and runtime permit.
- Remote APIs, including suitable free or user-provided API options.
- Multiple providers through replaceable adapters.
- Streaming responses and tool calling when supported by a provider.
- Explicit handling of provider-specific capability differences.
- User-controlled configuration of provider credentials and model selection.

Crabby must not require a single model vendor or mandatory paid API subscription.

Free API availability, rate limits, usage restrictions, and model capabilities may vary by provider. Crabby must not promise unlimited or permanently free access to third-party services.

## 7. Agent Capabilities

Crabby is intended to support agents that can plan, execute, observe results, and continue through multi-step tasks.

The planned capabilities include:

- Conversational assistance.
- Task planning and execution.
- Coding and development assistance.
- Shell and filesystem operations.
- Web research through available tools or integrations.
- Persistent conversation history and configurable memory.
- Tool use and skill-driven workflows.
- Background and long-running tasks.
- Automation and messaging integrations.
- Optional local, remote, or hybrid execution where supported.

Agent autonomy must operate within defined policies, resource limits, and permission boundaries. High-impact or sensitive actions may require explicit user approval.

Crabby should make task progress, tool activity, failures, and cancellation status visible where the interface supports them.

## 8. Runtime and Execution Model

Crabby will follow a **local-first architecture with optional remote or hybrid execution**.

The intended design includes a persistent Gateway that coordinates interfaces, sessions, task execution, events, and approvals.

The Gateway and core services should be capable of operating locally without a mandatory cloud backend. Optional remote execution may be introduced through an explicitly configured architecture with appropriate authentication and security controls.

Long-running tasks, background operation, and reliability on Android must account for operating-system restrictions. Continuous background availability cannot be guaranteed on every Android device or configuration.

The exact process model and remote-execution protocol will be documented and evaluated in the architecture specifications.

## 9. Tools, Skills, Plugins, and Integrations

Crabby will distinguish between:

- **Tools:** Callable capabilities such as filesystem access, shell execution, or external services.
- **Skills:** Instructions and workflows that guide agents in using capabilities.
- **Plugins:** Extensions that add functionality or integrate additional components.
- **Providers:** Adapters that connect the runtime to AI models.
- **MCP integrations:** Connections to compatible MCP servers and their exposed capabilities.

The project will define native extension interfaces and permission requirements.

### External ecosystem compatibility

Crabby aims to support importing or adapting useful extensions from selected ecosystems, including:

- OpenClaw.
- Claude Code.
- Other AI harnesses and compatible extension formats.

Compatibility will be implemented incrementally through format-specific adapters and importers.

Portable skill formats and MCP configurations are initial candidates for interoperability. Other formats will be assessed based on value, security, licensing, and implementation effort.

**Crabby will not assume that every external plugin, hook, command, or script can execute unchanged.** Compatibility claims must be specific to the formats and capabilities actually supported.

Imported extensions must remain subject to Crabby's own security and permission policies.

## 10. Security and Privacy Principles

Security is a foundational requirement, not an optional enhancement.

Crabby should follow these principles:

01. Default to local-only network access for a locally running Gateway unless the user explicitly configures another arrangement.
02. Require appropriate authentication for protected interfaces and remote access (per-client paired identities, `DECISIONS.md` D-030).
03. Apply centralized authorization and permission checks to tool execution.
04. Restrict filesystem access according to configured permissions and workspace boundaries.
05. Treat shell execution and other high-impact operations as security-sensitive.
06. Support explicit approval workflows for actions that require user authorization.
07. Protect API keys, tokens, and other secrets from unnecessary exposure.
08. Treat external plugins, skills, tool output, and imported instructions as potentially untrusted.
09. Provide useful execution logs and audit information without unnecessarily exposing sensitive data.
10. Keep user control over data storage, memory, and integrations.

Specific sandboxing mechanisms, threat-model details, capability vocabulary, risk tiers, and approval policies are defined in `SECURITY.md`; the accepted choices there are recorded in `DECISIONS.md` D-030…D-034. Their effectiveness must not be assumed without validation.

## 11. Storage and Memory

Crabby will provide persistent storage for the data required by its runtime, including applicable records for:

- Sessions and conversations.
- Messages and task state.
- Tool execution and approval records.
- Configuration and extension metadata.
- Long-term memory and retrieval information.
- Relevant audit events.

Conversation history and long-term memory should be treated as distinct concepts, with clear controls over persistence and retrieval.

Storage will be accessed through an abstraction so that implementation details can evolve without forcing changes throughout the application.

SQLite is a proposed default, subject to compatibility testing and evaluation of suitable bindings on Termux and other target platforms. See `DECISIONS.md` for the current evaluation status.

## 12. Technical Direction

The current proposed stack is:

| Area | Proposed technology |
| --- | --- |
| Runtime | Node.js |
| Language | TypeScript |
| Web frontend | React |
| Frontend build tooling | Vite |
| Gateway/API | Fastify |
| Live updates | WebSocket or a suitable streaming alternative |
| Package management | npm workspaces or another validated workspace solution |
| Data validation | A shared schema-validation library |
| Storage | SQLite behind an abstraction, pending validation |
| External tool integration | MCP client |
| Testing | Automated unit, integration, and security tests |

These technologies are a working technical direction, not a guarantee that every dependency has already been tested on Termux.

The exact TUI library, storage binding, packaging method, plugin isolation mechanism, and other unresolved implementation details are recorded separately in `DECISIONS.md`.

## 13. Project Principles

Crabby will follow these non-negotiable principles:

- **Open source:** Use the MIT license, subject to review of third-party dependencies and bundled components.
- **No mandatory paid subscription:** Core functionality must not depend on a paid Crabby subscription.
- **No mandatory cloud:** Local operation must remain possible for supported use cases.
- **Mobile-first:** Android/Termux is a first-class target.
- **Resource-conscious:** Avoid unnecessary dependencies and excessive resource consumption.
- **Secure by default:** Apply explicit permission boundaries and safe defaults.
- **User control:** Let users choose their models, integrations, execution options, and supported data-retention settings.
- **Modularity:** Keep interfaces, providers, tools, storage, and extension systems replaceable where practical.
- **Cross-platform design:** Isolate platform-specific behavior and verify compatibility.
- **Transparent limitations:** Clearly document unsupported features, provider constraints, and compatibility gaps.
- **Maintainability:** Prefer clear architecture and testable components over unnecessary complexity.

## 14. Initial Release Scope

The initial release is intended to establish a usable, integrated version of Crabby rather than merely a standalone chatbot.

### Initial release targets

- A shared core runtime and local Gateway.
- All four planned interfaces: CLI, TUI, Web UI, and Telegram.
- Unified model-provider configuration.
- Basic multi-step agent execution.
- A foundational set of tools with centralized permission checks.
- Session and conversation persistence.
- An initial memory capability.
- Native skill and extension foundations.
- MCP client integration where practical for the release.
- Installation and operating instructions for Termux, Linux, and macOS.
- Automated tests and basic security documentation.

The four interfaces should share stable contracts, but implementation details may be staged internally to reduce integration risk.

Full external-harness compatibility, sophisticated memory retrieval, extensive plugin sandboxing, advanced automation, and broad Windows support may require later milestones.

## 15. Out of Scope for Initial Commitments

The project does not currently promise:

- Unrestricted execution of arbitrary external plugins.
- Compatibility with every OpenClaw or Claude Code extension.
- Guaranteed operation of every local model on Android.
- Unlimited free access to remote AI providers.
- Reliable background execution despite Android terminating processes.
- A mandatory hosted cloud service.
- A dedicated native Android application.
- A fully isolated sandbox on every platform from the first release.
- Full Windows compatibility before it has been evaluated and tested.

These may be explored where useful, but they must not be treated as guaranteed deliverables.

## 16. Development and Decision Policy

Crabby's planning documentation will be completed and reviewed before implementation begins.

The project maintains separate records for requirements, architecture, development milestones, security, extension compatibility, and unresolved decisions.

Technical decisions must be categorized as appropriate:

- **Accepted:** Agreed upon for the project.
- **Proposed:** A candidate awaiting review.
- **Open:** Alternatives remain under consideration.
- **Needs Validation:** Requires research, compatibility checks, or a prototype.
- **Superseded:** Replaced by a later decision.

Unresolved choices must not be silently converted into finalized architecture.

Where evidence is insufficient, the project will document the alternatives, trade-offs, validation requirements, and decision criteria. The project owner retains final authority over significant architectural choices.

## 17. Success Criteria

Crabby will be considered successful when it can:

01. Be installed and run reliably in its verified target environments.
02. Provide a consistent agent experience across the four interfaces.
03. Use multiple supported model providers through a common abstraction.
04. Execute multi-step tasks with observable progress and appropriate safeguards.
05. Persist and retrieve sessions and supported memory data.
06. Extend functionality through documented tools, skills, plugins, and integrations.
07. Operate locally without requiring a proprietary cloud service.
08. Remain maintainable and usable on resource-constrained devices.
09. Document platform limitations, security boundaries, and compatibility honestly.
10. Provide clear setup, development, testing, and contribution instructions.

## 18. Relationship to Other Documents

This document defines the project's purpose, goals, constraints, and intended scope.

Other documentation provides the implementation-independent details needed to guide development:

| Document | Location | Scope |
| --- | --- | --- |
| `ARCHITECTURE.md` | root | System structure and component boundaries. |
| `DECISIONS.md` | root | Accepted decisions, proposals, open questions, validation records. |
| `AGENT_RUNTIME.md` | root | Planning, execution, task state, orchestration, recovery. |
| `SECURITY.md` | root | Threat model, permissions, authentication, approvals. |
| `DATA_AND_MEMORY.md` | `docs/` | Persistence, memory, retention, retrieval, deletion. |
| `EXTENSIONS.md` | `docs/` | Skills, plugins, MCP, external compatibility. |
| `PROVIDERS_AND_TOOLS.md` | `docs/` | Model providers, tools, capability interfaces. |
| `INTERFACES_AND_API.md` | `docs/` | Interface behavior, API contracts, event delivery. |
| `UI_UX_SPEC.md` | `docs/` | Layouts, screens, interactions per interface. |
| `DESIGN_SYSTEM.md` | `docs/` | Visual identity and shared components. |
| `ROADMAP.md` | `docs/` | Phases, priorities, dependencies, milestones. |
| `DEVELOPMENT.md` | `docs/` | Development environment, repository, testing. |
| `AGENTS.md` | root | Instructions for AI coding agents working on Crabby. |

All documents must remain consistent with this brief. If a significant requirement changes, the relevant documents must be reviewed and updated.

---

**End of Project Brief**
