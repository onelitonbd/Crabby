// The TUI's renderer: **inline**, line-diffed, and dependency-free.
//
// Three documents shape this file and they pull in different directions, so each decision below names the one it serves:
//
//  - **D-061** (inline, not the alternate screen): the frame draws in the terminal's normal buffer, so scrollback survives
//    the session and long-press selection on a phone works like every other terminal app. The cost is that there is no
//    "clear and redraw", and the whole design of this file is that cost handled honestly rather than avoided.
//  - **P-011** (repaint capped at ~4 fps, no full-screen repaint per token): a streaming answer must not repaint the world
//    per token. That is why `planFrame` computes a *list of writes for the lines that changed* rather than a new screen
//    buffer: on a 40×24 terminal with three lines changing, three lines are written.
//  - **§4 of `docs/UI_UX_SPEC.md`** (40 columns minimum, 24 rows usable, 8-color fallback): the layout is expressed in
//    *weights*, not column counts, so a wider terminal gives more to the primary pane and a narrower one drops from the
//    documented end rather than wrapping into unreadability.
//
// **Why no Ink.** P-010 (Ink 8) is **Proposed — Needs Validation**, gated on a phone measurement that has not been taken
// (O-006, O-051), and `docs/ROADMAP.md`'s M0 P5 names `node:readline` as the *control* to measure it against. Adopting a
// proposed rendering library — and two dependencies with it — before the measurement that decides it would be choosing the
// answer to the open question. So this is the control: stdlib only, and the frame it draws is the same frame. The seam is
// `Terminal`, an interface of four methods, so an accepted P-010 can replace the drawing without touching a pane.
//
// **What the tests here hold.** Not "it writes something": the pure part is `planFrame`, and it is tested for the three
// properties a screen depends on — an unchanged frame writes *nothing* (P-011's budget spent only where something moved),
// a changed frame writes only the changed lines, and a shrinking frame never moves the cursor above where it started
// (which in a normal buffer means erasing the user's scrollback).
import { clip } from "@crabby/platform";

/** The four things a terminal can be asked to do, and nothing else. Pane code never writes an escape sequence itself, so
 *  a renderer that changes is a change to one file — and a fake terminal in a test needs no pty. */
export interface Terminal {
  readonly columns: number;
  readonly rows: number;
  write(text: string): void;
}

const CSI = "\u001b[";

/** Move the cursor `delta` rows relative to where it is, and to column 1. Negative is up (`CSI n A`), positive is down
 *  (`CSI n B`) — down is needed because a frame's *unchanged* middle lines are skipped, so the cursor can be left on an
 *  earlier row and the next changed line may be below it. `\r` always: a rewritten line has to start at its own
 *  beginning, not wherever the previous one happened to end. Zero rows still emits the `\r`. */
function moveBy(delta: number): string {
  const rows = Math.trunc(delta);
  if (rows === 0) return "\r";
  return rows < 0 ? `${CSI}${-rows}A\r` : `${CSI}${rows}B\r`;
}

function clearLine(): string {
  return `${CSI}2K`;
}

function hideCursor(): string {
  return `${CSI}?25l`;
}

function showCursor(): string {
  return `${CSI}?25h`;
}

export interface FramePlan {
  /** Written to the terminal, in order. Empty when the frame is unchanged, which is the common case while a model is
   *  thinking and is why P-011's budget lasts: nothing changed, so nothing is written. */
  readonly text: string;
  /** How many terminal lines the frame occupies after this plan, so the next plan knows where it is. */
  readonly height: number;
  readonly lines: readonly string[];
}

/** One ANSI CSI sequence. **Declared once, with one suppression**, because `lint/suspicious/noControlCharactersInRegex` is
 *  right about every other case in this repository and wrong about this one: these are the sequences this module writes,
 *  and the width arithmetic has to see through them. A second copy of the pattern in a test would be a second thing to
 *  forget to suppress, and an unsuppressed copy fails a run for a reason nobody can act on. */
