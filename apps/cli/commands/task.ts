// `crabby task run|ls|show|cancel|watch` — reads, writes and streams over the same HTTP surface a phone uses, never into
// SQLite (`ARCHITECTURE.md` §19). `cancel` is here because §6 has a route behind it and a stop button that only three of
// four interfaces had would be the "one behaviour, four surfaces" rule broken where it matters most. `watch` is here for
// the same reason over §5.4: `GET /events` has filtered by `taskId`, replayed from `Last-Event-ID` and answered an
// out-of-window cursor with a `gap` frame since D-048, so the events existed and no terminal could follow them.
//
// `watch` is also the one verb in this file that does not answer with a single document. §7.1 promises NDJSON — one event
// per line, each carrying the per-task `seq` so a script notices a gap the way a browser does — which means the JSON
// rendering is a stream rather than a snapshot, and the difference is deliberate rather than an oversight: a trailing
// summary document would be a line a script parsing one-event-per-line never asked for.
// `run` is here because the thing that made it dishonest is gone: `POST /api/v1/tasks` composes a runner and hands the
// task to it with grants expanded from the identity that asked, so a created task has an end to reach and this verb can
// keep §7.1's promise to block until it does. It asks the Gateway whether a runner was composed *before* it creates
// anything, because a 201 nobody drives is worse than a refusal — and it shares `watch`'s stream rather than owning a
// second parser, differing only in §7.1's exit-3 rule.
import { randomBytes } from "node:crypto";
import {
  CANCELLATION_MODES,
  type CancellationMode,
  type Event,
  EXIT,
  type ExitCode,
  isTerminal,
  TASK_STATES,
  type TaskCheckpoint,
  type TaskRecord,
  TERMINAL_STATES,
} from "@crabby/api-contracts";
import { type GatewayClient, GatewayFailure, readCredentials } from "@crabby/gateway";
import type { DataLayout } from "@crabby/platform";
import { parseTail } from "../args.ts";
import { connect, reportFailure, reportNoGateway } from "../connect.ts";
import { clip, type Renderer, shortId } from "../output.ts";
import { findCommand } from "../registry.ts";

export type TaskVerb = "ls" | "show" | "cancel" | "watch" | "run";

/** The events that end a task, derived rather than retyped: `TERMINAL_STATES` is the constant the runtime uses to decide
 *  that a run is over, and a watch that could not see those events would never know to stop. Naming them as
 *  `task.<state>` keeps this list tied to that one source, so a state added to the runtime cannot leave this filter
 *  behind — the failure mode is a command that hangs, which no test a user runs would explain. */
const TERMINAL_EVENT_TYPES = TERMINAL_STATES.map((state) => `task.${state}`);

