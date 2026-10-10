# Crabby — M-D Cross-Document Consistency Review

> **Status:** In progress — first pass complete. Mechanical checks pass; human verification by the owner is the
> remaining item (§6).
>
> **Reviewed:** 22 documents (16 planning at `*.md` and `docs/*.md`, 4 element inventories, the review index and
> this file), most recently on 2026-10-10 — findings F-13…F-17 are from that pass, so every earlier finding has been
> re-checked against the documents as they now stand.
>
> **Method:** `python3 scripts/check-docs.py` + targeted manual contradiction hunting. This file is the record, not
> a scratch pad: every finding below is either fixed with a decision ID, or explicitly listed as still open.

## 1. Scope of the Review

Checked for:

01. **Contradictions** — the same subject described with different rules in two documents.
02. **Orphan requirements** — a requirement in `PROJECT_BRIEF.md` with no enforcing document.
03. **Status drift** — a decision cited as open after it was closed, or as closed without an accepting row.
04. **Traceability** — accepted decisions that no document enforces (`DECISIONS.md` §4A).
05. **Terminology drift** — different names for one component, which later becomes different behavior.
06. **Premature certainty** — a `Proposed` or `Open` item written as though it were settled, or a document
    implying code exists.

Not checked, deliberately: prose style, section ordering, and whether each document *should* exist (the document set
was fixed earlier in planning).

## 2. Findings and Resolutions

### F-01 — Contradiction: stored approvals existed in one document, not in another
**Severity: high.** `SECURITY.md` §6.3 described "stored/remembered approvals (optional convenience)" as a feature
with rules, while `docs/INTERFACES_AND_API.md` §4.3 specified `scope: once` and stated that only `once` exists in the
first release. An implementer reading the security document could reasonably build a remembered-approval store; one
reading the API document could not.

**Resolution:** stored approvals are out of scope for v1 — **D-052**. `SECURITY.md` §6.3 now states that plainly,
keeps the design constraints for a future version (scoped, listed, revocable, never for T3, invalidated by material
change), and points at the root cause: approval fatigue (T-05) should be answered by asking less often, not by
pre-authorizing dangerous actions. Test requirement updated to assert the *absence* of the path. Post-v1 possibility
tracked as **O-052**.

### F-02 — Gap: `history.export` existed in three documents and nowhere in the API
**Severity: medium.** `PROVIDERS_AND_TOOLS.md` §4.2 defined the tool and tier, `docs/INTERFACES_AND_API.md` §8 mapped
the parity matrix row to `POST …` with no route, and `docs/UI_UX_SPEC.md` promised a Download action — but §4 listed no
export endpoint, so there was nothing for the Web UI or Telegram to call.

**Resolution:** `POST /sessions/{id}/export` and `POST /export` added with the artifact-handle behavior (temp
directory, output caps, sanitization before bytes are written). The parity matrix row now names the real route.

### F-03 — Gap: pairing and revocation had no capability
**Severity: medium.** `docs/INTERFACES_AND_API.md` §3.1 defines `crabby auth pair/list/revoke`, and the parity matrix
required an identity-management surface, but `SECURITY.md` §6.1's vocabulary had no capability for it — so the
implementation would have had to invent a rule, which is the failure mode §21 of the architecture exists to prevent.

**Resolution:** `auth.manage` added to the vocabulary, defined as local-only, and the parity asymmetry is recorded
openly in **D-053** with its rationale (a stolen remote token must not be able to mint a second identity) plus the
local alternative path — rather than the matrix pretending the capability is identical everywhere.

### F-04 — Contradiction: `--restrict` would have deadlocked against T3 approvals
**Severity: high.** `SECURITY.md` §13 recommends narrowing an identity with `crabby auth pair --restrict shell,config`
for remote use. §6.2 says T3 actions always require an approval. If "restricted" were implemented as "capability
present but always approval-gated", a restricted remote client could start a task that needed an approval it was
itself not permitted to answer — waiting on a prompt that can only be resolved from another interface, which reads to
the user as a hang.

**Resolution:** **D-054** — `--restrict` *removes* capabilities from an identity; it never converts them into a
pending approval. A removed capability reports "not available to this client" with the reason, in the same shape as a
platform-unsupported result. Approvals remain answerable from any client with visibility, but that is a convenience,
not the escape hatch the design leans on.

