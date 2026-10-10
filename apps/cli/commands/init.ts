// `crabby init` — the first command a clone runs, and the only one allowed to create files. Two rules it has to keep:
// it never overwrites (a second `init` is a person checking their work, not a request to reset it), and it explains
// what it made in terms the next command can use (`docs/UI_UX_SPEC.md` §5: `doctor` prints fixes, and `init` should
// too).
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { EXIT, type ExitCode, validate } from "@crabby/api-contracts";
import { ConfigFile, writeConfig } from "@crabby/core";
import type { DataLayout } from "@crabby/platform";
import type { Renderer } from "../output.ts";

export interface InitResult {
  readonly created: string[];
  readonly existing: string[];
}

/** `{}` is the honest artifact: the defaults D-074 names live in code (`DEFAULT_CONFIG`), and a `config.json` that
 *  copied them out would fork them the moment a default changed — which is the drift the file exists to prevent by
 *  holding overrides only. */
export function runInit(layout: DataLayout, renderer: Renderer): ExitCode {
  const created: string[] = [];
  const existing: string[] = [];

  for (const [name, path] of [
    ["data dir", layout.stateDir],
    ["vault", layout.vaultDir],
  ] as const) {
    if (existsSync(path)) {
      existing.push(path);
      renderer.line(name, `${path} (already there)`);
      continue;
    }
    mkdirSync(path, { recursive: true, mode: 0o700 });
    // mkdir's mode is masked by the process umask, so the vault cannot be *left* group-readable by whoever happens to
    // own the umask; setting it after creation is the only way to mean it. SECURITY.md treats this directory as the
    // one place secrets live (D-031), which is the reason for the tighter mode rather than a style preference.
    if (name === "vault") chmodSync(path, 0o700);
    created.push(path);
    renderer.line(name, path);
  }

  if (existsSync(layout.configPath)) {
    existing.push(layout.configPath);
    renderer.line("config", `${layout.configPath} (left untouched)`);
    const problems = readProblems(layout);
    if (problems.length > 0) {
      for (const problem of problems)
        renderer.fix(`config ${problem.path || "<root>"}: ${problem.message}`);
      renderer.line("", "");
      renderer.line("next", `crabby doctor`);
      return EXIT.success;
    }
    renderer.line("config check", "valid");
    return renderer.done({ created, existing, configPath: layout.configPath });
  }

  const written = writeConfig(layout, {});
  if (!written.ok) {
    renderer.line("config", written.message);
    renderer.fix("fix the file by hand, or delete it and run `crabby init` again");
    return EXIT.failure;
  }
  created.push(layout.configPath);
  renderer.line("config", layout.configPath);
  renderer.line(
    "limits",
    "defaults in code — `crabby config get limits` shows what is actually in force",
  );
  renderer.fix("run `crabby doctor` to see what this platform can and cannot do");
  return renderer.done({ created, existing, configPath: layout.configPath });
}

function readProblems(layout: DataLayout): { path: string; message: string }[] {
  if (!existsSync(layout.configPath)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(layout.configPath, "utf8"));
  } catch {
    return [{ path: "", message: "is not valid JSON" }];
  }
  const result = validate(ConfigFile, parsed);
  return result.ok ? [] : result.problems;
}
