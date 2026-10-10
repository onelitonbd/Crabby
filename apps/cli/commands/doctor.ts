// `crabby doctor` — `docs/DEVELOPMENT.md` §10's list, run locally: "environment, Node version, native module status,
// Termux constraints, vault state, listener mode, paired clients, tunnel state".
//
// The last three belong to the Gateway, and the division of labour with `crabby status` is deliberate: doctor answers
// from the filesystem — what a process published, what mode a file has, whether a pid is alive — and never opens a
// socket, so a diagnostic stays a diagnostic instead of becoming a health check that depends on the thing it is
// diagnosing. Anything needing an answer *from* the running Gateway is `crabby status`'s job, and the fix lines say
// so. A state this build cannot have is reported as `deferred` with the reason, never as a green tick, which is how a
// diagnostic becomes a lie (F-28).
//
// `docs/UI_UX_SPEC.md` §5 is the tone rule: prints fixes, not findings. A line here that says only "no vault" is a
// bug in this file.

import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { EXIT, type ExitCode, isSecretShaped } from "@crabby/api-contracts";
import { loadConfig, readLastExit, redactText } from "@crabby/core";
import { readCredentials, readGatewayInfo } from "@crabby/gateway";
import {
  constraintsFor,
  type DataLayout,
  type PlatformFacts,
  STATE_DIR_NAME,
} from "@crabby/platform";
import type { Renderer } from "../output.ts";

export type CheckStatus = "ok" | "warn" | "fail" | "note" | "deferred";

export interface Check {
  readonly id: string;
  readonly status: CheckStatus;
  readonly summary: string;
  readonly detail?: string;
  readonly fix?: string;
}

export interface DoctorInput {
  readonly layout: DataLayout;
  readonly facts: PlatformFacts;
  /** The repository's root `package.json`, read only for `engines.node` — D-070 makes that field the single pin. */
  readonly rootPackageJson: string;
  /** Where workspace dependencies resolve to, so "is the native driver here yet" is answered by the filesystem. */
  readonly nodeModulesRoot: string;
  readonly home: string;
  readonly termuxVersion: string | undefined;
}

export function runDoctor(input: DoctorInput, renderer: Renderer): ExitCode {
  // `SECURITY.md` §14: "Diagnostics commands must be safe to paste into a bug report: redaction is verified by tests,
  // not by hope." A validation problem can quote the offending value, so every string this command prints goes
  // through the same text filter the log serializer uses — before the renderer sees it, because that is the last
  // point where a paste-ready document is still under our control.
  const checks = collectChecks(input).map(redactCheck);
  let failed = 0;
  for (const check of checks) {
    if (check.status === "fail") failed += 1;
    if (!renderer.json) {
      renderer.line(
        `${SYMBOL[check.status]} ${check.id}`,
        check.detail ? `${check.summary} — ${check.detail}` : check.summary,
      );
      if (check.fix) renderer.fix(check.fix);
    }
  }
  const payload = { checks, summary: tally(checks) };
  if (failed > 0) {
    renderer.fail({
      ...payload,
      code: "doctor-failed",
      message: `doctor found ${failed} problem(s)`,
    });
    return EXIT.failure;
  }
  return renderer.done(payload);
}

const SYMBOL: Record<CheckStatus, string> = {
  ok: "✓",
  warn: "!",
  fail: "✗",
  note: "·",
  deferred: "…",
};

export function collectChecks(input: DoctorInput): Check[] {
  const checks: Check[] = [];
  checks.push(nodeCheck(input.facts, input.rootPackageJson));
  checks.push(platformCheck(input.facts, input.termuxVersion));
  checks.push(...constraintChecks(input.facts));
  checks.push(nativeCheck(input));
  checks.push(storageDriverCheck(input));
  checks.push(dataDirCheck(input));
  checks.push(configCheck(input));
  checks.push(vaultCheck(input));
  checks.push(lastExitCheck(input));
  checks.push(...gatewayChecks(input.layout));
  return checks;
}

