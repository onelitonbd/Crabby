// `http.request`'s tests, against scripted `Response` objects — the same wager `net.test.ts` makes and for the same
// reason: what this file has to prove is what the executor *decides* (which verbs it serves, which credential headers
// it refuses, where a redirect may go, how many bytes come back, what it says when the request never completed), and a
// scripted transport proves those without making a red line depend on a resolver or a stranger's server.
//
// What is asserted beyond `net.fetch`'s own set is the split §4.2 drew between the two rows: this row is **T2 with no
// T1**, `idempotent: false` so D-065's verdict for it is `re-ask`, and a method that does not mutate is refused with a
// pointer at the row that serves it rather than silently upgraded — because the two rows carry different tiers and
// different resume permissions and one tool cannot hold both.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { LOOP_LIMITS, type ToolOutcome, toolDeadlineMs } from "@crabby/agent-runtime";
import { MAX_TOOL_OUTPUT_BYTES, type ToolDeclaration } from "@crabby/api-contracts";
import { LIMITS_DEFAULTS } from "@crabby/core";
import { resolveTool } from "@crabby/policy";
import {
  createHttpTools,
  EXTERNAL_CONTENT_TAG,
  HTTP_REQUEST_TOOL,
  HTTP_TOOL_CODES,
  httpToolDeclarations,
  MUTATING_METHODS,
} from "./index.ts";

const TASK = "tsk_http1";
const FIXED_NOW = Date.UTC(2026, 9, 13, 8, 0, 0);
const URL = "https://example.test/orders";

/** One answer the scripted transport gives, in the order the executor asks for it. */
interface Hop {
  readonly status: number;
  readonly body?: string | null;
  readonly location?: string;
  readonly headers?: Record<string, string>;
}

interface Recorded {
  readonly url: string;
  readonly init: RequestInit;
}

interface HttpLab {
  readonly scratch: string;
  readonly calls: Recorded[];
  run(args: Record<string, unknown>, signal?: AbortSignal, tool?: string): Promise<ToolOutcome>;
  overflowFiles(): string[];
}

const labs: { base: string }[] = [];
after(() => {
  for (const lab of labs.splice(0)) rmSync(lab.base, { recursive: true, force: true });
});

