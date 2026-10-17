// §7's secrets store as one facade. The platform table in that section decides which back end a device gets,
// and this file is where the decision is made once, so no caller re-derives it:
//
//   - macOS with `security` on PATH → Keychain (`KeychainVault`).
//   - Linux with `secret-tool` on PATH → Secret Service (`KeychainVault`).
//   - everything else — Android/Termux, WSL, a Linux without Secret Service — → the passphrase-encrypted file
//     (`EnvelopeVault`), the floor D-066 set and §7 labels *weaker*, a word the CLI must carry into every
//     answer that creates or describes it.
//
// The state machine is the part the rest of the build talks to: `unset` (no vault yet) → `locked` (a file
// exists and nothing has opened it) → `unlocked`. A keychain never locks. Every operation answers a
// discriminated result rather than throwing, because a locked vault is a *normal* state on a phone — D-031's
// sentence is that work waits and the wait is visible, and a thrown exception would make the wait a crash.

import { EnvelopeVault } from "./envelope.ts";
import { type CommandRunner, defaultRunner, detectKeychain, KeychainVault } from "./keychain.ts";

export { ENVELOPE_FILE, type EnvelopeKdf, EnvelopeVault, KDF_DEFAULT } from "./envelope.ts";
export {
  type CommandRunner,
  defaultRunner,
  detectKeychain,
  KEYCHAIN_SERVICE,
  KeychainVault,
} from "./keychain.ts";

export type VaultStoreKind = "keychain" | "file" | "none";

export interface VaultStatus {
  readonly kind: VaultStoreKind;
  readonly state: "unset" | "locked" | "unlocked";
  /** A locked file vault cannot even prove how many entries it holds — the count is an unlocked fact. */
  readonly entries?: number | undefined;
  /** Names are the whole listing §7 allows a status to carry; values stay behind `get`. */
  readonly names?: readonly string[] | undefined;
  /** Why this device has this store, in the words §7 requires — the weaker-store disclosure lives here and
   *  the CLI prints it, so the user knows which protection they have rather than inferring it from silence. */
  readonly note?: string | undefined;
}

export interface Vault {
  readonly kind: VaultStoreKind;
  status(): VaultStatus;
  /** File store only; a keychain answers ok immediately. The first unlock on an empty directory *creates*
   *  the vault — the caller's answer then carries §7's disclosure that the file protects against casual
   *  disclosure, not against whoever already owns the account. */
  unlock(passphrase: string): { ok: true } | { ok: false; reason: string };
  lock(): void;
  set(
    name: string,
    secret: string,
    passphrase?: string,
  ): { ok: true } | { ok: false; reason: string };
  delete(name: string, passphrase?: string): { ok: true } | { ok: false; reason: string };
  list(passphrase?: string): { ok: true; names: readonly string[] } | { ok: false; reason: string };
  get(
    name: string,
    passphrase?: string,
  ): { ok: true; secret: string } | { ok: false; reason: string };
}

/** The weaker-store sentence, kept in one place so every surface that touches the file store says the same
 *  words (§7: "any UI or log message referencing the fallback must state" this). */
export const FILE_STORE_DISCLOSURE =
  "the encrypted file protects against casual disclosure, not against someone who already controls this " +
  "user account (SECURITY.md §15: on Termux there is no sandbox between them)";

export interface OpenVaultOptions {
  readonly vaultDir: string;
  readonly platform: string;
  /** Tests inject a table here and never touch PATH or a real keychain; production uses the default runner. */
  readonly run?: CommandRunner | undefined;
  /** Tests only — a small scrypt so a suite can afford hundreds of unlocks. */
  readonly kdf?: { readonly N: number; readonly r: number; readonly p: number } | undefined;
  /** Tests pin this to `"file"` when they mean the file store regardless of what the host has on PATH; a
   *  suite that exercised the keychain branch does it through an injected `run`, never through the host. */
  readonly store?: "auto" | "file" | undefined;
}

export function openVault(options: OpenVaultOptions): Vault {
  const run = options.run ?? defaultRunner;
  const wantsFile = options.store === "file" || options.kdf !== undefined;
  const flavor = wantsFile ? undefined : detectKeychain(options.platform, run);
  if (flavor !== undefined) {
    return new KeychainFacade(new KeychainVault({ flavor, vaultDir: options.vaultDir, run }));
  }
  return new FileFacade(
    new EnvelopeVault(options.vaultDir, options.kdf === undefined ? {} : { kdf: options.kdf }),
  );
}

