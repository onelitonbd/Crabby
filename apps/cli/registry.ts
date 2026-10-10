// `docs/INTERFACES_AND_API.md` §7.1's rule that makes one grammar real: "`crabby --help` and `crabby <noun> --help` are generated from the same
// contract … so a command cannot exist in one interface only (the D-005 test)." The registry is that generation
// source for the CLI: help text, the unknown-command message, and the dispatch table all read this array, so adding
// a command without declaring it here is not possible.
//
// The Setup and Gateway rows of §7.1's table plus the `config` verbs D-074 and D-060 need. Everything else is
// `planned`, so that `--help` can be honest about the difference instead of silently omitting it: a user who reads a
// list of eleven commands should not have to guess whether the other forty exist somewhere else. A verb is promoted
// here only when it has a route behind it — `task run` stays `planned` in M1b because an executor is M2's job, and a
// command that created a task nothing would move would be a mock with an exit code.
export interface CommandSpec {
  readonly noun: string;
  readonly verb?: string;
  readonly summary: string;
  readonly flags: readonly string[];
  /** `planned` commands appear in help with that word and exit `2` if run, naming the milestone that delivers them. */
  readonly status: "ready" | "planned";
  readonly milestone?: string;
}

export const COMMANDS: readonly CommandSpec[] = [
  {
    noun: "init",
    summary: "create the data directory and config file",
    flags: ["--data-dir DIR"],
    status: "ready",
  },
  {
    noun: "doctor",
    summary: "environment, Node, native modules, Termux constraints, vault, data dir",
    flags: ["--json"],
    status: "ready",
  },
  {
    noun: "version",
    summary: "print version and runtime facts",
    flags: ["--json"],
    status: "ready",
  },
  {
    noun: "config",
    verb: "path",
    summary: "print the config file this process reads",
    flags: ["--data-dir DIR"],
    status: "ready",
  },
  {
    noun: "config",
    verb: "get",
    summary: "print a section, e.g. `config get limits`",
    flags: ["--json"],
    status: "ready",
  },
  {
    noun: "config",
    verb: "set",
    summary: "set one dotted key, validated before the write",
    flags: ["--json"],
    status: "ready",
  },
  {
    noun: "config",
    verb: "schema",
    summary: "print the JSON Schema for config.json (D-060)",
    flags: ["--json"],
    status: "ready",
  },
  {
    noun: "status",
    summary: "gateway, storage, task and stream state at a glance",
    flags: ["--json"],
    status: "ready",
  },
  {
    noun: "gateway",
    verb: "start",
    summary: "run the Gateway on loopback until Ctrl-C (D-066 drain)",
    flags: ["--host H", "--port N"],
    status: "ready",
  },
  {
    noun: "gateway",
    verb: "status",
    summary: "is a Gateway running here, and is the pid alive",
    flags: ["--json"],
    status: "ready",
  },
  {
    noun: "auth",
    verb: "pair",
    summary: "redeem a code with --code, or mint one for another interface",
    flags: ["--code CODE", "--name NAME", "--interface I"],
    status: "ready",
  },
  {
    noun: "auth",
    verb: "list",
    summary: "the identities this Gateway will accept",
    flags: ["--json"],
    status: "ready",
  },
  {
    noun: "auth",
    verb: "revoke",
    summary: "end an identity; the next request with its token fails",
    flags: ["--json"],
    status: "ready",
  },
  {
    noun: "task",
    verb: "ls",
    summary: "list tasks, newest state first by id order",
    flags: ["--state S", "--limit N", "--cursor C", "--json"],
    status: "ready",
  },
  {
    noun: "task",
    verb: "show",
    summary: "one task plus the tail of its events",
    flags: ["--json"],
    status: "ready",
  },
  {
    noun: "task",
    verb: "run",
    summary: "create a task and follow it (blocks; `--detach` for scripts)",
    flags: ["--json", "--detach"],
    status: "planned",
    milestone: "M2 (the runtime that executes a task)",
  },
];

export function findCommand(noun: string, verb: string | undefined): CommandSpec | undefined {
  return COMMANDS.find(
    (spec) =>
      spec.noun === noun && (spec.verb === undefined ? verb === undefined : spec.verb === verb),
  );
}

/** The closest thing that exists, so an unknown command is answered with a fix rather than a shrug (§7.1's exit `2`
 *  is a *usage* code, and a usage code that does not help is noise). */
export function suggest(noun: string, verb?: string): string | undefined {
  const wanted = `${noun} ${verb ?? ""}`.trim();
  let best: { name: string; distance: number } | undefined;
  for (const spec of COMMANDS) {
    const name = relativeName(spec);
    const distance = editDistance(wanted, name);
    if (!best || distance < best.distance) best = { name, distance };
  }
  if (!best || best.distance > Math.max(2, Math.floor(wanted.length / 3))) return undefined;
  return best.name;
}

export function helpText(): string {
  const ready = COMMANDS.filter((s) => s.status === "ready");
  const planned = COMMANDS.filter((s) => s.status === "planned");
  // Width is computed, not a literal 20, because a literal is a promise that the longest command name stays short —
  // and the moment one row is two characters too long the whole list runs together (`crabby config schemaprint…`).
  const width = Math.max(20, ...COMMANDS.map((s) => commandName(s).length + 2));
  const rows = ready.map((s) => `  ${commandName(s).padEnd(width)}${s.summary}`);
  const plannedRows = planned.map(
    (s) => `  ${commandName(s).padEnd(width)}${s.summary} — planned for ${s.milestone}`,
  );
  return [
    "crabby <noun> <verb> [args] [--flags]",
    "",
    "commands:",
    ...rows,
    "",
    "other commands from the contract, not implemented yet:",
    ...plannedRows,
    "",
    "global flags: --json, --data-dir DIR, --log-level debug|info|warn|error, --log-file PATH",
    "exit codes: 0 success, 1 failure, 2 usage/validation, 3 needs-approval, 4 platform-unsupported",
  ].join("\n");
}

/** Every name is printed with the binary in front of it, because the line has to be copy-pasteable: `init` on its own
 *  tells a reader nothing about what to type, and a prefix that had to be remembered per row would be a prefix that
 *  some rows forgot. */
export function commandName(spec: CommandSpec): string {
  return `crabby ${relativeName(spec)}`;
}

/** The same name as the process sees it — `argv` never contains the binary, so matching and suggestions work on this. */
export function relativeName(spec: CommandSpec): string {
  return spec.verb ? `${spec.noun} ${spec.verb}` : spec.noun;
}

/** Levenshtein, so "crabby tsk run" gets a suggestion rather than a shrug. `noUncheckedIndexedAccess` makes every
 *  read here a `number | undefined`, and spelling that out beats a cast that would hide the off-by-one. */
function editDistance(a: string, b: string): number {
  const row: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0] as number;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j] as number;
      row[j] = Math.min(
        current + 1,
        (row[j - 1] as number) + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prev = current;
    }
  }
  return row[b.length] as number;
}
