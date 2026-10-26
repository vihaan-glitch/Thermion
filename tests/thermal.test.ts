import { describe, expect, it } from "vitest";
import { DEFAULT_INV_RC_NO_AC, defaultParams, eulerStep, simulateDay, type ThermalRoom } from "@/lib/thermal";
import { syntheticDay, type WeatherSample } from "@/lib/weatherSeries";

const SITE = { lat: 40.9018, lon: -74.5204 };
const TZ = "America/New_York";
const DAY0 = Date.UTC(2026, 6, 15, 4); // 00:00 EDT

function hotDays(n: number): WeatherSample[] {
  const out: WeatherSample[] = [];
  for (let d = 0; d < n; d++)
    out.push(...syntheticDay(DAY0 + d * 86_400_000, TZ, { lowF: 72, highF: 92, rhAtLowPct: 80, rhAtHighPct: 45, skyCoverPct: 0 }));
  return out;
}

const localHour = (t: number) => ((t - DAY0) / 3_600_000) % 24;

describe("eulerStep", () => {
  it("relaxes toward the drive temperature with time constant 1/invRC", () => {
    let T = 60;
    for (let k = 0; k < 12 * 3; k++) T = eulerStep(T, 1 / 3, 0, 90, 0, 1 / 12); // 3 hours
    // exact: 90 - 30 e^-1 = 78.96; Euler at Δt=5 min is within 0.25 °F (0.8% of the 30 °F step)
    expect(T).toBeCloseTo(90 - 30 * Math.exp(-1), 0);
    expect(Math.abs(T - (90 - 30 * Math.exp(-1)))).toBeLessThan(0.25);
  });

  it("solar gain raises the equilibrium by alpha·Q/invRC", () => {
    let T = 80;
    for (let k = 0; k < 12 * 48; k++) T = eulerStep(T, 0.5, 1e-3, 80, 4000, 1 / 12);
    expect(T).toBeCloseTo(80 + (1e-3 * 4000) / 0.5, 3);
  });

  it("stays stable and monotone for a stiff time constant via sub-stepping", () => {
    const T = eulerStep(60, 50, 0, 90, 0, 1 / 12);
    expect(T).toBeGreaterThan(60);
    expect(T).toBeLessThanOrEqual(90 + 1e-9);
  });
});

describe("simulateDay", () => {
  const weather = hotDays(2);
  const sw: ThermalRoom = { orientation: "SW", window_area_m2: 11, has_ac: false };
  const n: ThermalRoom = { orientation: "N", window_area_m2: 6, has_ac: false };
  const ac: ThermalRoom = { orientation: "SW", window_area_m2: 11, has_ac: true };

  it("returns 5-minute samples across the forecast span", () => {
    const sim = simulateDay(sw, weather, defaultParams(sw, SITE));
    expect(sim[1].t - sim[0].t).toBe(5 * 60_000);
    expect(sim.length).toBe(48 * 12 + 1);
  });

  it("indoor peak lags the outdoor peak for a non-AC room", () => {
    const sim = simulateDay(n, weather, defaultParams(n, SITE)).filter((p) => p.t >= DAY0 + 86_400_000);
    const peak = sim.reduce((a, b) => (b.tIndoorF > a.tIndoorF ? b : a));
    // Outdoor max is at 15:00; a τ = 3 h room peaks later.
    expect(localHour(peak.t)).toBeGreaterThan(15.5);
  });

  it("a sunny SW room runs hotter than a north room and hotter than outdoor", () => {
    const pSw = simulateDay(sw, weather, defaultParams(sw, SITE));
    const pN = simulateDay(n, weather, defaultParams(n, SITE));
    const maxSw = Math.max(...pSw.map((p) => p.tIndoorF));
    const maxN = Math.max(...pN.map((p) => p.tIndoorF));
    expect(maxSw).toBeGreaterThan(maxN + 3);
    expect(maxSw).toBeGreaterThan(92);
  });

  it("an AC room stays near its setpoint", () => {
    const sim = simulateDay(ac, weather, defaultParams(ac, SITE));
    for (const p of sim) {
      expect(p.tIndoorF).toBeGreaterThan(71);
      expect(p.tIndoorF).toBeLessThan(80);
    }
  });

  it("uses the documented ~3 h default time constant for non-AC rooms", () => {
    expect(1 / DEFAULT_INV_RC_NO_AC).toBe(3);
  });
});
