// §7's fallback envelope: one file holding every secret behind one passphrase-derived key (D-066's floor for
// Android + Termux, and for any platform with no keychain).
//
// The format is small enough to state in full, because a secrets format a reader cannot verify from its spec is a
// format nobody should trust:
//
//   { "version": 1, "kdf": { "name": "scrypt", "N": 32768, "r": 8, "p": 1 },
//     "salt": <b64 of 32 random bytes>, "iv": <b64 of 12 random bytes>,
//     "tag": <b64 of the GCM tag>, "data": <b64 of the AES-256-GCM ciphertext> }
//
// The plaintext is one JSON document `{ entries: { name: secret } }`. The salt is **per-install** (D-066's own
// words): created once when the vault file is created and reused by every later write, because the derived key
// would stop verifying if the salt a read derives from ever differed from the salt the write used. What rotates
// per write is the GCM IV — reuse of an IV under one key is the one mistake AES-GCM does not survive. The KDF
// parameters are pinned in the file itself so a future change reads old files correctly instead of corrupting
// them silently; the numbers default to D-066's (N=2^15, r=8, p=1) and the only caller that may pass anything
// else is the test suite, which buys speed with a small N and never ships. The GCM tag is what makes a wrong
// passphrase a *verifiable* wrong passphrase — decryption fails cleanly rather than yielding garbage that looks
// like secrets.

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type ScryptOptions,
  scryptSync,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

/** D-066's pinned floor. Written into every envelope so a reader never guesses. */
export const KDF_DEFAULT = { name: "scrypt", N: 2 ** 15, r: 8, p: 1 } as const;

export const ENVELOPE_FILE = "secrets.vault";

interface Envelope {
  readonly version: 1;
  readonly kdf: {
    readonly name: "scrypt";
    readonly N: number;
    readonly r: number;
    readonly p: number;
  };
  readonly salt: string;
  readonly iv: string;
  readonly tag: string;
  readonly data: string;
}

interface Plaintext {
  readonly entries: Readonly<Record<string, string>>;
}

export interface EnvelopeKdf {
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

export interface EnvelopeOptions {
  /** Tests only. Production pins KDF_DEFAULT; the override exists so a suite can run hundreds of unlocks
   *  without paying the real scrypt's memory and time each, and it never ships in a default path. */
  readonly kdf?: EnvelopeKdf | undefined;
}

const REASON_LOCKED = "the vault is locked — unlock it (crabby vault unlock) and run this again";

export class EnvelopeVault {
  /** The derived key and its salt, held only while unlocked. A `undefined` key *is* the lock: no key, no
   *  entries, nothing to read — §7's "lock state is visible" starts with the state actually meaning lock. */
  #key: Buffer | undefined;
  #salt: Buffer | undefined;
  #entries: Map<string, string> = new Map();
  readonly #path: string;
  readonly #kdf: EnvelopeKdf;

  private readonly vaultDir: string;

