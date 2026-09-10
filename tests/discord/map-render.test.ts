import { describe, it, expect } from 'vitest';
import { renderMap, resolveMapFocus } from '../../src/render/map-render.js';
import type { DiscoveredGraph, DiscoveredNode } from '../../src/engine/WorldEngine.js';

function node(name: string, over: Partial<DiscoveredNode> = {}): DiscoveredNode {
  return { name, emoji: '📍', isSafe: false, nodeTier: 2, region: 'The Vale', lastVisitedAt: '2026-06-01 00:00:00', ...over };
}

const VALE: DiscoveredGraph = {
  current: "The Warden's Oak",
  nodes: [
    node("The Warden's Oak", { emoji: '🌳', isSafe: true, nodeTier: 0, lastVisitedAt: '2026-06-10' }),
    node('Town Square', { emoji: '🏛️', isSafe: true, nodeTier: 1, lastVisitedAt: '2026-06-09' }),
    node('The Town Forge', { emoji: '🔥', isSafe: true, lastVisitedAt: '2026-06-08' }),
    node('The Forest Edge', { emoji: '🌿', isSafe: false, lastVisitedAt: '2026-06-07' }),
  ],
  edges: [
    { from: "The Warden's Oak", to: 'Town Square', direction: 'N', difficulty: 1, flavour: null },
    { from: 'Town Square', to: 'The Town Forge', direction: 'E', difficulty: 1, flavour: null },
    { from: "The Warden's Oak", to: 'The Forest Edge', direction: 'S', difficulty: 2, flavour: null },
  ],
  frontiers: [{ from: 'The Forest Edge', direction: 'S', teaser: 'the deep woods swallow the trail', difficulty: 3 }],
};

