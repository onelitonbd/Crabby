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
    renderer.line("streams", `${diagnostics.streams.subscribers} connected`);
    const total = Object.values(diagnostics.tasks).reduce((a, b) => a + b, 0);
    if (total === 0) {
      renderer.line("tasks", "none yet");
      renderer.fix(
        'crabby task run "…" — planned for the runtime slice; the Gateway already accepts POST /api/v1/tasks',
      );
    } else {
      renderer.line(
        "tasks",
        TASK_STATES.filter((state) => (diagnostics.tasks[state] ?? 0) > 0)
          .map((state) => `${state} ${diagnostics.tasks[state]}`)
          .join(" · ") || "none",
      );
      renderer.line(
        "approvals",
        "no policy engine in this build — T2/T3 approvals arrive with M2, so nothing is waiting",
      );
    }
    return renderer.done({ ...diagnostics, health: info });
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
