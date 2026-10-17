#!/usr/bin/env sh
# The bare name `crabby`, on PATH, without a registry, a global package, or an updater (D-145).
#
# OpenClaw-style CLIs get their universal command name from `npm install -g <pkg>`: npm writes the package's
# `bin` entry as a symlink into the global prefix, which is on PATH. That mechanism requires publishing to a
# registry and fetching a package by name — both of which D-050 refused for the install path (a name fetched
# from a registry is a name someone else can answer to). This script provides the *same ergonomics* with a
# different mechanism: one symlink, created by an explicit act of yours, pointing INTO your checkout.
#
# What follows from that shape:
#   - update is `git pull` — the symlink tracks the checkout, so there is no updater to trust;
#   - uninstall is `rm` of one link — the checkout itself is never touched;
#   - nothing is fetched, nothing is registered, nothing auto-runs.
#
# Usage: sh scripts/link-global.sh          (create / refresh the link)
#        sh scripts/link-global.sh --remove (remove it)
set -eu

repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
entry="$repo/apps/cli/crabby.ts"
if [ ! -f "$entry" ]; then
  echo "crabby: $entry not found — run this from inside a Crabby checkout" >&2
  exit 1
fi

if [ -n "${PREFIX:-}" ] && [ -d "${PREFIX}/bin" ]; then
  # Termux (and any prefix-style environment): $PREFIX/bin is already on PATH.
  bin_dir="$PREFIX/bin"
else
  # The Linux/macOS convention. Created if missing; warned about if not on PATH.
  bin_dir="${HOME}/.local/bin"
  mkdir -p "$bin_dir"
  case ":${PATH}:" in
    *":${bin_dir}:"*) ;;
    *) printf 'note: %s is not on your PATH — add this to ~/.bashrc:\n  export PATH="%s:$PATH"\n' "$bin_dir" "$bin_dir" ;;
  esac
fi

case "${1:-}" in
  --remove)
    rm -f "${bin_dir}/crabby"
    echo "removed: ${bin_dir}/crabby"
    ;;
  "")
    ln -sf "$entry" "${bin_dir}/crabby"
    echo "linked:  ${bin_dir}/crabby -> ${entry}"
    echo 'crabby now works from any directory; updates are `git pull` (the link follows the checkout).'
    echo "undo any time: rm ${bin_dir}/crabby"
    ;;
  *)
    echo "usage: sh scripts/link-global.sh [--remove]" >&2
    exit 2
    ;;
esac
