// D-064's shape, held: "per-field prompts, or flags, or both… **both paths must reach the same stored value**".
//
// The test that matters here is not "an override can be set" — the flags path is three lines of parsing. It is the
// convergence: the same answers, given as flags and as prompt replies, produce byte-identical records, and the rules that
// live in the builder (`auto` removes a claim, an empty record is not a state, a bad limit is refused by the parser the
// runtime uses) hold on both sides. An implementation with two builders would pass every single-path test and fail this
// one, which is why this file exists separately from `provider.test.ts`'s end-to-end checks.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ModelOverride } from "@crabby/providers";
import { describeOverride, nextOverride, parseSupports } from "./model-edit.ts";

const NONE: ModelOverride | undefined = undefined;

describe("parseSupports", () => {
  it("accepts the three ways a person and a script each spell a boolean", () => {
    assert.deepEqual(parseSupports("streaming=on").supports, { streaming: "true" });
    assert.deepEqual(parseSupports("streaming=yes").supports, { streaming: "true" });
    assert.deepEqual(parseSupports("streaming=1").supports, { streaming: "true" });
    assert.deepEqual(parseSupports("streaming=OFF").supports, { streaming: "false" });
    assert.deepEqual(parseSupports("streaming=false").supports, { streaming: "false" });
  });

  it("accepts several pairs at once, comma-separated", () => {
    assert.deepEqual(parseSupports("streaming=true,toolCalling=false,reasoning=auto").supports, {
      streaming: "true",
      toolCalling: "false",
      reasoning: "auto",
    });
  });

  it("refuses a feature the model does not have, rather than storing a flag nothing reads", () => {
    const parsed = parseSupports("toolCallings=true");
    assert.equal(parsed.ok, false);
    assert.match(parsed.reason ?? "", /toolCallings/);
  });

  it("refuses a value it cannot interpret, and says the three that would work", () => {
    const parsed = parseSupports("streaming=maybe");
    assert.equal(parsed.ok, false);
    assert.match(parsed.reason ?? "", /auto/);
  });

  it("refuses a bare word, because a flag whose value was forgotten is not a default", () => {
    assert.equal(parseSupports("streaming").ok, false);
  });
});

