export const ORIENTATIONS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
export type Orientation = (typeof ORIENTATIONS)[number];

/** Compass azimuth (degrees clockwise from north) that a facade faces. */
export const ORIENTATION_AZIMUTH: Record<Orientation, number> = {
  N: 0,
  NE: 45,
  E: 90,
  SE: 135,
  S: 180,
  SW: 225,
  W: 270,
  NW: 315,
};

export const REPORTER_ROLES = ["student", "teacher", "staff"] as const;
export type ReporterRole = (typeof REPORTER_ROLES)[number];

export interface School {
  id: number;
  name: string;
  district: string;
  lat: number;
  lon: number;
  tz: string;
}

export interface Room {
  id: number;
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

export interface Report {
  id: number;
  room_id: number;
  temp_f: number;
  humidity_pct: number | null;
  reported_at: string;
  reporter_role: ReporterRole;
  note: string | null;
}

export interface ClassRow {
  id: number;
  school_id: number;
  name: string;
  period: number;
  enrollment: number;
  needs_lab: boolean;
  assigned_room_id: number | null;
}
