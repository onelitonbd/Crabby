// D-103, asserted field by field: what the grammar accepts, what it refuses and why, which clock it is read against, and
// the four edges a phone actually hits — a minute the zone skips, both day fields restricted, a `7` in the day-of-week
// column, and an expression with no occurrence left. A timer is standing authority, so every one of these is a sentence
// about what a user approved rather than a test of a parser's tolerance: an expression that comes to mean something the
// user did not write is a grant nobody gave.
//
// The zone is pinned rather than inherited. `process.env.TZ` is set before any `Date` is read, because a test that
// asserted "02:30 does not exist on 8 March 2026" against whatever zone the runner happened to have would pass in UTC and
// fail in New York — and both results would be about the machine rather than about the rule.
process.env.TZ = "America/New_York";

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  instantOfWallMinute,
  localStamp,
  MAX_SEARCH_DAYS,
  matches,
  nextFire,
  occurrencesBetween,
  parseCron,
  scheduleInWords,
  utcOffsetMinutesOf,
  wallMinuteExists,
  wallMinuteOf,
} from "./cron.ts";

/** The parse, unwrapped: a test that had to check `ok` before every field would spend its assertions on the wrong thing,
 *  and the refusals have their own block below. */
function schedule(expression: string) {
  const parsed = parseCron(expression);
  assert.ok(parsed.ok, `'${expression}' must parse: ${parsed.ok ? "" : parsed.reason}`);
  return parsed.schedule;
}

/** A wall minute in the pinned zone, as an instant. */
function instant(year: number, month: number, day: number, hour: number, minute: number): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

