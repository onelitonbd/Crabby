// §3.8's override record, built and stored — the one place any writer's answer becomes a stored value.
//
// **This file exists so that D-064's claim is checkable rather than aspirational**: "per-field prompts, or flags, or
// both… both paths must reach the same stored value". Interaction shapes that each compute their own object would
// reach the same value until the day one of them learned a rule the other did not, and the divergence would be a
// `config.json` that says something different depending on how a person answered. So `crabby model edit`'s prompts and
// flags collect *answers*, the Gateway's `PUT …/overrides` body is the same answer shape, and everything past that
// point — the record rules, the parse, the sibling-key write, the re-composition report — happens here, once.
//
// **The rules that live here rather than in any verb**, because each of them is a rule about the *stored value*:
//
//   - `auto` is how one flag is cleared, and `clear` is how the record is removed. Both come out of §3.8's
//     `supports.<flag>` column: "no opinion" has to be expressible, or "I never said" and "I said no" would be the same
//     file.
//   - An empty record is not a state. §3.8's table describes a record of what the user changed; a record with nothing in
//     it is a claim that the user changed nothing, which the absent record already says — so clearing every flag removes
//     the key rather than writing `{}` (D-126's schema note).
//   - A limit is not "changed" by restating it. The diff the caller prints compares against the *effective* value, so
//     restating today's number is reported as no change rather than as a claim the user made.
//   - A feature that is not in the data model is refused here, not stored. `parseOverride` in this package is the
//     authority and is called on the result before anything is written, so no writer can be the one place a bad record
//     reaches `config.json`.
import type { ConfigFile } from "@crabby/core";
import { composeProviders } from "./compose.ts";
import type { ModelOverride, OverrideProvenance } from "./override.ts";
import { parseOverride } from "./override.ts";

/** One answer, however it was given. `supports` holds `true`, `false` or `auto` as the caller typed it — this shape is
 *  the hand-off point between every interaction shape and the stored record. `undefined` for a field means "this
 *  question was not asked", which is different from `"auto"`, which means "asked, and the answer is no opinion". */
export interface OverrideAnswers {
  readonly context?: number | undefined;
  readonly maxOutput?: number | undefined;
  readonly supports?: Readonly<Record<string, "true" | "false" | "auto">> | undefined;
  readonly notes?: string | undefined;
  /** Remove the whole record. Refused together with any other answer, because "clear everything" and "set one flag" are
   *  different requests and a writer that honoured both would have to pick which one was meant. */
  readonly clear?: boolean | undefined;
}

export type NextOverride =
  | { readonly ok: true; readonly override: ModelOverride | undefined }
  | { readonly ok: false; readonly reason: string };

/** The whole of the stored-value rules, in the order a caller would hit them. `current` is the record as it stands (or
 *  nothing). */
export function nextOverride(
  current: ModelOverride | undefined,
  answers: OverrideAnswers,
): NextOverride {
  if (answers.clear === true) {
    const askedSomethingElse =
      answers.context !== undefined ||
      answers.maxOutput !== undefined ||
      answers.supports !== undefined ||
      answers.notes !== undefined;
    if (askedSomethingElse) {
      return {
        ok: false,
        reason:
          "`--clear` removes the whole override record, and it was asked together with something to set — run them as " +
          "two commands, or drop the clear and set the fields you meant",
      };
    }
    // `undefined` for the record: the caller deletes the key. An empty object would be a claim that the user changed
    // nothing, which is what an absent key already says.
    return { ok: true, override: undefined };
  }

  // `ModelOverride.supports` is typed `boolean | "auto"` because `parseOverride` accepts the tri-state; a *stored*
  // record never holds `"auto"` — that is what "no opinion" means, and it is written by removing the key. The filter
  // below is therefore not defensive coding: it is the rule that keeps the type's wider arm from reaching the file.
  const supports: Record<string, boolean | "auto"> = {};
  for (const [feature, value] of Object.entries(current?.supports ?? {})) {
    if (value !== "auto") supports[feature] = value as boolean;
  }
  for (const [feature, value] of Object.entries(answers.supports ?? {})) {
    if (value === "auto") {
      // "No opinion" removes the override rather than storing the string: a stored `"auto"` would have to be read
      // everywhere a `supports` value is read, and the whole point of `auto` is that the reported value is untouched.
      delete supports[feature];
      continue;
    }
    supports[feature] = value === "true";
  }

  const limits: { contextWindow?: number; maxOutputTokens?: number } = {
    ...(current?.limits ?? {}),
  };
  if (answers.context !== undefined) limits.contextWindow = answers.context;
  if (answers.maxOutput !== undefined) limits.maxOutputTokens = answers.maxOutput;

  // An empty note means "no note", the same way an empty prompt answer means "leave this alone": a stored `""` would be a
  // note field that reads as written and says nothing, and §3.8's `notes` is free text for a human, not a flag.
  const notes =
    answers.notes === undefined
      ? current?.notes
      : answers.notes.length === 0
        ? undefined
        : answers.notes;
  const override: ModelOverride = {
    // A record with nothing in it is not stored. `source` stays `manual` on every edit because every writer of this
    // record in this build speaks for a person; a preset writes its own records (D-126's §3.8 chain has one hop today),
    // and a future writer sets this itself rather than inheriting a `manual` label it did not earn.
    source: "manual",
    ...(Object.keys(supports).length === 0 ? {} : { supports }),
    ...(Object.keys(limits).length === 0 ? {} : { limits }),
    ...(notes === undefined ? {} : { notes }),
  };
  if (
    Object.keys(supports).length === 0 &&
    Object.keys(limits).length === 0 &&
    notes === undefined
  ) {
    return { ok: true, override: undefined };
  }

  // The authority is this package, not the caller: composition parses the record with `parseOverride` and refuses the
  // provider when it does not hold, so a record a writer saved but the runtime would refuse would be a file that
  // disables a model until someone read the error. Validating here means the refusal arrives while the caller watches.
  const parsed = parseOverride(override);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  return { ok: true, override: parsed.override };
}

