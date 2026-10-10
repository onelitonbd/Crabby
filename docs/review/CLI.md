# Element Review — CLI

> **Purpose:** the CLI is an equal interface, not a debug door (`ARCHITECTURE.md` §18, D-005). This file lists every
> element of it — commands, flags, output shapes, and the small mechanical promises scripts depend on — one row at a
> time, so the owner can read, edit, and approve each with the same weight (D-055).
>
> **Reviewed 2026-10-10 by the delegated reviewer (D-075)** — the owner delegated this pass for lack of time and kept
> review at the point of implementation, one step at a time (D-076). Criteria, the scan that applied them, and the
> exceptions are in `docs/review/README.md`; nothing here is unchangeable, and a veto follows the same procedure as
> an (R) row.
>
> **Status legend for the `Status` column**
> `PROPOSED` = awaiting review · `ACCEPTED` = approved and locked for implementation (by the owner, or by the
> D-075 pass) · `EDIT` = reviewer changed it, text is being updated · `CUT` = removed, with the capability's new home
> named · `?` = a blocking question. `ACCEPTED` never means unchangeable: D-076 reopens a row at the step that builds it.
>
> **IDs:** `C` = CLI · region number (or `-letter` for a named region) · element number. Quote an ID when you want
> to change one thing.
>
> **The binding case here is a pipe, not a terminal.** Most defects in a CLI come from what happens when output is
> redirected, when input is not a keyboard, or when another program is reading the exit code — so those rows are
> listed with the same care as the command list itself.
>
> **Review medium:** the CLI is reviewed as this table. Its "mockup" is `--help` output, which is generated from the
> same contract (`docs/INTERFACES_AND_API.md` §7.1), and cannot exist before implementation; nothing here claims one
> does.

---

## 1. Invocation

### Region C1 — Grammar and help

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| C1-01 | Command grammar | `crabby <noun> <verb> [args] [--flags]` | one line | the one contract every interface maps to; no noun-verb pair exists only here (`docs/INTERFACES_AND_API.md` §7.1) | ACCEPTED |
| C1-02 | Global flags | `--json` `--quiet` `--plain` `--wide` `--restrict <caps>` `--session <id>` | one line each | accepted on every command that produces output; a flag that exists for one command only is a defect | ACCEPTED |
| C1-03 | Top-level help | `crabby --help` — command list grouped by area | fits any width, wraps at 80 | generated from the same registry the TUI and Web read, so it cannot list a command that does not exist | ACCEPTED |
| C1-04 | Area help | `crabby task --help` | same | lists verbs, one line each, with the exit codes that verb can return | ACCEPTED |
| C1-05 | Command help | `crabby task run --help` | same | flags, defaults, one example, and what approval a T2/T3 call would require | ACCEPTED |
| C1-06 | Unknown noun or verb | typo handling | one line | names the closest real command and exits `2`; a wall of usage text on a typo is how people stop using a tool | ACCEPTED |
| C1-07 | Missing argument | required arg absent | one line | says which argument and shows the correct shape once; no partial execution | ACCEPTED |
| C1-08 | Flag with a bad value | `--format=yaml` on a json-only command | one line | says the allowed values, and does not silently fall back to the default | ACCEPTED |
| C1-09 | Version and build | `crabby version` | 1–3 lines | version, commit, Node version, Termux detected yes/no — and no update action, because self-updating is out (D-050) | ACCEPTED |
| C1-10 | Deprecated or absent command | asking for `crabby update` | one line | says plainly that it does not exist and which command replaces it (clone + pull, per D-050), rather than a generic usage error | ACCEPTED |
| C1-11 | Command aliases | short forms | n/a | none in v1 unless a row here says otherwise; aliases make `--help` lie about the surface | ACCEPTED |
| C1-12 | Non-UTF8 locale | argument text that is not valid UTF-8 | n/a | rejected with a clear line; never a stack trace, and never a mangled write to disk | ACCEPTED |

