// §4.3 / D-071, as refusals and records: the folder/name hard error, the honored fields, "ignored loudly" with the key
// named, allowed-tools recorded never granted, the 500-line warning, and the 32 KiB activation refusal that stays
// separable from validation.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSkill } from "./skill.ts";

function skill(body: string): string {
  return `${body}\n\n# Steps\n\n1. Read the numbers.\n`;
}

describe("SKILL.md frontmatter (D-071)", () => {
  it("honors name, description, license and metadata keys, and reports the body", () => {
    const text = skill(
      [
        "---",
        "name: weekly-report",
        "description: Summarises the week's numbers into one page.",
        'license: "MIT"',
        "metadata:",
        "  version: 2.0.1",
        "  author: Priya",
        "  tags: [reports, weekly]",
        "  crabby.tier: suggest",
        "---",
      ].join("\n"),
    );
    const result = parseSkill(text, "weekly-report");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.frontmatter.name, "weekly-report");
    assert.equal(result.frontmatter.license, "MIT");
    assert.equal(result.frontmatter.metadata.version, "2.0.1");
    assert.equal(result.frontmatter.metadata.author, "Priya");
    assert.deepEqual(result.frontmatter.metadata.tags, ["reports", "weekly"]);
    assert.deepEqual(Object.keys(result.frontmatter.metadata.crabby ?? {}), ["crabby.tier"]);
  });

  it("makes a folder/name mismatch a hard error — the name is the install key", () => {
    const text = skill("---\nname: weekly-report\ndescription: d\n---");
    const result = parseSkill(text, "different-folder");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0]?.message ?? "", /hard error/);
    assert.match(result.errors[0]?.message ?? "", /weekly-report/);
    assert.match(result.errors[0]?.message ?? "", /different-folder/);
  });

  it("rejects names outside the lowercase/digits/single-hyphen shape and over 64 chars", () => {
    const bad = parseSkill("---\nname: Weekly Report\ndescription: d\n---", "Weekly Report");
    assert.equal(bad.ok, false);
    const long = parseSkill(`---\nname: ${"a".repeat(65)}\ndescription: d\n---`, "x");
    assert.equal(long.ok, false);
  });

  it("records unknown frontmatter keys verbatim and names them — ignored loudly, not silently", () => {
    const text = skill(
      [
        "---",
        "name: weekly-report",
        "description: d",
        "permissions: [fs.write]",
        "source: https://example.com",
        "---",
      ].join("\n"),
    );
    const result = parseSkill(text, "weekly-report");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual([...result.report.unknownFields].sort(), ["permissions", "source"]);
    assert.deepEqual(result.report.preserved.permissions, ["fs.write"]);
    assert.equal(result.report.preserved.source, "https://example.com");
  });

  it("records allowed-tools and never grants them; unknown metadata keys are preserved too", () => {
    const text = skill(
      [
        "---",
        "name: weekly-report",
        "description: d",
        "allowed-tools: [Bash, Read, Write]",
        "metadata:",
        "  version: 1.0.0",
        "  model_preference: sonnet",
        "---",
      ].join("\n"),
    );
    const result = parseSkill(text, "weekly-report");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.frontmatter.allowedTools, ["Bash", "Read", "Write"]);
    assert.equal(result.frontmatter.metadata.unknown.model_preference, "sonnet");
    assert.ok(result.report.unknownFields.includes("metadata.model_preference"));
  });

  it("warns past 500 body lines and blocks activation past 32 KiB without failing validation", () => {
    const wide = skill(
      `---\nname: weekly-report\ndescription: d\n---\n${Array.from({ length: 520 }, (_, index) => `line ${index}`).join("\n")}`,
    );
    const wideResult = parseSkill(wide, "weekly-report");
    assert.equal(wideResult.ok, true);
    if (wideResult.ok) {
      assert.equal(wideResult.report.bodyLines > 500, true);
      assert.equal(wideResult.report.activationBlocked, false);
      assert.ok(wideResult.report.warnings.some((warning) => /500/.test(warning.message)));
    }
    const huge = skill(
      `---\nname: weekly-report\ndescription: d\n---\n${"# nine bytes\n".repeat(4000)}`,
    );
    const hugeResult = parseSkill(huge, "weekly-report");
    assert.equal(
      hugeResult.ok,
      true,
      "over 32 KiB validates — activation refuses, truncation never happens",
    );
    if (hugeResult.ok) {
      assert.equal(hugeResult.report.activationBlocked, true);
      assert.ok(
        hugeResult.report.warnings.some((warning) => /activation refuses/.test(warning.message)),
      );
    }
  });

  it("refuses a file without fenced frontmatter, naming the contract", () => {
    const result = parseSkill("# just prose\n", "weekly-report");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.errors[0]?.message ?? "", /frontmatter/);
  });

  it("enforces the 1–1024 description bound and warns when license is absent", () => {
    const missing = parseSkill("---\nname: weekly-report\ndescription: d\n---", "weekly-report");
    if (!missing.ok) throw new Error("absent license is a warning, not an error");
    assert.ok(missing.report.warnings.some((warning) => warning.path === "license"));
    const long = parseSkill(
      `---\nname: weekly-report\ndescription: ${"d".repeat(1025)}\n---`,
      "weekly-report",
    );
    assert.equal(long.ok, false);
  });
});
