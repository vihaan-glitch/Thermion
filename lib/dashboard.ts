import { getDb } from "./db";
import { peakIn, predictRoom, type PredictionPoint } from "./prediction";
import { heatwaveSeries, heatwaveStartMs, type ScenarioId } from "./scenario";
import { schoolDayWindow } from "./schedule";
import { defaultParams } from "./thermal";
import { heatIndexF } from "./heatindex";
import { estimateIndoorRh } from "./humidity";
import { getSchool, latestReportByRoom, listReportsForSchool, listRooms, reportCountsByRoom } from "./repo";
import { classifyHeatIndex, type ThresholdState } from "./thresholds";
import { DAY_MS, HOUR_MS, startOfLocalDay } from "./time";
import type { Report, Room, School } from "./types";
import { loadWeather, type WeatherContext } from "./weather";
import { weatherAt, type WeatherSample } from "./weatherSeries";

/** Server-side assembly of everything the dashboard renders. */

export interface RoomRowData {
  room: Room;
  latest: Report | null;
  reportCount: number;
  latestHeatIndexF: number | null;
  latestRhPct: number | null;
  latestRhEstimated: boolean;
  latestState: ThresholdState | null;
}

export interface OutdoorPoint {
  t: number;
  tempF: number;
  heatIndexF: number | null;
}

export interface RoomPeak {
  t: number;
  indoorF: number;
  heatIndexF: number;
}

export interface RoomPrediction {
  roomId: number;
  points: PredictionPoint[];
  /** Peak heat index during school hours on day 1 / day 2 of the window. */
  peaks: [RoomPeak | null, RoomPeak | null];
}

export interface SweepDay {
  key: string;
  label: string;
  dayStartMs: number;
  /** Hourly sky cover for this day if known (forecast); otherwise clear sky is assumed. */
  sky: { t: number; skyCoverPct: number | null }[];
}

export interface DashboardData {
  school: School;
  scenario: ScenarioId;
  /** Prediction window: [startMs, endMs]; day boundaries for peak columns. */
  predWindow: { startMs: number; endMs: number; day1Ms: number; day2Ms: number };
  predOutdoor: { t: number; tempF: number }[];
  predictions: RoomPrediction[];
  sweepDays: SweepDay[];
  nowMs: number;
  dayStartMs: number;
  weather: Pick<WeatherContext, "status" | "message" | "fetchedAt" | "now">;
  outdoorNowHeatIndexF: number | null;
  outdoor: OutdoorPoint[];
  rows: RoomRowData[];
  reportsToday: Report[];
  hottestToday: { row: RoomRowData; report: Report } | null;
}

