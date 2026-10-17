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
import { composeProviders, type ProviderComposition, selectDefaultModel } from "@crabby/providers";
import { openVault } from "@crabby/vault";
import type { Renderer } from "../output.ts";
import { WORKSPACE_ROOT_NAME } from "./init.ts";

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
  checks.push(...providerChecks(input));
  checks.push(workspaceCheck(input));
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

/** §5 step 2's "pick a model path", re-run as a check: `crabby doctor` "re-runs the same checks at any time and prints
 *  fixes, not findings". Two lines rather than one, because "does an adapter compose" and "does this install know which
 *  model to run" fail differently and are fixed by different commands — and §3.6 makes the second a user selection
 *  rather than something the build may assume.
 *
 *  A refusal is `deferred` when the reason is a subsystem this build does not have (the vault, §3.3's other three
 *  families) and `warn` when it is a configuration the user can fix now. Never a green tick, for the reason this file's
 *  header gives (F-28): a diagnostic that claims a state the build cannot have is a lie with a checkmark on it. */
function providerChecks(input: DoctorInput): Check[] {
  const loaded = loadConfig(input.layout);
  const entries = loaded.config.provider ?? {};
  const composed = composeProviders(loaded.config.provider, loaded.limits);
  const ready = composed.filter((entry) => entry.ok);
  const refused = composed.filter((entry) => !entry.ok);

  if (Object.keys(entries).length === 0) {
    return [
      {
        id: "provider",
        // A note and not a warn: §5 makes skipping a supported path ("Crabby must be usable in a read-only,
        // approval-for-everything mode right after `init`"), so an install with no provider is configured that way
        // rather than broken.
        status: "note",
        summary: "no provider is configured",
        detail:
          "§3.3's configuration path is `provider.<id>` in config.json, and an endpoint that needs no key composes today",
        fix: "crabby config set provider.local.baseUrl http://127.0.0.1:8080/v1",
      },
      {
        id: "model",
        status: "note",
        summary: "no default model, because no provider is configured",
        fix: "crabby config set defaultModel <provider>/<modelId> once one is",
      },
    ];
  }

  const out: Check[] = [];
  if (ready.length === 0) {
    // `deferred` when every refusal is a subsystem that arrives later, `warn` when at least one is a mistake the user
    // can correct now. Decided from the configuration rather than from the reason text, so rewording a refusal cannot
    // silently move a check between the two.
    const deferred = refused.every((entry) => {
      const config = entries[entry.id];
      return (
        config?.key !== undefined ||
        (config?.kind !== undefined && config.kind !== "openai-compatible")
      );
    });
    out.push({
      id: "provider",
      status: deferred ? "deferred" : "warn",
      summary: `no provider entry composes (${refused.length} refused)`,
      detail: refused.map((entry) => `${entry.id}: ${refusalOf(entry)}`).join("; "),
      fix: deferred
        ? "an endpoint that needs no key composes now; a keyed one waits for the vault (M5, F-56)"
        : "crabby config schema --json prints the shape an entry must have",
    });
    out.push({
      id: "model",
      status: "warn",
      summary: "no default model can be selected while no provider composes",
      fix: "fix the provider entry above, then `crabby config set defaultModel <provider>/<modelId>`",
    });
    return out;
  }

  out.push({
    id: "provider",
    status: "ok",
    summary: ready.map((entry) => `${entry.id} (${entry.modelIds.length})`).join(", "),
    detail:
      refused.length > 0
        ? `refused: ${refused.map((entry) => `${entry.id} — ${refusalOf(entry)}`).join("; ")}`
        : "§3.3's openai-compatible family, composed from config.json (D-100, D-101)",
  });
  const selected = selectDefaultModel(composed, loaded.config.defaultModel);
  out.push(
    selected.ok
      ? {
          id: "model",
          status: "ok",
          summary: `${selected.providerId}/${selected.modelId}`,
          detail: "§3.6's default selection; a per-task pin would win over it",
        }
      : {
          id: "model",
          status: "warn",
          summary: "no default model is selected",
          detail: selected.reason,
          fix: "crabby config set defaultModel <provider>/<modelId>",
        },
  );
  return out;
}

