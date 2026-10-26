/**
 * Room reassignment for one period. Pure.
 *
 * Rows = classes scheduled that period, columns = rooms free that period
 * (every room hosts at most one class per period, so for the classes being
 * reassigned all rooms are candidates).
 *
 *   cost(class, room) = enrollment · max(0, predictedPeakHeatIndex(room) − 82)
 *                     + movePenalty  if room ≠ class.assigned_room_id
 *
 * Infeasible pairs (capacity < enrollment, or a lab class in a non-lab room)
 * cost ∞. The matrix is padded to square: dummy class rows cost 0 everywhere
 * (an empty room), dummy room columns cost ∞ for real classes (a class
 * cannot go nowhere). Because the Hungarian solver needs finite costs, ∞ is
 * encoded as a large finite BIG, chosen so that any assignment using one
 * costs more than every fully feasible assignment; a solution containing a
 * BIG entry therefore proves that no feasible assignment exists.
 */
import { hungarian } from "./hungarian";
import { ADVISORY_HEAT_INDEX_F } from "./thresholds";

export interface PlanClass {
  id: number;
  name: string;
  enrollment: number;
  needs_lab: boolean;
  assigned_room_id: number | null;
}

export interface PlanRoom {
  id: number;
  room_number: string;
  capacity: number;
  is_lab: boolean;
  /** Predicted peak heat index during the period, °F. */
  peakHeatIndexF: number;
  /** 1σ of that prediction, °F. */
  peakHiSdF: number;
}

export interface PlanOptions {
  /** Cost (student-°F) charged for moving a class out of its assigned room. */
  movePenalty: number;
  /** Period length in hours, to convert student-°F into student-°F-hours. */
  periodHours: number;
  /** Plan against mean + riskSigmas·σ (0 = expected value). */
  riskSigmas?: number;
}

export interface PlanRow {
  classId: number;
  className: string;
  enrollment: number;
  fromRoomId: number | null;
  toRoomId: number;
  moved: boolean;
  /** Exposure in the assigned room, student-°F (enrollment · degrees over 82). */
  exposureBefore: number | null;
  exposureAfter: number;
  costAfter: number;
}

export type PlanResult =
  | {
      feasible: true;
      rows: PlanRow[];
      /** Σ cost with the current assignment (no move penalties apply). */
      totalCostBefore: number;
      /** Σ cost of the optimal assignment, including move penalties. */
      totalCostAfter: number;
      /** Student-degree-hours above 82 °F heat index. */
      exposureBefore: number;
      exposureAfter: number;
      moves: PlanRow[];
      /** Classes whose current room is infeasible or missing (they must move). */
      currentlyInfeasible: number[];
    }
  | {
      feasible: false;
      reason: string;
      /** Per class: number of rooms it could legally use. */
      options: { classId: number; className: string; feasibleRooms: number }[];
    };

export function isFeasible(c: PlanClass, r: PlanRoom): boolean {
  return r.capacity >= c.enrollment && (!c.needs_lab || r.is_lab);
}

export function plannedHeatIndex(r: PlanRoom, riskSigmas = 0): number {
  return r.peakHeatIndexF + riskSigmas * r.peakHiSdF;
}

/** Students × degrees above the advisory threshold. */
export function exposure(enrollment: number, heatIndexF: number): number {
  return enrollment * Math.max(0, heatIndexF - ADVISORY_HEAT_INDEX_F);
}

export function pairCost(c: PlanClass, r: PlanRoom, opts: PlanOptions): number {
  if (!isFeasible(c, r)) return Infinity;
  return exposure(c.enrollment, plannedHeatIndex(r, opts.riskSigmas)) + (r.id !== c.assigned_room_id ? opts.movePenalty : 0);
}

export function planPeriod(classes: PlanClass[], rooms: PlanRoom[], opts: PlanOptions): PlanResult {
  const options = classes.map((c) => ({
    classId: c.id,
    className: c.name,
    feasibleRooms: rooms.filter((r) => isFeasible(c, r)).length,
  }));

  if (classes.length === 0) {
    return {
      feasible: true,
      rows: [],
      totalCostBefore: 0,
      totalCostAfter: 0,
      exposureBefore: 0,
      exposureAfter: 0,
      moves: [],
      currentlyInfeasible: [],
    };
  }
  const stuck = options.filter((o) => o.feasibleRooms === 0);
  if (stuck.length > 0) {
    return {
      feasible: false,
      reason: `No room can hold ${stuck.map((s) => s.className).join(", ")} (capacity or lab requirement).`,
      options,
    };
  }
  if (classes.length > rooms.length) {
    return {
      feasible: false,
      reason: `${classes.length} classes meet this period but only ${rooms.length} rooms exist.`,
      options,
    };
  }

  const n = Math.max(classes.length, rooms.length);
  const finite: number[][] = classes.map((c) => rooms.map((r) => pairCost(c, r, opts)));
  let maxFinite = 0;
  for (const row of finite) for (const v of row) if (Number.isFinite(v)) maxFinite = Math.max(maxFinite, Math.abs(v));
  const BIG = (maxFinite + 1) * (n + 1) * 10;

  const matrix: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row: number[] = [];
    for (let j = 0; j < n; j++) {
      if (i >= classes.length) row.push(0); // dummy class: empty room
      else if (j >= rooms.length) row.push(BIG); // dummy room: class unplaced
      else row.push(Number.isFinite(finite[i][j]) ? finite[i][j] : BIG);
    }
    matrix.push(row);
  }

  const { assignment } = hungarian(matrix);
  const unplaced = classes.filter((_, i) => assignment[i] >= rooms.length || matrix[i][assignment[i]] >= BIG);
  if (unplaced.length > 0) {
    return {
      feasible: false,
      reason:
        `No assignment satisfies every capacity and lab constraint at once: ` +
        `${unplaced.map((c) => c.name).join(", ")} cannot be placed alongside the other classes this period.`,
      options,
    };
  }

  const roomById = new Map(rooms.map((r) => [r.id, r]));
  const risk = opts.riskSigmas ?? 0;
  const rows: PlanRow[] = classes.map((c, i) => {
    const to = rooms[assignment[i]];
    const from = c.assigned_room_id != null ? roomById.get(c.assigned_room_id) : undefined;
    return {
      classId: c.id,
      className: c.name,
      enrollment: c.enrollment,
      fromRoomId: c.assigned_room_id,
      toRoomId: to.id,
      moved: to.id !== c.assigned_room_id,
      exposureBefore: from ? exposure(c.enrollment, plannedHeatIndex(from, risk)) : null,
      exposureAfter: exposure(c.enrollment, plannedHeatIndex(to, risk)),
      costAfter: matrix[i][assignment[i]],
    };
  });

  const currentlyInfeasible = classes
    .filter((c) => {
      const r = c.assigned_room_id != null ? roomById.get(c.assigned_room_id) : undefined;
      return !r || !isFeasible(c, r);
    })
    .map((c) => c.id);

  const totalCostBefore = rows.reduce((s, r) => s + (r.exposureBefore ?? 0), 0);
  const totalCostAfter = rows.reduce((s, r) => s + r.costAfter, 0);
  return {
    feasible: true,
    rows,
    totalCostBefore,
    totalCostAfter,
    exposureBefore: totalCostBefore * opts.periodHours,
    exposureAfter: rows.reduce((s, r) => s + r.exposureAfter, 0) * opts.periodHours,
    moves: rows.filter((r) => r.moved),
    currentlyInfeasible,
  };
}
