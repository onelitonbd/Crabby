# Element Review — Index

> Four files, 612 elements, one status per element. This is the gate in front of M0 (D-055, and `docs/ROADMAP.md`
> §11 lists the open questions it raised). Nothing here is product code and nothing here is a summary: **these tables
> are the spec review itself**, and `docs/UI_UX_SPEC.md` plus `docs/DESIGN_SYSTEM.md` get regenerated from them once
> the statuses stop saying `PROPOSED`.

## What is here

| File | Surface | Regions | Elements | How to review it |
| --- | --- | --- | --- | --- |
| `WEB.md` | browser, 360px binding | 17 | 161 | `mockups/crabby-web-ui.html`, generated from the file — click any element, its row opens |
| `TUI.md` | Termux, 40×24 binding | 19 | 185 | the rows themselves; a terminal cannot be judged honestly in a browser, and no HTML pretends to be one |
| `CLI.md` | the pipe, not the terminal | 13 | 143 | rows; `--help` text is the mockup, and it does not exist until implementation |
| `TELEGRAM.md` | a chat on a phone with a flaky connection | 11 | 123 | rows; the transport's limits are quoted as facts, the responses to them are the decisions |

`W`, `T`, `C`, `G` are the ID prefixes. A region is `W1`, `T-A`, `C10`, `G-S`; an element is `W4-08`, `T-A13`,
`C-S09`, `G3-17`. Quote the ID when you want one thing changed — that is the whole reason the IDs exist.

## The rules these files hold themselves to

- **Equal weight.** A 44px tap target, a `redacted` marker, and the chat pane are all one row each. Nothing is
  "details later" (D-055).
- **Absence is a row too.** If something was deliberately not built — no bulk approve (C-A8), no `crabby update`
  (C1-10), no "install anyway" for an `unsafe` extension (C-E6) — it is written down, so the absence reads as a
  decision and not as an oversight.
- **One command surface.** `scripts/check-docs.py` rule 10 compares the actual token sets: every command noun in
  `docs/INTERFACES_AND_API.md` §7.1 and the §8 parity matrix must be named by a row in `CLI.md`, and every command in
  §7.4 and the matrix's Telegram column must have its own row in `TELEGRAM.md`. It runs the other way too, so a
  command invented in an inventory is a finding as well.
- **Counts are not remembered.** The coverage table at the end of each file, and the progress row for each file in
  `DECISIONS.md` §4B, are checked against the parsed rows on every run. Two of those tables have already disagreed
  with what a human wrote, which is why they are not trusted.
- **Statuses change only by the owner.** `PROPOSED → ACCEPTED / EDIT / CUT / ?`. An assistant may rewrite a row's
  text after an `EDIT`, but not its status.

## How to answer

1. **Web:** open the mockup (or run `python3 docs/review/mockups/serve.py` and use that URL from a phone), set each
   row, then "Copy my edits". The output is markdown rows for `WEB.md`, notes included.
2. **TUI, CLI, Telegram:** reply with IDs. "`T5-01: Shift+Enter is fine, Android Gboard has it`" is a complete
   decision; "`C6-A: block by default`" closes an open question. Each of those becomes an `ACCEPTED`/`EDIT` row, and
   any question that changes what gets built becomes an `O-` row in `DECISIONS.md` — that is what O-053…O-063 are.
3. **Anything cut** has to say where the capability goes instead, or it is a parity gap and `docs/INTERFACES_AND_API.md`
   §8 has to be edited to match, with the alternative interaction named.

## Current state

612 elements, 0 approved. Four open questions are registered against the Web bar and the TUI/CLI surfaces
(O-053…O-063); the platform numbers in `TELEGRAM.md` are quoted from the Bot API and are to be re-verified at
implementation time. `CHANGELOG.md` is the only file `scripts/check-docs.py` still calls out as planned-but-unwritten,
and it waits for the first release (`docs/ROADMAP.md` §11).
