import { describe, it, expect } from 'vitest';
import { renderMap } from '../../src/discord/map-render.js';
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

  it('marks the current location and groups under the home region', () => {
    const out = renderMap('Kael', VALE);
    expect(out).toContain('── THE VALE (home) ──');
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

  it('surfaces frontier exits under a "roads not yet walked" section', () => {
    const out = renderMap('Kael', VALE);
    expect(out).toContain('── ROADS NOT YET WALKED ──');
    expect(out).toContain('🧭 S the deep woods swallow the trail   ??? (from The Forest Edge)');
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
    expect(out).toContain('── THE ASHEN REACH ──');
    expect(out).toContain('Eastvale');
    expect(out).not.toContain('── THE VALE');
  });

  it('reports no match for an unknown focus', () => {
    expect(renderMap('Kael', VALE, 'Atlantis')).toContain('No charted region or place matches "Atlantis"');
  });
});
