// Source: assets/prompts/decision.md — loaded at runtime or inlined here
import type { LlmContext } from './LlmGateway.js';

export function buildSystemPrompt(): string {
  return `SYSTEM:
You are the game master for a text-based Discord RPG called The Warden's Oak.
Generate the next decision for the player's action. Return JSON only.

Rules:
- distilled_type: single lowercase word for the action (hunt, travel, talk, etc.)
- stat: which stat this action uses (physical, wisdom, intelligence, charisma)
- base_dc: 8-18. Higher = harder.
- required: true only if the action is reactive (attacked, cornered, etc.)
- done: false for decisions, true when the action should resolve
- decision: array of 2-4 objects with { "label": "action description", "dc_modifier": number }. dc_modifier is literal and signed: negative = easier, positive = harder. Range -5 to +5. null = bail (ends action as skipped). Use "label", not "text" or "name".
- When done: true, include a mutations block and a one-sentence outcome_text.`;
}

export function buildUserMessage(ctx: LlmContext): string {
  const lines: string[] = [];

  lines.push(`CHARACTER: class=${ctx.character.class}, stats=${JSON.stringify(ctx.character.stats)}, health=${ctx.character.health}, stamina=${ctx.character.stamina}, alignment=${ctx.character.alignment}, dayJob=${ctx.character.dayJob}`);
  lines.push(`LOCATION: ${ctx.location.name}`);

  if (ctx.nearbyNpcs.length > 0) {
    lines.push(`NEARBY NPCS: ${ctx.nearbyNpcs.map(n => `${n.name} (${n.description})`).join(', ')}`);
  } else {
    lines.push('NEARBY NPCS: none');
  }

  if (ctx.nearbyPcs.length > 0) {
    lines.push(`NEARBY PCS: ${ctx.nearbyPcs.map(p => `${p.name} (${p.class})`).join(', ')}`);
  } else {
    lines.push('NEARBY PCS: none');
  }

  if (ctx.recentActions.length > 0) {
    lines.push(`RECENT ACTIONS (last ${ctx.recentActions.length}): ${ctx.recentActions.map(a => `${a.type} (${a.outcome})`).join(', ')}`);
  } else {
    lines.push('RECENT ACTIONS: none');
  }

  lines.push(`PLAYER INPUT: ${ctx.rawInput}`);

  if (ctx.scalingHint) {
    lines.push(`DAILY SCALING: ${ctx.scalingHint}`);
  }

  if (ctx.previousDecisions && ctx.previousDecisions.length > 0) {
    lines.push('PREVIOUS DECISIONS:');
    for (const d of ctx.previousDecisions) {
      lines.push(`- ${d.prompt} → ${d.chosen} (dc_modifier: ${d.dcModifier})`);
    }
  }

  return lines.join('\n');
}
