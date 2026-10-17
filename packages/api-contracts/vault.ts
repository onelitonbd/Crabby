// §3.7's vault, as the wire sees it. The routes are read-and-state: `GET /vault` answers the status §7 says must
// always be visible (which store, which state, the weaker-store disclosure when the file store is the one this
// device has); `POST /vault/unlock` opens the Gateway's in-memory session and re-composes the provider list from
// configuration + vault; `POST /vault/lock` closes it. The passphrase rides the body — over loopback to a
// token-guarded route, or over the tunnel's TLS — and appears nowhere else: not in an audit row, not in a log,
// not in an event. The unlock answer carries what the re-composition decided per entry, because D-031's
// "reported clearly on all four interfaces" starts with the interface that did the unlocking knowing what changed.
//
// The runner note in the unlock answer states the one honest limit (recorded in D-139): composition is hot, the
// runner is not — a Gateway that started with no usable model has no runner to re-arm, and the answer names the
// restart that finishes the job rather than implying the task surface came back with the keys.

import { type Static, Type } from "@sinclair/typebox";

export const VaultPassphrase = Type.String({ minLength: 1, maxLength: 1024 });

export const VaultUnlockBody = Type.Object(
  { passphrase: VaultPassphrase },
  { additionalProperties: false },
);

export const VaultStoreKind = Type.Union([
  Type.Literal("keychain"),
  Type.Literal("file"),
  Type.Literal("none"),
]);

export const VaultState = Type.Union([
  Type.Literal("unset"),
  Type.Literal("locked"),
  Type.Literal("unlocked"),
]);

export const VaultStatusBody = Type.Object(
  {
    kind: VaultStoreKind,
    state: VaultState,
    entries: Type.Optional(Type.Integer({ minimum: 0 })),
    names: Type.Optional(Type.Array(Type.String())),
    note: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const VaultRefusedEntry = Type.Object(
  { id: Type.String(), reason: Type.String() },
  { additionalProperties: false },
);

export const VaultUnlockAnswer = Type.Object(
  {
    state: Type.Literal("unlocked"),
    providers: Type.Object(
      {
        composed: Type.Integer({ minimum: 0 }),
        refused: Type.Array(VaultRefusedEntry),
      },
      { additionalProperties: false },
    ),
    /** §7's disclosure when the store is the encrypted file, and the runner sentence when the process that
     *  started locked has no runner to re-arm. A surface prints it; that is the "reported clearly" half. */
    note: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const VaultLockAnswer = Type.Object(
  {
    state: Type.Literal("locked"),
    providers: Type.Object(
      {
        composed: Type.Integer({ minimum: 0 }),
        refused: Type.Array(VaultRefusedEntry),
      },
      { additionalProperties: false },
    ),
    note: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export type VaultUnlockBodyT = Static<typeof VaultUnlockBody>;
export type VaultStatusBodyT = Static<typeof VaultStatusBody>;
export type VaultUnlockAnswerT = Static<typeof VaultUnlockAnswer>;
export type VaultLockAnswerT = Static<typeof VaultLockAnswer>;
