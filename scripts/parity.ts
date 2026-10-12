// The parity generator D-067 promised, and the reason `docs/INTERFACES_AND_API.md` §8 can say "this table is
// generated" without a footnote. Run it with `npm run test:parity`, or `node scripts/parity.ts --write` after
// intentionally changing a row, and CI fails on a diff.
//
// Two halves, because §8's sentence describes two inputs. The **annotation** half is `MATRIX` below: what each feature
// costs in each interface, which is a design fact and lives in code so it can be reviewed. The **registry** half is
// `@crabby/policy`: the capability vocabulary, the tool table, and the tiers — the generator reads the documents,
// compares them with the code, and fails when either side moved alone. Rules 10 to 12 of `scripts/check-docs.py` used to
// stand in for this; rule 10 and rule 12's command-surface direction moved here (they need the real registries, which a
// Python check cannot import), and rule 11 stays there because it checks `docs/review/*` inventory completeness rather
// than parity.
//
// What "fails" means, in priority order: a route that exists in code but not in §4 (an undocumented surface is the one
// drift a reviewer cannot see in a diff of the docs), a command in the matrix that the CLI grammar does not have, a tier
// in `packages/policy` that §4.2 does not state or a tier in §4.2 that the code does not implement, a capability name in
// one of the two lists and not the other, and a Telegram command in the inventory with no matrix row.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isKnownState, PERMITTED_TRANSITIONS } from "@crabby/agent-runtime";
import { TASK_STATES } from "@crabby/api-contracts";
import { CAPABILITIES, TIERS, TOOL_REGISTRY } from "@crabby/policy";
import { COMMANDS } from "../apps/cli/registry.ts";

const REPO = path.resolve(new URL("../", import.meta.url).pathname);
const IFACE = "docs/INTERFACES_AND_API.md";
const SECURITY = "SECURITY.md";
const TOOLS = "PROVIDERS_AND_TOOLS.md";
const CLI_REVIEW = "docs/review/CLI.md";
const TG_REVIEW = "docs/review/TELEGRAM.md";
const RUNTIME = "AGENT_RUNTIME.md";

export interface FeatureRow {
  /** The capability, in the document's words. */
  readonly capability: string;
  /** The API column: routes, space separated, in backticks. */
  readonly api: string;
  readonly cli: string;
  readonly tui: string;
  readonly web: string;
  readonly telegram: string;
}

