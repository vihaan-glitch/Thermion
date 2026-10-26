import { describe, expect, it } from "vitest";
import { refractionCorrectionDeg, solarPosition } from "@/lib/solar";

const MIN = 60_000;

/** Scan a UTC day at 1-minute resolution for the instant of maximum elevation. */
function solarNoon(lat: number, lon: number, dayUtcMs: number) {
  let best = { t: dayUtcMs, el: -Infinity, az: 0 };
  for (let t = dayUtcMs - 12 * 60 * MIN; t < dayUtcMs + 36 * 60 * MIN; t += MIN) {
    const p = solarPosition(lat, lon, t);
    if (p.elevationDeg > best.el) best = { t, el: p.elevationDeg, az: p.azimuthDeg };
  }
  return best;
}

describe("solarPosition (NOAA algorithm)", () => {
  it.each([
    ["March equinox 2024", Date.UTC(2024, 2, 20)],
    ["September equinox 2024", Date.UTC(2024, 8, 22)],
  ])("sun is near zenith at solar noon on the equator, %s", (_label, day) => {
    const noon = solarNoon(0, 0, day);
    expect(noon.el).toBeGreaterThan(90 - 1.5);
    // Solar noon at Greenwich meridian is 12:00 UTC ± equation of time (< 17 min).
    expect(Math.abs(noon.t - (day + 12 * 60 * MIN))).toBeLessThan(17 * MIN);
  });

  it("azimuth is ~180° at local solar noon in the northern hemisphere (Morris Plains, NJ)", () => {
    for (const day of [Date.UTC(2026, 0, 15), Date.UTC(2026, 5, 21), Date.UTC(2026, 8, 1)]) {
      const noon = solarNoon(40.9018, -74.5204, day);
      expect(Math.abs(noon.az - 180)).toBeLessThan(1.5);
    }
  });

  it("matches the expected noon elevation 90 − lat + declination at the June solstice", () => {
    const noon = solarNoon(40.9018, -74.5204, Date.UTC(2026, 5, 21));
    // declination ≈ +23.44°, plus ~0.02° refraction at this elevation
    expect(noon.el).toBeCloseTo(90 - 40.9018 + 23.44, 0);
  });

  it("elevation is negative at local solar midnight", () => {
    for (const [lat, lon, day] of [
      [40.9018, -74.5204, Date.UTC(2026, 5, 21)],
      [40.9018, -74.5204, Date.UTC(2026, 11, 21)],
      [0, 0, Date.UTC(2024, 2, 20)],
    ]) {
      const noon = solarNoon(lat, lon, day);
      const midnight = solarPosition(lat, lon, noon.t + 12 * 60 * MIN);
      expect(midnight.elevationDeg).toBeLessThan(0);
    }
  });

  it("sun rises in the east and sets in the west", () => {
    // 6:30 EDT = 10:30 UTC; 19:30 EDT = 23:30 UTC on June 21
    const am = solarPosition(40.9018, -74.5204, Date.UTC(2026, 5, 21, 10, 30));
    const pm = solarPosition(40.9018, -74.5204, Date.UTC(2026, 5, 21, 23, 30));
    expect(am.azimuthDeg).toBeGreaterThan(45);
    expect(am.azimuthDeg).toBeLessThan(90);
    expect(pm.azimuthDeg).toBeGreaterThan(270);
    expect(pm.azimuthDeg).toBeLessThan(315);
  });

  it("refraction is ~0.5° at the horizon and vanishes overhead", () => {
    expect(refractionCorrectionDeg(0)).toBeCloseTo(1735 / 3600, 3);
    expect(refractionCorrectionDeg(89)).toBe(0);
    expect(refractionCorrectionDeg(45)).toBeLessThan(0.02);
  });
});
