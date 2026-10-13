// The task journal over SQLite: the seam `packages/agent-runtime/journal.ts` owns, implemented here. `ARCHITECTURE.md`
// §19 is the reason the dependency points this way — "Infrastructure adapters implement those abstractions" — and it is
// the same arrangement `approvals.ts` has with the arbiter's `ApprovalStore` (D-084), including the part a reviewer may
// want to argue with: the runtime imports no database, so the adapter imports the abstraction it serves.
//
// Three properties this file is responsible for, all of them already decided elsewhere and none of them re-decided here:
//
//   - **`seq` is assigned by `appendEvent`, not by the caller.** Two writers of one counter is how a counter starts
//     lying, which is why the event arrives with `seq: 0` and leaves with the number the store gave it (D-079's "starts
//     at 1").
//   - **Redaction happens on the way in.** This adapter does not redact: `appendEvent` does, on write, because a payload
//     that reached the database has already escaped the boundary that was supposed to stop it (`SECURITY.md` §7).
//   - **`transact` is better-sqlite3's.** No wrapper cleverness, and no `await` inside it — which is why the runtime's
//     write phases are synchronous and its effects happen between them.
//
// What this makes possible that nothing else in the build does: a run whose journal is the real database, so a task's
// state, its events and §6.2's cancellation evidence are one durable record and can be read back after the file is
// closed and reopened (`SECURITY.md` §17's restart property, applied to a run rather than to a queue).
import { RuntimeError, type TaskJournal } from "@crabby/agent-runtime";
import { type Event, newId, SCHEMA_VERSION, TASK_STATES } from "@crabby/api-contracts";
import type { DataLayout } from "@crabby/platform";
import { type SqliteDb, transact } from "./db.ts";
import { appendEvent } from "./events.ts";
import { taskScratch } from "./scratch.ts";
import { getTask, setState, tasksInStates } from "./tasks.ts";

export function createSqliteJournal(deps: {
  readonly db: SqliteDb;
  readonly layout: DataLayout;
}): TaskJournal {
  const { db, layout } = deps;
  return {
    task: (taskId) => getTask(db, taskId),
    tasks: (states) =>
      states === undefined ? tasksInStates(db, TASK_STATES) : tasksInStates(db, states),
    setState: (taskId, state, record) => {
      setState(db, taskId, state, {
        ...(record?.error === undefined ? {} : { error: record.error }),
        ...(record?.cancellation === undefined ? {} : { cancellation: record.cancellation }),
      });
    },
    append: ({ taskId, type, payload, at, correlationId }) => {
      const task = getTask(db, taskId);
      if (task === undefined) {
        // The foreign key would refuse this insert anyway; naming the task first is the difference between a message a
        // reviewer can act on and `FOREIGN KEY constraint failed`.
        throw new RuntimeError({
          code: "runtime.task_missing",
          message: `task ${taskId} is not in the database, so an event of type \`${type}\` has nothing to belong to`,
        });
      }
      const event: Event = {
        id: newId("evt"),
        schemaVersion: SCHEMA_VERSION,
        type,
        ts: new Date(at).toISOString(),
        sessionId: task.sessionId,
        taskId,
        // Replaced by the number the store assigns, which is the only writer of that counter.
        seq: 0,
        ...(correlationId === undefined ? {} : { correlationId }),
        payload,
      };
      const appended = appendEvent(db, { event, scratchDir: taskScratch(layout, taskId) });
      return { ...event, seq: appended.seq };
    },
    transact: (body) => transact(db, body),
  };
}
