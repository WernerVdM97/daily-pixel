import { describe, it, expect } from 'vitest';
import type { ActionOutcome } from '../../src/engine/WorldEngine.js';
import { formatOutcome, distilledActionEmoji } from '../../src/engine/OutcomeRenderer.js';

// ── Helpers ──

function ctx(overrides?: Partial<{
  stamina: number;
  maxStamina: number;
  rollsRemaining: number;
  health: number;
  maxHealth: number;
  wealth: number;
}>): {
  stamina: number;
  maxStamina: number;
  rollsRemaining: number;
  health: number;
  maxHealth: number;
  wealth: number;
} {
  return {
    stamina: 8,
    maxStamina: 10,
    rollsRemaining: 1,
    health: 10,
    maxHealth: 12,
    wealth: 5,
    ...overrides,
  };
}

// ── Success ──

describe('OutcomeRenderer — success', () => {
  const successOutcome: ActionOutcome = {
    distilledType: 'hunt',
    finalDc: 14,
    playerRolled: 16,
    outcome: 'success',
    outcomeText: 'The wolfsbane flares. The beast recoils, shrinking to the size of a common wolf before limping into the dark.',
    mutations: [],
  };

  it('shows roll vs DC with success emoji', () => {
    const result = formatOutcome(successOutcome, ctx());
    expect(result).toContain('🎲');
    expect(result).toContain('16  vs  14');
    expect(result).toContain('✅');
    expect(result).toContain('SUCCESS');
  });

  it('includes the outcome text from the LLM', () => {
    const result = formatOutcome(successOutcome, ctx());
    expect(result).toContain('The wolfsbane flares');
  });

  it('shows stamina and rolls in footer (no fixed denominator; spent roll surfaced)', () => {
    const result = formatOutcome(successOutcome, ctx());
    expect(result).toContain('⚡ 8/10');
    // No stale /2 denominator
    expect(result).not.toContain('🎲 1/2');
    // A resolved roll spends one roll → surfaced as (-1)
    expect(result).toContain('🎲 1 (-1)');
    // No delta suffix on stamina when mutations don't touch it
    expect(result).not.toContain('⚡ 8/10 (');
  });

  it('does not show health when unchanged', () => {
    const result = formatOutcome(successOutcome, ctx());
    expect(result).not.toContain('❤️');
  });

  it('shows health with delta when modified via mutation', () => {
    const outcome: ActionOutcome = {
      ...successOutcome,
      mutations: [{ type: 'modify_health', amount: -2 }],
    };
    const result = formatOutcome(outcome, ctx({ health: 8 }));
    expect(result).toContain('❤️ 8/12 (-2)');
  });

  it('shows positive health delta', () => {
    const outcome: ActionOutcome = {
      ...successOutcome,
      mutations: [{ type: 'modify_health', amount: 3 }],
    };
    const result = formatOutcome(outcome, ctx({ health: 13 }));
    expect(result).toContain('❤️ 13/12 (+3)');
  });

  it('does not show wealth when unchanged', () => {
    const result = formatOutcome(successOutcome, ctx());
    expect(result).not.toContain('💰');
  });

  it('lists items gained from add_item mutations', () => {
    const outcome: ActionOutcome = {
      ...successOutcome,
      mutations: [
        { type: 'add_item', emoji: '🦊', name: 'Wolf Pelt', stat: 'physical', modifier: 2 },
        { type: 'add_item', emoji: '🍖', name: 'Wolf Meat', stat: 'stamina', modifier: 1 },
      ],
    };
    const result = formatOutcome(outcome, ctx());
    expect(result).toContain('+ 🦊 Wolf Pelt');
    expect(result).toContain('+ 🍖 Wolf Meat');
  });

  it('shows location change from set_location mutation', () => {
    const outcome: ActionOutcome = {
      ...successOutcome,
      mutations: [{ type: 'set_location', name: 'Deep Forest' }],
    };
    const result = formatOutcome(outcome, ctx());
    expect(result).toContain('→ Deep Forest');
  });

  it('shows destination from cross_frontier mutation (feedback #16)', () => {
    const outcome: ActionOutcome = {
      ...successOutcome,
      mutations: [{ type: 'cross_frontier', direction: 'NE', name: 'Eastvale' }],
    };
    const result = formatOutcome(outcome, ctx());
    expect(result).toContain('→ Eastvale');
  });

  it('silently omits location line when cross_frontier carries no name', () => {
    // Validator rejects nameless cross_frontier before it reaches the renderer, but the
    // renderer should not crash or emit a bare "→ " if one slips through.
    const outcome: ActionOutcome = {
      ...successOutcome,
      mutations: [{ type: 'cross_frontier', direction: 'NE' }],
    };
    const result = formatOutcome(outcome, ctx());
    // The roll header contains "→  ✅"; only the location line starts a line with "→".
    expect(result).not.toMatch(/^→/m);
  });

  it('includes items, location, and stats in full summary line', () => {
    const outcome: ActionOutcome = {
      ...successOutcome,
      mutations: [
        { type: 'add_item', emoji: '🦊', name: 'Wolf Pelt', stat: 'physical', modifier: 2 },
        { type: 'set_location', name: 'Deep Forest' },
        { type: 'modify_stamina', amount: -2 },
      ],
    };
    const result = formatOutcome(outcome, ctx({ stamina: 6 }));
    expect(result).toContain('+ 🦊 Wolf Pelt');
    expect(result).toContain('→ Deep Forest');
    expect(result).toContain('⚡ 6/10 (-2)');
    expect(result).toContain('🎲 1 (-1)');
  });
});

