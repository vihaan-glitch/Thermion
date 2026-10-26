/**
 * Extended Kalman filter per room. Pure functions; 3×3 matrix math written
 * out by hand (no linear-algebra library).
 *
 * State   x = [T, k, a]
 *           T  indoor temperature, °F
 *           k  invRC, 1/h          (inverse thermal time constant)
 *           a  alpha, °F/h per W   (solar coupling)
 *
 * Process model: one forward-Euler step of the thermal model (thermal.ts),
 *
 *   T' = T + Δt·( k·(T_d − T) + a·Q )
 *   k' = k            (random walk: + process noise)
 *   a' = a            (random walk: + process noise)
 *
 * where T_d is the drive temperature (outdoor air, or the AC setpoint) and Q
 * the solar power on the windows at that step. Because k and a are part of
 * the state and correlated with T through the dynamics, every temperature
 * report also updates the filter's belief about the room's thermal
 * parameters: the filter LEARNS each room.
 *
 * Jacobian F = ∂x'/∂x, derived analytically from the Euler step:
 *
 *   ∂T'/∂T = 1 + Δt·(−k)         = 1 − Δt·k
 *   ∂T'/∂k = Δt·(T_d − T)         (the step is linear in k with that slope)
 *   ∂T'/∂a = Δt·Q                 (linear in a with slope Q)
 *   ∂k'/∂x = [0, 1, 0],  ∂a'/∂x = [0, 0, 1]
 *
 *       ⎡ 1 − Δt·k   Δt·(T_d − T)   Δt·Q ⎤
 *   F = ⎢    0            1           0   ⎥
 *       ⎣    0            0           1   ⎦
 *
 * The model is bilinear (k·T, a·Q), so the EKF linearization is exact in each
 * variable separately; the only approximation is dropping the k–T cross term.
 *
 * Measurement model: a report observes T directly, z = H·x + v, H = [1, 0, 0],
 * v ~ N(0, R) with R depending on who reported (see MEASUREMENT_SD_F).
 *
 * Outlier gating: normalized innovation squared NIS = y²/S, S = H·P·Hᵀ + R.
 * Reports with NIS > χ²₁(0.99) = 6.635 are rejected and logged.
 */
import { DEFAULT_ALPHA, DEFAULT_INV_RC_AC, DEFAULT_INV_RC_NO_AC, STEP_HOURS, driveAt, spinUpInitialF, type ThermalParams, type ThermalRoom } from "./thermal";
import type { ReporterRole } from "./types";
import type { WeatherSample } from "./weatherSeries";

export type Vec3 = [number, number, number];
export type Mat3 = [Vec3, Vec3, Vec3];

// ---------------------------------------------------------------------------
// 3×3 linear algebra
// ---------------------------------------------------------------------------

export function matMul(A: Mat3, B: Mat3): Mat3 {
  const C: Mat3 = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) C[i][j] = A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j];
  return C;
}

export function transpose(A: Mat3): Mat3 {
  return [
    [A[0][0], A[1][0], A[2][0]],
    [A[0][1], A[1][1], A[2][1]],
    [A[0][2], A[1][2], A[2][2]],
  ];
}

export function matAdd(A: Mat3, B: Mat3): Mat3 {
  return A.map((row, i) => row.map((v, j) => v + B[i][j])) as Mat3;
}

export function diag(a: number, b: number, c: number): Mat3 {
  return [
    [a, 0, 0],
    [0, b, 0],
    [0, 0, c],
  ];
}

/** Average with the transpose to remove round-off asymmetry. */
export function symmetrize(P: Mat3): Mat3 {
  return P.map((row, i) => row.map((v, j) => (v + P[j][i]) / 2)) as Mat3;
}

// ---------------------------------------------------------------------------
// Tuning (assumptions; see README)
// ---------------------------------------------------------------------------

/** Process noise spectral densities (variance growth per hour). */
export const PROCESS_NOISE = {
  /** Unmodeled indoor heat (occupants, doors, fans): (0.7 °F)² per hour. */
  qT: 0.5,
  /** invRC random walk: drifts ~0.05 /h over a day (windows opened, fans). */
  qInvRC: 0.05 ** 2 / 24,
  /** alpha random walk: drifts ~1e-4 over a day (blinds, seasons). */
  qAlpha: 1e-4 ** 2 / 24,
};

/**
 * Report noise standard deviation by role. Teachers and staff typically read
 * a wall thermostat or a calibrated classroom thermometer; students more
 * often report phone-app or handheld readings taken near a window or in sun,
 * so their reports are trusted half as much (twice the standard deviation).
 */
export const MEASUREMENT_SD_F: Record<ReporterRole, number> = {
  teacher: 1.0,
  staff: 1.0,
  student: 2.0,
};

