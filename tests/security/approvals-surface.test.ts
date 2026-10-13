// `SECURITY.md` §17's approval bullets, asserted on the surface rather than in the arbiter. The rules themselves live in
// `packages/agent-runtime/approvals.ts` and are unit-tested there; what this file proves is that the *route* cannot be
// walked around them, because a rule a route can bypass is a rule that only the honest obey.
//
// Where each of §17's five approval sentences is proved, so the next reader does not have to find them one at a time:
//   - bound to the exact action → `packages/agent-runtime/approvals.test.ts` (the binding is re-compared at consume)
//   - material change re-prompts → the same file, `materially-changed`
//   - no remembered-approval path, and a request for one refused (D-052) → here over HTTP, and in the unit file
//   - a restart does not silently satisfy a pending approval → `packages/storage/approvals.test.ts`
//   - no T3 answerable from a chat surface → here, since §6.2 is a statement about surfaces
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createApprovals } from "@crabby/agent-runtime";
import { newId } from "@crabby/api-contracts";
import { createLogger } from "@crabby/core";
import { buildApp } from "@crabby/gateway";
import { dataLayout } from "@crabby/platform";
import type { ApprovalRequest } from "@crabby/policy";
import {
  createSqliteApprovalStore,
  createTask,
  migrate,
  mintPairingCode,
  openDatabase,
  redeemPairingCode,
} from "@crabby/storage";

const T3_TTL = 5 * 60_000;

