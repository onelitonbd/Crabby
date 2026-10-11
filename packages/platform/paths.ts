// Crabby's data directory, resolved one way so four surfaces cannot each invent their own.
//
// Only three things are documented, and only these three live here:
//   * the state directory is `.crabby` inside the user's home — D-066's "the vault file in `~/.crabby/vault`", and
//     `AGENTS.md`'s anti-pattern row naming `.crabby/config.json`;
//   * `docs/DEVELOPMENT.md` §5's isolation rule for integration tests ("temp data dirs only; never a developer's real
//     `~/.crabby`") and §10's reflex (`--data-dir $(mktemp -d)`), which together mean **the flag names the state
//     directory itself** — one argument moves every file Crabby owns, so nothing can be left behind in a home
//     directory by accident;
//   * exports and backups take an explicit destination (`history export --out PATH`), so no convention for them here.
//
// Deliberately absent: an environment override (no document names one), and the SQLite file's name — the storage
// layer's path is still an open question (`docs/DATA_AND_MEMORY.md` §4 names the engine, not the filename), and a
// made-up filename in the platform layer is how a convention becomes impossible to change later.
import path from "node:path";

export const STATE_DIR_NAME = ".crabby";
export const CONFIG_FILE_NAME = "config.json";
export const VAULT_DIR_NAME = "vault";

export interface DataLayout {
  /** The state directory: `~/.crabby` by default, or whatever `--data-dir` named. */
  readonly stateDir: string;
  readonly configPath: string;
  readonly vaultDir: string;
}

export function dataLayout(stateDir: string): DataLayout {
  return {
    stateDir,
    configPath: path.join(stateDir, CONFIG_FILE_NAME),
    vaultDir: path.join(stateDir, VAULT_DIR_NAME),
  };
}

/** Where "home" is for this process, in one place. `resolveDataDir` takes it as an argument, and `PathContext.home` —
 *  the value §8's deny-list is measured against — needs the same one, so a second derivation would be a second opinion
 *  about which directory is sensitive. The `?? process.cwd()` is not a guess at a user's home: it is the fallback for a
 *  process with no `HOME` in its environment, where the working directory is the only path this process can honestly
 *  call its own starting point, and naming it makes the deny-list measure against something real rather than against
 *  `undefined` and therefore nothing. */
export function homeDirectory(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  return env.HOME ?? cwd;
}

/** The resolution rule, as a pure function so a test can pass `{ home: "/tmp/x" }` and never touch a real `$HOME`. */
export function resolveDataDir(options: { dataDir?: string; home: string; cwd?: string }): string {
  const explicit = options.dataDir;
  if (typeof explicit === "string" && explicit.length > 0) {
    return path.resolve(options.cwd ?? process.cwd(), explicit);
  }
  return path.join(path.resolve(options.home), STATE_DIR_NAME);
}

/** `~` only at the start of a value, which is the single form a config file has any business containing. */
export function expandHome(value: string, home: string): string {
  return value.replace(/^~(?=$|\/)/, path.resolve(home));
}

export function isRealHomeDataDir(layout: DataLayout, home: string): boolean {
  return layout.stateDir === path.join(path.resolve(home), STATE_DIR_NAME);
}
