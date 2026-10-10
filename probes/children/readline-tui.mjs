// P5's control: the same three composer decisions, made with nothing but `node:readline` and raw stdin, so the probe
// compares Ink against the fallback the plan keeps on the shelf rather than asserting that a library is fine.
import { appendFileSync, writeFileSync } from "node:fs";

const log = process.env.PROBE_LOG ?? "/tmp/crabby-p5-readline.log";
const keys = [];
let newlines = 0;
let submits = 0;
let shiftEnters = 0;
let caret = 0;

writeFileSync(
  log,
  `START cols=${process.stdout.columns} rows=${process.stdout.rows} term=${process.env.TERM ?? "-"}\n`,
);

const show = (s) =>
  s === "\r"
    ? "<CR>"
    : s === "\n"
      ? "<LF>"
      : s === "\x7f"
        ? "<DEL>"
        : s === "\x03"
          ? "<ETX>"
          : s === "\x01"
            ? "<SOH>"
            : s;

process.stdin.setEncoding("utf8");
if (process.stdin.isTTY) process.stdin.setRawMode(true);

let pending = "";
process.stdin.on("data", (chunk) => {
  pending += chunk;
  // CSI-prefixed sequences are consumed whole; a lone ESC is treated as Escape after the buffer drains
  while (pending.length) {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: a key decoder's inputs are escape bytes by definition
    const seq = /^\x1b\[[0-9;]*[A-Za-z]/.exec(pending);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: same
    if (seq && seq[0].length === pending.length && /^\x1b\[[0-9;]*$/.test(pending)) break;
    if (seq) {
      handle(seq[0]);
      pending = pending.slice(seq[0].length);
      continue;
    }
    const ch = pending[0];
    pending = pending.slice(1);
    handle(ch);
  }
});

function handle(raw) {
  const name = nameOf(raw);
  keys.push({ ch: show(raw), name });
  if (raw === "\x03") {
    dump("CTRL_C");
    process.exit(0);
  }
  if (raw === "\n") {
    newlines += 1;
    return;
  }
  if (raw === "\x1b[13;2u") {
    shiftEnters += 1;
    newlines += 1;
    return;
  }
  if (raw === "\r") {
    submits += 1;
    return;
  }
  if (
    raw === "\x01" ||
    raw === "\x1b[D" ||
    raw === "\x1b[C" ||
    raw === "\x1b[H" ||
    raw === "\x1b[F"
  )
    caret += 1;
  // state after every key, so the parent can stop reading whenever it likes instead of waiting for an exit
  dump("KEY");
}

function nameOf(raw) {
  if (raw === "\x1b[13;2u") return "return+shift";
  if (raw === "\x1b[D") return "leftArrow";
  if (raw === "\x1b[C") return "rightArrow";
  if (raw === "\x1b[H") return "home";
  if (raw === "\x1b[F") return "end";
  if (raw === "\x01") return "ctrl";
  if (raw === "\x03") return "ctrl";
  return "";
}

function dump(reason) {
  appendFileSync(
    log,
    `STATE ${reason} ${JSON.stringify({ keys: keys.length, newlines, submits, shiftEnters, caret })}\n`,
  );
  appendFileSync(log, `KEYS ${JSON.stringify(keys)}\n`);
}

// one frame, so the probe can prove the fallback paints at all
process.stdout.write(
  `\x1b[2J\x1b[H40c ${process.stdout.columns ?? 0}x${process.stdout.rows ?? 0}\n`,
);
