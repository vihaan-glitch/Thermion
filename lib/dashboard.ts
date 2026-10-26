import { getDb } from "./db";
import { heatIndexF } from "./heatindex";
import { estimateIndoorRh } from "./humidity";
import { getSchool, latestReportByRoom, listReportsForSchool, listRooms, reportCountsByRoom } from "./repo";
import { classifyHeatIndex, type ThresholdState } from "./thresholds";
import { DAY_MS, HOUR_MS, startOfLocalDay } from "./time";
import type { Report, Room, School } from "./types";
import { loadWeather, type WeatherContext } from "./weather";
import { weatherAt } from "./weatherSeries";

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

export interface DashboardData {
  school: School;
  nowMs: number;
  dayStartMs: number;
  weather: Pick<WeatherContext, "status" | "message" | "fetchedAt" | "now">;
  outdoorNowHeatIndexF: number | null;
  outdoor: OutdoorPoint[];
  rows: RoomRowData[];
  reportsToday: Report[];
  hottestToday: { row: RoomRowData; report: Report } | null;
}

export async function loadDashboard(): Promise<DashboardData | null> {
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

  const n = weather.now;
  return {
    school,
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