export async function loadDashboard(scenario: ScenarioId = "live"): Promise<DashboardData | null> {
  const db = getDb();
  const school = getSchool(db);
  if (!school) return null;

  const nowMs = Date.now();
  const dayStartMs = startOfLocalDay(nowMs, school.tz);
  const toMs = dayStartMs + 2 * DAY_MS;
  const weather = await loadWeather(db, school, { fromMs: dayStartMs, toMs, nowMs });

  const rooms = listRooms(db, school.id);
  const latest = latestReportByRoom(db, school.id);
  const counts = reportCountsByRoom(db, school.id);

  const rows: RoomRowData[] = rooms.map((room) => {
    const rep = latest.get(room.id) ?? null;
    if (!rep) {
      return { room, latest: null, reportCount: 0, latestHeatIndexF: null, latestRhPct: null, latestRhEstimated: false, latestState: null };
    }
    const out = weatherAt(weather.series, Date.parse(rep.reported_at));
    const rh = estimateIndoorRh({
      indoorF: rep.temp_f,
      measuredRhPct: rep.humidity_pct,
      hasAc: room.has_ac,
      outdoorF: Number.isFinite(out.tempF) ? out.tempF : null,
      outdoorRhPct: out.rhPct,
    });
    const hi = heatIndexF(rep.temp_f, rh.rhPct);
    return {
      room,
      latest: rep,
      reportCount: counts.get(room.id) ?? 0,
      latestHeatIndexF: hi,
      latestRhPct: rh.rhPct,
      latestRhEstimated: rh.estimated,
      latestState: classifyHeatIndex(hi),
    };
  });

  const reportsToday = listReportsForSchool(db, school.id, new Date(dayStartMs).toISOString());
  const latestToday = rows.filter((r) => r.latest && Date.parse(r.latest.reported_at) >= dayStartMs);
  let hottestToday: DashboardData["hottestToday"] = null;
  for (const row of latestToday) {
    if (!hottestToday || row.latest!.temp_f > hottestToday.report.temp_f) hottestToday = { row, report: row.latest! };
  }

  const outdoor: OutdoorPoint[] = weather.series
    .filter((s) => s.t >= dayStartMs && s.t < toMs)
    .map((s) => ({
      t: s.t + HOUR_MS / 2,
      tempF: s.tempF,
      heatIndexF: s.rhPct != null ? heatIndexF(s.tempF, s.rhPct) : null,
    }));

  // ---- Physics predictions -------------------------------------------------
  let predSeries: WeatherSample[];
  let day1Ms: number;
  let predStart: number;
  if (scenario === "heatwave") {
    day1Ms = heatwaveStartMs(nowMs, school.tz);
    predSeries = heatwaveSeries(day1Ms, school.tz);
    predStart = day1Ms;
  } else {
    day1Ms = dayStartMs;
    predSeries = weather.series;
    predStart = Math.max(dayStartMs, predSeries[0]?.t ?? dayStartMs);
  }
  const day2Ms = startOfLocalDay(day1Ms + DAY_MS + 2 * HOUR_MS, school.tz);
  const predEnd = startOfLocalDay(day2Ms + DAY_MS + 2 * HOUR_MS, school.tz);
  const site = { lat: school.lat, lon: school.lon };
  const sd1 = schoolDayWindow(day1Ms + 12 * HOUR_MS, school.tz);
  const sd2 = schoolDayWindow(day2Ms + 12 * HOUR_MS, school.tz);

  const predictions: RoomPrediction[] = rooms.map((room) => {
    const points = predictRoom(room, predSeries, defaultParams(room, site), { startMs: predStart, endMs: predEnd });
    const pk = (w: { startMs: number; endMs: number }): RoomPeak | null => {
      const p = peakIn(points, "heatIndexF", w.startMs, w.endMs);
      return p ? { t: p.t, indoorF: p.indoorF, heatIndexF: p.heatIndexF } : null;
    };
    return { roomId: room.id, points, peaks: [pk(sd1), pk(sd2)] };
  });
  const predOutdoor = (predictions[0]?.points ?? []).map((p) => ({ t: p.t, tempF: p.outdoorF }));

  const skyFor = (start: number) =>
    predSeries.filter((s) => s.t >= start && s.t < start + DAY_MS).map((s) => ({ t: s.t, skyCoverPct: s.skyCoverPct }));
  const fixedDay = (month: number, day: number) => {
    const y = new Date(nowMs).getUTCFullYear();
    return startOfLocalDay(Date.UTC(y, month - 1, day, 16), school.tz);
  };
  const sweepDays: SweepDay[] =
    scenario === "heatwave"
      ? [
          { key: "d1", label: "Heat wave day 1", dayStartMs: day1Ms, sky: skyFor(day1Ms) },
          { key: "d2", label: "Heat wave day 2", dayStartMs: day2Ms, sky: skyFor(day2Ms) },
        ]
      : [
          { key: "today", label: "Today", dayStartMs: day1Ms, sky: skyFor(day1Ms) },
          { key: "tomorrow", label: "Tomorrow", dayStartMs: day2Ms, sky: skyFor(day2Ms) },
          { key: "june", label: "June 18 (clear)", dayStartMs: fixedDay(6, 18), sky: [] },
          { key: "sept", label: "Sept 8 (clear)", dayStartMs: fixedDay(9, 8), sky: [] },
        ];

  const n = weather.now;
  return {
    school,
    scenario,
    predWindow: { startMs: predStart, endMs: predEnd, day1Ms, day2Ms },
    predOutdoor,
    predictions,
    sweepDays,
    nowMs,
    dayStartMs,
    weather: { status: weather.status, message: weather.message, fetchedAt: weather.fetchedAt, now: n },
    outdoorNowHeatIndexF: Number.isFinite(n.tempF) && n.rhPct != null ? heatIndexF(n.tempF, n.rhPct) : null,
    outdoor,
    rows,
    reportsToday,
    hottestToday,
  };
}
