// Graceful shutdown, in one place, because D-066's drain and DEVELOPMENT §10's "terminated without shutdown" record
// are the same problem seen from two sides: a process that leaves neatly must tell the next run it left neatly, and
// on a phone the alternative explanation (Android killed it) has to remain distinguishable.
//
// The drain is 5 s because that is the number D-066 states for in-flight requests ("shutdown drains in-flight
// requests for 5 s so a paired client sees a clean end rather than a hang"). It is not a general-purpose grace
// period, and no other phase borrows it.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { DataLayout } from "@crabby/platform";

export const DRAIN_MS = 5_000;

export type ExitKind = "clean" | "signal" | "uncaught" | "unknown";

export interface LastExitRecord {
  readonly kind: ExitKind;
  readonly at: string;
  readonly signal?: string;
}

/** The filename is this module's choice: §10 requires that the runtime *record* an unclean exit and that `doctor` be
 *  able to explain a crash from a kill, but it does not name a file. One record file in the state dir is the
 *  smallest thing that satisfies both, and it is deliberately written on the way *out* rather than kept open. */
export const LAST_EXIT_FILE = "last-exit.json";

export function lastExitPath(layout: DataLayout): string {
  return `${layout.stateDir}/${LAST_EXIT_FILE}`;
}

export function readLastExit(layout: DataLayout): LastExitRecord | "missing" | "unclean" {
  const file = lastExitPath(layout);
  if (!existsSync(file)) return "missing";
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return "unclean";
  }
  if (typeof parsed !== "object" || parsed === null) return "unclean";
  const record = parsed as Partial<LastExitRecord>;
  if (record.kind === "clean") return { kind: "clean", at: record.at ?? "" };
  // Anything that is not an explicit clean marker means the previous process did not finish this bookkeeping.
  return {
    kind: record.kind === "signal" || record.kind === "uncaught" ? record.kind : "unknown",
    at: record.at ?? "",
  };
}

export interface ShutdownHandle {
  /** Register a cleanup step. Order is registration order, and a step that throws must not strand the rest — so the
   *  failure is collected and reported, not propagated out of a signal handler. */
  onShutdown(name: string, fn: () => void | Promise<void>): void;
  /** Run the steps once. Returns the collected errors so a CLI command can exit non-zero instead of pretending. */
  run(kind: ExitKind, signal?: string): Promise<{ errors: { name: string; message: string }[] }>;
  readonly running: boolean;
}

export function createShutdown(
  layout: DataLayout,
  options: { drainMs?: number; exit?: (code: number) => void } = {},
): ShutdownHandle {
  const steps: { name: string; fn: () => void | Promise<void> }[] = [];
  let running = false;
  const drainMs = options.drainMs ?? DRAIN_MS;

  async function run(kind: ExitKind, signal?: string) {
    if (running) return { errors: [] };
    running = true;
    const errors: { name: string; message: string }[] = [];
    for (const step of steps) {
      try {
        await withDeadline(step.fn(), drainMs, step.name);
      } catch (error) {
        errors.push({
          name: step.name,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // Written last: the record is only trustworthy once every step has had its chance.
    writeLastExit(layout, { kind, at: new Date().toISOString(), ...(signal ? { signal } : {}) });
    return { errors };
  }

  return {
    onShutdown(name, fn) {
      steps.push({ name, fn });
    },
    run,
    get running() {
      return running;
    },
  };
}

async function withDeadline(work: void | Promise<void>, ms: number, name: string): Promise<void> {
  if (ms <= 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve(work),
      new Promise<void>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} did not finish within ${ms} ms`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function writeLastExit(layout: DataLayout, record: LastExitRecord): void {
  try {
    writeFileSync(lastExitPath(layout), `${JSON.stringify(record, null, 2)}\n`);
  } catch {
    // A shutdown path that throws while reporting a shutdown turns one problem into two. §10's record is a
    // diagnostic, and a diagnostic that blocks the exit is not one.
  }
}
