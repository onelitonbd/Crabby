// `crabby model edit`'s interaction half — the one place a terminal answer becomes `OverrideAnswers`.
//
// **The record rules and the storage step live in `@crabby/providers` (`override-write.ts`)**, because D-064's claim —
// "per-field prompts, or flags, or both… both paths must reach the same stored value" — stopped being CLI-only the day
// the Gateway's `PUT /models/{provider}/{model}/overrides` served the same writer. What remains here is what only a
// terminal needs: the flag spellings (`--supports toolCalling=on`, three spellings of each value, because a person and
// a shell both reach for their own), and the binding of this process's `writeConfig` to the shared storage step.
// Nothing below knows a rule about the *stored value*; it parses what a person typed and hands it over.
import { type ConfigFile, writeConfig } from "@crabby/core";
import type { DataLayout } from "@crabby/platform";
import { SUPPORTED_FEATURES } from "@crabby/providers";

// The shared halves, re-exported under this verb's own name so a caller of the CLI's modules keeps one import site:
// `nextOverride` (the record rules), `describeOverride` (the report), and the storage step — bound to this layout by
// `writeOverrideRecord` below, which keeps the shape `crabby provider` has always called.
export {
  describeOverride,
  type NextOverride,
  nextOverride,
  type OverrideAnswers,
  type OverrideWriteReport,
  writeOverrideRecord as writeStoredOverrideRecord,
} from "@crabby/providers";

import { writeOverrideRecord as writeStoredOverrideRecord } from "@crabby/providers";

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

/** The storage step with this process's writer bound in — the same `writeConfig` every other write in this process
 *  uses, with the token the read handed over. The record rules and the sibling-key write they feed are
 *  `@crabby/providers`'s `writeStoredOverrideRecord`, one implementation for the CLI, the Gateway's route and the
 *  TUI's editor (D-064/D-127). */
export function writeOverrideRecord(
  layout: DataLayout,
  loaded: { readonly file: ConfigFile; readonly token: string },
  providerId: string,
  modelId: string,
  override: Parameters<typeof writeStoredOverrideRecord>[0]["override"],
): ReturnType<typeof writeStoredOverrideRecord> {
  return writeStoredOverrideRecord({
    persist: (file, token) => {
      const written = writeConfig(layout, file, undefined, { token });
      return written.ok
        ? { ok: true as const }
        : {
            ok: false as const,
            message: written.message,
            ...(written.code === undefined ? {} : { code: written.code }),
          };
    },
    loaded,
    providerId,
    modelId,
    override,
  });
}
