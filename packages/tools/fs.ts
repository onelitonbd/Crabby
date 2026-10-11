// The eight file operations §4.2 classifies, and the reason `SECURITY.md` §8 puts them here rather than in the loop:
// "Path checks are enforced in the tool adapter, and the tool must not accept a caller-provided path that it then
// re-interprets." An adapter is the party that turns a string into a syscall, so it is the party that has to resolve and
// re-check it — and it delegates the *judgement* to `packages/policy`'s `checkPath`, which §8's ordering ("normalize,
// check, resolve links, then check again") already implements. Nothing in this file decides whether a path is sensitive or
// outside a root; it asks, and refuses on the answer.
//
// Four rules shape every operation below, and each is a sentence in a document rather than a preference:
//
//  1. **§4.4's order ends here.** Schema validation, the capability check and the tier/approval all happened before the
//     loop called `run`. What is left is execution and result validation — so this file validates the arguments again
//     anyway, because a caller that skipped the loop (a future admin route, a test) must not reach a syscall with
//     `args.path` holding a number.
//  2. **Every result is framed as untrusted content** (§10, `untrusted.ts`), including a directory listing and a `stat`,
//     because each of them carries at least one name somebody else chose and a name is text a model can be persuaded by.
//  3. **A cap is applied to what leaves, and labeled** (§4.4: "results above the cap are truncated *and labeled*; a tool
//     must not pretend a partial result is complete") with D-064's overflow beside it ("larger goes to a file in the
//     session scratch with the path printed").
//  4. **Nothing here throws.** An `EACCES`, an `ENOSPC` and a `EISDIR` are all answers, and an exception that escaped an
//     executor would leave the task in `running` with nobody driving it — so every operation catches its own filesystem
//     errors and returns them as an outcome with a code. The loop catches too, for the executors that do not.
//
// Two operations are refused rather than merged, because §4.2 splits one tool across two rows when the arguments change
// the risk: `file.write` creates and refuses an existing path, `file.edit` replaces and refuses a missing one. An
// executor that accepted both under one name would be running the T1 row's operation with the T2 row's consequences, and
// the qualifier in §4.2's first column ("`file.write` (new file)") would be decoration.
//
// Atomicity: §8 says "writes should prefer atomic write + rename", so both writing tools write a temporary file in the
// target's own directory and rename over the destination — a crash mid-write leaves the previous bytes, which is also what
// makes `file.edit`'s `idempotent: true` declaration in `declare.ts` true rather than hopeful.

