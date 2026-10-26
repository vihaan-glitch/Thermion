import { describe, expect, it } from "vitest";
import { openDb } from "@/lib/db";
import { getSchool, insertReport, latestReportByRoom, listClasses, listRooms } from "@/lib/repo";
import { ORIENTATIONS } from "@/lib/types";

describe("database bootstrap", () => {
  it("migrates and seeds one school, ~16 rooms, ~14 classes, zero reports", () => {
    const db = openDb(":memory:");
    const school = getSchool(db)!;
    expect(school.name).toBe("Morris Hills High School");
    expect(school.lat).toBeCloseTo(40.9018, 4);
    expect(school.tz).toBe("America/New_York");

    const rooms = listRooms(db, school.id);
    expect(rooms).toHaveLength(16);
    expect(new Set(rooms.map((r) => r.orientation))).toEqual(new Set(ORIENTATIONS));
    expect(new Set(rooms.map((r) => r.floor))).toEqual(new Set([1, 2]));
    expect(rooms.some((r) => r.has_ac) && rooms.some((r) => !r.has_ac)).toBe(true);
    expect(rooms.some((r) => r.is_lab) && rooms.some((r) => !r.is_lab)).toBe(true);
    for (const r of rooms) expect(r.capacity).toBeGreaterThanOrEqual(20);
    for (const r of rooms) expect(r.capacity).toBeLessThanOrEqual(32);

    const classes = listClasses(db, school.id);
    expect(classes).toHaveLength(14);
    expect(new Set(classes.map((c) => c.period))).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8]));

    // Seeded schedule must itself be feasible: capacity, lab, no double-booking.
    const byId = new Map(rooms.map((r) => [r.id, r]));
    const seen = new Set<string>();
    for (const c of classes) {
      const room = byId.get(c.assigned_room_id!)!;
      expect(room.capacity).toBeGreaterThanOrEqual(c.enrollment);
      if (c.needs_lab) expect(room.is_lab).toBe(true);
      const key = `${c.period}:${room.id}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }

    const count = db.prepare("SELECT COUNT(*) AS n FROM reports").get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("is idempotent on reopen and enforces the temperature range", () => {
    const db = openDb(":memory:");
    const school = getSchool(db)!;
    const room = listRooms(db, school.id)[0];
    expect(() =>
      insertReport(db, {
        room_id: room.id,
        temp_f: 150,
        humidity_pct: null,
        reported_at: new Date().toISOString(),
        reporter_role: "teacher",
        note: null,
      }),
    ).toThrow();
    insertReport(db, {
      room_id: room.id,
      temp_f: 84,
      humidity_pct: 55,
      reported_at: "2026-06-10T18:00:00.000Z",
      reporter_role: "teacher",
      note: null,
    });
    insertReport(db, {
      room_id: room.id,
      temp_f: 86,
      humidity_pct: null,
      reported_at: "2026-06-10T19:00:00.000Z",
      reporter_role: "student",
      note: "fans off",
    });
    expect(latestReportByRoom(db, school.id).get(room.id)?.temp_f).toBe(86);
  });
});
