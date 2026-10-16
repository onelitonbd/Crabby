// Words the screens draw, in one place: relative time (W15-01's "last activity"), elapsed (T6-02's card), and the
// schedule written **both ways** (W16-01 — "every weekday 07:30" and `30 7 * * 1-5`, because a cron string is not
// reviewable on a phone). The cron reader covers the five-field subset the scheduler itself accepts; a pattern it
// cannot say in words is shown raw with a note, never paraphrased wrongly.

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** `2026-10-16T09:00:00Z` → "3m ago" style words, from an injected `now` (a projection that reads the wall clock is a
 *  projection the tests cannot hold). */
export function relativeTime(iso, now = Date.now()) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${String(days)}d ago`;
  return new Date(then).toISOString().slice(0, 10);
}

/** Seconds → `1h 24m`, `3m 12s`, `42s`. */
export function elapsed(seconds) {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${String(total)}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${String(minutes)}m ${String(total % 60)}s`;
  const hours = Math.floor(minutes / 60);
  return `${String(hours)}h ${String(minutes % 60)}m`;
}

/** The five-field cron subset in words: minute hour day-of-month month day-of-week. `*` becomes "every"; a list and a
 *  range stay explicit; `dow` names days. Anything else comes back `undefined` and the caller shows the raw string —
 *  a wrong paraphrase is worse than a cron expression a power user can read. */
export function cronWords(expr) {
  const fields = String(expr).trim().split(/\s+/);
  if (fields.length !== 5) return undefined;
  const [minute, hour, dom, month, dow] = fields;
  const step = (f, unit) => {
    const m = /^\*\/(\d+)$/.exec(f);
    return m === null ? undefined : `every ${String(Number(m[1]))} ${unit}s`;
  };
  const time = (() => {
    if (minute === "*" && hour === "*") return undefined;
    if (/^\d+$/.test(minute) && /^\d+$/.test(hour)) {
      const hh = String(Number(hour)).padStart(2, "0");
      const mm = String(Number(minute)).padStart(2, "0");
      return `at ${hh}:${mm}`;
    }
    return step(minute, "minute") ?? step(hour, "hour");
  })();
  if (time === undefined) return undefined;
  const dayPart = (() => {
    if (dom === "*" && dow === "*") return "every day";
    if (dow !== "*") {
      const names = dow.split(",").flatMap((token) => {
        const range = /^(\d)-(\d)$/.exec(token);
        if (range !== null) {
          const from = Number(range[1]);
          const to = Number(range[2]);
          const days = [];
          for (let d = from; d <= to; d += 1) days.push(DAYS[d % 7] ?? `day ${String(d)}`);
          return days;
        }
        if (/^\d$/.test(token)) return [DAYS[Number(token) % 7] ?? `day ${token}`];
        return [undefined];
      });
      if (names.every((n) => n !== undefined)) return names.join(", ");
      return undefined;
    }
    if (dom !== "*") return `day ${dom} of the month`;
    return undefined;
  })();
  if (dayPart === undefined) return undefined;
  if (month !== "*") return undefined;
  return `${dayPart} ${time}`;
}
