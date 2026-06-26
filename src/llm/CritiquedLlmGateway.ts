import type { LlmGateway, LlmContext, LlmDecision, CriticGateway, CriticInput } from './LlmGateway.js';
import { buildContextDigest } from './prompt-builder.js';
import { c } from '../util/colors.js';

/**
 * Decorator gateway (Thread 2) that runs the coherence critic over **decision** beats before they
 * reach the player. Wraps an inner LlmGateway + a CriticGateway, mirroring FallbackLlmGateway's
 * wrap-a-gateway shape, so `machine.ts` is untouched for decision beats.
 *
 * Resolution beats (rollOutcome set) pass straight through — they are critiqued by the machine's
 * resolveWithRoll hook, after applyOutcomeToMutations, where the FINAL mutations exist (a
 * transparent decorator would only see pre-strip mutations).
 *
 * Correction ladder, one pass:
 *   gate → critique → ok? pass · minor+patch? rewrite prose · major? re-decide once · else keep original.
 * The critic only ever rewrites prose; the machine re-normalises whatever is returned
 * (toActionDecision clamps/strips/ensures bail), so the critic can never break an invariant.
 */
export class CritiquedLlmGateway implements LlmGateway {
  constructor(
    private inner: LlmGateway,
    private critic: CriticGateway,
  ) {}

  async decide(context: LlmContext): Promise<LlmDecision> {
    const decision = await this.inner.decide(context);

    // Resolution beats are critiqued by the resolveWithRoll hook (it has the final mutations).
    if (context.rollOutcome) return decision;
    // A re-decide is already a correction — never critique it again (one pass per beat).
    if (context.criticNote) return decision;

    // Gate: only spend the critic on high-stakes beats (a forced/required threat) or beats the
    // deterministic validator already flagged. Clean, low-stakes beats skip it entirely.
    const hasWarnings = (decision._warnings?.length ?? 0) > 0;
    if (!decision.required && !hasWarnings) return decision;

    const input: CriticInput = {
      beat: 'decision',
      decision,
      contextDigest: buildContextDigest(context),
      playerInput: context.rawInput,
      warnings: decision._warnings ?? [],
    };
    const verdict = await this.critic.critique(input);
    // Stamp the critic's audit-row id so the engine can link this beat's critic call to the
    // action (the verdict applies to whichever decision we return below).
    const cid = verdict._llmCallId;

    if (verdict.ok) return this.tag(decision, cid);

    // Minor: rewrite only the offending prose. Mutations / options / DC are left untouched.
    if (verdict.severity === 'minor' && verdict.patch && (verdict.patch.prompt || verdict.patch.outcomeText)) {
      return this.tag({
        ...decision,
        ...(verdict.patch.prompt !== undefined ? { prompt: verdict.patch.prompt } : {}),
        ...(verdict.patch.outcomeText !== undefined ? { outcomeText: verdict.patch.outcomeText } : {}),
      }, cid);
    }

    // Major: one bounded re-decide with the critic's issues as guidance. Not re-critiqued.
    if (verdict.severity === 'major') {
      const note = verdict.issues.join('; ') || 'incoherent with the scene';
      try {
        return this.tag(await this.inner.decide({ ...context, criticNote: note }), cid);
      } catch (err) {
        console.warn(c.yellow('[critic] re-decide failed — keeping original'), err instanceof Error ? err.message : String(err));
        return this.tag(decision, cid);
      }
    }

    // Minor but no usable patch → keep the deterministic-safe original.
    return this.tag(decision, cid);
  }

  /** Attach the decision-beat critic's audit-row id so it gets linked to the action. */
  private tag(decision: LlmDecision, critiqueCallId: number | undefined): LlmDecision {
    return critiqueCallId !== undefined ? { ...decision, _critiqueCallId: critiqueCallId } : decision;
  }
}
