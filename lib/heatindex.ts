/**
 * NWS heat index (Rothfusz regression), as published by the National Weather
 * Service Weather Prediction Center:
 * https://www.wpc.ncep.noaa.gov/html/heatindex_equation.shtml
 *
 * Pure function, no I/O. Inputs in °F and % relative humidity.
 */

/** Steadman-derived simple formula NWS uses first. */
export function heatIndexSimpleF(tempF: number, rhPct: number): number {
  return 0.5 * (tempF + 61.0 + (tempF - 68.0) * 1.2 + rhPct * 0.094);
}

/** Full Rothfusz multiple regression (valid roughly for HI >= 80 °F). */
export function rothfuszF(tempF: number, rhPct: number): number {
  const T = tempF;
  const R = rhPct;
  return (
    -42.379 +
    2.04901523 * T +
    10.14333127 * R -
    0.22475541 * T * R -
    0.00683783 * T * T -
    0.05481717 * R * R +
    0.00122874 * T * T * R +
    0.00085282 * T * R * R -
    0.00000199 * T * T * R * R
  );
}

/**
 * Heat index in °F.
 *
 * 1. Compute the simple formula. If the average of it and the air
 *    temperature is below 80 °F, that simple value is the answer.
 * 2. Otherwise use the full Rothfusz regression, then:
 *    - low-humidity adjustment: RH < 13% and 80 <= T <= 112 °F, subtract
 *      ((13 - RH) / 4) * sqrt((17 - |T - 95|) / 17)
 *    - high-humidity adjustment: RH > 85% and 80 <= T <= 87 °F, add
 *      ((RH - 85) / 10) * ((87 - T) / 5)
 */
export function heatIndexF(tempF: number, rhPct: number): number {
  if (!Number.isFinite(tempF) || !Number.isFinite(rhPct)) return NaN;
  const rh = Math.min(100, Math.max(0, rhPct));

  const simple = heatIndexSimpleF(tempF, rh);
  if ((simple + tempF) / 2 < 80) return simple;

  let hi = rothfuszF(tempF, rh);

  if (rh < 13 && tempF >= 80 && tempF <= 112) {
    hi -= ((13 - rh) / 4) * Math.sqrt((17 - Math.abs(tempF - 95)) / 17);
  } else if (rh > 85 && tempF >= 80 && tempF <= 87) {
    hi += ((rh - 85) / 10) * ((87 - tempF) / 5);
  }
  return hi;
}

/** Central-difference sensitivity dHI/dT, used to propagate temperature uncertainty. */
export function heatIndexDerivativeT(tempF: number, rhPct: number): number {
  const h = 0.05;
  return (heatIndexF(tempF + h, rhPct) - heatIndexF(tempF - h, rhPct)) / (2 * h);
}
