// The web client's pure halves, held the way the TUI's panes are held: the renderer is a function of data to a string,
// so the tests need no browser — and the one property they must all agree on is that **data never reaches the DOM
// unescaped** (safe.js's header argues why that is this surface's redaction rule).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cronWords, elapsed, relativeTime } from "./js/format.js";
import { hashFor, parseHash } from "./js/router.js";
import { esc, html, unsafe } from "./js/safe.js";
import { approvalQueue } from "./js/ui/approvals.js";
import { composer, errorPanel, messageRows, slashMatches, toolRow } from "./js/ui/chat.js";
import {
  configEntries,
  diffLines,
  isSecurityKey,
  SECURITY_FAMILIES,
  settingsForm,
  stringifyValue,
} from "./js/ui/config.js";
import { budgetLine, contextView } from "./js/ui/context.js";
import { diagnosticsProblemShapes, GAPS, gapBlock } from "./js/ui/gaps.js";
import { clientList, jobList, modelList, sessionList, toolList } from "./js/ui/lists.js";
import { nav, statusBar } from "./js/ui/shell.js";

describe("safe.js — interpolation is escaping, by construction", () => {
  it("escapes the five characters that matter, in text and attribute positions", () => {
    assert.equal(
      esc('<img src=x onerror="alert(1)">'),
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
    );
    assert.equal(esc("a&b'c"), "a&amp;b&#39;c");
  });

  it("the html template escapes every interpolation, arrays included", () => {
    const evil = "<script>alert(1)</script>";
    const out = html`<p>${evil}</p><p>${[evil, evil]}</p>`.valueOf();
    assert.doesNotMatch(out, /<script>/);
    assert.match(out, /&lt;script&gt;/);
  });

  it("unsafe is the one, greppable hatch — and it passes markup through", () => {
    const out = html`<div>${unsafe("<b>ok</b>")}</div>`.valueOf();
    assert.match(out, /<b>ok<\/b>/);
  });

  it("nested templates compose without re-escaping each other's output", () => {
    const inner = html`<b>bold ${"<i>x</i>"}</b>`;
    const out = html`<div>${inner}</div>`.valueOf();
    assert.match(out, /<b>bold &lt;i&gt;x&lt;\/i&gt;<\/b>/);
  });
});

describe("the hash router", () => {
  it("parses screen, segments and query", () => {
    assert.deepEqual(parseHash("#/tasks/tsk_1?x=1"), {
      screen: "tasks",
      rest: ["tsk_1"],
      query: { x: "1" },
    });
    assert.deepEqual(parseHash("#/settings/access"), {
      screen: "settings",
      rest: ["access"],
      query: {},
    });
    assert.equal(parseHash("").screen, "chat");
    assert.equal(
      parseHash("#/nope").screen,
      "chat",
      "unknown screens fall to chat (W-O8's caller-side note)",
    );
  });

  it("hashes the shell once rendered at the top level normalize into their settings subtab, not a 404", () => {
    for (const alias of ["access", "models", "tools", "logs", "memory", "extensions"]) {
      const parsed = parseHash(`#/${alias}`);
      assert.equal(parsed.screen, "settings");
      assert.deepEqual(parsed.rest, [alias]);
    }
  });

  it("round-trips through hashFor with ids encoded", () => {
    assert.equal(hashFor("tasks", ["tsk/a"], { b: "c d" }), "#/tasks/tsk%2Fa?b=c%20d");
    assert.equal(parseHash(hashFor("tasks", ["tsk/a"])).rest[0], "tsk/a");
  });
});

describe("format.js — words the screens draw", () => {
  it("relative time from an injected now", () => {
    const now = Date.parse("2026-10-16T12:00:00Z");
    assert.equal(relativeTime("2026-10-16T11:59:50Z", now), "just now");
    assert.equal(relativeTime("2026-10-16T11:30:00Z", now), "30m ago");
    assert.equal(relativeTime("2026-10-15T12:00:00Z", now), "1d ago");
  });

  it("elapsed seconds read like a phone reads them", () => {
    assert.equal(elapsed(42), "42s");
    assert.equal(elapsed(125), "2m 5s");
    assert.equal(elapsed(5040), "1h 24m");
  });

  it("W16-01: the schedule is written both ways — and an unreadable cron is shown raw, not paraphrased", () => {
    assert.equal(
      cronWords("30 7 * * 1-5"),
      "Monday, Tuesday, Wednesday, Thursday, Friday at 07:30",
    );
    assert.equal(cronWords("0 9 * * 0"), "Sunday at 09:00");
    assert.equal(cronWords("*/5 * * * *"), "every day every 5 minutes");
    assert.equal(
      cronWords("30 7"),
      undefined,
      "an unreadable schedule is shown raw, never paraphrased",
    );
  });
});

