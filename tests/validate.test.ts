import { describe, expect, it } from "vitest";
import { parseReportForm } from "@/lib/validate";

const form = (o: Record<string, string>) => (k: string) => (k in o ? o[k] : null);

const base = { school_id: "1", room_id: "3", temp_f: "84", reporter_role: "teacher" };

describe("parseReportForm", () => {
  it("accepts a minimal valid report", () => {
    const r = parseReportForm(form(base));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.tempF).toBe(84);
      expect(r.value.humidityPct).toBeNull();
      expect(r.value.room).toEqual({ kind: "existing", roomId: 3 });
    }
  });

  it.each(["39.9", "130.1", "abc", ""])("rejects temp_f=%s", (t) => {
    const r = parseReportForm(form({ ...base, temp_f: t }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.temp).toBeDefined();
  });

  it("accepts the 40 and 130 boundaries", () => {
    expect(parseReportForm(form({ ...base, temp_f: "40" })).ok).toBe(true);
    expect(parseReportForm(form({ ...base, temp_f: "130" })).ok).toBe(true);
  });

  it("validates optional humidity and role", () => {
    const r = parseReportForm(form({ ...base, humidity_pct: "140", reporter_role: "parent" }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.humidity).toBeDefined();
      expect(r.error.role).toBeDefined();
    }
  });

  it("parses a new room", () => {
    const r = parseReportForm(
      form({ ...base, room_id: "new", new_room_number: "b-210", new_floor: "2", new_orientation: "SW", new_has_ac: "0" }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.room).toEqual({ kind: "new", roomNumber: "B-210", floor: 2, orientation: "SW", hasAc: false });
  });

  it("requires orientation for a new room", () => {
    const r = parseReportForm(form({ ...base, room_id: "new", new_room_number: "300", new_floor: "3" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.orientation).toBeDefined();
  });
});
