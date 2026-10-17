// §4.2, as refusals: an unknown field is rejected with its name (a typo'd capability would otherwise disable a
// permission silently), a missing field names itself, the id keeps §4.2's reverse-DNS shape, and the parser's own
// hygiene (size, depth, JSON) refuses pathological input before it becomes a memory question.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseManifest } from "./manifest.ts";

const VALID = {
  manifestVersion: 1,
  id: "dev.crabby.skill.report-writing",
  name: "Report writing",
  description: "Turns weekly numbers into a one-page report.",
  version: "1.2.0",
  kind: "skill",
  hostApi: { min: "1.0", max: "1.0" },
  license: "MIT",
};

describe("native manifest parsing", () => {
  it("accepts a valid manifest and keeps the declared fields", () => {
    const result = parseManifest(JSON.stringify(VALID));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.manifest.id, "dev.crabby.skill.report-writing");
    assert.equal(result.manifest.kind, "skill");
    assert.deepEqual(result.manifest.hostApi, { min: "1.0", max: "1.0" });
  });

  it("rejects an unknown field and names it", () => {
    const result = parseManifest(JSON.stringify({ ...VALID, permissionz: ["fs.read"] }));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0]?.path ?? "", /permissionz/);
    assert.match(result.problems[0]?.message ?? "", /reject unknown fields/);
  });

  it("rejects a manifest with typos silently dropped — the refusal is the review", () => {
    const { ...missing } = VALID;
    delete (missing as Record<string, unknown>).license;
    const result = parseManifest(JSON.stringify(missing));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.problems.some((problem) => problem.path === "license"));
  });

  it("rejects an id without a reverse-DNS dot", () => {
    const result = parseManifest(JSON.stringify({ ...VALID, id: "report-writing" }));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.problems[0]?.message ?? "", /reverse-DNS/);
  });

  it("rejects a manifest over the size cap before parsing it", () => {
    const result = parseManifest(JSON.stringify({ ...VALID, description: "x".repeat(70 * 1024) }));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.problems[0]?.message ?? "", /caps it at/);
  });

  it("rejects non-JSON and non-object manifests with the problem named", () => {
    assert.equal(parseManifest("{not json").ok, false);
    const array = parseManifest("[]");
    assert.equal(array.ok, false);
    if (!array.ok) assert.match(array.problems[0]?.message ?? "", /JSON object/);
  });

  it("rejects a deep nest at the depth limit", () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let index = 0; index < 10; index += 1) deep = { nested: deep };
    const result = parseManifest(JSON.stringify({ ...VALID, resources: deep }));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.problems.some((problem) => /depth/.test(problem.message)));
  });

  it("rejects an inverted hostApi range and a non-semver version", () => {
    const inverted = parseManifest(
      JSON.stringify({ ...VALID, hostApi: { min: "1.2", max: "1.0" } }),
    );
    if (inverted.ok) throw new Error("inverted range must not parse");
    assert.ok(inverted.problems.some((problem) => /inverted/.test(problem.message)));
    const version = parseManifest(JSON.stringify({ ...VALID, version: "one" }));
    if (version.ok) throw new Error("'one' must not parse as a version");
    assert.match(version.problems[0]?.message ?? "", /semver/);
  });

  it("names every kind outside §3's list", () => {
    const result = parseManifest(JSON.stringify({ ...VALID, kind: "sidecar" }));
    if (result.ok) throw new Error("'sidecar' must not parse as a kind");
    assert.match(result.problems[0]?.message ?? "", /sidecar/);
  });
});
