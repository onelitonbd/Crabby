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

**Implemented in M2l (D-100): `openai-compatible`.** `createOpenAiCompatibleProvider` in `packages/providers` is the
first product adapter, and it is this row rather than a vendor's because §3.3's own reasoning is "implement families, not
N vendors": one adapter serves Groq, OpenRouter, Together, Fireworks, LM Studio, vLLM, Ollama's compatibility layer,
GitHub Models and D-041's user-defined endpoint, and a **preset is the same adapter with a name, a base URL and a model
list** — the constructor takes an `id`, so `groq` and a user's own endpoint differ in nothing that could behave
differently. What the user supplies is §3.3's three required things plus a §3.2 descriptor per model, because that is the
part no endpoint in this family serves: `GET /models` returns ids and nothing else, so discovery would produce exactly
what the conformance suite refuses — a model `listModels()` names whose limits are unknowable. What the adapter does with
a call is §3.1's contract and §3.5's taxonomy, and what it does with a configuration is the "Custom-provider
requirements" list below, implemented once in `packages/providers/config.ts` and called by the fake too, so the reference
adapter and the product adapter cannot drift apart on the rules a user's endpoint is checked against.

**Implemented in M4: `anthropic`, `gemini`, `ollama` (D-133).** The other three families now compose, each because it
differs genuinely and each passing §7's conformance suite over a scripted loopback server — no live key anywhere, per
§7's own rule. `anthropic` (Messages API): `system` hoisted to a top-level field, `max_tokens` defaulted from the
descriptor the user already declared, tool calls as `tool_use` blocks with results as `tool_result` in a user turn,
typed SSE events, a `stop_reason` table whose unknown values are `invalid-response` rather than a guessed terminal, and
the key on `x-api-key`, never a URL. `gemini` (`generateContent`): `parts` grammar with `user`/`model` roles, a tool
result as a `functionResponse` carrying the tool's **name** resolved from the proposing turn, `SAFETY`/`RECITATION` →
`content-filter`, and the key on `x-goog-api-key` even though the quickstart puts `?key=` on the URL — a credential in a
URL is a credential in access logs (G1-03). `ollama` (native `/api/chat`): NDJSON streaming, `done_reason` table,
`num_predict` from the descriptor, a `tool_name` on each result. **The native listing (`/api/tags`) is a named
non-goal**: §7's suite asserts D-100's rule — a model `listModels()` names with no descriptor has unknowable limits —
and `/api/tags` names models without pricing them, so `listModels()` is the declared, priced set; surfacing the
machine's installed names is a contract change (a discovery row on `Provider` or a screen beside the descriptor store),
recorded in D-133's remainder, as is pull state (`/api/pull`, `/api/ps`), for the reason a fifth method bolted onto one
adapter is a second opinion about what the boundary is. `mock` stays refused at composition (§17): a task must not
reach `completed` with no model behind it.

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
  **The configuration half is built (M2m, D-101); the verb is still M4's.** `provider.<id>` in `config.json` is §3.7's
  own namespace, and `packages/providers/compose.ts` turns an entry into an adapter. What composes is an entry that needs
  no secret: an inline key never validates, because this section's rule cannot be enforced after a mode-`0644` file
  exists, and a `vault://` reference is refused at composition with the reason §3.7 gives below. `mock` is refused from
  configuration although this section lists it as a preset — `SECURITY.md` §17 makes it a test instrument, and a task that
  completed on it would be the demo this phase has refused to ship.
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
labels it `estimated` rather than dimming it. Implemented as written in `packages/agent-runtime/context.ts`, and
implemented *as written* rather than repaired on the way: the formula's cluster term is never the smaller one, so
every estimate in this build is conservative by roughly a factor of five — which errs toward compacting early
rather than toward an overflow mid-task (D-115; O-075 records that coefficient as a question, not a bug).
- On approaching the ceiling the runtime compacts (hybrid compaction, D-027); on provider-reported context overflow
  it retries once after compaction, then surfaces the failure rather than silently truncating mid-task.
