// When lens and frame usage is released to Klear Operations.
//
// Usage is recorded per piece, per job, in `lab_usage`, and stays in the lab
// system. Operations is told totals per release window. A window ends:
//
//   1. on a fixed weekday (a setting, Sunday by default), and
//   2. on the last day of every month, so a month's cost is complete at
//      its close.
//
// No window is shorter than four days: a weekly end that falls within three
// days before OR after a month end is skipped. (The design states the
// "before" half; the "after" half follows from its own "no window is shorter
// than four days", since a month end on a Thursday would otherwise be
// followed by a three-day window ending that Sunday.) For the same reason a
// weekly end never closes a window that is under four days old, which is
// what would otherwise happen to the very first window and after the
// weekday setting is changed. The one exception is a month end: it always
// closes, so the first window, or one after a change of setting, can be
// short if a month ends right then.
//
// The cadence is a setting, not architecture. What is fixed is the shape of
// what crosses: totals per SKU and reason, with no job, order, day or time.
//
// All dates here are Bangkok calendar dates as "YYYY-MM-DD". They are handled
// as UTC midnights purely for arithmetic; no time zone conversion happens in
// this file.

const DAY_MS = 24 * 3600 * 1000;

function toMs(date: string): number {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    Number.isNaN(ms) ||
    new Date(ms).toISOString().slice(0, 10) !== date
  ) {
    throw new Error(`not a calendar date: ${date}`);
  }
  return ms;
}

function fromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return fromMs(toMs(date) + days * DAY_MS);
}

function isMonthEnd(ms: number): boolean {
  return new Date(ms + DAY_MS).getUTCDate() === 1;
}

/** Is this date the last day of a release window? */
export function isWindowEnd(date: string, weekday: number): boolean {
  const ms = toMs(date);
  if (isMonthEnd(ms)) return true;
  if (new Date(ms).getUTCDay() !== weekday) return false;
  for (let d = 1; d <= 3; d++) {
    if (isMonthEnd(ms + d * DAY_MS) || isMonthEnd(ms - d * DAY_MS)) return false;
  }
  return true;
}

export type ReleaseWindow = { window_start: string; window_end: string };

/**
 * The windows that are due: every window that starts after the last one
 * released (or at `firstDay` if none has been) and whose last day is before
 * `today`. A window is released only once it has ended in Bangkok.
 *
 * @param lastEnd  the last released window's end, or null
 * @param firstDay the first day usage could have been recorded; used only
 *                 when nothing has been released yet
 * @param today    today's Bangkok date
 * @param weekday  0 (Sunday) to 6 (Saturday)
 */
export function dueWindows(
  lastEnd: string | null,
  firstDay: string,
  today: string,
  weekday: number,
): ReleaseWindow[] {
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
    throw new Error(`weekday must be 0 to 6, got ${weekday}`);
  }
  const out: ReleaseWindow[] = [];
  let start = lastEnd ? addDays(lastEnd, 1) : firstDay;
  const todayMs = toMs(today);
  for (let ms = toMs(start); ms < todayMs; ms += DAY_MS) {
    const date = fromMs(ms);
    const fourDays = ms - toMs(start) >= 3 * DAY_MS;
    if (isMonthEnd(ms) || (fourDays && isWindowEnd(date, weekday))) {
      out.push({ window_start: start, window_end: date });
      start = fromMs(ms + DAY_MS);
    }
  }
  return out;
}

/** The weekday a window ends on: LMS_RELEASE_WEEKDAY (0 to 6), Sunday if
 *  unset or not a weekday. */
export function releaseWeekday(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.LMS_RELEASE_WEEKDAY;
  if (raw === undefined || raw === "") return 0;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 0 && n <= 6) return n;
  if (!warnedWeekday) {
    warnedWeekday = true;
    console.warn(
      `[lms] LMS_RELEASE_WEEKDAY="${raw}" is not 0 to 6; release windows end on Sunday`,
    );
  }
  return 0;
}

let warnedWeekday = false;
