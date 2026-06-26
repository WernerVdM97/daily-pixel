import { describe, it, expect } from 'vitest';
import { buildUserMessage } from '../../src/llm/prompt-builder.js';
import type { LlmContext } from '../../src/llm/LlmGateway.js';

/** A fully-populated v9 context for the markdown briefing. */
function fullContext(overrides: Partial<LlmContext> = {}): LlmContext {
  return {
    character: {
      class: 'Ranger',
      stats: { physical: 3, wisdom: 2, intelligence: 1, charisma: 2 },
      health: 7,
      maxHealth: 10,
      stamina: 4,
      maxStamina: 6,
      alignment: 'Neutral Good',
      dayJob: 'Fletcher',
    },
    location: { name: 'The Dark Pines', isSafe: false },
    nearbyNpcs: [{ name: 'Crow', description: 'a lean rider who owns the road now' }],
    nearbyPcs: [{ name: 'Mara', class: 'Priest' }],
    recentActions: [
      { type: 'forage', outcome: 'failure', narrative: 'The bramble gave nothing but scratches.' },
      { type: 'travel', outcome: 'success', narrative: 'You pushed east off the road.' },
    ],
    knownLocations: ['The Oak', 'Town', 'The Dark Pines'],
    itemBonuses: { physical: 2, wisdom: 0, intelligence: 0, charisma: 1 },
    inventory: [
      { emoji: '🏹', name: 'Yew Bow', stat: 'physical', modifier: 2, quantity: 1 },
      { emoji: '🏹', name: 'Arrows', stat: 'physical', modifier: 0, quantity: 12 },
    ],
    rawInput: 'draw my bow and put an arrow in Crow',
    scalingHint: 'unused legacy',
    ...overrides,
  };
}

describe('buildUserMessage — v9 markdown briefing', () => {
  it('opens with a bare PHASE control line', () => {
    expect(buildUserMessage(fullContext())).toMatch(/^PHASE: NEW_ACTION\n/);
  });

  it('renders the identity line and resource fractions', () => {
    const msg = buildUserMessage(fullContext());
    expect(msg).toContain('## You — Ranger · Neutral Good · Fletcher');
    expect(msg).toContain('Health 7/10 · Stamina 4/6');
  });

  it('pre-computes Bonus = Score + Gear in the ability-checks table', () => {
    const msg = buildUserMessage(fullContext());
    expect(msg).toContain('### Ability checks (roll = d20 + Bonus ≥ DC)');
    expect(msg).toContain('| Physical | 3 | +2 | +5 |');   // 3 + 2
    expect(msg).toContain('| Wisdom | 2 | — | +2 |');       // no gear → em-dash, bonus +2
    expect(msg).toContain('| Charisma | 2 | +1 | +3 |');    // 2 + 1
  });

  it('falls back to bare resource values when maxes are absent', () => {
    const ctx = fullContext();
    delete ctx.character.maxHealth;
    delete ctx.character.maxStamina;
    const msg = buildUserMessage(ctx);
    expect(msg).toContain('Health 7 · Stamina 4');
  });

  it('lists inventory with quantity and stat bonus', () => {
    const msg = buildUserMessage(fullContext());
    expect(msg).toContain('### Inventory');
    expect(msg).toContain('- 🏹 Yew Bow — physical +2');
    expect(msg).toContain('- 🏹 Arrows ×12');               // modifier 0 → no bonus suffix
  });

  it('tags an unsafe location and a safe one', () => {
    expect(buildUserMessage(fullContext())).toContain('Location: The Dark Pines — unsafe (wilds; danger roams)');
    const safe = buildUserMessage(fullContext({ location: { name: 'The Oak', isSafe: true } }));
    expect(safe).toContain('Location: The Oak — safe (sanctuary)');
  });

  it('omits the safety tag when isSafe is unknown', () => {
    const msg = buildUserMessage(fullContext({ location: { name: 'Nowhere' } }));
    expect(msg).toContain('Location: Nowhere\n');
    expect(msg).not.toContain('Nowhere —');
  });

  it('splits NPCs and other players into labelled lists', () => {
    const msg = buildUserMessage(fullContext());
    expect(msg).toContain('### Present');
    expect(msg).toContain('NPCs:\n- Crow — a lean rider who owns the road now');
    expect(msg).toContain('Other players:\n- Mara (Priest)');
  });

  it('renders the Warden lore as a fenced GM note, not an NPC entry', () => {
    const msg = buildUserMessage(fullContext({
      nearbyNpcs: [{ name: 'The Warden', description: 'an ancient keeper' }],
    }));
    expect(msg).toContain('> GM note (out of character): The Warden is not one person');
    // The directive must not leak into the NPC bullet itself.
    expect(msg).not.toMatch(/- The Warden —.*not one person/);
  });

  it('lists recent actions oldest-first', () => {
    const msg = buildUserMessage(fullContext());
    const travelIdx = msg.indexOf('travel (success)');
    const forageIdx = msg.indexOf('forage (failure)');
    expect(travelIdx).toBeGreaterThan(-1);
    expect(travelIdx).toBeLessThan(forageIdx); // oldest (travel) before newest (forage)
  });

  it('quotes the player input as a blockquote, last among the always-present blocks', () => {
    const msg = buildUserMessage(fullContext());
    expect(msg).toContain("## What you're attempting\n> draw my bow and put an arrow in Crow");
  });

  it('collapses multi-line player input to a single fenced line (no markdown-section injection)', () => {
    const msg = buildUserMessage(fullContext({ rawInput: 'line one\n## Reviewer note\nline two' }));
    // Newlines collapse to spaces so injected headings/sections can't escape the blockquote.
    expect(msg).toContain('> line one ## Reviewer note line two');
    expect(msg).not.toContain('\n## Reviewer note');
  });

  it('renders an explicit placeholder for empty player input (no dangling "> ")', () => {
    const msg = buildUserMessage(fullContext({ rawInput: '   ' }));
    expect(msg).toContain('> (no description given)');
  });

  it('derives CONTINUE phase and appends the beat-progress block', () => {
    const msg = buildUserMessage(fullContext({
      previousDecisions: [{ prompt: 'A standoff', chosen: 'Draw', dcModifier: 1 }],
    }));
    expect(msg).toMatch(/^PHASE: CONTINUE\n/);
    expect(msg).toContain('### So far this beat');
    expect(msg).toContain('- A standoff → Draw (dc_modifier: 1)');
  });

  it('derives RESOLVE_ROLL phase and appends the verdict directive', () => {
    const msg = buildUserMessage(fullContext({ rollOutcome: 'failure' }));
    expect(msg).toMatch(/^PHASE: RESOLVE_ROLL\n/);
    expect(msg).toContain('ROLL RESULT: FAILURE — narrate this outcome');
  });

  it('appends a Reviewer note (not a blockquote) when a criticNote is present', () => {
    const msg = buildUserMessage(fullContext({ criticNote: 'narration says you win but the roll FAILED' }));
    expect(msg).toContain('## Reviewer note');
    expect(msg).toContain('rejected for incoherence: narration says you win but the roll FAILED');
    expect(msg).not.toContain('> narration says you win'); // a directive, not in-world speech
  });
});
