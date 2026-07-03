import { describe, it, expect } from 'vitest';
import { heuristicClassify, notImplementedClassifyFallback } from '../../../src/llm/pipeline/classifier.js';
import type { ActionType, ClassifyHit } from '../../../src/llm/pipeline/types.js';
import type { LlmContext } from '../../../src/llm/LlmGateway.js';

function expectHit(rawInput: string, actionType: ActionType): ClassifyHit {
  const result = heuristicClassify(rawInput);
  expect(result.kind).toBe('hit');
  const hit = result as ClassifyHit;
  expect(hit.actionType).toBe(actionType);
  return hit;
}

function expectMiss(rawInput: string): void {
  const result = heuristicClassify(rawInput);
  expect(result.kind).toBe('miss');
  if (result.kind === 'miss') {
    expect(result.rawInput).toBe(rawInput);
  }
}

describe('heuristicClassify — rest', () => {
  it.each([
    'rest at the inn',
    'sleep until dawn',
    'take a nap',
    'recover from wounds',
    'set up camp for the night',
    'relax by the fire',
    'recuperate for a while',
  ])('classifies "%s" as rest', (input) => {
    expectHit(input, 'rest');
  });
});

describe('heuristicClassify — travel', () => {
  it.each([
    'travel to the city',
    'journey to the mountains',
    'go to the market',
    'head north',
    'move to the plaza',
    'cross the frontier',
    'set off for home',
    'walk to the well',
    'ride to town',
    'sail to the isles',
    'return to the village',
  ])('classifies "%s" as travel', (input) => {
    expectHit(input, 'travel');
  });
});

describe('heuristicClassify — combat', () => {
  it.each([
    'attack the goblin',
    'fight the raider',
    'strike the beast',
    'kill the rat',
    'slay the dragon',
    'stab the guard',
    'shoot the archer',
    'charge at the enemy',
    'draw my sword',
  ])('classifies "%s" as combat', (input) => {
    expectHit(input, 'combat');
  });
});

describe('heuristicClassify — social', () => {
  it.each([
    'talk to the merchant',
    'speak with the elder',
    'chat with the bard',
    'persuade the guard',
    'negotiate a truce',
    'greet the stranger',
    'convince the captain',
    'bribe the guard',
    'intimidate the thug',
    'charm the noble',
    'barter with the trader',
    'trade with the merchant',
    'ask the wizard',
  ])('classifies "%s" as social', (input) => {
    expectHit(input, 'social');
  });
});

describe('heuristicClassify — skill', () => {
  it.each([
    'pick the lock on the door',
    'craft a potion',
    'brew a tonic',
    'forge a blade',
    'repair the wagon',
    'build a shelter',
    'climb the wall',
    'pray at the shrine',
    'meditate quietly',
    'study the tome',
    'train with the sword',
    'tinker with the device',
    'carve a totem',
    'cook a meal',
    'heal the wounded',
    'bandage the wound',
  ])('classifies "%s" as skill', (input) => {
    expectHit(input, 'skill');
  });
});

describe('heuristicClassify — search', () => {
  it.each([
    'search the room',
    'investigate the noise',
    'scavenge for supplies',
    'forage for herbs',
    'loot the chest',
    'rummage through the drawers',
    'scout the area',
    'examine the body',
    'inspect the ruins',
    'look for clues',
    'dig through the rubble',
  ])('classifies "%s" as search', (input) => {
    expectHit(input, 'search');
  });
});

describe('heuristicClassify — ambiguous/unmatched input misses rather than guessing', () => {
  it.each([
    '',
    '   ',
    'purple elephants dance sideways',
    'ponder the meaning of the void',
  ])('returns a miss for unmatched input "%s"', (input) => {
    expectMiss(input);
  });

  it('returns a miss when input matches more than one category (never guesses)', () => {
    // Matches both social ("talk to") and combat ("attack") — genuinely ambiguous intent.
    expectMiss('talk to the guard then attack him');
  });

  it('never returns the "other" category — unmatched input misses instead of defaulting', () => {
    const result = heuristicClassify('do something inscrutable');
    expect(result.kind).toBe('miss');
  });
});

describe('heuristicClassify — routing flags', () => {
  it('flags roll-driven categories (combat/social/skill/search) as needing a roll', () => {
    const hit = expectHit('attack the goblin at the gate', 'combat');
    expect(hit.flags.needs_roll).toBe(true);
  });

  it('does not flag rest as needing a roll', () => {
    const hit = expectHit('rest at the inn', 'rest');
    expect(hit.flags.needs_roll).toBe(false);
  });

  it('does not flag simple travel as needing a roll', () => {
    const hit = expectHit('travel to the city', 'travel');
    expect(hit.flags.needs_roll).toBe(false);
  });

  it('flags unsafe-sounding locations in the raw input', () => {
    const hit = expectHit('search the abandoned dungeon for treasure', 'search');
    expect(hit.flags.unsafe_location).toBe(true);
  });

  it('does not flag ordinary locations as unsafe', () => {
    const hit = expectHit('talk to the merchant', 'social');
    expect(hit.flags.unsafe_location).toBe(false);
  });

  it('flags a named target when the input directs the action at someone/something', () => {
    const hit = expectHit('attack the goblin at the gate', 'combat');
    expect(hit.flags.target_present).toBe(true);
  });

  it('does not flag a target on an untargeted action', () => {
    const hit = expectHit('sleep', 'rest');
    expect(hit.flags.target_present).toBe(false);
  });
});

describe('notImplementedClassifyFallback — Stage 1 seam', () => {
  it('rejects rather than silently guessing a hit (real fallback is out of scope for Stage 1)', async () => {
    const context = {} as LlmContext;
    await expect(notImplementedClassifyFallback('do something inscrutable', context)).rejects.toThrow(
      /no LLM fallback is wired up/i,
    );
  });
});