import { createReadStream, existsSync, writeFileSync } from "node:fs";
import {
  copyFile,
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { ToolOutcome, ToolRunContext } from "@crabby/agent-runtime";
import { type ToolDeclaration, validateToolArguments } from "@crabby/api-contracts";
import { checkPath, type PathContext, type PathVerdict, type ToolCall } from "@crabby/policy";
import { capWrapped, type UntrustedMetadata, wrapUntrusted } from "./untrusted.ts";

export interface FileToolEnv {
  /** §8's context: the configured workspace roots, plus the home and data directory the deny-list is measured against. */
  readonly paths: PathContext;
  /** §8's "re-checked *after* resolving links". Injected for the same reason policy injects it — testable without a
   *  symlink on disk — and defaulted by `createFileTools` to a resolver that walks up to the nearest existing ancestor,
   *  because the path a create is about to make does not exist yet and its directory's links are the hop that matters. */
  readonly realpathOf: (absolutePath: string) => string;
  /** D-064's scratch: where an over-cap output and a trashed delete go. Injected rather than computed so this package
   *  does not depend on a storage layout it does not own (`packages/storage/scratch.ts` does). */
  readonly scratchDirFor: (taskId: string) => string;
  readonly maxOutputBytes: number;
  readonly declarations: readonly ToolDeclaration[];
  readonly now: () => number;
  readonly nonce: () => string;
}

/** What the loop asks before it asks policy: the facts §4.3's escalations read from arguments but only a runtime can
 *  know. `preExistingUserFile` and `overwrites` are not the model's to declare — §10's rule that "a declared field is
 *  never an authority" applies with full force to a field that decides a tier, and a completion that wanted T1 would
 *  simply omit it. Synchronous because the arbiter is: a `stat` per call, before a decision, not inside a transaction. */
export function fileFacts(call: ToolCall, env: FileToolEnv): Record<string, unknown> {
  if (call.tool !== "file.edit" && call.tool !== "file.move") return {};
  const verdict = resolve(call, env);
  if (!verdict.ok) return {};
  if (call.tool === "file.edit") {
    // §4.2's cell reads "Bumped to **T2** when overwriting a file Crabby did not create", and nothing in this build keeps
    // a ledger of what Crabby created, so the honest answer is the conservative one: a file that is already there is not
    // ours as far as this code can tell. §4.2's escalations only ever move a tier up, so the error is in the safe
    // direction — and a created-by ledger is the refinement that would let an edit of Crabby's own file stay T1.
    return { preExistingUserFile: existsSync(verdict.resolved) };
  }
  const destination = stringArg(call.args, "destination");
  if (destination === undefined) return {};
  const target = checkPath(destination, env.paths, env.realpathOf);
  return target.ok ? { overwrites: existsSync(target.resolved) } : {};
}

export async function runFileTool(
  call: ToolCall,
  run: ToolRunContext,
  env: FileToolEnv,
): Promise<ToolOutcome> {
  const declaration = env.declarations.find((entry) => entry.name === call.tool);
  if (declaration === undefined) {
    return refuse(
      "not-declared",
      `'${call.tool}' reached the file executor, which does not declare it; §4.1 makes an undeclared tool unrunnable rather than tolerant`,
    );
  }
  // §4.1: "malformed arguments are rejected pre-execution". The loop already did this before policy; doing it again here
  // costs one schema walk and is the difference between a tool that can be misused by a caller and one that cannot.
  const checked = validateToolArguments(declaration.inputSchema, call.args);
  if (!checked.ok) {
    return refuse(
      "invalid-arguments",
      `'${call.tool}' was called with arguments its own schema rejects: ${checked.problems
        .map((problem) => `${problem.path || "(root)"} ${problem.message}`)
        .join("; ")}`,
    );
  }
  if (run.signal.aborted) {
    return refuse(
      "aborted",
      `'${call.tool}' was signalled to stop before it started (§6.1's step 2: a cancellation asks for no more scheduled work)`,
    );
  }
  try {
    switch (call.tool) {
      case "file.read":
        return await readText(call, run, env);
      case "file.list":
        return await listDirectory(call, run, env);
      case "file.stat":
        return await statPath(call, run, env);
      case "file.write":
        return await createFile(call, run, env);
      case "file.edit":
        return await replaceFile(call, run, env);
      case "file.delete":
        return await deletePath(call, run, env);
      case "file.move":
        return await movePath(call, run, env);
      case "fs.search":
        return await searchContent(call, run, env);
      default:
        return refuse("not-declared", `'${call.tool}' has no operation in this executor`);
    }
  } catch (error) {
    // Rule 4 above. A filesystem error is an answer with a code, and the code is the errno because that is the part a
    // user on a phone can act on (`ENOSPC` means "free space", not "the agent is broken").
    const code = errorCode(error);
    // The errno is kept in the platform's own spelling: `ENOSPC` is a phrase a user can search for and a phone can act
    // on, and lowercasing it would make the outcome a Crabby word for a filesystem fact.
    return refuse(code ?? "executor-error", `'${call.tool}' failed: ${message(error)}`);
  }
}

// ------------------------------------------------------------------ operations

async function readText(
  call: ToolCall,
  run: ToolRunContext,
  env: FileToolEnv,
): Promise<ToolOutcome> {
  const verdict = resolve(call, env);
  if (!verdict.ok) return refused(verdict);
  const buffer = await readFile(verdict.resolved, { signal: run.signal });
  // A text tool that dumps a binary file puts unreadable bytes into a model's context and into the audit log. The cap
  // would bound the damage and the frame would label it, and it would still be garbage — so the first NUL says no.
  const nul = buffer.subarray(0, 8192).indexOf(0);
  if (nul >= 0) {
    return refuse(
      "binary",
      `'${relative(verdict)}' is not text (a NUL byte at offset ${nul} of ${buffer.byteLength}); file.read reads text, and §4.2's row for it is a read of a file's content`,
    );
  }
  return framed(env, run, "file.read", verdict, buffer.toString("utf8"));
}

async function listDirectory(
  call: ToolCall,
  run: ToolRunContext,
  env: FileToolEnv,
): Promise<ToolOutcome> {
  const verdict = resolve(call, env);
  if (!verdict.ok) return refused(verdict);
  const entries = await readdir(verdict.resolved, { withFileTypes: true });
  const lines: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const kind = entry.isSymbolicLink() ? "link" : entry.isDirectory() ? "dir" : "file";
    let size = "";
    if (kind === "file") {
      // A listing that reports no size is a listing the model has to `file.stat` once per entry to use, and §4.2's row
      // puts both tools at T0 for exactly this kind of read.
      const stats = await stat(path.join(verdict.resolved, entry.name)).catch(() => undefined);
      size = stats === undefined ? "?" : String(stats.size);
    }
    lines.push(`${entry.name}\t${kind}${size === "" ? "" : `\t${size}`}`);
    if (run.signal.aborted) break;
  }
  const body = lines.length === 0 ? "(empty directory)" : lines.join("\n");
  return framed(
    env,
    run,
    "file.list",
    verdict,
    body,
    `${entries.length} ${entries.length === 1 ? "entry" : "entries"} in ${relative(verdict)}`,
  );
}

