# Crabby — M-D Cross-Document Consistency Review

> **Status:** In progress — first pass complete. Mechanical checks pass; human verification by the owner is the
> remaining item (§6).
>
> **Reviewed:** 15 planning documents (`*.md`, `docs/*.md`) as of 2026-10-09.
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
| §12 technical direction | `DECISIONS.md` §3 + §5 + §5A | Covered, with `O-003`/`O-005` still open by design |
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
    That is M0's job, and M0 can still invalidate `P-003`, `P-010`, and `P-006`.
02. **`SECURITY.md` has not been adversarially reviewed** by anyone other than its author. A threat model written by
    the same agent that writes the mitigations is a single point of failure; the T-01…T-15 → test mapping should be
    checked by a second reader before M5 exit.
03. **Provider claims are dated.** `DECISIONS.md` §5/§5A record versions as of 2026-10-09; registry state moves, so
    both records carry an "as of" date and must be re-checked at M0 rather than trusted.
04. **Cost/effort is unestimated.** `docs/ROADMAP.md` gives order and gates, not durations. Turning it into a
    schedule would require the owner's availability, which is not a documentation fact.
05. **Bengali rendering and input ergonomics are untested** on a real phone keyboard (`docs/UI_UX_SPEC.md` §9,
    `docs/DESIGN_SYSTEM.md` §11) — this matters more for this project than for most, since the owner's working
    language is Bengali and the primary device is a phone.

## 6. Owner Verification Checklist

The remaining half of M-D. Each item is a yes/no, not a discussion:

- [ ] Read `PROJECT_BRIEF.md` §13 (principles) and confirm nothing there has drifted from the intent.
- [ ] Confirm `D-052` (no remembered approvals in v1) — it changes day-to-day feel, not just architecture.
- [ ] Confirm `D-053` (client management is local-only) as an accepted parity exception.
- [ ] Sanity-check `docs/ROADMAP.md` §1: is M0 (throwaway Termux probes) genuinely wanted before M1, or is one probe
      (`P3` driver, `P5` TUI) enough to proceed?
- [ ] Read `AGENTS.md` §7 (forbidden shortcuts) as the rules you actually want enforced on every future coding turn.
- [ ] Confirm that every still-open item in `DECISIONS.md` §4 is either device-measured (O-002, O-006, O-051) or an
      owner decision (O-053…O-063 from the element review), and that nothing is open out of habit.
- [ ] Verify `docs/INTERFACES_AND_API.md` §8's two documented limitations are acceptable rather than gaps to fill.

**And the element-review gate added during M-D (D-055/D-056), which comes first:**

- [ ] `docs/review/README.md` — the index: what each file covers, how to answer, and which invariants the checker
      enforces.
- [ ] `docs/review/WEB.md` — 185 elements over 19 regions. Reviewed through `docs/review/mockups/crabby-web-ui.html`, which is
      generated from that file, so an element that exists in one and not the other is a build error rather than a
      disagreement.
- [ ] `docs/review/TUI.md` — 202 elements over 21 regions, every one answerable at 40 columns × 24 rows.
- [ ] `docs/review/CLI.md` — 158 elements over 15 regions, with the pipe and the exit code as the binding case.
- [ ] `docs/review/TELEGRAM.md` — 129 elements, where the transport's own limits are facts and the responses to them
      are the decisions, and where every parity-matrix capability has a command of its own (F-08).
- [ ] Only after statuses stop saying `PROPOSED`: regenerate `docs/UI_UX_SPEC.md` and `docs/DESIGN_SYSTEM.md` from
      the approved rows, then re-run §7.

674 elements, 0 approved as of this round. (The count grew from 590 while F-08…F-10 were being fixed: a screen with no rows is the most expensive kind of gap, because it costs nothing to notice.) Nothing in this list is a formality: a row that reads "the small chip"
has as much standing as "the chat pane", and cutting it is a decision with an ID.

When these are ticked, `docs/ROADMAP.md` §0 moves to "M-D complete" and M0 starts.

## 7. Re-Review Rule

Re-run this review whenever: a `D-` row changes status, a new document or tool or capability is added, or an M0 probe
returns a result that contradicts a `P-` proposal. A drift check that only runs once is a snapshot, not a control —
which is why §3's checks live in `scripts/check-docs.py` and are wired into `npm run docs:check`.

---

**End of Consistency Review**
