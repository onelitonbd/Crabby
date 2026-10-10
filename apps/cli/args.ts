// The command tail parser, shared because §7.1's grammar is one grammar: every CLI command reads its own flags the
// same way, and — more to the point — the list of flags it accepts comes from `registry.ts`, which is the same source
// `crabby --help` prints. A flag can therefore not be implemented without appearing in help, which is the D-005
// direction of the parity rule (the docs' test is the other one: a command cannot exist in one interface only).
import type { CommandSpec } from "./registry.ts";
import { relativeName } from "./registry.ts";

export interface Tail {
  readonly values: Record<string, string>;
  readonly booleans: Set<string>;
  readonly positionals: string[];
  /** Flags the person typed that this command does not know, already without the leading dashes. */
  readonly unknown: string[];
}

/** A registry entry written `"--port N"` takes a value; one written `"--json"` is a switch. That is the whole
 *  convention, and it is a convention rather than a table because a second list of "which flags have arguments" is a
 *  list that forgets to be updated. */
export function allowedFlags(spec: CommandSpec | undefined): {
  value: Set<string>;
  flag: Set<string>;
} {
  const value = new Set<string>();
  const flag = new Set<string>();
  for (const entry of spec?.flags ?? []) {
    const name = entry.split(" ")[0] ?? entry;
    if (entry.includes(" ")) value.add(name);
    else flag.add(name);
  }
  return { value, flag };
}

export function parseTail(argv: readonly string[], spec: CommandSpec | undefined): Tail {
  const { value, flag } = allowedFlags(spec);
  const values: Record<string, string> = {};
  const booleans = new Set<string>();
  const positionals: string[] = [];
  const unknown: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const name = arg;
    if (flag.has(name)) {
      booleans.add(name);
      continue;
    }
    if (value.has(name)) {
      const next = argv[i + 1];
      if (typeof next === "string" && !next.startsWith("--")) {
        values[name.slice(2)] = next;
        i += 1;
        continue;
      }
    }
    unknown.push(name.slice(2));
  }
  return { values, booleans, positionals, unknown };
}

export function unknownFlagMessage(
  unknown: readonly string[],
  spec: CommandSpec | undefined,
): string {
  const accepted = [...(spec?.flags ?? [])].join(" ");
  return `crabby ${relativeName(spec ?? { noun: "?", summary: "", flags: [], status: "ready" })} accepts ${
    accepted.length > 0 ? accepted : "no flags"
  } — not ${unknown.join(", ")}`;
}
