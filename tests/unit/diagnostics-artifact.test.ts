// CLI-C12-08 (`crabby diagnostics`): the artifact is a 0600 file in the OS temp directory whose path is printed, and a
// report carrying a secret is refused instead of redacted. These are the two promises the command makes, and both now
// live in exported functions (`findUnsafeShapes`, `writeDiagnosticsArtifact`) rather than inside the command body, so
// they can be checked without a Gateway — the discovery half of `runDiagnostics` is `apps/cli/connect.ts`, which every
// command shares and `tests/integration/gateway.test.ts` drives over real HTTP.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { findUnsafeShapes, writeDiagnosticsArtifact } from "../../apps/cli/commands/diagnostics.ts";

test("a clean report is written into the temp directory as a 0600 file, and the name says when it was made", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "crabby-diagnostics-test-"));
  const text = `${JSON.stringify({ generatedAt: "2026-10-10T00:00:00.000Z", sanitized: true, events: [] }, null, 2)}\n`;
  try {
    const { file, bytes } = writeDiagnosticsArtifact(text, dir);
    assert.equal(
      path.dirname(file),
      dir,
      "the caller's directory is honored, so nothing is written where it cannot be removed",
    );
    assert.match(
      path.basename(file),
      /^crabby-diagnostics-\d{4}-\d{2}-\d{2}T[\d-]+Z-[0-9a-f]{6}\.json$/,
      "the name carries a timestamp and a suffix, because a bug report quotes a file path and two runs must not collide",
    );
    assert.equal(bytes, text.length);
    assert.equal(readFileSync(file, "utf8"), text);
    // D-078's retention table is what the data directory owns; this file deliberately lives outside it, which is only
    // safe because of the mode — a world-readable paste-able report on a shared Termux device is a leak.
    assert.equal(
      statSync(file).mode & 0o777,
      0o600,
      "a diagnostics artifact is readable by its owner only",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the refusal is a scan of the serialized text, so it does not depend on a field name", () => {
  assert.deepEqual(
    findUnsafeShapes(JSON.stringify({ generatedAt: "x", status: { uptime: 1 } })),
    [],
  );

  const cases: readonly { readonly report: unknown; readonly shape: string }[] = [
    { report: { env: { TELEGRAM_BOT_TOKEN: "123:abc" } }, shape: "an environment snapshot" },
    { report: { note: "the token is in process.env" }, shape: "an environment snapshot" },
    { report: { token: "crabby_live_abcdef123456" }, shape: "a bearer token or pairing code" },
    { report: { headers: { authorization: "Bearer x" } }, shape: "a bearer token or pairing code" },
    { report: { key: "-----BEGIN OPENSSH PRIVATE KEY-----" }, shape: "a private key" },
  ];
  for (const { report, shape } of cases) {
    const found = findUnsafeShapes(JSON.stringify(report));
    assert.ok(
      found.includes(shape),
      `${JSON.stringify(report)} must be refused for ${shape}; found ${JSON.stringify(found)}`,
    );
  }
});

test("a refused report names every shape found, because 'something is wrong' is not actionable", () => {
  const found = findUnsafeShapes(
    JSON.stringify({ env: {}, token: "crabby_live_abcdef123456", key: "BEGIN RSA PRIVATE KEY" }),
  );
  assert.equal(found.length, 3, found.join(", "));
});
