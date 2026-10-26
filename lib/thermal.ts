/**
 * First-order RC lumped thermal model, one zone per room. Pure functions.
 *
 *   C · dT/dt = (T_drive − T) / R + α' · I_solar
 *
 * Dividing through by C gives the form we integrate, in °F and hours:
 *
 *   dT/dt = invRC · (T_drive − T) + alpha · Q_solar
 *
 *   invRC  [1/h]          = 1/(R·C), the inverse thermal time constant
 *   alpha  [°F/h per W]   = α'/C: lumps window solar heat gain coefficient
 *                           and the room's effective heat capacity
 *   Q_solar [W]           = solar power striking the room's windows (irradiance.ts)
 *   T_drive [°F]          = outdoor air for naturally ventilated rooms, or the
 *                           AC setpoint for conditioned rooms (the AC is modeled
 *                           as a much stronger coupling to a fixed setpoint)
 *
 * Discretization: forward Euler at 5-minute steps,
 *
 *   T[k+1] = T[k] + Δt · (invRC · (T_drive − T[k]) + alpha · Q[k])
 *
 * Forward Euler on this linear ODE is stable when Δt·invRC < 2 and
 * monotone (no overshoot) when Δt·invRC < 1. Classroom time constants are on
 * the order of hours (τ = 1/invRC ≈ 3 h without AC, ≈ 40 min with AC), so
 * Δt·invRC ≈ 0.03-0.13 at Δt = 5 min: comfortably inside the stable,
 * non-oscillatory region, with truncation error far below forecast error.
 * If someone passes a stiffer invRC, `eulerStep` sub-steps automatically.
 */
import { roomSolarWatts } from "./irradiance";
import { ORIENTATION_AZIMUTH, type Orientation } from "./types";
import { weatherAt, type WeatherSample } from "./weatherSeries";

export const STEP_MINUTES = 5;
export const STEP_HOURS = STEP_MINUTES / 60;

/** Default for rooms without AC: τ = 3 h. */
export const DEFAULT_INV_RC_NO_AC = 1 / 3;
/** Default for AC rooms: τ = 40 min toward the setpoint. */
export const DEFAULT_INV_RC_AC = 1.5;
/**
 * Default solar coupling, °F/h per W striking the glass. Derivation: an
 * effective room heat capacity of ~2.6 MJ/K (air plus the first few cm of
 * walls, floor and furniture) and SHGC ≈ 0.5 give
 *   0.5 · 3600 s/h / 2.6e6 J/K ≈ 6.9e-4 K/h/W ≈ 1.2e-3 °F/h/W;
 * we round down to 1.0e-3 because blinds are often partly drawn.
 */
export const DEFAULT_ALPHA = 1.0e-3;
export const DEFAULT_AC_SETPOINT_F = 72;

export interface ThermalRoom {
  orientation: Orientation;
  window_area_m2: number;
  has_ac: boolean;
}

export interface ThermalParams {
  invRC: number;
  alpha: number;
  lat: number;
  lon: number;
  setpointF?: number;
  stepMinutes?: number;
}

export function defaultParams(room: ThermalRoom, site: { lat: number; lon: number }): ThermalParams {
  return {
    invRC: room.has_ac ? DEFAULT_INV_RC_AC : DEFAULT_INV_RC_NO_AC,
    alpha: DEFAULT_ALPHA,
    lat: site.lat,
    lon: site.lon,
    setpointF: room.has_ac ? DEFAULT_AC_SETPOINT_F : undefined,
  };
}

/** One forward-Euler step of dT/dt = invRC·(Tdrive − T) + alpha·Q. */
export function eulerStep(T: number, invRC: number, alpha: number, tDriveF: number, solarW: number, dtHours: number): number {
  // Sub-step if a caller supplies a time constant too stiff for monotone Euler.
  const n = Math.max(1, Math.ceil((dtHours * Math.abs(invRC)) / 0.5));
  const h = dtHours / n;
  let t = T;
  for (let i = 0; i < n; i++) t = t + h * (invRC * (tDriveF - t) + alpha * solarW);
  return t;
}

export interface Drive {
  outdoorF: number;
  tDriveF: number;
  solarW: number;
  rhPct: number | null;
}

/** External forcing for a room at an instant. */
export function driveAt(room: ThermalRoom, series: WeatherSample[], ms: number, p: ThermalParams): Drive {
  const w = weatherAt(series, ms);
  const solarW = roomSolarWatts({
    lat: p.lat,
    lon: p.lon,
    ms,
    windowAzimuthDeg: ORIENTATION_AZIMUTH[room.orientation],
    windowAreaM2: room.window_area_m2,
    skyCoverPct: w.skyCoverPct,
  });
  const tDriveF = room.has_ac ? (p.setpointF ?? DEFAULT_AC_SETPOINT_F) : w.tempF;
  return { outdoorF: w.tempF, tDriveF, solarW, rhPct: w.rhPct };
}

export interface SimPoint {
  t: number;
  tIndoorF: number;
}

/**
 * Periodic spin-up initial condition: integrate the first 24 h of forcing
 * starting from T_drive, and use the temperature reached 24 h later as the
 * temperature at the start. With τ ≈ 3 h the starting guess decays by e^-8.
 */
export function spinUpInitialF(room: ThermalRoom, series: WeatherSample[], startMs: number, p: ThermalParams): number {
  const dtH = (p.stepMinutes ?? STEP_MINUTES) / 60;
  const steps = Math.round(24 / dtH);
  let T = driveAt(room, series, startMs, p).tDriveF;
  for (let k = 0; k < steps; k++) {
    const d = driveAt(room, series, startMs + k * dtH * 3_600_000, p);
    T = eulerStep(T, p.invRC, p.alpha, d.tDriveF, d.solarW, dtH);
  }
  return T;
}

/**
 * Simulate indoor temperature over the span of `hourlyForecast` (or
 * [opts.startMs, opts.endMs]) at 5-minute steps.
 */
export function simulateDay(
  room: ThermalRoom,
  hourlyForecast: WeatherSample[],
  params: ThermalParams,
  opts: { startMs?: number; endMs?: number; t0F?: number } = {},
): SimPoint[] {
  if (hourlyForecast.length === 0) return [];
  const dtH = (params.stepMinutes ?? STEP_MINUTES) / 60;
  const dtMs = dtH * 3_600_000;
  const startMs = opts.startMs ?? hourlyForecast[0].t;
  const endMs = opts.endMs ?? hourlyForecast[hourlyForecast.length - 1].t + 3_600_000;

  let T = opts.t0F ?? spinUpInitialF(room, hourlyForecast, startMs, params);
  const out: SimPoint[] = [{ t: startMs, tIndoorF: T }];
  for (let t = startMs; t + dtMs <= endMs + 1; t += dtMs) {
    const d = driveAt(room, hourlyForecast, t, params);
    T = eulerStep(T, params.invRC, params.alpha, d.tDriveF, d.solarW, dtH);
    out.push({ t: t + dtMs, tIndoorF: T });
  }
  return out;
}
