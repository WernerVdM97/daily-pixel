// Prompt version — incremented when the system prompt changes.
// Stored on each action row so outcomes are traceable to the prompt that generated them.
export const PROMPT_VERSION = 'v3';

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LlmContext } from './LlmGateway.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const _systemPrompt = readFileSync(
  path.join(__dirname, '..', '..', 'assets', 'prompts', 'decision-v3.md'),
  'utf-8',
).trim();

/** The v3 system prompt, loaded from assets/prompts/decision-v3.md. */
export function buildSystemPrompt(): string {
  return _systemPrompt;
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
