# HANDOVER.md — where Crabby is, and what to do next

**Written by the agent that built slices 42–58, on 2026-10-16, at the owner's request; slices 59–63 (the TUI element
rows), 64 (the Web UI) and 65 (the Telegram adapter) were built afterwards and this file was corrected in the same
changes, per its own rule.** Everything here is a fact about
the repository at commit `main`, not a plan. If something here disagrees with the code, the code is right and this file is
stale — fix this file in the same change.

## 1. Read these first, in this order

`AGENTS.md` is binding and this repository's rules are unusual in three ways that will bite you:

1. **An element row in `docs/review/*.md` is a specification.** It was written by a delegated review pass (D-075) and every
   row is `ACCEPTED`. Implement what it says. If the row turns out to be wrong in practice, implement it anyway and raise the
   discrepancy for the owner (D-076).
2. **The status of a decision is not yours to promote.** `Accepted (D-)` → implement. `Proposed (P-)` → implement only if
   asked, and write `// PROPOSED P-0xx — not accepted` near the code. `Open / Needs Validation (O-)` → **stop and ask**.
   Inventing a settled answer is the single most damaging thing an agent can do here.
3. **The phone is the platform, and it is slow.** CI on GitHub is the verification of record. Do not run full test suites,
   `tsc`, or repo-wide lint on the device; run one test file at a time.

Then: `PROJECT_BRIEF.md` → `ARCHITECTURE.md` → `DECISIONS.md` → the spec for your area
(`PROVIDERS_AND_TOOLS.md`, `AGENT_RUNTIME.md`, `SECURITY.md`, `docs/INTERFACES_AND_API.md`, `docs/UI_UX_SPEC.md`).

## 2. Where the work is

**M2 is complete.** The whole runtime and Gateway exist: state machine, loop, approvals, cancellation, checkpoints,
recovery (including cross-process resume), scheduler, tools, event delivery, compaction with automatic and manual triggers,
and pins.

**M3 is code-complete, and every gate that can run without a Telegram socket passes.** What remains of the phase
exit is **only the four-interface demo**, which awaits the live-token check on the host: `TG_BOT_TOKEN=… npm run
telegram:check` (the build sandbox cannot reach `api.telegram.org`), then the demo — a task started on Telegram,
watched from Web, approved in the TUI, cancelled from the CLI — documented as the release test.