### Region C2 — Output modes

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| C2-01 | TTY detection | whether this is a terminal | n/a | no color, no box-drawing, no spinner, no progress bar when it is not a TTY (`docs/UI_UX_SPEC.md` §6) | ACCEPTED |
| C2-02 | Color suppression | `NO_COLOR`, `TERM=dumb`, `--plain` | n/a | all three remove color; `--plain` additionally removes Unicode, so pipes and pastes read identically | ACCEPTED |
| C2-03 | JSON mode | `--json` on every read command | n/a | stable keys, snake_case, and no key reordering between releases without a deprecation note | ACCEPTED |
| C2-04 | Ids only | `--quiet` | one id per line | pipeable by design: `crabby task ls --quiet \| xargs -n1 crabby task show` | ACCEPTED |
| C2-05 | Compact vs wide tables | default vs `--wide` | 80-column default | `--wide` adds columns; nothing ever wraps a cell to fit, because a wrapped path is unusable | ACCEPTED |
| C2-06 | Progress vs result split | progress to stderr, result to stdout | n/a | keeps `crabby task run "…" > out.txt` clean; a progress bar in stdout is a data corruption bug | ACCEPTED |
| C2-07 | Spinner | only on a TTY, only while waiting | 1 glyph | never while output is being piped, and never for more than the wait it represents | ACCEPTED |
| C2-08 | Redaction in output | secret-looking values | in place | the same redaction the logs use, including under `--debug`; a flag that turns redaction off is not offered | ACCEPTED |
| C2-09 | Long text from the model | markdown, code fences, Bengali | full width | printed as received, wrapped by character cell width; no emoji-aware or Indic-aware cleverness that could corrupt the bytes | ACCEPTED |
| C2-10 | Prompt-free guarantee | nothing ever waits for input unless asked | n/a | a read command must never block on a prompt in a non-TTY; it returns `3` (needs approval) or fails with usage instead | ACCEPTED |
| C2-11 | Exit status of the pager | no pager by default | n/a | long output prints to stdout in full; `--pager` is opt-in and is disabled when not a TTY | ACCEPTED |

### Region C3 — Exit codes and errors

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| C3-01 | Success | `0` | n/a | the command did what it said, including "task queued" only if that is what the command promised | ACCEPTED |
| C3-02 | Failure | `1` | n/a | a real failure while doing the work | ACCEPTED |
| C3-03 | Usage or validation | `2` | n/a | never used for runtime problems, or scripts cannot branch on it | ACCEPTED |
| C3-04 | Needs approval | `3` | n/a | the documented way a script detects "a human must answer", per `docs/INTERFACES_AND_API.md` §7.1 | ACCEPTED |
| C3-05 | Platform unsupported | `4` | n/a | e.g. a Termux-only tool requested on a laptop — distinct from failure so CI can skip it | ACCEPTED |
| C3-06 | Error line shape | `code: one human line` | ≤2 lines | `code` is machine-stable and greppable; the human line never contains a secret or a token | ACCEPTED |
| C3-07 | Request id on failure | printed with every error | one line | same id the Web and TUI show, so one bug report covers all four interfaces | ACCEPTED |
| C3-08 | JSON error body | `--json` with a failure | n/a | the error envelope on stdout plus the same exit code, because a script parsing output should not have to guess | ACCEPTED |
| C3-09 | Partial output on error | what already streamed | n/a | kept, with a labeled line that it stopped — a silently discarded half-answer is the worst case | ACCEPTED |
| C3-10 | Retries visible | provider retry attempts | one line per attempt | the ladder is printed to stderr as it happens (D-043), including when it asks and gets no answer in a non-TTY | ACCEPTED |
| C3-11 | Crash guard | unexpected exception | 3 lines max | prints the error, the request id, and where the log lives; no raw stack dumped as the only output | ACCEPTED |

---

## 2. Setup and health

### Region C4 — init, doctor, status

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| C4-01 | init: environment check | Node version, Termux or not, build tools, free space | one line each | the same six-step path as `docs/UI_UX_SPEC.md` §5, and the same sentences | ACCEPTED |
| C4-02 | init: model path | free endpoint, local, or skip | one question | skipping is a supported answer and lands in read-only mode with approvals for everything | ACCEPTED |
| C4-03 | init: workspace root | default plus the deny-list shown | one line | the deny-list is printed at setup time, not discovered later | ACCEPTED |
| C4-04 | init: shell access | default off, with the no-sandbox sentence | 2 lines | the sentence appears in the same words as Web W11-05 and TUI T12-05 | ACCEPTED |
| C4-05 | init: pair an interface | TUI ready; Web URL and Telegram steps offered | 1–3 lines | pairing from the CLI is a local action (D-053), and says so | ACCEPTED |
| C4-06 | init: first task | one command that finishes in seconds | n/a | proves the loop end to end before the user trusts anything bigger | ACCEPTED |
| C4-07 | doctor: findings | the checks, one per line, with severity | full width | the Web doctor panel and this command must print the same set of findings, not two dialects | ACCEPTED |
| C4-08 | doctor: fixes | each finding carries the exact fix command | one line below the finding | fixes are printed as commands the user can run; `--fix` applies only the ones that are file-safe and says what it touched | ACCEPTED |
| C4-09 | doctor: Termux storage process | whether the Gateway survived a background kill | 2 lines | the failure mode is Android killing the process, and the doctor names it as such | ACCEPTED |
| C4-10 | status | Gateway reachable, listener, tunnel, vault, pending approvals, queue depth | 6–10 lines | one command that answers "why is nothing happening"; `--json` gives the same shape to scripts | ACCEPTED |
| C4-11 | status while the Gateway is down | unreachable | 3 lines | exit `1`, prints the start command, and does not hang until a timeout | ACCEPTED |
| C4-12 | logs from the CLI | `crabby status --logs` | last N lines | tail, redacted, and it says the count it omitted when it truncates | ACCEPTED |

