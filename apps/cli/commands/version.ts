// `crabby version` — one line for a human, the same facts as a document for a script. A bug report starts with this
// output, which is why the platform and Node versions are here rather than only in `doctor`.
import { readFileSync } from "node:fs";
import type { ExitCode } from "@crabby/api-contracts";
import type { PlatformFacts } from "@crabby/platform";
import type { Renderer } from "../output.ts";

export interface VersionInfo {
  readonly crabby: string;
  readonly node: string;
  readonly platform: string;
  readonly arch: string;
  readonly termux: boolean;
  readonly install: "checkout";
}

export function readVersion(rootPackageJsonPath: string): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(rootPackageJsonPath, "utf8"));
    if (typeof parsed === "object" && parsed !== null && "version" in parsed) {
      const value = (parsed as { version?: unknown }).version;
      if (typeof value === "string") return value;
    }
  } catch {
    // A version command that fails because a file moved would be a bad diagnostic. Fall through.
  }
  return "0.0.0-unknown";
}

export function runVersion(facts: PlatformFacts, version: string, renderer: Renderer): ExitCode {
  const info: VersionInfo = {
    crabby: version,
    node: facts.nodeVersion,
    platform: facts.platform,
    arch: facts.arch,
    termux: facts.isTermux,
    install: "checkout",
  };
  if (!renderer.json) {
    renderer.line("crabby", info.crabby);
    renderer.line("node", `${info.node} (${info.platform}-${info.arch})`);
    renderer.line(
      "install",
      "git checkout + npm install (D-050; no global install, no self-updater)",
    );
    if (info.termux)
      renderer.line(
        "termux",
        facts.termuxVersion ? `TERMUX_VERSION=${facts.termuxVersion}` : "detected",
      );
  }
  return renderer.done({ ...info });
}