export async function runTask(
  verb: TaskVerb | undefined,
  argv: readonly string[],
  layout: DataLayout,
  renderer: Renderer,
): Promise<ExitCode> {
  const spec = findCommand("task", verb);
  const tail = parseTail(argv, spec);
  if (tail.unknown.length > 0) {
    renderer.line("unknown flag(s)", tail.unknown.join(" "));
    renderer.fix(`${(spec?.flags ?? []).join(" ")} are what this verb accepts`);
    return EXIT.usage;
  }
  // Answered before the Gateway is asked about, because §7.1's exit-code contract is about the command and not about the
  // process it would have talked to: a malformed `task cancel` is a usage question (exit 2) whether or not a Gateway is
  // running, and answering it afterwards would make the same typo exit 1 on a machine whose Gateway is down. The checks
  // read `tail`, which `parseTail` already produced, so nothing here needs a connection.
  const cancelId = verb === "cancel" ? tail.positionals[0] : undefined;
  if (verb === "cancel" && cancelId === undefined) {
    renderer.line("task cancel", "which task? `crabby task ls` prints the ids");
    return EXIT.usage;
  }
  const cancelMode = verb === "cancel" ? tail.values.mode : undefined;
  if (cancelMode !== undefined && !CANCELLATION_MODES.includes(cancelMode as CancellationMode)) {
    renderer.line("bad --mode", `"${cancelMode}" is not a cancellation mode`);
    renderer.fix(`${CANCELLATION_MODES.join(" | ")} — leaving it off asks for §6.1's finish-step`);
    return EXIT.usage;
  }
  // Same rule as `cancel`, and for the same reason: `watch` is the verb most likely to be run in a script or over SSH,
  // where "which task?" answered as a connection failure is the difference between a fixed command and a mystery.
  const watchId = verb === "watch" ? tail.positionals[0] : undefined;
  if (verb === "watch" && watchId === undefined) {
    renderer.line("task watch", "which task? `crabby task ls` prints the ids");
    return EXIT.usage;
  }
  // `--types` is split here rather than in the stream loop for the reason §7.1 gives exit 2: a value that yields no
  // filter at all would ask the Gateway for nothing and then wait forever, and the user learns that from the command
  // that mistyped it rather than from a stream that never answers. The Gateway trims and drops empty tokens itself
  // (`app.ts` parses the query the same way), so the local rule is the same rule, read where the fix is one keystroke
  // away instead of being discovered as a hang.
  const watchTypesRaw = verb === "watch" ? tail.values.types : undefined;
  const watchTypes =
    watchTypesRaw === undefined
      ? undefined
      : watchTypesRaw
          .split(",")
          .map((token) => token.trim())
          .filter((token) => token.length > 0);
  if (watchTypesRaw !== undefined && (watchTypes === undefined || watchTypes.length === 0)) {
    renderer.line("bad --types", `"${watchTypesRaw}" names no event type`);
    renderer.fix(
      "a comma-separated list such as `task.progress,tool.*` — leaving the flag off follows every event",
    );
    return EXIT.usage;
  }
  // `run`'s objective is every positional joined rather than the first one, because an objective is a sentence and a
  // shell that was not given quotes should not turn "summarise notes.md" into a task called "summarise" with an
  // argument nobody reads. Empty is a usage question, answered before the Gateway is asked about for the reason the
  // other checks here are: §7.1's exit codes are about the command, not about the process it would have talked to.
  const runObjective = verb === "run" ? tail.positionals.join(" ").trim() : undefined;
  if (verb === "run" && (runObjective === undefined || runObjective.length === 0)) {
    renderer.line("task run", 'what should the task do? `crabby task run "summarise notes.md"`');
    renderer.fix(
      "`--detach` creates it and returns at once; without it the command follows the task to its end",
    );
    return EXIT.usage;
  }
  // `show` reads its id here for the reason the other three do. The seventeenth slice moved `cancel`'s checks ahead of
  // `connect` and left `show` checking after it, so `crabby task show` with no id on a machine whose Gateway is down
  // answered "which task?" as a connection failure (exit 1) instead of a usage question (exit 2) — one rule, four
  // verbs, answered where the typo is made rather than where the process it would have talked to happens to be
  // unreachable.
  const showId = verb === "show" ? tail.positionals[0] : undefined;
  if (verb === "show" && showId === undefined) {
    renderer.line("task show", "which task? `crabby task ls` prints the ids");
    return EXIT.usage;
  }
  const connection = await connect(layout);
  if (connection.state !== "paired") return reportNoGateway(renderer, connection.state);

  if (verb === "ls") {
    try {
      const response = await connection.client.listTasks({
        ...(tail.values.state === undefined
          ? {}
          : { state: tail.values.state as TaskRecord["state"] }),
        ...(tail.values.limit === undefined ? {} : { limit: Number(tail.values.limit) }),
        ...(tail.values.cursor === undefined ? {} : { cursor: tail.values.cursor }),
      });
      const page = response.body as { items: TaskRecord[]; nextCursor?: string };
      if (page.items.length === 0) {
        renderer.line("tasks", "none");
        // True whether or not this Gateway drives tasks, and it does not take a second request to be true: `task run`
        // asks `runs.composed` itself and refuses before it creates anything, so naming the verb here cannot send a
        // user to a command that silently leaves a task in `queued`. The line this replaces said the verb "comes with
        // the runtime", which it now does.
        renderer.fix(
          'no task has been created yet — `crabby task run "<objective>"` creates one and follows it, and refuses up ' +
            "front if this Gateway composes no runner to drive it",
        );
        return renderer.done({ items: [], nextCursor: null });
      }
      for (const task of page.items)
        renderer.line(shortId(task.id), `${task.state.padEnd(16)}${clip(task.objective, 56)}`);
      if (page.nextCursor) renderer.fix(`crabby task ls --cursor ${page.nextCursor}`);
      return renderer.done({ ...page });
    } catch (error) {
      return reportFailure(renderer, error);
    }
  }

  if (verb === "show" && showId !== undefined) {
    // Read and checked before the Gateway was asked, so `showId` is a string here; the `!== undefined` guard is the
    // narrowing the compiler needs, and the case it excludes already returned at the pre-connect check above.
    const id = showId;
    try {
      const response = await connection.client.getTask(id);
      const task = response.body as TaskRecord;
      renderer.line("id", task.id);
      renderer.line("state", task.state);
      renderer.line("objective", task.objective);
      renderer.line("session", task.sessionId);
      renderer.line("events", String(task.lastSeq));
      renderer.line("created", task.createdAt);
      renderer.line("updated", task.updatedAt);
      if (task.error) renderer.line("error", `${task.error.code}: ${task.error.message}`);
      // §10.1 asks this screen for "cancellation or recovery status", and §6.2's evidence is on the record now (F-46,
      // D-091), so the line prints the two facts a user has to judge rather than the word "cancelled" alone: whether the
      // operation stopped, and whether an external effect may already have happened. The `--json` document carries the
      // whole object because it spreads the record, which is the same fact in both renderings.
      if (task.cancellation)
        renderer.line(
          "cancelled",
          `${task.cancellation.mode} · ${
            task.cancellation.terminated ? "confirmed stopped" : "may still be running"
          } · ${
            task.cancellation.effectsUncertain
              ? "external effects uncertain"
              : "no external effect in doubt"
          }`,
        );
      // D-095's boundary, because §10.1 asks this screen for recovery status and `interrupted` alone is half an answer:
      // the other half is whether a saved state exists at all and what D-065's rule says may be passed across it. The
      // `404` is an expected answer for a task that never committed a step, so it is read here as what it means rather
      // than allowed to escape into the catch below, which would turn a fact about the task into a failed command.
      let checkpoint: TaskCheckpoint | undefined;
      try {
        checkpoint = (await connection.client.taskCheckpoint(id)).body as TaskCheckpoint;
        renderer.line(
          "checkpoint",
          `${checkpoint.boundary} at step ${checkpoint.step} · ${checkpoint.resume.verdict} · ` +
            `${checkpoint.messages} message(s), ${checkpoint.bytes} bytes, redacted`,
        );
        if (checkpoint.resume.verdict === "re-ask") {
          const tool = checkpoint.resume.inFlight?.tool;
          renderer.fix(
            tool === undefined
              ? "a step was in flight when the process ended and its effect cannot be established, so a resume re-asks " +
                  "rather than repeating it (D-065, AGENT_RUNTIME.md §7.3)"
              : `'${tool}' was in flight when the process ended and its effect cannot be established, so a resume re-asks ` +
                  "rather than repeating it (D-065, AGENT_RUNTIME.md §7.3)",
          );
        }
      } catch (error) {
        if (error instanceof GatewayFailure && error.status === 404) {
          renderer.line(
            "checkpoint",
            "none — the run never committed a step boundary, so there is nothing to resume from and nothing to repeat",
          );
        } else {
          throw error;
        }
      }
      const events = await connection.client.taskEvents(id, Math.max(0, task.lastSeq - 9));
      const listed = (
        events.body as { items: { id: string; seq: number; type: string; ts: string }[] }
      ).items;
      if (listed.length > 0) {
        renderer.line("", "");
        renderer.line("tail", `last ${listed.length} of ${task.lastSeq}`);
        for (const event of listed)
          renderer.line(`  ${String(event.seq).padStart(4)}`, `${event.type}  ${event.ts}`);
      }
      return renderer.done({ ...task, tail: listed, checkpoint: checkpoint ?? null });
    } catch (error) {
      return reportFailure(renderer, error);
    }
  }

  if (verb === "cancel" && cancelId !== undefined) {
    // `cancelId` and `cancelMode` are read from the checks above `connect`, which already refused an absent id and an
    // unknown mode at the usage exit code. Re-deriving them here would be a second copy of one rule, and the two copies
    // would eventually disagree about which of them answers first.
    const id = cancelId;
    const mode = cancelMode;
    const reason = tail.values.reason;
    try {
      const response = await connection.client.cancelTask(id, {
        ...(mode === undefined ? {} : { mode: mode as CancellationMode }),
        ...(reason === undefined ? {} : { reason }),
      });
      const task = response.body as TaskRecord;
      renderer.line("id", task.id);
      renderer.line("state", task.state);
      // §6.2's two facts, printed the way `task show` prints them so one screen does not contradict the other. The
      // distinction that has to survive is `cancelling` from `cancelled`: a request recorded but not settled is D-090's
      // present-without-`settledAt`, and a user who reads it as stopped would walk away from work still running.
      const cancellation = task.cancellation;
      if (cancellation === undefined) {
        renderer.line("cancellation", "none recorded — the task is not stopping");
      } else if (cancellation.settledAt === undefined) {
        renderer.line(
          "cancellation",
          `${cancellation.mode} requested, not settled — a step is still finishing; ` +
            "`crabby task show` prints the evidence when it lands",
        );
      } else {
        renderer.line(
          "cancellation",
          `${cancellation.mode} · ${
            cancellation.terminated ? "confirmed stopped" : "may still be running"
          } · ${
            cancellation.effectsUncertain
              ? "external effects uncertain"
              : "no external effect in doubt"
          }`,
        );
      }
      if (cancellation?.inFlight !== undefined && cancellation.inFlight !== "none")
        renderer.line(
          "in flight",
          `${cancellation.inFlight} — which is why the answer about effects is the one above (D-089)`,
        );
      if (task.state === "cancelling")
        renderer.fix(
          "`--mode immediate` is §6.2's override if finishing the step is not acceptable",
        );
      return renderer.done({ ...task });
    } catch (error) {
      return reportFailure(renderer, error);
    }
  }

  if (verb === "run" && runObjective !== undefined) {
    // Asked before anything is created, because §7.1's contract for this verb is that it *blocks and follows*: a
    // Gateway that composed no runner would answer 201 and then leave the user watching a task that cannot move. The
    // record is not the honest part — creating a task nobody will drive is, and it is avoidable for the price of one
    // read the route already answers.
    let diagnostics: { runs?: { composed?: boolean } };
    try {
      diagnostics = (await connection.client.diagnostics()).body as {
        runs?: { composed?: boolean };
      };
    } catch (error) {
      return reportFailure(renderer, error);
    }
    if (diagnostics.runs?.composed !== true) {
      renderer.line("tasks", "this Gateway records tasks and drives none, so no task was created");
      renderer.fix(
        "`crabby gateway start` prints which half is missing: a workspace root (`crabby init`) and a selected default " +
          "model (`crabby config set defaultModel <provider>/<modelId>`) are what a runner is composed from",
      );
      return EXIT.failure;
    }
    // One opaque key per invocation, generated rather than asked for: §2 makes `Idempotency-Key` mandatory on this
    // route so a retried create cannot make a second task, and a command that made the user supply one would be a
    // command whose common path needs a flag — which §10's latency row rules out by name. Random rather than derived
    // from the objective on purpose: a key that came from the text would make a second, deliberate `task run` of the
    // same sentence return the first task instead of creating one, and the user asked twice. Generated the way the
    // pairing code and the token are (`packages/storage/clients.ts`), so one idiom makes the opaque strings in this
    // codebase.
    const key = randomBytes(16).toString("base64url");
    let record: TaskRecord;
    try {
      record = (await connection.client.createTask({ objective: runObjective }, key))
        .body as TaskRecord;
    } catch (error) {
      return reportFailure(renderer, error);
    }
    // Printed first and whole. §7.1's row exists for the case it names — a dropped SSH session — and the id on the
    // screen is what makes the loss nothing: the events are on the record and any client can follow them from anywhere.
    // The reattach line names `task watch` rather than the `task resume` the row was written around, because the verb is
    // M3's grammar and a printed command that cannot run is worse than a printed one that can. `POST /tasks/{id}/resume`
    // does answer a ladder ask now (D-044) — but it answers *this* process's park, and a reattach is by definition the
    // case where the client reconnected to a Gateway that may no longer hold the run (docs/CONSISTENCY_REVIEW.md F-47),
    // which is the opposite of the condition that route requires.
    renderer.line("task", `${record.id} · ${record.state}`);
    renderer.fix(
      `crabby task watch ${record.id} — reattach from any client; the events are on the record`,
    );
    // Read from `booleans` and not from `values`: `parseTail` puts a registry entry written without an argument —
    // `"--detach"`, not `"--detach X"` — into the switch set, so `values.detach` was never anything and the flag this
    // command advertised, the one §7.1's row calls "the script path", was parsed and then ignored. It is the CLI's
    // first boolean tail flag, which is why there was no neighbouring call to copy: every other switch in the registry
    // belongs to a verb that is still `planned`.
    if (tail.booleans.has("--detach"))
      // One document and not two. The `raw()` line below exists for the path that follows: there the record is the
      // first line of an NDJSON stream and `followTask` returns without rendering a second document. Detached there is
      // no stream, so `done()` is the whole answer — and a stdout holding two JSON documents, one compact and one
      // indented, is a stdout no script can parse either way.
      return renderer.done({ ...record, following: false, idempotencyKey: key });
    if (renderer.json) renderer.raw(JSON.stringify(record));
    return followTask({
      url: connection.url,
      client: connection.client,
      layout,
      renderer,
      taskId: record.id,
      stopAtApproval: true,
      exitOnOutcome: true,
    });
  }

  if (verb === "watch" && watchId !== undefined)
    return followTask({
      url: connection.url,
      client: connection.client,
      layout,
      renderer,
      taskId: watchId,
      ...(watchTypes === undefined ? {} : { types: watchTypes }),
      stopAtApproval: false,
      exitOnOutcome: false,
    });

  renderer.line("task", "which verb? `run`, `ls`, `show`, `cancel` or `watch`");
  return EXIT.usage;
}