---

## 3. Chat and tasks

### Region C5 — One-shot chat

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| C5-01 | chat: one-shot question | `crabby chat "…"` | full width | plain question, no task, no plan; the answer streams to stdout | ACCEPTED |
| C5-02 | Stdin input | `crabby chat -` or a pipe | n/a | reads until EOF, so `pbpaste \| crabby chat -` works; an empty stdin is an error, not a hang | ACCEPTED |
| C5-03 | Session continuation | `crabby chat --session <id>` | n/a | the same session the Web and TUI see; ids are printed on one selectable line | ACCEPTED |
| C5-04 | Model for this call | `--model <p>/<m>` | n/a | one-turn override with the capability delta warning if tool calling is off (D-045) | ACCEPTED |
| C5-05 | Answer with tool calls in it | collapsed tool lines on stderr | one line per call | `--plain` prints them inline; nothing about the run is hidden by default when a human asked | ACCEPTED |
| C5-06 | Attach a file | `--file <path>` repeatable | one line per path | workspace roots only, deny-list applied, and the resolved path is echoed before use | ACCEPTED |
| C5-07 | Cancel while streaming | `Ctrl-C` once | n/a | stops generation for this call, prints what it had, and never kills the Gateway; a second `Ctrl-C` still will not | ACCEPTED |
| C5-08 | Long answer | multi-KB text | full width | written out in full; the option to save to a file is printed as a hint, not applied silently | ACCEPTED |
| C5-09 | Output format | `--json` returns the turn object | n/a | includes usage, model actually used, and the request id | ACCEPTED |

### Region C6 — Task commands

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| C6-01 | task run | `crabby task run "<objective>"` | n/a | creates the task through the same endpoint the Web uses; Open question **C6-A** — closed below — about what it prints when the task is not finished — decided in D-063 | ACCEPTED |
| C6-02 | task run: detach | `--detach` returns the id immediately | one line | for cron and scripts; the id is the only thing on stdout with `--quiet` | ACCEPTED |
| C6-03 | task run: tier floor | `--tier-floor T2` | n/a | can only raise the floor, never lower it below the configured minimum | ACCEPTED |
| C6-04 | task run: capability narrowing | `--fs-root`, `--no-net`, `--no-shell` | one line each | the same per-task narrowing as Web W11-08 and TUI T12-08 (open O-025) — decided in D-066 | ACCEPTED |
| C6-05 | task ls | id, state, objective, model, elapsed, pending-approval count | compact by default | `--wide` adds columns; `--state running` filters; empty list prints nothing with `--quiet` and a sentence without it | ACCEPTED |
| C6-06 | task show | the same content as Web W6 and TUI T7 | up to 40 lines | plan tree with indentation, checkpoint, ladder, artifacts, result; `--json` gives the whole object | ACCEPTED |
| C6-07 | task watch | streams this task's events until terminal | n/a | NDJSON on stdout with `--json` (one event per line, per-task `seq`, D-049), human lines otherwise; Open question **C6-B** — decided in D-063 | ACCEPTED |
| C6-08 | task watch exit | `Ctrl-C` while watching | n/a | detaches the watcher only; the task keeps running. Cancel is a separate command, and mixing the two is the classic way to lose work | ACCEPTED |
| C6-09 | task cancel | `crabby task cancel <id>` | 2 lines | the three-phase cancel is printed as it happens (requested → finishing current step → settled), and the command exits after the terminal state | ACCEPTED |
| C6-10 | task resume | `crabby task resume <id>` | 2 lines | resumes from the checkpoint and prints what will be skipped vs repeated, so nothing re-runs silently (D-044) | ACCEPTED |
| C6-11 | task export | `crabby task show <id> --json > t.json` | n/a | the export is the same artifact the Web produces (`POST /sessions/{id}/export`), not a second format | ACCEPTED |
| C6-12 | Id that does not exist | unknown id | one line | `1` with `not-found`, and it never reveals whether the id exists in another identity's scope | ACCEPTED |

