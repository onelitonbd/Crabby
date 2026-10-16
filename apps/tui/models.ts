// `apps/tui/models.ts` — the models pane (region T11): the model list, the capability matrix and the notices, a pure
// projection over the two records §3.8 keeps beside each other (D-126): the stored descriptor a provider is *reported*
// with, and the user's override record as a sibling. The pane shows both halves and their composition — "reported vs
// effective per capability" (T11-02) — because a list that showed only the override would make it impossible to tell
// whether the endpoint moved or the user did.
//
// What is here is the read half plus the two notices and the probe's named gap. T11-03/04/06/08's editor (auto / force
// on / force off per capability, limit inputs, reset, notes) lands as its own step; until then the pane names
// `crabby model edit <p>/<m>` as the verb that writes what this screen reads, because §8 forbids a shortcut-only
// capability and a screen that shows a value nobody can change is half of one.
//
// The shapes are `@crabby/providers`' own: `parseDescriptor`, `parseOverride` and `applyOverride` are the same functions
// `crabby model list` composes with (D-125's "composes in-process" rule), so this pane and the CLI cannot hold two
// opinions about what a model's effective descriptor is.

import {
  type ApplyResult,
  applyOverride,
  type ModelDescriptor,
  type ModelOverride,
  parseDescriptor,
  parseOverride,
  SUPPORTED_FEATURES,
  type SupportedFeature,
} from "@crabby/providers";
import type { OverrideAnswers } from "../cli/commands/model-edit.ts";
import { type ComposerState, composerView, emptyComposer } from "./composer.ts";
import type { PaneContext } from "./panes.ts";
import { clip } from "./render.ts";

/** One model as the pane reads it: what was reported, what the user wrote, and what the two compose to — with the
 *  problems kept in words rather than swallowed, the §3.2 rule that a descriptor that does not parse *disables* rather
 *  than defaults. */
export interface ModelView {
  readonly provider: string;
  readonly model: string;
  readonly reported?: ModelDescriptor | undefined;
  readonly reportedProblem?: string | undefined;
  readonly override?: ModelOverride | undefined;
  readonly overrideProblem?: string | undefined;
  readonly effective?: ModelDescriptor | undefined;
  /** Which fields the record touches, in the record's own keys — "what did I change here" (the labels), not "what did it
   *  do" (the provenance), because one word cannot answer both. */
  readonly overridden: readonly string[];
}

/** §3.2's `cost` union, as a class word. `null` is `unmeasured`, never `free` — a different claim, and the one a
 *  budget (D-064) must not be handed as if it were zero. */
export function costClass(cost: ModelDescriptor["cost"]): string {
  if (cost === null) return "unmeasured (not free)";
  if (typeof cost === "string") return cost;
  return `${String(cost.promptPerMTok)} in / ${String(cost.completionPerMTok)} out per MTok`;
}

/** The config document's `provider` map as the pane sees it: each `<provider>/<model>` pair parsed and composed with the
 *  same functions the CLI uses, so the TUI and `crabby model list` answer identically. */
export function modelViewsFrom(
  providers: Record<string, Record<string, unknown>> | undefined,
): readonly ModelView[] {
  const views: ModelView[] = [];
  for (const [provider, entry] of Object.entries(providers ?? {})) {
    const models = (entry.models ?? {}) as Record<string, unknown>;
    const overrides = (entry.overrides ?? {}) as Record<string, unknown>;
    for (const [model, rawDescriptor] of Object.entries(models)) {
      const descriptor = parseDescriptor(rawDescriptor);
      const rawOverride = overrides[model];
      const override = rawOverride === undefined ? undefined : parseOverride(rawOverride);
      const composed: ApplyResult | undefined =
        descriptor.ok && override?.ok === true
          ? applyOverride(descriptor.descriptor, override.override)
          : undefined;
      views.push({
        provider,
        model,
        ...(descriptor.ok
          ? { reported: descriptor.descriptor }
          : { reportedProblem: descriptor.reason }),
        ...(override === undefined
          ? {}
          : override.ok
            ? { override: override.override }
            : { overrideProblem: override.reason }),
        ...(composed?.ok === true ? { effective: composed.descriptor } : {}),
        overridden:
          override?.ok === true
            ? [
                ...Object.keys(override.override.supports ?? {}),
                ...(override.override.limits?.contextWindow === undefined ? [] : ["contextWindow"]),
                ...(override.override.limits?.maxOutputTokens === undefined
                  ? []
                  : ["maxOutputTokens"]),
                ...(override.override.notes !== undefined &&
                Object.keys(override.override.supports ?? {}).length === 0
                  ? ["notes"]
                  : []),
              ]
            : [],
      });
    }
  }
  return views;
}

