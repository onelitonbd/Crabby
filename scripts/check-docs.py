#!/usr/bin/env python3
"""Crabby planning-document consistency checks.

Run: python3 scripts/check-docs.py

These are documentation lint rules, not implementation tests. They cover the planning set and
the element inventories under `docs/review/`, and they encode the project's own process rules: an open decision must stay open, decision IDs must resolve, cross
references must point at real sections, and planning documents must not claim that
anything is implemented.  Markdown tables must be rectangular, because a row that splits on an unescaped `|` is read
by a generator as an extra column.
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
# Two referenced files are unwritten on purpose, and only these two are forgiven: the license arrives with
# distribution and the changelog with the first release (docs/ROADMAP.md section 11). Everything else that used to be
# on this advisory list has been written, so a reference to a missing planning document is now a failure rather than
# a note — which is how the F-14 class of defect (a document referring to a section that quietly no longer exists)
# gets caught instead of accumulated.
ADVISORY_FILENAMES = {"LICENSE", "CHANGELOG.md"}
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
        # Deduplicated *before* the count is printed, not after: the list beneath this line is `sorted(set(...))`, and
        # counting the raw list advertised "4 advisory item(s)" above three bullets. A count that does not match the
        # list it generated reads as output the tool failed to print — which is F-27's discipline turned on the checker
        # itself, and is what F-40 records.
        unique = sorted(set(advisories))
        print(f"! {len(unique)} advisory item(s) (documents planned but not yet written):")
        for a in unique:
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


    # 10. retired here, on purpose: the command-surface and tool-registry comparison moved to `scripts/parity.ts` in
    #     M1c, because a Python check can read the documents but cannot import `packages/policy`'s registry or
    #     `apps/cli`'s grammar. Reading those files as text is how the parity matrix stayed able to drift: the check
    #     compared prose with prose, and both could be wrong together. `npm run test:parity` (CI's `test:parity` job)
    #     now compares the documents against the code that runs, and also regenerates §8's table from its annotations.
    #     Rules 11 and 12 stay below, because they check whether `docs/review/*` inventories are *complete*, which is a
    #     property of the documents alone and needs no import of anything.
    iface = bodies.get(ROOT / "docs" / "INTERFACES_AND_API.md", "")
    cli_md = bodies.get(ROOT / "docs" / "review" / "CLI.md", "")
    tg_md = bodies.get(ROOT / "docs" / "review" / "TELEGRAM.md", "")

    # 11. a screen that has no region has no elements, and an element-less screen is deleted by the next
    #     regeneration pass (`docs/UI_UX_SPEC.md` §2.2 and the TUI required views in `docs/INTERFACES_AND_API.md`
    #     §7.2 are the list of things that must survive). This rule exists because the Sessions screen had zero
    #     rows in all four inventories until F-10 — nothing else in the check could see it.
    SCREEN_ALIASES = {
        "Chat": r"message list|composer|chat",
        "Tasks": r"task list|tasks",
        "Task detail": r"task detail",
        "Approvals": r"approval",
        "Sessions": r"session",
        "Context": r"context",
        "Memory": r"memory",
        "Providers": r"provider",
        "Models": r"model",
        "Tools": r"\btool",
        "Extensions": r"extension",
        "Config": r"settings|config",
        "Logs / Audit": r"logs|audit",
        "Access": r"access",
        "Onboarding": r"onboarding|first.run|first run",
        "Scheduled": r"jobs|scheduled",
    }
    spec_doc = bodies.get(ROOT / "docs" / "UI_UX_SPEC.md", "")
    web = bodies.get(ROOT / "docs" / "review" / "WEB.md", "")
    web_titles = " ".join(re.findall(r"^#{2,4} Region [A-Z]{1,2}(?:\d+|-[A-Z]) \u2014 (.*)$", web, flags=re.M)).lower()
    sec22 = re.search(r"^### 2\.2 Screens\n(.*?)\n### ", spec_doc, flags=re.S | re.M)
    screens = re.findall(r"^\| \*\*([^|*]+)\*\* \|", sec22.group(1) if sec22 else "", flags=re.M)
    if not sec22:
        problems.append("scripts/check-docs.py: `docs/UI_UX_SPEC.md` §2.2 is missing or reshaped, so the screen "
                        "check has nothing to read")
    for screen in screens:
        name = screen.strip()
        pat = SCREEN_ALIASES.get(name)
        if pat is None:
            problems.append(
                f"docs/UI_UX_SPEC.md §2.2 lists a screen {name!r} that docs/review/WEB.md cannot be checked "
                f"against: add it to SCREEN_ALIASES in scripts/check-docs.py, or give the region its own title"
            )
        elif not re.search(pat, web_titles):
            problems.append(f"docs/review/WEB.md: no region covers the {name!r} screen — an element-less screen "
                            f"disappears when the spec is regenerated from these files")
    tui = bodies.get(ROOT / "docs" / "review" / "TUI.md", "")
    tui_titles = " ".join(re.findall(r"^#{2,4} Region T(?:\d+|-[A-Z]) \u2014 (.*)$", tui, flags=re.M)).lower()
    views = re.search(r"Required views: (.*?)\n", iface, flags=re.S)
    if views:
        wanted = {"conversation": r"message list|chat", "task list": r"task list", "task detail": r"task detail",
                  "approval prompt": r"approval", "tool activity": r"tool|message list",
                  "session switcher": r"session", "provider/model picker": r"provider|model"}
        for key, pat in wanted.items():
            if key in views.group(1).lower() and not re.search(pat, tui_titles):
                problems.append(f"docs/review/TUI.md: §7.2 requires {key!r} and no region covers it")


    # 12. every resource the API exposes has to be visible in every interface, or be explicitly absent there.
    #     F-08 found commands missing, F-10 found a screen missing, F-11 found a whole resource (`/jobs`) with routes
    #     and a security policy and no UI anywhere. The three were the same cause: routes, capability matrix, and screen
    #     list were hand-maintained lists that nobody cross-checked. This closes the loop from the API side.
    RESOURCE_PATTERNS = {
        "admin": r"lifecycle|restart|shutdown",
        "approvals": r"approval",
        "audit": r"audit",
        "auth": r"pair|revoke|client",
        "config": r"config|settings",
        "diagnostics": r"diagnostic|sanitized",
        "events": r"stream|tail|watch|reconnect",
        "export": r"export|download",
        "extensions": r"extension|\bext\b",
        "health": r"health|reachable|readiness",
        "jobs": r"job|schedul",
        "logs": r"\blog",
        "memory": r"memory",
        "models": r"\bmodel",
        "providers": r"provider",
        "sessions": r"session",
        "status": r"\bstatus",
        "tasks": r"\btask",
        "tools": r"\btool",
        "tunnel": r"tunnel",
    }
    res_names = set()
    for route in set(re.findall(r"`(?:GET|POST|PATCH|PUT|DELETE) (/[a-zA-Z0-9{}/_.-]*)`", iface)):
        seg = [p for p in route.split("/") if p and not p.startswith("{")]
        if seg:
            res_names.add(seg[0])
    unmapped = sorted(res_names - set(RESOURCE_PATTERNS))
    if unmapped:
        problems.append(
            "docs/INTERFACES_AND_API.md exposes routes for " + ", ".join(unmapped) + " and check-docs.py has no "
            "pattern for them: give the resource elements in all four inventories, then add it to RESOURCE_PATTERNS"
        )
    for name in sorted(res_names & set(RESOURCE_PATTERNS)):
        pat = RESOURCE_PATTERNS[name]
        for key, body in (("WEB.md", web), ("TUI.md", tui), ("CLI.md", cli_md), ("TELEGRAM.md", tg_md)):
            if not re.search(pat, body, flags=re.I):
                problems.append(
                    f"docs/review/{key}: the `{name}` resource has routes in the API and nothing here — an "
                    f"interface either carries the capability or records why it does not"
                )

    # 13. the palette table in docs/DESIGN_SYSTEM.md §2.3 states measured ratios, so they are measured
    #     here as well. A hex can be edited without measuring it, and a minimum can be lowered quietly;
    #     both are caught by recomputing WCAG 2.2 contrast from the hexes in the table.
    design = bodies.get(ROOT / "docs" / "DESIGN_SYSTEM.md", "")
    m = re.search(r"### 2\.3 Values.*?\n(###|## 3\.)", design, flags=re.S)
    if not m:
        problems.append("docs/DESIGN_SYSTEM.md: §2.3 (measured palette) is missing")
    else:
        def _lum(h):
            h = h.lstrip('#')
            c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
            c = [(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4) for v in c]
            return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]

        def _ratio(a, b):
            la, lb = _lum(a), _lum(b)
            hi, lo = max(la, lb), min(la, lb)
            return (hi + 0.05) / (lo + 0.05)

        palette, surfaces, raw = {}, {}, {}
        for line in m.group(0).splitlines():
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            if len(cells) != 7 or not cells[0].startswith("`"):
                continue
            tok = cells[0].strip("`")
            vals = {}
            for label, col in (("dark", 1), ("light", 2)):
                hexv = cells[col].strip("`")
                if not re.fullmatch(r"#[0-9a-f]{6}", hexv):
                    problems.append(f"docs/DESIGN_SYSTEM.md: {tok} {label} value `{hexv}` is not a 6-digit lowercase hex")
                    continue
                vals[label] = hexv
            if len(vals) != 2:
                continue
            palette[tok] = vals
            raw[tok] = cells
            if tok.startswith("bg."):
                surfaces[tok] = vals
        wanted = [t for t in ("bg.base", "bg.raised", "bg.overlay") if t not in surfaces]
        if wanted:
            problems.append(f"docs/DESIGN_SYSTEM.md: §2.3 needs all three surfaces to measure against; missing {', '.join(wanted)}")
        else:
            for tok, vals in palette.items():
                if tok.startswith("bg."):
                    continue
                minimum, shown_d, shown_l = raw[tok][3], raw[tok][4], raw[tok][5]
                if tok.split(".")[0] in ("fg", "accent", "state", "risk") and float(minimum) < 4.5:
                    problems.append(
                        f"docs/DESIGN_SYSTEM.md: {tok} is text and declares a minimum of {minimum}; WCAG 2.2 AA "
                        f"body text is 4.5 — a floor may be raised here, never lowered"
                    )
                if minimum == "—":
                    if shown_d != "—" or shown_l != "—":
                        problems.append(f"docs/DESIGN_SYSTEM.md: {tok} is declared exempt but still prints ratios")
                    continue
                for label, shown in (("dark", shown_d), ("light", shown_l)):
                    worst = min(_ratio(vals[label], surfaces[s][label]) for s in ("bg.base", "bg.raised", "bg.overlay"))
                    try:
                        stated = float(shown)
                    except ValueError:
                        problems.append(f"docs/DESIGN_SYSTEM.md: {tok} {label} ratio `{shown}` is not a number")
                        continue
                    if abs(stated - worst) > 0.02:
                        problems.append(
                            f"docs/DESIGN_SYSTEM.md: {tok} {label} prints {stated:.2f} but the hexes measure {worst:.2f} "
                            f"— the worst surface, not bg.base, is what a token has to clear"
                        )
                    if worst < float(minimum) - 0.005:
                        problems.append(
                            f"docs/DESIGN_SYSTEM.md: {tok} {label} measures {worst:.2f} against its stated minimum {minimum}"
                        )

    # 14. a `P-` row is a proposal that something else has to validate. Once an Accepted decision covers the
    #     same choice, the proposal must move to Accepted/Superseded/Needs Validation and name its blocker —
    #     the F-17 class of defect is a `Proposed` row nobody was still deciding.
    for line in bodies[decisions_path].splitlines():
        m = re.match(r"^\|\s*(P-\d{3})\s*\|(.*)\|\s*$", line)
        if not m:
            continue
        cells = [c.strip() for c in m.group(2).split("|")]
        status = cells[-1] if cells else ""
        if not status.startswith("Proposed"):
            continue
        blockers = re.findall(r"O-\d{3}", m.group(2))
        live = [b for b in blockers if not re.match(
            r"^\|\s*" + b + r"\s*\|[^|]*\|\s*(\*\*(Closed|Mostly closed|Narrowed)|Accepted in D-)",
            bodies[decisions_path], flags=re.M)]
        if not blockers or not live:
            problems.append(
                f"DECISIONS.md: {m.group(1)} is still Proposed without an open blocker — a proposal must cite the "
                f"`O-` row that is waiting for evidence, or move to Accepted / Superseded / Needs Validation"
            )

    # 15. a section that enumerates open questions is a second register (F-14, F-18): the answers arrive in the same
    #     commit set and nobody re-reads the list. Every bullet under such a heading must name the id that owns it —
    #     an accepted decision, a tracked open item, or a section of the document itself — because a bullet that cites
    #     nothing is either already answered or too vague to close. This is why an open-questions list must stay short:
    #     the shorter it is, the more each line has to justify itself.
    open_section = re.compile(r"^#{2,3}\s*(?:\d+\.\s*)?(Open Decisions|Open Items|Unresolved|"
                              r"Topics[^\n]{0,40}finalized|Remaining[^\n]{0,30}Open)[^\n]*$", re.M)
    heading_level = re.compile(r"^(#{1,6})\s")
    for path, body in bodies.items():
        if "review" in path.parts:
            continue
        for m in open_section.finditer(body):
            level = len(heading_level.match(m.group(0)).group(1))
            tail = body[m.end():]
            nxt = re.search(r"^#{1,%d}\s" % level, tail, re.M)
            section = tail[:nxt.start()] if nxt else tail
            lines = section.splitlines()
            # a GFM table's header row is the line directly above the separator; it cannot cite anything
            headers = {i - 1 for i, ln in enumerate(lines) if re.match(r"^\|\s*-{2,}", ln)}
            for i, line in enumerate(lines):
                if line.startswith("|") and (i in headers or re.match(r"^\|\s*-{2,}", line)):
                    continue                      # header row and separator row carry no citation duty
                if not line.startswith(("- ", "|")):
                    continue
                # a register id or a section pointer both name an owner; a bare "- Some topic." names nothing
                if not re.search(r"[DPO]-\d{3}|§", line):
                    problems.append(
                        f"{path.relative_to(ROOT)}: an item under {m.group(0).lstrip('#').strip()!r} cites no decision "
                        f"or open item — {line[:80]!r}. A document that lists open questions is a second register: "
                        f"name the id that answers it, or the evidence it waits for (and then the id that owns that)"
                    )


    # 16. every row of a Markdown table must have as many cells as its header. An unescaped `|` inside a cell splits
    #     the row, and the row that breaks is not the row that reads wrong: the cell after it shifts, and a generator
    #     that parses the table (docs/review/mockups/build.py) invents a column. Four rows across four documents were
    #     in that state when this rule was written, one of them in the Web inventory feeding the review mockup (F-21).
    for path, body in bodies.items():
        lines = body.splitlines()
        infence = False
        i = 0
        while i < len(lines):
            if lines[i].startswith("```"):
                infence = not infence
                i += 1
                continue
            is_sep = i + 1 < len(lines) and not infence and re.match(r"^\|\s*:?-{2,}[\s:|-]*\|$", lines[i + 1])
            if lines[i].startswith("|") and is_sep:
                def cells(line: str) -> int:
                    return len(re.split(r"(?<!\\)\|", line)) - 2
                want = cells(lines[i])
                if cells(lines[i + 1]) != want:
                    problems.append(
                        f"{path.relative_to(ROOT)}:{i + 2}: table separator has {cells(lines[i + 1])} cells but the "
                        f"header has {want}"
                    )
                j = i
                while j < len(lines) and lines[j].startswith("|"):
                    if cells(lines[j]) != want:
                        problems.append(
                            f"{path.relative_to(ROOT)}:{j + 1}: row has {cells(lines[j])} cells but this table has "
                            f"{want} — escape a literal pipe as \\| or close the row: {lines[j][:70].strip()}"
                        )
                    j += 1
                i = j
                continue
            i += 1


    # 17. a findings range quoted in another document is a second copy of `docs/CONSISTENCY_REVIEW.md`'s numbering, and
    #     a second copy is what F-20 is about. "F-01…F-16" was true for exactly one commit.
    review = bodies.get(ROOT / "docs" / "CONSISTENCY_REVIEW.md") or text(ROOT / "docs" / "CONSISTENCY_REVIEW.md")
    max_f = max((int(n) for n in re.findall(r"^### (?:F-)?(\d+) ", review, flags=re.M)), default=0)
    if max_f:
        for path, body in bodies.items():
            for m in re.finditer(r"F-01…F-(\d+)", body):
                if int(m.group(1)) != max_f:
                    problems.append(
                        f"{path.relative_to(ROOT)}: cites findings up to F-{int(m.group(1)):02d} but "
                        f"`docs/CONSISTENCY_REVIEW.md` has F-{max_f:02d} — quote the real range, or say 'all findings' "
                        f"if the count is the point"
                    )


    # 18. a count written inside `docs/review/` must equal the count the rows produce (F-22). An inventory is read by
    #     a generator as well as a human, so "lists all 28 commands" in a row is not prose, it is a second copy of a
    #     table — and the second copy was stale in two files while their coverage tables were correct.
    review_files = [p for p in files if p.parent.name == "review" and p.stem in {"WEB", "TUI", "CLI", "TELEGRAM"}]
    for path in review_files:
        body = text(path)
        rows = inventory(body)
        heads = re.findall(REVIEW_REGION_RE, body)
        defined_commands = len({m.group(1) for m in re.finditer(r"^\|\s*[A-Z][A-Z0-9-]*\s*\|\s*(/[a-z][a-z0-9-]*)\s*\|", body, re.M)})
        approved = sum(1 for _i, st, _r in rows if st == "ACCEPTED")
        for m in re.finditer(r"\b(\d{1,4}) (?:slash )?commands\b", body):
            if defined_commands and int(m.group(1)) != defined_commands:
                problems.append(
                    f"{path.relative_to(ROOT)}: says {m.group(1)} commands, the file defines {defined_commands}"
                )
        for m in re.finditer(r"\b(\d{1,4}) rows to read\b", body):
            want = len(rows) - approved
            if int(m.group(1)) != want:
                problems.append(
                    f"{path.relative_to(ROOT)}: says {m.group(1)} rows await review, {want} are not `ACCEPTED`"
                )
        for m in re.finditer(r"\*\*(\d+) regions\*\*", body):
            if int(m.group(1)) != len(heads):
                problems.append(
                    f"{path.relative_to(ROOT)}: a coverage row claims {m.group(1)} regions, the file has {len(heads)}"
                )


    # 18b. and an element count quoted *outside* `docs/review/` is the same second copy in a more dangerous place: a
    #      summary document is what a reader trusts. `docs/UI_UX_SPEC.md` had "Web 161, TUI 185, CLI 138, Telegram 106"
    #      for three rounds after those files grew (F-24). Any such number must be one the inventories produce today.
    inv_sizes = {}
    for stem in ("WEB", "TUI", "CLI", "TELEGRAM"):
        f = review_dir / f"{stem}.md"
        if f.is_file():
            inv_sizes[stem] = len(inventory(text(f)))
    valid = {str(sum(inv_sizes.values()))} | {str(v) for v in inv_sizes.values()}
    iface_re = re.compile(r"\b(Web|TUI|CLI|Telegram)\s+(\d{2,4})(?=[,\s)]|$)")
    bare_re = re.compile(r"\b(\d{2,4})\s+elements\b")
    for path, body in bodies.items():
        if "review" in path.relative_to(ROOT).parts or path.name == "DECISIONS.md":
            continue
        def stale(matches) -> list[str]:
            out = []
            for m in matches:
                # a *region* row count is a different fact and cannot drift the same way: it is written next to the
                # region it counts, and "region W15 (11 elements: …)" must not read as a claim about WEB.md's size
                if re.search(r"region\b[^.\n]{0,24}$", body[max(0, m.start() - 40):m.start()], re.I):
                    continue
                if m.group(1) not in valid:
                    out.append(m.group(1))
            return out

        def iface_stale(matches):
            out = []
            for m in matches:
                if re.search(r"region\b[^.\n]{0,24}$", body[max(0, m.start() - 40):m.start()], re.I):
                    continue
                # strict only when the sentence says what is being counted, so "Web 1024" (a breakpoint) is not read
                # as a row count — but "Web 161, TUI 185 … elements" is, even when 185 belongs to a different file
                ahead = body[m.start():body.find(".", m.end()) + 1 if "." in body[m.end():m.end() + 120] else m.end() + 120]
                if not re.search(r"\b(elements?|rows?)\b", ahead, re.I):
                    continue
                want = str(inv_sizes.get(m.group(1).upper(), ""))
                if m.group(2) != want:
                    out.append(m.group(2))
            return out

        quoted = iface_stale(iface_re.finditer(body)) + stale(bare_re.finditer(body))
        for num in sorted(set(quoted)):
            problems.append(
                f"{path.relative_to(ROOT)}: quotes {num} elements where the inventories hold "
                f"{', '.join(f'{k} {v}' for k, v in sorted(inv_sizes.items()))} (total {sum(inv_sizes.values())}) — a "
                f"summary document is what a reader trusts, so point at `docs/review/` instead of restating a count"
            )

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
