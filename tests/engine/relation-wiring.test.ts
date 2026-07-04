import { describe, it, expect, vi } from 'vitest';
import { resolveRelationEndpoint, resolveAuthoredRelation, type NearbyNpc } from '../../src/engine/action/relation-wiring.js';
import type { AuthoredRelation } from '../../src/engine/action/mutations.js';

const npcs: NearbyNpc[] = [
  { id: 42, name: 'Grum the Smith', description: 'A burly blacksmith.' },
];

describe('resolveRelationEndpoint', () => {
  it('resolves a pc endpoint to ("pc", String(char.id)) — no lookup needed', () => {
    expect(resolveRelationEndpoint({ node: 'pc' }, { id: 7 }, [])).toEqual({ type: 'pc', ref: '7' });
  });

  it('resolves a location endpoint to ("location", trimmed name) — name-keyed, no lookup', () => {
    expect(resolveRelationEndpoint({ node: 'location', name: '  The Old Mill  ' }, { id: 1 }, [])).toEqual({
      type: 'location',
      ref: 'The Old Mill',
    });
  });

  it('drops a location endpoint with an empty/whitespace name, warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveRelationEndpoint({ node: 'location', name: '   ' }, { id: 1 }, [])).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('resolves an npc endpoint by case-insensitive name match against the supplied nearby-npc list', () => {
    expect(resolveRelationEndpoint({ node: 'npc', name: 'grum the smith' }, { id: 1 }, npcs)).toEqual({
      type: 'npc',
      ref: '42',
    });
  });

  it('drops an npc endpoint against an empty nearby-npc list, warning (never throws)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveRelationEndpoint({ node: 'npc', name: 'grum the smith' }, { id: 1 }, [])).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('grum the smith');
    warn.mockRestore();
  });

  it('drops an npc endpoint whose name matches nobody in a non-empty list, warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveRelationEndpoint({ node: 'npc', name: 'Someone Else' }, { id: 1 }, npcs)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('resolveAuthoredRelation', () => {
  it('resolves a well-formed pc -> location relation to a full RelationKey', () => {
    const relation: AuthoredRelation = {
      from: { node: 'pc' },
      to: { node: 'location', name: 'The Old Mill' },
      relType: 'knows_secret',
      props: {},
    };
    expect(resolveAuthoredRelation(relation, { id: 3 }, [])).toEqual({
      fromType: 'pc',
      fromRef: '3',
      toType: 'location',
      toRef: 'The Old Mill',
      relType: 'knows_secret',
    });
  });

  it('resolves a pc -> npc relation when the npc is in the supplied nearby list', () => {
    const relation: AuthoredRelation = {
      from: { node: 'pc' },
      to: { node: 'npc', name: 'Grum the Smith' },
      relType: 'trust',
      props: { score: 5 },
    };
    expect(resolveAuthoredRelation(relation, { id: 3 }, npcs)).toEqual({
      fromType: 'pc',
      fromRef: '3',
      toType: 'npc',
      toRef: '42',
      relType: 'trust',
    });
  });

  it('drops the whole edge (returns null) when the npc endpoint is unresolvable against an empty list', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const relation: AuthoredRelation = {
      from: { node: 'pc' },
      to: { node: 'npc', name: 'Grum the Smith' },
      relType: 'trust',
      props: {},
    };
    expect(resolveAuthoredRelation(relation, { id: 3 }, [])).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