/** One notice rendered as whole clauses rather than one clipped line. T11-09 sizes its notice at "one line" and the
 *  40-column design case cannot carry 74 characters of it: a clipped `…cannot widen its` is a rule half-stated, and
 *  T17-03's protection of the state word is the inventory's own precedent for never clipping the point away. At the
 *  design case the notice wraps to a second drawn line; wide terminals see the one line the row describes. */
export function wrapNotice(text: string, columns: number, indent = "  "): readonly string[] {
  const width = Math.max(8, columns - indent.length);
  if (text.length <= width) return [`${indent}${text}`];
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current.length === 0) current = word;
    else if (`${current} ${word}`.length <= width) current = `${current} ${word}`;
    else {
      lines.push(`${indent}${current}`);
      current = word;
    }
  }
  if (current.length > 0) lines.push(`${indent}${current}`);
  return lines;
}

/** T11-01's row: `provider/model` + context at the design case, "the rest on the detail line" — output cap and cost
 *  class. A descriptor that does not parse prints its reason instead of a line of numbers (§3.2: disabled, not broken),
 *  and an override that does not parse is named on the row, because the CLI's `model edit` says why and a silent
 *  healthy-looking row would be the worst possible answer. */
export function modelLines(view: ModelView, selected: boolean, columns: number): readonly string[] {
  const cursor = selected ? "> " : "  ";
  const head = `${view.provider}/${view.model}`;
  if (view.reported === undefined) {
    // Wrapped, not clipped: the clause leads (`disabled, §3.2`) and the reason wraps whole, because a row that ends in
    // `…does not parse` tells a phone less than the same words spread over a second line.
    return [
      `${cursor}${clip(head, columns - 2)}`,
      ...wrapNotice(
        `disabled, §3.2 — the descriptor does not parse: ${view.reportedProblem ?? "unknown problem"}`,
        columns,
      ),
    ];
  }
  const context = view.effective?.contextWindow ?? view.reported.contextWindow;
  const flags = view.overridden.length === 0 ? "" : " *";
  const lines = [
    `${cursor}${clip(`${head} · ${String(context)} ctx${flags}`, columns - 2)}`,
    `  ${clip(
      `out ${String(view.effective?.maxOutputTokens ?? view.reported.maxOutputTokens)} · ${costClass(view.effective?.cost ?? view.reported.cost)}` +
        (view.overrideProblem === undefined
          ? ""
          : ` · override does not parse: ${view.overrideProblem}`),
      columns - 2,
    )}`,
  ];
  return lines;
}

/** T11-02's matrix: one row per capability, reported beside effective, an overridden cell marked `*` — the 8-color
 *  tier's suffix rule ("never color alone"), so the marker survives a terminal with no color at all. Three columns at
 *  40 columns: name, reported, effective. */
export function capabilityMatrix(view: ModelView, columns: number): readonly string[] {
  const reported = view.reported;
  const effective = view.effective;
  if (reported === undefined) return [];
  const width = Math.max(10, Math.min(20, columns - 14));
  const lines: string[] = [];
  lines.push(clip(`  ${"capability".padEnd(width)} rep  eff`, columns));
  for (const feature of SUPPORTED_FEATURES) {
    const rep = reported.supports[feature] === true ? "on" : "off";
    const moved =
      effective !== undefined && effective.supports[feature] !== reported.supports[feature];
    const eff = (effective ?? reported).supports[feature] === true ? "on" : "off";
    lines.push(`  ${feature.padEnd(width)} ${rep.padEnd(3)} ${eff}${moved ? "*" : ""}`);
  }
  return lines;
}

/** T11-05's forced-on notice — the sentence W10-05 shares, kept whole and in the same words on both screens so the
 *  interfaces cannot drift: a capability the user forced on is a claim no run has verified, and the failure it can
 *  produce has a name. */
export function forcedOnLines(view: ModelView): readonly string[] {
  const forced = Object.entries(view.override?.supports ?? {}).filter(
    ([, value]) => value === true,
  );
  if (forced.length === 0) return [];
  return [
    `forced on, unverified: ${forced.map(([feature]) => feature).join(", ")} — runtime verification has not run`,
    "a call that the endpoint refuses fails as `unsupported-capability`, not as silence",
  ];
}

/** T11-09's gate notice, present in this pane too: hiding it here would make the TUI the escape hatch from a rule every
 *  other surface states. */
export function t3GateLine(): string {
  return "T3: editing overrides is a config write; an agent cannot widen its own model";
}

