import { describe, expect, it } from "vitest";
import { openDb } from "@/lib/db";
import { filterLogForSchool, getRoomState, getSchool, listRooms, upsertWeatherHours } from "@/lib/repo";
import { buildForecast, recordReport } from "@/lib/roomModel";
import type { HourlyPeriod } from "@/lib/nws";

const H = 3_600_000;

function seedWeather(db: ReturnType<typeof openDb>, schoolId: number, fromMs: number, hours: number) {
  const periods: HourlyPeriod[] = [];
  for (let h = 0; h < hours; h++) {
    const t = fromMs + h * H;
    const hourLocal = (new Date(t).getUTCHours() + 20) % 24; // EDT
    const temp = 80 + 10 * Math.sin(((hourLocal - 9) / 24) * 2 * Math.PI);
    periods.push({
      startTime: new Date(t).toISOString(),
      endTime: new Date(t + H).toISOString(),
      temperatureF: temp,
      relativeHumidityPct: 55,
      skyCoverPct: 10,
      skyCoverSource: "derived",
      shortForecast: "Sunny",
      isDaytime: hourLocal > 6 && hourLocal < 20,
    });
  }
  upsertWeatherHours(db, schoolId, periods, new Date(fromMs).toISOString());
}

describe("recordReport + buildForecast", () => {
  it("persists Kalman state, logs decisions, and tightens the band", () => {
    const db = openDb(":memory:");
    const school = getSchool(db)!;
    const room = listRooms(db, school.id).find((r) => r.room_number === "220")!;
    const now = Date.UTC(2026, 5, 16, 18); // 2 pm EDT
    seedWeather(db, school.id, now - 30 * H, 80);

    const before = buildForecast(db, school, "live", now, []);
    const priorRoom = before.rooms.find((r) => r.room.id === room.id)!;
    const priorSdAt = (t: number) => priorRoom.points.find((p) => Math.abs(p.t - t) < 8 * 60_000)?.sdF ?? NaN;

    // Three teacher reports, an hour apart, consistent with the model's own prediction.
    for (let i = 0; i < 3; i++) {
      const t = now + i * H;
      const pred = priorRoom.points.find((p) => Math.abs(p.t - t) < 8 * 60_000)!.indoorF;
      const res = recordReport(db, school, room, {
        room_id: room.id,
        temp_f: Math.round((pred + 0.5) * 10) / 10,
        humidity_pct: null,
        reported_at: new Date(t).toISOString(),
        reporter_role: "teacher",
        note: null,
      });
      expect(res.outcome.accepted).toBe(true);
    }
    const state = getRoomState(db, room.id)!;
    expect(state.updated_at).toBe(new Date(now + 2 * H).toISOString());
    expect(JSON.parse(state.cov_json)).toHaveLength(3);

    // Garbage report is rejected and logged, state barely moves.
    const garbage = recordReport(db, school, room, {
      room_id: room.id,
      temp_f: 130,
      humidity_pct: null,
      reported_at: new Date(now + 2 * H + 60_000).toISOString(),
      reporter_role: "student",
      note: "lol",
    });
    expect(garbage.outcome.accepted).toBe(false);
    const log = filterLogForSchool(db, school.id);
    expect(log).toHaveLength(4);
    expect(log.filter((l) => l.accepted === 0)).toHaveLength(1);
    const after = getRoomState(db, room.id)!;
    expect(Math.abs(after.t_indoor - state.t_indoor)).toBeLessThan(0.5);

    const fc = buildForecast(db, school, "live", now + 3 * H, []);
    const fr = fc.rooms.find((r) => r.room.id === room.id)!;
    expect(fr.rejectedCount).toBe(1);
    expect(fr.reportCount).toBe(4);
    // Right after the last accepted report, the band is far narrower than the prior's at that instant.
    const tLast = now + 2 * H;
    const postSd = fr.points.filter((p) => p.t === tLast).at(-1)!.sdF!;
    expect(postSd).toBeLessThan(0.5 * priorSdAt(tLast));
    // Every predicted point carries an uncertainty.
    for (const p of fr.points) expect(p.sdF! > 0 && p.hiSdF! > 0).toBe(true);
  });

  it("heat-wave scenario uses learned parameters but synthetic weather", () => {
    const db = openDb(":memory:");
    const school = getSchool(db)!;
    const fc = buildForecast(db, school, "heatwave", Date.UTC(2026, 9, 26), []);
    expect(fc.rooms).toHaveLength(16);
    const hottest = Math.max(...fc.rooms.map((r) => r.peaks[0]?.heatIndexF ?? 0));
    expect(hottest).toBeGreaterThan(88);
    const ac = fc.rooms.filter((r) => r.room.has_ac);
    for (const r of ac) expect(r.peaks[0]!.heatIndexF).toBeLessThan(82);
  });
});
