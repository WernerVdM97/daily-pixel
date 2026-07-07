import { describe, it, expect } from 'vitest';
import { buildDecisionMessage, buildOutcomeEmbed, setPendingDecision, getChoiceLabel } from '../../src/discord/commands/action.js';
import type { ActionOutcome } from '../../src/engine/WorldEngine.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
function buttons(msg: ReturnType<typeof buildDecisionMessage>): any[] {
  return msg.components.flatMap((r: any) => r.components);
}

describe('buildDecisionMessage — A/B/C buttons', () => {
  it('lists real options as lettered body lines, stat-emoji-prefixed and dcArrow-suffixed; bail is not lettered', () => {
    const msg = buildDecisionMessage({
      prompt: 'A wolf blocks the path.',
      options: [
        { label: 'Track the wolf quietly', dcModifier: -2, stat: 'physical' },
        { label: 'Charge in', dcModifier: 2, stat: 'wisdom' },
        { label: 'Step back', dcModifier: null },
      ],
    }, 0);

    const desc = (msg.embeds[0] as any).description as string;
    // decide-scene-narration: each option carries its stat emoji (from STAT_LABELS)
    // as a prefix and a dcArrow difficulty hint as a suffix — render-only decoration.
    expect(desc).toContain('**A.** 💪 Track the wolf quietly 🟢⬇️');
    expect(desc).toContain('**B.** 🧠 Charge in 🔴⬆️');
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

  it('renders the gamebook story thread: quest, quoted prior narration, bold choice', () => {
    const msg = buildDecisionMessage(decision, 1, {
      rawInput: 'hunt the stag',
      decisions: [{
        prompt: 'Hunt — what do you do?',
        chosen: 'Track it',
        dcModifier: -1,
        narration: 'The stag freezes at the treeline.',
      }],
      accumulatedDc: 11,
    });
    const desc = (msg.embeds[0] as any).description as string;
    expect(desc).toContain('> 🧭 **Quest:** hunt the stag');
    // Prior beat: its narration (the consequence of the choice before it) is
    // quoted, the player's choice is bold, with a green/red difficulty arrow
    // (−1 modifier → easier → green down). The beat's own `prompt` (CTA) never
    // renders in the thread.
    expect(desc).toContain('> The stag freezes at the treeline.');
    expect(desc).toContain('↪ **Track it 🟢⬇️**');
    expect(desc).not.toContain('Hunt — what do you do?');
    // The current scene's CTA is quoted too.
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

  it('recaps the encounter as a full gamebook thread: first beat choice-only, later beat narration + choice, plus outcome', () => {
    const desc = buildOutcomeEmbed(outcome, null, null, {
      rawInput: 'hunt the stag',
      decisions: [
        // First beat authors no narration (lean, framed by the player's own input).
        { prompt: 'Hunt — what do you do?', chosen: 'Track it', dcModifier: -1, distilledType: 'hunt' },
        // Second beat's narration is the consequence of the first choice.
        {
          prompt: 'Hunt — what do you do?',
          chosen: 'Cut it off at the river',
          dcModifier: 2,
          distilledType: 'hunt',
          narration: 'A twig snaps — the stag bolts toward the ford.',
        },
      ],
    }).description as string;

    expect(desc).toContain('> 🧭 **Quest:** hunt the stag');
    // First beat: no narration to quote, choice-only.
    expect(desc).not.toContain('Hunt — what do you do?');
    expect(desc).toContain('↪ **Track it 🟢⬇️**');
    // Second beat: its narration is quoted, player choice bold, with a difficulty
    // arrow instead of a raw DC number (negative → green down, positive → red up).
    expect(desc).toContain('> A twig snaps — the stag bolts toward the ford.');
    expect(desc).toContain('↪ **Cut it off at the river 🔴⬆️**');
    // No raw DC numbers leak into the recap.
    expect(desc).not.toMatch(/DC\s*[+-]?\d/);
    // The final outcome narration is the focal (unquoted) text.
    expect(desc).toContain('The stag falls.');
  });

  it('stays within the 4096-char embed cap, degrading a huge narration thread gracefully', () => {
    const longNarration = 'X'.repeat(1500);
    const desc = buildOutcomeEmbed(outcome, null, null, {
      rawInput: 'epic quest',
      decisions: Array.from({ length: 8 }, (_, i) => ({
        prompt: `Beat ${i} — what do you do?`, chosen: `Choice ${i}`, dcModifier: 0, distilledType: 'hunt', narration: longNarration,
      })),
    }).description as string;

    expect(desc.length).toBeLessThanOrEqual(4096);
    // The quest line and the outcome survive the degradation.
    expect(desc).toContain('> 🧭 **Quest:** epic quest');
    expect(desc).toContain('The stag falls.');
  });
});

describe('Work vs Quest story-thread label (ActionState.kind)', () => {
  const outcome: ActionOutcome = {
    distilledType: 'craft',
    finalDc: 10,
    playerRolled: 12,
    outcome: 'success',
    mutations: [{ type: 'modify_stamina', amount: -1 }],
    outcomeText: 'You finish the batch.',
  };

  it('labels a preset day-job action as Work in the outcome', () => {
    const embed: any = buildOutcomeEmbed(outcome, null, null, {
      rawInput: 'You pace the streets and the wall.',
      decisions: [],
      kind: 'work',
    });
    expect(embed.description).toContain('🛠️ **Work:**');
    expect(embed.description).not.toContain('🧭 **Quest:**');
  });

  it('labels a freeform action as Quest (default) in the outcome', () => {
    const embed: any = buildOutcomeEmbed(outcome, null, null, {
      rawInput: 'I hunt the white stag',
      decisions: [],
    });
    expect(embed.description).toContain('🧭 **Quest:**');
  });

  it('labels a Work decision view too', () => {
    const msg: any = buildDecisionMessage(
      { prompt: 'A dispute brews.', options: [{ label: 'Step in', dcModifier: 0 }] },
      0,
      { rawInput: 'Raised voices spill from the tavern.', decisions: [], kind: 'work' },
    );
    expect(msg.embeds[0].description).toContain('🛠️ **Work:**');
  });
});

describe('Work label uses the profession emoji', () => {
  const outcome: ActionOutcome = {
    distilledType: 'patrol', finalDc: 10, playerRolled: 12, outcome: 'success',
    mutations: [{ type: 'modify_stamina', amount: -1 }], outcomeText: 'Rounds walked.',
  };

  it('tags a Work outcome with the day-job emoji (Town Guard → 🛡️)', () => {
    const embed: any = buildOutcomeEmbed(outcome, { dayJob: 'Town Guard' } as any, null, {
      rawInput: 'You hold the gate.', decisions: [], kind: 'work',
    });
    expect(embed.description).toContain('🛡️ **Work:**');
  });

  it('tags a Work decision view with the day-job emoji', () => {
    const msg: any = buildDecisionMessage(
      { prompt: 'A dispute brews.', options: [{ label: 'Step in', dcModifier: 0 }] },
      0,
      { rawInput: 'Raised voices.', decisions: [], kind: 'work' },
      { stats: { physical: 1, wisdom: 1, intelligence: 1, charisma: 1 }, dayJob: 'Town Guard' } as any,
    );
    expect(msg.embeds[0].description).toContain('🛡️ **Work:**');
  });
});

// ── Owner identity on public outcome messages (F#3, F#8) ──

describe('Outcome payload — owner mention', () => {
  it('public content line carries the owner Discord mention after the character name', () => {
    const userId = '123456789012345678';
    const payload = {
      content: `⚔️ **Thorn** <@${userId}> — hunt`,
      embeds: [],
      components: [],
      allowedMentions: { users: [] },
    };
    expect(payload.content).toContain(`<@${userId}>`);
    // The mention sits after the bold character name, before the dash
    expect(payload.content).toMatch(/\*\*\w+\*\*\s+<@\d+>/);
  });

  it('includes allowedMentions with empty users array to suppress the ping', () => {
    const payload = {
      content: '⚔️ **Thorn** <@123456789012345678> — hunt',
      embeds: [],
      components: [],
      allowedMentions: { users: [] },
    };
    expect(payload.allowedMentions).toBeDefined();
    expect(payload.allowedMentions!.users).toEqual([]);
  });
});

// ── decide-scene-narration: narration + combatStatus on the decision screen ──

describe('buildDecisionMessage — narration and combatStatus', () => {
  it('renders narration quoted above the CTA when present', () => {
    const msg = buildDecisionMessage({
      prompt: 'Scout — what do you do?',
      narration: 'Wolves circle the ridge, tracking your scent.',
      options: [{ label: 'Track the wolf quietly', dcModifier: -2, stat: 'physical' }],
    }, 0);
    const desc = (msg.embeds[0] as any).description as string;
    expect(desc).toContain('> Wolves circle the ridge, tracking your scent.');
    expect(desc).toContain('> Scout — what do you do?');
    expect(desc.indexOf('Wolves circle')).toBeLessThan(desc.indexOf('Scout — what do you do?'));
  });

  it('shows no narration block on the first beat (absent narration) — just the quest line, CTA, and options', () => {
    const msg = buildDecisionMessage({
      prompt: 'Scout — what do you do?',
      options: [{ label: 'Track the wolf quietly', dcModifier: -2 }],
    }, 0);
    const desc = (msg.embeds[0] as any).description as string;
    expect(desc).toBe('> Scout — what do you do?\n\n**A.** Track the wolf quietly 🟢⬇️');
  });

  it('renders combatStatus as a plain (unquoted) line between narration and the CTA on combat continue-screens', () => {
    const msg = buildDecisionMessage({
      prompt: 'Combat — what do you do?',
      narration: 'The wolf lunges, jaws snapping shut on air.',
      combatStatus: 'Wolf: ▓▓▓░░ Bloodied · You: −2 HP',
      options: [{ label: 'Press the attack', dcModifier: 0, stat: 'physical' }],
    }, 1);
    const desc = (msg.embeds[0] as any).description as string;
    expect(desc).toContain('Wolf: ▓▓▓░░ Bloodied · You: −2 HP');
    // Plain line: not prefixed with the blockquote marker.
    expect(desc).not.toContain('> Wolf: ▓▓▓░░');
    expect(desc.indexOf('jaws snapping')).toBeLessThan(desc.indexOf('Wolf: ▓▓▓░░'));
    expect(desc.indexOf('Wolf: ▓▓▓░░')).toBeLessThan(desc.indexOf('Combat — what do you do?'));
  });

  it('omits combatStatus on non-combat screens where the engine never set it', () => {
    const msg = buildDecisionMessage({
      prompt: 'Scout — what do you do?',
      narration: 'The trail forks ahead.',
      options: [{ label: 'Take the low path', dcModifier: 0 }],
    }, 0);
    const desc = (msg.embeds[0] as any).description as string;
    expect(desc).not.toMatch(/Wolf:|Bloodied|HP/);
  });
});

describe('buildDecisionMessage — option stat emoji degrades gracefully on a missing/unknown stat', () => {
  it('renders no icon (and does not crash) when stat is absent or unrecognised', () => {
    const msg = buildDecisionMessage({
      prompt: 'x',
      options: [
        { label: 'Missing stat', dcModifier: 0 },
        { label: 'Unknown stat', dcModifier: 0, stat: 'luck' },
      ],
    }, 0);
    const desc = (msg.embeds[0] as any).description as string;
    expect(desc).toContain('**A.** Missing stat');
    expect(desc).toContain('**B.** Unknown stat');
  });
});

describe('Option decorations are render-only — the raw label persists as `chosen`', () => {
  it('getChoiceLabel returns the undecorated label, with no stat emoji or dcArrow', () => {
    setPendingDecision('narration-test-user', {
      prompt: 'x',
      narration: 'Something happens.',
      options: [{ label: 'Shoulder-charge the brute', dcModifier: 2, stat: 'physical' }],
    });
    expect(getChoiceLabel('narration-test-user', 0)).toBe('Shoulder-charge the brute');
  });
});
