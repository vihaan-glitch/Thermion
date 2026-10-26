import { ORIENTATIONS, REPORTER_ROLES, type Orientation, type ReporterRole } from "./types";
import type { Result } from "./nws";

/** Validation for the /report form. Pure; shared by the server action and tests. */

export const TEMP_MIN_F = 40;
export const TEMP_MAX_F = 130;

/** Defaults for a room created from the report form (documented in README). */
export const NEW_ROOM_DEFAULTS = {
  building: "Main",
  window_area_m2: 6,
  capacity: 25,
  is_lab: false,
} as const;

export interface ParsedReport {
  schoolId: number;
  room:
    | { kind: "existing"; roomId: number }
    | { kind: "new"; roomNumber: string; floor: number; orientation: Orientation; hasAc: boolean };
  tempF: number;
  humidityPct: number | null;
  role: ReporterRole;
  note: string | null;
}

export type FieldErrors = Partial<Record<"school" | "room" | "temp" | "humidity" | "role" | "note" | "floor" | "orientation", string>>;

type Getter = (key: string) => string | null;

function numberField(raw: string | null): number | null {
  if (raw == null || raw.trim() === "") return null;
  const n = Number(raw.trim());
  return Number.isFinite(n) ? n : NaN;
}

export function parseReportForm(get: Getter): Result<ParsedReport, FieldErrors> {
  const errors: FieldErrors = {};

  const schoolId = numberField(get("school_id"));
  if (schoolId == null || !Number.isInteger(schoolId) || schoolId <= 0) errors.school = "Pick a school.";

  let room: ParsedReport["room"] | null = null;
  const roomRaw = get("room_id");
  if (roomRaw === "new") {
    const roomNumber = (get("new_room_number") ?? "").trim();
    const floor = numberField(get("new_floor"));
    const orientation = get("new_orientation");
    if (!/^[A-Za-z0-9-]{1,12}$/.test(roomNumber)) errors.room = "Room number: 1-12 letters, digits or dashes.";
    if (floor == null || !Number.isInteger(floor) || floor < 0 || floor > 10) errors.floor = "Pick a floor.";
    if (!ORIENTATIONS.includes(orientation as Orientation)) errors.orientation = "Which way do the windows face?";
    if (!errors.room && !errors.floor && !errors.orientation) {
      room = {
        kind: "new",
        roomNumber: roomNumber.toUpperCase(),
        floor: floor!,
        orientation: orientation as Orientation,
        hasAc: get("new_has_ac") === "1",
      };
    }
  } else {
    const roomId = numberField(roomRaw);
    if (roomId == null || !Number.isInteger(roomId) || roomId <= 0) errors.room = "Pick a room.";
    else room = { kind: "existing", roomId };
  }

  const tempF = numberField(get("temp_f"));
  if (tempF == null || Number.isNaN(tempF)) errors.temp = "Enter the temperature.";
  else if (tempF < TEMP_MIN_F || tempF > TEMP_MAX_F)
    errors.temp = `Temperature must be between ${TEMP_MIN_F} and ${TEMP_MAX_F} °F.`;

  const humidity = numberField(get("humidity_pct"));
  if (humidity != null && (Number.isNaN(humidity) || humidity < 0 || humidity > 100))
    errors.humidity = "Humidity must be 0-100%.";

  const role = get("reporter_role");
  if (!REPORTER_ROLES.includes(role as ReporterRole)) errors.role = "Who is reporting?";

  const noteRaw = (get("note") ?? "").trim();
  if (noteRaw.length > 280) errors.note = "Keep the note under 280 characters.";

  if (Object.keys(errors).length > 0 || !room) return { ok: false, error: errors };
  return {
    ok: true,
    value: {
      schoolId: schoolId!,
      room,
      tempF: Math.round(tempF! * 10) / 10,
      humidityPct: humidity == null ? null : Math.round(humidity),
      role: role as ReporterRole,
      note: noteRaw === "" ? null : noteRaw,
    },
  };
}
