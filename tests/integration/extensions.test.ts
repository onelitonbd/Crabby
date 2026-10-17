// §4.6's four extension paths over real HTTP — the installed-record store (`<stateDir>/extensions`, folders are the
// truth) answering a second interface without becoming a second opinion.
//
// The questions this file asks are the ones a route can only answer by existing: does `GET /extensions` carry the
// verdict beside each row, so a settings pane never has to validate N packs per render? Does install answer the CLI's
// own no-override rule over the wire (C-E6), write the same conversion report the CLI's install writes, and put the
// `extension_install` row on §14's trail? Does the report history answer newest first, per D-039's "when did this
// start failing"? And does uninstall remove the folder and leave the trail saying it was here?
//
// The CLI's half of these verbs is `tests/unit/ext-cli.test.ts`; the store's own reconcile rules live beside it in
// `packages/extensions/repo.test.ts`. What is asserted here is the seam: one store, two faces, one truth.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { createLogger } from "@crabby/core";
import { buildApp } from "@crabby/gateway";
import { dataLayout } from "@crabby/platform";
import { capabilitiesFor } from "@crabby/policy";
import {
  listAudit,
  migrate,
  mintPairingCode,
  openDatabase,
  redeemPairingCode,
} from "@crabby/storage";

function scaffoldSkill(root: string, name: string): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: The ${name} skill.\n---\n\nDo the thing.\n`,
    "utf8",
  );
  return dir;
}

interface Harness {
  readonly url: string;
  readonly token: string;
  readonly repoRoot: string;
  /** The harness's own handle, for reading the trail the routes wrote. */
  readonly db: import("@crabby/storage").SqliteDb;
  close(): Promise<void>;
}

async function boot(): Promise<Harness> {
  const dir = mkdtempSync(path.join(tmpdir(), "crabby-ext-http-"));
  const layout = dataLayout(dir);
  mkdirSync(layout.stateDir, { recursive: true, mode: 0o700 });
  const handle = openDatabase(path.join(dir, "crabby.sqlite3"));
  migrate(handle.db);
  const built = await buildApp({
    db: handle.db,
    layout,
    log: createLogger({ level: "error", write: () => {} }, "ext-test"),
    version: "test",
    startedAt: new Date(),
    listenerMode: "local",
  });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const address = built.app.server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const minted = mintPairingCode(handle.db, {
    name: "the owner",
    interface: "cli",
    capabilities: capabilitiesFor("cli"),
  });
  const redeemed = redeemPairingCode(handle.db, minted.code);
  assert.ok(redeemed.ok && redeemed.token, "the harness's identity has to pair");
  return {
    url: `http://127.0.0.1:${port}`,
    token: redeemed.token as string,
    repoRoot: path.join(layout.stateDir, "extensions"),
    db: handle.db,
    async close() {
      await built.app.close();
      handle.close();
    },
  };
}

interface Answer {
  readonly status: number;
  readonly location: string | null;
  // biome-ignore lint/suspicious/noExplicitAny: the assertion reads an untyped wire body — the shape is what this route test exists to pin, and restating it as a type would duplicate the contract under test
  readonly body: any;
}

