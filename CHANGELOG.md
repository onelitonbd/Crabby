# Changelog

User-facing changes only, newest first — features, fixes, security notes, and **platform-limitation changes**
(`docs/DEVELOPMENT.md` §9: a change to what a platform supports is a documented change, never an implementation
detail). Versioning is semver with an honest `0.x` phase: minor bumps may break, and each break is written here
with its migration step (D-143). Tags are `v0.x.y`, cut from CI at a release.

The version field stays `0.0.0` until the first release. **`v0.1.0` is cut when phase M6's exit bar passes** — a
new user, following only the docs on a phone, reaches a completed multi-step task with approvals and hits nothing
the limitations page did not mention. Everything before that lives under *Unreleased*, organized by the phase that
shipped it; the per-slice detail behind every line is in `docs/ROADMAP.md`, which gains one paragraph per slice.

## [Unreleased]

### M6 — release readiness (in progress, 2026-10-17)

- **Added: `crabby backup [destination]`** (D-142) — one timestamped directory holding the database (copied with
  the driver's online backup API, safe while a Gateway is writing), `config.json`, `extensions/` and `mcp/`, plus a
  `manifest.json` naming every exclusion with its reason. Secrets are excluded by default: the vault's file and the
  two bearer-token files never ride in a backup. The copy must pass `integrity_check` before the backup exists —
  an unverified copy is deleted, not kept. **Restore is a documented manual step** (`docs/DATA_AND_MEMORY.md` §8);
  nothing prunes `backups/`, and the verb prints the one disclosure that matters: data deleted after a backup was
  taken comes back when it is restored.
- **Security-tested: the §17 injection corpus** (`tests/security/injection.test.ts`) and the migration-failure
  clause ("a failed migration leaves the previous file untouched") are now tests rather than promises.

### M5 — security hardening, remote access, isolation decision (complete 2026-10-17)

- **Added: the secrets vault** (D-139) — OS keychain back ends where they exist; everywhere else a
  passphrase-encrypted file (`~/.crabby/vault`, scrypt N=2¹⁵, per-install salt, per-write GCM IV, parameters
  pinned inside the file so a future change reads old files instead of corrupting them). Lock state is visible
  everywhere; `crabby vault set/get/list/delete/unlock/lock`; provider keys are referenced as `vault://name` and
  are never stored in `config.json`. A wrong passphrase is a clean refusal, and the weaker file-store protection
  is disclosed in the status it reports.
- **Added: the Cloudflare Quick Tunnel** (§13, D-066's lifecycle) — `crabby tunnel on` is one confirmed decision:
  the prompt lists which paired identities become remotely reachable, the URL is printed on every start and never
  remembered, `tunnel off` closes the child process group for real, and `POST /api/v1/tunnel` refuses a second
  start with `tunnel_active`.
- **Added: `crabby auth list` last-seen** — each identity shows `last seen` / `never used`, because "idle since
  the 14th" and "in active use" are different revocation decisions.
- **Added: `crabby doctor --security`** — the security-relevant subset of the checks plus a plain-language
  posture summary (workspace confinement, ask-first approvals, the vault's actual state, and the Termux no-sandbox
  sentence), in the rendered lines and in `--json`.
- **Security-decided: O-008's gate is final** (D-140) — untrusted executable code stays off by every path until a
  candidate passes the injection corpus on the primary platform. `worker_threads` and `node:vm` remain rejected as
  security boundaries.

### M4 — providers, memory, extensions (complete 2026-10-17)

- **Added: provider adapters with a conformance suite** (D-042) — the lean preset set (`groq`, `openrouter`,
  `ollama`, `anthropic`, `gemini`, mock) plus D-041's rule that any OpenAI-compatible endpoint attaches by base
  URL and key, with no code change and no extra trust. A model's capability descriptor is user-overridable
  (D-126's editor), and the model probe answers per model with its own wall.
- **Added: memory** (D-065's FTS5 store) with executor-side tools — ordinary text search in v1, automatic creation
  under user control (D-019), and deletion that says what it deleted.
- **Added: the skills layer and `crabby ext` verbs** (D-035) — inert SKILL.md import with a deterministic
  compatibility verdict, per-version conversion reports that never overwrite (D-039), and imported content can
  grant itself nothing: `allowed-tools` is read for the report and granted never.
- **Added: the §10 MCP client** (D-040) — stdio and HTTP/SSE transports, tier-classified tools, capped output;
  `crabby mcp add` imports a foreign servers.json with names kept and values dropped (D-137).
- **Added: the route gaps that close the contract** (D-133) — `each` scheduling, `GET /auth/whoami`, `GET /logs`,
  `GET /audit`, `DELETE /jobs/{id}`, and the model-probe route; §4.6's extension routes write the same
  `extension_install` audit trail the CLI writes.

### M3 — four interfaces (built 2026-10-16; the four-interface demo remains owner-device work)

- **Added: the TUI** (D-129 — zero dependencies, deliberate) with six wired panes: chat with the real cursor and
  input history, tasks with filters, the approvals modal, jobs, models with the override editor, and logs.
- **Added: the Web UI** (D-067/D-068) — served by the Gateway itself as no-build custom elements, one origin, one
  certificate story.
- **Added: Telegram** (D-132) — silent gate, in-chat pairing to per-chat identities, a command table, approvals as
  `apr:<id>:<nonce>`, paced delivery with recorded failures. Never yet run against a live token; the wire check is
  `npm run telegram:check` on the owner's device.

### M2 — core runtime and Gateway

- The task state machine, the execution loop, risk-tiered approvals bound to the exact action, cancellation with
  its two phases and its honest "in doubt" answer, checkpoints and recovery, the scheduler, the tool set behind
  the capability vocabulary, event delivery with replay and gap frames, compaction that never destroys originals
  (D-027), and pins.
- **Security posture landed as code:** the wrapper for untrusted tool output carries a per-call nonce (D-098), so
  content cannot close its own frame; redaction happens before anything leaves the process; `shell.run` is never
  in a fresh baseline.

### M1 — contracts and skeleton

- The API contracts (`@crabby/api-contracts`), the Gateway skeleton on loopback with pairing tokens (D-030), the
  policy engine's capability check, the fake provider the suite still runs against, the parity test that keeps
  `docs/INTERFACES_AND_API.md` §8 and the registry one grammar, and CI with the checks that gate every push.

### M0 — Termux validation prototype (container half 2026-10-10)

- The probes and their generated results (`probes/RESULTS.md`): what a clean environment does and refuses, with
  the phone column still owed by the owner's device. P-003/P-004/P-010/P-011 stay Needs-Validation until it runs.

### M-D — planning documents (2026-10-10)

- The sixteen planning documents, the decision register, the 675-row element review (D-075), and
  `scripts/check-docs.py` — the checker that has kept documents and code agreeing since.
