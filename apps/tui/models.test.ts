// The models pane, asserted against `docs/review/TUI.md` region T11's rows — T11-01's list line and detail line,
// T11-02's reported-vs-effective matrix with the `*` suffix the 8-color tier needs ("never color alone"), T11-05's
// forced-on notice, T11-07's probe gap and T11-09's gate line. The composition under it is the CLI's own
// (`parseDescriptor` / `parseOverride` / `applyOverride`), so these tests are also the claim that the pane and
// `crabby model list` cannot disagree.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  capabilityMatrix,
  choiceOf,
  costClass,
  cycleChoice,
  forcedOnLines,
  formAnswers,
  formLines,
  modelLines,
  modelsPane,
  modelViewsFrom,
  openModelForm,
  overrideFieldCount,
  probeGapLine,
  resetNoticeLine,
  t3GateLine,
  typedInt,
  unparsableFields,
} from "./models.ts";
import type { ModelView } from "./models.ts";
import type { PaneContext } from "./panes.ts";

const descriptor = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  contextWindow: 8192,
  maxOutputTokens: 2048,
  supports: {
    streaming: true,
    toolCalling: true,
    parallelToolCalls: false,
    systemRole: true,
    structuredOutput: false,
    imageInput: false,
    audioInput: false,
    reasoning: false,
    promptCaching: false,
    jsonSchemaValidation: false,
  },
  cancellation: "best-effort",
  rateLimits: null,
  cost: "local",
  batching: null,
  ...over,
});

/** One model in, one view out — asserted, so the tests below never lean on `!`. */
function one(providers: Record<string, Record<string, unknown>>): ModelView {
  const view = modelViewsFrom(providers)[0];
  assert.ok(view !== undefined, "one model in, one view out");
  return view;
}

const context = (over: Partial<PaneContext> = {}): PaneContext =>
  ({
    client: {},
    pane: "models",
    rows: 24,
    columns: 40,
    color: "none",
    offline: false,
    ...over,
  }) as PaneContext;

describe("T11-01 — the model list: provider/model and context, the rest on the detail line", () => {
  it("puts `provider/model` and the context on one line and the output cap and cost class below", () => {
    const view = one({ mock: { models: { tiny: descriptor() } } });
    const lines = modelLines(view, false, 40);
    assert.equal(lines[0], "  mock/tiny · 8192 ctx");
    assert.ok((lines[1] as string).includes("out 2048"));
    assert.ok((lines[1] as string).includes("local"));
  });

  it("reports a descriptor that does not parse as disabled with its reason (§3.2), never as a row of numbers", () => {
    const view = one({ mock: { models: { broken: { contextWindow: -1 } } } });
    const lines = modelLines(view, false, 40);
    // Word wrap can split a phrase across drawn lines, so the check reads the words rather than the rows.
    const words = lines.join(" ").replace(/\s+/g, " ");
    assert.ok(words.includes("does not parse"));
    assert.ok(words.includes("disabled, §3.2"));
  });
});

describe("T11-02 — the capability matrix: reported beside effective, `*` on the cell an override moved", () => {
  it("shows both columns and marks the moved cell with a star (never color alone)", () => {
    const view = one({
      mock: {
        models: { tiny: descriptor() },
        overrides: {
          tiny: {
            source: "manual",
            supports: { toolCalling: false, streaming: "auto" },
            limits: { contextWindow: 16384 },
          },
        },
      },
    });
    const text = capabilityMatrix(view, 40).join("\n");
    // The effective column reports the composed truth; the moved cell carries the star.
    assert.ok(/toolCalling\s+on\s+off\*/.test(text), text);
    // `auto` clears the flag — the effective value falls back to the reported one, and nothing moved.
    assert.ok(/streaming\s+on\s+on\s*$/m.test(text), text);
    // The limit override rides in the view's labels and the list line's context number.
    assert.ok(view.overridden.includes("contextWindow"));
    assert.ok((modelLines(view, false, 40)[0] as string).includes("16384 ctx"));
  });
});

describe("T11-05 — the forced-on notice, in W10-05's own words", () => {
  it("names the unverified claim and the failure it can produce, and stays away when nothing is forced", () => {
    const forced = one({
      mock: {
        models: { tiny: descriptor() },
        overrides: { tiny: { source: "manual", supports: { imageInput: true } } },
      },
    });
    const lines = forcedOnLines(forced);
    assert.equal(lines.length, 2);
    assert.ok((lines[0] as string).includes("forced on, unverified"));
    assert.ok((lines[1] as string).includes("unsupported-capability"));
    const plain = one({ mock: { models: { tiny: descriptor() } } });
    assert.deepEqual(forcedOnLines(plain), []);
  });
});

describe("T11-07 and T11-09 — the gaps named, not hidden", () => {
  it("says the probe has no route rather than implying a table exists (C7-09 is M4's)", () => {
    const view = one({ mock: { models: { tiny: descriptor() } } });
    const line = probeGapLine(view);
    assert.ok(line.includes("POST /models/mock/tiny/probe"));
    assert.ok(line.includes("C7-09"));
  });

  it("keeps T3's gate line in this pane too, or the TUI becomes the escape hatch", () => {
    assert.ok(t3GateLine().includes("agent cannot widen its own model"));
  });
});

