/**
 * Hungarian algorithm (Kuhn-Munkres) for the minimum-cost perfect assignment
 * on a square cost matrix, O(n³). Written from scratch; pure.
 *
 * This is the shortest-augmenting-path formulation with dual potentials:
 * rows are inserted one at a time; for each, a Dijkstra-like scan over
 * columns using reduced costs c[i][j] − u[i] − v[j] (kept ≥ 0 by the duals)
 * finds the cheapest augmenting path, after which the potentials are updated
 * and the path is flipped. Each insertion is O(n²), so O(n³) total.
 *
 * Costs must be finite. Callers model "forbidden" pairs with a large finite
 * cost and check the result (see reassign.ts), because ∞ − ∞ breaks the
 * potential arithmetic.
 */

export interface AssignmentResult {
  /** assignment[row] = column */
  assignment: number[];
  /** Sum of cost[row][assignment[row]] */
  cost: number;
}

export function hungarian(cost: number[][]): AssignmentResult {
  const n = cost.length;
  if (n === 0) return { assignment: [], cost: 0 };
  for (const row of cost) {
    if (row.length !== n) throw new Error("hungarian: cost matrix must be square");
    for (const c of row) if (!Number.isFinite(c)) throw new Error("hungarian: costs must be finite");
  }

  // 1-indexed arrays; index 0 is a virtual column used as the path root.
  const u = new Array<number>(n + 1).fill(0); // row potentials
  const v = new Array<number>(n + 1).fill(0); // column potentials
  const p = new Array<number>(n + 1).fill(0); // p[j] = row matched to column j (0 = free)
  const way = new Array<number>(n + 1).fill(0); // predecessor column on the augmenting path

  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(n + 1).fill(Infinity);
    const used = new Array<boolean>(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    // Flip the augmenting path.
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }

  const assignment = new Array<number>(n).fill(-1);
  for (let j = 1; j <= n; j++) if (p[j] !== 0) assignment[p[j] - 1] = j - 1;
  let total = 0;
  for (let i = 0; i < n; i++) total += cost[i][assignment[i]];
  return { assignment, cost: total };
}
