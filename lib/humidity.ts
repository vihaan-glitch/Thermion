/**
 * Psychrometric helpers (Magnus-Tetens approximation). Pure functions.
 *
 * Used to estimate indoor relative humidity when a report has none: in a
 * naturally ventilated room the moisture content tracks outdoor air, so the
 * dewpoint is shared while the warmer indoor air holds a lower RH.
 */

const A = 17.625;
const B = 243.04; // °C

const fToC = (f: number) => ((f - 32) * 5) / 9;
const cToF = (c: number) => (c * 9) / 5 + 32;

export function dewpointF(tempF: number, rhPct: number): number {
  const t = fToC(tempF);
  const rh = Math.min(100, Math.max(1, rhPct));
  const g = Math.log(rh / 100) + (A * t) / (B + t);
  return cToF((B * g) / (A - g));
}

export function rhFromDewpoint(tempF: number, dewF: number): number {
  const t = fToC(tempF);
  const td = fToC(dewF);
  const rh = 100 * Math.exp((A * td) / (B + td) - (A * t) / (B + t));
  return Math.min(100, Math.max(0, rh));
}

/** Assumed RH for air-conditioned rooms, which dehumidify. */
export const AC_ROOM_RH_PCT = 50;
/** Fallback when neither the room nor the outdoor forecast has humidity. */
export const DEFAULT_RH_PCT = 50;

/**
 * Best estimate of indoor RH for a room at `indoorF`.
 * Priority: measured value > AC assumption > outdoor-dewpoint carryover > default.
 */
export function estimateIndoorRh(opts: {
  indoorF: number;
  measuredRhPct?: number | null;
  hasAc: boolean;
  outdoorF?: number | null;
  outdoorRhPct?: number | null;
}): { rhPct: number; estimated: boolean } {
  if (opts.measuredRhPct != null && Number.isFinite(opts.measuredRhPct)) {
    return { rhPct: opts.measuredRhPct, estimated: false };
  }
  if (opts.hasAc) return { rhPct: AC_ROOM_RH_PCT, estimated: true };
  if (opts.outdoorF != null && opts.outdoorRhPct != null) {
    const td = dewpointF(opts.outdoorF, opts.outdoorRhPct);
    return { rhPct: rhFromDewpoint(opts.indoorF, Math.min(td, opts.indoorF)), estimated: true };
  }
  return { rhPct: DEFAULT_RH_PCT, estimated: true };
}