**Open question C6-A:** does `crabby task run` block until the task finishes (simple, and a phone terminal holds the
session) or queue and return the id (scriptable, but the user has to run a second command)? Proposal: block by
default, with `--detach` for scripts, and the printed id + resume command on the first line so losing the terminal
costs nothing.

> **C6-A — closed (D-063).** Decided: **it blocks**, with the task id and the resume command on the first line so a closed terminal loses nothing, and `--detach` for scripts.

**Open question C6-B:** the watch stream contract. NDJSON with per-task `seq` is proposed so a script can detect a
gap the same way the Web does; the alternative is a human-only tail with no machine mode. Machine-readable is
strongly preferred — a capability that exists in the Web and TUI but not in scripts breaks the parity rule.

---

> **C6-B — closed (D-063).** Decided: **NDJSON**, one event per line, each carrying the per-task `seq` (D-049) so a script notices a dropped event exactly as the Web does. A `--json` snapshot stays one document; the stream is the only multi-line output and the help says so.

## 4. Approvals

### Region C-A — The approval commands

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| C-A1 | approval ls | pending items with task, tool, tier, exact target, expiry | 2 lines per item | oldest first; empty output is a clean "nothing pending", not a blank shell | ACCEPTED |
| C-A2 | Full card | `crabby approval show <id>` | up to 12 lines | the same fields as Web W-A1…W-A5 and TUI T-A1…T-A5; no interface gets a shorter explanation of what it is approving | ACCEPTED |
| C-A3 | Exact target in full | the real command / path / recipient / URL / SQL | own line, untruncated | this is the line the user actually decides on, so it is never wrapped into pieces | ACCEPTED |
| C-A4 | approval approve | `crabby approval approve <id>` | one line | approves once (D-052); prints the decision, who made it, and which client | ACCEPTED |
| C-A5 | approval deny | `crabby approval deny <id> --reason "…"` | one line | the reason is recorded on the task, and the denial prints what will not happen | ACCEPTED |
| C-A6 | Already answered | second answer from another interface | one line | prints the `conflict` outcome and that the first answer won; exit `1`, so scripts do not assume success | ACCEPTED |
| C-A7 | Expired item | answering after expiry | one line | says it expired and what the user can do now; a stale approval is never silently approvable | ACCEPTED |
| C-A8 | Approve by task, not by id | `--task <id> --all-pending` | n/a | absent in v1: approving a set is how a wrong write becomes permanent, and the row exists so the absence is a decision | ACCEPTED |
| C-A9 | Waiting for an approval in a script | `--wait-approval <seconds>` | n/a | open question **C-A-A** below; without something like it, `crabby task run` from cron is either a hang or a failure — decided in D-063 | ACCEPTED |
| C-A10 | Non-interactive denial | no stdin and no `--yes` where the command needs one | one line | fails with exit `3` and the exact command to approve, rather than prompting into the void | ACCEPTED |

**Open question C-A-A:** should a CLI run be allowed to block until a human answers (`--wait-approval`), or should it
always exit `3` immediately and let the user approve later? Exiting immediately is honest and scriptable; blocking
matches the mental model of "I am running this now". Proposal: exit `3` by default, with an explicit
`--wait-approval <n>` opt-in, because a silent blocking command in a cron job is an outage.

---

> **C-A-A — closed (D-063).** Decided: **exit `3` immediately** when no human is reachable, `--wait-approval <n>` as the explicit opt-in. A command that silently waits inside a cron job is an outage that waits to be discovered.

## 5. Providers, models, config

