// The conversation executor, and the composition it joins. Asserted as the sentences it enforces: what §4.2's two rows
// declare, what a list answers when an install has no conversations at all, that a refusal arrives with the store's own
// code rather than a flattened one, and that the third surface in a Gateway's composition does not shadow the other two.
//
// A separate file from `tools.test.ts` for the reason `scheduler-tools.test.ts` is one: that suite's subject is a real
// filesystem, and this one has no database in it either — its subject is what a model is offered and what it is told when
// an answer is no.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { RunOrigin, ToolRunContext } from "@crabby/agent-runtime";
import type { SessionRow } from "@crabby/api-contracts";
import { LIMITS_DEFAULTS } from "@crabby/core";
import { PENDING_RECORD_FIELDS } from "@crabby/policy";
import {
  combineToolSurfaces,
  createFileTools,
  createSchedulerTools,
  createSessionTools,
  SESSION_LIST_TOOL,
  SESSION_RENAME_TOOL,
  type SessionRenameResult,
} from "./index.ts";

const ORIGIN: RunOrigin = {
  clientId: "cli_1",
  clientName: "the owner",
  interface: "cli",
  capabilities: ["session.read", "session.write"],
  sessionId: "ses_1",
};

function context(origin: RunOrigin | null = ORIGIN): ToolRunContext {
  return {
    taskId: "tsk_harness1",
    signal: new AbortController().signal,
    deadlineMs: undefined,
    ...(origin === null ? {} : { origin }),
  };
}

function row(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "ses_one",
    titleShown: "the inbox project",
    stateWord: "idle",
    tasks: 2,
    runningTasks: 0,
    createdAt: "2026-10-12T06:00:00.000Z",
    updatedAt: "2026-10-12T06:00:00.000Z",
    lastActivityAt: "2026-10-12T06:30:00.000Z",
    revision: 1,
    ...overrides,
  };
}

interface Lab {
  readonly rows: SessionRow[];
  /** What the next rename answers with. Absent means the write succeeded, which is the honest default: most of these tests
   *  are about the answer a success produces. */
  // `| undefined` because `exactOptionalPropertyTypes` otherwise forbids the one-shot assignment that consumes a refusal.
  refuseNext?: SessionRenameResult | undefined;
  readonly renames: { id: string; title: string }[];
  readonly tools: ReturnType<typeof createSessionTools>;
  readonly files: ReturnType<typeof createFileTools>;
}

function lab(rows: SessionRow[] = []): Lab {
  const root = mkdtempSync(path.join(tmpdir(), "crabby-session-tools-"));
  const self: Lab = {
    rows,
    refuseNext: undefined,
    renames: [],
    get tools() {
      return tools;
    },
    get files() {
      return files;
    },
  };
  const tools = createSessionTools({
    list: () => self.rows,
    rename: ({ id, title }) => {
      self.renames.push({ id, title });
      const refusal = self.refuseNext;
      if (refusal !== undefined) {
        self.refuseNext = undefined;
        return refusal;
      }
      const found = self.rows.find((candidate) => candidate.id === id);
      if (found === undefined)
        return { ok: false as const, code: "not-found" as const, reason: `no session ${id}` };
      const renamed: SessionRow = {
        ...found,
        titleShown: title,
        title,
        revision: found.revision + 1,
      };
      self.rows[self.rows.indexOf(found)] = renamed;
      return { ok: true as const, session: renamed };
    },
  });
  const files = createFileTools({
    paths: { home: path.join(root, "home"), dataDir: path.join(root, "state"), roots: [root] },
    scratchDirFor: (taskId) => path.join(root, "state", "scratch", taskId),
  });
  return self;
}

const call = (tool: string, args: Record<string, unknown>) => ({ tool, args });
type Outcome = { ok: boolean; output: string; code?: string };

