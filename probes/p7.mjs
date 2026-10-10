// P7 — the extension sandbox, probed with the enemy in mind. The plan (D-041, O-008) says an extension is untrusted
// code and the host must be able to say no; the mechanism on the table is `node:vm`. This probe asks what that
// mechanism actually denies a hostile extension, and what it silently does *not* — because the answer decides whether
// M-E ships `node:vm`, a worker, or a documented "deterrence only" warning in the install step.

import { setTimeout as sleep } from "node:timers/promises";
import vm from "node:vm";
import { envFacts, Probe, parseArgs, report } from "./lib.mjs";

const probe = new Probe("P7", "hostile extension against the node:vm sandbox the plan leans on");
const args = parseArgs();

console.log(`P7 · ${envFacts().node} on ${envFacts().platform}`);

const audit = [];

/** The host API, with the two rules the plan already commits to: workspace-relative paths only (D-034) and no shell
 *  without an approval the host owns. Everything a sandbox cannot see is simply not passed in. */
const api = {
  fs: {
    read(p) {
      audit.push(`fs.read ${p}`);
      if (typeof p !== "string" || p.startsWith("/") || p.includes("..")) {
        throw new Error(`fs.read: "${p}" is outside the workspace (D-034)`);
      }
      return `contents of ${p}`;
    },
    write(p, data) {
      audit.push(`fs.write ${p} ${String(data).length}B`);
      if (typeof p !== "string" || p.startsWith("/") || p.includes(".."))
        throw new Error("fs.write: outside the workspace");
      return true;
    },
  },
  net: {
    fetch(url) {
      audit.push(`net.fetch ${url}`);
      if (!/^https?:/.test(String(url))) throw new Error("net.fetch: only http(s)");
      return Promise.resolve({ ok: true, url });
    },
  },
  shell: {
    run(cmd) {
      audit.push(`shell.run ${cmd}`);
      throw new Error("shell.run needs an approval the host grants, not the extension");
    },
  },
};
for (const group of Object.values(api)) Object.freeze(group);
Object.freeze(api);

function makeContext() {
  const logs = [];
  return {
    logs,
    context: vm.createContext(
      { crabby: api, note: (v) => logs.push(String(v)) },
      { codeGeneration: { strings: false, wasm: false } },
    ),
  };
}

function attempt(code, opts = {}) {
  const { context, logs } = makeContext();
  try {
    const value = vm.runInContext(`"use strict";\n${code}`, context, {
      timeout: opts.timeout ?? 2000,
      ...opts,
    });
    return { value, logs, reachable: isHostish(value) };
  } catch (err) {
    return { error: err, code: err?.code ?? "", logs };
  }
}

function isHostish(value) {
  // anything the sandbox hands back that has `.pid` and `env` is the host process, and that is the failure to detect
  try {
    return Boolean(value) && typeof value === "object" && "pid" in value && "env" in value;
  } catch {
    return false;
  }
}

// 1. what is simply not there
const ambient = attempt(
  `[typeof require, typeof module, typeof process, typeof fetch, typeof Worker, typeof Buffer].join(",")`,
);
probe.check(
  "the sandbox has no require, module, process, fetch, Worker or Buffer in scope",
  !ambient.error && ambient.value === "undefined,undefined,undefined,undefined,undefined,undefined",
  String(ambient.value ?? ambient.error?.message),
);
const ownKeys = attempt(
  `Object.keys(globalThis).filter((k) => /process|require|Worker|Buffer|child/i.test(k)).join(",") || "none"`,
);
probe.check(
  "nothing host-shaped is even a name on the sandbox's global object",
  ownKeys.value === "none",
  String(ownKeys.value ?? ownKeys.error?.message),
);

// 2. no string→code at all: the two classic doors and the Function constructor itself
const evalDoor = attempt(`eval("1+1")`);
const funcDoor = attempt(`Function("return process")()`);
const ctorDoor = attempt(`(()=>{}).constructor("return process")()`);
const protoDoor = attempt(
  `Object.getPrototypeOf({}).constructor.constructor("return globalThis.process")()`,
);
const refused = (r) =>
  Boolean(r.error) && /code generation from strings/i.test(String(r.error.message));
probe.check(
  "eval, new Function, and Function via the prototype chain are all refused (codeGeneration.strings:false)",
  [evalDoor, funcDoor, ctorDoor, protoDoor].every(refused),
  [
    ["eval", evalDoor],
    ["Function", funcDoor],
    ["constructor", ctorDoor],
    ["proto chain", protoDoor],
  ]
    .map(
      ([name, r]) =>
        `${name}: ${refused(r) ? "refused" : String(r.error?.message ?? `returned ${JSON.stringify(r.value)}`)}`,
    )
    .join("; "),
);
const wasmDoor = attempt(`new WebAssembly.Module(new Uint8Array(0))`);
probe.check(
  "WebAssembly exists as a name but compiling is refused too (codeGeneration.wasm:false)",
  /disallowed by embedder/i.test(String(wasmDoor.error?.message)),
  String(wasmDoor.error?.message ?? "compiling worked — that would need a different sandbox"),
);
probe.check(
  "no attempt handed back the host process object",
  ![evalDoor, funcDoor, ctorDoor, protoDoor].some((r) => r.reachable),
  "reachable-by-shape check on every return value",
);