// ── Stamina delta display ──

describe('OutcomeRenderer — stamina delta', () => {
  const base: ActionOutcome = {
    distilledType: 'hunt',
    finalDc: 14,
    playerRolled: 16,
    outcome: 'success',
    outcomeText: 'You push through.',
    mutations: [],
  };

  it('shows negative stamina delta', () => {
    const outcome: ActionOutcome = {
      ...base,
      mutations: [{ type: 'modify_stamina', amount: -3 }],
    };
    const result = formatOutcome(outcome, ctx({ stamina: 5 }));
    expect(result).toContain('⚡ 5/10 (-3)');
  });

  it('shows positive stamina delta', () => {
    const outcome: ActionOutcome = {
      ...base,
      mutations: [{ type: 'modify_stamina', amount: 2 }],
    };
    const result = formatOutcome(outcome, ctx({ stamina: 10 }));
    expect(result).toContain('⚡ 10/10 (+2)');
  });

  it('aggregates multiple stamina mutations', () => {
    const outcome: ActionOutcome = {
      ...base,
      mutations: [
        { type: 'modify_stamina', amount: -5 },
        { type: 'modify_stamina', amount: 2 },
      ],
    };
    const result = formatOutcome(outcome, ctx({ stamina: 5 }));
    expect(result).toContain('⚡ 5/10 (-3)');
  });
});

// ── Max stamina delta display ──

