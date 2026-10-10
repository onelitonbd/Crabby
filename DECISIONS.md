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
| D-030 | Client authentication: per-client pairing tokens issued by an explicit `crabby auth pair` flow, stored with owner-only permissions, individually revocable, used for local and remote clients alike. | Accepted |
| D-031 | Secrets storage: OS keychain where available (macOS Keychain, Linux Secret Service), encrypted-file passphrase fallback elsewhere (including Termux); the fallback must be labeled as weaker in UI and docs. | Accepted |
| D-032 | Remote access adds no capability narrowing by default: a remote client may use exactly the permissions its paired identity holds, the same as a local client. Interface type may narrow only what the user configures, never what the core allows. | Accepted |
| D-033 | `termux-api` device capabilities (SMS, contacts, camera, location, sensor read) may be exposed to the agent, classified T3 with per-action approval and no stored blanket grant; each capability is independently enable-able. | Accepted |
| D-034 | Security decisions taken in `SECURITY.md` review are recorded here and must be reflected in that document; neither file may state a rule the other contradicts. | Accepted |
| D-035 | Extension strategy is content-first: skills, command templates, and MCP configuration are supported in the initial release; third-party executable code is blocked until the isolation gate passes. | Accepted |
| D-036 | No "install anyway" override exists for an `unsafe` compatibility verdict while untrusted executable isolation is unresolved. | Accepted |
| D-037 | External harness support is implemented as converters with a stored conversion report; dropped or reinterpreted features must be reported, never silently ignored. | Accepted |
| D-038 | No third-party executable extension kind (tool, provider adapter, hook, interface integration) is enabled in the first release, including via any override. The only path is the `O-008` isolation gate. | Accepted |
| D-039 | Conversion reports are retained as per-version history and never overwritten by an update; `crabby ext info` shows the current report plus a diff against the previous one. | Accepted |
| D-040 | Crabby is an MCP **client** only. Exposing Crabby as an MCP server is a non-goal, not a deferred feature. | Accepted |
| D-041 | Users can attach any OpenAI-compatible endpoint by base URL + API key without a Crabby code change or a new release. Custom endpoints get no extra trust and no exemption from policy. | Accepted |
| D-042 | First-release bundled provider presets are the lean set: `groq`, `openrouter`, `ollama`, `anthropic`, `gemini`, `mock/fake`. Other services arrive through D-041. | Accepted |
| D-043 | Retry ladder stage 1: same model, same provider, at least 5 attempts per failing stage (configurable), transient classes only, honoring provider hints with jitter. Never a silent model switch. | Accepted |
| D-044 | On failure after the retry budget, Crabby asks the user which model to use instead, and resumes from the checkpoint — never restarts the task, and never re-runs completed steps or repeated side effects. | Accepted |
| D-045 | Any model's capability descriptor is user-overridable (force on/off, context ceiling, output reserve). Priority: user override → preset → discovery → adapter default. Forcing a capability on does not exempt it from runtime verification. | Accepted |
| D-046 | Tier confirmations: `history.export` T2, `cron.schedule` T2 with runtime per-step approval (§4.5 of `PROVIDERS_AND_TOOLS.md`), `memory.save` T1 while external-derived memory is T2. Closes O-020. | Accepted |
| D-047 | Automatic provider/model fallback is off by default; a per-identity pre-approved narrow ladder may be configured, limited to reliability classes that change neither cost nor data destination. | Accepted |
| D-048 | Streaming transport: SSE for server-to-client events, plain HTTP for every client action, no WebSocket in v1. The transport sits behind an abstraction so the decision is revisitable without touching application logic. Closes O-004. | Accepted |
| D-049 | Event replay is per-task and count-bounded, ordered by a monotonic per-task `seq`; outside the window the Gateway returns an explicit gap marker and the client must reconcile from `GET /tasks/{id}`. Events for display, GET for truth. Closes O-010. | Accepted |
| D-050 | First-release installation path: clone/checkout plus `npm install` with the documented `--build-from-source` step for native modules, per-platform docs, `crabby doctor` for recovery. No global install target, no package-manager repository, no self-updater in v1. Closes O-012. | Accepted |
| D-051 | Client credential format: opaque random token, owner-only file permissions, no expiry by default and no rotation requirement in v1; revocation is the control. Closes the O-019 remainder. | Accepted |
| D-052 | Approvals are once-only in the first release. "Remember this choice" approvals are out of scope for v1, and therefore unavailable for T3 by definition. | Accepted |
| D-053 | Paired-identity management (`auth.manage`) is available only to local clients. It is the one accepted asymmetry in the feature-parity matrix, recorded with its alternative path rather than hidden. | Accepted |
| D-054 | `--restrict` removes capabilities from an identity; it never converts them into an approval the same restricted client must answer. | Accepted |
| D-055 | Interface review is done element by element: every screen of every interface is written up as an element inventory (`docs/review/`) before `docs/UI_UX_SPEC.md` and `docs/DESIGN_SYSTEM.md` are regenerated from it. All elements carry equal weight — size, cost, or how often they are seen never moves one to the bottom of the list. | Accepted |
| D-056 | The review medium for an interface is a mockup generated from its inventory file (`docs/review/mockups/`), not a hand-drawn picture: every element shown must come from a row, must click back to that row, and must be able to carry a decision out of the mockup. The inventory stays the source of truth; a generated view cannot contradict it. A mockup is a review instrument, not implementation, and is never shipped. | Accepted |
| D-057 | Scheduled jobs get a first-class surface in v1: a `Scheduled` screen in the Web UI (fifth nav item), a sixth TUI pane, `crabby job …` commands, and `/jobs` on Telegram. They are **not** folded into the task list, because a job is a standing authority to run work later and needs its own pause/edit/review affordances. | Accepted |
| D-058 | Gateway lifecycle (`start` / `stop` / `restart`) and the sanitized diagnostics report are capabilities of all four interfaces, not CLI-only conveniences. Restart/shutdown is T3 (`config.write`) and confirms in every interface that shows it. | Accepted |
| D-059 | **Review-round authority.** On 2026-10-10 the owner instructed: research, then arrange everything according to the agent's recommendations. Decisions in this round are marked **(R)**, each names the evidence it rests on, and each is reversible one row at a time — an (R) row the owner rejects goes back to `Proposed` or `Open` without touching its neighbours. Anything that can only be measured on a physical phone stays Needs Validation and is listed as such, because deciding it here would be the exact failure mode this project forbids (an unvalidated choice presented as final). | Accepted (R) |
| D-060 | **Toolchain.** npm with workspaces (no pnpm: Termux installs must be reproducible with the one package manager a user already has, D-050's clone+`npm install` path). Lint and format: Biome — the package is `@biomejs/biome` (2.5.15, verified on the npm registry, zero runtime deps); `biome` on npm is an unrelated 2016 package and must never be the install target. Types/schemas: TypeBox (0.34.52) over Zod, because the API contract, the config schema (`crabby config schema --json`) and the generated `--help` all need real JSON Schema, which TypeBox emits rather than converts. `packages/*` are not published independently in v1 (one repo, one version, no cross-package skew to support). `scripts/check-docs.py` runs in CI as a required check. Termux coverage: `termux/termux-docker` (active, verified on GitHub) runs the Node/toolchain half of the suite in CI; the device checklist remains the substitute for `termux-api` calls and TUI measurement, because a container has no Android runtime. Closes O-003, O-005, O-036, O-047, O-048, O-049, O-050. | Accepted (R) |
| D-061 | **Terminal input and rendering contract.** (a) The TUI renders **inline**, not in the alternate screen, and turns on Ink's line-diffing incremental mode; a `print to scrollback` action exists for any block the user may want to keep, because losing copy-paste history on a phone is worse than exit residue (O-054). (b) Newline in the composer is **`Ctrl+J`** as the always-available key; `Shift+Enter`/`Alt+Enter` are used only when the terminal confirms extended-key reporting, and `Enter` always sends (O-002 design half, O-055): the evidence is that a plain terminal reports Shift+Enter as `CR`, identical to Enter, and Termux's own support is only certain via a fork's implementation, so a design that depends on it is a design that breaks on the primary platform. (c) Markdown in the TUI renders emphasis, code spans and fenced blocks only; tables, nested lists and inline HTML pass through as text (O-056). (d) Approvals are **one card at a time** with a queue count in the status line (O-057): 24 rows cannot hold two readable cards, and a readable second card is the one thing an approval cannot lose. (e) Keys are **fixed in v1**, no configuration surface (O-059) — a binding file is a second source of truth for the hint strip, and the hint strip is the authority. | Accepted (R) |
| D-062 | **Non-Latin text in terminals.** Layout never measures text with code units or code points: it segments grapheme clusters (`Intl.Segmenter`, present in Node 22 — measured here, not assumed) and sums cell widths. Truncation happens only at cluster boundaries. No grid-aligned table, ruler or box may contain non-Latin text, because terminals disagree about Indic spacing marks: measured here, `দিয়েছি` is 7 code units but 3 clusters and 6 cells, `কিন্তু` is 6 code units and 4 cells, and truncating `দিয়েছি` at 3 code units yields `দিয` with a broken conjunct. Chrome (labels, hints, status) stays English; user and model text passes through unshaped and unmodified, with the limit stated in the help rather than discovered (O-058). | Accepted (R) |
| D-063 | **CLI blocking and machine output.** `crabby task run` **blocks** and prints the id plus the resume command on the first line; `--detach` is the script path (O-060). `task watch` with `--json` emits **NDJSON**, one event per line, carrying the per-task `seq` from D-049 so a script detects gaps the way the Web does (O-061). When a human answer is required and none is reachable, the command **exits 3** rather than blocking forever; `--wait-approval <n>` is the explicit opt-in (O-062), because a silently blocking command in a cron job is an outage. Shell completion is **generated from the command registry in v1**; there is no man page and no second reference surface (O-063). | Accepted (R) |
| D-064 | **Provider runtime policies.** Retry schedule inside the 5-attempt floor (D-043): `1s, 2s, 4s, 8s, 16s` with ±25% jitter, and a `Retry-After`/`retry_after` value always overrides the schedule upward (O-029). Token estimation when a provider exposes no counter: `max(chars/4, cluster count × 1.35)` — the measured Bengali ratio above is why the divisor is not applied blindly to non-Latin text — and every estimate is labeled `estimated` in the UI, never shown as a count (O-031). Tool output caps for a low-resource device: 64 KiB inline, larger goes to a file in the session scratch with the path printed; scratch files older than 24 h are pruned at startup, and the prune is logged (O-035). Approval expiry per tier: T1 15 min, T2 10 min, T3 5 min — an approval that grants more should age faster (O-041). `crabby model edit` opens a field editor with per-field prompts available for scripting; the Web/TUI show the same fields in a form, one source of truth (O-037). Overriding every model of one provider at once is allowed only as an explicit bulk action that repeats the warning per affected model, never as a default (O-038). | Accepted (R) |
| D-065 | **Data, retention and deletion policies.** Imported content is tagged by source and treated as data — no privileged parsing, no instruction-following from file or web text, and the `external content` marker from `SECURITY.md` §10 is what a user sees (O-021). Redaction: log lines and exports carry no secret-shaped values and no credential material; the audit record keeps the **exact target** in plaintext because approving a path you cannot re-read is worthless, and the retention of that record is what `SECURITY.md`'s deletion rules govern (O-022). Event retention: 30 days or 5 000 events per task, whichever comes first, with the count visible in the task record (O-014). Deleting a conversation propagates to summaries and derived memories on read (a dangling reference is shown as deleted, never silently rewritten) (O-016). Retrieval in v1 is SQLite FTS5 only; vector search stays out until a measured need exists (O-015). Backup is `db.backup()` to a timestamped file plus the config directory; restore is a documented manual step that runs an integrity check first, and a failed migration leaves the previous file untouched (O-017, and the rollback half of O-012). Checkpoint recovery may only resume past a step whose tool declares itself idempotent or whose effect is recorded; anything else re-asks rather than repeating an external action (O-013), and the compaction/budget algorithms are validated against the recorded acceptance list rather than a benchmark (O-011). Extension conversion reports: keep the report for the installed version and the one before it, prune older ones, and include reports in user exports (O-027). | Accepted (R) |
| D-066 | **Platform boundaries.** SQLite is confirmed as the engine (`docs/DATA_AND_MEMORY.md` §4's comparison stands; the clean-environment reproduction stays open as O-001's one remaining clause). `better-sqlite3 ^13` (13.0.3 verified, single native dependency) with `--build-from-source` on Termux per D-050. Windows: **WSL only** in v1; native Windows is documented-unsupported rather than half-supported (O-007). Secrets on Android/Termux: the vault file in `~/.crabby/vault`, scrypt KDF at N=2^15 with a per-install salt, and `termux-keystore` used only if the probe succeeds at first run — the probe result is printed at setup so the user knows which they have (O-018). Local inference on Android: **documented unsupported**, supported only through an external server the user runs, matching the §3.3 assumption (O-034). Tunnel lifecycle: a quick tunnel's URL is not sticky, it changes on restart, the Gateway prints the new one on every start and never redirects the old one, and shutdown drains for 5 s before exiting (O-009). The initial `termux-api` capability list is exactly: `notify`(T1), `tts`(T1), `clipboard-read`(T2), `clipboard-write`(T2), `share`(T2), `camera-capture`(T2), `location`(T2), `vibrate`(T1), `torch`(T1), `sms-send`(T3) (O-024). Per-task capability narrowing is **opt-in with a configured floor**, not mandatory: a mandatory prompt per task is friction that trains users to click through it, which is worse than the hole it closes (O-025). The `shell.run` classifier is a small table shipped in-tree with the release and versioned with the code, documented as an escalation hint and never as the security boundary (the boundary is path and capability checks, `SECURITY.md` §9); "updatable via a skill" was rejected because a table that gates T3 and updates itself is an extension point with less review than an extension gets (D-038), and that closes O-032. | Accepted (R) |
| D-067 | **Interface shapes.** API versioning by path prefix `/api/v1`, with additive changes inside a minor version and a deprecation note for anything removed (O-039). The Web UI is **served by the Gateway** from a build directory — `crabby web open` starts nothing new and points at the same origin, because two servers means two certificate stories and a second thing to keep alive on a phone (O-040). `docs/INTERFACES_AND_API.md` §8 is **generated** from the tool registry plus per-tool interface annotations, with the generator committed and the table checked in so drift fails CI — this is the structural answer to F-08/F-11, whose root cause was three hand-maintained lists (O-042). Pairing on a phone: `crabby auth pair` prints the URL and an 8-character code on their own lines, the Web first-run field takes the code, and the long-lived credential is delivered once and never logged (O-019). A status bar that cannot fit its chips at 360px shows four inline plus a `more` sheet, and locked-vault and offline escape the sheet into the bar (O-053). Remembered, scoped approvals remain out of v1 (D-052); their design is deferred as O-052 rather than guessed at here (O-052). | Accepted (R) |
| D-068 | **Web UI stack and colour values.** The Web UI is framework-free: native custom elements, `<dialog>`, CSS custom properties for tokens, SSE for events — no SPA framework, because this interface is a client of the contract rather than an application platform, and every dependency is install weight and audit surface on a phone (O-043). Palette values are recorded in `docs/DESIGN_SYSTEM.md` §2.3 with their measured WCAG 2.2 contrast, and `scripts/check-docs.py` recomputes them rather than trusting the table (O-044). Both themes ship on day one; light is specified, not inverted, and the measured numbers show why (a naive muted/accent pair for light fails AA on a raised surface — O-045). TUI colour detection is an explicit user setting first, with `$COLORTERM` sniffing only as the default when unset, and the 8-color tier keeps every state word readable — a probe that fails on a phone is worse than no probe (O-046). | Accepted (R) |
| D-069 | **Dependency set for the runtime.** Accepted (R). Gateway framework **Fastify** (`^5.12.5`, 15 deps, published 2026-09-16): route-level validation is wired to the same TypeBox schemas the contract exports, through a `validatorCompiler`, so there is one schema and one validator rather than Fastify's `ajv` dialect sitting beside ours; SSE goes through `reply.hijack()`. **grammY** (`1.46.0`, 4 deps, pure JS) as the Telegram transport adapter only — update parsing, `retry_after` handling and 429 backoff live in Crabby's code, because the retry policy is a contract for all four interfaces (D-064) and cannot be delegated to a library's convenience. The test runner is **`node:test` with native type stripping**: measured here on Node 22.22.3, `node a.ts` runs a `.ts` file unflagged, `node --test` discovers `*.test.ts` and passed, and `--experimental-test-coverage` printed per-file tables — a complete stack with zero dependencies and no transform step, which also means the tests execute the same bytes production does. **Vitest and `tsx` are rejected as defaults, not forbidden**: both reach `esbuild`'s platform binaries (`tsx` → `esbuild`; `vitest` → `vite` → `esbuild`), and esbuild does publish `@esbuild/android-arm64` (registry, 0.28.2, 2026-08-08), so the argument is *not* "it cannot work on Termux" — a document claiming that would be the exact failure mode this register forbids. The argument is that the dev loop should not depend on a native binary the release path does not need, and that M0 should spend its measurements on things that can actually break. Adopting Vitest later is allowed with a named reason in `docs/DEVELOPMENT.md` §3. This row moves **P-001, P-002, P-005, P-009** to Accepted and **P-008** to Superseded, and it records that **P-006 (Zod)** and **P-007 (React + Vite)** were still written as open proposals after D-060 and D-068 had rejected them — the register contradicting itself, found only because this pass re-read the `P-` table (F-17). | Accepted (R) |
| D-070 | **Runtime baseline, and what type stripping forbids.** Accepted (R). The requirement is behavioral, not a version number: **the installed Node must run `.ts` entry points and `node --test` with no flags and no loader**. That is what M0 P1 measures on Termux, and what `crabby doctor` refuses to start without. Two consequences are written into the codebase rules instead of left to taste: non-erasable TypeScript (`enum`, `namespace`, parameter properties) is simply unavailable, because the runtime rejects it — an error observed here, not inferred — so the language subset the project uses is the subset it can execute; and `package.json` `engines` is the single pin, so no document restates a Node version and no document can be separately wrong about one. | Accepted (R) |
| D-071 | **Skill frontmatter: which fields are honored.** Accepted (R). The upstream Agent Skills format (agentskills.io shape, cross-checked 2026-10-10 against four independent write-ups of the spec) defines `name`, `description`, and optionally `license`, `compatibility`, `metadata`, `allowed-tools`. Crabby's rule is three-way, because "supported" and "trusted" are different questions: **honored** — `name` (1–64 chars, lowercase alphanumerics and single interior hyphens, must equal the containing folder name; a mismatch is a hard validation error, since the id doubles as the install key), `description` (1–1024 chars, model-visible, therefore untrusted content under `SECURITY.md` §10 — the field that decides activation is the field an author can lie in, and the UI says so), `license` (feeds §9's distribution check; SPDX expected, free text accepted, absence is a warning not a block because the ecosystem ships both), and `metadata` **only** for the keys `version`, `author`, `tags`, `crabby.*`; anything else in `metadata` is preserved verbatim and not interpreted. **Recorded, never granted** — `allowed-tools`: a field inside an untrusted file that pre-approves tools is a privilege escalation written in the file the approval system exists to gate (the upstream security notes describe exactly this failure in another harness), so Crabby maps the names into the `SECURITY.md` §6.1 vocabulary for *reporting* — a capability-diff line and a `--restrict` floor hint — and never skips a tier check for it. **Displayed, not enforced** — `compatibility`, which is free prose; it is shown on the install screen and copied into the conversion report. **Ignored loudly** — every unknown field, with a named report line; a native `crabby.extension.json` *rejects* unknown fields (a typo must not silently drop a capability), while an imported `SKILL.md` is treated leniently and preserved, per §11 rule 3, because rejecting someone's upstream file for carrying a field dated after our release is how an import path becomes useless. Body size: a `SKILL.md` over 500 lines is a validation **warning**, and a body over 32 KiB is **refused at activation** with the instruction to split into `references/` — truncating instructions silently is the one thing a skill loader may never do, since a truncated rule reads like a complete one. | Accepted (R) |
| D-072 | **Host API version policy for extensions and skills.** Accepted (R). The manifest already carries `hostApi` (min and max) and `capabilities`; what was missing is the policy those fields mean, and it is now: host API versions are **one decimal pair, `major.minor`, declared for the whole surface rather than per capability**. `minor` bumps for additive changes — a new optional method, a new field in a result — and a bundle with `max-host-api` set below the running minor still loads; `major` bumps for anything that changes a signature, a meaning, or a security-relevant default, and a bundle whose `min-host-api` exceeds the host **refuses to load** with `ext_host_api_unsupported`, naming both versions in the message. v1 ships exactly one major (`1.x`) and never two at once: a plugin system that supports two live majors is a maintenance promise this project cannot keep, and an honest refusal costs one message. Deprecation is a three-step ladder with a floor of one release between steps — `@deprecated` marker plus the replacement's name in a minor, a warning line in `ext check-compat` and in the load report in the next minor, removal at the following major — and because the release changelog is deliberately not written until the first release, the *authoritative* deprecation record is `ext check-compat`'s output — a command every interface can run, not a file nobody is promised yet. Skills without a manifest take `1.0` implicitly; a converted skill records the resolved pair in its conversion report (D-039) so "what did this assume when it was imported" is answerable years later. | Accepted (R) |
| D-073 | **Memory provenance instead of memory confidence scores.** Accepted (R). No model-generated float is stored as a confidence value: a number nobody can calibrate becomes a number somebody will trust. Each memory carries **provenance instead** — how it was learned (`stated` by the user, `confirmed` by an outcome, `inferred` from a pattern), the source references it came from, the count of independent sources, and a last-confirmed timestamp — and the coarse rank is displayed as a word, never a percentage. Conflict rule: for the same key, a newer `stated` supersedes an older `stated`, while `inferred` never overrides `stated` and cannot delete it; a conflict that is not resolvable by those two lines is **shown** in the memory view as two entries with their timestamps, matching the deletion rule in D-065 — the system does not quietly edit its own past. Extraction triggers are exactly two, and only the first is on by default: the explicit user act (`remember`, in all four interfaces), and an auto-extraction step that must be **off by default** and, when enabled, surfaces each candidate as a diff the user can refuse before it is written (D-046's approval floor; a memory written silently is a personality change nobody approved). The numeric threshold for when an `inferred` memory is promoted to a stored one is deliberately not chosen here, and the procedure for choosing it is: tune in M2 against the acceptance list recorded in `docs/review/`, one number per rule, each with the case that motivated it — not against a benchmark nobody will run (the same standard D-065 applies to compaction). | Accepted (R) |
| D-074 | **Timeout and concurrency defaults.** Accepted (R). Decided as *defaults with a named override path*, because waiting for a phone to learn what a request timeout should be is the wrong dependency. Provider calls: connect 10 s, first token 60 s, idle stream 45 s (a stream that goes quiet is dead, not slow), absolute 300 s. `fs.*` 10 s; `net.fetch` 20 s total; `shell.run` 120 s wall clock, killed as a group so a child does not outlive its parent, and the outcome is reported as `timeout` — a distinct code, never `failure`, because "it took too long" and "it did not work" need different responses. SQLite busy timeout 5 s. Extension and MCP calls inherit their tool class's timeout plus 5 s of adapter overhead, so a slow plugin cannot be blamed on the tool or the host. Concurrency: 2 tool steps in parallel inside one task, 4 concurrent provider requests per Gateway, 5 queued tasks before `task run` refuses with a count (a queue that grows silently on a phone is a memory leak with good manners). Every one of these is a `limits.*` key in `config.json`, visible through `crabby config get limits`, editable through the same screen as the caps in D-064 (W11-07), and an approval that ages out mid-step follows D-064's expiry rather than the tool timeout — the two clocks are different and must stay that way in the logs. Timeouts are not retried blindly: only the retryable classes in `PROVIDERS_AND_TOOLS.md` §3.5 re-enter the ladder. | Accepted (R) |
| D-075 | **The element review is executed under delegation, with its criteria printed.** Accepted (R). The owner could not review 650 element rows and asked for the reviewer's own judgment instead, so the gate in D-055 is satisfied by a delegated pass rather than by waiting — and a gate satisfied by delegation is only honest if the criteria are inspectable, because "reviewed" without a method is the word that means nothing. The pass checked every row against the constraint its own interface already owes: thin rows (a claim too short to build), duplicate element labels, citations of element ids that no inventory defines, citations of API routes that `docs/INTERFACES_AND_API.md` does not define, rows still naming a technology the register killed, open questions raised in an inventory with no answer block, Telegram rows exceeding the transport's own recorded numbers, TUI rows summing past 40 columns or promising `Shift+Enter` or Indic grid alignment, and Web rows relying on hover or on hue alone. The scan is `scripts/review-scan.py`, committed, so the pass is repeatable by anyone rather than a story about a good afternoon. Outcome: 650 rows to `ACCEPTED`, **zero cut** (a cut would move a capability out of an interface and force a parity edit in the same breath), and **three rows corrected**: two carried hand-typed numbers that had quietly gone stale (`/help` claiming 28 commands where region G3 defines 32; `docs/review/WEB.md`'s review-surface line claiming 161 rows when 179 were open — F-22), and one was a genuine fork, `/help` specified in two regions with two different limitation citations, now split into a catalogue row and a first-run invite (F-23). What the delegation did *not* buy: the eight `O-` rows that need a device stay open, `ACCEPTED` here means "reviewed against the recorded rules", not "the owner likes it", and `AGENTS.md` §1 tells an implementer to raise a discrepancy rather than quietly deviate. | Accepted (R) |
| D-076 | **Owner review moves to the implementation step.** Accepted (R). Review continues, just not as a 650-row table: the owner reviews one implemented unit when it exists — a screen, a command, a bot behavior — and answers by row. Per step: the reviewer presents the running thing plus the element IDs it implements; an answer becomes a code change *and* an inventory-row change in the same commit, so the document never describes a build that stopped existing; no answer means the summary says `unreviewed` and the step stays reversible; and nothing in this protocol lets an agent mark a row `EDIT` or `CUT` on the owner's behalf, because that is taste, and taste is the one thing the delegation explicitly did not transfer. This is what makes D-075's blanket `ACCEPTED` safe to build against: the statuses say "implementable as written", not "final". | Accepted (R) |

## 3. Proposed Technical Choices

These choices are recommendations, not accepted technical decisions.

| ID | Area | Candidate | Status |
| --- | --- | --- | --- |
| P-001 | Gateway framework | Fastify | Accepted — chosen in D-069, with `validatorCompiler` over the TypeBox schemas instead of a second `ajv` dialect |
| P-002 | Streaming | SSE for server-to-client updates, ordinary HTTP endpoints for client actions | Accepted — D-048 |
| P-003 | Database engine | SQLite | Needs Validation — the design is accepted (D-066); O-001 and O-002 are the clean-build and WAL measurement |
| P-004 | Database driver | `better-sqlite3` (source build on Termux) | Needs Validation — pinned at `^13.0.3` by D-066; O-001 and O-002 are the measurement, `node:sqlite` the named alternative it is compared against |
| P-005 | Workspace tooling | npm workspaces | Accepted — D-060 |
| P-006 | Schema validation | Zod | Superseded — D-060 chose TypeBox (O-005). The row stays so the reversal is visible |
| P-007 | Web frontend | React + Vite | Superseded — D-068 chose framework-free custom elements (O-043). Six documents still named this stack and were corrected in the same pass (F-17) |
| P-008 | Test framework | Vitest | Superseded — D-069 chose `node:test` with native type stripping; Vitest is allowed later with a named reason |
| P-009 | Telegram library | grammY | Accepted — D-069, as a transport adapter with Crabby-owned retry and `retry_after` handling |
| P-010 | TUI library | Ink 8 (React renderer for terminals) | Needs Validation — O-006 and O-051, measured on a phone in M0 P5. Ink 8.0.0 was published 2026-10-03, a week before this review, which is precisely why it is not Accepted |

Each proposal remains pending until explicitly accepted or validated as required.

## 4. Open Decisions and Validation Requirements

| ID | Topic | Status / next action |
| --- | --- | --- |
| O-001 | Database engine | **Mostly closed (D-066).** SQLite is the engine. One clause stays open: the clean-environment reproduction on a phone (see O-002, same run). |
| O-002 | Database driver | **Narrowed (D-060, D-066).** Driver and build path fixed (`better-sqlite3 ^13`, `--build-from-source`); the newline-key question is answered (D-061) and no longer waits on this. What stays open is one measured number: build + WAL behaviour on a clean Termux install. |
| O-003 | npm vs pnpm | **Closed (D-060).** npm with workspaces. |
| O-004 | SSE vs WebSocket | **Closed (D-048).** SSE + HTTP; WebSocket not in v1. |
| O-005 | Zod vs TypeBox | **Closed (D-060).** TypeBox, because the contract, the config schema and the generated help all need JSON Schema natively. |
| O-006 | TUI library | Researched 2026-10-09 against the npm registry (evidence in §5A). **Intentionally not accepted yet:** Ink 8 stays P-010 (Proposed) until `docs/ROADMAP.md` M0 P5 measures streaming repaint cost on a phone terminal. Owner decision this round: measure first, accept after. |
| O-007 | Windows support | **Closed (D-066).** WSL only; native Windows documented-unsupported. |
| O-008 | Extension isolation | Needs Validation. Candidates and the hard gate are written up in `EXTENSIONS.md` §15: filtered in-process for bundled/first-party only, child process + capability RPC for everything else; `worker_threads` and `node:vm` rejected as security boundaries. Blocking item: hostile-extension test on Termux. |
| O-009 | Tunnel lifecycle | **Closed (D-066).** Non-sticky URL, printed on every start, no redirect of the old one, 5 s drain on shutdown. |
| O-010 | Event replay | **Closed (D-049).** Per-task `seq`, count-bounded window, explicit gap + reconcile-by-GET. |
| O-011 | Context management algorithms | **Closed (D-065).** Budget/compaction/recovery are validated against the recorded acceptance list, not a benchmark. |
| O-012 | Installation and upgrades | **Closed (D-050)** for the v1 path. Still open: backup/restore specifics (O-017) and rollback behavior after a failed migration (O-013-adjacent). |
| O-013 | Checkpoint recovery semantics | **Closed (D-065).** Resume may pass only a step that is declared idempotent or whose effect is recorded; otherwise it re-asks. |
| O-014 | Event retention policy | **Closed (D-065).** 30 days or 5 000 events per task, whichever first, count visible in the task record. |
| O-015 | Memory retrieval implementation | **Closed (D-065).** SQLite FTS5 text search in v1; no vector search before a measured need. |
| O-016 | Memory deletion and privacy | **Closed (D-065).** Propagation on read, dangling references shown as deleted, never silently rewritten. |
| O-017 | Backup and restore | **Closed (D-065).** `db.backup()` + timestamped file, manual restore behind an integrity check. |
| O-018 | Secrets storage mechanism | **Closed (D-066).** Vault file with scrypt N=2^15; `termux-keystore` only when the setup probe succeeds, and the probe result is printed. |
| O-019 | Local client authentication method | **Closed (D-067).** URL and 8-character code on their own lines; code consumed by the Web first-run field. |
| O-020 | Risk classification levels for tools | **Closed (D-046).** Tier model in `SECURITY.md` §6.2, per-tool assignment in `PROVIDERS_AND_TOOLS.md` §4.2; the three judgement calls confirmed. |
| O-021 | Prompt-injection hardening depth for imported content | **Closed (D-065).** Tagged by source, treated as data, no privileged parsing; the `external content` marker is the user-visible half. |
| O-022 | Audit log redaction rules | **Closed (D-065).** Logs and exports carry no secret-shaped values; the audit record keeps the exact target in plaintext, because approving a path you cannot re-read is worthless. |
| O-023 | Remote shell posture | Accepted in D-032 (no tunnel-specific narrowing). See `SECURITY.md` §13 for the residual-risk note and the per-identity narrowing path. |
| O-024 | `termux-api` exposure | **Closed (D-066).** The initial list and its tiers are named in D-066. |
| O-025 | Mandatory per-task capability narrowing | **Closed (D-066).** Opt-in with a configured floor; not mandatory for every task. |
| O-026 | MCP server role | **Closed — non-goal (D-040).** Crabby is an MCP client only. |
| O-027 | Conversion-report history depth | **Closed (D-065).** Installed version plus the one before it; older pruned; included in exports. |
| O-028 | Bundled provider list | **Closed (D-042).** Lean presets (`groq`, `openrouter`, `ollama`, `anthropic`, `gemini`, `mock/fake`) + user-defined OpenAI-compatible endpoints (D-041). |
| O-029 | Provider retry/backoff policy | **Closed (D-064).** `1s, 2s, 4s, 8s, 16s` ±25% jitter, `Retry-After` overrides upward, floor of 5 attempts per stage stays (D-043). |
| O-030 | Provider fallback default | **Closed (D-047).** Explicit ask by default (D-043); optional narrow pre-approved ladder, reliability classes only. |
| O-031 | Token estimation when a provider has no counter | **Closed (D-064).** `max(chars/4, clusters × 1.35)`, always labeled `estimated`. |
| O-032 | Shell command classifier ruleset | **Closed (D-066).** In-tree table, versioned with the code, escalation hint only. |
| O-033 | `generic-http` user template | **Closed as rejected.** OpenAI-compatible shape is the supported custom path (D-041); a user-authored request template stays out until proven need. |
| O-034 | Local inference on Android | **Closed (D-066).** Documented unsupported on Android; external local server only. |
| O-035 | Tool output caps and temp-file lifetime | **Closed (D-064).** 64 KiB inline, larger to scratch with the path printed; scratch pruned at startup past 24 h, logged. |
| O-036 | Planning-doc checker coverage | **Closed (D-060).** `scripts/check-docs.py` is a required CI check. |
| O-037 | Capability override UX | **Closed (D-064).** Field editor with per-field prompts for scripting; same fields, one source of truth. |
| O-038 | Provider-wide capability override | **Closed (D-064).** Bulk override allowed only as an explicit action that repeats the warning per model. |
| O-039 | API versioning style | **Closed (D-067).** `/api/v1` path prefix. |
| O-040 | Web UI serving | **Closed (D-067).** Served by the Gateway from a build directory. |
| O-041 | Approval expiry policy | **Closed (D-064).** T1 15 min, T2 10 min, T3 5 min. |
| O-042 | Parity matrix source | **Closed (D-067).** §8 is generated from the registry plus annotations, with the generator committed. |
| O-043 | Web component approach | **Closed (D-068).** Framework-free custom elements; no SPA dependency. |
| O-044 | Concrete palette values | **Closed (D-068).** Values in `docs/DESIGN_SYSTEM.md` §2.3 with measured ratios; the checker recomputes them. |
| O-045 | Light theme in v1 | **Closed (D-068).** Both themes on day one; light specified, not inverted. |
| O-046 | TUI color capability detection | **Closed (D-068).** Explicit setting first, `$COLORTERM` as the default only, readable 8-color tier required. |
| O-047 | Linter/formatter | **Closed (D-060).** Biome. |
| O-048 | Biome vs ESLint + Prettier | **Closed (D-060).** Biome, as `@biomejs/biome` — the bare `biome` name on npm is an unrelated 2016 package. |
| O-049 | Package publishing model | **Closed (D-060).** Not published independently in v1. |
| O-050 | Termux CI runner | **Closed (D-060).** `termux/termux-docker` for the Node half in CI; the device checklist stays the substitute for `termux-api` and TUI measurement. |
| O-051 | TUI repaint strategy under streaming | Needs Validation (M0 P5): measure Ink's reconciliation cost for token-by-token output on a phone terminal; decide buffer/flush policy from the result. |
| O-052 | Remembered approvals after v1 | Open: whether scoped "remember this" approvals return, and with which persistence and revocation guarantees. Out of scope for v1 per D-052. |
| O-053 | Web status bar overflow at 360px | **Closed (D-067).** Four chips inline plus a `more` sheet, with vault-locked and offline escaping the sheet: the two states where the bar is the only place a user looks. Layout rule in `docs/UI_UX_SPEC.md` §2.1. |
| O-054 | TUI screen buffer vs scrollback | **Closed (D-061).** Inline, incremental, with `print to scrollback`. |
| O-055 | TUI newline key | **Closed (D-061).** `Ctrl+J` primary; `Shift+Enter` only when extended-key reporting is confirmed; `Enter` always sends. |
| O-056 | TUI markdown rendering depth | **Closed (D-061).** Emphasis, code spans, fenced blocks; everything else as text. |
| O-057 | TUI approval queue shape | **Closed (D-061).** One card plus a queue count. |
| O-058 | Terminal rendering of Bengali | **Closed (D-062).** Cluster-aware widths, cluster-boundary truncation, no grid alignment for non-Latin, English chrome, stated limit. |
| O-059 | TUI key configurability | **Closed (D-061).** Keys fixed in v1; no configuration surface. |
| O-060 | CLI task run blocking behavior | **Closed (D-063).** Blocks; `--detach` for scripts. |
| O-061 | CLI watch stream contract | **Closed (D-063).** NDJSON with per-task `seq`. |
| O-062 | Waiting for an approval from a script | **Closed (D-063).** Exits `3`; `--wait-approval <n>` is the opt-in. |
| O-063 | Shell completion and generated reference | **Closed (D-063).** Completion generated from the registry; no man page. |
| O-064 | Integrity and signing mechanism for `verified-community` distribution | Open, and it gates a tier rather than a feature: an artifact is verified by the hash recorded at install time and by whatever the publisher supplies, so `verified-community` stays unavailable until there is a scheme that works **without a hosted service** (the constraint in `EXTENSIONS.md` §15). Closing step: pick one local-verifiable mechanism — a detached signature over the artifact plus a publisher key pinned in Crabby's own config — and write its revocation story before the tier is offered. Until then `ext install` reports the tier it *cannot* assign, not a guessed one. |
| O-065 | Sandbox enforcement on Termux | Needs Validation, measured not designed: `SECURITY.md` §15 states the honest position (no application sandbox between Crabby and Termux's data dir), and `EXTENSIONS.md` §15 lists the candidates. Closing step is M0 P7 with P6's process-kill notes — attempt `fs`/`net`/`child_process` access from a restricted candidate and record what the platform actually refuses. The fallback is not a weaker sandbox, it is a **documented platform limitation** plus the O-008 gate staying shut for untrusted executable code on that platform. |

**Open here means genuinely undecided.** A row marked closed must stay consistent with the decision it cites.

## 5A. TUI Library Evaluation Record

**Evidence source:** npm registry metadata read on 2026-10-09. Runtime behavior on Termux is **not** measured
here — that is what `docs/ROADMAP.md` M0 P5 exists for.

| Candidate | Latest | Published | Engines | Native modules | Assessment |
| --- | --- | --- | --- | --- | --- |
| **Ink** | 8.0.0 | 2026-10-03 | `node >=22` | none — all 23 direct deps and the layout engine are pure JS | **Recommended.** Actively maintained; React model matches the Web UI stack, so component and state patterns are shared across two interfaces; Yoga flexbox is exactly what a 40-column layout needs |
| neo-blessed | 0.2.0 | 2018-06-13 | `node >=8` | none | Rejected. Two published versions, ~8 years dormant; `blessed` upstream is unmaintained |
| OpenTUI (`@opentui/core`, `@opentui/react`) | 0.5.17 | 2026-10-08 | `bun >=1.3.0`, `node >=26.4.0` | Zig core via FFI bindings | Deferred as primary. Fast and actively developed, but it requires Bun or Node ≥26.4 (conflicts with D-015's Node LTS plan) and a native/FFI layer — the exact Termux risk class `DECISIONS.md` §5 flags. Revisit if Ink's repaint cost proves unacceptable at streaming volumes |
| Build directly on `node:readline` + ANSI | — | Node built-in | n/a | none | Fallback if both fail the Termux probe. Cheapest possible footprint, most code owned |

Selection rationale against Crabby's constraints:

- **Termux:** no `node-gyp`, no prebuilt binaries, no native addon is the single strongest filter. Ink passes cleanly.
- **Single React model:** TUI and Web share components, state logic, and the token layer (`docs/DESIGN_SYSTEM.md` §9).
- **Node LTS alignment:** Ink 8 requires `node >=22`; the reported Termux range is v22–v26 (`§5.3`), so it fits.
- **Streaming cost** is the known risk of a reconciling renderer in a terminal. `docs/ROADMAP.md` M0 P5 must measure
  line-buffered output at 40 columns rather than trusting a benchmark; a failure reopens OpenTUI or the readline
  fallback, and that outcome is recorded as a *useful* M0 result, not a setback.
- Anything layered on top (termcn-style component collections) is treated as copy-in source, not a dependency, so it
  cannot smuggle in an install-time native build.

## 4A. Traceability — Which Document Enforces Which Decision

An accepted decision with no enforcing document is a decision nobody implements, so every `D-` row must appear at
least once below. Adding a decision without naming its enforcer is a documentation failure, not a detail.

| Enforced by | Decisions |
| --- | --- |
| `DECISIONS.md` itself (register governance, review status) | D-059, D-075, D-076|
| `PROJECT_BRIEF.md` (product scope, platforms, principles) | D-001, D-002, D-003, D-004, D-016, D-017, D-019, D-021 |
| `ARCHITECTURE.md` (structure, contracts, platform) | D-006, D-007, D-008, D-009, D-010, D-011, D-012, D-015, D-032, D-045, D-048, D-049, D-050, D-053, D-060, D-066, D-068, D-069, D-070|
| `AGENT_RUNTIME.md` (execution lifecycle) | D-018, D-022, D-023, D-024, D-025, D-026, D-027, D-028, D-029, D-044, D-074|
| `SECURITY.md` (policy, authn, secrets, exposure) | D-005, D-013, D-014, D-020, D-030, D-031, D-033, D-040, D-043, D-046, D-047, D-051, D-052, D-053, D-054, D-064, D-065, D-066, D-067, D-071|
| `EXTENSIONS.md` (packaging, compatibility, trust) | D-035, D-036, D-037, D-038, D-039, D-040, D-065, D-071, D-072|
| `PROVIDERS_AND_TOOLS.md` (adapters, tools, tiers) | D-041, D-042, D-043, D-044, D-045, D-046, D-047, D-057, D-064, D-066, D-074|
| `docs/DATA_AND_MEMORY.md` (persistence, memory, deletion) | D-017, D-018, D-019, D-020, D-021, D-065, D-073|
| `docs/INTERFACES_AND_API.md` (API surface, parity) | D-005, D-030, D-048, D-049, D-051, D-052, D-053, D-057, D-058, D-063, D-067, D-069|
| `docs/UI_UX_SPEC.md` + `docs/DESIGN_SYSTEM.md` (presentation) | D-005, D-045, D-046, D-052, D-057, D-058, D-061, D-062, D-068 |
| `docs/review/*.md` (element inventories, per D-055/D-056) | D-005, D-045, D-046, D-052, D-055, D-056, D-057, D-058, D-059, D-061, D-063, D-075|
| `docs/ROADMAP.md` + `docs/DEVELOPMENT.md` (sequencing, workflow) | D-016, D-034, D-050, D-051, D-060, D-066, D-069, D-070|
| `AGENTS.md` (agent contract) | D-013, D-014, D-016, D-026, D-034, D-038, D-040, D-043, D-044, D-052, D-076|

Rules: a decision may be enforced by several documents but must be enforced by at least one; the enforcing document
states the behavior and this register records the status; and no document restates a rule it does not own — which is
exactly how the stored-approval and export-endpoint contradictions described in
`docs/CONSISTENCY_REVIEW.md` came to exist.

## 4B. Element Review Progress (`docs/review/`)

Per D-055, interface review proceeds as element inventories. An element counts as reviewed only when its row's
`Status` changes from `PROPOSED`; `scripts/check-docs.py` counts the rows so progress is measured, not estimated, and
`python3 scripts/count-inventory.py --markdown` prints the table below so it is pasted, never typed.

| File | Surfaces covered | Elements | Approved | Remaining |
| --- | --- | --- | --- | --- |
| `docs/review/WEB.md` | 19 regions of the Web UI | 185 | 185 | 0 |
| `docs/review/TUI.md` | 21 regions of the TUI | 203 | 203 | 0 |
| `docs/review/CLI.md` | 15 regions of the CLI | 158 | 158 | 0 |
| `docs/review/TELEGRAM.md` | 11 regions of the Telegram interface | 129 | 129 | 0 |

Review medium (D-056): `python3 docs/review/mockups/build.py` renders `docs/review/WEB.md` into
`docs/review/mockups/crabby-web-ui.html` — one self-contained file, no network, no CDN. The build fails if the mockup
references an element the inventory does not define, or if the inventory has a row the mockup cannot place, so
the picture cannot drift from the document. Decisions made in the mockup leave it as paste-ready rows; nothing
the mockup stores counts until it is written back into the `.md`.

All four inventories exist: 185 Web + 203 TUI + 158 CLI + 129 Telegram = 675 elements, and their review was the gate
before `docs/UI_UX_SPEC.md` and `docs/DESIGN_SYSTEM.md` could be regenerated from them. That gate is closed (D-075),
and the regeneration itself is scheduled at `docs/ROADMAP.md` M0 P8 so it follows the measurements that can still
change a row. 25 rows were left `PROPOSED` in the
(R) round of 2026-10-10, and one row was added by it — T-A14, the approval queue walk that D-061 makes necessary.
The rule the round held itself to: a row was flipped only when the one thing blocking it was an open question that
D-060…D-068 has now answered, and the row names its decision inline, so rejecting a decision puts its rows back
with one search. Nothing was flipped for looking obviously fine. The remaining 650 were then reviewed under delegation
(D-075) on 2026-10-10, when the owner said they had no time to read a table of 650 rows and asked for the pass to be
run per the reviewer's own recommendations: every row is `ACCEPTED` now, `Remaining` is zero, and the criteria the pass
applied are printed in `docs/review/README.md` rather than summarized here, because a gate that cannot be re-run is a
claim. Two rows were corrected by that pass — both for carrying a hand-typed count that had gone stale (F-22) — and
nothing was cut, so no capability lost an interface and §8 of `docs/INTERFACES_AND_API.md` needed no edit. Review did
not end, it moved: D-076 puts it at each implementation step, where the owner sees a running screen instead of a row.

An open question written in an inventory is not left inside the inventory: each one that changes what gets built is
registered as an `O-` row in section 4 (the Web, TUI and CLI questions became O-053…O-063, and all eleven are closed by D-061…D-067; the measurements they were entangled with are not — O-006 and O-051 on repaint cost still gate rows like T-C6 and the transcript caps that hang off it (T4-05, T15-08), which is why those rows stay labelled as unvalidated instead of approved), so review progress and
unresolved questions are counted in the same register as everything else.

All four inventories are reviewed, so the regeneration gate is open: `docs/UI_UX_SPEC.md` and
`docs/DESIGN_SYSTEM.md` are now to be written *from* the accepted rows, then `docs/CONSISTENCY_REVIEW.md` re-run (a
spec written from approved elements cannot contradict them). That pass is scheduled as `docs/ROADMAP.md` M0 P8 and is
document work, not new design: it is listed there so nobody implements M1 against a spec that is one round behind the
inventories it is supposed to come from.

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
13. No request from any interface is processed without an identified paired client identity (D-030).
14. Secrets never share a storage location with conversation, configuration, or log data (D-031).

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

**Done this round:** M-D opened with a mechanical consistency review (`docs/CONSISTENCY_REVIEW.md`); D-030 (pairing tokens), D-031 (secrets), D-032 (remote posture),
D-033 (`termux-api` tiers) accepted and propagated.

1. ~~Write `EXTENSIONS.md`~~ done — D-035…D-039 accepted, O-008 narrowed to a validation gate, first-release scope confirmed (no third-party executable).
2. Review `EXTENSIONS.md` for scope: confirm the initial release really only needs skills + commands + MCP client + first-party tools.
3. ~~Write `PROVIDERS_AND_TOOLS.md`~~ done — provider contract, tool registry, tier table (§4.2) proposed;
   O-020 narrowed, O-028…O-036 opened. `device.*` and read-side capabilities added to the `SECURITY.md` §6.1
   vocabulary so no tool references an undefined grant.
3b. Add `scripts/check-docs.py` to a pre-commit or CI step once the repository has workflows (O-036).
4. ~~`docs/INTERFACES_AND_API.md`~~ · ~~`docs/UI_UX_SPEC.md`~~ · ~~`docs/DESIGN_SYSTEM.md`~~ ·
   ~~`docs/ROADMAP.md`~~ · ~~`docs/DEVELOPMENT.md`~~ · ~~`AGENTS.md`~~ all written this round.
5. **M-D in progress:** cross-document consistency review written up in `docs/CONSISTENCY_REVIEW.md`. Four
   blocking items closed this round (O-004, O-010, O-012, O-019). Remaining blockers need a device: O-002
   (driver reproduction), O-006/O-051 (TUI repaint measurement), which is exactly M0 P3/P5 work.
7. M-D mechanical findings and their fixes are recorded in `docs/CONSISTENCY_REVIEW.md`; five defects were found and
   repaired, including two real contradictions (stored approvals, export endpoint) and one policy deadlock
   (`--restrict` vs T3 approval on a restricted identity).
6. Then M0 Termux validation prototype. Still no product code before M-D finishes and those gates are addressed.

| Counter | Value |
| --- | --- |
| Accepted decisions | 76 (D-001…D-076) |
| Proposed technical choices | 10 (P-001…P-010) |
| Open / needs-validation items | 65 tracked (63 from the (R) round plus O-064 and O-065 registered while finalizing), 50 of them closed by D-060…D-068 in the (R) round of 2026-10-10; closed earlier as decided: O-004, O-010, O-012, O-019, O-020, O-026, O-028, O-030, O-033. O-023 is closed by D-032 under the wording "Accepted in D-032" rather than "Closed by" — the phrasing a count-by-hand pass misreads, so `scripts/count-inventory.py --register-counters` prints the ids it could not classify instead of a bare number. Six items carry work and each has its closing protocol in `docs/review/DECISION-QUEUE.md` §2 rather than a vague promise: four open rows (O-006 and O-051 need a phone render, O-008 needs real extensions, O-052 is a post-v1 design question) and two with one measured clause left (O-001, O-002: a clean Termux build and a WAL torture). The row count stays 63 because a closed question keeps its number — otherwise a register that renumbers itself cannot be cited by a document that was written against it |
| Planning docs written | 16 — includes `docs/CONSISTENCY_REVIEW.md` (M-D record) |
| Custom endpoint / fallback decisions | D-041…D-047 accepted this round |
| Finalization round (D-071…D-076) | The four questions still answerable without a phone — skill frontmatter, host API versioning, memory provenance, timeout and concurrency defaults — plus the delegated element review (D-075) and the review protocol that keeps it honest (D-076) |
| Element review (`docs/review/`) | 675 of 675 rows `ACCEPTED`: 25 by D-059's narrow exception, 650 by the delegated pass in D-075; `Remaining` is 0 and review continues per step (D-076) |
| Planning docs remaining | 0 (M-D review is the last step) |

**The `P-` table, honestly counted.** Four of the ten rows are Accepted (P-001, P-002, P-005, P-009), three are
Superseded (P-006, P-007, P-008) and three are **Needs Validation** (P-003, P-004, P-010) because only a phone can
move them. That sentence previously read "five… four…
three": twelve statuses spread across ten rows, which is what a count typed from memory looks like — nobody noticed it
for a round, and no reader would (`docs/CONSISTENCY_REVIEW.md` F-20). No row sits at `Proposed` with no
blocker named, and rule 14 of `scripts/check-docs.py` keeps it that way: a `P-` row outside
`Accepted`/`Superseded` must cite an `O-` row that is still open. The Superseded rows are kept rather than deleted —
a register that erases its rejected options cannot be audited for having considered them. What this table looked like
before this pass (Zod and React+Vite offered as live proposals after the decisions that killed them) is
`docs/CONSISTENCY_REVIEW.md` F-17, and it is why the checker rather than a reviewer now keeps it honest.

**About the (R) marker.** D-059…D-068 were recorded on 2026-10-10 under the owner's instruction to research the open
items and arrange everything according to the agent's recommendations, and D-071…D-074 under the follow-up to finish the
job the same way. The marker now covers fourteen rows, all recorded the same afternoon, and the instruction behind them
is worth stating precisely because it is *not* a blanket approval: the owner asked for the objectively-decidable
questions to be researched and closed, and for nothing that needs a phone to be dressed up as decided. Each row names
the evidence behind it, and rejecting one sends that row back to `Proposed` or `Open` without disturbing its
neighbours — the veto path is in `docs/review/DECISION-QUEUE.md`. The owner's authority is unchanged: **(R)** says how
a row got here, not that it is untouchable.

Run `python3 scripts/check-docs.py` after editing any planning document (and `python3 scripts/review-scan.py` after
editing an inventory — the two overlap on purpose, since the second one's rules are the first one's evidence). It verifies ID references, cross-references,
section anchors, capability coverage, traceability of every accepted decision to a document that enforces it, the
element counts in `docs/review/`, the §8 counters and the §2.3 palette ratios, that an open-questions list names the
decision owning each line (rule 15), that Markdown tables are rectangular (rule 16), and that no document claims an
implementation exists. `docs/CONSISTENCY_REVIEW.md` §3 is the record of what each rule exists because of: rules 1–5 are
ordinary lint, and rules 6–17 each exist because something specific slipped past the checks that came before them.

**Implementation remains out of scope until the planning documents and required decisions have been reviewed.**
