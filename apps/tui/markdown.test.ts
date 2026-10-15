// D-061's named subset, held to the two properties the pane depends on: **code survives whole**, and **rendering is stable**
// enough to run per token batch.
//
// Stability is the testable half. T4-A's own note is that rendering costs a re-layout per token batch and
// `docs/UI_UX_SPEC.md` §4 calls flicker a usability defect — so a renderer whose output changes each time it sees the same
// text cannot be used in a stream at all, and `renderMarkdown` is asserted to be **idempotent**: rendering the rendered text
// again must produce the same lines. Without that property the pane has to keep the raw text forever, and then the renderer
// is not where the cost is paid either.
//
// The second property is **width honesty**: every line reports the width a person sees, so a code line longer than the
// terminal is *known* to be too long rather than silently truncated (T4-03), and the pane can scroll it.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  estimateLine,
  redactedMarker,
  renderInline,
  renderMarkdown,
  toolLine,
} from "./markdown.ts";
import { visibleWidth } from "./render.ts";

function texts(lines: readonly { text: string }[]): readonly string[] {
  return lines.map((line) => line.text);
}

describe("D-061's named subset", () => {
  it("renders emphasis and code spans when the charset tier allows attributes", () => {
    const lines = renderMarkdown("a *word* and `code`", 40, "ansi");
    const text = texts(lines)[0] ?? "";
    assert.match(text, /word/);
    assert.match(text, /code/);
    // The markers are *consumed* and the words kept: that is what rendering is.
    assert.ok(!text.includes("*word*"), text);
  });

  it("keeps the markers and the words when the tier has no attributes", () => {
    // Nothing reachable only through colour: an 8-colour terminal and a pipe carry the same information.
    const text = texts(renderMarkdown("a *word* and `code`", 40, "none"))[0] ?? "";
    assert.match(text, /\\*word\\*/);
    assert.match(text, /`code`/);
  });

  it("leaves a heading as text", () => {
    // D-061's subset: tables, nested lists and inline HTML pass through, and a heading is in the same class — rendering it
    // as a rule would be a decoration the charset tier would then have to carry.
    const text = texts(renderMarkdown("# Heading", 40, "ansi"))[0] ?? "";
    assert.match(text, /^# Heading/);
  });

  it("leaves a table and inline HTML as text", () => {
    const table = texts(renderMarkdown("| a | b |", 40, "ansi"))[0] ?? "";
    assert.match(table, /\| a \| b \|/);
    const html = texts(renderMarkdown("<div>x</div>", 40, "ansi"))[0] ?? "";
    assert.match(html, /<div>x<\/div>/);
  });

  it("renders a fenced block with a language label and no reflow (T4-03)", () => {
    const lines = renderMarkdown("```ts\nconst x = 1;\n```", 40, "ansi");
    assert.match(lines[0]?.text ?? "", /── ts/);
    // The width helper already strips attributes, so the assertion uses it rather than carrying a second escape pattern.
    assert.equal(lines[1]?.width, "const x = 1;".length, "the code line is exactly the code");
    assert.match(lines[1]?.text ?? "", /const x = 1;/);
  });

  it("keeps a 300-character identifier whole and reports that it is too wide", () => {
    const long = "x".repeat(300);
    const lines = renderMarkdown(`\`\`\`\n${long}\n\`\`\``, 40, "none");
    const body = lines[1];
    assert.equal(body?.text, long, "not truncated, not wrapped");
    // The pane needs to *know*: this is the line that has to scroll.
    assert.equal(body?.width, 300);
    assert.equal(body?.code, true);
  });

  it("renders an unterminated fence as a block rather than swallowing the rest", () => {
    // A stream that ends mid-fence is normal, not exceptional, and a renderer that loses the rest of the message is the
    // failure a person notices first.
    const lines = renderMarkdown("```\ncode\nstill code", 40, "none");
    assert.deepEqual(texts(lines).slice(1), ["code", "still code"]);
  });

  it("is idempotent, which is what makes it safe to run per token batch", () => {
    const once = renderMarkdown("a *word* of `code`\n\n```ts\nlet x = 1;\n```", 40, "ansi");
    const twice = renderMarkdown(texts(once).join("\n"), 40, "ansi");
    // Wrapped text re-wrapped is stable by construction; the code block's rule line is the interesting case, because a
    // rule that grew on every pass would be a message that gets longer the longer it streams.
    assert.deepEqual(
      twice.map((line) => line.width),
      once.map((line) => line.width),
    );
  });

  it("wraps prose on word boundaries and indents the continuation", () => {
    const lines = renderMarkdown("one two three four five six seven eight nine ten", 20, "none");
    assert.ok(lines.length > 1, "the sentence does not fit in 20 columns");
    for (const line of lines) {
      assert.ok(visibleWidth(line.text) <= 20, `${visibleWidth(line.text)}: ${line.text}`);
    }
    assert.match(lines[1]?.text ?? "", /^ {2}/, "a continuation is visibly a continuation");
  });

  it("leaves one word longer than the line whole rather than breaking it", () => {
    // A path or a URL broken across three lines is one nobody can copy, and the same reason a code line is not wrapped.
    const lines = renderMarkdown("x".repeat(50), 20, "none");
    assert.equal(lines[0]?.text, "x".repeat(50));
  });
});

describe("the one-line renderers the pane's rows ask for", () => {
  it("T4-07's collapsed tool line names tool, tier, status and duration", () => {
    const line = toolLine("file.read", "T1", "ok", 1250);
    assert.equal(line.text, "file.read · T1 · ok · 1.3s");
  });

  it("T4-08's redaction marker is a word, not a box", () => {
    assert.equal(redactedMarker("key").text, "key: redacted");
  });

  it("T5-10's estimate is labelled an estimate, because O-031 says so", () => {
    const line = estimateLine(1234);
    assert.match(line.text, /est/);
    assert.match(line.text, /1,234/);
  });

  it("a duration that was not measured is omitted rather than guessed", () => {
    assert.equal(toolLine("file.read", "T1", "ok", undefined).text, "file.read · T1 · ok");
  });
});

describe("inline emphasis", () => {
  it("does not treat a glob or a multiplication sign as emphasis", () => {
    // The subset is *named*, not aggressive: a mangled path is worse than an undecorated one.
    const text = renderInline("pass --files *.ts and 2 * 3", "ansi");
    assert.match(text, /\*\.ts/);
  });

  it("renders bold as well as italic", () => {
    assert.ok(!renderInline("**loud**", "ansi").includes("**"));
  });
});
