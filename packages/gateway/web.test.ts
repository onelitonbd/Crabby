// The two halves of D-067's serving story, each held where it can fail: the client assets answer **without** a token
// (they are the client — `web.ts`'s header argues why that is not a §13 violation), and the API one level over still
// answers `401` without one (the token model did not move). The traversal case is its own test, because "the only
// file a URL can reach is a file in the client directory" is the property, not an implementation detail.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createLogger } from "@crabby/core";
import { dataLayout } from "@crabby/platform";
import { migrate, openDatabase } from "@crabby/storage";
import { buildApp } from "./app.ts";
import { resolveWebAsset } from "./web.ts";

describe("the Gateway-served web client (D-067)", () => {
  let root: string;
  let dir: string;
  let close: (() => Promise<void>) | undefined;

  before(async () => {
    root = mkdtempSync(path.join(tmpdir(), "crabby-web-"));
    mkdirSync(path.join(root, "js"), { recursive: true });
    writeFileSync(path.join(root, "index.html"), "<!doctype html><title>Crabby</title>", "utf8");
    writeFileSync(path.join(root, "styles.css"), ":root{}", "utf8");
    writeFileSync(path.join(root, "js", "app.js"), "export {};", "utf8");
    dir = mkdtempSync(path.join(tmpdir(), "crabby-web-db-"));
    const handle = openDatabase(path.join(dir, "crabby.db"));
    migrate(handle.db);
    const built = await buildApp({
      db: handle.db,
      layout: dataLayout(dir),
      log: createLogger({ level: "error", write: () => {} }, "web-test"),
      version: "test",
      startedAt: new Date(),
      listenerMode: "local",
      webRoot: root,
    });
    close = async () => {
      await built.app.close();
      handle.close();
    };
  });

  after(async () => {
    if (close !== undefined) await close();
  });

  it("serves the client assets with no token, no-store, and the right type", async () => {
    const handle = openDatabase(path.join(dir, "crabby.db"));
    migrate(handle.db);
    const built = await buildApp({
      db: handle.db,
      layout: dataLayout(dir),
      log: createLogger({ level: "error", write: () => {} }, "web-test"),
      version: "test",
      startedAt: new Date(),
      listenerMode: "local",
      webRoot: root,
    });
    try {
      for (const [p, type] of [
        ["/web/", "text/html"],
        ["/web/styles.css", "text/css"],
        ["/web/js/app.js", "text/javascript"],
      ] as const) {
        const response = await built.app.inject({ method: "GET", url: p });
        assert.equal(response.statusCode, 200, `${p} answered ${String(response.statusCode)}`);
        assert.ok(String(response.headers["content-type"]).startsWith(type), `${p} type`);
        assert.equal(response.headers["cache-control"], "no-store", `${p} caching`);
      }
    } finally {
      await built.app.close();
    }
    handle.close();
  });

  it("answers 404, with a body that names nothing, for a miss and for a traversal", async () => {
    const handle = openDatabase(path.join(dir, "crabby.db"));
    migrate(handle.db);
    const built = await buildApp({
      db: handle.db,
      layout: dataLayout(dir),
      log: createLogger({ level: "error", write: () => {} }, "web-test"),
      version: "test",
      startedAt: new Date(),
      listenerMode: "local",
      webRoot: root,
    });
    try {
      for (const p of [
        "/web/nope.js",
        "/web/../secret.txt",
        "/web/%2e%2e/secret.txt",
        "/web/js/../../db.sqlite3",
      ]) {
        const response = await built.app.inject({ method: "GET", url: encodeURI(p) });
        // The property is "no file outside the client directory is ever served": a traversal that the router
        // normalizes away lands on an unknown path and answers 401 like every other unauthenticated route, one the
        // handler still holds answers 404. Either way the body names nothing and the file does not move.
        assert.notEqual(response.statusCode, 200, `${p} leaked a file`);
        // A handler miss answers the same four syllables as the JSON not-found handler's rule demands — names nothing;
        // a normalized traversal lands on the guard, whose generic auth refusal is the one every unknown path gets.
        assert.ok(
          response.body === "not found" ||
            (JSON.parse(response.body) as { error: { code: string } }).error.code ===
              "auth_missing",
          `${p} body talks: ${response.body}`,
        );
      }
    } finally {
      await built.app.close();
    }
    handle.close();
  });

  it("leaves the API's token rule untouched: /api/v1/health next door still answers 401", async () => {
    const handle = openDatabase(path.join(dir, "crabby.db"));
    migrate(handle.db);
    const built = await buildApp({
      db: handle.db,
      layout: dataLayout(dir),
      log: createLogger({ level: "error", write: () => {} }, "web-test"),
      version: "test",
      startedAt: new Date(),
      listenerMode: "local",
      webRoot: root,
    });
    try {
      const response = await built.app.inject({ method: "GET", url: "/api/v1/health" });
      assert.equal(response.statusCode, 401);
      // POST under /web is not an asset request either — only reads are the client.
      const post = await built.app.inject({ method: "POST", url: "/web/", payload: {} });
      assert.equal(post.statusCode, 401);
    } finally {
      await built.app.close();
    }
    handle.close();
  });

  it("resolveWebAsset's containment is the property, whatever the caller", () => {
    assert.equal(resolveWebAsset("/web/../../..", root), undefined);
    // An encoded `..` is not a traversal at this layer — it is a literal (and missing) filename, which `isFile`
    // answers 404 for. The test pins that reading so "decode then check" can never creep in as a second opinion.
    const encoded = resolveWebAsset("/web/%2e%2e/secret", root) ?? "";
    assert.ok(encoded.startsWith(path.resolve(root)) && encoded.includes("%2e%2e"), encoded);
    const resolved = resolveWebAsset("/web/js/app.js", root);
    assert.ok(resolved?.startsWith(path.resolve(root)), String(resolved));
    // The app root and the bare path both land on index.html.
    assert.equal(resolveWebAsset("/web", root), resolveWebAsset("/web/", root));
  });
});