describe("the approval surface cannot be walked around §6.2", () => {
  let dir: string;
  let close: () => Promise<void>;
  let app: Awaited<ReturnType<typeof buildApp>>["app"];
  let tokens: Record<"tui" | "telegram" | "cli", string>;
  let approvals: ReturnType<typeof createApprovals>;
  let taskId: string;

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "crabby-approval-surface-"));
    const handle = openDatabase(path.join(dir, "crabby.db"));
    migrate(handle.db);
    const built = await buildApp({
      db: handle.db,
      layout: dataLayout(dir),
      log: createLogger({ level: "error", write: () => {} }, "approval-surface"),
      version: "test",
      startedAt: new Date(),
      listenerMode: "local",
    });
    approvals = createApprovals({
      store: createSqliteApprovalStore(handle.db),
      newId: () => newId("apr"),
    });
    taskId = createTask(handle.db, { objective: "rotate the signing key" }).id;
    tokens = {
      tui: token(handle.db, "tui"),
      telegram: token(handle.db, "telegram"),
      cli: token(handle.db, "cli"),
    };
    close = async () => {
      await built.app.close();
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    };
    app = built.app;
  });
  after(async () => {
    await close();
  });

  function open(overrides: Partial<ApprovalRequest> = {}): string {
    const at = Date.now();
    const request: ApprovalRequest = {
      taskId,
      tool: "shell.privileged",
      tier: "T3",
      summary: "rotate the signing key",
      exact: "ssh-keygen -R host && ssh-keygen -t ed25519",
      effects: "invalidates the old key on every client that pinned it",
      reversibility: "irreversible",
      whatCouldGoWrong: "clients cannot verify the host until they re-pin",
      scope: "once",
      ttlMs: T3_TTL,
      expiresAt: at + T3_TTL,
      binding: "sha256:t3key",
      ...overrides,
    };
    const opened = approvals.open(request, at);
    assert.ok(opened.ok, JSON.stringify(opened));
    return opened.ok ? opened.record.id : "";
  }

  it("refuses both approval routes without a token, describing nothing while doing it", async () => {
    // `printRoutes()` compresses shared prefixes into a tree — `\/api\/v1\/approvals` never appears as a substring —
    // so the *answer* is what proves a route is registered, and `tests/security/policy-surface.test.ts` walks that
    // tree to assert the token requirement over every route in it. These two assertions are the feature-named half:
    // the queue and the decision each refuse a caller with no credential, and say nothing about what they are
    // refusing to see (§3.1).
    for (const [method, url] of [
      ["GET", "/api/v1/approvals"],
      ["POST", "/api/v1/approvals/apr_nope/decision"],
    ] as const) {
      const refused = await app.inject({ method, url });
      assert.equal(refused.statusCode, 401, `${method} ${url} answered without a token`);
      const error = refused.json().error as { class: string; message: string };
      assert.equal(error.class, "auth");
      assert.doesNotMatch(
        error.message,
        /approval|queue|pending/,
        `§3.1: an unauthenticated refusal must not describe what it refused (${error.message})`,
      );
    }
    const withToken = await app.inject({
      method: "GET",
      url: "/api/v1/approvals",
      headers: { authorization: `Bearer ${tokens.tui}` },
    });
    assert.equal(withToken.statusCode, 200);
    assert.equal(
      (withToken.json() as { state: string }).state,
      "pending",
      "§4.3's default is the actionable state",
    );
  });

  it("refuses a T3 answer from Telegram and from the CLI, and leaves the row pending for the TUI", async () => {
    const id = open();
    for (const surface of ["telegram", "cli"] as const) {
      const refused = await app.inject({
        method: "POST",
        url: `/api/v1/approvals/${id}/decision`,
        headers: { authorization: `Bearer ${tokens[surface]}` },
        payload: { decision: "approve" },
      });
      assert.equal(
        refused.statusCode,
        403,
        `${surface} may display a T3 and relay an answer; it may not sign one`,
      );
      const error = refused.json().error as { code: string; message: string };
      assert.equal(error.code, "approval_surface-not-allowed");
      assert.match(error.message, /SECURITY\.md §6\.2/);
    }
    assert.equal(
      approvals.list().find((row) => row.id === id)?.state,
      "pending",
      "the row a chat surface could not sign is still signable by the surface that can",
    );

    const answered = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${id}/decision`,
      headers: { authorization: `Bearer ${tokens.tui}` },
      payload: { decision: "approve", scope: "once" },
    });
    assert.equal(answered.statusCode, 200);
    assert.equal((answered.json() as { record: { state: string } }).record.state, "approved");
  });

  it("refuses a T3 shell.run answer from Telegram and from the CLI, and leaves the row pending for the TUI", async () => {
    // Same rule as the privileged row above, proved on the tool whose tier is argument-dependent: a destructive
    // command opens a T3 prompt, and no chat surface may sign it (D-085). The row naming `shell.privileged` above
    // proves the registry row; this one proves the executor's row reaches the same arbiter.
    const id = open({
      tool: "shell.run",
      tier: "T3",
      summary: "run rm -rf /tmp/x",
      exact: "command: rm -rf /tmp/x",
      effects: "deletes /tmp/x",
      reversibility: "irreversible",
      whatCouldGoWrong: "the path may not contain what the model thinks it does",
      binding: "sha256:shellt3",
    });
    for (const surface of ["telegram", "cli"] as const) {
      const refused = await app.inject({
        method: "POST",
        url: `/api/v1/approvals/${id}/decision`,
        headers: { authorization: `Bearer ${tokens[surface]}` },
        payload: { decision: "approve" },
      });
      assert.equal(refused.statusCode, 403, `${surface} may not sign a T3 shell.run`);
      const error = refused.json().error as { code: string; message: string };
      assert.equal(error.code, "approval_surface-not-allowed");
      assert.match(error.message, /SECURITY\.md §6\.2/);
    }
    assert.equal(
      approvals.list().find((row) => row.id === id)?.state,
      "pending",
      "the row a chat surface could not sign is still signable by the surface that can",
    );
    const answered = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${id}/decision`,
      headers: { authorization: `Bearer ${tokens.tui}` },
      payload: { decision: "approve", scope: "once" },
    });
    assert.equal(answered.statusCode, 200);
    assert.equal((answered.json() as { record: { state: string } }).record.state, "approved");
  });

  it("refuses a remembered approval over HTTP with the sentence that cites D-052", async () => {
    const id = open({ binding: "sha256:t3scope", tool: "fs.write", tier: "T2", ttlMs: undefined });
    const widened = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${id}/decision`,
      headers: { authorization: `Bearer ${tokens.tui}` },
      payload: { decision: "approve", scope: "always" },
    });
    assert.equal(widened.statusCode, 403);
    const error = widened.json().error as { code: string; message: string };
    assert.equal(error.code, "approval_scope-unsupported");
    assert.match(error.message, /D-052/);
    assert.equal(approvals.list().find((row) => row.id === id)?.state, "pending");
  });
});

function token(db: import("@crabby/storage").SqliteDb, iface: "tui" | "telegram" | "cli"): string {
  const minted = mintPairingCode(db, { name: iface, interface: iface });
  const redeemed = redeemPairingCode(db, minted.code);
  assert.ok(redeemed.ok && redeemed.token, `the ${iface} identity has to be paired`);
  return redeemed.token as string;
}
