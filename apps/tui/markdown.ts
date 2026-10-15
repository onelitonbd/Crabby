// D-061's markdown subset, rendered for a terminal that has no colour budget and no font.
//
// The decision is "a **named subset**": emphasis, code spans and fenced blocks render; tables, nested lists and inline
// HTML pass through as text; `--plain` turns rendering off entirely. Two facts make the subset the right size:
//
//  - **Rendering costs a re-layout per token batch** (T4-A's own note), and `docs/UI_UX_SPEC.md` §4 makes flicker on a
//    slow terminal a usability defect rather than a cosmetic one. Every transformation here is **width-aware and
//    idempotent**, because a renderer that changes text each time it sees it cannot be run per token at all.
//  - **Code must survive.** A 300-character identifier in a fenced block must not be wrapped or truncated (T4-03), so a
//    fenced block is emitted as its own lines with no reflow at all, and the pane handles overflow by scrolling — the
//    frame's `fit` is a *frame* concern and a code block is a *content* concern.
//
// The colour choice is the charset tier (`docs/DESIGN_SYSTEM.md` §2.1): attributes where the tier allows them, and the
// **words** where it does not. Nothing here is reachable only through colour, so an 8-colour terminal and a truecolor one
// carry the same information.
import { clip, visibleWidth } from "./render.ts";

/** SGR sequences, and the tier that turns them off. Emitted from one table so "what does 8 colours drop" is one list rather
 *  than a decision made per span. */
const SGR = {
  dim: "\u001b[2m",
  bold: "\u001b[1m",
  italic: "\u001b[3m",
  code: "\u001b[36m",
  reset: "\u001b[0m",
} as const;

export type CharsetTier = "truecolor" | "256" | "ansi" | "none";

/** Where attributes are allowed. `none` is not a colour tier the *terminal* advertises for a dumb device — it is `TERM=dumb`
 *  and a pipe — and there the renderer emits no escape at all, because an escape in a pipe is a character in somebody's
 *  `grep`. */
function attributesAllowed(tier: CharsetTier): boolean {
  return tier !== "none";
}

/** Wrap in an attribute, or not. **The decision about whether a reader can see the difference lives here**, which is why
 *  every call site passes the tier rather than deciding for itself. */
function attribute(text: string, sequence: string, tier: CharsetTier): string {
  return attributesAllowed(tier) ? `${sequence}${text}${SGR.reset}` : text;
}

/** One rendered line, with its own width known. The pane needs the width to decide scrolling and to keep a code block
 *  unbroken, and re-measuring a line the renderer just built would be the second measurement of one thing. */
export interface RenderedLine {
  readonly text: string;
  /** Columns the line occupies **without** attributes — the number that decides wrapping and overflow. */
  readonly width: number;
  /** True for a fenced code block's lines, which are never reflowed (T4-03). */
  readonly code: boolean;
}

/** A fenced code block: the lines between the fences, plus the language label the row asks for. The fences themselves are
 *  dropped — the *label* is what a person needs, and a border made of backticks is a third thing to reflow. */
function codeBlock(
  body: readonly string[],
  language: string | undefined,
  tier: CharsetTier,
): readonly RenderedLine[] {
  const label = language === undefined || language.length === 0 ? "code" : language;
  const rule = `── ${label} `;
  // The rule is drawn to a *fixed* 20 columns rather than to the terminal width: a rule that resizes with the terminal is
  // one more thing that changes per token batch, and this file's whole cost argument is that rendering must be stable.
  const lines: RenderedLine[] = [
    {
      text: attribute(rule + "─".repeat(Math.max(1, 24 - visibleWidth(rule))), SGR.dim, tier),
      width: Math.max(visibleWidth(rule) + 1, 24),
      code: true,
    },
  ];
  for (const line of body) {
    // No clipping, no wrapping: T4-03 says a long identifier must not break the frame, and the only way to keep it whole
    // is to let the pane scroll it. The width is reported honestly so the pane knows it has to.
    lines.push({ text: attribute(line, SGR.code, tier), width: visibleWidth(line), code: true });
  }
  return lines;
}

/** Wrap on word boundaries at `columns`, with a continuation indent so a wrapped paragraph is visibly a paragraph. A long
 *  *word* (a path, a base64 blob) is left whole and reported wider than the terminal — the same decision as a code block,
 *  because a URL broken across three lines is one nobody can copy. */
function wrap(text: string, columns: number, indent: string): readonly RenderedLine[] {
  if (visibleWidth(text) <= columns) return [{ text, width: visibleWidth(text), code: false }];
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/).filter((part) => part.length > 0)) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (current.length === 0 && visibleWidth(word) > columns) {
      // One word longer than the line: keep it whole and start fresh.
      lines.push(word);
      continue;
    }
    if (indent.length + visibleWidth(candidate) <= columns) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = word;
  }
  if (current.length > 0) lines.push(current);
  return lines.map((line, index) => {
    const text0 = index === 0 ? line : `${indent}${line}`;
    return { text: text0, width: visibleWidth(text0), code: false };
  });
}

