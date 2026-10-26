import { describe, expect, it } from "vitest";
import {
  CHI2_1DOF_99,
  MEASUREMENT_SD_F,
  diag,
  matMul,
  predictStep,
  priorAt,
  propagate,
  trackWithAnchors,
  transpose,
  update,
  type KalmanState,
  type Mat3,
} from "@/lib/kalman";
import { eulerStep, simulateDay, driveAt, type ThermalRoom } from "@/lib/thermal";
import { syntheticDay, type WeatherSample } from "@/lib/weatherSeries";

const SITE = { lat: 40.9018, lon: -74.5204 };
const TZ = "America/New_York";
const DAY0 = Date.UTC(2026, 5, 15, 4);
const H = 3_600_000;

function weather(days: number): WeatherSample[] {
  const out: WeatherSample[] = [];
  for (let d = -1; d < days; d++) {
    const hi = 88 + 4 * Math.sin(d * 1.7); // vary day to day for excitation
    out.push(...syntheticDay(DAY0 + d * 24 * H, TZ, { lowF: hi - 18, highF: hi, rhAtLowPct: 80, rhAtHighPct: 45, skyCoverPct: d % 2 ? 20 : 0 }));
  }
  return out;
}

/** Deterministic Gaussian noise (mulberry32 + Box-Muller). */
function rng(seed: number) {
  let a = seed;
  const u = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u());
}

const room: ThermalRoom = { orientation: "SW", window_area_m2: 10, has_ac: false };
const TRUE_INV_RC = 0.5;
const TRUE_ALPHA = 8e-4;

function runFilter(nObs: number, spacingH = 2.5) {
  const series = weather(Math.ceil((nObs * spacingH) / 24) + 2);
  const truth = simulateDay(room, series, { invRC: TRUE_INV_RC, alpha: TRUE_ALPHA, lat: SITE.lat, lon: SITE.lon }, { startMs: DAY0, endMs: DAY0 + (nObs * spacingH + 6) * H });
  const truthAt = (t: number) => truth.reduce((best, p) => (Math.abs(p.t - t) < Math.abs(best.t - t) ? p : best)).tIndoorF;
  const noise = rng(42);
  let s: KalmanState = priorAt(room, SITE, series, DAY0);
  for (let i = 1; i <= nObs; i++) {
    const t = DAY0 + Math.round(i * spacingH * 12) * 5 * 60_000;
    s = propagate(s, t, room, SITE, series);
    const z = truthAt(t) + noise() * MEASUREMENT_SD_F.teacher;
    s = update(s, z, MEASUREMENT_SD_F.teacher ** 2).state;
  }
  return { s, series, truthAt };
}

describe("3×3 matrix helpers", () => {
  it("multiplies and transposes", () => {
    const A: Mat3 = [
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 10],
    ];
    expect(matMul(A, diag(1, 1, 1))).toEqual(A);
    expect(transpose(transpose(A))).toEqual(A);
    expect(matMul(A, A)[0]).toEqual([30, 36, 45]);
  });
});

describe("EKF Jacobian", () => {
  it("matches finite differences of the Euler step", () => {
    const series = weather(1);
    const t = DAY0 + 15 * H;
    const x: [number, number, number] = [85, 0.4, 9e-4];
    const dt = 5 / 60;
    const d = driveAt(room, series, t, { invRC: x[1], alpha: x[2], lat: SITE.lat, lon: SITE.lon });
    const f = (T: number, k: number, a: number) => eulerStep(T, k, a, d.tDriveF, d.solarW, dt);
    // P = identity lets us read F·Fᵀ; instead compare predicted mean and F via a unit-P step.
    const s = predictStep({ t, x, P: diag(0, 0, 0) }, room, SITE, series, dt);
    expect(s.x[0]).toBeCloseTo(f(...x), 10);

    const eps = [1e-4, 1e-6, 1e-9];
    const numeric = [0, 1, 2].map((j) => {
      const xp = [...x] as [number, number, number];
      const xm = [...x] as [number, number, number];
      xp[j] += eps[j];
      xm[j] -= eps[j];
      return (f(...xp) - f(...xm)) / (2 * eps[j]);
    });
    const analytic = [1 - dt * x[1], dt * (d.tDriveF - x[0]), dt * d.solarW];
    for (let j = 0; j < 3; j++) expect(numeric[j]).toBeCloseTo(analytic[j], 4);

    // With P = e_j e_jᵀ the propagated P[0][0] equals F[0][j]² (+ process noise).
    for (let j = 0; j < 3; j++) {
      const P = diag(j === 0 ? 1 : 0, j === 1 ? 1 : 0, j === 2 ? 1 : 0);
      const out = predictStep({ t, x, P }, room, SITE, series, dt);
      const q = out.P[0][0] - analytic[j] ** 2;
      expect(q).toBeGreaterThanOrEqual(-1e-9);
      expect(q).toBeLessThan(0.1);
    }
  });
});

