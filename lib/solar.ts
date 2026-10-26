/**
 * Solar position from first principles: the NOAA Solar Calculator algorithm
 * (Meeus, "Astronomical Algorithms"), as implemented in NOAA's solar position
 * spreadsheet. Pure function, no I/O, no libraries.
 *
 * Accuracy is roughly ±0.01° in elevation for dates 1800-2100 (before
 * refraction, which itself is a model of the standard atmosphere).
 */

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

const sinD = (d: number) => Math.sin(d * RAD);
const cosD = (d: number) => Math.cos(d * RAD);
const tanD = (d: number) => Math.tan(d * RAD);
const clamp1 = (x: number) => Math.max(-1, Math.min(1, x));
const mod = (a: number, n: number) => ((a % n) + n) % n;

export interface SolarPosition {
  /** Apparent elevation above the horizon, degrees, refraction-corrected. Negative = below horizon. */
  elevationDeg: number;
  /** Azimuth clockwise from true north, degrees in [0, 360). */
  azimuthDeg: number;
}

/**
 * Standard atmospheric refraction correction (degrees) for a true geometric
 * elevation `e` (degrees). Piecewise fit used by NOAA.
 */
export function refractionCorrectionDeg(e: number): number {
  if (e > 85) return 0;
  const te = tanD(e);
  let arcsec: number;
  if (e > 5) arcsec = 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5;
  else if (e > -0.575) arcsec = 1735 + e * (-518.2 + e * (103.4 + e * (-12.79 + e * 0.711)));
  else arcsec = -20.772 / te;
  return arcsec / 3600;
}

/**
 * @param lat  latitude, degrees north positive
 * @param lon  longitude, degrees east positive (west is negative)
 * @param utc  instant (Date or epoch milliseconds)
 */
export function solarPosition(lat: number, lon: number, utc: Date | number): SolarPosition {
  const ms = typeof utc === "number" ? utc : utc.getTime();

  // Julian day and Julian century (J2000.0 epoch).
  const julianDay = ms / 86_400_000 + 2440587.5;
  const T = (julianDay - 2451545) / 36525;

  // Geometric mean longitude and mean anomaly of the sun (degrees).
  const L0 = mod(280.46646 + T * (36000.76983 + T * 0.0003032), 360);
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);

  // Eccentricity of Earth's orbit.
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);

  // Equation of center.
  const C =
    sinD(M) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
    sinD(2 * M) * (0.019993 - 0.000101 * T) +
    sinD(3 * M) * 0.000289;

  // True and apparent longitude (nutation + aberration correction via Omega).
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const appLong = trueLong - 0.00569 - 0.00478 * sinD(omega);

  // Mean obliquity of the ecliptic, plus the nutation correction term.
  const meanObliq = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const obliqCorr = meanObliq + 0.00256 * cosD(omega);

  // Declination.
  const decl = Math.asin(sinD(obliqCorr) * sinD(appLong)) * DEG;

  // Equation of time (minutes).
  const y = tanD(obliqCorr / 2) ** 2;
  const eqTime =
    4 *
    DEG *
    (y * Math.sin(2 * L0 * RAD) -
      2 * e * Math.sin(M * RAD) +
      4 * e * y * Math.sin(M * RAD) * Math.cos(2 * L0 * RAD) -
      0.5 * y * y * Math.sin(4 * L0 * RAD) -
      1.25 * e * e * Math.sin(2 * M * RAD));

  // True solar time (minutes past local solar midnight) from UTC minutes.
  const utcMinutes = mod(ms / 60_000, 1440);
  const trueSolarTime = mod(utcMinutes + eqTime + 4 * lon, 1440);

  // Hour angle (degrees, negative before solar noon).
  const hourAngle = trueSolarTime / 4 < 0 ? trueSolarTime / 4 + 180 : trueSolarTime / 4 - 180;

  // Solar zenith.
  const cosZenith = clamp1(sinD(lat) * sinD(decl) + cosD(lat) * cosD(decl) * cosD(hourAngle));
  const zenith = Math.acos(cosZenith) * DEG;

  // Solar azimuth, clockwise from north.
  let azimuth: number;
  const sinZenith = Math.sin(zenith * RAD);
  if (sinZenith < 1e-9) {
    azimuth = 180; // sun at zenith/nadir: azimuth undefined; pick due south
  } else {
    const acosArg = clamp1((sinD(lat) * cosZenith - sinD(decl)) / (cosD(lat) * sinZenith));
    const a = Math.acos(acosArg) * DEG;
    azimuth = hourAngle > 0 ? mod(a + 180, 360) : mod(540 - a, 360);
  }

  // Apparent elevation = geometric elevation + atmospheric refraction.
  const geomElevation = 90 - zenith;
  const elevationDeg = geomElevation + refractionCorrectionDeg(geomElevation);

  return { elevationDeg, azimuthDeg: azimuth };
}