function lab(
  options: {
    readonly hops?: readonly Hop[];
    readonly throws?: Error;
    /** Reject the way an aborted fetch rejects, when the run's own signal fires — D-074's mid-request clock. */
    readonly hangUntilAbort?: boolean;
    readonly maxOutputBytes?: number;
    readonly maxRedirects?: number;
    readonly netFetchTimeoutMs?: number;
  } = {},
): HttpLab {
  const base = mkdtempSync(path.join(tmpdir(), "crabby-http-"));
  const scratch = path.join(base, "state", "scratch", TASK);
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  labs.push({ base });

  const calls: Recorded[] = [];
  let index = 0;
  const doFetch: typeof globalThis.fetch = async (input, init) => {
    const recorded: Recorded = { url: String(input), init: init ?? {} };
    calls.push(recorded);
    if (options.hangUntilAbort === true) {
      await new Promise<never>((_resolve, reject) => {
        const signal = recorded.init.signal;
        if (signal === null || signal === undefined) return;
        if (signal.aborted) reject(new Error("aborted"));
        else signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    if (options.throws !== undefined) throw options.throws;
    const hop: Hop = options.hops?.[index] ?? { status: 200, body: "" };
    index += 1;
    const headers = new Headers(hop.headers ?? {});
    if (hop.location !== undefined) headers.set("location", hop.location);
    return new Response(hop.body ?? null, { status: hop.status, headers });
  };

  const tools = createHttpTools({
    scratchDirFor: (taskId) => {
      const dir = path.join(base, "state", "scratch", taskId);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      return dir;
    },
    fetch: doFetch,
    limits: {
      ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
      ...(options.netFetchTimeoutMs === undefined
        ? {}
        : { netFetchTimeoutMs: options.netFetchTimeoutMs }),
    },
    ...(options.maxRedirects === undefined ? {} : { maxRedirects: options.maxRedirects }),
    now: () => FIXED_NOW,
    // Predictable, for the reason `net.test.ts` gives: the frame's nonce is what makes a forged closer impossible, and
    // a test that could not predict it could not assert the frame's shape.
    nonce: () => "httpnonce0001",
  });

  return {
    scratch,
    calls,
    run: (args, signal, tool) =>
      Promise.resolve(
        tools.run(
          { tool: tool ?? HTTP_REQUEST_TOOL, args },
          { taskId: TASK, signal: signal ?? new AbortController().signal, deadlineMs: undefined },
        ),
      ),
    overflowFiles: () => readdirSync(scratch),
  };
}

/** The minimum a mutating call needs: a method this row serves and a URL policy can price. */
const POST = { method: "POST", url: URL };

describe("http.request — §4.1's record for the mutating row", () => {
  it("declares the five fields, at §4.2's base tier, with the network class's one clock", () => {
    const declarations = httpToolDeclarations();
    assert.equal(
      declarations.length,
      1,
      "one row, because §4.2 has one `http.request (non-GET)` row",
    );
    const declaration = declarations[0] as ToolDeclaration;
    assert.equal(declaration.name, HTTP_REQUEST_TOOL);
    assert.equal(
      declaration.limits.timeoutMs,
      LIMITS_DEFAULTS.netFetchTimeoutMs,
      "§5.2 prices this row under the network class's row: 20 s total, from the same `limits.netFetchTimeoutMs` " +
        "key `net.fetch` reads — a second number for a second network row would be a second opinion about how long " +
        "a phone waits on a stranger",
    );
    assert.equal(
      declaration.limits.timeoutMs,
      toolDeadlineMs(HTTP_REQUEST_TOOL, LOOP_LIMITS),
      "one number by construction rather than by coincidence: an executor that announced 20 s while the loop armed " +
        "none would be describing a clock that does not exist — the drift `net.test.ts` pins for its own row",
    );
    assert.equal(declaration.limits.maxOutputBytes, MAX_TOOL_OUTPUT_BYTES, "D-064's inline cap");
    assert.equal(
      declaration.idempotent,
      false,
      "the whole reason this row exists: §7.3's question is whether re-running reaches the same end state, and a " +
        "POST repeated by a recovery is a second order to a server that already received the first — D-065's " +
        "verdict for this step is `re-ask`",
    );
    assert.equal(
      declaration.sideEffects,
      "external",
      "§6.2's cancellation evidence: a request sent and never answered may still have been applied by a server " +
        "this install cannot inspect",
    );
    const schema = declaration.inputSchema as {
      properties: Record<string, unknown>;
      additionalProperties: boolean;
    };
    assert.deepEqual(
      Object.keys(schema.properties).sort(),
      ["body", "headers", "method", "url"],
      "the four arguments §6.3's prompt quotes — method, URL, headers, body — and nothing else",
    );
    assert.equal(
      schema.additionalProperties,
      false,
      "§4.3's 'arguments it did not declare → reject before policy' is read from this flag",
    );
    const spec = resolveTool(HTTP_REQUEST_TOOL);
    assert.equal(
      spec?.tier,
      "T2",
      "and the registry still prices the row at §4.2's base tier: an executor arriving does not reprice it",
    );
    assert.equal(
      spec?.qualifier,
      "non-GET",
      "the qualifier is kept, because it is why the row exists — §4.2 splits one tool across two rows when the " +
        "arguments change its risk",
    );
    assert.deepEqual(
      [...(spec?.capabilities ?? [])],
      ["net.egress"],
      "the same grant `net.fetch` holds",
    );
  });

  it("reads the class override `net.fetch` reads, so one config key moves both rows", () => {
    const declarations = httpToolDeclarations({ netFetchTimeoutMs: 5_000 });
    assert.equal(
      declarations[0]?.limits.timeoutMs,
      5_000,
      "D-074's numbers are `limits.*` keys, and the network class has one — an override moves the declaration and " +
        "the clock the loop enforces together",
    );
  });

  it("answers no `facts`, and declares no tool but its own", () => {
    const base = lab();
    const tools = createHttpTools({
      scratchDirFor: () => base.scratch,
      fetch: async () => new Response(""),
    });
    assert.equal(
      (tools as unknown as { facts?: unknown }).facts,
      undefined,
      "§4.3's price for this row reads `args.method` and `args.url`, both caller-supplied, so there is no fact only " +
        "a runtime could observe before the arbiter is asked (D-099) — unlike `file.edit`'s `preExistingUserFile`",
    );
    assert.equal(tools.declares(HTTP_REQUEST_TOOL)?.name, HTTP_REQUEST_TOOL);
    assert.equal(
      tools.declares("net.fetch"),
      undefined,
      "one executor, one row: the fetch row keeps its own",
    );
    assert.equal(tools.specs().length, 1);
    assert.deepEqual(Object.keys(tools.specs()[0] ?? {}), ["name", "description", "parameters"]);
  });
});

describe("http.request — the method split §4.2 drew", () => {
  it("refuses a read verb and points at the row that serves it, sending nothing", async () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      const instance = lab();
      const outcome = await instance.run({ ...POST, method });
      assert.equal(
        outcome.ok,
        false,
        `${method} changes no remote state, so this row does not serve it`,
      );
      assert.equal(outcome.code, HTTP_TOOL_CODES.methodRefused);
      assert.match(
        outcome.output,
        /`net\.fetch`/,
        "the refusal names the row that does serve it — a model that reached here wanted a read, and the answer " +
          "that says where reads are priced is more useful than a silent upgrade to T2",
      );
      assert.match(
        outcome.output,
        /\*\*T1\*\*/,
        "and it says what the other row has that this one does not",
      );
      assert.equal(instance.calls.length, 0, "§4.4: the refusal is before the act, not after it");
    }
  });

  it("refuses a lowercase spelling of a verb it serves, because the approval quoted the other one", async () => {
    const instance = lab();
    const outcome = await instance.run({ ...POST, method: "post" });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, HTTP_TOOL_CODES.methodRefused);
    assert.match(outcome.output, /wrong case/);
    assert.equal(
      instance.calls.length,
      0,
      "§6.3's approval quotes `args` as the user read them; a verb the executor rewrites is a verb the prompt did " +
        "not name, so the difference is refused rather than normalised",
    );
  });

  it("refuses an unrecognised verb rather than forwarding it", async () => {
    const instance = lab();
    const outcome = await instance.run({ ...POST, method: "MOVE" });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, HTTP_TOOL_CODES.methodRefused);
    assert.match(outcome.output, /not a verb this executor serves/);
    assert.equal(instance.calls.length, 0);
  });

  it("serves POST with the body it was given, no credentials, and the loop's own signal", async () => {
    const instance = lab({ hops: [{ status: 201, body: `{"id":1}` }] });
    const controller = new AbortController();
    const outcome = await instance.run(
      {
        ...POST,
        headers: { "content-type": "application/json" },
        body: `{"sku":"krab"}`,
      },
      controller.signal,
    );
    assert.equal(outcome.ok, true);
    const call = instance.calls[0];
    assert.equal(call?.url, URL);
    assert.equal(
      call?.init.method,
      "POST",
      "the method the approval priced is the method sent, verbatim",
    );
    assert.equal(
      call?.init.redirect,
      "manual",
      "`follow` would land on a host nobody priced (§4.3)",
    );
    assert.equal(
      call?.init.credentials,
      "omit",
      "F-56: no vault means no cookie jar, and a cookie is a credential this build has no business carrying",
    );
    assert.equal(
      call?.init.signal,
      controller.signal,
      "the loop hands the run its own abort, and D-074's clock " +
        "is that signal rather than a timer the executor arms itself",
    );
    assert.equal(
      call?.init.body,
      `{"sku":"krab"}`,
      "the body is sent as written, never re-encoded",
    );
    const headers = call?.init.headers as Record<string, string>;
    assert.equal(
      (headers["user-agent"] ?? "").includes("http.request"),
      true,
      "a mutating request with no user agent is indistinguishable from a scanner, and the far end should be able " +
        "to tell which Crabby row sent it",
    );
    assert.equal(
      headers["content-type"],
      "application/json",
      "lowercased, because header names are",
    );
    assert.match(outcome.output, /status 201/);
    assert.match(
      outcome.output,
      /not idempotent/,
      "the answer restates §7.3's verdict for this row",
    );
  });
});

