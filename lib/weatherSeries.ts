/**
 * Hourly outdoor weather samples and interpolation. Pure functions.
 */
import { DAY_MS, HOUR_MS, localParts, zonedToUtc } from "./time";

export interface WeatherSample {
  /** Start of the hour, UTC ms. Value is treated as the hour's midpoint conditions. */
  t: number;
  tempF: number;
  rhPct: number | null;
  skyCoverPct: number | null;
}

export interface WeatherAt {
  tempF: number;
  rhPct: number | null;
  skyCoverPct: number | null;
}

/**
 * Linear interpolation of temperature/RH between hourly samples (samples are
 * placed at the middle of their hour); sky cover is held piecewise-constant.
 * Outside the covered range the nearest sample is held (clamped).
 */
export function weatherAt(series: WeatherSample[], t: number): WeatherAt {
  const n = series.length;
  if (n === 0) return { tempF: NaN, rhPct: null, skyCoverPct: null };
  const mid = (i: number) => series[i].t + HOUR_MS / 2;
  if (t <= mid(0)) return pick(series[0]);
  if (t >= mid(n - 1)) return pick(series[n - 1]);

  // Binary search for the bracketing pair.
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (mid(m) <= t) lo = m;
    else hi = m;
  }
  const a = series[lo];
  const b = series[hi];
  const f = (t - mid(lo)) / (mid(hi) - mid(lo));
  const lerp = (x: number, y: number) => x + (y - x) * f;
  return {
    tempF: lerp(a.tempF, b.tempF),
    rhPct: a.rhPct != null && b.rhPct != null ? lerp(a.rhPct, b.rhPct) : (a.rhPct ?? b.rhPct),
    skyCoverPct: t - a.t < HOUR_MS ? a.skyCoverPct : b.skyCoverPct,
  };
}

function pick(s: WeatherSample): WeatherAt {
  return { tempF: s.tempF, rhPct: s.rhPct, skyCoverPct: s.skyCoverPct };
}

/** Sorts by time and keeps the last sample for any duplicated hour. */
export function normalizeSeries(samples: WeatherSample[]): WeatherSample[] {
  const byHour = new Map<number, WeatherSample>();
  for (const s of samples) byHour.set(Math.floor(s.t / HOUR_MS) * HOUR_MS, { ...s, t: Math.floor(s.t / HOUR_MS) * HOUR_MS });
  return [...byHour.values()].sort((a, b) => a.t - b.t);
}

/**
 * Approximate monthly normal highs/lows (°F) for inland north-central New
 * Jersey. Used ONLY as a clearly labeled fallback when no NWS forecast has
 * ever been fetched, so the app degrades instead of going blank.
 */
const NORMAL_HIGH_F = [37, 40, 49, 61, 71, 80, 85, 83, 76, 64, 53, 42];
const NORMAL_LOW_F = [19, 21, 28, 38, 47, 57, 62, 60, 52, 41, 33, 25];

export interface DiurnalProfile {
  lowF: number;
  highF: number;
  /** RH at the daily low; RH falls as temperature rises (constant dewpoint-ish). */
  rhAtLowPct: number;
  rhAtHighPct: number;
  skyCoverPct: number;
}

/**
 * Synthetic diurnal temperature curve: minimum near 6:00 local, maximum near
 * 15:00 local, cosine-shaped between them.
 */
export function syntheticDay(
  dayStartUtc: number,
  tz: string,
  profile: DiurnalProfile,
  hours = 24,
): WeatherSample[] {
  const out: WeatherSample[] = [];
  for (let h = 0; h < hours; h++) {
    const t = dayStartUtc + h * HOUR_MS;
    const lp = localParts(t + HOUR_MS / 2, tz);
    const hr = lp.hour + lp.minute / 60;
    // Piecewise cosine: rising 6 -> 15, falling 15 -> 30 (6 next day).
    let frac: number;
    if (hr >= 6 && hr <= 15) frac = (1 - Math.cos((Math.PI * (hr - 6)) / 9)) / 2;
    else {
      const since = hr > 15 ? hr - 15 : hr + 9;
      frac = (1 + Math.cos((Math.PI * since) / 15)) / 2;
    }
    out.push({
      t,
      tempF: profile.lowF + (profile.highF - profile.lowF) * frac,
      rhPct: profile.rhAtLowPct + (profile.rhAtHighPct - profile.rhAtLowPct) * frac,
      skyCoverPct: profile.skyCoverPct,
    });
  }
  return out;
}

export function climatologySeries(fromUtc: number, days: number, tz: string): WeatherSample[] {
  const out: WeatherSample[] = [];
  const lp = localParts(fromUtc, tz);
  const start = zonedToUtc(lp.year, lp.month, lp.day, 0, 0, tz);
  for (let d = 0; d < days; d++) {
    const dayStart = start + d * DAY_MS;
    const m = localParts(dayStart + 12 * HOUR_MS, tz).month - 1;
    out.push(
      ...syntheticDay(dayStart, tz, {
        lowF: NORMAL_LOW_F[m],
        highF: NORMAL_HIGH_F[m],
        rhAtLowPct: 85,
        rhAtHighPct: 50,
        skyCoverPct: 40,
      }),
    );
  }
  return normalizeSeries(out);
}
