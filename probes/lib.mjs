// M0 probe harness. Throwaway by design (docs/ROADMAP.md section 2): nothing in `probes/` is imported by product
// code, and nothing here may assume a laptop. The harness exists so a probe run on a phone produces a machine-readable
// record instead of a paragraph, because "we think Termux is fine" is how an expensive rewrite gets scheduled.
//
// Exit codes follow the CLI contract's shape (D-063) so the same muscle memory applies:
//   0  every check passed on this machine
//   1  a check failed — the assumption is wrong, record it and change the plan
//   2  blocked: a precondition or a human/device step is missing, which is NOT a pass
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const PROBE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_DIR = path.dirname(PROBE_DIR);
export const OUT_DIR = path.join(PROBE_DIR, "out");
export const DEPS_DIR = path.join(PROBE_DIR, ".deps");

/** Termux is detected from the prefix, not from `platform`: Android under Node still reports `linux`. */
export function isTermux(env = process.env) {
  const prefix = env.PREFIX ?? "";
  return prefix.includes("com.termux") || Boolean(env.TERMUX_VERSION);
}

export function envFacts() {
  return {
    node: process.version,
    v8: process.versions.v8,
    platform: `${process.platform}/${process.arch}`,
    kernel: `${os.type()} ${os.release()}`,
    termux: isTermux(),
    terminal: {
      term: process.env.TERM ?? null,
      colorterm: process.env.COLORTERM ?? null,
      cols: process.stdout.columns ?? null,
      rows: process.stdout.rows ?? null,
    },
    cpus: os.cpus().length,
    totalMemMB: Math.round(os.totalmem() / 1024 / 1024),
    freeMemMB: Math.round(os.freemem() / 1024 / 1024),
  };
}

const SYMBOLS = { pass: "✓", fail: "✗", blocked: "▢", manual: "…" };

export class Probe {
  constructor(id, title) {
    this.id = id;
    this.title = title;
    this.checks = [];
    this.notes = {};
    this.manualSteps = [];
    this.startedAt = Date.now();
  }

  note(key, value) {
    this.notes[key] = value;
    return value;
  }

  /** Records an observation with a verdict. A check never throws: a probe that stops at the first failure reports
   *  one problem, and the point of M0 is to see the whole picture in one run. */
  check(name, ok, detail = "") {
    this.checks.push({ name, ok: Boolean(ok), detail });
    const mark = ok ? SYMBOLS.pass : SYMBOLS.fail;
    console.log(`  ${mark} ${name}${detail ? ` — ${detail}` : ""}`);
    return Boolean(ok);
  }

  /** A precondition that is missing is not a failure of the assumption; it is an absence of evidence. Reported as
   *  blocked so nobody can read the run as a pass. */
  block(name, why) {
    this.checks.push({ name, ok: false, blocked: true, detail: why });
    console.log(`  ${SYMBOLS.blocked} ${name} — blocked: ${why}`);
  }

  /** Steps only a person with the phone can do. They are part of the record, not a footnote. */
  manual(question, howto) {
    this.manualSteps.push({ question, howto });
    console.log(`  ${SYMBOLS.manual} you: ${question}\n      ${howto}`);
  }

  get status() {
    if (this.checks.some((c) => c.blocked)) return "blocked";
    if (this.checks.some((c) => !c.ok)) return "fail";
    return this.manualSteps.length && !this.checks.length ? "manual-only" : "pass";
  }

  finish() {
    const result = {
      id: this.id,
      title: this.title,
      status: this.status,
      durationMs: Date.now() - this.startedAt,
      env: envFacts(),
      notes: this.notes,
      checks: this.checks,
      manualSteps: this.manualSteps,
      recordedAt: new Date().toISOString(),
    };
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(path.join(OUT_DIR, `${this.id}.json`), `${JSON.stringify(result, null, 2)}\n`);
    const counts = {
      pass: this.checks.filter((c) => c.ok).length,
      fail: this.checks.filter((c) => !c.ok && !c.blocked).length,
      blocked: this.checks.filter((c) => c.blocked).length,
    };
    console.log(
      `${this.id} → ${result.status} (${counts.pass} passed, ${counts.fail} failed, ${counts.blocked} blocked)`,
    );
    if (!isTermux()) {
      console.log(
        `  note: this is ${process.platform}/${process.arch}, not Termux. A result recorded here proves the probe\n` +
          `        works; it cannot prove the assumption. See probes/RESULTS.md for the column a device fills in.`,
      );
    }
    return result;
  }
}

/** Installs a dependency for probing purposes only, under `probes/.deps`, so M0 never smuggles a dependency into the
 *  product manifest. If the install is what is being tested (P3), the probe passes `npmArgs` to control it. */