describe('renderMap', () => {
  it('opens with a count progress line (never a fraction)', () => {
    expect(renderMap('Kael', VALE)).toContain("🗺️ **Kael's Map** — 4 charted · 1 road into the unknown");
  });

  it('marks the current location and groups under the home region (separator + bold label)', () => {
    const out = renderMap('Kael', VALE);
    expect(out).toContain('━━━'); // Discord separator between sections
    expect(out).toContain('**The Vale** (home)');
    expect(out).toMatch(/🌳🛡️ The Warden's Oak {2}◀ you are here/);
  });

  it('per-line glyphs: emoji + safety + effort (effort from the incoming edge, omitted at the root)', () => {
    const out = renderMap('Kael', VALE);
    // Root carries no effort glyph.
    expect(out).toMatch(/🌳🛡️ The Warden's Oak/);
    expect(out).not.toMatch(/🌳🛡️🚶/);
    // A tier-1 reached over a difficulty-1 edge → 🚶; a wild node over difficulty-2 → 🏃.
    expect(out).toContain('🏛️🛡️🚶 Town Square');
    expect(out).toContain('🌿⚠️🏃 The Forest Edge');
  });

  it('draws box-drawing connectors so levels read on mobile (Forge nested under the Square)', () => {
    const lines = renderMap('Kael', VALE).split('\n');
    const square = lines.find((l) => l.includes('Town Square'))!;
    const forge = lines.find((l) => l.includes('The Town Forge'))!;
    // Children carry a ├─/└─ connector; a deeper child carries a leading │ rail.
    expect(square).toMatch(/^[├└]─ /);
    expect(forge).toMatch(/^│\s+└─ /);
    // Prefix (everything before the node emoji) is longer for the deeper node.
    const prefixLen = (s: string) => s.search(/[^│├└─\s]/);
    expect(prefixLen(forge)).toBeGreaterThan(prefixLen(square));
  });

  it('surfaces frontier exits under "Unexplored paths", grouped by from-location with rails', () => {
    const out = renderMap('Kael', VALE);
    expect(out).toContain('**Unexplored paths**');
    // Grouped: the from-location on its own line, then each path under a rail connector.
    const lines = out.split('\n');
    const fromIdx = lines.findIndex((l) => l.includes('🌿 The Forest Edge') && !l.includes('◀'));
    expect(fromIdx).toBeGreaterThan(-1);
    // Connector, then leading difficulty (🧗 for band 3), then the compass arrow (⬇️ = S), then teaser.
    expect(lines[fromIdx + 1]).toBe('└─ 🧗 ⬇️ the deep woods swallow the trail');
  });

  it('orders siblings most-recently-visited first', () => {
    const g: DiscoveredGraph = {
      current: 'Hub',
      nodes: [
        node('Hub', { nodeTier: 0, region: 'R', lastVisitedAt: '2026-06-10' }),
        node('Older', { region: 'R', lastVisitedAt: '2026-01-01' }),
        node('Newer', { region: 'R', lastVisitedAt: '2026-06-09' }),
      ],
      edges: [
        { from: 'Hub', to: 'Older', direction: 'N', difficulty: 1, flavour: null },
        { from: 'Hub', to: 'Newer', direction: 'S', difficulty: 1, flavour: null },
      ],
      frontiers: [],
    };
    const lines = renderMap('Kael', g).split('\n');
    expect(lines.findIndex((l) => l.includes('Newer'))).toBeLessThan(lines.findIndex((l) => l.includes('Older')));
  });

  it('effectiveRegion climbs multiple hops (null → null → region grandparent)', () => {
    const g: DiscoveredGraph = {
      current: "The Warden's Oak",
      nodes: [
        node("The Warden's Oak", { nodeTier: 0, region: 'The Vale', lastVisitedAt: '2026-06-10' }),
        node('Waypoint', { region: null, lastVisitedAt: '2026-06-08' }),
        node('Deep Cave', { region: null, lastVisitedAt: '2026-06-05' }),
      ],
      edges: [
        { from: "The Warden's Oak", to: 'Waypoint', direction: 'S', difficulty: 2, flavour: null },
        { from: 'Waypoint', to: 'Deep Cave', direction: 'S', difficulty: 3, flavour: null },
      ],
      frontiers: [],
    };
    const out = renderMap('Test', g);
    // Deep Cave: no region; Waypoint: no region; grandparent Oak: The Vale → both inherit.
    expect(out).toContain('**The Vale** (home)');
    expect(out).toContain('Deep Cave');
    expect(out).not.toContain('**Elsewhere**');
  });

  it('a null-region node inherits the region of its nearest BFS ancestor (feedback #14)', () => {
    // Old Watchtower scenario: a node with region = null should group with its parent's
    // region instead of landing in the "Elsewhere" catch-all.
    const g: DiscoveredGraph = {
      current: "The Warden's Oak",
      nodes: [
        node("The Warden's Oak", { nodeTier: 0, region: 'The Vale', lastVisitedAt: '2026-06-10' }),
        node('Old Watchtower', { region: null, lastVisitedAt: '2026-06-05' }),
      ],
      edges: [
        { from: "The Warden's Oak", to: 'Old Watchtower', direction: 'NE', difficulty: 2, flavour: null },
      ],
      frontiers: [],
    };
    const out = renderMap('Test', g);
    // Node groups under The Vale (parent's region), not under Elsewhere.
    expect(out).toContain('**The Vale** (home)');
    expect(out).toContain('Old Watchtower');
    expect(out).not.toContain('**Elsewhere**');
  });

  it('collapses an over-cap region tail into a "+K more" line (no silent truncation)', () => {
    const nodes: DiscoveredNode[] = [node('Hub', { nodeTier: 0, region: 'Big', lastVisitedAt: '2026-06-30' })];
    const edges = [];
    for (let i = 0; i < 20; i++) {
      nodes.push(node(`Leaf ${String(i).padStart(2, '0')}`, { region: 'Big', lastVisitedAt: `2026-06-${String(i + 1).padStart(2, '0')}` }));
      edges.push({ from: 'Hub', to: `Leaf ${String(i).padStart(2, '0')}`, direction: 'N', difficulty: 1, flavour: null });
    }
    const out = renderMap('Kael', { current: 'Hub', nodes, edges, frontiers: [] });
    expect(out).toMatch(/└─ … \+\d+ more \(\/map Big\)/);
  });

  it('drills into a single region when focused', () => {
    const g: DiscoveredGraph = {
      current: "The Warden's Oak",
      nodes: [
        node("The Warden's Oak", { nodeTier: 0, region: 'The Vale' }),
        node('Eastvale', { region: 'The Ashen Reach', emoji: '🏘️' }),
      ],
      edges: [{ from: "The Warden's Oak", to: 'Eastvale', direction: 'E', difficulty: 2, flavour: null }],
      frontiers: [],
    };
    const out = renderMap('Kael', g, 'The Ashen Reach');
    expect(out).toContain('**The Ashen Reach**');
    expect(out).toContain('Eastvale');
    expect(out).not.toContain('**The Vale**');
  });

  it('reports no match for an unknown focus', () => {
    expect(renderMap('Kael', VALE, 'Atlantis')).toContain('No charted region or place matches `Atlantis`');
  });

  it('renders a markdown-laden focus query literally in the no-match message', () => {
    const out = renderMap('Kael', VALE, '**boom**');
    expect(out).toContain('matches `**boom**`');
  });

  it('focuses a place to its own roads (fuzzy "town" → Town Square, neighbours by reversed heading)', () => {
    const out = renderMap('Kael', VALE, 'town');
    // Header still present, then the place line with region.
    expect(out).toContain("🏛️🛡️ **Town Square** · The Vale");
    // The Oak is NORTH of Town Square in the seed (Oak→N→Town Square), so from the Square
    // the Oak reads SOUTH (⬇️); the Forge sits east (➡️). No region tree, no other regions' nodes.
    // Road lines now carry the destination's own glyph + safety (full-map node parity).
    expect(out).toContain("⬇️ 🌳🛡️ The Warden's Oak");
    expect(out).toContain("➡️ 🔥🛡️ The Town Forge");
    expect(out).not.toContain('**The Vale** (home)'); // node view, not the region tree
    expect(out).not.toContain('The Forest Edge'); // not connected to Town Square
  });

  it("a place focus surfaces that node's own frontier exits", () => {
    const out = renderMap('Kael', VALE, 'forest edge');
    expect(out).toContain('🌿⚠️ **The Forest Edge**');
    expect(out).toContain('**Unexplored paths**');
    expect(out).toContain('the deep woods swallow the trail');
  });

  it('a drilled-in region renders uncapped (no "+K more" self-loop — Finding 3)', () => {
    const nodes: DiscoveredNode[] = [node('Hub', { nodeTier: 0, region: 'Big', lastVisitedAt: '2026-06-30' })];
    const edges = [];
    for (let i = 0; i < 20; i++) {
      nodes.push(node(`Leaf ${String(i).padStart(2, '0')}`, { region: 'Big', lastVisitedAt: `2026-06-${String(i + 1).padStart(2, '0')}` }));
      edges.push({ from: 'Hub', to: `Leaf ${String(i).padStart(2, '0')}`, direction: 'N', difficulty: 1, flavour: null });
    }
    const out = renderMap('Kael', { current: 'Hub', nodes, edges, frontiers: [] }, 'Big');
    expect(out).not.toMatch(/\+\d+ more/);
    expect(out).toContain('Leaf 19'); // the tail that would have been collapsed is shown
  });

  describe('resolveMapFocus', () => {
    it('prefers an exact/prefix place hit and tolerates typos & casing', () => {
      expect(resolveMapFocus('Town Square', VALE)).toEqual({ kind: 'node', name: 'Town Square' });
      expect(resolveMapFocus('town', VALE)).toEqual({ kind: 'node', name: 'Town Square' }); // whole-string prefix beats word-prefix
      expect(resolveMapFocus('twn square', VALE)).toEqual({ kind: 'node', name: 'Town Square' }); // typo
    });

    it('resolves a region by a word, and returns none for noise', () => {
      expect(resolveMapFocus('vale', VALE)).toEqual({ kind: 'region', name: 'The Vale' });
      expect(resolveMapFocus('Atlantis', VALE)).toEqual({ kind: 'none' });
    });
  });

  it('groups a region-less visited place under "Elsewhere", not "Uncharted"', () => {
    const g: DiscoveredGraph = {
      current: 'Training Grounds',
      nodes: [node('Training Grounds', { region: null, emoji: '⚔️', isSafe: true })],
      edges: [],
      frontiers: [],
    };
    const out = renderMap('Kael', g);
    expect(out).toContain('**Elsewhere**');
    expect(out).not.toContain('Uncharted'); // never collide with frontier wording
    expect(out).toContain('⚔️🛡️ Training Grounds');
  });
});
