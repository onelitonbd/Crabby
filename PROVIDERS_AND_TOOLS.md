# Crabby — Providers and Tools Specification

> **Document status:** Planning draft. The provider contract and the tool tier assignment below are proposed for
> project-owner review; runtime mechanisms remain open.
>
> **Owns:** model provider abstraction, capability declaration, provider selection and fallback, tool registry
> contract, the initial tool set, and per-tool risk-tier assignment (closes **O-020**).
>
> **Does not own:** tier semantics and approval workflow (`SECURITY.md` §6), tool execution state in the agent loop
> (`AGENT_RUNTIME.md` §9), MCP transport and trust rules (`EXTENSIONS.md` §10).
>
> **Related:** `ARCHITECTURE.md` §12/§13, `PROJECT_BRIEF.md` §6/§9

## 1. Purpose

Crabby must work with many model backends without its agent logic knowing which one is in use, and it must expose
a small, well-classified set of callable capabilities to those models. This document defines both boundaries.

The single rule that makes the rest of this document coherent: **a model asks, the Policy Engine decides.** No
provider, tool, or extension gets to grant itself authority (`SECURITY.md` §2 rule 02).

## 2. Design Principles

01. **Capabilities are declared, never assumed.** Every provider states what it supports; the runtime degrades
    explicitly instead of guessing (`ARCHITECTURE.md` §12).
02. **Lowest common denominator first.** The core agent loop may rely only on the contract in §3.1; richer
    provider features are optional extensions behind their declared capability.
03. **Provider-agnostic internal representation.** Crabby's message model is its own; adapters translate, they do
    not leak vendor shapes upward.
04. **Free-first without false promises.** Free tiers and local inference are supported paths, never guaranteed
    quotas (`PROJECT_BRIEF.md` §6).
05. **Every tool is classified before it can be registered.** An unclassified tool is a build failure, not a
    runtime warning.
06. **Argument shape changes tier.** The tier is a function of the tool *and* its arguments, so `ls` and
    `rm -rf` never share a policy path (`SECURITY.md` §6.2).
07. **One code path for all four interfaces.** A tool call initiated from Telegram passes the identical checks as
    one from the TUI (D-005).
08. **Mobile budget applies to tools too.** Output caps, timeouts, and temp-file lifetime are set for low-resource
    devices, not desktop defaults.
09. **Discovery is a default, not a cage.** What a provider reports about a model seeds the descriptor; the user's
    override wins, because providers lie, lag, and differ by endpoint (§3.8).
10. **A provider failure is never a restart.** Retrying or switching a model resumes the task from its checkpoint.
    Completed steps are not re-run and side effects are never repeated for the sake of simplicity (§3.9, D-044).

## 3. Model Provider Architecture

### 3.1 Provider contract

A provider adapter implements a narrow interface. Presence of a method is not enough — the capability must be
declared in `describe()`.

| Member | Kind | Contract |
| --- | --- | --- |
| `id` | required | Stable provider identifier used in configuration and audit records. |
| `describe()` | required | Capability descriptor per §3.2, plus limits. Called at registration; result is cached and re-checked on config change. |
| `listModels()` | required | Returns model list with per-model limits and capabilities. MAY be a static list for providers without a discovery endpoint. |
| `generate(request, ctx)` | required | Single completion. Returns text plus usage metadata. MUST honor `ctx.signal`. |
| `stream(request, ctx)` | required | Async iterator of deltas. MUST surface the same terminal states as `generate` (done, error, cancelled). |
| `cancel(handle)` | optional | Best-effort abort. Absence means the runtime waits for the request to settle (`AGENT_RUNTIME.md` §6.2). |
| `countTokens(text)` | optional | Estimator. Absent → §3.4 estimation. |
| `validateConfig(cfg)` | required | Rejects unusable configuration with an actionable reason before any call. |

Rules for every method:

- Timeouts are enforced by the runtime wrapper, so a hung provider cannot occupy a task forever (§5.2).
- Errors are translated into the taxonomy in §3.5; raw provider bodies are preserved in the audit record with
  secrets stripped (`SECURITY.md` §14).