describe('OutcomeRenderer — max stamina delta', () => {
  const base: ActionOutcome = {
    distilledType: 'hunt',
    finalDc: 14,
    playerRolled: 16,
    outcome: 'success',
    outcomeText: 'Your vitality expands.',
    mutations: [],
  };

  it('shows a positive max_stamina delta as labelled suffix', () => {
    const outcome: ActionOutcome = {
      ...base,
      mutations: [{ type: 'modify_max_stamina', amount: 1 }],
    };
    const result = formatOutcome(outcome, ctx({ stamina: 8, maxStamina: 11 }));
    expect(result).toContain('⚡ 8/11 (max +1)');
  });

  it('shows a negative max_stamina delta', () => {
    const outcome: ActionOutcome = {
      ...base,
      mutations: [{ type: 'modify_max_stamina', amount: -1 }],
    };
    const result = formatOutcome(outcome, ctx({ stamina: 8, maxStamina: 9 }));
    expect(result).toContain('⚡ 8/9 (max -1)');
  });

  it('both stamina and max stamina deltas stay visually separable', () => {
    const outcome: ActionOutcome = {
      ...base,
      mutations: [
        { type: 'modify_stamina', amount: -2 },
        { type: 'modify_max_stamina', amount: 1 },
      ],
    };
    const result = formatOutcome(outcome, ctx({ stamina: 6, maxStamina: 11 }));
    // The stamina delta (-2) and the labelled max suffix (max +1) must both appear
    // and be distinguishable — the current-stamina delta is unlabelled, the ceiling
    // delta is explicitly labelled "(max …)".
    expect(result).toContain('⚡ 6/11 (-2) (max +1)');
  });

  it('no max change does not emit a spurious (max suffix', () => {
    const outcome: ActionOutcome = {
      ...base,
      mutations: [{ type: 'modify_stamina', amount: -2 }],
    };
    const result = formatOutcome(outcome, ctx({ stamina: 6 }));
    expect(result).toContain('⚡ 6/10 (-2)');
    expect(result).not.toContain('(max');
  });

  it('aggregates multiple max stamina mutations', () => {
    const outcome: ActionOutcome = {
      ...base,
      mutations: [
        { type: 'modify_max_stamina', amount: 2 },
        { type: 'modify_max_stamina', amount: -1 },
      ],
    };
    const result = formatOutcome(outcome, ctx({ stamina: 8, maxStamina: 11 }));
    expect(result).toContain('⚡ 8/11 (max +1)');
  });
});

// ── Failure ──

describe('OutcomeRenderer — failure', () => {
  const failureOutcome: ActionOutcome = {
    distilledType: 'hunt',
    finalDc: 14,
    playerRolled: 3,
    outcome: 'failure',
    outcomeText: 'You lunge but the shale gives way beneath you.',
    mutations: [],
  };

  it('shows roll vs DC with cross', () => {
    const result = formatOutcome(failureOutcome, ctx({ stamina: 7 }));
    expect(result).toContain('🎲');
    expect(result).toContain('3  vs  14');
    expect(result).toContain('❌');
    expect(result).toContain('FAILURE');
  });

  it('lists items lost from remove_item mutations', () => {
    const outcome: ActionOutcome = {
      ...failureOutcome,
      mutations: [{ type: 'remove_item', name: 'Iron Sword' }],
    };
    const result = formatOutcome(outcome, ctx({ stamina: 7 }));
    expect(result).toContain('- Iron Sword');
  });

  it('shows health with delta on failure', () => {
    const outcome: ActionOutcome = {
      ...failureOutcome,
      mutations: [{ type: 'modify_health', amount: -2 }],
    };
    const result = formatOutcome(outcome, ctx({ stamina: 6, health: 8 }));
    expect(result).toContain('❤️ 8/12 (-2)');
  });
});

// ── Skipped ──

describe('OutcomeRenderer — skipped', () => {
  const skipOutcome: ActionOutcome = {
    distilledType: 'hunt',
    finalDc: 12,
    playerRolled: null,
    outcome: 'skipped',
    outcomeText: 'You retreat from the situation.',
    mutations: [],
  };

  it('shows skip symbol and text', () => {
    const result = formatOutcome(skipOutcome, ctx({ stamina: 9 }));
    expect(result).toContain('⏭️');
    expect(result).toContain('SKIPPED');
    expect(result).toContain('You retreat from the situation.');
  });

  it('does not show a roll line for skipped', () => {
    const result = formatOutcome(skipOutcome, ctx({ stamina: 9 }));
    expect(result).not.toContain(' vs ');
  });
});

// ── Timed out ──

describe('OutcomeRenderer — timed out', () => {
  const timeoutOutcome: ActionOutcome = {
    distilledType: 'hunt',
    finalDc: 12,
    playerRolled: null,
    outcome: 'timed_out',
    outcomeText: 'The moment passes. Whatever you were doing, it\'s gone now.',
    mutations: [],
  };

  it('shows timeout symbol and text', () => {
    const result = formatOutcome(timeoutOutcome, ctx());
    expect(result).toContain('⏰');
    expect(result).toContain('TIMED OUT');
    expect(result).toContain('The moment passes.');
  });
});