### Region C7 — Configuration commands

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| C7-01 | provider add | name, base URL, model ids; key by reference | one line per field | a user-defined OpenAI-compatible endpoint needs no code change and no release (D-041) | ACCEPTED |
| C7-02 | Key entry path | `--key-stdin` or `--key-file` only | n/a | never `--key <secret>`: argv is visible in `ps` and in shell history, and this row is the reason the option does not exist | ACCEPTED |
| C7-03 | provider list | preset vs user-defined, base URL, model count, last success | 1 line each | base URL is not a secret and is shown in full (`PROVIDERS_AND_TOOLS.md` §3.3) | ACCEPTED |
| C7-04 | provider remove | names how many tasks are pinned to it | 2 lines | same warning as Web W9-06 and TUI T10-07 | ACCEPTED |
| C7-05 | provider test | latency and the error class | one line | the same test the UI triggers; a pass here must mean the UI will pass too | ACCEPTED |
| C7-06 | Insecure transport warning | plain HTTP or non-loopback with a key stored | 2 lines | refuses without `--allow-insecure` and prints why, rather than warning and continuing | ACCEPTED |
| C7-07 | model list | provider, model, context, output cap, cost class, overrides | 1 line per model | `--json` includes the capability descriptor with the priority order the data model already fixes (user → preset → discovery → adapter) | ACCEPTED |
| C7-08 | model edit | per-field prompts, or flags, or both | n/a | the interaction shape is open (O-037 closed by D-064); both paths must reach the same stored value — decided in D-064 | ACCEPTED |
| C7-09 | model probe | per-capability pass/fail table | up to 10 lines | same probe the UI calls; output is stable enough to diff | ACCEPTED |
| C7-10 | config get / set | `crabby config set <key> <value>` | one line | shows the diff before writing (the same rule as Web W12-02), and `--yes` is required for T3 keys | ACCEPTED |
| C7-11 | config path / schema | where the file is; the full schema | n/a | `config schema --json` is what a completion script or an editor plugin would read | ACCEPTED |
| C7-12 | Identity for CLI actions | which identity a CLI call runs as | one line in status | a local CLI invocation is the owner identity; `--restrict` narrows it, and narrowing never queues an approval (D-054) | ACCEPTED |
| C7-13 | Config written while the Gateway runs | hot reload or restart needed | one line | prints which it is; "restart to apply" discovered later is a support ticket | ACCEPTED |

---

## 6. Extensions

### Region C-E — ext commands

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| C-E1 | ext init | scaffold a skill in place | 5–10 lines | the same skeleton the Web button produces (W-E11), and it prints the path it wrote | ACCEPTED |
| C-E2 | ext validate | manifest, fields, capability names | 1 line per check | exit `2` on a bad manifest, with the failing key named | ACCEPTED |
| C-E3 | ext check-compat | the compat pipeline verdict | up to 15 lines | compatible / partial / incompatible / unsafe, with the exact failed check (`EXTENSIONS.md` §6.1) | ACCEPTED |
| C-E4 | Conversion report | mapped / dropped / reinterpreted / unknown | paged | written to a file per version and never overwritten (D-039); the path is printed | ACCEPTED |
| C-E5 | Report diff | `ext check-compat <id> --diff <older-version>` | unified diff | diffable on purpose, because "what changed between v1 and v2" is the question that matters | ACCEPTED |
| C-E6 | ext install | validate → verdict → capability diff → approval | step lines | an `unsafe` verdict stops the command; there is no override flag to search for (D-036, D-038) | ACCEPTED |
| C-E7 | Install size report | size and dependency count before approval | one line | printed before the confirmation prompt, per `EXTENSIONS.md` §9 | ACCEPTED |
| C-E8 | ext list | id, kind, version, source tier, verdict, enabled | 1 line each | `--json` for scripts; suspended items carry the failing check inline | ACCEPTED |
| C-E9 | ext info | one extension, everything known about it | up to 20 lines | grants, hooks it wanted, files it owns, last error | ACCEPTED |
| C-E10 | ext update | re-run validation and the converter | n/a | shows the report diff and the new verdict before replacing anything | ACCEPTED |
| C-E11 | ext uninstall | residual data disclosure; purge is separate | 2 lines | `--purge-data` is a distinct, T3-flagged action, exactly like the Web (W-E8) | ACCEPTED |
| C-E12 | Executable kinds | hooks and native plugins | 2 lines | refuses with the version-lock reason (D-038) rather than installing something the runtime will not load | ACCEPTED |
| C-E13 | MCP server commands | add / list / restart an MCP server entry | 1–2 lines each | client-only: nothing here can make Crabby an MCP server (D-040), and the help text says so where a user would look | ACCEPTED |

---

## 7. Interfaces and access

