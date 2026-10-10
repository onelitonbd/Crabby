// P3 — storage, on the terms DECISIONS.md §5 reported and this project has never reproduced.
//
// What the first run of this probe found, before anyone touched a phone: `better-sqlite3` 13 does not compile by
// default. The tarball ships eight prebuilt bindings, and `lib/binding.js` prefers `prebuilds/<target>.node` over a
// local `build/Release` build, with `target` built as `${isLinuxMusl() ? "linuxmusl" : process.platform}-${process.arch}`
// where `isLinuxMusl()` is "no glibc in the process report". Termux has no glibc, so the loader reaches for the *musl*
// prebuild on a bionic runtime — and a hand-built binding is ignored while `prebuilds/` exists. That makes the plan's
// "builds from source" both necessary and non-obvious on the device, so P3 measures four things: which binding loaded,
// what the loader's rule says for Termux-shaped facts, whether a compile by hand produces a binding that works when
// loaded by path, and whether the database survives SIGKILL in the middle of a write.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  DEPS_DIR,
  ensureDep,
  envFacts,
  Probe,
  parseArgs,
  report,
  spawnReady,
  stageChild,
} from "./lib.mjs";

const probe = new Probe(
  "P3",
  "better-sqlite3: how it loads, whether it compiles, WAL, and a crash during a write",
);
const args = parseArgs();
const BATCH = 100;
const ROWS = 40000;
let pkgDir = path.join(DEPS_DIR, "node_modules", "better-sqlite3");
const runNode = (code) =>
  spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8",
    cwd: DEPS_DIR,
  });

console.log(`P3 · ${envFacts().node} on ${envFacts().platform}`);

const dep = await ensureDep("better-sqlite3", "13.0.3");
if (!dep.ok) {
  probe.block(
    "better-sqlite3 13.0.3 installed",
    `${dep.reason} — on a device: npm install --prefix probes/.deps better-sqlite3@13.0.3`,
  );
} else {
  pkgDir = dep.target;
  probe.check(
    "the package installs",
    true,
    dep.installMs ? `${dep.installMs}ms` : "cached from a previous run",
  );

  // 1. the binding that actually loaded here, read off the live process
  const loaded = runNode(`import Database from "better-sqlite3";
const db = new Database(":memory:");
db.exec("create table t(x)");
db.prepare("insert into t values (?)").run(1);
const fs = await import("node:fs");
const maps = fs.existsSync("/proc/self/maps") ? fs.readFileSync("/proc/self/maps", "utf8") : "";
const hit = maps.split("\\n").map((l) => l.trim().split(/\\s+/).pop()).find((p) => p && p.endsWith(".node")) ?? "";
console.log(JSON.stringify({ rows: db.prepare("select count(*) as c from t").get().c, file: hit }));`);
  let binding = { rows: -1, file: "" };
  try {
    binding = JSON.parse((loaded.stdout || "").trim().split("\n").pop());
  } catch {
    /* the check below reports it */
  }
  probe.check(
    "a native binding loads and answers a query",
    binding.rows === 1,
    binding.file
      ? `${path.basename(binding.file)} (${binding.file.includes("prebuilds") ? "bundled prebuild" : "local build"})`
      : (loaded.stderr || "no /proc readable here").split("\n")[0],
  );
  probe.note("loadedBinding", binding.file || "unknown on this platform");

  // 2. the loader's rule, and what it implies for Termux — read from the installed source, not from memory
  const loaderSrc = existsSync(path.join(pkgDir, "lib", "binding.js"))
    ? readFileSync(path.join(pkgDir, "lib", "binding.js"), "utf8")
    : "";
  const prefersPrebuilds =
    /getPrebuildPath\(\)[\s\S]{0,400}prebuilds/.test(loaderSrc) &&
    /try to find the binding as a prebuilt binary/i.test(loaderSrc);
  probe.check(
    "the installed loader still prefers `prebuilds/` over a local build",
    prefersPrebuilds,
    prefersPrebuilds
      ? "so a Termux source build needs prebuilds out of the way"
      : "loader changed — re-read this probe's header comment",
  );
  const muslNoGlibc = /glibcVersionRuntime/.test(loaderSrc);
  probe.check(
    'the musl guess is "no glibc", which is also Termux\'s shape',
    muslNoGlibc,
    "isLinuxMusl() reads process.report.getReport().header.glibcVersionRuntime",
  );
  const muslPrebuilds = ["linuxmusl-arm64.node", "linuxmusl-x64.node"].filter((f) =>
    existsSync(path.join(pkgDir, "prebuilds", f)),
  );
  probe.check(
    "the loader would pick a musl-named prebuild on Termux, and that file ships",
    muslPrebuilds.length > 0 && loaderSrc.includes("linuxmusl"),
    `prebuilds/${muslPrebuilds.join(", ") || "none"} — musl on a bionic runtime is the failure the device run confirms or refutes`,
  );
  probe.note(
    "termuxLoaderChoice",
    muslPrebuilds.length
      ? `would reach for ${muslPrebuilds.join(" or ")}`
      : "no musl prebuild in this package",
  );

  // 3. compile it by hand, the way a Termux user must
  const built = forceBuild();
  if (built.outcome === "no-toolchain") {
    probe.block(
      "a source build is possible with the tools present",
      `missing ${built.missing.join(", ")} — on Termux: pkg install nodejs-lts python make clang. ` +
        "That list is the measurement `crabby doctor` has to reproduce (docs/DEVELOPMENT.md §1)",
    );
  } else if (built.outcome === "no-network") {
    probe.block(
      "node-gyp fetches the Node headers it compiles against",
      `${built.detail} — this sandbox reaches only a few hosts (docs/DEVELOPMENT.md §12), so the build is untested here, ` +
        "not failed. On a phone this line becomes a real number: header download plus compile time.",
    );
  } else if (built.outcome === "failed") {
    probe.check("node-gyp builds the addon from source", false, built.detail);
  } else {
    probe.check("node-gyp builds the addon from source", true, built.detail);
    const byPath = compileWorksByPath(path.join(pkgDir, "build", "Release", "better_sqlite3.node"));
    probe.check("the compiled binding works when loaded by path", byPath.ok, byPath.detail);
  }

  // 4. durability, the question §5 actually claimed to have answered
  await crashCase("better");
  const hasNodeSqlite = spawnSync(
    process.execPath,
    ["-e", "import('node:sqlite').then(m=>process.exit(m.DatabaseSync?0:1))"],
    {
      stdio: "ignore",
    },
  );
  probe.check(
    "`node:sqlite` exists for the same-case comparison",
    hasNodeSqlite.status === 0,
    `exit ${hasNodeSqlite.status}`,
  );
  if (hasNodeSqlite.status === 0) await crashCase("node");
}