export const MATRIX: readonly FeatureRow[] = [
  {
    capability: "Chat / one-shot prompt",
    api: "`POST /sessions/{id}/messages`",
    cli: "`chat`",
    tui: "chat pane",
    web: "chat view",
    telegram: "`/ask`",
  },
  {
    capability: "Create multi-step task",
    api: "`POST /tasks`",
    cli: "`task run`",
    tui: "`n` in tasks pane",
    web: "New task",
    telegram: "`/task`",
  },
  {
    capability: "Watch task + live progress",
    api: "`GET /events`, `GET /tasks/{id}`",
    cli: "`task watch`",
    tui: "task detail",
    web: "task view",
    telegram: "`/watch` + edits",
  },
  {
    capability: "Cancel task",
    api: "`POST /tasks/{id}/cancel`",
    cli: "`task cancel`",
    tui: "`Ctrl-C`",
    web: "Cancel button",
    telegram: "`/cancel`",
  },
  {
    capability: "Resume task",
    api: "`POST /tasks/{id}/resume`",
    cli: "`task resume`",
    tui: "`r` in detail",
    web: "Resume",
    telegram: "`/resume <id>`",
  },
  {
    capability: "Answer approval",
    api: "`POST /approvals/{id}/decision`",
    cli: "`approval approve/deny`",
    tui: "modal",
    web: "dialog",
    telegram: "inline buttons",
  },
  {
    capability: "Pending approval queue",
    api: "`GET /approvals`",
    cli: "`approval ls`",
    tui: "status bar",
    web: "approvals panel",
    telegram: "`/approvals`",
  },
  {
    capability: "List/switch sessions",
    api: "`GET /sessions`",
    cli: "`chat --session`",
    tui: "session switcher",
    web: "sidebar",
    telegram: "`/sessions`",
  },
  {
    capability: "Context view + pin",
    api: "`GET /sessions/{id}/context`, `POST …/pin`",
    cli: "`context show/pin`",
    tui: "context pane",
    web: "context drawer",
    telegram: "`/context`",
  },
  {
    capability: "Force compaction",
    api: "`POST /sessions/{id}/compact`",
    cli: "`session compact`",
    tui: "`c`",
    web: "Compact",
    telegram: "`/compact`",
  },
  {
    capability: "Provider add/remove",
    api: "`POST/DELETE /providers`",
    cli: "`provider add`",
    tui: "provider screen",
    web: "settings",
    telegram:
      "`/providers` (add is Web/CLI-only if typing a URL on a phone is impractical — needs an accepted limitation, not a gap)",
  },
  {
    capability: "Model list + override",
    api: "`GET /models`, `PUT …/overrides`",
    cli: "`model edit`",
    tui: "model picker",
    web: "model editor",
    telegram: "`/model`",
  },
  {
    capability: "Probe model capabilities",
    api: "`POST /models/…/probe`",
    cli: "`model probe`",
    tui: "action in picker",
    web: "Probe button",
    telegram: "`/probe <model>`",
  },
  {
    capability: "List tools + tiers",
    api: "`GET /tools`",
    cli: "`tools ls`",
    tui: "tools pane",
    web: "tools view",
    telegram: "`/tools`",
  },
  {
    capability: "Memory review/search/forget",
    api: "`/memory…`",
    cli: "`memory …`",
    tui: "memory pane",
    web: "memory view",
    telegram: "`/memory`",
  },
  {
    capability: "Extension validate/install",
    api: "`/extensions…`",
    cli: "`ext …`",
    tui: "extensions pane",
    web: "extensions view",
    telegram: "`/ext` (install requires a confirming approval message)",
  },
  {
    capability: "Config get/set",
    api: "`/config`",
    cli: "`config …`",
    tui: "settings",
    web: "settings",
    telegram: "`/config` (T3 changes confirm in-chat)",
  },
  {
    capability: "Logs / audit",
    api: "`/logs`, `/audit`",
    cli: "`logs`, `audit`",
    tui: "log pane",
    web: "logs view",
    telegram: "`/logs` (tail + file export)",
  },
  {
    capability: "Tunnel on/off",
    api: "`POST/DELETE /tunnel`",
    cli: "`tunnel on/off`",
    tui: "status + action",
    web: "settings",
    telegram: "`/tunnel on` (T3 confirm)",
  },
  {
    capability: "Pair / revoke client",
    api: "`/auth…`",
    cli: "`auth pair/revoke`",
    tui: "settings",
    web: "settings",
    telegram:
      "revoke from a trusted local client only — a remote client must not be able to mint identities; **documented limitation with local-only alternative**",
  },
  {
    capability: "History export",
    api: "`POST /sessions/{id}/export` (`history.export`)",
    cli: "`history export`",
    tui: "export action",
    web: "Download",
    telegram: "`/export` as a file",
  },
  {
    capability: "Delete conversation",
    api: "`DELETE /sessions/{id}`",
    cli: "`history delete-session`",
    tui: "`d`",
    web: "Delete",
    telegram: "`/delete <n>` with the title typed back",
  },
  {
    capability: "Review scheduled jobs",
    // Six paths and no `POST /jobs`, and the absence is the decision C12-09 records: creation is `cron.schedule`, a T2
    // call the user approved, so a route that created a job would be a second creation path with no approval in it.
    api:
      "`GET /jobs?state=`, `GET /jobs/{id}`, `PATCH /jobs/{id}`, `POST /jobs/{id}/pause`, " +
      "`POST /jobs/{id}/resume`, `POST /jobs/{id}/run`, `POST /jobs/{id}/backlog`",
    cli: "`job …`",
    tui: "jobs pane",
    web: "Scheduled screen",
    telegram: "`/jobs`, `/job <id>`",
  },
  {
    capability: "Gateway lifecycle",
    api: "`POST /admin/restart`, `POST /admin/shutdown`",
    cli: "`gateway restart`",
    tui: "status action",
    web: "Access screen",
    telegram: "refused here, local-only (like pairing, D-053)",
  },
  {
    capability: "Diagnostics report",
    api: "`GET /diagnostics`",
    cli: "`diagnostics`",
    tui: "status action",
    web: "Export sanitized",
    telegram: "`/report` as a file",
  },
] as const;