- Per-provider limits live in configuration and in the descriptor; the smaller of the two wins.
- **The compaction threshold and the verbatim tail are configuration, not code**: `limits.context.compactAt` (a
fraction of the derived budget, default `0.8`, schema-capped below `1` because compacting *after* the ceiling is
worse than not compacting) and `limits.context.verbatimTurns` (the most recent turns that stay as they are,
default `6`). A fraction rather than a token count is the only form that is right for every model, since the
budget it applies to differs by three orders of magnitude between descriptors. `limits.context.summaryModel`
spells the `<provider>/<modelId>` that writes a summary and has **no default**: absent, the run's own model does
it, which is a default rather than a switch. A failed summary retries once and then surfaces the failure — the
same rule this section gives a provider-reported overflow, applied at the budget instead of after it
(D-113, D-115). **Where it runs**: the runtime asks before it builds a request, on every provider call, so a
conversation that outgrows its window is summarized while it still can be (D-117). The overflow rule above is
the backstop for an estimate that was wrong rather than the primary path: one retry after compaction, spent
once per call, then the failure is surfaced. A loop with no context manager wired — no Gateway, or no
summarizer resolved — keeps growing and reports `context-overflow`, because trimming a conversation to stay
under a limit is §2.5's "silently replace or destroy" wearing a feature's name.

### 3.5 Error taxonomy (shared, provider-independent)

