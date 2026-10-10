# Crabby — Security Specification

> **Document status:** Planning draft. Requirements are proposed for project-owner review; nothing here claims an implemented or audited control.
>
> **Owner of security policy:** this document. Other documents may reference it but must not redefine permission, approval, or trust rules.
>
> **Related:** `PROJECT_BRIEF.md` §10, `ARCHITECTURE.md` §13/§16, `AGENT_RUNTIME.md` §5, `DECISIONS.md`, `docs/DATA_AND_MEMORY.md`

## 1. Purpose and Scope

This document defines Crabby's security requirements: the trust boundaries between interfaces, the Gateway, the core runtime, tools, extensions, and the network; the permission and approval model; protection of secrets and personal data; and the limits of what Crabby can honestly claim on each platform.

Security is a foundational requirement for Crabby, not an optional enhancement (Brief §10). This matters more than in an ordinary application because Crabby combines four remote-controllable interfaces with an autonomous multi-step agent that can run shell commands, edit files, and send data to external services — and its primary platform, Android via Termux, provides weaker process isolation than a typical server.

Out of scope here: the internal state machine of the agent (`AGENT_RUNTIME.md`), storage schema details (`docs/DATA_AND_MEMORY.md`), and extension manifest format (`EXTENSIONS.md`). This document defines what each of them must enforce.

## 2. Security Principles

01. **Least capability:** Nothing — no interface, tool, provider, or extension — receives authority it does not need for the task at hand.
02. **Centralized enforcement:** Every permission decision is made in the shared core Policy Engine. An interface may request, display, and relay; it may never grant.
03. **Fail closed:** Unknown capability, unparsable manifest, missing permission record, ambiguous identity, or unavailable policy data results in denial, not permissive fallback.
04. **Explicit elevation:** Broadening access (new permission, remote exposure, higher risk tier, wider workspace) is always an explicit user action with a clear description of what changes.
05. **Local by default:** The Gateway listens on loopback only unless the user deliberately enables remote exposure.
06. **Human-meaningful approval:** An approval request must describe the concrete action and its consequences in terms a user can evaluate from a phone screen.
07. **No security by AI judgment:** A model's opinion that something is safe is an input to risk assessment, never an authorization. Deterministic policy checks decide.
08. **Defense against our own agent:** Content returned by tools, the web, files, MCP servers, and imported extensions is untrusted data and must not become instructions that override policy.
09. **Auditable:** Security-relevant events are recorded durably enough to reconstruct what was allowed, by whom, and when — without turning the log into a leak.
10. **Honest limitations:** Platform constraints (Android background limits, no real sandbox in Termux, mutable app home directory) are documented as limitations, never described as protections we do not have.
11. **Reversible where possible:** Users can revoke tokens, cancel or deny pending approvals, disable extensions, rotate secrets, and delete data.

## 3. Trust Boundaries

```
        [ Untrusted network: internet ]
                    |
        (optional) Cloudflare Quick Tunnel  ← Boundary 5 (remote exposure)
                    |
+---------------------------------------------------+
|  CLI      TUI      Web UI      Telegram bot       |  Boundary 1 (client identity)
+-------------------------+-------------------------+
                          |  HTTP + SSE, authenticated
+-------------------------v-------------------------+
|                     Gateway                       |  Boundary 2 (authorization at API edge)
|   authn/authz · rate limits · input validation    |
+-------------------------+-------------------------+
                          |  in-process, typed service calls
+-------------------------v-------------------------+
|            Shared Core / Agent Runtime            |  Boundary 3 (policy decisions)
|   Policy Engine · Approval Service · Audit Log    |
+-------------------------+-------------------------+
                          |  capability-gated tool invocation
+-------------------------v-------------------------+
|   Tools: fs · shell · net · provider · MCP · ext  |  Boundary 4 (execution & untrusted code)
+---------------------------------------------------+
```

Boundary rules:

