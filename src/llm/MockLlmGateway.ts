import type { LlmGateway, LlmContext, LlmDecision } from './LlmGateway.js';

/**
 * MockLlmGateway — test fixture.
 * Returns a canned decision. Throws if decide() called without one set.
 */
export class MockLlmGateway implements LlmGateway {
  private _decision: LlmDecision | null = null;

  calls: { context: LlmContext }[] = [];

  setDecision(decision: LlmDecision): void {
    this._decision = decision;
  }

  async decide(context: LlmContext): Promise<LlmDecision> {
    this.calls.push({ context });
    if (!this._decision) {
      throw new Error('MockLlmGateway.decide: no canned decision set');
    }
    return this._decision;
  }

  static defaultDecision(overrides?: Partial<LlmDecision>): LlmDecision {
    return {
      prompt: 'You venture into the wilds, seeking prey.',
      distilledType: 'scout',
      stat: 'wisdom',
      baseDc: 12,
      required: false,
      done: false,
      mutations: [],
      outcomeText: 'The trail goes cold, but the wilds keep their secrets a while longer.',
      decision: [
        { label: 'Investigate the tracks', dcModifier: -2 },
        { label: 'Charge ahead', dcModifier: 2 },
        { label: 'Bail', dcModifier: null },
      ],
      ...overrides,
    };
  }
}