### Region C8 — Gateway, web, telegram, tui, tunnel, auth

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| C8-01 | gateway start | foreground, with a detach note | 3 lines | on Termux it prints how to keep it alive after the app is backgrounded, because Android kills it otherwise | ACCEPTED |
| C8-02 | gateway stop / restart / status | pid, port, reachable URL | 3 lines | status answers "is anything running" without a second command; `restart` is T3, prints who it is disconnecting, and does not require a TTY to confirm because `--yes` is the confirmation (D-058) | ACCEPTED |
| C8-03 | web open | builds nothing, prints the URL | 1–2 lines | the URL is on its own line to be selectable (the same reason as TUI T2-09) | ACCEPTED |
| C8-04 | telegram start | reads the bot token from the vault, not from argv | one line | prints the chat the user must send `/start` to, and the identity it will get | ACCEPTED |
| C8-05 | tui | launches the terminal interface | n/a | same Gateway, same capabilities; starting it does not start a second core | ACCEPTED |
| C8-06 | tunnel on / off / status | URL, reachable identities, stop | 2–4 lines | `on` is a T3 action: it prints who becomes reachable and needs `--yes` | ACCEPTED |
| C8-07 | Tunnel while a task runs | warning about the current task | one line | says that a live task is now reachable from the tunnel URL, because "stop" after the fact is too late | ACCEPTED |
| C8-08 | auth pair | local-only action (D-053) | 3 lines | prints the pairing code once, and the expiry rule; a remote session cannot mint a second identity from here | ACCEPTED |
| C8-09 | auth list | name, interface, last seen, granted caps | 1 line each | the same rows as Web W13-01 and TUI T14-01 | ACCEPTED |
| C8-10 | auth revoke | immediate, kills live streams | one line | prints how many streams it terminated | ACCEPTED |
| C8-11 | auth restrict | `--restrict <caps>` per identity (D-054) | one line | removal is the semantics; it never converts a missing capability into an approvable prompt | ACCEPTED |
| C8-12 | Token output | any command printing a credential | n/a | none do; the row exists so this stays a checked property rather than a hope | ACCEPTED |

---

## 8. Data

### Region C9 — History and memory commands

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| C9-01 | history export | session range, format | 1–3 lines | T2 per D-046: run by the agent it needs approval, run by the owner in a terminal it is a direct action — and the command prints which it is | ACCEPTED |
| C9-02 | history delete-session | one session | 2 lines | says how many rows and how much disk it will remove, and confirms unless `--yes` | ACCEPTED |
| C9-03 | memory list | entries with provenance and trust | 1–2 lines each | same fields as Web W8-01 and TUI T9-01 | ACCEPTED |
| C9-04 | memory search | text query | n/a | text search only in v1 (D-021), and it says so rather than pretending to be semantic | ACCEPTED |
| C9-05 | memory forget | single entry | one line | prints what referenced it before deleting, mirroring the propagation preview (W8-08) | ACCEPTED |
| C9-06 | memory forget-topic | "forget everything about X" | 2 lines | T3, and it counts what it will touch; `--yes` cannot skip the count | ACCEPTED |
| C9-07 | logs command | `crabby logs --level warn --tail` | n/a | the same redacted view as the Web log screen; there is no "show unredacted" flag anywhere | ACCEPTED |
| C9-08 | audit command | decisions with who and which client | 1 line each | the readable version of the audit trail, matching Web W14-03 fields | ACCEPTED |
| C9-09 | Export destination | file paths vs stdout | n/a | writes next to the workspace root it was given, never into a system temp dir the user has to hunt for | ACCEPTED |

---

## 9. Context and tools

### Region C10 — Context, compaction, tools

These four commands exist because the parity matrix lists them (`docs/INTERFACES_AND_API.md` §8): the context drawer
in the Web, the context pane in the TUI, and `/context` in Telegram all reach the same three routes, and a user in a
terminal has to be able to reach them too. They are also the commands a script would call.

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| C10-01 | context show | `crabby context show <session>` | ≤20 lines | what is in budget, what was compacted, what is pinned, each section with its cost — the same view as TUI T8-02 and Web W7; a section costing 0 prints `0` rather than being hidden | ACCEPTED |
| C10-02 | context pin | `crabby context pin <session> [ref]` | one line | no ref lists what is pinned, a ref pins it, `--remove` unpins; pinning is what keeps an instruction alive through compaction (`POST /sessions/{id}/pin`) | ACCEPTED |
| C10-03 | session compact | `crabby session compact <session>` | 3–5 lines | summarizes now instead of at the budget limit (D-027), and says where the originals live; never implies the original text is gone | ACCEPTED |
| C10-04 | tools ls | `crabby tools ls` | 1 line per tool | name, tier, capability, enabled, platform availability, and the reason for anything deferred — the same list the Web shows (W11-01), including "not in this version" rows | ACCEPTED |
| C10-05 | context as data | `context show --json` | n/a | byte counts and budget headroom in machine form, so a cron wrapper can stop filling a session it cannot see (`GET /sessions/{id}/context`) | ACCEPTED |

