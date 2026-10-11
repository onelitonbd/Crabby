// `crabby task ls|show|cancel` — reads and writes over the same HTTP surface a phone uses, never into SQLite
// (`ARCHITECTURE.md` §19). `cancel` is here because §6 has a route behind it and a stop button that only three of four
// interfaces had would be the "one behaviour, four surfaces" rule broken where it matters most.
// `task run` is not here: creating a task that no runtime will move is the placeholder work the owner asked me not to
// do, so the verb stays `planned` in the registry until the milestone that gives it an executor.
import {
  CANCELLATION_MODES,
  type CancellationMode,
  EXIT,
  type ExitCode,
  type TaskCheckpoint,
  type TaskRecord,
} from "@crabby/api-contracts";
import { GatewayFailure } from "@crabby/gateway";
import type { DataLayout } from "@crabby/platform";
import { parseTail } from "../args.ts";
import { connect, reportFailure, reportNoGateway } from "../connect.ts";
import type { Renderer } from "../output.ts";
import { findCommand } from "../registry.ts";

export type TaskVerb = "ls" | "show" | "cancel";

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

  renderer.line("task", "which verb? `ls`, `show` or `cancel`");
  return EXIT.usage;
}

/** The prefix is what a user pastes back into `task show`, and the timestamp part of a sortable id is the same for
 *  every task in one minute — so the tail, not the head, is the distinguishing half. */
function shortId(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 8)}…${id.slice(-4)}`;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