describe("http.request — credentials and destinations, refused before the act", () => {
  it("refuses a credential header with the rule named, and sends nothing", async () => {
    for (const header of ["Authorization", "Cookie", "x-api-key"]) {
      const instance = lab();
      const outcome = await instance.run({
        ...POST,
        headers: { [header]: "Bearer sekrit" },
      });
      assert.equal(outcome.ok, false, `${header} may not leave this process (§3 rule 06, F-56)`);
      assert.equal(outcome.code, HTTP_TOOL_CODES.invalidArguments);
      assert.match(outcome.output, /rule 06/, "the refusal cites the rule, not a schema shape");
      assert.match(
        outcome.output,
        /vault/,
        "and says where a real credential would live if one existed",
      );
      assert.equal(instance.calls.length, 0, "refused before the request, not stripped from it");
    }
  });

  it("refuses a scheme that is not http(s), because a path spelled as a URL is not egress", async () => {
    for (const url of ["file:///etc/passwd", "data:text/plain,x", "gopher://legacy/1"]) {
      const instance = lab();
      const outcome = await instance.run({ ...POST, url });
      assert.equal(outcome.ok, false, `${url} is not a destination §4.3 could have priced`);
      assert.equal(outcome.code, HTTP_TOOL_CODES.schemeRefused);
      assert.match(
        outcome.output,
        /§8/,
        "the file: case is a containment rule wearing a URL's clothes",
      );
      assert.equal(instance.calls.length, 0);
    }
  });

  it("refuses a URL it cannot parse, naming that no host exists to price", async () => {
    const instance = lab();
    const outcome = await instance.run({ ...POST, url: "not a url" });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, HTTP_TOOL_CODES.badUrl);
    assert.match(outcome.output, /no host for policy to have priced/);
    assert.equal(instance.calls.length, 0);
  });

  it("refuses arguments its own schema rejects, before policy sees them", async () => {
    const instance = lab();
    const outcome = await instance.run({ ...POST, dryRun: true });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, HTTP_TOOL_CODES.invalidArguments);
    assert.match(outcome.output, /schema rejects/);
    assert.equal(
      instance.calls.length,
      0,
      "§4.3's last bullet is about this call, not about whoever forgot to check",
    );
  });
});