describe("W-A's cards", () => {
  const approval = {
    id: "apr_1",
    summary: "You are asked to let the run write a file",
    target: "echo hello > /workspace/out.txt",
    tier: "T2",
    tool: "fs.write",
    taskId: "tsk_1",
    expiresAt: new Date(Date.now() + 90_000).toISOString(),
  };

  it("the exact target is on the card, whole and selectable — never a paraphrase (A3)", () => {
    const card = approvalQueue([approval], false).valueOf();
    assert.match(card, /exact target/);
    assert.match(card, /echo hello &gt; \/workspace\/out\.txt/);
  });

  it("the expiry counts down with its reason, and the deny reason field exists (A5/A7)", () => {
    const card = approvalQueue([approval], false).valueOf();
    assert.match(card, /expires in 1m 30s/);
    assert.match(card, /deny-reason/);
    assert.match(card, /approve once/);
  });

  it("A10's conflict banner renders when the answer lost the race", () => {
    assert.match(approvalQueue([], true).valueOf(), /answered elsewhere/);
  });
});

describe("W3/W4's chat halves", () => {
  it("message bodies are data — a script tag in a message is text on the screen", () => {
    const out = messageRows([
      { id: "m1", role: "assistant", content: "<script>x</script>", when: "now" },
    ]).valueOf();
    assert.doesNotMatch(out, /<script>x/);
    assert.match(out, /&lt;script&gt;x&lt;\/script&gt;/);
  });

  it("the tool row keeps the tier with the name (W3-04) and the detail is escaped", () => {
    const out = toolRow({
      name: "fs.write",
      tier: "T2",
      status: "running",
      detail: '["<i>"]',
    }).valueOf();
    assert.match(out, /tier-T2/);
    assert.match(out, /&quot;&lt;i&gt;&quot;/);
  });

  it("the composer's estimate is labeled as an estimate (W4-09) and the capability line names its source", () => {
    const out = composer({ draftChars: 200, queued: 0, running: false, taskMode: false }).valueOf();
    assert.match(out, /estimate, not a count/);
    assert.match(out, /fs: workspace · net: off · shell: off/);
  });

  it("the slash menu filters as typed (W4-03)", () => {
    assert.deepEqual(
      slashMatches("/m").map((m: { command: string }) => m.command),
      ["/model"],
    );
    assert.deepEqual(
      slashMatches("/c").map((m: { command: string }) => m.command),
      ["/compact", "/cancel"],
    );
    assert.deepEqual(slashMatches("hello"), []);
  });

  it("the error panel carries the request id and the resumable word (W3-11), never a bare toast", () => {
    const out = errorPanel({
      code: "http_409",
      message: "answered elsewhere",
      resumable: true,
      requestId: "req_1",
    }).valueOf();
    assert.match(out, /http_409/);
    assert.match(out, /req(uest)?_?1|request req_1/);
    assert.match(out, /resumable/);
  });
});

describe("W12's settings half", () => {
  const schema = {
    type: "object",
    properties: {
      shell: { type: "object", properties: { enabled: { type: "boolean" } } },
      limits: { type: "object", properties: { maxOutput: { type: "integer" } } },
      name: { type: "string" },
    },
  };

  it("the walker is driven by the server's schema, values joined from the document", () => {
    const entries = configEntries(schema, {
      shell: { enabled: false },
      limits: { maxOutput: 100 },
      name: "crab",
    });
    assert.deepEqual(
      entries.map((e: { key: string }) => e.key),
      ["shell.enabled", "limits.maxOutput", "name"],
    );
  });

  it("the T3 families mark before edit (W12-03), mirrored from @crabby/core and pinned here", () => {
    assert.deepEqual(SECURITY_FAMILIES, ["shell", "net", "workspace", "provider"]);
    assert.equal(isSecurityKey("shell.enabled"), true);
    assert.equal(isSecurityKey("limits.maxOutput"), false);
    assert.match(settingsForm(configEntries(schema, {})).valueOf(), /tier-T3/);
  });

  it("W12-02's diff is exactly the two lines, JSON for structure", () => {
    assert.deepEqual(diffLines("limits.maxOutput", 100, { a: 1 }), [
      "- limits.maxOutput: 100",
      '+ limits.maxOutput: {"a":1}',
    ]);
    assert.equal(stringifyValue("bare"), "bare");
  });
});

