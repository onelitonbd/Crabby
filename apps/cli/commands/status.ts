// `crabby status` — §7.1's Setup row: "gateway, task and approval state at a glance" in one screen. Two things keep it
// honest. It never claims a subsystem is healthy that this build does not have, and it distinguishes the three states
// a user actually needs told apart: no Gateway, a Gateway that is not paired to, and a Gateway with nothing to show.
import { type ExitCode, TASK_STATES } from "@crabby/api-contracts";
import type { DataLayout } from "@crabby/platform";
import { connect, reportFailure, reportNoGateway } from "../connect.ts";
import type { Renderer } from "../output.ts";

interface Diagnostics {
  version: string;
  generatedAt: string;
  listener: { host: string; port: number | undefined };
  storage: { schemaVersion: number; stateDir: string };
  tasks: Record<string, number>;
  /** Whether this process composed a runner and how many runs it is moving. Optional because it arrived with the
   *  handoff, and a Gateway started from an older checkout does not send it: the screen asks the process rather than
   *  asserting a property of the build, which is the discipline this file's own comments argue for. */
  runs?: { composed: boolean; inFlight: number };
  streams: { subscribers: number };
}

export async function runStatus(layout: DataLayout, renderer: Renderer): Promise<ExitCode> {
  const connection = await connect(layout);
  if (connection.state !== "paired") return reportNoGateway(renderer, connection.state);
  try {
    const health = await connection.client.health();
    const diagnostics = (await connection.client.diagnostics()).body as Diagnostics;
    const info = health.body as {
      uptimeMs: number;
      listener: { mode: string; host: string; port: number };
      vault: { managed: boolean };
    };
    renderer.line(
      "gateway",
      `http://${info.listener.host}:${info.listener.port} · ${diagnostics.version} · up ${formatUptime(info.uptimeMs)}`,
    );
    renderer.line(
      "listener mode",
      info.listener.mode === "local"
        ? "local (loopback only, §2 of SECURITY.md)"
        : info.listener.mode,
    );
    renderer.line(
      "storage",
      `schema v${diagnostics.storage.schemaVersion} · ${diagnostics.storage.stateDir}`,
    );
    renderer.line(
      "vault",
      info.vault.managed ? "managed" : "unmanaged — no secret store in this build (M2)",
    );
    const runs = diagnostics.runs;
    renderer.line(
      "runs",
      runs === undefined
        ? "not reported — this Gateway predates the handoff, so it records tasks and drives none"
        : runs.composed
          ? runs.inFlight === 0
            ? "composed · none in flight"
            : `composed · ${runs.inFlight} in flight`
          : "not composed — a task is recorded and nothing in this process drives it",
    );
    renderer.line("streams", `${diagnostics.streams.subscribers} connected`);
    const total = Object.values(diagnostics.tasks).reduce((a, b) => a + b, 0);
    if (total === 0) {
      renderer.line("tasks", "none yet");
      // The line here said `crabby task run` was "planned for the runtime slice", which is the defect the comment above
      // the approvals line was written about: a state of the build hardcoded into an output, outliving the build without
      // failing anything. What replaces it is conditional on the answer the Gateway just gave, so it cannot go stale by
      // the verb existing — only by the Gateway changing, which it reports.
      renderer.fix(
        runs?.composed === true
          ? 'crabby task run "…" creates a task and follows it to its end'
          : 'crabby task run "…" refuses up front here: `crabby gateway start` prints which half of a runner is missing',
      );
    } else {
      renderer.line(
        "tasks",
        TASK_STATES.filter((state) => (diagnostics.tasks[state] ?? 0) > 0)
          .map((state) => `${state} ${diagnostics.tasks[state]}`)
          .join(" · ") || "none",
      );
    }
    // §7.1 asks this screen for "gateway, task and approval state at a glance", so the approval line *asks*. What was
    // here before was a sentence — "no policy engine in this build, so nothing is waiting" — which was true when it was
    // written and became a lie one milestone later without failing anything, because no test reads a prose string and
    // a user does not check a screen that says "nothing is waiting". A hardcoded state of the build in an output line
    // is a claim that outlives its subject; this is the same defect F-38 was written about, one notch smaller.
    let queue: Awaited<ReturnType<typeof connection.client.approvals>>;
    try {
      queue = await connection.client.approvals({ state: "pending" });
    } catch (error) {
      // A Gateway old enough to lack the route answers 404 with §6's envelope, and the screen has to say which of the
      // two truths it is showing: nothing waiting, or nothing knowable. Collapsing them would be the same lie in a
      // different font.
      renderer.line("approvals", `the queue could not be read: ${(error as Error).message}`);
      return renderer.done({ ...diagnostics, approvals: { readable: false }, health: info });
    }
    const pending = queue.body as {
      count: number;
      items: { id: string; request: { tier: string; summary: string; tool: string } }[];
    };
    renderer.line(
      "approvals",
      pending.count === 0
        ? // The line used to end "— requests are opened by M2's runtime loop, which lands after this slice", and the loop
          // has now landed (`packages/agent-runtime/loop.ts`), so the claim went stale exactly the way F-40 describes: no
          // test reads a prose string, and a user does not check a screen that says nothing is waiting. What is left is the
          // measurement and nothing else. Which party opens a request is `AGENT_RUNTIME.md` §5.2's business, not a status
          // line's, and a sentence about the build in an output line outlives the build.
          "nothing waiting"
        : `${pending.count} waiting · ${pending.items
            .map((item) => `${item.request.tier} ${item.request.tool}`)
            .join(", ")}`,
    );
    // The same fact in both renderings: a `--json` reader that saw an `approvals` line on screen and nothing in the
    // document would be left guessing which one the command means.
    return renderer.done({
      ...diagnostics,
      approvals: { pending: pending.count, ids: pending.items.map((item) => item.id) },
      health: info,
    });
  } catch (error) {
    return reportFailure(renderer, error);
  }
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} m ${seconds % 60} s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${minutes % 60} m`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}
