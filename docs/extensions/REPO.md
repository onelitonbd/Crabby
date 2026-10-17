# File-backed extension repo

Crabby's import pipeline validates and stages third-party extension content on
disk under `<stateDir>/extensions`. The repo keeps two things per imported skill:

- the **converted content** (`SKILL.md` with honored frontmatter + body),
- the **original** under `originals/` (verbatim, never loaded), and
- a **conversion report** under `reports/` (JSON: mapped / displayed /
  reinterpreted / unknown fields, scan result, `allowedTools.granted: false`).

First-party extension behaviors live in-repo and are not installed through this
pipeline; see `docs/extensions/PACKAGES.md`.