**M4 is complete (2026-10-17).** All of its scope landed: provider adapters with the conformance suite (D-042), the
per-model override editor (D-126), memory (D-065's FTS5) with the executor-side tools, the skills layer (D-035), the
`crabby ext` verbs (C-E1…C-E12), the §10 MCP client with its C-2 import (D-040/D-137), `each` plus the route gaps the
owner named — whoami, `/logs`, `/audit`, `DELETE /jobs/{id}`, the model probe (D-133) — and §4.6's extension routes
over the installed-record store, with both faces writing §14's `extension_install` trail. The exit gate holds: a
SKILL.md import shows every transferred key in its report, and imported content can grant itself nothing — tool
names are read for the capability diff and granted never. Full sweep 1466/1466, typecheck, biome, parity
(47 routes, 45 tools, 32 capabilities), docs:check.

**M5 is complete (2026-10-17).** All of its scope landed: the vault (D-139 — scrypt/GCM file store with the
unset→locked→unlocked state machine, `crabby vault set/unlock/lock`, hot unlock re-composition, and the `vault://`
resolution F-56 asked for), the quick tunnel (D-066's O-009 mechanics as the confirm-gated `POST /api/v1/tunnel`
with its `tunnel_active` conflict, plus `crabby tunnel on/off/status`), §4.5's read-through (D-141 — the vault-job
defer clause is satisfied by the composition's visible reasons, no new run state), and O-008's gate made final
(D-140) with §17's injection fixtures (`tests/security/injection.test.ts`) proving the import path's four attack
shapes. The auth list shows each identity's last-seen time, and `crabby doctor --security` prints the security
subset with plain-language posture sentences. Full sweep 1486/1486, typecheck, biome, parity (51 routes, 45 tools,
32 capabilities), docs:check.

**M6 is underway (2026-10-17).** Its first slice shipped `crabby backup` (D-142): the online backup verb with a
verified copy and a named-exclusions manifest, secrets excluded by default, restore kept a documented manual step
(`docs/DATA_AND_MEMORY.md` §8 has the four moves), and the migration-failure clause finally a test. The changelog
exists (`CHANGELOG.md`, D-143 — `Unreleased` accumulates, `v0.1.0` is cut at this phase's exit bar), the license
audit is `npm run license:audit` (D-144 — allowlist, fails on anything outside it) and `LICENSE` (MIT) plus
`THIRD-PARTY-NOTICES.md` are in the repository. The install path is written and rehearsed (`docs/INSTALL.md`,
D-050's path; `engines.node >=22.22` pinned from the P1 measurement), and the release pages exist: README told the
truth about the phase, `docs/LIMITATIONS.md` is §18-09's user-facing page, `docs/TROUBLESHOOTING.md` pairs real
refusal sentences with the command that fixes them. What the phase still owes **this repository**: the `v0.1.0`
cut at the exit bar — and the exit bar itself is owner-device: the Termux install rehearsal (O-001's last clause),
the performance pass, the probe phone column, and the Telegram wire check with the M3 demo.

| Workstream | State |
| --- | --- |
| CLI | **Largely done.** 30 commands live; the registry (`apps/cli/registry.ts`) is the authority on what is `ready`. |
| TUI | **Built.** All six panes draw real content, and the views inside them are wired: `chat` (composer with the real cursor, T5-02; input history on ↑/↓, T5-09; the overflow warning, T8-08), `tasks` (T6-01's filter row), `approvals` (T-A's modal), `jobs` (T17), `models` (T11, editor included, plus T12's tools view on `t`), `logs` (T15's decisions + diagnostics, T14's access view and T13's config view on `v`). The log/audit *views* still name their route gaps (see §7) and `model probe` names its own (T11-07). |
| Web UI | **Built** (slices 64, D-068/D-067) — the Gateway serves `apps/web` as no-build custom elements; eight screens, §13's asset/API token split tested; route-less places name their gaps by name. |
| Telegram | **Built** (slice 65, D-132) — `packages/telegram` over grammY: silent gate, in-chat pairing to per-chat identities, 36-row command table, `apr:<id>:<nonce>` approvals, paced delivery with recorded failures, SSE watch, `telegram.json` state (D-078's sixth file). **Never run against a live token yet** — the owner's first was revoked; a fresh one arrived on 2026-10-16, but the build sandbox cannot reach `api.telegram.org` (its egress allowlist cuts the TLS handshake), so `npm run telegram:check` was added: it exercises `getMe`/`setMyCommands`/`getUpdates` through the adapter's own transport and is meant to run **on the host**. The wire check is pending that run; `vault://` resolution **landed with M5** (D-139, F-56). |

**Phase exit for M3** (`docs/ROADMAP.md` §5): the parity test walks `docs/INTERFACES_AND_API.md` §8 with every blank cell
carrying an accepted limitation — **that half passes** — and one task is started on Telegram, watched from Web, approved in
the TUI, cancelled from the CLI — in one demo, documented as the release test. **The demo is the remaining M3 work, and it
needs a live Telegram token.**

Decisions run to **D-145**; open questions to **O-075**. O-008's gate is final (D-140) — the strategy half is post-v1. `docs/ROADMAP.md` has one paragraph per slice (39–86) — read the
last three to know what just happened and why.

## 3. The last three slices, and the bugs they found

- **75 (D-139)** — the vault: scrypt/GCM file store whose KDF parameters are pinned inside the file, per-session
  lock over the running Gateway's routes, hot unlock re-composition, `vault://` resolution at compose time (F-56),
  and the audit trail's eighth kind.
- **76** — the quick tunnel: one confirmed decision over the wire (§13), `tunnel_active` conflict, the URL printed
  per start and never redirected, the `tunnel` audit kind, `crabby tunnel on/off/status`.
- **77** — the last-seen row (`auth list` finally shows `lastUsedAt`) and `doctor --security`'s plain-language
  posture, riding both the rendered lines and the `--json` document.
- **78 (D-140/D-141)** — O-008's gate made final, §17's injection corpus, §4.5's read-through, and the documents
  caught up with the decisions (§19's stale still-open list, §18's met-markers, §20's test column, D-078's sixth
  file name).
- **72 (D-040/D-137)** — the §10 MCP client: `initialize` + `tools/list` + `tools/call` over stdio (one JSON per line)
  and HTTP (POST JSON-RPC, SSE answers tolerated, `Mcp-Session-Id` echoed); server entries in `<stateDir>/mcp/
  servers.json` (env names only, never values), and the C-2 import turns a `claude mcp` config into Crabby entries at
  a T2 capability floor.
- **73 (D-133)** — the route gaps the owner named, closed together because they share one contract slice: `each`
  (one fire → one run per occurrence), `GET /auth/whoami` (the caller's own grants row — the TUI's capability line
  prints real grants now), `GET /logs` (the ring buffer, level floors, redaction before delivery), `GET /audit`
  (§14's trail as a route, `aud_` cursors), `DELETE /jobs/{id}` and the model probe route with its per-row 20 s wall.
- **74 (this slice)** — §4.6's extension routes over `<stateDir>/extensions`: the list carries each pack's verdict,
  install runs the CLI's no-override verdict first (C-E6 over the wire), a re-install is D-039's update with reports
  never overwriting, reports answer newest first, uninstall leaves a trail row — and the CLI's `ext install` now
  writes the same trail row its route writes, plus the fix for `ext install --json` answering an empty stdout (it
  answers `{code:"approval_required"}`, exit 3, when `--yes` is missing).

**T5-06 is answered (slice 73).** The capability line under the composer used to print the documented conservative
defaults, because nothing answered **"which identity am I"**. `GET /api/v1/auth/whoami` now does — the caller's own
grants row, with the executor's declared surfaces beside them — and the TUI prints the real grants, falling back to
the conservative defaults with a note only when the route says nothing.

Four bugs in this stretch were found **by running the TUI**, not by tests, and each is now either a test or a comment:

1. `crabby tui` printed "not implemented yet" — the registry's planned-verb branch answered before the dispatcher's branch
   that starts the app, so a built app was unreachable by name. The `tui` row was **removed** rather than marked ready: that
   table holds commands, and the TUI is an application.
2. A pty with no window size set reports `columns: 0`, and the TUI read `process.stdout.columns` directly and drew nothing.
   `terminalFacts` now treats zero as an absent measurement.
3. `TaskReader.listTasks` promised `{ items }`; the real client returns `Response<T>`. The cast that let it compile was the
   cast that hid the envelope, so the app threw on its first frame. **An injected dependency's interface is the
   dependency's shape, never the convenient shape.**
4. Listeners were attached *after* the first frame, so an early keystroke was dropped and an early `stdin` end hung the app
   forever. Android kills this process whenever it likes; an app that hangs instead of exiting is the failure `AGENTS.md` §8
   is about.

## 4. Where the local tooling lives

`biome` has no native binary on Termux, so three WASM scripts stand in for it. **They are the reason two CI runs went red
in this stretch — use them before every push.**

| Script | What it does |
| --- | --- |
| `/tmp/opencode/diag2.mjs` | Biome diagnostics over every tracked file (`pullDiagnostics` with `syntax`, `lint`, `action`, `transformation`) |
| `/tmp/opencode/fmt-check.mjs [--write]` | `formatFile` over every tracked file — **separate from the fixer on purpose**: `fixFile` did not reformat one file CI rejected |
| `/tmp/opencode/biome-fix.mjs [--write] <files>` | `fixFile`, which catches `organizeImports` and `useTemplate` but *not* formatting |

`/tmp` is wiped on reboot — if they are gone, rewrite them from this table; do not skip the checks.

Pre-push sequence that has kept `main` green:

```
npx -y -p typescript@5.9.2 tsc --noEmit -p tsconfig.json      # once per slice
node /tmp/opencode/fmt-check.mjs --write && node /tmp/opencode/fmt-check.mjs
node /tmp/opencode/biome-fix.mjs --write <changed files>
REPO=$PWD node /tmp/opencode/diag2.mjs                        # expect nothing outside biome.json
npm run test:parity && npm run docs:check
git add -A && git commit && git push origin main
gh run list --limit 1 --json databaseId,conclusion
```

Ignore `/biome.json:2:14 deserialize` — pre-existing, CI is green with it. `docs/review/mockups/*` is excluded by
`biome.json`.

## 5. Reading CI when it fails

```
RUN=$(gh run list --limit 1 --json databaseId --jq '.[0].databaseId')
JOB=$(gh api repos/onelitonbd/Crabby/actions/runs/$RUN/jobs --jq '.jobs[] | select(.name=="linux-x64") | .id')
gh api --allow-escape-sequences repos/onelitonbd/Crabby/actions/jobs/$JOB/logs > /tmp/ci.log
sed -e 's/\x1b\[[0-9;]*m//g' /tmp/ci.log | grep -nE "lint/|not ok|# fail|Found [0-9]+ error"
```

Without `--allow-escape-sequences` the log download refuses to print. Step-level failures carry no file annotations, so the
log is the only place the answer is.

## 6. What to do next, in this order

1. ~~**TUI approvals modal** (region T-A)~~ — **built** (one card, `n`/`p` walk, typed yes/no, `Esc` refused on a
   blocking approval, `conflict` printed when another interface answered first).
2. ~~**TUI jobs / logs / models panes**~~ — **built** (T17/T11 complete; T15's decisions + diagnostics wired). The
   remaining gaps are routes, not panes: `GET /logs`, `GET /audit` (T15-01/03's views) and `POST /models/…/probe`
   (T11-07) — see §7. T11-04's `reserve` input is drawn and reported as not-stored (F-62 refused the field).
3. **`model probe`** (C7-09) — deliberately unbuilt: it needs a credential a Gateway holds, so it wants a **route**, not a
   CLI verb. D-125 says where it stands.
4. ~~**Web UI**~~ — **built** (slice 64): the Gateway serves the no-build bundle; screens per `docs/review/WEB.md`'s
   accepted rows, gaps named where routes are absent.
5. ~~**Telegram**~~ — **built** (slice 65, D-132): polling, not the tunnel — v1 is getUpdates over the loopback-owned
   Gateway. The un-run verification is one command on the host: `TG_BOT_TOKEN=… npm run telegram:check` (token from
   @BotFather; env-only, G1-03). **M3 is otherwise closed; M4 and M5 are complete** (see §2) — the demo remains the one
   open item, and it folds in the day the token check passes. What follows M5 is post-v1: O-008's isolation
   strategy (a candidate implementation to point D-140's corpus at) and O-065's Termux sandbox measurement.

## 7. Things that are open and belong to the owner

- **T17-07's backlog answer `each`** — **answered (D-133): `each` joins the contract**, and the scheduler's fire path
  enqueues one run per occurrence; the per-occurrence walk note retires with the slice that lands it.
- **`GET /logs` and `GET /audit`** — **answered (D-133): both enter M4**, with the log store and §14's audit fields
  they need; the whoami route, `DELETE /jobs/{id}` and the model probe route enter with them.
- **T11-04's `reserve` input** — the row prices three typed limits including `reserve`; F-62 closed `reserveForOutput`
  as derived (D-064) and the record has no column for it. The TUI draws the input (the row, as written) and reports
  `reserve is derived … (F-62)` on save without storing it. If the owner wants it stored, §3.8's schema and D-064
  revisit; if the row should drop it, D-076 reopens T11-04.
- **T17-05/W16-11's delete** — **answered (D-133, slice 73): `DELETE /jobs/{id}` exists**; the scheduler refuses to
  fire a job someone is deleting, the TUI's typed-name confirmation really deletes, and the audit trail holds a
  `job_delete` row.
- **T17-06/C12-05/W16-06's objective edit** — a material change is re-approval (§4.5) and nothing here can open one
  (D-084). The form collects both fields and the save prints the notice and writes nothing for an objective change; the
  schedule half lands through `PATCH /jobs/{id}`. Same decision the CLI made in leaving `job edit` planned.

- **O-006 / O-051, and P-010 / P-011.** The TUI's renderer is the `node:readline` **control** that `docs/ROADMAP.md` M0 P5
  names, chosen because Ink 8 (P-010) is *Proposed — Needs Validation* pending a phone measurement. **That measurement has
  not been taken.** Nothing in this repository has been run on a real phone except what §3 of this file lists. When someone
  can, `probes/RESULTS.md`'s phone column is the deliverable, and P-010/P-011 can then be accepted or rejected.
- **F-61** — C5-01 says a chat has "no task"; every run in this build is one. D-123 implements the *output* reading. If the
  row meant the *record*, that is a second writer of conversation history and its own slice.
- **F-62** — §3.8's `reserveForOutput` is refused (derived, D-064). Closed by D-126; kept in the review because the gap was
  real.
- **T1-08's quit confirmation** is a second press plus a line that admits the modal is still owed.
- **No owner review has been recorded for slices 47–58** (D-076). The owner was asked to stop the work, not to review it.

## 8. Things that will look like mistakes and are not

- **The TUI has zero dependencies.** That is deliberate (D-129), not an omission.
- **`clip` and `terminalFacts` live in `packages/platform`**, not in an interface, because two interfaces have a 40-column
  design case and two clippers would be two answers.
- **Schema version is 12.** Test literals asserting the version were updated in slices 46–47.
- **P-010's measured facts are load-bearing**: CR and LF both arrive, a kitty terminal's `Shift+Enter` arrives as an
  unnamed CSI sequence, and `exitOnCtrlC` must be off. They are pinned as tests in `apps/tui/input.test.ts`.
- **`docs/ROADMAP.md` gains one paragraph per slice.** Keep them, and add one for yours.
