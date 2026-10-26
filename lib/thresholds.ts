/**
 * Classroom heat-index thresholds.
 *
 * These constants mirror the proposed New York State classroom temperature
 * standard (maximum-temperature legislation introduced in the NY Senate and
 * Assembly): at 82 °F schools must take remedial action (shades, fans,
 * hydration, relocating students), and at 88 °F a classroom is deemed
 * unsuitable for occupancy. We apply them to the heat index rather than the
 * dry-bulb temperature, which is the more conservative reading in humid rooms.
 */

/** Remedial-action threshold, °F heat index. */
export const ADVISORY_HEAT_INDEX_F = 82;

/** Room-unusable threshold, °F heat index. */
export const UNUSABLE_HEAT_INDEX_F = 88;

export type ThresholdState = "ok" | "advisory" | "unusable";

export function classifyHeatIndex(heatIndexF: number): ThresholdState {
  if (heatIndexF >= UNUSABLE_HEAT_INDEX_F) return "unusable";
  if (heatIndexF >= ADVISORY_HEAT_INDEX_F) return "advisory";
  return "ok";
}

export const THRESHOLD_LABEL: Record<ThresholdState, string> = {
  ok: "OK",
  advisory: "Advisory",
  unusable: "Unusable",
};