const BEGIN = "<!-- parity:begin -->";
const END = "<!-- parity:end -->";

export interface ParityProblem {
  readonly file: string;
  readonly message: string;
}

function backticked(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((match) => (match[1] ?? "").trim()).filter(Boolean);
}

/** Inline code spans across a whole document, one line at a time and with fenced blocks skipped. A document-wide
 *  `` ` `` regex is wrong here, and the failure is invisible rather than loud: a ``` fence carries three backticks,
 *  so every pair after it is offset by one and the spans that *matter* — §4's route table — land in the gaps. That
 *  read as "the Gateway registers routes the document does not define", 12 problems at a time, on a document that was
 *  fine. */
function inlineCode(body: string): string[] {
  const found: string[] = [];
  let fenced = false;
  for (const line of body.split("\n")) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    for (const match of line.matchAll(/`([^`]+)`/g)) {
      const token = (match[1] ?? "").trim();
      if (token !== "") found.push(token);
    }
  }
  return found;
}

/** `app.get("/api/v1/health", …)`, `app.post<{…}>(\n  "/api/v1/tasks", …)`, and the two path constants the pairing
 *  routes share are all one regex away: every string literal in the Gateway source that starts with the version
 *  prefix. A `printRoutes()`-based version would be truer at runtime and would need a database, a listener, and a
 *  second process to read; this is a docs check that has to run in milliseconds on a phone too. */
async function implementedRoutes(): Promise<string[]> {
  const source = await readFile(path.join(REPO, "packages/gateway/app.ts"), "utf8");
  return [
    ...new Set([...source.matchAll(/"(\/api\/v1[^"]*)"/g)].map((match) => match[1] ?? "")),
  ].sort();
}

/** Every pipe row in the file, not just the first table. `docs/review/*.md` is a set of tables per region, and a
 *  checker that read one section and called it an inventory would report "no row names `chat`" for every command
 *  outside its favorite heading — which is a false positive that trains a reviewer to ignore the tool. */
function allTableRows(body: string): string[][] {
  return body
    .split("\n")
    .filter((line) => line.startsWith("|") && !/^[|-\s]+$/.test(line))
    .map((line) =>
      line
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim()),
    );
}

/** The paths the document defines, anywhere in it: `GET /tools`, `POST/DELETE /tunnel`, and
 *  `/api/v1/tasks/{id}/events` all reduce to a path shape. `{id}` is the document's placeholder and `:id` is
 *  Fastify's, which is the only translation this function does. §4's endpoint tables are where most of them live, and
 *  pairing and `/events` are described in §3 next to the flows that need them — a check that read only §4 would
 *  report `/api/v1/auth/pair` as undocumented, which is the kind of finding that gets "fixed" by moving a paragraph. */
