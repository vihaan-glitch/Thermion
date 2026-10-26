import { describe, expect, it } from "vitest";
import { exposure, pairCost, planPeriod, type PlanClass, type PlanRoom } from "@/lib/reassign";

const room = (id: number, hi: number, cap = 30, lab = false, sd = 1): PlanRoom => ({
  id,
  room_number: String(100 + id),
  capacity: cap,
  is_lab: lab,
  peakHeatIndexF: hi,
  peakHiSdF: sd,
});
const cls = (id: number, enrollment: number, assigned: number | null, needsLab = false): PlanClass => ({
  id,
  name: `Class ${id}`,
  enrollment,
  needs_lab: needsLab,
  assigned_room_id: assigned,
});

const OPTS = { movePenalty: 20, periodHours: 0.75 };

describe("cost model", () => {
  it("charges enrollment × degrees over 82 plus a move penalty", () => {
    expect(exposure(25, 90)).toBe(200);
    expect(exposure(25, 80)).toBe(0);
    expect(pairCost(cls(1, 25, 1), room(1, 90), OPTS)).toBe(200);
    expect(pairCost(cls(1, 25, 1), room(2, 90), OPTS)).toBe(220);
  });
  it("is infinite for capacity or lab violations", () => {
    expect(pairCost(cls(1, 31, 1), room(1, 70, 30), OPTS)).toBe(Infinity);
    expect(pairCost(cls(1, 20, 1, true), room(1, 70, 30, false), OPTS)).toBe(Infinity);
    expect(pairCost(cls(1, 20, 1, true), room(1, 70, 30, true), OPTS)).toBe(0);
  });
});

describe("planPeriod", () => {
  it("moves the class in the hot room to the cool free room", () => {
    const res = planPeriod([cls(1, 28, 1), cls(2, 20, 2)], [room(1, 94), room(2, 84), room(3, 76)], OPTS);
    expect(res.feasible).toBe(true);
    if (!res.feasible) return;
    const byClass = new Map(res.rows.map((r) => [r.classId, r]));
    expect(byClass.get(1)!.toRoomId).toBe(3);
    // Class 2: staying in room 2 costs 20·2 = 40, moving to room 1 is worse; stays.
    expect(byClass.get(2)!.toRoomId).toBe(2);
    expect(res.moves).toHaveLength(1);
    expect(res.totalCostBefore).toBe(28 * 12 + 20 * 2);
    expect(res.totalCostAfter).toBe(20 + 40);
    expect(res.exposureBefore).toBeCloseTo((28 * 12 + 40) * 0.75, 6);
    expect(res.exposureAfter).toBeCloseTo(40 * 0.75, 6);
  });

  it("does not move when the saving is smaller than the penalty", () => {
    const res = planPeriod([cls(1, 10, 1)], [room(1, 83), room(2, 75)], { ...OPTS, movePenalty: 50 });
    expect(res.feasible && res.moves.length).toBe(0);
  });

  it("respects labs and capacity while optimizing", () => {
    const res = planPeriod(
      [cls(1, 24, 1, true), cls(2, 30, 2)],
      [room(1, 95, 24, true), room(2, 90, 30), room(3, 70, 20, false), room(4, 80, 24, true)],
      OPTS,
    );
    expect(res.feasible).toBe(true);
    if (!res.feasible) return;
    const byClass = new Map(res.rows.map((r) => [r.classId, r.toRoomId]));
    expect(byClass.get(1)).toBe(4); // only labs allowed; room 4 is the cool lab
    expect(byClass.get(2)).toBe(2); // room 3 is too small
  });

  it("uses the conservative (mean + σ) heat index when asked", () => {
    const rooms = [room(1, 85, 30, false, 0.2), room(2, 84, 30, false, 4)];
    const expected = planPeriod([cls(1, 20, 2)], rooms, { ...OPTS, movePenalty: 0 });
    const cautious = planPeriod([cls(1, 20, 2)], rooms, { ...OPTS, movePenalty: 0, riskSigmas: 1 });
    expect(expected.feasible && expected.rows[0].toRoomId).toBe(2);
    expect(cautious.feasible && cautious.rows[0].toRoomId).toBe(1);
  });

  it("says so explicitly when a class fits nowhere", () => {
    const res = planPeriod([cls(1, 40, 1)], [room(1, 80, 30), room(2, 80, 32)], OPTS);
    expect(res.feasible).toBe(false);
    if (!res.feasible) expect(res.reason).toMatch(/No room can hold Class 1/);
  });

  it("detects joint infeasibility (two lab classes, one lab)", () => {
    const res = planPeriod([cls(1, 20, 1, true), cls(2, 20, 2, true)], [room(1, 80, 24, true), room(2, 80, 30), room(3, 80, 30)], OPTS);
    expect(res.feasible).toBe(false);
    if (!res.feasible) {
      expect(res.reason).toMatch(/No assignment satisfies/);
      expect(res.options.every((o) => o.feasibleRooms === 1)).toBe(true);
    }
  });

  it("flags classes whose current room is infeasible and forces them to move", () => {
    const res = planPeriod([cls(1, 28, 1)], [room(1, 70, 24), room(2, 85, 30)], OPTS);
    expect(res.feasible).toBe(true);
    if (!res.feasible) return;
    expect(res.currentlyInfeasible).toEqual([1]);
    expect(res.rows[0].toRoomId).toBe(2);
  });

  it("handles an empty period", () => {
    const res = planPeriod([], [room(1, 90)], OPTS);
    expect(res.feasible && res.rows.length).toBe(0);
  });
});
