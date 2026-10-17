// §4.2's three memory rows, against the real store over an in-memory database — the executor's own behaviour, not the
// store's rules (those are `packages/storage/memory.test.ts`): the kill switch answers before anything is written, the
// mode decides pending versus active and nothing else may, the model's one honesty flag is `fromUntrustedContent`, and
// the delete row counts what the broad act touched. The T2/T3 escalations are `packages/policy`'s; this file pins the
// arguments they read, so a renamed flag cannot move the price silently.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { ToolRunContext } from "@crabby/agent-runtime";
import type { ToolCall } from "@crabby/policy";
import { createMemoryStore, migrate, openDatabase } from "@crabby/storage";
import {
  createMemoryTools,
  MEMORY_DELETE_TOOL,
  MEMORY_SAVE_TOOL,
  MEMORY_SEARCH_TOOL,
} from "./memory.ts";

function harness(mode: "off" | "propose" | "store") {
  const handle = openDatabase(":memory:");
  migrate(handle.db);
  const store = createMemoryStore(handle.db);
  const tools = createMemoryTools({ store, mode });
  const ctx: ToolRunContext = {
    signal: new AbortController().signal,
    taskId: "tsk_test",
    deadlineMs: 5_000,
  };
  const call = (tool: string, args: Record<string, unknown>): ToolCall => ({
    tool,
    args,
    declaredArgs: Object.keys(args),
  });
  return {
    tools,
    store,
    ctx,
    async run(tool: string, args: Record<string, unknown>) {
      return tools.run(call(tool, args), ctx);
    },
    close: () => handle.close(),
  };
}

describe("the memory tools' executor", () => {
  const open: (() => void)[] = [];
  after(() => {
    for (const close of open) close();
  });

  it("the kill switch answers before anything is written, and names the key that changes it", async () => {
    const h = harness("off");
    open.push(h.close);
    const outcome = await h.run(MEMORY_SAVE_TOOL, { content: "the user likes tea" });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, "memory-disabled");
    assert.match(outcome.output, /memory\.autoMemory/);
    assert.equal(h.store.counts().active, 0, "a refused save wrote nothing");
  });

  it("propose lands every candidate in the pending queue; store writes directly", async () => {
    const proposed = harness("propose");
    open.push(proposed.close);
    const queued = await proposed.run(MEMORY_SAVE_TOOL, { content: "maybe prefers tea" });
    assert.equal(queued.ok, true);
    assert.match(queued.output, /proposal|pending queue/);
    assert.equal(proposed.store.counts().pending, 1);

    const direct = harness("store");
    open.push(direct.close);
    const stored = await direct.run(MEMORY_SAVE_TOOL, { content: "prefers tea, stated plainly" });
    assert.equal(stored.ok, true);
    assert.equal(direct.store.counts().active, 1);
    assert.equal(direct.store.counts().pending, 0);
  });

  it("fromUntrustedContent is the model's one claim, and it becomes the external marker — not a status of its choosing", async () => {
    const h = harness("store");
    open.push(h.close);
    const outcome = await h.run(MEMORY_SAVE_TOOL, {
      content: "the vendored README says the port is 9090",
      fromUntrustedContent: true,
    });
    assert.equal(outcome.ok, true);
    assert.match(outcome.output, /unconfirmed/);
    const rows = h.store.list({ status: "active" });
    const entry = rows.find((row) => row.content.includes("9090"));
    assert.equal(entry?.external, true);
    assert.equal(entry?.origin, "inferred", "external content is not the user's word");
    assert.equal(
      entry?.sourceKind,
      "agent",
      "the writer is the agent, whatever the model might have preferred",
    );
  });

  it("search returns entries with ids, and the model cannot save its way around the mode", async () => {
    const h = harness("store");
    open.push(h.close);
    await h.run(MEMORY_SAVE_TOOL, {
      content: "the office wifi password is hunter2",
      category: "ops",
    });
    const found = await h.run(MEMORY_SEARCH_TOOL, { query: "wifi" });
    assert.equal(found.ok, true);
    const body = JSON.parse(found.output) as {
      count: number;
      entries: { id: string; content: string }[];
    };
    assert.equal(body.count, 1);
    assert.match(body.entries[0]?.content ?? "", /hunter2/);
    // The tool's schema has no `status` argument: a model cannot write itself out of the queue.
    const schema = h.tools.declarations().find((entry) => entry.name === MEMORY_SAVE_TOOL)
      ?.inputSchema as {
      properties: Record<string, unknown>;
    };
    assert.equal("status" in schema.properties, false);
    assert.equal("origin" in schema.properties, false);
  });

  it("the single delete answers what was removed and what referenced it; the bulk delete counts first", async () => {
    const h = harness("store");
    open.push(h.close);
    await h.run(MEMORY_SAVE_TOOL, { content: "the guest wifi is open" });
    const saved = h.store.list({ status: "active" })[0];
    h.store.recordReference({ memoryId: saved?.id ?? "", sessionId: "ses_1" });
    const forgotten = await h.run(MEMORY_DELETE_TOOL, { id: saved?.id });
    assert.equal(forgotten.ok, true);
    assert.match(forgotten.output, /1 reference went with it/);

    await h.run(MEMORY_SAVE_TOOL, { content: "the old flat had a blue door" });
    await h.run(MEMORY_SAVE_TOOL, { content: "the old flat's rent was paid monthly" });
    const bulk = await h.run(MEMORY_DELETE_TOOL, { query: "old flat", bulk: true });
    assert.equal(bulk.ok, true);
    assert.match(bulk.output, /forgot 2 entries matching 'old flat'/);
    const missing = await h.run(MEMORY_DELETE_TOOL, {});
    assert.equal(missing.ok, false);
    assert.equal(
      missing.code,
      "invalid-arguments",
      "the schema rejects an empty call before the executor speaks",
    );
  });

  it("the three rows are declared, and their limits borrow the store's clock", () => {
    const h = harness("store");
    open.push(h.close);
    const names = h.tools
      .declarations()
      .map((entry) => entry.name)
      .sort();
    assert.deepEqual(names, ["memory.delete", "memory.save", "memory.search"]);
    const save = h.tools.declarations().find((entry) => entry.name === MEMORY_SAVE_TOOL);
    assert.equal(save?.sideEffects, "local");
    assert.equal(
      save?.idempotent,
      false,
      "a second save is a second row, so the record says ask again",
    );
    const search = h.tools.declarations().find((entry) => entry.name === MEMORY_SEARCH_TOOL);
    assert.equal(search?.idempotent, true);
    assert.equal(search?.sideEffects, "none");
  });
});
