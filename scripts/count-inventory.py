#!/usr/bin/env python3
"""Count the element inventories so review progress is output, not memory.

`DECISIONS.md` §4B states how many elements each inventory holds and how many have left `PROPOSED`; `docs/review/README.md`
repeats the totals. Writing those numbers by hand is how a progress table starts claiming review that has not happened,
which is the one thing this gate exists to prevent (D-055). So the counting rules are imported from the checker itself —
one definition of "what is a row" for both tools, or the two drift and the safe-looking number wins.

    python3 scripts/count-inventory.py            # plain text
    python3 scripts/count-inventory.py --markdown  # §4B table rows, paste-ready
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


def main() -> int:
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
