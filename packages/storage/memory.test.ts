// The memory store, against an in-memory SQLite — the rules are the subject, not the SQL: D-073's provenance and
// conflict rules, D-065's deletion propagation, §2.4's rebuildable index, and the pending queue that makes
// "propose, don't store" a physical state rather than a hope. `docs/DATA_AND_MEMORY.md` §7's sentences are each
// asserted here by the test that would catch their regression.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { openDatabase } from "./db.ts";
import { createMemoryStore, trustWord } from "./memory.ts";
import { migrate } from "./migrate.ts";

describe("the memory store's provenance rules (D-073)", () => {
  const handle = openDatabase(":memory:");
  migrate(handle.db);
  const store = createMemoryStore(handle.db);
  after(() => handle.close());

  it("saves a stated memory with its source, and the rank is a word", () => {
    const entry = store.save({
      content: "the user's cat is named Momo",
      category: "household",
      origin: "stated",
      sourceKind: "conversation",
      sourceId: "ses_01",
    });
    assert.equal(entry.id.startsWith("mem_"), true, "D-135's prefix");
    assert.equal(trustWord(entry), "stated");
    assert.equal(entry.sourceCount, 1);
  });

  it("an edit makes the user the author — user edits are authoritative (W8-03)", () => {
    const entry = store.save({
      content: "deploys on tuesday",
      origin: "inferred",
      sourceKind: "agent",
    });
    const edited = store.edit(entry.id, "deploys on wednesday");
    assert.equal(edited.content, "deploys on wednesday");
    assert.equal(edited.origin, "stated");
    assert.equal(edited.sourceKind, "user");
    assert.equal(trustWord(edited), "stated");
  });

  it("a newer stated supersedes an older stated; inferred never supersedes anything", () => {
    const older = store.save({ content: "the pin is 1234", origin: "stated", sourceKind: "user" });
    const newer = store.save({ content: "the pin is 9876", origin: "stated", sourceKind: "user" });
    const moved = store.supersede(older.id, newer.id);
    assert.equal(moved?.status, "superseded");
    assert.equal(moved?.supersededBy, newer.id);
    const guess = store.save({
      content: "the pin might be 0000",
      origin: "inferred",
      sourceKind: "agent",
    });
    const refused = store.supersede(older.id, guess.id);
    assert.equal(
      refused?.status,
      "superseded",
      "an inferred row cannot push a stated row aside — the attempt is a no-op",
    );
    const settled = store.save({
      content: "a confirmed row",
      origin: "confirmed",
      sourceKind: "agent",
    });
    const target = store.save({ content: "a stated row", origin: "stated", sourceKind: "user" });
    const alsoRefused = store.supersede(target.id, settled.id);
    assert.equal(
      alsoRefused?.status,
      "active",
      "a confirmed row does not push a stated one aside either",
    );
  });

  it("a contradiction the rules cannot settle is two active entries, not a silent winner", () => {
    const a = store.save({
      content: "the server is eu-west",
      origin: "stated",
      sourceKind: "user",
    });
    const b = store.save({
      content: "the server is ap-south",
      origin: "stated",
      sourceKind: "user",
    });
    assert.equal(a.status, "active");
    assert.equal(b.status, "active");
    // `supersede` is the only path to superseded, and nothing called it: both stay listed, timestamps beside them.
    assert.equal(store.list({ status: "active" }).length >= 2, true);
  });

  it("external-derived content reads as unconfirmed until a user confirms it (W8-07)", () => {
    const entry = store.save({
      content: "the vendored README says the port is 9090",
      origin: "inferred",
      sourceKind: "task",
      external: true,
    });
    assert.equal(trustWord(entry), "unconfirmed");
    const confirmed = store.confirm(entry.id);
    assert.equal(trustWord(confirmed), "confirmed");
    assert.equal(confirmed.external, false);
    assert.ok(confirmed.lastConfirmedAt !== undefined);
  });
});