describe("the lists", () => {
  it("W15-02: the current session is the word AND the mark; ids are selectable lines", () => {
    const out = sessionList(
      [
        {
          id: "s_1",
          titleShown: "main",
          origin: "cli",
          updatedAt: new Date().toISOString(),
          runningTasks: 1,
        },
      ],
      "s_1",
    ).valueOf();
    assert.match(out, /› current/);
    assert.match(out, /cli · just now · 1 running/);
    assert.match(out, /data-id="s_1"/, "the id is a selectable line");
  });

  it("W16-01: the job row shows the schedule both ways; W16-02's state is a word-chip", () => {
    const out = jobList([
      { id: "j_1", objective: "morning brief", schedule: "30 7 * * 1-5", stateWord: "active" },
    ]).valueOf();
    assert.match(out, /30 7 \* \* 1-5/);
    assert.match(out, /Monday/);
    assert.match(out, /state-active/);
  });

  it("W13: a remote tab gets the loopback explanation, not buttons that 403", () => {
    const remote = clientList(
      [
        {
          id: "cli_1",
          name: "pixel",
          interface: "cli",
          capabilities: ["a"],
          liveStreams: 0,
          createdAt: new Date().toISOString(),
        },
      ],
      false,
    ).valueOf();
    assert.match(remote, /loopback|local actions|D-053|crabby auth/);
    assert.doesNotMatch(remote, /client-revoke/);
    const local = clientList(
      [
        {
          id: "cli_1",
          name: "pixel",
          interface: "cli",
          capabilities: ["a"],
          liveStreams: 0,
          createdAt: new Date().toISOString(),
        },
      ],
      true,
    ).valueOf();
    assert.match(local, /client-revoke/);
  });

  it("W11: tools carry tier + escalation rules; W10: models say what they are without claiming a comparison", () => {
    const tools = toolList([
      {
        id: "shell.run",
        tier: "T3",
        capabilities: ["shell.run"],
        availability: { available: true },
        tierRules: ["every call asks"],
      },
    ]).valueOf();
    assert.match(tools, /tier-T3/);
    assert.match(tools, /every call asks/);
    const models = modelList([
      { label: "local/q", contextWindow: 1000, maxOutput: 500, capabilities: ["tools"] },
    ]).valueOf();
    assert.match(models, /local\/q/);
    assert.match(models, /no comparison it cannot prove/);
  });
});

describe("the shell and the context drawer", () => {
  it("W1-A (D-067): four chips inline; a locked vault and offline escape into the bar", () => {
    const out = statusBar({
      connection: "live",
      approvals: 2,
      vaultUnlocked: false,
      model: "openrouter/qwen",
      sessionTitle: "main",
      version: "0.1",
    }).valueOf();
    assert.match(out, /openrouter\/qwen|…\/qwen/);
    assert.match(out, /2 waiting/);
    assert.match(out, /vault locked/);
    assert.match(out, /chip-escape/);
  });

  it("W2: five tabs, + first, badge on tasks", () => {
    const out = nav("chat", { approvals: 3 }).valueOf();
    assert.match(out, /nav-new/);
    assert.match(out, /nav-badge/);
    assert.match(out, /Extensions/);
  });

  it("W7-01: the budget line flags the estimate; W7-08: the overflow warning carries the arithmetic", () => {
    const line = budgetLine({
      projected: { tokens: 900, source: "estimated" },
      budget: {
        window: 1000,
        reserveForOutput: 100,
        tokens: 900,
        compactAtTokens: 800,
        compactAt: 0.8,
      },
    });
    assert.match(line, /~900 tokens of 1,000/);
    assert.match(line, /reserve for output 100/);
    const body = {
      projected: { tokens: 900, source: "estimated" },
      budget: {
        window: 1000,
        reserveForOutput: 100,
        tokens: 900,
        compactAtTokens: 800,
        compactAt: 0.8,
      },
      sections: [],
      compacted: [],
    };
    assert.match(contextView(body).valueOf(), /estimated by the documented heuristic/);
  });
});

describe("the named gaps and the diagnostics scan", () => {
  it("every gap names what is missing AND where the capability lives today", () => {
    for (const [id, gap] of Object.entries(GAPS)) {
      assert.ok(id.length > 0);
      assert.match(
        gap.missing,
        /route|surface|wizard|allow-list|act/i,
        `${id} says what is missing`,
      );
      assert.match(gap.today, /crabby|the bot|the config|later/i, `${id} says what to do today`);
    }
    assert.match(gapBlock("logs").valueOf(), /GET/);
  });

  it("W14-05's scan finds the shapes before the clipboard does", () => {
    const problems = diagnosticsProblemShapes(
      "key sk-abcdef0123456789abcdef and token crt_abcdefghijklmnop",
    );
    assert.equal(problems.length, 2);
    assert.deepEqual(diagnosticsProblemShapes("clean report"), []);
  });
});
