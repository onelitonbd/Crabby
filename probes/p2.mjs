// P2 — Fastify as the Gateway on Termux (D-069): loopback bind, one /health, one SSE stream through `reply.hijack()`,
// and a clean restart after a forced kill. Pass condition in docs/ROADMAP.md §2 says "survives a forced process kill
// and restarts cleanly", so this probe kills its own child with SIGKILL — a graceful shutdown would prove nothing.
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { ensureDep, envFacts, Probe, parseArgs, report, spawnReady, stageChild } from "./lib.mjs";

const probe = new Probe(
  "P2",
  "Fastify Gateway on loopback: /health, hijacked SSE, restart after SIGKILL",
);
const args = parseArgs();

console.log(`P2 · ${envFacts().node} on ${envFacts().platform}`);

const dep = await ensureDep("fastify", "5.12.5");
if (!dep.ok) {
  probe.block(
    "fastify 5.12.5 installable",
    `${dep.reason} — on a device run \`npm install --prefix probes/.deps fastify@5.12.5\` once and re-run`,
  );
} else {
  probe.check(
    "fastify installs and imports",
    typeof dep.mod?.default === "function",
    dep.installMs ? `${dep.installMs}ms to install` : "cached from a previous run",
  );

  // staged next to the install so the child can resolve `fastify` (see probes/lib.mjs `stageChild`)
  const child = stageChild("gateway.mjs");

  // first life: health + stream
  const run1 = spawnReady(child, { readyMarker: "READY" });
  let port1 = 0;
  try {
    const line = await run1.ready;
    port1 = Number(line.split(" ")[1]);
  } catch (err) {
    probe.check("server bound to 127.0.0.1 and reported a port", false, err.message);
  }
  if (port1) {
    probe.check("server bound to 127.0.0.1 and reported a port", port1 > 0, `127.0.0.1:${port1}`);
    const health = await fetchJson(`http://127.0.0.1:${port1}/health`);
    probe.check(
      "GET /health answers JSON",
      health?.ok === true,
      JSON.stringify(health).slice(0, 120),
    );

    const t0 = Date.now();
    const events = await readSse(`http://127.0.0.1:${port1}/events`, 5, 4000);
    probe.check(
      "SSE through reply.hijack() delivers ordered events",
      events.count >= 5,
      `${events.count} events, first in ${events.firstByteMs}ms, total ${Date.now() - t0}ms`,
    );
    probe.check(
      "event ids are monotonic (the per-task seq contract starts from a working transport)",
      events.ids.length >= 5 && events.ids.every((v, i) => v === i + 1),
      events.ids.join(","),
    );

    // the kill: SIGKILL, then the port must be free and a restart must succeed
    const pid = run1.child.pid;
    run1.child.kill("SIGKILL");
    await sleep(250);
    probe.check("child is gone after SIGKILL", exited(run1.child), `pid ${pid}`);
    const addrHeld = await fetchJson(`http://127.0.0.1:${port1}/health`, 600);
    probe.check(
      "the killed process holds nothing on the port",
      addrHeld === null,
      addrHeld ? "still answering" : "connection refused",
    );

    const run2 = spawnReady(child, { readyMarker: "READY" });
    try {
      const line2 = await run2.ready;
      probe.check("restart binds again with no cleanup step", Boolean(line2), String(line2));
    } catch (err) {
      probe.check("restart binds again with no cleanup step", false, err.message);
    }
    run2.child.kill("SIGKILL");
    await sleep(120);
  }
}

probe.manual(
  "run P2 on Termux and record both numbers",
  `npm run probe:p2 on the phone, then note the install time and whether \`reply.hijack()\` streamed. A container
      result is not a Termux result (docs/DEVELOPMENT.md §12): record the device row in probes/RESULTS.md.`,
);
probe.manual(
  "confirm nothing else on the phone can reach the port",
  `while the probe is running, from another app try http://127.0.0.1:<port>/health — Termux has no per-process sandbox
      (SECURITY.md §15, O-065), so the honest expectation is "another process in Termux could reach it".`,
);

report(probe, args);

function exited(child) {
  try {
    execFileSync("kill", ["-0", String(child.pid)], { stdio: "ignore" });
    return false;
  } catch {
    return true;
  }
}

async function fetchJson(url, timeoutMs = 3000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return await res.json();
  } catch {
    return null;
  }
}

async function readSse(url, want, timeoutMs) {
  const count = { count: 0, ids: [], firstByteMs: 0 };
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.body) return count;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const t0 = Date.now();
    while (count.count < want && Date.now() - t0 < timeoutMs) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!count.firstByteMs) count.firstByteMs = Date.now() - t0;
      buf += decoder.decode(value, { stream: true });
      let idx = buf.indexOf("\n\n");
      while (idx >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const id = /^id: (\d+)$/m.exec(frame);
        if (id) {
          count.count += 1;
          count.ids.push(Number(id[1]));
        }
        idx = buf.indexOf("\n\n");
      }
    }
  } catch {
    /* partial results are the answer; the check below reads them */
  }
  return count;
}