const BULLET = "  · ";
const NUMBER = "  ";

/** The whole render, as a list of lines. `columns` is the *content* width — the frame's, or the pane's — and everything
 *  about the output depends on it, which is why it is a parameter rather than a constant: a chat pane at 40 columns and the
 *  same pane at 100 are different renderings of one answer. */
export function renderMarkdown(
  text: string,
  columns: number,
  tier: CharsetTier = "none",
): readonly RenderedLine[] {
  if (columns < 8) columns = 8;
  const out: RenderedLine[] = [];
  const lines = text.split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const fence = /^```(.*)$/.exec(line);
    if (fence !== null) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index] ?? "")) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      // The closing fence (or the end of the text) — either way the block ends, and an unterminated fence renders as a
      // block rather than swallowing the rest of the message, because a stream that ends mid-fence is normal.
      index += 1;
      out.push(...codeBlock(body, fence[1]?.trim(), tier));
      continue;
    }
    // A heading is **left as text** by D-061's subset — tables, nested lists and inline HTML pass through, and a heading is
    // in the same class: rendering it as a rule would be a decoration the charset tier would have to carry.
    // Wrapped first, then decorated: the wrap must measure the text the reader sees, so it cannot run on a line that
    // already carries escape sequences (which count as zero width and would let the text overflow).
    for (const rendered of wrap(line, columns, NUMBER)) {
      out.push(rendered);
    }
    index += 1;
  }
  // The width is recomputed **after** decorating, because it is the width a person sees and the decoration adds no columns.
  // Reporting the pre-decoration width made every emphasised line look four columns too wide, which is exactly the kind of
  // wrong number a pane uses to decide scrolling — and it is also why rendering the rendered text again produced different
  // widths, i.e. why the renderer was not idempotent.
  return out.map((line) => {
    if (line.code) return line;
    const text = renderInline(line.text, tier);
    return { ...line, text, width: visibleWidth(text) };
  });
}

/** Emphasis (`*x*`, `_x_`, `**x**`) and inline code, inside one line. Applied with a single pass so a `*` that is not
 *  emphasis — a multiplication sign in prose, or a glob in a path — is left alone: the subset is "named", not "aggressive". */
export function renderInline(line: string, tier: CharsetTier = "none"): string {
  if (!attributesAllowed(tier)) {
    // Still recognised, just not decorated: stripping the markers would be *rendering*, and the row says the words are what
    // survive, not the punctuation.
    return line;
  }
  let text = line;
  text = text.replace(/`([^`]+)`/g, (_all, code: string) => attribute(code, SGR.code, tier));
  text = text.replace(/\*\*([^*]+)\*\*/g, (_all, bold: string) => attribute(bold, SGR.bold, tier));
  // The content must not start or end with a space — the markdown rule, and the thing that keeps `--files *.ts and 2 * 3`
  // out of the decorator. A pattern that allows a leading space inside the emphasis will happily swallow a glob, an
  // arithmetic expression, or half a sentence, and the result is a *mangled* path rather than an undecorated one.
  const starred = "[^*\\n\\s](?:[^*\\n]*[^*\\n\\s])?";
  text = text.replace(
    new RegExp(`(^|[\\s(])\\*(${starred})\\*`, "g"),
    (_all, before: string, italic: string) => `${before}${attribute(italic, SGR.italic, tier)}`,
  );
  // `_` additionally refuses to emphasise *inside* a word, because `snake_case_name` is a name and not emphasis.
  const underscored = "[^_\\n\\s](?:[^_\\n]*[^_\\n\\s])?";
  text = text.replace(
    new RegExp(`(^|[\\s(])_(${underscored})_`, "g"),
    (_all, before: string, italic: string) => `${before}${attribute(italic, SGR.italic, tier)}`,
  );
  return text;
}

/** One line of the transcript for a *tool* result or a diff — the rows T4-07/T4-08 ask for are lists of these, so the
 *  collapse/expand decision belongs to the pane and the formatting to here. */
export function toolLine(
  tool: string,
  tier: string,
  status: string,
  durationMs: number | undefined,
): RenderedLine {
  const duration = durationMs === undefined ? "" : ` · ${(durationMs / 1000).toFixed(1)}s`;
  const text = `${tool} · ${tier} · ${status}${duration}`;
  return { text, width: visibleWidth(text), code: false };
}

/** T4-08's `redacted` marker, as a word. A marker drawn as a box is a marker nobody can read on a phone, and the row's
 *  reason is that the user learns something — which means it has to be spelled. */
export function redactedMarker(what: string): RenderedLine {
  const text = `${what}: redacted`;
  return { text, width: visibleWidth(text), code: false };
}

/** T5-10's estimate, clipped so the line cannot push the layout: the estimate is a budget, not a promise (O-031), and the
 *  number is labelled `est` so nobody reads it as a measurement. */
export function estimateLine(tokens: number): RenderedLine {
  const text = `~${tokens.toLocaleString("en-US")} tokens est (D-064)`;
  return { text: text.length > 0 ? clip(text, 60) : text, width: visibleWidth(text), code: false };
}

export { BULLET };
