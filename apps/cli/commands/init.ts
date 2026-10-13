// `crabby init` — the first command a clone runs, and the only one allowed to create files. Two rules it has to keep:
// it never overwrites (a second `init` is a person checking their work, not a request to reset it), and it explains
// what it made in terms the next command can use (`docs/UI_UX_SPEC.md` §5: `doctor` prints fixes, and `init` should
// too).
//
// §5's list is this command's specification, and step 3 is the one that creates something outside the state directory:
// "create workspace root — default: $HOME/crabby-workspace, with the deny-list shown". The default is deliberately not
// `$HOME` itself, and `SECURITY.md` §8 says why in one clause — "the home directory is not a workspace". A root that
// *was* the home directory would leave §8's sensitive deny-list as the only thing between an agent and `~/.ssh`, and
// the deny-list is a floor rather than a containment boundary. So init makes a directory, records the path it made, and
// shows what stays denied inside it.
//
// Skipping stays supported (§5's last bullet: usable in a read-only, approval-for-everything mode right after `init`),
// which is why an existing config is left alone and a missing root is reported with the command that records one
// rather than written over a file the user has since edited.
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { EXIT, type ExitCode } from "@crabby/api-contracts";
import { type ConfigFile, loadConfig, writeConfig } from "@crabby/core";
import type { DataLayout } from "@crabby/platform";
import { SENSITIVE_BASENAME_GLOBS } from "@crabby/policy";
import { parseTail, unknownFlagMessage } from "../args.ts";
import type { Renderer } from "../output.ts";
import { findCommand } from "../registry.ts";

/** §5 step 3's default, as the one place the name is spelled. */
export const WORKSPACE_ROOT_NAME = "crabby-workspace";

export interface InitResult {
  readonly created: string[];
  readonly existing: string[];
  readonly workspaceRoot: string;
}

export function runInit(
  argv: readonly string[],
  layout: DataLayout,
  renderer: Renderer,
  home: string,
): ExitCode {
  const spec = findCommand("init", undefined);
  const tail = parseTail(argv, spec);
  if (tail.unknown.length > 0) {
    // Usage is answered before anything is created: a flag this command does not know must not leave a state dir
    // behind, let alone a config that opts into shell execution nobody asked for.
    renderer.line("unknown flag(s)", tail.unknown.join(" "));
    renderer.fix(unknownFlagMessage(tail.unknown, spec));
    return EXIT.usage;
  }
  // §9's opt-in, as a flag rather than a prompt: a scripted first run must be able to choose it, and a flag is the
  // choice a later `init` can see it did not make. Absent means off, and off is the default that needs no recording.
  const enableShell = tail.booleans.has("--enable-shell");
  const created: string[] = [];
  const existing: string[] = [];

  for (const [name, dir] of [
    ["data dir", layout.stateDir],
    ["vault", layout.vaultDir],
  ] as const) {
    if (existsSync(dir)) {
      existing.push(dir);
      renderer.line(name, `${dir} (already there)`);
      continue;
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mkdir's mode is masked by the process umask, so the vault cannot be *left* group-readable by whoever happens to
    // own the umask; setting it after creation is the only way to mean it. SECURITY.md treats this directory as the
    // one place secrets live (D-031), which is the reason for the tighter mode rather than a style preference.
    if (name === "vault") chmodSync(dir, 0o700);
    created.push(dir);
    renderer.line(name, dir);
  }

  // ---- §5 step 3: the workspace root.
  const root = path.join(home, WORKSPACE_ROOT_NAME);
  if (existsSync(root)) {
    existing.push(root);
    renderer.line("workspace", `${root} (already there)`);
  } else {
    // Not `0o700` this time, and the difference is the point of the two modes sitting next to each other: the vault
    // holds secrets and nothing else reads it, while a workspace holds the files a task works on — a directory the
    // user's own editor, shell and backups are expected to open. What protects it is §8's containment, not its mode.
    mkdirSync(root, { recursive: true });
    created.push(root);
    renderer.line("workspace", root);
  }
  renderer.line(
    "deny-list",
    `${SENSITIVE_BASENAME_GLOBS.join(", ")} stay denied inside a workspace root (SECURITY.md §8)`,
  );

  const loaded = loadConfig(layout);
  if (loaded.exists) {
    existing.push(layout.configPath);
    renderer.line("config", `${layout.configPath} (left untouched)`);
    if (loaded.problems.length > 0) {
      for (const problem of loaded.problems)
        renderer.fix(`config ${problem.path || "<root>"}: ${problem.message}`);
      renderer.line("", "");
      renderer.line("next", `crabby doctor`);
      return EXIT.success;
    }
    // An install that already has a config may still have no roots — §8's containment is fail-closed without one, so
    // every `file.*` call outside a task's scratch directory is denied and the agent looks broken rather than
    // unconfigured. Naming the fix is the difference (UI_UX_SPEC §5: `init` explains what it made in terms the next
    // command can use).
    const roots = loaded.config.workspace?.roots ?? [];
    if (!roots.includes(root)) {
      renderer.fix(
        `no workspace root is recorded — crabby config set workspace.roots '${JSON.stringify([root])}'`,
      );
    }
    // An existing config is left untouched — the flag above cannot opt a config in that this run did not create, for
    // the same reason a second `init` never records the root twice. What it can do is report the choice and name the
    // command that changes it, the way the roots check above does.
    const shellEnabled = loaded.config.shell?.enabled === true;
    renderer.line(
      "shell",
      shellEnabled
        ? "`shell.run` may compose over the configured roots (§9)"
        : "off by default — `shell.run` is not composed (§4.2)",
    );
    if (!shellEnabled) {
      renderer.fix("`crabby config set shell.enabled true` opts in; the flag only applies to a fresh install");
    }
    renderer.line("config check", "valid");
    return renderer.done({ created, existing, configPath: layout.configPath, workspaceRoot: root });
  }

  // A recorded root is not a default: it is the path this command just created, which is a fact about this install.
  // Everything else stays out of the file, because a `config.json` that copied `DEFAULT_CONFIG` out would fork the
  // moment a default changed — the drift D-074's override-only rule exists to prevent. The shell opt-in is the one
  // exception to "nothing else", and only when the flag asked for it: `shell.enabled: true` records an explicit act
  // (§9, `docs/ROADMAP.md` §4), while a bare `init` writes no shell key at all, because off is the default and a file
  // that spelled it out would read as a choice somebody made.
  const file: ConfigFile = {
    workspace: { roots: [root] },
    ...(enableShell ? { shell: { enabled: true } } : {}),
  };
  const written = writeConfig(layout, file);
  if (!written.ok) {
    renderer.line("config", written.message);
    renderer.fix("fix the file by hand, or delete it and run `crabby init` again");
    return EXIT.failure;
  }
  created.push(layout.configPath);
  renderer.line("config", layout.configPath);
  renderer.line(
    "shell",
    enableShell
      ? "`shell.run` may compose over the workspace root this install recorded (§9)"
      : "off by default — `shell.run` is not composed (§4.2)",
  );
  if (!enableShell) {
    renderer.fix("`crabby init --enable-shell` opts in on a fresh install, `crabby config set shell.enabled true` after");
  }
  renderer.line(
    "limits",
    "defaults in code — `crabby config get limits` shows what is actually in force",
  );
  renderer.fix("run `crabby doctor` to see what this platform can and cannot do");
  return renderer.done({ created, existing, configPath: layout.configPath, workspaceRoot: root });
}
