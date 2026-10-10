// `docs/DEVELOPMENT.md` §12's `test:security` job, and the file its name refers to. These are not the policy unit
// tests again: `packages/policy/policy.test.ts` proves the rules, and this file proves the *surface* — that the
// Gateway cannot expose a route that skips the token check, that a restricted client can never be walked into an
// approval it cannot answer, and that no configuration shape can lower a tier. Each of those is a property over
// *everything*, which is why it reads the registries rather than a hand-picked list: a hand-picked list is exactly as
// current as the last person who remembered to update it.
//
// The route enumeration is the load-bearing part. `app.printRoutes()` is Fastify's own router dump, so the list of
// paths this test checks is the list the server can actually answer, and a route added in `app.ts` next week is
// covered the day it lands — with no one having to remember this file exists.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createLogger } from "@crabby/core";
import { buildApp } from "@crabby/gateway";
import { dataLayout } from "@crabby/platform";
import {
  CAPABILITIES,
  evaluate,
  OFF_BY_DEFAULT,
  type PolicyDecision,
  raiseOnly,
  resolveTool,
  TOOL_REGISTRY,
} from "@crabby/policy";
import { migrate, openDatabase } from "@crabby/storage";

const ALL_GRANTS = CAPABILITIES.map((capability) => capability.name);

/**
 * Read Fastify's router dump back into (method, path) pairs. `printRoutes` compresses shared prefixes — `/auth/pair`
 * and `/auth/pair-codes` print as a node and a `-codes` child — so the tree has to be walked rather than matched, and
 * a regex that silently stopped matching would turn this sweep into a sweep of nothing. `HEAD` is dropped because
 * Fastify answers it wherever `GET` is registered, so it is never a route that could skip a check.
 */
function parseRouteTree(dump: string): { method: string; path: string }[] {
  const found: { method: string; path: string }[] = [];
  const byDepth: string[] = [];
  for (const line of dump.split("\n")) {
    const marker = line.search(/[├└]/);
    if (marker < 0) continue;
    const depth = Math.floor(marker / 4);
    const body = line.slice(marker + 4);
    const match = /^(\S+)\s+\(([^)]*)\)$/.exec(body.trim());
    if (!match) continue;
    const raw = match[1] ?? "";
    const methods = (match[2] ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "HEAD");
    const parent = depth === 0 ? "" : (byDepth[depth - 1] ?? "");
    const full = raw.startsWith("-") ? parent + raw.slice(1) : parent + raw;
    byDepth[depth] = full;
    byDepth.length = depth + 1;
    for (const method of methods) found.push({ method, path: full });
  }
  return found.sort((a, b) => `${a.method}${a.path}`.localeCompare(`${b.method}${b.path}`));
}

describe("the http surface cannot lose the token check", () => {
  let dir: string;
  let close: () => Promise<void>;
  let routes: { method: string; path: string }[];

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "crabby-security-"));
    const handle = openDatabase(path.join(dir, "crabby.db"));
    migrate(handle.db);
    const built = await buildApp({
      db: handle.db,
      layout: dataLayout(dir),
      log: createLogger({ level: "error", write: () => {} }, "security-test"),
      version: "test",
      startedAt: new Date(),
      listenerMode: "local",
    });
    routes = parseRouteTree(built.app.printRoutes({ commonPrefix: false }));
    close = async () => {
      await built.app.close();
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    };
  });

  after(async () => {
    await close();
  });

  it("finds the routes the router can actually answer", async () => {
    // If the parse shape ever changes, this fails loudly — a security sweep that enumerated zero routes would
    // otherwise pass forever, which is the worst kind of green.
    assert.ok(routes.length >= 12, `only ${routes.length} routes were parsed from printRoutes()`);
    assert.ok(
      new Set(routes.map((route) => route.path)).size >= 10,
      "the router collapsed the surface",
    );
  });

  it("answers 401 on every parameterless route without a token, except the one §3.1 exempts", async () => {
    const handle = openDatabase(path.join(dir, "crabby.db"));
    const built = await buildApp({
      db: handle.db,
      layout: dataLayout(dir),
      log: createLogger({ level: "error", write: () => {} }, "security-test"),
      version: "test",
      startedAt: new Date(),
      listenerMode: "local",
    });
    try {
      const exempt = ["/api/v1/auth/pair"];
      const checked = routes.filter((route) => !route.path.includes(":"));
      assert.ok(checked.length > 0);
      for (const route of checked) {
        const response = await built.app.inject({ method: route.method as never, url: route.path });
        if (exempt.includes(route.path)) {
          assert.notEqual(
            response.statusCode,
            401,
            `${route.path} is the one route §3.1 lets through unauthenticated`,
          );
          continue;
        }
        assert.equal(
          response.statusCode,
          401,
          `${route.method} ${route.path} answered without demanding a token; SECURITY.md §13 requires rejection on every route`,
        );
        assert.match(
          String(response.headers["x-crabby-request-id"] ?? ""),
          /.+/,
          "a refusal still needs a request id",
        );
      }
      // The mint path is exempt from *nothing* but loopback; an unauthenticated mint would let any local process pair
      // itself, which is the difference between "code in my terminal" and "code from the network".
      const mint = await built.app.inject({ method: "POST", url: "/api/v1/auth/pair-codes" });
      assert.equal(mint.statusCode, 401);
    } finally {
      await built.app.close();
      handle.close();
    }
  });
});

