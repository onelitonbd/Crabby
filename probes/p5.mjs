// P5 — the TUI at the width the design case allows. A container has no phone screen, so this probe does not pretend to
// judge appearance. It puts Ink 8 in a real 40x24 pty (`script` + `stty`), paints a frame deliberately too wide in two
// scripts, reads the pty stream back through a small terminal emulator (probes/vt.mjs), and asserts on the keystrokes
// Ink reported. First run here settled two things the plan had left open, both of which are Ink's behaviour rather
// than the phone's: Ctrl+J reaches useInput as LF with no ctrl flag (so it is distinguishable from Enter, which arrives
// as CR), and a terminal that speaks the kitty protocol shows up as `return+shift` against plain `return` — the second
// half of that is still only as good as the terminal, which is why O-051 stays a device question.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ensureDep, envFacts, Probe, parseArgs, REPO_DIR, report, stageChild } from "./lib.mjs";
import { graphemes, VtScreen } from "./vt.mjs";

const probe = new Probe("P5", "Ink 8 in a 40x24 pty: width, key decoding, colour depth");
const args = parseArgs();
const COLS = 40;
const ROWS = 24;

console.log(`P5 · ${envFacts().node} on ${envFacts().platform}`);

const inkDep = await ensureDep("ink", "8.0.0");
const reactDep = await ensureDep("react", "19.3.0");
if (!inkDep.ok || !reactDep.ok) {
  probe.block(
    "Ink 8 and React 19 install for the probe",
    `${inkDep.reason ?? ""} ${reactDep.reason ?? ""} — npm install --prefix probes/.deps ink@8.0.0 react@19.3.0`,
  );
} else {
  probe.check(
    "Ink's layout is WebAssembly, so it needs no device compiler",
    true,
    "yoga-layout 3.2 ships yoga-wasm-base64-esm.js — unlike better-sqlite3 (P3) this is not a build risk",
  );

  const child = stageChild("ink-tui.mjs");
  mkdirSync(path.join(REPO_DIR, "probes", "out"), { recursive: true });

  const session = await runSession(child, {
    term: "xterm-256color",
    colorterm: "truecolor",
    feed: ["a", "b", "\x01", "\x1b[D", "\x0a", "\x1b[13;2u", "\r"],
  });
  if (!session.started) {
    probe.block(
      "a pty could be allocated and Ink painted a frame",
      `no START line from the child (exit ${session.exit.code ?? "null"}/${session.exit.signal ?? "-"}): ${session.tail.slice(0, 200)}`,
    );
  } else {
    const { screen, keys, state } = session;
    probe.check(
      `nothing was written past the ${COLS}th cell, so the terminal never had to wrap`,
      screen.maxWidth() <= COLS && screen.edgeOverflow() === 0,
      `widest row ${screen.maxWidth()} cells, cells past the edge ${screen.edgeOverflow()}, ${screen.visible().length} painted rows`,
    );
    const first = graphemes("এ")[0];
    probe.check(
      "the Bengali line survives the render instead of turning into blanks or question marks",
      screen.text().includes(first) && !screen.text().includes("\ufffd"),
      `"${first}" present; how the marks *shape* is a phone question, not a byte question`,
    );

    const lf = keys.filter((k) => k.ch === "<LF>");
    const cr = keys.filter((k) => k.ch === "<CR>");
    probe.check(
      "Ctrl+J arrives as LF, and Enter as CR, so the composer can tell them apart",
      lf.length === 1 && cr.length >= 1 && state.newlines === 1 && lf[0]?.name === "",
      `LF ${lf.length} (flags "${lf[0]?.name ?? ""}"), CR ${cr.length}, newlines inserted ${state.newlines}, submits ${state.submits}`,
    );
    probe.check(
      "the kitty Shift+Enter sequence arrives as a distinct chord, legacy CR does not",
      state.shiftEnter === 1 &&
        cr.some((k) => k.name.includes("shift")) &&
        cr.some((k) => k.name === "return"),
      `return+shift seen ${state.shiftEnter}×, plain return ${cr.filter((k) => k.name === "return").length}× — a terminal that sends neither is what O-051 must decide on the phone`,
    );
    probe.check(
      "readline-style controls reach useInput named (Ctrl+A, arrows), so the TUI can move a caret",
      keys.some((k) => k.name === "ctrl" && k.ch === "a") &&
        keys.some((k) => k.name.includes("leftArrow")),
      keys.map((k) => `${k.ch}:${k.name || "-"}`).join(" "),
    );
    // Ctrl+C, both ways, because the answer changes what the TUI has to write: Ink's default handler quits the process
    // *before* the app sees the key, so an app that must save state or stop a stream on Ctrl+C has to opt out of it
    const quitOn = await runSession(child, {
      term: "xterm-256color",
      colorterm: "truecolor",
      feed: ["\x03"],
      tag: "ctrlc-on",
    });
    const quitOff = await runSession(child, {
      term: "xterm-256color",
      colorterm: "truecolor",
      feed: ["\x03"],
      tag: "ctrlc-off",
      exitOnCtrlC: false,
    });
    probe.check(
      "Ctrl+C ends the app in both modes, with exit code 0 and no leftover signal",
      quitOn.started && quitOff.started && quitOn.exit.code === 0 && quitOff.exit.code === 0,
      `exitOnCtrlC default ${quitOn.exit.code}, opted out ${quitOff.exit.code}`,
    );
    probe.check(
      "the default swallows the key, so the TUI must set exitOnCtrlC:false to act on it",
      !quitOn.log.includes("STATE CTRL_C") && quitOff.log.includes("STATE CTRL_C"),
      `handler saw it: default ${quitOn.log.includes("STATE CTRL_C")}, opted out ${quitOff.log.includes("STATE CTRL_C")} — M-T writes this into the app's input layer, not into a document`,
    );
    probe.check(
      "Shift+Enter added a line without submitting, which is the rule the composer needs",
      state.shiftEnters === 1 && state.submits === 1,
      `shift+CR ${state.shiftEnters}, submits ${state.submits}, newlines ${state.newlines}`,
    );
    // the two things the plan's P5 row asks for that are not about keys at all
    const rows = session.screen.lines();
    const dangling = rows.filter((r) => /^\p{M}/u.test(r.trimStart())).length;
    probe.check(
      "no painted row starts with a dangling combining mark, so nothing split a cluster at the wrap",
      dangling === 0,
      `${rows.length} painted rows checked with Intl.Segmenter; the phone's own shaping is a manual step`,
    );
    const floodChars = 200;
    const flood = await runSession(child, {
      term: "xterm-256color",
      colorterm: "truecolor",
      feed: Array.from({ length: floodChars }, (_, i) => (i % 40 === 39 ? "\n" : "x")),
      tag: "flood",
      feedDelay: 0,
      ttl: 9000,
    });
    probe.check(
      `all ${floodChars} characters survive a burst, even though stdin coalesces them into fewer events`,
      flood.started && flood.state?.chars === floodChars && flood.state.keys < floodChars,
      `${flood.state?.keys} handler calls carried ${flood.state?.chars} characters in ${flood.feedMs}ms — counting events instead of characters invents lost keystrokes`,
    );
    const paced = await runSession(child, {
      term: "xterm-256color",
      colorterm: "truecolor",
      feed: Array.from({ length: floodChars }, (_, i) => (i % 40 === 39 ? "\n" : "x")),
      tag: "paced",
      feedDelay: 3,
      ttl: 9000,
    });
    probe.check(
      "paced keystrokes are all accounted for while the frame repaints between them",
      paced.started && paced.state?.chars === floodChars,
      `${paced.state?.keys} events for ${paced.state?.chars} characters over ${paced.feedMs}ms, ${paced.state?.frames} frames painted`,
    );
    // the plan's P5 condition asks the TUI to hold at most 4 repaints a second under token streaming. Ink 8 has no such
    // cap: it schedules a render for every state change. So the number below is a finding, and the finding is that the
    // throttle belongs to the app — worth knowing before M-T is written, not after.
    const paintRate = (1000 * (paced.state?.frames ?? 0)) / Math.max(1, paced.feedMs);
    probe.note(
      "burstVsPaced",
      `burst: ${flood.state?.keys} events / ${flood.state?.chars} chars; paced: ${paced.state?.keys} events /
 ${paced.state?.chars} chars; Ink painted ${paced.state?.frames} times during the paced run (${paintRate.toFixed(1)}/s)`,
    );
    probe.check(
      "repaint stays at or under the 4 fps P5's pass condition names (Ink caps nothing, so the app must)",
      paintRate <= 4,
      `≈${paintRate.toFixed(1)} repaints/s here against the 4/s the condition names — a measurement, not a broken probe; M-T owns the throttle and P-011 is queued`,
    );
    probe.note("keyLog", keys.map((k) => `${k.ch}${k.name ? `(${k.name})` : ""}`).join(" "));

    // an 8-colour environment: does the paint stay inside what a plain terminal can show?
    const dim = await runSession(child, {
      term: "xterm",
      colorterm: undefined,
      feed: ["\x03"],
      tag: "dim",
    });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: this is checking escape bytes, which is the whole claim
    const truecolor = /\x1b\[38;2;/.test(dim.raw);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: same
    const indexed = /\x1b\[38;5;\d+m/.test(dim.raw);
    const rl = await runSession(stageChild("readline-tui.mjs"), {
      term: "xterm-256color",
      colorterm: "truecolor",
      feed: ["\x0a", "\x1b[13;2u", "\r", "\x01", "\x1b[D"],
      tag: "readline",
      endWith: "kill",
    });
    probe.check(
      "the node:readline fallback distinguishes the same three keys Ink does",
      rl.started &&
        rl.state?.newlines === 2 &&
        rl.state?.submits === 1 &&
        rl.state?.shiftEnters === 1 &&
        rl.state?.caret === 2,
      `fallback saw newlines ${rl.state?.newlines}, submits ${rl.state?.submits}, shift+enter ${rl.state?.shiftEnters}, caret moves ${rl.state?.caret} — the control keeps the same composer rule without a dependency`,
    );
    probe.check(
      "with TERM=xterm and no COLORTERM the stream carries no truecolour",
      dim.started && !truecolor,
      `truecolour ${truecolor ? "present" : "absent"}, 256-colour escapes ${indexed ? "present" : "absent"} — whether that is *readable* at 8 colours is DESIGN_SYSTEM's claim, this only shows Ink obeys the environment`,
    );
  }
}

probe.manual(
  "run P5 in the terminal you will actually use on the phone",
  `npm run probe:p5 inside Termux, then read the painted frame at 40 columns in that terminal. The numbers above say
      nothing crossed the edge; they cannot say whether the layout is readable. Repeat inside tmux if you use it, since
      tmux needs a terminal-features extkeys entry before kitty sequences reach the app at all.`,
);
probe.manual(
  "close O-051 and O-006 with the device in hand",
  `O-051: press Shift+Enter in Termux's terminal and in any other terminal you use, and write down whether the app could
      tell it from Enter. O-006: run the same frame with TalkBack on and say whether Ink's screen-reader path is usable.
      Both answers become DECISIONS.md rows; a "no" on O-051 changes nothing in code, because Ctrl+J is already the
      guaranteed path.`,
);
probe.manual(
  "type Bengali into the composer and edit it backwards",
  "Rendering was measured above. Deleting a combining-mark cluster one at a time with Backspace is not, and D-055's rule " +
    "(never promise grid alignment for Indic text) is what this step confirms we can keep.",
);

report(probe, args);

/** Runs one child under a pty, feeds keystrokes, and reads back what the child recorded. */
async function runSession(
  script,
  { term, colorterm, feed, tag, exitOnCtrlC = true, endWith = "self", feedDelay = 140, ttl = 4000 },
) {
  const name = tag ?? `${term}${colorterm ? "-cc" : "-dim"}`;
  const log = path.join(os.tmpdir(), `crabby-p5-${name}.log`);
  rmSync(log, { force: true });
  writeFileSync(log, "");
  const env = {
    ...process.env,
    COLUMNS: String(COLS),
    LINES: String(ROWS),
    TERM: term,
    PROBE_LOG: log,
    PROBE_TTL: String(ttl),
    PROBE_EXIT_ON_CTRL_C: exitOnCtrlC ? "1" : "0",
  };
  if (colorterm) env.COLORTERM = colorterm;
  else delete env.COLORTERM;
  // `script` gives us a pty; without the inner `stty` the window size arrives as 0x0 in a sandbox with no terminal
  const cmd = `stty rows ${ROWS} cols ${COLS} ; exec ${process.execPath} '${script}'`;
  const proc = spawn("script", ["-q", "-c", cmd, "/dev/null"], { env });
  const screen = new VtScreen({ cols: COLS, rows: ROWS });
  let raw = "";
  proc.stdout.on("data", (b) => {
    const s = b.toString("utf8");
    raw += s;
    screen.write(s);
  });
  proc.stderr.on("data", (b) => {
    raw += b.toString("utf8");
  });
  const exited = new Promise((resolve) => {
    proc.on("exit", (code, signal) => resolve({ code, signal }));
    setTimeout(() => resolve({ code: null, signal: "probe-timeout" }), ttl + 12000).unref();
  });
  await sleep(800);
  const fedAt = Date.now();
  for (const k of feed) {
    proc.stdin.write(k);
    if (feedDelay) await sleep(feedDelay);
  }
  const fedDoneAt = Date.now();
  if (endWith === "kill") proc.kill("SIGKILL");
  // wait for the child to end on its own otherwise: a state read early is a state read *half-written*, and a probe
  // that measures "62 of 200 keys" because it stopped listening is worse than no measurement
  const exit = await exited;
  await sleep(150);
  const text = readIf(log);
  const stateLine =
    text
      .split("\n")
      .filter((l) => l.startsWith("STATE"))
      .pop() ?? "";
  const keysLine =
    text
      .split("\n")
      .filter((l) => l.startsWith("KEYS "))
      .pop() ?? "";
  return {
    started: text.includes("START"),
    screen,
    raw,
    log: text,
    tail: raw.slice(-400),
    exit,
    state: parse(stateLine.split(" ").slice(2).join(" ")),
    keys: parse(keysLine.slice(5)) ?? [],
    feedMs: fedDoneAt - fedAt,
  };
}

function readIf(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function parse(json) {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