/** χ² 99th percentile, 1 degree of freedom. */
export const CHI2_1DOF_99 = 6.634896601021214;

/** Prior uncertainty of the physics defaults (1σ). */
export const PRIOR_SD = {
  T: 3,
  invRCNoAc: 0.25,
  invRCAc: 0.6,
  alpha: 6e-4,
};

/** Parameters are physically positive; the filter is clamped to these floors. */
const MIN_INV_RC = 0.02;
const MIN_ALPHA = 0;

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

export interface KalmanState {
  /** Instant the state refers to, UTC ms. */
  t: number;
  x: Vec3;
  P: Mat3;
}

export interface Site {
  lat: number;
  lon: number;
}

function thermalParams(site: Site, x: Vec3): ThermalParams {
  return { invRC: x[1], alpha: x[2], lat: site.lat, lon: site.lon };
}

/** One EKF predict step of length dtH hours. */
export function predictStep(state: KalmanState, room: ThermalRoom, site: Site, series: WeatherSample[], dtH: number): KalmanState {
  const [T, k, a] = state.x;
  const d = driveAt(room, series, state.t, thermalParams(site, state.x));

  const Tn = T + dtH * (k * (d.tDriveF - T) + a * d.solarW);
  const F: Mat3 = [
    [1 - dtH * k, dtH * (d.tDriveF - T), dtH * d.solarW],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const Q = diag(PROCESS_NOISE.qT * dtH, PROCESS_NOISE.qInvRC * dtH, PROCESS_NOISE.qAlpha * dtH);
  const P = symmetrize(matAdd(matMul(matMul(F, state.P), transpose(F)), Q));
  return { t: state.t + dtH * 3_600_000, x: [Tn, k, a], P };
}

/** Propagate to `toMs` in 5-minute steps (the last step may be shorter). */
export function propagate(state: KalmanState, toMs: number, room: ThermalRoom, site: Site, series: WeatherSample[]): KalmanState {
  let s = state;
  const stepMs = STEP_HOURS * 3_600_000;
  while (s.t < toMs - 1) {
    const dt = Math.min(stepMs, toMs - s.t);
    s = predictStep(s, room, site, series, dt / 3_600_000);
  }
  return s;
}

/** Physics-default prior with parameter uncertainty, at time `t`. */
export function defaultPrior(room: ThermalRoom, site: Site, series: WeatherSample[], t: number): KalmanState {
  const k = room.has_ac ? DEFAULT_INV_RC_AC : DEFAULT_INV_RC_NO_AC;
  const sdK = room.has_ac ? PRIOR_SD.invRCAc : PRIOR_SD.invRCNoAc;
  const T0 = spinUpInitialF(room, series, t, { invRC: k, alpha: DEFAULT_ALPHA, lat: site.lat, lon: site.lon });
  return { t, x: [T0, k, DEFAULT_ALPHA], P: diag(PRIOR_SD.T ** 2, sdK ** 2, PRIOR_SD.alpha ** 2) };
}

/**
 * Prior for a room at time `t`: start at t − 24 h (from the physics defaults,
 * or from previously learned parameters), and propagate 24 h. The spin-up
 * builds the T–parameter correlations that let the very first report inform
 * invRC and alpha, and gives T a physically consistent starting value.
 */
export function priorAt(
  room: ThermalRoom,
  site: Site,
  series: WeatherSample[],
  t: number,
  learned?: { x: Vec3; P: Mat3 },
): KalmanState {
  const t0 = t - 24 * 3_600_000;
  const base = defaultPrior(room, site, series, t0);
  if (learned) {
    base.x = [base.x[0], learned.x[1], learned.x[2]];
    base.P = [
      [base.P[0][0], 0, 0],
      [0, learned.P[1][1], learned.P[1][2]],
      [0, learned.P[2][1], learned.P[2][2]],
    ];
  }
  return propagate(base, t, room, site, series);
}

export type UpdateReason = "accepted" | "corroborated" | "outlier";

export interface UpdateResult {
  state: KalmanState;
  accepted: boolean;
  reason: UpdateReason;
  predictedF: number;
  predictedSdF: number;
  innovationF: number;
  /** Innovation variance S = P_TT + R. */
  S: number;
  /** Normalized innovation squared y²/S. */
  nis: number;
}

/**
 * Measurement update for a report z (°F) with noise variance R.
 *
 * Gating: NIS > χ²₁(0.99) rejects the report, unless `recentRejected`
 * contains an earlier rejected report that agrees with this one
 * (|z − z_prev| ≤ 3·√(R + R_prev)). Two independent reports that agree with
 * each other but not with the model say the model is wrong, not the
 * reporters; the filter then inflates its temperature variance so the
 * innovation is plausible (NIS = 1) and accepts ("corroborated"). Without
 * this, a room the physics badly under-predicts could never be corrected.
 */
export function update(state: KalmanState, z: number, R: number, recentRejected: { z: number; R: number }[] = []): UpdateResult {
  const predictedF = state.x[0];
  const y = z - predictedF;
  let P = state.P;
  let S = P[0][0] + R;
  const nis = (y * y) / S;
  const predictedSdF = Math.sqrt(P[0][0]);

  let reason: UpdateReason = "accepted";
  if (nis > CHI2_1DOF_99) {
    const agrees = recentRejected.some((r) => Math.abs(z - r.z) <= 3 * Math.sqrt(R + r.R));
    if (!agrees) {
      return { state, accepted: false, reason: "outlier", predictedF, predictedSdF, innovationF: y, S, nis };
    }
    reason = "corroborated";
    const inflate = Math.max(0, y * y - R - P[0][0]);
    P = P.map((row) => [...row]) as Mat3;
    P[0][0] += inflate;
    S = P[0][0] + R;
  }

  // K = P Hᵀ / S, with H = [1, 0, 0] so P Hᵀ is P's first column.
  const K: Vec3 = [P[0][0] / S, P[1][0] / S, P[2][0] / S];
  const x: Vec3 = [state.x[0] + K[0] * y, state.x[1] + K[1] * y, state.x[2] + K[2] * y];

  // Joseph form: P⁺ = (I − K H) P (I − K H)ᵀ + K R Kᵀ  (stays symmetric PSD).
  const IKH: Mat3 = [
    [1 - K[0], 0, 0],
    [-K[1], 1, 0],
    [-K[2], 0, 1],
  ];
  const KRKt: Mat3 = [
    [K[0] * K[0] * R, K[0] * K[1] * R, K[0] * K[2] * R],
    [K[1] * K[0] * R, K[1] * K[1] * R, K[1] * K[2] * R],
    [K[2] * K[0] * R, K[2] * K[1] * R, K[2] * K[2] * R],
  ];
  const Pn = symmetrize(matAdd(matMul(matMul(IKH, P), transpose(IKH)), KRKt));

  x[1] = Math.max(MIN_INV_RC, x[1]);
  x[2] = Math.max(MIN_ALPHA, x[2]);

  return { state: { t: state.t, x, P: Pn }, accepted: true, reason, predictedF, predictedSdF, innovationF: y, S, nis };
}

export interface TrackPoint {
  t: number;
  meanF: number;
  sdF: number;
}

/**
 * Prediction track over [startMs, endMs] sampled every `everyMin` minutes.
 * `anchors` are posterior states (sorted by t): the track propagates from the
 * latest anchor at or before each instant and jumps to the next anchor when
 * it is reached, which is where accepted reports visibly tighten the band.
 */
export function trackWithAnchors(
  initial: KalmanState,
  anchors: KalmanState[],
  room: ThermalRoom,
  site: Site,
  series: WeatherSample[],
  startMs: number,
  endMs: number,
  everyMin = 15,
): TrackPoint[] {
  const pending = anchors.filter((a) => a.t > initial.t).sort((a, b) => a.t - b.t);
  let s = initial;
  if (s.t < startMs) {
    // Jump through any anchors before the window first.
    while (pending.length && pending[0].t <= startMs) s = pending.shift()!;
    s = propagate(s, startMs, room, site, series);
  }
  const out: TrackPoint[] = [];
  const everyMs = everyMin * 60_000;
  for (let t = Math.max(startMs, s.t); t <= endMs; t += everyMs) {
    while (pending.length && pending[0].t <= t) {
      const a = pending.shift()!;
      s = propagate(s, a.t, room, site, series);
      out.push({ t: a.t, meanF: s.x[0], sdF: Math.sqrt(s.P[0][0]) }); // just before the update
      s = a;
      out.push({ t: a.t, meanF: s.x[0], sdF: Math.sqrt(s.P[0][0]) }); // just after
    }
    s = propagate(s, t, room, site, series);
    out.push({ t, meanF: s.x[0], sdF: Math.sqrt(Math.max(0, s.P[0][0])) });
  }
  return out;
}

export function serializeState(s: KalmanState): { t_indoor: number; inv_rc: number; alpha: number; cov_json: string; updated_at: string } {
  return {
    t_indoor: s.x[0],
    inv_rc: s.x[1],
    alpha: s.x[2],
    cov_json: JSON.stringify(s.P),
    updated_at: new Date(s.t).toISOString(),
  };
}

export function deserializeState(row: { t_indoor: number; inv_rc: number; alpha: number; cov_json: string; updated_at: string }): KalmanState {
  return { t: Date.parse(row.updated_at), x: [row.t_indoor, row.inv_rc, row.alpha], P: JSON.parse(row.cov_json) as Mat3 };
}