/** Following one task's events to the end of it, shared by `watch` and `run` because they are the same stream and the
 *  same framing rules — §5.4's `gap` and `end` frames, §5.1's heartbeat, the per-task `seq`, and the cursor a
 *  reconnecting client would use. One copy rather than two, because a second implementation of an SSE parser is a second
 *  place for the chunk-boundary bug to live.
 *
 *  `stopAtApproval` is the only difference the two verbs need, and it is §7.1's rather than a preference: `watch`
 *  keeps streaming through a prompt because its whole job is to show what happens, while `run` exits 3 at one because
 *  its contract is to block until the task ends and `--wait-approval <n>` — the opt-in that would make blocking
 *  legitimate — is in no registry. */
export interface FollowInput {
  readonly url: string;
  readonly client: GatewayClient;
  readonly layout: DataLayout;
  readonly renderer: Renderer;
  readonly taskId: string;
  /** What to *print*. The stream always asks for the terminal types as well, so a filter cannot hide the event that
   *  ends the follow and leave the command holding an open socket forever. */
  readonly types?: readonly string[] | undefined;
  /** Whether the task's own outcome decides the exit code. `task run` *is* the act of running a task, so §7.1's `1`
   *  is about the run: a task that ended `failed` must not let a script, or a person, read success from the command that
   *  started it. `task watch` leaves it false, because a read reports its subject's outcome rather than inheriting it —
   *  the same reason `task show` on a failed task exits `0` — and the state is on every NDJSON line for a caller that
   *  wants to decide for itself. */
  readonly exitOnOutcome: boolean;
  readonly stopAtApproval: boolean;
}

