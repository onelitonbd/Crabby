// `docs/INTERFACES_AND_API.md` §7.1's rule that makes one grammar real: "`crabby --help` and `crabby <noun> --help` are generated from the same
// contract … so a command cannot exist in one interface only (the D-005 test)." The registry is that generation
// source for the CLI: help text, the unknown-command message, and the dispatch table all read this array, so adding
// a command without declaring it here is not possible.
//
// The Setup and Gateway rows of §7.1's table plus the `config` verbs D-074 and D-060 need. Everything else is
// `planned`, so that `--help` can be honest about the difference instead of silently omitting it: a user who reads a
// list of eleven commands should not have to guess whether the other forty exist somewhere else. A verb is promoted
// here only when it has a route behind it — `task run` stays `planned` because the loop that would run it
// (`packages/agent-runtime/loop.ts`) has no executor, no provider adapter and no Gateway runner, and a command that
// created a task nothing would move would be a mock with an exit code.
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
    flags: ["--data-dir DIR", "--enable-shell"],
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
    flags: ["--code CODE", "--name NAME", "--interface I", "--restrict <a,b>"],
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
    // `ready` because the rule this registry states is that a verb is listed only when it has a route behind it, and
    // `POST /api/v1/tasks/{id}/cancel` has one, tested end to end. The flags are §6.1's two phases and §6.2's override:
    // `--mode immediate` is the override that must beat finish-the-current-step, and `--reason` is the sentence that goes
    // on the record with the request. Leaving `--mode` off is the common case and the safe one, which is why the route
    // defaults it rather than demanding a choice at a moment a user is trying to stop something.
    noun: "task",
    verb: "cancel",
    summary: "ask a task to stop (§6.1), and print whether it did and what is in doubt (§6.2)",
    flags: ["--mode M", "--reason R", "--json"],
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
    // `ready` for the reason `task cancel` and `task watch` are: a route stands behind the verb. `POST /api/v1/tasks`
    // has stood there since M1c, and `ready` would still have been a lie until a runner was composed into it, because
    // this verb's contract is that it blocks and follows to an end (§7.1) and a task nothing drives has no end to
    // reach — it would print an id and then watch it sit in `queued`, which is what the milestone field used to say.
    // What is *still* absent is named rather than implied: `--wait-approval <n>`, §7.1's opt-in to keep blocking
    // through a prompt, is in no registry, so a run that parks at an approval exits 3 at once; and
    // `POST /tasks/{id}/resume` has no route, so the reattach line this verb prints names `task watch` rather than the
    // `task resume` the row in §7.1 was written around (F-47).
    status: "ready",
  },
  {
    noun: "chat",
    summary: "one-shot prompt; `--session <id>` continues a conversation",
    flags: ["--session ID", "--json"],
    status: "planned",
    milestone: "M2 (the runtime that answers a prompt)",
  },
  {
    // `ready` for the reason `task cancel` is: the rule is whether a route stands behind the verb, and `GET /events` has
    // stood behind this one since D-048 — filtered by `taskId`, replaying from `Last-Event-ID`, and answering a cursor
    // outside its window with §5.4's `gap` frame rather than silence. The milestone this entry carried named "event
    // delivery and gap handling", and both halves were already delivered server-side, so what was missing was the command
    // that reads them.
    noun: "task",
    verb: "watch",
    summary: "follow one task's events, NDJSON per line with `--json`",
    // `--types` is not a new promise: D-048 already accepted that `GET /events` filters by query (`sessionId`,
    // `taskId`, `types`), and the Gateway has split that value on commas and matched it as a prefix since the route was
    // written. What the flag adds is a terminal that can ask for the filter it was already entitled to.
    flags: ["--types <a,b>", "--json"],
    status: "ready",
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
    // `ready` because the milestone named a service that has been composed into the Gateway since before this entry was
    // written: `createApprovals` is built in `buildApp`, `registerApprovalRoutes` registers both §4.3 routes, and the
    // sweep the queue depends on (D-093) runs inside the read. `--state` is passed through to the route rather than
    // checked here, so a typo is refused by the Gateway naming all five states instead of being coerced into a filter
    // that matched nothing.
    noun: "approval",
    verb: "ls",
    summary: "the approval queue for this client, `pending` unless `--state` says otherwise",
    flags: ["--state <state>", "--json"],
    status: "ready",
  },
  {
    // The `--yes` this entry used to advertise is gone rather than implemented: it would have skipped a confirmation
    // prompt, and no code asks for one — `approval approve <id>` is itself the deliberate act, so the flag's only effect
    // would have been to tell a user that a prompt exists. There is no `--scope` either, and the reason is D-052 rather
    // than an oversight: this release admits exactly one answer shape, so every value but `once` is a refusal the arbiter
    // owes a sentence about, and a knob that can only fail is not a knob. The body's `scope` stays a string on the HTTP
    // surface precisely so that refusal can be provoked and tested there.
    noun: "approval",
    verb: "approve",
    summary: "approve one action, once (D-052: the only answer shape)",
    flags: ["--json"],
    status: "ready",
  },
  {
    // The summary promised "record why" and the route cannot keep that promise: `ApprovalDecisionBody` carries `decision`
    // and an optional `scope`, and no reason field, so a `--reason` here would have been read, accepted, and dropped —
    // losing silently the one thing the user offered. The summary is narrowed to what the record does hold, which is §14's
    // audit fields written by the route from the answering identity: who decided, from which surface, and what they
    // decided. Adding a reason is a change to §4.3's body and to the arbiter's record, not to a CLI flag.
    noun: "approval",
    verb: "deny",
    summary: "deny one action, once",
    flags: ["--json"],
    status: "ready",
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
    summary: "conversations: id, title, last activity, state word, model, origin (C11-01)",
    flags: ["--origin I", "--quiet", "--json"],
    // `ready` because the record behind it is: schema version 6 gave a conversation a row of its own, so
    // `GET /api/v1/sessions` answers with titles, state words and last activity instead of ids that nothing owns — which
    // is C11's whole reason for the noun, "without `session ls` the only way to resume on a phone is to remember an id".
    // Sorted by last activity and not by creation, because C11-01 says that is "the order a person remembers in", and
    // `--quiet` is ids alone for the pipe §10 promises.
    status: "ready",
  },
  {
    noun: "session",
    verb: "new",
    summary: "start a conversation, optionally titled (C11-02)",
    flags: ["--title T", "--json"],
    // W15-03's shape: with no `--title` the session is created un-named and takes its title from the first question asked
    // in it, so the flag is optional rather than required. The verb prints the id *and* the command that uses it, because
    // C11-02's own sentence is "a created thing you cannot address is a bug".
    status: "ready",
  },
  {
    noun: "session",
    verb: "show",
    summary: "one conversation: title, turns, tasks, budget, pinned items (C11-03)",
    flags: ["--json"],
    // Planned and not missing, and the distinction is the whole row. C11-03's content is five fields and three of them —
    // turns, budget, pinned items — need a message store and D-027's context manager. `GET /api/v1/sessions/{id}` answers
    // the two that exist and names the other three in its `absent` list, so the route is honest about it; a verb that
    // printed the same zeroes at a person would be printing a screen full of nothing.
    status: "planned",
    milestone: "the release that stores messages (§4.3's `messages` paths, C11-03, D-027)",
  },
  {
    noun: "session",
    verb: "rename",
    summary: "change a conversation's title (C11-04)",
    flags: ["--json"],
    // Writes through `PATCH /api/v1/sessions/{id}` with the revision the read carried, so the Web title and the TUI list
    // change with it rather than after it (C11-04) and two interfaces editing one title cannot silently overwrite each
    // other (§2's concurrency row, W1-02, W15-04, T16-05).
    status: "ready",
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
    summary: "scheduled jobs: name, schedule, next run, last outcome, state word (C12-01)",
    flags: ["--state S", "--quiet", "--json"],
    // `ready` because the route behind it is: `GET /api/v1/jobs` answers from the job table whether or not this Gateway
    // composed a scheduler, and says which of those it is (`driven`) instead of listing rows that cannot fire. `--quiet`
    // is ids only, for §10's scripting contract.
    status: "ready",
  },
  {
    noun: "job",
    verb: "show",
    summary: "one job: the capability set it holds, who it runs as, its last runs (C12-02)",
    flags: ["--json"],
    status: "ready",
  },
  {
    noun: "job",
    verb: "pause",
    summary: "stop a job firing until resumed; takes effect before the next tick (C12-03)",
    flags: ["--json"],
    status: "ready",
  },
  {
    noun: "job",
    verb: "resume",
    summary:
      "start a paused job again, re-evaluating the grants rather than trusting the last evaluation (C12-03)",
    flags: ["--json"],
    status: "ready",
  },
  {
    noun: "job",
    verb: "run-now",
    summary:
      "one run outside the schedule, followed to its end; exit 3 if it stops at an approval (C12-04)",
    flags: ["--json", "--detach"],
    status: "ready",
  },
  {
    noun: "job",
    verb: "backlog",
    summary:
      "answer for the runs that passed while the host was down: --latest or --skip, recorded either way (C12-06)",
    flags: ["--latest", "--skip", "--json"],
    // Not in §7.1's inventory row when it was written, and added to it by the slice that built it: C12-06 documents the
    // verb, `POST /api/v1/jobs/{id}/backlog` answers it, and §4.5's sixth rule is the reason it exists. A noun whose
    // documented behaviour no interface can perform is the parity rule broken in the direction nobody notices.
    status: "ready",
  },
  {
    noun: "job",
    verb: "edit",
    summary: "change what a job runs",
    flags: [],
    // Planned and not missing, and the distinction is the whole row. C12-05's content is "schedule, objective, model,
    // recipients" — the material half — which §4.5 prices as re-approval, and no route in this build can open an approval
    // (D-084): a verb that wrote the objective would be a material change riding on the old authorisation, exactly what
    // C12-05 says cannot happen. The non-material half does have a route, `PATCH /api/v1/jobs/{id}` (name and schedule,
    // with `objective` absent from the body schema so the refusal is structural), which W16-06's edit sheet uses; the verb
    // arrives when an edit can carry a re-approval with it rather than implying one happened.
    status: "planned",
    milestone: "the first release that can re-approve a material change (§4.5, D-084)",
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
