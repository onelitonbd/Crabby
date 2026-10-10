# Crabby — M-D Cross-Document Consistency Review

> **Status:** In progress — mechanical checks pass and every open question the documents could answer on their own is
> now answered; human verification by the owner (§6) is the remaining item. The set does not need more planning
> documents, it needs the two things a plan cannot supply: the element review, and the seven M0 measurements.
>
> **Reviewed:** 22 documents (16 planning at `*.md` and `docs/*.md`, 4 element inventories, the review index and
> this file), most recently on 2026-10-10 — findings F-13…F-31 are from the six 2026-10-10 passes (the (R) round,
> the finalization round, and the two implementation passes, which is where F-27, F-28 and F-29…F-31 came from), so
> every earlier finding has been re-checked against the documents as they now stand.
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

### F-18 — The fix for F-14 was applied to seven of eight places and nobody noticed
**Severity: medium, systemic.** F-14 found eight lists of questions that had already been answered and recorded that
"each list now states the answer". It did not. `AGENT_RUNTIME.md` §12 still carried fifteen bare bullets — task state
machine, step granularity, checkpoint format, retry and backoff, compaction, budgeting, event schema, retention — every
one of them answered inside that same document (§4.1, §7.3, §8, §9, §10) or by D-043, D-064, D-065, D-074. The heading
said "Open Decisions"; the content was a history of decisions not yet marked as one.

**Resolution:** §12 is now a disposition table — item, decided where, and what a phone still has to say — so a reader
can check each claim against the section it names, and only the genuinely-measurable residue is left in an open-list.
**Rule 15** of `scripts/check-docs.py` is the systemic half: every bullet and every table row under a heading that
announces open questions must cite a `[DPO]-` id or a `§` of the document. Negative-tested by blanking one citation.

**Lesson kept:** a finding that says "in eight places" has to be closed eight times. A fix verified only where it was
first noticed is a fix with a coverage claim attached, and the claim is the part that lies.

### F-19 — An import mapping would have let an untrusted file grant itself privileges
**Severity: high.** `EXTENSIONS.md` §11's C-1 row listed the portable-skill import scope as "Markdown body + supported
frontmatter fields (name, description, allowed-tools mapping)". In the upstream format `allowed-tools` *pre-approves
tools for the skill* — so "mapping" it, read the way an implementer would, means Crabby takes a permission list from the
file it is about to run and skips the approval step that file should be passing. The format's own security notes describe
that failure in another harness, where such a line applies even in an untrusted folder. Nothing else in the set
contradicted it: D-046 and `SECURITY.md` §6.2 own approvals, and the sentence that would have caught it — §11 rule 4,
"fields that encode host behavior are translated only when there is a genuine Crabby equivalent" — did not name
`allowed-tools`, because Crabby has a *vocabulary* for tool names even though it has no equivalent for granting them.

**Resolution:** D-071 makes the field set a contract with three treatments and `allowed-tools` as the documented case of
a fourth: **recorded, never granted**. The names are mapped into the `SECURITY.md` §6.1 vocabulary for the capability
diff and flagged for review at install; no tier check is ever skipped because a file asked. `EXTENSIONS.md` §4.3 carries
the table and the reasoning, §11's row now says "read for the capability diff and never granted", and the same table
cites `SECURITY.md` §6.2's floor so the two cannot drift apart silently.

**Lesson kept:** a compatibility import is a security boundary with a nicer name. Every field copied from someone else's
format has to be classified as *data*, *display*, or *authority*, and the answer is data or display unless a decision
says so in that document — never inferred from the source format's semantics.

### F-20 — Two open questions were open nowhere, and the register's own arithmetic was wrong
**Severity: medium.** `EXTENSIONS.md` §15 listed "Signing/integrity mechanism for `verified-community`" and "Sandbox on
Termux" as open items. Neither had an `O-` row, so neither appeared in the register, in the counters, in the veto list,
or in §6 of this file — an untracked open question is invisible to every control built to find stale open questions.
Reading on for that same class of defect, `DECISIONS.md` §8's prose described the `P-` table as "Five of the ten rows
are Accepted, four Superseded, and three Needs Validation" — twelve statuses across ten rows. The two counter cells
rule 9 checks were right; the sentence *beside* them, the one a human reads, was not.