### F-05 — Stale status references after a decision closed
**Severity: low, but corrosive.** After `O-019`, `O-010`, `O-020`, and `O-033` were closed, four documents still
described their content as pending (e.g. "Remaining open detail (O-019): token format, optional expiry policy"
after D-051 had decided exactly that). Stale open-items are how an agent gets permission to re-decide something.

**Resolution:** all four references updated to cite the accepting decision; where only part of an item was decided,
the remainder is now named precisely (O-019 → pairing-code presentation on a phone screen, nothing else).

### F-06 — Traceability gap: 27 accepted decisions were cited nowhere outside the register
**Severity: medium.** A grep for `D-xxx` outside `DECISIONS.md` showed 27 accepted decisions with no enforcing
document — including several early ones (D-001…D-012) whose content *is* present in the brief and architecture text
but was never linked back. Traceability that lives only in a reader's memory is how a later edit drops a requirement
without anyone noticing.

**Resolution:** `DECISIONS.md` §4A traceability map added, one row per document listing the decisions it enforces,
with the rule that a decision must be enforced by at least one document and that no document restates a rule it does
not own. The map doubles as the checklist for F-01/F-02 class bugs.

### F-07 — Wording that could license skipping a required behavior
**Severity: low.** `docs/ROADMAP.md` M2 said `shell.run` "may exist but stays off by default", which leaves room to
ship M2 without the tool at all and still call the gate passed. `PROJECT_BRIEF.md` §14 requires a controlled tool
execution system in the initial release.

**Resolution:** M2 now states that `shell.run` ships in that phase, is not enabled by default, and that the exit demo
runs twice — once with it off, once with it on — so "off by default" is verified rather than assumed.

### F-08 — The command grammar and the parity matrix did not describe the same surface
**Severity: medium.** While counting the four element inventories against `docs/INTERFACES_AND_API.md` §8, three
disagreements appeared at once:

1. §7.1's command table was missing `logs`, `audit`, `context show`/`context pin`, `session compact`, and `tools ls` —
   all five of which §8 requires a CLI cell for. `crabby --help` generated from that table would have omitted them, so
   the CLI would have looked like the interface with the gap.
2. §7.4 listed 11 Telegram commands, while §8's Telegram column names 20 — and 15 of those had no command in the
   list at all (`/approvals`, `/compact`, `/config`, `/context`, `/delete`, `/export`, `/ext`, `/logs`, `/memory`,
   `/probe`, `/providers`, `/resume`, `/sessions`, `/tools`, `/tunnel`). Most of them are exactly the ones nobody
   would think to type and nobody would think to miss. §7.4 now has 28: the union of both lists, plus `/unwatch` and
   `/new`, which are an inverse and a second session rather than new capabilities.
3. `docs/review/TELEGRAM.md` inherited that short list and had a row saying provider/config/extension commands are
   simply "not offered here" — which would have written an undocumented capability gap into the approved spec.

**Resolution:** §7.1 gained the missing rows, §7.4 now states one command per matrix capability and says plainly that
dropping a command to save typing is the D-005 test failing, `docs/review/TELEGRAM.md` G3 was rebuilt to one row per
command (31 rows: 28 named commands plus an unknown command, bare text, and a refusal), and
`docs/review/CLI.md` gained region C10 for context/compaction/tools. `docs/UI_UX_SPEC.md` §7 no longer repeats the
command list at all — it points at §7.4, because a second copy of a list is how this happened.

**Made structural:** `scripts/check-docs.py` rule 10 now compares the command sets themselves instead of trusting
prose, in both directions, and refuses to stay silent if the source tables change shape. That is the only reason this
class of finding cannot come back as F-08 again.

### F-09 — One of the consistency checks was not checking anything
**Severity: medium, against our own tooling.** Rule 1 of `scripts/check-docs.py` — "every referenced decision ID must
exist in the register" — was written as `set(ID_RE.findall(body)) and set()`, which evaluates to an empty set: the
loop body never ran, so a reference to a decision that does not exist would have passed silently since the checker was
written. Found while wiring rule 10, not by the rule itself.

**Resolution:** the expression is fixed, and the first honest run of rule 1 reported nothing — the register is clean.
A check that cannot fail is worse than no check, because it is trusted; both rules now print an error naming
themselves if the tables they read are missing or reshaped.