| Class | Meaning | Retryable | Notes |
| --- | --- | --- | --- |
| `auth` | Bad or expired credential | No | Message must name the credential, never show it |
| `rate-limit` | 429 / quota window | Yes, with backoff honoring provider hints | Surface remaining quota when provided |
| `overloaded` | 5xx, capacity | Yes, bounded | Escalate after N attempts |
| `timeout` | Deadline exceeded | Yes, bounded | Distinguish connect vs first-token vs stall. Since M2l the error carries which one tripped as a `deadline` field, plus `absolute` for D-074's fourth row — the budget the *runtime* supplies and the adapter reports (D-100), because "the endpoint never answered" and "the call ran out of budget" are different facts with different ladder behaviour. |
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
- **The ask and the switch are built (D-044, the thirty-ninth slice).** A retryable class that spends the budget stops the
  run in `awaiting_approval` with **no approval row** — the state, with nothing in the queue to approve, is what says a
  human must act — and appends `provider.switch.proposed`, carrying the attempts spent, the budget, the class, the pair the
  run was on, and each candidate labelled with its provider, its cost class and the capabilities choosing it would lose.
  The same facts ride on the transition frame's payload, so a client that filters event families still learns why the task
  stopped (§5.2's retrievable-by-polling rule). `billing` and every other non-retryable class still stops and reports, and
  the prompt is offered only on the two the ladder exists for: switching cannot fix a rejected key.
- **The ordering disagreement is resolved in the only direction §4.1 allows.** Stage 2 happens *before* the task is failed,
  because `AGENT_RUNTIME.md` §4.1 makes `failed` terminal and absorbing and no resume travels backwards out of it
  (`docs/CONSISTENCY_REVIEW.md` F-50): the run that spent its ladder stops in a state it can be woken from, and `failed`
  now means the class was not worth asking about.
- The answer is `POST /api/v1/tasks/{id}/resume` (`docs/INTERFACES_AND_API.md` §4.3), with an empty body meaning "the same
  model again". The run continues from the boundary it had reached — the committed messages travel with it, so no step runs
  twice — and the record carries what stage 3's second rule asks for: `model` is the chosen pair, `modelSwitch` carries the
  original pair, the reason, `stage: 2`, `reAttempted: false` and the attempts spent, with §14's `by`/`via` beside it, and
  `provider.switch.accepted` goes into the log because the selection counts as the user's approval for that switch.
- **What the answer reaches is one process's run.** The messages a resume continues from live in the runner's memory, so a
  task whose ask was parked by a process that has since ended is `interrupted` (§7.1) rather than resumable, and
  `docs/CONSISTENCY_REVIEW.md` F-47's cross-process rebuild — which would rebuild them from D-095's checkpoint — is what
  closes that half. The candidate label does not carry a **host**: §3.2's descriptor describes a model, and the `Provider`
  interface exposes no endpoint, so naming a destination host is part of what a rebuilt descriptor would have to add. What
  it does carry is the provider id and every loss, which is the pair of facts the sentence above asks for minus the host.
- **What moves an unanswered ask is not priced by anything yet.** No document gives the ask a deadline (D-064's window is
  an approval row's, and the ask has no row) and no interface inventory gives it a decline verb, so today the ask waits —
  like D-086's refusal pause — until it is answered, cancelled, or marked `interrupted` by a restart. That gap is recorded
  as `DECISIONS.md` O-073 rather than settled here.
- Where a conversation was generated partly on one model and continues on another, the context is re-budgeted for
  the new limits: every count after the switch asks the provider the user chose. The user sees it happen in the switch
  recorded on the task and in the log, and the capability losses were named at the prompt before they were chosen.

Timeouts are per call, not per task: a slow model that keeps responding within its per-call deadline is not
retried merely because the overall task is long. The per-call numbers are the defaults in §5.2 (D-074); a slow model
is normal operation, a stalled stream is not.

### 3.7 Credential handling

Provider credentials are secrets under `SECURITY.md` §7 and D-031: they are supplied once, stored in the vault, and
referenced by name in configuration — `provider.groq.key = vault://groq`. Adapters receive a handle that yields the
value at call time; the agent never reads it, and it never enters model context (`SECURITY.md` §7).

**What this build does instead, stated rather than glossed (M2l).** There is no vault code: `crabby doctor` checks the
directory's existence and mode, `GET /health` reports `vault: { managed: false }` rather than claiming a lock it cannot
show, and nothing resolves a `vault://` reference. Since M2m that absence is also a
refusal a user meets: `packages/providers/compose.ts` declines to compose an entry whose `key` is a `vault://` reference
and names the milestone that changes the answer (D-101), because an adapter composed with a dropped credential answers
`401` from the endpoint and reads as a broken network rather than an absent subsystem. So `ProviderConfig.apiKey` is a plain string and the adapter holds it
for the lifetime of the process. Two duties follow for whoever composes an adapter, and they are the reason this
paragraph exists: the key must never reach a log line (`packages/core/redact.ts` is defence in depth, not the control)
and never enter model context — an adapter that put its own configuration into a prompt would leak the one secret the
product is built to keep on-device. `docs/CONSISTENCY_REVIEW.md` F-56 records the gap and its closing condition, in the
same shape as F-52's: a column and a sentence exist, and the writer that would fill them does not.

### 3.8 Per-model capability override by the user

Provider-reported capabilities are a **starting point, and the user may override any of them for any model**
(D-045) — bundled or custom, discovered or static.

Two things in user configuration, **per provider id and per model id**, and the split is forced rather than chosen
(D-126):

| Where | What |
| --- | --- |
| `provider.<id>.models.<modelId>` | The **reported** descriptor — what the provider/adapter supplied. The adapter's own record, kept for reference and drift reports, and the only copy of it. |
| `provider.<id>.overrides.<modelId>` | The override record: only what the user changed. |

The override record is a **sibling** of the descriptor rather than a field inside it, because §3.2's parser refuses a
descriptor carrying an unknown field: an override written inside the descriptor would disable the very model it was meant
to adjust. Keeping `reported` in its existing place rather than copying it into the override also means drift is the
difference between two adjacent keys, with no second copy that could disagree with the first.

Override record fields:

| Field | Meaning |
| --- | --- |
| `limits` | User-set `contextWindow` and `maxOutputTokens`. **`reserveForOutput` is not stored** — D-064 derives the reserve from `maxOutputTokens`, so a second source for the same number would be a number that could disagree with the first; the parser refuses the key with that reason rather than accepting a value nothing reads. |
| `supports.<flag>` | Forced `true` / `false` / `auto`. `auto` means "no opinion": the reported value stands and nothing is reported as moved. |
| `source` | `manual` \| `preset` — how it got there. Required, because "I typed it" and "a preset shipped it" are different trust statements. |
| `notes` | Free text, e.g. "endpoint is a proxy, reports no tool support but works". |

Composition produces the **effective** descriptor (reported + override, highest specificity first) and every later reader
— `describe()`, budgeting (§3.4), the ask's capability deltas, the interfaces' screens — sees that one value rather than a
stored opinion beside a reported one. What the user changed travels beside it as provenance on the composition result,
never *inside* the descriptor: §3.2's parser would reject such a field, and a provenance field inside a descriptor is a
field a document could set about itself. §3.8's failure sentence below ("declared by override and failed") is the
runtime's use of that provenance, and it arrives with the slice that wires provenance into the loop.

Rules:

- Highest specificity wins: **user override → bundled preset → provider discovery → adapter default.**
- Overrides are per model *and per provider endpoint*, because the same model name behind a proxy is not the same
  capability set.
- Forcing a capability **on** is a trust decision with a cost: the runtime still verifies at call time, and when a
  forced-on capability fails, Crabby must report "`toolCalling` was declared by override and failed" rather than
  fall back silently. That failure feeds §3.5's `unsupported-capability`. **Built (D-128)**, and it is said by the
  **adapter**, which is the only party that knows both halves of the claim — which capability the request used, and which
  capability the user forced on. Three conditions keep it from being a sentence that cries wolf: the capability must be
  one the call **exercised**, the class must mean *the endpoint answered and the answer was not usable* (`overloaded` and
  `timeout` are the endpoint being busy and say nothing about a declared capability), and the forced value must be `true` —
  nothing was sent that needed a capability the user turned off. The error's class, raw body and attempt survive
  unchanged, because the ladder's retry decision and the audit record must not depend on whether a human edited a
  descriptor. What the request can currently exercise is tools and the system role: `ProviderRequest`'s `content` is a
  string and it has no `responseFormat`, so image input and structured output are not expressible yet and the attribution
  does not pretend otherwise.
- Forcing a capability **off** is always allowed and never argued about — that is the user's fastest lever for a
  misbehaving endpoint.
- Changing a context ceiling affects budgeting (§3.4) immediately and is reflected in the TUI/Web provider screens.
- Editing overrides is a configuration change: `config.write`, T3 (`SECURITY.md` §6.2) — an agent must not be able
  to widen its own model capabilities by editing this. A human at a terminal runs as the owner identity (C7-12), so the
  T3 gate is on the *tool*, not on the verb: the refusal that matters is an agent's `config.write`, which D-107 already
  prices at T3, and the override it could write is one of the fields that gate covers.
- An override that does not parse, names a feature the model does not have, or would make the descriptor illegal
  **fails the provider closed**, with the field named. Applying the parts that were understood would leave a user who
  typo'd one flag believing they had raised a context window when they had not (SECURITY.md §2 rule 02).
- `crabby model list` shows model, provider, effective capability set, and which entries are overridden;
  `crabby model edit <provider>/<model>` is the single entry point, mirrored in the Web UI and the TUI. **The Gateway
  serves the same writer (D-134)**: `GET /models` answers effective, reported, override and provenance side by side,
  and `PUT /models/{provider}/{model}/overrides` is this verb over a wire — the record rules and the storage step are
  one implementation in `@crabby/providers` (`override-write.ts`), the CLI binds its layout and the route binds the
  Gateway's, so "both paths reach the same stored value" is enforced by import rather than by discipline. A route that
  duplicated the rules would have been the second writer D-064's sentence exists to prevent.

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
| `limits` | Timeout, max output bytes, max files, max processes; defaults per tool class in §5.2 (D-074). |
| `idempotent` | Whether re-running is safe — directly used by recovery (`AGENT_RUNTIME.md` §7.3). |
| `sideEffects` | `none` / `local` / `external` / `irreversible`. |
| `availability` | Platform predicate; false yields a documented reason instead of a broken tool. |

Registration rules: duplicate id is fatal at startup; a tool with an unparsable schema cannot register; `describe`
output is versioned with the API contract so all four interfaces can render it consistently. A tool whose name is not in
§4.2's registry cannot register either (D-098): §5 of `SECURITY.md` requires every tool to be classified before it may be
exposed, and an executor is the only party that could introduce an unclassified one, so `assertRegistrable` in
`packages/tools` refuses the declaration rather than letting the registry grow a row nobody priced.

**What this build declares (M2k, D-098).** `packages/tools` implements eight of §4.2's forty-five rows — `file.read`,
`file.list`, `file.stat`, `file.write`, `file.edit`, `file.delete`, `file.move`, `fs.search` — and each carries the fields
above that belong to an executor rather than to a registry: `inputSchema`, `limits` (`fsTimeoutMs`, the same 10 s D-074
set for `fs.*`), `idempotent` and `sideEffects`. The four that answer §7.3 and §6.2 are the interesting ones, and they are
not uniform within a family:

- reads (`file.read`, `file.list`, `file.stat`, `fs.search`) — `idempotent: true`, `sideEffects: "none"`.
- `file.edit` — `idempotent: true` (it replaces whole content, so a repeat reaches the same end state and cannot
  compound), `sideEffects: "local"`.
- `file.write`, `file.move` — `idempotent: false`. `file.write` refuses a path that already exists, so a repeat corrupts
  nothing but does not reproduce its outcome either: the first attempt returns ok and the second returns `exists`, and a
  resume that cannot tell which it is looking at has no business passing the step.
- `file.delete` — `idempotent: true` **and** `sideEffects: "irreversible"`, which is not a contradiction but the two
  questions §4.1 asks: `sideEffects` answers whether the user's data can be got back (the executor moves it into the
  task's scratch trash, which D-064 prunes 24 h after the task ends — a courtesy, not an undo the loop may promise), while
  `idempotent` answers whether repeating the call makes it worse (a file already gone cannot be deleted twice).

`availability` stays out of the declaration on purpose. Whether a tool is present in a given process is a fact about a
build and a runner, and a declaration that asserted it would be a second source for what `GET /tools` answers — the reason
that route still reports these five fields as pending (`PENDING_RECORD_FIELDS`) is that no runner composes an executor
yet, not that the fields are unknown (`docs/CONSISTENCY_REVIEW.md` F-55).

Two rules came with the executor because §4.4 required them and nothing could implement them before: **the output cap
(64 KiB, `MAX_TOOL_OUTPUT_BYTES`) is applied to the *wrapped* text**, cut on a UTF-8 boundary, with the whole result
written to the task's scratch directory and its path printed in the label — capping the unwrapped content instead would
risk truncating the delimiter itself, and a boundary that no longer closes is §10's defence with the door open; and
**the delimiter carries a nonce** (`SECURITY.md` §10 has its shape), re-rolled if the content happens to contain the
closer and thrown rather than emitted if six rolls all collide, because bytes in a user's file must not be able to end
the block they are inside.

**What this build declares now (M2ab, D-106).** Fourteen of §4.2's forty-five rows have an executor — the eight above,
the scheduler's `cron.schedule`, the two conversation rows, the three task rows and `net.fetch` — carried as fifteen
declarations, because `file.stat` shares §4.2's row with `file.list` and has no row of its own. The M2k paragraph above
stays as its snapshot, including the sentence that `GET /tools` reports the five runtime fields as pending because "no
runner composes an executor yet": F-55's closing amendment superseded it, and the route now merges an executor's
declarations into the registry rows and reports `runtime.implemented`, with `pendingRecordFields` surviving only for rows
nothing declares. What `net.fetch` added to the two rules above is a third, and it is about size rather than framing:
**the download stops at the cap** instead of the framing cutting afterwards, because a response body's length is chosen
by whoever answers, and D-064's promise about what the model sees has to be a promise about what lands on a phone too.
The row is also the first to declare `sideEffects: "external"`, which is what lets §6.2's cancellation evidence say that
an effect may have landed somewhere this install cannot inspect.

**What this build declares now (M2ac, D-107).** Sixteen of §4.2's forty-five rows have an executor — the fourteen above
plus `config.get` and `config.set` — carried as seventeen declarations. The M2ab paragraph above stays as its snapshot.
These two are the first rows whose price is about *who can answer* rather than about how loud a prompt is: `config.set` is
**T3**, D-085 confines a T3 signature to the TUI and the Web control UI, and M2 ships neither, so a run whose model asks
to change configuration parks at a prompt no CLI can sign and the request expires rather than runs. That is asserted
rather than merely documented (`tests/integration/config.test.ts` drives a real run into exactly that park), because a
tier whose consequence nobody has watched is a tier in a table. What the read added to the rules above is a fourth, and it
is about the answer rather than the act: **a configuration read is scrubbed by the same derivation the route answers
with** — `configForReading` in `packages/core`, one implementation and two callers — so §4.2's "secret *names* only, never
values" is not a rule either of them has to remember. Neither row is wrapped as untrusted, because this is Crabby's own
state rather than bytes from elsewhere, and both take the `fs.*` clock from D-074's table: the act is a file read and a
file write, so the tool borrows the deadline of the thing it touches instead of inventing a fifth number for a document on
the same disk.

**What this build declares now (shell slice).** Eighteen of §4.2's forty-five rows have an executor — the sixteen above
plus the two shell rows — carried as eighteen declarations, because the base and the elevated `shell.run` rows share one
name and one declaration answers both records. The M2ac paragraph above stays as its snapshot. What the shell row adds
to the rules above is a fifth, and it is about *where* rather than what: **a command runs only inside the configured
workspace roots**, with the run's own cwd resolved through the same link re-check §8 demands of every path, a child
environment that is an explicit allow-list (a provider key inherited from the parent is a secret the run was never
granted), and an abort that kills the process group rather than the one pid the spawn returned. The declaration is
`idempotent: false` — a second run with the same argv is a second act, so §7.3's answer for it is `re-ask` — with
`sideEffects: "external"`, which is what lets §6.2's cancellation evidence say an effect may have landed somewhere this
install cannot inspect. The executor declares no `facts`: the tier moves on the argv the caller declared (D-099's
channel stays empty rather than carrying a second copy of the request).

**What this build declares now (http.request slice).** Nineteen of §4.2's forty-five rows have an executor — the
eighteen above plus `http.request` — carried as nineteen declarations, because this row's reason to exist is that it
cannot share `net.fetch`'s: one tool cannot declare itself both idempotent and not. The shell paragraph above stays as
its snapshot. What this row adds to the rules above is a sixth, and it is about *when* rather than where or how much:
**a mutating request is never passed by a resume** — `idempotent: false` makes §7.3's verdict for the step `re-ask`,
which is the whole difference the §4.2 split carries, and it is why the tier cell does not move either: the
allow-list de-escalation in §4.3 belongs to the GET row, so a curated host is still a host the user is asked before
anything is written to it, and `escalation.ts` prices this row at its base tier by having no branch for it at all.
The row also inherits the network class's one clock (`limits.netFetchTimeoutMs`, §5.2) rather than being handed a
second number, because both rows are one crossing of the same boundary on the same `net.egress` grant.

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
| `config.get` | `config.write`-independent read | **T0** | Secret *names* only, never values. **Executed since M2ac** (`packages/tools/config.ts`, D-107): one dotted key or the whole document, one line per leaf and each marked as a default or as an override, so a model can tell a user whose number a deadline came from. The values a reader may see are scrubbed by `configForReading`, the same derivation `GET /api/v1/config` answers with, and a `provider.<id>.key` that is not a `vault://` name is withheld and named in the answer's `redacted` list. |
| `config.set` | `config.write` | **T3** | Includes changing permissions, roots, or retention. **Executed since M2ac** (`packages/tools/config.ts`, D-107): one key and never a deletion, because setting and unsetting are different acts on the document that decides permissions and this row prices only the one it names. The concurrency token is read and presented by the sink rather than declared as an argument (D-099: a declared field is never an authority). On a build with no TUI or Web control UI the T3 request parks and cannot be answered (D-085), which is the rule working rather than a fault to retry around; the user's own path to the same act is `crabby config set` or `PUT /api/v1/config`. |
| `tunnel.status` | read-only | **T0** | |
| `tunnel.enable` / `tunnel.stop` | `tunnel.enable` | **T3** | Must list which paired identities become reachable (`SECURITY.md` §13). |
| `ext.list` / `ext.info` | read-only | **T0** | |
| `ext.install` | `ext.install` | **T2** | Content-only kinds. |
| `ext.install` (executable kind) | `ext.execute` | **T3** | Blocked in the first release regardless of tier (D-038). |
| `ext.uninstall` | `ext.install` | **T2** | `--purge-data` is **T3**. |
| `mcp.connect` / `mcp.tools` | `ext.install` | **T2** | Shows exact command line or URL. |
| `net.fetch` | `net.egress:<host>` | **T2** | **T1** only for a user-curated allow-list; response is untrusted content. **Executed since M2ab** (`packages/tools/net.ts`, D-106): GET only, because a method that mutates remote state is the next row's `http.request`; the allow-list that moves this row to **T1** is `net.allowList` in `config.json`, and the grant an identity holds names that *set* rather than its members, so a host nobody curated reaches the tier rule below instead of being denied outright. |
| `http.request` (non-GET) | `net.egress` | **T2** | Any method that mutates remote state; carries destination host in the approval text. **Executed since the http.request slice** (`packages/tools/http.ts`): a second executor rather than a `method` argument on `net.fetch`, because the two rows cannot share a tier cell or an idempotency declaration — this row is `idempotent: false` (§7.3's verdict for a resume is `re-ask`), and the allow-list **T1** belongs to the GET row: a host the user curated for *reading* is not a host they pre-approved *writing* to, so every call is **T2** with the host named whatever `net.allowList` holds, and `escalation.ts` has no branch for this row at all. Serves `POST`/`PUT`/`PATCH`/`DELETE` verbatim — a lowercase or unrecognised verb is refused rather than rewritten, because §6.3's approval quotes `args` as the user read them — and a read verb is refused with a pointer at `net.fetch`. Credential headers (`Authorization`, `Cookie`, `x-api-*`) are refused with §3 rule 06 named rather than stripped (F-56: no vault, nothing to attach). Destination judgements are shared with `net.fetch` from `net-shared.ts`: http(s) only, a hop that changes the host refused as a destination nobody priced, D-106's five hops, D-064's capped read; a 303/301/302 turns the follow-up into a GET and drops the body, and the report says so. The clock is the network class's own — `limits.netFetchTimeoutMs`, the same key `net.fetch` reads (§5.2). |
| `provider.invoke` | `provider.invoke` | **T1** | **T2** when the selected model is paid (`provider.billing`). |
| `shell.run` | `shell.run` | **T2** per command | Capability itself is off by default. Tier computed per command, not per tool; escalation table in §4.3. **Executed since the shell slice** (`packages/tools/shell.ts`): argv-form only — `argv` plus an optional `cwd` inside the workspace roots, never a string assembled from untrusted content (§9) — cwd resolved through `checkPath` with the link re-check, a fixed child-env allow-list, abort killing the process group, and D-064's 64 KiB wrapped cap with the nonce delimiter and the runtime note outside it. One declaration covers both shell rows; privilege stays a grant the arbiter checks, not a branch the executor takes. Composed only when the install opted in (`shell.enabled`, `crabby init --enable-shell`); otherwise `GET /tools` reports both rows as pending. |
| `shell.run` (elevated) | `shell.privileged` | **T3** | Package install/remove, service control, system config. Reached through the same argv-form executor as the base row: the elevated price is enforced by the capability (`shell.privileged`, withheld from every fresh install per §9) and by D-085's TUI/Web-only signature, not by a second executor path — so a T3 shell prompt parks on a CLI-only build exactly the way `config.set` does. |
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
- `file.*` — escalation by resolved path after symlink resolution, and by two facts about the filesystem: `file.edit`
  of a path that already exists and `file.move` onto an occupied destination are the §4.2 bumps to T2. Neither can be
  decided from the arguments, so neither travels in them (D-099): the runtime observes and passes what it saw on
  `ToolCall.facts`, a channel the model cannot write to, because a fact smuggled in as an argument is either rejected by
  the rule below or declared in the model-visible schema — and `SECURITY.md` §10's "a declared field is never an
  authority" is exactly the sentence that forbids the second. The observation is recorded in `tool.call.proposed` and
  hashed into the approval's binding, so the prompt shows what policy saw and an approval signed against "this file did
  not exist" cannot be spent on a step that found it did.
- `net.fetch` — escalation by destination: any host not in the allow-list is T2 with the host named in the prompt. Since
  M2ab the list is `net.allowList` in `config.json` and this comparison is `packages/policy`'s alone (D-106): the
  executor is never given the list, because a second copy would be a second opinion about which hosts are cheap. An empty
  list is not a refusal and not a hole — it is exactly the state this bullet describes, where every destination is a new
  host. What the executor does judge is the destination a *redirect* reaches: hops are followed while the host stays the
  one this rule priced and refused the moment a server substitutes another, because spending a T1 auto-allow or a T2
  approval on a host neither saw would be this bullet's rule enforced against the wrong destination.
- New provider model discovered → its descriptor is re-validated; a capability that vanished since registration must
  produce `unsupported-capability`, not a silent degradation.
- Any tool receiving arguments it did not declare → reject before policy, so a schema mismatch can never be
  mistaken for permission.

### 4.4 Execution rules

- Order of checks, always: schema validation → capability check → tier/approval → execution → result validation.
  A tool never runs "to see if it works". The runtime's observed facts are gathered between validation and the capability
  check (D-099), because §4.3's file escalations are argument-dependent in the only sense that matters: they depend on
  what the arguments *are about*, and the party that knows is the one about to touch the filesystem.
- Every execution carries: timeout, output byte cap, and a cancellation signal. On Termux, spawn in a process
  group so a kill reaches children (`SECURITY.md` §9). A timeout ends the call with the code `timeout` and the class
  name of the deadline that tripped, never as a generic failure — "it took too long" and "it did not work" need
  different responses, and a retry ladder that cannot tell them apart retries the wrong thing.
- Child environment is an explicit allow-list; the parent's provider keys are not inherited.
- Temp files live in a per-task scratch directory with a documented lifetime and automatic cleanup on task end,
  with leftovers reported rather than silently retained.
- Results above the cap are truncated *and labeled*; a tool must not pretend a partial result is complete. Concretely
  (D-098): the cap is 64 KiB of the **wrapped** text — the same number storage uses for an event payload, so an overflow
  is cut once, by the executor, rather than twice, by whoever stores it — the cut falls on a UTF-8 boundary so the model
  never receives half a character, the full bytes go to the task's scratch directory, and the label names both the
  truncation and the path the rest is at. The label and the runtime note sit *outside* the delimiter, because a note
  inside untrusted content is content.
- Output is delivered to the model as delimited, attributed, untrusted content (`SECURITY.md` §10), and since M2k that
  sentence has a shape rather than an intention: `wrapUntrusted` in `packages/tools` emits the marker §10 specifies, with
  a nonce in both the opener and the closer.

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

The starting numbers are decided now, as defaults with a named override path (D-074), because "wait for a phone to learn
what a timeout should be" would hold up four documents for values that are cheap to change and expensive to invent per
interface:

| Class | Default | Notes |
| --- | --- | --- |
| Provider — connect | 10 s | TCP plus TLS to the endpoint. |
| Provider — first token | 60 s | Reasoning models are slow to start; this is the generous one. |
| Provider — idle stream | 45 s | A stream that goes quiet is dead, not slow. |
| Provider — absolute | 300 s | The per-call ceiling, not the per-task one. |
| `fs.*` | 10 s | Storage on a phone can be slow; it cannot be this slow. |
| `net.fetch` | 20 s total | One request, redirects included, so a redirect chain cannot restart the clock forever. Enforced since M2ab by handing the executor the loop's own `AbortSignal` and no timer of its own, and a same-host chain is bounded at five hops (D-106), so a chain can neither restart the clock nor multiply the requests one pricing bought. `http.request` takes the same number from the same key (`limits.netFetchTimeoutMs`): it is the same class — one crossing of the same boundary, on the same `net.egress` grant — and a second number for a second network row would be a second opinion about how long a phone waits on a stranger. |
| `shell.run` | 120 s wall clock | Killed as a process group so children go with it. Declared since the shell slice (`shellRunTimeoutMs`, read from `config.json` so the declaration and the enforced deadline are one number); the loop arms the deadline from the declaration and hands the run its own abort, which the executor answers with a group kill — and the outcome is reported as a timeout, never a failure, because "it took too long" and "it did not work" need different responses. |
| SQLite busy | 5 s | `PRAGMA busy_timeout`; longer and the UI starts to look frozen instead of busy. |
| Extension, MCP | tool class + 5 s | Adapter overhead, so a slow plugin is not blamed on the tool or the host. |
| Parallel tool steps in one task | 2 | More than two on a phone trades wall-clock time for memory pressure. |
| Concurrent provider requests | 4 | Per Gateway, shared by all interfaces. |
| Queued tasks | 5 | `task run` refuses past that, with the count in the message; a silently growing queue is a leak with good manners. |
| Per-task steps | 25 | Tool calls through the gate, executed **or refused** (D-088). A budget that counted only executions would leave unbounded the loop `SECURITY.md` §6.3 forbids. |
| Tool calls per completion | 2 | The parallel-steps row above, reused as a per-response cap rather than invented twice (D-088): a completion proposing three is asking for parallelism the device budget does not have. |
| Provider attempts | 6 | D-043's floor is five and D-064's schedule has five delays, so the default is one attempt plus five retries. `limits.providerAttempts` cannot be set below 5, because "at least 5 attempts (configurable)" is a floor (D-094). |
| Cancellation settle (`immediate`) | 5 s | How long the runtime waits for a step that will not stop before it stops waiting and records `AGENT_RUNTIME.md` §6.2's uncertainty (D-090). `finish-step` gets no second clock: the step keeps the deadline it was given. |

Four of the limits this section's opening sentence requires still have **no number**, and they are recorded rather than
priced by guess (F-41, F-45): a per-task wall clock, which would have to exclude D-064's approval window because the two
clocks are separate by D-074 and a task paused for a human is not a task that is running long; a `finish-step` cancellation window,
which is deliberately the step's own deadline rather than a second clock beside it (D-090); and a token budget and an
optional cost ceiling, which both need `AGENT_RUNTIME.md` §8's context accounting and cannot be enforced before it
exists. The per-tool deadlines below are enforced for the three classes this table prices — `fs.*`, the network class
(`net.fetch` and `http.request`), `shell.run` — and a tool in no class runs under cancellation alone, with
`deadlineMs: null` in its
`tool.execution.started` event so the absence is visible instead of implied.

Every row is a `limits.*` key in `config.json` — readable with `crabby config get limits`, editable in the same screen
as the output caps (`docs/review/WEB.md` W11-07) so there is one place where the machine's budget lives. Two clocks stay
separate on purpose: an approval that ages out mid-step expires under D-064's approval expiry, not under the tool
timeout, and the task record says which of the two fired. Only the retryable classes in §3.5 re-enter the ladder after a
timeout — an `irreversible` side effect that timed out is reconciled, never retried (`AGENT_RUNTIME.md` §7.3).

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
