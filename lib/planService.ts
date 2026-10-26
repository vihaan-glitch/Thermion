/** Server-side assembly for /plan and its CSV export. */
import { getDb } from "./db";
import { planPeriod, type PlanClass, type PlanResult, type PlanRoom } from "./reassign";
import { getSchool, listClasses } from "./repo";
import { buildForecast, type RoomForecast } from "./roomModel";
import { parseScenario, type ScenarioId } from "./scenario";
import { PERIOD_COUNT, PERIOD_MIN, periodLabel, periodWindow } from "./schedule";
import { DAY_MS, HOUR_MS, startOfLocalDay } from "./time";
import type { ClassRow, Room, School } from "./types";
import { loadWeather, type WeatherStatus } from "./weather";

export const DEFAULT_MOVE_PENALTY = 20;

export interface PlanParams {
  scenario: ScenarioId;
  day: 1 | 2 | null;
  period: number | null;
  movePenalty: number;
  riskSigmas: 0 | 1;
}

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export function parsePlanParams(sp: SP): PlanParams {
  const day = Number(one(sp.day));
  const period = Number(one(sp.period));
  const penalty = Number(one(sp.penalty));
  return {
    scenario: parseScenario(one(sp.scenario)),
    day: day === 1 || day === 2 ? day : null,
    period: Number.isInteger(period) && period >= 1 && period <= PERIOD_COUNT ? period : null,
    movePenalty: Number.isFinite(penalty) && penalty >= 0 && penalty <= 1000 ? penalty : DEFAULT_MOVE_PENALTY,
    riskSigmas: one(sp.risk) === "1" ? 1 : 0,
  };
}

export interface PlanRoomView extends PlanRoom {
  room: Room;
}

export interface PeriodSummary {
  period: number;
  label: string;
  classCount: number;
  available: boolean;
  exposureBefore: number | null;
  exposureAfter: number | null;
}

export interface PlanView {
  school: School;
  params: PlanParams & { day: 1 | 2; period: number };
  dayMs: number;
  dayOptions: { day: 1 | 2; dayMs: number }[];
  weatherStatus: WeatherStatus;
  weatherMessage: string | null;
  periodLabel: string;
  classes: ClassRow[];
  rooms: PlanRoomView[] | null;
  result: PlanResult | null;
  unavailableReason: string | null;
  summaries: PeriodSummary[];
}

function roomsForPeriod(forecast: RoomForecast[], startMs: number, endMs: number): PlanRoomView[] | null {
  const out: PlanRoomView[] = [];
  for (const f of forecast) {
    let best: (typeof f.points)[number] | null = null;
    for (const p of f.points) {
      if (p.t < startMs || p.t > endMs) continue;
      if (!best || p.heatIndexF > best.heatIndexF) best = p;
    }
    if (!best) return null;
    out.push({
      id: f.room.id,
      room_number: f.room.room_number,
      capacity: f.room.capacity,
      is_lab: f.room.is_lab,
      peakHeatIndexF: best.heatIndexF,
      peakHiSdF: best.hiSdF ?? 0,
      room: f.room,
    });
  }
  return out;
}

const toPlanClass = (c: ClassRow): PlanClass => ({
  id: c.id,
  name: c.name,
  enrollment: c.enrollment,
  needs_lab: c.needs_lab,
  assigned_room_id: c.assigned_room_id,
});

