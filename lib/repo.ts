import type { DB } from "./db";
import type { HourlyPeriod } from "./nws";
import type { ClassRow, Orientation, Report, ReporterRole, Room, School } from "./types";
import type { WeatherSample } from "./weatherSeries";

/** Data-access layer. All SQL lives here. */

interface RoomRow extends Omit<Room, "has_ac" | "is_lab"> {
  has_ac: number;
  is_lab: number;
}

const toRoom = (r: RoomRow): Room => ({ ...r, has_ac: r.has_ac === 1, is_lab: r.is_lab === 1 });

export function listSchools(db: DB): School[] {
  return db.prepare("SELECT * FROM schools ORDER BY name").all() as School[];
}

export function getSchool(db: DB, id?: number): School | null {
  const row = id
    ? db.prepare("SELECT * FROM schools WHERE id = ?").get(id)
    : db.prepare("SELECT * FROM schools ORDER BY id LIMIT 1").get();
  return (row as School | undefined) ?? null;
}

export function listRooms(db: DB, schoolId: number): Room[] {
  const rows = db
    .prepare("SELECT * FROM rooms WHERE school_id = ? ORDER BY floor, room_number")
    .all(schoolId) as RoomRow[];
  return rows.map(toRoom);
}

export function getRoom(db: DB, id: number): Room | null {
  const row = db.prepare("SELECT * FROM rooms WHERE id = ?").get(id) as RoomRow | undefined;
  return row ? toRoom(row) : null;
}

export interface NewRoom {
  school_id: number;
  room_number: string;
  building: string;
  floor: number;
  orientation: Orientation;
  window_area_m2: number;
  has_ac: boolean;
  capacity: number;
  is_lab: boolean;
}

export function findRoomByNumber(db: DB, schoolId: number, roomNumber: string): Room | null {
  const row = db
    .prepare("SELECT * FROM rooms WHERE school_id = ? AND room_number = ? COLLATE NOCASE")
    .get(schoolId, roomNumber) as RoomRow | undefined;
  return row ? toRoom(row) : null;
}

export function createRoom(db: DB, r: NewRoom): Room {
  const res = db
    .prepare(
      `INSERT INTO rooms (school_id, room_number, building, floor, orientation, window_area_m2, has_ac, capacity, is_lab)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      r.school_id,
      r.room_number,
      r.building,
      r.floor,
      r.orientation,
      r.window_area_m2,
      r.has_ac ? 1 : 0,
      r.capacity,
      r.is_lab ? 1 : 0,
    );
  return getRoom(db, Number(res.lastInsertRowid))!;
}

export interface NewReport {
  room_id: number;
  temp_f: number;
  humidity_pct: number | null;
  reported_at: string;
  reporter_role: ReporterRole;
  note: string | null;
}

export function insertReport(db: DB, r: NewReport): Report {
  const res = db
    .prepare(
      `INSERT INTO reports (room_id, temp_f, humidity_pct, reported_at, reporter_role, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(r.room_id, r.temp_f, r.humidity_pct, r.reported_at, r.reporter_role, r.note);
  return { id: Number(res.lastInsertRowid), ...r };
}

export function listReportsForSchool(db: DB, schoolId: number, sinceIso?: string): Report[] {
  return db
    .prepare(
      `SELECT r.* FROM reports r JOIN rooms m ON m.id = r.room_id
       WHERE m.school_id = ? AND (? IS NULL OR r.reported_at >= ?)
       ORDER BY r.reported_at`,
    )
    .all(schoolId, sinceIso ?? null, sinceIso ?? null) as Report[];
}

export function latestReportByRoom(db: DB, schoolId: number): Map<number, Report> {
  const rows = db
    .prepare(
      `SELECT r.* FROM reports r
       JOIN rooms m ON m.id = r.room_id
       WHERE m.school_id = ?
         AND r.id = (SELECT r2.id FROM reports r2 WHERE r2.room_id = r.room_id
                     ORDER BY r2.reported_at DESC, r2.id DESC LIMIT 1)`,
    )
    .all(schoolId) as Report[];
  return new Map(rows.map((r) => [r.room_id, r]));
}

export function reportCountsByRoom(db: DB, schoolId: number): Map<number, number> {
  const rows = db
    .prepare(
      `SELECT r.room_id AS room_id, COUNT(*) AS n FROM reports r
       JOIN rooms m ON m.id = r.room_id WHERE m.school_id = ? GROUP BY r.room_id`,
    )
    .all(schoolId) as { room_id: number; n: number }[];
  return new Map(rows.map((r) => [r.room_id, r.n]));
}

interface ClassDbRow extends Omit<ClassRow, "needs_lab"> {
  needs_lab: number;
}

export function listClasses(db: DB, schoolId: number): ClassRow[] {
  const rows = db
    .prepare("SELECT * FROM classes WHERE school_id = ? ORDER BY period, name")
    .all(schoolId) as ClassDbRow[];
  return rows.map((c) => ({ ...c, needs_lab: c.needs_lab === 1 }));
}

export function upsertWeatherHours(db: DB, schoolId: number, periods: HourlyPeriod[], fetchedAt: string): void {
  const stmt = db.prepare(
    `INSERT INTO weather_hours (school_id, start_time, temp_f, rh_pct, sky_cover_pct, short_forecast, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (school_id, start_time) DO UPDATE SET
       temp_f = excluded.temp_f, rh_pct = excluded.rh_pct, sky_cover_pct = excluded.sky_cover_pct,
       short_forecast = excluded.short_forecast, fetched_at = excluded.fetched_at`,
  );
  db.transaction(() => {
    for (const p of periods) {
      stmt.run(
        schoolId,
        new Date(p.startTime).toISOString(),
        p.temperatureF,
        p.relativeHumidityPct,
        p.skyCoverPct,
        p.shortForecast,
        fetchedAt,
      );
    }
  })();
}

export function weatherHours(db: DB, schoolId: number, fromMs: number, toMs: number): WeatherSample[] {
  const rows = db
    .prepare(
      `SELECT start_time, temp_f, rh_pct, sky_cover_pct FROM weather_hours
       WHERE school_id = ? AND start_time >= ? AND start_time <= ? ORDER BY start_time`,
    )
    .all(schoolId, new Date(fromMs).toISOString(), new Date(toMs).toISOString()) as {
    start_time: string;
    temp_f: number;
    rh_pct: number | null;
    sky_cover_pct: number | null;
  }[];
  return rows.map((r) => ({
    t: Date.parse(r.start_time),
    tempF: r.temp_f,
    rhPct: r.rh_pct,
    skyCoverPct: r.sky_cover_pct,
  }));
}
