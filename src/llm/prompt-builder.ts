// Single source of truth for the prompt version. Selects the prompt file
// (decision-<PROMPT_VERSION>.md) and is stamped on every actions/llm_calls row so
// outcomes trace back to the prompt that produced them.
// To cut a new version: copy decision-<old>.md → decision-<new>.md, edit, bump this
// string, keep old files, and mirror the new file into current_source.md.
export const PROMPT_VERSION = 'v9';

// Critic prompt version, independent of PROMPT_VERSION. Stamped on critic llm_calls
// rows as `critic-<CRITIC_VERSION>` so a verdict traces to the prompt that produced it.
// Bump it (and add critic-<N>.md) when the critic prompt changes.
export const CRITIC_VERSION = 'v1';

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LlmContext, CriticInput } from './LlmGateway.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** System prompt, loaded once at boot from the file matching PROMPT_VERSION. */
const _systemPrompt = readFileSync(
  path.join(__dirname, '..', '..', 'assets', 'prompts', 'decision-prompts', `decision-${PROMPT_VERSION}.md`),
  'utf-8',
).trim();

/** Critic system prompt, loaded once at boot from the file matching CRITIC_VERSION. */
const _criticSystemPrompt = readFileSync(
  path.join(__dirname, '..', '..', 'assets', 'prompts', 'critic', `critic-${CRITIC_VERSION}.md`),
  'utf-8',
).trim();

export function buildSystemPrompt(): string {
  return _systemPrompt;
}

export function buildCriticSystemPrompt(): string {
  return _criticSystemPrompt;
}

/** User message for the coherence critic: the authored beat + engine truths to anchor
 *  against. Markdown, like the decision briefing. */
export function buildCriticUserMessage(input: CriticInput): string {
  const out: string[] = [];
  out.push(`BEAT: ${input.beat}`);
  if (input.rollOutcome) {
    out.push(`ROLL VERDICT: ${input.rollOutcome.toUpperCase()}`);
  }

  out.push('');
  out.push('## Authored output (JSON)');
  out.push('```json');
  // Strip transient/audit-only `_`-prefixed fields (_rawPrompt, _reasoning, …): they'd
  // re-embed the whole prompt and the author's chain-of-thought — wasted tokens, and the
  // critic must judge prose-vs-truth independently, not rubber-stamp the author's reasoning.
  // The validator warnings it needs are surfaced under "## Validator warnings" below.
  const authored = Object.fromEntries(
    Object.entries(input.decision).filter(([k]) => !k.startsWith('_')),
  );
  out.push(JSON.stringify(authored, null, 2));
  out.push('```');

  if (input.finalMutations !== undefined) {
    out.push('');
    out.push('## Final mutations (engine-applied — outcome_text must match these)');
    out.push('```json');
    out.push(JSON.stringify(input.finalMutations, null, 2));
    out.push('```');
  }

  out.push('');
  out.push('## Validator warnings');
  out.push(input.warnings.length > 0 ? input.warnings.map(w => `- ${w}`).join('\n') : '- none');

  out.push('');
  out.push('## Context the author saw');
  out.push(input.contextDigest);

  return out.join('\n');
}

/** Fixed display order — keeps the prompt prefix cache-stable. */
const STATS = ['physical', 'wisdom', 'intelligence', 'charisma'] as const;

/** Quote untrusted player text as a per-line blockquote so multi-line input stays fenced
 *  and can't break out. The SECURITY RULE does the real defending. */
function asBlockquote(s: string): string {
  return s.split('\n').map(line => `> ${line}`).join('\n');
}

/** Signed table cell: `+5`, `-2`, or `—` for zero. */
function signed(n: number): string {
  return n === 0 ? '—' : `${n > 0 ? '+' : ''}${n}`;
}

/**
 * v9 markdown briefing. Renders context as a scene to read, not a struct to parse — uses
 * markdown's structural features (headings, tables, labels), skips decorative bold/italic.
 * Section order: control → you → scene → present → story → reference → the ask.
 */
