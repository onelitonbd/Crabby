#!/usr/bin/env python3
"""Element-inventory review pass (`docs/review/*.md`), run by the reviewer, not for the reviewer.

The element review in front of M0 (D-055) is 675 rows. A pass that reads every row and returns every row `ACCEPTED`
is not a review, it is a stamp, and a stamp helps nobody when the code is written. This script applies each
interface's *own* recorded constraints — the transport limits in `docs/review/TELEGRAM.md`, the 40x24 rule for the
TUI, the machine-output rule for the CLI (D-063), the no-meaning-by-hue-alone rule for the Web (D-068 and the palette
floor) — and prints every row that a reader should look at again. It decides nothing: the exit code is always 0, and
the flagged rows are the input to a human (or, this round, to the delegated reviewer) judgment pass.

Run: python3 scripts/review-scan.py            # summary + all flags
     python3 scripts/review-scan.py --counts  # rows per file, for the coverage tables

Checks are deliberately mechanical: a rule that needs judgment is not a scan, it is a review.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REVIEW = ROOT / "docs" / "review"
FILES = ["WEB.md", "TUI.md", "CLI.md", "TELEGRAM.md"]

# technologies the register has already rejected (D-060, D-068, D-069): an inventory row still naming one as the
# implementation is not a style opinion, it is a row that will be built wrong
KILLED = ["React", "Vite", "Vitest", "tsx", "Zod", "pnpm", "esbuild", "WebSocket"]

CAPTION_LIMIT = 1024      # Telegram caption, a fact recorded in the inventory's own preamble
TEXT_LIMIT = 4096         # Telegram message text
CALLBACK_LIMIT = 64       # bytes of callback_data
BUTTONS_PER_ROW = 3       # the recorded ergonomic limit for a phone thumb


def rows_of(body: str):
    """Yield (line_number, id, cells) for every inventory row, with the header's column names."""
    lines = body.splitlines()
    header: list[str] = []
    for n, line in enumerate(lines, start=1):
        m = re.match(r"^\|\s*ID\s*\|(.*)\|\s*$", line)
        if m:
            header = [c.strip() for c in m.group(1).split("|")]
            header.insert(0, "ID")
            continue
        if not line.startswith("|") or not header:
            continue
        if re.match(r"^\|\s*-{2,}", line):
            continue
        m = re.match(r"^\|\s*([A-Z][A-Z0-9-]*)\s*\|(.*)\|\s*$", line)
        if not m:
            continue
        cells = [c.strip() for c in m.group(2).split("|")]
        if len(cells) < 2:
            continue
        status = cells[-1]
        body_cells = cells[:-1]
        yield n, m.group(1), header, body_cells, status


def cell(header: list[str], cells: list[str], name: str) -> str:
    if name in header:
        i = header.index(name)
        if i - 1 < len(cells):
            return cells[i - 1]
    return ""


ROUTE_RE = re.compile(r"`(?:GET|POST|PATCH|PUT|DELETE) (/[^`{\s]*)")


OPENQ_RE = re.compile(r"\*\*Open question ([A-Z][A-Z0-9-]*):\*\*")
ANSWER_RE = re.compile(r"\*\*([A-Z][A-Z0-9-]*) — (closed|decided|answered|not in v1|out of scope)", re.I)


def known_ids() -> tuple[dict[str, set[str]], dict[str, dict[str, bool]]]:
    """Ids defined per file, plus the region's own open-question markers.

    An inventory defines two kinds of id: a table row, and a `**Open question X:**` block that a row can cite. A
    citation to either is fine; a citation to neither is a spec pointing at nothing. An open question with no
    `**X — closed (D-0nn)**` answer in the same file is a different defect, reported as A6.
    """
    ids: dict[str, set[str]] = {}
    openq: dict[str, dict[str, bool]] = {}
    for fname in FILES:
        body = (REVIEW / fname).read_text(encoding="utf-8")
        row_ids = {m.group(1) for m in re.finditer(r"^\|\s*([A-Z][A-Z0-9]*-?[A-Z]?\d*)\s*\|", body, re.M)}
        answered = {m.group(1) for m in ANSWER_RE.finditer(body)}
        asked = {m.group(1) for m in OPENQ_RE.finditer(body)}
        ids[fname] = row_ids | asked
        openq[fname] = {q: (q in answered) for q in sorted(asked)}
    return ids, openq


