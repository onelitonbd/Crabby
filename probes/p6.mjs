// P6 — what Android does to a long-lived process. Nothing here can answer the phone's questions (Doze, battery
// optimisation, a task-swipe kill), so those are manual steps and the probe reports `blocked` until a device answers.
// But two things a shell *can* measure are the preconditions for all of them: that the Gateway outlives the shell that
// started it, and that a signal stops it cleanly instead of leaving a half-written file behind.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { envFacts, Probe, parseArgs, report, stageChild } from "./lib.mjs";

const probe = new Probe(
  "P6",
  "process lifetime: survives the parent shell, stops cleanly on a signal",
);
const args = parseArgs();
const dir = mkdtempSync(path.join(os.tmpdir(), "crabby-p6-"));
const child = stageChild("lifecycle.mjs");

console.log(`P6 · ${envFacts().node} on ${envFacts().platform}`);

// 1. detached: the launcher exits while the child keeps serving — the shape of "start it and walk away" on a phone
const detached = await launch({ detached: true });
await sleep(900);
const alive = await fetch(`http://127.0.0.1:${detached.port}/`, {
  signal: AbortSignal.timeout(1500),
})
  .then((r) => r.json())
  .catch(() => null);
probe.check(
  "a detached process keeps serving after its parent exits",
  Boolean(alive?.ok) && detached.launcherGone,
  alive
    ? `pid ${alive.pid} answering on ${detached.port}; the launcher that started it exited first`
    : "nothing answered — on Termux this is what `termux-wake-lock` and a service are for",
);
const beats = (readFileSync(detached.marker, "utf8").match(/beat/g) ?? []).length;
probe.check(
  "it kept working without a controlling terminal",
  beats > 0,
  `${beats} beats written while detached`,
);

// 2. a signal must flush, not truncate — a different process, a different marker, so nothing overlaps
const signalled = await launch({ detached: false });
const t0 = Date.now();
signalled.proc.kill("SIGTERM");
const exit = await signalled.exited;
const text = readFileSync(signalled.marker, "utf8");
const flushed = /SIGTERM after (\d+)ms — flushed pending writes/.exec(text);
probe.check(
  "SIGTERM is handled: it stops accepting work, flushes, and exits 0",
  Boolean(flushed) && exit.code === 0,
  flushed
    ? `flushed after ${flushed[1]}ms of life, exit code ${exit.code}`
    : `no SIGTERM line in the marker (exit ${exit.code}/${exit.signal ?? "no signal"}) — the handler never ran`,
);
probe.check(
  "the port is released once the signal has been handled",
  !(await fetch(`http://127.0.0.1:${signalled.port}/`, { signal: AbortSignal.timeout(700) })
    .then(() => true)
    .catch(() => false)),
  `answered for ${Date.now() - t0}ms after the kill, then closed`,
);

// and the honest limit
try {
  const pid = Number(/pid=(\d+)/.exec(readFileSync(detached.marker, "utf8"))?.[1]);
  process.kill(pid, "SIGKILL");
} catch {
  /* the detached child is already gone, or this is not a machine where kill works */
}

probe.block(
  "what the phone does to this process is unknown until a device answers",
  "Doze, battery optimisation, a task-swipe kill and termux-wake-lock cannot be simulated in a container. This run is " +
    "recorded as blocked, not passed — the harness's rule for a missing precondition (probes/README.md)",
);

probe.manual(
  "start the probe's child on the phone, background it, and wait",
  `termux-wake-lock, then npm run probe:p6 and watch the marker: tail -f $TMPDIR/crabby-p6-*/state.log — on Termux that
      is /data/data/com.termux/files/usr/tmp. Write down whether the beats stop when the screen goes off, and how long after.`,
);
probe.manual(
  "swipe Termux away in the recents screen and look at the port",
  "if the Gateway dies with the app, that answers the 'one command, still running tomorrow' promise in PROJECT_BRIEF's " +
    "local-first rule; if it survives, note whether the Termux notification was up, because that is the difference",
);
probe.manual(
  "say whether the battery-optimisation exclusion has to be asked for",
  "the app must tell a person how to get exempted rather than assume it (docs/DEVELOPMENT.md §11). Whatever this " +
    "changes lands in DECISIONS.md before M-G writes the start script",
);

report(probe, args);
rmSync(dir, { recursive: true, force: true });

async function launch({ detached }) {
  const marker = path.join(dir, detached ? "detached.log" : "signal.log");
  const portFile = path.join(dir, detached ? "detached.port" : "signal.port");
  let proc;
  let launcherGone = false;
  if (detached) {
    // spawned through a launcher that exits immediately, so "still answering" cannot be the parent keeping it alive
    const launcher = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { spawn } from "node:child_process";
const c = spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(child)}, ${JSON.stringify(marker)}, ${JSON.stringify(portFile)}], { detached: true, stdio: "ignore" });
c.unref();
process.exit(0);`,
      ],
      { stdio: "ignore" },
    );
    await new Promise((resolve) => launcher.on("exit", resolve));
    launcherGone = true;
    proc = { pid: 0, kill: () => {} };
  } else {
    proc = spawn(process.execPath, [child, marker, portFile], { stdio: "ignore" });
  }
  const exited = new Promise((resolve) => {
    proc.on?.("exit", (code, signal) => resolve({ code, signal }));
    setTimeout(() => resolve({ code: null, signal: "probe-timeout" }), 6000).unref();
  });
  for (let i = 0; i < 60; i++) {
    if (readIf(portFile)) break;
    await sleep(50);
  }
  return { proc, marker, port: Number(readIf(portFile) ?? 0), exited, launcherGone };
}

function readIf(file) {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}
