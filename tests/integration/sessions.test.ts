// §4.3's four conversation paths over real HTTP, plus the two `session.*` tools inside a real run.
//
// The routes are asserted on a Gateway that composed **no runner**, on purpose: a conversation is a record and not a
// privilege, and schema version 6 exists because `createTask` has minted `ses_…` ids since version 1 that nothing owned.
// A session route that needed a provider to be configured would be a route that hides a user's conversations exactly when
// their provider is broken — the same reasoning that keeps `GET /api/v1/jobs` answering from the table. The second block
// composes a runner because that is the only place the tools can be reached at all, and it asserts them the way
// `tests/integration/tasks.test.ts` asserts the file executor: a scripted provider really calls them, inside a task, and
// the change is read back off the record.
//
// What is *not* asserted here, and why: `DELETE /api/v1/sessions/{id}` does not exist, because destroying a conversation is
// `history.deleteConversation` at T3 (§4.2) and C11-05 keeps it as the one command that does; and the `messages`,
// `compact`, `export`, `context` and `pin` paths need a message store and D-027's context manager, so the detail route
// names them in its `absent` list — which is asserted below, because a route that omitted them would let a client print
// `0 turns` for a conversation that has forty.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { createScriptedProvider } from "@crabby/agent-runtime/loop-harness";
import {
  newId,
  type SessionActionBody,
  type SessionDetailBody,
  type SessionListBody,
  type TaskRecord,
  UNNAMED_TITLE,
} from "@crabby/api-contracts";
import { createLogger } from "@crabby/core";
import { buildApp, createClient, type GatewayClient } from "@crabby/gateway";
import { dataLayout, homeDirectory } from "@crabby/platform";
import { capabilitiesFor } from "@crabby/policy";
import { composeProviders, FAKE_TOOL_MODEL_ID, type FakeStep } from "@crabby/providers";
import {
  getSession,
  listSessions,
  migrate,
  mintPairingCode,
  openDatabase,
  patchSession,
  redeemPairingCode,
  type SqliteDb,
  sessionRowOf,
  sessionRows,
  taskScratch,
} from "@crabby/storage";
import {
  combineToolSurfaces,
  createFileTools,
  createSchedulerTools,
  createSessionTools,
  defaultRealpathOf,
} from "@crabby/tools";

interface Harness {
  readonly cli: GatewayClient;
  readonly db: SqliteDb;
  readonly url: string;
  readonly token: string;
  readonly creator: { clientId: string; name: string };
  close(): Promise<void>;
}