export const ANSI_SEQUENCE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: this module's own escape sequences, matched to measure width
  /\u001b\[[0-9;?]*[A-Za-z]/g;

/** ANSI sequences never survive a width calculation, and a line measured with its escapes included is a line clipped 40
 *  columns too early. Removed for measurement and re-applied only where the layout asks for them, so that a colour tier of
 *  8 (`docs/DESIGN_SYSTEM.md` §2.1) is a *choice at one place* rather than something every pane has to remember. */
export function visibleWidth(line: string): number {
  return line.replace(ANSI_SEQUENCE, "").length;
}

/** Clip to `columns`, counting only what a person can see. `clip` from the CLI is the same helper the CLI prints with,
 *  because two clip helpers would be two answers to "what does this look like at 40 columns" — §4 says 40 is the design
 *  case, not the smallest. */
export function fit(line: string, columns: number): string {
  if (visibleWidth(line) <= columns) return line;
  // A coloured line that is cut in the middle of an escape is worse than an uncoloured one, so the sequences are dropped
  // rather than split: the information that survives is the text, and a truncated colour code changes the rest of the
  // terminal's mood.
  const plain = line.replace(ANSI_SEQUENCE, "");
  return clip(plain, Math.max(1, columns));
}

/** The plan: what to write to move the frame from `previous` to `next`.
 *
 *  The arithmetic, once, so the tests can hold it:
 *
 *   - **The cursor sits on a row of the frame**, because a plan writes lines without a trailing newline. Line `h - 1` of
 *     an `h`-row frame is the starting row, and the load-bearing convention is that the cursor is *on* the last row rather
 *     than below the frame: counting "below" makes every move one row short, so a frame rewrites the line *after* the one
 *     it meant to and the screen looks plausible while being wrong.
 *   - Every unchanged line is **skipped**, so the cursor can end up on an earlier row and the next changed line can be
 *     *below* it. Both directions are therefore emitted: `CSI n A` up, `CSI n B` down. Down is the case a
 *     changed-line-only writer forgets, and its symptom is a frame whose middle lines are rewritten one row too high.
 *   - Moves are clamped to the frame's own rows. Reaching further up would rewrite the scrollback above the frame, which is
 *     the one thing D-061's inline mode promises never to do.
 *
 *  Every changed line is cleared before it is written (`CSI 2 K`), not only the ones that got shorter: a longer new line
 *  over a shorter old one leaves nothing behind, and a shorter new line over a longer old one leaves the tail visible — and
 *  the cost is one sequence per changed line, against a frame that would otherwise lie about its own width. */
export function planFrame(
  previous: readonly string[],
  next: readonly string[],
  columns: number,
): FramePlan {
  const fitted = next.map((line) => fit(line, columns));
  const previousLines = previous.map((line) => fit(line, columns));
  if (
    fitted.length === previousLines.length &&
    fitted.every((line, index) => line === previousLines[index])
  ) {
    // Identical after clipping is a frame that did not change, and it must write nothing: P-011's budget is spent per
    // *change*, and a renderer that redraws on every poll would spend it whether anything happened or not.
    return { text: "", height: previousLines.length, lines: fitted };
  }

  const rows = Math.max(previousLines.length, fitted.length);
  // Start on the last row of the **previous** frame, clamped to the taller of the two so a frame that grew is drawn from a
  // row that exists. A brand-new frame (`previous` empty) starts on its own first row, which is where the cursor is.
  let cursor = previousLines.length === 0 ? 0 : Math.min(previousLines.length - 1, rows - 1);
  let text = "";
  const emit = (row: number, body: string): void => {
    text += moveBy(row - cursor) + clearLine() + body;
    cursor = row;
  };

  for (let row = 0; row < fitted.length; row += 1) {
    if (fitted[row] === previousLines[row]) continue;
    emit(row, fitted[row] ?? "");
  }
  // Whatever the frame shrank by, the rows it no longer occupies are still on screen: erase them, or the taller frame's
  // ghosts stay behind and the next taller frame grows into them. An empty `next` lands here too, which is what makes
  // `printToScrollback` leave a clean frame behind instead of printing underneath it.
  for (let row = fitted.length; row < previousLines.length; row += 1) emit(row, "");
  // …and then move back up past the rows just erased, so the cursor ends on the frame's new last row (or, for an empty
  // frame, just above where the frame was). A bare cursor move destroys nothing — only a write does — so this is what lets
  // `printToScrollback` put its text where the frame was rather than inside the region the frame used to occupy.
  if (fitted.length < previousLines.length) text += moveBy(-(previousLines.length - fitted.length));
  return { text, height: fitted.length, lines: fitted };
}

/** Holds the last frame and the cursor's position in the buffer. One instance per TUI; panes call `draw(lines)` and know
 *  nothing about escape sequences. */
export class FrameRenderer {
  readonly #terminal: Terminal;
  #previous: string[] = [];
  #height = 0;

  constructor(terminal: Terminal) {
    this.#terminal = terminal;
  }

  /** The 4 fps cap (P-011), applied here rather than in the panes. One place means the budget cannot be forgotten by the
   *  pane that streams fastest, which is exactly the pane that would forget it. `now` is injected for the reason policy
   *  injects it: a rate limit tested against the wall clock is a rate limit that cannot be tested. */
  #lastDraw = 0;

  draw(lines: readonly string[], now: number, minIntervalMs = 250): void {
    if (now - this.#lastDraw < minIntervalMs && this.#height > 0) {
      // Too soon. The frame is *not* remembered as drawn, so the next call still writes it: dropping it would lose the
      // last lines of an answer, which is the failure mode the cap is not allowed to have.
      return;
    }
    this.#lastDraw = now;
    this.drawNow(lines);
  }

  /** The uncapped path: one write per changed line, and nothing when nothing changed. */
  drawNow(lines: readonly string[]): void {
    const plan = planFrame(this.#previous, lines, this.#terminal.columns);
    this.#previous = [...plan.lines];
    this.#height = plan.height;
    if (plan.text !== "") this.#terminal.write(plan.text);
  }

  /** The first frame needs room. In an inline buffer the terminal scrolls when the cursor reaches the last row, so
   *  drawing a 20-row frame at the bottom of the screen pushes the user's scrollback up by 20 rows — acceptable, and the
   *  documented price of inline over the alternate screen (D-061). The alternative (the alternate screen) is the thing
   *  D-061 refused. */
  ensureRoom(lines: number): void {
    if (lines <= this.#terminal.rows) return;
    const overflow = lines - this.#terminal.rows + 1;
    this.#terminal.write("\n".repeat(overflow));
  }

  get height(): number {
    return this.#height;
  }

  hideCursor(): void {
    this.#terminal.write(hideCursor());
  }

  showCursor(): void {
    this.#terminal.write(showCursor());
  }

  /** Scrollback on purpose: T-01's "print to scrollback", and the only way anything is pushed out of the frame on
   *  purpose. Everything above the frame is already in the buffer (D-061), so "printing" is printing and not copying. */
  printToScrollback(text: string): void {
    const plan = planFrame(this.#previous, [], this.#terminal.columns);
    if (plan.text !== "") this.#terminal.write(plan.text);
    this.#previous = [];
    this.#height = 0;
    this.#terminal.write(`${text}\n`);
  }
}

/** A terminal over stdio. The only place in the TUI that knows about escape sequences *and* the outside world; the pane
 *  layer takes the `Terminal` interface, which is also what the tests fake. */
export function stdioTerminal(out: NodeJS.WriteStream, columns: number, rows: number): Terminal {
  return { columns, rows, write: (text) => out.write(text) };
}
