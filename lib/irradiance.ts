/**
 * Per-room solar load through a vertical window. Pure functions.
 *
 * Chain, for one instant:
 *   1. Sun position (lib/solar.ts).
 *   2. Extraterrestrial irradiance I0 = 1361 W/m² × eccentricity correction
 *      (1 + 0.033·cos(2π·n/365)), n = day of year.
 *   3. Kasten-Young (1989) relative air mass
 *        AM = 1 / (cos z + 0.50572·(96.07995 − z)^−1.6364), z in degrees.
 *   4. Clear-sky direct normal irradiance (Meinel & Meinel):
 *        DNI = I0 · 0.7^(AM^0.678)
 *   5. Diffuse horizontal irradiance as a fixed fraction of the beam on the
 *      horizontal: DHI = k_d · DNI · cos z.  A vertical plane sees half of an
 *      isotropic sky dome, so diffuse on the window = DHI / 2.
 *   6. Beam on a VERTICAL window whose outward normal has azimuth γ:
 *        cos θ = cos(elevation) · cos(sunAzimuth − γ), clamped at 0 when the
 *      sun is behind the wall.
 *   7. Multiply by window area and a cloud factor.
 */
import { solarPosition } from "./solar";

export const SOLAR_CONSTANT_W_M2 = 1361;
/** Fraction of horizontal beam taken as diffuse sky irradiance. Assumption, see README. */
export const DIFFUSE_FRACTION = 0.1;

const RAD = Math.PI / 180;

export function dayOfYear(ms: number): number {
  const d = new Date(ms);
  return Math.floor((ms - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000) + 1;
}

export function extraterrestrialIrradiance(ms: number): number {
  return SOLAR_CONSTANT_W_M2 * (1 + 0.033 * Math.cos((2 * Math.PI * dayOfYear(ms)) / 365));
}

export function kastenYoungAirMass(zenithDeg: number): number {
  if (zenithDeg >= 90) return Infinity;
  return 1 / (Math.cos(zenithDeg * RAD) + 0.50572 * Math.pow(96.07995 - zenithDeg, -1.6364));
}

/**
 * Kasten & Czeplak (1980): global irradiance under cloud cover fraction C is
 * reduced by (1 − 0.75·C^3.4). Sky cover is reported in percent.
 * Null/undefined sky cover means "unknown" and gives 1.0 (clear sky).
 */
export function cloudFactor(skyCoverPct: number | null | undefined): number {
  if (skyCoverPct == null || !Number.isFinite(skyCoverPct)) return 1;
  const c = Math.min(1, Math.max(0, skyCoverPct / 100));
  return 1 - 0.75 * Math.pow(c, 3.4);
}

export interface WindowIrradiance {
  /** Irradiance on the window plane, W/m² (beam + diffuse, after clouds). */
  planeWm2: number;
  /** Total solar power striking the window, W. */
  watts: number;
  beamWm2: number;
  diffuseWm2: number;
  elevationDeg: number;
  azimuthDeg: number;
}

export function windowIrradiance(opts: {
  lat: number;
  lon: number;
  ms: number;
  windowAzimuthDeg: number;
  windowAreaM2: number;
  skyCoverPct?: number | null;
}): WindowIrradiance {
  const { elevationDeg, azimuthDeg } = solarPosition(opts.lat, opts.lon, opts.ms);
  if (elevationDeg <= 0) {
    return { planeWm2: 0, watts: 0, beamWm2: 0, diffuseWm2: 0, elevationDeg, azimuthDeg };
  }
  const zenith = 90 - elevationDeg;
  const am = kastenYoungAirMass(zenith);
  const dni = extraterrestrialIrradiance(opts.ms) * Math.pow(0.7, Math.pow(am, 0.678));
  const dhi = DIFFUSE_FRACTION * dni * Math.cos(zenith * RAD);

  const cosTheta = Math.max(0, Math.cos(elevationDeg * RAD) * Math.cos((azimuthDeg - opts.windowAzimuthDeg) * RAD));
  const cf = cloudFactor(opts.skyCoverPct);
  const beam = dni * cosTheta * cf;
  const diffuse = (dhi / 2) * cf;
  const plane = beam + diffuse;
  return {
    planeWm2: plane,
    watts: plane * opts.windowAreaM2,
    beamWm2: beam,
    diffuseWm2: diffuse,
    elevationDeg,
    azimuthDeg,
  };
}

/** Watts of solar radiation into a room's windows at an instant. */
export function roomSolarWatts(opts: {
  lat: number;
  lon: number;
  ms: number;
  windowAzimuthDeg: number;
  windowAreaM2: number;
  skyCoverPct?: number | null;
}): number {
  return windowIrradiance(opts).watts;
}
