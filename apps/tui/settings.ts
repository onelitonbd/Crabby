// T13's settings view, hosted in the logs pane's `v` cycle — same reasoning as the access view: the review groups
// "Settings/access/logs", and T1-02's six-name row has no seventh seat.
//
// T13-01's rule is the whole design: the key list is **walked out of `configSchema()`'s own properties**, not
// hand-coded — a new key in the schema appears here on its own, which is what makes this the same source of truth the
// Web form reads. The edit is the CLI's own pipeline (`applyConfigKey` → `writeConfig` with the read token), so the
// TUI and `crabby config set` cannot disagree about what a write is or refuse a stale write differently (§2's
// compare-and-swap, D-107). T13-03's diff is `-`/`+` lines a person can paste into an issue, shown *before* the apply,
// and T13-04's T3 marker sits on the security-relevant rows as a word — never colour alone.
//
// Carried gaps, printed in the view: density (T13-05), a colour-tier override (T13-06 — it needs a config key that
// does not exist yet), retention sizes (T13-07 — the keys edit, the byte counts belong to `crabby diagnostics`),
// sanitized export (T13-08) and language (T13-09 — D-062's shaping caveat).

import { applyConfigKey, type ConfigFile, configSchema, type writeConfig } from "@crabby/core";
import { clip } from "./render.ts";

/** One editable key, as the walk produced it. `value` is the merged view's answer (defaults applied), which is what
 *  the user is running on; the write round-trips the *file*'s document, so editing never freezes today's defaults
 *  into the user's config — the same rule `crabby config set` follows. */
export interface ConfigEntry {
  readonly key: string;
  readonly value: unknown;
  readonly kind: "string" | "number" | "boolean" | "array" | "json";
  /** T13-04's marker: the §-relevant families are the ones whose names already carry weight in SECURITY.md. */
  readonly security: boolean;
}

const SECURITY_FAMILIES: readonly string[] = ["shell", "net", "workspace", "provider"];

const kindOf = (schemaNode: Record<string, unknown>): ConfigEntry["kind"] => {
  const type = schemaNode.type;
  if (type === "array") return "array";
  if (type === "number" || type === "integer") return "number";
  if (type === "boolean") return "boolean";
  if (type === "string") return "string";
  return "json";
};

function walk(
  properties: Record<string, Record<string, unknown>>,
  prefix: string,
  segment: Record<string, unknown> | undefined,
  out: ConfigEntry[],
): void {
  for (const [key, schemaNode] of Object.entries(properties)) {
    const dotted = prefix === "" ? key : `${prefix}.${key}`;
    const family = dotted.split(".")[0] ?? "";
    const security = SECURITY_FAMILIES.includes(family);
    const value = segment?.[key];
    const childProperties = schemaNode.properties as
      | Record<string, Record<string, unknown>>
      | undefined;
    if (childProperties !== undefined && schemaNode.type === "object") {
      walk(
        childProperties,
        dotted,
        value === undefined ? undefined : (value as Record<string, unknown>),
        out,
      );
      continue;
    }
    if (schemaNode.type === "object" && childProperties === undefined) {
      // A record (`provider.<id>`): its keys live in the user's document, not in the schema — but the schema DOES
      // describe what an entry looks like (TypeBox's `patternProperties`), so the walk uses it and `provider.local.
      // baseUrl` appears exactly as `crabby config set` spells it. An entry the schema cannot describe stays one
      // opaque JSON value rather than a guess.
      const patterns = schemaNode.patternProperties as
        | Record<string, Record<string, unknown>>
        | undefined;
      const entrySchema =
        patterns === undefined
          ? undefined
          : (Object.values(patterns)[0] as Record<string, unknown> | undefined);
      const entryProperties = entrySchema?.properties as
        | Record<string, Record<string, unknown>>
        | undefined;
      if (entryProperties !== undefined && value !== undefined && typeof value === "object") {
        for (const child of Object.keys(value as Record<string, unknown>)) {
          walk(
            entryProperties,
            `${dotted}.${child}`,
            (value as Record<string, unknown>)[child] as Record<string, unknown> | undefined,
            out,
          );
        }
      }
      continue;
    }
    out.push({ key: dotted, value, kind: kindOf(schemaNode), security });
  }
}

