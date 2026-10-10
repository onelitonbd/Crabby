// The per-task scratch directory, because D-064's overflow rule is where an event's too-large payload goes: "64 KiB
// inline, larger to scratch with the path printed; scratch pruned at startup past 24 h, logged" (O-035, closed).
//
// The directory's *name* is this implementation's (`crabby.sqlite3` and `scratch/` are recorded in
// `docs/DATA_AND_MEMORY.md` §4 by the same change that added them, so the state directory is not a list only code
// knows). Location: inside the state dir, which is the one place §5's isolation rule guarantees is Crabby's own.
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import type { DataLayout } from "@crabby/platform";

export const SCRATCH_DIR_NAME = "scratch";
export const SCRATCH_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function scratchRoot(layout: DataLayout): string {
  return path.join(layout.stateDir, SCRATCH_DIR_NAME);
}

export function taskScratch(layout: DataLayout, taskId: string): string {
  const dir = path.join(scratchRoot(layout), taskId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export interface PruneReport {
  readonly removed: string[];
  readonly bytes: number;
}

/** Startup pruning, as D-064 specifies it, and it reports what it removed because "logged" is in the sentence: a
 *  directory that deletes user-visible evidence silently is the thing this project keeps deciding against. */
export function pruneScratch(
  root: string,
  options: { maxAgeMs?: number; now?: number } = {},
): PruneReport {
  const maxAgeMs = options.maxAgeMs ?? SCRATCH_MAX_AGE_MS;
  const now = options.now ?? Date.now();
  const removed: string[] = [];
  let bytes = 0;
  if (!existsSync(root)) return { removed, bytes };
  for (const entry of readdirSync(root)) {
    const full = path.join(root, entry);
    let age = 0;
    let size = 0;
    try {
      const stats = statSync(full);
      age = now - stats.mtimeMs;
      size = stats.size;
    } catch {
      continue;
    }
    if (age <= maxAgeMs) continue;
    const isDir = statSync(full).isDirectory();
    if (!isDir) {
      try {
        size = readSize(full);
      } catch {
        /* the entry is already gone; that is the outcome we wanted */
      }
    }
    rmSync(full, { recursive: true, force: true });
    removed.push(entry);
    bytes += size;
  }
  return { removed, bytes };
}

function readSize(file: string): number {
  return statSync(file).size;
}
