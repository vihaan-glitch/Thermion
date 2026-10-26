/**
 * Turns thermal simulations into what the UI and optimizer consume: indoor
 * temperature, outdoor temperature and indoor heat index on a common time
 * grid, plus peaks over a time window. Pure functions.
 */
import { heatIndexDerivativeT, heatIndexF } from "./heatindex";
import { trackWithAnchors, type KalmanState, type Site } from "./kalman";
import { estimateIndoorRh } from "./humidity";
import { driveAt, simulateDay, type ThermalParams, type ThermalRoom } from "./thermal";
import type { WeatherSample } from "./weatherSeries";

export interface PredictionPoint {
  t: number;
  indoorF: number;
  outdoorF: number;
  heatIndexF: number;
  solarW: number;
  /** 1σ uncertainty of indoorF (absent for physics-only predictions). */
  sdF?: number;
  /** 1σ uncertainty of heatIndexF, linearized: |dHI/dT|·sdF. */
  hiSdF?: number;
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

/**
 * Kalman-filtered prediction: mean and 1σ from the filter's covariance,
 * propagated from `initial` and re-anchored at every posterior in `anchors`.
 */
export function predictRoomFiltered(
  room: ThermalRoom,
  site: Site,
  series: WeatherSample[],
  initial: KalmanState,
  anchors: KalmanState[],
  window: { startMs: number; endMs: number },
  sampleEveryMin = 15,
): PredictionPoint[] {
  const track = trackWithAnchors(initial, anchors, room, site, series, window.startMs, window.endMs, sampleEveryMin);
  const p: ThermalParams = { invRC: initial.x[1], alpha: initial.x[2], lat: site.lat, lon: site.lon };
  return track.map((tp) => {
    const d = driveAt(room, series, tp.t, p);
    const rh = estimateIndoorRh({ indoorF: tp.meanF, hasAc: room.has_ac, outdoorF: d.outdoorF, outdoorRhPct: d.rhPct });
    return {
      t: tp.t,
      indoorF: tp.meanF,
      outdoorF: d.outdoorF,
      heatIndexF: heatIndexF(tp.meanF, rh.rhPct),
      solarW: d.solarW,
      sdF: tp.sdF,
      hiSdF: Math.abs(heatIndexDerivativeT(tp.meanF, rh.rhPct)) * tp.sdF,
    };
  });
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
