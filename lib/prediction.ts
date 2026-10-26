/**
 * Turns thermal simulations into what the UI and optimizer consume: indoor
 * temperature, outdoor temperature and indoor heat index on a common time
 * grid, plus peaks over a time window. Pure functions.
 */
import { heatIndexF } from "./heatindex";
import { estimateIndoorRh } from "./humidity";
import { driveAt, simulateDay, type ThermalParams, type ThermalRoom } from "./thermal";
import type { WeatherSample } from "./weatherSeries";

export interface PredictionPoint {
  t: number;
  indoorF: number;
  outdoorF: number;
  heatIndexF: number;
  solarW: number;
}

export function predictRoom(
  room: ThermalRoom,
  series: WeatherSample[],
  params: ThermalParams,
  window: { startMs: number; endMs: number },
  sampleEveryMin = 15,
): PredictionPoint[] {
  const sim = simulateDay(room, series, params, window);
  const stride = Math.max(1, Math.round(sampleEveryMin / (params.stepMinutes ?? 5)));
  const out: PredictionPoint[] = [];
  for (let i = 0; i < sim.length; i += stride) {
    const p = sim[i];
    const d = driveAt(room, series, p.t, params);
    const rh = estimateIndoorRh({ indoorF: p.tIndoorF, hasAc: room.has_ac, outdoorF: d.outdoorF, outdoorRhPct: d.rhPct });
    out.push({ t: p.t, indoorF: p.tIndoorF, outdoorF: d.outdoorF, heatIndexF: heatIndexF(p.tIndoorF, rh.rhPct), solarW: d.solarW });
  }
  return out;
}

/** Point with the highest value of `key` inside [startMs, endMs], or null. */
export function peakIn<T extends { t: number }>(points: T[], key: keyof T, startMs: number, endMs: number): T | null {
  let best: T | null = null;
  for (const p of points) {
    if (p.t < startMs || p.t > endMs) continue;
    if (!best || (p[key] as number) > (best[key] as number)) best = p;
  }
  return best;
}
