// RED: tests fail because FallbackLlmGateway doesn't exist yet

import { describe, it, expect, vi } from 'vitest';
import { FallbackLlmGateway, DIVINE_INTERVENTION_TYPE } from '../../src/llm/FallbackLlmGateway.js';
import { MockLlmGateway } from '../../src/llm/MockLlmGateway.js';
import type { LlmContext, LlmDecision } from '../../src/llm/LlmGateway.js';

const testContext: LlmContext = {
  character: {
    class: 'Warrior',
    stats: { physical: 3, wisdom: -1, intelligence: 0, charisma: 0 },
    health: 12,
    stamina: 10,
    alignment: 'lawful good',
    dayJob: 'Blacksmith',
  },
  location: { name: 'The Warden\'s Oak' },
  nearbyNpcs: [{ name: 'Greta', description: 'A stern blacksmith' }],
  nearbyPcs: [],
  recentActions: [{ type: 'hunt', outcome: 'failure' }],
  rawInput: 'go hunt a wolf',
  scalingHint: 'Day 1 — standard difficulty',
};

function makeDecision(overrides?: Partial<LlmDecision>): LlmDecision {
  return {
    prompt: 'You venture into the wilds.',
    distilledType: 'hunt',
    stat: 'physical',
    baseDc: 12,
    required: false,
    done: false,
    decision: [
      { label: 'Track wolf', dcModifier: 2 },
      { label: 'Bail', dcModifier: null },
    ],
    ...overrides,
  };
}

describe('FallbackLlmGateway — happy path', () => {
  it('passes through the inner gateway response on success', async () => {
    const inner = new MockLlmGateway();
    inner.setDecision(makeDecision());
    const gateway = new FallbackLlmGateway(inner);

    const result = await gateway.decide(testContext);

    expect(result.distilledType).toBe('hunt');
    expect(result.baseDc).toBe(12);
  });

  it('passes the original context to inner gateway', async () => {
    const inner = new MockLlmGateway();
    inner.setDecision(makeDecision());
    const gateway = new FallbackLlmGateway(inner);

    await gateway.decide(testContext);

    expect(inner.calls).toHaveLength(1);
    expect(inner.calls[0].context.rawInput).toBe('go hunt a wolf');
    expect(inner.calls[0].context.nearbyNpcs).toHaveLength(1);
  });

  it('does not call fallback counter on success', async () => {
    const inner = new MockLlmGateway();
    inner.setDecision(makeDecision());
    const onFallback = vi.fn();
    const gateway = new FallbackLlmGateway(inner, { onTier2Fallback: onFallback });

    await gateway.decide(testContext);

    expect(onFallback).not.toHaveBeenCalled();
  });
});

describe('FallbackLlmGateway — tier 1 (simpler retry)', () => {
  it('retries with stripped context on first failure', async () => {
    const inner = new MockLlmGateway();
    // First call throws
    const decision1 = makeDecision();
    let callCount = 0;
    vi.spyOn(inner, 'decide').mockImplementation(async (ctx) => {
      callCount++;
      if (callCount === 1) throw new Error('API error');
      return decision1;
    });

    const gateway = new FallbackLlmGateway(inner);
    const result = await gateway.decide(testContext);

    expect(result.distilledType).toBe('hunt');
    expect(callCount).toBe(2);
  });

  it('strips context on retry — removes NPCs, PCs, location, history, previous decisions', async () => {
    const inner = new MockLlmGateway();
    let retryContext: LlmContext | null = null;
    let callCount = 0;
    vi.spyOn(inner, 'decide').mockImplementation(async (ctx) => {
      callCount++;
      if (callCount === 1) throw new Error('API error');
      retryContext = ctx;
      return makeDecision();
    });

    const gateway = new FallbackLlmGateway(inner);
    await gateway.decide(testContext);

    expect(retryContext).not.toBeNull();
    // Stripped context keeps only character basics + rawInput
    expect(retryContext!.location.name).toBe('unknown');
    expect(retryContext!.nearbyNpcs).toEqual([]);
    expect(retryContext!.nearbyPcs).toEqual([]);
    expect(retryContext!.recentActions).toEqual([]);
    expect(retryContext!.previousDecisions).toBeUndefined();
    expect(retryContext!.scalingHint).toBe('');
    // Character basics preserved
    expect(retryContext!.character.class).toBe('Warrior');
    expect(retryContext!.character.stats.physical).toBe(3);
    expect(retryContext!.character.health).toBe(12);
    expect(retryContext!.character.stamina).toBe(10);
    // But character details stripped
    expect(retryContext!.character.alignment).toBe('');
    expect(retryContext!.character.dayJob).toBe('');
    // Raw input preserved
    expect(retryContext!.rawInput).toBe('go hunt a wolf');
  });

  it('does not call tier-2 fallback counter on tier-1 success', async () => {
    const inner = new MockLlmGateway();
    let callCount = 0;
    vi.spyOn(inner, 'decide').mockImplementation(async (ctx) => {
      callCount++;
      if (callCount === 1) throw new Error('API error');
      return makeDecision();
    });
    const onFallback = vi.fn();
    const gateway = new FallbackLlmGateway(inner, { onTier2Fallback: onFallback });

    await gateway.decide(testContext);

    expect(onFallback).not.toHaveBeenCalled();
  });
});

