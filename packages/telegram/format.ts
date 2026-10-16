// Region G2 — what text looks like on the way out. Everything here is a pure function of data to a string, because
// the inventory's binding case ("a chat on a phone with a flaky connection") is answered twice per row: what the user
// sees when it works, and what they see when the API says no. The `no` answers live in `outbound.ts`; this file owns
// the `yes` answers, and a test holds each one against the row that names it.
import { MESSAGE_TEXT_MAX } from "./limit.ts";

/** G2-04's conservative subset: what survives is a fenced code block, an inline code span, and bold. Everything else
 *  is escaped, and the escape is the *first* thing that happens — a `<` in someone's shell command is data, and the
 *  one thing this interface must not do is turn a user's text into markup. */
export function escapeTelegram(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const FENCE_RE = /^```([a-zA-Z0-9_-]*)\n?([\s\S]*?)\n?```$/;

/** Render untrusted text into Telegram's HTML parse mode, or `undefined` when there is nothing to style. The caller
 *  sends with `parse_mode: "HTML"` only when this returned a value; G2-04's fallback ("if escaping fails, it sends
 *  plain text rather than broken formatting") is the sender's branch, because only it can retry. */
export function toTelegramHtml(text: string): string | undefined {
  if (text.length === 0) return undefined;
  // The conservative walk: one whole-message fence, or inline spans, or bold — never a nesting the phone could
  // mis-render. Multi-fence messages fall back to plain — G2-04's rule prefers unstyled truth over broken markup,
  // and a message with two fences is ordinary tool output.
  const fence = FENCE_RE.exec(text.trim());
  if (fence !== null && !(fence[2] ?? "").includes("```")) {
    const body = escapeTelegram(fence[2] ?? "");
    return fence[1]
      ? `<pre><code class="language-${fence[1]}">${body}</code></pre>`
      : `<pre>${body}</pre>`;
  }
  if (fence !== null) {
    // The trim made two fences look like one; a body that still carries a fence is the multi-block case, and the
    // conservative rule sends it plain rather than guessing at nesting (G2-04).
    return undefined;
  }
  let out = "";
  let rest = text;
  let styled = false;
  while (rest.length > 0) {
    const span = /`([^`\n]+)`/.exec(rest);
    const bolded = /\*\*([^*\n]+)\*\*/.exec(rest);
    if (span === null && bolded === null) {
      out += escapeTelegram(rest);
      break;
    }
    const pick =
      span !== null && (bolded === null || (span.index ?? 0) < (bolded.index ?? 0)) ? span : bolded;
    if (pick === null) {
      out += escapeTelegram(rest);
      break;
    }
    out += escapeTelegram(rest.slice(0, pick.index));
    if (pick === span) {
      out += `<code>${escapeTelegram(pick[1] ?? "")}</code>`;
    } else {
      out += `<b>${escapeTelegram(pick[1] ?? "")}</b>`;
    }
    styled = true;
    rest = rest.slice((pick.index ?? 0) + pick[0].length);
  }
  if (!styled) return undefined; // nothing survived as markup — plain text is the honest send
  return out;
}

export interface SplitPart {
  readonly text: string;
  readonly marker: string | undefined;
}

/** G2-02: split at a line boundary, never mid-code-block, with `(2/3)` markers whose count is the *real* count. The
 *  budget per part is the API's 4 096 minus room for the marker line, because the marker rides inside the same
 *  message. A single block that fits comes back as one part with no marker — a `(1/1)` would be noise. */
export function splitMessage(text: string, max = MESSAGE_TEXT_MAX): SplitPart[] {
  const budget = max - 12; // "(", ")", digits, spaces, newlines — the marker line's worst case
  if (text.length <= max) return [{ text, marker: undefined }];
  const chunks: string[] = [];
  let current = "";
  let fenceOpen = false; // the fence state *before* the current line is appended
  for (const line of text.split("\n")) {
    const candidate = current.length === 0 ? line : `${current}\n${line}`;
    if (candidate.length > budget && current.length > 0) {
      if (fenceOpen) {
        // "Never mid-code-block": the part ships a *closed* fence, and the next part reopens — what the phone
        // renders is balanced markup, not a monospace block that swallows the rest of the message.
        chunks.push(`${current}\n\`\`\``);
        current = `\`\`\`\n${line}`;
      } else {
        chunks.push(current);
        current = line;
      }
    } else {
      current = candidate;
    }
    if (/^```/.test(line)) fenceOpen = !fenceOpen;
  }
  if (current.length > 0) chunks.push(fenceOpen ? `${current}\n\`\`\`` : current);
  // A single line longer than the budget would still overflow; G2-03's truncation label is that case's answer, not a
  // hard split inside a line the phone cannot wrap honestly.
  return chunks.map((part, i) => ({
    text: part,
    marker: chunks.length === 1 ? undefined : `(${String(i + 1)}/${String(chunks.length)})`,
  }));
}

/** G2-03's label: it says the text was cut **and what the omitted part was** — "…" is the defect this row exists for. */
export function truncationLabel(omitted: string): string {
  const shape =
    omitted.length > 200
      ? `${omitted.slice(0, 200)}… (+${String(omitted.length - 200)} more chars)`
      : omitted;
  return `truncated — omitted: ${shape}`;
}

/** G2-06: a "table" becomes aligned plain text, padded per column, never a grid that wraps on a narrow screen. */
export function alignTable(rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const cols: number[] = [];
  for (let c = 0; c < width; c += 1) {
    cols.push(Math.max(...rows.map((row) => (row[c] ?? "").length)));
  }
  return rows
    .map((row) =>
      row
        .map((cell, c) => (cell ?? "").padEnd(cols[c] ?? 0, " "))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

/** G2-09: a time quoted in a reply carries the Gateway's timezone label, because "21:44" between two devices is how
 *  people misread logs. `zone` is the config's own spelling (`Asia/Dhaka`), rendered when the platform can render it. */
export function stampTime(iso: string, zone: string | undefined): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  let local: string;
  try {
    local = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      hour: "2-digit",
      minute: "2-digit",
      day: "2-digit",
      month: "short",
    }).format(at);
  } catch {
    // A zone the platform cannot render is still labeled — with where the time actually came from — because an
    // unlabeled "21:44" between two devices is exactly the misreading this row exists for.
    return `${at.toISOString().slice(11, 16)} (Gateway time)`;
  }
  return `${local} (${zone ?? "Gateway time"})`;
}

/** G2-10: an id is its own line — copyable in one tap, never welded inside a sentence. */
export function idLine(label: string, id: string): string {
  return `${label}\n${id}`;
}

/** G1-11's status word and G4-03's terminal line are words, not emoji (G2-13: state is carried by words). */
export function stateWord(state: string): string {
  return state;
}
