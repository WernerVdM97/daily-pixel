// User-message builders for the v12 pipeline's CLASSIFY and RESOLVE-* stages (T2). DECIDE
// deliberately reuses `buildUserMessage` from prompt-builder.ts verbatim — its output already
// matches the v12 decide `INPUT CONTEXT` layout (assets/prompts/decision-prompts/v12/decide/
// BASE.md), so there's nothing pipeline-specific to add there.
import type { LlmContext } from '../LlmGateway.js';
import { buildSceneBody } from '../prompt-builder.js';
import type { PipelineResolveMutateInput, PipelineResolveNarrateInput } from './types.js';

/** Mirrors prompt-builder.ts's private `asBlockquote` (collapses whitespace so untrusted raw
 *  input can't inject markdown headings/sections). Duplicated rather than exported from there —
 *  classify's blockquote need is this one line, not worth widening that module's surface for. */
function blockquote(s: string): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine ? `> ${oneLine}` : '> (no description given)';
}

/**
 * CLASSIFY's user message — the LLM fallback for a heuristic miss (`classifier.ts`).
 * `classify.md` is still a STUB (T3 authors the real prompt + richer briefing), so this is
 * deliberately minimal: the raw input plus the one extra signal (location) worth handing over
 * for a heuristic-table miss. Do not over-invest here — see T2 spec §3.
 */
export function buildClassifyUserMessage(rawInput: string, context: LlmContext): string {
  const out: string[] = [blockquote(rawInput)];
  if (context.location?.name) {
    out.push(`Location: ${context.location.name}`);
  }
  return out.join('\n');
}

/** Reconstructs the decision-framing line the player would have seen, mirroring
 *  `PipelineActionStateMachine`'s private `toActionDecision`/`capitalize` helpers. Needed because
 *  `PipelineDecideResult` deliberately carries no `prompt` field (D5b: DECIDE never authors prose,
 *  only options) — see T2 spec §3's "decision-prompt" ambiguity, resolved by rebuilding the same
 *  generic framing the machine itself shows the player for this decision. */
function reconstructDecisionPrompt(distilledType: string): string {
  const capitalized = distilledType ? distilledType.charAt(0).toUpperCase() + distilledType.slice(1) : distilledType;
  return `${capitalized} — choose your approach:`;
}

/**
 * RESOLVE-MUTATE / RESOLVE-NARRATE user message. Shares the scene body with `buildUserMessage`
 * (`prompt-builder.ts::buildSceneBody`) so the two prose layouts can never drift apart, and adds
 * the resolve-specific handoff header `resolve/BASE.md`'s `INPUT CONTEXT` expects: TASK/VERDICT/
 * D20, the routed action type, and a reconstruction of what was decided. On RESOLVE-NARRATE only,
 * appends `### Final mutations` — the mutations that actually landed post-finalize.
 */
export function buildResolveUserMessage(
  input: PipelineResolveMutateInput | PipelineResolveNarrateInput,
  task: 'RESOLVE-MUTATE' | 'RESOLVE-NARRATE',
): string {
  const { actionType, decision, chosenOption, verdict, d20Roll, context } = input;

  const out: string[] = [];
  out.push(`TASK: ${task}`);
  out.push(`VERDICT: ${verdict.toUpperCase()}`);
  out.push(`D20: ${d20Roll}`);

  out.push('');
  out.push('### Action type');
  out.push(actionType);

  out.push('');
  out.push('### What was decided');
  out.push(`- prompt: ${reconstructDecisionPrompt(decision.distilledType)}`);
  out.push(`- chosen: ${chosenOption.label}`);
  out.push(`- stat: ${chosenOption.stat ?? decision.stat}`);

  out.push(...buildSceneBody(context));

  if (task === 'RESOLVE-NARRATE') {
    const { finalMutations } = input as PipelineResolveNarrateInput;
    out.push('');
    out.push('### Final mutations');
    out.push('```json');
    out.push(JSON.stringify(finalMutations, null, 2));
    out.push('```');
  }

  return out.join('\n');
}
