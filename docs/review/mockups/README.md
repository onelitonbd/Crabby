# Review mockups (planning instruments, not product code)

`docs/review/mockups/` exists so the owner can **look at** the element inventories in `docs/review/` instead of
only reading tables, per D-055/D-056. Nothing in this directory is Crabby: it implements no feature, ships no
code, and is never referenced by a runtime. When the inventories are approved they are used to regenerate
`docs/UI_UX_SPEC.md` and `docs/DESIGN_SYSTEM.md`, and this directory's purpose is finished.

## Files

| File | What it is |
| --- | --- |
| `build.py` | parses the inventory tables, then writes `crabby-web-ui.html`; fails if the mockup references an element the inventory does not define, or leaves a row unplaced |
| `shell.html` | the drawn screens — markup only, no invented element names (each carries `data-el="<inventory ID>"`) |
| `tokens.css` | semantic tokens, placeholders until `docs/DESIGN_SYSTEM.md` is regenerated from approved elements |
| `app.js` | selection, drawer, viewport/theme/density toggles, review notes, export |
| `crabby-web-ui.html` | **generated, committed for convenience** — the file to open (one file: inline CSS, inline data, no assets). Regenerate with the command below; do not hand-edit |

```
python3 docs/review/mockups/build.py
```

## Rules this directory obeys

- The inventory is the source of truth. A row is never renamed, merged, or dropped inside the mockup.
- One self-contained HTML file: inline CSS, inline data, no network, no CDN, no build step — so it opens from a
  file path or from a Termux-served port on a phone.
- Reviews happen in the browser, but the result leaves as markdown rows that are pasted back into `WEB.md`. The
  browser's `localStorage` copy is a convenience and never the record.
- Every element is clickable and shows its own row: small things (a `redacted` marker, a chip) get the same
  affordance as the chat pane, which is the point of D-055.

## What the toggles at the top are for

They are not decoration; each one exists because a row in the inventory makes a claim that has to be checked:

- **360 / 600 / desktop** — the 360px case is the binding one (`docs/UI_UX_SPEC.md` §2).
- **vault locked / offline / tunnel on** — the three states that change what can be trusted on screen. With
  *phone* + *vault locked* you can see the escape from the overflow sheet that open question **W1-A** proposes.
- **element IDs** — labels every drawn element with its inventory ID, so a comment can be phrased as "W4-08, this one".
- **Download / Copy review** — markdown of the rows you changed, plus your notes, ready to paste into
  `docs/review/WEB.md` or to hand back for applying.
