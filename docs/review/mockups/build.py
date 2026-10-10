#!/usr/bin/env python3
"""Build the Crabby Web UI review mockup from docs/review/WEB.md.

The inventory file is the source of truth: every element drawn in the mockup is read from a
table row, so the picture cannot drift from the document. Re-run after editing WEB.md:

    python3 docs/review/mockups/build.py

Writes web.html next to this script: self-contained (inline CSS, inline data, no fetch, no
CDN, no network), because it has to open from a file or from a Termux-hosted port on a phone.

This is a review instrument for planning, not application code: it renders the approved
element list so the owner can look at it, and nothing else.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
INVENTORY = HERE.parent / "WEB.md"
SHELL = HERE / "shell.html"
OUT = HERE / "web.html"

STATUSES = ("PROPOSED", "ACCEPTED", "EDIT", "CUT", "?")
REGION_HEAD_RE = re.compile(r"^#{2,4} Region ((?:W\d+|W-[A-Z]))\s*(?:—|-{1,2})\s*(.*)$")
SPLIT_RE = re.compile(r"^\|(.*)\|$")


def is_element_id(cell: str) -> bool:
    """Accept `W1-01` and `W-A1`-family IDs; reject header and separator rows."""
    if cell in ("ID", "---") or set(cell) <= {"-", " ", ":"}:
        return False
    return bool(re.match(r"^W(?:\d{1,2}-\d{1,2}|-[A-Z]\d{1,2})$", cell))


def strip_md(value: str) -> str:
    value = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", value)
    value = re.sub(r"`([^`]+)`", r"\1", value)
    value = re.sub(r"\*\*([^*]+)\*\*", r"\1", value)
    return value.replace("**", "").strip()


def parse() -> list[dict]:
    """Row order and column meaning come from each table's own header, not from position.

    The regions do not all use the same columns (W2 has no Content/Sizes, W-A has no Sizes),
    so a positional parse would silently mislabel rows - which is exactly the kind of drift
    this review exists to prevent.
    """
    rows: list[dict] = []
    region, region_title = "", ""
    header: list[str] = []
    for line in INVENTORY.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        m = REGION_HEAD_RE.match(stripped)
        if m:
            region, region_title = m.group(1).strip(), m.group(2).strip()
            continue
        if not stripped.startswith("|"):
            header = []
            continue
        cells = [c.strip() for c in SPLIT_RE.match(stripped).group(1).split("|")]
        if cells and cells[0].upper() == "ID":
            header = [c.lower() for c in cells]
            continue
        if not header or not is_element_id(cells[0]):
            continue
        row = {"id": cells[0], "region": region, "region_title": region_title,
               # raw line + column order, so an edited row can be pasted back verbatim
               "raw": stripped, "cols": [h for h in header if h != "id"]}
        for name, value in zip(header[1:], cells[1:]):
            row[name] = strip_md(value)
        for col in ("element", "content", "sizes", "behavior", "placement", "notes"):
            row.setdefault(col, "")
        status = row.get("status", "").upper()
        row["status"] = status if status in STATUSES else "PROPOSED"
        if "placement" not in row:
            # a region without a Placement column still needs a placement for the mockup
            row["placement"] = ""
        rows.append(row)
    return rows


def check_refs(rows: list[dict]) -> tuple[set[str], set[str]]:
    """Every element rendered in the mockup must exist in the inventory, and vice versa."""
    by_id = {r["id"] for r in rows}
    # web.html is generated output and contains this same markup plus the app source: scanning
    # it would report the app's own string literals as references.
    sources = [SHELL] + [p for p in HERE.glob("*.html") if p not in (SHELL, OUT)]
    markup = "\n".join(p.read_text(encoding="utf-8") for p in sources)
    refs = set(re.findall(r'data-el="([^"]+)"', markup))
    unknown = sorted(refs - by_id)
    placed = refs & by_id
    unplaced = sorted(by_id - placed, key=lambda i: (len(i), i))
    return unknown, set(unplaced)


def declared_total(rows: list[dict]) -> tuple[int, int]:
    """The coverage table's own claim, so the mockup build fails when it stops matching."""
    text = INVENTORY.read_text(encoding="utf-8")
    m = re.search(r"\|\s*\*\*Total\*\*\s*\|\s*\*\*(\d+) regions\*\*\s*\|\s*\*\*(\d+) elements\*\*", text)
    return (int(m.group(1)), int(m.group(2))) if m else (0, 0)


def payload(rows: list[dict]) -> str:
    """JSON as an inline-script literal: `</` must not appear, or it closes the tag early."""
    return json.dumps(rows, ensure_ascii=False).replace("</", "<\\/") + ";"


def main() -> int:
    rows = parse()
    if not rows:
        print("no inventory rows parsed - check the table shape in WEB.md", file=sys.stderr)
        return 1
    seen: dict[str, dict] = {}
    for r in rows:
        if r["id"] in seen:
            print(f"duplicate element ID in WEB.md: {r['id']}", file=sys.stderr)
            return 1
        seen[r["id"]] = r
    rows = list(seen.values())

    regions = {r["region"] for r in rows if r["region"]}
    n_regions, n_elements = declared_total(rows)
    if (n_regions, n_elements) not in ((0, 0),):
        if n_elements != len(rows):
            print(f"WEB.md coverage table says {n_elements} elements, parse found {len(rows)}", file=sys.stderr)
            return 1
        if n_regions and n_regions != len(regions):
            print(f"WEB.md coverage table says {n_regions} regions, parse found {len(regions)}", file=sys.stderr)
            return 1

    unknown, unplaced = check_refs(rows)
    if unknown:
        print(f"shell.html references element IDs that are not in WEB.md: {', '.join(unknown)}", file=sys.stderr)
        return 1

    html = (
        SHELL.read_text(encoding="utf-8")
        .replace("/*__CSS__*/", (HERE / "tokens.css").read_text(encoding="utf-8").strip())
        .replace("/*__DATA__*/[]", "window.CRABBY_DATA = " + payload(rows))
        .replace("/*__JS__*/", (HERE / "app.js").read_text(encoding="utf-8").strip())
    )
    OUT.write_text(html, encoding="utf-8")

    counts = {s: sum(1 for r in rows if r["status"] == s) for s in STATUSES}
    rel = OUT.relative_to(HERE.parents[2])
    print(f"wrote {rel}: {len(rows)} elements across {len(regions)} regions")
    print("  status: " + ", ".join(f"{k}={v}" for k, v in counts.items() if v))
    print(f"  drawn in a screen: {len(rows) - len(unplaced)} · listed on the inventory sheet only: {len(unplaced)}")
    if unplaced:
        print("  inventory sheet holds: " + ", ".join(sorted(unplaced, key=lambda i: (i[1:3], i))))
    return 0


if __name__ == "__main__":
    sys.exit(main())
