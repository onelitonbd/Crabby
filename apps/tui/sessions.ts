// T16's session switcher: the projection of `GET /sessions` into one overlay a phone can drive mid-task.
//
// The rows are the spec (docs/review/TUI.md §3A): the state word is the reason a person switches, so it wins the space
// fight (T16-02); the current session is both the `>` and the word `current`, because a one-column marker in a
// 40-column frame is one misread away from a wrong switch (T16-03); and the id of the highlighted session gets a line
// of its own so long-press can copy what a CLI needs (T16-08). What this build deliberately does not have is a delete:
// `DELETE /sessions/{id}` is T3's one confirmed path (`crabby history delete`), and an overlay key with no
// confirmation behind it would be a second road to the same irreversible act — `d` says so instead of pretending.
import type { SessionRow } from "@crabby/api-contracts";
import { clip, visibleWidth } from "./render.ts";

/** T16-02's relative activity: words a phone reads at a glance, not timestamps it has to subtract. `now` is injected
 *  for the same reason every clock in this app is injected — a projection that reads the wall clock cannot be tested. */
export function relativeActivity(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "activity unknown";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return `${String(seconds)}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  const days = Math.round(hours / 24);
  return `${String(days)}d ago`;
}

/** T16-02's middle truncation: a title cut at the end hides the part that differs between similarly-named sessions
 *  (they are often the same objective retried), so the *middle* yields and both ends stay. Never applied to the state
 *  word — the row is built so the word is the last thing standing. */
export function middleClip(text: string, width: number): string {
  if (width < 5) return clip(text, width);
  if (text.length <= width) return text;
  const head = Math.floor((width - 1) / 2);
  const tail = width - 1 - head;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

/** One row: `>` or space, the title (middle-clipped), the relative activity, and the state word — with `current`
 *  appended for the session the composer would send into (T16-03). The state word and `current` are measured *after*
 *  the title is cut, so the title is what shrinks (T16-02's space fight, decided). */
export function sessionLine(
  row: SessionRow,
  columns: number,
  state: { readonly current: boolean; readonly selected: boolean; readonly now: number },
): string {
  const cursor = state.selected ? ">" : " ";
  const suffix = `${row.stateWord}${state.current ? " · current" : ""}`;
  const activity = relativeActivity(row.lastActivityAt, state.now);
  const fixed = ` ${activity} · ${suffix}`;
  const titleWidth = Math.max(6, columns - 1 - visibleWidth(fixed) - 2);
  return `${cursor} ${middleClip(row.titleShown, titleWidth)}${fixed}`;
}

/** T16-01's overlay: ≤10 rows on screen, then scroll around the selection. The hint line is T16-04's — the overlay's
 *  own keys, stated where the fingers are — and T16-08's id line names the highlighted session. `deleteNote` is what
 *  `d` answered when the overlay was drawn with one: this build's answer is the T3 gap, in words. */
export function switcherLines(
  rows: readonly SessionRow[],
  currentId: string | undefined,
  selected: number,
  columns: number,
  options: {
    readonly now: number;
    readonly deleteNote?: string | undefined;
    readonly renameFor?: string | undefined;
    readonly renameBuffer?: string | undefined;
  },
): readonly string[] {
  const lines: string[] = ["sessions — Enter switch · n new · t title · d delete · Esc back"];
  const first = Math.max(0, Math.min(selected - 5, rows.length - 10));
  const shown = rows.slice(first, first + 10);
  for (let index = 0; index < shown.length; index += 1) {
    const row = shown[index] as SessionRow;
    lines.push(
      sessionLine(row, columns, {
        current: row.id === currentId,
        selected: first + index === selected,
        now: options.now,
      }),
    );
    // T16-08: the id belongs to the highlighted row, on its own line, where long-press lands on it whole.
    if (first + index === selected) lines.push(`  ${row.id}`);
  }
  if (rows.length === 0) lines.push("no conversations yet — press n to start one");
  if (options.renameFor !== undefined) {
    lines.push(
      `title for ${options.renameFor}: ${options.renameBuffer ?? ""}▏ (Enter saves · Esc cancels)`,
    );
  }
  if (options.deleteNote !== undefined) lines.push(`! ${options.deleteNote}`);
  return lines;
}

/** T16-07's word, printed when the overlay switches away from a conversation with work in motion: the task keeps
 *  running and its events stop rendering here, and coming back re-reads the Gateway rather than replaying a buffer —
 *  the frame says so, because a person watching a task vanish from view deserves to know it did not vanish from the
 *  world. */
export function switchNote(row: SessionRow | undefined): string | undefined {
  if (row === undefined) return undefined;
  if (row.stateWord === "idle") return undefined;
  return `now in ${row.titleShown} — its ${row.stateWord === "running" ? "running task keeps running; this screen stops drawing its events until you come back" : "waiting prompt is still waiting; the approvals pane and the bell still reach you"}`;
}
