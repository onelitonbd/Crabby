# Crabby — M-D Cross-Document Consistency Review

> **Status:** In progress — mechanical checks pass and every open question the documents could answer on their own is
> now answered; human verification by the owner (§6) is the remaining item. The set does not need more planning
> documents, it needs the two things a plan cannot supply: the element review, and the seven M0 measurements.
>
> **Reviewed:** 22 documents (16 planning at `*.md` and `docs/*.md`, 4 element inventories, the review index and
> this file), most recently on 2026-10-10 — findings F-13…F-31 are from the six 2026-10-10 passes (the (R) round,
> the finalization round, and the two implementation passes, which is where F-27, F-28 and F-29…F-31 came from),
> F-32…F-36 from M1c's implementation pass, the first pass where a *generator* rather than a reader compared the
> documents with the code, and F-37…F-53 from M2's — CI's seven legs (F-37), the one unreproduced red (F-38, sighted
> twice), a rule enforced without a document to cite (F-39), the checker's own arithmetic (F-40), the three M2d's loop met
> when it had to ask for numbers and vocabulary the plan had not priced (F-41…F-43), the three M2e's cancellation manager
> met when it had to write down an outcome §6.2 requires and the plan had not defined (F-44…F-46), and the two M2g's
> recovery met when it had to answer what a restart owes a prompt and a user (F-47, F-48), the one M2h's ladder met
> when it went looking for the budget D-043 had already priced (F-49), the one M2i's checkpoint met when it went to
> hand the run back to a task the state machine had already ended (F-50), and the two M2j's revocation met when it went to
> find the second half of its own promise and the capability that was supposed to decide it (F-51, F-52, F-53).
> Every earlier finding has been re-checked against
> the documents as they now stand.
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


### F-32 — A capability was listed twice in the vocabulary, and only a generator could see it
**Severity: low as a typo, medium as a signal.** `SECURITY.md` §6.1's capability table had `task.read` on two rows —
one inside the grouped "read-only: state, history, and results" line, one on its own. A prose review does not flag that,
because each row is individually plausible and a reader who wants the fact finds it twice rather than noticing the
second copy. What caught it was the day `scripts/parity.ts` started comparing §6.1 against `CAPABILITIES` in
`packages/policy`: the comparison counts a name once per row and one grant per name *between* rows, so the duplicate
failed in the same commit that added the check. Fixed by folding the read-only wording into the grouped task row and
deleting the second row. The extracted rule is that a capability list is a set, and "harmless redundancy" in a security
document is two sentences that can drift apart — a grant renamed in one row and not the other is exactly what §6.1
exists to prevent. The check keeps the distinction the fix taught it: repeated names inside one row's sentence are
prose, the same name granted by two rows is a contradiction.