function nodeCheck(facts: PlatformFacts, rootPackageJson: string): Check {
  // D-070: "the requirement is behavioral, not a version number: the installed Node must run `.ts` entry points …
  // with no flags and no loader". The strongest available proof is that this command *is* a `.ts` entry point.
  const engines = readEngines(rootPackageJson);
  if (engines === undefined) {
    return {
      id: "runtime.node",
      status: "warn",
      summary: `${facts.nodeVersion} runs .ts entry points and node --test unflagged`,
      detail: "package.json has no engines.node",
      fix: "pin engines.node from the M0 P1 Termux measurement — docs/DEVELOPMENT.md §1 says that field is authoritative",
    };
  }
  return {
    id: "runtime.node",
    status: "ok",
    summary: `${facts.nodeVersion} satisfies engines.node "${engines}" and runs .ts entry points unflagged`,
  };
}

function readEngines(rootPackageJson: string): string | undefined {
  if (!existsSync(rootPackageJson)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(rootPackageJson, "utf8"));
    const engines = (parsed as { engines?: { node?: unknown } }).engines;
    return typeof engines?.node === "string" ? engines.node : undefined;
  } catch {
    return undefined;
  }
}

function platformCheck(facts: PlatformFacts, termuxVersion: string | undefined): Check {
  const parts = [
    `${facts.platform}-${facts.arch}`,
    facts.uid === undefined ? "" : `uid ${facts.uid}`,
    termuxVersion ? `TERMUX_VERSION ${termuxVersion}` : "",
    facts.prefix ? `PREFIX ${facts.prefix}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  return {
    id: "platform",
    status: "ok",
    summary: parts,
    detail: facts.isTermux
      ? "Termux, detected from its own environment markers"
      : facts.isAndroid
        ? "Android without Termux's markers — the two are not separable from here, so this is a guess worth stating"
        : "not Termux",
    ...(facts.isAndroid && !facts.isTermux
      ? {
          fix: "if this is not Termux: install it from F-Droid or the Play Store — D-066 supports that path, not bare Android",
        }
      : {}),
  };
}

function constraintChecks(facts: PlatformFacts): Check[] {
  const rows = constraintsFor(facts);
  if (rows.length === 0) {
    return [
      {
        id: "platform.constraints",
        status: "ok",
        summary: "no platform-specific constraints recorded for this surface",
      },
    ];
  }
  return rows.map((row) => ({
    id: `constraint.${row.id}`,
    status: "note" as const,
    summary: row.text,
    detail: row.source,
  }));
}

function nativeCheck(input: DoctorInput): Check {
  if (input.facts.isTermux) {
    const missing = ["python", "make", "clang"].filter((tool) => !onPath(tool));
    if (missing.length > 0) {
      return {
        id: "native.toolchain",
        status: "fail",
        summary: `source builds for native modules need ${missing.join(", ")}`,
        detail:
          "docs/DEVELOPMENT.md §1 records the requirement; the app does not install it for you",
        fix: `pkg install ${missing.join(" ")}`,
      };
    }
    return {
      id: "native.toolchain",
      status: "ok",
      summary: "python, make and clang are on PATH for source builds",
    };
  }
  if (input.facts.platform === "win32") {
    return {
      id: "native.toolchain",
      status: "fail",
      summary: "native Windows is documented-unsupported, not half-supported",
      detail: "D-066: WSL only in v1",
      fix: "run Crabby inside WSL",
    };
  }
  return {
    id: "native.toolchain",
    status: "ok",
    summary: "no source build needed here: prebuilds cover glibc and musl",
  };
}

function onPath(tool: string): boolean {
  const probe = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" });
  return probe.status === 0 && (probe.stdout ?? "").trim().length > 0;
}

/** "Native module status" (`docs/DEVELOPMENT.md` §10) is not only a toolchain question: on Termux the answer depends
 *  on whether the driver shipped a prebuild for this libc, which is what `probes/p3.mjs` measured. So this reports
 *  what is on disk, and says plainly when the dependency does not exist yet rather than implying it was checked. */
function storageDriverCheck(input: DoctorInput): Check {
  const manifest = path.join(input.nodeModulesRoot, "better-sqlite3", "package.json");
  if (!existsSync(manifest)) {
    return {
      id: "storage.driver",
      status: "note",
      summary: "no better-sqlite3: packages/storage has not been written yet",
      detail: "P-004 pins it at ^13.0.3 and waits on O-001's clean Termux build",
      fix: "nothing to do here — the driver arrives with the storage slice",
    };
  }
  let version: string | undefined;
  try {
    version = (JSON.parse(readFileSync(manifest, "utf8")) as { version?: string }).version;
  } catch {
    // A package directory whose manifest will not parse is exactly what this check exists to surface, so it is
    // reported rather than folded into the "not installed" branch above.
    return {
      id: "storage.driver",
      status: "fail",
      summary: `${manifest} exists but is not readable JSON`,
      fix: "rm -rf node_modules/better-sqlite3 && npm install",
    };
  }
  return {
    id: "storage.driver",
    status: "ok",
    summary: `better-sqlite3 ${version ?? "?"} resolves from this checkout`,
  };
}

function dataDirCheck(input: DoctorInput): Check {
  const { layout } = input;
  if (!existsSync(layout.stateDir)) {
    return {
      id: "data.dir",
      status: "fail",
      summary: `${layout.stateDir} does not exist`,
      fix: "crabby init",
    };
  }
  let writable = true;
  try {
    accessSync(layout.stateDir, constants.W_OK);
  } catch {
    writable = false;
  }
  if (!writable) {
    return {
      id: "data.dir",
      status: "fail",
      summary: `${layout.stateDir} is not writable`,
      fix: `chmod u+w ${layout.stateDir} or pass --data-dir $(mktemp -d)`,
    };
  }
  const realHome = layout.stateDir === path.join(path.resolve(input.home), STATE_DIR_NAME);
  return {
    id: "data.dir",
    status: "ok",
    summary: layout.stateDir,
    detail: realHome
      ? "the real home data dir — tests and debugging should not use it"
      : "isolated",
    ...(realHome
      ? { fix: "for experiments: --data-dir $(mktemp -d) (docs/DEVELOPMENT.md §10)" }
      : {}),
  };
}

function configCheck(input: DoctorInput): Check {
  const loaded = loadConfig(input.layout);
  if (!loaded.exists) {
    return {
      id: "config",
      status: "fail",
      summary: `no ${input.layout.configPath}`,
      fix: "crabby init",
    };
  }
  if (loaded.problems.length > 0) {
    return {
      id: "config",
      status: "fail",
      summary: `${loaded.problems.length} problem(s) in ${input.layout.configPath}`,
      detail: loaded.problems.map((p) => `${p.path || "<root>"}: ${p.message}`).join("; "),
      fix: "crabby config schema --json prints the shape; `config set` refuses a bad value at the keystroke",
    };
  }
  return {
    id: "config",
    status: "ok",
    summary: loaded.path ?? "",
    detail: "valid against the schema in packages/core",
  };
}

function vaultCheck(input: DoctorInput): Check {
  if (!existsSync(input.layout.vaultDir)) {
    return {
      id: "vault",
      status: "warn",
      summary: `${input.layout.vaultDir} does not exist yet`,
      detail: "secrets live here and nowhere else (D-031, D-066)",
      fix: "crabby init creates the directory; `crabby auth` fills it in M1b",
    };
  }
  const mode = statSync(input.layout.vaultDir).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    return {
      id: "vault",
      status: "fail",
      summary: `${input.layout.vaultDir} is readable beyond its owner (mode ${mode.toString(8)})`,
      fix: `chmod 700 ${input.layout.vaultDir}`,
    };
  }
  return {
    id: "vault",
    status: "ok",
    summary: input.layout.vaultDir,
    detail: "mode 700 or tighter",
  };
}

function lastExitCheck(input: DoctorInput): Check {
  const record = readLastExit(input.layout);
  if (record === "missing") {
    return {
      id: "exit.last",
      status: "note",
      summary: "no shutdown record yet",
      detail: "the Gateway writes it (D-066's 5 s drain)",
    };
  }
  if (record !== "unclean" && record.kind !== "clean" && record.drained) {
    // The drain finished, so nothing was lost: this is what Ctrl-C looks like, and §10's purpose is telling a crash
    // from a kill, which means a kill that said goodbye must not be reported as one.
    return {
      id: "exit.last",
      status: "ok",
      summary: `stopped by ${record.signal ?? "a signal"} at ${record.at}, after the drain finished`,
      detail:
        "D-066: a drained exit is a clean one — this line is here to say so once, not to warn",
    };
  }
  if (record === "unclean" || record.kind !== "clean") {
    return {
      id: "exit.last",
      status: "warn",
      summary: `the previous process recorded "${record === "unclean" ? "no clean exit marker" : record.kind}" at ${record === "unclean" ? "an unknown time" : record.at}`,
      detail:
        "docs/DEVELOPMENT.md §10: on Termux, capture logcat context to tell a crash from a kill",
      fix: "npm run probe:p6 reproduces the background-kill case",
    };
  }
  return {
    id: "exit.last",
    status: "ok",
    summary: `previous process exited cleanly at ${record.at}`,
  };
}

function gatewayChecks(layout: DataLayout): Check[] {
  const info = readGatewayInfo(layout);
  const paired = readCredentials(layout) !== undefined;

  const listener: Check =
    info.state === "live"
      ? {
          id: "gateway.listener",
          status: "ok",
          summary: `http://${info.info.host}:${info.info.port} (pid ${info.info.pid}, v${info.info.version})`,
          detail: `up since ${info.info.startedAt}; loopback bind, which is the only kind this build offers`,
        }
      : info.state === "stale"
        ? {
            id: "gateway.listener",
            status: "warn",
            summary: `gateway.json names pid ${info.info.pid}, and that process is gone`,
            detail: `the file says http://${info.info.host}:${info.info.port} — a stale one is a note, not a listener`,
            fix: "crabby gateway start (a clean shutdown removes the file, so its survival means the last stop was not clean)",
          }
        : {
            id: "gateway.listener",
            status: "deferred",
            summary: "listener mode (loopback by default, §2)",
            detail: "nothing has published a listener in this data directory",
            fix: "crabby gateway start",
          };

  const clients: Check =
    info.state === "live" && paired
      ? {
          id: "gateway.paired-clients",
          status: "note",
          summary: "this device holds a paired identity",
          detail: `client.json in ${layout.stateDir}, mode 0600; the list of every identity and their last use is \`crabby auth list\``,
        }
      : {
          id: "gateway.paired-clients",
          status: "deferred",
          summary: "paired clients",
          detail:
            info.state === "absent"
              ? "no listener to ask, and no identity to ask it with"
              : "a Gateway is listening and this device has no token",
          ...(info.state === "absent"
            ? { fix: "crabby gateway start, then crabby auth pair --code <code>" }
            : {
                fix: "crabby auth pair --code <code> — the code is printed on the Gateway's own terminal at first run",
              }),
        };

  // There is no tunnel in this build to report on, and the reason is a decision rather than an omission: `SECURITY.md`
  // §13 keeps remote exposure out of the initial release, and `gateway start` refuses a non-loopback bind. Naming the
  // workaround is the useful half of a `deferred` line.
  const tunnel: Check = {
    id: "gateway.tunnel",
    status: "deferred",
    summary: "tunnel state",
    detail:
      "no tunnel exists in this build; the Gateway binds loopback only and refuses a wider host",
    fix: "from another device, use an SSH tunnel to 127.0.0.1 on this one",
  };
  return [listener, clients, tunnel];
}

export function redactCheck(check: Check): Check {
  return {
    ...check,
    summary: redactText(check.summary),
    ...(check.detail === undefined ? {} : { detail: redactText(check.detail) }),
    ...(check.fix === undefined ? {} : { fix: redactText(check.fix) }),
  };
}

export function tally(checks: readonly Check[]): Record<CheckStatus, number> {
  const out: Record<CheckStatus, number> = { ok: 0, warn: 0, fail: 0, note: 0, deferred: 0 };
  for (const check of checks) out[check.status] += 1;
  return out;
}

/** The predicate behind the rule in `runDoctor`, exported so `tests/unit/cli.test.ts` can assert it on the payload a
 *  real doctor run produced rather than trusting that a filter "probably" caught everything. */
export function containsSecret(checks: readonly Check[]): boolean {
  return JSON.stringify(checks, (_key, value) =>
    typeof value === "string" && isSecretShaped(value) ? SECRET_MARK : value,
  ).includes(SECRET_MARK);
}

const SECRET_MARK = "***secret-shaped***";
