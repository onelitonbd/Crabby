// P5's subject, run under a pty by `script` so Ink believes it has a terminal. The child is deliberately dumb: it
// records every keystroke Ink hands it, exactly as Ink named it, and paints one over-long Bengali line plus one
// over-long latin line. The parent reads the key record out of PROBE_LOG (out-of-band, because the pty stream is Ink's
// paint, not the app's state) and asserts on that, so the probe measures Ink's decoder rather than this file's prose.
import { appendFileSync, writeFileSync } from "node:fs";
import { Box, render, Text, useApp, useInput } from "ink";
import React from "react";

const log = process.env.PROBE_LOG ?? "/tmp/crabby-p5.log";
const keys = [];
let frames = 0;
let newlines = 0;
let submits = 0;
let chars = 0;
let shiftEnters = 0;

const show = (ch) =>
  ch === "\r"
    ? "<CR>"
    : ch === "\n"
      ? "<LF>"
      : ch === "\x7f"
        ? "<DEL>"
        : ch === "\x1b"
          ? "<ESC>"
          : ch;

function flags(k) {
  const named = Object.entries(k)
    .filter(([, v]) => v === true)
    .map(([name]) => name)
    .sort();
  return named.length ? named.join("+") : "";
}

let caret = 0;

function state() {
  return {
    frames,
    keys: keys.length,
    chars,
    newlines,
    submits,
    shiftEnters,
    caret,
    shiftEnter: keys.filter((x) => x.name.includes("shift")).length,
  };
}

function App() {
  const app = useApp();
  const [draft, setDraft] = React.useState("");

  useInput((ch, k) => {
    const entry = { ch: show(ch), name: flags(k), n: ch.length };
    keys.push(entry);
    chars += ch.length; // stdin events coalesce, so events are not keystrokes: count the characters too
    if (k.ctrl && ch === "c") {
      dump("CTRL_C");
      app.exit();
      return;
    }
    // the composer rule the TUI will ship: LF is the newline key (Ctrl+J), CR is submit
    if (ch === "\n" || ch === "\x0a" || (k.ctrl && ch === "j")) {
      newlines += 1;
      setDraft((d) => `${d}\n`);
      return;
    }
    // the composer rule M-T has to keep: Shift+Enter arrives as CR *with a shift flag*, so the flag has to be
    // checked before a CR is allowed to submit, or a kitty terminal submits when the user meant to add a line
    if (ch === "\r" && k.shift) {
      shiftEnters += 1;
      setDraft((d) => `${d}\n`);
      return;
    }
    if (ch === "\r") {
      submits += 1;
      return;
    }
    if (k.leftArrow || k.rightArrow || k.home || k.end) caret += 1;
    if (ch && !k.ctrl && !k.meta) setDraft((d) => d + (ch === "\x7f" ? "" : ch));
    // state after every key, so the parent reads a current record instead of waiting for the child to decide to exit
    dump("KEY");
    if (ch === "q") app.exit();
  });

  frames += 1;
  const wide = "এই একটি লাইন ইচ্ছা করে লম্বা করা হয়েছে যাতে ৪০ কলামে না ধরে";
  return React.createElement(
    Box,
    { flexDirection: "column" },
    React.createElement(
      Text,
      { color: "yellow" },
      `40c ${process.stdout.columns}x${process.stdout.rows}`,
    ),
    React.createElement(
      Text,
      { dimColor: true },
      `frame ${frames} draft=${draft.length} caret=${caret}`,
    ),
    React.createElement(Text, null, wide),
    React.createElement(Text, { backgroundColor: "blue", color: "white" }, "> type here"),
    React.createElement(Text, { color: "red" }, "long ".repeat(12)),
  );
}

function dump(reason) {
  appendFileSync(log, `STATE ${reason} ${JSON.stringify(state())}\n`);
  appendFileSync(log, `KEYS ${JSON.stringify(keys)}\n`);
}

writeFileSync(
  log,
  `START cols=${process.stdout.columns} rows=${process.stdout.rows} term=${process.env.TERM ?? "-"} colorterm=${process.env.COLORTERM ?? "-"}\n`,
);

// Ink's default is `exitOnCtrlC: true`, and P5 measures what that costs: with it on, the app never sees the key.
const exitOnCtrlC = process.env.PROBE_EXIT_ON_CTRL_C !== "0";
const instance = render(React.createElement(App), { exitOnCtrlC });
setTimeout(
  () => {
    dump("TTL");
    instance.unmount();
    instance.waitUntilExit().then(() => process.exit(0));
  },
  Number(process.env.PROBE_TTL ?? 8000),
);
