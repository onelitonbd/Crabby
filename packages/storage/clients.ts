// Client identities and pairing codes. Two rules from `docs/INTERFACES_AND_API.md` §3.1 decide the shape here: a token
// is "never stored server-side in plaintext", and a pairing code is single-use and short-lived, so *both* live as
// SHA-256 digests and the plaintext exists only in the response that hands it over. A revocation must take effect on
// the next request (§3.1), which this table serves by having no cached decision anywhere.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { CLIENT_INTERFACES, type ClientInterface } from "@crabby/api-contracts";
import type { SqliteDb } from "./db.ts";

// The four names are the contract's (`api-contracts/clients.ts`), not a list storage keeps beside it: a fifth
// interface is added once, and a table that accepted a sixth string would be a table of nothing.
export { CLIENT_INTERFACES, type ClientInterface };

/** §3.2: eight characters, no `0/O` or `1/I`, "short enough to read aloud, long enough not to be guessable at a few
 *  hundred attempts per minute against a single-use, short-lived record". The alphabet is 32 symbols, so a code is
 *  40 bits — and the TTL and single-use rule are what make that enough, which is why both are enforced here. */
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const PAIRING_CODE_TTL_MS = 120_000;

export interface Identity {
  readonly id: string;
  readonly name: string;
  readonly interface: ClientInterface;
  readonly capabilities: readonly string[];
  readonly createdAt: string;
  readonly lastUsedAt: string | undefined;
}

export function newPairingCode(): string {
  const bytes = randomBytes(8);
  let out = "";
  for (const byte of bytes) out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return out;
}

export function newToken(): string {
  // D-051: opaque, no expiry — revocation is the control.
  return randomBytes(32).toString("base64url");
}

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Constant-time comparison, because a code check that leaks how many characters were right turns a 40-bit space into
 *  a ladder. The digest comparison below is exact, but the timing-safe form costs nothing and is the habit that
 *  matters when a real oracle appears. */
export function codesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface PairingRecord {
  readonly code: string;
  readonly clientId: string;
  readonly expiresAt: string;
}

export function createIdentity(
  db: SqliteDb,
  input: {
    name: string;
    interface: ClientInterface;
    capabilities?: readonly string[];
    now?: string;
  },
): { identity: Identity; token: string } {
  const now = input.now ?? new Date().toISOString();
  // Not `newId(...)`: `packages/api-contracts/ids.ts` documents five prefixes and none of them is a client identity,
  // so minting a sixth here would be a contract change smuggled in through storage. An opaque id is what §3.1
  // specifies ("a client identity: { id, name, interface, … }") and nothing more; O-070 is the open question.
  const id = randomBytes(10).toString("base64url");
  const token = newToken();
  db.prepare(
    `INSERT INTO client_identity (id, name, interface, capability_json, token_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.name,
    input.interface,
    JSON.stringify(input.capabilities ?? []),
    digest(token),
    now,
  );
  return {
    identity: {
      id,
      name: input.name,
      interface: input.interface,
      capabilities: input.capabilities ?? [],
      createdAt: now,
      lastUsedAt: undefined,
    },
    token,
  };
}

export function mintPairingCode(
  db: SqliteDb,
  input: {
    name: string;
    interface: ClientInterface;
    capabilities?: readonly string[];
    ttlMs?: number;
    now?: Date;
  },
): PairingRecord {
  const now = input.now ?? new Date();
  const { identity } = createIdentity(db, {
    name: input.name,
    interface: input.interface,
    ...(input.capabilities ? { capabilities: input.capabilities } : {}),
    now: now.toISOString(),
  });
  const code = newPairingCode();
  const expiresAt = new Date(now.getTime() + (input.ttlMs ?? PAIRING_CODE_TTL_MS)).toISOString();
  db.prepare("INSERT INTO pairing_code (code_hash, client_id, expires_at) VALUES (?, ?, ?)").run(
    digest(code),
    identity.id,
    expiresAt,
  );
  return { code, clientId: identity.id, expiresAt };
}

export interface RedeemResult {
  readonly ok: boolean;
  readonly clientId?: string;
  readonly token?: string;
  readonly reason?: "unknown" | "expired" | "used";
}

export function redeemPairingCode(db: SqliteDb, code: string, now = new Date()): RedeemResult {
  const row = db
    .prepare("SELECT client_id, expires_at, used_at FROM pairing_code WHERE code_hash = ?")
    .get(digest(code)) as
    | { client_id: string; expires_at: string; used_at: string | null }
    | undefined;
  if (!row) return { ok: false, reason: "unknown" };
  if (row.used_at !== null) return { ok: false, reason: "used" };
  if (new Date(row.expires_at).getTime() < now.getTime()) return { ok: false, reason: "expired" };
  const token = newToken();
  db.transaction(() => {
    db.prepare("UPDATE pairing_code SET used_at = ? WHERE code_hash = ?").run(
      now.toISOString(),
      digest(code),
    );
    db.prepare("UPDATE client_identity SET token_hash = ? WHERE id = ?").run(
      digest(token),
      row.client_id,
    );
  })();
  return { ok: true, clientId: row.client_id, token };
}

export function authenticate(db: SqliteDb, token: string, now = new Date()): Identity | undefined {
  const row = db
    .prepare(
      "SELECT id, name, interface, capability_json, created_at, last_used_at FROM client_identity WHERE token_hash = ?",
    )
    .get(digest(token)) as
    | {
        id: string;
        name: string;
        interface: string;
        capability_json: string;
        created_at: string;
        last_used_at: string | null;
      }
    | undefined;
  if (!row) return undefined;
  db.prepare("UPDATE client_identity SET last_used_at = ? WHERE id = ?").run(
    now.toISOString(),
    row.id,
  );
  return {
    id: row.id,
    name: row.name,
    interface: row.interface as ClientInterface,
    capabilities: JSON.parse(row.capability_json) as string[],
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? undefined,
  };
}

export function listIdentities(db: SqliteDb): Identity[] {
  const rows = db
    .prepare(
      "SELECT id, name, interface, capability_json, created_at, last_used_at FROM client_identity ORDER BY created_at ASC, id ASC",
    )
    .all() as {
    id: string;
    name: string;
    interface: string;
    capability_json: string;
    created_at: string;
    last_used_at: string | null;
  }[];
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    interface: row.interface as ClientInterface,
    capabilities: JSON.parse(row.capability_json) as string[],
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? undefined,
  }));
}

export function revoke(db: SqliteDb, id: string): boolean {
  return db.prepare("DELETE FROM client_identity WHERE id = ?").run(id).changes > 0;
}