async function boot(options: {
  rounds?: readonly (readonly FakeStep[])[];
  noRunner?: boolean;
}): Promise<Harness> {
  const dir = mkdtempSync(path.join(tmpdir(), "crabby-sessions-"));
  const layout = dataLayout(dir);
  // A sibling of the data dir and never inside it: §8's deny-list refuses everything under `dataDir`.
  const root = mkdtempSync(path.join(tmpdir(), "crabby-sessions-work-"));
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "notes.md"), "# notes\n", "utf8");

  const handle = openDatabase(path.join(dir, "crabby.sqlite3"));
  migrate(handle.db);
  const paths = { home: homeDirectory(), dataDir: layout.stateDir, roots: [root] };
  const files = createFileTools({
    paths,
    scratchDirFor: (taskId) => taskScratch(layout, taskId),
  });
  // The composition `apps/cli/commands/gateway.ts` makes: three surfaces, one owner map, and a duplicate name fatal at
  // startup rather than last-one-wins.
  const sessionTools = createSessionTools({
    list: (origin) =>
      sessionRows(
        handle.db,
        listSessions(handle.db, {
          ...(origin === undefined ? {} : { origin: origin as "cli" | "tui" | "web" | "telegram" }),
        }),
      ),
    rename: ({ id, title }) => {
      const current = getSession(handle.db, id);
      if (current === undefined)
        return {
          ok: false as const,
          code: "not-found" as const,
          reason: `no session ${id}`,
        };
      const patched = patchSession(handle.db, id, {
        title,
        expectedRevision: current.revision,
      });
      if (!patched.ok) return patched;
      return { ok: true as const, session: sessionRowOf(handle.db, patched.session) };
    },
  });
  const composed = options.noRunner
    ? undefined
    : combineToolSurfaces([
        files,
        createSchedulerTools({
          schedule: () => ({
            ok: false as const,
            code: "unavailable" as const,
            reason: "this harness composes no scheduler sink; the job routes have their own file",
          }),
        }),
        sessionTools,
      ]);
  const drive =
    composed === undefined
      ? undefined
      : {
          tools: composed,
          provider: createScriptedProvider(options.rounds ?? []),
          modelId: FAKE_TOOL_MODEL_ID,
          ctx: { paths, realpathOf: defaultRealpathOf },
        };

  const built = await buildApp({
    db: handle.db,
    layout,
    providers: composeProviders({
      local: {
        baseUrl: "http://127.0.0.1:8080/v1",
        models: {
          "qwen2.5:3b": {
            contextWindow: 4096,
            maxOutputTokens: 512,
            supports: {
              streaming: true,
              toolCalling: true,
              parallelToolCalls: false,
              systemRole: true,
              structuredOutput: false,
              imageInput: false,
              audioInput: false,
              reasoning: false,
              promptCaching: false,
              jsonSchemaValidation: false,
            },
            cancellation: "best-effort",
            rateLimits: null,
            cost: "local",
            batching: null,
          },
        },
      },
    }),
    log: createLogger({ level: "error", write: () => {} }, "sessions-test"),
    version: "test",
    startedAt: new Date(),
    listenerMode: "local",
    declares: composed === undefined ? files.declares : composed.declares,
    ...(drive === undefined ? {} : { drive }),
  });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const address = built.app.server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const url = `http://127.0.0.1:${port}`;

  const minted = mintPairingCode(handle.db, {
    name: "the owner",
    interface: "cli",
    capabilities: capabilitiesFor("cli"),
  });
  const redeemed = redeemPairingCode(handle.db, minted.code);
  assert.ok(redeemed.ok && redeemed.token, "the harness's identity has to pair");
  const token = redeemed.token as string;
  return {
    cli: createClient({ url, token }),
    db: handle.db,
    url,
    token,
    creator: { clientId: redeemed.clientId as string, name: "the owner" },
    async close() {
      built.scheduler?.shutdown();
      // D-066's order: runs settle before the listener and before SQLite, so a run this harness started cannot be writing
      // when the database closes.
      await built.runner?.shutdown(5_000);
      await built.app.close();
      handle.close();
    },
  };
}

async function raw(
  h: Harness,
  route: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; etag: string | null; location: string | null; body: unknown }> {
  const response = await fetch(`${h.url}${route}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${h.token}`,
      "content-type": "application/json; charset=utf-8",
      ...init.headers,
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    etag: response.headers.get("etag"),
    location: response.headers.get("location"),
    body: text.length === 0 ? null : JSON.parse(text),
  };
}

interface ErrorEnvelope {
  error: { class: string; code: string; message: string };
}