---

## 9A. Sessions

The grammar's `session` noun exists for one reason beyond compaction: `chat --session <id>` continues a session but
cannot *find* one. Without `session ls` the only way to resume on a phone is to remember an id, which is how people
end up with forty sessions they cannot tell apart.

### Region C11 — Session commands

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| C11-01 | session ls | id, title, last activity, state word, model, origin interface | 1 line each | `--quiet` prints ids only; sorted by last activity, not by creation, because that is the order a person remembers in (`GET /sessions`) | ACCEPTED |
| C11-02 | session new | `crabby session new [--title "…"]` | one line | prints the id and the command to use it (`crabby chat --session <id>`) — a created thing you cannot address is a bug | ACCEPTED |
| C11-03 | session show | title, turns, tasks, budget, pinned items | ≤12 lines | the union of what `context show` and `task ls` say about one session; `--json` gives the session object | ACCEPTED |
| C11-04 | session rename | `crabby session rename <id> "title"` | one line | writes through `PATCH /sessions/{id}`, so the Web title and the TUI list change with it, not after it | ACCEPTED |
| C11-05 | no session delete | the deletion verb stays where it is | one line | `history delete-session` is the only path, so there is exactly one command that destroys history and one place to look for it; the absence is the decision, not an oversight | ACCEPTED |
| C11-06 | bare crabby chat | which session it uses | one line | a fresh one each time, with its id printed on the last line — silently continuing the most recent session would let a script append to a conversation it never opened | ACCEPTED |

---

## 9C. Jobs, lifecycle, diagnostics

### Region C12 — job commands, gateway restart, diagnostics

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| C12-01 | job ls | name, schedule, next run, last outcome, state word | 1 line each | `--quiet` prints ids; state is a word (`active`, `paused`, `waiting-approval`, `deferred:vault-locked`, `failing`) so it greps (`GET /jobs`) | ACCEPTED |
| C12-02 | job show | the capability set it holds, its identity, last runs with outcomes | ≤15 lines | the text version of "what did I authorize on that day" — `PROVIDERS_AND_TOOLS.md` §4.5 says a job carries only what is recorded here, so this command is where that is checkable | ACCEPTED |
| C12-03 | job pause / resume | one id each | one line | pausing takes effect before the next tick and says so; resuming re-evaluates the grants rather than trusting the last evaluation | ACCEPTED |
| C12-04 | job run-now | runs once, outside the schedule | 2 lines | still a fresh policy evaluation: a T2/T3 step asks at run time and the command exits `3` if nobody answers (C3-04), it does not proceed unattended | ACCEPTED |
| C12-05 | job edit | schedule, objective, model, recipients | ≤6 lines | prints which steps now need re-approval before it writes; a material change cannot ride on the old authorization (`PATCH /jobs/{id}`) | ACCEPTED |
| C12-06 | job backlog | what happens to runs missed while the host was down | 3 lines | lists them and asks once (latest / each / skip); the answer is recorded, and `--json` shows the same structure so a monitoring script can see a stalled job | ACCEPTED |
| C12-07 | gateway restart | T3 lifecycle | 2 lines | names the streams it kills and returns only when the port answers; no restart of a remote Gateway over a link the restart itself will drop (`POST /admin/restart`) | ACCEPTED |
| C12-08 | diagnostics | sanitized report to a file, path printed | 1 line | the same artifact the Web's Export button produces (`GET /diagnostics`), safe to paste into a bug report; it refuses to include env vars or key material rather than redacting after the fact | ACCEPTED |
| C12-09 | no `job create` | scheduling is created from a task, not here | one line | the job verb set has no create command because scheduling is an agent tool (`cron.schedule`, T2) or a task-detail action — two creation paths with different approval semantics is how a schedule escapes review; the absence is the decision | ACCEPTED |

