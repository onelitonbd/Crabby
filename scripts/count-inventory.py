#!/usr/bin/env python3
"""Count the element inventories so review progress is output, not memory.

`DECISIONS.md` §4B states how many elements each inventory holds and how many have left `PROPOSED`; `docs/review/README.md`
repeats the totals. Writing those numbers by hand is how a progress table starts claiming review that has not happened,
which is the one thing this gate exists to prevent (D-055). So the counting rules are imported from the checker itself —
one definition of "what is a row" for both tools, or the two drift and the safe-looking number wins.

    python3 scripts/count-inventory.py            # plain text
    python3 scripts/count-inventory.py --markdown          # §4B table rows, paste-ready
    python3 scripts/count-inventory.py --register-counters # the section 8 counter cells
"""
from __future__ import annotations

import importlib.util
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
FILES = ["WEB.md", "TUI.md", "CLI.md", "TELEGRAM.md"]
LABEL = {"WEB.md": "Web UI", "TUI.md": "TUI", "CLI.md": "CLI", "TELEGRAM.md": "Telegram interface"}


def checker():
    spec = importlib.util.spec_from_file_location("check_docs", ROOT / "scripts" / "check-docs.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def rows_for(mod, name: str):
    body = (ROOT / "docs" / "review" / name).read_text(encoding="utf-8")
    return mod.inventory(body), len(mod.REVIEW_REGION_RE.findall(body))


def register_counters() -> int:
    """Print the DECISIONS.md section 8 counter cells, computed from the register itself.

    The same numbers have been written wrong by hand twice, which is why section 8 exists as a table the checker
    verifies (rule 9) and not as prose. Paste these; do not count by hand.
    """
    body = (ROOT / "DECISIONS.md").read_text(encoding="utf-8")
    last: dict[str, str] = {}
    for line in body.splitlines():
        m = re.match(r"^\|\s*([DPO]-\d{3})\s*\|(.*)$\n?", line)
        if not m:
            continue
        cells = [c.strip() for c in m.group(2).split("|") if c.strip()]
        if cells:
            last[m.group(1)] = cells[-1].strip("| ").strip()
    d = sorted(k for k in last if k.startswith("D-"))
    p_ = sorted(k for k in last if k.startswith("P-"))
    o = sorted(k for k in last if k.startswith("O-"))
    acc = [k for k in d if "Accepted" in last[k]]
    sup = [k for k in d if "Superseded" in last[k]]
    p_prop = [k for k in p_ if last[k].startswith("Proposed")]
    p_nv = [k for k in p_ if "Needs Validation" in last[k]]
    # a closure marker reads "**Closed", "**Mostly closed", "**Narrowed" or "Accepted in D-"; a question phrased
    # differently counts as open here, which is why the still-open ids are printed instead of a bare count
    o_closed = [k for k in o if re.match(r"(\*\*(Closed|Mostly closed|Narrowed))|(Accepted in D-)", last[k])]
    o_open = [k for k in o if k not in o_closed]
    print("| Accepted decisions | %d (%s…%s) |" % (len(acc), d[0], d[-1]))
    print("| Proposed technical choices | %d (%s…%s) |" % (len(p_), p_[0], p_[-1]))
    # rule 9 counts every O- row as tracked; a closed question keeps its number
    print("| Open / needs-validation items | %d tracked |" % len(o))
    print()
    print("prose note (not checked by the checker):")
    print("  D: %d accepted, %d superseded, %d neither" % (len(acc), len(sup), len(d) - len(acc) - len(sup)))
    print("  P: %d still Proposed (rule 14 requires 0), %d Needs Validation: %s"
          % (len(p_prop), len(p_nv), ", ".join(p_nv) or "-"))
    print("  O: %d rows, %d closed or narrowed, %d still open: %s"
          % (len(o), len(o_closed), len(o_open), ", ".join(o_open) or "-"))
    return 0


def main() -> int:
    if "--register-counters" in sys.argv:
        return register_counters()
    mod = checker()
    table, total, approved = [], 0, 0
    for name in FILES:
        rows, regions = rows_for(mod, name)
        ok = sum(1 for _, status, _ in rows if status != "PROPOSED")
        unknown = [rid for rid, status, _ in rows if status not in mod.REVIEW_STATUSES]
        if unknown:
            raise SystemExit(f"docs/review/{name}: statuses not in the allowed set: {', '.join(unknown[:5])}")
        total += len(rows)
        approved += ok
        table.append((name, regions, len(rows), ok))
    if "--markdown" in sys.argv:
        for name, regions, n, ok in table:
            print(f"| `docs/review/{name}` | {regions} regions of the {LABEL[name]} | {n} | {ok} | {n - ok} |")
    else:
        for name, regions, n, ok in table:
            print(f"{name:13s} regions={regions:<3} elements={n:<4} approved={ok:<4} remaining={n - ok}")
    print(f"{'TOTAL':13s} elements={total} approved={approved} remaining={total - approved}")
    parts = " + ".join(str(n) for _, _, n, _ in table)
    print(f"totals line for prose: {parts} = {total} elements, {approved} decided")
    return 0


if __name__ == "__main__":
    sys.exit(main())