/** What a stored record changes about the effective descriptor, as a human sentence per field. The comparison is against
 *  the **effective** values composition produced, so restating today's number is reported as no change rather than as a
 *  claim — the same rule `model list` uses when it prints the override column. */
export function describeOverride(
  provenance: Pick<OverrideProvenance, "supports" | "limits"> | undefined,
): readonly string[] {
  if (provenance === undefined) return [];
  const lines: string[] = [];
  const supports = (provenance.supports ?? {}) as Record<string, { from: boolean; to: boolean }>;
  for (const [feature, move] of Object.entries(supports)) {
    lines.push(`${feature}: ${String(move.from)} → ${String(move.to)} (declared by you, §3.8)`);
  }
  const limits = provenance.limits;
  if (limits !== undefined) {
    if (limits.from?.contextWindow !== undefined) {
      lines.push(
        `contextWindow: ${limits.from.contextWindow} → ${limits.to.contextWindow} — budgeting (D-064) sizes ` +
          "compaction against this now",
      );
    }
    if (limits.from?.maxOutputTokens !== undefined) {
      lines.push(
        `maxOutputTokens: ${limits.from.maxOutputTokens} → ${limits.to.maxOutputTokens} — D-064 derives the output ` +
          "reserve from this, so §3.8's `reserveForOutput` is not stored (F-62)",
      );
    }
  }
  return lines;
}

/** The storage step, one implementation for every writer — `crabby model edit`, the Gateway's
 *  `PUT /models/{provider}/{model}/overrides`, and the TUI's T11 editor all land here. D-064's claim ("both paths must
 *  reach the same stored value") is about the *record*, and `nextOverride` is half of it; this is the rest: two writers
 *  that each cloned the document, set the sibling key and called their own writer would agree until the day one of them
 *  learned the empty-`overrides`-map rule the other had not. The rules are: the record is a sibling of `models`
 *  (D-126), an absent record is `delete` and not `{}`, an empty `overrides` map is removed with it, and the write is
 *  CAS-guarded by the token the read handed over (`If-Match`'s shape, §2's concurrency row).
 *
 *  The document write itself is **injected** rather than imported: this package does not own a file layout, and a
 *  second copy of `writeConfig`'s contract here is exactly the drift the rest of the file refuses. Every caller binds
 *  the same `writeConfig` its own process already uses, with the token it read the document under.
 *
 *  The composition is re-run here — the same pure function on the same document a Gateway composes at startup — so the
 *  report is what the next process will use rather than a second opinion about the file. */
export interface OverrideWriteReport {
  readonly ok: boolean;
  readonly message?: string;
  readonly code?: ConfigWriteCode;
  /** What was stored: the record, or `undefined` for a clear. */
  readonly override: ModelOverride | undefined;
  /** `describeOverride`'s report over the composed provenance — what actually moved, not what was typed. */
  readonly changes: readonly string[];
  readonly composed: boolean;
  readonly composeReason?: string;
  /** The composed provenance object itself, for `--json` and for a route's body. */
  readonly provenance?: OverrideProvenance | undefined;
}

/** What a refused document write answers with, named once: the same three codes `@crabby/core`'s `writeConfig`
 *  answers with, and the same three `CONFIG_REFUSAL_CLASS` maps — a route should not need a fourth word for "the file
 *  did not move". */
export type ConfigWriteCode = "invalid" | "stale" | "unwritable";

/** The one way a stored document moves: `(file, token)` in, an answer that is either written or refused with the
 *  loader's own sentence and code. `@crabby/core`'s `writeConfig` bound to a layout is the reference implementation. */
export type ConfigPersister = (
  file: ConfigFile,
  token: string,
) =>
  | {
      readonly ok: true;
    }
  | { readonly ok: false; readonly message: string; readonly code?: ConfigWriteCode };

export function writeOverrideRecord(input: {
  readonly persist: ConfigPersister;
  readonly loaded: { readonly file: ConfigFile; readonly token: string };
  readonly providerId: string;
  readonly modelId: string;
  readonly override: ModelOverride | undefined;
}): OverrideWriteReport {
  const file = structuredClone(input.loaded.file) as Record<string, unknown>;
  const providers = { ...((file.provider ?? {}) as Record<string, unknown>) };
  const entry0 = { ...((providers[input.providerId] ?? {}) as Record<string, unknown>) };
  const overrides = { ...((entry0.overrides ?? {}) as Record<string, unknown>) };
  if (input.override === undefined) delete overrides[input.modelId];
  else overrides[input.modelId] = input.override;
  if (Object.keys(overrides).length === 0) delete entry0.overrides;
  else entry0.overrides = overrides;
  providers[input.providerId] = entry0;
  file.provider = providers;

  const written = input.persist(file as ConfigFile, input.loaded.token);
  if (!written.ok) {
    return {
      ok: false,
      message: written.message,
      ...(written.code === undefined ? {} : { code: written.code }),
      override: input.override,
      changes: [],
      composed: false,
    };
  }
  const composed = composeProviders((file as ConfigFile).provider);
  const entry1 = composed.find((row) => row.id === input.providerId);
  const provenance = entry1?.ok ? entry1.overrides[input.modelId] : undefined;
  return {
    ok: true,
    override: input.override,
    changes: describeOverride(provenance),
    composed: provenance !== undefined,
    ...(provenance === undefined
      ? {
          composeReason:
            entry1 !== undefined && !entry1.ok ? entry1.reason : "the provider did not compose",
        }
      : { provenance }),
  };
}