**Resolution:** the two questions are now **O-064** (signing mechanism, with the "no hosted service" constraint and a
revocation story) and **O-065** (Termux sandbox enforcement, measured by M0 P7 with a documented-limitation fallback),
which moves the tracked count to 65 and the count of rows carrying work to eight. The `P-` sentence is corrected to
four/three/three with the ids named, and `scripts/count-inventory.py --register-counters` prints all three counter cells
*and* the ids it could not classify as closed, so both kinds of arithmetic mistake are a paste rather than a memory.
Rule 15 requires the same of every row in a table like §15, which is what turned the two untracked items up.

**Lesson kept:** an item that is not in the register does not exist, and a number beside a table is a second copy of the
table. Both are fixed by the same thing: print the number from the data instead of typing it.

### F-21 — Four table rows were splitting on an unescaped pipe, and one of them reached the review instrument
**Severity: medium, mechanical.** A literal `|` inside a Markdown table cell ends the cell. `scripts/check-docs.py`
checked table *content* (statuses, ids, coverage) and never table *shape*, so four rows across four documents had been
rendering wrong for an unknown number of rounds: `EXTENSIONS.md` §15's conversion-report row (a stray pipe from an
earlier patch that had also left the sentence repeating itself), `docs/DESIGN_SYSTEM.md` §3's fallback glyph row
(`||` inside a code span, which does not protect pipes), `docs/INTERFACES_AND_API.md` §5's approval-decision row
(`approve|deny`), and — the one that mattered — `docs/review/WEB.md`'s W13-09 Gateway-lifecycle row, which had six
cells in a four-column table *and* was filed out of id order between W13-07 and W13-08, the signature of a hand-pasted
row nobody re-parsed.

The Web inventory row is not documentation-only: `docs/review/mockups/build.py` generates the review instrument from it,
and it parsed the six cells into a label containing `| restart and shutdown, both T3 | 2 buttons |` plus a `content`
field carrying one of them. So the screen the owner reviews element-by-element has been showing a corrupt row, and the
generator said nothing, because a generator that tolerates anything reads as verified.

**Resolution:** all four rows rewritten to the correct cell count with literal pipes escaped as `\|`, W13-09 re-filed
after W13-08, and **rule 16** added — every row in a table must have as many cells as its header, fences skipped so
ASCII diagrams are untouched. Negative-tested twice (a split row and an unescaped `||`). The mockup was regenerated and
re-checked headlessly after the fix.

**Lesson kept:** when a document is a *source* for a tool, its grammar is an interface. Lint the shape at the source,
because a tolerant parser turns a formatting typo into shipped UI text with no signal anywhere.

### F-22 — Two counts inside the inventories had gone stale, and no check could see either
**Severity: medium, mechanical.** The delegated element review (D-075) went row by row against each interface's own
recorded constraints, and the things it found were not opinions: `docs/review/TELEGRAM.md` G3-28 said `/help` "lists
all 28 commands" while region G3 defines **32** — a help screen built from that row would have quietly omitted four
commands, including ones the file itself documents elsewhere — and `docs/review/WEB.md` closed with "161 rows to read,
edit, cut, or approve" when 179 were open, a sentence written before the Sessions and Jobs additions (F-10, F-11)
changed the file's own size. Both are the F-20 class one level down: a number typed into a row instead of read from the
table the row belongs to. The checker could not see either one, because it verified the *coverage* tables and the §4B
progress rows, and these two numbers lived in ordinary prose inside a row.

