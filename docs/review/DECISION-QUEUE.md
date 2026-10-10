# Decision Queue — the (R) round of 2026-10-10

**Status: this is a record, not an approval queue any more.** On 2026-10-10 the owner delegated the open items: research
them, then arrange the documents per the agent's recommendations (D-059). Every recommendation below became an accepted
row in `DECISIONS.md` marked **(R)**, and the rows it unblocked were flipped in the four inventories. This file exists so
that a single recommendation can be examined on its own and rejected without disturbing its neighbours — which is the
condition the delegation came with.

To veto one item: change that `D-0nn` row's status to `Proposed` (or `Open`, if the reasoning is that the question was
asked wrong), revert the rows named in its "flips" column, re-run `python3 scripts/count-inventory.py --markdown`, paste
the result into `DECISIONS.md` §4B, then `python3 scripts/check-docs.py`. The checker is what makes that sequence safe:
it fails if a status and a count disagree, so an override cannot quietly leave the documents half-moved.

Sources are named in prose, not linked: this is a plan that has to stay readable offline, and every version or date
below was checked on 2026-10-10 against the npm registry, the upstream repository, or a measurement taken here.

## 1. Closed by this round

| Item | The question as it was asked | Recorded as | What it rests on | Flips |
| --- | --- | --- | --- | --- |
| O-003 | npm, pnpm, or a plain single-package repo | D-060 | The install story in D-050 is clone + `npm install`; asking a Termux user to install a second package manager to build a local tool is a barrier with no upside | — |
| O-005 | Zod or TypeBox | D-060 | The API contract, `crabby config schema --json` and the generated `--help` all need JSON Schema as an output, not a conversion | — |
| O-036 | Does the doc checker run in CI | D-060 | `scripts/check-docs.py` is the only thing standing between 21 documents and drift; unchecked it decays in one editing session | — |
| O-047, O-048 | ESLint + Prettier or Biome | D-060 | Biome 2.5.15 (npm, 2026-09-30) has zero runtime dependencies and does both; the install name must be `@biomejs/biome` — the bare `biome` package on npm is an unrelated 2016 artifact at 0.3.3 | — |
| O-049 | Publish `packages/*` independently | D-060 | No consumer exists yet; publishing creates a version matrix to support for nobody | — |
| O-050 | Can Termux behaviour be tested in CI | D-060 | `termux/termux-docker` is active (pushed 2026-09-15) and packages the Termux environment as an image — enough for the Node half, not enough for `termux-api`, which needs Android | — |
| O-054 | Alternate screen or inline | D-061 | Ink's README states the scrollback buffer is unavailable while the alternate screen is active; `incrementalRendering` diffs only changed lines and preserves grapheme boundaries; the flicker root cause is `log-update`'s erase-lines-then-rewrite, documented in a published measurement write-up | T1-04, T-O9 |
| O-055, and O-002's design half | Which key means newline | D-061 | Legacy terminals report `Shift+Enter` as `CR`, identical to Enter; the kitty protocol (which can report it) is supported by kitty, foot, Alacritty 0.13, Ghostty, iTerm2 and WezTerm, needs a tmux feature flag, and is listed as *unclear* for the Termux app; xterm.js lacks it before 6.1.0-beta | T5-01 |
| O-056 | How much markdown the TUI renders | D-061 | Re-layout cost at every resize, and the `--plain` contract already defined in C2-02 | — |
| O-057 | One approval card or a list | D-061 | The 24-row minimum frame cannot hold two readable cards; a lost risk line is the failure mode `SECURITY.md` §5 forbids | T-A14 is *new*: one-card display needs a way to walk the queue, so `n`/`p` and the visible `2 of 5` became a row, and the TUI inventory went from 202 to 203 |
| O-059 | Configurable keys in v1 | D-061 | The hint strip must be true; a binding file makes it a claim about someone else's config | — |
| O-058 | Bengali and other non-Latin text in a terminal | D-062 | Measured here with Node 22: `দিয়েছি` is 7 UTF-16 units and 7 code points but 3 grapheme clusters and 6 cells; `কিন্তু` is 6 units and 4 cells; `ক্ষ` is one cluster; truncating at 3 code units yields `দিয`, a torn conjunct. `wcwidth` treats spacing combining marks (Indic vowel signs) as 1 cell, and glibc disagrees with grapheme-aware terminals, which give Brahmic clusters one cell per base letter — so no width model survives every terminal | T4-15, T13-09, T-C9 |
| O-060 | `task run` blocks or returns | D-063 | A returned id with no attached view is the worst of both; blocking with the resume command printed is recoverable from a dropped SSH session | C6-01 |
| O-061 | Watch stream format | D-063 | Same `seq` semantics as the Web (D-049), so gap detection is one rule for both | C6-07 |
| O-062 | Blocking on approval from a script | D-063 | Exit `3` already means "a human must answer" (C3-04); waiting on a TTY-less stdin turns a cron entry into a hung process | C-A9, C-S13 (completion, same contract family) |
| O-063 | Man page in v1 | D-063 | Two reference surfaces, one of them generated from the other, is a contradiction waiting | C-S13 |
| O-029 | Retry schedule within the ≥5-attempt floor | D-064 | Providers advertise `Retry-After` for a reason; jitter exists so a fleet of phones does not retry in lockstep | T5-10 |
| O-031 | Token estimation without a provider counter | D-064 | `chars/4` is calibrated on English text; the measured Bengali cluster ratio is why the second term exists, and labelling is what makes an estimate honest | W4-09, W7-01 |
| O-035 | Output caps and temp lifetime | D-064 | 64 KiB keeps a tool result inside a frame and out of swap on a 3 GB device; a prune at startup that logs is auditable, a silent delete is not | W11-07 |
| O-037, O-038 | Override editor UX; provider-wide override | D-064 | Per-capability override is accepted (D-045); a bulk action that silently re-lays capability across models is the mistake that decision exists to prevent, so it must be explicit and repeated per model | — |
| O-041 | Approval expiry per tier | D-064 | T1 15 min, T2 10 min, T3 5 min — the more an approval grants, the sooner it should age | W-A5, T-A5 |
| O-021 | Prompt-injection hardening for imported text | D-065 | Text from a file or a web page is data; the `external content` marker is the user-visible half of that rule | — |
| O-022 | Audit redaction vs. an approvable record | D-065 | Redacting the path that a user approved makes the record useless for review, so secrets go and targets stay | — |
| O-014 | Event retention | D-065 | A phone has the least free storage; 30 days or 5 000 events per task bounds one runaway job without erasing the reason a job misbehaved | — |
| O-015 | Vector retrieval or FTS5 | D-065 | Embeddings on-device need a model nobody has chosen; FTS5 ships inside the SQLite already required (D-033) | — |
| O-016 | Deleting a conversation that summaries cite | D-065 | Silently rewriting derived records is how a memory system starts telling a story it never stored | — |
| O-017, and O-012's rollback half | Backup and restore | D-065 | `better-sqlite3` exposes SQLite's online backup API, which is safe under WAL; a restore that does not check integrity first can replace good data with a half-written file | — |
| O-011, O-013 | Compaction validation; checkpoint recovery | D-065 | The acceptance list recorded during review *is* the benchmark; and a resume that re-runs an external action (an email, a payment) is worse than a resume that stops and asks | — |
| O-027 | Conversion report retention | D-065 | Keeping every report unbounded is a storage cost, pruning all but one destroys the ability to answer "when did this start failing" | — |
| O-001's remainder, O-002's build half | SQLite on Termux | D-066 | `better-sqlite3` 13.0.3 (npm, 2026-08-05) has one dependency, `node-addon-api`; the build itself is the risk, and a container cannot discharge it | — |
| O-007 | Windows | D-066 | WSL is the only path where the Termux-shaped assumptions (POSIX, file modes, sqlite) hold; half-supporting native Windows costs more than saying no | — |
| O-018 | Where secrets live on Android | D-066 | Keystore reachability from Termux is reported variously and cannot be assumed; a vault file with scrypt is the floor, and printing the probe result tells the user which they got | — |
| O-024 | Which `termux-api` tools ship | D-066 | Each entry is one capability with a tier; the list stops at what the risk model in `SECURITY.md` §6 can already express | — |
| O-025, O-032 | Per-task narrowing; the shell classifier | D-066 | A mandatory prompt per task trains users to click through, which is worse than the hole it closes; and a classifier that gates T3 must not be updatable by the thing it gates (D-038) | W11-08, C6-04 |
| O-034 | Local inference on Android | D-066 | Documented unsupported plus an external server over loopback keeps the model layer honest about what it has measured | — |
| O-009 | Quick Tunnel lifecycle | D-066 | Cloudflare's quick tunnels are ephemeral by design; pretending the URL is stable would be a support queue | T2-04 |
| O-039, O-040, O-042, O-019 | API prefix; who serves the Web UI; how §8 stays true; pairing on a phone | D-067 | Three hand-maintained lists produced F-08, F-10 and F-11 — generation from the registry is the structural fix, not another checklist | G1-02 |
| O-053 | Nine chips in a 360px bar | D-067 | Counted against the mockup at 360px; the exception for locked-vault and offline is because those states are only ever visible there | — |
| O-043, O-044, O-045, O-046 | Web stack; palette; light theme; TUI colour depth | D-068 | The web UI is a client of the contract, not a platform, so every dependency is cost; the palette is now arithmetic that the checker re-measures, and light was specified rather than inverted because the first candidate failed AA on `bg.raised` | W12-05, T13-06, T-C1 |