describe("http.request — redirects, judged the way `net.fetch` judges them", () => {
  it("follows a same-host redirect, and says the follow-up was a GET without the body", async () => {
    const instance = lab({
      hops: [
        { status: 303, location: "https://example.test/orders/1" },
        { status: 201, body: `{"id":1}` },
      ],
    });
    const outcome = await instance.run({ ...POST, body: `{"sku":"krab"}` });
    assert.equal(outcome.ok, true);
    assert.equal(instance.calls.length, 2, "one hop inside D-106's bound of five");
    assert.equal(
      instance.calls[1]?.init.method,
      "GET",
      "HTTP says a 303 turns the follow-up into a GET — the executor follows the protocol rather than re-sending " +
        "an order the redirect asked it not to send",
    );
    assert.equal(
      instance.calls[1]?.init.body,
      undefined,
      "and drops the body with it: after a 303 the original POST must not be re-delivered",
    );
    assert.match(outcome.output, /1 same-host redirect/);
    assert.match(
      outcome.output,
      /follow-up was GET, not POST/,
      "the report states what actually happened, so a model can tell that what arrived is not what it wrote",
    );
    assert.match(outcome.output, /status 201/);
  });

  it("refuses a redirect that changes the host, because the arbiter priced a different destination", async () => {
    const instance = lab({
      hops: [{ status: 302, location: "https://attacker.test/harvest" }],
    });
    const outcome = await instance.run(POST);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, HTTP_TOOL_CODES.redirectRefused);
    assert.match(
      outcome.output,
      /§6\.3's approval named/,
      "the reason is one decision spent on another host",
    );
    assert.equal(instance.calls.length, 1, "one request out; the refused hop never left");
  });

  it("stops following at the bound, and the bound is about how many requests one pricing buys", async () => {
    const instance = lab({
      hops: [
        { status: 302, location: "https://example.test/a" },
        { status: 302, location: "https://example.test/b" },
        { status: 302, location: "https://example.test/c" },
        { status: 302, location: "https://example.test/d" },
      ],
      maxRedirects: 2,
    });
    const outcome = await instance.run(POST);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, HTTP_TOOL_CODES.tooManyRedirects);
    assert.equal(
      instance.calls.length,
      3,
      "two hops are followed and the third is refused: §5.2 gives the chain one clock, and a chain with no bound " +
        "is a loop a server can keep alive",
    );
    assert.match(
      outcome.output,
      /already left this device/,
      "the refusal is honest about what already happened: the original and its follow-ups were sent, and only the " +
        "hop past the bound was refused — a message claiming nothing went out would be a claim this install " +
        "cannot make",
    );
  });
});