### F-33 — Two documents disagreed about whether a read-only tool needs a grant, and the code had to choose
**Severity: medium, and still open by decision.** `PROVIDERS_AND_TOOLS.md` §4.2 writes the words "read-only" in the
cell where `tunnel.status`, `ext.list`/`ext.info` and `memory.search` would otherwise name a grant, and so names none;
`SECURITY.md` §6.1 defines `ext.list` and `memory.read` as capabilities with scope `none`. One document therefore says
"there is nothing to grant" and the other says "there is a grant". `packages/policy` could not defer the question,
because evaluation order (D-014's boundary) has to know whether an unlisted capability is a deny. It follows §4.2 —
§4.2 is the document that owns per-tool capability assignment — and the affected rows carry a `capabilityNote` with
§4.2's own words rather than an empty list, so the registry can be read as a transcription instead of an opinion
(`packages/policy/tools.ts`'s header says the same thing at the code). What was *not* done is the tempting version:
attaching `ext.list` and `memory.read` to those rows, which would make `evaluate()` deny a tool that is supposed to
work on every device until somebody grants a grant nobody asked for. The closing sentence belongs in §6.1 — that a
scope-`none` capability is one the subject always holds, so naming it in §4.2 or not cannot change an answer — and is
left for the next time §6.1 is open rather than written here, because this file records findings and does not edit a
security document through the back door.

### F-34 — `shell.privileged` is T3 in the tier table and off-by-default in nobody's prose
**Severity: medium.** Writing `OFF_BY_DEFAULT` in `packages/policy/availability.ts` looked like a two-line job: `shell.run`
is documented as shipping disabled, and the elevated sibling surely does too. It is not: §4.2's note for `shell.run`
says the capability is off by default, and no document says anything of the kind about `shell.privileged`. Inheriting it
would have made the constant carry one inference, and the inference would have read as a documented rule the next time a
reviewer checked the code against the prose — the failure direction D-071's "recorded, never honored" note already
describes. So `OFF_BY_DEFAULT` is exactly `["shell.run"]`, the comment names the gap, and the security suite asserts the
list against the documents in both directions: every entry must have an "off by default" sentence to point at, and no
capability may be in the list without one. `shell.privileged` inherits T3's approval requirement, which is enforced
every call rather than at install time; whether it should *also* ship disabled is an owner question, and it is recorded
here as that rather than answered.

### F-35 — The parity generator found two documents missing rows that code already had
**Severity: high for the documents, and it is the reason the generator was worth writing before `build` exists.** Two
checks, two holes. First: `packages/gateway/app.ts` registers eleven routes from M1b's auth slice —
`POST /clients/register`, `POST /pairings/redeem`, `GET /clients`, `DELETE /clients/{id}` — and `§4` documented none of
them, because they existed only inside a fenced ASCII diagram in §3.1/§3.2. A reader of §4 got a complete-looking table
that was missing the four rows every CLI on the planet calls first; the diagram's prose was true, and the *contract
section* was not. Second: `docs/review/TELEGRAM.md` G1-02 and G-O01 both build on `/start`, `docs/INTERFACES_AND_API.md`
§7.4 promised "one command per capability group", and `/start` was not in §7.4's 28-command list — so either the
inventory proposed a command the contract forbade, or the contract had an exemption it never stated. Fixed by adding
§4.5 "Clients and pairing" (four rows, worded from `registerAuthRoutes`' comments and §3.1/§3.2's own language, so the
table says what the code does rather than what a design hoped) and by putting `/start` in §7.4 with the reason it is
exempt: it is not a capability, it is how a chat learns the bot exists, and a rule that cannot say that is a rule that
will be broken on purpose. Both directions of the lesson matter: a check that reads documents against documents found
neither of these for three rounds, because two documents can agree on being incomplete.

### F-36 — A planned command could not name its milestone, because the plan has none for it
**Severity: low, and it is the good kind.** `tests/unit/cli.test.ts` refuses a help line that says "planned" without
saying when — an assertion that had been easy for `crabby tunnel on` to satisfy with an invented `M4`. It could not,
because `docs/ROADMAP.md` has no phase for the tunnel: `SECURITY.md` §13 defers remote exposure out of the initial
release unless a request needs it, and the phase list never says which phase owns that. So the honest help text cites
the section that defers it, the test now accepts a `§` citation as an answer of the same class as an `M` number, and
the gap is recorded here: **the tunnel needs a place in the roadmap, or the roadmap should say explicitly that it is
post-M6 by design.** Inventing `M4` would have been worse in two directions — the milestone would have been a lie, and
the day someone scheduled the tunnel the lie becomes the citation. This is the F-28 shape (refuse to approximate a
number the plan has not earned) applied to a help string, and it is why `planned` rows in `apps/cli/registry.ts` carry a
`milestone` field at all: a command that cannot say when it arrives has to say what stopped it.

### F-37 — A CI matrix row cited a Docker image as though it were an Action
**Severity: medium, and it is the reason `docs/DEVELOPMENT.md` §12 now has an "absent legs" table.** The plan's CI
section asked for a third matrix runner: "`termux` via `termux/termux-docker` for the toolchain half (D-060)". Read as a
sentence it is a reasonable request; read against the thing it names, it is a category error — `termux/termux-docker` is
a Docker **image**, so it arrives as a `container:` job rather than a runner, its own README states the environment has
no Android runtime components, its `aarch64` tag needs `--privileged` or `seccomp:unconfined`, and `termux-api` binaries
do not work under proot at all (`termux/proot-distro`#516). So the leg the sentence wanted — evidence about a phone — is
exactly the evidence a container cannot give, and the leg a container *could* give (does `npm ci` and `node --test`
survive bionic) was already answerable from the probes and is not what the row was for. D-082 records the outcome: the
workflow ships the seven legs that pass today, §12 names each absent leg with the milestone that gives it something to
run, and the Termux half stays with `npm run test:termux` and the M0 device checklist, with O-050 open until an ARM
runner exists. The general rule for a table of commands, extended: a CI row is a promise about *infrastructure that
exists*, so it is verified by reading the upstream README, not by trusting the phrasing — the same discipline F-27
demands of a citation, applied to a toolchain instead of a document.

### F-38 — A required leg failed once on a freshly installed tree, and the record says so rather than shrinking
**Severity: medium, and the finding is the record itself.** Verifying the pushed commit meant installing the GitHub
tarball of it in an empty directory, and the first `npm test` there answered `# tests 173 · # pass 172 · # fail 1`.
Nine further runs — two of them under 16 concurrent busy loops, one of them the exact same command again — were
173/173, and the failure has not repeated since. What is written down is therefore not a fix but the shape of the thing
to compare against if it happens again: the only two budgets a cold tree has to beat are already priced generously
(`waitForGatewayInfo` at 25 s and the SIGTERM drain at 12 s, both in `tests/integration/gateway.test.ts`, and the spawn
helpers in `tests/unit/cli.test.ts` carry no timeout at all, so slowness cannot fail them); the one known
process-lifetime hazard in that file is the one it already documents and disarms, which is Node's fetch keeping the
dispatcher's sockets open for 72 s and making a finished file look like a timeout, handled by the `after()` hook at the
bottom of `tests/integration/gateway.test.ts`. What the exercise did establish as a *fact about the environment*, not
about Crabby: a clean install with lifecycle scripts enabled fails here at `better-sqlite3`'s build step, because
`node-gyp` wants the Node headers host and this sandbox reaches only the npm registry — while the same install with
`--ignore-scripts` succeeds and runs, because npm's cache already held a matching prebuilt binary. So a
locked-down image can install Crabby and still not be able to build its driver from source, and that is now written
into `docs/DEVELOPMENT.md` §1's install row instead of being discovered by the next person on a captive network. The
rule this file has been building since F-20 applies to a red you cannot reproduce: name it, date it, and record what
was measured against it, because "could not reproduce" without the measurements is how a real race becomes folklore.

**Second sighting, 2026-10-10, M2e, and this one has a named condition.** `npm test` answered `# tests 250 · # pass 249 ·
# fail 1`, the failure being `a spawned gateway and a spawned cli (P-003)` — the same test, and the first red since the
one above. What was different is measurable: the run was started *concurrently* with a second shell running
`test:integration`, `test:security`, `biome`, `parity` and `docs:check`, so two suites were spawning processes and
type-stripping TypeScript on the same cores at once. Re-run alone immediately afterwards, and twice more during the same
slice, it was 250/250. So the budget that gave way is `waitForGatewayInfo`'s 25 s under roughly double load, which is a
fact about the sandbox rather than about the Gateway — but it is the second time this specific test has been the one to
fail, and the pattern is now worth stating: **the spawned-process legs are the ones that go red under load, and a red
produced by running two suites at once is not evidence about the code.** The discipline that follows is the boring one —
run the gates one at a time before a commit, which is what the M2 slices have done, and treat a red from a parallel run
as unmeasured until it reproduces on its own.

### F-39 — A security rule enforced by code cited a section that does not state it, and the fix moved the rule and the sentence
**Severity: high, because the rule was correct.** `packages/policy/evaluate.ts` refuses to queue a T3 approval for a
Telegram client, and its comment and its user-facing message both cite `SECURITY.md` §6.2. §6.2's T3 row says
"explicit approval, no stored blanket grant, re-prompt on every material change"; §6.2's rules list says nothing about
which surface may answer. Meanwhile §6.3 states "it must be answerable from all four interfaces". So a reviewer reading
only the documents — which is what `docs/DEVELOPMENT.md` §7 asks of a security change — would find an enforcement that
the prose forbids, in the one place a chat notification is most likely to be answered, and the defensible action would
be to delete the `if`. Finding it required writing the approval arbiter and needing to know, for the route, *who may
answer what*: the answer was not in any document.

Two moves, in this order. The rule was kept and §6.2 gained a bullet, because "a T3 signature may be made only on a
surface that renders the whole request" is the §6.2 floor and D-080's procedure for changing what a tier means is to
move the document first, in a commit a reviewer reads. And the enforcement moved from the queue to the answer:
`evaluate` refusing to *create* a T3 prompt for one surface is not the same rule as refusing to *record an answer* on
it, because the queue is shared ("answer from anywhere"), a T3 row opened for the TUI sits in the phone's list too, and
a per-surface check would have to be written four times and would fail the first time a fifth surface arrived. D-085
records both halves, including the part that was decided rather than found: a refusal from a wrong surface leaves the
row `pending` and writes no event, since sending someone to another device to say *no* is worse than the prompt they
were already reading, and an unanswered request expires in D-064's window instead.

The general rule this adds to the one F-27 established: a citation in a message string is a claim about a document, and
`grep` settles it — but a *refusal* a user reads is also a rule, so the check is two-sided. A citation that points at a
section which does not say it is a finding even when the behavior is right, because the behavior is then owned by a
comment instead of by the specification that is supposed to be able to overrule it.

### F-40 — The checker counted one thing and printed another, and the fix was to make the number come from the list
**Severity: low, category: the tooling that enforces everything else.** `scripts/check-docs.py` printed
`! 4 advisory item(s)` followed by three bullets. The count came from the raw list and the bullets from
`sorted(set(list))`, so one duplicate reference — three documents citing the not-yet-written `CHANGELOG.md`, plus a
second mention in one of them — made the line advertise output the tool had not shown. Nothing failed, which is how a
reporter bug survives: the check it belongs to is advisory by design, because a reference to a planned document is a
promise and not an error. That part is correct and stays — `CHANGELOG.md` is owed to M9's release process, and the
advisory list is where a reviewer sees the debt without a build going red for it.

What was fixed is the arithmetic: the list is deduplicated first and its length is what is printed, so the number is
computed from the thing beneath it rather than from an earlier snapshot of the same data. The general rule, which
belongs next to F-27's: **a count printed above a list has to come from the expression that produced the list** —
`len(raw)` beside `sorted(set(raw))` is a discrepancy no test can catch because both halves are individually correct,
and a tool whose numbers do not match its own output teaches a reviewer to skim it.

The same audit found and fixed one instance of the *worse* version of this in a user-facing command, recorded here
rather than in its own section because the cause is identical: `crabby status` printed "no policy engine in this build
— T2/T3 approvals arrive with M2, so nothing is waiting". The policy engine has been in the build since M1c and the
approval queue has been answerable since M2's arbiter, so the line asserted a fact about the release that the release no
longer matches, and no test reads prose. The command now queries `GET /approvals?state=pending` and prints the count it
gets, with the same object in the `--json` document — the claim became a measurement, which is the only fix that cannot
go stale again.

### F-41 — §5.2 requires six limits and D-074's table priced two of them nowhere
**Severity: medium, because the prose and the table were both right and the code needed one of them.**
`PROVIDERS_AND_TOOLS.md` §5.2's opening sentence requires the core — citing `SECURITY.md` §12 for why the caller may not
be trusted with it — to enforce "per-task step limit, wall-clock timeout, tool-call count, output bytes, parallel steps
(D-023), provider request rate, and a token budget with an optional cost ceiling". D-074's table, which is where §5.2 says
those numbers live ("every row is a `limits.*` key in `config.json`"), carries provider timeouts, three tool classes,
SQLite's busy timeout, extension overhead, 2 parallel steps, 4 concurrent provider requests and 5 queued tasks. It
carries **no row for a per-task step limit and none for a tool-call count**, and none for a per-task wall clock or a token
budget either.

M2d's loop was the first code that had to answer "how many steps", which turned a documentation gap into a blocker: an
unbounded loop of refused proposals is exactly what `SECURITY.md` §6.3 forbids, and a bound written only in a source file
is a number no document can overrule — F-39's shape one level down, since here the *rule* was documented and the *size*
was not. Fixed by D-088: 25 steps per task, counting refused calls as well as executed ones, and 2 tool calls per
completion — D-074's own parallel-steps number reused as a per-response cap rather than a second invention. Both rows are
in §5.2's table, and the three limits that remain unpriced are named in the paragraph under it with the reason each one
waits: a wall clock would have to exclude D-064's approval window (D-074 keeps the two clocks separate on purpose), and a
token budget and cost ceiling need `AGENT_RUNTIME.md` §8's context accounting, which does not exist.

The same class of gap, one row down: the table prices per-tool deadlines for **three** classes only, so
`packages/agent-runtime`'s `toolDeadlineMs` answers for `fs.*`, `net.fetch` and `shell.run` and `undefined` for the other
forty-odd tools in §4.2, and the loop publishes `deadlineMs: null` in `tool.execution.started` rather than inventing a
number. The general rule this adds: **a prose list of what the core enforces and a table of numbers are two registers, and
the difference between them is a blocker for whoever writes the core.** A generator could diff them the way
`scripts/parity.ts` diffs §4.2's tier table, and that is left as a named arrival rather than built here — §5.2's list is a
sentence, and a sentence is not yet a machine-readable register.

### F-42 — The fifth approval state had no event, so one event was doing two jobs
**Severity: low, and invisible until something consumed an approval.** `APPROVAL_STATES` has five members, and the fifth —
`consumed` — is what D-052's `scope: once` means in a row. `docs/INTERFACES_AND_API.md` §5.2's `approval.*` family listed
four types, and `packages/agent-runtime/approvals.ts` returned `approval.answered` for the consumption as well as for the
answer. Nothing could see it while only the arbiter and the decision route existed: the route only *answers*, so the double
use never appeared in one log. M2d's loop consumes, and a full cycle then wrote **two `approval.answered` frames for one
decision** — the first meaning "a human approved this", the second "the runtime has now used it" — with nothing to tell a
client which had happened. `AGENT_RUNTIME.md` §5.1's own rule ("a state change without its event is a lie in progress") is
why that is a defect and not a cosmetic one.

Fixed by adding the type rather than by suppressing the second event, because suppressing it would have left a state
change unlogged: `approval.consumed` is in `EVENT_TYPES`, in §5.2's family row, and is what `consume` returns;
`packages/agent-runtime/approvals.test.ts` asserts it at the arbiter and `loop.test.ts` asserts it in a full cycle, in
order, before the action starts. It is deliberately **not** in `ACTIONABLE_EVENT_TYPES`: §5.2's rule is about events a
client must act on, and nobody acts on a consumption — the action it authorized is already running. The general rule: a
state list and an event list are two registers of one lifecycle, and when their lengths differ the shorter one is missing
something rather than the longer one inventing it.

### F-43 — A deferral the registry carries on a row no name-keyed lookup can reach
**Severity: low, still open by choice, category: a table split by argument and a lookup keyed by name.** §4.2 gives
`ext.install` two rows: "Content-only kinds." at T2, and the executable kind "Blocked in the first release regardless of
tier (D-038)". `packages/policy`'s `resolveTool` answers **by name**, so it returns the first row — and `availability.ts`'s
`deferralFor`, which correctly reads the deferral off the row's own note instead of keeping a second list, therefore never
sees the blocked one. No argument rule covers the gap either: `escalation.ts` has nothing for `ext.install`. So an executor
that declared `ext.install` today would be offered it, and a call carrying an executable kind would be *gated at T2*
instead of blocked at D-038.

Recorded rather than fixed, for two reasons. Nothing in this build declares an `ext.install` executor — `ARCHITECTURE.md`
§18's `packages/tools` has existed since M2k and implements eight file rows, none of them `ext.install`, so what makes the
gap unreachable is now the executor's scope rather than its absence, which is a narrower reason and a stabler one — and the
honest fix is an argument-dependent rule in
`escalation.ts` beside the §4.2 row that justifies it, which belongs with the extension tooling and not with M2d's loop.
`packages/agent-runtime/loop.test.ts` pins what *is* reachable (`withheldReason("ext.install", …)` answers `undefined`
when the identity holds the grant) with this finding named in the assertion message, so the day someone adds the executor
the test that goes red is the one that says why. It is the same shape as F-33 and F-34: two documents or two rows
disagreeing, recorded visibly instead of resolved by inference.

### F-44 — §6.2 said a per-tool duration was undecided while D-074's table priced three, and the code enforced them
**Severity: low, and it was the code that made it visible.** `AGENT_RUNTIME.md` §6.2's last paragraph read: "Timeout
thresholds remain a tuning value (the 64 KiB and temp-lifetime caps are decided in D-064; a per-tool duration is not)".
D-074's table in `PROVIDERS_AND_TOOLS.md` §5.2 prices three per-tool durations — `fs.*` 10 s, `net.fetch` 20 s,
`shell.run` 120 s — as "defaults with a named override path", and M2d's loop enforces exactly those three, citing D-074.
A reviewer reading §6.2 would conclude the loop invented numbers, and the defensible action would be to delete the
enforcement: F-39's shape again, with the code right and the sentence stale.

The sentence was wrong, not the table, so the sentence moved: §6.2 now says the thresholds are defaults with an override
path, names the three classes that are priced and the code that enforces them, and says plainly that the other forty-odd
tools in §4.2 have no priced duration — which is F-41's third clause, and is why `toolDeadlineMs` returns `undefined` and
the loop publishes `deadlineMs: null` instead of guessing. The general rule is F-27's, applied to a negative claim: a
document saying a number is *not* decided is as checkable as one saying it is, and it goes stale in the opposite
direction, by being overtaken rather than forgotten.

### F-45 — §12's table cited D-074 for cancellation timeouts, and D-074 has no such row
**Severity: low, one half fixed and one half left unpriced on purpose.** `AGENT_RUNTIME.md` §12's disposition table answers
"Cancellation timeouts and escalation" with "§6; D-074" and adds "nothing structural; the numbers are `limits.*` keys".
§6 states the requirement and no number; D-074's table has rows for provider timeouts, three tool classes, SQLite,
extension overhead, parallel steps, provider concurrency and queue depth — and nothing for cancellation. So the citation
resolved to a table that did not contain the thing cited, which is the F-14 class of defect one level down: not a section
that moved, but a number that was never there.

M2e had to answer it, and the answer is split rather than unified (D-090). The `immediate` override — §6.2's
safety-critical path — is priced at `limits.cancellationSettleMs` = 5 s and has a row in §5.2's table, because an override
that cannot bound a step which ignores its signal is not an override. The `finish-step` default is deliberately **not**
priced: the step in flight keeps the deadline it was already given, and a cancellation clock beside a tool clock would give
one step two deadlines. §5.2's paragraph about unpriced limits now names it, so the absence is a decision a reader can
find rather than a hole a reviewer has to infer.

### F-46 — §6.2 requires the uncertainty "on the task", and `TaskRecord` has no field for it
**Severity: medium, open by choice, and the one debt M2e names instead of hiding.** §6.2: "Where an external action may
already have taken effect when cancellation arrived …, that uncertainty MUST be recorded explicitly **on the task**".
M2e records it durably, per task, in the `task.cancelled` event payload — `terminated`, `effectsUncertain`, `inFlight` and
the step — which satisfies §5.2's recovery rule ("anything a client must act on must also be retrievable by polling
`GET /tasks/{id}`") only in its weaker form: the poll that answers it is `GET /tasks/{id}/events`. A client reading the
task record alone learns that the task was cancelled and not whether an external effect is in doubt, which is the fact
§7.3 says must never be resolved by blindly re-executing.

Not fixed in that slice because the honest fix was a schema change and not a sentence: `TaskRecord` would gain a
`cancellation` object, `packages/storage` a migration to v3 with a column to hold it, `crabby task show` and
`GET /tasks/{id}` a line each, and §4.1's tool-record vocabulary a decision about where `sideEffects` eventually comes
from. That was a slice of its own with a review surface of its own, and doing it inside a cancellation slice would have put
a migration and a contract change in the same commit as the behaviour they serve. §6.2 said what was true then and what was
owed, so the gap lived in the document a reviewer reads rather than in a code comment.

*(Closed in the next slice, as intended: D-091 is `TaskRecord.cancellation` and schema version 3's `cancellation_json`
column, written once at the settle, read back by `GET /tasks/{id}` and printed by `crabby task show` as two facts a user can
judge — whether the operation stopped, and whether an external effect is in doubt. What made it more than a column is
`packages/storage/journal.ts`, the runtime's write seam over the real database: `packages/storage/journal.test.ts` now runs a
whole gated task against SQLite, with the arbiter's rows committing in the same transaction as the task's events, and
reopens the file afterwards to prove the outcome and every event that carried it survived. The one part of F-46 still open was
the half that was never this finding's to close: `sideEffects` remained in `PENDING_RECORD_FIELDS`, so `effectsUncertain`
was `true` for every tool step until a tool declared otherwise — and M2k closed it, because `packages/tools` declares
`sideEffects` for all eight of its rows (D-098) and the loop now derives the evidence from the declaration instead of
writing the constant: a cancelled `file.read` is `effectsUncertain: false` and a cancelled `file.delete` is `true`, which
is the first time §6.2's second fact has been a measurement. What survives of F-46 is nothing; what survives of
`PENDING_RECORD_FIELDS` is a reporting question and has its own row, F-55.)*

### F-47 — After a restart, a prompt is answerable and nothing can act on the answer
**Severity: medium, closed by the fortieth slice (F-47, D-111), and the one thing recovery could not make honest.** §7.1's scan marks every
non-terminal task `interrupted`, including a task that was in `awaiting_approval` when the process died. Its approval row is
durable — that was M2c's whole point — so the prompt is still in `GET /approvals?state=pending`, still inside D-064's
window, and still answerable from all four interfaces. And after the answer, nothing happens: the loop's `SuspendedRun`
was process memory (M2d says so in its header), there is no checkpoint to resume from, so no party exists that could
consume the approval and run the action. A user answers a prompt on their phone and the action never runs.

Three fixes were considered and all three were rejected in this slice. **Withdrawing the row** would need a sixth approval
state or a reuse of `expired` for something that did not expire, and the arbiter's five states are checked into the schema
by a `CHECK` constraint that M2c's tests assert against the file. **Refusing the answer at the route** for a task in
`interrupted` would contradict §7.2, which *permits* resuming work covered by a still-valid approval — the surface is not
the party that gets to narrow a rule the runtime owns (D-084's whole argument). **Rebuilding the run's conversation from
the event log** is §8's compaction with the log's redaction and 64 KiB truncation applied, so the rebuild would be lossy in
a way no document describes.

What this slice does instead is make the situation legible: the `task.interrupted` event carries the reason and names the
approval, the recovery report lists it under `approval` with `resumed: false` as a literal type, and §7.1's new paragraph
says plainly that the authorization half of §7.2 has nothing to authorize yet. It closes with the runner and the checkpoint
manager, which are the two things that would make an answer actionable — and until then the prompt expires on its own
deadline, which is the outcome D-064's gradient was designed to make safe.

*(Half closed by M2i. `packages/agent-runtime/checkpoint.ts` commits D-065's boundary and writes a second kind of
boundary for a run suspended at a prompt, so the pause is now a durable fact with coordinates — `GET /tasks/{id}/checkpoint`
names the step the run stopped on, the approval that covers it and D-065's verdict on continuing from it — and the answer
the user gives is no longer the only durable thing about the run. What is still missing is the party that would act: there
is no runner in the Gateway, no `packages/tools` for the resumed step to execute and no product provider adapter to call,
so the answer remains inert and this row stays open. M2k removed the middle item of those three — `packages/tools` exists
and declares what a resumed file step needs (D-098) — so what this row now waits on is precisely two parties, a runner and
an adapter, and neither is a tool question. The half that was this finding's to name as absent is gone: the
`task.cancelled` payload's `checkpoint` field reports a boundary instead of apologising for one, and recovery reports the
verdict per task rather than saying it has nothing to pass. F-50 is the residue, and it is a different shape: the
checkpoint turned out not to be the only thing D-044's promise was waiting on.)*

*(Closed by the fortieth slice, in both halves, and the row's own diagnosis turned out to be right about what was missing:
the party. `POST /tasks/{id}/resume` answers two positions — a ladder ask this process holds, and a task a restart left
`interrupted` — and the second one rebuilds the run from D-095's boundary instead of continuing one that is still in
memory. Three things the text above did not know, and a reviewer should read them next to the code rather than next to the
finding: **the checkpoint's `messages` are the committed context**, which is exactly what an in-process park was carrying, so
the rebuild is a continuation and not a reconstruction — and the objective is *not* prepended again, because a second copy
of the user's opening sentence would be a second instruction in the conversation. **The task's origin was not on the
record**, which is the question this row had grown since it was written, and D-111 answers it in the direction
`RunInput.origin` already insisted on: a human answering a prompt does not become the author of a task, so the record now
names the identity (schema version 9) and the route *looks it up* rather than trusting a stored copy of its capabilities —
a revoked creator refuses the continuation, which is §7.2's rule arriving from a direction nobody had thought to check.
**D-065's verdict is read in the runner**, so no route can rebuild work the runtime would not have permitted, and a
`re-ask` is refused with the verdict's own sentence. What remains open is not this row but a smaller one: `re-ask`'s
*resolution* — no interface has priced a "skip this step or retry it" act, so an interrupted task whose step was in flight
is refused with a reason rather than continued, and a user is told why instead of being offered a choice that does not
exist yet.)*

### F-48 — Nothing swept the queue, so a stale prompt was shown as pending and counted as waiting
**Severity: medium, fixed by D-093, and found by writing recovery rather than by reading the queue.** The arbiter has had
`sweep` since M2b, and its header states why: "an approval that expires only when someone looks at it is an approval that
can be answered late by a client reading a stale queue". Until M2g, the only callers were the loop's own expiry path and
`answer`'s late refusal. So the security property held — a stale prompt could not be *approved*, because the arbiter
refuses and flips the row — and the display property did not: `GET /approvals?state=pending` listed a row whose deadline had
passed, and `crabby status` printed it as "1 waiting", which is the number a user reads to decide whether to pick up their
phone.

That is the F-40 shape again, one layer up: a claim about the world ("something is waiting for you") produced by a query
that had not been told the clock had moved. Fixed by sweeping on the read that renders the queue, and at startup, with no
timer (D-093 records why: a timer needs an interval nobody decided, a lifecycle, and a second clock beside the arbiter's).
The write inside a GET is deliberate and is the part a reviewer should push on, so it is argued in the decision row rather
than left to the diff. `tests/integration/recovery.test.ts` asserts both halves over HTTP, including that a second read
does not log the same expiry twice.

### F-49 — D-043's attempt count was "configurable" and no config key reached it
**Severity: low, fixed by D-094, and found by wiring the ladder rather than by reading it.** D-043 prices the first rung
of the retry ladder as "at least 5 attempts per failing stage (configurable)", and D-064 prices the delays between the
rungs (`1s, 2s, 4s, 8s, 16s`, ±25% jitter, a `Retry-After` hint overriding upward). `packages/providers/errors.ts` had
held both since M1c — `RETRY_SCHEDULE_MS`, `retryDelayMs`, `shouldRetry`, `MAX_ATTEMPTS` — and nothing in the build called
any of them, so the loop's own header told the truth when it said a provider error fails the task on the first error and
the event says no retry was attempted. Two gaps sat inside that one and they are not the same size. The behavioural gap
was one function call wide: `callProvider` had to ask `shouldRetry` and sleep what `retryDelayMs` returned. The
*configurability* gap had no code at all: `MAX_ATTEMPTS` was a module constant, `limits` held no key that reached it, and
a user reading D-043's "(configurable)" had nothing to configure. That is F-41's shape turned around — there, a rule was
stated and a number unpriced; here, a number was priced and no rule existed that could carry it.

Fixed by `limits.providerAttempts`, defaulting to `MAX_ATTEMPTS` (6 = one attempt plus the five delays D-064 priced) with
`minimum: 5` in the TypeBox schema rather than in a comment, because a floor enforced by the same `validate()` every route
uses is stronger than a documented one, and because the floor is the part of D-043's sentence that has to survive a user
editing their own config: the configurable half may lengthen the ladder or shorten it to five, and may not configure it
out of existence. `loop.test.ts` asserts `LOOP_LIMITS.providerAttempts === MAX_ATTEMPTS` and that `providerAttempts: 4`
fails validation, so neither package has to remember the other's number — F-40's rule, two packages apart. What is *not*
fixed was D-044's second rung, and both halves of the reason it could not be have since landed: the checkpoint it resumes
from is durable (D-095, M2i) and the switch surface to ask on is `POST /tasks/{id}/resume` (the thirty-ninth slice). An
exhausted budget on a retryable class therefore no longer fails the task — it parks it in `awaiting_approval` with
`provider.switch.proposed` and no approval row, and the answer continues the run from the boundary it had reached. The
`task.failed` payload still carries `attempts`, `retried` and a `ladder` sentence, and the sentence now describes the case
it actually describes: a class that is not retryable (so there was no budget to spend and no other model that would answer
differently), or a ladder that stopped short of the configured budget.

### F-50 — D-044 resumes from the checkpoint after a failure, and the state machine has no edge out of `failed`
**Severity: medium, open, and found by writing a verdict rather than by reading D-044.** D-044's sentence is "on failure
after the retry budget, Crabby asks the user which model to use instead, and resumes from the checkpoint — never restarts
the task", and `PROVIDERS_AND_TOOLS.md` §3.6's stage 3 repeats it: "Switching models or exhausting retries **must not
restart the task from scratch**. Work already completed remains complete; execution continues from the saved checkpoint and
the pending step that failed." D-083's table makes `failed` terminal and absorbing — §4.1's first rule, enforced by
`transition()`, which refuses a move out of it and is asserted refusing it in `agent-runtime.test.ts`. So the two
documents describe one moment from opposite ends and no legal path joins them: a runtime that has failed the task has ended
it, and a resume would have to un-end it. M2h left the impression that the checkpoint was the only missing piece (F-49's
last paragraph says the rung cannot be built because there is no checkpoint to resume from); M2i built the checkpoint and
found a second wall behind it.

Three readings. **Let `failed → running` for this one case** makes the absorbing rule a default with an exception, which is
the shape §4.1 exists to prevent, and it would ripple into every interface's assumption that a terminal state means the
story is over — including `GET /tasks/{id}`'s contract, whose `state` is what a client decides whether to keep polling on.
**Fail the task and keep the prompt open** — ask the user while the task is `failed` — is a state a client cannot render:
§5.2's rule is that anything a client must act on is retrievable, and a prompt hanging off a terminal task is F-47 with the
polarity reversed. **Ask before failing** is the reading the three documents agree on once the order is fixed: the ladder's
exhaustion produces a pause in D-086's shape (`awaiting_approval`, no pending row, a `task.progress` frame naming the spent
budget and the candidate models, per §3.6's stage-2 labeling rules), the answer records the switch on the task, and the run
continues from the checkpoint while the task is still moving; only an ask that goes unanswered or is refused moves to
`failed`, where it belongs. That is what the runner's slice has to implement, and nothing in M2i altered a state machine to
get there early.

What this slice did settle is the dependency D-044 named. `verdictFor` answers `none` for a failed task with a reason that
carries both halves — the boundary is durable at step N, and `failed` is why nothing walks back to it — so a reader of
`GET /tasks/{id}/checkpoint` learns the shape of the missing rung from the record itself rather than from a document. The
row stays open until a slice either builds that pause or amends D-044 to say the ask happens before the task ends.

*(Closed by the thirty-ninth slice, on the second of the two ways this row allowed. The pause is built rather than D-044
amended: a retryable class that spends `limits.providerAttempts` stops the run in `awaiting_approval` **before** any
`failed` move exists, so the ordering is not a preference this slice had to choose — §4.1's absorbing terminal state is
unreachable from the rung that asks. `awaiting_approval` → `running` gained an evidence field (`modelAnswered`) rather
than a new edge, because the edge was always right and the record was what could not say *which* answer woke the run.
`failed` is still absorbing and still reaches only classes no switch can help. `loop.test.ts` asserts the class that
never asks — `auth` — and the loop tests that followed the answer assert the continuation rather than a restart, so the
row's own sentence ("the task does NOT restart") is now a test rather than a hope.)*

**What this did not settle, and is a new row rather than a leftover:** F-50's last clause — "an ask that goes unanswered or
is refused moves to `failed`" — describes a destination nothing in the documents prices. There is no decline verb in any
interface inventory, and no document gives the ask a deadline (D-064's window belongs to an approval row, and the ask has
no row to expire). The build therefore lets the ask wait, like D-086's refusal pause, until it is answered, cancelled, or
marked `interrupted` by a restart — which is honest but is not the sentence above, and the difference is recorded as
`DECISIONS.md` O-073 with its alternatives rather than settled in a comment.

### F-51 — §3.1's second half was a promise no code could keep, and a test name read as covering it
**Severity: medium, fixed by D-096, and found by going to implement the sentence rather than by reading it.**
`SECURITY.md` §3.1 says "revocation takes effect on the next request **and must also terminate live event streams**", and
`docs/INTERFACES_AND_API.md` §3.1 repeats the demand as a duty on `crabby auth revoke`. Four slices of Gateway work went
past it. The reason is structural rather than careless: `GET /events` resolved the caller's identity for the request that
opened the stream and then forgot it — `requireToken` returns an `Identity`, the route discarded the value, and the bus
keyed subscribers by nothing at all — so there was no handle a revocation could act *through*, and the delete route said so
in a `log.warn` ("live streams are not yet bound to identities") instead of pretending. The route's own test was titled
"revokes an identity so the next request fails, **which is §3.1's whole promise**".

That title is the finding. A requirement with a mechanism missing has nowhere to be tested, so the test written next to it
drifted into describing the half it could reach, and the drift was invisible because the sentence naming the coverage was
written by the same hand that stopped there. Fixed in three parts: the event route binds its subscriber to the identity
that opened it, `closeFor(clientId)` ends those streams in registration order and **returns how many** (a control whose
effect nobody can observe is a control that rots), and each closed stream gets a named `event: end` frame carrying
`{end: true, reason: "revoked"}` before the socket goes — because §5.4 already tells a client that a stream which stopped is
a stream to reconnect through, and a silence is exactly what that rule was written for. The frame has no `id`, because a
control frame is not an event and must not become a cursor.

What was *not* fixed, because the transport does not have the thing to fix: §3.1's neighbouring sentence — "checked once at
request start and again when a live event stream is upgraded to an action" — describes an upgrade that does not exist here.
Every client action is a plain HTTP request (`docs/INTERFACES_AND_API.md` §5.1's reason for choosing SSE over WebSocket),
so there is no moment at which a stream becomes an action; the sentence is now written against the mechanism that satisfies
it, in §3.1 of both documents.

### F-53 — §3.1 promised an identity list says "whether it is currently connected", and nothing carried it
**Severity: low, closed by the same decision as F-51, and the kind of row only a code-aware read finds.**
`docs/INTERFACES_AND_API.md` §3.1 says `crabby auth list` shows "name, interface, created, last used, granted
capabilities, and whether it is currently connected", and §4.5's `GET /auth/clients` row repeats the list verbatim. The
route returned `listIdentities` — id, name, interface, capabilities, created, last used — so the sixth promise had no
field; `ClientRecord`, which `additionalProperties: false` makes a closed shape and which `tests/integration/gateway.test.ts`
validates every row against, had no room for one; and `apps/cli/commands/auth.ts` printed `name · interface · paired ·
caps`, silently one column short. A reader comparing the CLI's output with §3.1 would conclude the *document* had added a
field out of kindness, which is the failure mode F-08, F-10 and F-11 were about, in a table nobody re-read.

It could not have been fixed before M2j, and that is the useful part of the record: "currently connected" is a fact about a
live stream belonging to an identity, and until D-096 bound the two together the question had no referent — the bus could
count subscribers and nothing more. Fixed by one field, `ClientRecord.liveStreams`, computed by the route from
`bus.countFor` — the same registry the revocation closes streams through, so the list and the control cannot disagree about
who is watching — and rendered by the CLI as `connected, 2 live streams` or `idle`. Deliberately **one** field and not a
boolean plus a count: `connected` derived from `liveStreams > 0` in two interfaces would be two definitions of the word,
and the second consumer this row had been waiting for (`docs/review/TUI.md` T14-03, "prints how many streams it will kill
first") needs the number anyway. `GET /status`'s `streams.subscribers` stays a process-wide count, because it answers "is
this Gateway being watched at all" for `crabby status`, and collapsing the two questions into one field would lose whichever
one the reader did not intend.

### F-52 — `auth.manage` is cited by three routes and enforceable by none, and identity capabilities have no writer
**Severity: high, open, and found by trying to write the check the documents name.** `docs/INTERFACES_AND_API.md` §4.5
attaches `auth.manage` (`SECURITY.md` §6.1, "local-only by construction") to `POST /auth/pair-codes`; §3.1 says "managing
identities requires `auth.manage` … minting or revoking identities from a network-facing interface would let a stolen
remote token create a second one"; and the §3.1 row for `GET /auth/clients` promises a list that includes *granted
capabilities*. The Gateway checks none of it: the mint route is guarded by `requireLoopback` plus a token, and listing and
revoking were guarded by a token alone — so before M2j, a token stolen off any reachable path could enumerate every
identity on the device and delete the one the owner would use to recover.

The capability cannot simply be checked, and that is the half worth writing down. The plumbing is half-built and the
decision is missing: `client_identity.capability_json` exists, `createIdentity` and `mintPairingCode` both accept a
`capabilities` list, and **no caller in the build ever passes one** — the mint route's body is `{name, interface}` and
nothing more, `crabby auth pair` has no flag that supplies grants, and the `[--restrict caps]` §3.1's usage line advertises
is in no registry, so every identity this Gateway pairs is created with `capabilities: []`. There is no "restrict" to
read, only a column to write. Meanwhile
`packages/policy` asks each `PolicySubject` for `grants` and `removedGrants` — the restricted-client concept D-060 protects
— so the durable fact and the runtime question have never been joined. A check for `auth.manage` written today would
therefore refuse *everyone*, the owner's own CLI included: a gate that locks the owner out of the device is not a security
improvement, it is an outage with better optics.

What M2j did, in D-097, is enforce the property with the one mechanism that exists: `GET /auth/clients` and
`DELETE /auth/clients/{id}` now require a loopback request, the same guard §4.5's mint row already uses, measured on the
socket because `trustProxy: false` means a forwarded header cannot move it. That implements "local only" without inventing
a grant model, and it is deliberately fail-closed about the address itself: the guard accepts the bound loopback addresses
and not the whole `127/8` range. What remains open is the real control, and its closing condition is named rather than
implied: a pairing-time grant decision — what `--restrict` means, who may set it, and how `capability_json` becomes
`PolicySubject.grants` — which is the same unanswered question `POST /admin/*` waits on, so it should be answered once, in
whichever slice takes it. Until then §4.5's `auth.manage` sentences are a rule the documents state and the build can only
approximate, and this row is where a reader learns that.

**M2n widened this row instead of closing any of it.** `POST /api/v1/tasks/{id}/cancel` now exists, and §6.1's `task.cancel` is the capability that decides who may stop a task — enforced by nothing beyond the token the guard already demanded, for exactly the reason above: every paired identity holds `capabilities: []`, so a real check would refuse the owner's own CLI. That makes `task.cancel` a second capability routes cite and no code can enforce, and it makes the missing writer load-bearing for a second reason. The task *handoff* — `POST /tasks` passing a created task to the runner that now exists — is deliberately not written, and this row is why: `LoopSubject.grants` would come from `Identity.capabilities`, so a run started from a route would hold no grants and `packages/policy` would refuse every tool it proposed. A Gateway that started runs which could do nothing would be worse than one that says plainly it starts none, so the honest state is recorded here: the runner exists and nothing composes it, the cancellation half of §6 is wired because stopping work needs no grants, and the pairing-time grant decision now blocks three things — `POST /admin/*`, the handoff, and `crabby task run` — rather than one.

**This slice answers two of F-52's three questions and locates the third precisely.** The decision, recorded as D-102:
an identity's baseline is `SECURITY.md` §6.1's vocabulary for the interface it was paired for, less the two §9 shell
capabilities no fresh install holds (`shell.run`, `shell.privileged`), less the two §6.1 marks local-only that
`telegram` does not hold (`auth.manage`, `tunnel.enable`) — so a remote client never receives a wider set than a local
one (§5.3). D-032 ("interface type may narrow only what the user configures, never what the core allows") is not
contradicted by that withholding, and the reason is worth stating because it is the first objection a reviewer will
raise: §6.1's table *is* the core's allowance, and its `auth.manage` row reads "Local-only by construction: no remote
or agent-facing path may grant it". `restrict` then narrows the baseline and nothing else. It is an intersection, so
`--restrict shell.run` is refused with the rule named instead of enabling the shell — D-054, which says a restriction
removes capabilities and never converts one into an approval the same restricted client must answer; an unknown name is
refused with the vocabulary named; an empty list is refused, because a restriction naming nothing is not a restriction
and an identity holding nothing can only fail. The mint route refuses the *whole* request when anything is refused
(§2's rule 03) and its answer carries the granted set, so a caller can see that a narrowing took effect without a
second read.

Four sentences above are therefore no longer true of this build, and are corrected here rather than deleted, because
the row is a record of what was found and when. There *is* now a caller that passes `capabilities`: the mint route, and
the bootstrap identity `crabby gateway start` pairs first. `crabby auth pair` *does* have a flag that supplies a
restriction, and §3.1's `[--restrict caps]` is in the registry rather than in no registry. A freshly paired identity
does *not* hold `capabilities: []` — it holds the baseline above, which `crabby auth list` prints and §3.1's row
promised. And the capability refusal a caller gets names §6.1 instead of pointing at `--help`, which never held the
vocabulary. What is *unchanged* is the enforcement, for a reason about this build rather than about the rule: D-097's
socket guard still decides `POST /auth/pair-codes`, `GET /auth/clients` and `DELETE /auth/clients/{id}`, because no
migration gives capabilities to an identity paired before assignment existed — replacing the guard would lock such an
owner out of their own recovery path, exactly the outage D-097 named — and because no route has a `PolicySubject` to
ask. In v1 the two conditions agree, since §13 admits no tunnel and a caller off the loopback socket cannot be holding
a local interface's baseline.

The third question — how `capability_json` becomes `PolicySubject.grants` — is now a located absence rather than an
open one. `packages/policy` has the function that would do it: `grantsFor(capabilities, { roots })` expands
`scope: "none"` to the bare name, `scope: "root"` to one `name:root` grant per configured workspace root, and withholds
*with a reason* rather than silently a root-scoped grant when no root is configured and every `net.egress` host-set
grant in any build, because nothing in `config.json` supplies a host set. It is tested and it has no
caller for a run, because nothing composes a runner into `POST /api/v1/tasks` — `docs/ROADMAP.md` §4's "still absent:
the handoff" sentence. That handoff is the slice that joins the durable fact to the runtime question, and until it
lands `auth.manage` and `task.cancel` stay cited by routes that decide on something else, which is what this row has
said since M2j and what it will keep saying until it can stop.

**The handoff landed, and with it the answer to the third question.** `POST /api/v1/tasks` reads the identity that asked
before it writes anything, calls `grantsFor(client.capabilities, { roots })` with the roots the composition root was
given, logs every withheld grant with the reason `packages/policy` produced rather than dropping it, and hands
`runner.start` a subject of `{ grants, removedGrants, clientKind: client.interface }`. So `capability_json` becomes
`PolicySubject.grants` at the route, once per task, from the durable fact D-102 started writing at pairing — and
`tests/integration/tasks.test.ts` asserts the join end to end over HTTP: a run that completes and really writes a file,
and a narrowed identity whose refused write is reported §13's way.

The second half of the subject is the finding this slice made rather than read. `PolicySubject.removedGrants` had no
writer either, and without it `§13`'s own sentence is unreachable from a Gateway-composed run: an unheld capability
answers `deny` — "needs `fs.write`, which this identity does not hold" — which reads as something the user could go and
grant, when for a restricted client it is a feature that is not available and must not be laundered into an approval it
cannot answer. `removedGrantsFor(capabilities, interface)` is the missing writer: the interface's baseline minus what the
identity holds, so an unrestricted pairing has nothing in it and §9's withheld shell and §6.1's local-only marks are
*not* reported as somebody's narrowing. Only the integration test could have caught this; reading the two packages
showed two correct halves and no seam between them.

What this row still says, and now more precisely. `auth.manage` and `task.cancel` remain enforced by D-097's socket
guard rather than by a grant, but the reason has lost one of its two legs: a route *does* now have a `PolicySubject` to
ask. What is left is the migration — no code gives capabilities to an identity paired before assignment existed, and
such an identity holds `[]`, so a grant test on `POST /auth/pair-codes` or on `POST /api/v1/tasks` would refuse the
owner's own CLI and lock them out of the recovery path, which is the outage D-097 named. `POST /api/v1/tasks` therefore
records a task from any paired identity and enforces nothing at the door; the enforcement it does perform is per tool
call, inside the run, where the subject exists. That is the closing condition, stated once: a migration that gives every
existing identity its interface's baseline, after which the socket guard can be replaced by the grant test the documents
have described since §3.1.


**One more sentence in §13 was untypeable, and it took the handoff to notice.** The narrowing bullet reads
`crabby auth pair --restrict shell,config`, and both of those names are families rather than vocabulary entries, so the
mint route refused the document's own example as two unknown words. Worse, the refusal it gave was the *typo* refusal,
which sends an operator to check a spelling they got right. `restrictCapabilities` now reads a dot-less token as the
family it names and expands it to the members the baseline holds, and the two refusals are separate sentences: a token
that is neither a name nor a family is a typo, and a family no baseline holds is a rule — `shell`, which §9 keeps out of
every baseline, so `--restrict shell` cannot be honoured on any install and says so with its members listed. Expansion
cannot widen anything, because what it adds is still intersected, so D-054 and §5.3 are untouched by it; and the example
in §13 is now `--restrict task,session`, which mints an identity that can read and drive tasks and sessions and nothing
else. The finding is recorded here rather than as a new row because it is F-52's subject — what a restriction means and
who may set it — and this row is where a reader looks for that answer.

**Amendment (thirtieth slice): `task.cancel` now has a path where the capability *is* the control.** §4.2's three task
rows are executed inside a run (`packages/tools/task.ts`, D-105), and a run is the one place this build has a
`PolicySubject`, so a `task.cancel` tool call is gated by the `task.cancel` grant the identity holds and refused §13's way
when it does not hold one. That is the enforcement this row has described since §3.1, and until now it had only ever
applied to file and scheduler tools. The route half is unchanged and stays exactly as this row says it:
`POST /api/v1/tasks/{id}/cancel` decides on the token the guard demanded, because it has no subject to ask and D-097's
migration is still what stands between that and a grant test. What changed is the *shape* of the gap, and the new shape is
the one a reader can act on: the same act is gated on one path and not on the other, so an identity minted with
`--restrict task` cannot stop a task from inside a run and can still stop one over HTTP with its token. That is worse than
a uniform gap in one specific way — it makes the capability real enough to be relied on and partial enough to be wrong
about — and it is the reason the closing condition below is now sharper rather than softer: one migration, and both paths
decide on the same fact.

**Amendment (thirty-second slice): `config.json` supplies a host set, so the withheld-grant half of this row is closed.**
The sentence above said `grantsFor` withholds "every `net.egress` host-set grant in any build, because nothing in
`config.json` supplies a host set". `net.allowList` is now that something (D-106): `egressHosts` normalizes it once, the
composition root hands it to `EvalContext.egressAllowList` — a field that existed before any caller filled it — and
`grantsFor` mints `net.egress:allow-list` for every identity whose baseline holds the name, whether the list is empty or
not. The grant names the *set* rather than its members, and the reason is this row's own subject: a per-host expansion
would have denied every host nobody curated, so §4.3's "T2 with the host named in the prompt" would have been reachable
from a document and not from an install. The third question's other half is unchanged and stays open exactly as the
paragraph above says it: `POST /api/v1/tasks/{id}/cancel` still decides on the token the guard demanded rather than on a
grant, and one migration (D-097's) is what stands between that and a grant test.

**Amendment (thirty-third slice): the same act is now gated on one path and not on the other, on the file that decides
permissions.** §4.2's two configuration rows are executed (`packages/tools/config.ts`, D-107) and §4.4's three `/config`
paths are built, so `config.write` has both halves at once and they do not decide on the same fact. Inside a run the
capability *is* the control: a run has a `PolicySubject`, so a `config.set` call is gated by the grant the identity holds
and priced at **T3**, which the arbiter turns into a prompt and D-085 confines to the TUI and the Web control UI — on this
build the request parks and expires, which is asserted rather than assumed (`tests/integration/config.test.ts` drives a
real run into that park and then has the CLI refused with the arbiter's own `surface-not-allowed`). Over HTTP the route
decides on §2's token and never asks the arbiter, for the reason the thirtieth-slice amendment gives: a route has an
identity and no subject, and D-097's migration is still what stands between. So an identity minted with
`--restrict config` cannot change configuration from inside a run and can still change it with `PUT /api/v1/config` and
its token — the asymmetry this row named for `task.cancel`, now on the document that decides workspace roots, retention
and the egress allow-list. Two things keep it from being worse than that sentence sounds. The write is not unguarded: it
requires the token the read answered, so a client that has not read the document cannot write it, and a stale one is told
so with both tokens named. And the user's own interface writing the user's own configuration is the act §4.2's **T3**
exists to gate rather than a caller of it — D-084's rule is that only the loop opens an approval, so a settings screen
that had to approve itself would be a prompt with nobody to answer it. What the closing condition below now buys is
therefore specific: one migration, and `PUT /api/v1/config` can refuse an identity that does not hold `config.write`
instead of refusing only a document that moved.

### F-54 — §4.4's first check is a *type* check, and a schema that arrives as data cannot be type-checked

**Severity: low, open, and named in the code that skips it.** `PROVIDERS_AND_TOOLS.md` §4.4 fixes the order of checks —
"schema validation → capability check → tier/approval → execution" — and §4.1 says `inputSchema` is "validated before
policy evaluation". M2k had to make that check runnable, because `packages/tools` publishes an `inputSchema` per tool and
the loop validates arguments before it asks policy anything. What it found is that the sentence hides two spellings: in
this repository a schema is a **typebox** object where it is checked and a **JSON Schema** where it is published (a
provider's tool list, `GET /tools`, an MCP server's `describe`). `validateToolArguments` in `packages/api-contracts` is the
one place the two are reconciled, so the cast lives beside a reason instead of at every call site that needs one.

The gap is the second spelling. A schema that arrived as *data* carries no typebox `Kind` symbol, and typebox's visitor
throws "Unknown type" on it instead of answering, so the type half of step 1 is **skipped** rather than crashed. Skipping
is recorded, not designed: the argument *names* are still compared against the declaration before policy is asked
(`ToolCall.declaredArgs`, §4.3's "arguments it did not declare → reject before policy"), so a discovered tool cannot be
called with invented parameters, and what it loses is only the types, ranges and required-ness of the ones it was given.
Every schema this repository authors is typebox, so today the skip fires for a discovered MCP tool and for nothing else —
and there is no MCP client in the build, which is why this is `low` rather than `medium`: the affected party does not exist
yet, and the row exists so that when it does, the skip is a known debt with a closing condition rather than a validator
that quietly passed.

**Closing condition:** a JSON Schema validator in the tree (or a compile-at-registration step that turns a discovered
JSON Schema into a typebox one and refuses the tool when it cannot), so §4.4's step 1 means the same thing for a native
tool and a discovered one. Until then `validateToolArguments`'s comment is where a reader learns which half ran.

### F-55 — `GET /tools` reports five fields as pending, and the party that could answer them now exists

**Severity: low, open by composition rather than by judgement.** §4.1 describes a tool by ten fields; four come from §4.2's
registry (`capability`, base tier, tier rules, `availability`) and five are properties of the runtime that executes it —
`inputSchema`, `outputSchema`, `limits`, `idempotent`, `sideEffects`. `packages/policy/availability.ts` lists those five in
`PENDING_RECORD_FIELDS` and `GET /tools` prints the list, because naming a gap in a response is cheaper than inventing a
default: `sideEffects: "none"` for `file.delete` would be a lie a recovery path could act on.

M2k removed the reason the fields were unanswerable and left the reason they are unreported. `packages/tools` declares all
five for the eight rows it implements (D-098), and `ToolDeclaration` in `packages/api-contracts` is the shape they arrive
in precisely so a registry row and an executor's declaration can be merged without either inventing the other's half. What
is missing is a party to merge them: the Gateway composes no executor, so no route holds a declaration to publish, and the
honest response is still the pending list. A runner — the slice that makes `crabby task run` real — composes
`createFileTools` and passes its `declares` to the loop; the same value answers `GET /tools`, and F-46's closed half shows
what the merge buys: §6.2's evidence and D-065's first permission both read the declaration rather than a constant.

**Closing condition:** the Gateway runner composes an executor, `GET /tools` reports a merged record for the rows an
executor implements and keeps naming the rest as absent, and `PENDING_RECORD_FIELDS` shrinks to the rows nothing implements
— which is a smaller list than the one printed today and a truer one. Note the deliberate asymmetry: an *unimplemented*
tool stays out of the response entirely rather than appearing with empty fields, because §4.2's inventory is a document of
what the product will do and `GET /tools` is a statement of what this process can do, and F-20 is the finding about
confusing two copies of one list.

**Amendment (sixteenth slice): the party to merge them exists, and the finding narrows rather than closes.**
`crabby gateway start` composes `createFileTools` from `config.json`'s `workspace.roots` and hands its `declares` to
`buildApp`, so `GET /tools` now answers §4.1's runtime fields for the rows an executor implements and prints
`runtime: {implemented: 7, described: 0, pending: 38}` beside them. Two of the three things the closing condition asked for
happened; the third did not, and the difference is worth stating rather than rounding:

1. **`PENDING_RECORD_FIELDS` did not shrink — each row's own list did.** The constant still names all five fields, because
   it is the list of fields the *runtime* owns and that ownership has not changed. What changed is that
   `toolRecord(spec, facts, source, declares?)` filters it per row, so the seven rows the file executor declares now name
   `["outputSchema"]` alone and the other thirty-eight still name all five. A row's list is now a fact about that row
   instead of a fact about the registry, which is the truth the condition was reaching for, arrived at from the other side.
2. **`described` is 0 and stays 0.** No declaration in `packages/tools` carries an `outputSchema`, so no row is fully
   described even though seven are partly answered. That is why the route reports two counts: `implemented` says an executor
   declares the row, `described` says nothing about it is left unanswered, and a client that read the first as the second
   would render an empty output schema as a check that always passes.
3. **Eight declarations answer seven rows.** `createFileTools` declares `file.stat`, which has no row in §4.2's table, so
   one declaration matches nothing and is not counted. That is the merge behaving correctly — it is keyed on the registry's
   id and cannot invent a policy row for a tool policy never classified — but it is also a second copy of one list drifting,
   which is F-20's shape, and the honest place to record the drift is here rather than in a count that hides it.
4. **No configured workspace means no executor, by decision.** `WorkspaceConfig`'s own rule is that a root invented by a
   default "would be a path the agent may write to that the user never chose", so an install that has chosen no workspace
   composes nothing and every row keeps naming all five. The Gateway says so on the screen that started it, and `GET /tools`
   says it as `implemented: 0`.

Still open, therefore: `outputSchema` is answered by nothing, `file.stat` is declared but unclassified, and the thirty-eight
rows no executor implements are as silent as they were. The remaining work is not a merge but an executor for them.

**Amendment (twenty-eighth slice): an eighth row is implemented, and it is the scheduler's.** `crabby gateway start` now
composes a second surface beside the file executor — `createSchedulerTools`, which declares `cron.schedule` and nothing
else — and hands `combineToolSurfaces`'s merged `declares` to `buildApp`, so a Gateway that composes a runner answers
`runtime: {implemented: 8, described: 0, pending: 37}` where the amendment above answers 7 and 38. Three properties of
that count are decisions rather than arithmetic, and each is the kind of thing a later slice would otherwise rediscover
by reading a number and believing it:

1. **The eighth row is declared only where a job can fire.** The combined surface is composed exactly when `drive` is —
   an executor and a selected model, which is what makes a runner — and a Gateway with no runner keeps the file executor
   alone and answers `implemented: 7`. §5.1's "hidden is better than failing" is about permissions, but it applies to a
   subsystem for the same reason: a row advertising a timer nothing would ever fire is a promise the process cannot keep,
   and `cron.schedule` called on such a Gateway would write a job whose next fire is a lie.
2. **`described` stays 0, and the new row is why the count is still honest rather than merely unchanged.** The declaration
   carries `inputSchema`, `limits` (D-074's `sqliteBusyTimeoutMs`, because §5.2 prices no `cron.*` class and the tool's
   whole cost is two statements against the job table), `idempotent: false` — calling it twice creates two jobs that both
   fire — and `sideEffects: "local"`, and no `outputSchema`. So `cron.schedule` joins the rows naming `["outputSchema"]`
   alone, and the eighth implementation raises `implemented` without touching `described`, which is the difference the two
   counts exist to keep visible.
3. **A duplicate name is fatal at composition rather than last-one-wins.** `combineToolSurfaces` builds its owner map from
   `specs()`, throws on a second declaration of one name, and runs `assertRegistrable` over the merge — §4.1's
   registration rule applied to a *composition* of surfaces instead of to one, which is the point where two executors would
   otherwise begin silently shadowing each other and a `run` would reach whichever was registered last.
4. **Nine declarations now answer eight rows, and item 3's drift is unchanged rather than fixed.** `file.stat` still has
   no row in §4.2's table, so the gap between what executors declare and what policy classifies is one row wide exactly
   where the sixteenth slice measured it. The count moved and the drift did not, which is worth saying because a reader
   who saw `implemented` go 7 → 8 and declarations go 8 → 9 could otherwise conclude the two numbers had been reconciled.
   Nothing in this build classifies `file.stat`, and F-20's shape is still open.

**Amendment (twenty-ninth slice): ten rows are implemented, and the two new ones are conversations.** The same
composition gained a third surface — `createSessionTools`, declaring `session.list` and `session.rename`, the two rows
§4.2 prices at T0 and T1 — so a Gateway that composes a runner now answers `runtime: {implemented: 10, described: 0,
pending: 35}` and a Gateway that composes none still answers 7, with `cron.schedule` and both session rows carrying all
five pending fields rather than four. Three things about that are worth recording beside the number:

1. **The two new rows are implemented where the scheduler's is, and for a different reason.** `cron.schedule` is composed
   only beside a runner because a timer nothing would fire is a promise the process cannot keep. `session.list` and
   `session.rename` would work perfectly well without one — a conversation is a record and not a privilege, and
   `GET /sessions` answers on a Gateway that drives nothing — but they are declared through the same combined surface,
   because §4.1 registers a tool by name across the composition a *runner* is given and a second surface for a Gateway
   with no runner would be a second place to look. The routes are where the no-runner case is answered honestly, and the
   integration test asserts both counts rather than one.
2. **`described` is still 0 and now has three rows keeping it there.** Neither session declaration carries an
   `outputSchema`, so both join the rows naming `["outputSchema"]` alone: ten implemented, none described, thirty-five
   pending, and the two counts still mean different things.
3. **Eleven declarations answer ten rows.** The drift item 4 records did not move: `file.stat` is still declared and still
   unclassified, and a count that rose on both sides would have hidden it.

**Amendment (thirtieth slice): thirteen rows are implemented, and the three new ones act on work rather than on files.**
The same composition gained a fourth surface — `createTaskTools`, declaring `task.create`, `task.status` and `task.cancel`,
the rows §4.2 prices at T1, T0 and T1 — so a Gateway that composes a runner now answers
`runtime: {implemented: 13, described: 0, pending: 32}`, and a Gateway that composes none still answers 7 with all three
rows carrying their five pending fields. Three things belong beside the number:

1. **The count is asserted in two integration files, and they agree because both harnesses now compose four surfaces.**
   `tests/integration/jobs.test.ts` said it mirrored `crabby gateway start` while composing three of the four; this slice
   made the sentence true rather than narrowing it, so 13 is one fact asserted twice instead of two fixtures with two
   numbers — and the job routes are proved unaffected by a surface they do not use, which is the only way "unaffected" is
   worth writing down.
2. **`described` is still 0, with three more rows keeping it there.** None of the three declarations carries an
   `outputSchema`, for the reason §4.1 gives and the other executors' tests repeat: an empty one would pretend to validate
   an answer these tools render as prose for a model to read.
3. **Fourteen declarations answer thirteen rows.** The drift item 4 records is still exactly one row wide: `file.stat` is
   declared and still unclassified, and both counts rose by three, which is what keeps the drift visible rather than
   absorbed.

### F-56 — §3.7 gives an adapter a vault handle, and nothing in the build resolves one

**Severity: medium, open, and the same shape as F-52.** §3.7 is specific: provider credentials "are supplied once, stored
in the vault, and referenced by name in configuration — `provider.groq.key = vault://groq`", and "adapters receive a
handle that yields the value at call time; the agent never reads it, and it never enters model context". `SECURITY.md` §7
and D-031 say the same thing from the secrets side, and `docs/DATA_AND_MEMORY.md` §4.1 lists `vault/` at mode `0700` as
part of the state directory's whole footprint.

What exists is the directory and three honest reports about it. `packages/platform/paths.ts` names `vault/`;
`crabby doctor` checks that it exists and that its mode is `0700`, and says plainly when it does not exist yet;
`GET /health` reports `vault: { managed: false }` rather than `locked: false`, because a lock nobody implements is a
protection nobody has. What does not exist is any code that stores a secret, resolves a `vault://` reference, or hands an
adapter a handle — so `ProviderConfig.apiKey` is a plain string, and M2l's adapter holds one for the lifetime of the
process (D-100 records that as what the build does instead, rather than letting a reader assume §3.7 is implemented). The third report is the one a
user meets first, and M2m added it: `packages/providers/compose.ts` **refuses** a `provider.<id>.key` reference at
composition, naming this finding and the milestone that closes it, so a keyed endpoint is answered with "the vault
arrives in M5" instead of being composed with a dropped credential and failing as a `401` from the endpoint (D-101). The
schema refuses the other shape — an inline key never validates, because §3.3's rule cannot be enforced after a
mode-`0644` file exists and `crabby config get` prints what is in it.

Not fixed in that slice because the honest fix is a subsystem, not a signature: an encrypted or at-rest-protected store
whose keys survive a process restart, a `vault://` resolver with a rule for a missing or locked vault, `crabby provider
add` writing a reference instead of a value, and a decision about what unlocks it on a device with no keyring — which is
O-065's question ("what a phone's sandbox can actually enforce") and cannot be answered from a laptop. Inventing a
plaintext file with a `vault://` prefix in front of it would have made the sentence true in a grep and false in every way
that matters.

**Closing condition:** a vault that stores, resolves and refuses; `ProviderConfig` taking a reference rather than a value;
and a test that a key never appears in an event payload, a log line or a prompt — which is the property §3.7 and
`SECURITY.md` §14 are actually about. Until then two duties sit with whoever composes an adapter and are stated in
`PROVIDERS_AND_TOOLS.md` §3.7 rather than left to a reader: the key must not reach a log line (`packages/core/redact.ts`
is defence in depth, not the control) and must not enter model context.

### F-57 — §4.3's `POST /tasks` row documents four body fields and the contract accepts two

**Severity: low, closed by the thirty-ninth slice — the contract gained the pin and §4.3 now marks the other two fields
not-built, so the row and the route agree.** `docs/INTERFACES_AND_API.md`
§4.3 spells the body out: "Create a task. Body: objective, optional session, **model pin, capability narrowing,
schedule**. Idempotency key required." `packages/api-contracts/task.ts` answers `CreateTaskBody = { objective,
sessionId? }` with `additionalProperties: false`, so a client that sends the documented model pin is refused with a
named-field problem. That is the right behaviour for a field this build does not have and the wrong description of a
route that does, and the two have sat side by side since M1c.

Two of the three missing fields belong to other milestones: capability narrowing is `SECURITY.md` §13's removal, and
since D-102 the *per-pairing* half of it is assigned — `--restrict` narrows an identity's baseline at the mint, and
F-52's amendment records it — while the *per-task* half this row is about is still absent, because no field in
`CreateTaskBody` can carry it and nothing builds a `PolicySubject` for a run; and `schedule` is the scheduler's, which
`docs/ROADMAP.md` §4 lists and nothing has built. (Both halves of that last clause have since moved: D-102 gives a run a
`PolicySubject`, and the twenty-eighth slice built the scheduler — see the amendment below, which is also where the
`schedule` field's absence stops being an unbuilt milestone and becomes a decision.) The model pin is the one D-101 sharpened, because
§3.6's sentence has two halves — "The user selects a default model **and may pin a model per task** or per interface
session; per-task pinning wins" — and M2m implemented the first. So there is now a default with nothing able to override
it, `TaskRecord` has no `model` column, and a pin would need schema version 6 — M2x spent 5 on §4.5's `job` and `job_run`
tables — plus an answer about whether a pinned model
survives a restart (D-065's checkpoint already carries `modelId`, which is the same fact recorded from the other side).

**Closing condition:** the row loses the fields this build refuses, or the contract gains them — and for the model pin the
second is the honest one, because a runner needs a `modelId` and §3.6 says where it comes from. Until then a runner takes
the model from composition rather than from the task, and says so.

**Amendment (twenty-eighth slice): `schedule` has a scheduler behind it, and the field stays out of `POST /tasks` on
purpose.** The subsystem this row named as unbuilt now exists — `packages/agent-runtime/scheduler.ts` over schema version
5's `job` and `job_run` tables, with `GET /jobs` and the pause verb shipped alongside it as `docs/ROADMAP.md` §4 required —
and a schedule can be created today, through `cron.schedule`. That is a T2 tool call, so the expression, the name and the
objective a job will run are shown to the user and approved before the row is written (D-046). What `POST /tasks`'s
`schedule` field would be is a *second* creation path with no approval anywhere in it: a route cannot open an approval,
because only the loop does that and only from `policy.evaluate`'s verdict (D-084), so a body field would either write a
job nobody reviewed or refuse after accepting the request. The same reasoning is why C12-09 refuses `crabby job create`
and why W16-12's "teach `crabby task run --schedule`" is deferred with this field rather than built beside it. The row in
§4.3 therefore keeps documenting a field this build refuses, and the honest closing condition for that one is not "add the
field" but "give the route a way to open the T2 approval the field implies" — which is the same condition `job edit`
(C12-05) waits on. The other two fields are unchanged: capability narrowing per task still has no carrier, and the model
pin still needs a `modelId` column and version 6.

**Amendment (thirtieth slice): the pin's schema version moved, because version 6 was spent on conversations.** The two
sentences above say a model pin "would need schema version 6" and that M2x spent 5 on §4.5's `job` and `job_run` tables.
M2y then spent 6 on the `session` table and its backfill (D-104), so the pin needs version **7** — and the reason the
number went stale is F-40's shape inside this file rather than inside a screen: a version printed in prose, away from the
migration list that produces it. Nothing else here moved. Capability narrowing per task still has no carrier in
`CreateTaskBody`, `schedule` stays out of `POST /tasks` by the decision the previous amendment records, and the honest
closing condition for the pin is still the contract gaining the field rather than the row losing it — §3.6 says a user
"may pin a model per task", and a runner that can only take its model from composition is the half of that sentence this
build answers.

**Amendment (the thirty-ninth slice): the model pin is built, scoped, and the contract and the route now agree.** D-108
settled the fork the earlier sentences left open. `CreateTaskBody` and `TaskRecord` gain an optional `model`, schema
version 7 adds `task.model` (nullable, mirroring `session.model`), and a pin is a `<provider>/<modelId>` pair resolved
against the one provider the runner holds: `selectPinnedModel` validates it at `POST /tasks` and refuses a pin that names
another provider *before* a row is written (400 `invalid_model_pin`, citing `docs/INTERFACES_AND_API.md` §4.3, which now
records the limitation beside the field), and `StartInput.modelId` carries the resolved model half into `loop.start` with
`RunnerDeps.modelId` as the fallback a pinless task keeps. §4.3's row now states the pin as accepted and names capability
narrowing and `schedule` as not-built, so the document and the contract describe the same body — which was this finding's
whole complaint. What remains of F-57 is named rather than closed by omission: cross-provider pinning (the loop holding
every composed provider so a pin may name any of them) is option B and stays deferred under D-108, and per-task
capability narrowing still has no carrier in `CreateTaskBody`.

**Amendment (the thirty-eighth slice): option B has landed, and the pin resolves against every composed provider.** The owner
chose to start it, and D-110 records the mechanism as D-101 read literally rather than this finding's earlier sketch: the
composition root holds the pool (`deps.providers`' usable entries, with the runner's own provider unioned in) and the
caller resolves the pin against it at the same gate that resolved the model, so `DriveTaskInput.pin`,
`StartInput.provider` and `RunInput.provider` carry the answer down and the loop — which still holds one composed
default — runs what it is handed without ever choosing. A pin naming any composed provider is served and its run calls
that provider; a pin no entry answers is refused 400 with the pool's ids before a row exists. What remains of F-57 is
exactly what the thirty-ninth slice named minus the pin: per-task capability narrowing still has no carrier in
`CreateTaskBody`.

### F-62 — §3.8's override table lists a field the runtime derives rather than stores

**Severity: low, and closed by D-126 in the same change — recorded because the gap was real, not because it still
is.** `PROVIDERS_AND_TOOLS.md` §3.8 listed `limits.reserveForOutput` as a user-settable field of a per-model override,
while `packages/agent-runtime/context.ts` (D-064) computes the output reserve as `descriptor.maxOutputTokens`. Two
sources for one number, one of them user-writable, is a number that will eventually disagree — and the disagreement
would surface as a context window that compacts earlier than the screen says it will, which is the class of bug
`docs/UI_UX_SPEC.md` §4's rule about showing a number you cannot back is written for.

Storing it was also the reading that would have been implemented by copying the table. The builder instead refuses the
key and says why: `reserveForOutput` is derived, raise `maxOutputTokens` instead, and budgeting reads that. A field that
is accepted, stored, and read by nothing is worse than a field that is refused with a sentence.

**Closing condition, met:** §3.8's table now states the derivation, `packages/providers/override.ts` refuses the key with
that reason, and D-126 records both. What stays open is the neighbouring question §3.8 also implies — whether a future
model with a *variable* output ceiling needs the reserve as its own field — and that belongs to whoever builds such a
model rather than to a document written before one existed.

### F-61 — C5-01 says a chat has "no task", and every run in this build is one

**Severity: low in behaviour, high in wording, and left open for the owner rather than resolved by an agent.** The
element row says: "chat: one-shot question — `crabby chat "…"` — plain question, **no task, no plan**; the answer
streams to stdout". Three of those four clauses build and one cannot, because the runtime has no path that is not a
task: §9's one-writer rule, the approval arbiter (D-084) and the checkpoint (D-095) all hang off one task row, and the
alternative reading — a route that appended a conversation turn without a task — is precisely the second writer D-112
forbids, which is also why `POST /sessions/{id}/messages` stays unbuilt. A chat here creates a task, follows it, and
keeps it out of the user's view: the answer streams, no event vocabulary prints, and the conversation id is printed
when the run opened one (C11-06's rule, and the reason a script cannot append to a conversation it never opened).

**Why this is a finding and not a note.** "No task" was written by a reviewer describing a surface, not about a
runtime, and the difference matters in exactly one place: what a caller may assume about the record behind the answer.
C11-06 says "a fresh conversation each time, with its id printed on the last line", so the record is reachable — but a
client that reads the row and concludes "chat answers without a task record" would be wrong about where the
conversation came from, and a document that says so is better than a surface that implies it. D-123 therefore states
the reading this slice implements (the clause is about the *output*) and names the other one (the clause is about the
*record*), with what the other would cost: a second writer of conversation history, and a decision about §9 this
repository does not get to make quietly.

**Closing condition:** the owner says which reading the row meant. If the output reading stands, this finding closes
with D-123 and the row's wording stays as a reviewer's shorthand. If the record reading is meant, it is a schema and
architecture change — a turn that belongs to a conversation and no task — and it belongs in its own slice with its own
decision row, not inside a CLI verb.

### F-60 — The forty-sixth slice built the context verbs under the wrong noun, and a row's empties clause went unread

**Severity: low, closed by the forty-seventh slice one commit after it was opened, and kept because the shape of it is
the lesson: an element inventory is a specification, and building a feature from the architecture instead of from the
inventory produces working code in the wrong place.** `docs/review/CLI.md` region C10 says `crabby context show
<session>` and `crabby context pin <session> [ref]`, and the forty-sixth slice shipped `crabby session context`,
`crabby session pin` and `crabby session unpin` instead — three verbs that answer the same questions and are spelled
the way the slice that wrote them happened to think of them. Nothing failed: the routes were the routes, the parity
check counted commands rather than names, and `scripts/parity.ts` compares §8's matrix against the registry, which
agreed with itself. What the slice *also* could not do, because the route it built did not answer it, is C10-01's
"each section with its cost" — and the clause that matters most in that row is the one about **empties**: "a section
costing 0 prints `0` rather than being hidden". A view that hides an empty section does not look empty; it looks like
"there is nothing pinned", which is a different and wrong claim, and it is the kind of small lie a screen tells while
being perfectly reasonable.

The lesson is about *where the specification lives*. §4.2, §6.1 and the transition table were all read while building,
because they are the documents a runtime is argued from; the element inventories were read afterwards, to check the
names. C10 is a case where the inventory carried the requirement the architecture did not: no document says "print
each section's cost", and §8.1 says only that a user should be able to review what was compacted. So the fix in D-120 is
the verb move (the noun C10 names, and the session-level verbs removed rather than aliased — §9's one-path rule is about
behaviour and an alias is a second path nobody asked for), the per-section costs with **characters** beside tokens
(C10-05's "byte counts … so a cron wrapper can stop filling a session it cannot see", and a heuristic's token count is
not a byte count), and `session compact`'s promise printed in every outcome because C10-03's clause is about what the
output *must not* imply.

**Closing condition:** the `context` noun carries the rows' two verbs, `GET /sessions/{id}/context` answers a cost per
section with the empties still printable, and the three sections are a partition of the conversation so a client can
add them up. Closed by D-120; what remains planned is C11-03's combined `session show`, whose milestone now names the
reason precisely — its five fields exist across three routes, and assembling them for one screen is a decision M3's four
interfaces should earn rather than one a runtime slice should make for them.

### F-58 — `POST /approvals/{id}/decision` records the answer and nothing in the process spends it

**Severity: high, closed by the thirty-first slice one commit after it was opened, and kept here in full because the
shape of it is the lesson — a route that answers a question and holds no party that can act on the answer.** A run that
reaches a gated step does what §6.3 and D-084 ask: `policy.evaluate` answers `require-approval`, the loop opens the row
inside the same transaction as the `approval.requested` event and the move to `awaiting_approval`, it writes D-065's
`prompt` boundary, and it suspends. A user then answers from any interface, the arbiter records the decision, the
`approval.answered` event is appended, the row leaves the pending queue and carries `approved` beside `answeredBy` — and
the task stays `awaiting_approval` forever. `Runner.resume(taskId)` exists, holds the `SuspendedRun` in memory, and would
spend the decision; no route calls it. `packages/gateway/app.ts`'s `registerApprovalRoutes` is not handed a runner, and
the only callers of `resume` in the repository are tests.

The restart case is *not* this finding and is already honest: `resume` answers `not-parked` with F-47's reason, because
§7 keeps `call.args` out of the checkpoint (SECURITY.md §8.2, D-095) so a restarted Gateway cannot rebuild the proposed
call, and D-065's verdict for a step killed at a prompt boundary is `re-ask`. That is an absence with a sentence attached.
(F-47's route has since arrived, and it did not change this: a continuation rebuilds the run from the boundary and lets the
model ask again — it cannot *spend* an approval row whose action the checkpoint deliberately does not carry.)
What this finding is about is the same-process case, where the parked run is reachable and nothing asks it — so §6.3's
"answer from anywhere" is, in this build, "record an answer from anywhere": a user approves a T2 step on Telegram, the
button says approved, and the agent never continues. The corollary of D-084's rule is the reason it is easy to miss: only
the loop may open a prompt, so only the loop can spend one, and the loop is the one party a route cannot reach without
being handed it.

Found by the thirtieth slice rather than by a review pass, and found because a test tried to use it: `task.cancel` with
`all: true` is §4.2's T2 half, so the run that declares it parks, and the test that approves the prompt and expects the
cancellations to happen discovered that nothing wakes the run. `tests/integration/task-tools.test.ts` therefore asserts the
gap and then drives `runner.resume` itself, with a comment naming this finding — the assertions after that call are the
behaviour the fix has to make reachable from a route, and they stay as they are when it does.

**Closing condition:** the decision path wakes the parked run — either the route is handed the runner, or the arbiter is,
and the second is the better seam because a decision answered over a socket and one answered inside the process then take
the same path — for `approve` *and* for `deny`, since `loop.resume` spends both and a denial nobody delivers leaves a task
parked on a question already answered. With it: a test that a T2 prompt answered over HTTP ends with the gated step
executed and the task terminal, containing no `resume` call of its own; §4.3's decision row and §7.1's `approval approve`
row losing the sentence this slice added; and `docs/review/TELEGRAM.md`'s approve element checked against it, because
"approved" printed on a phone has to mean something happened on the device.

**Amendment (thirty-first slice): closed, with the route handed the runner rather than the arbiter.** The seam chosen is
the first of the two the closing condition named, and the reason is §9's: the arbiter owns one row and one event, and a
`decide` that also started runs would give it a second responsibility and a dependency on the runtime it exists to be asked
by (`packages/agent-runtime/approvals.ts` holds no runner today and its store interface has no opinion about tasks). So
`registerApprovalRoutes` takes the runner the process composed, and `wakeParkedRun` does the four things the condition
asked for: it wakes on **both** decisions, because `loop.resume` spends a denial by making it the step's result and a
denied task parked on an answered question is this finding with the opposite sign; it wakes **after** the answer's
transaction commits, because a run resumed against a rolled-back row would execute a step nobody approved — D-084 inverted;
it wakes **after** the `approval.answered` event is published, so a client watching the task sees the reason before the
state moves; and it **reports** what it did, as two new fields on the decision response — `resumed` and the Gateway's own
`note` — because the three cases where nothing was woken (no runner in this process, no run parked in it, one already
moving) need different next actions and `resumed: false` alone is a fact with no sentence attached.
`crabby approval approve` prints both. What is still true and stays recorded: a run parked in a *previous* process is not
*spendable*, because `SuspendedRun` carries the proposed call in memory and SECURITY.md §8.2 keeps `call.args` out of the
checkpoint. `POST /tasks/{id}/resume` now exists and rebuilds the run from the boundary instead (F-47, D-111), which gets
the task moving and the model asking again — not the old row spent — and `Runner.resume`'s `not-parked` sentence is still
carried through to the caller verbatim rather than flattened into a `false`. Asserted by two tests in
`tests/integration/task-tools.test.ts`, neither of which contains a `resume` call: a T2 `task.cancel {all: true}` prompt
approved over HTTP ends with every cancellable task asked to stop and the `interrupted` one untouched, and the same prompt
denied over HTTP ends with the run completing on the refusal, one `tool.execution.blocked` event carrying the reason, and
the task the user refused to let it stop still `queued`.

### F-59 — §4.2 prices egress by host, and nothing in the documents prices it by class of host

**Severity: medium, open, and found by building the tool rather than by reading the table.** `net.fetch` is executed
(M2ab, D-106) and its destination is priced exactly as §4.3 says: a host on the user's `net.allowList` is §4.2's **T1**,
and every other host is **T2** with that host named in the approval's `exact` field. What no document does — `SECURITY.md`
§6.1 and §8, `PROVIDERS_AND_TOOLS.md` §4.2/§4.3/§5.2, `AGENT_RUNTIME.md` §4.4 — is distinguish a *class* of destination.
Three families therefore arrive at the same price as any other new host: this machine's own loopback, including the
Gateway's own listener; link-local and cloud-metadata addresses, of which `169.254.169.254` is the one with a documented
history of answering questions it should not; and private-range hosts on whatever LAN the device happens to be joined to.

The consequence is bounded, and stating the bound precisely is the point of recording this rather than escalating it. An
approval names the host, so the user is shown `169.254.169.254` and not "a URL"; the Gateway answers a fetch that carries
no bearer token with `401` (D-097), so a tool cannot drive the process it is running inside by fetching it; and F-56's
absence means there is no credential store for a destination to be handed. What is *not* bounded is the LAN and metadata
case on a device whose network the user did not choose — a phone on a café Wi-Fi, which is this product's primary platform
— where an approved fetch into a private range is a request into a network §13's "loopback only" posture was written to
keep the rest of the world out of. The tier is the same T2 either way, and T2 is ten minutes and one tap.

Closing condition: a rule in `SECURITY.md` (§6.1's table or §8's containment) that classes destinations — loopback,
link-local, private — and says whether each is refused, priced above its row's tier, or priced the same with a louder
prompt; and an executor that enforces whatever it says, which `packages/tools/net.ts` already has the seam for (it parses
every URL and every hop, and it already refuses a hop whose host differs from the one that was priced). Deliberately not
closed inside that executor by the slice that opened this: a refusal the arbiter did not ask for is a second policy with
no document behind it, which is D-099's split enforced from the wrong side, and D-106's fourth part names this finding
instead of inventing the rule.

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
| Documents compared with the code they describe (`scripts/parity.ts`, `npm run test:parity`) | ✓ (it exists because of F-08/F-10/F-11 and it found F-32 and F-35 — the first two findings in this file that a prose-against-prose check could not have seen. What it compares is not quoted here any more: this row used to carry the counts, and they were two milestones stale by M2d, which is F-40's rule about a number printed away from the expression that produces it. `npm run test:parity` prints them.) |
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
