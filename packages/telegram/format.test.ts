// Region G2 held as pure functions. Every test names its row, because the rows are the accepted spec and a test that
// cannot say which sentence it holds is a test that drifts with the code it was meant to pin.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  alignTable,
  escapeTelegram,
  idLine,
  splitMessage,
  stampTime,
  toTelegramHtml,
  truncationLabel,
} from "./format.ts";
import { MESSAGE_TEXT_MAX } from "./limit.ts";

describe("G2-02 — split at a line boundary, markers that count for real", () => {
  it("a fitting message is one part with no marker — a (1/1) would be noise", () => {
    assert.deepEqual(splitMessage("short"), [{ text: "short", marker: undefined }]);
  });

  it("a long message splits at line boundaries with (2/3)-style markers, each part within the limit", () => {
    const text = Array.from(
      { length: 400 },
      (_, i) => `line ${String(i)} — ${"x".repeat(20)}`,
    ).join("\n");
    const parts = splitMessage(text);
    assert.ok(parts.length > 1);
    assert.equal(
      parts.length,
      parts.filter((p) => p.marker !== undefined).length,
      "every part after a split carries a marker",
    );
    const width = String(parts.length).length;
    parts.forEach((part, i) => {
      assert.ok(
        part.text.length + width * 2 + 4 <= MESSAGE_TEXT_MAX,
        `part ${String(i)} overflows`,
      );
      assert.ok(!part.text.endsWith("\n"), `part ${String(i)} ends mid-line`);
    });
    assert.equal(parts[0]?.marker, `(1/${String(parts.length)})`);
    assert.equal(
      parts[parts.length - 1]?.marker,
      `(${String(parts.length)}/${String(parts.length)})`,
    );
    const rejoined = parts.map((p) => p.text).join("\n");
    for (const line of text.split("\n"))
      assert.ok(rejoined.includes(line), "no line is lost by the split");
  });

  it("never mid-code-block: a fence crossing the boundary is closed and reopened", () => {
    const inside = "c".repeat(4_100);
    const text = `\`\`\`bash\n${inside}\nline-two\n\`\`\`\nafter`;
    const parts = splitMessage(text);
    for (const part of parts) {
      const fences = (part.text.match(/```/g) ?? []).length;
      assert.equal(fences % 2, 0, `part has an unbalanced fence: ${part.text.slice(0, 60)}`);
    }
  });
});

describe("G2-03 — the truncation label says what was omitted", () => {
  it("names the cut and the omitted shape, never a bare ellipsis", () => {
    const label = truncationLabel("the deployment log from 02:14 to 02:40");
    assert.match(label, /^truncated/);
    assert.match(label, /omitted: the deployment log/);
  });

  it("a huge omission is itself bounded, with the count", () => {
    const label = truncationLabel("y".repeat(1_000));
    assert.ok(label.length < 400);
    assert.match(label, /\+\d+ more chars/);
  });
});

describe("G2-04/G2-05 — the conservative subset, escaped first", () => {
  it("escapes angle brackets — user text is data, never markup", () => {
    assert.equal(escapeTelegram("<b>not bold</b>"), "&lt;b&gt;not bold&lt;/b&gt;");
  });

  it("a fenced block becomes <pre>; a span becomes <code>; bold becomes <b>", () => {
    assert.match(toTelegramHtml("```\ncode\n```") ?? "", /<pre>code<\/pre>/);
    assert.match(toTelegramHtml("run `crabby status` now") ?? "", /<code>crabby status<\/code>/);
    assert.match(toTelegramHtml("**bold** move") ?? "", /<b>bold<\/b>/);
  });

  it("mixed or unstyled text falls back to plain — the sender's parse_mode branch handles it (G2-04)", () => {
    assert.equal(toTelegramHtml("plain words"), undefined);
    assert.equal(
      toTelegramHtml("```\na\n```\n```\nb\n```"),
      undefined,
      "two fences: unstyled truth over broken markup",
    );
    const hostile = toTelegramHtml("<script>alert(1)</script>");
    assert.equal(hostile, undefined, "an escaped-only message has nothing to style, so plain wins");
  });

  it("markup injection inside a styled message stays escaped", () => {
    const out = toTelegramHtml("say `**gotcha** <img src=x>` please") ?? "";
    assert.doesNotMatch(out, /<img/);
    assert.match(out, /&lt;img src=x&gt;/);
  });
});

describe("G2-06 — a table is aligned text", () => {
  it("columns pad to the widest cell, never a grid that wraps", () => {
    const table = alignTable([
      ["tool", "tier"],
      ["shell.run", "T3"],
      ["net.fetch", "T2"],
    ]);
    const lines = table.split("\n");
    assert.equal(lines[0], "tool       tier");
    assert.equal(lines[1], "shell.run  T3");
  });
});

describe("G2-09 — a quoted time carries the Gateway's timezone", () => {
  it("renders in the zone and labels it", () => {
    const stamp = stampTime("2026-10-16T15:44:00Z", "Asia/Dhaka");
    assert.match(stamp, /\(Asia\/Dhaka\)$/);
    assert.match(stamp, /21:44/);
  });

  it("an unresolvable zone degrades to UTC with the label, not a crash", () => {
    const stamp = stampTime("2026-10-16T15:44:00Z", "Not/AZone");
    assert.match(stamp, /15:44/);
    assert.match(stamp, /Gateway time/);
  });
});

describe("G2-10 — ids are their own lines", () => {
  it("the id is copyable in one tap, not welded into a sentence", () => {
    assert.equal(idLine("task", "tsk_abc"), "task\ntsk_abc");
  });
});