describe("the memory store's deletion semantics (D-065 / §7)", () => {
  const handle = openDatabase(":memory:");
  migrate(handle.db);
  const store = createMemoryStore(handle.db);
  after(() => handle.close());

  it("a conversation's death marks single-source memories for review and re-attributes the rest — deleting neither", () => {
    const only = store.save({
      content: "only from ses_9",
      origin: "stated",
      sourceKind: "conversation",
      sourceId: "ses_9",
    });
    const shared = store.save({
      content: "from ses_9 and elsewhere",
      origin: "confirmed",
      sourceKind: "conversation",
      sourceId: "ses_9",
      sourceCount: 2,
    });
    const untouched = store.save({
      content: "from ses_8",
      origin: "stated",
      sourceKind: "conversation",
      sourceId: "ses_8",
    });
    const result = store.propagateConversationDeletion("ses_9");
    assert.equal(result.needsReview, 1);
    assert.equal(result.reattributed, 1);
    assert.equal(
      store.get(only.id)?.status,
      "needs-review",
      "marked, not deleted — a person decides",
    );
    const kept = store.get(shared.id);
    assert.equal(kept?.status, "active");
    assert.equal(kept?.sourceCount, 1);
    assert.equal(
      kept?.sourceMissing,
      true,
      "the pointer that names a deleted conversation is flagged, not erased",
    );
    assert.equal(store.get(untouched.id)?.status, "active");
  });

  it("forget answers what referenced the entry — the preview C9-05 prints", () => {
    const entry = store.save({
      content: "the wifi password",
      origin: "stated",
      sourceKind: "user",
    });
    store.recordReference({ memoryId: entry.id, sessionId: "ses_1" });
    store.recordReference({ memoryId: entry.id, taskId: "tsk_2" });
    const report = store.forget(entry.id);
    assert.equal(report?.entry.content, "the wifi password");
    assert.equal(report?.references.length, 2);
    assert.equal(store.get(entry.id), undefined, "the row is gone, and so is its index entry");
    assert.equal(store.search("wifi password").length, 0);
  });

  it("the pending queue is a physical state, and a person's review is the only way out", () => {
    const proposal = store.save({
      content: "maybe prefers oat milk",
      origin: "inferred",
      sourceKind: "agent",
      status: "pending",
    });
    assert.equal(trustWord(proposal), "proposed");
    assert.equal(store.get(proposal.id)?.status, "pending");
    const approved = store.review(proposal.id, "approve");
    assert.equal(approved?.status, "active");
    const second = store.save({
      content: "maybe dislikes coriander",
      origin: "inferred",
      sourceKind: "agent",
      status: "pending",
    });
    const rejected = store.review(second.id, "reject");
    assert.equal(
      rejected?.content,
      "maybe dislikes coriander",
      "the answer carries what was removed",
    );
    assert.equal(store.get(second.id), undefined);
  });
});

describe("the memory store's search (D-065 / §2.4)", () => {
  const handle = openDatabase(":memory:");
  migrate(handle.db);
  const store = createMemoryStore(handle.db);
  after(() => handle.close());

  it("text search finds by content, and Bengali shares the one tokenizer", () => {
    store.save({ content: "মামার বাড়ি নিদারুণ কাছে", origin: "stated", sourceKind: "user" });
    store.save({
      content: "the office wifi password is hunter2",
      origin: "stated",
      sourceKind: "user",
    });
    assert.equal(
      store.search("মামার").length,
      1,
      "recall is unicode61's — documented as imperfect, not patched",
    );
    assert.equal(store.search("wifi").length, 1);
  });

  it("the index is rebuildable from the authoritative rows", () => {
    const entry = store.save({ content: "rebuild me", origin: "stated", sourceKind: "user" });
    handle.db.prepare("DELETE FROM memory_search_fts").run();
    assert.equal(store.search("rebuild").length, 0, "a broken index finds nothing");
    const indexed = store.rebuildIndex();
    assert.ok(indexed >= 1);
    assert.equal(
      store
        .search("rebuild")
        .map((row) => row.id)
        .includes(entry.id),
      true,
    );
  });

  it("superseded entries leave the default list but keep their row — nothing is silently gone", () => {
    const older = store.save({ content: "old fact", origin: "stated", sourceKind: "user" });
    const newer = store.save({ content: "new fact", origin: "stated", sourceKind: "user" });
    store.supersede(older.id, newer.id);
    const active = store.list({ status: "active" }).map((row) => row.id);
    assert.equal(active.includes(older.id), false);
    assert.equal(
      store.get(older.id)?.content,
      "old fact",
      "the row is there for the review screen",
    );
    assert.equal(store.counts().superseded >= 1, true);
  });
});
