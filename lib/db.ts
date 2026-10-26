import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

/**
 * SQLite connection, migrations and seed. Migrations run automatically the
 * first time a connection is opened (i.e. on boot); progress is tracked in
 * PRAGMA user_version so each migration runs exactly once.
 */

export type DB = Database.Database;

const MIGRATIONS: string[] = [
  // 1: core schema
  `
  CREATE TABLE schools (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    district TEXT NOT NULL,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    tz TEXT NOT NULL
  );
  CREATE TABLE rooms (
    id INTEGER PRIMARY KEY,
    school_id INTEGER NOT NULL REFERENCES schools(id),
    room_number TEXT NOT NULL,
    building TEXT NOT NULL,
    floor INTEGER NOT NULL,
    orientation TEXT NOT NULL CHECK (orientation IN ('N','NE','E','SE','S','SW','W','NW')),
    window_area_m2 REAL NOT NULL CHECK (window_area_m2 >= 0),
    has_ac INTEGER NOT NULL CHECK (has_ac IN (0,1)),
    capacity INTEGER NOT NULL CHECK (capacity > 0),
    is_lab INTEGER NOT NULL CHECK (is_lab IN (0,1)),
    UNIQUE (school_id, room_number)
  );
  CREATE TABLE reports (
    id INTEGER PRIMARY KEY,
    room_id INTEGER NOT NULL REFERENCES rooms(id),
    temp_f REAL NOT NULL CHECK (temp_f BETWEEN 40 AND 130),
    humidity_pct REAL CHECK (humidity_pct IS NULL OR humidity_pct BETWEEN 0 AND 100),
    reported_at TEXT NOT NULL,
    reporter_role TEXT NOT NULL CHECK (reporter_role IN ('student','teacher','staff')),
    note TEXT
  );
  CREATE INDEX reports_room_time ON reports(room_id, reported_at);
  CREATE TABLE room_state (
    room_id INTEGER PRIMARY KEY REFERENCES rooms(id),
    t_indoor REAL NOT NULL,
    inv_rc REAL NOT NULL,
    alpha REAL NOT NULL,
    cov_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE classes (
    id INTEGER PRIMARY KEY,
    school_id INTEGER NOT NULL REFERENCES schools(id),
    name TEXT NOT NULL,
    period INTEGER NOT NULL CHECK (period BETWEEN 1 AND 8),
    enrollment INTEGER NOT NULL CHECK (enrollment > 0),
    needs_lab INTEGER NOT NULL CHECK (needs_lab IN (0,1)),
    assigned_room_id INTEGER REFERENCES rooms(id)
  );
  -- Every hourly forecast we fetch is logged, so hours that have passed stay
  -- available to the physics model (the NWS hourly product only looks ahead).
  CREATE TABLE weather_hours (
    school_id INTEGER NOT NULL REFERENCES schools(id),
    start_time TEXT NOT NULL,
    temp_f REAL NOT NULL,
    rh_pct REAL,
    sky_cover_pct REAL,
    short_forecast TEXT,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (school_id, start_time)
  );
  `,
  // 2: Kalman filter audit log. One row per report the filter processed,
  // accepted or rejected, with the posterior state so the UI can draw the
  // prediction track piecewise through every accepted report.
  `
  CREATE TABLE filter_log (
    id INTEGER PRIMARY KEY,
    report_id INTEGER NOT NULL UNIQUE REFERENCES reports(id),
    room_id INTEGER NOT NULL REFERENCES rooms(id),
    accepted INTEGER NOT NULL CHECK (accepted IN (0,1)),
    reason TEXT NOT NULL CHECK (reason IN ('accepted','corroborated','outlier')),
    observed_f REAL NOT NULL,
    predicted_f REAL NOT NULL,
    predicted_sd_f REAL NOT NULL,
    innovation_f REAL NOT NULL,
    nis REAL NOT NULL,
    measurement_var REAL NOT NULL,
    state_after_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX filter_log_room ON filter_log(room_id, created_at);
  `,
];

function migrate(db: DB): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

