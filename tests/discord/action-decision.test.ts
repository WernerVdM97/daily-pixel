import { describe, it, expect } from 'vitest';
import { buildDecisionMessage, buildOutcomeEmbed } from '../../src/discord/commands/action.js';
import type { ActionOutcome } from '../../src/engine/WorldEngine.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
function buttons(msg: ReturnType<typeof buildDecisionMessage>): any[] {
  return msg.components.flatMap((r: any) => r.components);
}

describe('buildDecisionMessage — A/B/C buttons', () => {
  it('lists real options as lettered body lines; bail is not lettered', () => {
    const msg = buildDecisionMessage({
      prompt: 'A wolf blocks the path.',
      options: [
        { label: 'Track the wolf quietly', dcModifier: -2 },
        { label: 'Charge in', dcModifier: 2 },
        { label: 'Step back', dcModifier: null },
      ],
    }, 0);

    const desc = (msg.embeds[0] as any).description as string;
    expect(desc).toContain('**A.** Track the wolf quietly');
    expect(desc).toContain('**B.** Charge in');
    expect(desc).not.toContain('Step back'); // terminal option lives on the button only
  });

  it('labels real-option buttons A/B and keeps a worded bail button', () => {
    const msg = buildDecisionMessage({
      prompt: 'x',
      options: [
        { label: 'Track the wolf quietly', dcModifier: -2 },
        { label: 'Charge in', dcModifier: 2 },
        { label: 'Step back', dcModifier: null },
      ],
    }, 0);

    expect(buttons(msg).map(b => b.label)).toEqual(['A', 'B', 'Step back']);
  });

  it('maps each letter button to its original option index (resolution depends on this)', () => {
    const msg = buildDecisionMessage({
      prompt: 'x',
      options: [
        { label: 'first', dcModifier: 0 },
        { label: 'second', dcModifier: -1 },
        { label: 'Bail', dcModifier: null },
      ],
    }, 2);

    const btns = buttons(msg);
    expect(btns[0].custom_id).toBe('action:choice:2:0');
    expect(btns[1].custom_id).toBe('action:choice:2:1');
    expect(btns[2].custom_id).toBe('action:bail');
  });
});

describe('buildDecisionMessage — hidden DCs & earned passive-insight hint', () => {
  const SUCCESS = 3; // ButtonStyle.Success
  const SECONDARY = 2; // ButtonStyle.Secondary

  // Easy path DC 10, hard path DC 16 (running 12 ± modifier) — a clear gap.
  const decision = {
    prompt: 'A fork in the road.',
    options: [
      { label: 'Easy path', dcModifier: -2 },
      { label: 'Hard path', dcModifier: 4 },
      { label: 'Step back', dcModifier: null },
    ],
  };
  const state = { rawInput: 'go east', decisions: [], accumulatedDc: 12 };

  it('never shows raw DC numbers while deciding', () => {
    const wise = { stats: { physical: 0, wisdom: 4, intelligence: 0, charisma: 0 } };
    const desc = (buildDecisionMessage(decision, 0, state, wise).embeds[0] as any).description as string;
    expect(desc).not.toMatch(/DC\s*\d/);
  });

  it('lights exactly one option green when insight warrants it (clear safest path, within reach)', () => {
    // WIS 2 → passive insight 12 ≥ best DC 10, and 16 − 10 = 6 ≥ margin.
    const char = { stats: { physical: 0, wisdom: 2, intelligence: 0, charisma: 0 } };
    const btns = buttons(buildDecisionMessage(decision, 0, state, char));
    expect(btns.filter(b => b.style === SUCCESS)).toHaveLength(1);
    expect(btns[0].style).toBe(SUCCESS);   // Easy path
    expect(btns[1].style).toBe(SECONDARY); // Hard path
    const desc = (buildDecisionMessage(decision, 0, state, char).embeds[0] as any).description as string;
    expect(desc).toContain('🟢');
  });

  it('gives no hint to a character whose insight cannot reach the easiest option', () => {
    // WIS -1 → passive insight 9 < best DC 10.
    const char = { stats: { physical: 0, wisdom: -1, intelligence: 0, charisma: 0 } };
    const btns = buttons(buildDecisionMessage(decision, 0, state, char));
    expect(btns.every(b => b.style !== SUCCESS)).toBe(true);
  });

  it('gives no hint when no option is clearly safer than the rest (not warranted)', () => {
    // Both within reach of a very wise character, but DCs are tied — nothing stands out.
    const flat = {
      prompt: 'Two even paths.',
      options: [
        { label: 'Left', dcModifier: 0 },
        { label: 'Right', dcModifier: 0 },
        { label: 'Step back', dcModifier: null },
      ],
    };
    const wise = { stats: { physical: 0, wisdom: 5, intelligence: 0, charisma: 0 } };
    const btns = buttons(buildDecisionMessage(flat, 0, state, wise));
    expect(btns.every(b => b.style !== SUCCESS)).toBe(true);
  });

  it('shows no hint and no DCs when the character is unknown', () => {
    const btns = buttons(buildDecisionMessage(decision, 0, state));
    expect(btns.every(b => b.style !== SUCCESS)).toBe(true);
  });

  it('renders the gamebook story thread: quest, quoted prior prompt, bold choice', () => {
    const msg = buildDecisionMessage(decision, 1, {
      rawInput: 'hunt the stag',
      decisions: [{ prompt: 'The stag freezes at the treeline.', chosen: 'Track it', dcModifier: -1 }],
      accumulatedDc: 11,
    });
    const desc = (msg.embeds[0] as any).description as string;
    expect(desc).toContain('> 🧭 **Quest:** hunt the stag');
    // Prior beat: the DM prompt is quoted, the player's choice is bold, with a
    // green/red difficulty arrow (−1 modifier → easier → green down).
    expect(desc).toContain('> The stag freezes at the treeline.');
    expect(desc).toContain('↪ **Track it 🟢⬇️**');
    // The current scene is quoted DM narration too.
    expect(desc).toContain('> A fork in the road.');
  });
});