export function buildUserMessage(ctx: LlmContext): string {
  // Explicit loop phase so the model never infers game state from prose.
  //   NEW_ACTION   — first beat; open a decision or resolve outright.
  //   CONTINUE     — a prior choice exists but no verdict yet; produce the NEXT beat.
  //   RESOLVE_ROLL — dice have decided; narrate the attached ROLL RESULT only.
  const phase = ctx.rollOutcome
    ? 'RESOLVE_ROLL'
    : (ctx.previousDecisions && ctx.previousDecisions.length > 0 ? 'CONTINUE' : 'NEW_ACTION');

  const out: string[] = [];
  out.push(`PHASE: ${phase}`);

  // ── You — identity, resources, the ability-checks table (Score + Gear = Bonus) ──
  const c = ctx.character;
  out.push('');
  out.push(`## You — ${c.class} · ${c.alignment} · ${c.dayJob}`);
  const hp = c.maxHealth !== undefined ? `${c.health}/${c.maxHealth}` : `${c.health}`;
  const sta = c.maxStamina !== undefined ? `${c.stamina}/${c.maxStamina}` : `${c.stamina}`;
  out.push(`Health ${hp} · Stamina ${sta}`);
  out.push('');
  out.push('### Ability checks (roll = d20 + Bonus ≥ DC)');
  out.push('| Stat | Score | Gear | Bonus |');
  out.push('|------|-------|------|-------|');
  for (const stat of STATS) {
    const score = c.stats[stat];
    const gear = ctx.itemBonuses?.[stat] ?? 0;
    const bonus = score + gear; // what's added to the d20 — always shown signed, incl. +0
    const label = stat.charAt(0).toUpperCase() + stat.slice(1);
    out.push(`| ${label} | ${score} | ${signed(gear)} | ${bonus >= 0 ? '+' : ''}${bonus} |`);
  }

  // ── Inventory — names/emoji/qty for narration, remove_item, and consumption ──
  if (ctx.inventory && ctx.inventory.length > 0) {
    out.push('');
    out.push('### Inventory');
    for (const it of ctx.inventory) {
      const qty = it.quantity > 1 ? ` ×${it.quantity}` : '';
      const bonus = it.modifier !== 0 ? ` — ${it.stat} ${signed(it.modifier)}` : '';
      out.push(`- ${it.emoji} ${it.name}${qty}${bonus}`);
    }
  }

  // ── Scene — location + safety tag (the danger-pacing lever) ──
  out.push('');
  out.push('## Scene');
  const safety = ctx.location.isSafe === undefined
    ? ''
    : (ctx.location.isSafe ? ' — safe (sanctuary)' : ' — unsafe (wilds; danger roams)');
  out.push(`Location: ${ctx.location.name}${safety}`);

  // ── Present — NPCs and other players, separate labelled lists ──
  if (ctx.nearbyNpcs.length > 0 || ctx.nearbyPcs.length > 0) {
    out.push('');
    out.push('### Present');
    if (ctx.nearbyNpcs.length > 0) {
      out.push('NPCs:');
      for (const n of ctx.nearbyNpcs) out.push(`- ${n.name} — ${n.description}`);
    }
    if (ctx.nearbyPcs.length > 0) {
      out.push('Other players:');
      for (const p of ctx.nearbyPcs) out.push(`- ${p.name} (${p.class})`);
    }
  }

  // Warden lore — out-of-character GM note, kept OUT of the NPC list so the model never
  // renders it as scene data. Only when the Warden is present.
  if (ctx.nearbyNpcs.some(n => n.name === 'The Warden')) {
    out.push('');
    out.push('> GM note (out of character): The Warden is not one person — the title has passed across centuries, and the current Warden is the last. When they die, the Oak dies. Reveal only through fragments, one subtle hint every few in-game weeks. Imply, never explain.');
  }

  // ── Story so far — recent beats, oldest first so the model reads forward ──
  if (ctx.recentActions.length > 0) {
    out.push('');
    out.push('### Story so far (oldest first)');
    for (const a of [...ctx.recentActions].reverse()) {
      const thread = a.narrative ? `: ${a.narrative}` : '';
      out.push(`- ${a.type} (${a.outcome})${thread}`);
    }
  }

  // ── Known locations — reference for set_location reuse (inline, not a list) ──
  if (ctx.knownLocations && ctx.knownLocations.length > 0) {
    out.push('');
    out.push('### Known locations');
    out.push(ctx.knownLocations.join(' · '));
  }

  // ── The ask — the player's intent, fenced as in-world speech, placed last ──
  out.push('');
  out.push("## What you're attempting");
  out.push(asBlockquote(ctx.rawInput));

  // ── CONTINUE / RESOLVE_ROLL additions ──
  if (ctx.previousDecisions && ctx.previousDecisions.length > 0) {
    out.push('');
    out.push('### So far this beat');
    for (const d of ctx.previousDecisions) {
      out.push(`- ${d.prompt} → ${d.chosen} (dc_modifier: ${d.dcModifier})`);
    }
  }

  // Narration pass: the dice have already decided. Narrate THIS verdict.
  if (ctx.rollOutcome) {
    out.push('');
    out.push(`ROLL RESULT: ${ctx.rollOutcome.toUpperCase()} — narrate this outcome and emit matching mutations. No decision options.`);
  }

  // Re-decide pass: the critic rejected the previous attempt. Engine directive (not in-world
  // speech) — fix the named problem and produce a corrected beat.
  if (ctx.criticNote) {
    out.push('');
    out.push('## Reviewer note');
    out.push(`Your previous attempt was rejected for incoherence: ${ctx.criticNote}. Produce a corrected beat that fixes this, consistent with the context above.`);
  }

  return out.join('\n');
}

/**
 * Compact, query-friendly context snapshot for the audit log. Strips reconstructable
 * boilerplate (NPC descriptions, full inventory/location lists) and dedupes NPC names,
 * keeping only the volatile signal. Real prompt token cost comes from the API's usage.
 */
export function buildContextDigest(ctx: LlmContext): string {
  return JSON.stringify({
    location: ctx.location.name,
    npcs: [...new Set(ctx.nearbyNpcs.map(n => n.name))],
    npc_rows: ctx.nearbyNpcs.length,        // pre-dedup count — flags prompt bloat
    pcs: ctx.nearbyPcs.length,
    recent: ctx.recentActions.map(a => `${a.type}:${a.outcome}`),
    has_scaling: Boolean(ctx.scalingHint),
    known_locations: ctx.knownLocations?.length ?? 0,  // count only — names are reconstructable
    prev_decisions: ctx.previousDecisions?.length ?? 0,
  });
}