probe.note(
  "reportedClaim",
  "DECISIONS.md §5.3 reported transactions, WAL and crash recovery on Termux; this project had not reproduced it",
);
probe.manual(
  "run P3 on the phone with the toolchain installed",
  "pkg install nodejs-lts python make clang && npm run probe:p3 — the compile time and the two integrity lines go in probes/RESULTS.md",
);
probe.manual(
  "say which escape hatch the device needed",
  "if the load failed until `prebuilds/` was moved away (or the binding was passed explicitly), record that: it decides whether O-001's " +
    "fallback stays `node:sqlite` or becomes a documented build step in the installer",
);

report(probe, args);

/* ---------- the crash, run once per driver, same script and same kill ---------- */

async function crashCase(driver) {
  const name = driver === "better" ? "better-sqlite3" : "node:sqlite";
  const writer = stageChild("writer.mjs");
  const dir = mkdtempSync(path.join(os.tmpdir(), `crabby-p3-${driver}-`));
  const db = path.join(dir, "t.db");
  const run = spawnReady(writer, {
    readyMarker: "READY",
    args: ["--driver", driver, "--db", db, "--rows", String(ROWS), "--batch", String(BATCH)],
  });
  try {
    await run.ready;
    for (let i = 0; i < 500 && !run.out.stdout.includes(`WROTE ${BATCH * 4}`); i++) await sleep(10);
    const batches = (run.out.stdout.match(/WROTE /g) ?? []).length;
    run.child.kill("SIGKILL");
    await sleep(200);
    const seen = inspect(driver, db);
    if (!seen) {
      probe.check(`${name}: opens after SIGKILL`, false, "no driver could read the file back");
      return;
    }
    probe.check(
      `${name}: integrity_check ok after a crash mid-write`,
      seen.integrity === "ok",
      `integrity=${seen.integrity}${seen.error ? ` (${seen.error})` : ""}`,
    );
    probe.check(
      `${name}: committed rows are whole batches, so no torn write survived`,
      seen.count >= BATCH && seen.count % BATCH === 0,
      `${seen.count} rows recovered after ${batches} reported batches (batch=${BATCH})`,
    );
    probe.check(
      `${name}: a checkpoint runs on the recovered file`,
      seen.checkpointOk,
      `db=${Math.round(seen.size / 1024)}KB, -wal after checkpoint=${seen.walAfter}B`,
    );
  } catch (err) {
    probe.check(`${name}: writer ran`, false, String(err?.message ?? err).slice(0, 180));
  } finally {
    run.child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
}

function inspect(driver, file) {
  // the reader has to live inside `.deps` so a bare `import "better-sqlite3"` resolves from there
  const script = path.join(DEPS_DIR, "inspect-driver.mjs");
  writeFileSync(
    script,
    `import fs from "node:fs";
const [driver, file] = process.argv.slice(2);
const out = { integrity: "unreadable", count: -1, checkpointOk: false };
try {
  if (driver === "better") {
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(file);
    out.integrity = db.pragma("integrity_check", { simple: true });
    out.count = db.prepare("select count(*) as c from t").get().c;
    db.pragma("wal_checkpoint(TRUNCATE)");
    out.checkpointOk = true;
  } else {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(file);
    out.integrity = db.prepare("pragma integrity_check").get().integrity_check;
    out.count = db.prepare("select count(*) as c from t").get().c;
    db.exec("pragma wal_checkpoint(TRUNCATE)");
    out.checkpointOk = true;
  }
} catch (e) {
  out.error = String(e.message).split("\\n")[0];
}
out.size = fs.existsSync(file) ? fs.statSync(file).size : 0;
out.walAfter = fs.existsSync(file + "-wal") ? fs.statSync(file + "-wal").size : 0;
console.log(JSON.stringify(out));
`,
  );
  const res = spawnSync(process.execPath, [script, driver, file], {
    encoding: "utf8",
    cwd: DEPS_DIR,
  });
  try {
    return JSON.parse((res.stdout || "").trim().split("\n").pop());
  } catch {
    return null;
  }
}

/* ---------- source build ---------- */

function forceBuild() {
  for (const tool of ["make", "cc"]) {
    const found = spawnSync(tool, ["--version"], { stdio: "ignore" });
    if (found.error || found.status !== 0) return { outcome: "no-toolchain", missing: [tool] };
  }
  const nodegyp = path.join(DEPS_DIR, "node_modules", ".bin", "node-gyp");
  if (!existsSync(nodegyp)) {
    const install = spawnSync(
      "npm",
      ["install", "--no-save", "--ignore-scripts", "node-gyp@latest"],
      {
        cwd: DEPS_DIR,
        encoding: "utf8",
      },
    );
    if (install.status !== 0) {
      return {
        outcome: "no-toolchain",
        missing: [
          `node-gyp (npm said: ${(install.stderr || install.stdout || "").split("\n").filter(Boolean).pop()})`,
        ],
      };
    }
  }
  const t0 = Date.now();
  const res = spawnSync(nodegyp, ["rebuild", "--release", "--force_build=1"], {
    cwd: pkgDir,
    encoding: "utf8",
    timeout: 900_000,
    maxBuffer: 48 * 1024 * 1024,
  });
  const artifact = path.join(pkgDir, "build", "Release", "better_sqlite3.node");
  if (existsSync(artifact)) {
    return {
      outcome: "built",
      detail: `${Date.now() - t0}ms to compile, ${Math.round(statSync(artifact).size / 1024)}KB`,
    };
  }
  const log = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
  const line =
    log
      .split("\n")
      .filter((l) => /error|fatal|not found|disconnected|EACCES|ENOENT/i.test(l))
      .slice(-1)[0] ?? `exit ${res.status}`;
  if (
    /disconnected before secure TLS|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNRESET|socket hang up|network/i.test(
      log,
    )
  ) {
    return { outcome: "no-network", detail: line.slice(0, 200) };
  }
  return { outcome: "failed", detail: line.slice(0, 220) };
}

function compileWorksByPath(nativeBinding) {
  const res = runNode(`import Database from "better-sqlite3";
const db = new Database(":memory:", { nativeBinding: ${JSON.stringify(nativeBinding)} });
db.pragma("journal_mode = WAL");
db.exec("create table t(i integer primary key, s text not null, c integer not null)");
const ins = db.prepare("insert into t (s, c) values (?, ?)");
db.transaction(() => { for (let i = 1; i <= 2000; i++) ins.run("x".repeat(64), i * 7919); })();
const bad = db.prepare("select count(*) as c from t where c <> i * 7919").get().c;
console.log(JSON.stringify({ rows: db.prepare("select count(*) as c from t").get().c, bad }));`);
  try {
    const parsed = JSON.parse((res.stdout || "").trim().split("\n").pop());
    return {
      ok: parsed.rows === 2000 && parsed.bad === 0,
      detail: `${parsed.rows} rows in one transaction, ${parsed.bad} checksum mismatches, via ${path.basename(nativeBinding)}`,
    };
  } catch {
    return {
      ok: false,
      detail:
        (res.stderr || res.stdout || "load failed").split("\n").filter(Boolean)[0]?.slice(0, 200) ??
        "no output",
    };
  }
}