**Resolution:** both rows now point at their source of truth instead of restating a count ("the row count of region G3
is the source, never a number typed into this cell"), and **rule 18** of `scripts/check-docs.py` closes the class: a
statement inside `docs/review/` of the form "*N* commands / elements / regions / rows to read" is compared with the
value computed from the file, and a mismatch fails. The status legend in all four inventories was corrected in the same
pass, because after D-075 `ACCEPTED` no longer means "the owner typed it" — leaving that sentence standing would have
made the register's most-used status lie about its own provenance.

**Lesson kept:** an inventory is a specification *and* a data source, so its numbers have to be derived, not recalled.
This is the third round running that found a hand-typed count that had drifted (F-17, F-20, F-22), which is why the
response each time is a rule and not just an edit.

### F-23 — One row was not a row but a second copy of another, and the copies disagreed
**Severity: medium.** `scripts/review-scan.py` flags an element name that appears twice in a file, because two rows for
one element is how a specification forks. Three of the four flags were correct UI vocabulary (`Delete` on two screens
is two Deletes), but `docs/review/TELEGRAM.md` had `/help` in region G3 *and* in region G-O — two rows for one message,
each naming a different limitation as the one help must state (G7-03 + G3-16 in one, G7-03 + G6-06 in the other), and
G3-16 is a symptom of G6-06 rather than a separate limit. An implementer reading either file would build either
variant, and both would pass review against the inventory, which is the property that makes a contradiction worth
finding rather than a difference of taste.

**Resolution:** the two rows now own different things — G3-28 is the catalogue and states limitations by the row that
owns each rule; G-O03 is the first-run invite, capped at five lines, and defers to G3-28 instead of restating it. The
duplicate-label flag stays in the scan as a *report*, not a failure: it needs a reader, and pretending otherwise would
have the checker reject `Delete`.

**Lesson kept:** inventories allow the same word twice, but not the same *message* twice. When a name repeats, the
question is never "is this label unique" but "does one thing here have two definitions".

### F-24 — The two summary documents were three rounds behind the files they summarize, and quoted their sizes wrong
**Severity: medium.** Closing the review meant updating the documents the review feeds, and reading them found the
drift the checker cannot see. `docs/UI_UX_SPEC.md`'s header announced that all four inventories were drafted, listed
each one's size, and added *"and none is approved yet"*. Every part of that sentence was stale: F-10, F-11 and F-12 had
added 24, 18 and 23 rows to three of the files since those sizes were typed, and "none is approved yet" had stopped
being true twice — 25 rows moved in the (R) round, the remaining 650 in D-075. The header quoted counts it had no way to
see, which is the whole defect; F-22 and F-20 were the same shape one level up. `docs/DESIGN_SYSTEM.md` carried the same tense problem: its
review status said the file *will be* regenerated "once those are approved", with no mention that the palette section
had already been measured and accepted, so a reader could conclude §2.3 was provisional when rule 13 treats it as
binding arithmetic. Neither header was checked by anything: rule 8 verifies the inventories' own coverage tables and
`DECISIONS.md` §4B, and the four numbers in this sentence were a *fifth* copy, in the document a newcomer reads first.

**Resolution:** both headers now say what is approved, which pass is scheduled where, and — the part that prevents a
repeat — they refuse to restate counts: `docs/UI_UX_SPEC.md` no longer lists per-file sizes at all, and both headers
state the precedence rule ("where it disagrees with `docs/review/`, `docs/review/` wins"), which is the sentence an
index needs and a number is not. **Rule 18** was widened to make the class mechanical: any "*N* elements" or
"Web *N* … elements" claim outside `docs/review/` must equal the number the inventories produce today (strict per
interface when the sentence names the unit, so a 1024px breakpoint is not mistaken for a row count), and region-level
counts are exempt because they belong to the region beside them.

**Lesson kept:** a summary document is the most trusted and least checked thing in a repository. If it quotes numbers
it cannot see, delete the numbers and keep the precedence rule.

### F-25 — P4's pass condition named a section number that two documents both have
**Severity: low, and it was the probe that caught it, not the checker.** `docs/ROADMAP.md` M0's P4 row says the served
bundle's colour values must be "the §2.3 palette". Two documents have a §2.3: `docs/UI_UX_SPEC.md`'s is *Empty states*,
`docs/DESIGN_SYSTEM.md`'s is the measured palette. The probe written against that sentence read the wrong file, found no
table, and would have reported a passing check built on nothing — `probes/p4.mjs` now reads the palette out of
`DESIGN_SYSTEM.md` and asserts that every custom property in the fixture is a value of the token it is named after, so
the check has a source. The roadmap row names the document.

Rule 5 verifies that a referenced *file* exists; it cannot tell that `§2.3` pointed at a different document's section 2.3,
and no rule could. **Lesson kept:** a cross-reference inside a pass condition needs the file name in it. "See §X" is a
promise the checker cannot keep, and the more precise the number looks, the less suspicious anyone gets.

### F-26 — P5's pass condition named a rate that no candidate dependency provides, and the honest fix was a new obligation
**Severity: medium, because the easy reading would have been a library rejection.** The condition says the TUI must
"hold ≤4 fps repaint without dropping input". `probes/p5.mjs` put Ink 8 in a real 40×24 pty and fed it 200 keystrokes
3 ms apart: every character arrived, and the frame was repainted around 300 times a second. The run's exact figure is the failing line in
`probes/RESULTS.md`, and only that: a number quoted in two documents is a number that can go stale (F-24). Ink is
not misbehaving; it schedules a render per state change, which is the right default for a library and the wrong answer
for a phone. Two ways out existed. Relax the row to "Ink repaints per state change" — which would have made the
condition pass by describing something else — or accept that the sentence describes work our own code has to do. The
second is what happened: `P-011` now owns the throttle, cites `O-006` as the device half, and the 4/s number stays in the
roadmap where it can be falsified again.

The same run found two smaller obligations nobody had written down: while Ink's `exitOnCtrlC` default is on, the app's
own handler never sees Ctrl+C (measured both ways in P5), and stdin coalesces — 200 characters delivered in one write
arrive as 2 handler calls, so counting events instead of characters invents lost keystrokes. Both are in `P-010`'s row
because M-T has to implement them, and neither is in a spec, because a spec is where a *decision* goes, not a library
fact. **Lesson kept:** when a probe fails, first ask whether the assumption or the measurement is at fault — and if the
measurement is right, the finding goes into the register as work, not into the roadmap as softer wording.

### F-27 — The implementation pass started from notes about the docs, and four of the notes were not in the docs
**Severity: high for the process, low for the documents.** M1a began by writing `packages/api-contracts` and
`packages/core` from what the planning rounds had *concluded*, and the code carried a `gateway.port` of 8765, a
`logging.level` default, a `policy.approvalMode` with three modes, an `agent.maxIterations` of 24, a `budget.dailyUsd`
of 25, and a `$tmp/config.json` written next to a `$tmp/.crabby` directory. `grep -c` over the repository returns zero
for `8765`, for `approvalMode`, for `maxIterations` and for `auto-safe`; DEVELOPMENT §8 is *PR Template*, not test
isolation; and the "documented" sample config block does not exist anywhere in the plan. Every one of those was a
citation-shaped sentence in a working note, repeated often enough to stop looking like a guess. Nothing in the
documents was wrong — the notes were wrong about the documents, which is worse, because a doc bug gets reviewed and a
stale summary does not.

Three defences, all now in use: the code cites a **file and a line range that `grep` can find** (`packages/platform/paths.ts`
names §5's isolation table and §10's reflex; `packages/core/config.ts` names D-074 and quotes the `limits.*` sentence);
a value with no citation is not written, it is opened (O-066…O-069 exist because the first pass refused to keep
four numbers it could not point at); and the tests assert the *absence* as well — `tests/unit/platform.test.ts` proves
there is no `CRABBY_DATA_DIR` override to discover, and `tests/unit/cli.test.ts` proves `config set` writes only the
override, so a re-inflated `config.json` fails CI rather than shipping quietly. **Lesson kept:** when the source of a
fact is a note about a document, re-read the document before the fact reaches code. A citation is a claim that a grep
will succeed, and the grep takes four seconds.

### F-28 — `crabby doctor` had to report a required check as impossible rather than approximate it
**Severity: medium, and it is a good result.** `docs/DEVELOPMENT.md` §1 lists `engines.node` as authoritative for the
Node range, and D-070 restates the requirement behaviourally ("the installed Node must run `.ts` entry points and
`node --test` with no flags and no loader"). This container cannot supply the number the pin needs — D-070's rule is
that the Termux measurement sets it, and the phone column is still open (O-002, `probes/RESULTS.md`) — so
`crabby doctor` prints a `warn` naming the missing pin and a fix pointing at M0 P1, and `tests/unit/cli.test.ts`
asserts that a `fail` never comes from that check. The alternative was to write `"node": ">=22"` from a container and
let a phone discover the mistake later, which is the failure mode D-070 was written to prevent. The same reasoning made
`doctor`'s three Gateway-backed checks `deferred` instead of `ok`: a diagnostic that reports a component nobody has
built yet is how a green check mark becomes worth less than a red one.

### F-29 — A finding I filed against the documents, where the documents had already answered
**Severity: high for the process, zero for the code.** While sizing the event payload cap, I searched `DECISIONS.md`
and `docs/DATA_AND_MEMORY.md` for the phrases "payload cap", "max bytes" and "truncation", found nothing, and opened
**O-068** for an undocumented number — three days after D-064 had written "64 KiB inline, larger goes to a file in the
session scratch" and D-065 had restated it as the event payload limit (`DECISIONS.md` D-064/D-065,
`docs/DATA_AND_MEMORY.md` §5). The number was never missing; my query was. Two rules come out of this and both are
now in how this project searches: **grep the unit as well as the concept** (a document that decided something wrote
the digit, and "64" is findable while "payload cap" may not be), and **write a gap as an observation rather than a
conclusion** — a comment in `packages/api-contracts/events.ts` claimed "no document names a size", which is a claim
about a corpus, not about my grep, and it stayed wrong for a whole round until it was replaced with "no row found for".
The four rows that were genuinely undocumented (the class → status map, the page ceiling, the database filename, the
heartbeat interval) survived exactly this treatment: each was confirmed by an exhaustive pass over the section that
owned it before it was opened, and they are O-066, O-067 and O-069 — closed as D-077, D-078, D-079. O-068 closed by
citation, with the misfiling recorded here rather than edited out.

### F-30 — A script the documents promised and the manifest did not have
**Severity: low, and the rule turns out to be bidirectional.** `docs/DEVELOPMENT.md` §3's table listed
`npm run test:integration` while `package.json` had no such script and `tests/integration/` was an empty directory —
the state §3's own footnote describes as intentional ("these scripts need code to point at, and a script that exists
but does not work is the failure mode D-060's rule prevents"). Writing the harness made the asymmetry visible from the
other side: a *document* advertising a command nobody can run is the same defect as the command that exits 0 while
doing nothing, and `scripts/check-docs.py` catches neither, because it checks references, not reachability. Both
halves are now closed together — `tests/integration/gateway.test.ts` exists, the manifest carries
`test:integration` as a subset runner over that directory, and §3's footnote names which scripts still do not exist
(`dev`, `build`, `test:security`, `test:live`, `test:parity`) instead of leaving a reader to discover it by typing one.
The general rule, for the next milestone that "already has it in the docs": a table of commands is a promise about the
manifest, so it is verified by running the command, not by reading the row.

### F-31 — §5.1 required disabling proxy buffering and left out the one line that makes SSE work at all
**Severity: medium, and M1c inherits it.** The first `GET /events` implementation opened the stream, framed its
frames, and delivered none of them: `reply.hijack()` hands back a raw response whose `transfer-encoding` is already
negotiated as `chunked`, so writing frames to `reply.raw.socket` — which is what "hijacked, therefore mine" suggests —
puts a frame's text where a chunk size belongs. `curl` tolerated it and printed nothing; Node's `fetch` answered
`HPE_INVALID_CHUNK_SIZE` and killed the stream, and a second bug hid behind it, because `writeHead` only queues the
status line so a client waiting for headers saw a hung server until the first heartbeat 15 s later. The fixes are two
lines (`write` to the `ServerResponse`, and `flushHeaders()` on open) and `tests/integration/gateway.test.ts` now
asserts a real frame over a real socket, but the reason this is a *review* finding is that `docs/INTERFACES_AND_API.md`
§5.1 specifies the parts a client can see (`X-Accel-Buffering: no`, heartbeats, `Last-Event-ID`) and says nothing about
the one rule the server has to keep for any of it to arrive, which every implementer of a second stream — the TUI's
task tail, the browser's `EventSource`, Telegram's forwarder — is left to rediscover. Recorded here, and the client
side of the same rule ("a stream you are not draining must still be read or cancelled, because a paused reader is
backpressure on the task") belongs in M1c's element rows rather than in a comment in `sse.ts`.


## 3. Checks That Passed

| Check | Result |
| --- | --- |
| All `D-`/`P-`/`O-` references resolve to a register row | ✓ |
| Every referenced document resolves, or is an advisory for a planned-but-unwritten file | ✓ (3 advisories, all `CHANGELOG.md`, created at first release: `README.md`, `docs/DEVELOPMENT.md`, this file) |
| Markdown links resolve | ✓ |
| `§N` cross-references point at a section that exists in the target file | ✓ |
| Every tool-requested capability exists in the `SECURITY.md` §6.1 vocabulary | ✓ (enforced by the checker) |
| No planning document claims an implementation exists | ✓ |
| Terminology: Gateway, Policy Engine, Task Manager, Event System, Cancellation Manager, Checkpoint Manager, workspace root, Quick Tunnel | ✓ single canonical name each; `gateway/` lowercase appears only as a directory name and a command name, which is correct |
| Accepted `D-` rows do not describe themselves as unselected | ✓ |
| Review-progress tables equal the parsed rows (`scripts/count-inventory.py` and the checker agree by construction) | ✓ |
| Palette ratios in `docs/DESIGN_SYSTEM.md` §2.3 recompute from the hexes, against the worst surface, with a floor that cannot be lowered for text | ✓ (rule 13; stale numbers and washed-out values both fail, verified) |
| No `P-` row sits at `Proposed` without an open `O-` blocker | ✓ (rule 14, added because of F-17) |
| Every item in an open-questions list cites the decision or section that owns it | ✓ (rule 15, added because of F-18; negative-tested by blanking a citation) |
| The section 8 counters and the `P-` row arithmetic are printed by a tool, not remembered | ✓ (`scripts/count-inventory.py --register-counters`) |
| `allowed-tools` in an imported skill cannot grant a privilege | ✓ (D-071, `EXTENSIONS.md` §4.3 — F-19) |
| Markdown tables are rectangular, so a generator reads the same row a human does | ✓ (rule 16, added because of F-21; 4 pre-existing rows fixed) |
| A count written inside `docs/review/` equals the count the file's rows produce | ✓ (rule 18, added because of F-22) |
| A count quoted by a summary document equals what the inventories hold today | ✓ (rule 18 widened because of F-24; negative-tested with three planted wrong figures) |
| Every element row satisfies its own interface's recorded constraints | ✓ (`scripts/review-scan.py`, run as the D-075 pass: 675 rows, 0 cuts, 2 corrections) |

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
    That is M0's job, and M0 can still invalidate `P-003`, `P-004`, `P-010` and `P-011`. Its container half was run on 2026-10-10 and is generated into `probes/RESULTS.md` — which proves the probes work, not the assumptions, and produced F-25 and F-26 on the way. The (R) round of 2026-10-10 changed
    the *designs* around those measurements and did not touch their status: what it recorded is either arithmetic that
    can be redone here (contrast ratios, cluster widths, registry versions and dates) or a choice about what to build.
    Nothing that needs a phone was presented as settled. Eight rows carry work and each names its closing step in
    `DECISIONS.md` §4: O-001 and O-002 (a clean Termux build, a WAL torture), O-006 and O-051 (a phone render), O-008
    (real extensions), O-052 (post-v1 by choice), and the two registered while finalizing — O-064 (signing) and O-065
    (sandbox). The (R) round's recommendations stay separately reviewable and vetoable in
    `docs/review/DECISION-QUEUE.md` §2.
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
06. **The skill frontmatter field set is described by secondary sources.** D-071's constraints (name length and folder
    equality, the 1–1024 description, `compatibility` as prose, `allowed-tools` as an experimental pre-approval list) were
    cross-checked on 2026-10-10 against six independent write-ups of the upstream spec, which agree with each other — not
    against a fetched normative file, and the spec is younger than this project's ambition for it. Crabby's own rule is
    what makes that survivable: an unknown field is recorded and never fatal, so a spec change costs a report line rather
    than a broken import. The numbers in D-074 are likewise unfalsifiable here; each is a starting value whose only judge
    is a device, which is why they ship as `limits.*` keys instead of prose.
07. **Bengali rendering and input ergonomics are untested** on a real phone keyboard (`docs/UI_UX_SPEC.md` §9,
    `docs/DESIGN_SYSTEM.md` §11) — this matters more for this project than for most, since the owner's working
    language is Bengali and the primary device is a phone. What *was* measured here is the arithmetic behind the
    layout rule (code units vs grapheme clusters vs cells, in Node 22), which is enough to decide how truncation must
    work and nowhere near enough to claim a terminal will agree about widths.

## 6. Owner Verification — delegated, and what that changed

The second half of M-D was always going to be yours, and on 2026-10-10 you said you had no time for it and asked for
the reviewer's own judgment instead, with review arriving while the work is in progress (D-075, D-076). So the
checklist below is no longer a gate in front of M0. It is a **spot-check list you can use any time, including after
implementation has started**, and each item has a one-line veto path because a delegated answer is only tolerable if
undoing it is cheap:

| Item | Where it lives | If you disagree |
| --- | --- | --- |
| The 675 element rows, all now `ACCEPTED` | `docs/review/*.md`, reviewed against the criteria in `docs/review/README.md` | Set the row back to `PROPOSED` or `EDIT`, then `python3 scripts/count-inventory.py --markdown` → paste into `DECISIONS.md` §4B → `python3 scripts/check-docs.py` |
| The 650-row pass and what it changed (2 rows, 0 cuts) | `docs/review/README.md` "Delegated review outcome" | Re-run `python3 scripts/review-scan.py`; the scan is the criteria, so a disagreement is usually a row the scan cannot see (taste), which is exactly what D-076 keeps for you |
| D-059…D-076, every `(R)` decision | `docs/review/DECISION-QUEUE.md` §1–§3, one row per recommendation | Flip that `D-` row to `Proposed`, revert the inventory rows in its "flips" column, re-run the checker |
| `PROJECT_BRIEF.md` §13 principles still describe the product you want | the brief | Say which principle moved; a principle change is not a row edit, it re-weights decisions |
| `D-052` (no remembered approvals in v1) and `D-053` (client management is local-only) | `SECURITY.md` §6.3, `docs/INTERFACES_AND_API.md` §8 | These two change how the product *feels*; they are the two rows in this set most worth a look before M1 |
| Whether M0 is genuinely wanted as seven probes, or two (`P3`, `P5`) are enough | `docs/ROADMAP.md` §2 | Say so and §2 shrinks; M0 exists to be argued with |
| `AGENTS.md` §7 as the rules you want enforced on every coding turn | `AGENTS.md` | Any rule there that you would not enforce is a rule to delete, not to soften |
| `docs/INTERFACES_AND_API.md` §8's two documented limitations | that section | They are limitations, not gaps; if you want them closed, that is a new `O-` row |

**What delegation did not do:** it did not close the eight `O-` rows that need a device (O-001, O-002, O-006, O-008,
O-051, O-052, O-064, O-065), it did not make any `(R)` row unreviewable, and it did not move an element row to `EDIT`
or `CUT` on your behalf — the pass cut nothing, so no capability lost an interface and the parity matrix needed no
edits. `docs/UI_UX_SPEC.md` and `docs/DESIGN_SYSTEM.md` are regenerated at M0 P8 rather than now, on purpose: M0 P3
and P5 can still change rows, and regenerating a spec from numbers that are about to be measured would produce a
document that needs regenerating again inside a week.

M-D's mechanical half is complete and the human half is delegated, so `docs/ROADMAP.md` §0 no longer waits on this
file: M0 can start on the owner's go-ahead, and the element reviews happen against running screens (D-076).

## 7. Re-Review Rule

Re-run this review whenever: a `D-` row changes status, a new document or tool or capability is added, or an M0 probe
returns a result that contradicts a `P-` proposal. A drift check that only runs once is a snapshot, not a control —
which is why §3's checks live in `scripts/check-docs.py` and are wired into `npm run docs:check`.

---

**End of Consistency Review**