describe('buildOutcomeEmbed — quoted recap', () => {
  const outcome: ActionOutcome = {
    distilledType: 'hunt',
    finalDc: 14,
    playerRolled: 16,
    outcome: 'success',
    outcomeText: 'The stag falls. You field-dress it by the river.',
    mutations: [],
  };

  it('recaps the encounter as a full gamebook thread: quoted prompts + bold choices + outcome', () => {
    const desc = buildOutcomeEmbed(outcome, null, null, {
      rawInput: 'hunt the stag',
      decisions: [
        { prompt: 'The mist thickens between the pines as distant hooves fade north.', chosen: 'Track it', dcModifier: -1, distilledType: 'hunt' },
        { prompt: 'A twig snaps — the stag bolts toward the ford.', chosen: 'Cut it off at the river', dcModifier: 2, distilledType: 'hunt' },
      ],
    }).description as string;

    expect(desc).toContain('> 🧭 **Quest:** hunt the stag');
    // Each prior beat: DM prompt quoted, player choice bold, with a difficulty
    // arrow instead of a raw DC number (negative → green down, positive → red up).
    expect(desc).toContain('> The mist thickens between the pines as distant hooves fade north.');
    expect(desc).toContain('↪ **Track it 🟢⬇️**');
    expect(desc).toContain('> A twig snaps — the stag bolts toward the ford.');
    expect(desc).toContain('↪ **Cut it off at the river 🔴⬆️**');
    // No raw DC numbers leak into the recap.
    expect(desc).not.toMatch(/DC\s*[+-]?\d/);
    // The final outcome narration is the focal (unquoted) text.
    expect(desc).toContain('The stag falls.');
  });

  it('stays within the 4096-char embed cap, degrading a huge thread gracefully', () => {
    const longPrompt = 'X'.repeat(1500);
    const desc = buildOutcomeEmbed(outcome, null, null, {
      rawInput: 'epic quest',
      decisions: Array.from({ length: 8 }, (_, i) => ({
        prompt: longPrompt, chosen: `Choice ${i}`, dcModifier: 0, distilledType: 'hunt',
      })),
    }).description as string;

    expect(desc.length).toBeLessThanOrEqual(4096);
    // The quest line and the outcome survive the degradation.
    expect(desc).toContain('> 🧭 **Quest:** epic quest');
    expect(desc).toContain('The stag falls.');
  });
});
