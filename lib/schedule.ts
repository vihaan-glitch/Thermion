/** Bell schedule (assumption, see README): 8 periods of 45 min, 5-min passing, first bell 7:30. */
import { DAY_MS, localParts, zonedToUtc } from "./time";

export const FIRST_BELL_MIN = 7 * 60 + 30;
export const PERIOD_MIN = 45;
export const PASSING_MIN = 5;
export const PERIOD_COUNT = 8;

export function periodLocalMinutes(period: number): { start: number; end: number } {
  const start = FIRST_BELL_MIN + (period - 1) * (PERIOD_MIN + PASSING_MIN);
  return { start, end: start + PERIOD_MIN };
}

export function periodLabel(period: number): string {
  const { start, end } = periodLocalMinutes(period);
  const f = (m: number) => {
    const h = Math.floor(m / 60);
    const mm = String(m % 60).padStart(2, "0");
    return `${((h + 11) % 12) + 1}:${mm}`;
  };
  return `${f(start)}–${f(end)}`;
}

/** UTC [start, end) of a period on the local calendar day containing `dayMs`. */
export function periodWindow(period: number, dayMs: number, tz: string): { startMs: number; endMs: number } {
  const p = localParts(dayMs, tz);
  const { start, end } = periodLocalMinutes(period);
  return {
    startMs: zonedToUtc(p.year, p.month, p.day, Math.floor(start / 60), start % 60, tz),
    endMs: zonedToUtc(p.year, p.month, p.day, Math.floor(end / 60), end % 60, tz),
  };
}

/** The full school day: first bell to end of the last period. */
export function schoolDayWindow(dayMs: number, tz: string): { startMs: number; endMs: number } {
  return { startMs: periodWindow(1, dayMs, tz).startMs, endMs: periodWindow(PERIOD_COUNT, dayMs, tz).endMs };
}

export { DAY_MS };