async function statPath(
  call: ToolCall,
  run: ToolRunContext,
  env: FileToolEnv,
): Promise<ToolOutcome> {
  const verdict = resolve(call, env);
  if (!verdict.ok) return refused(verdict);
  const stats = await stat(verdict.resolved).catch(() => undefined);
  const link = await lstat(verdict.resolved).catch(() => undefined);
  if (stats === undefined && link === undefined) {
    return refuse("enoent", `'${relative(verdict)}' does not exist`);
  }
  const effective = stats ?? link;
  if (effective === undefined) return refuse("enoent", `'${relative(verdict)}' does not exist`);
  const body = JSON.stringify(
    {
      path: verdict.resolved,
      kind: effective.isDirectory() ? "dir" : effective.isFile() ? "file" : "other",
      bytes: effective.size,
      modified: new Date(effective.mtimeMs).toISOString(),
      // A link is visible here without a flag of its own: this is the path §8's re-check produced, so a caller who named
      // a link sees its target and the hop is on the record. What a flag *is* owed is the case the resolution cannot
      // answer — a link whose target is gone, where `stat` fails and only `lstat` has anything to say.
      ...(stats === undefined ? { brokenLink: true } : {}),
    },
    null,
    2,
  );
  return framed(env, run, "file.stat", verdict, body);
}

async function createFile(
  call: ToolCall,
  run: ToolRunContext,
  env: FileToolEnv,
): Promise<ToolOutcome> {
  const verdict = resolve(call, env);
  if (!verdict.ok) return refused(verdict);
  const content = stringArg(call.args, "content") ?? "";
  if (existsSync(verdict.resolved)) {
    // §4.2's two rows again. This is the refusal that keeps the T1 row honest, and it names the tool that does the other
    // job so the model can plan around it rather than retry.
    return refuse(
      "exists",
      `'${relative(verdict)}' already exists, and file.write creates (§4.2's row is "file.write (new file)"); replacing a file is file.edit, which policy prices at T1 or T2 depending on whose file it is`,
    );
  }
  const stopping = stopped(run);
  if (stopping !== undefined) return stopping;
  await mkdir(path.dirname(verdict.resolved), { recursive: true });
  const written = await atomicCreate(verdict.resolved, content, run, env);
  return plain(
    true,
    `wrote ${Buffer.byteLength(content, "utf8")} bytes to ${verdict.resolved} (new file, ${written})`,
  );
}

