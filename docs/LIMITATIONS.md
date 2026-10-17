# What Crabby does not promise

This page is part of the release bar (M6's exit): a new user should hit **nothing** that it did not already
mention. Every line here is a decision or a measurement recorded elsewhere — the links say where — and none of
them is a bug to file. They are the honest shape of v1.

## On Android/Termux

- **There is no application sandbox between Crabby and Termux's data directory.** Another app or an adb-rooted
  context can read `~/.crabby/` (T-14). The defenses are at rest (the vault's encryption, `0600`/`0700` file
  modes) and in policy (capabilities, tiers, approvals) — not isolation from the rest of the device.
  `SECURITY.md` §15 is the standing sentence, and O-065 tracks what a phone's sandbox can actually enforce.
- **Local inference is documented unsupported.** A model is a URL you control — an OpenAI-compatible endpoint on
  your network or a hosted provider. Nothing bundles a model engine for Android (O-034, D-066).
- **The vault's file store is the weaker protection, and says so every time it reports.** Where no OS keychain
  exists, secrets live in a passphrase-encrypted file — scrypt and AES-GCM are real, but a file on a shared
  device is a file on a shared device (D-031/D-139's §7 disclosure). A keychain never locks; the file does.
- **The Telegram adapter has never been run against a live token.** The wire check is
  `TG_BOT_TOKEN=… npm run telegram:check` on the owner's device, and the four-interface demo is still owed.

## Remote access

- **A quick tunnel's URL changes on every start.** The Gateway prints the fresh one each time and never redirects
  the old one (O-009/D-066). Anything that needs a stable address needs a named tunnel, which v1 does not offer.
- **Turning the tunnel on is one confirmed decision with real reach.** The prompt lists which paired identities
  become remotely reachable; `--yes` is the scripted form of that same confirmation (§13). A remote caller's
  requests arrive from loopback, so the socket-based identity guards (D-097) are no stronger behind a tunnel than
  the mint route's — the capability check replaces them when a pairing-time grant model exists.
- **Loopback is the default, and the Gateway refuses a wider bind** — another device reaches it by SSH tunnel or
  by the tunnel above, not by `--host 0.0.0.0`.

## Extensions

- **No third-party executable code runs in v1 — no override, no "install anyway"** (D-035/D-036/D-038). The only
  untrusted-safe channel is instruction-only content: portable skills and MCP *client* configuration. O-008's
  gate is final (D-140): a candidate isolation strategy must pass the injection corpus on the primary platform
  before anything executable loads.
- **`verified-community` is not offerable** until a signing mechanism and its revocation story exist (O-064) —
  there is no registry, no moderation queue, and no publisher to be accountable to (D-035/D-050).
- **Crabby is an MCP client, never a server** (D-040).
- `worker_threads` and `node:vm` are **not** isolation, and nothing in this build pretends otherwise.

## Approvals and authority

- **Approvals are once-only.** There are no remembered, scoped or blanket approvals in v1 — a request for one is
  refused, not deferred (D-052/O-052).
- **A schedule never pre-buys approval.** Every job run re-evaluates policy at run time; a T2/T3 step waits for a
  human through the interfaces, every time (§4.5).
- **`shell.run` is off by default** and enabling it is an explicit act (§9). The classifier that hints at
  escalation is a shipped table, not a security boundary.
- **A Gateway that started with the vault locked has no runner** until `crabby gateway restart` (D-139) — the
  unlock arms the running process's composition, and the answer says so rather than implying the task surface
  came back with the keys.

## Data

- **Migrations are forward-only; a downgrade is unsupported.** The rollback path for a bad upgrade is the backup
  you took, not an old binary on a migrated file (`docs/DEVELOPMENT.md` §9).
- **Restoring a backup is a manual, documented step** (D-142), and **data deleted after a backup was taken comes
  back when it is restored** — the disclosure §8 requires and `crabby backup` prints.
- **Memory search is ordinary text (FT5) in v1.** Vector/semantic search stays out until a measured need exists
  (D-021/O-015).
- Conversation deletion deletes the conversation; derived summaries and memories have their own named semantics
  (`docs/DATA_AND_MEMORY.md` §7), not a silent cascade.

## Versions

- **`0.x` may break in a minor.** Each break is written in the changelog with its migration step (D-143,
  `docs/DEVELOPMENT.md` §9). `1.0.0` is the owner's declaration, not a date.

## Still being measured

- The phone column of the M0 probes — terminal rendering facts, Ink feasibility, process-lifetime behavior — is
  owed to a real device (P-003/P-004/P-010/P-011 stay Needs-Validation until it runs), and the performance pass
  (startup, idle CPU, battery, WAL growth) is M6 owner-device work. Nothing on this page is softened to make a
  table greener.