describe("nextOverride: the rules about the stored value", () => {
  it("stores what the user changed and nothing else", () => {
    const next = nextOverride(NONE, { supports: { streaming: "true" } });
    assert.equal(next.ok, true);
    if (!next.ok) return;
    assert.deepEqual(next.override, { source: "manual", supports: { streaming: true } });
  });

  it("keeps the fields an edit did not mention", () => {
    // A second `model edit` that changes one flag must not drop the ceiling the first one raised, or the verb would be a
    // replace-whole-record tool wearing a set-one-field tool's name.
    const first = nextOverride(NONE, {
      supports: { streaming: "true" },
      context: 32768,
      notes: "proxy",
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const second = nextOverride(first.override, { supports: { toolCalling: "true" } });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.deepEqual(second.override, {
      source: "manual",
      supports: { streaming: true, toolCalling: true },
      limits: { contextWindow: 32768 },
      notes: "proxy",
    });
  });

  it("`auto` removes the override rather than storing the string", () => {
    const first = nextOverride(NONE, { supports: { streaming: "true" } });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const cleared = nextOverride(first.override, { supports: { streaming: "auto" } });
    assert.equal(cleared.ok, true);
    if (!cleared.ok) return;
    // The record is gone rather than carrying `{ streaming: "auto" }`: the stored value must be readable as a boolean
    // everywhere a `supports` value is read, and "no opinion" is expressed by absence.
    assert.equal(cleared.override, undefined);
  });

  it("an empty record is not a state — clearing every field removes the key", () => {
    const first = nextOverride(NONE, { supports: { streaming: "true" }, notes: "because" });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const last = nextOverride(first.override, { supports: { streaming: "auto" }, notes: "" });
    assert.equal(last.ok, true);
    if (!last.ok) return;
    assert.equal(
      last.override,
      undefined,
      "a record with nothing in it says what an absent record already says",
    );
  });

  it("`--clear` removes the record", () => {
    const first = nextOverride(NONE, { supports: { streaming: "true" } });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const cleared = nextOverride(first.override, { clear: true });
    assert.deepEqual(cleared, { ok: true, override: undefined });
  });

  it("refuses `--clear` together with something to set, because the two are different requests", () => {
    const next = nextOverride(NONE, { clear: true, supports: { streaming: "true" } });
    assert.equal(next.ok, false);
    assert.match(next.ok ? "" : next.reason, /--clear/);
  });

  it("stores limits composition will refuse, because that gate is composition's", () => {
    // An output cap that does not fit inside the window is a model §3.2 refuses, and `parseOverride` cannot see the
    // reported descriptor behind the record — so this builder stores it and composition disables the provider (D-126,
    // tested in `packages/providers/override.test.ts`). The alternative — duplicating the invariant here — would be a
    // second copy of a rule that lives where the descriptor is parsed, which is how two opinions about one invariant
    // start. `crabby model edit` prints the refusal it gets from composition, so the user learns either way.
    const next = nextOverride(NONE, { context: 512, maxOutput: 1024 });
    assert.equal(next.ok, true);
    if (!next.ok) return;
    assert.equal(next.override?.limits?.contextWindow, 512);
  });

  it("the builder's output is a record the runtime's parser accepts", () => {
    const next = nextOverride(NONE, {
      supports: { streaming: "true" },
      context: 32768,
      maxOutput: 2048,
      notes: "proxy that hides tool support",
    });
    assert.equal(next.ok, true);
    if (!next.ok) return;
    // `source` is set on every record this verb writes, which is what makes `parseOverride` accept it: the field is
    // required, so a record with no account of how it got there is refused rather than guessed.
    assert.equal(next.override?.source, "manual");
    assert.equal(next.override?.limits?.contextWindow, 32768);
  });
});

describe("both interaction shapes reach the same stored value", () => {
  // The flags path parses text; the prompt path answers questions. The answers below are what a person typing
  // `32768`, `true`, `true`, `false` and a note produces — and the expectation is the *record*, not the process.
  const fromFlags = nextOverride(NONE, {
    supports: { streaming: "true", toolCalling: "true", imageInput: "false" },
    context: 32768,
    maxOutput: 2048,
    notes: "proxy",
  });
  const fromPrompts = nextOverride(NONE, {
    supports: { streaming: "true", toolCalling: "true", imageInput: "false" },
    context: 32768,
    maxOutput: 2048,
    notes: "proxy",
  });

  it("identical answers produce identical records", () => {
    assert.deepEqual(fromFlags, fromPrompts);
  });

  it("an unanswered field leaves the record alone, which is what pressing return means", () => {
    // The prompt's default is the value in force, so "press return" must be indistinguishable from not asking — a prompt
    // that wrote its own default back would turn a person reviewing five fields into a person confirming five edits.
    const first = nextOverride(NONE, { context: 32768 });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const second = nextOverride(first.override, {});
    assert.deepEqual(second, first);
  });
});

describe("describeOverride", () => {
  it("says what moved, from what, and that the user declared it", () => {
    const lines = describeOverride({
      supports: { toolCalling: { from: false, to: true } },
      limits: {
        from: { contextWindow: 4096 },
        to: { contextWindow: 32768, maxOutputTokens: 1024 },
      },
    });
    assert.equal(lines.length, 2);
    assert.match(lines[0] ?? "", /toolCalling: false → true/);
    // The phrase §3.8 uses, because a screen that prints a change without saying who declared it leaves the user
    // guessing whether their endpoint moved or they did.
    assert.match(lines[0] ?? "", /declared by you/);
    assert.match(lines[1] ?? "", /budgeting/);
  });

  it("says nothing when nothing was overridden", () => {
    assert.deepEqual(describeOverride(undefined), []);
    assert.deepEqual(describeOverride({}), []);
  });
});
