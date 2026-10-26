import { describe, expect, it } from "vitest";
import { heatIndexF, heatIndexSimpleF, rothfuszF } from "@/lib/heatindex";
import { classifyHeatIndex } from "@/lib/thresholds";

// Values read from the NWS heat index chart
// (https://www.weather.gov/safety/heat-index), [temp °F, RH %, HI °F].
// Cells inside the high-humidity adjustment band (80-87 °F, RH > 85%) are
// avoided: the chart predates that adjustment, so e.g. 80 °F / 100% reads 87
// on the chart but 89.3 from the full NWS procedure.
const NWS_TABLE: [number, number, number][] = [
  [80, 40, 80],
  [90, 40, 91],
  [100, 40, 109],
  [110, 40, 136],
  [84, 50, 85],
  [94, 50, 103],
  [90, 60, 100],
  [96, 60, 116],
  [88, 70, 100],
  [86, 85, 102],
  [90, 90, 122],
  [90, 80, 113],
  [92, 75, 116],
];

describe("heatIndexF vs NWS table", () => {
  it.each(NWS_TABLE)("T=%sF RH=%s pct -> %sF", (t, rh, expected) => {
    expect(Math.abs(heatIndexF(t, rh) - expected)).toBeLessThanOrEqual(1.5);
  });
});

describe("heatIndexF branches", () => {
  it("uses the simple formula when the simple average is below 80F", () => {
    // 70F, 50%: simple = 0.5*(70+61+2.4+4.7) = 69.05; avg 69.5 < 80
    expect(heatIndexF(70, 50)).toBeCloseTo(heatIndexSimpleF(70, 50), 10);
    expect(heatIndexF(70, 50)).toBeCloseTo(69.05, 2);
  });

  it("uses the full regression above the 80F switch", () => {
    // 95F at 50% RH is well inside regression range with no adjustment.
    expect(heatIndexF(95, 50)).toBeCloseTo(rothfuszF(95, 50), 10);
  });

  it("applies the low-humidity adjustment (RH<13%, 80-112F)", () => {
    const raw = rothfuszF(100, 5);
    const adj = ((13 - 5) / 4) * Math.sqrt((17 - Math.abs(100 - 95)) / 17);
    expect(heatIndexF(100, 5)).toBeCloseTo(raw - adj, 10);
    expect(heatIndexF(100, 5)).toBeLessThan(raw);
  });

  it("applies the high-humidity adjustment (RH>85%, 80-87F)", () => {
    const raw = rothfuszF(84, 95);
    const adj = ((95 - 85) / 10) * ((87 - 84) / 5);
    expect(heatIndexF(84, 95)).toBeCloseTo(raw + adj, 10);
    expect(heatIndexF(84, 95)).toBeGreaterThan(raw);
  });

  it("does not adjust outside the adjustment temperature bands", () => {
    expect(heatIndexF(115, 5)).toBeCloseTo(rothfuszF(115, 5), 10);
    expect(heatIndexF(90, 95)).toBeCloseTo(rothfuszF(90, 95), 10);
  });
});

describe("thresholds", () => {
  it("classifies at the 82 / 88 boundaries", () => {
    expect(classifyHeatIndex(81.9)).toBe("ok");
    expect(classifyHeatIndex(82)).toBe("advisory");
    expect(classifyHeatIndex(87.99)).toBe("advisory");
    expect(classifyHeatIndex(88)).toBe("unusable");
  });
});