async function replaceFile(
  call: ToolCall,
  run: ToolRunContext,
  env: FileToolEnv,
): Promise<ToolOutcome> {
  const verdict = resolve(call, env);
  if (!verdict.ok) return refused(verdict);
  const existing = await lstat(verdict.resolved).catch(() => undefined);
  if (existing === undefined) {
    return refuse(
      "enoent",
      `'${relative(verdict)}' does not exist, and file.edit replaces (§4.2's row is "file.edit (existing)"); creating a file is file.write`,
    );
  }
  if (existing.isDirectory()) {
    return refuse(
      "eisdir",
      `'${relative(verdict)}' is a directory; file.edit replaces a file's content`,
    );
  }
  const content = stringArg(call.args, "content") ?? "";
  const temporary = temporaryName(verdict.resolved, env);
  await writeFile(temporary, content, { encoding: "utf8", signal: run.signal });
  await rename(temporary, verdict.resolved);
  // The previous bytes are gone and no copy is kept, on purpose: §8's protection for an overwrite is the T2 approval
  // (§4.2's "destructive overwrites of pre-existing user files are T2"), not a shadow copy nobody priced a retention rule
  // for. `file.delete` moves to scratch because §8 asks it to; an edit does not, because §8 asks it to be atomic.
  return plain(
    true,
    `replaced ${relative(verdict)} with ${Buffer.byteLength(content, "utf8")} bytes (was ${existing.size}; atomic write + rename, §8)`,
  );
}

async function deletePath(
  call: ToolCall,
  run: ToolRunContext,
  env: FileToolEnv,
): Promise<ToolOutcome> {
  const verdict = resolve(call, env);
  if (!verdict.ok) return refused(verdict);
  const recursive = call.args.recursive === true;
  const hard = call.args.hard === true;
  const existing = await lstat(verdict.resolved).catch(() => undefined);
  if (existing === undefined) {
    // `declare.ts` promises this tool is idempotent, and this line is the promise: the end state after a re-run is the
    // state the first run intended, reported as such rather than as an error §7.3 would have to re-ask about.
    return plain(true, `'${relative(verdict)}' is already absent; nothing to delete`);
  }
  if (existing.isDirectory() && !recursive) {
    return refuse(
      "eisdir",
      `'${relative(verdict)}' is a directory, and deleting one needs recursive: true — which §4.2 prices at T3 and policy's IRREVERSIBLE_RULES marks irreversible`,
    );
  }
  if (hard) {
    const stopping = stopped(run);
    if (stopping !== undefined) return stopping;
    await rm(verdict.resolved, { recursive, force: false });
    return plain(
      true,
      `removed ${relative(verdict)}${recursive ? " and everything under it" : ""} (hard delete; the bytes are gone)`,
    );
  }
  // §8: "trash-or-rename should be offered in place of hard delete where the platform supports it". The trash is the
  // task's own scratch directory, which already exists, is already per-task, and is already pruned after 24 h by D-064 —
  // so the window to change one's mind is a documented lifetime rather than a new retention rule, and a completed task's
  // trashed bytes leave with the rest of its scratch.
  const trash = path.join(env.scratchDirFor(run.taskId), "trash");
  const stopping = stopped(run);
  if (stopping !== undefined) return stopping;
  await mkdir(trash, { recursive: true });
  const destination = path.join(trash, `${env.now()}-${path.basename(verdict.resolved)}`);
  try {
    await rename(verdict.resolved, destination);
  } catch (error) {
    if (errorCode(error) !== "EXDEV") throw error;
    if (existing.isDirectory()) {
      return refuse(
        "exdev",
        `'${relative(verdict)}' is a directory on a different device from the scratch directory, so it cannot be moved to trash; pass hard: true to remove it, which policy prices at T2/T3 and marks irreversible`,
      );
    }
    await copyFile(verdict.resolved, destination);
    await rm(verdict.resolved);
  }
  return plain(
    true,
    `moved ${relative(verdict)} to ${destination} instead of deleting it (§8's trash-or-rename); D-064 prunes that directory 24 h after the task ends`,
  );
}

