// `crabby task ls|show` — reads over the same HTTP surface a phone uses, never into SQLite (`ARCHITECTURE.md` §19).
// `task run` is not here: creating a task that no runtime will move is the placeholder work the owner asked me not to
// do, so the verb stays `planned` in the registry until the milestone that gives it an executor.
import { EXIT, type ExitCode, type TaskRecord } from "@crabby/api-contracts";
import type { DataLayout } from "@crabby/platform";
import { parseTail } from "../args.ts";
import { connect, reportFailure, reportNoGateway } from "../connect.ts";
import type { Renderer } from "../output.ts";
import { findCommand } from "../registry.ts";

export type TaskVerb = "ls" | "show";

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
      return renderer.done({ ...task, tail: listed });
    } catch (error) {
      return reportFailure(renderer, error);
    }
  }

  renderer.line("task", "which verb? `ls` or `show`");
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
