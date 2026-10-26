import { describe, expect, it } from "vitest";
import { cloudFactor, extraterrestrialIrradiance, kastenYoungAirMass, roomSolarWatts, windowIrradiance } from "@/lib/irradiance";

const LAT = 40.9018; // Morris Hills HS, Morris Plains area
const LON = -74.5204;
const JULY_15 = Date.UTC(2026, 6, 15, 4); // local midnight EDT
const STEP = 5 * 60_000;

function dailyWh(azimuth: number, day = JULY_15) {
  let wh = 0;
  for (let t = day; t < day + 86_400_000; t += STEP) {
    wh += roomSolarWatts({ lat: LAT, lon: LON, ms: t, windowAzimuthDeg: azimuth, windowAreaM2: 1 }) * (STEP / 3_600_000);
  }
  return wh;
}

function peakLocalHour(azimuth: number) {
  let best = { t: 0, w: -1 };
  for (let t = JULY_15; t < JULY_15 + 86_400_000; t += STEP) {
    const w = roomSolarWatts({ lat: LAT, lon: LON, ms: t, windowAzimuthDeg: azimuth, windowAreaM2: 1 });
    if (w > best.w) best = { t, w };
  }
  return (best.t - JULY_15) / 3_600_000; // hours after local midnight (EDT)
}

describe("irradiance building blocks", () => {
  it("air mass is 1 overhead and grows toward the horizon", () => {
    expect(kastenYoungAirMass(0)).toBeCloseTo(1, 2);
    expect(kastenYoungAirMass(60)).toBeCloseTo(2, 1);
    expect(kastenYoungAirMass(89)).toBeGreaterThan(20);
  });

  it("extraterrestrial irradiance peaks near perihelion (January)", () => {
    expect(extraterrestrialIrradiance(Date.UTC(2026, 0, 3))).toBeGreaterThan(1400);
    expect(extraterrestrialIrradiance(Date.UTC(2026, 6, 4))).toBeLessThan(1330);
  });

  it("cloud factor is 1 for clear/unknown sky and 0.25 for overcast", () => {
    expect(cloudFactor(null)).toBe(1);
    expect(cloudFactor(0)).toBe(1);
    expect(cloudFactor(100)).toBeCloseTo(0.25, 6);
    expect(cloudFactor(50)).toBeGreaterThan(0.9);
  });

  it("is zero at night and zero beam when the sun is behind the wall", () => {
    const night = windowIrradiance({ lat: LAT, lon: LON, ms: JULY_15 + 2 * 3_600_000, windowAzimuthDeg: 180, windowAreaM2: 5 });
    expect(night.watts).toBe(0);
    // 4 pm EDT: sun is in the west-southwest; an east window gets diffuse only.
    const eastPm = windowIrradiance({ lat: LAT, lon: LON, ms: JULY_15 + 16 * 3_600_000, windowAzimuthDeg: 90, windowAreaM2: 1 });
    expect(eastPm.beamWm2).toBe(0);
    expect(eastPm.diffuseWm2).toBeGreaterThan(0);
  });

  it("scales linearly with window area and cloud factor", () => {
    const base = { lat: LAT, lon: LON, ms: JULY_15 + 13 * 3_600_000, windowAzimuthDeg: 180 };
    const one = roomSolarWatts({ ...base, windowAreaM2: 1 });
    expect(roomSolarWatts({ ...base, windowAreaM2: 8 })).toBeCloseTo(8 * one, 6);
    expect(roomSolarWatts({ ...base, windowAreaM2: 1, skyCoverPct: 100 })).toBeCloseTo(0.25 * one, 6);
  });
});

describe("per-orientation behavior in Morris Plains, July", () => {
  it("a north-facing window receives materially less daily total than a south-facing one", () => {
    const north = dailyWh(0);
    const south = dailyWh(180);
    expect(north).toBeGreaterThan(0);
    expect(north).toBeLessThan(0.6 * south);
  });

  it("an east window peaks in the morning, a west window in the afternoon", () => {
    const east = peakLocalHour(90);
    const west = peakLocalHour(270);
    expect(east).toBeLessThan(11);
    expect(east).toBeGreaterThan(6);
    expect(west).toBeGreaterThan(14);
    expect(west).toBeLessThan(19.5);
  });

  it("west and east windows gather similar daily totals (symmetry about solar noon)", () => {
    const e = dailyWh(90);
    const w = dailyWh(270);
    expect(Math.abs(e - w) / e).toBeLessThan(0.05);
  });
});
