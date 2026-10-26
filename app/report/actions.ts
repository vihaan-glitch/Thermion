"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { heatIndexF } from "@/lib/heatindex";
import { estimateIndoorRh } from "@/lib/humidity";
import { createRoom, findRoomByNumber, getRoom, getSchool, insertReport, weatherHours } from "@/lib/repo";
import { HOUR_MS } from "@/lib/time";
import { classifyHeatIndex, type ThresholdState } from "@/lib/thresholds";
import { NEW_ROOM_DEFAULTS, parseReportForm, type FieldErrors } from "@/lib/validate";
import { weatherAt } from "@/lib/weatherSeries";

export interface ReportActionState {
  status: "idle" | "error" | "ok";
  errors?: FieldErrors;
  message?: string;
  result?: {
    roomId: number;
    roomNumber: string;
    tempF: number;
    heatIndexF: number;
    rhPct: number;
    rhEstimated: boolean;
    state: ThresholdState;
  };
}

export async function submitReport(_prev: ReportActionState, formData: FormData): Promise<ReportActionState> {
  const parsed = parseReportForm((k) => {
    const v = formData.get(k);
    return typeof v === "string" ? v : null;
  });
  if (!parsed.ok) return { status: "error", errors: parsed.error, message: "Check the highlighted fields." };
  const input = parsed.value;

  const db = getDb();
  const school = getSchool(db, input.schoolId);
  if (!school) return { status: "error", errors: { school: "Unknown school." } };

  let room = null;
  if (input.room.kind === "existing") {
    room = getRoom(db, input.room.roomId);
    if (!room || room.school_id !== school.id) return { status: "error", errors: { room: "Unknown room." } };
  } else {
    room =
      findRoomByNumber(db, school.id, input.room.roomNumber) ??
      createRoom(db, {
        school_id: school.id,
        room_number: input.room.roomNumber,
        floor: input.room.floor,
        orientation: input.room.orientation,
        has_ac: input.room.hasAc,
        ...NEW_ROOM_DEFAULTS,
      });
  }

  const nowMs = Date.now();
  insertReport(db, {
    room_id: room.id,
    temp_f: input.tempF,
    humidity_pct: input.humidityPct,
    reported_at: new Date(nowMs).toISOString(),
    reporter_role: input.role,
    note: input.note,
  });

  const outdoor = weatherAt(weatherHours(db, school.id, nowMs - 3 * HOUR_MS, nowMs + 3 * HOUR_MS), nowMs);
  const rh = estimateIndoorRh({
    indoorF: input.tempF,
    measuredRhPct: input.humidityPct,
    hasAc: room.has_ac,
    outdoorF: Number.isFinite(outdoor.tempF) ? outdoor.tempF : null,
    outdoorRhPct: outdoor.rhPct,
  });
  const hi = heatIndexF(input.tempF, rh.rhPct);

  revalidatePath("/dashboard");
  revalidatePath("/report");
  return {
    status: "ok",
    result: {
      roomId: room.id,
      roomNumber: room.room_number,
      tempF: input.tempF,
      heatIndexF: hi,
      rhPct: rh.rhPct,
      rhEstimated: rh.estimated,
      state: classifyHeatIndex(hi),
    },
  };
}
