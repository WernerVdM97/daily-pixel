// ── FallbackLlmGateway ── decorator implementing LlmGateway
//
// Two-tier fallback chain per S4 spec:
//   Tier 1: Retry with stripped context (character basics + rawInput only)
//   Tier 2: Divine intervention — canned outcome, increment counter

import type { LlmGateway, LlmContext, LlmDecision } from './LlmGateway.js';
import { c } from '../util/colors.js';

/** Sentinel distilledType value for divine intervention outcomes. */
export const DIVINE_INTERVENTION_TYPE = '__divine__';

/** The divine intervention message shown to the player. */
export const DIVINE_MESSAGE =
  "A flash of light. The warden's hand on your shoulder. " +
  'You wake beneath the Oak, your action lost to forces beyond mortal ken.';

export interface FallbackGatewayOptions {
  /**
   * Called when tier-2 fallback (divine intervention) fires.
   * Used by WorldEngineImpl to increment meta.llm_fallback_count.
   */
  onTier2Fallback?: () => void;
}

/**
 * FallbackLlmGateway — decorator wrapping any LlmGateway.
 *
 * On success: pass through.
 * On throw (tier 1): retry with stripped context (character basics + rawInput only).
 * On second throw (tier 2): return divine intervention decision and call
 *   onTier2Fallback callback.
 */
export class FallbackLlmGateway implements LlmGateway {
  private inner: LlmGateway;
  private options: FallbackGatewayOptions;

  constructor(inner: LlmGateway, options: FallbackGatewayOptions = {}) {
    this.inner = inner;
    this.options = options;
  }

  async decide(context: LlmContext): Promise<LlmDecision> {
    try {
      return await this.inner.decide(context);
    } catch (firstErr) {
      console.error(c.red('[llm:fallback:tier1]'), firstErr instanceof Error ? firstErr.message : String(firstErr));

      // Tier 1: retry with stripped context
      try {
        const stripped = this.stripContext(context);
        return await this.inner.decide(stripped);
      } catch (secondErr) {
        console.error(c.red('[llm:fallback:tier2]'), secondErr instanceof Error ? secondErr.message : String(secondErr));

        // Tier 2: divine intervention
        this.options.onTier2Fallback?.();
        return this.buildDivineIntervention();
      }
    }
  }

  /**
   * Build a stripped context for tier-1 retry.
   * Keeps only character basics (class, stats, health, stamina) + rawInput.
   */
  private stripContext(ctx: LlmContext): LlmContext {
    return {
      character: {
        class: ctx.character.class,
        stats: { ...ctx.character.stats },
        health: ctx.character.health,
        stamina: ctx.character.stamina,
        alignment: '',
        dayJob: '',
      },
      location: { name: 'unknown' },
      nearbyNpcs: [],
      nearbyPcs: [],
      recentActions: [],
      rawInput: ctx.rawInput,
      scalingHint: '',
    };
  }

  /**
   * Build the divine intervention decision.
   * done: true so the action state machine resolves; no action row is inserted
   * (WorldEngineImpl checks DIVINE_INTERVENTION_TYPE to skip action row).
   */
  private buildDivineIntervention(): LlmDecision {
    return {
      distilledType: DIVINE_INTERVENTION_TYPE,
      stat: 'physical',
      baseDc: 10,
      required: false,
      done: true,
      decision: [],
      mutations: [],
      outcomeText: DIVINE_MESSAGE,
    };
  }
}
