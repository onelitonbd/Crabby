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
