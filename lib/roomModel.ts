/**
 * Server-side glue between SQLite and the pure physics/filter modules:
 *  - recordReport: insert a report and run the Kalman update (persisting
 *    room_state and the filter_log audit row) in one transaction.
 *  - buildForecast: per-room filtered predictions with uncertainty for the
 *    dashboard and the planner.
 */
import type { DB } from "./db";
import {
  MEASUREMENT_SD_F,
  deserializeState,
  priorAt,
  propagate,
  serializeState,
  update,
  type KalmanState,
  type Mat3,
  type UpdateResult,
  type Vec3,
} from "./kalman";
import { peakIn, predictRoomFiltered, type PredictionPoint } from "./prediction";
import {
  filterLogForSchool,
  getRoomState,
  insertFilterLog,
  insertReport,
  listRoomStates,
  listRooms,
  recentRejections,
  upsertRoomState,
  weatherHours,
  type FilterLogRow,
  type NewReport,
} from "./repo";
import { heatwaveSeries, heatwaveStartMs, type ScenarioId } from "./scenario";
import { schoolDayWindow } from "./schedule";
import { DAY_MS, HOUR_MS, startOfLocalDay } from "./time";
import type { Report, Room, School } from "./types";
import { climatologySeries, normalizeSeries, type WeatherSample } from "./weatherSeries";

/** Logged forecast hours over [fromMs, toMs]; climatology only outside the logged span. */
export function loggedSeries(db: DB, school: School, fromMs: number, toMs: number): WeatherSample[] {
  const logged = weatherHours(db, school.id, fromMs, toMs);
  const days = Math.ceil((toMs - fromMs) / DAY_MS) + 1;
  if (logged.length === 0) return climatologySeries(fromMs, days, school.tz);
  const first = logged[0].t;
  const last = logged[logged.length - 1].t;
  const clim = climatologySeries(fromMs, days, school.tz).filter((s) => s.t < first || s.t > last);
  return normalizeSeries([...clim, ...logged]);
}

/** States older than this are not propagated hour by hour; their learned parameters seed a fresh prior. */
const MAX_PROPAGATION_MS = 3 * DAY_MS;
/** A rejected report can corroborate a later one within this window. */
const CORROBORATION_WINDOW_MS = 12 * HOUR_MS;

export interface RecordedReport {
  report: Report;
  outcome: UpdateResult;
}

export function recordReport(db: DB, school: School, room: Room, input: NewReport): RecordedReport {
  return db.transaction((): RecordedReport => {
    const report = insertReport(db, input);
    const t = Date.parse(report.reported_at);
    const site = { lat: school.lat, lon: school.lon };
    const row = getRoomState(db, room.id);
    const prev = row ? deserializeState(row) : null;

    let prior: KalmanState;
    if (prev && t >= prev.t && t - prev.t <= MAX_PROPAGATION_MS) {
      const series = loggedSeries(db, school, prev.t - 2 * HOUR_MS, t + HOUR_MS);
      prior = propagate(prev, t, room, site, series);
    } else {
      const series = loggedSeries(db, school, t - 26 * HOUR_MS, t + HOUR_MS);
      prior = priorAt(room, site, series, t, prev ?? undefined);
    }

    const R = MEASUREMENT_SD_F[report.reporter_role] ** 2;
    const rejected = recentRejections(db, room.id, new Date(t - CORROBORATION_WINDOW_MS).toISOString()).map((r) => ({
      z: r.observed_f,
      R: r.measurement_var,
    }));
    const outcome = update(prior, report.temp_f, R, rejected);

    upsertRoomState(db, { room_id: room.id, ...serializeState(outcome.state) });
    insertFilterLog(db, {
      report_id: report.id,
      room_id: room.id,
      accepted: outcome.accepted ? 1 : 0,
      reason: outcome.reason,
      observed_f: report.temp_f,
      predicted_f: outcome.predictedF,
      predicted_sd_f: outcome.predictedSdF,
      innovation_f: outcome.innovationF,
      nis: outcome.nis,
      measurement_var: R,
      state_after_json: JSON.stringify(outcome.state),
      created_at: report.reported_at,
    });
    return { report, outcome };
  })();
}

// ---------------------------------------------------------------------------

export interface RoomPeak {
  t: number;
  indoorF: number;
  sdF: number;
  heatIndexF: number;
  hiSdF: number;
}

export interface RoomForecast {
  room: Room;
  points: PredictionPoint[];
  /** Peak heat index during school hours on day 1 / day 2. */
  peaks: [RoomPeak | null, RoomPeak | null];
  /** Current persisted filter state, if the room has ever been reported. */
  state: KalmanState | null;
  /** Physics-default prior at the window start, for "how much did reports help" comparisons. */
  priorPeakSd: [number | null, number | null];
  reportCount: number;
  rejectedCount: number;
  logs: FilterLogRow[];
}

