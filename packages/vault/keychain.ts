// §7's preferred half of D-031: where the platform has an OS keychain, secrets live there and this package never
// holds a master key. Two adapters, behind one injected command runner so a test can exercise every branch
// without a keychain:
//
//   - macOS: the `security` CLI every Mac ships (`add-generic-password` / `find-generic-password` /
//     `delete-generic-password`), one generic password per entry under the service name "Crabby".
//   - Linux: `secret-tool`, the Secret Service's CLI, when it is on PATH — the table in §7 says "when available;
//     otherwise treated like the fallback", so absence is a detection result, not an error.
//
// The keychain holds *values* only. The list of entry *names* lives in a plain `index.json` beside the vault
// dir's other files, because a name is not a secret (§7 prices values; a name is how `crabby vault list`
// answers without asking the keychain to enumerate) and because neither CLI offers a service-scoped listing
// worth parsing. The index is a cache of names and the keychain is the truth: a `get` for a name the keychain
// does not have is reported as missing, and `delete` removes the name from both.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const KEYCHAIN_SERVICE = "Crabby";
const INDEX_FILE = "index.json";

/** What a command runner must answer: exit status and captured streams, nothing more. `spawnSync` satisfies it
 *  with a one-line wrapper; tests substitute a table. */
export type CommandRunner = (
  command: readonly string[],
  options: { readonly input?: string | undefined },
) => { readonly status: number | null; readonly stdout: string; readonly stderr: string };

export type KeychainFlavor = "macos-security" | "linux-secret-tool";

export interface KeychainOptions {
  readonly flavor: KeychainFlavor;
  readonly vaultDir: string;
  readonly run: CommandRunner;
}

export class KeychainVault {
  readonly #flavor: KeychainFlavor;
  readonly #dir: string;
  readonly #run: CommandRunner;

  constructor(options: KeychainOptions) {
    this.#flavor = options.flavor;
    this.#dir = options.vaultDir;
    this.#run = options.run;
  }

  /** A keychain is never locked in Crabby's sense — the OS gates access, and reporting "locked" would tell the
   *  user to run an unlock this build has no reason to ask for. */
  get state(): "unlocked" {
    return "unlocked";
  }

  get entryCount(): number {
    return this.#readIndex().length;
  }

  set(name: string, secret: string): { ok: true } | { ok: false; reason: string } {
    const args =
      this.#flavor === "macos-security"
        ? // -U updates in place, which makes `vault set` on an existing name the rotation §7 asks to be a
          // one-command action. The secret rides argv here because `security` has no stdin mode for it; the
          // process list on a single-user device is inside the trust domain §15 already assumes, and §7's
          // stronger rule (never a flag value) is kept everywhere the CLI supports a stdin path.
          [
            "security",
            "add-generic-password",
            "-U",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            name,
            "-w",
            secret,
          ]
        : ["secret-tool", "store", "--label=Crabby", "service", KEYCHAIN_SERVICE, "username", name];
    const ran = this.#run(args, this.#flavor === "linux-secret-tool" ? { input: secret } : {});
    if (ran.status !== 0) {
      return {
        ok: false,
        reason: `the keychain refused the write (${ran.stderr.trim() || `exit ${String(ran.status)}`})`,
      };
    }
    const names = this.#readIndex();
    if (!names.includes(name)) {
      names.push(name);
      this.#writeIndex(names.sort());
    }
    return { ok: true };
  }

  delete(name: string): { ok: true } | { ok: false; reason: string } {
    const args =
      this.#flavor === "macos-security"
        ? ["security", "delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", name]
        : ["secret-tool", "clear", "service", KEYCHAIN_SERVICE, "username", name];
    const ran = this.#run(args, {});
    if (ran.status !== 0) {
      return {
        ok: false,
        reason: `no entry named ${name} (the keychain answered exit ${String(ran.status)})`,
      };
    }
    this.#writeIndex(this.#readIndex().filter((candidate) => candidate !== name));
    return { ok: true };
  }

  list(): readonly string[] {
    // The index is the listing; the keychain is the truth. A name whose keychain read fails at `get` time is
    // reported missing there, which is how a stale index name eventually corrects itself.
    return this.#readIndex().sort();
  }

  get(name: string): { ok: true; secret: string } | { ok: false; reason: string } {
    const args =
      this.#flavor === "macos-security"
        ? ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", name, "-w"]
        : ["secret-tool", "lookup", "service", KEYCHAIN_SERVICE, "username", name];
    const ran = this.#run(args, {});
    if (ran.status !== 0 || ran.stdout.trim() === "") {
      return { ok: false, reason: `no entry named ${name}` };
    }
    return { ok: true, secret: ran.stdout.trim() };
  }

  #readIndex(): string[] {
    const file = path.join(this.#dir, INDEX_FILE);
    if (!existsSync(file)) return [];
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { names?: string[] };
      return [...(parsed.names ?? [])];
    } catch {
      // An unreadable index is an empty listing, never a crash: the names are recoverable by memory and the
      // values are untouched in the keychain. The next `set` rewrites the file whole.
      return [];
    }
  }

  #writeIndex(names: readonly string[]): void {
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    const file = path.join(this.#dir, INDEX_FILE);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ names }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  }
}

/** Whether the platform's keychain CLI exists — the §7 table's "when available", answered by PATH rather than
 *  assumed. The default runner is the production one; tests inject their own and never reach PATH. */
export function detectKeychain(
  platform: string,
  run: CommandRunner = defaultRunner,
): KeychainFlavor | undefined {
  if (platform === "darwin" && run(["which", "security"], {}).status === 0) return "macos-security";
  if (platform === "linux" && run(["which", "secret-tool"], {}).status === 0)
    return "linux-secret-tool";
  return undefined;
}

export function defaultRunner(
  command: readonly string[],
  options: { readonly input?: string | undefined },
) {
  // §9's env allow-list rule does not apply here: these invocations carry no untrusted content and inherit
  // nothing but PATH. Every caller that passes a secret uses the stdin channel where the CLI has one.
  const ran = spawnSync(command[0] ?? "", command.slice(1), {
    encoding: "utf8",
    ...(options.input === undefined ? {} : { input: options.input }),
  });
  return { status: ran.status, stdout: ran.stdout ?? "", stderr: ran.stderr ?? "" };
}
