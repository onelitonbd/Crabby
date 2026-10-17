# Installing Crabby

D-050's install path, written out: **a checkout plus `npm install`** — no global install target, no
package-manager repository, no self-updater in v1. The recovery tool for everything below is `crabby doctor`, and
the version you are on is what `crabby version` says. Uninstalling is deleting the checkout and the state
directory (`~/.crabby/`); a backup taken first (`crabby backup`) is how anything else survives.

## Prerequisites

- **Node.js ≥ 22.22** — the `engines.node` field in the root `package.json` is the single pin (D-070), and the
  number comes from M0 P1's measurement: the requirement is *behavioral* — the installed Node must run `.ts`
  entry points and `node --test` with no flags and no loader. `crabby doctor` checks exactly that and tells you
  what your Node actually does.
- **git** — the install *is* a checkout.
- **A C toolchain (python3, make, a C++ compiler)** — only where the prebuilt binary does not cover you. Termux
  always needs it; Linux/macOS on x64/arm64 normally do not.

## The name `crabby` — and why it is not on your PATH

D-050 promises no global install and no self-updater, so nothing puts a `crabby` binary on your PATH and your
shell's command-not-found will suggest unrelated packages. The command lives inside the checkout:

```sh
node apps/cli/crabby.ts doctor          # the unambiguous form, works anywhere in the checkout
npx --no-install crabby doctor          # the workspace bin, after npm install
```

For the bare name, use an alias — the ergonomic form of "no global install":

```sh
echo "alias crabby='node $HOME/Crabby/apps/cli/crabby.ts'" >> ~/.bashrc && source ~/.bashrc
```

**Never a bare `npx crabby` from outside the checkout**: with no local install under it, npx is allowed to fetch
whichever registry package answers to that name — a stranger's code with our name, which is exactly the
supply-chain shape this install path exists to refuse.

## Linux and macOS

```sh
git clone https://github.com/onelitonbd/Crabby.git
cd Crabby
npm install
node apps/cli/crabby.ts doctor      # the green-light check, and the recovery tool forever after
node apps/cli/crabby.ts init
```

macOS `security` and a Linux Secret Service are used for the vault automatically when present; everywhere else the
vault is the encrypted file, and `crabby doctor` tells you which one you got (D-139, §7's disclosure).

If your machine cannot reach the Node header download (locked networks, some CI), `npm install --ignore-scripts`
still yields a working install: better-sqlite3 13 ships its prebuilt binary inside the package. The from-source
build is the fallback for platforms without a bundled prebuild — that is the one place the toolchain matters.

## Termux (Android — the primary platform)

```sh
pkg install nodejs-lts git python3 make clang binutils
git clone https://github.com/onelitonbd/Crabby.git
cd Crabby
npm install --build-from-source     # D-050/D-066: Termux builds the native module from source
node apps/cli/crabby.ts doctor
node apps/cli/crabby.ts init
```

The doctor output is the honest column: it names what this Termux can and cannot do (the vault's store choice —
`termux-keystore` only if the probe succeeds at first run, the encrypted file otherwise — and §15's no-sandbox
sentence, which is a platform fact, not a warning to clear). Local inference on Android is **documented
unsupported**; the model lives behind a URL you control (O-034). Windows is WSL only (O-007) — native Windows is
documented-unsupported, not half-supported.

## From clone to first conversation

```sh
node apps/cli/crabby.ts vault set groq          # the key arrives on stdin, never argv (§3.7)
node apps/cli/crabby.ts config set provider.groq.key vault://groq
node apps/cli/crabby.ts config set provider.groq.baseUrl https://api.groq.com/openai/v1
node apps/cli/crabby.ts config set defaultModel groq/llama-3.3-70b-versatile
node apps/cli/crabby.ts gateway start           # loopback; prints the pairing code for the next client
```

`gateway start` composes the runner only when a provider **and** a default model both exist, and says exactly
which is missing when they do not — a task created before that is recorded and stays `queued`, which is the truth
rather than a shrug. Pair another interface with the code the start printed (`crabby auth pair --code <code>`, or
the Web UI's first-run field), then `crabby chat "…"` / `crabby task run "…"`.

## Update, rollback, backup

- **Update:** `git pull && npm install`. The database migrates forward only; a downgrade is unsupported
  (`docs/DEVELOPMENT.md` §9), so the rollback path is the backup, not an old checkout on a migrated file.
- **Backup:** `crabby backup` — online copy, secrets excluded, integrity-verified at backup time; restore is the
  documented manual step in `docs/DATA_AND_MEMORY.md` §8 (D-142).
- **Recovery:** `crabby doctor` — D-050 named it the recovery tool; every check it prints carries a fix line.

## Rehearsed

**2026-10-17, linux/x64 container, Node v22.22.3:** fresh `git clone` → `npm install --ignore-scripts` (this
environment's egress blocks the Node header download; the prebuilt binary carried the install) → `init` exit 0 →
`doctor` exit 0 → `version` (0.0.0, checkout) → `backup` (integrity ok, exclusions named) → `gateway start`
(schema v16 applied, pairing code printed, unauthenticated `/health` and `/tunnel` refused with `auth_missing`,
clean drain on stop). **The Termux column is owed to the owner's device** — the same steps there are also O-001's
one remaining clause (the clean-environment build reproduction), and the phone column of `probes/RESULTS.md`
records what it measures.