async function movePath(
  call: ToolCall,
  run: ToolRunContext,
  env: FileToolEnv,
): Promise<ToolOutcome> {
  const source = resolve(call, env);
  if (!source.ok) return refused(source);
  const requested = stringArg(call.args, "destination");
  if (requested === undefined) {
    return refuse("invalid-arguments", "file.move needs a destination");
  }
  const target = checkPath(requested, env.paths, env.realpathOf);
  if (!target.ok) return refused(target);
  const existing = await lstat(source.resolved).catch(() => undefined);
  if (existing === undefined) {
    return refuse("enoent", `'${relative(source)}' does not exist, so there is nothing to move`);
  }
  const stopping = stopped(run);
  if (stopping !== undefined) return stopping;
  await mkdir(path.dirname(target.resolved), { recursive: true });
  try {
    await rename(source.resolved, target.resolved);
  } catch (error) {
    if (errorCode(error) !== "EXDEV") throw error;
    if (existing.isDirectory()) {
      return refuse(
        "exdev",
        `'${relative(source)}' is a directory and '${target.resolved}' is on another device; a tree cannot be moved atomically across devices, and a copy that failed halfway would leave two partial answers`,
      );
    }
    await copyFile(source.resolved, target.resolved);
    await rm(source.resolved);
  }
  return plain(
    true,
    `moved ${source.resolved} to ${target.resolved}${existing.isDirectory() ? " (directory)" : ""}`,
  );
}

interface SearchWalk {
  matches: string[];
  files: number;
  links: number;
  stopped: string | undefined;
}

async function searchContent(
  call: ToolCall,
  run: ToolRunContext,
  env: FileToolEnv,
): Promise<ToolOutcome> {
  const pattern = stringArg(call.args, "pattern");
  if (pattern === undefined) return refuse("invalid-arguments", "fs.search needs a pattern");
  let expression: RegExp;
  try {
    expression = new RegExp(pattern, call.args.ignoreCase === true ? "i" : "");
  } catch (error) {
    // §4.4's rule that a failure names what failed: an unparsable pattern reported as "no matches" would send the model
    // looking for a different pattern instead of a valid one.
    return refuse(
      "invalid-arguments",
      `the pattern '${pattern}' is not a usable regular expression: ${message(error)}`,
    );
  }
  const requested = stringArg(call.args, "path");
  const starts: Resolved[] = [];
  if (requested === undefined) {
    // Absent means every configured root, and §8's containment still holds: the walk begins at a root and never leaves
    // one, which is the difference between "search the workspace" and "search the device".
    for (const root of env.paths.roots) {
      const verdict = checkPath(root, env.paths, env.realpathOf);
      if (verdict.ok) starts.push(verdict);
    }
  } else {
    const verdict = checkPath(requested, env.paths, env.realpathOf);
    if (!verdict.ok) return refused(verdict);
    starts.push(verdict);
  }
  if (starts.length === 0) {
    return refuse(
      "path-refused",
      "fs.search has no workspace root to search (§8: the home directory is not a workspace)",
    );
  }

  const budget = Math.max(0, env.maxOutputBytes - SEARCH_SUMMARY_RESERVE);
  const walk: SearchWalk = { matches: [], files: 0, links: 0, stopped: undefined };
  let used = 0;
  outer: for (const start of starts) {
    const queue = [start.resolved];
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) break;
      if (run.signal.aborted) {
        walk.stopped = "the step was signalled to stop (§6.1)";
        break outer;
      }
      const self = await lstat(current).catch(() => undefined);
      if (self?.isFile() === true) {
        // A start that is one file is searched as one file: `fs.search {path: "notes.md"}` is a reasonable thing to ask
        // and refusing it would make the `path` argument mean "a directory" without §4.2 saying so.
        used = await searchOne(current, path.dirname(current), expression, run, budget, used, walk);
        if (walk.stopped !== undefined) break outer;
        continue;
      }
      const entries = await readdir(current, { withFileTypes: true }).catch(() => undefined);
      if (entries === undefined) {
        // A directory the process cannot list is a fact about the walk, not a failure of the search: report it in the
        // summary rather than aborting a search that has already found things.
        walk.matches.push(`# skipped ${current}: not readable`);
        continue;
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(current, entry.name);
        if (entry.isSymbolicLink()) {
          // Not followed, and the count is reported: §8's containment is judged per path, and a walk that hopped through
          // every link would be a containment check that ran once at the top and hoped.
          walk.links += 1;
          continue;
        }
        if (entry.isDirectory()) {
          queue.push(full);
          continue;
        }
        if (!entry.isFile()) continue;
        used = await searchOne(full, start.resolved, expression, run, budget, used, walk);
        if (walk.stopped !== undefined) break outer;
      }
    }
  }

  const summary = [
    `${walk.matches.length} matching ${walk.matches.length === 1 ? "line" : "lines"} in ${walk.files} ${walk.files === 1 ? "file" : "files"} searched`,
    walk.links > 0
      ? `${walk.links} symbolic ${walk.links === 1 ? "link" : "links"} not followed (§8's containment is per path)`
      : "",
    walk.stopped === undefined ? "" : `stopped early: ${walk.stopped}`,
  ]
    .filter((line) => line !== "")
    .join("; ");
  const body = walk.matches.length === 0 ? "(no matches)" : walk.matches.join("\n");
  const at = new Date(env.now()).toISOString();
  const text = `${wrapUntrusted(
    { source: "fs.search", subject: requested ?? env.paths.roots.join(", "), at },
    body,
    { nonce: env.nonce },
  )}\n${summary}`;
  return { ok: true, output: text };
}