### F-10 — A whole screen had zero elements in every inventory
**Severity: high, and it is the reason this review exists.** `docs/UI_UX_SPEC.md` §2.2 lists a **Sessions** screen
("session list, rename, delete with typed confirm, export"), and `docs/INTERFACES_AND_API.md` §7.2 names a **session
switcher** as a required TUI view. Both documents were written before D-055, and both were *correct* — yet the element
inventories for Web, TUI, and CLI had **no region and no row** for any of it, and the CLI grammar had no `session`
verbs at all beyond `chat --session <id>`. Since `docs/UI_UX_SPEC.md` is regenerated *from* the inventories, the next
pass would have deleted the screen quietly and the parity matrix would have gone on claiming it.

This is the exact failure D-055 was meant to prevent, approached from the other side: summarizing a spec into rows
loses anything the summary never enumerated.

**Resolution:** region **W15** (11 elements: list row, current marker, new, rename, switch, switching while a task
runs, delete with the title typed back, export, search, empty state, origin interface), region **T16** (8 elements,
40-column switcher), region **C11** (6 elements, `session ls/new/show/rename`, and the deliberate absence of a
`session delete` so there is exactly one destructive verb), and `/rename` on Telegram (G3-32) so rename is not a
three-interface capability. `docs/INTERFACES_AND_API.md` §7.1 gained a Sessions row and §7.4 gained `/rename`.
Region T-A's heading now says "Approvals", because a heading that does not name its screen is how a screen goes
missing twice.

**Made structural:** rule 11 of `scripts/check-docs.py` reads the §2.2 screen table and the §7.2 required-view list and
fails when no region title in `docs/review/WEB.md` / `docs/review/TUI.md` matches one. Negative-tested
against the pre-fix `docs/review/WEB.md`: it
reports exactly `Sessions` and nothing else, so it is not a check that passes on everything.

### F-11 — A resource with routes, a policy, and no interface at all
**Severity: high.** `GET /jobs`, `PATCH /jobs/{id}`, `POST /jobs/{id}/pause` exist in `docs/INTERFACES_AND_API.md`,
and `PROVIDERS_AND_TOOLS.md` §4.5 carries the strictest scheduling policy in the project (each run is a fresh policy
evaluation, a run that cannot get approval stops and records it, a killed Termux must not fire a backlog burst). No
element row in any of the four inventories implemented any of it, and `docs/UI_UX_SPEC.md` §2.2 had no such screen.
The same sweep found `POST /admin/restart` · `/admin/shutdown` (T3 lifecycle) and `GET /diagnostics` unreachable
outside the CLI, and `GET /health` absent from the TUI.

**Root cause, stated plainly:** three hand-maintained lists — the route table, the §8 capability matrix, and the §2.2
screen list — were never cross-checked, so F-08 (commands), F-10 (screens) and F-11 (resources) are the same defect
seen from three sides. Prose promises about parity had not caught any of them.

**Resolution:** D-057 makes scheduled jobs a first-class surface (Web `Scheduled` screen as the fifth nav item, a
sixth TUI pane, `crabby job …`, `/jobs` + `/job <id>` on Telegram) with regions W16 (12), T17 (8), C12 (9) and three
Telegram rows; D-058 puts Gateway lifecycle and the diagnostics report in every interface, refusing restart over the
transport that restart would drop (`/report` carries the diagnostics bundle on Telegram). `/jobs` and `/job` join
§7.4, `job …` and `diagnostics` join §7.1, and two capability rows join §8.

**Made structural:** rule 12 derives the resource list from the API route table and fails when a resource has no
presence in an interface inventory, or when a new route appears that the rule knows nothing about. It is deliberately
dumb — presence, not correctness — because the point is that a resource cannot be *unmentioned* again.

### F-12 — The capability existed in every spec and in no milestone
**Severity: medium.** After F-11 was closed, `grep -n "cron\|schedule" docs/ROADMAP.md` returned **nothing**: the
scheduler was specified in `PROVIDERS_AND_TOOLS.md` §4.5, tiered in D-046, routed in `docs/INTERFACES_AND_API.md`,
and now had elements in all four inventories — but no phase was going to build it. A feature that is designed
everywhere and scheduled nowhere is not planned; it is folklore.

**Resolution:** M2 gained the scheduler as a deliverable with the pause verb shipped alongside it, and M3's Web row
names `Sessions` and `Scheduled` as screens the phase owes, so the two regions added for F-10/F-11 cannot be dropped
as "extra".