export async function ensureDep(name, range, { npmArgs = [], quiet = true } = {}) {
  const dest = DEPS_DIR;
  const manifest = path.join(dest, "package.json");
  mkdirSync(dest, { recursive: true });
  if (!existsSync(manifest)) {
    writeFileSync(
      manifest,
      `${JSON.stringify({ name: "crabby-m0-probe-deps", private: true, version: "0.0.0" }, null, 2)}\n`,
    );
  }
  const target = path.join(dest, "node_modules", name);
  const start = Date.now();
  let installed = existsSync(target);
  if (!installed) {
    const args = [
      "install",
      "--prefix",
      dest,
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      ...npmArgs,
    ];
    // `no-log-file` keeps npm from writing a log into the user's home; a phone may not want it (D-065's cleanup rule)
    args.push("--no-logfile");
    args.push(`${name}@${range}`);
    try {
      execFileSync("npm", args, {
        cwd: dest,
        encoding: "utf8",
        stdio: quiet ? "pipe" : "inherit",
        env: { ...process.env, npm_config_update_notifier: "false" },
      });
      installed = existsSync(target);
    } catch (err) {
      return {
        ok: false,
        reason: `npm install failed: ${String(err.message).split("\n")[0]}`,
        installMs: Date.now() - start,
        target,
      };
    }
  }
  if (!installed)
    return { ok: false, reason: "install reported success but the package is absent", target };
  let mod = null;
  try {
    mod = await import(path.join(target, findEntry(target)));
  } catch (err) {
    return {
      ok: false,
      reason: `import failed: ${err.message}`,
      target,
      installMs: Date.now() - start,
    };
  }
  return { ok: true, mod, target, installMs: Date.now() - start };
}

function findEntry(pkgDir) {
  const manifest = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  // two shapes carry the same information and Ink uses the second: `exports: { ".": {...} }` or a bare `{...}` map.
  // Reading `main` alone is not enough for either, and pointing at a file that does not exist is a confusing failure.
  const exp = manifest.exports;
  const map =
    typeof exp === "string"
      ? exp
      : (exp?.["."] ?? (exp?.default || exp?.import || exp?.require ? exp : undefined));
  const dot = typeof map === "string" ? map : (map?.import ?? map?.require ?? map?.default);
  if (typeof dot === "string") return dot.replace(/^\.\//, "");
  return manifest.main ?? "index.js";
}

/** Spawns a child that prints its own readiness line, then waits for it. Used by P2 and P3 so the parent can kill a
 *  live process — the crash case is the whole point, and a fake "crashed mid-write" is not a crash. */
export function spawnReady(scriptPath, { args = [], readyMarker = "READY", env = {} } = {}) {
  const child = spawn(process.execPath, [scriptPath, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  const out = { stdout: "", stderr: "" };
  child.stdout.on("data", (b) => {
    out.stdout += b.toString();
  });
  child.stderr.on("data", (b) => {
    out.stderr += b.toString();
  });
  const ready = new Promise((resolve, reject) => {
    const t = setTimeout(
      () =>
        reject(
          new Error(`child did not report ${readyMarker}; stderr: ${out.stderr.slice(0, 400)}`),
        ),
      30_000,
    );
    const tick = setInterval(() => {
      if (out.stdout.includes(readyMarker)) {
        clearTimeout(t);
        clearInterval(tick);
        resolve(out.stdout.split("\n").find((l) => l.startsWith(readyMarker)) ?? readyMarker);
      }
    }, 25);
    child.once("exit", (code) => {
      clearTimeout(t);
      clearInterval(tick);
      reject(new Error(`child exited early (code ${code}); stderr: ${out.stderr.slice(0, 400)}`));
    });
  });
  return { child, ready, out };
}

/** ESM resolves bare specifiers from the importing file's directory upward, so a child script that must see
 *  `probes/.deps/node_modules` has to be run from inside `probes/.deps`. Staging it there keeps the install local to
 *  M0 and keeps the product manifest clean. */
export function stageChild(name) {
  const src = path.join(PROBE_DIR, "children", name);
  mkdirSync(DEPS_DIR, { recursive: true });
  const dest = path.join(DEPS_DIR, name);
  writeFileSync(dest, readFileSync(src));
  return dest;
}

export function parseArgs(argv = process.argv.slice(2)) {
  return { json: argv.includes("--json"), device: argv.includes("--device") };
}

/** A probe's whole output is one JSON object on stdout when `--json` is set, so a phone run can be pasted into an
 *  issue or piped into `probes/RESULTS.md` tooling without editing prose. */
export function report(probe, { json }) {
  const result = probe.finish();
  if (json) console.log(JSON.stringify(result));
  const code =
    result.status === "pass" || result.status === "manual-only"
      ? 0
      : result.status === "blocked"
        ? 2
        : 1;
  process.exitCode = code;
  return result;
}