// ── Natural 1 / 20 ──

describe('OutcomeRenderer — natural 1 / natural 20', () => {
  const nat1Outcome: ActionOutcome = {
    distilledType: 'hunt',
    finalDc: 5,
    playerRolled: 1,
    outcome: 'failure',
    outcomeText: 'You trip over your own feet.',
    mutations: [],
  };

  const nat20Outcome: ActionOutcome = {
    distilledType: 'hunt',
    finalDc: 30,
    playerRolled: 20,
    outcome: 'success',
    outcomeText: 'The gods smile upon you.',
    mutations: [],
  };

  it('marks nat1 as failure regardless of DC', () => {
    const result = formatOutcome(nat1Outcome, ctx());
    expect(result).toContain('💥');
    expect(result).toContain('**1**  vs  5');
    expect(result).toContain('❌');
    expect(result).toContain('FAILURE');
  });

  it('marks nat20 as success regardless of DC', () => {
    const result = formatOutcome(nat20Outcome, ctx());
    expect(result).toContain('🌟');
    expect(result).toContain('**20**  vs  30');
    expect(result).toContain('✅');
    expect(result).toContain('SUCCESS');
  });
});

// ── Wealth ──

describe('OutcomeRenderer — wealth', () => {
  const base: ActionOutcome = {
    distilledType: 'hunt',
    finalDc: 14,
    playerRolled: 16,
    outcome: 'success',
    outcomeText: 'You find a coin purse.',
    mutations: [],
  };

  it('shows wealth with delta when modify_wealth mutation exists', () => {
    const outcome: ActionOutcome = {
      ...base,
      mutations: [{ type: 'modify_wealth', amount: 10 }],
    };
    const result = formatOutcome(outcome, ctx({ wealth: 15 }));
    expect(result).toContain('💰 15 (+10)');
  });

  it('shows negative wealth delta', () => {
    const outcome: ActionOutcome = {
      ...base,
      mutations: [{ type: 'modify_wealth', amount: -3 }],
    };
    const result = formatOutcome(outcome, ctx({ wealth: 2 }));
    expect(result).toContain('💰 2 (-3)');
  });

  it('does not show wealth when no modify_wealth mutation', () => {
    const result = formatOutcome(base, ctx({ wealth: 5 }));
    expect(result).not.toContain('💰');
  });

  it('does not show wealth when modify_wealth amount is zero', () => {
    const outcome: ActionOutcome = {
      ...base,
      mutations: [{ type: 'modify_wealth', amount: 0 }],
    };
    const result = formatOutcome(outcome, ctx({ wealth: 5 }));
    expect(result).not.toContain('💰');
  });
});

// ── Rolls delta ──