---

## 10. The scripting contract

### Region C-S — What another program may rely on

| ID | Element | Content | Sizes | Behavior | Status |
| --- | --- | --- | --- | --- | --- |
| C-S01 | stdout is data | nothing but the result goes to stdout | n/a | warnings, progress, and prompts go to stderr — the one rule that makes everything else pipeable | ACCEPTED |
| C-S02 | JSON stability | keys and types | n/a | additive changes only within a major version; a removed key needs a deprecation cycle (`docs/DEVELOPMENT.md`) | ACCEPTED |
| C-S03 | Stable ids | session, task, approval, request | one line each | ids are opaque and short enough to survive a copy from a phone screen | ACCEPTED |
| C-S04 | Idempotency | running the same command twice | n/a | `provider add` and `auth pair` must not create duplicates; cancelling a finished task is a no-op with exit `0` and a word | ACCEPTED |
| C-S05 | Concurrency | two commands at once | n/a | no lock file the user has to know about; the Gateway serializes what must be serialized, and a collision returns a named error | ACCEPTED |
| C-S06 | Long objective text | argument length and quoting | n/a | accepts `--objective-file <path>` and stdin, because a 4 KB quoted string in a shell is a broken pipeline waiting to happen | ACCEPTED |
| C-S07 | Secrets in argv | none, ever | n/a | no flag takes a key, token, or password value; the `ps` output rule is C7-02 stated as a contract | ACCEPTED |
| C-S08 | Locale and width | output in a non-English locale | n/a | copy is English in the CLI (translations live in the Web and TUI), and column alignment uses cell width, not character count | ACCEPTED |
| C-S09 | Signal handling | `SIGTERM`, `SIGHUP`, `SIGINT` | n/a | a signal mid-command settles state and writes a log line; a task does not need the client to survive | ACCEPTED |
| C-S10 | Timeouts | every network call has one | n/a | a default with a flag to change it; a hung CLI with no timeout is indistinguishable from a hung agent | ACCEPTED |
| C-S11 | No writes outside roots | config and export paths | n/a | the same root and deny-list rule as `file.write`, applied to the CLI's own output files | ACCEPTED |
| C-S12 | Dry run | `--dry-run` where a side effect exists | n/a | prints what would change and the exit code it would have had; unsupported on commands with no side effect rather than accepted and ignored | ACCEPTED |
| C-S13 | Completion | shell completion for bash and zsh | n/a | Open question **C-S-A** — decided in D-063 | ACCEPTED |
| C-S14 | Man page or docs site | reference documentation | n/a | `--help` is the contract in v1; a generated reference is listed as an open item, not a promise | ACCEPTED |

**Open question C-S-A:** shell completion and a generated reference page — in v1 or not? It is real convenience and
it is also a second surface that can drift from the registry. Proposal: generate completion from the same registry in
v1 (cheap, impossible to drift once generated), skip the man page.

---

> **C-S-A — closed (D-063).** Decided: **completion generated from the command registry**; no man page and no second reference surface to contradict the first.

## 11. Coverage check

| Screen | Regions | Elements | Every state defined? |
| --- | --- | --- | --- |
| Invocation and output | C1, C2, C3 | 34 | non-TTY, `NO_COLOR`, `--plain`, bad value, crash, redaction |
| Setup and health | C4 | 12 | Gateway down, Termux kill, first-run skip |
| Chat and tasks | C5, C6 | 21 | cancel detach, resume disclosure, unknown id, stream interrupt |
| Approvals | C-A | 10 | conflict, expired, non-interactive, no-bulk decision |
| Providers/models/config | C7 | 13 | insecure transport, hot reload, key handling |
| Extensions | C-E | 13 | verdict stop, report diff, executable-kinds refusal |
| Interfaces and access | C8 | 12 | local-only pairing, T3 tunnel, token never printed |
| Data | C9 | 9 | T2 export, propagation count, no unredacted view |
| Context, compaction, tools | C10 | 5 | pin/unpin, compaction disclosure, deferred tools listed |
| Scripting contract | C-S | 14 | idempotency, signals, timeouts, dry run |
| **Total** | **15 regions** | **158 elements** | — |

Every `C` element above has to exist for the parity test to pass: if a capability is in `docs/INTERFACES_AND_API.md`
§8 and there is no row here, this file is wrong, not the matrix.

**Open questions:** C6-A, C6-B, C-A-A and C-S-A are closed by D-063.