- **B1 — Client identity.** Every connection is attributable to a known client (interface instance + configured identity). Anonymous local access is not an accepted model; the mechanism is per-client pairing tokens (D-030), with residual detail tracked in O-019.
- **B2 — API edge.** Validation and authorization happen before any application service runs. The Gateway does not trust that an interface already checked anything.
- **B3 — Policy decisions.** All permission and approval evaluation occurs here. Tool implementations must not contain the only copy of a rule.
- **B4 — Execution.** Tools and extensions receive only the declared capability set for the current task, never ambient full-user privileges beyond what the platform cannot avoid (see §15).
- **B5 — Remote exposure.** A tunnel is a transport, not an authenticator. Enabling it never widens permissions.

## 4. Threat Model

### 4.1 Assets

01. Provider API keys, Telegram bot token, tunnel and session credentials.
02. Conversation history, long-term memory, and any personal or project data in them.
03. The user's files and workspace, including anything outside a configured boundary that the process can reach.
04. The execution environment itself (device, shell, package manager, battery, storage).
05. crabby configuration and installed extensions.
06. The user's reputation and relationships — actions taken in their name via Telegram, git, or messaging.
07. Audit records used to detect abuse of the above.

### 4.2 Threat catalog

| ID | Threat | Primary vector | Mitigation owner |
| --- | --- | --- | --- |
| T-01 | **Prompt injection via tool output** — a fetched page, file, or MCP response carries instructions that make the agent exfiltrate secrets or run commands. | Web/file/MCP content | §10, §11, tier-based approvals |
| T-02 | **Prompt injection via imported extension** — a skill from another harness smuggles instructions in its description or README. | Compatibility importer | §11, `EXTENSIONS.md` |
| T-03 | **Untrusted extension code** — a plugin with shell or network access misuses it. | Plugin install | §11, O-008 |
| T-04 | **Unauthorized remote control** — attacker reaches the Gateway through a tunnel, LAN, or a shared device and issues high-impact tasks. | B5, weak local trust | §5, §13 |
| T-05 | **Approval fatigue / rubber-stamping** — user approves destructive actions reflexively; a broad or remembered approval is then exploited. | Approval UX | §6.3 (once-only approvals in v1) |
| T-06 | **Cross-interface privilege confusion** — a task started on Telegram is silently granted TUI-level permissions, or vice versa. | Interface-specific policy drift | §2 rule 02, §7 parity |
| T-07 | **Recovery overreach** — auto-resume repeats a non-idempotent action (double send, double purchase) after a restart. | Full auto-resume (D-026) | `AGENT_RUNTIME.md` §7.2 |
| T-08 | **Secret leakage** — keys in logs, crash reports, conversation records, memory search results, or exported backups. | Error paths, telemetry | §7, §14, `docs/DATA_AND_MEMORY.md` §2.6 |
| T-09 | **Context-window exhaustion / cost abuse** — attacker-provoked loops drain quota or battery. | Unbounded retries, long tasks | §12, runtime limits |
| T-10 | **Workspace escape** — path traversal, symlink tricks, or absolute paths outside the granted root. | Filesystem tools | §8 |
| T-11 | **Destructive shell command** — recursive deletes, package removal, force pushes. | Shell tool | §9 |
| T-12 | **Data residue after deletion** — deleted conversation survives in summaries, indexes, or old backups. | Retention, backups | `docs/DATA_AND_MEMORY.md` §7 |
| T-13 | **Supply chain** — malicious dependency or compromised extension registry. | Install path | §11, §16 |
| T-14 | **Local device compromise** — another app or an adb-rooted context reads app-private storage. | Android model | §15 (documented limitation) |
| T-15 | **Denial of the Gateway** — runaway parallel tasks exhaust a low-resource phone. | Scheduler | §12 |

### 4.3 Explicit non-goals

Crabby does **not** claim to provide: multi-tenant isolation, protection against a root-compromised Android device, a hardened OS-level sandbox on Termux, compliance certifications, or anonymity/privacy of prompts sent to third-party model providers. Provider-side data handling must be documented so users can choose knowingly.

## 5. Authentication

### 5.1 Local interfaces (CLI, TUI, Web UI on loopback)