## 2. Still open, and exactly what closes it

Six items did not move — four still open, two carrying one measured clause — because a recommendation about them
would be a claim about hardware this workspace cannot see. Each has a protocol, so the measurement is the thing that
closes it and not a mood. (The register holds 65 numbered `O-` rows and only these six still ask for work — the
finalization round added two more, O-064 and O-065, recorded in `DECISIONS.md` §4 rather than here because they were
never a recommendation of this round; the rest are
closed *rows*, kept numbered so the documents that cite them keep pointing at something.)

Nothing in this table was answerable from a desk: the four questions that *were* answerable that way — skill
frontmatter, host API versioning, memory provenance, timeout and concurrency defaults — were decided in the same
spirit as this round and are recorded as D-071…D-074, so they are not listed here. The veto path in the header works
for those four exactly as it does for these.

| Item | Why it stays open | How to close it |
| --- | --- | --- |
| O-001, O-002 | Build behaviour of `better-sqlite3` on a clean Termux install, and whether WAL survives Android's storage semantics | One command on a phone: `pkg install nodejs-lts && npm i better-sqlite3 --build-from-source && npm test`, then run the WAL torture (kill -9 during 1 000 writes, reopen, integrity_check). Record Node version, API level, and the exact output |
| O-006 | Whether the TUI's rendering cost is acceptable on a low-end device — line count, update rate, resize storm | On a phone, in the TUI: 1 000 lines of mixed text and code, resize held for 10 s, `time` a full redraw; the acceptance is the frame staying interactive at ≥4 fps with input latency under 50 ms. Numbers go in `docs/UI_UX_SPEC.md` §4 |
| O-051 | Ink 8 specifically, one week old at review time | Same session as O-006, on ink 8.0.0, recording flicker observations per terminal (Termux, and one desktop). If it fails, D-014's fallback is a hand-rolled renderer, not a version pin |
| O-008 | Whether the lightweight extension contract actually contains a bad extension | Needs the first three real extensions; the test is a skill that tries to read outside the workspace roots and to redefine a core tool, and both must be refused by the contract rather than by review |
| O-052 | Remembered, scoped approvals | Post-v1 by construction (D-052). It is a design question, not a vote: what a scope looks like, and how a remembered grant is displayed later |

## 3. What the (R) round did *not* decide

Nothing about how a screen looks. The 650 rows still `PROPOSED` in `docs/review/` are the owner's to review against
`docs/review/mockups/crabby-web-ui.html`, and no decision in `DECISIONS.md` §2 substitutes for that: an (R) row settles
a *question*, and a `PROPOSED` row is a *choice someone has to like*. Those are different statuses on purpose.