export interface ForecastBundle {
  scenario: ScenarioId;
  window: { startMs: number; endMs: number; day1Ms: number; day2Ms: number };
  series: WeatherSample[];
  rooms: RoomForecast[];
}

function parseAnchor(json: string): KalmanState {
  const o = JSON.parse(json) as { t: number; x: Vec3; P: Mat3 };
  return { t: o.t, x: o.x, P: o.P };
}

function peaksFor(points: PredictionPoint[], days: { startMs: number; endMs: number }[]): [RoomPeak | null, RoomPeak | null] {
  const pk = (w: { startMs: number; endMs: number }): RoomPeak | null => {
    const p = peakIn(points, "heatIndexF", w.startMs, w.endMs);
    return p ? { t: p.t, indoorF: p.indoorF, sdF: p.sdF ?? 0, heatIndexF: p.heatIndexF, hiSdF: p.hiSdF ?? 0 } : null;
  };
  return [pk(days[0]), pk(days[1])];
}

export function buildForecast(
  db: DB,
  school: School,
  scenario: ScenarioId,
  nowMs: number,
  liveSeries: WeatherSample[],
): ForecastBundle {
  const site = { lat: school.lat, lon: school.lon };
  const rooms = listRooms(db, school.id);
  const states = listRoomStates(db, school.id);
  const logsByRoom = new Map<number, FilterLogRow[]>();
  for (const l of filterLogForSchool(db, school.id)) {
    const arr = logsByRoom.get(l.room_id) ?? [];
    arr.push(l);
    logsByRoom.set(l.room_id, arr);
  }

  const dayStart = startOfLocalDay(nowMs, school.tz);
  const day1Ms = scenario === "heatwave" ? heatwaveStartMs(nowMs, school.tz) : dayStart;
  const day2Ms = startOfLocalDay(day1Ms + DAY_MS + 2 * HOUR_MS, school.tz);
  const endMs = startOfLocalDay(day2Ms + DAY_MS + 2 * HOUR_MS, school.tz);
  const startMs = scenario === "heatwave" ? day1Ms : Math.max(dayStart, liveSeries[0]?.t ?? dayStart);
  const schoolDays = [schoolDayWindow(day1Ms + 12 * HOUR_MS, school.tz), schoolDayWindow(day2Ms + 12 * HOUR_MS, school.tz)];

  let series: WeatherSample[];
  if (scenario === "heatwave") {
    series = heatwaveSeries(day1Ms, school.tz);
  } else {
    let earliest = startMs - 26 * HOUR_MS;
    for (const logs of logsByRoom.values()) {
      const before = logs.filter((l) => Date.parse(l.created_at) <= startMs).at(-1);
      if (before && startMs - Date.parse(before.created_at) <= MAX_PROPAGATION_MS)
        earliest = Math.min(earliest, Date.parse(before.created_at) - 2 * HOUR_MS);
    }
    series = normalizeSeries([...loggedSeries(db, school, earliest, endMs), ...liveSeries]);
  }

  const out: RoomForecast[] = rooms.map((room) => {
    const logs = logsByRoom.get(room.id) ?? [];
    const stateRow = states.get(room.id);
    const state = stateRow ? deserializeState(stateRow) : null;

    let initial: KalmanState;
    let anchors: KalmanState[] = [];
    if (scenario === "heatwave") {
      // Same physics on synthetic weather, with whatever this room's reports have taught the filter.
      initial = priorAt(room, site, series, startMs, state ?? undefined);
    } else {
      const all = logs.map((l) => parseAnchor(l.state_after_json));
      const before = all.filter((a) => a.t <= startMs).at(-1);
      if (before && startMs - before.t <= MAX_PROPAGATION_MS) initial = before;
      else initial = priorAt(room, site, series, startMs, before);
      anchors = all.filter((a) => a.t > initial.t);
    }

    const points = predictRoomFiltered(room, site, series, initial, anchors, { startMs, endMs });
    const prior = scenario === "heatwave" || logs.length === 0
      ? null
      : predictRoomFiltered(room, site, series, priorAt(room, site, series, startMs), [], { startMs, endMs });
    const priorPeaks = prior ? peaksFor(prior, schoolDays) : null;

    return {
      room,
      points,
      peaks: peaksFor(points, schoolDays),
      state,
      priorPeakSd: [priorPeaks?.[0]?.hiSdF ?? null, priorPeaks?.[1]?.hiSdF ?? null],
      reportCount: logs.length,
      rejectedCount: logs.filter((l) => l.accepted === 0).length,
      logs,
    };
  });

  return { scenario, window: { startMs, endMs, day1Ms, day2Ms }, series, rooms: out };
}
