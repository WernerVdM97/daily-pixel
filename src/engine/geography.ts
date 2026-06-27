/**
 * Deterministic, engine-owned travel maths over the shared world graph
 * (docs/engine/per-player-map-exploration.md §2). Pure — no DB, no LLM. The
 * engine owns the cheatable truth: stamina cost is `Σ(edge difficulty)` along
 * the least-cost route, never a number the LLM emits.
 */

/** A traversable neighbour and the difficulty (weight) of the edge to it. */
export interface WeightedNeighbour {
  name: string;
  difficulty: number;
}

export type NeighboursOf = (name: string) => WeightedNeighbour[];

export interface RouteResult {
  /** Ordered nodes from origin to destination, inclusive. */
  path: string[];
  /** Σ(edge difficulty) along the path — the stamina cost of the trip. */
  cost: number;
}

/**
 * Least-cost route over edge `difficulty` weights (Dijkstra; trivial at this node
 * count). Returns null when the destination is unreachable from the origin.
 * Same-node trips cost 0.
 */
export function findRoute(from: string, to: string, neighboursOf: NeighboursOf): RouteResult | null {
  if (from === to) return { path: [from], cost: 0 };

  const dist = new Map<string, number>([[from, 0]]);
  const prev = new Map<string, string>();
  const settled = new Set<string>();

  for (;;) {
    // Smallest-distance unsettled node (linear scan — the graph is tiny).
    let u: string | undefined;
    let best = Infinity;
    for (const [node, d] of dist) {
      if (!settled.has(node) && d < best) {
        best = d;
        u = node;
      }
    }
    if (u === undefined || u === to) break;
    settled.add(u);

    for (const nb of neighboursOf(u)) {
      const nd = best + nb.difficulty;
      if (nd < (dist.get(nb.name) ?? Infinity)) {
        dist.set(nb.name, nd);
        prev.set(nb.name, u);
      }
    }
  }

  const cost = dist.get(to);
  if (cost === undefined) return null;

  const path: string[] = [];
  for (let cur: string | undefined = to; cur !== undefined; cur = prev.get(cur)) {
    path.unshift(cur);
  }
  return { path, cost };
}
