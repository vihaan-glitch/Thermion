/** Time-zone helpers built on Intl only. Pure functions. */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export { HOUR_MS, DAY_MS };

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = partsFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsFormatters.set(tz, f);
  }
  return f;
}

export function localParts(utcMs: number, tz: string): LocalParts {
  const out: Record<string, number> = {};
  for (const p of partsFormatter(tz).formatToParts(new Date(utcMs))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour === 24 ? 0 : out.hour,
    minute: out.minute,
  };
}

/** Offset of `tz` from UTC at `utcMs`, in minutes (e.g. -240 for EDT). */
export function tzOffsetMinutes(utcMs: number, tz: string): number {
  const p = localParts(utcMs, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  const truncated = Math.floor(utcMs / 60_000) * 60_000;
  return Math.round((asUtc - truncated) / 60_000);
}

/** UTC instant for a wall-clock time in `tz`. */
export function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let t = guess - tzOffsetMinutes(guess, tz) * 60_000;
  // Second pass settles DST boundaries.
  t = guess - tzOffsetMinutes(t, tz) * 60_000;
  return t;
}

export function startOfLocalDay(utcMs: number, tz: string): number {
  const p = localParts(utcMs, tz);
  return zonedToUtc(p.year, p.month, p.day, 0, 0, tz);
}

/** Local decimal hour (0-24) of an instant. */
export function localHour(utcMs: number, tz: string): number {
  const p = localParts(utcMs, tz);
  return p.hour + p.minute / 60;
}

export function formatClock(utcMs: number, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(utcMs));
}

export function formatHourShort(utcMs: number, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric" })
    .format(new Date(utcMs))
    .replace(" ", "")
    .toLowerCase();
}

export function formatDayClock(utcMs: number, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(utcMs));
}

export function formatDate(utcMs: number, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(utcMs));
}

export function timeAgo(utcMs: number, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - utcMs) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}