**Lesson kept:** the review pass checks documents against *other documents*. It does not check documents against the
plan that executes them, so `docs/ROADMAP.md` is now inside the loop — every capability with an inventory region has
to be named by a phase. That is the same rule, one level up.

### F-13 — The review instrument disagreed with the design system
**Severity: high, for this round.** `docs/review/mockups/tokens.css` carried `--accent: #d4622a` and a comment
calling its values "placeholder … pending O-044", while `docs/DESIGN_SYSTEM.md` §2.1 stated constraints and no values.
So far, consistent with "not decided yet". What was not consistent: the light block was **the dark theme inverted**,
which is the one thing §1 principle 02 forbids — and it was inverted badly enough to be visible in the numbers. Its
`--bg-raised` and `--bg-overlay` were both `#ffffff`, i.e. three surfaces collapsed to two, and `fg.muted` on that
raised surface measured **4.19:1**, under AA for body text.

**Resolution:** the palette was decided *by arithmetic* (O-044, O-045, O-046 → D-068): values recorded in
`docs/DESIGN_SYSTEM.md` §2.3 with their worst-surface contrast for both themes, `scripts/check-docs.py` rule 13
recomputes every printed ratio from the hexes, and a declared text floor below 4.5 is a failure ("a floor may be
raised here, never lowered"). `tokens.css` now imports the same values instead of paraphrasing them, and the light
theme is specified rather than derived. Measured along the way: no pair of state hues in this palette can reach even
17% luminance separation while both clear 3:1 on every surface, so the `+`/`-` prefixes and the tier words are the
meaning and the color is decoration — which is §1's never-color-only rule with a number behind it for the first time.

**Lesson kept:** a mockup that shows placeholder values *while claiming to be the review instrument* is worse than no
mockup, because the owner reviews the wrong colors and calls it approved. Either the instrument carries the decided
values or it says, in the file the reviewer reads, that it does not.

### F-14 — Eight documents kept lists of questions that had already been answered
**Severity: medium, systemic.** Closing the open items exposed the same defect in eight places at once:
`ARCHITECTURE.md` §21 listed ten "topics [that] must not be silently treated as finalized", of which eight had
answers; `AGENT_RUNTIME.md` called the atomic-step definition and the retrieval strategy open twice;
`docs/DATA_AND_MEMORY.md` §9 asked seven questions that D-065 and D-066 had answered; and `docs/INTERFACES_AND_API.md`,
`docs/DESIGN_SYSTEM.md`, `docs/DEVELOPMENT.md`, `PROVIDERS_AND_TOOLS.md` and `SECURITY.md` each ended with an
"Open Decisions" section whose items were closed elsewhere in the same commit set. Every one of those sections read
as *current* — nothing marks a stale open-list as stale.

**Resolution:** each list now states the answer and the decision ID next to the question, struck through where the
house style already did that, and keeps the *genuinely* open items with the reason they are open (a device, real
extensions, or post-v1). `docs/ROADMAP.md` §0's count of accepted/open decisions was updated in the same pass,
because a figure like "47 accepted · 45 open" in an ASCII diagram is exactly the kind of number that is true once.

**Lesson kept:** the register is not the only place a decision lives; it is only the place a decision is *counted*.
Any document that enumerates open questions is a second register and needs the same status discipline — which is why
`DECISIONS.md` §4's counters are checked mechanically and these eight lists are not, and why they should be short.

### F-15 — A validation probe was written to test a stack nobody had chosen
**Severity: medium.** `docs/ROADMAP.md` §2's P4 read "React + Vite production build served by the Gateway", and P5's
pass conditions covered repaint, `Ctrl-C` and color tiers but not the composer key contract or Bengali truncation.
Both rows were written before the decisions they were meant to inform; keeping them would have spent M0 measuring a
framework the Web design then rejected (O-043 → D-068, framework-free) and skipped the two measurements the TUI
design now depends on.

**Resolution:** P4 builds and serves the small dependency-free bundle and checks the 360px bar against the overflow
rule; P5 gained the `Ctrl+J` guarantee, the extended-key negotiation as a *recorded* result rather than a hope, the
≤4 fps repaint budget, the readable 8-color tier and cluster-boundary truncation of pasted Bengali. Both rows state
what a failure would change, which is the point of a probe.

**Lesson kept:** when a decision lands, re-read the plan for the questions it was answering. A probe that tests an
overturned assumption is not neutral — it costs a day and produces confidence in the wrong thing.

### F-16 — The decision text invented two key bindings and one row
**Severity: low, caught before it shipped.** Writing D-061 into `docs/UI_UX_SPEC.md` §4 came with two plausible
inventions — `j`/`k` as select keys, and a `g`-prefix pane jump "matching the Web" — neither of which any inventory
row carried, in a document whose job is to be *generated from* those rows. Fixing the sentence surfaced a real
inconsistency in the same list: it said `Tab` or `1-5` while D-057's pane set has six members.

**Resolution:** the invented keys were removed rather than back-filled into the inventories; the stale `1-5` became
`1`–`6`; and the one thing the decision genuinely *does* create became an element with a row of its own —
**T-A14**, walking the approval queue with `n`/`p` while the `2 of 5` count stays visible — which raised the TUI
inventory to 203 elements and was recomputed by `scripts/count-inventory.py` rather than typed.

**Lesson kept:** a decision text is not a license to add elements; it is a reason to check whether one is missing. If
an answer makes a new control necessary, the control appears in the inventory with the size and the behavior, or it
does not exist.

### F-17 — The register itself was still offering technologies the decisions had killed
**Severity: high, and it was invisible by construction.** `DECISIONS.md` §2 kept ten `P-` rows as "proposed"
candidates: `P-006 Schema validation | Zod` two days after D-060 chose TypeBox, `P-007 Web frontend | React + Vite`
after D-068 chose framework-free custom elements, `P-008 Test framework | Vitest` never decided at all, and the
runtime/dev-loop question (`tsx`) undecided while `docs/DEVELOPMENT.md` §1 already listed it as the dev runner.
Downstream of those rows, **six documents asserted the superseded stack**: `PROJECT_BRIEF.md` §5.3 and its
technology table, `ARCHITECTURE.md` §6.3 plus the whole of §20, and `docs/INTERFACES_AND_API.md` §7.3. A reader who
started at the brief — the correct place to start — would have implemented React, Vite, Vitest and Zod, and every
document they consulted would have agreed with them.

The checker could not see it: rule 4 validates that a *filename* exists and rule 7 that an *Accepted decision appears
in the traceability map*. Neither compares a decision's content with the sentence that contradicts it. There is no
general way to do that mechanically. There *is* a way to close the specific hole where it started, which is the
`P-` table: a proposal that names no open blocker is a proposal nobody is still deciding.

**Resolution:** D-069 and D-070 decide the dependency set and the runtime baseline — Fastify with `validatorCompiler`
over the shared TypeBox schemas, grammY as transport adapter only with retry owned in Crabby, and `node:test` with
native type stripping as the whole test stack. The runner choice was **measured here** rather than argued: on Node
22.22.3, `node a.ts` runs unflagged, `node --test` discovers `*.test.ts` and passes, `--experimental-test-coverage`
prints the table, and an `enum` fails with a platform error — which is why D-070 turns that error into the codebase's
"erasable TypeScript only" rule instead of a convention. Vitest and `tsx` are rejected as *defaults*, with the
honest reason written down: they reach esbuild's platform binaries, esbuild *does* ship `@esbuild/android-arm64`
(verified on the registry), so the argument is dev-loop dependency weight, not impossibility — the sentence this
document would have liked to write, and should not. `P-006`/`P-007`/`P-008` become Superseded with their text kept,
`P-003`/`P-004`/`P-010` become Needs Validation citing O-001/O-002/O-006/O-051, all six stale documents were
corrected, `ARCHITECTURE.md` §20's table now cites a decision per row, and rule 14 fails any future `Proposed` row
without an open `O-` reference (negative-tested).

**Lesson kept:** decisions do not end when a `D-` row is written; they end when the last document that disagreed with
them is edited. `Proposed` in a register is a *promise that someone is still deciding* — and if nobody is, the row is
not undecided, it is abandoned.

## 3. Checks That Passed

| Check | Result |
| --- | --- |
| All `D-`/`P-`/`O-` references resolve to a register row | ✓ |
| Every referenced document resolves, or is an advisory for a planned-but-unwritten file | ✓ (1 advisory: `CHANGELOG.md`, created at first release) |
| Markdown links resolve | ✓ |
| `§N` cross-references point at a section that exists in the target file | ✓ |
| Every tool-requested capability exists in the `SECURITY.md` §6.1 vocabulary | ✓ (enforced by the checker) |
| No planning document claims an implementation exists | ✓ |
| Terminology: Gateway, Policy Engine, Task Manager, Event System, Cancellation Manager, Checkpoint Manager, workspace root, Quick Tunnel | ✓ single canonical name each; `gateway/` lowercase appears only as a directory name and a command name, which is correct |
| Accepted `D-` rows do not describe themselves as unselected | ✓ |
| Review-progress tables equal the parsed rows (`scripts/count-inventory.py` and the checker agree by construction) | ✓ |
| Palette ratios in `docs/DESIGN_SYSTEM.md` §2.3 recompute from the hexes, against the worst surface, with a floor that cannot be lowered for text | ✓ (rule 13; stale numbers and washed-out values both fail, verified) |
| No `P-` row sits at `Proposed` without an open `O-` blocker | ✓ (rule 14, added because of F-17) |

## 4. Requirements Coverage From `PROJECT_BRIEF.md`

Orphan check on the brief itself — every numbered requirement needs a home:

| Brief section | Enforcing document | Status |
| --- | --- | --- |
| §5 four interfaces | `ARCHITECTURE.md` §6, `docs/INTERFACES_AND_API.md` §7–§8 | Covered |
| §6 models and providers | `PROVIDERS_AND_TOOLS.md` §3 | Covered |
| §7 agent capabilities | `AGENT_RUNTIME.md` §3–§10 | Covered |
| §8 runtime and execution | `ARCHITECTURE.md` §3–§5, §16 | Covered |
| §9 tools/skills/plugins/compat | `EXTENSIONS.md`, `PROVIDERS_AND_TOOLS.md` §4 | Covered |
| §10 security and privacy | `SECURITY.md` | Covered |
| §11 storage and memory | `docs/DATA_AND_MEMORY.md` | Covered |
| §12 technical direction | `DECISIONS.md` §3 + §5 + §5A | Covered; `O-003`/`O-005` were open by design and are closed by D-060 (npm workspaces, TypeBox), with the registry evidence in §5A re-checked 2026-10-10 |
| §13 principles | `AGENTS.md` §2–§4 (enforceable form) | Covered |
| §14 initial release scope | `docs/ROADMAP.md` §1–§8 | Covered |
| §15 out of scope | `EXTENSIONS.md` §10, `docs/ROADMAP.md` §9 | Covered |
| §16 decision policy | `DECISIONS.md` §1/§7 | Covered |
| §17 success criteria | `docs/ROADMAP.md` §8 exit gate | Covered |
| §4 platform verification | `docs/ROADMAP.md` M0 + `docs/DEVELOPMENT.md` §11 | Covered, awaiting device results |

Nothing in the brief is currently unassigned.

## 5. What the Review Could Not Verify

Being explicit, because "reviewed" must not quietly mean "verified":

01. **No document has been tested against a real system.** Termux behavior (`node:sqlite` stability, Ink repaint
    cost, WAL growth, Android process killing) is asserted from reports and registry metadata, not measured here.
    That is M0's job, and M0 can still invalidate `P-003`, `P-010`, and `P-006`. The (R) round of 2026-10-10 changed
    the *designs* around those measurements and did not touch their status: what it recorded is either arithmetic that
    can be redone here (contrast ratios, cluster widths, registry versions and dates) or a choice about what to build.
    Nothing that needs a phone was presented as settled, and the five items that need one say so with a protocol
    (`docs/review/DECISION-QUEUE.md` §2).
02. **`SECURITY.md` has not been adversarially reviewed** by anyone other than its author. A threat model written by
    the same agent that writes the mitigations is a single point of failure; the T-01…T-15 → test mapping should be
    checked by a second reader before M5 exit.
03. **Provider claims are dated.** `DECISIONS.md` §5/§5A record versions as of 2026-10-09, re-checked against the npm
    registry on 2026-10-10 for the (R) round (ink 8.0.0 published 2026-10-03, `@biomejs/biome` 2.5.15 on 2026-09-30,
    `better-sqlite3` 13.0.3 on 2026-08-05); registry state moves, so both records carry an "as of" date and must be
    re-checked at M0 rather than trusted. Ink 8 being a week old at review time is precisely why `P-010` stays
    `Proposed`.
04. **`node` here is not `node` on the device.** D-069 and D-070 rest on measurements taken in this workspace
    (type stripping unflagged, `node --test`, coverage, the `enum` rejection, registry facts for esbuild's Android
    binary). Every one of them is reproducible here and *none of them is Termux*: M0 P1 is what turns the baseline
    from a local observation into a supportable floor. That is the difference between this round's decisions and the
    ones left open, and the register marks it (`Needs Validation`) rather than smoothing it over.
05. **Cost/effort is unestimated.** `docs/ROADMAP.md` gives order and gates, not durations. Turning it into a
    schedule would require the owner's availability, which is not a documentation fact.
06. **Bengali rendering and input ergonomics are untested** on a real phone keyboard (`docs/UI_UX_SPEC.md` §9,
    `docs/DESIGN_SYSTEM.md` §11) — this matters more for this project than for most, since the owner's working
    language is Bengali and the primary device is a phone. What *was* measured here is the arithmetic behind the
    layout rule (code units vs grapheme clusters vs cells, in Node 22), which is enough to decide how truncation must
    work and nowhere near enough to claim a terminal will agree about widths.

## 6. Owner Verification Checklist

The remaining half of M-D. Each item is a yes/no, not a discussion:

- [ ] Read `PROJECT_BRIEF.md` §13 (principles) and confirm nothing there has drifted from the intent.
- [ ] Confirm `D-052` (no remembered approvals in v1) — it changes day-to-day feel, not just architecture.
- [ ] Confirm `D-053` (client management is local-only) as an accepted parity exception.
- [ ] Sanity-check `docs/ROADMAP.md` §1: is M0 (throwaway Termux probes) genuinely wanted before M1, or is one probe
      (`P3` driver, `P5` TUI) enough to proceed?
- [ ] Read `AGENTS.md` §7 (forbidden shortcuts) as the rules you actually want enforced on every future coding turn.
- [ ] Read `docs/review/DECISION-QUEUE.md` and veto anything in the (R) round you disagree with, one row at a time
      (D-059). Thirteen `O-` rows are still open: O-001/O-002 (a phone build), O-006/O-051 (a phone render), O-008
      (real extensions), O-052 (post-v1 by choice) and the halves of O-012/O-018 that M0 will finish — confirm that
      nothing is open out of habit.
- [ ] Decide whether the (R) round's *process* is the pattern you want: a delegated answer recorded with its evidence
      and marked `(R)` beats an unmarked assumption, but it does move work from "asked" to "reviewed after". If you
      would rather every item were asked first, say so and D-059 goes back to `Proposed`.
- [ ] Verify `docs/INTERFACES_AND_API.md` §8's two documented limitations are acceptable rather than gaps to fill.

**And the element-review gate added during M-D (D-055/D-056), which comes first:**

- [ ] `docs/review/README.md` — the index: what each file covers, how to answer, and which invariants the checker
      enforces.
- [ ] `docs/review/WEB.md` — 185 elements over 19 regions. Reviewed through `docs/review/mockups/crabby-web-ui.html`, which is
      generated from that file, so an element that exists in one and not the other is a build error rather than a
      disagreement.
- [ ] `docs/review/TUI.md` — 203 elements over 21 regions, every one answerable at 40 columns × 24 rows.
- [ ] `docs/review/CLI.md` — 158 elements over 15 regions, with the pipe and the exit code as the binding case.
- [ ] `docs/review/TELEGRAM.md` — 129 elements, where the transport's own limits are facts and the responses to them
      are the decisions, and where every parity-matrix capability has a command of its own (F-08).
- [ ] Only after statuses stop saying `PROPOSED`: regenerate `docs/UI_UX_SPEC.md` and `docs/DESIGN_SYSTEM.md` from
      the approved rows, then re-run §7.

675 elements, 25 decided as of this round — the 25 are the rows whose only blocker was an open question the (R) round
answered; the other 650 wait on the owner, not on research. (The count grew from 590 while F-08…F-10 were being fixed: a screen with no rows is the most expensive kind of gap, because it costs nothing to notice.) Nothing in this list is a formality: a row that reads "the small chip"
has as much standing as "the chat pane", and cutting it is a decision with an ID.

When these are ticked, `docs/ROADMAP.md` §0 moves to "M-D complete" and M0 starts.

## 7. Re-Review Rule

Re-run this review whenever: a `D-` row changes status, a new document or tool or capability is added, or an M0 probe
returns a result that contradicts a `P-` proposal. A drift check that only runs once is a snapshot, not a control —
which is why §3's checks live in `scripts/check-docs.py` and are wired into `npm run docs:check`.

---

**End of Consistency Review**
