/** Shared chart tokens (validated reference categorical slots + recessive axes). */
export const SERIES = {
  outdoor: "#2a78d6", // slot 1 blue
  indoor: "#eb6834", // slot 2 orange
  heatIndex: "#6250d6", // slot 7 violet
};

export const AXIS = {
  stroke: "#d9d4ca",
  tick: { fill: "#6f6a62", fontSize: 11 },
  grid: "#ebe7df",
};

export const THRESHOLD_COLORS = { advisory: "#b45309", unusable: "#b91c1c" };

export function hourTicks(fromMs: number, toMs: number, everyHours: number, tz: string): number[] {
  const out: number[] = [];
  const H = 3_600_000;
  // Align to local hour boundaries that are multiples of `everyHours`.
  for (let t = Math.ceil(fromMs / H) * H; t <= toMs; t += H) {
    const hr = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(t));
    if (hr % everyHours === 0) out.push(t);
  }
  return out;
}
