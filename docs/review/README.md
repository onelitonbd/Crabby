# Element Review — Index

> Four files, 675 elements, one status per element. This is the gate in front of M0 (D-055, and `docs/ROADMAP.md`
> §11 lists the open questions it raised). Nothing here is product code and nothing here is a summary: **these tables
> are the spec review itself**, and `docs/UI_UX_SPEC.md` plus `docs/DESIGN_SYSTEM.md` get regenerated from them once
> the statuses stop saying `PROPOSED`.

## What is here

| File | Surface | Regions | Elements | How to review it |
| --- | --- | --- | --- | --- |
| `WEB.md` | browser, 360px binding | 19 | 185 | `mockups/crabby-web-ui.html`, generated from the file — click any element, its row opens |
| `TUI.md` | Termux, 40×24 binding | 21 | 203 | the rows themselves; a terminal cannot be judged honestly in a browser, and no HTML pretends to be one |
| `CLI.md` | the pipe, not the terminal | 15 | 158 | rows; `--help` text is the mockup, and it does not exist until implementation |
| `TELEGRAM.md` | a chat on a phone with a flaky connection | 11 | 129 | rows; the transport's limits are quoted as facts, the responses to them are the decisions |

`W`, `T`, `C`, `G` are the ID prefixes. A region is `W1`, `T-A`, `C10`, `G-S`; an element is `W4-08`, `T-A13`,
`C-S09`, `G3-17`. Quote the ID when you want one thing changed — that is the whole reason the IDs exist.

## The rules these files hold themselves to

- **Equal weight.** A 44px tap target, a `redacted` marker, and the chat pane are all one row each. Nothing is
  "details later" (D-055).
- **Absence is a row too.** If something was deliberately not built — no bulk approve (C-A8), no `crabby update`
  (C1-10), no "install anyway" for an `unsafe` extension (C-E6) — it is written down, so the absence reads as a
  decision and not as an oversight.
- **A row is a table row.** Four rows across the set once carried an unescaped `|` inside a cell, which silently splits
   the row and shifts every field after it — and because `docs/review/mockups/build.py` parses these files, one of
   them reached the review instrument as a corrupt label (F-21). Rule 16 refuses a table that is not rectangular, so
   a pasted row is checked instead of trusted.
- **One command surface.** `scripts/check-docs.py` rule 10 compares the actual token sets: every command noun in
  `docs/INTERFACES_AND_API.md` §7.1 and the §8 parity matrix must be named by a row in `CLI.md`, and every command in
  §7.4 and the matrix's Telegram column must have its own row in `TELEGRAM.md`. It runs the other way too, so a
  command invented in an inventory is a finding as well.
- **Nothing may be a capability in one interface only.** Rules 10–12 of `scripts/check-docs.py`
  cross-check the three hand-maintained lists — API routes, the `docs/INTERFACES_AND_API.md` §8 capability matrix,
  and the `docs/UI_UX_SPEC.md` §2.2 screen list — against the four inventories. All three have already disagreed once
  (F-08, F-10, F-11).
- **Values that can be computed are computed.** Rule 13 recomputes every contrast ratio in
  `docs/DESIGN_SYSTEM.md` §2.3 from the hexes in the same table — measured against the worst surface a token can sit
  on, not `bg.base` — and fails if a printed number is stale, if a value misses its own floor, or if a text token's
  floor has been lowered. Same principle as the counts: a number a human typed is a number a human can be wrong about.
- **Counts are not remembered.** The coverage table at the end of each file, and the progress row for each file in
  `DECISIONS.md` §4B, are checked against the parsed rows on every run; `scripts/count-inventory.py --markdown` prints
  the §4B rows using the checker's own parser, so the two cannot disagree about what a row is. Two of those tables have already disagreed
  with what a human wrote, which is why they are not trusted.
- **Statuses change by the owner.** `PROPOSED → ACCEPTED / EDIT / CUT / ?`. An assistant may rewrite a row's text
  after an `EDIT`, but not its status. **One exception, granted 2026-10-10 and bounded:** under D-059 the agent moved
  rows whose only blocker was an open question that the (R) decisions answered, and 25 rows plus the new T-A14 record
  the decision ID inside the row for exactly that reason. A row that needs someone to *like* it was not touched, and
  reverting any of them is one decision ID plus `python3 scripts/count-inventory.py --markdown`.

## How to answer

1. **Web:** open the mockup (or run `python3 docs/review/mockups/serve.py` and use that URL from a phone), set each
   row, then "Copy my edits". The output is markdown rows for `WEB.md`, notes included.
2. **TUI, CLI, Telegram:** reply with IDs. "`T5-01: Shift+Enter is fine, Android Gboard has it`" is a complete
   decision; "`C6-A: block by default`" closes an open question. Each of those becomes an `ACCEPTED`/`EDIT` row, and
   any question that changes what gets built becomes an `O-` row in `DECISIONS.md` — that is what O-053…O-063 were, and
   it is why O-064 and O-065 were registered during finalization when two open items turned up in a document with no
   row of their own (F-20).
   **Since 2026-10-10 the flip is not blocked on a reply** for that one class of row: the owner delegated the open
   questions (D-059), so a row whose only blocker was such a question has been moved by the agent and marked with the
   decision that moved it, and `docs/review/DECISION-QUEUE.md` lists every one with its evidence. That exception
   covers *answered questions* and nothing else — a row that needs someone to like it, or to measure it on a phone,
   is still `PROPOSED` and still waits for the owner.
3. **Anything cut** has to say where the capability goes instead, or it is a parity gap and `docs/INTERFACES_AND_API.md`
   §8 has to be edited to match, with the alternative interaction named.

## Current state

675 elements, 25 decided. The count moved twice during the audit passes because the
Sessions screen (`docs/UI_UX_SPEC.md` §2.2) and the session switcher (§7.2) turned out to have **zero** elements
anywhere (F-10) — a screen with no rows is a screen that silently disappears when these files regenerate the spec.

Every open question that used to hang off these files is closed except eight items, and all eight are closed by a
measurement rather than by an opinion: O-001/O-002 (a clean Termux build plus a WAL torture on a phone), O-006 and
O-051 (repaint cost and Ink 8 at 40×24, on a phone), O-008 (extension isolation, which needs the first real
extensions to exist), O-064 (a signing mechanism that needs no hosted service) and O-065 (what Termux actually refuses
an untrusted process). O-052, remembered approvals, stays open as a post-v1 design question by choice (D-052). The
questions that needed no hardware were answered rather than left open — D-071…D-074, skill frontmatter, host API
versioning, memory provenance, timeout and concurrency defaults. The
platform numbers in `TELEGRAM.md` are quoted from the Bot API and are to be re-verified at implementation time.
`CHANGELOG.md` is the only file `scripts/check-docs.py` still calls out as planned-but-unwritten, and it waits for the
first release (`docs/ROADMAP.md` §11).
