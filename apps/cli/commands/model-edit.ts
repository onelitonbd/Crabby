// §3.8's override record, built — the one place a `crabby model edit` answer becomes a stored value.
//
// **This file exists so that D-064's claim is checkable rather than aspirational**: "per-field prompts, or flags, or
// both… both paths must reach the same stored value". Two interaction shapes that each compute their own object would
// reach the same value until the day one of them learned a rule the other did not, and the divergence would be a
// `config.json` that says something different depending on how a person answered. So the prompts collect *answers* and
// hand them here, and the flags parse into the same answer shape before they get here. Nothing below knows whether a
// terminal, a flag or a script produced it.
//
// **The rules that live here rather than in the verb**, because each of them is a rule about the *stored value*:
//
//   - `auto` is how one flag is cleared, and `--clear` is how the record is removed. Both come out of §3.8's
//     `supports.<flag>` column: "no opinion" has to be expressible, or "I never said" and "I said no" would be the same
//     file.
//   - An empty record is not a state. §3.8's table describes a record of what the user changed; a record with nothing in
//     it is a claim that the user changed nothing, which the absent record already says — so clearing every flag removes
//     the key rather than writing `{}` (D-126's schema note).
//   - A limit is not "changed" by restating it. The diff the verb prints compares against the *effective* value, so
//     restating today's number is reported as no change rather than as a claim the user made.
//   - A feature that is not in the data model is refused here, not stored. `parseOverride` in the providers package is
//     the authority and is called on the result before anything is written, so this verb cannot be the one place a bad
//     record reaches `config.json`.
import { type ModelOverride, parseOverride, SUPPORTED_FEATURES } from "@crabby/providers";

/** One answer, however it was given. `supports` holds `true`, `false` or `auto` as the person typed it — this shape is
 *  the hand-off point between the two interaction shapes and the stored record. */
export interface OverrideAnswers {
  readonly context?: number | undefined;
  readonly maxOutput?: number | undefined;
  readonly supports?: Readonly<Record<string, "true" | "false" | "auto">> | undefined;
  readonly notes?: string | undefined;
  /** Remove the whole record. Refused together with any other answer, because "clear everything" and "set one flag" are
   *  different requests and a command that honoured both would have to pick which one was meant. */
  readonly clear?: boolean | undefined;
}

export type NextOverride =
  | { readonly ok: true; readonly override: ModelOverride | undefined }
  | { readonly ok: false; readonly reason: string };

/** `true` | `false` | `auto`, spelled three ways, because three spellings is what a person and a script both reach
 *  for: `--supports streaming=on` reads better at a terminal than `=true`, and `=1` is what a shell generates. Anything
 *  else is refused with the three words that would have worked. */
function parseTri(value: string): "true" | "false" | "auto" | undefined {
  const text = value.trim().toLowerCase();
  if (text === "true" || text === "on" || text === "yes" || text === "1") return "true";
  if (text === "false" || text === "off" || text === "no" || text === "0") return "false";
  if (text === "auto") return "auto";
  return undefined;
}

/** `--supports toolCalling=true,streaming=false`. Comma-separated rather than repeatable because the tail parser keeps one
 *  value per flag, and a second `--supports` would silently replace the first — the failure mode where a user widens
 *  nothing and believes they did. */
export function parseSupports(raw: string | undefined): {
  readonly ok: boolean;
  readonly supports?: Record<string, "true" | "false" | "auto">;
  readonly reason?: string;
} {
  if (raw === undefined) return { ok: true };
  const supports: Record<string, "true" | "false" | "auto"> = {};
  for (const pair of raw.split(",")) {
    const text = pair.trim();
    if (text.length === 0) continue;
    const equals = text.indexOf("=");
    if (equals <= 0) {
      return {
        ok: false,
        reason: `'${text}' is not a feature=value pair — the form is --supports toolCalling=true (true/false/auto, or on/off, yes/no, 1/0)`,
      };
    }
    const feature = text.slice(0, equals).trim();
    const value = parseTri(text.slice(equals + 1));
    if (value === undefined) {
      return {
        ok: false,
        reason: `'${text.slice(equals + 1).trim()}' is not a value for ${feature} — true, false or auto (or on/off, yes/no, 1/0); auto means "whatever the endpoint reported"`,
      };
    }
    if (!(SUPPORTED_FEATURES as readonly string[]).includes(feature)) {
      return {
        ok: false,
        reason: `'${feature}' is not a capability of §3.2; a model has ${SUPPORTED_FEATURES.join(", ")}`,
      };
    }
    supports[feature] = value;
  }
  return { ok: true, supports };
}

/** The whole of the stored-value rules, in the order a person would hit them. `current` is the record as it stands (or
 *  nothing), and the answer's `undefined` means "this question was not asked" — which is different from `"auto"`, which
 *  means "asked, and the answer is no opinion". */
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
          "two commands, or drop the `--clear` and set the fields you meant",
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
    if (value !== "auto") supports[feature] = value;
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
    // A record with nothing in it is not stored. `source` stays `manual` on every edit because the only writer of this
    // record in this build is a person at a terminal; a preset writes its own records (D-126's §3.8 chain has one hop
    // today), and a future writer sets this itself rather than inheriting a `manual` label it did not earn.
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

  // The authority is `packages/providers`, not this file: composition parses the record with `parseOverride` and refuses
  // the provider when it does not hold, so a record this verb wrote but the runtime would refuse would be a file that
  // disables a model until someone read the error. Validating here means the refusal arrives while the user is watching.
  const parsed = parseOverride(override);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  return { ok: true, override: parsed.override };
}

/** What a stored record changes about the effective descriptor, as a human sentence per field. The comparison is against
 *  the **effective** values composition produced, so restating today's number is reported as no change rather than as a
 *  claim — the same rule `model list` uses when it prints the override column. */
export function describeOverride(
  provenance:
    | {
        readonly supports?: Readonly<Record<string, { from: boolean; to: boolean }>> | undefined;
        readonly limits?:
          | Readonly<{
              from?: { contextWindow?: number; maxOutputTokens?: number };
              to: { contextWindow: number; maxOutputTokens: number };
            }>
          | undefined;
      }
    | undefined,
): readonly string[] {
  if (provenance === undefined) return [];
  const lines: string[] = [];
  for (const [feature, move] of Object.entries(provenance.supports ?? {})) {
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
