// `crabby task ls|show|cancel|watch` — reads, writes and streams over the same HTTP surface a phone uses, never into
// SQLite (`ARCHITECTURE.md` §19). `cancel` is here because §6 has a route behind it and a stop button that only three of
// four interfaces had would be the "one behaviour, four surfaces" rule broken where it matters most. `watch` is here for
// the same reason over §5.4: `GET /events` has filtered by `taskId`, replayed from `Last-Event-ID` and answered an
// out-of-window cursor with a `gap` frame since D-048, so the events existed and no terminal could follow them.
//
// `watch` is also the one verb in this file that does not answer with a single document. §7.1 promises NDJSON — one event
// per line, each carrying the per-task `seq` so a script notices a gap the way a browser does — which means the JSON
// rendering is a stream rather than a snapshot, and the difference is deliberate rather than an oversight: a trailing
// summary document would be a line a script parsing one-event-per-line never asked for.
// `task run` is not here: creating a task that no runtime will move is the placeholder work the owner asked me not to
// do, so the verb stays `planned` in the registry until the milestone that gives it an executor.
import {
  CANCELLATION_MODES,
  type CancellationMode,
  type Event,
  EXIT,
  type ExitCode,
  isTerminal,
  type TaskCheckpoint,
  type TaskRecord,
  TERMINAL_STATES,
} from "@crabby/api-contracts";
import { GatewayFailure, readCredentials } from "@crabby/gateway";
import type { DataLayout } from "@crabby/platform";
import { parseTail } from "../args.ts";
import { connect, reportFailure, reportNoGateway } from "../connect.ts";
import { clip, type Renderer, shortId } from "../output.ts";
import { findCommand } from "../registry.ts";

export type TaskVerb = "ls" | "show" | "cancel" | "watch";

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
        renderer.fix(
          "the Gateway accepts POST /api/v1/tasks now; `crabby task run` comes with the runtime",
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

  if (verb === "show") {
    const id = tail.positionals[0];
    if (id === undefined) {
      renderer.line("task show", "which task? `crabby task ls` prints the ids");
      return EXIT.usage;
    }
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

  if (verb === "watch" && watchId !== undefined) {
    // The task is read once before the stream opens, for a reason that is about hanging rather than about convenience: a
    // task that already reached a terminal state will never publish another event, so opening a stream for it would block
    // until the user interrupts. Answering "already cancelled" is both faster and the truth.
    let task: TaskRecord;
    try {
      task = (await connection.client.getTask(watchId)).body as TaskRecord;
    } catch (error) {
      return reportFailure(renderer, error);
    }
    if (isTerminal(task.state)) {
      const absorbing =
        `${watchId} is ${task.state}, which is terminal and absorbing (AGENT_RUNTIME.md §4.1), so no further event will ` +
        "arrive — `crabby task show` prints what it left behind";
      renderer.line("state", task.state);
      renderer.fix(absorbing);
      if (renderer.json) {
        // One line, because §7.1 promises this verb NDJSON and `done()` renders its document with two-space indentation:
        // a pretty-printed answer would arrive as dozens of lines that no script parsing one-document-per-line can read.
        // The same refusal is therefore a paragraph for a human and a single JSON object for a machine, with `streamed:
        // false` and `events: 0` saying plainly that no stream was ever opened rather than leaving a reader to infer it
        // from an absence.
        renderer.raw(
          JSON.stringify({ ok: true, ...task, events: 0, streamed: false, fixes: [absorbing] }),
        );
        return EXIT.success;
      }
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
      const requested =
        watchTypes === undefined ? undefined : [...watchTypes, ...TERMINAL_EVENT_TYPES];
      response = await fetch(
        `${connection.url}/api/v1/events?taskId=${encodeURIComponent(watchId)}` +
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
      watchTypes === undefined
        ? `${watchId} · ${task.state} · waiting for events`
        : `${watchId} · ${task.state} · ${watchTypes.join(",")} · waiting for events`,
    );
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let lastEventId: string | undefined;
    let seen = 0;
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
          const gapLine = JSON.stringify({ gap: true, stateAt: parsed.stateAt, taskId: watchId });
          if (renderer.json) renderer.raw(gapLine);
          else {
            renderer.line(
              "gap",
              "the stream's window no longer holds the cursor; reconcile from the task's state",
            );
            renderer.fix(`crabby task show ${watchId}`);
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
          watchTypes === undefined ||
          watchTypes.some((filter) => event.type === filter || event.type.startsWith(`${filter}.`));
        if (wanted) {
          seen += 1;
          if (renderer.json) renderer.raw(JSON.stringify(event));
          else renderer.line(String(event.seq).padStart(4), `${event.type}  ${event.ts}`);
        }

        // Two ways to recognise the end, because a terminal state arrives either as the state change itself or as the
        // event named for it, and watching past either one would leave the user staring at a prompt that will never
        // print. `interrupted` is deliberately not one of them: it is not terminal (§4.1), and a run may resume.
        const state = typeof event.payload?.state === "string" ? event.payload.state : undefined;
        if (
          (state !== undefined && isTerminal(state as TaskRecord["state"])) ||
          event.type === "task.completed" ||
          event.type === "task.failed" ||
          event.type === "task.cancelled"
        ) {
          finalState = (state ?? finalState) as TaskRecord["state"];
          await reader.cancel();
          break outer;
        }
      }
    }

    // The last id is printed rather than acted on. §5.1 gives a reconnecting client `Last-Event-ID` and the Gateway
    // honours it, but a command that reconnected silently would hide the outage that made it reconnect — so the cursor is
    // handed to whoever is driving, and the exit code says the stream is over.
    if (lastEventId !== undefined && !renderer.json)
      renderer.fix(
        `last event id ${lastEventId} — reconnect with Last-Event-ID to resume without a gap`,
      );
    if (renderer.json) {
      // NDJSON is the contract §7.1 names for this verb, and a trailing summary document would be a line a script
      // parsing one-event-per-line did not ask for. The document form is what a snapshot command returns, not a stream.
      return ended === undefined ? EXIT.success : EXIT.failure;
    }
    return renderer.done({
      task: watchId,
      state: finalState,
      events: seen,
      streamed: true,
      ...(lastEventId === undefined ? {} : { lastEventId }),
      ...(ended === undefined ? {} : { ended }),
    });
  }

  renderer.line("task", "which verb? `ls`, `show`, `cancel` or `watch`");
  return EXIT.usage;
}
