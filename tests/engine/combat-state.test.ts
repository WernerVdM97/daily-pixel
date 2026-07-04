import { describe, it, expect } from 'vitest';
import {
  readCombatState,
  readCombatSave,
  combatStateToSetRelation,
  combatRoundUpdate,
  combatSaveUpdate,
  type CombatState,
} from '../../src/engine/action/combat-state.js';
import type { SceneStateEdge } from '../../src/llm/LlmGateway.js';

function edgeFromAuthored(
  from: { type: 'pc' | 'npc' | 'location'; ref: string },
  to: { type: 'pc' | 'npc' | 'location'; ref: string },
  relType: string,
  props: Record<string, number | string | boolean>,
): SceneStateEdge {
  return { from, to, relType, props };
}

describe('readCombatState / combatStateToSetRelation round-trip', () => {
  it('round-trips a location-anchored combat state (minion/wildlife, decision 4)', () => {
    const state: CombatState = {
      enemyName: 'Wild Boar',
      enemyHp: 8,
      enemyMaxHp: 12,
      round: 1,
      anchor: { node: 'location', name: 'Darkwood Clearing' },
    };
    const authored = combatStateToSetRelation(state);
    expect(authored).toEqual({
      from: { node: 'pc' },
      to: { node: 'location', name: 'Darkwood Clearing' },
      relType: 'in_combat',
      props: { enemyName: 'Wild Boar', enemyHp: 8, enemyMaxHp: 12, round: 1 },
    });

    const edge = edgeFromAuthored(
      { type: 'pc', ref: '7' },
      { type: 'location', ref: 'Darkwood Clearing' },
      'in_combat',
      authored.props,
    );
    expect(readCombatState([edge])).toEqual(state);
  });

  it('round-trips an npc-anchored combat state (named foe/boss, decision 4)', () => {
    const state: CombatState = {
      enemyName: 'Grask the Bandit',
      enemyHp: 15,
      enemyMaxHp: 15,
      round: 1,
      anchor: { node: 'npc', name: '42' }, // structural passthrough — see combat-state.ts caveat
    };
    const authored = combatStateToSetRelation(state);
    const edge = edgeFromAuthored(
      { type: 'pc', ref: '7' },
      { type: 'npc', ref: '42' },
      'in_combat',
      authored.props,
    );
    expect(readCombatState([edge])).toEqual(state);
  });

  it('returns null when no in_combat edge is present', () => {
    expect(readCombatState([])).toBeNull();
  });

  it('returns null when the in_combat edge is not authored by the pc', () => {
    const edge = edgeFromAuthored(
      { type: 'npc', ref: '1' },
      { type: 'pc', ref: '7' },
      'in_combat',
      { enemyName: 'x', enemyHp: 1, enemyMaxHp: 5, round: 1 },
    );
    expect(readCombatState([edge])).toBeNull();
  });

  it('returns null for malformed props: missing enemyName', () => {
    const edge = edgeFromAuthored({ type: 'pc', ref: '7' }, { type: 'location', ref: 'X' }, 'in_combat', {
      enemyHp: 1,
      enemyMaxHp: 5,
      round: 1,
    });
    expect(readCombatState([edge])).toBeNull();
  });

  it('returns null for malformed props: non-numeric round', () => {
    const edge = edgeFromAuthored({ type: 'pc', ref: '7' }, { type: 'location', ref: 'X' }, 'in_combat', {
      enemyName: 'x',
      enemyHp: 1,
      enemyMaxHp: 5,
      round: 'one' as unknown as number,
    });
    expect(readCombatState([edge])).toBeNull();
  });

  it('returns null for malformed props: enemyHp > enemyMaxHp', () => {
    const edge = edgeFromAuthored({ type: 'pc', ref: '7' }, { type: 'location', ref: 'X' }, 'in_combat', {
      enemyName: 'x',
      enemyHp: 20,
      enemyMaxHp: 5,
      round: 1,
    });
    expect(readCombatState([edge])).toBeNull();
  });

  it('returns null for malformed props: enemyMaxHp above ENEMY_HP_MAX (read guard mirrors the write clamp)', () => {
    const edge = edgeFromAuthored({ type: 'pc', ref: '7' }, { type: 'location', ref: 'X' }, 'in_combat', {
      enemyName: 'x',
      enemyHp: 50,
      enemyMaxHp: 100,
      round: 1,
    });
    expect(readCombatState([edge])).toBeNull();
  });
});