def scan() -> int:
    flags: list[tuple[str, int, str, str, str]] = []
    ids, openq = known_ids()
    api = (ROOT / "docs" / "INTERFACES_AND_API.md").read_text(encoding="utf-8")
    api_routes = {m.group(1) for m in ROUTE_RE.finditer(api)}

    for fname in FILES:
        path = REVIEW / fname
        if not path.is_file():
            continue
        body = path.read_text(encoding="utf-8")
        seen: dict[str, list[int]] = {}
        for n, rid, header, cells, status in rows_of(body):
            joined = " ".join(cells)
            element = cell(header, cells, "Element") or (cells[0] if cells else "")
            # the row's claim is everything between the element name and the status; column names drift per region,
            # so the length test reads the whole claim rather than guessing which column is "Content"
            content = " ".join(cells[1:])
            behavior = cell(header, cells, "Behavior")
            sizes = cell(header, cells, "Sizes") or ""
            seen.setdefault(element.lower().strip(), []).append(n)

            def flag(rule: str, why: str):
                flags.append((f"{fname}:{n}", rid, rule, why, joined[:200]))

            # A1: a row that makes no claim cannot be reviewed
            if len(joined) < 30 and "?" not in joined:
                flag("A1 thin-row", f"whole row is {len(joined)} chars, nothing for an implementer to build")
            # A4: a row that still names a rejected technology
            hit = [k for k in KILLED if re.search(r"\b" + re.escape(k) + r"\b", joined)]
            if hit and not re.search(r"not\b|no |never|instead|supersed|reject", joined, re.I):
                flag("A4 stale-stack", f"names {', '.join(hit)} without saying it is the rejected option")

            if fname == "TELEGRAM.md":
                m = re.search(r"(\d{4,5})\s*(?:chars?|characters)", joined)
                if m and int(m.group(1)) > TEXT_LIMIT:
                    flag("B1 text-limit", f"{m.group(1)} chars exceeds the {TEXT_LIMIT}-char message limit")
                m = re.search(r"caption[^.]{0,40}?(\d{3,5})\s*chars?", joined, re.I)
                if m and int(m.group(1)) > CAPTION_LIMIT:
                    flag("B2 caption-limit", f"caption of {m.group(1)} exceeds {CAPTION_LIMIT}")
                if re.search(r"\b\d{2,}\s*buttons?\b", joined) and not re.search(r"rows?", joined, re.I):
                    flag("B4 button-count", "a keyboard this wide is unusable on a phone; state rows x cols")
                if re.search(r"callback[_ ]?data[^.]{0,30}(path|url|args|json|payload)", joined, re.I):
                    flag("B3 callback-data", "callback_data is 64 bytes; an id goes in it, not an argument list")

            if fname == "TUI.md":
                widths = [int(x) for x in re.findall(r"(\d{1,2})\s*cols?\b", joined)]
                if widths and sum(widths) > 40 and "40" not in sizes:
                    flag("C1 40-cols", f"widths {widths} sum to {sum(widths)}, over the 40-column contract")
                if re.search(r"Shift\+Enter", joined) and not re.search(r"Ctrl\+J|best.effort|legacy|\*\*T[0-9A-Z-]*A\*\*", joined):
                    flag("C2 newline", "Shift+Enter is not guaranteed on Termux; Ctrl+J is the binding (D-061)")
                if re.search(r"align[s]?\b|column.aligned", joined, re.I) and re.search(
                    r"Bengali|Devanagari|indic|cluster", joined, re.I
                ) and not re.search(r"not promised|no promise|never promise", joined, re.I):
                    flag("C3 grid promise", "D-062: no grid-alignment promise for combining-mark text")

            # A3: a row that cites an element id must cite one that exists, in this file or in the file the id
            # belongs to by prefix; a dangling citation in an inventory is a spec that points at nothing
            for ref in set(re.findall(r"\b((?:W|T|C|G)[0-9A-Z-]*\d-[0-9A-Z]+)\b", joined)):
                home = {"W": "WEB.md", "T": "TUI.md", "C": "CLI.md", "G": "TELEGRAM.md"}.get(ref[0])
                pool = ids.get(fname, set()) | ids.get(home or "", set())
                if ref not in pool and re.sub(r"[A-Z]$", "", ref) not in pool:
                    flag("A3 dangling-ref", f"cites {ref}, which no inventory defines")

            # A5: a row that promises a route has to promise one the API document has
            for route in {m.group(1) for m in ROUTE_RE.finditer(joined)}:
                if route not in api_routes:
                    flag("A5 invented-route", f"`{route}` is not in `docs/INTERFACES_AND_API.md`")

            # D1 was tried and dropped. A per-row demand for a failure story duplicates the file's own contracts —
            # C3-01…C3-05 define the exit-code set for every command and C-S02 defines the machine-output stability
            # rule — so the flag fired on 25 rows that were complete and stayed silent on the rows that were not.
            # A rule that inverts like that is worse than no rule: it trains the reader to ignore the scan.
            pass

            if fname == "WEB.md":
                if re.search(r"tooltip|on hover|hover only", joined, re.I) and not re.search(
                    r"tap|focus|long.press|keyboard", joined, re.I
                ):
                    flag("E1 hover-only", "touch-first: hover has to have a tap or focus equivalent")
                if re.search(r"\b(red|green|amber)\b", joined, re.I) and not re.search(
                    r"label|text|word|icon|border|glyph", joined, re.I
                ):
                    flag("E2 hue-only meaning", "tier and state must survive grayscale (DESIGN_SYSTEM §2.3)")

        for q, answered in openq.get(fname, {}).items():
            if not answered:
                flags.append((f"{fname}:0", q, "A6 unanswered-question",
                              "an open question with no `**X — closed (D-0nn)**` answer in this file", ""))

        for el, lines in seen.items():
            if len(lines) > 1:
                flags.append((f"{fname}:{lines[0]}", "-", "A2 duplicate", f"{el!r} appears on lines {lines}", ""))

    by_rule: dict[str, list] = {}
    for loc, rid, rule, why, ctx in flags:
        by_rule.setdefault(rule, []).append((loc, rid, why, ctx))

    print(f"review scan: {len(flags)} flagged rows across {len(FILES)} inventories")
    for rule in sorted(by_rule):
        print(f"\n{rule}  ({len(by_rule[rule])})")
        for loc, rid, why, ctx in by_rule[rule]:
            print(f"  {loc} {rid}: {why}")
            if ctx:
                print(f"      {ctx}")
    return 0


def counts() -> int:
    for fname in FILES:
        path = REVIEW / fname
        body = path.read_text(encoding="utf-8")
        rows = list(rows_of(body))
        acc = sum(1 for _n, _i, _h, _c, s in rows if s.upper() == "ACCEPTED")
        print(f"{fname:12} rows={len(rows):4} accepted={acc:4} not-approved={len(rows) - acc:4}")
    return 0


if __name__ == "__main__":
    sys.exit(counts() if "--counts" in sys.argv else scan())
