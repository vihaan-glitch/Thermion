import type { DB } from "./db";
import { getHourlyForecast, type HourlyPeriod } from "./nws";
import { upsertWeatherHours, weatherHours } from "./repo";
import { HOUR_MS } from "./time";
import type { School } from "./types";
import { climatologySeries, normalizeSeries, weatherAt, type WeatherAt, type WeatherSample } from "./weatherSeries";

/**
 * Server-side weather loader: live NWS forecast when available, otherwise the
 * logged forecast hours from SQLite, otherwise labeled climatology. The page
 * renders a banner for anything other than "live".
 */

export type WeatherStatus = "live" | "stale" | "fallback";

export interface WeatherContext {
  status: WeatherStatus;
  message: string | null;
  fetchedAt: string | null;
  /** NWS periods from the most recent successful fetch (may be empty). */
  periods: HourlyPeriod[];
  /** Hourly samples covering [fromMs, toMs]. */
  series: WeatherSample[];
  /** Conditions right now, interpolated. */
  now: WeatherAt;
}

export async function loadWeather(
  db: DB,
  school: School,
  window: { fromMs: number; toMs: number; nowMs: number },
): Promise<WeatherContext> {
  const res = await getHourlyForecast(school.lat, school.lon);
  let status: WeatherStatus = "live";
  let message: string | null = null;
  let periods: HourlyPeriod[] = [];
  let fetchedAt: string | null = null;

  if (res.ok) {
    periods = res.value.periods;
    fetchedAt = res.value.fetchedAt;
    upsertWeatherHours(db, school.id, periods, fetchedAt);
  } else {
    status = "stale";
    message = `National Weather Service unavailable (${res.error.message}).`;
    if (res.error.stale) {
      periods = res.error.stale.periods;
      fetchedAt = res.error.stale.fetchedAt;
    }
  }

  let series = weatherHours(db, school.id, window.fromMs - HOUR_MS, window.toMs);
  if (series.length === 0) {
    status = "fallback";
    message =
      (message ?? "No forecast data.") +
      " Showing typical-day climatology for this month, not a forecast.";
    series = climatologySeries(window.fromMs, Math.ceil((window.toMs - window.fromMs) / (24 * HOUR_MS)) + 1, school.tz);
  } else {
    const last = series[series.length - 1].t;
    if (last < window.toMs - HOUR_MS) {
      const fill = climatologySeries(last + HOUR_MS, Math.ceil((window.toMs - last) / (24 * HOUR_MS)) + 1, school.tz)
        .filter((s) => s.t > last && s.t <= window.toMs);
      if (fill.length > 0) {
        if (status === "live") status = "stale";
        message =
          (message ?? "") +
          ` Forecast coverage ends ${new Date(last).toISOString().slice(0, 16)}Z; later hours use climatology.`;
        series = normalizeSeries([...series, ...fill]);
      }
    }
  }

  return { status, message: message?.trim() ?? null, fetchedAt, periods, series, now: weatherAt(series, window.nowMs) };
}
