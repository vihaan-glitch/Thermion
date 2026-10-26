import { describe, expect, it } from "vitest";
import { hungarian } from "@/lib/hungarian";

function bruteForce(cost: number[][]): number {
  const n = cost.length;
  let best = Infinity;
  const perm = [...Array(n).keys()];
  const permute = (k: number) => {
    if (k === n) {
      best = Math.min(best, perm.reduce((s, j, i) => s + cost[i][j], 0));
      return;
    }
    for (let i = k; i < n; i++) {
      [perm[k], perm[i]] = [perm[i], perm[k]];
      permute(k + 1);
      [perm[k], perm[i]] = [perm[i], perm[k]];
    }
  };
  permute(0);
  return best;
}

describe("hungarian", () => {
  it("solves the classic 3×3 example (hand-verified optimum 5)", () => {
    // Rows: workers, cols: jobs. Optimum: (0→1)=1, (1→0)=2, (2→2)=2 → 5.
    const cost = [
      [4, 1, 3],
      [2, 0, 5],
      [3, 2, 2],
    ];
    const r = hungarian(cost);
    expect(r.cost).toBe(5);
    expect(r.assignment).toEqual([1, 0, 2]);
  });

  it("solves a 4×4 example (hand-verified optimum 140)", () => {
    const cost = [
      [82, 83, 69, 92],
      [77, 37, 49, 92],
      [11, 69, 5, 86],
      [8, 9, 98, 23],
    ];
    // Hand check: 0→2 (69) + 1→1 (37) + 2→0 (11) + 3→3 (23) = 140. The greedy
    // choice 3→0 (8), 2→2 (5) leaves row 0 only cols 1/3 and costs at least
    // 8 + 5 + 92 + 37 = 142. The brute-force enumeration below confirms 140.
    const r = hungarian(cost);
    expect(r.cost).toBe(140);
    expect(r.assignment).toEqual([2, 1, 0, 3]);
    expect(bruteForce(cost)).toBe(140);
  });

  it("handles ties, zeros, negatives and 1×1", () => {
    expect(hungarian([[7]])).toEqual({ assignment: [0], cost: 7 });
    expect(hungarian([]).cost).toBe(0);
    expect(
      hungarian([
        [0, 0],
        [0, 0],
      ]).cost,
    ).toBe(0);
    expect(
      hungarian([
        [-5, 1],
        [1, -5],
      ]).cost,
    ).toBe(-10);
  });

  it("matches brute force on random matrices", () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let trial = 0; trial < 40; trial++) {
      const n = 1 + (trial % 7);
      const cost = Array.from({ length: n }, () => Array.from({ length: n }, () => Math.floor(rand() * 100)));
      const r = hungarian(cost);
      expect(r.cost).toBe(bruteForce(cost));
      expect(new Set(r.assignment).size).toBe(n);
    }
  });

  it("rejects non-square and non-finite input", () => {
    expect(() => hungarian([[1, 2]])).toThrow(/square/);
    expect(() => hungarian([[Infinity]])).toThrow(/finite/);
  });
});
