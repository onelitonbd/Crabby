#!/usr/bin/env python3
"""Crabby planning-document consistency checks.

Run: python3 scripts/check-docs.py

These are documentation lint rules, not implementation tests. They cover the planning set and
the element inventories under `docs/review/`, and they encode the project's own process rules: an open decision must stay open, decision IDs must resolve, cross
references must point at real sections, and planning documents must not claim that
anything is implemented.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOC_GLOBS = ["*.md", "docs/*.md", "docs/review/*.md"]

ID_RE = re.compile(r"\b([DPO])-(\d{3})\b")
MD_LINK_RE = re.compile(r"\[[^\]]+\]\(([^)#]+\.[A-Za-z]+)(#[^)]*)?\)")
FILE_REF_RE = re.compile(r"`((?:[A-Za-z0-9_.-]+/)+[A-Za-z0-9_.-]+\.md)`|`([A-Za-z0-9_.-]+\.md)`")
# Referenced-but-unwritten documents are a known phase of this project: they are
# reported as advisory, because the plan explicitly defers them (DECISIONS.md section 8).
ADVISORY_FILENAMES = {
    "INTERFACES_AND_API.md", "UI_UX_SPEC.md", "DESIGN_SYSTEM.md", "ROADMAP.md",
    "DEVELOPMENT.md", "AGENTS.md", "LICENSE", "SKILL.md", "CHANGELOG.md", "CONSISTENCY_REVIEW.md",
    "WEB.md", "TUI.md", "CLI.md", "TELEGRAM.md",
}
SECTION_RE = re.compile(r"`([A-Z][A-Z_]+\.md)`\s*§(\d+(?:\.\d+)*)")
H2_RE = re.compile(r"^##\s+(\d+)(?:[^\n]*)$", re.M)
CAPABILITY_RE = re.compile(r"`([a-z]+(?:\.[a-z_]+)+(?::-root)?)`")

CLAIMS = [
    r"\bwe (?:have |had )?implemented\b",
    r"\bit is now implemented\b",
    r"\bcrabby (?:now )?(?:ships|supports)\b",
    r"\bhas been released\b",
    r"\bimplementation complete\b",
]


def docs() -> list[Path]:
    seen: dict[Path, None] = {}
    for pattern in DOC_GLOBS:
        for p in sorted(ROOT.glob(pattern)):
            seen.setdefault(p, None)
    return list(seen)


def text(p: Path) -> str:
    return p.read_text(encoding="utf-8")


REVIEW_STATUSES = {"PROPOSED", "ACCEPTED", "EDIT", "CUT", "?"}
# A review row ID is `<prefix><region>-<element>` (`W1-04`) or, for a named region,
# `<prefix>-<letter><element>` (`W-A1`); both grammars appear in `docs/review/WEB.md`.
REVIEW_ROW_RE = re.compile(r"^\|\s*([A-Z]{1,2}(?:\d+-\d+|-[A-Z]\d+))\s*\|(.*)\|\s*$")
REVIEW_REGION_RE = re.compile(r"^#{2,4} Region ([A-Z]{1,2}(?:\d+|-[A-Z]))\b", re.M)


def region_of(eid: str) -> str:
    m = re.match(r"^([A-Z]{1,2})(?:(\d+)|-([A-Z]))", eid)
    return f"{m.group(1)}{m.group(2) or ('-' + m.group(3))}" if m else ""


def inventory(body: str) -> list[tuple[str, str, str]]:
    """(id, status, region) for every element row in a review inventory.

    Region membership is decided by the last `Region <ID>` heading seen, so an element row that
    wandered out from under its heading is a finding rather than an invisible row.
    """
    out: list[tuple[str, str, str]] = []
    region = ""
    for line in body.splitlines():
        m = REVIEW_REGION_RE.match(line)
        if m:
            region = m.group(1)
            continue
        m = REVIEW_ROW_RE.match(line.strip())
        if not m:
            continue
        cells = [c.strip() for c in m.group(2).split("|")]
        out.append((m.group(1), cells[-1], region))
    return out


def review_elements(body: str) -> list[tuple[str, str]]:
    """(id, element-column text) for every row in a review inventory."""
    out: list[tuple[str, str]] = []
    for line in body.splitlines():
        m = REVIEW_ROW_RE.match(line.strip())
        if m:
            out.append((m.group(1), [c.strip() for c in m.group(2).split("|")][0]))
    return out


def defined_ids(decisions: str) -> dict[str, str]:
    """Rows like `| D-001 | ... |` in the decision register define those IDs."""
    out: dict[str, str] = {}
    for line in decisions.splitlines():
        m = re.match(r"^\|\s*([DPO]-\d{3})\s*\|(.*)", line)
        if m:
            out[m.group(1)] = m.group(2)
    return out


def main() -> int:
    problems: list[str] = []
    advisories: list[str] = []
    files = docs()
    if not files:
        print("no planning documents found", file=sys.stderr)
        return 1

    bodies = {p: text(p) for p in files}
    decisions_path = ROOT / "DECISIONS.md"
    if not decisions_path.exists():
        print("DECISIONS.md missing", file=sys.stderr)
        return 1
    defined = defined_ids(bodies[decisions_path])

    # 1. every referenced decision ID must be defined in the register
    for p, body in bodies.items():
        for tup in sorted(set(ID_RE.findall(body))):
            full = f"{tup[0]}-{tup[1]}"
            if full not in defined:
                problems.append(f"{p.name}: references undefined {full}")

    # 2. a decision row must not mark its own decision as unselected, and an O- row
    #    may not claim to be decided by something the register does not accept
    for ident, row in defined.items():
        if ident.startswith("D-") and re.search(r"\bunselected\b", row, flags=re.I):
            problems.append(f"DECISIONS.md: {ident} says the decision is unselected")
    accepted = {k for k, v in defined.items() if k.startswith("D-") and "Accepted" in v}
    for ident, row in defined.items():
        if not ident.startswith("O-"):
            continue
        for ref in re.findall(r"\bD-\d{3}\b", row):
            if ref not in accepted:
                problems.append(f"DECISIONS.md: {ident} cites {ref}, which is not Accepted")

    # 3. markdown links must resolve
    for p, body in bodies.items():
        for target, _anchor in MD_LINK_RE.findall(body):
            if target.startswith(("http://", "https://", "mailto:")):
                continue
            if not (p.parent / target).exists():
                problems.append(f"{p.name}: broken link -> {target}")

    # 4. `file.md` references and `file.md` §N section references must exist
    sec_index = {
        name: {n for n in H2_RE.findall(body)}
        for name, body in bodies.items()
    }
    for p, body in bodies.items():
        for ref in {a or b for a, b in set(FILE_REF_RE.findall(body))}:
            if ref == "SKILL.md":
                continue  # extension convention, not a document reference
            candidate = (p.parent / ref) if not ref.startswith("docs/") else ROOT / ref
            if not candidate.exists():
                candidate = ROOT / ref
            if not candidate.exists():
                (advisories if Path(ref).name in ADVISORY_FILENAMES else problems).append(
                    f"{p.name}: references missing file {ref}"
                )
        for fname, sec in set(SECTION_RE.findall(body)):
            target = ROOT / fname
            if not target.exists() or fname not in sec_index:
                continue
            if sec.split(".")[0] not in sec_index[fname]:
                problems.append(f"{p.name}: {fname} has no section §{sec}")

    # 5. planning docs must not claim implementation
    for p, body in bodies.items():
        for pat in CLAIMS:
            for m in re.finditer(pat, body, flags=re.I):
                line = body[: m.start()].count("\n") + 1
                problems.append(f"{p.name}:{line}: claims implementation ({m.group(0)!r})")

    # 6. security capability vocabulary must cover every capability referenced elsewhere
    sec = bodies[ROOT / "SECURITY.md"]
    vocab_start, vocab_end = sec.find("### 6.1"), sec.find("### 6.2")
    if vocab_start > 0:
        vocab = set()
        for line in sec[vocab_start:vocab_end].splitlines():
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            if len(cells) < 2:
                continue
            for tok in re.findall(r"`([^`]+)`", cells[0]):
                tok = tok.split(":<")[0].split(":")[0]
                vocab.add(tok)
                # `group.<member>` declares a family; members listed in the same row
                # (e.g. device.sms, device.camera) are valid capabilities too.
                if "<" in tok:
                    family = tok.split(".")[0]
                    for member in re.findall(rf"`({family}\.[a-z_]+)`", line):
                        vocab.add(member)
        # Only prefixes the vocabulary establishes are treated as capability namespaces,
        # so `file.read` (a tool) is not mistaken for `fs.read` (a capability).
        prefixes = {v.split(".")[0] for v in vocab}
        for p, body in bodies.items():
            if p.name == "SECURITY.md":
                continue
            # Only capability positions are checked: the "Capability" table column and
            # inline `requires \`x.y\`` phrasing.
            sites = re.findall(r"^\|[^|]*\|\s*`([^`]+)`", body, flags=re.M)
            # never across a table cell boundary: `| Capability summary | \`fs: workspace\`` is UI copy,
            # not a capability grant, and reading it as one produced a false positive.
            sites += re.findall(r"(?:capabilit(?:y|ies)[^`|]{0,40})`([^`]+)`", body, flags=re.I)
            for cap in sorted(set(sites)):
                base = cap.split(":")[0]
                if base.split(".")[0] not in prefixes:
                    continue
                if base not in vocab:
                    problems.append(
                        f"{p.name}: capability `{cap}` is not in the SECURITY.md §6.1 vocabulary"
                    )

    if advisories:
        print(f"! {len(advisories)} advisory item(s) (documents planned but not yet written):")
        for a in sorted(set(advisories)):
            print(f"  - {a}")

    # 7. traceability: every accepted decision must be enforced by at least one document,
    #    and the map in DECISIONS.md section 4A must not invent IDs that do not exist.
    d_ids = {k for k, v in defined.items() if k.startswith("D-") and "Accepted" in v}
    trace_match = re.search(r"## 4A\. Traceability.*?\n## 4B\.", bodies[decisions_path], flags=re.S)
    if trace_match:
        mapped = set()
        doc_names = set()
        for line in trace_match.group(0).splitlines():
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            if len(cells) < 2:
                continue
            doc_names |= {d for d in re.findall(r"`([A-Za-z0-9_./]+\.md)`", cells[0])}
            mapped |= {f"{a}-{b}" for a, b in ID_RE.findall(cells[1]) if a == "D"}
        for ident in sorted(d_ids - mapped):
            problems.append(
                f"DECISIONS.md: {ident} is Accepted but absent from the section 4A traceability map"
            )
        for ident in sorted(mapped - d_ids):
            problems.append(f"DECISIONS.md: traceability map cites {ident}, which is not an Accepted row")
        for fname in sorted(doc_names):
            if fname not in bodies and not (ROOT / fname).exists():
                problems.append(f"DECISIONS.md: traceability map names missing document {fname}")
    elif d_ids:
        problems.append("DECISIONS.md: section 4A traceability map is missing")

    # 8. element inventories (`docs/review/*.md`): every row needs a region, a status from the
    #    fixed set, and a unique ID; the file's own coverage table and the section 4B progress row
    #    must equal the rows that actually exist. D-055 makes review measurable, which only means
    #    something if the counts cannot drift away from the file they describe.
    review_dir = ROOT / "docs" / "review"
    prog_rows: dict[str, list[str]] = {}
    progress = re.search(r"## 4B\..*?\n## \d", bodies[decisions_path], flags=re.S)
    if progress:
        for line in progress.group(0).splitlines():
            m = re.match(r"^\|\s*`docs/review/([A-Z_]+\.md)`\s*\|(.*)\|\s*$", line)
            if m:
                prog_rows[m.group(1)] = [c.strip() for c in m.group(2).split("|")]
    if review_dir.is_dir():
        for f in sorted(review_dir.glob("*.md")):
            body = text(f)
            rows = inventory(body)
            if not rows:
                continue
            where = f"docs/review/{f.name}"
            heads = re.findall(REVIEW_REGION_RE, body)
            by_region: dict[str, int] = {}
            for rid, st, region in rows:
                by_region[region] = by_region.get(region, 0) + 1
                if st not in REVIEW_STATUSES:
                    problems.append(
                        f"{where}: row {rid} status {st!r} is not one of "
                        + ", ".join(sorted(REVIEW_STATUSES))
                    )
                if region not in heads:
                    problems.append(f"{where}: row {rid} sits under no `Region` heading")
            ids = [r[0] for r in rows]
            for dup in sorted({i for i in ids if ids.count(i) > 1}):
                problems.append(f"{where}: element ID {dup} is defined twice")
            for h in heads:
                if not by_region.get(h):
                    problems.append(f"{where}: region {h} has a heading but no element rows")
                elif region_of(ids[heads and 0][0]) and h not in {region_of(i) for i in ids}:
                    problems.append(f"{where}: region {h} is declared but holds no rows")
            for line in body.splitlines():
                m = re.match(r"^\|\s*\*{0,2}[^|]+\*{0,2}\s*\|\s*([A-Z][^|]*?)\s*\|\s*(\d+)\s*\|", line)
                if m and re.match(r"^[A-Z]{1,2}(?:\d+|-[A-Z])$", m.group(1).split(",")[0].strip()):
                    want = sum(by_region.get(r.strip(), 0) for r in m.group(1).split(","))
                    if str(want) != m.group(2):
                        problems.append(
                            f"{where}: coverage row {m.group(1)!r} claims {m.group(2)} elements, the regions have {want}"
                        )
            total = re.search(
                r"\|\s*\*\*Total\*\*\s*\|\s*\*\*(\d+) regions?\*\*\s*\|\s*\*\*(\d+) elements\*\*", body
            )
            if total:
                if int(total.group(1)) != len(heads):
                    problems.append(
                        f"{where}: coverage table claims {total.group(1)} regions, file has {len(heads)}"
                    )
                if int(total.group(2)) != len(rows):
                    problems.append(
                        f"{where}: coverage table claims {total.group(2)} elements, file has {len(rows)}"
                    )
            approved = sum(1 for _i, st, _r in rows if st == "ACCEPTED")
            cells = prog_rows.get(f.name)
            if cells is None:
                problems.append(f"DECISIONS.md section 4B has no progress row for {where}")
            else:
                want = [str(len(rows)), str(approved), str(len(rows) - approved)]
                if cells[1:4] != want:
                    problems.append(
                        f"DECISIONS.md section 4B: {where} should read {cells[0]} | {' | '.join(want)}"
                        f" (found: {len(rows)} rows, {approved} accepted)"
                    )

    # 9. the counter table in DECISIONS.md must be read off the register, not remembered: the
    #    same numbers have drifted twice by hand.
    # the review inventories are linted too, but "planning docs written" counts the planning set
    n_planning = sum(1 for p in files if "review" not in p.relative_to(ROOT).parts)
    n_acc = sum(1 for k, v in defined.items() if k.startswith("D-") and "Accepted" in v)
    n_pro = sum(1 for k in defined if k.startswith("P-"))
    n_open = sum(1 for k in defined if k.startswith("O-"))
    last_acc = max((k for k in defined if k.startswith("D-")), default="D-000")
    last_pro = max((k for k in defined if k.startswith("P-")), default="P-000")
    first_acc = min((k for k in defined if k.startswith("D-")), default="D-001")
    wants = {
        "Accepted decisions": f"{n_acc} ({first_acc}…{last_acc})",
        "Proposed technical choices": f"{n_pro} ({'P-001'}…{last_pro})",
    }
    for label, want in wants.items():
        m = re.search(rf"^\|\s*{re.escape(label)}\s*\|([^|\n]*)\|", bodies[decisions_path], flags=re.M)
        if not m:
            problems.append(f"DECISIONS.md: counter row {label!r} is missing")
        elif m.group(1).strip() != want:
            problems.append(f"DECISIONS.md: counter {label!r} reads {m.group(1).strip()!r}, register says {want!r}")
    for label, want in [
        ("Open / needs-validation items", f"{n_open} tracked"),
        ("Planning docs written", f"{n_planning} —"),
    ]:
        m = re.search(rf"^\|\s*{re.escape(label)}\s*\|([^|\n]*)\|", bodies[decisions_path], flags=re.M)
        if m and not m.group(1).strip().startswith(want):
            problems.append(f"DECISIONS.md: counter {label!r} should start with {want!r}")


    # 10. the command surface must be the same set in every direction. "A command cannot exist in one interface
    #     only" is prose in `docs/INTERFACES_AND_API.md`; here it is a set comparison. Two things it caught on the
    #     first run: §7.1 listed fewer commands than §8 required, and `docs/review/TELEGRAM.md` named a command in a
    #     sentence instead of as an element.
    iface = bodies.get(ROOT / "docs" / "INTERFACES_AND_API.md", "")
    cli_md = bodies.get(ROOT / "docs" / "review" / "CLI.md", "")
    tg_md = bodies.get(ROOT / "docs" / "review" / "TELEGRAM.md", "")

    def first_table(body: str, heading: str) -> list[list[str]]:
        """The first pipe table after `heading`, skipping whatever prose sits between them."""
        at = body.find(heading)
        if at < 0:
            return []
        rows = []
        for line in body[at:].splitlines():
            if line.startswith("|"):
                if not set(line) <= set("|- "):
                    rows.append([c.strip() for c in line.strip().strip("|").split("|")])
            elif rows:
                break
        return rows

    cmd_cell = re.compile(r"`([a-z][a-z0-9-]*)(?:[ /<][^`]*)?`")
    cli_nouns: set[str] = set()
    tg_spec: set[str] = set()
    for row in first_table(iface, "### 7.1 CLI"):
        for cell in row[1:] if len(row) > 1 else []:
            cli_nouns |= set(cmd_cell.findall(cell))
    for row in first_table(iface, "## 8. Feature Parity Matrix"):
        if len(row) < 6:
            continue
        cli_nouns |= set(cmd_cell.findall(row[2]))
        tg_spec |= {c for c in re.findall(r"`/([a-z]+)", row[5])}
    sec74 = re.search(r"^### 7\.4 Telegram\n(.*?)\n## 8", iface, flags=re.S | re.M)
    if sec74:
        tg_spec |= {c for c in re.findall(r"`/([a-z]+)", sec74.group(1))}
    if not cli_nouns or not tg_spec:
        problems.append(
            "scripts/check-docs.py: the parity check read no commands out of `docs/INTERFACES_AND_API.md` — the "
            "§7.1/§8 tables changed shape, so the check itself needs updating"
        )
    # an inventory names a command in the element column, so that is where it has to be found: matching anywhere
    # in the file let "context window" stand in for `crabby context show`, and a build-tool mention for `tools ls`.
    cli_words = {w for _, el in review_elements(cli_md) for w in re.findall(r"[a-z][a-z0-9-]*", el.lower())}
    for noun in sorted(cli_nouns - cli_words):
        problems.append(
            f"docs/review/CLI.md: no row names the command `{noun}` — the grammar and the parity matrix both "
            f"require it, so the CLI inventory has to carry it as an element"
        )
    tg_inv = {m.group(1) for _, el in review_elements(tg_md) if (m := re.match(r"^/([a-z]+)$", el))}
    for cmd in sorted(tg_spec - tg_inv):
        problems.append(f"docs/review/TELEGRAM.md: command /{cmd} is required by §7.4/§8 but no row names it")
    for cmd in sorted(tg_inv - tg_spec):
        problems.append(f"docs/review/TELEGRAM.md: command /{cmd} is proposed here but absent from §7.4's list")

    if problems:
        print(f"✗ {len(problems)} documentation problem(s):")
        for prob in problems:
            print(f"  - {prob}")
        return 1

    n_inv = sum(1 for p in files if p.parent.name == "review" and p.stem in {"WEB", "TUI", "CLI", "TELEGRAM"})
    n_other = len(files) - n_planning - n_inv
    detail = f"{n_planning} planning + {n_inv} element inventories"
    if n_other:
        detail += f" + {n_other} index"

    print(f"✓ {len(files)} documents consistent ({detail})")
    print(f"  decisions: {sum(1 for k in defined if k.startswith('D-'))} accepted · "
          f"{sum(1 for k in defined if k.startswith('P-'))} proposed · "
          f"{sum(1 for k in defined if k.startswith('O-'))} open")
    return 0


if __name__ == "__main__":
    sys.exit(main())