  constructor(vaultDir: string, options: EnvelopeOptions = {}) {
    this.vaultDir = vaultDir;
    this.#path = path.join(vaultDir, ENVELOPE_FILE);
    this.#kdf = options.kdf ?? KDF_DEFAULT;
    if (existsSync(this.#path)) this.#load();
  }

  get path(): string {
    return this.#path;
  }

  /** `unset` until the first write, then `locked` or `unlocked` — the state §7 says must always be visible. */
  get state(): "unset" | "locked" | "unlocked" {
    if (this.#key !== undefined) return "unlocked";
    return existsSync(this.#path) ? "locked" : "unset";
  }

  get entryCount(): number {
    return this.#key === undefined ? 0 : this.#entries.size;
  }

  unlock(passphrase: string): { ok: true } | { ok: false; reason: string } {
    if (!existsSync(this.#path)) {
      // First use is a create, not an unlock: the passphrase becomes the key with nothing to verify against, and
      // §7's weaker-store disclosure rides with the answer that creates the vault (the CLI prints it once).
      this.#open(passphrase, randomBytes(32), randomBytes(12), undefined, undefined);
      const write = this.#write();
      if (!write.ok) {
        this.lock();
        return write;
      }
      return { ok: true };
    }
    const envelope = JSON.parse(readFileSync(this.#path, "utf8")) as Envelope;
    return this.#open(
      passphrase,
      Buffer.from(envelope.salt, "base64"),
      Buffer.from(envelope.iv, "base64"),
      Buffer.from(envelope.tag, "base64"),
      Buffer.from(envelope.data, "base64"),
    );
  }

  lock(): void {
    this.#key?.fill(0);
    this.#key = undefined;
    this.#salt = undefined;
    this.#entries = new Map();
  }

  set(name: string, secret: string): { ok: true } | { ok: false; reason: string } {
    if (this.#key === undefined) return { ok: false, reason: REASON_LOCKED };
    this.#entries.set(name, secret);
    return this.#write();
  }

  delete(name: string): { ok: true } | { ok: false; reason: string } {
    if (this.#key === undefined) return { ok: false, reason: REASON_LOCKED };
    if (!this.#entries.delete(name)) return { ok: false, reason: `no entry named ${name}` };
    return this.#write();
  }

  /** Names only. The values stay behind `get`, which is the one surface allowed to show them (§7: the owner's
   *  own terminal — everywhere else a name is the whole answer). */
  list(): readonly string[] {
    return [...this.#entries.keys()].sort();
  }

  get(name: string): { ok: true; secret: string } | { ok: false; reason: string } {
    if (this.#key === undefined) return { ok: false, reason: REASON_LOCKED };
    const secret = this.#entries.get(name);
    return secret === undefined
      ? { ok: false, reason: `no entry named ${name}` }
      : { ok: true, secret };
  }

  #open(
    passphrase: string,
    salt: Buffer,
    iv: Buffer,
    tag: Buffer | undefined,
    data: Buffer | undefined,
  ): { ok: true } | { ok: false; reason: string } {
    // maxmem: node's default (32 MiB) is exactly D-066's N·r product and scrypt refuses on the boundary —
    // the headroom is an implementation necessity, not a parameter change; N, r, p stay D-066's.
    const options: ScryptOptions = {
      N: this.#kdf.N,
      r: this.#kdf.r,
      p: this.#kdf.p,
      maxmem: 96 * 1024 * 1024,
    };
    const key = scryptSync(passphrase, salt, 32, options);
    if (tag === undefined || data === undefined) {
      // A create: nothing to verify, everything to save.
      this.#key = key;
      this.#salt = salt;
      this.#entries = new Map();
      return { ok: true };
    }
    let plain: Buffer;
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      plain = Buffer.concat([decipher.update(data), decipher.final()]);
    } catch {
      key.fill(0);
      return {
        ok: false,
        reason:
          "the passphrase did not open this vault — the file is unchanged and nothing was written",
      };
    }
    this.#key = key;
    this.#salt = salt;
    this.#entries = new Map(
      Object.entries((JSON.parse(plain.toString("utf8")) as Plaintext).entries),
    );
    return { ok: true };
  }

  #write(): { ok: true } | { ok: false; reason: string } {
    if (this.#key === undefined || this.#salt === undefined)
      return { ok: false, reason: REASON_LOCKED };
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const plain = Buffer.from(
      JSON.stringify({ entries: Object.fromEntries(this.#entries) } satisfies Plaintext),
    );
    const data = Buffer.concat([cipher.update(plain), cipher.final()]);
    const envelope: Envelope = {
      version: 1,
      kdf: { name: "scrypt", ...this.#kdf },
      salt: this.#salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    };
    mkdirSync(this.vaultDir, { recursive: true, mode: 0o700 });
    const tmp = `${this.#path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.#path);
    // The rename carried the temp file's mode; assert the result rather than trust the chain — §7 prices the
    // file's permissions, and a umask surprise is exactly the kind of fact a check catches and a hope does not.
    const mode = statSync(this.#path).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      return {
        ok: false,
        reason: `the vault file was written with mode ${mode.toString(8)} — chmod 600 ${this.#path} and try again`,
      };
    }
    return { ok: true };
  }

  #load(): void {
    const envelope = JSON.parse(readFileSync(this.#path, "utf8")) as Envelope;
    // Kept to fail fast on a file this code cannot have written; the entries stay unread until a passphrase
    // opens them. A future version bumps `version` and reads 1 alongside it — never in place of it.
    if (envelope.version !== 1) {
      throw new Error(
        `unsupported vault envelope version ${String(envelope.version)} in ${this.#path}`,
      );
    }
  }
}
