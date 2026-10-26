/**
 * A labeled demo scenario so the physics can be explored outside heat season:
 * two consecutive June school days under a synthetic heat wave. Never mixed
 * with live data; every page that uses it says so.
 */
import { DAY_MS, localParts, zonedToUtc } from "./time";
import { normalizeSeries, syntheticDay, type WeatherSample } from "./weatherSeries";

export type ScenarioId = "live" | "heatwave";

export interface Scenario {
  id: ScenarioId;
  label: string;
}

export const HEATWAVE_DESCRIPTION =
  "Synthetic heat wave on the third Thursday and Friday of June: lows 74/76 °F, highs 94/97 °F, clear skies. Not a forecast.";

export function parseScenario(raw: string | string[] | undefined): ScenarioId {
  return raw === "heatwave" ? "heatwave" : "live";
}

/** Third Thursday of June in the year of `nowMs` (or next year once that has passed). */
export function heatwaveStartMs(nowMs: number, tz: string): number {
  const year = localParts(nowMs, tz).year;
  for (const y of [year, year + 1]) {
    const june1 = new Date(Date.UTC(y, 5, 1)).getUTCDay(); // 0=Sun
    const firstThu = 1 + ((4 - june1 + 7) % 7);
    const day = firstThu + 14;
    const start = zonedToUtc(y, 6, day, 0, 0, tz);
    if (start + 2 * DAY_MS > nowMs || y === year + 1) return start;
  }
  throw new Error("unreachable");
}

export function heatwaveSeries(startMs: number, tz: string): WeatherSample[] {
  return normalizeSeries([
    // A day of lead-in so the spin-up sees the heat building.
    ...syntheticDay(startMs - DAY_MS, tz, { lowF: 71, highF: 90, rhAtLowPct: 80, rhAtHighPct: 50, skyCoverPct: 15 }),
    ...syntheticDay(startMs, tz, { lowF: 74, highF: 94, rhAtLowPct: 78, rhAtHighPct: 46, skyCoverPct: 5 }),
    ...syntheticDay(startMs + DAY_MS, tz, { lowF: 76, highF: 97, rhAtLowPct: 75, rhAtHighPct: 44, skyCoverPct: 5 }),
  ]);
}
