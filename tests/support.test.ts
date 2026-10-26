import { describe, expect, it } from "vitest";
import { dewpointF, estimateIndoorRh, rhFromDewpoint } from "@/lib/humidity";
import { peakIn, predictRoom } from "@/lib/prediction";
import { heatwaveSeries, heatwaveStartMs, parseScenario } from "@/lib/scenario";
import { periodLabel, periodWindow, schoolDayWindow } from "@/lib/schedule";
import { defaultParams } from "@/lib/thermal";
import { localParts, startOfLocalDay, tzOffsetMinutes, zonedToUtc } from "@/lib/time";
import { climatologySeries, normalizeSeries, weatherAt } from "@/lib/weatherSeries";

const TZ = "America/New_York";
const H = 3_600_000;

describe("time helpers", () => {
  it("handles EDT and EST offsets", () => {
    expect(tzOffsetMinutes(Date.UTC(2026, 6, 1, 12), TZ)).toBe(-240);
    expect(tzOffsetMinutes(Date.UTC(2026, 0, 1, 12), TZ)).toBe(-300);
  });
  it("round-trips wall clock times", () => {
    const t = zonedToUtc(2026, 6, 18, 7, 30, TZ);
    expect(t).toBe(Date.UTC(2026, 5, 18, 11, 30));
    expect(localParts(t, TZ)).toMatchObject({ year: 2026, month: 6, day: 18, hour: 7, minute: 30 });
    expect(startOfLocalDay(t, TZ)).toBe(Date.UTC(2026, 5, 18, 4));
  });
});

describe("schedule", () => {
  it("lays out 8 periods from 7:30 to 2:05", () => {
    expect(periodLabel(1)).toBe("7:30–8:15");
    expect(periodLabel(8)).toBe("1:20–2:05");
    const day = Date.UTC(2026, 5, 18, 16);
    const w = schoolDayWindow(day, TZ);
    expect(w.startMs).toBe(Date.UTC(2026, 5, 18, 11, 30));
    expect(w.endMs).toBe(Date.UTC(2026, 5, 18, 18, 5));
    const p3 = periodWindow(3, day, TZ);
    expect(p3.endMs - p3.startMs).toBe(45 * 60_000);
  });
});

describe("weather series", () => {
  const series = normalizeSeries([
    { t: 2 * H, tempF: 80, rhPct: 50, skyCoverPct: 10 },
    { t: 0, tempF: 60, rhPct: 70, skyCoverPct: 90 },
    { t: H, tempF: 70, rhPct: 60, skyCoverPct: 50 },
  ]);
  it("sorts and interpolates between hour midpoints", () => {
    expect(series.map((s) => s.t)).toEqual([0, H, 2 * H]);
    expect(weatherAt(series, H).tempF).toBeCloseTo(65, 6);
    expect(weatherAt(series, 1.5 * H).tempF).toBeCloseTo(70, 6);
  });
  it("clamps outside the covered range", () => {
    expect(weatherAt(series, -10 * H).tempF).toBe(60);
    expect(weatherAt(series, 10 * H).tempF).toBe(80);
  });
  it("climatology fallback covers whole days", () => {
    const c = climatologySeries(Date.UTC(2026, 6, 1, 16), 2, TZ);
    expect(c.length).toBe(48);
    expect(Math.max(...c.map((s) => s.tempF))).toBeCloseTo(85, 0);
  });
});

describe("humidity", () => {
  it("dewpoint and RH are inverses", () => {
    const td = dewpointF(90, 50);
    expect(rhFromDewpoint(90, td)).toBeCloseTo(50, 3);
  });
  it("warmer indoor air at the same dewpoint has lower RH", () => {
    const est = estimateIndoorRh({ indoorF: 95, hasAc: false, outdoorF: 85, outdoorRhPct: 60 });
    expect(est.estimated).toBe(true);
    expect(est.rhPct).toBeLessThan(60);
  });
  it("prefers measured humidity", () => {
    expect(estimateIndoorRh({ indoorF: 95, measuredRhPct: 33, hasAc: false })).toEqual({ rhPct: 33, estimated: false });
  });
});

describe("scenario + prediction", () => {
  it("picks the third Thursday of June, rolling to next year when past", () => {
    const s = heatwaveStartMs(Date.UTC(2026, 9, 26), TZ);
    const p = localParts(s + 12 * H, TZ);
    expect(p).toMatchObject({ year: 2027, month: 6, day: 17 });
    expect(new Date(s + 12 * H).getUTCDay()).toBe(4);
    expect(parseScenario("heatwave")).toBe("heatwave");
    expect(parseScenario(undefined)).toBe("live");
  });

  it("predicts a hot SE room above the advisory threshold during the heat wave", () => {
    const start = heatwaveStartMs(Date.UTC(2026, 0, 1), TZ);
    const series = heatwaveSeries(start, TZ);
    const room = { orientation: "SE" as const, window_area_m2: 8, has_ac: false };
    const pts = predictRoom(room, series, defaultParams(room, { lat: 40.9018, lon: -74.5204 }), {
      startMs: start,
      endMs: start + 24 * H,
    });
    expect(pts[1].t - pts[0].t).toBe(15 * 60_000);
    const sd = schoolDayWindow(start + 12 * H, TZ);
    const peak = peakIn(pts, "heatIndexF", sd.startMs, sd.endMs)!;
    expect(peak.heatIndexF).toBeGreaterThan(88);
    expect(peakIn(pts, "heatIndexF", 0, 1)).toBeNull();
  });
});