async function untilTerminal(h: Harness, id: string, deadlineMs = 20_000): Promise<TaskRecord> {
  const started = Date.now();
  for (;;) {
    const record = (await h.cli.getTask(id)).body as TaskRecord;
    if (record.state === "completed" || record.state === "failed") return record;
    if (Date.now() - started > deadlineMs)
      assert.fail(`task ${id} was still \`${record.state}\` after ${deadlineMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("the session routes", () => {
  it("creates a conversation empty and un-named, and answers 201 with the token a rename will need", async () => {
    const h = await boot({ noRunner: true });
    try {
      const created = await raw(h, "/api/v1/sessions", { method: "POST", body: {} });
      assert.equal(created.status, 201, "a creation, so §4.3's answer is 201");
      const body = created.body as SessionActionBody;
      assert.match(
        body.session.id,
        /^ses_/,
        "`ses_` is one of the five prefixes `ids.ts` documents",
      );
      assert.equal(
        body.session.title,
        undefined,
        "W15-03: it starts un-named, and un-named is an absence rather than a blank",
      );
      assert.equal(
        body.session.titleShown,
        UNNAMED_TITLE,
        "with the word a list prints for one, decided once",
      );
      assert.equal(body.session.stateWord, "idle");
      assert.equal(body.session.tasks, 0);
      assert.equal(
        body.session.origin,
        "cli",
        "W15-11's attribution, from the credential and never from the body",
      );
      assert.equal(body.session.revision, 1);
      assert.equal(created.location, `/api/v1/sessions/${body.session.id}`);
      assert.equal(
        created.etag,
        '"1"',
        "the ETag is the revision, quoted because RFC 9110 says an entity-tag is",
      );
      assert.match(body.note, /first question asked in it/);

      // A body may carry a title, and an interface a caller declares may not.
      const titled = await raw(h, "/api/v1/sessions", {
        method: "POST",
        body: { title: "the inbox project", origin: "web" },
      });
      assert.equal(
        titled.status,
        400,
        "`origin` is not a field of the body: an attribution a caller declares is a claim",
      );
      const listed = (await h.cli.sessions()).body as SessionListBody;
      assert.equal(listed.count, 1, "and the refused creation wrote nothing");
      assert.equal(listed.items[0]?.titleShown, UNNAMED_TITLE);
    } finally {
      await h.close();
    }
  });

  it("lists in last-activity order, with the state word derived from the tasks in each conversation", async () => {
    const h = await boot({ noRunner: true });
    try {
      const first = (
        (await raw(h, "/api/v1/sessions", { method: "POST", body: {} })).body as SessionActionBody
      ).session.id;
      const second = (
        (await raw(h, "/api/v1/sessions", { method: "POST", body: {} })).body as SessionActionBody
      ).session.id;
      // A task in the *first* conversation, which is the only activity this build records: it has to move that
      // conversation to the top of a list C11-01 sorts by last activity rather than by creation.
      const task = await h.cli.createTask(
        { objective: "summarise notes.md", sessionId: first },
        "idem-session-list",
      );
      const created = (task.body as TaskRecord).id;
      assert.ok(created.length > 0);

      const body = (await h.cli.sessions()).body as SessionListBody;
      assert.equal(
        body.sortedBy,
        "lastActivity",
        "the order is stated rather than left to be inferred from the first row",
      );
      assert.deepEqual(
        body.items.map((row) => row.id),
        [first, second],
        "the conversation something happened in is first, even though it was created first anyway — and the second row is " +
          "the one that would have been on top in a list sorted by creation",
      );
      const firstRow = body.items[0];
      assert.equal(firstRow?.tasks, 1);
      assert.equal(
        firstRow?.runningTasks,
        1,
        "a task nothing has driven is still non-terminal, and the count says so",
      );
      assert.equal(firstRow?.stateWord, "running");
      assert.equal(
        firstRow?.titleShown,
        "summarise notes.md",
        "W15-03's title is the first question asked in the conversation, which in a build with no message store is the " +
          "first task's objective",
      );
      assert.equal(body.items[1]?.stateWord, "idle");

      // The filter W15-11's attribution exists for, and the vocabulary it accepts.
      const onlyCli = (await h.cli.sessions({ origin: "cli" })).body as SessionListBody;
      assert.equal(onlyCli.count, 2);
      const bad = await raw(h, "/api/v1/sessions?origin=shell");
      assert.equal(bad.status, 400);
      assert.match((bad.body as ErrorEnvelope).error.message, /cli, tui, web, telegram/);
    } finally {
      await h.close();
    }
  });

  it("answers one conversation with its tasks, its token, and what it still cannot answer", async () => {
    const h = await boot({ noRunner: true });
    try {
      const id = (
        (await raw(h, "/api/v1/sessions", { method: "POST", body: {} })).body as SessionActionBody
      ).session.id;
      await h.cli.createTask({ objective: "first question", sessionId: id }, "idem-detail-1");
      await h.cli.createTask({ objective: "second question", sessionId: id }, "idem-detail-2");

      const read = await raw(h, `/api/v1/sessions/${id}`);
      assert.equal(read.status, 200);
      assert.equal(read.etag, '"1"', "the token a rename has to send back");
      const body = read.body as SessionDetailBody;
      assert.equal(body.taskCount, 2);
      assert.equal(body.tasks.length, 2);
      assert.deepEqual(
        body.tasks.map((task) => task.objective),
        ["second question", "first question"],
        "newest first, so the tail of a conversation reads as a tail",
      );
      assert.equal(
        body.session.titleShown,
        "first question",
        "and the title stayed the *first* one, which is what W15-03 asks for",
      );
      assert.deepEqual(
        [...body.absent],
        ["context", "pins"],
        "C11-03's budget and pinned items are still named as absent rather than answered as zero, and `messages` left " +
          "this list with D-112: a detail body that omitted it would let a client render `0 turns` for a conversation that " +
          "has turns, which is what the list exists to prevent",
      );

      const missing = await raw(h, "/api/v1/sessions/ses_nobody_made");
      assert.equal(missing.status, 404);
      assert.equal((missing.body as ErrorEnvelope).error.class, "not-found");
    } finally {
      await h.close();
    }
  });

  it("renames with an If-Match token, and refuses a write that carries a stale one or none at all", async () => {
    const h = await boot({ noRunner: true });
    try {
      const id = (
        (await raw(h, "/api/v1/sessions", { method: "POST", body: {} })).body as SessionActionBody
      ).session.id;

      // §2's concurrency row: no token, no write. A rename that skipped it would be the silent overwrite the row exists
      // to prevent, and the code is its own so a client can act on it rather than read a message.
      const bare = await raw(h, `/api/v1/sessions/${id}`, {
        method: "PATCH",
        body: { title: "no token" },
      });
      assert.equal(bare.status, 400);
      assert.equal((bare.body as ErrorEnvelope).error.code, "if_match_required");
      assert.match(
        (bare.body as ErrorEnvelope).error.message,
        /If-Match/,
        "and the refusal says what to send, because the fix is a header rather than a body",
      );

      const malformed = await raw(h, `/api/v1/sessions/${id}`, {
        method: "PATCH",
        body: { title: "bad token" },
        headers: { "if-match": "not-a-revision" },
      });
      assert.equal(malformed.status, 400);
      assert.match((malformed.body as ErrorEnvelope).error.message, /revision/);

      const empty = await raw(h, `/api/v1/sessions/${id}`, {
        method: "PATCH",
        body: {},
        headers: { "if-match": '"1"' },
      });
      assert.equal(empty.status, 400, "a patch with neither a title nor a model is not an edit");
      assert.equal((empty.body as ErrorEnvelope).error.code, "session_no-change");

      const renamed = await raw(h, `/api/v1/sessions/${id}`, {
        method: "PATCH",
        body: { title: "the inbox project" },
        headers: { "if-match": '"1"' },
      });
      assert.equal(renamed.status, 200);
      assert.equal(
        renamed.etag,
        '"2"',
        "the answer carries the next token, so a client can keep editing without a re-read",
      );
      const body = renamed.body as SessionActionBody;
      assert.equal(body.session.title, "the inbox project");
      assert.equal(body.session.revision, 2);
      assert.match(
        body.note,
        /revision 2/,
        "and the sentence says which token the next edit carries",
      );

      // The race the token exists for: the same read, written twice.
      const stale = await raw(h, `/api/v1/sessions/${id}`, {
        method: "PATCH",
        body: { title: "a second interface's rename" },
        headers: { "if-match": '"1"' },
      });
      assert.equal(
        stale.status,
        409,
        "a stale token is a conflict: the request was well-formed and the world moved",
      );
      assert.equal((stale.body as ErrorEnvelope).error.code, "session_stale");
      assert.match(
        (stale.body as ErrorEnvelope).error.message,
        /revision 2 and this write carries 1/,
        "the refusal states both numbers, because 'somebody edited it' without them is a sentence a client cannot act on",
      );
      assert.equal(
        ((await raw(h, `/api/v1/sessions/${id}`)).body as SessionDetailBody).session.title,
        "the inbox project",
        "and the loser of the race wrote nothing",
      );

      // A model override is the other patchable field, and clearing it is a different act from setting it.
      const pinned = await raw(h, `/api/v1/sessions/${id}`, {
        method: "PATCH",
        body: { model: "local/qwen2.5:3b" },
        headers: { "if-match": '"2"' },
      });
      assert.equal((pinned.body as SessionActionBody).session.model, "local/qwen2.5:3b");
      assert.match((pinned.body as SessionActionBody).note, /model override is now/);
      const cleared = await raw(h, `/api/v1/sessions/${id}`, {
        method: "PATCH",
        body: { model: null },
        headers: { "if-match": '"3"' },
      });
      assert.equal(
        (cleared.body as SessionActionBody).session.model,
        undefined,
        "`model: null` clears the override and returns the session to the install's default, which is not the same act as " +
          "setting it to the default's current value: the second pins a session to a model that stops existing when the " +
          "default moves",
      );
      assert.match((cleared.body as SessionActionBody).note, /override is cleared/);

      const missing = await raw(h, "/api/v1/sessions/ses_nobody_made", {
        method: "PATCH",
        body: { title: "x" },
        headers: { "if-match": '"1"' },
      });
      assert.equal(missing.status, 404);
      assert.match(
        (missing.body as ErrorEnvelope).error.message,
        /crabby session ls/,
        "a refusal names the verb that would have found the id",
      );
    } finally {
      await h.close();
    }
  });

  it("gives every task a conversation record, whether the task named one or not", async () => {
    const h = await boot({ noRunner: true });
    try {
      // No `sessionId` at all: `createTask` mints one, and before schema version 6 that id was a conversation nobody
      // owned — the gap C11 exists to close.
      const anonymous = (
        await h.cli.createTask({ objective: "an objective with no session" }, "idem-anon")
      ).body as TaskRecord;
      const named = newId("ses");
      const explicit = (
        await h.cli.createTask(
          { objective: "a question in a session of my own", sessionId: named },
          "idem-named",
        )
      ).body as TaskRecord;
      assert.equal(explicit.sessionId, named);

      const body = (await h.cli.sessions()).body as SessionListBody;
      assert.equal(
        body.count,
        2,
        "both conversations exist as records, and only as records — nothing else was created",
      );
      const ids = body.items.map((row) => row.id).sort();
      assert.deepEqual(ids, [anonymous.sessionId, named].sort());
      for (const row of body.items) {
        assert.equal(row.tasks, 1);
        assert.equal(
          row.origin,
          "cli",
          "the interface that created the first task in it, which is the attribution W15-11 wants",
        );
        assert.ok(
          row.title !== undefined,
          "and each was named from its first question rather than left un-named with a task in it",
        );
      }
      // The record is in the database and not only in the answer, which is what makes it survive a restart.
      assert.ok(getSession(h.db, named) !== undefined);
      assert.equal(getSession(h.db, named)?.title, "a question in a session of my own");

      // A title the user chose is not a placeholder: a second task in the same conversation does not rename it.
      await h.cli.createTask({ objective: "a later question", sessionId: named }, "idem-second");
      assert.equal(
        getSession(h.db, named)?.title,
        "a question in a session of my own",
        "the first question names a conversation and the ones after it do not overwrite the name",
      );
      assert.equal(
        getSession(h.db, named)?.revision,
        1,
        "and activity is not an edit, so the token a phone holds survives it",
      );
    } finally {
      await h.close();
    }
  });
});

describe("the session tools inside a run", () => {
  it("answers `session.list` and writes `session.rename`, and the change is on the record", async () => {
    const session = newId("ses");
    const h = await boot({
      rounds: [
        [{ kind: "tool-call", name: "session.list", arguments: {} }],
        [
          {
            kind: "tool-call",
            name: "session.rename",
            arguments: { id: session, title: "renamed by the agent" },
          },
        ],
        [{ kind: "text", text: "listed them and renamed one" }],
      ],
    });
    try {
      const created = (
        await h.cli.createTask(
          { objective: "tidy up my conversation titles", sessionId: session },
          "idem-tools",
        )
      ).body as TaskRecord;
      const record = await untilTerminal(h, created.id);
      assert.equal(
        record.state,
        "completed",
        "a run that called two tools and ended: the tools are declared, routed to their owner and executed",
      );
      const after = getSession(h.db, session);
      assert.equal(
        after?.title,
        "renamed by the agent",
        "`session.rename` really wrote, through the same store the routes read",
      );
      assert.equal(
        after?.revision,
        2,
        "once for the title the first task gave it and once for the rename",
      );

      // The list is answered from the same derivation the route uses, so the two cannot disagree about a state word.
      const body = (await h.cli.sessions()).body as SessionListBody;
      const row = body.items.find((item) => item.id === session);
      assert.equal(row?.titleShown, "renamed by the agent");
      assert.equal(row?.tasks, 1);
      assert.equal(row?.stateWord, "idle", "the task ended, so the conversation is idle again");
    } finally {
      await h.close();
    }
  });

  it("refuses a rename of a conversation that does not exist, with the store's own sentence", async () => {
    const missing = newId("ses");
    const h = await boot({
      rounds: [
        [
          {
            kind: "tool-call",
            name: "session.rename",
            arguments: { id: missing, title: "a conversation nobody has" },
          },
        ],
        [{ kind: "text", text: "that one was not there" }],
      ],
    });
    try {
      const created = (await h.cli.createTask({ objective: "rename something" }, "idem-missing"))
        .body as TaskRecord;
      const record = await untilTerminal(h, created.id);
      assert.equal(
        record.state,
        "completed",
        "a refused tool call is a step with an answer, not a failed run",
      );
      assert.equal(
        getSession(h.db, missing),
        undefined,
        "and nothing was written: a refusal is not a conversation with a title nobody asked for",
      );
    } finally {
      await h.close();
    }
  });
});

// Sockets opened by `fetch` outlive the tests that opened them, and an open handle keeps `node --test` alive after its
// last assertion has passed.
after(() => {
  const global = (globalThis as unknown as Record<symbol, { close?: () => Promise<void> }>)[
    Symbol.for("undici.globalDispatcher.1")
  ];
  if (global !== undefined && typeof global.close === "function") void global.close();
});