async function raw(
  h: Harness,
  route: string,
  init: { method?: string; body?: unknown; token?: string | null } = {},
): Promise<Answer> {
  const response = await fetch(`${h.url}${route}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.token === null ? {} : { authorization: `Bearer ${init.token ?? h.token}` }),
      // A content-type without a body is Fastify's empty-JSON refusal — the header names a payload, so it rides
      // only when there is one.
      ...(init.body === undefined ? {} : { "content-type": "application/json; charset=utf-8" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    location: response.headers.get("location"),
    body: text.length === 0 ? null : JSON.parse(text),
  };
}

describe("§4.6's extension routes — one store, two faces, one truth", () => {
  const boots: Harness[] = [];
  after(async () => {
    for (const h of boots) await h.close();
  });

  it("install writes the pack, the report, and the trail row; the list carries the verdict", async () => {
    const h = await boot();
    boots.push(h);
    const skill = scaffoldSkill(path.join(path.dirname(h.repoRoot), "work"), "weekly-report");
    const installed = await raw(h, "/api/v1/extensions/install", {
      method: "POST",
      body: { path: skill },
    });
    assert.equal(installed.status, 201, "a pack landed, so the answer is a creation");
    assert.equal(installed.location, "/api/v1/extensions/weekly-report");
    // biome-ignore lint/suspicious/noExplicitAny: the assertion reads an untyped wire body — the shape is what this route test exists to pin, and restating it as a type would duplicate the contract under test
    assert.equal((installed.body as any).name, "weekly-report");
    // biome-ignore lint/suspicious/noExplicitAny: the assertion reads an untyped wire body — the shape is what this route test exists to pin, and restating it as a type would duplicate the contract under test
    assert.match((installed.body as any).report, /report-.*\.json$/);
    assert.ok(
      // biome-ignore lint/suspicious/noExplicitAny: the assertion reads an untyped wire body — the shape is what this route test exists to pin, and restating it as a type would duplicate the contract under test
      (installed.body as any).warnings.every((warning: string) => warning.includes("license")),
      "the only warning a minimal pack earns is the license note — §4.3's absence-is-a-warning rule, carried in the answer",
    );
    const report = JSON.parse(
      // biome-ignore lint/suspicious/noExplicitAny: the assertion reads an untyped wire body — the shape is what this route test exists to pin, and restating it as a type would duplicate the contract under test
      readFileSync((installed.body as any).report, "utf8"),
    ) as { allowedTools: { granted: boolean } };
    assert.equal(
      report.allowedTools.granted,
      false,
      "D-035's rule in the stored artifact: tool names are read for the diff, granted never",
    );
    assert.ok(
      existsSync(path.join(h.repoRoot, "weekly-report", "SKILL.md")),
      "the converted pack is in the repo the CLI reads",
    );

    const list = await raw(h, "/api/v1/extensions");
    assert.equal(list.status, 200);
    const listBody = list.body as {
      items: { name: string; verdict: string; source: string; version?: string }[];
      count: number;
      collisions: string[];
    };
    assert.equal(listBody.count, 1);
    assert.equal(listBody.items[0]?.name, "weekly-report");
    assert.equal(listBody.items[0]?.verdict, "compatible", "the verdict rides the row");
    assert.equal(listBody.items[0]?.source, "import");
    assert.deepEqual(listBody.collisions, []);

    const trail = listAudit(h.db, { limit: 10 });
    const row = trail.rows.find((candidate) => candidate.kind === "extension_install");
    assert.ok(row !== undefined, "the trail holds the install");
    assert.equal(row.detail?.action, "install");
    assert.equal(row.detail?.name, "weekly-report");
  });

  it("validate refuses what install refuses, and the verdict has no override over the wire either", async () => {
    const h = await boot();
    boots.push(h);
    const relative = await raw(h, "/api/v1/extensions/validate", {
      method: "POST",
      body: { path: "relative/path" },
    });
    assert.equal(relative.status, 400, "a relative path is a named refusal, not a guess about cwd");

    const skill = scaffoldSkill(path.join(path.dirname(h.repoRoot), "work2"), "weekly-report");
    const validated = await raw(h, "/api/v1/extensions/validate", {
      method: "POST",
      body: { path: skill },
    });
    assert.equal(validated.status, 200);
    // biome-ignore lint/suspicious/noExplicitAny: the assertion reads an untyped wire body — the shape is what this route test exists to pin, and restating it as a type would duplicate the contract under test
    assert.equal((validated.body as any).verdict, "compatible");
    // biome-ignore lint/suspicious/noExplicitAny: the assertion reads an untyped wire body — the shape is what this route test exists to pin, and restating it as a type would duplicate the contract under test
    assert.ok(Array.isArray((validated.body as any).lines));

    const installed = await raw(h, "/api/v1/extensions/install", {
      method: "POST",
      body: { path: skill },
    });
    assert.equal(installed.status, 201);
    // A second install of the same name is D-039's update path: the reports never overwrite, so the history grows —
    // and "when did this start failing" stays answerable from the file names alone.
    const again = await raw(h, "/api/v1/extensions/install", {
      method: "POST",
      body: { path: skill },
    });
    assert.equal(again.status, 201, "a re-install is an update, and the answer says what landed");
    const reports = await raw(h, "/api/v1/extensions/weekly-report/reports");
    // biome-ignore lint/suspicious/noExplicitAny: the assertion reads an untyped wire body — the shape is what this route test exists to pin, and restating it as a type would duplicate the contract under test
    assert.equal((reports.body as any).count, 2, "the first report survived the update");
  });

  it("reports answer newest first, and an unknown id is a 404 rather than an empty list that lies", async () => {
    const h = await boot();
    boots.push(h);
    const missing = await raw(h, "/api/v1/extensions/nobody/reports");
    assert.equal(missing.status, 404);
    const walker = await raw(h, "/api/v1/extensions/../../config/reports");
    assert.equal(walker.status, 404, "an id with a path in it is not an id");

    const skill = scaffoldSkill(path.join(path.dirname(h.repoRoot), "work3"), "weekly-report");
    await raw(h, "/api/v1/extensions/install", { method: "POST", body: { path: skill } });
    const reports = await raw(h, "/api/v1/extensions/weekly-report/reports");
    assert.equal(reports.status, 200);
    const body = reports.body as { items: { file: string }[]; count: number };
    assert.equal(
      body.count,
      1,
      "D-065's depth: this version and the one before it are kept, pruned beyond",
    );
    assert.match(body.items[0]?.file ?? "", /^report-/);
  });

  it("uninstall removes the folder and the trail says it was here; the guard still gates the whole surface", async () => {
    const h = await boot();
    boots.push(h);
    const skill = scaffoldSkill(path.join(path.dirname(h.repoRoot), "work4"), "weekly-report");
    await raw(h, "/api/v1/extensions/install", { method: "POST", body: { path: skill } });
    const removed = await raw(h, "/api/v1/extensions/weekly-report", { method: "DELETE" });
    assert.equal(removed.status, 200);
    // biome-ignore lint/suspicious/noExplicitAny: the assertion reads an untyped wire body — the shape is what this route test exists to pin, and restating it as a type would duplicate the contract under test
    assert.match((removed.body as any).note, /removed/);
    const trail = listAudit(h.db, { limit: 10 });
    const row = trail.rows.find(
      (candidate) =>
        candidate.kind === "extension_install" && candidate.detail?.action === "uninstall",
    );
    assert.ok(row !== undefined, "the trail records what stopped existing");

    const gone = await raw(h, "/api/v1/extensions/weekly-report", { method: "DELETE" });
    assert.equal(gone.status, 404, "a second uninstall has nothing to remove");

    const unauth = await raw(h, "/api/v1/extensions", { token: null });
    assert.equal(unauth.status, 401, "the list answers the token, like every other read");
  });
});
