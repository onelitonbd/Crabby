// `docs/INTERFACES_AND_API.md` §7.1's rule that makes one grammar real: "`crabby --help` and `crabby <noun> --help` are generated from the same
// contract … so a command cannot exist in one interface only (the D-005 test)." The registry is that generation
// source for the CLI: help text, the unknown-command message, and the dispatch table all read this array, so adding
// a command without declaring it here is not possible.
//
// Only the Setup row of §7.1's table is implemented in M1a, plus the `config` verbs D-074 and D-060 need. Everything
// else is `planned` so that `--help` can be honest about the difference instead of silently omitting it: a user who
// reads a list of four commands should not have to guess whether the other forty exist somewhere else.
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
    summary: "gateway, task and approval state at a glance",
    flags: ["--json"],
    status: "planned",
    milestone: "M1",
  },
  {
    noun: "gateway",
    verb: "start",
    summary: "run the Gateway on 127.0.0.1",
    flags: ["--host", "--log-level"],
    status: "planned",
    milestone: "M1",
  },
  {
    noun: "task",
    verb: "run",
    summary: "create a task and follow it (blocks; `--detach` for scripts)",
    flags: ["--json", "--detach"],
    status: "planned",
    milestone: "M1",
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
  const rows = ready.map((s) => `  ${commandName(s).padEnd(20)}${s.summary}`);
  const plannedRows = planned.map(
    (s) => `  ${commandName(s).padEnd(20)}${s.summary} — planned for ${s.milestone}`,
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
