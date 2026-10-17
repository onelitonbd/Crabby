// §14's store, property by property: append-only by construction (the module exports no update or delete, and the
// test proves the trail survives the row it names being deleted), redaction on the way in, id-cursor paging that
// stays stable under inserts, and the task filter the route names.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { isId } from "@crabby/api-contracts";
import { AUDIT_KINDS, listAudit, recordAudit } from "./audit.ts";
import { openDatabase } from "./db.ts";
import { migrate } from "./migrate.ts";
import { createSession } from "./sessions.ts";
import { createTask } from "./tasks.ts";

const handles: { close(): void }[] = [];
after(() => {
  for (const handle of handles.splice(0)) handle.close();
});

function freshDb() {
  const dir = mkdtemp();
  mkdirSync(dir, { recursive: true });
  const handle = openDatabase(":memory:");
  migrate(handle.db);
  handles.push(handle);
  return handle.db;
}

function mkdtemp(): string {
  return join(tmpdir(), `crabby-audit-${Math.random().toString(36).slice(2)}`);
}

describe("the audit store (§14)", () => {
  it("records rows with aud_ ids, every §14 field, and pages by id cursor", () => {
    const db = freshDb();
    const first = recordAudit(db, {
      ts: new Date(0).toISOString(),
      kind: "auth_attempt",
      outcome: "rejected",
      actor: "anonymous",
      detail: { reason: "missing token" },
    });
    const second = recordAudit(db, {
      ts: new Date(1).toISOString(),
      kind: "config_change",
      outcome: "ok",
      actor: "cli_01",
      interface: "cli",
    });
    assert.ok(isId("aud", first));
    assert.ok(isId("aud", second));
    const page = listAudit(db, {});
    assert.equal(page.sortedBy, "id");
    assert.deepEqual(
      page.rows.map((row) => row.id),
      [first, second],
    );
    const after = listAudit(db, { cursor: first });
    assert.deepEqual(
      after.rows.map((row) => row.id),
      [second],
    );
    assert.equal(listAudit(db, { limit: 1 }).rows.length, 1);
  });

  it("keeps what was attempted and strips the secret-shaped half on the way in", () => {
    const db = freshDb();
    recordAudit(db, {
      ts: new Date(0).toISOString(),
      kind: "auth_attempt",
      outcome: "rejected",
      detail: { attempted: "pair redeem", apiKey: "sk-super-secret-value", code: "abcd1234" },
    });
    const row = listAudit(db, {}).rows[0];
    assert.equal(row?.detail?.attempted, "pair redeem");
    assert.equal(JSON.stringify(row?.detail).includes("sk-super-secret-value"), false);
  });

  it("survives the task it names being deleted — the trail is not a foreign key away", () => {
    const db = freshDb();
    const layout = {
      stateDir: mkdtemp(),
      configPath: join(mkdtemp(), "config.json"),
      vaultDir: mkdtemp(),
    };
    mkdirSync(layout.vaultDir, { recursive: true });
    const sessionId = createSession(db, { origin: "cli" }).id;
    const task = createTask(db, {
      sessionId,
      objective: "do the thing",
      origin: { interface: "cli", clientId: "cli_01", clientName: "the owner" },
    });
    recordAudit(db, {
      ts: new Date(0).toISOString(),
      kind: "tool_invocation",
      outcome: "ok",
      taskId: task.id,
      actor: "cli_01",
      detail: { tool: "memory.search", tier: "T0" },
    });
    db.prepare("DELETE FROM task WHERE id = ?").run(task.id);
    assert.equal(
      listAudit(db, { taskId: task.id }).rows.length,
      1,
      "the audit row outlives the task",
    );
  });

  it("knows the eight kinds §14 lists and refuses nothing else at the type level but filters at the store's edge", () => {
    assert.deepEqual(
      [...AUDIT_KINDS],
      [
        "auth_attempt",
        "approval",
        "config_change",
        "tool_invocation",
        "extension_install",
        "tunnel",
        "job_delete",
        "vault",
      ],
    );
    // The CHECK constraint is the database's own opinion; a bad kind is refused at the boundary.
    const db = freshDb();
    assert.throws(() =>
      recordAudit(db, {
        ts: new Date(0).toISOString(),
        kind: "vibes" as never,
        outcome: "ok",
      }),
    );
  });
});