export async function computePlan(params: PlanParams): Promise<PlanView | null> {
  const db = getDb();
  const school = getSchool(db);
  if (!school) return null;
  const nowMs = Date.now();
  const dayStart = startOfLocalDay(nowMs, school.tz);
  const weather = await loadWeather(db, school, { fromMs: dayStart, toMs: dayStart + 2 * DAY_MS, nowMs });
  const fc = buildForecast(db, school, params.scenario, nowMs, weather.series);
  const dayOptions: PlanView["dayOptions"] = [
    { day: 1, dayMs: fc.window.day1Ms },
    { day: 2, dayMs: fc.window.day2Ms },
  ];

  const allClasses = listClasses(db, school.id);
  const opts = { movePenalty: params.movePenalty, periodHours: PERIOD_MIN / 60, riskSigmas: params.riskSigmas };

  const evaluate = (dayMs: number, period: number) => {
    const w = periodWindow(period, dayMs + 12 * HOUR_MS, school.tz);
    const classes = allClasses.filter((c) => c.period === period);
    const rooms = w.endMs <= fc.window.startMs ? null : roomsForPeriod(fc.rooms, w.startMs, w.endMs);
    const result = rooms ? planPeriod(classes.map(toPlanClass), rooms, opts) : null;
    return { classes, rooms, result };
  };

  // Default to tomorrow once today's last period has passed.
  const day =
    params.day ??
    (periodWindow(PERIOD_COUNT, fc.window.day1Ms + 12 * HOUR_MS, school.tz).endMs <= fc.window.startMs ? 2 : 1);
  const dayMs = day === 1 ? fc.window.day1Ms : fc.window.day2Ms;

  const summaries: PeriodSummary[] = [];
  for (let p = 1; p <= PERIOD_COUNT; p++) {
    const e = evaluate(dayMs, p);
    summaries.push({
      period: p,
      label: periodLabel(p),
      classCount: e.classes.length,
      available: e.rooms != null,
      exposureBefore: e.result?.feasible ? e.result.exposureBefore : null,
      exposureAfter: e.result?.feasible ? e.result.exposureAfter : null,
    });
  }

  // Default period: the one with the most exposure to remove, else the first with classes.
  const period =
    params.period ??
    [...summaries].filter((s) => s.available && s.classCount > 0).sort((a, b) => (b.exposureBefore ?? 0) - (a.exposureBefore ?? 0))[0]
      ?.period ??
    1;

  const chosen = evaluate(dayMs, period);
  return {
    school,
    params: { ...params, day, period },
    dayMs,
    dayOptions,
    weatherStatus: weather.status,
    weatherMessage: weather.message,
    periodLabel: periodLabel(period),
    classes: chosen.classes,
    rooms: chosen.rooms,
    result: chosen.result,
    unavailableReason: chosen.rooms ? null : "This period has already ended, so there is no forward prediction for it.",
    summaries,
  };
}

function csvCell(v: string | number | boolean | null): string {
  if (v == null) return "";
  const s = typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function planToCsv(view: PlanView): string {
  const header = [
    "date",
    "period",
    "period_time",
    "class",
    "enrollment",
    "needs_lab",
    "current_room",
    "current_peak_heat_index_f",
    "current_heat_index_2sigma_f",
    "recommended_room",
    "recommended_peak_heat_index_f",
    "recommended_heat_index_2sigma_f",
    "moved",
    "exposure_before_student_deg_hours",
    "exposure_after_student_deg_hours",
  ];
  const lines = [header.join(",")];
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: view.school.tz }).format(view.dayMs + 12 * HOUR_MS);
  const roomById = new Map((view.rooms ?? []).map((r) => [r.id, r]));
  const hours = PERIOD_MIN / 60;
  if (view.result?.feasible) {
    for (const row of view.result.rows) {
      const from = row.fromRoomId != null ? roomById.get(row.fromRoomId) : undefined;
      const to = roomById.get(row.toRoomId)!;
      const cls = view.classes.find((c) => c.id === row.classId)!;
      lines.push(
        [
          date,
          view.params.period,
          view.periodLabel,
          row.className,
          row.enrollment,
          cls.needs_lab,
          from?.room_number ?? "",
          from ? from.peakHeatIndexF : null,
          from ? 2 * from.peakHiSdF : null,
          to.room_number,
          to.peakHeatIndexF,
          2 * to.peakHiSdF,
          row.moved,
          row.exposureBefore != null ? row.exposureBefore * hours : null,
          row.exposureAfter * hours,
        ]
          .map(csvCell)
          .join(","),
      );
    }
  }
  // Leading BOM so Excel opens the UTF-8 file (en dashes, °) correctly.
  return "\uFEFF" + lines.join("\n") + "\n";
}
