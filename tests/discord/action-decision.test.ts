import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildDecisionMessage, buildOutcomeEmbed } from '../../src/discord/commands/action.js';
import type { ActionOutcome } from '../../src/engine/WorldEngine.js';
import type { CombatBeatLog } from '../../src/engine/action/combat-dc.js';
import { WorldEngineImpl } from '../../src/engine/WorldEngineImpl.js';
import { MockPipelineGateway } from '../helpers/MockPipelineGateway.js';
import { initDb, closeDb, getDb } from '../../src/db/connection.js';
import { migrate, seedWorld, SEEDED_LOCATIONS, SEEDED_EDGES } from '../../src/db/migrate.js';
import { UserRepository } from '../../src/db/repositories/user.js';
import { CharacterRepository } from '../../src/db/repositories/character.js';
import { ItemRepository } from '../../src/db/repositories/item.js';
import { ActionRepository } from '../../src/db/repositories/action.js';
import { NpcRepository } from '../../src/db/repositories/npc.js';

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
    expect(desc).toContain('**A.** 💪 Track the wolf quietly ⬇️');
    expect(desc).toContain('**B.** 🧠 Charge in ⬆️');
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

  it('lights exactly one option green when insight warrants it (clear safest path, within reach) — button colour only, no redundant emoji', () => {
    // WIS 2 → passive insight 12 ≥ best DC 10, and 16 − 10 = 6 ≥ margin.
    const char = { stats: { physical: 0, wisdom: 2, intelligence: 0, charisma: 0 } };
    const btns = buttons(buildDecisionMessage(decision, 0, state, char));
    expect(btns.filter(b => b.style === SUCCESS)).toHaveLength(1);
    expect(btns[0].style).toBe(SUCCESS);   // Easy path
    expect(btns[1].style).toBe(SECONDARY); // Hard path
    const msg = buildDecisionMessage(decision, 0, state, char);
    const desc = (msg.embeds[0] as any).description as string;
    const footer = (msg.embeds[0] as any).footer.text as string;
    // The passive tell is the footer prose plus the button colour — never a
    // redundant emoji in the option text itself.
    expect(desc).not.toContain('🟢');
    expect(footer).toBe('a safer path catches your eye');
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
    // quoted, the player's choice is bold, with a difficulty arrow (−1
    // modifier → easier → down). The beat's own `prompt` (CTA) never renders
    // in the thread.
    expect(desc).toContain('> The stag freezes at the treeline.');
    expect(desc).toContain('↪ **Track it ⬇️**');
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
    expect(desc).toContain('↪ **Track it ⬇️**');
    // Second beat: its narration is quoted, player choice bold, with a difficulty
    // arrow instead of a raw DC number (negative → down, positive → up).
    expect(desc).toContain('> A twig snaps — the stag bolts toward the ford.');
    expect(desc).toContain('↪ **Cut it off at the river ⬆️**');
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
    expect(desc).toBe('> Scout — what do you do?\n\n**A.** Track the wolf quietly ⬇️');
  });

  it('ANSI-C tolerant read: a legacy pre-rendered string combatStatus (old in-flight state) — the actual output of renderFrame, an already-fenced ```ansi block — renders unmodified, without throwing', () => {
    const legacyFencedStatus = '```ansi\nWolf: ▓▓▓░░ Bloodied · You: −2 HP\n```';
    const msg = buildDecisionMessage({
      prompt: 'Combat — what do you do?',
      narration: 'The wolf lunges, jaws snapping shut on air.',
      combatStatus: legacyFencedStatus,
      options: [{ label: 'Press the attack', dcModifier: 0, stat: 'physical' }],
    }, 1);
    const desc = (msg.embeds[0] as any).description as string;
    // Lands unmodified: no re-fencing, no backtick escaping applied over the legacy block.
    expect(desc).toContain(legacyFencedStatus);
    expect(desc.indexOf('jaws snapping')).toBeLessThan(desc.indexOf('```ansi'));
    expect(desc.indexOf('```ansi')).toBeLessThan(desc.indexOf('Combat — what do you do?'));
  });

  it('ANSI-C: a structured CombatStatusData combatStatus (current engine shape) is composed into an AnsiRenderer frame', () => {
    const msg = buildDecisionMessage({
      prompt: 'Combat — what do you do?',
      narration: 'The wolf lunges, jaws snapping shut on air.',
      combatStatus: {
        enemyName: 'Wolf',
        woundWord: 'Bloodied',
        pips: { filled: 3, total: 5 },
        playerHp: 10,
        playerMaxHp: 12,
        playerHpDelta: -2,
      },
      options: [{ label: 'Press the attack', dcModifier: 0, stat: 'physical' }],
    }, 1);
    const desc = (msg.embeds[0] as any).description as string;
    // Composed via AnsiRenderer — a fenced frame, not a plain text line.
    // Continue card redesign: HP floaters are no longer rendered as separate lines;
    // the displayed HP is already post-delta (10/12).
    expect(desc).toContain('```ansi');
    expect(desc).toContain('Wolf');
    expect(desc).toContain('Bloodied');
    expect(desc).toContain('10/12');
  });

  // ── ANSI-D: the continue frame's dice line (previously the frame showed HP bands only) ──

  function round(overrides: Partial<CombatBeatLog> = {}): CombatBeatLog {
    const beat = {
      round: 1,
      band: 'trade',
      enemyHpBefore: 10,
      enemyHpAfter: 8,
      playerHpDelta: -2,
      playerD20: 14,
      playerBonus: 3,
      dc: 15,
      enemyD20: 10,
      enemyBonus: 2,
      materialMutationFired: true,
      ops: ['modify_health'],
      marker: 'combat_round',
      ...overrides,
    };
    // Derive margin from this beat's own dice rather than trusting a caller-supplied value —
    // a hardcoded margin that contradicts the dice is the exact wiring-bug class 0.3.2 exists
    // to catch, so the fixture must not be able to assert on a self-contradictory round.
    const margin = (beat.playerD20 + beat.playerBonus) - (beat.enemyD20 + beat.enemyBonus);
    return { ...beat, margin };
  }

  const combatStatus = {
    enemyName: 'Wolf',
    woundWord: 'Bloodied',
    pips: { filled: 3, total: 5 },
    playerHp: 10,
    playerMaxHp: 12,
    playerHpDelta: -2,
  };

  it('shows the round dice line (contested roll vs enemy total + margin/band) when combatRounds carries a fought round', () => {
    const msg = buildDecisionMessage({
      prompt: 'Combat — what do you do?',
      combatStatus,
      combatRounds: [round()],
      options: [{ label: 'Press the attack', dcModifier: 0, stat: 'physical' }],
    }, 1);
    const desc = (msg.embeds[0] as any).description as string;

    // POC+ 0.3.2 C1: the readout shows the contested roll (player vs enemy total),
    // not a solo `[DC N]` threshold — mirrors the terminal card's vocabulary.
    // Strip SGR — ANSI codes split segments so 'hit +5 margin' isn't contiguous raw.
    const mono = desc.replace(/\x1b\[[0-9;]*m/g, '');
    expect(mono).toContain('vs 10 +2 = 12');
    expect(mono).toContain('+3 = 17');
    // margin derived from the fixture's own dice: (14+3) - (10+2) = +5.
    expect(mono).toContain('hit +5 margin');
    expect(mono).toContain('TRADE');
    expect(mono).not.toContain('[DC');
  });

  it('reads the LAST round of combatRounds (a multi-round fight shows the most recent dice, not the first)', () => {
    const msg = buildDecisionMessage({
      prompt: 'Combat — what do you do?',
      combatStatus,
      combatRounds: [
        round({ round: 1, playerD20: 5, dc: 11, band: 'heavy' }),
        round({ round: 2, playerD20: 19, playerBonus: 2, dc: 13, band: 'clean' }),
      ],
      options: [{ label: 'Press the attack', dcModifier: 0, stat: 'physical' }],
    }, 1);
    const desc = (msg.embeds[0] as any).description as string;

    // Strip SGR for the checks below — colour codes split segments.
    const mono = desc.replace(/\x1b\[[0-9;]*m/g, '');
    expect(mono).toContain('vs 10 +2 = 12');
    expect(mono).toContain('+2 = 21');
    // margin derived from round 2's own dice: (19+2) - (10+2) = +9.
    expect(mono).toContain('hit +9 margin');
    expect(mono).toContain('CLEAN');
    // Round 1's playerD20 (5) must not appear as the focal digit — only the last round shows.
    expect(mono).not.toMatch(/ {2}5\s/);
  });

  it('signs a negative bonus and a negative margin correctly', () => {
    const msg = buildDecisionMessage({
      prompt: 'Combat — what do you do?',
      combatStatus,
      combatRounds: [round({ playerD20: 4, playerBonus: -1, dc: 15, band: 'heavy' })],
      options: [{ label: 'Press the attack', dcModifier: 0, stat: 'physical' }],
    }, 1);
    const desc = (msg.embeds[0] as any).description as string;

    const mono = desc.replace(/\x1b\[[0-9;]*m/g, '');
    expect(mono).toContain('vs 10 +2 = 12');
    expect(mono).toContain('-1 = 3');
    // margin derived from this round's own dice: (4-1) - (10+2) = -9.
    expect(mono).toContain('hit -9 margin');
    expect(mono).toContain('HEAVY');
    expect(mono).not.toContain('[DC');
  });

  it('shows no dice line when combatRounds is absent (first beat / pre-combat) — HP bands render exactly as before', () => {
    const msg = buildDecisionMessage({
      prompt: 'Combat — what do you do?',
      combatStatus,
      options: [{ label: 'Press the attack', dcModifier: 0, stat: 'physical' }],
    }, 1);
    const desc = (msg.embeds[0] as any).description as string;

    expect(desc).not.toContain('d20');
    expect(desc).not.toContain('margin');
    // HP band content still present, unaffected
    expect(desc).toContain('Wolf');
    expect(desc).toContain('Bloodied');
  });

  it('shows no dice line when combatRounds is an empty array', () => {
    const msg = buildDecisionMessage({
      prompt: 'Combat — what do you do?',
      combatStatus,
      combatRounds: [],
      options: [{ label: 'Press the attack', dcModifier: 0, stat: 'physical' }],
    }, 1);
    const desc = (msg.embeds[0] as any).description as string;

    expect(desc).not.toContain('d20');
    expect(desc).not.toContain('margin');
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

// ── 0.3.2 C5: the last-stand / bail (desperate-choice) screen must show the same roll readout
// as an ordinary continue screen, not just the two buttons. The engine's floor branch emits a
// decision carrying combatStatus + combatRounds (a floorSave beat) plus the Bail bloodied / Last
// stand options — see PipelineActionStateMachine's desperate-choice branch, whose exact beat shape
// is pinned by `tests/engine/pipeline-machine.test.ts` ("the desperate-choice (floor) beat carries
// floorSave: true"). This asserts that shape renders the readout, closing the "on decision 2 I only
// see last stand or bail with no rolls" report. ──
describe('buildDecisionMessage — last-stand / bail decision screen shows the roll readout (C5)', () => {
  // Mirrors the engine's floor branch output: a floored player (survives at 1 HP, delta 0), the
  // band-depleted enemy, the fought round, and the two forced options.
  const floorBeat: CombatBeatLog = {
    round: 1,
    band: 'heavy',
    enemyHpBefore: 10,
    enemyHpAfter: 9,
    playerHpDelta: -2,
    playerD20: 1,
    playerBonus: 5,
    dc: 12,
    enemyD20: 10,
    enemyBonus: 2,
    margin: (1 + 5) - (10 + 2),
    materialMutationFired: true,
    ops: ['modify_health', 'set_relation', 'set_relation'],
    marker: 'combat_round',
    floorSave: true,
  };
  const desperateDecision = {
    prompt: "The blow would be lethal — you feel death's cold touch. Make your stand or flee before it's too late.",
    combatStatus: {
      enemyName: 'Shadow Stag',
      woundWord: 'Critical',
      pips: { filled: 5, total: 5 },
      playerHp: 1,
      playerMaxHp: 30,
      playerHpDelta: 0,
    },
    combatRounds: [floorBeat],
    options: [
      { label: 'Bail bloodied', dcModifier: null },
      { label: 'Last stand', dcModifier: 0 },
    ],
  };

  it('renders the contested-roll readout and enemy condition alongside the Bail/Last-stand buttons', () => {
    const msg = buildDecisionMessage(desperateDecision, 1);
    const desc = (msg.embeds[0] as any).description as string;
    const mono = desc.replace(/\x1b\[[0-9;]*m/g, '');

    // The same post-C1/C2 readout the ordinary continue screen shows: the contested roll (player
    // vs the enemy's total), the signed margin, and the band word — never a solo [DC N].
    expect(mono).toContain('vs 10 +2 = 12'); // enemy contested total
    expect(mono).toContain('+5 = 6');        // player total (1 + 5)
    expect(mono).toContain('hit -6 margin'); // margin (1+5) - (10+2) = -6
    expect(mono).toContain('HEAVY');
    expect(mono).not.toContain('[DC');
    // Enemy condition still reads (banded, not exact numbers).
    expect(mono).toContain('Shadow Stag');
    expect(mono).toContain('Critical');

    // The forced options still render — the readout is ADDED above them, not a swap. Both survive
    // the standard convention: the real "Last stand" option is lettered (A) with its label in the
    // body; the terminal "Bail bloodied" keeps a worded button. (Cosmetic styling of these buttons
    // is a separate tracked item, TODO.md — out of C5's readout scope.)
    expect(desc).toContain('**A.** Last stand');
    expect(buttons(msg).map((b: any) => b.label)).toEqual(['Bail bloodied', 'A']);
  });
});

// ── SL-6: the fatal-blow interstitial on a WIN offers finish/spare instead of a silent
// short-circuit to the outcome — see PipelineActionStateMachine's fatal-blow branch, whose exact
// beat shape is pinned by `tests/engine/pipeline-machine.test.ts`
// ("PipelineActionStateMachine — SL-6 fatal-blow interstitial (RA-5c)"). Cloned from the
// last-stand/bail idiom above: both options here are real (non-bail — `dcModifier: 0`), so
// there is no worded terminal button, just two lettered choices. ──
describe('buildDecisionMessage — fatal-blow (finish/spare) decision screen (SL-6)', () => {
  const fatalBlowDecision = {
    prompt: 'Shadow Stag is broken and cannot rise. Finish it, or let it live?',
    // RA-3 correction: the real path can no longer produce `woundWord: 'Slain'` / `filled: 0`
    // here — the player hasn't chosen finish/spare yet, so `handleCombatStep`'s fatal-blow
    // branch deliberately bands a nominal 1 HP (never the real 0), reading a last-gasp
    // survivor. 1/5 -> 'Battered', filled 1 (see `enemyConditionBand`'s own unit coverage).
    combatStatus: {
      enemyName: 'Shadow Stag',
      woundWord: 'Battered',
      pips: { filled: 1, total: 5 },
      playerHp: 24,
      playerMaxHp: 30,
      playerHpDelta: 0,
    },
    combatRounds: [],
    options: [
      { label: 'Finish it', dcModifier: 0 },
      { label: 'Show mercy', dcModifier: 0 },
    ],
  };

  it('renders both options as lettered A/B body lines with no worded bail button', () => {
    const msg = buildDecisionMessage(fatalBlowDecision, 1);
    const desc = (msg.embeds[0] as any).description as string;

    expect(desc).toContain('**A.** Finish it');
    expect(desc).toContain('**B.** Show mercy');
    expect(desc).toContain('Shadow Stag');

    // Neither option is a bail (`dcModifier: 0` on both, per the RA-5c trap: a null dcModifier
    // would route through step()'s bail path instead, charging stamina and leaving the fight live).
    expect(buttons(msg).map((b: any) => b.label)).toEqual(['A', 'B']);
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
  // Pins the real seam: the stat emoji + dcArrow shown on a decision's rendered option
  // LINE (see actionViewState.ts's `optionLines` build) are cosmetic to that line only.
  // The engine indexes and resolves `opt.label` itself — via `resolvePendingChoice` — which
  // must stay undecorated, since that's what a bail/option click echoes back as `chosen`
  // (M3.2 DC-A/C). A same-object mutation check (the old version of this test) can't fail
  // even if decoration DID leak into the persisted label, because nothing here mutates the
  // input option — it only proves buildDecisionMessage doesn't write back to its input, not
  // that resolution stays undecorated. Wiring a real WorldEngineImpl end to end closes that
  // gap: it renders the decorated line AND resolves the same seeded option through the real
  // `resolvePendingChoice` path (mirrors tests/engine/resolve-pending-choice.test.ts's setup).
  let engine: WorldEngineImpl;
  let charRepo: CharacterRepository;
  let characterId: number;

  beforeEach(() => {
    initDb(':memory:');
    migrate(getDb());
    seedWorld(getDb(), SEEDED_LOCATIONS, SEEDED_EDGES);
    charRepo = new CharacterRepository(getDb());
    engine = new WorldEngineImpl({
      db: getDb(),
      userRepo: new UserRepository(getDb()),
      charRepo,
      itemRepo: new ItemRepository(getDb()),
      actionRepo: new ActionRepository(getDb()),
      npcRepo: new NpcRepository(getDb()),
      pipelineLlmGateway: new MockPipelineGateway(),
      rollD20: () => 15,
    });
    const char = engine.createCharacter('u1', {
      name: 'Kael', class: 'Hunter', upbringing: 'Outskirts',
      race: 'Human', alignment: 'Neutral', dayJob: 'Forager',
    });
    characterId = char.id;
  });

  afterEach(() => closeDb());

  it('renders a decorated option line but resolves the raw, undecorated label', () => {
    const options = [{ label: 'Shoulder-charge the brute', dcModifier: 2, stat: 'physical' }];
    charRepo.update(characterId, {
      last_action_state: JSON.stringify({ pendingDecision: { prompt: 'A brute blocks the path.', options } }),
    });

    // dcModifier: 2 (nonzero) + stat: 'physical' → the rendered line gains both the stat
    // emoji prefix and the dcArrow suffix.
    const msg = buildDecisionMessage(
      { prompt: 'A brute blocks the path.', options },
      0,
      { rawInput: 'fight the brute', decisions: [], accumulatedDc: 8 },
      { stats: { physical: 10, wisdom: 10, intelligence: 10, charisma: 10 } },
    );
    const desc = (msg.embeds[0] as any).description as string;
    expect(desc).toContain('💪'); // physical stat emoji prefix
    expect(desc).toContain('⬆️'); // dcArrow suffix (positive dcModifier)
    expect(desc).toContain('**A.** 💪 Shoulder-charge the brute ⬆️');

    // The label the engine actually indexes/resolves — via the real resolvePendingChoice,
    // against the same seeded options — must be the raw label, with no decoration.
    const resolved = engine.resolvePendingChoice(characterId, { kind: 'option', index: 0 });
    expect(resolved).toBe('Shoulder-charge the brute');
  });
});

describe('buildDecisionMessage — ANSI-F opening frame (art post + reply-body delivery)', () => {
  const decision = { prompt: 'A wolf blocks the path.', options: [{ label: 'Fight', dcModifier: 0 }] };
  const char = { stats: { physical: 10, wisdom: 10, intelligence: 10, charisma: 10 }, name: 'Aldric', health: 24, maxHealth: 30, location: 'Oakhollow' };

  it('prepends an opening-frame embed ahead of the decision embed on the first decision when actionType is given', () => {
    const msg = buildDecisionMessage(decision, 0, undefined, char, 'travel');
    expect(msg.embeds.length).toBe(2);
    const frameDesc = (msg.embeds[0] as any).description as string;
    expect(frameDesc).toContain('```ansi');
    expect(frameDesc).toContain('Oakhollow');
    // The decision embed (narration/options/CTA — the "reply body") stays SECOND, untouched.
    const decisionDesc = (msg.embeds[1] as any).description as string;
    expect(decisionDesc).toContain('Fight');
  });

  it('omits the opening frame entirely when no actionType is supplied (backward-compatible default)', () => {
    const msg = buildDecisionMessage(decision, 0, undefined, char);
    expect(msg.embeds.length).toBe(1);
  });

  it('never prepends the opening frame on a CONTINUE beat (decisionIdx > 0), even if actionType were passed', () => {
    const msg = buildDecisionMessage(decision, 1, undefined, char, 'travel');
    expect(msg.embeds.length).toBe(1);
  });

  it('renders the combat register with the real PC name/HP and an honest placeholder foe', () => {
    const msg = buildDecisionMessage(decision, 0, undefined, char, 'combat');
    const frameDesc = (msg.embeds[0] as any).description as string;
    expect(frameDesc).toContain('Aldric');
    expect(frameDesc).toContain('24/30');
    expect(frameDesc).toContain('Unknown foe');
  });

  it('degrades gracefully with no character data at all — still renders a frame, just placeholders', () => {
    const msg = buildDecisionMessage(decision, 0, undefined, undefined, 'other');
    expect(msg.embeds.length).toBe(2);
    const frameDesc = (msg.embeds[0] as any).description as string;
    expect(frameDesc).toContain('```ansi');
  });
});

describe('buildOutcomeEmbed — combat frame on outcome (0.3.2 P2)', () => {
  const combatBeat: CombatBeatLog = {
    round: 2,
    band: 'clean',
    enemyHpBefore: 6,
    enemyHpAfter: 0,
    playerHpDelta: 0,
    playerD20: 18,
    playerBonus: 5,
    dc: 10,
    enemyD20: 7,
    enemyBonus: 0,
    margin: 16,
    materialMutationFired: true,
    ops: ['set_relation'],
    marker: 'combat_round',
  };

  const combatOutcome: ActionOutcome = {
    distilledType: 'skirmish',
    finalDc: 10,
    playerRolled: 18,
    rollBonus: 5,
    rollStat: 'physical',
    outcome: 'success',
    outcomeText: 'Your blade finds its mark — the creature crumples.',
    mutations: [],
    combatBeat,
    combatFrame: { enemyName: 'Shadow Stag', enemyMaxHp: 24, margin: 16 },
    combatRounds: [combatBeat],
  };

  const char = {
    name: 'Aldric',
    health: 12,
    maxHealth: 12,
    stamina: 10,
    maxStamina: 10,
    rollsRemaining: 1,
    wealth: 5,
  };

  it('renders the combat opening frame on a combat outcome instead of the plain location scene', () => {
    const embed = buildOutcomeEmbed(combatOutcome, char as any, null, {
      rawInput: 'attack the stag',
      decisions: [],
    });
    const desc = (embed as any).description as string;
    // The combat opening frame renders within an ansi code block.
    expect(desc).toContain('```ansi');
    // The enemy nameplate appears in the combat frame.
    expect(desc).toContain('Shadow Stag');
    // The player nameplate also appears.
    expect(desc).toContain('Aldric');
    // The terminal card (with COMBAT RESOLVED and margin) is also present.
    expect(desc).toContain('COMBAT RESOLVED');
    expect(desc).toContain('margin +16');
    // The location scene (from the 'scene' parameter) is NOT rendered.
    // (We passed null for scene, so no location block could appear.)
  });

  it('shows the enemy at their final (depleted) HP-condition band, not full', () => {
    const embed = buildOutcomeEmbed(combatOutcome, char as any, null, {
      rawInput: 'attack the stag',
      decisions: [],
    });
    const desc = (embed as any).description as string;
    // The enemy's banded condition (wound word) from the last beat appears.
    // enemyHpAfter=0 (banded against enemyMaxHp=24) → fraction 0 → 'Slain' (RA-5a).
    expect(desc).toContain('Slain');
  });

  it('a non-combat outcome still shows the location scene as before', () => {
    const nonCombatOutcome: ActionOutcome = {
      distilledType: 'hunt',
      finalDc: 14,
      playerRolled: 16,
      outcome: 'success',
      outcomeText: 'The stag falls.',
      mutations: [],
    };
    const embed = buildOutcomeEmbed(nonCombatOutcome, char as any, '🌲 Forest scene art', {
      rawInput: 'hunt the stag',
      decisions: [{ prompt: 'Hunt', chosen: 'Track it', dcModifier: -1, distilledType: 'hunt' }],
    });
    const desc = (embed as any).description as string;
    expect(desc).toContain('Forest scene art');
  });
});