/** The resolver `composeProviders` takes: a `vault://name` reference in, the secret or the reason it cannot be
 *  produced. This is the one function that turns a reference into a value anywhere in the build (§7: the agent
 *  uses a credential without reading it — the adapter receives the resolved string through composition, and no
 *  tool ever asks for a secret by name). */
export type SecretResolver = (
  reference: string,
) => { ok: true; secret: string } | { ok: false; reason: string };

export function resolverFor(vault: Vault): SecretResolver {
  return (reference: string) => {
    if (!reference.startsWith("vault://")) {
      return { ok: false, reason: `\`${reference}\` is not a vault reference` };
    }
    return vault.get(reference.slice("vault://".length));
  };
}

class KeychainFacade implements Vault {
  readonly kind = "keychain" as const;
  private readonly inner: KeychainVault;
  constructor(inner: KeychainVault) {
    this.inner = inner;
  }
  status(): VaultStatus {
    return {
      kind: this.kind,
      state: this.inner.state,
      entries: this.inner.entryCount,
      names: this.inner.list(),
      note: "values live in the OS keychain; Crabby holds no master key for them",
    };
  }
  unlock(): { ok: true } {
    return { ok: true };
  }
  lock(): void {}
  set(name: string, secret: string): { ok: true } | { ok: false; reason: string } {
    return this.inner.set(name, secret);
  }
  delete(name: string): { ok: true } | { ok: false; reason: string } {
    return this.inner.delete(name);
  }
  list(): { ok: true; names: readonly string[] } | { ok: false; reason: string } {
    return { ok: true, names: this.inner.list() };
  }
  get(name: string): { ok: true; secret: string } | { ok: false; reason: string } {
    return this.inner.get(name);
  }
}

class FileFacade implements Vault {
  readonly kind = "file" as const;
  private readonly inner: EnvelopeVault;
  constructor(inner: EnvelopeVault) {
    this.inner = inner;
  }
  status(): VaultStatus {
    const state = this.inner.state;
    return {
      kind: this.kind,
      state,
      entries: state === "unlocked" ? this.inner.entryCount : undefined,
      names: state === "unlocked" ? this.inner.list() : undefined,
      // §7's disclosure rides every message that references the fallback — a file-store status is one.
      note: FILE_STORE_DISCLOSURE,
    };
  }
  unlock(passphrase: string): { ok: true } | { ok: false; reason: string } {
    return this.inner.unlock(passphrase);
  }
  lock(): void {
    this.inner.lock();
  }
  set(
    name: string,
    secret: string,
    passphrase?: string,
  ): { ok: true } | { ok: false; reason: string } {
    if (this.inner.state === "unset") {
      if (passphrase === undefined) {
        return {
          ok: false,
          reason:
            "no vault exists yet, and creating one needs a passphrase (the first `crabby vault set` asks)",
        };
      }
      const created = this.inner.unlock(passphrase);
      if (!created.ok) return created;
    } else if (this.inner.state === "locked") {
      const opened = this.#openWith(passphrase);
      if (!opened.ok) return opened;
    }
    return this.inner.set(name, secret);
  }
  delete(name: string, passphrase?: string): { ok: true } | { ok: false; reason: string } {
    const opened = this.#openWith(passphrase);
    if (!opened.ok) return opened;
    return this.inner.delete(name);
  }
  list(
    passphrase?: string,
  ): { ok: true; names: readonly string[] } | { ok: false; reason: string } {
    const opened = this.#openWith(passphrase);
    if (!opened.ok) return opened;
    return { ok: true, names: this.inner.list() };
  }
  get(
    name: string,
    passphrase?: string,
  ): { ok: true; secret: string } | { ok: false; reason: string } {
    const opened = this.#openWith(passphrase);
    if (!opened.ok) return opened;
    return this.inner.get(name);
  }
  #openWith(passphrase?: string): { ok: true } | { ok: false; reason: string } {
    if (this.inner.state === "unlocked") return { ok: true };
    if (passphrase === undefined) {
      return {
        ok: false,
        reason:
          this.inner.state === "unset"
            ? "no vault exists yet — the first `crabby vault set` creates one and asks for a passphrase"
            : "the vault is locked and this call carried no passphrase",
      };
    }
    return this.inner.unlock(passphrase);
  }
}
