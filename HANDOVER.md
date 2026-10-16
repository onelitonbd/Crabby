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

**M3's four interfaces all exist.** What remains of the phase is its exit test, not a missing interface.

| Workstream | State |
| --- | --- |
| CLI | **Largely done.** 30 commands live; the registry (`apps/cli/registry.ts`) is the authority on what is `ready`. |
| TUI | **Built.** All six panes draw real content, and the views inside them are wired: `chat` (composer with the real cursor, T5-02; input history on ↑/↓, T5-09; the overflow warning, T8-08), `tasks` (T6-01's filter row), `approvals` (T-A's modal), `jobs` (T17), `models` (T11, editor included, plus T12's tools view on `t`), `logs` (T15's decisions + diagnostics, T14's access view and T13's config view on `v`). The log/audit *views* still name their route gaps (see §7) and `model probe` names its own (T11-07). |
| Web UI | **Built** (slices 64, D-068/D-067) — the Gateway serves `apps/web` as no-build custom elements; eight screens, §13's asset/API token split tested; route-less places name their gaps by name. |
| Telegram | **Built** (slice 65, D-132) — `packages/telegram` over grammY: silent gate, in-chat pairing to per-chat identities, 36-row command table, `apr:<id>:<nonce>` approvals, paced delivery with recorded failures, SSE watch, `telegram.json` state (D-078's sixth file). **Never run against a live token** (the owner's was revoked) — `getUpdates`, `setMyCommands` and a real card tap are unverified on the wire; `vault://` resolution is M5 (F-56). |

**Phase exit for M3** (`docs/ROADMAP.md` §5): the parity test walks `docs/INTERFACES_AND_API.md` §8 with every blank cell
carrying an accepted limitation — **that half passes** — and one task is started on Telegram, watched from Web, approved in
the TUI, cancelled from the CLI — in one demo, documented as the release test. **The demo is the remaining M3 work, and it
needs a live Telegram token.**

Decisions run to **D-132**; open questions to **O-075**. `docs/ROADMAP.md` has one paragraph per slice (39–65) — read the
last three to know what just happened and why.

## 3. The last three slices, and the bugs they found

- **57 (D-130)** — the chat pane: `apps/tui/markdown.ts` (D-061's named subset), `transcript.ts` (events → rows),
  `composer.ts` (`Enter` sends, `Ctrl+J` newlines). Pure modules, 73 tests, no pty needed.
- **58 (D-131)** — `apps/tui/stream.ts` (`GET /api/v1/events`), the composer sending through `POST /tasks`, the app
  opening on chat, and `apps/tui/main.test.ts` driving the whole loop with a fake stdin.
- **59–63 (this stretch)** — the TUI's remaining element rows, wired to what the routes already answer:
  `tools.ts`/`access.ts`/`settings.ts` are pure projections (T12/T14/T13) and `main.ts` only wires them: `t` opens the
  tools view inside the models pane (dangerous-first sort, Enter folds the schema), and the logs pane's `v` cycle is five
  stops — log, audit, decisions, **clients** (revoke asks twice and says what ends; `n` mints a pairing code through the
  same client method `crabby auth` uses), **config** (the buffer → diff → write pipeline is the CLI's own `applyEdit`,
  same CAS, same 0600 file). The polish rows: the composer drives the **real terminal cursor** (T5-02 — no drawn block
  on a TTY), `↑`/`↓` walk the session's input history (T5-09, stepping out past the newest to the empty buffer), the
  overflow warning computes before the send from the Gateway's own count plus the draft's estimate (T8-08), quitting
  with a task running confirms once **in words that the task survives** (T1-08, `q`/Ctrl-Q; Ctrl-Z suspends through
  cooked mode + SIGTSTP and SIGCONT redraws), created task ids and their watch commands get **bare lines** in the
  transcript (T2-09/T-C8 — `addNote`, no prefix), and the tasks pane has T6-01's filter row (`f` enters, `f` toggles
  field, Esc clears; prefix match on state and session).

**T5-06 stays a named gap, not a guess.** The capability line under the composer still prints the documented
conservative defaults (`fs: workspace · net: off · shell: off`), because the one route that could make them real does
not exist: `GET /auth/clients` carries `capabilities` *per identity*, but nothing answers **"which identity am I"** —
the caller's own grants row. Building it without that route would mean printing "shell: on" from a guess, and a wrong
"shell: on" is a wrong promise about what a run may do. The fix is a route (`GET /api/v1/auth/whoami` or an `own` flag
on the clients list); the line and its comment in `main.ts` name this and wait.

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
   Gateway. A **live token** at `crabby config set telegram.token <token>` then `crabby telegram start` is the
   un-run verification; the four-interface demo (§2) is what the token unblocks.

## 7. Things that are open and belong to the owner

- **T17-07's backlog answer `each`** — three of the accepted rows (T17-07, W16-08, C12-06) offer `latest / each / skip`
  and `JobBacklogBody` carries only `latest | skip`. The TUI prompt shows three answers and `each` is built as a
  per-occurrence walk over `run-now` (D-103's one-run-at-a-time makes N simultaneous fires impossible, and §4.5 forbids a
  burst). If the owner wants `each` as one recorded action, the contract and the scheduler need the third action.
- **`GET /logs` and `GET /audit`** — T15-01/03/02/06 price a log view and an audit view; the routes are documented
  (`docs/INTERFACES_AND_API.md` §4.4) and the registry's `logs`/`audit` verbs are `planned` on them. The logs pane names the
  gap per view; building the views means building the routes (a log store and §14's audit fields are the real work).
- **T11-04's `reserve` input** — the row prices three typed limits including `reserve`; F-62 closed `reserveForOutput`
  as derived (D-064) and the record has no column for it. The TUI draws the input (the row, as written) and reports
  `reserve is derived … (F-62)` on save without storing it. If the owner wants it stored, §3.8's schema and D-064
  revisit; if the row should drop it, D-076 reopens T11-04.
- **T17-05/W16-11's delete** — there is no `DELETE /jobs/{id}` route and no delete in the scheduler. The TUI's typed-name
  confirmation runs and then reports the gap by name; the job stands. Needs a route or an accepted limitation.
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
