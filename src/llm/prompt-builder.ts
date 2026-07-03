// Single source of truth for the prompt version. Selects the prompt file
// (decision-<PROMPT_VERSION>.md) and is stamped on every actions/llm_calls row so
// outcomes trace back to the prompt that produced them.
// To cut a new version: copy decision-<old>.md → decision-<new>.md, edit, bump this
// string, keep old files, and mirror the new file into current_source.md.
export const PROMPT_VERSION = 'v11';

// Critic prompt version, independent of PROMPT_VERSION. Stamped on critic llm_calls
// rows as `critic-<CRITIC_VERSION>` so a verdict traces to the prompt that produced it.
// Bump it (and add critic-<N>.md) when the critic prompt changes.
export const CRITIC_VERSION = 'v1';

// v12 prompt-*set* version (docs/decisions/v12-prompt-set-versioning.md). Scaffolding
// only: no orchestrator consumes loadPromptSet yet, so this never touches the live v11
// path above. Stage 1 (Thread D) wires the engine onto it and retires PROMPT_VERSION.
export const PROMPT_SET_VERSION = 'v12';

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTION_CATEGORIES, type LlmContext, type CriticInput, type ActionCategory } from './LlmGateway.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Read a prompt file under assets/prompts/ and trim it. Path segments join under the
 *  assets root; fails loud (ENOENT) if the file is missing — prompts are boot-critical. */
function readPrompt(...segments: string[]): string {
  return readFileSync(path.join(__dirname, '..', '..', 'assets', 'prompts', ...segments), 'utf-8').trim();
}

/** System prompt, loaded once at boot from the file matching PROMPT_VERSION. */
const _systemPrompt = readPrompt('decision-prompts', `decision-${PROMPT_VERSION}.md`);

/** Critic system prompt, loaded once at boot from the file matching CRITIC_VERSION. */
const _criticSystemPrompt = readPrompt('critic', `critic-${CRITIC_VERSION}.md`);

export function buildSystemPrompt(): string {
  return _systemPrompt;
}

export function buildCriticSystemPrompt(): string {
  return _criticSystemPrompt;
}

/** A full versioned prompt set (docs/decisions/v12-prompt-set-versioning.md §1): the
 *  classify/resolve bookends plus one decide template per ActionCategory, loaded together
 *  from a single directory so a pipeline outcome traces to the exact set that produced it. */
export interface PromptSet {
  version: string;
  classify: string;
  resolve: string;
  decide: Record<ActionCategory, string>;
}

/** Load a full prompt set from decision-prompts/<version>/. Throws loud (fail-fast at
 *  boot) naming the missing file if any expected template is absent — a partial set must
 *  never run. Reads eagerly (not memoized like the v11 singletons above) since no caller
 *  exists yet; Stage 1 can add caching once the orchestrator calls this per-boot. */
export function loadPromptSet(version: string = PROMPT_SET_VERSION): PromptSet {
  const dir = ['decision-prompts', version];
  const load = (name: string): string => {
    try {
      return readPrompt(...dir, `${name}.md`);
    } catch (err) {
      throw new Error(`loadPromptSet('${version}'): missing template '${name}.md' in assets/prompts/decision-prompts/${version}/ (${(err as Error).message})`);
    }
  };

  const classify = load('classify');
  const resolve = load('resolve');
  // The cast is safe because ActionCategory is TYPE-DERIVED from this same ACTION_CATEGORIES
  // array (LlmGateway.ts) — looping over it can't skip or invent a key, so `decide` really is
  // total by construction, not just by convention.
  const decide = {} as Record<ActionCategory, string>;
  for (const category of ACTION_CATEGORIES) decide[category] = load(category);

  return { version, classify, resolve, decide };
}

/** Derive the per-call telemetry stamp for a pipeline stage: `${version}/${template}`
 *  (e.g. 'v12/combat'). Stamps are always derived, never hand-maintained, so the set and
 *  its stage stay attributable without duplicated version bookkeeping. */
export function stampFor(template: 'classify' | 'resolve' | ActionCategory, version: string = PROMPT_SET_VERSION): string {
  return `${version}/${template}`;
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

/** Quote untrusted player text as a single-line blockquote. Newlines and whitespace runs are
 *  collapsed to single spaces so multi-line input can't inject fake markdown sections or
 *  impersonate engine/GM lines (the player's intent is one line anyway); the SECURITY RULE
 *  backstops the rest. Empty input renders an explicit placeholder, not a dangling `> `. */
function asBlockquote(s: string): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine ? `> ${oneLine}` : '> (no description given)';
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
  const region = ctx.location.region ? ` · ${ctx.location.region}` : '';
  out.push(`Location: ${ctx.location.name}${region}${safety}`);

  // ── Present — NPCs (with ephemeral handles) and other players ──
  // Handles [N1]…[Nk] are assigned by index to present NPCs in id-ascending order.
  // update_npc/remove_npc mutations reference these handles; the gateway resolves them
  // back to npcId at parse time (§2a). add_npc always uses a name, never a handle.
  if (ctx.nearbyNpcs.length > 0 || ctx.nearbyPcs.length > 0) {
    out.push('');
    out.push('### Present');
    if (ctx.nearbyNpcs.length > 0) {
      out.push('NPCs (use the handle to update or remove an existing NPC):');
      for (let i = 0; i < ctx.nearbyNpcs.length; i++) {
        const n = ctx.nearbyNpcs[i];
        out.push(`- [N${i + 1}] ${n.name} — ${n.description}`);
      }
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

  // ── Here & exits (v10) — the local, geographic travel menu. Charted exits are
  // legal move targets (set_location); frontier exits are the cross_frontier
  // invitations (direction + teaser, no node yet). Replaces the global location list. ──
  const geo = ctx.localGeography;
  if (geo && (geo.neighbours.length > 0 || geo.frontiers.length > 0)) {
    out.push('');
    out.push('### Exits from here');
    if (geo.neighbours.length > 0) {
      out.push('Charted (travel here by name):');
      for (const n of geo.neighbours) {
        out.push(`- ${n.direction} → ${n.name} (effort ${n.difficulty})`);
      }
    }
    if (geo.frontiers.length > 0) {
      out.push('Uncharted frontier (cross to explore — emit cross_frontier with the direction):');
      for (const f of geo.frontiers) {
        const teaser = f.teaser ? ` — ${f.teaser}` : '';
        out.push(`- ${f.direction}${teaser} (effort ${f.difficulty})`);
      }
    }
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
    exits: ctx.localGeography?.neighbours.length ?? 0,
    frontiers: ctx.localGeography?.frontiers.length ?? 0,
    prev_decisions: ctx.previousDecisions?.length ?? 0,
  });
}
