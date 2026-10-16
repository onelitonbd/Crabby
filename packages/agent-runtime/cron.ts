// The five-field cron expression: parsed, matched and projected forward here, in the framework-free zone
// `docs/DEVELOPMENT.md` §4 names, because `PROVIDERS_AND_TOOLS.md` §4.5's rules are all statements about *when* —
// "jobs are evaluated against their recorded schedule", "must not fire a burst of backlogged runs on resume" — and a
// schedule nobody in this repository can evaluate is a rule nobody can enforce. It is also the only way the refusal can
// be honest: a parser that accepts an expression it cannot project would create a job that never fires and never says
// so, which is the F-28 shape (refuse to approximate a thing you cannot do) applied to a timer.
//
// What is decided here, and recorded as D-103 because no document decided it:
//
//   - **The grammar is five fields and nothing else.** `minute hour day-of-month month day-of-week`, each a comma list
//     of `*`, `*/n`, `a`, `a-b` or `a-b/n`, with three-letter or full names for months and days of the week. A seconds
//     field, an `@daily` word, a `?`, an `L`, a `W`, a `#` and a bare `a/n` are all refused with the grammar named in
//     the refusal, rather than accepted by a parser that quietly means something else by them.
//   - **A schedule is evaluated against the device's own wall clock.** "Every morning at seven" is what a person means
//     when they write `0 7 * * *` on a phone, and evaluating it in UTC would fire it at one in the afternoon in Dhaka.
//     The cost is a wall clock that can move, so the offset the expression was written against is recorded on the job
//     (`JobRecord.utcOffsetMinutes`) and rendered beside the next fire, which turns a silent shift into a comparison a
//     user can make.
//   - **A local minute that does not exist is skipped, never moved.** A wall clock that jumps forward (the change most
//     zones make twice a year) has minutes in it that no instant corresponds to; `0 30 2 * * *` on such a day has no
//     occurrence, and inventing one at 03:30 would be firing work at a time the user did not write. The check is a
//     re-projection: an instant built from a wall minute must read back as the same wall minute.
//   - **When day-of-month and day-of-week are both restricted, either one matching is enough.** That is the behaviour
//     every cron a user has met has (Vixie's rule), and the alternative — requiring both — would make `0 0 13 * 5` fire
//     only on a Friday the thirteenth, which is a reading nobody writing that expression intended. Both fields being
//     `*` is not "restricted", and neither is `*/2`: the rule keys on the bare star, as the implementations do.
//   - **A search for the next occurrence is bounded, and the bound is a refusal rather than a hang.** `0 0 30 2 *` names
//     a day that does not exist, and the honest answer at creation time is "this will never fire" — not a job row with a
//     `nextRunAt` of `undefined` that a user reads as "soon".
//
// Nothing here reads a clock of its own: every function takes the instant it is asked about, so a test can pin a
// projection without waiting for one and `packages/agent-runtime/scheduler.ts` can be handed an injected `now`.

/** One minute of wall-clock time, as the device renders it. Six fields because a cron expression names five of them and
 *  the sixth — the year — is what makes "the next occurrence" an instant rather than a recurring shape. */
export interface WallMinute {
  readonly year: number;
  /** 1-12, the way the expression writes it, rather than the 0-based month a `Date` returns. */
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  /** 0-6 with 0 as Sunday, which is the expression's own numbering and `Date.prototype.getDay`'s. */
  readonly weekday: number;
}

export function wallMinuteOf(instantMs: number): WallMinute {
  const date = new Date(instantMs);
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: date.getHours(),
    minute: date.getMinutes(),
    weekday: date.getDay(),
  };
}

/** The inverse of `wallMinuteOf`, and deliberately built from local components rather than from an arithmetic offset: a
 *  wall clock that jumped means the offset at the start of the day is not the offset at the minute being constructed,
 *  and only the platform's own zone rules know which one applies. */
export function instantOfWallMinute(wall: WallMinute): number {
  return new Date(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, 0, 0).getTime();
}