- A provider must not be able to alter the tool set, permission state, or approval outcome of a task.
- Adapters must not persist conversation content outside the request unless a provider-side feature (caching,
  file storage) is explicitly enabled by the user.

### 3.2 Capability descriptor

Declared per model, not per provider, because models inside one provider differ.

```
{
  contextWindow, maxOutputTokens,
  supports: { streaming, toolCalling, parallelToolCalls, systemRole,
              structuredOutput, imageInput, audioInput, reasoning,
              promptCaching, jsonSchemaValidation },
  cancellation: "supported" | "best-effort" | "unsupported",
  rateLimits: { rpm, tpm } | null,
  cost: { promptPerMTok, completionPerMTok } | "free-tier" | "local" | null,
  batching: { maxRequestsPerSecond } | null
}
```

Contract rules:

- Unknown fields fail closed: an unparsable descriptor disables the provider rather than defaulting everything on.
- A declared-but-broken capability is a bug to fix in the adapter, not something the runtime papers over.
- Capability claims are verified by the conformance suite (§7). An adapter that claims `toolCalling` without
  passing the tool-calling conformance test must fail CI.

### 3.3 Provider families and initial targets

Recommended shape: **implement families, not N vendors.** Most services speak an OpenAI-compatible API, so one
adapter covers a large part of the free-tier landscape, and vendor-specific adapters exist only where the API
genuinely differs.

| Adapter | Serves | Initial release | Notes |
| --- | --- | --- | --- |
| `openai-compatible` | OpenAI-compatible endpoints, including Groq, OpenRouter, Together, Fireworks, LM Studio, vLLM, Ollama's compatibility layer, GitHub Models | Yes | Base URL + key + model name; covers most free tiers with no Crabby code change |
| `ollama` | Local models on Linux/macOS/Android | Yes | Native API for model listing and pull state; local inference path |
| `llama-cpp-server` | `llama-server`, local GGUF | Optional | Depends on the user running the server; no bundling decision here |
| `anthropic` | Claude APIs | Yes (message format, tool use) | Different system-role and tool-block semantics justify a dedicated adapter |
| `gemini` | Google AI / Vertex | Yes | Distinct streaming and safety metadata |
| `openai-compatible` **user-defined** | Any endpoint the user points at: base URL + API key + model name | **Yes — required** | Accepted in D-041. First-class feature, not a workaround: a user must never need a Crabby code change or a released preset to attach an endpoint |
| `generic-http` (non-OpenAI-shaped template) | Anything else via a user-supplied request template | No | Rejected (O-033 closed): a user-authored request/response template is its own security review, and `openai-compatible` already covers the practical cases |
| `mock/fake` | Deterministic test provider | Yes | Required so tests never hit live APIs (`SECURITY.md` §17) |

Two distinct things, deliberately separated:

- **Bundled presets** (O-028, accepted as the lean set — D-042): `groq`, `openrouter`, `ollama`, `anthropic`,
  `gemini`, `mock/fake`, plus `openai-compatible` used with a user-supplied base URL. Presets exist only to
  pre-fill a display name, a default base URL, and a known model list; they carry no privileged behavior.
- **User-defined endpoints** (D-041): anything OpenAI-compatible can be attached by the user without a release.
  A custom endpoint is subject to exactly the same validation, capability rules, tier policy, and credential
  handling as a bundled one — it gains no extra trust and no exemption.

Custom-provider requirements:

- Configured through `crabby provider add` or configuration, never through an agent-requested change
  (`config.write` is T3, `PROVIDERS_AND_TOOLS.md` §4.2).
- Required fields: name, base URL, model name(s); key supplied by reference to the vault (`§3.7`), never inline in
  a conversation or an ordinary config file.
- Base URL validation: absolute `http(s)` URL, no embedded credentials in the URL, and a clear warning if the
  host is not loopback while the key would be sent over plain HTTP.
- Connecting a custom endpoint sends task context to a third party chosen by the user; that is the user's
  decision to make, and the model/provider in use MUST be visible on every interface during the task.