describe("http.request — the answer it frames", () => {
  it("reports a 403 as an answer, because a completed exchange is not a failed tool", async () => {
    const instance = lab({ hops: [{ status: 403, body: "denied" }] });
    const outcome = await instance.run(POST);
    assert.equal(
      outcome.ok,
      true,
      "`ok: false` is for a request that did not complete or one this executor refused; a server that answered " +
        "403 completed the exchange, and the loop must not report it as a tool failure",
    );
    assert.match(outcome.output, /status 403/);
    assert.match(outcome.output, /denied/);
  });

  it("frames the response as untrusted content with the final URL as its subject", async () => {
    const instance = lab({
      hops: [
        { status: 302, location: "https://example.test/orders/1" },
        { status: 200, body: "created" },
      ],
    });
    const outcome = await instance.run(POST);
    assert.match(outcome.output, /<external-content/, "§10: the body is data, never instructions");
    const closers =
      outcome.output.split(`</${EXTERNAL_CONTENT_TAG} nonce="httpnonce0001">`).length - 1;
    assert.equal(
      closers,
      1,
      "exactly one closer, so a body carrying the delimiter cannot forge a second frame",
    );
    assert.match(
      outcome.output,
      /https:\/\/example\.test\/orders\/1/,
      "the subject is where the bytes actually came from, not where the call was aimed (§4.3's destination)",
    );
    assert.match(
      outcome.output,
      /untrusted content \(§10\)/,
      "the runtime's own sentence sits outside the frame, because a note inside is content",
    );
  });

  it("stops the download at the cap instead of pulling a stranger's body onto the phone", async () => {
    const instance = lab({
      hops: [{ status: 200, body: "x".repeat(300_000) }],
      maxOutputBytes: 4096,
    });
    const outcome = await instance.run(POST);
    assert.equal(outcome.ok, true);
    assert.match(
      outcome.output,
      /4096 bytes/,
      "the note reports what was kept, not the 300 KiB offered",
    );
    assert.match(outcome.output, /download stopped at 4096 bytes/);
    assert.match(outcome.output, /\[truncated:/, "D-064's label");
    const files = instance.overflowFiles();
    assert.equal(
      files.length,
      1,
      "the rest went to a file in the session scratch with the path printed, because a phone's memory is not a " +
        "response body's to choose",
    );
  });
});

describe("http.request — a request that did not complete", () => {
  it("answers `aborted` for a signal that arrived before the request, and makes none", async () => {
    const instance = lab();
    const controller = new AbortController();
    controller.abort();
    const outcome = await instance.run(POST, controller.signal);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, HTTP_TOOL_CODES.aborted);
    assert.match(
      outcome.output,
      /no request left this device/,
      "§6.1's step 2: no more scheduled work",
    );
    assert.equal(instance.calls.length, 0);
  });

  it("answers `aborted` when the clock runs out mid-request, and never claims the order was not sent", async () => {
    const instance = lab({ hangUntilAbort: true });
    const controller = new AbortController();
    const pending = instance.run(POST, controller.signal);
    controller.abort();
    const outcome = await pending;
    assert.equal(outcome.ok, false, "D-074: a distinct code, never `failure`");
    assert.equal(outcome.code, HTTP_TOOL_CODES.aborted);
    assert.match(
      outcome.output,
      /was sent/,
      "the one sentence this row owes: a POST whose answer never arrived may still have been applied, and " +
        "reporting it as 'not sent' would be a claim this install cannot make",
    );
    assert.match(
      outcome.output,
      /unknown/,
      "…and it says the outcome is unknown rather than guessing either way",
    );
  });

  it("answers `network` for a transport failure, and says it is not a policy answer", async () => {
    const instance = lab({ throws: new Error("ECONNREFUSED 127.0.0.1:9") });
    const outcome = await instance.run(POST);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, HTTP_TOOL_CODES.network);
    assert.match(outcome.output, /ECONNREFUSED/);
    assert.match(
      outcome.output,
      /transport answer rather than a policy one/,
      "the arbiter allowed this POST; confusing a refused connection with a refused permission is how a model " +
        "learns to distrust approvals",
    );
    assert.match(
      outcome.output,
      /Nothing was retried/,
      "a retry is a second order inside a budget priced for one",
    );
  });

  it("refuses a tool name it does not declare, §4.1's unrunnable rather than tolerant", async () => {
    const instance = lab();
    const outcome = await instance.run(POST, undefined, "net.fetch");
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, HTTP_TOOL_CODES.notDeclared);
    assert.match(outcome.output, /§4\.1/);
    assert.equal(instance.calls.length, 0);
  });
});