/** T13-01: the entries are the schema's own walk over the running config. New schema keys show up uninvited. */
export function configEntries(config: ConfigFile): readonly ConfigEntry[] {
  const schema = configSchema() as {
    properties?: Record<string, Record<string, unknown>>;
  };
  const out: ConfigEntry[] = [];
  if (schema.properties !== undefined) {
    walk(schema.properties, "", config as unknown as Record<string, unknown>, out);
  }
  return out;
}

/** T13-03's diff, in the paste-into-an-issue shape. The values are JSON so a boolean never reads like a string. */
export function diffLines(
  key: string,
  previous: unknown,
  next: unknown,
  columns: number,
): readonly string[] {
  const before = JSON.stringify(previous ?? null);
  const after = JSON.stringify(next ?? null);
  return [clip(`- ${key}: ${before}`, columns), clip(`+ ${key}: ${after}`, columns)];
}

const shown = (value: unknown): string => {
  if (value === undefined) return "(unset — the default stands)";
  const json = JSON.stringify(value);
  return json.length > 60 ? `${json.slice(0, 57)}…` : json;
};

/** The list: one line per key, T3 rows marked as a word before the edit (T13-04), the current value beside it. */
export function settingsLines(
  entries: readonly ConfigEntry[],
  columns: number,
  selected: number,
  options: {
    readonly editing?: string | undefined;
    readonly buffer?: string | undefined;
    readonly diff?: readonly string[] | undefined;
  } = {},
): readonly string[] {
  const lines: string[] = [
    clip(`config — ${String(entries.length)} keys from the schema`, columns),
    clip("Enter edit · j/k move · Esc back (write on third Enter)", columns),
  ];
  const first = Math.max(0, Math.min(selected - 4, entries.length - 9));
  const shownEntries = entries.slice(first, first + 9);
  for (let index = 0; index < shownEntries.length; index += 1) {
    const entry = shownEntries[index] as ConfigEntry;
    const isSelected = first + index === selected;
    const cursor = isSelected ? ">" : " ";
    const marker = entry.security ? "T3 " : "";
    lines.push(clip(`${cursor} ${marker}${entry.key}`, columns));
    if (isSelected) {
      lines.push(clip(`  now: ${shown(entry.value)} (${entry.kind})`, columns));
      if (options.editing === entry.key) {
        lines.push(clip(`  new value: ${options.buffer ?? ""}▏ Enter shows the diff`, columns));
      }
      if (options.diff !== undefined && options.editing === entry.key) {
        lines.push(...options.diff);
        lines.push(clip("  Enter writes · Esc leaves it as it was", columns));
      }
    }
  }
  lines.push(
    clip(
      "gaps: density T13-05 · colour override T13-06 · retention sizes T13-07 → diagnostics · export T13-08 · language T13-09",
      columns,
    ),
  );
  return lines;
}

/** The parse the edit hands in: JSON when it parses, a string when it does not — the CLI's own rule, so `true` becomes
 *  a boolean and `ollama` stays a word. An unparsable array is refused by the schema at write time, with its sentence. */
export function parseValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The write, as one act so the view cannot apply half of it: the key lands on the *file's* document (never the merged
 *  view), and the token the read produced is presented back, so a config the Gateway's `PUT /config` changed between
 *  the read and the write is refused rather than silently overwritten (§2, D-107). */
export function applyEdit(
  config: { readonly file: ConfigFile; readonly token: string },
  key: string,
  text: string,
  write: typeof writeConfig,
  layout: Parameters<typeof writeConfig>[0],
): { readonly ok: boolean; readonly message: string } {
  const next = applyConfigKey(config.file, key, parseValue(text)) as ConfigFile;
  const result = write(layout, next, undefined, { token: config.token });
  return result.ok
    ? { ok: true, message: `${key} written — the diff above is what changed` }
    : { ok: false, message: `refused: ${result.message}` };
}