/** Does this instant, read back as a wall minute, still say what it was built from? A minute inside a forward jump does
 *  not — `new Date(2026, 2, 29, 2, 30)` is 03:30 where the zone skips 02:00–02:59 — and the scheduler treats that as no
 *  occurrence rather than as a shifted one. */
export function wallMinuteExists(wall: WallMinute): boolean {
  const back = wallMinuteOf(instantOfWallMinute(wall));
  return (
    back.year === wall.year &&
    back.month === wall.month &&
    back.day === wall.day &&
    back.hour === wall.hour &&
    back.minute === wall.minute
  );
}

/** Minutes east of UTC at one instant, in the sign a person writes (`+360` for UTC+06:00). `Date` returns the negated
 *  number, and a field named `utcOffsetMinutes` that carried the platform's sign convention would be read backwards by
 *  every interface that renders it. */
export function utcOffsetMinutesOf(instantMs: number): number {
  const offset = -new Date(instantMs).getTimezoneOffset();
  // Zero is written as `0` and not as the `-0` the negation produces, because the number lands in a record: a signed zero
  // survives `JSON.stringify` as `0` and fails every `Object.is` and `deepEqual` on the way there, which is a difference
  // nobody can see on a wire and everybody can see in a test.
  return offset === 0 ? 0 : offset;
}

/** One instant as the zone that evaluates schedules writes it: `2026-10-13T07:00+06:00`. Rendered here rather than in
 *  each interface because this module is the party that decides what the wall clock is — a browser on another machine
 *  rendering `nextRunAt` in its own zone would print a time the timer does not fire at, and four interfaces agreeing about
 *  a timestamp is D-005's rule applied to a clock. Minutes are the resolution a cron expression has, so seconds are not
 *  printed: a `07:00:00` next to a `* * * * *` schedule invites a reader to think the seconds mean something. */
export function localStamp(instantMs: number): string {
  const wall = wallMinuteOf(instantMs);
  const offset = utcOffsetMinutesOf(instantMs);
  const sign = offset < 0 ? "-" : "+";
  const absolute = Math.abs(offset);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${wall.year}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}` +
    `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
  );
}

export interface CronSchedule {
  /** Verbatim, for the record: §4.5 authorises the job "as described at creation time" and a normalised expression is a
   *  description the user did not write. */
  readonly expression: string;
  readonly minutes: readonly number[];
  readonly hours: readonly number[];
  readonly daysOfMonth: readonly number[];
  readonly months: readonly number[];
  readonly daysOfWeek: readonly number[];
  /** The two halves of the day rule above. Kept as facts about the parse rather than inferred at match time, because
   *  "was this field a bare star" is not recoverable from the value list: `1-31` and `*` are the same set of days. */
  readonly dayOfMonthRestricted: boolean;
  readonly dayOfWeekRestricted: boolean;
}

export type CronParse =
  | { readonly ok: true; readonly schedule: CronSchedule }
  | { readonly ok: false; readonly reason: string };

/** How far forward a projection is worth searching. Four years covers every real expression — a leap-day schedule is
 *  the rarest one anybody writes and it recurs inside this — and the bound is what turns "no occurrence" into an answer
 *  instead of a loop. */
export const MAX_SEARCH_DAYS = 1500;

const GRAMMAR =
  "five fields — minute hour day-of-month month day-of-week — each a comma list of `*`, `*/n`, `a`, `a-b` or `a-b/n`";

const MONTH_NAMES: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const WEEKDAY_NAMES: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

interface FieldSpec {
  readonly name: string;
  readonly min: number;
  readonly max: number;
  readonly names?: Record<string, number>;
  /** The sentence a refusal adds when the field has its own trap. Day-of-week has one: `7` for Sunday is accepted by the
   *  crons a user has met and refused here, because silently reading it as `0` is a rule nobody wrote down and a
   *  schedule that fires on a day the user did not name is worse than a refusal they can fix in one keystroke. */
  readonly trap?: string;
}