describe('OutcomeRenderer — rolls delta', () => {
  const base: ActionOutcome = {
    distilledType: 'explore',
    finalDc: 12,
    playerRolled: 15,
    outcome: 'success',
    outcomeText: 'You search carefully.',
    mutations: [],
  };

  it('combines a negative rolls mutation with the spent roll', () => {
    const outcome: ActionOutcome = {
      ...base,
      mutations: [{ type: 'modify_rolls_remaining', amount: -1 }],
    };
    // mutation -1 plus the one roll spent on this resolved action = -2
    const result = formatOutcome(outcome, ctx({ rollsRemaining: 0 }));
    expect(result).toContain('🎲 0 (-2)');
  });

  it('a positive rolls mutation cancels the spent roll, surfacing an inspired line (feedback #13)', () => {
    const outcome: ActionOutcome = {
      ...base,
      mutations: [{ type: 'modify_rolls_remaining', amount: 1 }],
    };
    // mutation +1 minus the one roll spent = net 0 → no delta on the 🎲 counter,
    // but an explicit inspired line so the grant is never silently swallowed.
    const result = formatOutcome(outcome, ctx({ rollsRemaining: 1 }));
    expect(result).toContain('🎲 1');
    expect(result).not.toContain('🎲 1 (');
    expect(result).toContain('✨ inspired (+1 roll)');
  });

  it('does not show inspired line when the roll grant is already visible in the footer', () => {
    const outcome: ActionOutcome = {
      ...base,
      mutations: [{ type: 'modify_rolls_remaining', amount: 2 }],
    };
    // net: +2 grant − 1 spent = +1 visible in footer; no redundant inspired line needed
    const result = formatOutcome(outcome, ctx({ rollsRemaining: 2 }));
    expect(result).not.toContain('✨ inspired');
    expect(result).toContain('🎲 2 (+1)');
  });

  it('does not show inspired line for a no-op refund', () => {
    const outcome: ActionOutcome = {
      ...base,
      playerRolled: null,
      outcome: 'done',
      rollsDelta: 0,
      rollRefunded: true,
      mutations: [],
    };
    const result = formatOutcome(outcome, ctx({ rollsRemaining: 2 }));
    expect(result).not.toContain('✨ inspired');
    expect(result).toContain('🎲 2 (refunded)');
  });

  it('shows inspired line when engine-reported rollsDelta is zero but mutation granted a roll', () => {
    // The engine may set outcome.rollsDelta to surface the true net (e.g. +1 grant − 1 action cost = 0).
    // The inspired line must still fire because d.rollsDelta > 0 tells us a grant happened.
    const outcome: ActionOutcome = {
      ...base,
      mutations: [{ type: 'modify_rolls_remaining', amount: 1 }],
      rollsDelta: 0,
    };
    const result = formatOutcome(outcome, ctx({ rollsRemaining: 1 }));
    expect(result).toContain('✨ inspired (+1 roll)');
    expect(result).toContain('🎲 1');
    expect(result).not.toContain('🎲 1 (');
  });

  it('surfaces the spent roll with no rolls mutation', () => {
    const result = formatOutcome(base, ctx({ rollsRemaining: 2 }));
    expect(result).toContain('🎲 2 (-1)');
  });

  it('shows no spent-roll delta when no roll was made (playerRolled null)', () => {
    const outcome: ActionOutcome = { ...base, playerRolled: null };
    const result = formatOutcome(outcome, ctx({ rollsRemaining: 3 }));
    expect(result).toContain('🎲 3');
    expect(result).not.toContain('🎲 3 (');
  });

  it('tags a no-op refund so the unchanged roll count is not mistaken for a bug', () => {
    const outcome: ActionOutcome = {
      ...base,
      playerRolled: null,
      outcome: 'done',
      rollsDelta: 0,
      rollRefunded: true,
    };
    const result = formatOutcome(outcome, ctx({ rollsRemaining: 2 }));
    expect(result).toContain('🎲 2 (refunded)');
  });

  it('shows the real delta (not "refunded") when a mutation also moved rolls', () => {
    // rollRefunded set, but a roll mutation made the net non-zero — must not mislabel as a refund.
    const outcome: ActionOutcome = {
      ...base,
      playerRolled: null,
      outcome: 'done',
      rollsDelta: -1,
      rollRefunded: true,
    };
    const result = formatOutcome(outcome, ctx({ rollsRemaining: 2 }));
    expect(result).toContain('🎲 2 (-1)');
    expect(result).not.toContain('refunded');
  });

  it('uses the engine-reported delta over the heuristic for a charged no-op', () => {
    // Auto-finish that was charged (2nd no-op of the day): no roll made, but a roll WAS spent.
    const outcome: ActionOutcome = {
      ...base,
      playerRolled: null,
      outcome: 'done',
      rollsDelta: -1,
    };
    const result = formatOutcome(outcome, ctx({ rollsRemaining: 1 }));
    expect(result).toContain('🎲 1 (-1)');
  });
});

// ── spawn_npc is ignored (narrated by LLM in outcome_text) ──