function documentedPaths(body: string): string[] {
  const found = new Set<string>();
  for (const token of inlineCode(body)) {
    for (const piece of token.split(/\s*·\s*|,\s*/)) {
      const match = /(?:(?:GET|POST|PUT|PATCH|DELETE)\s+)?(\/[^\s`]+|\/[a-z][a-z0-9-]*)/.exec(
        piece.trim(),
      );
      if (!match) continue;
      const withoutQuery = (match[1] ?? "").split("?")[0] ?? "";
      found.add(withoutQuery.replace(/\/:id\b/g, "/{id}").replace(/\/$/, ""));
    }
  }
  return [...found].sort();
}

function sectionOf(body: string, heading: string, next: RegExp): string {
  const at = body.indexOf(heading);
  if (at < 0) return "";
  const rest = body.slice(at);
  const stop = rest.slice(1).search(next);
  return stop < 0 ? rest : rest.slice(0, stop + 1);
}

/** The rows of the first pipe table after a heading, cells trimmed. Duplicated from the doc checker on purpose: the
 *  generator has to be readable alone, and a shared parser would tie the two scripts' fates together. */
function tableRows(body: string, heading: string): string[][] {
  const at = body.indexOf(heading);
  if (at < 0) return [];
  const rows: string[][] = [];
  for (const line of body.slice(at).split("\n")) {
    if (line.startsWith("|")) {
      if (!/^[|-\s]+$/.test(line))
        rows.push(
          line
            .trim()
            .replace(/^\|/, "")
            .replace(/\|$/, "")
            .split("|")
            .map((cell) => cell.trim()),
        );
    } else if (rows.length > 0) break;
  }
  return rows;
}

export async function check(quiet = false): Promise<ParityProblem[]> {
  const problems: ParityProblem[] = [];
  const [iface, security, toolsDoc, cliMd, tgMd, runtimeDoc] = await Promise.all([
    readFile(path.join(REPO, IFACE), "utf8"),
    readFile(path.join(REPO, SECURITY), "utf8"),
    readFile(path.join(REPO, TOOLS), "utf8"),
    readFile(path.join(REPO, CLI_REVIEW), "utf8"),
    readFile(path.join(REPO, TG_REVIEW), "utf8"),
    readFile(path.join(REPO, RUNTIME), "utf8"),
  ]);

  // ---- 1. the §8 table in the document, against the rows above
  const generated = renderMatrix();
  const at = iface.indexOf(BEGIN);
  const end = iface.indexOf(END);
  if (at < 0 || end < 0) {
    problems.push({
      file: IFACE,
      message: `§8 is not delimited by ${BEGIN} / ${END}, so nothing is being generated`,
    });
  } else if (iface.slice(at + BEGIN.length, end).trim() !== generated.trim()) {
    problems.push({
      file: IFACE,
      message:
        "§8's table differs from what scripts/parity.ts renders — run `npm run test:parity -- --write` after changing a row",
    });
  }

  // ---- 2. routes the Gateway answers, against the routes §4 documents
  const routes = await implementedRoutes();
  const documented = documentedPaths(iface);
  if (documented.length === 0) {
    problems.push({
      file: IFACE,
      message: "the endpoint tables parsed to nothing, so the route check has no reference",
    });
  }
  for (const route of routes) {
    const bare = route.replace(/^\/api\/v1/, "").replace(/\/$/, "") || "/";
    const normalized = bare.replace(/\/:id\b/g, "/{id}");
    if (!documented.includes(normalized)) {
      problems.push({
        file: IFACE,
        message: `\`${route}\` is registered in packages/gateway/app.ts but absent from the endpoint tables in §4`,
      });
    }
  }

  // ---- 3. the matrix's CLI column, against the grammar the CLI actually has
  const nouns = new Set(COMMANDS.map((command) => command.noun));
  const matrixNouns = new Set<string>();
  for (const row of MATRIX) {
    for (const token of backticked(row.cli)) {
      const noun = (token.split(/\s+/)[0] ?? "").replace(/^crabby\s+/, "");
      if (!/^[a-z][a-z0-9-]*$/.test(noun) || noun === "id") continue;
      matrixNouns.add(noun);
      if (!nouns.has(noun)) {
        problems.push({
          file: CLI_REVIEW,
          message: `§8 requires \`crabby ${noun}\` for "${row.capability}" and apps/cli/registry.ts has no such noun`,
        });
      }
    }
  }
  // …and the other direction: a command the grammar offers must appear in the matrix or in §7.1's table.
  const ifaceCommands = new Set<string>();
  for (const row of tableRows(sectionOf(iface, "### 7.1 CLI", /^### 7\.2/m), "|")) {
    for (const cell of row)
      for (const token of backticked(cell))
        ifaceCommands.add((token.split(/\s+/)[0] ?? "").replace(/^crabby\s+/, ""));
  }
  for (const row of MATRIX)
    for (const token of backticked(row.cli))
      ifaceCommands.add((token.split(/\s+/)[0] ?? "").replace(/^crabby\s+/, ""));
  for (const command of COMMANDS) {
    if (command.status !== "ready") continue;
    if (!ifaceCommands.has(command.noun)) {
      problems.push({
        file: IFACE,
        message: `\`crabby ${command.noun}${command.verb ? ` ${command.verb}` : ""}\` is ready and not listed in §7.1 or §8`,
      });
    }
  }
  // The CLI inventory has to carry a row for every noun the grammar has, which is the direction rule 10 used to check.
  const cliElements = allTableRows(cliMd).flat().join(" ").toLowerCase();
  for (const noun of matrixNouns) {
    if (!cliElements.includes(noun)) {
      problems.push({
        file: CLI_REVIEW,
        message: `no element names the command \`${noun}\` the grammar and the matrix both require`,
      });
    }
  }

  // ---- 4. Telegram, both directions, exactly as rule 10 did
  const matrixTelegram = new Set<string>();
  for (const row of MATRIX) {
    for (const command of row.telegram.matchAll(/`\/([a-z]+)/g))
      if (command[1]) matrixTelegram.add(command[1]);
  }
  const sec74 = /### 7\.4 Telegram\n([\s\S]*?)\n## 8/.exec(iface);
  if (sec74)
    for (const command of sec74[1].matchAll(/`\/([a-z]+)/g))
      if (command[1]) matrixTelegram.add(command[1]);
  const inventoryTelegram = new Set<string>();
  // `docs/review/TELEGRAM.md`'s tables are `ID | Element | Content | Sizes | Behavior | Status`, and the command is
  // the *element* cell (G3-18's element is `/tools`), so the second column is the only place a command can be declared.
  for (const row of allTableRows(tgMd)) {
    const cell = (row[1] ?? "").trim();
    const match = /^\/([a-z]+)\b/.exec(cell);
    if (match?.[1]) inventoryTelegram.add(match[1]);
  }
  if (matrixTelegram.size === 0 || inventoryTelegram.size === 0) {
    problems.push({
      file: TG_REVIEW,
      message:
        "the Telegram check read no commands (matrix or inventory changed shape), so it proves nothing",
    });
  }
  for (const command of [...matrixTelegram].sort()) {
    if (!inventoryTelegram.has(command))
      problems.push({
        file: TG_REVIEW,
        message: `/${command} is required by §7.4 or §8 and no row names it`,
      });
  }
  for (const command of [...inventoryTelegram].sort()) {
    if (!matrixTelegram.has(command))
      problems.push({
        file: TG_REVIEW,
        message: `/${command} is proposed here and appears in neither §7.4 nor §8`,
      });
  }

  // ---- 5. the tool registry against §4.2, and the vocabulary against §6.1
  for (const problem of compareRegistry(toolsDoc)) problems.push(problem);
  for (const problem of compareVocabulary(security)) problems.push(problem);

  // ---- 6. the task state machine against the lifecycle document that owns it (D-083)
  for (const problem of compareStateMachine(runtimeDoc)) problems.push(problem);

  if (!quiet) {
    const counts = {
      routes: routes.length,
      tools: TOOL_REGISTRY.length,
      capabilities: CAPABILITIES.length,
      features: MATRIX.length,
      tiers: TIERS.length,
      states: TASK_STATES.length,
    };
    console.log(
      `parity: ${Object.entries(counts)
        .map(([key, value]) => `${value} ${key}`)
        .join(", ")}` +
        (problems.length === 0
          ? " — documents and code agree"
          : ` — ${problems.length} problem(s)`),
    );
  }
  return problems;
}

/** `AGENT_RUNTIME.md` §4.1's transition table against `PERMITTED_TRANSITIONS`. D-083 decided these rules in M2, and the
 *  document that owns the lifecycle states them in a table — so the table is checked, in both directions, exactly like
 *  §4.2's tier table: a state may not gain or lose an edge in prose alone, and a code-side edge with no row in the
 *  document is the same defect wearing the other uniform. */
function compareStateMachine(runtimeDoc: string): ParityProblem[] {
  const problems: ParityProblem[] = [];
  const rows = tableRows(runtimeDoc, "### 4.1 Task lifecycle").slice(1);
  const documented = new Map<string, string[]>();
  for (const row of rows) {
    const from = backticked(row[0] ?? "");
    const to = backticked(row[1] ?? "");
    for (const name of from) {
      if (documented.has(name)) {
        problems.push({
          file: RUNTIME,
          message: `§4.1's table names \`${name}\` as a source state in two rows — a state with two rule sets is one rule set too many`,
        });
        continue;
      }
      documented.set(name, to);
    }
  }
  for (const state of TASK_STATES) {
    if (!documented.has(state)) {
      problems.push({
        file: RUNTIME,
        message: `§4.1's transition table has no row whose From cell names \`${state}\`, so the lifecycle document is silent about a state the contract has`,
      });
    }
  }
  for (const [from, to] of documented) {
    if (!isKnownState(from)) {
      problems.push({
        file: RUNTIME,
        message: `§4.1's table has a row for \`${from}\`, which is not one of the nine states in \`TASK_STATES\``,
      });
      continue;
    }
    const actual = [...(PERMITTED_TRANSITIONS[from] ?? [])];
    if (actual.join(",") !== to.join(",")) {
      problems.push({
        file: RUNTIME,
        message:
          `§4.1 says \`${from}\` may move to [${to.join(", ") || "nothing"}] and ` +
          `PERMITTED_TRANSITIONS says [${actual.join(", ") || "nothing"}] — the transition table is the runtime's ` +
          "rules as written in the document that owns them, so the two must read the same",
      });
    }
  }
  return problems;
}

/** §4.2's table, cell for cell. A row that names two tools and two tiers (`**T2** / **T0**`) assigns them
 *  positionally, which is how `process.spawn` and `process.list` differ by two tiers in one line of the document. */
function compareRegistry(toolsDoc: string): ParityProblem[] {
  const problems: ParityProblem[] = [];
  const heading = "### 4.2 Initial tool set with risk-tier assignment (closes O-020)";
  const rows = tableRows(toolsDoc, heading);
  if (rows.length < 2)
    return [
      {
        file: TOOLS,
        message: "§4.2's table could not be parsed, so the registry has no reference",
      },
    ];
  const docTiers = new Map<string, string>();
  for (const row of rows.slice(1)) {
    const [toolCell = "", , tierCell = ""] = row;
    const names = toolCell
      .replace(/\*\*/g, "")
      .replace(/`/g, "")
      .split(/,\s|\s+\/\s+/)
      .map((name) => name.trim().replace(/\s*\(.*\)$/, ""))
      .filter((name) => /^[a-z][a-zA-Z0-9. -]*$/.test(name));
    const tiers = [...tierCell.matchAll(/T[0-3]/g)].map((match) => match[0]);
    names.forEach((name, index) => {
      const tier = tiers.length === names.length ? (tiers[index] ?? tiers[0]) : (tiers[0] ?? "");
      if (tier) docTiers.set(name, tier);
    });
  }
  if (docTiers.size === 0) return [{ file: TOOLS, message: "§4.2 parsed to zero tool rows" }];
  const codeTiers = new Map<string, string>();
  for (const spec of TOOL_REGISTRY) {
    for (const name of [spec.tool, ...(spec.aliases ?? [])])
      codeTiers.set(name.replace(/\s*\(.*\)$/, ""), spec.tier);
  }
  for (const [name, tier] of [...docTiers].sort()) {
    if (codeTiers.get(name) !== tier) {
      problems.push({
        file: "packages/policy/tools.ts",
        message: `'${name}' is ${tier} in §4.2 and ${codeTiers.get(name) ?? "absent"} in the registry`,
      });
    }
  }
  for (const name of [...codeTiers.keys()].sort()) {
    if (!docTiers.has(name))
      problems.push({ file: TOOLS, message: `'${name}' is in the registry and not in §4.2` });
  }
  return problems;
}

/** `SECURITY.md` §6.1's vocabulary, bidirectionally — including the duplicate-row case, which is how F-32 was found:
 *  a name listed twice in the document is a document bug, and a check that deduped to be forgiving would have made it
 *  permanent. */
function compareVocabulary(security: string): ParityProblem[] {
  const problems: ParityProblem[] = [];
  const rows = tableRows(security, "### 6.1 Capability model");
  const names: string[] = [];
  for (const row of rows.slice(1)) {
    const cell = row[0] ?? "";
    const rowNames = new Set<string>();
    const families: string[] = [];
    for (const match of cell.matchAll(/`([a-z][a-z0-9.<>:_-]*)`/g)) {
      const name = match[1] ?? "";
      if (!name.includes(".")) continue;
      const family = /<[^>]+>/.test(name) ? name.split(".")[0] : undefined;
      if (family !== undefined) {
        families.push(`${family}.`);
        // `fs.read:<root>` names the family *and* the parameter in one token, so the registry must hold the base name.
        // `device.<capability>` names a family with no dotted base at all, and its members are enumerated beside it —
        // pushing `device` here would ask the code for a capability no one could hold.
        const base = name.replace(/:<.*$/, "").replace(/\.<[^>]+>$/, "");
        if (base.includes(".")) rowNames.add(base);
        continue;
      }
      rowNames.add(name);
    }
    // A family row (`device.<capability>`) enumerates its members in the *description*, and enumerating them is the
    // point of the row — "one independently enabled Termux device capability" — so the check reads them back out.
    // Without this, nine capabilities the registry has and enforces would look undocumented, and the honest response
    // to that finding would be to delete them from the code.
    if (families.length > 0) {
      for (const rest of row.slice(1)) {
        for (const match of rest.matchAll(/`([a-z][a-z0-9._-]*\.[a-z][a-z0-9._-]*)`/g)) {
          const name = match[1] ?? "";
          if (families.some((prefix) => name.startsWith(prefix))) rowNames.add(name);
        }
      }
    }
    // Duplicates are *between* rows. A row that repeats a name inside its own sentence — "`device.notify` and
    // `device.control` … are the only low-risk members" — is emphasis, and the defect the check is for is `task.read`
    // appearing as two grants, which is F-32 and how this rule earned its keep.
    for (const name of rowNames) {
      if (names.includes(name))
        problems.push({
          file: SECURITY,
          message: `§6.1 lists \`${name}\` in two rows — the vocabulary is a set, and a repeated row is a document error, not a stronger grant`,
        });
      names.push(name);
    }
  }
  if (names.length === 0)
    return [
      {
        file: SECURITY,
        message:
          "§6.1's table parsed to zero capability names, so the vocabulary check has no reference",
      },
    ];
  const docNames = new Set(names);
  const codeNames = new Set(CAPABILITIES.map((capability) => capability.name));
  for (const name of [...docNames].sort()) {
    if (!codeNames.has(name)) {
      problems.push({
        file: "packages/policy/capabilities.ts",
        message: `§6.1 names \`${name}\` and the registry does not have it`,
      });
    }
  }
  for (const name of [...codeNames].sort()) {
    if (!docNames.has(name))
      problems.push({
        file: SECURITY,
        message: `the registry grants \`${name}\` and §6.1 does not name it`,
      });
  }
  return problems;
}

export function renderMatrix(): string {
  const header =
    "| Capability | API | CLI | TUI | Web | Telegram |\n| --- | --- | --- | --- | --- | --- |";
  const rows = MATRIX.map(
    (row) =>
      `| ${row.capability} | ${row.api} | ${row.cli} | ${row.tui} | ${row.web} | ${row.telegram} |`,
  );
  return [header, ...rows].join("\n");
}

async function writeMatrix(): Promise<void> {
  const file = path.join(REPO, IFACE);
  const body = await readFile(file, "utf8");
  const at = body.indexOf(BEGIN);
  const end = body.indexOf(END);
  if (at < 0 || end < 0) throw new Error(`${BEGIN}/${END} markers are missing from ${IFACE}`);
  const next = `${body.slice(0, at + BEGIN.length)}\n\n${renderMatrix()}\n\n${body.slice(end)}`;
  await writeFile(file, next, "utf8");
  console.log(`wrote §8 from scripts/parity.ts (${MATRIX.length} rows)`);
}

const invoked = process.argv[1] === undefined ? "" : path.resolve(process.argv[1]);
if (invoked.endsWith("scripts/parity.ts")) {
  if (process.argv.includes("--write")) {
    await writeMatrix();
    // Regenerating §8 is allowed to *fix* the table and nothing else: a `--write` that exits 0 while a route is
    // undocumented would teach the habit of running the flag until the red goes away.
    const remaining = await check(true);
    if (remaining.length > 0) {
      for (const problem of remaining) console.log(`${problem.file}: ${problem.message}`);
      process.exitCode = 1;
    } else {
      console.log("parity: §8 regenerated, and the document and the code agree on everything else");
    }
  } else {
    const problems = await check(process.argv.includes("--quiet"));
    if (problems.length > 0) {
      for (const problem of problems) console.log(`${problem.file}: ${problem.message}`);
      process.exitCode = 1;
    }
  }
}