test("the grammar is five fields and the values each field admits", () => {
  // The five documented field shapes, each asserted by what it expands to rather than by "it parsed": a parser that
  // accepted `*/15` and read it as `15` would pass a smoke test and fire four times an hour late.
  const every = schedule("* * * * *");
  assert.equal(every.minutes.length, 60, "a bare star in the minute field is all sixty minutes");
  assert.equal(every.hours.length, 24);
  assert.deepEqual(
    [...every.daysOfMonth],
    Array.from({ length: 31 }, (_, i) => i + 1),
  );
  assert.equal(
    every.dayOfMonthRestricted,
    false,
    "a bare star is unrestricted, which is what makes the day rule below AND",
  );
  assert.equal(every.dayOfWeekRestricted, false);

  const morning = schedule("0 7 * * *");
  assert.deepEqual([...morning.minutes], [0]);
  assert.deepEqual([...morning.hours], [7]);
  assert.equal(
    morning.expression,
    "0 7 * * *",
    "recorded verbatim: §4.5 authorises the job as described at creation, and a normalised expression is a description nobody wrote",
  );

  const lists = schedule("0,30 9-17 * * mon-fri");
  assert.deepEqual([...lists.minutes], [0, 30]);
  assert.deepEqual([...lists.hours], [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepEqual(
    [...lists.daysOfWeek],
    [1, 2, 3, 4, 5],
    "mon-fri is Monday to Friday with Sunday as 0",
  );
  assert.equal(lists.dayOfWeekRestricted, true);

  const stepped = schedule("*/15 */6 * * *");
  assert.deepEqual([...stepped.minutes], [0, 15, 30, 45]);
  assert.deepEqual([...stepped.hours], [0, 6, 12, 18]);

  const ranged = schedule("0-30/10 * * * *");
  assert.deepEqual(
    [...ranged.minutes],
    [0, 10, 20, 30],
    "a step inside a range walks the range, not the field",
  );

  const named = schedule("0 0 1 jan-jun *");
  assert.deepEqual(
    [...named.months],
    [1, 2, 3, 4, 5, 6],
    "month names are the numbers a user writes them for",
  );
  assert.equal(named.dayOfMonthRestricted, true);

  const zeroSunday = schedule("0 0 * * 0");
  assert.deepEqual(
    [...zeroSunday.daysOfWeek],
    [0],
    "0 is Sunday, and it is the only spelling this parser accepts for it",
  );
});

test("what the parser refuses, and the reason is the sentence a user reads", () => {
  const refused: [string, string][] = [
    ["* * * * * *", "seconds"],
    ["* * * *", "five"],
    ["", "five"],
    ["@daily", "@"],
    ["@reboot", "@"],
    ["0 0 ? * mon", "?"],
    ["0 0 L * *", "L"],
    ["0 0 15W * *", "W"],
    ["0 0 * * mon#2", "#"],
    ["5/10 * * * *", "step"],
    ["30-10 * * * *", "ends before it starts"],
    ["60 * * * *", "0-59"],
    ["* 24 * * *", "0-23"],
    ["* * 32 * *", "1-31"],
    ["* * * 13 *", "1-12"],
    ["* * * * 8", "0-6"],
    ["foo * * * *", "minute"],
    ["* * * foo *", "month"],
  ];
  for (const [expression, expected] of refused) {
    const parsed = parseCron(expression);
    assert.equal(parsed.ok, false, `'${expression}' must be refused rather than guessed at`);
    if (!parsed.ok)
      assert.ok(
        parsed.reason.toLowerCase().includes(expected.toLowerCase()),
        `'${expression}' was refused, but the reason does not name '${expected}': ${parsed.reason}`,
      );
  }
});

test("a `7` in the day-of-week field is refused rather than read as Sunday (D-103)", () => {
  const parsed = parseCron("0 7 * * 7");
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  // The reason has to say what to write instead, because `7` means Sunday in Vixie cron and a user who learned it there
  // is not making a typo — they are being refused by a decision, and a decision that does not explain itself reads as a
  // bug.
  assert.match(parsed.reason, /7/, "the refusal names the value it refused");
  assert.match(parsed.reason, /0/, "and names the spelling this parser accepts for Sunday");
  assert.match(
    parsed.reason,
    /Monday|counting/i,
    "and says why: a second spelling for one day is more likely a user counting from Monday than a synonym",
  );
});

test("both day fields restricted means OR, as in Vixie cron; one of them a bare star means AND", () => {
  // `0 7 1 * mon` is the case the two dialects disagree about, and the disagreement is weeks wide: Vixie fires on the
  // first of the month *or* on any Monday, Quartz only on a first-of-the-month that is also a Monday.
  const or = schedule("0 7 1 * mon");
  assert.equal(or.dayOfMonthRestricted, true);
  assert.equal(or.dayOfWeekRestricted, true);
  // 2026-10-12 is a Monday and not the first; 2026-11-01 is the first and a Sunday. OR fires on both.
  const monday = wallMinuteOf(instant(2026, 10, 12, 7, 0));
  const first = wallMinuteOf(instant(2026, 11, 1, 7, 0));
  const neither = wallMinuteOf(instant(2026, 10, 13, 7, 0));
  assert.equal(monday.weekday, 1, "the fixture has to be the day it claims to be");
  assert.equal(first.day, 1);
  assert.ok(matches(or, monday), "a Monday fires even though it is not the first of the month");
  assert.ok(matches(or, first), "the first of the month fires even though it is not a Monday");
  assert.ok(
    !matches(or, neither),
    "a Tuesday that is not the first fires under neither half of the OR",
  );

  // `*/2` is a restriction and not a star: it names a subset of days, so a schedule that says "every second day" must
  // not be widened into "every second day that is also every day of the week" by treating the step as unrestricted.
  const stepped = schedule("0 7 */2 * *");
  assert.equal(
    stepped.dayOfMonthRestricted,
    true,
    "`*/2` restricts the day-of-month field even though it came from a star",
  );
  assert.equal(
    stepped.dayOfWeekRestricted,
    false,
    "a bare star in the other field leaves the rule AND",
  );
  assert.ok(matches(stepped, wallMinuteOf(instant(2026, 10, 13, 7, 0))), "day 13 is in 1-31/2");
  assert.ok(!matches(stepped, wallMinuteOf(instant(2026, 10, 14, 7, 0))), "day 14 is not");
});

test("a local minute the zone skips is not an occurrence, and is never moved (D-103)", () => {
  // America/New_York springs forward at 02:00 on 2026-03-08, so 02:30 does not exist that day.
  const skipped = { year: 2026, month: 3, day: 8, hour: 2, minute: 30, weekday: 0 };
  assert.equal(
    wallMinuteExists(skipped),
    false,
    "02:30 on the night the clock jumps forward is not a minute",
  );
  const readBack = wallMinuteOf(instantOfWallMinute(skipped));
  assert.equal(
    readBack.hour,
    3,
    "the platform moves it to 03:30, which is exactly why the scheduler may not use it",
  );

  const daily = schedule("30 2 * * *");
  const before = instant(2026, 3, 7, 12, 0);
  const next = nextFire(daily, before);
  assert.ok(next.ok, next.ok ? "" : next.reason);
  if (!next.ok) return;
  // Not 2026-03-08T03:30 (a time the expression does not name), not 01:30 (early), and not twice: the search steps to
  // the next day on which the minute exists.
  assert.equal(
    localStamp(next.at),
    "2026-03-09T02:30-04:00",
    "the skipped day produces no fire at all",
  );
  assert.equal(
    occurrencesBetween(daily, before, next.at).count,
    1,
    "and the count agrees: one occurrence between the two, not two",
  );

  // The autumn ambiguity is the mirror case and gets the mirror answer: 01:30 on 2026-11-01 happens twice, and the
  // minute *exists*, so the job fires — once, at the instant the platform's own zone rules pick. What is asserted is the
  // wall clock the record will show, because that is what a user compares their approval against.
  const ambiguous = { year: 2026, month: 11, day: 1, hour: 1, minute: 30, weekday: 0 };
  assert.equal(wallMinuteExists(ambiguous), true);
  const autumn = nextFire(schedule("30 1 * * *"), instant(2026, 11, 1, 0, 0));
  assert.ok(autumn.ok);
  if (autumn.ok)
    assert.equal(
      localStamp(autumn.at).slice(0, 16),
      "2026-11-01T01:30",
      "the stamp reads the minute the user wrote",
    );
});

test("the forward search is bounded, and the bound is an answer rather than a hang (D-103)", () => {
  // 30 February matches nothing in any calendar. An unbounded search would walk to the end of the epoch on a phone to
  // discover that; the bound turns it into a refusal at creation.
  const impossible = schedule("0 0 30 2 *");
  const none = nextFire(impossible, instant(2026, 1, 1, 0, 0));
  assert.equal(none.ok, false, "an expression with no occurrence cannot be projected");
  if (!none.ok)
    assert.match(
      none.reason,
      new RegExp(String(MAX_SEARCH_DAYS)),
      "the refusal names the bound it stopped at, so a user learns the search was finite rather than that it failed",
    );

  // The bound is generous enough for the rarest expression anybody actually writes: a leap-day schedule recurs inside
  // four years, so it projects rather than refusing.
  const leap = schedule("0 0 29 2 *");
  const found = nextFire(leap, instant(2026, 3, 1, 0, 0));
  assert.ok(found.ok, found.ok ? "" : found.reason);
  if (found.ok)
    assert.equal(
      localStamp(found.at).slice(0, 10),
      "2028-02-29",
      "2028 is the next leap year after 2026",
    );

  // A caller may ask for a shorter bound, which is what keeps a creation-time check cheap; the refusal is the same shape.
  const short = nextFire(schedule("0 0 1 1 *"), instant(2026, 2, 1, 0, 0), 30);
  assert.equal(short.ok, false, "a 30-day bound cannot reach next 1 January");
});

test("the next fire is strictly after the instant asked about", () => {
  const everyMinute = schedule("* * * * *");
  const at = instant(2026, 10, 12, 14, 30);
  const next = nextFire(everyMinute, at);
  assert.ok(next.ok);
  if (!next.ok) return;
  // A tick standing on 14:30 that fired the 14:30 occurrence would fire it again on the next tick inside the same
  // minute, which is how a job runs twice for one entry in a user's schedule.
  assert.equal(localStamp(next.at).slice(11, 16), "14:31");
  const oneBefore = nextFire(everyMinute, next.at - 1);
  assert.ok(oneBefore.ok);
  if (oneBefore.ok)
    assert.equal(
      oneBefore.at,
      next.at,
      "one millisecond earlier and the same minute is still the one due",
    );
});

test("the recorded offset is the one a person writes, and the stamp carries it", () => {
  // `Date.prototype.getTimezoneOffset` is minutes *west* of UTC, so a field named `utcOffsetMinutes` that carried it
  // would be read backwards by every interface that renders it.
  assert.equal(
    utcOffsetMinutesOf(instant(2026, 1, 15, 12, 0)),
    -300,
    "New York in January is UTC-05:00",
  );
  assert.equal(utcOffsetMinutesOf(instant(2026, 7, 15, 12, 0)), -240, "and UTC-04:00 in July");
  assert.equal(localStamp(instant(2026, 1, 15, 7, 0)), "2026-01-15T07:00-05:00");
  // Seconds are not printed, because a stamp beside a minute-resolution expression invites a reader to think they mean
  // something.
  assert.equal(localStamp(instant(2026, 1, 15, 7, 0) + 42_000), "2026-01-15T07:00-05:00");
});

test("occurrences between two instants are counted, and the cap says it was hit", () => {
  const everyMinute = schedule("* * * * *");
  const from = instant(2026, 10, 12, 0, 0);
  const to = instant(2026, 10, 12, 1, 0);
  const hour = occurrencesBetween(everyMinute, from, to);
  assert.equal(
    hour.count,
    60,
    "one per minute, and the window's own start is excluded because it already fired",
  );
  assert.equal(hour.capped, false);
  assert.equal(hour.first, from + 60_000);
  assert.equal(hour.last, to);

  const daily = schedule("0 7 * * *");
  assert.equal(occurrencesBetween(daily, from, instant(2026, 10, 15, 0, 0)).count, 3);
  assert.equal(
    occurrencesBetween(daily, from, instant(2026, 10, 12, 6, 0)).count,
    0,
    "a window that ends before the fire holds none, which is the fact the no-burst rule reports as 'nothing was missed'",
  );

  // The cap is a floor and says so: a per-minute expression left for a year is half a million occurrences, and the
  // answer §4.5 needs from that number is "more than you want to run", not a count that costs a second on a phone.
  const capped = occurrencesBetween(everyMinute, from, instant(2027, 10, 12, 0, 0), 10);
  assert.equal(capped.count, 10);
  assert.equal(
    capped.capped,
    true,
    "a capped count is reported as capped rather than passed off as a total",
  );
});

test("a schedule as words: W16-01's register, one renderer for every interface", () => {
  // The example W16-01 writes in its own row, asserted first: if this pair drifts, the Web and the TUI read the same
  // schedule differently and a phone review of a standing authority is a review of the wrong thing.
  assert.equal(scheduleInWords("30 7 * * 1-5"), "every weekday 07:30");
  assert.equal(scheduleInWords("* * * * *"), "every minute");
  assert.equal(scheduleInWords("*/5 * * * *"), "every 5 minutes");
  assert.equal(scheduleInWords("15 * * * *"), "every hour at :15");
  // `0,30` and `*/30` are the same schedule, and the words describe the schedule rather than its spelling: both are
  // "every 30 minutes", which is the reviewable claim a phone reads.
  assert.equal(scheduleInWords("0,30 * * * *"), "every 30 minutes");
  assert.equal(scheduleInWords("*/30 * * * *"), "every 30 minutes");
  assert.equal(scheduleInWords("0,20,40 * * * *"), "every 20 minutes");
  assert.equal(scheduleInWords("5,35 * * * *"), "every hour at :05 and :35");
  assert.equal(scheduleInWords("0 7 * * *"), "every day 07:00");
  assert.equal(scheduleInWords("30 7,19 * * *"), "every day 07:30, 19:30");
  assert.equal(scheduleInWords("0 7 * * 1"), "every Monday 07:00");
  assert.equal(scheduleInWords("0 9 * * 0,6"), "every weekend 09:00");
  assert.equal(scheduleInWords("0 7 * * 1,3,5"), "every Monday, Wednesday and Friday 07:00");
  assert.equal(scheduleInWords("30 7 1 * *"), "every month on the 1st 07:30");
  assert.equal(scheduleInWords("30 7 1,15 * *"), "every month on the 1st and 15th 07:30");
  assert.equal(scheduleInWords("0 0 1 1 *"), "on the 1st in Jan 00:00");
  assert.equal(scheduleInWords("0 7 * Jan *"), "every day in Jan 07:00");
  // Both day fields restricted is this parser's OR rule, so the sentence names both halves rather than one of them.
  assert.equal(scheduleInWords("0 7 1 * 1"), "every Monday and on the 1st 07:00");
  // A step that does not divide the hour is not "every N minutes"; `*/29` fires at :00, :29 and :58, and the words say
  // that instead of describing a cadence the schedule does not have.
  assert.equal(scheduleInWords("*/29 * * * *"), "every hour at :00, :29 and :58");
  // An expression this grammar cannot read has no words, and inventing some would describe a schedule nobody wrote.
  assert.equal(scheduleInWords("every weekday at seven"), "every weekday at seven");
  assert.equal(scheduleInWords(""), "");
});
