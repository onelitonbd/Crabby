// The named-gap block: the web's version of the TUI's discipline (T15-01's words, W14's rows). A capability this build
// cannot act on is **shown and named**, never rendered as a button that fails, never silently missing. Each gap names
// what is missing and where the capability lives today (a CLI command or a later milestone), because the honest answer
// includes the way a person can act right now.
import { html } from "../safe.js";

export const GAPS = {
  logs: {
    id: "W14-01/03/04",
    missing:
      "`GET /api/v1/logs`, `GET /api/v1/audit` and the approvals-decisions listing have no routes in this build",
    today:
      "`crabby logs` and `crabby audit` are the CLI's verbs for the same data once those routes exist",
  },
  memory: {
    id: "W8-01…08",
    missing: "the memory routes (`/api/v1/memory*`) are not in this build",
    today: "`crabby memory list/search` reaches the store; the review screen waits on the routes",
  },
  extensions: {
    id: "W-E1…E12",
    missing: "the extensions surface has no routes in this build (M4's host installs them)",
    today:
      "`crabby ext` verbs cover what exists; third-party executable kinds are locked by D-038 regardless",
  },
  vault: {
    id: "W1-07/W9-03",
    missing: "vault unlock/lock has no route, so the chip shows the state the config file implies",
    today:
      "the vault is opened by `crabby init` on the host; key storage is `vault://name` references by design",
  },
  tunnel: {
    id: "W13-06/W1-06",
    missing: "`crabby tunnel on/off` has no route — enabling is a T3 act the CLI owns",
    today: "`crabby tunnel on` on the host, `--yes` as the confirmation (C8-06)",
  },
  lifecycle: {
    id: "W13-09",
    missing:
      "gateway restart/shutdown have no routes (and a route that could kill the listener from the browser would)",
    today: "`crabby gateway stop` / `restart --yes` on the host (C8-02)",
  },
  telegram: {
    id: "W13-07",
    missing: "the Telegram allow-list is config+vault work the bot milestone owns",
    today: "`PROVIDERS_AND_TOOLS.md` §4.5 carries the policy until the bot exists",
  },
  jobDelete: {
    id: "W16-11",
    missing:
      "`DELETE /api/v1/jobs/:id` does not exist — pause is the reversible act this build offers",
    today:
      "history stays — read it with `crabby jobs show` and the run's events (the audit trail of work that happened)",
  },
  probe: {
    id: "W10-07",
    missing: "`POST /models/…/probe` has no route (C7-09 is M4's)",
    today: "`crabby model probe` when the route lands",
  },
  onboarding: {
    id: "W-O1/O2/O3/O6",
    missing:
      "the first-run wizard, read-only mode, in-page doctor and the command palette are later-slice surfaces",
    today:
      "`crabby doctor` on the host; this screen's connect step is §3.2's pairing, which is the wizard's security-critical half",
  },
};

/** The block a screen renders when a row's surface cannot exist yet. */
export function gapBlock(...ids) {
  return html`${ids.map((id) => {
    const gap = GAPS[id];
    if (gap === undefined) return "";
    return html`
      <div class="gap">
        <p class="gap-title"><strong>${gap.id}</strong> — not in this build, on purpose and named</p>
        <p>${gap.missing}.</p>
        <p>until then: ${gap.today}.</p>
      </div>
    `;
  })}`;
}

/** W14-05's diagnostics export: the bundle with a client-side secret-shape scan before the clipboard gets it — the TUI
 *  keeps the same rule through `findUnsafeShapes`; a paste must be safe to post. Pure, so the test holds it. */
export function diagnosticsProblemShapes(text) {
  const problems = [];
  const patterns = [
    ["sk_ key", /\bsk-[A-Za-z0-9]{16,}\b/g],
    ["bearer token", /\bcrt_[A-Za-z0-9]{12,}\b/g],
    ["pairing code", /\b[2-9A-HJ-NP-Z]{8}\b/g],
  ];
  for (const [name, re] of patterns) {
    const found = text.match(re);
    if (found !== null) problems.push(`${name} (${String(found.length)} occurrence(s))`);
  }
  return problems;
}