const FIELDS: readonly FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTH_NAMES },
  {
    name: "day-of-week",
    min: 0,
    max: 6,
    names: WEEKDAY_NAMES,
    trap:
      " (0-6 with 0 as Sunday, or a name — `7` is refused rather than read as Sunday: in a field where every other " +
      "value has one spelling, a second one is likelier somebody counting from Monday than a synonym, and guessing " +
      "would fire on the wrong day every week)",
  },
];

interface FieldParse {
  readonly values: number[];
  readonly restricted: boolean;
}

function parseValue(raw: string, spec: FieldSpec): number | undefined {
  const text = raw.trim().toLowerCase();
  if (text === "") return undefined;
  if (spec.names !== undefined) {
    const named = spec.names[text];
    if (named !== undefined) return named;
  }
  if (!/^[0-9]+$/.test(text)) return undefined;
  const value = Number.parseInt(text, 10);
  return value >= spec.min && value <= spec.max ? value : undefined;
}

function parseField(
  raw: string,
  spec: FieldSpec,
): { ok: true; field: FieldParse } | { ok: false; reason: string } {
  const field = raw.trim();
  if (field === "") return { ok: false, reason: `the ${spec.name} field is empty` };
  if (field.startsWith("@"))
    return {
      ok: false,
      reason:
        `'${field}' is an @word, and this parser reads ${GRAMMAR} — write the fields the word stands for, because a ` +
        "shorthand is a second grammar whose meaning a reader has to look up",
    };
  if (/[?LW#]/.test(field))
    return {
      ok: false,
      reason:
        `the ${spec.name} field '${field}' uses a symbol this parser refuses (? L W #), and it reads ${GRAMMAR} — ` +
        "each of those means something different in each cron that accepts it",
    };
  const values = new Set<number>();
  let restricted = false;
  for (const term of field.split(",")) {
    const piece = term.trim();
    if (piece === "")
      return { ok: false, reason: `the ${spec.name} field '${field}' has an empty term` };
    const [rangePart, stepPart, ...extra] = piece.split("/");
    if (extra.length > 0)
      return {
        ok: false,
        reason: `the ${spec.name} term '${piece}' has more than one \`/\``,
      };
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^[0-9]+$/.test(stepPart) || Number.parseInt(stepPart, 10) < 1)
        return {
          ok: false,
          reason: `the ${spec.name} term '${piece}' has a step of '${stepPart}', and a step is a whole number at least 1`,
        };
      step = Number.parseInt(stepPart, 10);
    }
    const range = (rangePart ?? "").trim();
    if (range === "*") {
      // A bare star is the only form that leaves the field unrestricted, and the distinction decides the day rule above.
      // `*/2` *is* a restriction: the user named a subset, so the field counts as one of the two the rule compares.
      if (stepPart === undefined) restricted = false;
      else restricted = true;
      for (let value = spec.min; value <= spec.max; value += step) values.add(value);
      continue;
    }
    restricted = true;
    const [fromRaw, toRaw, ...rest] = range.split("-");
    if (rest.length > 0)
      return {
        ok: false,
        reason: `the ${spec.name} term '${piece}' has more than one \`-\``,
      };
    if (toRaw === undefined) {
      if (stepPart !== undefined)
        return {
          ok: false,
          reason:
            `the ${spec.name} term '${piece}' steps from a single value, which reads as "from here to the end of the ` +
            `field" in some crons and as a mistake in others — write \`${fromRaw}-${spec.max}/${step}\``,
        };
      const single = parseValue(fromRaw ?? "", spec);
      if (single === undefined) return { ok: false, reason: badValue(spec, fromRaw ?? "") };
      values.add(single);
      continue;
    }
    const from = parseValue(fromRaw ?? "", spec);
    const to = parseValue(toRaw, spec);
    if (from === undefined) return { ok: false, reason: badValue(spec, fromRaw ?? "") };
    if (to === undefined) return { ok: false, reason: badValue(spec, toRaw) };
    if (from > to)
      return {
        ok: false,
        reason:
          `the ${spec.name} range '${piece}' ends before it starts; a range that wraps is two ranges, and reading one ` +
          "as the other would fire on days the expression does not name",
      };
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return {
    ok: true,
    field: { values: [...values].sort((left, right) => left - right), restricted },
  };
}

function badValue(spec: FieldSpec, raw: string): string {
  return (
    `'${raw}' is not a ${spec.name} this parser reads: ${spec.min}-${spec.max}` +
    (spec.names === undefined ? "" : " or a name") +
    (spec.trap ?? "")
  );
}

export function parseCron(expression: string): CronParse {
  const text = expression.trim();
  if (text === "") return { ok: false, reason: `a schedule is ${GRAMMAR}, and this one is empty` };
  const fields = text.split(/\s+/);
  if (fields.length !== FIELDS.length)
    return {
      ok: false,
      reason:
        `'${text}' has ${fields.length} field${fields.length === 1 ? "" : "s"} and this parser reads ${FIELDS.length}: ` +
        `${GRAMMAR}${fields.length > FIELDS.length ? " — a leading seconds field is not part of it" : ""}`,
    };
  const parsed: FieldParse[] = [];
  for (let index = 0; index < FIELDS.length; index++) {
    const spec = FIELDS[index] as FieldSpec;
    const result = parseField(fields[index] as string, spec);
    if (!result.ok) return { ok: false, reason: result.reason };
    parsed.push(result.field);
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parsed as [
    FieldParse,
    FieldParse,
    FieldParse,
    FieldParse,
    FieldParse,
  ];
  return {
    ok: true,
    schedule: {
      expression: text,
      minutes: minute.values,
      hours: hour.values,
      daysOfMonth: dayOfMonth.values,
      months: month.values,
      daysOfWeek: dayOfWeek.values,
      dayOfMonthRestricted: dayOfMonth.restricted,
      dayOfWeekRestricted: dayOfWeek.restricted,
    },
  };
}

/** W16-01's "written both ways" and T17-02's "schedule in words": a five-field expression as the sentence a phone can
 *  review. `30 7 * * 1-5` is `every weekday 07:30` — the register W16-01's own example sets. **One renderer for four
 *  interfaces**, the reason `packages/platform`'s `clip` is one: a words form each client derived would drift until a
 *  schedule read differently in the TUI and the Web. Rendered beside the parser because the grammar is this module's own
 *  (`localStamp` is here for the same reason), and the expression is what the detail line prints — the words are the
 *  reviewable half, never the only representation (T17-02).
 *
 *  An expression this grammar cannot read is returned verbatim: there are no words to write for a string that is not a
 *  five-field schedule, and inventing a description would be describing something other than what was stored. Every
 *  schedule a job carries passed `parseCron` at creation, so that fallback is for foreign bodies, not for stored state. */
export function scheduleInWords(expression: string): string {
  const parsed = parseCron(expression);
  if (!parsed.ok) return expression;
  const schedule = parsed.schedule;
  const pad = (value: number): string => String(value).padStart(2, "0");
  const list = (words: readonly string[]): string =>
    words.length <= 1
      ? (words[0] ?? "")
      : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1] as string}`;
  const WEEKDAY_WORDS = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ] as const;
  const MONTH_WORDS = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ] as const;
  const ordinal = (day: number): string => {
    const suffix =
      day % 100 >= 11 && day % 100 <= 13
        ? "th"
        : day % 10 === 1
          ? "st"
          : day % 10 === 2
            ? "nd"
            : day % 10 === 3
              ? "rd"
              : "th";
    return `${day}${suffix}`;
  };

  const everyDayScope =
    !schedule.dayOfMonthRestricted &&
    !schedule.dayOfWeekRestricted &&
    schedule.months.length === 12;
  const everyMonthScope = !schedule.dayOfMonthRestricted && !schedule.dayOfWeekRestricted;

  // The day scope: what the schedule is "every". A restricted day-of-week narrows it to those days; a restricted
  // day-of-month narrows it to the month's days; both restricted means the occurrence matches either (this parser's
  // recorded decision — Vixie's OR rule), so the sentence says both.
  let scope: string;
  if (schedule.dayOfWeekRestricted) {
    const days = schedule.daysOfWeek.map((day) => WEEKDAY_WORDS[day] ?? String(day));
    const set = new Set(schedule.daysOfWeek);
    const isWeekday = [1, 2, 3, 4, 5].every((day) => set.has(day)) && set.size === 5;
    const isWeekend = set.has(0) && set.has(6) && set.size === 2;
    scope = isWeekday ? "every weekday" : isWeekend ? "every weekend" : `every ${list(days)}`;
    if (schedule.dayOfMonthRestricted) {
      const daysOfMonth = schedule.daysOfMonth.map(ordinal);
      scope = `${scope} and on the ${list(daysOfMonth)}`;
    }
  } else if (schedule.dayOfMonthRestricted) {
    scope = `every month on the ${list(schedule.daysOfMonth.map(ordinal))}`;
    if (schedule.months.length < 12) {
      // "every month on the 1st in Jan" contradicts itself; the months are the scope, the days are the qualifier.
      scope = `on the ${list(schedule.daysOfMonth.map(ordinal))}`;
    }
  } else {
    scope = "every day";
  }
  if (schedule.months.length < 12) {
    const months = schedule.months.map((month) => MONTH_WORDS[month - 1] ?? String(month));
    scope =
      everyMonthScope && !schedule.dayOfMonthRestricted && !schedule.dayOfWeekRestricted
        ? `every day in ${list(months)}`
        : `${scope} in ${list(months)}`;
  }

  // The time half. A cross product of hours × minutes sorted by the clock, because `30 7,19 * * *` fires at 07:30 and
  // 19:30 and that is two times, not "7,19 hours past 30".
  const times = [
    ...new Set(
      schedule.hours.flatMap((hour) =>
        schedule.minutes.map((minute) => `${pad(hour)}:${pad(minute)}`),
      ),
    ),
  ].sort();

  // Minute cadences say "every N minutes" and carry no clock time; `*/5` is not "every hour at :00, :05, …".
  if (schedule.hours.length === 24 && schedule.minutes.length === 60) {
    return everyDayScope ? "every minute" : `every minute ${scope}`;
  }
  if (schedule.hours.length === 24) {
    const step = 60 / schedule.minutes.length;
    const evenStep =
      Number.isInteger(step) && schedule.minutes.every((minute, index) => minute === index * step);
    if (evenStep) {
      return everyDayScope ? `every ${step} minutes` : `every ${step} minutes ${scope}`;
    }
    const marks = schedule.minutes.map((minute) => `:${pad(minute)}`);
    return everyDayScope ? `every hour at ${list(marks)}` : `every hour at ${list(marks)} ${scope}`;
  }
  return `${scope} ${times.join(", ")}`;
}

/** Does this wall minute satisfy the expression? The day rule is the only part with a branch, and the branch is the
 *  decision recorded above rather than an implementation detail. */
export function matches(schedule: CronSchedule, wall: WallMinute): boolean {
  if (!schedule.minutes.includes(wall.minute)) return false;
  if (!schedule.hours.includes(wall.hour)) return false;
  if (!schedule.months.includes(wall.month)) return false;
  const byMonthDay = schedule.daysOfMonth.includes(wall.day);
  const byWeekDay = schedule.daysOfWeek.includes(wall.weekday);
  if (schedule.dayOfMonthRestricted && schedule.dayOfWeekRestricted) return byMonthDay || byWeekDay;
  return byMonthDay && byWeekDay;
}

export type NextFire =
  | { readonly ok: true; readonly at: number; readonly wall: WallMinute }
  | { readonly ok: false; readonly reason: string };

/** The first occurrence strictly after `afterMs`. Days are the outer loop and minutes the inner one, which is what keeps
 *  a rare expression cheap: `0 0 29 2 *` costs four years of *day* checks and one day of minute checks, where a
 *  minute-by-minute walk would cost two million of them and would be the difference between a creation-time check and a
 *  hang on a phone. */
export function nextFire(
  schedule: CronSchedule,
  afterMs: number,
  boundDays: number = MAX_SEARCH_DAYS,
): NextFire {
  const start = new Date(afterMs);
  start.setSeconds(0, 0);
  // The next minute, because the answer is strictly after the instant asked about: a tick that fires the occurrence it
  // is standing on would fire it again on the next tick inside the same minute.
  start.setMinutes(start.getMinutes() + 1);
  for (let dayOffset = 0; dayOffset <= boundDays; dayOffset++) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + dayOffset);
    const month = day.getMonth() + 1;
    if (!schedule.months.includes(month)) continue;
    const weekday = day.getDay();
    const byMonthDay = schedule.daysOfMonth.includes(day.getDate());
    const byWeekDay = schedule.daysOfWeek.includes(weekday);
    const dayMatches =
      schedule.dayOfMonthRestricted && schedule.dayOfWeekRestricted
        ? byMonthDay || byWeekDay
        : byMonthDay && byWeekDay;
    if (!dayMatches) continue;
    for (const hour of schedule.hours) {
      for (const minute of schedule.minutes) {
        const wall: WallMinute = {
          year: day.getFullYear(),
          month,
          day: day.getDate(),
          hour,
          minute,
          weekday,
        };
        const at = instantOfWallMinute(wall);
        if (at <= afterMs) continue;
        // A minute the zone skips is not an occurrence, and moving it would be firing work at a time nobody wrote.
        if (!wallMinuteExists(wall)) continue;
        return { ok: true, at, wall };
      }
    }
  }
  return {
    ok: false,
    reason:
      `'${schedule.expression}' has no occurrence in the ${boundDays} days after ${new Date(afterMs).toISOString()} — ` +
      "a schedule that cannot fire is refused at creation rather than recorded as a job that never runs and never says so",
  };
}

export interface OccurrenceCount {
  readonly count: number;
  /** The count stopped at the cap, so `count` is a floor and not a total. A year of a per-minute expression is half a
   *  million occurrences, and the answer §4.5 needs is "more than you want to run", not an exact number nobody will
   *  read — so the cap is reported beside the count instead of being hidden inside it. */
  readonly capped: boolean;
  readonly first?: number;
  readonly last?: number;
}

/** How many occurrences fall in `(fromMs, toMs]`. This is the measurement §4.5's no-burst rule needs: a device that was
 *  off overnight comes back, asks how much of the schedule passed while it was down, and records that number instead of
 *  firing it. */
export function occurrencesBetween(
  schedule: CronSchedule,
  fromMs: number,
  toMs: number,
  cap = 1000,
): OccurrenceCount {
  if (toMs <= fromMs) return { count: 0, capped: false };
  let count = 0;
  let first: number | undefined;
  let last: number | undefined;
  const start = new Date(fromMs);
  const end = new Date(toMs);
  for (
    let day = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    day.getTime() <= toMs;
    day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)
  ) {
    if (day.getTime() > end.getTime()) break;
    const month = day.getMonth() + 1;
    if (!schedule.months.includes(month)) continue;
    const weekday = day.getDay();
    const byMonthDay = schedule.daysOfMonth.includes(day.getDate());
    const byWeekDay = schedule.daysOfWeek.includes(weekday);
    const dayMatches =
      schedule.dayOfMonthRestricted && schedule.dayOfWeekRestricted
        ? byMonthDay || byWeekDay
        : byMonthDay && byWeekDay;
    if (!dayMatches) continue;
    for (const hour of schedule.hours) {
      for (const minute of schedule.minutes) {
        const wall: WallMinute = {
          year: day.getFullYear(),
          month,
          day: day.getDate(),
          hour,
          minute,
          weekday,
        };
        const at = instantOfWallMinute(wall);
        if (at <= fromMs || at > toMs) continue;
        if (!wallMinuteExists(wall)) continue;
        count += 1;
        first = first === undefined ? at : first;
        last = at;
        if (count >= cap)
          return {
            count,
            capped: true,
            ...(first === undefined ? {} : { first }),
            ...(last === undefined ? {} : { last }),
          };
      }
    }
  }
  return {
    count,
    capped: false,
    ...(first === undefined ? {} : { first }),
    ...(last === undefined ? {} : { last }),
  };
}