test("the two declarations say what §4.2's rows say, including the delete that is not here", () => {
  const instance = lab();
  const declarations = instance.tools.declarations();
  assert.deepEqual(
    declarations.map((declaration) => declaration.name),
    [SESSION_LIST_TOOL, SESSION_RENAME_TOOL],
  );
  const [list, rename] = declarations;
  assert.equal(
    list?.idempotent,
    true,
    "a read with no writes in it, so §7.3's resume may repeat it freely",
  );
  assert.equal(
    list?.sideEffects,
    "none",
    "and §6.2's evidence for a step abandoned here is that nothing was left behind",
  );
  assert.equal(
    rename?.sideEffects,
    "local",
    "a write to this device's database: `none` would tell a recovery path there was nothing to be uncertain about",
  );
  assert.equal(
    rename?.idempotent,
    true,
    "writing the same title twice ends at the same title, which is the sense §7.3 cares about",
  );
  for (const declaration of declarations) {
    assert.equal(
      declaration?.limits.timeoutMs,
      LIMITS_DEFAULTS.sqliteBusyTimeoutMs,
      "D-074's `SQLite busy` row, because §5.2 prices no `session.*` class and both tools cost statements against this device's database",
    );
    assert.equal(declaration?.outputSchema, undefined);
    const answered = declaration as unknown as Record<string, unknown>;
    assert.deepEqual(
      PENDING_RECORD_FIELDS.filter((field) => answered[field] === undefined),
      ["outputSchema"],
      "F-55's asymmetry from this row's side: four of the five runtime fields answered and the fifth named as pending",
    );
  }
  assert.match(
    list?.description ?? "",
    /T0/,
    "the description tells the model what the call costs a user",
  );
  assert.match(
    list?.description ?? "",
    /no tool that reads a conversation's messages/,
    "and what it cannot do, because a model that asks for turns deserves the reason",
  );
  assert.match(rename?.description ?? "", /T1/);
  assert.match(
    rename?.description ?? "",
    /no delete here/,
    "C11-05's absence is stated in the declaration, so a model does not spend a turn discovering it",
  );
  assert.match(rename?.description ?? "", /history\.deleteConversation/);
});

test("a list with nothing in it says what creates one, rather than answering an empty page", () => {
  const instance = lab([]);
  const outcome = instance.tools.run(call(SESSION_LIST_TOOL, {}), context()) as Outcome;
  assert.equal(outcome.ok, true, "an empty list is an answer, not a failure");
  assert.match(outcome.output, /no conversations yet/);
  assert.match(
    outcome.output,
    /created by the first task asked in it/,
    "and it teaches the two ways one comes to exist, because a model that reports 'you have no history' would be wrong",
  );
  assert.match(outcome.output, /crabby session new/);
});

test("a list prints C11-01's fields, in the route's order, and says when it stopped", () => {
  const many = Array.from({ length: 25 }, (_, index) =>
    row({
      id: `ses_${index}`,
      titleShown: index === 0 ? "the newest" : `conversation ${index}`,
      stateWord: index === 1 ? "waiting-approval" : "idle",
      tasks: index,
      runningTasks: index === 2 ? 1 : 0,
      ...(index === 3 ? {} : { origin: (index % 2 === 0 ? "cli" : "web") as "cli" | "web" }),
      ...(index === 4 ? {} : { model: "local/qwen2.5:3b" }),
    }),
  );
  const instance = lab(many);
  const outcome = instance.tools.run(call(SESSION_LIST_TOOL, {}), context()) as Outcome;
  assert.equal(outcome.ok, true);
  assert.match(
    outcome.output,
    /^25 conversations, newest activity first:/,
    "the count and the order, stated",
  );
  assert.match(
    outcome.output,
    /ses_0 {2}"the newest" {2}idle/,
    "id, title and state word on one line",
  );
  assert.match(
    outcome.output,
    /waiting-approval/,
    "and the state that must never be hidden is in the list (W16-02's rule)",
  );
  assert.match(
    outcome.output,
    /2 tasks \(1 moving\)/,
    "the counts, with the moving one called out",
  );
  assert.match(
    outcome.output,
    /1 task {2}last activity/,
    "and the singular spelled as one task rather than one tasks",
  );
  assert.match(
    outcome.output,
    /unknown origin/,
    "W15-11's attribution, and `unknown` for the conversations schema version 6 backfilled — a guess would read as an attribution",
  );
  assert.match(
    outcome.output,
    /model local\/qwen2\.5:3b/,
    "and the override, which is only printed when there is one",
  );
  assert.match(
    outcome.output,
    /and 5 more; the list is bounded at 20/,
    "a bounded answer says it was bounded, because a model that read 20 rows as all of them would answer a question wrongly",
  );

  // The filter, and the vocabulary it accepts.
  const bad = instance.tools.run(
    call(SESSION_LIST_TOOL, { origin: "shell" }),
    context(),
  ) as Outcome;
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "bad-argument");
  assert.match(
    bad.output,
    /cli, tui, web, telegram/,
    "the refusal names the four interfaces it does accept",
  );
  const wrongType = instance.tools.run(
    call(SESSION_LIST_TOOL, { origin: 7 }),
    context(),
  ) as Outcome;
  assert.equal(wrongType.ok, false);
  assert.match(wrongType.output, /as text/);
});