describe('combatRoundUpdate', () => {
  const state: CombatState = {
    enemyName: 'Wild Boar',
    enemyHp: 8,
    enemyMaxHp: 12,
    round: 1,
    anchor: { node: 'location', name: 'Darkwood Clearing' },
  };

  it('emits a set_relation with the enemyHp delta applied and round advanced (full absolute prop set)', () => {
    const update = combatRoundUpdate(state, -3, 2);
    expect(update).toEqual({
      from: { node: 'pc' },
      to: { node: 'location', name: 'Darkwood Clearing' },
      relType: 'in_combat',
      props: { enemyName: 'Wild Boar', enemyHp: 5, enemyMaxHp: 12, round: 2 },
    });
  });

  it('clamps enemyHp at 0 (never negative)', () => {
    const update = combatRoundUpdate(state, -100, 2);
    expect(update.props.enemyHp).toBe(0);
  });

  it('clamps enemyHp at enemyMaxHp (never exceeds it, e.g. a healing delta)', () => {
    const update = combatRoundUpdate(state, 100, 2);
    expect(update.props.enemyHp).toBe(12);
  });

  it('preserves enemyName/enemyMaxHp/anchor across the round update', () => {
    const update = combatRoundUpdate(state, -2, 2);
    expect(update.props.enemyName).toBe('Wild Boar');
    expect(update.props.enemyMaxHp).toBe(12);
    expect(update.to).toEqual(state.anchor);
  });

  it('round-trips through readCombatState after being reflected back as a SceneStateEdge', () => {
    const update = combatRoundUpdate(state, -3, 2);
    const edge = edgeFromAuthored(
      { type: 'pc', ref: '7' },
      { type: 'location', ref: 'Darkwood Clearing' },
      'in_combat',
      update.props,
    );
    expect(readCombatState([edge])).toEqual({ ...state, enemyHp: 5, round: 2 });
  });
});

describe('readCombatSave / combatSaveUpdate round-trip', () => {
  it('round-trips a combat_save self-edge', () => {
    const authored = combatSaveUpdate(9);
    expect(authored).toEqual({
      from: { node: 'pc' },
      to: { node: 'pc' },
      relType: 'combat_save',
      props: { savedDay: 9 },
    });

    const edge = edgeFromAuthored({ type: 'pc', ref: '7' }, { type: 'pc', ref: '7' }, 'combat_save', authored.props);
    expect(readCombatSave([edge])).toBe(9);
  });

  it('returns null when no combat_save edge is present', () => {
    expect(readCombatSave([])).toBeNull();
  });

  it('returns null for a malformed savedDay (non-numeric)', () => {
    const edge = edgeFromAuthored({ type: 'pc', ref: '7' }, { type: 'pc', ref: '7' }, 'combat_save', {
      savedDay: 'nine' as unknown as number,
    });
    expect(readCombatSave([edge])).toBeNull();
  });

  it('returns null for a negative savedDay', () => {
    const edge = edgeFromAuthored({ type: 'pc', ref: '7' }, { type: 'pc', ref: '7' }, 'combat_save', {
      savedDay: -1,
    });
    expect(readCombatSave([edge])).toBeNull();
  });

  it('ignores a combat_save edge not shaped pc -> pc', () => {
    const edge = edgeFromAuthored({ type: 'pc', ref: '7' }, { type: 'npc', ref: '1' }, 'combat_save', {
      savedDay: 3,
    });
    expect(readCombatSave([edge])).toBeNull();
  });
});
