#!/usr/bin/env python3
"""Crabby planning-document consistency checks.

Run: python3 scripts/check-docs.py

These are documentation lint rules, not implementation tests. They encode the project's
own process rules: an open decision must stay open, decision IDs must resolve, cross
references must point at real sections, and planning documents must not claim that
anything is implemented.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOC_GLOBS = ["*.md", "docs/*.md"]

ID_RE = re.compile(r"\b([DPO])-(\d{3})\b")
MD_LINK_RE = re.compile(r"\[[^\]]+\]\(([^)#]+\.[A-Za-z]+)(#[^)]*)?\)")
FILE_REF_RE = re.compile(r"`((?:[A-Za-z0-9_.-]+/)+[A-Za-z0-9_.-]+\.md)`|`([A-Za-z0-9_.-]+\.md)`")
# Referenced-but-unwritten documents are a known phase of this project: they are
# reported as advisory, because the plan explicitly defers them (DECISIONS.md section 8).
ADVISORY_FILENAMES = {
    "INTERFACES_AND_API.md", "UI_UX_SPEC.md", "DESIGN_SYSTEM.md", "ROADMAP.md",
    "DEVELOPMENT.md", "AGENTS.md", "LICENSE", "SKILL.md", "CHANGELOG.md", "CONSISTENCY_REVIEW.md",
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
        for ident in sorted(set(ID_RE.findall(body)) and set()):
            full = f"{ident[0]}-{ident[1]}"
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
            sites += re.findall(r"(?:capabilit(?:y|ies)[^`]{0,40})`([^`]+)`", body, flags=re.I)
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
    trace_match = re.search(r"## 4A\..*?\n## 5\.", bodies[decisions_path], flags=re.S)
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

    if problems:
        print(f"✗ {len(problems)} documentation problem(s):")
        for prob in problems:
            print(f"  - {prob}")
        return 1

    print(f"✓ {len(files)} planning documents consistent")
    print(f"  decisions: {sum(1 for k in defined if k.startswith('D-'))} accepted · "
          f"{sum(1 for k in defined if k.startswith('P-'))} proposed · "
          f"{sum(1 for k in defined if k.startswith('O-'))} open")
    return 0


if __name__ == "__main__":
    sys.exit(main())