/** T11-07's probe action, named as the gap it is: `POST /models/…/probe` has no route in this build (C7-09 is M4's,
 *  D-125 keeps it there because a probe calls a live endpoint with a credential a Gateway holds). The line is here so
 *  the pane never implies a probe ran. */
export function probeGapLine(view: ModelView): string {
  return (
    `probe: not built — POST /models/${view.provider}/${view.model}/probe has no route in this build ` +
    "(C7-09, M4) — no per-capability table can be printed"
  );
}

/** The pane body: the model rows (T11-01) with the selected model's matrix (T11-02) and the notices under it. A blank
 *  pane is a defect (T6-06's rule): the empty state names the verb that creates what is missing. */
export function modelsPane(
  context: PaneContext,
  views: readonly ModelView[],
  selected = 0,
): readonly string[] {
  if (context.offline) {
    return [
      `gateway unreachable (${context.lastConfirmed === undefined ? "never confirmed" : `last confirmed ${context.lastConfirmed}`})`,
      "restart it with: crabby gateway start",
    ];
  }
  if (views.length === 0) {
    return [
      "no models configured",
      "add one with: crabby provider add <id> --base-url <url> --model <id> --context <n> --max-output <n>",
    ];
  }
  // The selected model's block is sized first and the list rows fit around it: T11-02's matrix is the content the rows
  // exist to reach, and a list that pushed it off a 24-row screen would be a list of names with no answers under it.
  const view = views[Math.min(Math.max(0, selected), views.length - 1)] as ModelView;
  const block: string[] = [];
  if (view !== undefined) {
    block.push("  reported → effective (T11-02):");
    block.push(...capabilityMatrix(view, context.columns));
    block.push(...forcedOnLines(view).flatMap((line) => wrapNotice(line, context.columns)));
    block.push(...wrapNotice(t3GateLine(), context.columns));
    block.push(...wrapNotice(probeGapLine(view), context.columns));
  }
  const height = Math.max(1, context.rows - 3);
  const room = Math.max(0, height - block.length - 1);
  const lines: string[] = [];
  let shown = 0;
  for (let index = 0; index < views.length; index += 1) {
    const row = modelLines(views[index] as ModelView, index === selected, context.columns);
    if (lines.length + row.length > room && shown > 0) break;
    lines.push(...row);
    shown += 1;
  }
  if (shown < views.length) {
    lines.push(`…and ${views.length - shown} more — \`crabby model list\` lists them all`);
  }
  lines.push(...block);
  return lines;
}

/** T11-03's three-position control, in the row's own words. The cycle is `auto → force on → force off → auto`, and the
 *  words are drawn because the 8-color tier may have no distinguishing color — the same rule the matrix's `*` follows. */
export type SupportsChoice = "auto" | "force on" | "force off";

export function cycleChoice(choice: SupportsChoice): SupportsChoice {
  return choice === "auto" ? "force on" : choice === "force on" ? "force off" : "auto";
}

export function choiceOf(value: boolean | "auto" | undefined): SupportsChoice {
  return value === true ? "force on" : value === false ? "force off" : "auto";
}

/** The form T11-03/04/06/08 describe: typed limit inputs (numbers typed, not stepped — 131072 is a lot of `+` presses),
 *  a free-text note that survives verbatim into the config file, and one line per capability carrying the
 *  auto / force on / force off control. `reserve` is the third input T11-04 names and the record has no column for:
 *  F-62 closed `reserveForOutput` as derived (D-064), so the input is collected and reported as not-stored on save —
 *  the row is implemented as written and the discrepancy is raised rather than the input silently dropped. */
export interface ModelEditForm {
  readonly view: ModelView;
  readonly field: number;
  readonly context: ComposerState;
  readonly maxOutput: ComposerState;
  readonly reserve: ComposerState;
  readonly notes: ComposerState;
  readonly supports: Readonly<Record<SupportedFeature, SupportsChoice>>;
}

export const FORM_TEXT_FIELDS = ["context", "maxOutput", "reserve", "notes"] as const;

export function openModelForm(view: ModelView): ModelEditForm {
  const supports = {} as Record<SupportedFeature, SupportsChoice>;
  for (const feature of SUPPORTED_FEATURES) {
    supports[feature] = choiceOf(view.override?.supports?.[feature]);
  }
  const text = (value: string): ComposerState => ({
    buffer: value,
    cursor: value.length,
    history: [],
  });
  return {
    view,
    field: 0,
    context: text(String(view.effective?.contextWindow ?? view.reported?.contextWindow ?? "")),
    maxOutput: text(
      String(view.effective?.maxOutputTokens ?? view.reported?.maxOutputTokens ?? ""),
    ),
    reserve: emptyComposer(),
    notes: text(view.override?.notes ?? ""),
    supports,
  };
}

