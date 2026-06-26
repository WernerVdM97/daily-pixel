import { describe, it, expect, vi } from 'vitest';
import { CritiquedLlmGateway } from '../../src/llm/CritiquedLlmGateway.js';
import type { LlmGateway, LlmContext, LlmDecision, CriticGateway, CriticVerdict } from '../../src/llm/LlmGateway.js';

const baseContext: LlmContext = {
  character: {
    class: 'Ranger',
    stats: { physical: 3, wisdom: 2, intelligence: 1, charisma: 2 },
    health: 7,
    stamina: 4,
    alignment: 'Neutral Good',
    dayJob: 'Fletcher',
  },
  location: { name: 'The Dark Pines', isSafe: false },
  nearbyNpcs: [],
  nearbyPcs: [],
  recentActions: [],
  rawInput: 'fight the boar',
  scalingHint: '',
};

function decision(over: Partial<LlmDecision> = {}): LlmDecision {
  return {
    distilledType: 'combat',
    stat: 'physical',
    baseDc: 12,
    required: true,
    done: false,
    decision: [{ label: 'Strike', dcModifier: 0 }],
    prompt: 'The boar lunges.',
    ...over,
  };
}

/** An inner gateway that returns scripted decisions and records each call's context. */
function innerReturning(...scripted: LlmDecision[]): LlmGateway & { calls: LlmContext[] } {
  const calls: LlmContext[] = [];
  let i = 0;
  return {
    calls,
    decide: vi.fn(async (ctx: LlmContext) => {
      calls.push(ctx);
      return scripted[Math.min(i++, scripted.length - 1)];
    }),
  };
}

function criticReturning(verdict: CriticVerdict): CriticGateway & { critique: ReturnType<typeof vi.fn> } {
  return { critique: vi.fn(async () => verdict) };
}

describe('CritiquedLlmGateway', () => {
  it('passes through unchanged when the critic says ok', async () => {
    const inner = innerReturning(decision());
    const critic = criticReturning({ ok: true, severity: 'minor', issues: [] });
    const gw = new CritiquedLlmGateway(inner, critic);

    const result = await gw.decide(baseContext);
    expect(result.prompt).toBe('The boar lunges.');
    expect(critic.critique).toHaveBeenCalledTimes(1);
  });

  it('skips the critic entirely on resolution beats', async () => {
    const inner = innerReturning(decision({ required: false }));
    const critic = criticReturning({ ok: false, severity: 'major', issues: ['x'] });
    const gw = new CritiquedLlmGateway(inner, critic);

    await gw.decide({ ...baseContext, rollOutcome: 'failure' });
    expect(critic.critique).not.toHaveBeenCalled();
  });

  it('skips the critic on a clean, non-required beat with no warnings', async () => {
    const inner = innerReturning(decision({ required: false, _warnings: [] }));
    const critic = criticReturning({ ok: true, severity: 'minor', issues: [] });
    const gw = new CritiquedLlmGateway(inner, critic);

    await gw.decide(baseContext);
    expect(critic.critique).not.toHaveBeenCalled();
  });

  it('critiques a non-required beat once the validator raised a warning', async () => {
    const inner = innerReturning(decision({ required: false, _warnings: ['base_dc out of range'] }));
    const critic = criticReturning({ ok: true, severity: 'minor', issues: [] });
    const gw = new CritiquedLlmGateway(inner, critic);

    await gw.decide(baseContext);
    expect(critic.critique).toHaveBeenCalledTimes(1);
  });

  it('applies a minor prose patch without touching options', async () => {
    const inner = innerReturning(decision());
    const critic = criticReturning({
      ok: false, severity: 'minor', issues: ['scene contradicts the location'],
      patch: { prompt: 'The boar charges through the pines.' },
    });
    const gw = new CritiquedLlmGateway(inner, critic);

    const result = await gw.decide(baseContext);
    expect(result.prompt).toBe('The boar charges through the pines.');
    expect(result.decision).toEqual([{ label: 'Strike', dcModifier: 0 }]); // options untouched
  });

  it('re-decides once on a major defect, passing the issues as a criticNote', async () => {
    const inner = innerReturning(
      decision({ prompt: 'first attempt' }),
      decision({ prompt: 'corrected attempt' }),
    );
    const critic = criticReturning({ ok: false, severity: 'major', issues: ['combat silently converted'] });
    const gw = new CritiquedLlmGateway(inner, critic);

    const result = await gw.decide(baseContext);
    expect(result.prompt).toBe('corrected attempt');
    expect(inner.calls).toHaveLength(2);
    expect(inner.calls[1].criticNote).toContain('combat silently converted');
    expect(critic.critique).toHaveBeenCalledTimes(1); // the re-decide is NOT re-critiqued
  });

  it('does not critique a re-decide pass (criticNote already set)', async () => {
    const inner = innerReturning(decision());
    const critic = criticReturning({ ok: false, severity: 'major', issues: ['x'] });
    const gw = new CritiquedLlmGateway(inner, critic);

    await gw.decide({ ...baseContext, criticNote: 'fix it' });
    expect(critic.critique).not.toHaveBeenCalled();
  });

  it('keeps the original on a minor defect with no usable patch', async () => {
    const inner = innerReturning(decision());
    const critic = criticReturning({ ok: false, severity: 'minor', issues: ['vague'] });
    const gw = new CritiquedLlmGateway(inner, critic);

    const result = await gw.decide(baseContext);
    expect(result.prompt).toBe('The boar lunges.');
  });
});