type SeedRoom = [string, string, number, string, number, 0 | 1, number, 0 | 1];
// room_number, building, floor, orientation, window_area_m2, has_ac, capacity, is_lab
const SEED_ROOMS: SeedRoom[] = [
  ["101", "Main", 1, "N", 5.5, 0, 28, 0],
  ["104", "Main", 1, "NE", 6.0, 1, 30, 0],
  ["108", "Main", 1, "E", 7.5, 0, 26, 0],
  ["112", "Main", 1, "SE", 8.0, 0, 32, 0],
  ["116", "Main", 1, "S", 9.0, 0, 30, 0],
  ["S120", "Science Wing", 1, "SW", 7.0, 0, 24, 1],
  ["S124", "Science Wing", 1, "W", 6.5, 1, 24, 1],
  ["128", "Main", 1, "NW", 5.0, 0, 22, 0],
  ["201", "Main", 2, "N", 6.0, 0, 30, 0],
  ["204", "Main", 2, "NE", 6.5, 0, 26, 0],
  ["208", "Main", 2, "E", 8.0, 0, 28, 0],
  ["212", "Main", 2, "SE", 9.5, 1, 32, 0],
  ["S216", "Science Wing", 2, "S", 8.5, 0, 24, 1],
  ["220", "Main", 2, "SW", 11.0, 0, 30, 0],
  ["S224", "Science Wing", 2, "W", 10.0, 0, 20, 1],
  ["228", "Main", 2, "NW", 6.0, 1, 25, 0],
];

type SeedClass = [string, number, number, 0 | 1, string];
// name, period, enrollment, needs_lab, assigned room_number
const SEED_CLASSES: SeedClass[] = [
  ["English 9", 1, 27, 0, "220"],
  ["AP Chemistry", 1, 22, 1, "S216"],
  ["Algebra II", 2, 29, 0, "116"],
  ["US History I", 3, 30, 0, "220"],
  ["Biology", 3, 24, 1, "S120"],
  ["Spanish III", 4, 21, 0, "208"],
  ["Physics", 5, 20, 1, "S224"],
  ["Precalculus", 5, 26, 0, "112"],
  ["English 11", 6, 28, 0, "220"],
  ["Environmental Science", 6, 23, 1, "S120"],
  ["AP Biology", 7, 19, 1, "S224"],
  ["World History", 7, 29, 0, "116"],
  ["Geometry", 7, 25, 0, "208"],
  ["Robotics Engineering", 8, 18, 1, "S216"],
];

export function seed(db: DB): void {
  const hasSchool = db.prepare("SELECT COUNT(*) AS n FROM schools").get() as { n: number };
  if (hasSchool.n > 0) return;

  db.transaction(() => {
    const school = db
      .prepare("INSERT INTO schools (name, district, lat, lon, tz) VALUES (?, ?, ?, ?, ?)")
      .run("Morris Hills High School", "Morris Hills Regional", 40.9018, -74.5204, "America/New_York");
    const schoolId = Number(school.lastInsertRowid);

    const insRoom = db.prepare(
      `INSERT INTO rooms (school_id, room_number, building, floor, orientation, window_area_m2, has_ac, capacity, is_lab)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const roomIds = new Map<string, number>();
    for (const r of SEED_ROOMS) {
      const res = insRoom.run(schoolId, ...r);
      roomIds.set(r[0], Number(res.lastInsertRowid));
    }

    const insClass = db.prepare(
      `INSERT INTO classes (school_id, name, period, enrollment, needs_lab, assigned_room_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const [name, period, enrollment, needsLab, roomNumber] of SEED_CLASSES) {
      insClass.run(schoolId, name, period, enrollment, needsLab, roomIds.get(roomNumber) ?? null);
    }
  })();
}

export function openDb(file: string): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  seed(db);
  return db;
}

/**
 * ./data/roomtemp.db locally. Vercel's filesystem is read-only apart from
 * /tmp, so there the database lives in /tmp (ephemeral per instance; see
 * README limitations). ROOMTEMP_DB overrides both.
 */
export function defaultDbPath(): string {
  if (process.env.ROOMTEMP_DB) return process.env.ROOMTEMP_DB;
  if (process.env.VERCEL) return "/tmp/roomtemp.db";
  return path.join(process.cwd(), "data", "roomtemp.db");
}

const globalForDb = globalThis as unknown as { __roomtempDb?: DB };

export function getDb(): DB {
  if (!globalForDb.__roomtempDb) globalForDb.__roomtempDb = openDb(defaultDbPath());
  return globalForDb.__roomtempDb;
}