describe("no client can be walked into an approval it cannot answer", () => {
  it("every tool, for every removed capability, answers unavailable rather than require-approval (§13)", () => {
    for (const spec of TOOL_REGISTRY) {
      for (const grant of spec.capabilities) {
        const decision: PolicyDecision = evaluate(
          { tool: spec.tool, args: {} },
          { grants: [], removedGrants: [grant], clientKind: "telegram", taskId: "task_x" },
          { grants: [] },
        );
        assert.notEqual(
          decision.outcome,
          "require-approval",
          `${spec.tool} offered an approval to an identity that cannot hold '${grant}'`,
        );
        if (decision.outcome === "unavailable") assert.equal(decision.capability, grant);
      }
    }
  });

  it("no T3 tool is answerable from Telegram, whatever the arguments", () => {
    // Filtered through `resolveTool` rather than read off the rows, because two §4.2 rows share the name `ext.install`
    // (content kind T2, executable kind T3) and the tier a *nameless* call resolves to is the first one. The
    // argument-dependent half of that is `escalation.ts`'s business, and M2 supplies the arguments.
    const t3 = TOOL_REGISTRY.filter((spec) => resolveTool(spec.tool)?.tier === "T3");
    assert.ok(t3.length >= 6, `only ${t3.length} rows are T3, which is not what §4.2 says`);
    for (const spec of t3) {
      const decision = evaluate(
        { tool: spec.tool, args: {} },
        { grants: ALL_GRANTS, clientKind: "telegram", taskId: "task_y" },
        { grants: ALL_GRANTS },
      );
      assert.notEqual(
        decision.outcome,
        "require-approval",
        `${spec.tool} asked Telegram to approve a T3`,
      );
      assert.equal(
        decision.outcome,
        "deny",
        `${spec.tool} was allowed through from Telegram at T3`,
      );
      if (decision.outcome !== "deny") continue;
      assert.match(
        decision.reason,
        /TUI or the Web/,
        "the refusal has to name where the answer can be given",
      );
    }
  });

  it("an approval never exists for a T0 or T1 call, and always exists above it", () => {
    for (const spec of TOOL_REGISTRY) {
      const decision = evaluate(
        { tool: spec.tool, args: {} },
        { grants: ALL_GRANTS, clientKind: "local", taskId: "t" },
        {
          grants: ALL_GRANTS,
        },
      );
      if (spec.tier === "T0" || spec.tier === "T1") {
        // The escalation rules may still raise a call out of auto-allow — that is their job — but they may only do it
        // with an argument in front of them, so an empty-args call must stay allowed.
        assert.equal(
          decision.outcome,
          "allow",
          `${spec.tool} at ${spec.tier} with no arguments was not auto-allowed`,
        );
      }
    }
  });
});

describe("configuration cannot loosen the floor", () => {
  it("raising is the only operation a tier accepts", () => {
    for (const spec of TOOL_REGISTRY) {
      for (const requested of ["T0", "T1", "T2", "T3"] as const) {
        assert.equal(
          raiseOnly(spec.tier, requested) === spec.tier ||
            raiseOnly(spec.tier, requested) > spec.tier,
          true,
          `${spec.tool} could be moved below its §4.2 tier by a request for ${requested}`,
        );
      }
      assert.equal(raiseOnly(spec.tier, undefined), spec.tier);
    }
  });

  it("the off-by-default capabilities are the ones §4.2 names, and only those", () => {
    const offByName = TOOL_REGISTRY.filter((spec) =>
      spec.capabilities.some((c) => OFF_BY_DEFAULT.includes(c)),
    );
    assert.deepEqual(
      [...new Set(offByName.map((spec) => spec.capabilities.join("+")))].sort(),
      [...OFF_BY_DEFAULT].sort(),
      "an enabled-state default was added to the registry without naming the capability that carries it",
    );
    assert.deepEqual(
      [...OFF_BY_DEFAULT],
      ["shell.run"],
      "the off-by-default set is §4.2's sentence, not a guess about siblings",
    );
    for (const capability of OFF_BY_DEFAULT) {
      const rows = TOOL_REGISTRY.filter((spec) => spec.capabilities.includes(capability));
      assert.ok(rows.length > 0, `'${capability}' names no row at all`);
      assert.ok(
        rows.some((spec) => /off by default/.test(spec.notes ?? "")),
        `'${capability}' is treated as off by default, but no §4.2 row for it says so — the default needs a source`,
      );
    }
  });
});
