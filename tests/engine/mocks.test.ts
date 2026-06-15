import { describe, it, expect } from 'vitest';
import { MockWorldEngine } from '../../src/engine/MockWorldEngine.js';
import { MockLlmGateway } from '../../src/llm/MockLlmGateway.js';
import type { WorldEngine } from '../../src/engine/WorldEngine.js';
import type { LlmGateway } from '../../src/llm/LlmGateway.js';

describe('MockWorldEngine satisfies WorldEngine', () => {
  it('can be assigned to the WorldEngine type', () => {
    // Compile-time check: if MockWorldEngine doesn't implement WorldEngine,
    // this line won't type-check.
    const engine: WorldEngine = new MockWorldEngine();
    expect(engine).toBeDefined();
  });

  it('characterExists returns false by default', () => {
    const engine = new MockWorldEngine();
    expect(engine.characterExists('any')).toBe(false);
  });

  it('getCharacter returns null by default', () => {
    const engine = new MockWorldEngine();
    expect(engine.getCharacter('any')).toBeNull();
  });

  it('tracks calls to createCharacter', () => {
    const engine = new MockWorldEngine();
    engine.createCharacter('discord-1', {
      name: 'Test',
      class: 'Warrior',
      upbringing: 'Village',
      race: 'Human',
      alignment: 'lawful good',
      dayJob: 'Blacksmith',
    });
    expect(engine.calls.createCharacter).toHaveLength(1);
    expect(engine.calls.createCharacter[0].discordUserId).toBe('discord-1');
    expect(engine.calls.createCharacter[0].data.name).toBe('Test');
  });

  it('returns canned character when set', () => {
    const engine = new MockWorldEngine();
    const canned = MockWorldEngine.defaultCharacter({ name: 'Bran' });
    engine.setCharacter(canned);
    expect(engine.getCharacter('any')?.name).toBe('Bran');
  });

  it('getMeta returns canned values', () => {
    const engine = new MockWorldEngine();
    engine.setMeta('day_number', '42');
    expect(engine.getMeta('day_number')).toBe('42');
    expect(engine.getMeta('unknown')).toBeNull();
  });

  it('submitFeedback and submitBug track calls', () => {
    const engine = new MockWorldEngine();
    engine.submitFeedback(1, 'Great game!');
    engine.submitBug(1, 'Found a bug');
    expect(engine.calls.submitFeedback).toHaveLength(1);
    expect(engine.calls.submitBug[0].text).toBe('Found a bug');
  });

  it('tick returns default result', () => {
    const engine = new MockWorldEngine();
    const result = engine.tick(true);
    expect(result.dayNumber).toBe(1);
    expect(result.playersAffected).toBe(0);
  });

  it('getLocation returns a default when none set', () => {
    const engine = new MockWorldEngine();
    const loc = engine.getLocation('Test Place');
    expect(loc).toBeDefined();
    expect(loc!.name).toBe('Test Place');
    expect(loc!.tags).toEqual(['mock']);
  });
});

describe('MockLlmGateway satisfies LlmGateway', () => {
  it('can be assigned to the LlmGateway type', () => {
    const gateway: LlmGateway = new MockLlmGateway();
    expect(gateway).toBeDefined();
  });

  it('returns canned decision when set', async () => {
    const gateway = new MockLlmGateway();
    const canned = MockLlmGateway.defaultDecision({ distilledType: 'hunt' });
    gateway.setDecision(canned);
    const result = await gateway.decide({
      character: {
        class: 'Ranger',
        stats: { physical: 1, wisdom: 2, intelligence: 0, charisma: -1 },
        health: 10,
        stamina: 10,
        alignment: 'chaotic good',
        dayJob: 'Hunter',
      },
      location: { name: 'Dark Forest' },
      nearbyNpcs: [],
      nearbyPcs: [],
      recentActions: [],
      rawInput: 'go hunt a deer',
      scalingHint: 'day 3',
    });
    expect(result.distilledType).toBe('hunt');
    expect(result.decision).toHaveLength(3);
  });

  it('throws if decide() called without a canned decision', async () => {
    const gateway = new MockLlmGateway();
    await expect(gateway.decide({
      character: {} as never,
      location: { name: 'test' },
      nearbyNpcs: [],
      nearbyPcs: [],
      recentActions: [],
      rawInput: 'test',
      scalingHint: 'day 1',
    })).rejects.toThrow('no canned decision');
  });
});
