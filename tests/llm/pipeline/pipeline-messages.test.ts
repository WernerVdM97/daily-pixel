import { describe, it, expect } from 'vitest';
import { buildResolveUserMessage } from '../../../src/llm/pipeline/pipeline-messages.js';
import type { PipelineDecideResult, PipelineResolveMutateInput } from '../../../src/llm/pipeline/types.js';
import type { LlmContext } from '../../../src/llm/LlmGateway.js';

const minimalContext: LlmContext = {
  character: {
    class: 'Warrior',
    stats: { physical: 3, wisdom: -1, intelligence: 0, charisma: 0 },
    health: 12,
    stamina: 10,
    alignment: 'lawful good',
    dayJob: 'Blacksmith',
  },
  location: { name: 'The Warden\'s Oak' },
  nearbyNpcs: [],
  nearbyPcs: [],
  recentActions: [],
  rawInput: 'attack the goblin',
};

const decision: PipelineDecideResult = {
  distilledType: 'combat',
  stat: 'physical',
  baseDc: 6,
  required: true,
  decision: [{ label: 'Press the attack', dcModifier: 0 }],
};

function baseInput(overrides?: Partial<PipelineResolveMutateInput>): PipelineResolveMutateInput {
  return {
    actionType: 'combat',
    decision,
    chosenOption: { label: 'Press the attack', dcModifier: 0 },
    verdict: 'success',
    d20Roll: 20,
    context: minimalContext,
    ...overrides,
  };
}

describe('buildResolveUserMessage — Stage 2 fatalBlow / decisionPrompt (RA-1/RA-2)', () => {
  it('omits the "- fatal blow:" line entirely when fatalBlow is absent', () => {
    const msg = buildResolveUserMessage(baseInput(), 'RESOLVE-MUTATE');
    expect(msg).not.toContain('- fatal blow:');
  });

  it('emits a bare "- fatal blow: spare" line when fatalBlow is present', () => {
    const msg = buildResolveUserMessage(baseInput({ fatalBlow: 'spare' }), 'RESOLVE-MUTATE');
    expect(msg).toContain('- fatal blow: spare');
  });

  it('emits "- fatal blow: finish" for the finish ending', () => {
    const msg = buildResolveUserMessage(baseInput({ fatalBlow: 'finish' }), 'RESOLVE-MUTATE');
    expect(msg).toContain('- fatal blow: finish');
  });

  it('falls back to the generic reconstruction for "- prompt:" when decisionPrompt is not supplied', () => {
    const msg = buildResolveUserMessage(baseInput(), 'RESOLVE-MUTATE');
    expect(msg).toContain('- prompt: Combat — what do you do?');
  });

  it('uses decisionPrompt verbatim for "- prompt:" when supplied, instead of the reconstruction', () => {
    const interstitialPrompt = 'Goblin is broken and cannot rise. Finish it, or let it live?';
    const msg = buildResolveUserMessage(
      baseInput({ fatalBlow: 'spare', decisionPrompt: interstitialPrompt }),
      'RESOLVE-MUTATE',
    );
    expect(msg).toContain(`- prompt: ${interstitialPrompt}`);
    expect(msg).not.toContain('Combat — what do you do?');
  });
});
