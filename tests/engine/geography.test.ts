import { describe, it, expect } from 'vitest';
import { findRoute, type NeighboursOf } from '../../src/engine/geography.js';

// A small weighted graph:
//   Oak ─1─ Town ─1─ Blacksmith
//    └──3── Ridge
// (symmetric adjacency, like the real edge repo exposes)
const ADJ: Record<string, { name: string; difficulty: number }[]> = {
  Oak: [{ name: 'Town', difficulty: 1 }, { name: 'Ridge', difficulty: 3 }],
  Town: [{ name: 'Oak', difficulty: 1 }, { name: 'Blacksmith', difficulty: 1 }],
  Blacksmith: [{ name: 'Town', difficulty: 1 }],
  Ridge: [{ name: 'Oak', difficulty: 3 }],
  Island: [], // unreachable from Oak
};
const neighboursOf: NeighboursOf = (n) => ADJ[n] ?? [];

describe('findRoute — Σ difficulty', () => {
  it('sums edge difficulty along the least-cost path', () => {
    expect(findRoute('Oak', 'Blacksmith', neighboursOf)).toEqual({ path: ['Oak', 'Town', 'Blacksmith'], cost: 2 });
  });

  it('weights terrain, not hop-count (Oak→Ridge costs 3 in one hop)', () => {
    expect(findRoute('Oak', 'Ridge', neighboursOf)).toEqual({ path: ['Oak', 'Ridge'], cost: 3 });
  });

  it('same node costs 0', () => {
    expect(findRoute('Oak', 'Oak', neighboursOf)).toEqual({ path: ['Oak'], cost: 0 });
  });

  it('returns null when unreachable', () => {
    expect(findRoute('Oak', 'Island', neighboursOf)).toBeNull();
    expect(findRoute('Oak', 'Nowhere', neighboursOf)).toBeNull();
  });

  it('prefers the cheaper of two routes', () => {
    // Add a cheap bypass Oak─1─Shortcut─1─Blacksmith vs Oak─Town─Blacksmith (also 2): tie keeps a valid path.
    const adj: Record<string, { name: string; difficulty: number }[]> = {
      A: [{ name: 'B', difficulty: 5 }, { name: 'C', difficulty: 1 }],
      B: [{ name: 'D', difficulty: 1 }],
      C: [{ name: 'D', difficulty: 1 }],
      D: [],
    };
    expect(findRoute('A', 'D', (n) => adj[n] ?? [])).toEqual({ path: ['A', 'C', 'D'], cost: 2 });
  });
});
