# Troubleshooting

The rule `docs/UI_UX_SPEC.md` §5 sets for every command — **prints fixes, not findings** — is the rule this page
follows: each section is a symptom, the sentence Crabby actually prints, and the thing to type. `crabby doctor`
remains the triage entry point; it answers from the filesystem, never from a socket, so it works when nothing
else does (D-050 named it the recovery tool).

## "No command crabby found" — and the shell suggesting cabal/caddy/ruby

Nothing is broken: D-050 ships no global binary, so the name is only reachable inside the checkout. Run
`node apps/cli/crabby.ts doctor` (or `npx --no-install crabby …` after `npm install`) — or put the name on PATH
properly with `sh scripts/link-global.sh` (D-145, one symlink into your checkout; `docs/INSTALL.md`'s "the name
`crabby`" section). If even the `node` form fails with a syntax error, your Node is
older than the `engines.node` pin — `node --version`, then upgrade (Termux: `pkg upgrade nodejs-lts`).

## Missed the pairing code, it expired, or a restart printed no code at all

The code is redeemed by a **client in a second session** while the Gateway keeps running — not typed into the
Gateway's terminal. Termux: swipe from the left edge → *New session*, then `crabby auth pair --code <code>`.
Expired? Harmless: until one identity exists, **every `gateway start` prints a fresh code** (the `first client`
block near the end of the output). A start with **no** code almost always means the old Gateway still holds the
port — `crabby gateway status` names the pid, `kill <pid>` or Ctrl-C in its terminal, start again. (`gateway
stop` is a planned verb; Ctrl-C and the pid are today's stops.) Once paired, `crabby auth list` shows the
identity and its last-seen time.

## `ERR_MODULE_NOT_FOUND` for an `@crabby/…` package — after switching branches or pulling

The `node_modules` tree was built from a different `package.json` set: the workspace links (`@crabby/vault`,
`@crabby/extensions`, …) are created by `npm install` from the declarations, and a `git checkout`/`git pull`
changes the declarations but never the tree. Re-run it:

```sh
npm install --build-from-source     # Termux; elsewhere: npm install
crabby doctor
```

If a pull touched `package.json` (or you moved between `main` and a work branch), this is expected — install is
the step that makes the module graph match the code you just checked out.

## "Gateway" — nothing answers

- `crabby status` is the first command, not `curl`: it reads what a running Gateway published
  (`<stateDir>/gateway.json`) and whether that pid is alive. A Gateway that exited cleanly **removed** the file,
  so "no listener" usually means exactly that — start it: `crabby gateway start`.
- The Gateway binds **loopback by default and refuses a wider host** (§2). From another device, use
  `crabby tunnel on` (§13) or an SSH tunnel — the error naming the refused bind is the design, not a misrule.
- A task created while no runner was composed answers `201` and stays `queued` — recorded, not driven. The
  missing piece is named by the start output: a provider **and** a default model compose the runner.

## Auth errors

- `auth_missing` — the request carried no bearer token. Pair first: `crabby gateway start` prints a single-use
  8-character code (it **expires in ~2 minutes**), then `crabby auth pair --code <code>` — or type the code into
  the Web UI's first-run field.
- `auth_invalid` — the token was refused. Tokens are stored as digests and cannot be re-printed; revoke and
  re-pair: `crabby auth list`, `crabby auth revoke <id>`, then pair again. Revocation ends live streams too.
- A revoked identity's scheduled job stops firing with the reason "its identity was revoked" — the job row
  records it; re-pairing does not silently resurrect the job.

## Vault and providers

- `vault_unset` / "no vault yet" — no entry exists yet: `crabby vault set <name>` (the value arrives on **stdin**,
  never argv), then point the provider at it: `config set provider.<id>.key vault://<name>`.
- "the vault is locked" — unlock the **running Gateway's** session: `crabby vault unlock` (passphrase on stdin).
  A Gateway that started locked composed no runner; after unlocking, `crabby gateway restart` arms it — the unlock
  answer says the same thing (D-139).
- A wrong passphrase is a clean refusal — the GCM tag verifies it before any entry is read. Retry, or restore the
  vault file from before the last write; there is no bypass, by design.
- "no runner composed" at task creation — the start output names the missing half: a provider entry that composes
  (check `crabby doctor`'s provider row for why one refuses) or the default model:
  `crabby config set defaultModel <provider>/<modelId>`.

## Scheduled jobs

- All six job writes answer **exit 4 `scheduler_absent`** when this Gateway composed no scheduler — it composed no
  runner, because no executor+model existed at start. Fix the provider/model, then `crabby gateway restart`.
  `GET /api/v1/jobs` still answers from the table with `driven:false`; nothing was lost.
- A job that cannot get approval "stops and records waiting on approval" (§4.5) — the run row says so; it does
  not proceed unattended, and no other run fires beside the waiting prompt.
- Occurrences missed overnight are **not** silently back-filled: the rows are marked `missed`, the list prints
  `missedUnacknowledged`, and `crabby job backlog <id> --latest|--skip` is the explicit choice (§4.5).

## Tunnel

- `tunnel_active` (409) — a tunnel is already up or starting. `crabby tunnel status` shows the live row and its
  URL; `crabby tunnel off` stops the child for real before starting again.
- **The URL changed** — it always does. A quick tunnel's URL is printed fresh on every start and the old one is
  never redirected (O-009); hand out the one the last `tunnel on` printed.
- The child died / `tunnel_start_failed` — `cloudflared` must exist or `CRABBY_TUNNEL_COMMAND` must point at
  something that speaks its protocol; the failure names the reason and is retryable.

## Storage and SQLite

- better-sqlite3 fails to build — on Termux install the toolchain first
  (`pkg install python3 make clang binutils`) and use `npm install --build-from-source` (D-050); elsewhere the
  package ships its prebuilt binary, so a from-source attempt means an unusual platform: keep python3/make/g++ and
  let node-gyp fetch headers.
- "database is locked" beyond the busy window — writes wait 5 s (D-074's `busy_timeout`, configurable via
  `crabby config set limits.sqliteBusyTimeoutMs …`); a second Gateway on the same state dir is the usual cause.
  One state dir, one Gateway.
- A failed migration — the file is **left untouched** at the previous version (tested, D-142/D-065); fix the
  install and start again, or restore the backup you took (`docs/DATA_AND_MEMORY.md` §8's manual steps).
- Restored a backup and it will not open — you copied a stale `crabby.sqlite3-wal`/`-shm` on top of it. Remove
  the sidecars (§8, step 2) and try again; the file you moved aside is still there.

## Telegram

- `telegram start` answers the vault sentence until a token exists — the token arrives **by env**
  (`TG_BOT_TOKEN=…`, G1-03: never argv, never a file in git). The wire check before anything else:
  `TG_BOT_TOKEN=… npm run telegram:check` on a machine that can reach `api.telegram.org`.
- The bot ignores a sender that has not paired — that is the silent gate (§3.2), not a bug: `/start` in-chat to
  pair, and the pairing lands in `telegram.json` (excluded from backups — bearer material).

## The two meta-answers

- **Exit codes:** 0 success, 1 failure, 2 usage/validation, 3 needs-approval, 4 platform-unsupported
  (`crabby --help` says so; a script can trust it).
- **A refusal you disagree with** is still a record: `crabby doctor --json` and `crabby diagnostics` produce the
  paste-ready report (sanitized, 0600), and `docs/LIMITATIONS.md` may already own the sentence that stopped you.