Requirements:

- The Gateway must be able to attribute a request to a configured local client identity, not "whoever can open a socket".
- Loopback binding alone is treated as *reachability* control, not authentication. A device-attached attacker or a browser page from another origin must not be able to drive the Gateway.
- The Web UI must validate `Origin`/`Host`, and must not accept ambient browser credentials (no cookie-based session relying on the browser's automatic sending; if a session token is used it must be non-guessable and explicitly delivered).
- Any local bearer material must be generated randomly, stored with owner-only file permissions, and revocable.

**Selected (D-030): per-client pairing tokens.** Each interface instance is paired explicitly and receives its
own credential, so any client can be revoked without disturbing the others.

```
crabby auth pair --name kitchen-phone --interface telegram|tui|cli|web
crabby auth list                 # show clients, creation time, last use, granted capabilities
crabby auth revoke <client-id>   # immediate, affects that client only
```

Pairing requirements:

- A pairing request is issued from inside the Gateway's own process/host (CLI/TUI command), never accepted over the network by an unauthenticated caller.
- The pairing artifact is short-lived, single-use, and carries a TTL; the long-lived credential is delivered once and never logged.
- Every credential is bound to a client name and an interface type so audit records say *which* client acted.
- Revocation takes effect on the next request and must also terminate live event streams.
- Unauthenticated requests are rejected before routing, including `GET /health` and event subscriptions.

Token format and lifetime are fixed by D-051 (opaque token, no expiry; revocation is the control). **O-019** keeps a
single remainder: the pairing code's presentation on a phone-sized terminal — readable, typeable, and copyable in one
screen (`docs/INTERFACES_AND_API.md` §3.2).

Alternatives considered and rejected:

| Option | Verdict | Reason |
| --- | --- | --- |
| **Per-client tokens via `crabby auth pair`** | **Selected** | Revocable, attributable, one model for local and remote, cheap on Termux |
| Shared token file in the data dir | Rejected | Anyone who reads the file *is* every local client; no per-client audit or revocation |
| Trust-the-OS-user peer credential check | Rejected | Not portable, unreliable on Android, no revocation |
| Short-lived signed tokens with rotation | Deferred | Genuine benefit but clock and rotation complexity on mobile; may layer on later |

### 5.2 Telegram

- The bot token is a secret under §7 and must never appear in logs, config dumps, or error output.
- Authorization is by **allow-listed Telegram user IDs and/or chat IDs**, configured explicitly. Being able to message the bot is not authorization.
- The bot must ignore unauthorized senders without revealing whether an ID exists, and should record attempts.
- Webhook mode must verify the secret token; long polling is the simpler default for Termux.
- Scheduled and background jobs are the one place where a single approval could silently become a standing one, so:
creating a job is a normal tiered action, and **each run re-evaluates every step** — a schedule grants nothing in
advance (`PROVIDERS_AND_TOOLS.md` §4.5). A job that cannot get approval within its window stops with a visible
reason rather than running unattended.

Inline-button approval callbacks must be verified to originate from the same user, chat, and message that the approval was issued for; a callback id alone is not a decision.
- Group chats are denied for privileged operations unless separately enabled, and approvals must not be answerable by anyone but the requesting user.

### 5.3 Remote access

See §13. Remote clients never receive a wider permission set than local ones; the interface label may only narrow capabilities, and feature parity (D-005) is preserved by keeping capability identical and only adapting presentation.

## 6. Authorization and Risk Tiers

### 6.1 Capability model

Permissions are named capabilities, not free-form text. Initial proposed vocabulary (exact names are an implementation decision):

| Capability | Grants |
| --- | --- |
| `session.read` / `session.write` | Read or modify conversation and session state. |
| `task.create` / `task.cancel` / `task.read` | Start, cancel, inspect tasks. |
| `fs.read:<root>` / `fs.write:<root>` | File access scoped to a configured root. |
| `net.egress:<hostset>` | Outbound network from tools, scoped by host set. |
| `task.read` | Inspect task state, history, and results (read-only). |
| `shell.run` | Execute commands through the shell tool. |
| `shell.privileged` | Commands touching package managers, services, system config. |
| `provider.invoke` / `provider.billing` | Call a provider / call a paid endpoint. |
| `memory.write` / `memory.delete` | Persist or purge long-term memory. |
| `memory.read` | Search and read memory entries. |
| `ext.install` / `ext.execute` | Install / run external code. |
| `config.write` | Change configuration, including security settings. |
| `config.read` | Read non-secret configuration. |
| `ext.list` | Enumerate installed extensions and their metadata. |
| `ext.read` | Read an extension's own manifest, docs, and conversion reports. |
| `tunnel.enable` | Expose the Gateway remotely. |
| `auth.manage` | Create, list, and revoke paired client identities. Local-only by construction: no remote or agent-facing path may grant it (`docs/INTERFACES_AND_API.md` §3.1). |
| `device.<capability>` | One independently enabled Termux device capability: `device.sms`, `device.contacts`, `device.camera`, `device.location`, `device.sensor`, `device.notify`, `device.control`, `device.screen`, `device.clipboard`. Each is a distinct grant; `device.notify` and `device.control` for benign outputs are the only low-risk members (D-033, `PROVIDERS_AND_TOOLS.md` §4.2). |

A task may additionally be given a *task-scoped* narrowing of these, so "just do this repo job" does not mean "and everything else".

### 6.2 Risk tiers

Every registered tool declares a tier; tier drives the approval policy. Proposed four tiers (per-tool assignment is **O-020**):

| Tier | Description | Default behavior |
| --- | --- | --- |
| **T0 — Read-only local** | Reading files inside the workspace, listing sessions, reading status. | Auto-allow, audited. |
| **T1 — Reversible local write** | Creating/editing files in the workspace, scratch output, saving memory. | Auto-allow if the permission is granted; batch notification. |
| **T2 — External side effect or destructive** | Deleting/overwriting outside scratch, git push, sending messages, calling paid endpoints, package install, any network egress to a new host. | **Per-action approval.** |
| **T3 — Security-sensitive / elevated** | Changing permissions, config, secrets, enabling a tunnel, installing extensions, `shell.privileged`, disabling logging, or anything irreversible on infrastructure. | **Explicit approval, no stored blanket grant, re-prompt on every material change.** |

Rules:

- Tier assignment is a property of the tool and the *argument shape*, not of the model's confidence. `rm -rf` and `ls` are never the same tier even though both are "shell".
- A tool may raise its own tier; it may not lower it. Configuration may raise strictness but never below the tier's floor.
- Unknown, unclassified, or newly imported extensions default to **T2** until classified.

### 6.3 Approval workflow

An approval request must carry: task id, tool, tier, human-readable action summary, the exact command or path or destination host, expected effects, reversibility, and an explicit "what could go wrong". It must be answerable from all four interfaces, with an expire-on-timeout default so a stale prompt cannot be approved much later.

Approval binding: a decision applies to *that* action with *those* arguments in *that* task. Approval must never be interpreted as a general license, and re-approval is required when the action materially changes (targets a new path, host, or destination) — per `AGENT_RUNTIME.md` §5.

**Stored ("remember this") approvals are out of scope for the first release** (D-052). v1 supports exactly one
answer shape — approve this one action, once — which is also what `docs/INTERFACES_AND_API.md` §4.3 exposes as
`scope: once`. If a remembered approval is ever added, it must be scoped to the tool plus argument pattern, listed
in one place, individually revocable, unavailable for T3 entirely, and it must not survive a material change to the
action. This is the honest reading of the parity promise: approval fatigue (T-05) is better answered by asking less
often — fewer, larger, reversible steps — than by pre-authorizing the dangerous ones.

Denials are recorded and respected; the agent must not rephrase a denied action to obtain a different answer, and repeated denial of the same class should pause the task and surface it to the user rather than loop.

## 7. Secrets Handling

Requirements (mechanism **selected: D-031** — OS keychain with encrypted-file fallback):

- Secrets live outside the conversation database and outside ordinary configuration files. Never interleave keys with session records that a user might export or share.
- Redaction is applied at the logging and event-serialization layer, not only at the UI. If an error object can contain a header, the serializer must strip it (see `AGENT_RUNTIME.md` §9.3).
- Provider keys, bot token, and tunnel credentials must not be sent into model context unless a tool genuinely requires it, and then only via the provider adapter path — the agent should be able to use a credential without reading it.
- Files containing secrets: owner-only permissions (`0600`), excluded from backups by default, and never included in diagnostics bundles without explicit opt-in.
- Rotation and revocation must be a documented, one-command user action.
- Any crash report or bug attachment flow must run a secret-pattern scan before the content is written out.

Platform behavior:

| Platform | Store | Notes |
| --- | --- | --- |
| macOS | Keychain | Preferred path. |
| Linux | Secret Service when available | Otherwise treated like the fallback case; do not silently write plaintext. |
| Android + Termux | Encrypted file + passphrase | `keystore` reachability from Termux is unverified → O-018 remainder. If a future probe finds it usable, it may become the preferred store. |
| Windows / WSL | Fallback encrypted file | Do not claim DPAPI protection until designed and tested (§15). |

Fallback rules:

- The encrypted file is created `0600`, holds a key-derived blob (KDF parameters to be pinned, O-018 remainder), and is *never* the default on a platform where a keychain exists.
- Startup must not block forever for a passphrase: a locked vault means provider calls and T2/T3 tools are unavailable until unlocked, which must be reported clearly on all four interfaces.
- Lock state is visible: users must always be able to tell whether secrets are currently available.
- Any UI or log message referencing the fallback must state that it protects against casual disclosure, not against an attacker who already owns the Termux user account (§15).

## 8. Filesystem and Workspace Security

- All file tools operate relative to one or more **configured workspace roots**. Absolute paths, `..` traversal, and symlink resolution must be normalized and re-checked *after* resolving links.
- The default install grants no filesystem access outside the workspace; the home directory is not a workspace.
- Sensitive default deny-list (configurable, user-owned): `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config/gh`, browser profile directories, `.env*` files, `*.pem`, `*.key`, `credentials*`, and the Crabby data directory itself. Deny applies to read as well as write; agents routinely leak by reading.
- Writes should prefer atomic write + rename; destructive overwrites of pre-existing user files are T2.
- Trash-or-rename should be offered in place of hard delete where the platform supports it; hard delete is T2/T3.
- Path checks are enforced in the tool adapter, and the tool must not accept a caller-provided path that it then re-interprets (e.g. shell redirection as a "read" call is still a write).

## 9. Shell and Process Execution

- Shell execution is capability-gated (`shell.run`) and **never enabled by default** for a fresh install; enabling it is an explicit act.
- Command strings must not be assembled from untrusted content. Where possible, use argv-form invocation; if a shell is genuinely needed, quoting must be explicit and tested.
- Each command carries: timeout, output size caps, cwd within an allowed root, environment allow-list, and resource limits where the platform supports them.
- Environment passed to child processes must be an explicit allow-list — the parent environment often contains provider keys.
- Command output is untrusted data (§10) and must be rendered to the model as clearly delimited, non-authoritative content.
- Process trees must be cancellable: Crabby spawns process groups so a cancellation or shutdown can signal children (`AGENT_RUNTIME.md` §6). Orphaned children after a crash must be detectable on restart.
- A command deny-list is *advisory friction*, not a security boundary. The boundary is the permission + approval model. This must be documented so users do not over-trust pattern lists.
- Long or heavy commands on Termux may be killed by Android; the runtime must distinguish "we cancelled it", "Android killed it", and "it failed".

## 10. Untrusted Content and Instruction Hierarchy

Crabby's agent consumes text that it did not author: web pages, files, tool results, MCP responses, memory entries written earlier, and imported skills. All of it is data.

Requirements:

- **Instruction precedence** must be explicit and documented: system/security policy > user request in the current session > approved configuration > skill and memory content > retrieved or external content. Lower tiers may inform, never authorize.
- External content is wrapped with structural delimiters and metadata (source, fetch time, trust label) so both the model and the audit log can attribute it.
- Policy-relevant decisions must never be derived from content inside a tool result. Even if a model is persuaded, the Policy Engine still denies a capability that was not granted — this is why §2 rule 02 exists.
- Importers must sanitize: strip embedded instructions that impersonate system or user roles, neutralize fake turn markers, and cap sizes.
- Memory poisoning is a real risk under D-019 automatic memory: entries derived from untrusted content must carry their provenance and a trust label, and low-trust memories must not be injected into context for T2/T3 work without the user seeing why.
- A task that is only supposed to read may not be escalated into writing or sending by text it read.

## 11. Extension and Plugin Trust

Requirements for the extension system (format and flow in `EXTENSIONS.md`):

- Installation is **T2**, execution of arbitrary extension code is **T3**, and both must state the exact capability set requested.
- Every extension is a distinct permission principal. It receives only its declared capabilities; it does not inherit the user's or the task's full authority.
- Deterministic checks run before AI assistance: manifest schema, dependency and platform requirements, signature/integrity where available, permission diff versus the installed version, and dangerous-pattern inspection of bundled scripts.
- Compatibility verdicts are advisory; the installer must not treat "AI says it looks fine" as approval. An extension cannot self-declare its tier.
- Untrusted executable extensions must not run until an isolation strategy exists (O-008). Until then, the only untrusted-safe import path is **instruction-only** content (portable skills), which is inert data under §10.
- Updates re-run checks and re-prompt on any permission widening. Uninstall removes code and revokes grants; residual data is reported to the user.
- MCP servers are extensions for security purposes: their tools are tier-classified, their results are untrusted content, and their transport (stdio command vs remote URL) is surfaced in the approval prompt.

## 12. Resource and Availability Controls

- Concurrency limits (D-023), per-task step limits, wall-clock timeouts, retry caps (§9 of the runtime doc), and output-size caps must be enforced by the core, not the caller.
- Rate limiting on the Gateway API protects against runaway client loops and local DoS; provider calls need budget guards so a task cannot silently burn paid quota.
- Battery/thermal awareness: on mobile, sustained background work must be explicitly user-initiated and cancellable; a "low resource" mode should degrade parallelism before it degrades correctness.
- Disk: WAL growth, event retention, and artifact storage need configurable caps with a warn-then-refuse behavior, because a full phone storage damages more than Crabby.
- Structured failures: when limits cause a stop, the user sees which limit fired and how to change it.

## 13. Network Exposure and Cloudflare Quick Tunnel

Default posture: **loopback only**. Requirements for the optional remote mode:

- Enabling remote access is a T3 config change and must be visible in the UI/TUI/Web with a persistent indicator while active.
- Quick Tunnel provides reachability, not authentication, not confidentiality of the app layer, and not availability. Permanent URLs, uptime, and third-party routing must never be promised.
- Remote clients authenticate with the same mechanism as other clients (§5.1) over TLS to the tunnel. Without a valid token, the Gateway must reject every route, including health and SSE.
- Remote access must not add capabilities. **Selected (D-032):** Crabby applies no tunnel-specific hardening on top of normal policy — a remote client may use exactly what its paired identity is allowed, preserving feature parity (D-005) across local and remote.
- Residual risk is accepted and must be documented for users: with a valid token, a remote client can drive a shell-capable task. The compensating controls are risk-tier approvals (§6.2), per-action T2/T3 prompts, token revocation, and audit records.
- Narrowing remains available per client, not per transport: `crabby auth pair --restrict shell,config` produces a
  limited identity. This keeps parity intact — the *identity* is narrower, the *transport* is not.
- Restriction semantics, so a narrow identity cannot deadlock: `--restrict` **removes** capabilities from that
  identity; it does not convert them into always-deny-with-an-approval-prompt. A removed capability is reported as
  `platform-unsupported`-style "not available to this client" with the reason, rather than queueing an approval the
  same restricted client may be unable to answer. Approvals may be answered from *any* paired client that holds
  `auth` visibility, but relying on that as the only escape hatch is a design bug.
- Because exposure is the risky part, enabling a tunnel is T3, and the approval text must list which paired identities would become reachable remotely.
- Tunnel lifecycle: URL changes on restart, so clients must discover rather than assume; the runtime must handle tunnel drops with clear state, and `crabby tunnel stop` must fully revoke exposure and close the listener.
- Log the tunnel's active periods and any accepted remote auth failures.
- LAN exposure (non-loopback bind) and reverse-proxy setups are separate, harder-to-secure modes; keep them out of the initial release unless requested, and never offer them implicitly.

## 14. Audit Logging and Safe Telemetry

- Record: auth attempts and failures, permission decisions, approval requests with their payload and outcome, tool invocations with tier, config changes, extension installs, tunnel start/stop.
- Every audit record needs: timestamp, actor/client id, session id, task id, correlation id, outcome. Records are append-only from the application's perspective, subject to the retention policy (O-014).
- Redaction: audit payloads keep *what was attempted* while stripping secrets and unnecessary private content. The exact strip/hash/keep rules are **O-022**.
- The audit log must not be writable by tools or extensions — otherwise the agent can erase its own trail. Log disabling or filtering is itself a T3 action.
- Telemetry: none by default; Crabby should not phone home. If any diagnostic upload is ever offered, it is opt-in per occurrence, shows the payload, and runs the §7 secret scan.
- Diagnostics commands must be safe to paste into a bug report: redaction is verified by tests, not by hope.

## 15. Platform-Specific Security Notes

| Platform | Position | Notes and honest limitations |
| --- | --- | --- |
| Android + Termux | Primary | No application sandbox between Crabby and Termux's own data dir: any process running inside Termux can read Crabby's files and any plaintext secret there. Assume a single trust domain. Android may kill long processes; recovery must not weaken policy to "catch up". `termux-api` grants are exposed only under D-033: each capability independently enabled, classified **T3**, per-action approval, no stored blanket grant. |
| Linux | First-class | Standard user privileges — Crabby runs as the user and cannot claim stronger isolation without an added mechanism. Optional hardening (separate user, `bwrap`/`landrun`-style, systemd user sandbox) is a proposed future feature, not a promise. |
| macOS | First-class | Keychain available for secrets; no per-directory ACL for Termux-style access; `TCC` prompts affect tool usability, which must be documented rather than worked around. |
| Windows via WSL | Potential | Filesystem bridging means a workspace root under `/mnt/c` has weaker permission semantics. Path normalization and case-insensitivity need explicit tests. |
| Native Windows | Not committed | Do not claim DPAPI/ACL-based protection until designed and tested. |

Device capability rule (D-033): `termux-sms-send`, `termux-contact-list`, `termux-camera-photo`, location and sensor access are separate capabilities (`device.sms`, `device.contacts`, `device.camera`, `device.location`). Reading contacts to answer "who is in my family?" is still T3, because the sensitive act is disclosure into model context, not the write. Model providers therefore must not receive device capability output unless the current task explicitly approved that destination.

Cross-platform requirement: path handling, permission bits, and process-group signaling must be implemented behind the platform adapter (`ARCHITECTURE.md` §17) and tested per platform, because these are exactly where security code tends to rot silently on the less-tested OS.

## 16. Supply Chain and Distribution

- Pin dependency versions with a lockfile; review additions of install scripts, which are a real risk on Termux where many packages build from source.
- Prefer dependencies with no native compilation where a portable alternative exists (`PROJECT_BRIEF.md` §13 resource-consciousness).
- Publish integrity information for the CLI package; document how users verify what they installed.
- Extension registries, when introduced, are untrusted third-party sources by default: signature verification, publisher identity, and revocation are prerequisites for any "official" trust tier.
- MIT licensing review is a distribution-time security activity as much as a legal one: bundled assets and plugin templates must be audited before release.

## 17. Security Testing Requirements

The test suite must include, at minimum (see also `docs/DEVELOPMENT.md`):

- **Policy unit tests:** every capability check has a positive and a negative case; unparsable or unknown input denies.
- **Boundary tests:** file tools reject traversal, symlink escape, and absolute paths outside roots; on both POSIX and WSL path shapes.
- **Approval tests:** approval is bound to the exact action; material change re-prompts; no remembered-approval path exists in v1, and a request for one is refused (`D-052`); a restart does not silently satisfy a pending approval.
- **Injection fixtures:** corpus of adversarial tool outputs and imported skill text; expected behavior is denial or reporting, never execution.
- **Redaction tests:** inject a fake secret through every path (tool error, provider error, extension crash, audit payload) and assert it appears nowhere.
- **Auth tests:** unauthorized Telegram sender, wrong token, missing Origin header, expired/revoked token — all rejected, with no capability leak in the error text.
- **Tunnel tests:** remote mode refuses without auth and reverts to loopback on stop.
- **Resource tests:** timeouts, retry caps, disk caps, concurrency limits, cancellation propagation to child processes.
- **Termux security smoke test:** the above on the primary platform, not just CI Linux.

Security-relevant tests must run without live model APIs, using deterministic provider fakes.

## 18. Security Acceptance Criteria

The security design is ready for implementation planning when:

01. Capability vocabulary and risk tiers are defined, and every initial tool is classified.
02. A client authentication mechanism is selected and specified — closed by D-030 (mechanism) and D-051 (format and
   lifetime); the pairing-screen UX stays open and does not block M1.
03. Secrets storage behavior is decided per platform, with an explicit weaker-fallback disclosure (O-018).
04. Approval payload content, binding rules, and revocation UX are specified for all four interfaces.
05. The untrusted-content policy is written into tool and importer implementations as a requirement, not a convention.
06. Remote-mode requirements are complete enough that no implementer must invent a security rule.
07. Audit redaction rules are decided (O-022) and covered by tests.
08. Threat model rows T-01…T-15 each map to at least one concrete mitigation and at least one test.
09. Platform limitations are documented in user-facing docs, not only in this file.
10. `DECISIONS.md` reflects the accepted/open status of every choice referenced above.

## 19. Open Security Decisions

Recorded in `DECISIONS.md` §4; ownership is this document.

Resolved by review — see `DECISIONS.md` D-030…D-033: client authentication mechanism, secrets storage
strategy, remote posture, and `termux-api` exposure.

Still open:

- **O-008** Extension isolation strategy and supported trust levels.
- **O-009** Tunnel lifecycle details (URL rotation, reconnect, shutdown ordering).
- **O-018** (remainder) Android `keystore` reachability from Termux; KDF and encryption parameters for the fallback.
- **O-019** (remainder) Pairing-code presentation on a phone-sized terminal. Format and expiry are decided (D-051).
- ~~**O-020**~~ Per-tool risk-tier assignment — **closed (D-046)**; table in `PROVIDERS_AND_TOOLS.md` §4.2.
- **O-021** Depth of prompt-injection hardening for imported content.
- **O-022** Audit log redaction rules.
- **O-024** Initial `termux-api` capability list.
- **O-025** Whether task-scoped capability narrowing is mandatory or opt-in.

## 20. Threat-to-Mitigation Summary

| Threat | Where the mitigation lives |
| --- | --- |
| T-01, T-02 | §10 + §11 sanitization + Policy Engine at B3 |
| T-03, T-13 | §11 + §16 + O-008 gate |
| T-04, T-15 | §5 + §12 + §13 |
| T-05, T-06 | §6 (binding, per-action approval, single enforcement point) |
| T-07 | `AGENT_RUNTIME.md` §7.2 (auto-resume cannot authorize) |
| T-08 | §7 + §14 + `docs/DATA_AND_MEMORY.md` §2.6 |
| T-09, T-12 | §12 + `docs/DATA_AND_MEMORY.md` §7 |
| T-10, T-11, T-14 | §8 + §9 + §15 |

---

**End of Security Specification**