/** Search one file and fold its matches into the walk, stopping at the cap. One helper for both the file-start and the
 *  walk, because the two would otherwise be the same twelve lines with a different `root` — and a cap enforced in two
 *  places is a cap enforced in neither. */
async function searchOne(
  file: string,
  root: string,
  expression: RegExp,
  run: ToolRunContext,
  budget: number,
  used: number,
  walk: { matches: string[]; files: number; stopped: string | undefined },
): Promise<number> {
  const found = await searchFile(root, file, expression, run, Math.max(0, budget - used));
  walk.files += 1;
  let total = used;
  for (const line of found.lines) {
    walk.matches.push(line);
    total += Buffer.byteLength(line, "utf8") + 1;
    if (total >= budget) {
      walk.stopped = `the ${budget}-byte budget for matches, inside D-064's inline cap`;
      break;
    }
  }
  return total;
}

/** One file's matches, streamed rather than read: a phone's workspace can hold a file larger than memory, and §4.4's cap
 *  is about what leaves the tool, not about how much of the user's storage it may buffer on the way. */
async function searchFile(
  root: string,
  file: string,
  expression: RegExp,
  run: ToolRunContext,
  budget: number,
): Promise<{ lines: string[] }> {
  const lines: string[] = [];
  let used = 0;
  const stream = createReadStream(file, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  let number = 0;
  try {
    for await (const line of reader) {
      number += 1;
      if (run.signal.aborted) break;
      if (!expression.test(line)) continue;
      const text = `${path.relative(root, file) || file}:${number}: ${line}`;
      lines.push(text);
      used += Buffer.byteLength(text, "utf8") + 1;
      if (used >= budget) break;
    }
  } catch {
    // A file that cannot be read mid-walk (permissions, a device that went away) is one file's absence, not the search's
    // failure; the count of files searched already says the walk was partial.
  } finally {
    reader.close();
    stream.destroy();
  }
  return { lines };
}

/** Reserved for `searchContent`'s summary line, which is printed after the matches and must not be what pushes the result
 *  past the cap. */
const SEARCH_SUMMARY_RESERVE = 512;

// ------------------------------------------------------------------ shared parts

/** §8's one path judgement, delegated whole to policy: resolve against a root, check containment, check the deny-list,
 *  resolve links, and check both again. The adapter's job is to use the answer and to act on the *resolved* path only —
 *  acting on the requested string is how a re-check gets bypassed. */
function resolve(call: ToolCall, env: FileToolEnv): PathVerdict {
  const requested = stringArg(call.args, "path");
  if (requested === undefined) {
    return { ok: false, sensitive: false, reason: `'${call.tool}' was called without a path` };
  }
  return checkPath(requested, env.paths, env.realpathOf);
}

/** A path the adapter can act on: §8's verdict narrowed to the branch that carries a resolved path. */
type Resolved = Extract<PathVerdict, { ok: true }>;

/** §6.1's step 2, checked by the adapter rather than assumed by the loop: `node:fs/promises` takes a cancellation signal
 *  on a read and a write and on nothing else, so a `mkdir`/`rename`/`rm` sequence has to be stopped *between* its calls or
 *  not at all. The loop's deadline still bounds the whole thing by abandoning the await (D-074); this is what keeps a
 *  step that was asked to stop from starting its next filesystem mutation. */
function stopped(run: ToolRunContext): ToolOutcome | undefined {
  return run.signal.aborted
    ? refuse(
        "aborted",
        "the step was signalled to stop before its next filesystem operation (§6.1: a cancellation asks for no more scheduled work)",
      )
    : undefined;
}

function refused(verdict: Extract<PathVerdict, { ok: false }>): ToolOutcome {
  // `path-refused` rather than a policy class: the arbiter already allowed this call, so a refusal here is the adapter
  // enforcing §8 at the moment of execution — the second of the two checks §8 asks for, and worth telling apart from a
  // denial that happened before it.
  return refuse("path-refused", verdict.reason);
}

function refuse(code: string, output: string): ToolOutcome {
  return { ok: false, output, code };
}

function plain(ok: boolean, output: string): ToolOutcome {
  return { ok, output };
}

/** Frame a result and cap it, with the overflow going to this task's scratch directory (D-064). The `note` is the
 *  runtime's own sentence about the result, so it sits outside the frame — §10's rule is that *foreign* text is inside
 *  the delimiters, and a reader who found Crabby's commentary inside them could not tell which of the two said it. */
function framed(
  env: FileToolEnv,
  run: ToolRunContext,
  source: string,
  verdict: Resolved,
  content: string,
  note?: string,
): ToolOutcome {
  const metadata: UntrustedMetadata = {
    source,
    subject: verdict.resolved,
    at: new Date(env.now()).toISOString(),
  };
  const capped = capWrapped(metadata, content, {
    maxBytes: env.maxOutputBytes,
    overflowDir: env.scratchDirFor(run.taskId),
    writeOverflow: writeOverflowFile,
    nonce: env.nonce,
  });
  const lines = [capped.text];
  if (note !== undefined) lines.push(note);
  return { ok: true, output: lines.join("\n") };
}

/** D-064's "larger goes to a file in the session scratch with the path printed". Written with mode 0600 in a directory
 *  `taskScratch` already created 0700, because the overflow is a verbatim copy of a file the user's policy allowed this
 *  task to read, and a second copy with looser permissions would be a new fact about the state directory. */
function writeOverflowFile(dir: string, content: string): string {
  const file = path.join(
    dir,
    `tool-output-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`,
  );
  // Synchronous on purpose: this is called from inside the framing of a result that is already in memory, and an async
  // write here would mean the label could not name the path it just created.
  writeFileSync(file, content, { encoding: "utf8", mode: 0o600 });
  return file;
}

/** §8's "atomic write + rename", plus the part that makes `file.write`'s refusal of an existing path mean something: a
 *  hard link onto the destination is the only create that fails atomically when the target appeared between the check and
 *  the write. Where the filesystem has no hard links (Termux's shared storage is a FUSE mount that often does not), the
 *  fallback is a rename, and the outcome says which happened rather than implying a guarantee the device did not give. */
async function atomicCreate(
  resolved: string,
  content: string,
  run: ToolRunContext,
  env: FileToolEnv,
): Promise<"linked" | "renamed"> {
  const temporary = temporaryName(resolved, env);
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, signal: run.signal });
  try {
    await link(temporary, resolved);
    await rm(temporary, { force: true });
    return "linked";
  } catch (error) {
    const code = errorCode(error);
    if (code === "EEXIST") {
      await rm(temporary, { force: true });
      throw Object.assign(
        new Error(`'${resolved}' appeared while the write was in progress, and file.write creates`),
        {
          code: "EEXIST",
        },
      );
    }
    if (code !== "EPERM" && code !== "EOPNOTSUPP" && code !== "EXDEV" && code !== "ENOSYS")
      throw error;
    await rename(temporary, resolved);
    return "renamed";
  }
}

function temporaryName(resolved: string, env: FileToolEnv): string {
  return `${resolved}.crabby-tmp-${env.nonce()}`;
}

function relative(verdict: Resolved): string {
  const root = verdict.root;
  const short = path.relative(root, verdict.resolved);
  return short === "" ? root : `${root}/${short.split(path.sep).join("/")}`;
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" ? code : undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