function refusalOf(entry: ProviderComposition): string {
  return entry.ok ? "" : entry.reason;
}

/** `SECURITY.md` §8's containment, as a check: "Tool-declared paths must resolve within one or more **configured
 *  workspace roots**", and "the home directory is not a workspace". Both halves are reported because they fail
 *  differently. No roots is a `warn` and not a `fail`: containment is fail-closed, so nothing is exposed — what breaks
 *  is that every `file.*` call outside a task's scratch directory is denied, and an agent that cannot touch a file
 *  looks broken rather than unconfigured. A root that *is* the home directory is a `fail`, because that configuration
 *  removes the boundary §8 requires and leaves the sensitive deny-list — a floor, not a containment rule — as the only
 *  thing between a task and `~/.ssh`. */
function workspaceCheck(input: DoctorInput): Check {
  const loaded = loadConfig(input.layout);
  const roots = loaded.config.workspace?.roots ?? [];
  if (roots.length === 0) {
    return {
      id: "workspace",
      status: "warn",
      summary: "no workspace root is configured",
      detail:
        "§8's containment is fail-closed without one, so `file.*` is denied outside a task's scratch directory",
      fix: `crabby init creates ${input.home}/${WORKSPACE_ROOT_NAME}, or crabby config set workspace.roots '["…"]'`,
    };
  }
  if (roots.some((root) => root === input.home || root === `${input.home}/`)) {
    return {
      id: "workspace",
      status: "fail",
      summary: `${input.home} is a workspace root, and §8 says the home directory is not a workspace`,
      detail:
        "a root this wide leaves the sensitive deny-list as the only boundary, and that list is a floor rather than a containment rule",
      fix: `crabby config set workspace.roots '["${input.home}/${WORKSPACE_ROOT_NAME}"]'`,
    };
  }
  const missing = roots.filter((root) => !existsSync(root));
  if (missing.length > 0) {
    return {
      id: "workspace",
      status: "warn",
      summary: `${missing.length} configured root(s) do not exist`,
      detail: missing.join(", "),
      fix: `mkdir -p ${missing[0]}`,
    };
  }
  return {
    id: "workspace",
    status: "ok",
    summary: roots.join(", "),
    detail: "§8's containment resolves every tool-declared path inside one of these",
  };
}

function vaultCheck(input: DoctorInput): Check {
  // The store's own answer, not the directory's: which back end this device got (D-031's platform table),
  // which state it is in, and — when the file store is the one it has — the weaker-protection sentence §7
  // requires every message that references the fallback to carry.
  const vault = openVault({ vaultDir: input.layout.vaultDir, platform: input.facts.platform });
  const status = vault.status();
  if (existsSync(input.layout.vaultDir)) {
    const mode = statSync(input.layout.vaultDir).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      return {
        id: "vault",
        status: "fail",
        summary: `${input.layout.vaultDir} is readable beyond its owner (mode ${mode.toString(8)})`,
        fix: `chmod 700 ${input.layout.vaultDir}`,
      };
    }
  }
  if (status.state === "unset") {
    return {
      id: "vault",
      status: "warn",
      summary: `no vault yet (${status.kind} store)`,
      detail: "secrets live here and nowhere else (D-031, D-066)",
      fix: "`crabby vault set <name>` creates it — a provider entry whose key is a vault:// reference composes once the name exists and the store is unlocked",
    };
  }
  if (status.state === "locked") {
    return {
      id: "vault",
      status: "warn",
      summary: `locked (${status.kind} store)`,
      ...(status.note === undefined ? {} : { detail: status.note }),
      fix: "`crabby vault unlock` opens the running Gateway's session; keyed providers compose again with it",
    };
  }
  return {
    id: "vault",
    status: "ok",
    summary: `${status.kind} store, unlocked${status.entries === undefined ? "" : `, ${String(status.entries)} entr${status.entries === 1 ? "y" : "ies"}`}`,
    ...(status.note === undefined ? {} : { detail: status.note }),
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