- A custom endpoint may not declare itself exempt from timeouts, output caps, or approval tiers, and its declared
  capabilities are treated as unverified until the conformance check for §3.2 passes or the user overrides them
  knowingly (§3.8).

Local inference **on** Android (running a model inside Termux) is a separate question from talking to a local
server, and is not promised — device capability, storage, and thermal limits decide it.

### 3.4 Context limits and budgeting

- The runtime computes a token budget from the model descriptor minus reserve-for-output, and constructs context to
  fit (`AGENT_RUNTIME.md` §8).
- Without `countTokens`, estimation uses the documented heuristic `max(chars / 4, grapheme clusters × 1.35)`,
where the cluster count comes from `Intl.Segmenter` (O-031 closed by D-064). The second term exists because a
character ratio calibrated on English over-counts Bengali and other Indic scripts — measured here, `দিয়েছি` is 7 code
units but 3 clusters. The estimate is reported as an estimate, never as a measurement, and a screen that shows one
labels it `estimated` rather than dimming it.
- On approaching the ceiling the runtime compacts (hybrid compaction, D-027); on provider-reported context overflow
  it retries once after compaction, then surfaces the failure rather than silently truncating mid-task.
- Per-provider limits live in configuration and in the descriptor; the smaller of the two wins.

### 3.5 Error taxonomy (shared, provider-independent)

| Class | Meaning | Retryable | Notes |
| --- | --- | --- | --- |
| `auth` | Bad or expired credential | No | Message must name the credential, never show it |
| `rate-limit` | 429 / quota window | Yes, with backoff honoring provider hints | Surface remaining quota when provided |
| `overloaded` | 5xx, capacity | Yes, bounded | Escalate after N attempts |
| `timeout` | Deadline exceeded | Yes, bounded | Distinguish connect vs first-token vs stall |
| `context-overflow` | Request too large | Only after compaction | §3.4 |
| `unsupported-capability` | Model refused a feature it claimed | No | Flag the descriptor for review; report to user |
| `invalid-response` | Unparsable, truncated, or schema-violating output | Sometimes | Keep the raw fragment in audit, redacted |
| `content-filter` | Provider safety refusal | No | Distinguish from a model failure |
| `billing` | Out of credit / paid tier required | No | Especially important given free-first expectations |
| `cancelled` | Abort requested | No | Terminal, not an error worth retrying |

The per-class retry schedule is fixed by D-064 (O-029 closed): attempts wait `1s, 2s, 4s, 8s, 16s` with ±25%
jitter, and a provider-supplied `Retry-After` (or a Telegram `retry_after`) **overrides the schedule upward** for
that attempt rather than being treated as a suggestion. Jitter is not decoration: a fleet of phones on one free
tier that retries in lockstep manufactures its own outage.

### 3.6 Selection, routing, and fallback

- The user selects a default model and may pin a model per task or per interface session; per-task pinning wins.

**Retry-then-ask ladder (D-043, D-044).** When a model call fails, the runtime walks exactly one sequence, and
every stage is observable to the user:

```
Stage 1  Same model, same provider
         retry the failed call, up to 5 attempts with backoff
         (transient classes only: rate-limit, overloaded, timeout,
          invalid-response that is plausibly partial)
   |
   |  still failing, budget exhausted
   v
Stage 2  Ask the user — do NOT switch silently
         "Which model should Crabby use instead?"
         offer: other models on the same provider, then models on
         other configured providers; each option labeled with its
         provider, capability deltas, and cost class
   |
   |  user selects
   v
Stage 3  Resume from the checkpoint
         the task does NOT restart; completed steps stay completed
```

Stage 1 rules:

- **5 attempts is a floor, not a ceiling**, and it is configurable; it applies *per failing stage*, so recovering
  and then hitting a new error starts a fresh budget rather than continuing a spent one.
- Retries obey the per-class policy (O-029 closed by D-064): honor a provider `Retry-After` when present, always with jitter, and
  never retry a non-retryable class (`auth`, `billing`, `content-filter`, `cancelled`, denied permission).
- A retry re-issues the **failed call only**. It never re-runs earlier steps, and it never re-sends an action whose
  side effect is already recorded as complete.