describe('OutcomeRenderer — spawn_npc ignored', () => {
  const outcome: ActionOutcome = {
    distilledType: 'hunt',
    finalDc: 15,
    playerRolled: 18,
    outcome: 'success',
    outcomeText: 'A stranger emerges from the trees. "Well met," she says.',
    mutations: [
      { type: 'spawn_npc', name: 'Elena', class: 'Hunter', description: 'A scarred ranger' },
    ],
  };

  it('does not mention NPC spawn in summary line', () => {
    const result = formatOutcome(outcome, ctx());
    expect(result).not.toContain('Elena');
    expect(result).toContain('⚡ 8/10');
    expect(result).toContain('🎲 1 (-1)');
  });
});

// ── Multiple mutation types in one outcome ──

describe('OutcomeRenderer — complex outcome', () => {
  it('handles items, health, wealth, and location all together', () => {
    const outcome: ActionOutcome = {
      distilledType: 'hunt',
      finalDc: 14,
      playerRolled: 18,
      outcome: 'success',
      outcomeText: 'You defeat the creature and claim its lair.',
      mutations: [
        { type: 'add_item', emoji: '🦊', name: 'Wolf Pelt', stat: 'physical', modifier: 2 },
        { type: 'remove_item', name: 'Torch' },
        { type: 'set_location', name: 'Wolf Den' },
        { type: 'modify_health', amount: -3 },
        { type: 'modify_stamina', amount: -2 },
        { type: 'modify_wealth', amount: 15 },
        { type: 'modify_rolls_remaining', amount: -1 },
      ],
    };

    const result = formatOutcome(outcome, ctx({
      stamina: 6,
      rollsRemaining: 0,
      health: 7,
      wealth: 20,
    }));

    expect(result).toContain('+ 🦊 Wolf Pelt');
    expect(result).toContain('- Torch');
    expect(result).toContain('→ Wolf Den');
    expect(result).toContain('❤️ 7/12 (-3)');
    expect(result).toContain('⚡ 6/10 (-2)');
    // rolls mutation -1 plus the spent roll = -2
    expect(result).toContain('🎲 0 (-2)');
    expect(result).toContain('💰 20 (+15)');
  });
});

// ── Roll bonus display ──

describe('OutcomeRenderer — roll bonus', () => {
  it('shows the item/stat bonus separately in the roll line', () => {
    const outcome: ActionOutcome = {
      distilledType: 'hunt', finalDc: 11, playerRolled: 8, rollBonus: 7,
      outcome: 'success', outcomeText: 'You manage it.', mutations: [],
    };
    const result = formatOutcome(outcome, ctx());
    expect(result).toContain('🎲 8 + 7 = **15**  vs  11');
    expect(result).toContain('✅');
    expect(result).toContain('SUCCESS');
  });

  it('omits the bonus expression when bonus is zero', () => {
    const outcome: ActionOutcome = {
      distilledType: 'hunt', finalDc: 14, playerRolled: 16, rollBonus: 0,
      outcome: 'success', outcomeText: 'Clean.', mutations: [],
    };
    const result = formatOutcome(outcome, ctx());
    expect(result).toContain('🎲 16  vs  14');
    expect(result).toContain('✅');
    expect(result).toContain('SUCCESS');
    expect(result).not.toContain('16 +');
  });
});

// ── Distilled-action emoji (decision breadcrumb) ──

describe('distilledActionEmoji', () => {
  it('maps known action keywords (incl. variants) to an emoji', () => {
    expect(distilledActionEmoji('combat')).toBe('⚔️');
    expect(distilledActionEmoji('duel')).toBe('⚔️');
    expect(distilledActionEmoji('hunt')).toBe('🏹');
    expect(distilledActionEmoji('investigate')).toBe('🔍');
    expect(distilledActionEmoji('talk')).toBe('🗣️');
    expect(distilledActionEmoji('travel')).toBe('🥾');
  });

  it('is case-insensitive and matches substrings', () => {
    expect(distilledActionEmoji('Negotiate')).toBe('🗣️');
  });

  it('falls back to ✴️ for an unknown type', () => {
    expect(distilledActionEmoji('flibbertigibbet')).toBe('✴️');
    expect(distilledActionEmoji('')).toBe('✴️');
  });
});
