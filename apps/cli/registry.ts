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
    noun: "diagnostics",
    summary: "write the sanitized report the Web's Export button produces, and print where it went",
    flags: ["--json"],
    status: "ready",
  },
  {
    noun: "tools",
    verb: "ls",
    summary: "every tool with tier, capability, enabled state, and platform availability",
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
  {
    noun: "chat",
    summary: "one-shot prompt; `--session <id>` continues a conversation",
    flags: ["--session ID", "--json"],
    status: "planned",
    milestone: "M2 (the runtime that answers a prompt)",
  },
  {
    noun: "task",
    verb: "watch",
    summary: "follow one task's events, NDJSON per line with `--json`",
    flags: ["--json"],
    status: "planned",
    milestone: "M2 (event delivery and gap handling)",
  },
  {
    noun: "task",
    verb: "cancel",
    summary: "ask for cancellation and report the settled state",
    flags: ["--json"],
    status: "planned",
    milestone: "M2 (cancellation manager)",
  },
  {
    noun: "task",
    verb: "resume",
    summary: "explicit resume after an auto-recovery decline",
    flags: ["--json"],
    status: "planned",
    milestone: "M2 (recovery that cannot bypass approvals)",
  },
  {
    noun: "approval",
    verb: "ls",
    summary: "the pending approval queue for this client",
    flags: ["--json"],
    status: "planned",
    milestone: "M2 (the approval service)",
  },
  {
    noun: "approval",
    verb: "approve",
    summary: "approve one action, once (D-052: the only answer shape)",
    flags: ["--yes"],
    status: "planned",
    milestone: "M2 (the approval service)",
  },
  {
    noun: "approval",
    verb: "deny",
    summary: "deny one action and record why",
    flags: [],
    status: "planned",
    milestone: "M2 (the approval service)",
  },
  {
    noun: "provider",
    verb: "add",
    summary: "register a provider adapter",
    flags: [],
    status: "planned",
    milestone: "M4 (provider adapters, docs/ROADMAP.md §6)",
  },
  {
    noun: "provider",
    verb: "list",
    summary: "configured providers and their status",
    flags: ["--json"],
    status: "planned",
    milestone: "M4 (provider adapters)",
  },
  {
    noun: "provider",
    verb: "remove",
    summary: "drop a provider from configuration",
    flags: [],
    status: "planned",
    milestone: "M4 (provider adapters)",
  },
  {
    noun: "model",
    verb: "list",
    summary: "models per provider with limits and capabilities",
    flags: ["--json"],
    status: "planned",
    milestone: "M4 (the §3.2 descriptor cache)",
  },
  {
    noun: "model",
    verb: "edit",
    summary: "set or clear a model override",
    flags: [],
    status: "planned",
    milestone: "M4 (provider configuration)",
  },
  {
    noun: "model",
    verb: "probe",
    summary: "verify a model's declared capabilities against the §7 suite",
    flags: [],
    status: "planned",
    milestone: "M4 (provider conformance at runtime)",
  },
  {
    noun: "memory",
    verb: "list",
    summary: "review stored long-term memory",
    flags: ["--json"],
    status: "planned",
    milestone: "M4 (memory, docs/ROADMAP.md §6)",
  },
  {
    noun: "memory",
    verb: "search",
    summary: "search memory entries",
    flags: ["--json"],
    status: "planned",
    milestone: "M4 (memory)",
  },
  {
    noun: "memory",
    verb: "forget",
    summary: "delete one entry or everything about a subject (T2/T3)",
    flags: ["--yes"],
    status: "planned",
    milestone: "M4 (memory)",
  },
  {
    noun: "history",
    verb: "export",
    summary: "write a sanitized export and name the artifact",
    flags: ["--format F"],
    status: "planned",
    milestone: "M2 (`POST /sessions/{id}/export`)",
  },
  {
    noun: "history",
    verb: "delete-session",
    summary: "delete a conversation — the one destructive session verb",
    flags: ["--yes"],
    status: "planned",
    milestone: "M2 (session deletion)",
  },
  {
    noun: "context",
    verb: "show",
    summary: "what is in budget, compacted, and pinned",
    flags: ["--json"],
    status: "planned",
    milestone: "M2 (the context manager)",
  },
  {
    noun: "context",
    verb: "pin",
    summary: "keep a ref alive through compaction",
    flags: ["--remove"],
    status: "planned",
    milestone: "M2 (the context manager)",
  },
  {
    noun: "session",
    verb: "ls",
    summary: "list conversations",
    flags: ["--json"],
    status: "planned",
    milestone: "M2 (the session manager)",
  },
  {
    noun: "session",
    verb: "new",
    summary: "start a conversation, optionally titled",
    flags: ["--title T"],
    status: "planned",
    milestone: "M2 (the session manager)",
  },
  {
    noun: "session",
    verb: "show",
    summary: "one conversation with its tail",
    flags: ["--json"],
    status: "planned",
    milestone: "M2 (the session manager)",
  },
  {
    noun: "session",
    verb: "rename",
    summary: "change a conversation's title",
    flags: [],
    status: "planned",
    milestone: "M2 (the session manager)",
  },
  {
    noun: "session",
    verb: "compact",
    summary: "summarize now instead of at the budget limit (D-027)",
    flags: [],
    status: "planned",
    milestone: "M2 (hybrid compaction)",
  },
  {
    noun: "job",
    verb: "ls",
    summary: "scheduled jobs and their next run",
    flags: ["--json"],
    status: "planned",
    milestone: "M2 (the scheduler, D-046)",
  },
  {
    noun: "job",
    verb: "show",
    summary: "one job's plan and last runs",
    flags: ["--json"],
    status: "planned",
    milestone: "M2 (the scheduler)",
  },
  {
    noun: "job",
    verb: "pause",
    summary: "stop a job firing until resumed",
    flags: [],
    status: "planned",
    milestone: "M2 (the scheduler; a job you cannot pause is standing authority, D-057)",
  },
  {
    noun: "job",
    verb: "resume",
    summary: "start a paused job again",
    flags: [],
    status: "planned",
    milestone: "M2 (the scheduler)",
  },
  {
    noun: "job",
    verb: "run-now",
    summary: "trigger one run without changing the schedule",
    flags: [],
    status: "planned",
    milestone: "M2 (the scheduler)",
  },
  {
    noun: "job",
    verb: "edit",
    summary: "change what a job runs",
    flags: [],
    status: "planned",
    milestone: "M2 (the scheduler; T2/T3 by what changes)",
  },
  {
    noun: "logs",
    summary: "structured operational logs, redacted",
    flags: ["--level L", "--json"],
    status: "planned",
    milestone: "M2 (`GET /logs`)",
  },
  {
    noun: "audit",
    summary: "the security-relevant record (SECURITY.md §14)",
    flags: ["--json"],
    status: "planned",
    milestone: "M2 (`GET /audit`)",
  },
  {
    noun: "ext",
    verb: "init",
    summary: "scaffold a local extension",
    flags: [],
    status: "planned",
    milestone: "M4 (extensions, docs/ROADMAP.md §6)",
  },
  {
    noun: "ext",
    verb: "validate",
    summary: "validate a SKILL.md or extension directory",
    flags: [],
    status: "planned",
    milestone: "M4 (extensions)",
  },
  {
    noun: "ext",
    verb: "check-compat",
    summary: "report which capabilities an extension needs that this build lacks",
    flags: [],
    status: "planned",
    milestone: "M4 (extensions)",
  },
  {
    noun: "ext",
    verb: "install",
    summary: "install an extension (T2/T3 by kind; executable kinds are blocked, D-038)",
    flags: ["--yes"],
    status: "planned",
    milestone: "M4 (extensions)",
  },
  {
    noun: "ext",
    verb: "list",
    summary: "installed extensions and their metadata",
    flags: ["--json"],
    status: "planned",
    milestone: "M4 (extensions)",
  },
  {
    noun: "ext",
    verb: "info",
    summary: "one extension's manifest and reports",
    flags: ["--json"],
    status: "planned",
    milestone: "M4 (extensions)",
  },
  {
    noun: "ext",
    verb: "update",
    summary: "update an extension from its source",
    flags: [],
    status: "planned",
    milestone: "M4 (extensions)",
  },
  {
    noun: "ext",
    verb: "uninstall",
    summary: "remove an extension; `--purge-data` is T3",
    flags: ["--purge-data"],
    status: "planned",
    milestone: "M4 (extensions)",
  },
  {
    noun: "gateway",
    verb: "stop",
    summary: "ask a running Gateway to drain and exit (D-066)",
    flags: [],
    status: "planned",
    milestone: "M2 (the supervisor `start` is foreground for)",
  },
  {
    noun: "gateway",
    verb: "restart",
    summary: "drain, restart, and print who was disconnected (T3, D-058)",
    flags: ["--yes"],
    status: "planned",
    milestone: "M2 (restart is T3 and needs the approval service)",
  },
  {
    noun: "tunnel",
    verb: "on",
    summary: "expose the Gateway through a tunnel (T3, SECURITY.md §13)",
    flags: [],
    status: "planned",
    milestone: "the tunnel slice — SECURITY.md §13 keeps tunnels out of the initial release",
  },
  {
    noun: "tunnel",
    verb: "off",
    summary: "revoke exposure and close the listener",
    flags: [],
    status: "planned",
    milestone: "the tunnel slice — SECURITY.md §13 keeps tunnels out of the initial release",
  },
  {
    noun: "tunnel",
    verb: "status",
    summary: "the current URL and which identities are reachable",
    flags: ["--json"],
    status: "planned",
    milestone: "the tunnel slice — SECURITY.md §13 keeps tunnels out of the initial release",
  },
  {
    noun: "web",
    verb: "open",
    summary: "the Web control UI's address and a pairing hint",
    flags: [],
    status: "planned",
    milestone: "M3 (the Web interface)",
  },
  {
    noun: "telegram",
    verb: "start",
    summary: "run the Telegram bot against this Gateway",
    flags: [],
    status: "planned",
    milestone: "M3 (the Telegram interface)",
  },
  {
    noun: "tui",
    summary: "the interactive terminal client",
    flags: [],
    status: "planned",
    milestone: "M3 (the TUI, after P-011 resolves Ink)",
  },
];

// The planned half of §7.1's table, in one block, generated from the same array the help text reads. Every command the
// document lists is here — `ready` when a route answers it and `planned` with the milestone that will — because
// "a command cannot exist in one interface only" (D-005) is only checkable if the CLI's own grammar is complete:
// `scripts/parity.ts` fails when §8 names a command this array does not have, and when this array has a *ready*
// command the document does not list.

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
