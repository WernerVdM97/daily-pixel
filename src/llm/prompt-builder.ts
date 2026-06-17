// Prompt version — the single source of truth. Bump this ONE constant when the
// system prompt changes; the prompt file is derived from it
// (assets/prompts/decision-prompts/decision-<PROMPT_VERSION>.md). It's stamped on every
// actions/llm_calls row so outcomes trace back to the prompt that produced them.
//
// To cut a new version: copy assets/prompts/decision-prompts/decision-<old>.md → decision-<new>.md,
// edit the body, then change the string below. Keep old files for history.
// After cutting, also copy the new file's content into current_source.md.
export const PROMPT_VERSION = 'v7';

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LlmContext } from './LlmGateway.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Active system prompt, loaded once at boot from the file matching PROMPT_VERSION. */
const _systemPrompt = readFileSync(
  path.join(__dirname, '..', '..', 'assets', 'prompts', 'decision-prompts', `decision-${PROMPT_VERSION}.md`),
  'utf-8',
).trim();

/** The active system prompt (assets/prompts/decision-prompts/decision-<PROMPT_VERSION>.md). */
export function buildSystemPrompt(): string {
  return _systemPrompt;
}

export function buildUserMessage(ctx: LlmContext): string {
  const lines: string[] = [];

  // Explicit loop phase so the model never has to infer game state from prose.
  //   NEW_ACTION  — first beat; open a decision or resolve outright.
  //   CONTINUE    — a prior choice exists but no verdict yet; produce the NEXT beat.
  //   RESOLVE_ROLL — the dice have decided; narrate the attached ROLL RESULT only.
  const phase = ctx.rollOutcome
    ? 'RESOLVE_ROLL'
    : (ctx.previousDecisions && ctx.previousDecisions.length > 0 ? 'CONTINUE' : 'NEW_ACTION');
  lines.push(`PHASE: ${phase}`);

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
    // Oldest→newest so the LLM reads the story forward. Each beat carries its
    // narrative (the prior DM outcome text) when we have it, for continuity.
    lines.push(`RECENT ACTIONS (last ${ctx.recentActions.length}, oldest first):`);
    for (const a of [...ctx.recentActions].reverse()) {
      const thread = a.narrative ? `: ${a.narrative}` : '';
      lines.push(`- ${a.type} (${a.outcome})${thread}`);
    }
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

  // Narration pass: the dice have already decided. Narrate THIS verdict.
  if (ctx.rollOutcome) {
    lines.push(`ROLL RESULT: ${ctx.rollOutcome.toUpperCase()} — narrate this outcome and emit matching mutations. done: true, no decision options.`);
  }

  return lines.join('\n');
}

/**
 * Compact, query-friendly snapshot of the context for the audit log.
 *
 * Strips reconstructable boilerplate (NPC descriptions, full inventory/location
 * lists) and dedupes NPC names — keeping only the volatile signal. The exact
 * token cost of the real prompt is captured separately via the API's usage.
 */
export function buildContextDigest(ctx: LlmContext): string {
  return JSON.stringify({
    location: ctx.location.name,
    npcs: [...new Set(ctx.nearbyNpcs.map(n => n.name))],
    npc_rows: ctx.nearbyNpcs.length,        // pre-dedup count — flags prompt bloat
    pcs: ctx.nearbyPcs.length,
    recent: ctx.recentActions.map(a => `${a.type}:${a.outcome}`),
    has_scaling: Boolean(ctx.scalingHint),
    prev_decisions: ctx.previousDecisions?.length ?? 0,
  });
}