describe('FallbackLlmGateway — tier 2 (divine intervention)', () => {
  it('returns divine intervention when both attempts fail', async () => {
    const inner = new MockLlmGateway();
    vi.spyOn(inner, 'decide').mockRejectedValue(new Error('API error'));

    const gateway = new FallbackLlmGateway(inner);
    const result = await gateway.decide(testContext);

    expect(result.distilledType).toBe(DIVINE_INTERVENTION_TYPE);
    expect(result.done).toBe(true);
    expect(result.outcomeText).toContain('The Warden\'s hand');
  });

  it('includes the divine message text', async () => {
    const inner = new MockLlmGateway();
    vi.spyOn(inner, 'decide').mockRejectedValue(new Error('API error'));

    const gateway = new FallbackLlmGateway(inner);
    const result = await gateway.decide(testContext);

    expect(result.outcomeText).toBe(
      "A flash of light. The Warden's hand on your shoulder. " +
      "You wake beneath the Oak, your action lost to forces beyond mortal ken.",
    );
  });

  it('returns empty decision array (no options)', async () => {
    const inner = new MockLlmGateway();
    vi.spyOn(inner, 'decide').mockRejectedValue(new Error('API error'));

    const gateway = new FallbackLlmGateway(inner);
    const result = await gateway.decide(testContext);

    expect(result.decision).toEqual([]);
  });

  it('returns empty mutations array', async () => {
    const inner = new MockLlmGateway();
    vi.spyOn(inner, 'decide').mockRejectedValue(new Error('API error'));

    const gateway = new FallbackLlmGateway(inner);
    const result = await gateway.decide(testContext);

    expect(result.mutations).toEqual([]);
  });

  it('calls the tier-2 fallback counter when divine intervention fires', async () => {
    const inner = new MockLlmGateway();
    vi.spyOn(inner, 'decide').mockRejectedValue(new Error('API error'));
    const onFallback = vi.fn();
    const gateway = new FallbackLlmGateway(inner, { onTier2Fallback: onFallback });

    await gateway.decide(testContext);

    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it('does not crash when no callback is provided', async () => {
    const inner = new MockLlmGateway();
    vi.spyOn(inner, 'decide').mockRejectedValue(new Error('API error'));

    const gateway = new FallbackLlmGateway(inner); // no callback
    const result = await gateway.decide(testContext);

    expect(result.distilledType).toBe(DIVINE_INTERVENTION_TYPE);
  });

  it('tries inner gateway twice (original + stripped retry)', async () => {
    const inner = new MockLlmGateway();
    const spy = vi.spyOn(inner, 'decide').mockRejectedValue(new Error('API error'));

    const gateway = new FallbackLlmGateway(inner);
    await gateway.decide(testContext);

    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('FallbackLlmGateway — edge cases', () => {
  it('handles non-Error throws (string)', async () => {
    const inner = new MockLlmGateway();
    vi.spyOn(inner, 'decide').mockRejectedValue('timeout');

    const gateway = new FallbackLlmGateway(inner);
    const result = await gateway.decide(testContext);

    expect(result.distilledType).toBe(DIVINE_INTERVENTION_TYPE);
  });

  it('handles null throws', async () => {
    const inner = new MockLlmGateway();
    vi.spyOn(inner, 'decide').mockRejectedValue(null);

    const gateway = new FallbackLlmGateway(inner);
    const result = await gateway.decide(testContext);

    expect(result.distilledType).toBe(DIVINE_INTERVENTION_TYPE);
  });

  it('handles empty context gracefully', async () => {
    const inner = new MockLlmGateway();
    const decision = makeDecision();
    let callCount = 0;
    vi.spyOn(inner, 'decide').mockImplementation(async (ctx) => {
      callCount++;
      if (callCount === 1) throw new Error('fail');
      return decision;
    });

    const gateway = new FallbackLlmGateway(inner);
    const minimalCtx: LlmContext = {
      character: { class: 'Mage', stats: { physical: 0, wisdom: 3, intelligence: 5, charisma: 1 }, health: 10, stamina: 10, alignment: 'neutral', dayJob: 'Alchemist' },
      location: { name: 'unknown' },
      nearbyNpcs: [],
      nearbyPcs: [],
      recentActions: [],
      rawInput: 'search',
      scalingHint: '',
    };

    const result = await gateway.decide(minimalCtx);

    expect(result.distilledType).toBe('hunt');
    expect(callCount).toBe(2);
  });
});
