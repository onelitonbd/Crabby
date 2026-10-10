// Test-only wiring, deliberately not exported from the package index. The layout helper lives here because production
// code never needs to invent a temporary state directory, and a test that reaches for `node:fs` inside a package
// source file makes the package depend on the test suite by accident.
import { mkdirSync } from "node:fs";
import { dataLayout } from "@crabby/platform";

export {
  applyConfigKey,
  configSchema,
  createLogger,
  createShutdown,
  LIMITS_DEFAULTS,
  loadConfig,
  mergeConfig,
  readLastExit,
  redact,
  redactText,
  writeConfig,
} from "@crabby/core";

export function dataLayoutFor(stateDir: string) {
  const layout = dataLayout(stateDir);
  mkdirSync(layout.stateDir, { recursive: true, mode: 0o700 });
  return layout;
}