test("a rename writes, says whose revision it landed on, and passes a refusal through with the store's own code", () => {
  const instance = lab([row()]);
  const outcome = instance.tools.run(
    call(SESSION_RENAME_TOOL, { id: "ses_one", title: "  a title of my own  " }),
    context(),
  ) as Outcome;
  assert.equal(outcome.ok, true);
  assert.deepEqual(
    instance.renames,
    [{ id: "ses_one", title: "a title of my own" }],
    "trimmed, because a title is read aloud in three interfaces",
  );
  assert.match(outcome.output, /renamed ses_one to "a title of my own" \(revision 2\)/);
  assert.match(
    outcome.output,
    /asked by the owner over cli/,
    "§14's audit half, from the run's own origin — which is a fact the model cannot declare",
  );
  assert.match(
    outcome.output,
    /already visible in every interface/,
    "and the sentence says there is nothing to sync",
  );

  for (const args of [
    { id: "", title: "x" },
    { id: "ses_one" },
    { id: 7, title: "x" },
    { id: "ses_one", title: "   " },
  ]) {
    const refused = instance.tools.run(call(SESSION_RENAME_TOOL, args), context()) as Outcome;
    assert.equal(refused.ok, false, `${JSON.stringify(args)} must be refused`);
    assert.equal(refused.code, "bad-argument");
  }

  // The store's own code and its own sentence: `stale` and `not-found` are different fixes, and a tool that flattened them
  // would send the model to re-read a row that was never there.
  instance.refuseNext = {
    ok: false,
    code: "stale",
    reason: "session ses_one is at revision 4 and this write carries 3",
  };
  const stale = instance.tools.run(
    call(SESSION_RENAME_TOOL, { id: "ses_one", title: "late" }),
    context(),
  ) as Outcome;
  assert.equal(stale.ok, false);
  assert.equal(stale.code, "stale");
  assert.equal(stale.output, "session ses_one is at revision 4 and this write carries 3");

  const missing = instance.tools.run(
    call(SESSION_RENAME_TOOL, { id: "ses_nobody_made", title: "x" }),
    context(),
  ) as Outcome;
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "not-found");

  const wrong = instance.tools.run(call("file.read", { path: "a.md" }), context()) as Outcome;
  assert.equal(wrong.ok, false);
  assert.equal(wrong.code, "unknown-tool");
  assert.match(
    wrong.output,
    new RegExp(SESSION_RENAME_TOOL),
    "and says what this executor does declare",
  );
});

test("three surfaces compose into one owner map, and a duplicate name is fatal rather than last-one-wins", async () => {
  const instance = lab([row()]);
  const scheduler = createSchedulerTools({
    schedule: () => ({
      ok: false as const,
      code: "unavailable" as const,
      reason: "not in this test",
    }),
  });
  const combined = combineToolSurfaces([instance.files, scheduler, instance.tools]);
  const names = combined.specs().map((spec) => spec.name);
  assert.equal(
    names.length,
    11,
    "eight from the file executor — one of which, `file.stat`, has no §4.2 row — plus `cron.schedule` plus the two " +
      "conversation rows: eleven declarations answering ten registry rows, which is F-55's item 3 unchanged",
  );
  assert.equal(
    new Set(names).size,
    names.length,
    "with no name counted twice in what a provider is offered",
  );
  for (const tool of [SESSION_LIST_TOOL, SESSION_RENAME_TOOL])
    assert.equal(
      combined.declares(tool)?.name,
      tool,
      `${tool} is declared through the combination`,
    );

  // Routing, rather than a fallback chain: each call reaches the surface that owns the name.
  const listed = (await combined.run(call(SESSION_LIST_TOOL, {}), context())) as Outcome;
  assert.equal(listed.ok, true);
  assert.match(listed.output, /the inbox project/);
  const unknown = (await combined.run(call("shell.run", {}), context())) as Outcome;
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, "not-declared");

  // A fact one surface answers survives a composition that holds two others which have nothing to say about it.
  const fileCall = { tool: "file.write", args: { path: "a.md", content: "x" } };
  assert.deepEqual(combined.facts(fileCall), instance.files.facts(fileCall));
  assert.deepEqual(combined.facts({ tool: SESSION_LIST_TOOL, args: {} }), {});

  assert.throws(
    () => combineToolSurfaces([instance.tools, instance.tools]),
    /declared by two executors in one composition/,
    "§4.1's registration rule applied to a composition, which is where two executors would otherwise start shadowing each other",
  );
});