/** The form's drawn lines: the header, the four typed inputs (T11-04/T11-08), one line per capability (T11-03), the
 *  forced-on notice while one is set (T11-05), and T11-09's gate line — the pane-level notices repeat inside the editor
 *  because a person editing an override is exactly who must read them. */
export function formLines(form: ModelEditForm, columns: number): readonly string[] {
  const lines: string[] = [
    clip(`edit ${form.view.provider}/${form.view.model} — Enter saves · Esc cancels`, columns),
  ];
  const textField = (
    index: number,
    label: string,
    state: ComposerState,
    hint: string,
  ): readonly string[] => {
    const view = composerView(state, Math.max(4, columns - label.length - 5));
    const marker = form.field === index ? ">" : " ";
    const body = view.lines[0] ?? "";
    return body.length === 0 && hint.length > 0
      ? [`${marker} ${label} (${hint})`]
      : [`${marker} ${label} ${body}`];
  };
  lines.push(...textField(0, "context:", form.context, "typed"));
  lines.push(...textField(1, "max output:", form.maxOutput, "typed"));
  lines.push(...textField(2, "reserve:", form.reserve, "derived, not stored — F-62"));
  lines.push(...textField(3, "notes:", form.notes, "optional, kept verbatim"));
  let index = FORM_TEXT_FIELDS.length;
  for (const feature of SUPPORTED_FEATURES) {
    const marker = form.field === index ? ">" : " ";
    lines.push(
      `${marker} ${clip(`${feature.padEnd(20)} [${form.supports[feature]}]`, columns - 2)}`,
    );
    index += 1;
  }
  const forced = forcedOnLines(form.view);
  lines.push(...(forced.length === 0 ? [] : forced.flatMap((line) => wrapNotice(line, columns))));
  lines.push(...wrapNotice(t3GateLine(), columns));
  return lines;
}

/** A whole positive number out of a typed field, or `undefined` when the field was left empty. A buffer that is *not*
 *  empty and not a number is the caller's refusal to answer for — the CLI's flags share `parseSupports`'s rule and this
 *  form refuses the save rather than silently ignoring what a person can see they typed. */
export function typedInt(buffer: string): number | undefined {
  const raw = buffer.trim();
  if (raw.length === 0) return undefined;
  if (!/^\d+$/.test(raw)) return undefined;
  const value = Number.parseInt(raw, 10);
  return value > 0 ? value : undefined;
}

/** The form's answers as `OverrideAnswers` — the same hand-off shape the CLI's flags and prompts both produce, so
 *  `nextOverride` applies one set of stored-value rules to either surface (D-064's boundary). */
export function formAnswers(form: ModelEditForm): OverrideAnswers {
  const supports: Record<string, "true" | "false" | "auto"> = {};
  for (const feature of SUPPORTED_FEATURES) {
    const choice = form.supports[feature];
    supports[feature] = choice === "force on" ? "true" : choice === "force off" ? "false" : "auto";
  }
  const context = typedInt(form.context.buffer);
  const maxOutput = typedInt(form.maxOutput.buffer);
  return {
    ...(context === undefined ? {} : { context }),
    ...(maxOutput === undefined ? {} : { maxOutput }),
    supports,
    // The note travels verbatim (T11-08); an emptied field is "no note", which is `nextOverride`'s own rule.
    notes: form.notes.buffer,
  };
}

/** Which typed fields hold something that is not a number, named for the refusal line. */
export function unparsableFields(form: ModelEditForm): readonly string[] {
  const bad: string[] = [];
  for (const [label, buffer] of [
    ["context", form.context.buffer],
    ["max output", form.maxOutput.buffer],
  ] as const) {
    if (buffer.trim().length > 0 && typedInt(buffer) === undefined) bad.push(label);
  }
  return bad;
}

/** T11-06's count: how many fields of the record a reset removes — supports flags, limits and the note counted as what
 *  they are, because "2 overrides will be lost" is a claim about the record, not about the label list. */
export function overrideFieldCount(view: ModelView): number {
  const record = view.override;
  if (record === undefined) return 0;
  return (
    Object.keys(record.supports ?? {}).length +
    (record.limits?.contextWindow === undefined ? 0 : 1) +
    (record.limits?.maxOutputTokens === undefined ? 0 : 1) +
    (record.notes === undefined ? 0 : 1)
  );
}

/** T11-06's one line: the count first, then the two ways out. */
export function resetNoticeLine(count: number): string {
  return `${count} override${count === 1 ? "" : "s"} will be lost — r again resets, Esc keeps`;
}
