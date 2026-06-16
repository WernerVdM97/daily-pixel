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

  it('shows stamina and rolls in footer (always, no delta when unchanged)', () => {
    const result = formatOutcome(successOutcome, ctx());
    expect(result).toContain('⚡ 8/10');
    expect(result).toContain('🎲 1/2');
    // No delta suffix when mutations don't touch them
    expect(result).not.toContain('⚡ 8/10 (');
    expect(result).not.toContain('🎲 1/2 (');
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
    expect(result).toContain('🎲 1/2');
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

  it('shows negative rolls delta', () => {
    const outcome: ActionOutcome = {
      ...base,
      mutations: [{ type: 'modify_rolls_remaining', amount: -1 }],
    };
    const result = formatOutcome(outcome, ctx({ rollsRemaining: 0 }));
    expect(result).toContain('🎲 0/2 (-1)');
  });

  it('shows positive rolls delta', () => {
    const outcome: ActionOutcome = {
      ...base,
      mutations: [{ type: 'modify_rolls_remaining', amount: 1 }],
    };
    const result = formatOutcome(outcome, ctx({ rollsRemaining: 1 }));
    expect(result).toContain('🎲 1/2 (+1)');
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
    expect(result).toContain('🎲 1/2');
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
    expect(result).toContain('🎲 0/2 (-1)');
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