/** §7.1's exit codes read off a terminal state rather than off a stream. `completed` is the only success: `failed`,
 *  `cancelled` and `interrupted` all mean the work did not finish, and a caller that continues as though it had is the
 *  harm an exit code exists to prevent — a cancellation the user asked for is still a run that produced nothing. A state
 *  that is not terminal answers `undefined`, so the caller falls through to whatever else it knows. */
function exitForState(state: TaskRecord["state"] | undefined): ExitCode | undefined {
  if (state === "completed") return EXIT.success;
  if (state === "failed" || state === "cancelled" || state === "interrupted") return EXIT.failure;
  return undefined;
}

export async function followTask(input: FollowInput): Promise<ExitCode> {
  const { url, client, layout, renderer, taskId, types, stopAtApproval, exitOnOutcome } = input;
  // The task is read once before the stream opens, for a reason that is about hanging rather than about convenience: a
  // task that already reached a terminal state will never publish another event, so opening a stream for it would block
  // until the user interrupts. Answering "already cancelled" is both faster and the truth.
  let task: TaskRecord;
  try {
    task = (await client.getTask(taskId)).body as TaskRecord;
  } catch (error) {
    return reportFailure(renderer, error);
  }
  if (isTerminal(task.state)) {
    const absorbing =
      `${taskId} is ${task.state}, which is terminal and absorbing (AGENT_RUNTIME.md §4.1), so no further event will ` +
      "arrive — `crabby task show` prints what it left behind";
    renderer.line("state", task.state);
    renderer.fix(absorbing);
    // The verb that *is* the run answers with the run's outcome even when the task had already ended before the stream
    // was worth opening; a read verb reports and succeeds.
    const already = exitOnOutcome ? exitForState(task.state) : undefined;
    if (renderer.json) {
      // One line, because §7.1 promises this verb NDJSON and `done()` renders its document with two-space indentation:
      // a pretty-printed answer would arrive as dozens of lines that no script parsing one-document-per-line can read.
      // The same refusal is therefore a paragraph for a human and a single JSON object for a machine, with `streamed:
      // false` and `events: 0` saying plainly that no stream was ever opened rather than leaving a reader to infer it
      // from an absence.
      renderer.raw(
        JSON.stringify({
          ok: already !== EXIT.failure,
          ...task,
          events: 0,
          streamed: false,
          fixes: [absorbing],
        }),
      );
      return already ?? EXIT.success;
    }
    if (already === EXIT.failure)
      return renderer.fail({
        code: `task.${task.state}`,
        message:
          `${taskId} is ${task.state}, which is terminal and absorbing (AGENT_RUNTIME.md §4.1), and §7.1's exit code ` +
          `is the run's outcome — \`crabby task show ${taskId}\` prints what it left behind`,
        ...task,
        events: 0,
        streamed: false,
      });
    return renderer.done({ ...task, events: 0, streamed: false });
  }

  // A raw fetch rather than a client method, because `GatewayClient` is buffered by design: every other route answers
  // with one document, and giving it a streaming member would mean two lifecycles behind one interface. The token comes
  // from the same credentials `connect` paired with, and the URL from the Gateway's own published one, so an ephemeral
  // port is honoured exactly as it is everywhere else.
  const credentials = readCredentials(layout);
  if (credentials === undefined) return reportNoGateway(renderer, "unpaired");
  let response: globalThis.Response;
  try {
    // The filter the user asked for, widened by the three events that end a task. A `--types` value that left out
    // `task.cancelled` would otherwise hide the very event that makes a watch finish, and the command would hold a
    // stream open forever — which is §7.1's promise broken by a flag whose whole job is to narrow what is printed.
    // Narrowing the *display* is the user's business; narrowing what the command can see about its own ending is not,
    // so the widening happens in the query and the narrowing happens below, at print time.
    const requested = types === undefined ? undefined : [...types, ...TERMINAL_EVENT_TYPES];
    response = await fetch(
      `${url}/api/v1/events?taskId=${encodeURIComponent(taskId)}` +
        (requested === undefined ? "" : `&types=${encodeURIComponent(requested.join(","))}`),
      {
        headers: {
          authorization: `Bearer ${credentials.token}`,
          accept: "text/event-stream",
        },
      },
    );
  } catch (error) {
    return reportFailure(renderer, error);
  }
  if (!response.ok || response.body === null) {
    renderer.line(
      "stream refused",
      `the Gateway answered ${response.status} to GET /api/v1/events`,
    );
    renderer.fix("crabby gateway status — is the Gateway still running?");
    return EXIT.failure;
  }

  renderer.line(
    "watching",
    types === undefined
      ? `${taskId} · ${task.state} · waiting for events`
      : `${taskId} · ${task.state} · ${types.join(",")} · waiting for events`,
  );
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastEventId: string | undefined;
  let seen = 0;
  let promptId: string | undefined;
  /** D-044's ask facts, read off the transition frame rather than off `provider.switch.proposed`: the state move is the
   *  frame every interface already follows, so a client that filters event families still learns the task is waiting on a
   *  model and not on a prompt. */
  let askSpent: Record<string, unknown> | undefined;
  let finalState: TaskRecord["state"] = task.state;
  let ended: string | undefined;
  // Frames are separated by a blank line, and a chunk boundary can fall inside one, so the buffer is only ever consumed
  // up to the last complete separator. Dropping the tail would lose an event; parsing it early would invent one.
  outer: for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    for (;;) {
      const separator = buffer.indexOf("\n\n");
      if (separator === -1) break;
      const rawFrame = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      let name: string | undefined;
      let idLine: string | undefined;
      const dataLines: string[] = [];
      for (const line of rawFrame.split("\n")) {
        // A line starting with a colon is a comment, which is what the 15-second heartbeat sends. Skipping it is what
        // keeps an idle stream from printing noise, and §5.1's heartbeat exists to be ignored.
        if (line.startsWith(":")) continue;
        if (line.startsWith("id:")) idLine = line.slice(3).trim();
        else if (line.startsWith("event:")) name = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length === 0) continue;
      const parsed = JSON.parse(dataLines.join("\n")) as Record<string, unknown>;

      // §5.4's two control frames are facts, not noise: a gap means the cursor asked for events outside the window and
      // the answer is to reconcile from `stateAt`, and an end frame means the stream itself is closing for a reason the
      // client did not choose. Printing neither would turn an outage into a silent EOF.
      if (name === "gap" || parsed.gap === true) {
        const gapLine = JSON.stringify({ gap: true, stateAt: parsed.stateAt, taskId: taskId });
        if (renderer.json) renderer.raw(gapLine);
        else {
          renderer.line(
            "gap",
            "the stream's window no longer holds the cursor; reconcile from the task's state",
          );
          renderer.fix(`crabby task show ${taskId}`);
        }
        continue;
      }
      if (parsed.end === true) {
        ended = String(parsed.reason ?? "unknown");
        if (renderer.json) renderer.raw(JSON.stringify({ end: true, reason: ended }));
        else renderer.line("stream ended", String(ended));
        break outer;
      }

      const event = parsed as unknown as Event;
      if (idLine !== undefined) lastEventId = idLine;
      // Printed only if the user asked for it, matched the way the Gateway matches: an exact type or a prefix ending in
      // a dot, so `task` follows `task.state.changed` and `task.` follows the same events without swallowing
      // `taskmaster.whatever`. The cursor still advances for an event that is not printed, because §5.1's reconnect
      // contract is about the stream's position and not about what one client chose to look at.
      const wanted =
        types === undefined ||
        types.some((filter) => event.type === filter || event.type.startsWith(`${filter}.`));
      if (wanted) {
        seen += 1;
        if (renderer.json) renderer.raw(JSON.stringify(event));
        else renderer.line(String(event.seq).padStart(4), `${event.type}  ${event.ts}`);
      }

      // Two ways to recognise the end, because a terminal state arrives either as the state change itself or as the
      // event named for it, and watching past either one would leave the user staring at a prompt that will never
      // print. `interrupted` is deliberately not one of them: it is not terminal (§4.1), and a run may resume.
      //
      // The state comes from `to`, and falls back to `state` only for the frames that carry one: every transition frame
      // — `task.state.changed` and the terminal `task.completed`, `task.failed` and `task.cancelled` — reports
      // `{from, to}`, and reading `state` alone left this command holding the state the task was *created* in. That is
      // how `task run` came to answer exit `0` for a run that had ended `failed`: the frame that said so was read, and
      // then not believed. Found by running the command against a live Gateway rather than by reading it, which is the
      // reason §7.1's exit codes are a contract about the outcome and not about the stream. `approval.requested` carries
      // a `state` too, but it is the *approval's* — "pending" — so what a frame reports is checked against §4.1's list
      // before this command acts on it.
      const reported =
        typeof event.payload?.to === "string"
          ? event.payload.to
          : typeof event.payload?.state === "string"
            ? event.payload.state
            : undefined;
      const state =
        reported !== undefined && (TASK_STATES as readonly string[]).includes(reported)
          ? reported
          : undefined;
      if (typeof event.payload?.approvalId === "string") promptId = event.payload.approvalId;
      // D-044's ask parks in `awaiting_approval` with *no* approval behind it, and the two pauses want different
      // sentences: one is answered by naming a model, the other by doing something else. The transition frame carries the
      // ladder's facts (`ladder` plus the pair the run was on), so one field is enough to tell them apart without depending
      // on the order two events arrived in.
      if (typeof event.payload?.ladder === "object" && event.payload.ladder !== null) {
        askSpent = event.payload;
      }
      // §7.1's exit-3 row: "Approval needed, no answer reachable — exit `3` immediately", with `--wait-approval <n>`
      // as the only opt-in to keep waiting. That flag is in no registry, so there is nothing to opt into and blocking on
      // anyway would be exactly the silent hang inside a cron job the row exists to prevent. The id is tracked across
      // frames rather than read from the one that stops the follow, because D-086's pause arrives as a state with *no*
      // prompt behind it and the two answers a user needs are different sentences.
      if (
        stopAtApproval &&
        (state === "awaiting_approval" || event.type === "approval.requested")
      ) {
        await reader.cancel();
        // Three sentences for three pauses, because the fixes are three different things. The ladder's ask names the route
        // that answers it, because that is what exists in this build — the `task resume` verb C6-10 prints is M3's grammar,
        // and a fix line naming a command that cannot run is worse than one naming the route that can.
        const answer =
          promptId !== undefined
            ? "`crabby approval approve " +
              promptId +
              "` continues it and `crabby approval deny " +
              promptId +
              "` ends the step; `--wait-approval`, §7.1's opt-in to keep blocking here, is in no registry yet"
            : askSpent !== undefined
              ? "answer POST /api/v1/tasks/" +
                taskId +
                "/resume with one of the models the ask offers, or with `{}` to retry the same one (`crabby task resume " +
                taskId +
                "`, C6-10, is M3's grammar and is in no registry yet)"
              : "`crabby task show " +
                taskId +
                "` prints why — a task paused under D-086 has no prompt to answer, and nothing resumes it but a new run";
        if (renderer.json) {
          renderer.raw(
            JSON.stringify({
              ok: false,
              code: "needs-approval",
              task: taskId,
              state: "awaiting_approval",
              ...(promptId === undefined ? {} : { approvalId: promptId }),
            }),
          );
          return EXIT.needsApproval;
        }
        renderer.line(
          "needs approval",
          promptId !== undefined
            ? `${taskId} is waiting on approval ${promptId}`
            : askSpent !== undefined
              ? `${taskId} is awaiting_approval after ${String(
                  (askSpent.ladder as { attempts?: unknown } | undefined)?.attempts ?? "?",
                )} provider attempts (D-044's ask for another model)`
              : `${taskId} is awaiting_approval with no prompt behind it (D-086's pause after repeated denials)`,
        );
        renderer.fix(answer);
        return EXIT.needsApproval;
      }

      if (
        (state !== undefined && isTerminal(state as TaskRecord["state"])) ||
        event.type === "task.completed" ||
        event.type === "task.failed" ||
        event.type === "task.cancelled"
      ) {
        // The frame's own state, then the event type's, then whatever was last known: a terminal frame that somehow
        // carried no `to` still ends a run, and `task run`'s exit code must not depend on which of the two halves of the
        // record happened to speak last.
        finalState = (state ??
          (event.type === "task.completed"
            ? "completed"
            : event.type === "task.failed"
              ? "failed"
              : event.type === "task.cancelled"
                ? "cancelled"
                : finalState)) as TaskRecord["state"];
        await reader.cancel();
        break outer;
      }
    }
  }

  // The last id is printed rather than acted on. §5.1 gives a reconnecting client `Last-Event-ID` and the Gateway
  // honours it, but a command that reconnected silently would hide the outage that made it reconnect — so the cursor is
  // handed to whoever is driving, and the exit code says the stream is over.
  // The outcome, and only for the verb that is the run. Everything above this line is the same for both verbs: the same
  // frames, the same `seq`, the same last-event-id handed to whoever is driving.
  const outcome = exitOnOutcome ? exitForState(finalState) : undefined;

  if (lastEventId !== undefined && !renderer.json)
    renderer.fix(
      `last event id ${lastEventId} — reconnect with Last-Event-ID to resume without a gap`,
    );
  if (renderer.json) {
    // NDJSON is the contract §7.1 names for this verb, and a trailing summary document would be a line a script
    // parsing one-event-per-line did not ask for. The document form is what a snapshot command returns, not a stream.
    return outcome ?? (ended === undefined ? EXIT.success : EXIT.failure);
  }
  if (outcome === EXIT.failure)
    return renderer.fail({
      code: finalState === undefined ? "failure" : `task.${finalState}`,
      message:
        `${taskId} ended ${finalState ?? "without a terminal state"}: §7.1's exit code is the run's outcome and not the ` +
        `stream's — \`crabby task show ${taskId}\` prints what it left behind`,
      task: taskId,
      ...(finalState === undefined ? {} : { state: finalState }),
      events: seen,
      streamed: true,
      ...(lastEventId === undefined ? {} : { lastEventId }),
    });
  return renderer.done({
    task: taskId,
    state: finalState,
    events: seen,
    streamed: true,
    ...(lastEventId === undefined ? {} : { lastEventId }),
    ...(ended === undefined ? {} : { ended }),
  });
}