describe("EKF learning", () => {
  it("converges to within 20% of the true invRC after 20 observations", () => {
    const { s } = runFilter(20);
    expect(Math.abs(s.x[1] - TRUE_INV_RC) / TRUE_INV_RC).toBeLessThan(0.2);
    // and it is confident about it
    expect(Math.sqrt(s.P[1][1])).toBeLessThan(0.15);
  });

  it("parameter uncertainty shrinks as reports arrive", () => {
    const series = weather(2);
    const prior = priorAt(room, SITE, series, DAY0);
    const { s } = runFilter(10);
    expect(s.P[1][1]).toBeLessThan(prior.P[1][1]);
    expect(s.P[2][2]).toBeLessThan(prior.P[2][2]);
  });

  it("rejects a single 130 °F garbage report and leaves the estimate unchanged", () => {
    const { s } = runFilter(20);
    const r = update(s, 130, MEASUREMENT_SD_F.student ** 2);
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe("outlier");
    expect(r.nis).toBeGreaterThan(CHI2_1DOF_99);
    expect(Math.abs(r.state.x[0] - s.x[0])).toBeLessThan(1e-9);
    expect(Math.abs(r.state.x[1] - s.x[1]) / s.x[1]).toBeLessThan(0.01);
  });

  it("accepts a surprising report when an earlier rejected report corroborates it", () => {
    const { s } = runFilter(20);
    const z = s.x[0] + 15;
    const first = update(s, z, 1);
    expect(first.accepted).toBe(false);
    const second = update(s, z + 1, 1, [{ z, R: 1 }]);
    expect(second.accepted).toBe(true);
    expect(second.reason).toBe("corroborated");
    expect(second.state.x[0]).toBeGreaterThan(s.x[0] + 10);
  });

  it("weights student reports less than teacher reports", () => {
    const { s } = runFilter(8);
    const teacher = update(s, s.x[0] + 2, MEASUREMENT_SD_F.teacher ** 2);
    const student = update(s, s.x[0] + 2, MEASUREMENT_SD_F.student ** 2);
    expect(teacher.state.x[0] - s.x[0]).toBeGreaterThan(student.state.x[0] - s.x[0]);
  });
});

describe("prediction track", () => {
  it("band narrows at an accepted report and widens with time after it", () => {
    const series = weather(2);
    const prior = priorAt(room, SITE, series, DAY0);
    const tr = DAY0 + 14 * H;
    const atReport = propagate(prior, tr, room, SITE, series);
    const post = update(atReport, atReport.x[0] + 1, 1).state;
    const track = trackWithAnchors(prior, [post], room, SITE, series, DAY0, DAY0 + 30 * H, 15);
    const before = track.filter((p) => p.t === tr)[0];
    const after = track.filter((p) => p.t === tr).at(-1)!;
    expect(after.sdF).toBeLessThan(before.sdF);
    expect(after.sdF).toBeLessThanOrEqual(1);
    const later = track.at(-1)!;
    expect(later.sdF).toBeGreaterThan(after.sdF);
    // Every point carries an uncertainty.
    for (const p of track) expect(Number.isFinite(p.sdF) && p.sdF > 0).toBe(true);
  });
});