Stage 2 rules:

- Automatic provider/model switching on `rate-limit`/`overloaded` is **off by default** (O-030 closed as D-043):
  the user is asked, because switching changes who sees the data — a privacy decision, not a reliability detail.
- The prompt must name the destination of the candidate (provider + host) and any capability loss. Selecting an
  alternative from the prompt counts as the user's approval for that switch, recorded on the task.
- A pre-approved automatic ladder MAY be configured per identity (e.g. "on `rate-limit` only, fall back to
  model X"); it may not extend to classes that change cost or data destination.
- `billing` never triggers a switch attempt: the task stops and reports, because cycling spends money the user did
  not authorize (§5.2).
- No capability downgrade may be silent. If the chosen model lacks `toolCalling` or a smaller context window, the
  runtime states it and re-plans only what the budget requires.

Stage 3 rules:

- Switching models or exhausting retries **must not restart the task from scratch**. Work already completed
  remains complete; execution continues from the saved checkpoint and the pending step that failed.
- If a step's external effect is uncertain, the recovery rules of `AGENT_RUNTIME.md` §7.3 apply unchanged —
  Crabby reconciles or asks, it does not blindly repeat.
- The task record must show the switch: original model, chosen model, reason, stage reached, and whether any step
  was re-attempted.
- Where a conversation was generated partly on one model and continues on another, the context is re-budgeted for
  the new limits, and the user can see that happened.

Timeouts are per call, not per task: a slow model that keeps responding within its per-call deadline is not
retried merely because the overall task is long.

### 3.7 Credential handling

Provider credentials are secrets under `SECURITY.md` §7 and D-031: they are supplied once, stored in the vault, and
referenced by name in configuration — `provider.groq.key = vault://groq`. Adapters receive a handle that yields the
value at call time; the agent never reads it, and it never enters model context (`SECURITY.md` §7).

### 3.8 Per-model capability override by the user

Provider-reported capabilities are a **starting point, and the user may override any of them for any model**
(D-045) — bundled or custom, discovered or static.

Override record (stored per model id in user configuration, not inside the adapter):

| Field | Meaning |
| --- | --- |
| `reported` | The descriptor the provider/adapter supplied, kept for reference and drift reports. |
| `overrides` | Only what the user changed. |
| `limits` | User-set `contextWindow`, `maxOutputTokens`, `reserveForOutput`. |
| `supports.<flag>` | Forced `true` / `false` / `auto`. |
| `source` | `manual` \| `preset` — how it got there. |
| `notes` | Free text, e.g. "endpoint is a proxy, reports no tool support but works". |

Rules:

- Highest specificity wins: **user override → bundled preset → provider discovery → adapter default.**
- Overrides are per model *and per provider endpoint*, because the same model name behind a proxy is not the same
  capability set.
- Forcing a capability **on** is a trust decision with a cost: the runtime still verifies at call time, and when a
  forced-on capability fails, Crabby must report "`toolCalling` was declared by override and failed" rather than
  fall back silently. That failure feeds §3.5's `unsupported-capability`.
- Forcing a capability **off** is always allowed and never argued about — that is the user's fastest lever for a
  misbehaving endpoint.
- Changing a context ceiling affects budgeting (§3.4) immediately and is reflected in the TUI/Web provider screens.
- Editing overrides is a configuration change: `config.write`, T3 (`SECURITY.md` §6.2) — an agent must not be able
  to widen its own model capabilities by editing this.
- `crabby model list` shows model, provider, effective capability set, and which entries are overridden;
  `crabby model edit <provider>/<model>` is the single entry point, mirrored in the Web UI and the TUI.

### 3.9 Resume and re-attempt semantics (shared with the runtime)

The retry ladder and provider switching both land on one rule, which `AGENT_RUNTIME.md` §7 already owns for
restarts:

- A task resumes at the boundary between completed and pending work, never at step 1.
- Task progress is authoritative from recorded state, not from what a model believes it had done
  (`AGENT_RUNTIME.md` §10.1).
- Re-entry into a step is allowed only when the step is retryable and its side effects are known-safe, or when
  `idempotent`/`sideEffects` metadata (§4.1) says so.
- If the new model cannot satisfy a pending step (e.g. no tool calling), the step is marked blocked with a reason
  and the user chooses: skip, adapt, or approve a different model — instead of the runtime restarting everything.

## 4. Tool Architecture

### 4.1 Tool contract

Every tool — native, first-party, or discovered via MCP client — is described by one record:

| Field | Purpose |
| --- | --- |
| `id`, `version` | Stable identifier; MCP tools are namespaced `mcp:<server>:<tool>`. |
| `description` | Model-visible. Untrusted text if it came from an MCP server (`SECURITY.md` §10). |
| `inputSchema` | Validated before policy evaluation; malformed arguments are rejected pre-execution. |
| `outputSchema` | Optional; enables verified structured results. |
| `capability` | Required permission from `SECURITY.md` §6.1 vocabulary. |
| `riskTier` + `tierRules` | Base tier and the argument-dependent escalations (§4.3). |
| `limits` | Timeout, max output bytes, max files, max processes. |
| `idempotent` | Whether re-running is safe — directly used by recovery (`AGENT_RUNTIME.md` §7.3). |
| `sideEffects` | `none` / `local` / `external` / `irreversible`. |
| `availability` | Platform predicate; false yields a documented reason instead of a broken tool. |

Registration rules: duplicate id is fatal at startup; a tool with an unparsable schema cannot register; `describe`
output is versioned with the API contract so all four interfaces can render it consistently.

### 4.2 Initial tool set with risk-tier assignment (closes O-020)

Tiers are per `SECURITY.md` §6.2. "Approval" means the default policy for a fresh install; users may tighten, and
may relax only where a floor exists (T3 has no relaxation path in the first release).

| Tool | Capability | Base tier | Escalation / notes |
| --- | --- | --- | --- |
| `file.read` | `fs.read:<root>` | **T0** | Within workspace. Denied outright on the `SECURITY.md` §8 sensitive deny-list even at T0 — reading `~/.ssh` is not a "read" operation. |
| `file.list` / `file.stat` | `fs.read:<root>` | **T0** | Same deny-list applies to names. |
| `file.write` (new file) | `fs.write:<root>` | **T1** | New paths inside root. |
| `file.edit` (existing) | `fs.write:<root>` | **T1** | Bumped to **T2** when overwriting a file Crabby did not create. |
| `file.delete` | `fs.write:<root>` | **T2** | **T3** outside the workspace, or on the deny-list, or recursive on directories. Prefer trash/rename. |
| `file.move` | `fs.read` + `fs.write` | **T1** | **T2** across roots or onto an existing target. |
| `fs.search` | `fs.read:<root>` | **T0** | Content search results are untrusted data. |
| `session.list` / `session.read` | `session.read` | **T0** | |
| `session.rename` | `session.write` | **T1** | |
| `task.create` | `task.create` | **T1** | **T2** if the new task itself carries T2 steps; the task inherits its own tier, it does not inherit the caller's. |
| `task.status` / `task.history` | `task.read` | **T0** | |
| `task.cancel` | `task.cancel` | **T1** | **T2** for cross-session or "cancel all"; per `ARCHITECTURE.md` §10. |
| `config.get` | `config.write`-independent read | **T0** | Secret *names* only, never values. |
| `config.set` | `config.write` | **T3** | Includes changing permissions, roots, or retention. |
| `tunnel.status` | read-only | **T0** | |
| `tunnel.enable` / `tunnel.stop` | `tunnel.enable` | **T3** | Must list which paired identities become reachable (`SECURITY.md` §13). |
| `ext.list` / `ext.info` | read-only | **T0** | |
| `ext.install` | `ext.install` | **T2** | Content-only kinds. |
| `ext.install` (executable kind) | `ext.execute` | **T3** | Blocked in the first release regardless of tier (D-038). |
| `ext.uninstall` | `ext.install` | **T2** | `--purge-data` is **T3**. |
| `mcp.connect` / `mcp.tools` | `ext.install` | **T2** | Shows exact command line or URL. |
| `net.fetch` | `net.egress:<host>` | **T2** | **T1** only for a user-curated allow-list; response is untrusted content. |
| `http.request` (non-GET) | `net.egress` | **T2** | Any method that mutates remote state; carries destination host in the approval text. |
| `provider.invoke` | `provider.invoke` | **T1** | **T2** when the selected model is paid (`provider.billing`). |
| `shell.run` | `shell.run` | **T2** per command | Capability itself is off by default. Tier computed per command, not per tool; escalation table in §4.3. |
| `shell.run` (elevated) | `shell.privileged` | **T3** | Package install/remove, service control, system config. |
| `process.spawn` / `process.list` | `shell.run` | **T2** / **T0** | Long-running processes must be cancellable and re-attachable after restart. |
| `memory.save` | `memory.write` | **T1** (confirmed) | Auto-memory is T1; a memory whose content originates from untrusted external material stays **T2** until the user confirms — writing injection text into durable memory is the poisoning path (`SECURITY.md` §10). |
| `memory.search` | read-only | **T0** | |
| `memory.delete` | `memory.delete` | **T2** | **T3** for bulk or "forget everything about X" (see `docs/DATA_AND_MEMORY.md` §7). |
| `history.export` | `session.read` | **T2** (confirmed) | Leaves the controlled store; may contain third-party content and secrets that were quoted into messages. Redaction runs before the file is written (§4.4). |
| `history.deleteConversation` | `session.write` | **T3** | Irreversible relative to derived memories. |
| `notify.send` (Telegram out) | `net.egress` | **T2** | Sending to a new recipient is T2; publishing is T2/T3 by audience size. |
| `git.read` (`status`/`diff`/`log`) | `fs.read` | **T0** | Read-only, inside repo root. |
| `git.commit` | `fs.write` | **T1** | Local, reversible. |
| `git.push` | `net.egress` | **T2** | **T3** with force, or to a protected branch. |
| `termux-notify` | `device.notify` | **T1** | Benign; no data leaves the device. |
| `termux-sms-send` | `device.sms` | **T3** | D-033. |
| `termux-contact-list` | `device.contacts` | **T3** | Disclosure into context is the risk (`EXTENSIONS.md` §15 area, `SECURITY.md` §15). |
| `termux-camera-photo`, `termux-location`, sensor read | `device.camera` / `device.location` / `device.sensor` | **T3** | D-033, per-capability enablement. |
| `termux-battery-status`, `termux-wifi-connectioninfo`, `termux-torch`, `termux-vibrate` | `device.sensor` / `device.control` | **T1** | Low consequence; still opt-in per capability. |
| `cron.schedule` | `config.write`-adjacent | **T2** | Confirmed: creating a timer is T2, and every step inside the job is still evaluated against policy **each time it runs** — a schedule never inherits or pre-buys approval. Editing an existing job to add T3 steps, or changing what it targets, is **T3**. See §4.5. |
| `screenshot` / `clipboard.read` | `device.screen` / `device.clipboard` | **T2** | Clipboard is a notorious secret carrier; reading it deserves to be visible. |
| `clipboard.write` | `device.clipboard` | **T2** | |

**Deferred** (specified later, not implied available): image generation, TTS/STT, browser automation, GUI
automation, database tools, k8s/docker control. Each must arrive with its own tier entry before it can register.

### 4.3 Argument-dependent escalation

Tier is computed per call, from the validated arguments:

- `shell.run` — a static command classifier maps argv to a tier. Known-destructive patterns (`rm -rf`, `dd`,
  `mkfs`, `:(){:|:&};:`, force pushes, `chmod -R 777`, curl-pipe-shell) → **T3**. Read-only commands inside the
  workspace (`ls`, `cat`, `grep`, `git status`) → **T0/T1**. Everything else → **T2**. The classifier is *friction
  and information*, not a boundary: the boundary remains capability + approval (`SECURITY.md` §9). The table lives
  in-tree and is versioned with the release (O-032 closed by D-066); it is deliberately not updatable by a skill.
- Redirection, command substitution, and `;`/`&&` chains force a re-evaluation of the *whole* chain — a `T0`
  command with a `> ~/.bashrc` redirect is a write.
- `file.*` — escalation by resolved path after symlink resolution.
- `net.fetch` — escalation by destination: any host not in the allow-list is T2 with the host named in the prompt.
- New provider model discovered → its descriptor is re-validated; a capability that vanished since registration must
  produce `unsupported-capability`, not a silent degradation.
- Any tool receiving arguments it did not declare → reject before policy, so a schema mismatch can never be
  mistaken for permission.

### 4.4 Execution rules

- Order of checks, always: schema validation → capability check → tier/approval → execution → result validation.
  A tool never runs "to see if it works".
- Every execution carries: timeout, output byte cap, and a cancellation signal. On Termux, spawn in a process
  group so a kill reaches children (`SECURITY.md` §9).
- Child environment is an explicit allow-list; the parent's provider keys are not inherited.
- Temp files live in a per-task scratch directory with a documented lifetime and automatic cleanup on task end,
  with leftovers reported rather than silently retained.
- Results above the cap are truncated *and labeled*; a tool must not pretend a partial result is complete.
- Output is delivered to the model as delimited, attributed, untrusted content (`SECURITY.md` §10).

### 4.5 Scheduled and background work

A timer is the one feature that can quietly turn "one approval" into "approval forever", so the rules are explicit:

- Scheduling is authorized for *the job as described at creation time*. Any material change to its steps, targets,
  recipients, or model/provider crosses into re-approval (§4.3, `SECURITY.md` §6.3).
- Every execution of a scheduled job is a fresh policy evaluation: capability check, tier check, and — for T2/T3
  steps — an approval request delivered through the interfaces at run time, not at schedule time.
- If a scheduled run cannot obtain approval within its window, it stops and records "waiting on approval"; it must
  not proceed unattended. Unattended runs are only possible for steps whose tier and grants already permit them.
- A job inherits no ambient authority from the user who created it beyond its own recorded capability set, and it
  runs under the identity that created it, so audit records name a person rather than "cron".
- Jobs are cancellable like tasks (`task.cancel`), and a paused/unlocked vault (§3.7) means the job defers with a
  visible reason rather than failing opaquely.
- On a device that killed Termux overnight, jobs are evaluated against their recorded schedule and must not fire a
  burst of backlogged runs on resume without telling the user.

## 5. Capability Negotiation

### 5.1 What the model is allowed to see

The tool list presented to a model is the intersection of: registered tools ∩ tools the *current task's* identity
holds capability for ∩ tools available on this platform ∩ tools whose declared minimum host version is satisfied.
Hidden is better than failing: a tool the user has not enabled should not appear, so the model does not spend a
turn being denied — except that any capability the user *did* grant must be visible, so the model cannot invent an
excuse to skip it.

### 5.2 Limits and budgets

Enforced by the core, never by the caller (`SECURITY.md` §12): per-task step limit, wall-clock timeout, tool-call
count, output bytes, parallel steps (D-023), provider request rate, and a token budget with an optional cost
ceiling. When a limit trips, the failure names the limit and how to change it.

## 6. Approval Interaction

Tools and providers do not implement approval UI. They emit an approval request with the fields required by
`SECURITY.md` §6.3, and the Approval Service handles delivery to all four interfaces, timeouts, and binding.

Provider-specific things an approval prompt must carry, because they change what the user is agreeing to: the
destination host for `net.fetch`/`http.request`, the resolved path for `file.*` outside scratch, the exact argv for
`shell.run`, the recipient for `notify.send`/`termux-sms-send`, and the *model + provider* whenever a task would
fall back across a privacy boundary (§3.6).

## 7. Testing Requirements

- **Provider conformance suite:** one shared test set every adapter must pass — capability declaration accuracy,
  streaming terminal states, cancellation semantics, error mapping for each §3.5 class, and correct rejection of
  invalid config. `mock/fake` implements it too, as the reference.
- **No live APIs:** all core and security tests run against the fake provider; a separate opt-in suite may hit real
  endpoints and must never be required for a green build.
- **Tier assignment tests:** per tool, at least one allow case, one deny case, and one escalation case per §4.3
  rule; plus a test proving an unclassified tool cannot register.
- **Escalation tests:** `ls > ~/.bashrc` is a write; `git push --force` is T3; a symlinked path resolves outside
  the root and denies.
- **Idempotency metadata tests:** recovery consults `idempotent`/`sideEffects`, so a wrong declaration must be
  detectable — declare `irreversible` and the runtime must refuse blind retry.
- **Budget tests:** every limit in §5.2 fires with an actionable, named error.
- **Termux run:** the whole suite on the primary platform, including the local-server providers, because "works on
  CI Linux" is not the target (`SECURITY.md` §17).

## 8. Open Decisions

Tracked in `DECISIONS.md`:

- ~~**O-020**~~ — **closed.** §4.2 is the accepted assignment for the initial tool set, with the three judgement
  calls confirmed as: `memory.save` T1 (external-content memory T2), `cron.schedule` T2 with runtime per-step
  approval (§4.5), `history.export` T2.
- ~~**O-028**~~ — **closed as the lean set** (D-042): `groq`, `openrouter`, `ollama`, `anthropic`, `gemini`,
  `mock/fake`, plus user-defined `openai-compatible` endpoints (D-041) rather than a wide preset catalogue.
- ~~**O-029**~~ — **closed (D-064).** `1s, 2s, 4s, 8s, 16s` ±25% jitter inside the D-043 floor; `Retry-After` wins.
- ~~**O-030**~~ — **closed** (D-043): no silent switching; the user is asked. A per-identity pre-approved narrow
  ladder is the only exception.
- ~~**O-037**~~ — **closed (D-064).** An editor screen, not a prompt chain: `crabby model edit` opens the field
  editor, per-field prompts remain available for scripting, and the Web and TUI render the same fields from the
  and TUI. Same data model either way — one prompt per field would make the CLI the only interface that can do this,
  which is the parity rule in reverse.
- ~~**O-038**~~ — **closed (D-064).** Allowed as an explicit bulk action that repeats the warning per affected model,
  never as a default. A provider-wide override that reports as one line is a drift report that hides its own size.
- ~~**O-031**~~ — **closed (D-064).** `max(chars/4, clusters × 1.35)`, always labeled `estimated` (§3.4).
- ~~**O-032**~~ — **closed (D-066).** The ruleset above is the initial table; it ships in-tree and is versioned with
  the code. Updatable-by-skill was rejected on one ground: a table that decides whether a command needs a human is an
  extension point, and D-038 does not hand extension points to the thing they gate.
- ~~**O-033**~~ — **closed as rejected:** user-authored request templates are out; D-041 covers the practical cases.
- ~~**O-034**~~ — **closed (D-066).** Documented unsupported on Android, supported only via an external server the
  user runs — which is what §3.3 already assumes, so the decision is to say the quiet thing out loud in the README
  rather than let a user discover it as a crash.
- ~~**O-035**~~ — **closed (D-064).** 64 KiB inline; the rest to the session scratch directory with the path
  printed, so the file is discoverable rather than assumed. Scratch files older than 24 h are pruned at startup
  and the prune is logged, because an invisible delete in a tool that also has `rm` is a bad precedent.

## 9. Acceptance Criteria

This specification is ready for implementation planning when:

01. The provider contract has a versioned schema and a reference implementation (`mock/fake`).
02. Every capability the agent loop depends on is either in the required set or explicitly optional with a defined
    degradation.
03. §4.2 is confirmed as the initial tool list, and every entry has a capability, a tier, escalation rules, and an
    idempotency/side-effect declaration.
04. Tier floors and the no-relaxation rule for T3 are enforced in code, not convention.
05. Fallback privacy semantics (§3.6) are accepted.
06. The conformance suite exists before a second real adapter is written, so adapters are verified rather than
    trusted.
07. `DECISIONS.md` records §8 items with the correct status, and `SECURITY.md`'s capability vocabulary covers every
    tool listed here — no tool may request a capability the security document does not define.

---

**End of Providers and Tools Specification**
