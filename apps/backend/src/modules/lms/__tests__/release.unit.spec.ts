import { addDays, dueWindows, isWindowEnd, releaseWeekday } from "../release";

const SUNDAY = 0;

describe("release windows: which days end a window", () => {
  it("ends a window on the weekday and on every month end", () => {
    // November 2026: the 1st is a Sunday, the 30th a Monday.
    expect(isWindowEnd("2026-11-08", SUNDAY)).toBe(true);
    expect(isWindowEnd("2026-11-15", SUNDAY)).toBe(true);
    expect(isWindowEnd("2026-11-09", SUNDAY)).toBe(false);
    expect(isWindowEnd("2026-11-30", SUNDAY)).toBe(true);
    expect(isWindowEnd("2026-02-28", SUNDAY)).toBe(true);
    expect(isWindowEnd("2028-02-28", SUNDAY)).toBe(false); // leap year
    expect(isWindowEnd("2028-02-29", SUNDAY)).toBe(true);
  });

  it("skips a weekly end within three days before a month end", () => {
    // Sunday 29 November, month end Monday 30: one day before.
    expect(isWindowEnd("2026-11-29", SUNDAY)).toBe(false);
    // Sunday 28 February 2027 is itself the month end.
    expect(isWindowEnd("2027-02-28", SUNDAY)).toBe(true);
    // Sunday 27 December 2026, month end Thursday 31: four days before, kept.
    expect(isWindowEnd("2026-12-27", SUNDAY)).toBe(true);
  });

  it("skips a weekly end within three days after a month end", () => {
    // Month end Thursday 31 December 2026; Sunday 3 January is three days on.
    expect(isWindowEnd("2027-01-03", SUNDAY)).toBe(false);
    // Month end Wednesday 30 September 2026; Sunday 4 October is four days on.
    expect(isWindowEnd("2026-10-04", SUNDAY)).toBe(true);
  });

  it("never makes a window shorter than four days or longer than ten, on any weekday, over five years", () => {
    for (let weekday = 0; weekday <= 6; weekday++) {
      const windows = dueWindows(null, "2026-01-01", "2031-01-01", weekday);
      // The very first window starts wherever usage started, so it may be short.
      for (const w of windows.slice(1)) {
        const days =
          (Date.parse(w.window_end) - Date.parse(w.window_start)) / (24 * 3600 * 1000) + 1;
        expect(days).toBeGreaterThanOrEqual(4);
        expect(days).toBeLessThanOrEqual(10);
      }
      // Windows tile the calendar with no gap and no overlap.
      for (let i = 1; i < windows.length; i++) {
        expect(windows[i].window_start).toBe(addDays(windows[i - 1].window_end, 1));
      }
      // Every month end closes a window.
      const ends = new Set(windows.map((w) => w.window_end));
      for (const monthEnd of ["2026-01-31", "2026-02-28", "2028-02-29", "2030-12-31"]) {
        expect(ends.has(monthEnd)).toBe(true);
      }
    }
  });
});

describe("release windows: which are due", () => {
  it("releases nothing until a window's last day has passed in Bangkok", () => {
    expect(dueWindows(null, "2026-11-02", "2026-11-08", SUNDAY)).toEqual([]);
    expect(dueWindows(null, "2026-11-02", "2026-11-09", SUNDAY)).toEqual([
      { window_start: "2026-11-02", window_end: "2026-11-08" },
    ]);
  });

  it("carries on from the last released window and catches up after a gap", () => {
    expect(dueWindows("2026-11-08", "2020-01-01", "2026-12-02", SUNDAY)).toEqual([
      { window_start: "2026-11-09", window_end: "2026-11-15" },
      { window_start: "2026-11-16", window_end: "2026-11-22" },
      // Sunday the 29th is skipped: the month ends the next day.
      { window_start: "2026-11-23", window_end: "2026-11-30" },
    ]);
    expect(dueWindows("2026-11-30", "2020-01-01", "2026-12-02", SUNDAY)).toEqual([]);
  });

  it("refuses a date that is not one and a weekday that is not one", () => {
    expect(() => dueWindows(null, "2026-02-31", "2026-03-05", SUNDAY)).toThrow(/calendar date/);
    expect(() => dueWindows(null, "2026-02-01", "2026-03-05", 7)).toThrow(/weekday/);
  });
});

describe("release windows: never a daily total", () => {
  it("does not close a first window on a weekday end that is under four days in", () => {
    // Production starts on Sunday the 8th itself: no one-day window.
    expect(dueWindows(null, "2026-11-08", "2026-11-20", SUNDAY)).toEqual([
      { window_start: "2026-11-08", window_end: "2026-11-15" },
    ]);
  });

  it("does not make a short window when the weekday setting changes", () => {
    // Released to Sunday the 8th, then the setting moves to Monday.
    expect(dueWindows("2026-11-08", "2020-01-01", "2026-11-20", 1)).toEqual([
      { window_start: "2026-11-09", window_end: "2026-11-16" },
    ]);
  });

  it("still closes at a month end, however soon it comes", () => {
    expect(dueWindows(null, "2026-11-29", "2026-12-10", SUNDAY)).toEqual([
      { window_start: "2026-11-29", window_end: "2026-11-30" },
      { window_start: "2026-12-01", window_end: "2026-12-06" },
    ]);
  });
});

describe("releaseWeekday", () => {
  it("reads LMS_RELEASE_WEEKDAY and falls back to Sunday", () => {
    expect(releaseWeekday({})).toBe(0);
    expect(releaseWeekday({ LMS_RELEASE_WEEKDAY: "5" })).toBe(5);
    expect(releaseWeekday({ LMS_RELEASE_WEEKDAY: "9" })).toBe(0);
    expect(releaseWeekday({ LMS_RELEASE_WEEKDAY: "friday" })).toBe(0);
  });
});