// 3. dynamic import, the door that looks harmless because it is not `require`
const dyn = makeContext();
let dynOutcome = "no outcome";
try {
  vm.runInContext(
    `globalThis.outcome = "pending";
     import("node:fs").then(() => { globalThis.outcome = "LOADED the host fs module" }, (e) => { globalThis.outcome = "BLOCKED:" + (e.code ?? e.message) });`,
    dyn.context,
  );
  await sleep(80);
  dynOutcome = String(vm.runInContext("globalThis.outcome", dyn.context));
} catch (err) {
  dynOutcome = `BLOCKED:${err.code ?? err.message}`;
}
probe.check(
  "dynamic import() from inside the sandbox cannot load a host module",
  dynOutcome.startsWith("BLOCKED"),
  dynOutcome === "pending"
    ? "the promise never settled, which is a pass by silence — re-check this one on the device"
    : dynOutcome,
);

// 4. an infinite loop must be interruptible, or D-074's per-call limits are fiction
const t0 = Date.now();
const spin = attempt(`while (true) {}`, { timeout: 250 });
const elapsed = Date.now() - t0;
probe.check(
  "a runaway extension is stopped by the run timeout, and the host survives it",
  spin.error?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT" && elapsed < 3000,
  `${elapsed}ms to interrupt \`while(true){}\`; error ${spin.error?.code ?? "none"}`,
);
probe.check(
  "the timeout number is honoured within a tolerance (the limits table is enforceable)",
  elapsed >= 200 && elapsed <= 1500,
  `asked for 250ms, took ${elapsed}ms`,
);

// 5. the doors that are supposed to be host-checked, not sandbox-checked
const traversal = attempt(
  `(() => { try { return crabby.fs.read("/etc/passwd") } catch (e) { return "refused: " + e.message } })()`,
);
const dotdot = attempt(
  `(() => { try { return crabby.fs.read("../../home/.ssh/id_ed25519") } catch (e) { return "refused: " + e.message } })()`,
);
const inside = attempt(`crabby.fs.read("notes/todo.md")`);
probe.check(
  "the host's own path rule holds the line the sandbox cannot (D-034)",
  /refused/.test(String(traversal.value)) &&
    /refused/.test(String(dotdot.value)) &&
    inside.value === "contents of notes/todo.md",
  `${String(traversal.value).slice(0, 60)} | ${String(inside.value)}`,
);
const escapedShell = attempt(
  `(() => { try { return crabby.shell.run("rm -rf /") } catch (e) { return "refused: " + e.message } })()`,
);
probe.check(
  "shell.run is unreachable without an approval the extension cannot grant itself",
  /refused/.test(String(escapedShell.value)),
  String(escapedShell.value).slice(0, 90),
);
probe.check(
  "every call the extension made is visible to the host afterwards (the audit trail is real)",
  audit.length >= 4 && audit.some((l) => l.startsWith("shell.run rm -rf")),
  `${audit.length} audited calls: ${audit.slice(0, 3).join(" / ")}`,
);

// 6. can the extension widen itself?
const tamper = attempt(
  `(() => { try { crabby.fs.read = () => "host secrets"; return "assigned" } catch (e) { return "refused: " + e.message } })()`,
);
const replace = attempt(
  `(() => { try { globalThis.crabby = { fs: { read: () => "pwned" } }; return "replaced" } catch (e) { return "refused" } })()`,
);
probe.check(
  "a frozen host API cannot be swapped out from inside the sandbox",
  /refused/.test(String(tamper.value)) && api.fs.read !== undefined,
  `assign to frozen group: ${String(tamper.value).slice(0, 60)}`,
);
probe.check(
  "overwriting `crabby` in the sandbox changes only the sandbox's copy",
  String(replace.value) === "replaced" && api.fs.read.name === "read",
  "the host object it replaced was never the host's",
);

// 7. what this does not cover, recorded rather than glossed
probe.note(
  "ceiling",
  "same-uid, same-kernel: a sandboxed extension still shares the filesystem with the host process. SECURITY.md §15 " +
    "already says a Termux process can read anything in the profile, so this is deterrence and audit, not isolation.",
);
probe.note(
  "hostApisExposed",
  "crabby.fs.read/write, crabby.net.fetch, crabby.shell.run, note() — nothing else was passed in",
);
probe.manual(
  "decide O-008 with these seven results in hand",
  `if the sandbox refuses everything above, the plan can keep node:vm for *first-party* extensions and mark third-party
      ones as deterrence; if any of them reaches the host, M-E moves to worker_threads with no require and a message
      boundary. Write the choice in probes/RESULTS.md and the decision row goes in DECISIONS.md.`,
);
probe.manual(
  "try the hostile script on the phone too",
  `the container's Node and Termux's Node can differ (P1 decides which one is real), so run npm run probe:p7 on the
      device and paste both outcome lines — a pass on one and a fail on the other is the answer, not a surprise`,
);

report(probe, args);