describe("the pane body — a blank pane is a defect", () => {
  it("teaches the verb that adds a model instead of drawing an empty box", () => {
    const lines = modelsPane(context(), []);
    assert.ok(lines.join("\n").includes("no models configured"));
    assert.ok(lines.join("\n").includes("crabby provider add"));
  });

  it("carries the matrix and the notices under the selected model", () => {
    const views = modelViewsFrom({
      mock: { models: { a: descriptor(), b: descriptor({ cost: null }) } },
    });
    const text = modelsPane(context(), views, 1).join("\n");
    assert.ok(text.includes("mock/a"));
    assert.ok(text.includes("mock/b"));
    assert.ok(text.includes("reported → effective"));
    // The gate notice wraps whole rather than clipping to `…cannot widen its` at 40 columns; the clause a phone must
    // see survives the design case (wrapping splits it across drawn lines, so the check reads the words, not the rows).
    assert.ok(text.replace(/\s+/g, " ").includes("cannot widen its own model"));
  });

  it("answers a dead Gateway with the restart command (T1-10)", () => {
    const lines = modelsPane(context({ offline: true }), []);
    assert.ok(lines.join("\n").includes("crabby gateway start"));
  });
});

describe("cost classes — `null` is unmeasured, never free", () => {
  it("keeps D-064's distinction visible", () => {
    assert.ok(costClass(null).includes("unmeasured"));
    assert.equal(costClass("free-tier"), "free-tier");
    assert.equal(costClass("local"), "local");
    assert.ok(costClass({ promptPerMTok: 1, completionPerMTok: 2 }).includes("1 in / 2 out"));
  });
});

describe("T11-03/04/06/08 — the editor: three-position controls, typed limits, notes, and the reset count", () => {
  it("cycles auto → force on → force off, in the row's own words (T11-03)", () => {
    assert.equal(cycleChoice("auto"), "force on");
    assert.equal(cycleChoice("force on"), "force off");
    assert.equal(cycleChoice("force off"), "auto");
    assert.equal(choiceOf(true), "force on");
    assert.equal(choiceOf(false), "force off");
    assert.equal(choiceOf(undefined), "auto");
  });

  it("draws one line per capability and the three typed limit inputs T11-04 names, reserve included (T11-08's note too)", () => {
    const view = one({ mock: { models: { tiny: descriptor() } } });
    const text = formLines(openModelForm(view), 40).join("\n");
    assert.ok(text.includes("context:"));
    assert.ok(text.includes("max output:"));
    assert.ok(text.includes("reserve:"));
    assert.ok(text.includes("notes:"));
    assert.ok(text.includes("[auto]"));
    // One line per capability, in the row's own words.
    for (const feature of ["streaming", "toolCalling", "jsonSchemaValidation"]) {
      assert.ok(text.includes(feature), feature);
    }
  });

  it("seeds the form from the record and hands `nextOverride`'s own answer shape back (D-064's boundary)", () => {
    const view = one({
      mock: {
        models: { tiny: descriptor() },
        overrides: {
          tiny: {
            source: "manual",
            supports: { toolCalling: false },
            limits: { contextWindow: 16384 },
            notes: "why it is like this",
          },
        },
      },
    });
    const form = openModelForm(view);
    assert.equal(form.context.buffer, "16384");
    assert.equal(form.notes.buffer, "why it is like this");
    assert.equal(form.supports.toolCalling, "force off");
    const answers = formAnswers(form);
    assert.equal(answers.context, 16384);
    assert.equal(answers.notes, "why it is like this");
    assert.equal(answers.supports?.toolCalling, "false");
    // `auto` travels as `auto`, which `nextOverride` stores as "no opinion" (the key is removed, never the string).
    assert.equal(answers.supports?.streaming, "auto");
  });

  it("refuses to answer for a typed field that is not a number rather than silently ignoring it", () => {
    const view = one({ mock: { models: { tiny: descriptor() } } });
    const form = { ...openModelForm(view), context: { buffer: "12x", cursor: 2, history: [] } };
    assert.deepEqual(unparsableFields(form), ["context"]);
    assert.equal(typedInt("  8192 "), 8192);
    assert.equal(
      typedInt("0"),
      undefined,
      "a limit is a positive integer (§3.2's parser's own rule)",
    );
    assert.equal(typedInt(""), undefined);
  });

  it("counts the record's fields for T11-06's reset line and says how many will be lost", () => {
    const view = one({
      mock: {
        models: { tiny: descriptor() },
        overrides: {
          tiny: {
            source: "manual",
            supports: { toolCalling: false, streaming: true },
            limits: { contextWindow: 16384 },
            notes: "x",
          },
        },
      },
    });
    assert.equal(overrideFieldCount(view), 4);
    assert.equal(resetNoticeLine(4), "4 overrides will be lost — r again resets, Esc keeps");
    assert.equal(resetNoticeLine(1), "1 override will be lost — r again resets, Esc keeps");
    const plain = one({ mock: { models: { tiny: descriptor() } } });
    assert.equal(overrideFieldCount(plain), 0);
  });
});
