# HANDOVER.md — where Crabby is, and what to do next

**Written by the agent that built slices 42–58, on 2026-10-16, at the owner's request.** Everything here is a fact about
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

**M3 is in progress: "four interfaces in parallel".** Two of the four exist.

| Workstream | State |
| --- | --- |
| CLI | **Largely done.** 30 commands live; the registry (`apps/cli/registry.ts`) is the authority on what is `ready`. |
| TUI | **Frame + chat pane + stream wiring.** Runs, draws, switches panes, quits. Approvals modal, jobs pane, logs pane and models pane are declared but not built — they print their milestone and the CLI equivalent that reaches the same place. |
| Web UI | **Not started.** D-068 decided custom elements, no SPA framework, so nothing here gates it. |
| Telegram | **Not started.** Needs the tunnel. |

**Phase exit for M3** (`docs/ROADMAP.md` §5): the parity test walks `docs/INTERFACES_AND_API.md` §8 with every blank cell
carrying an accepted limitation, and one task is started on Telegram, watched from Web, approved in the TUI, cancelled from
the CLI — in one demo, documented as the release test.

Decisions run to **D-131**; open questions to **O-075**. `docs/ROADMAP.md` has one paragraph per slice (39–58) — read the
last three to know what just happened and why.

## 3. The last three slices, and the bugs they found

- **57 (D-130)** — the chat pane: `apps/tui/markdown.ts` (D-061's named subset), `transcript.ts` (events → rows),
  `composer.ts` (`Enter` sends, `Ctrl+J` newlines). Pure modules, 73 tests, no pty needed.
- **58 (D-131)** — `apps/tui/stream.ts` (`GET /api/v1/events`), the composer sending through `POST /tasks`, the app
  opening on chat, and `apps/tui/main.test.ts` driving the whole loop with a fake stdin.

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

1. **TUI approvals modal** (region T-A) — the one pane that steals focus, and the only modal in the product. Rows are in
   `docs/review/TUI.md`. Answering must go through `POST /approvals/{id}/decision` and must print `conflict` when another
   interface answered first (W-A10).
2. **TUI jobs / logs / models panes** — small, and each one is a route that already exists.
3. **`model probe`** (C7-09) — deliberately unbuilt: it needs a credential a Gateway holds, so it wants a **route**, not a
   CLI verb. D-125 says where it stands.
4. **Web UI** — unblocked by D-068 (custom elements). Check `docs/UI_UX_SPEC.md` §2 and the W-rows in
   `docs/review/WEB.md`. The Gateway does not serve static files yet, so that is the first decision.
5. **Telegram** — needs the tunnel, which is its own phase.

## 7. Things that are open and belong to the owner

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
