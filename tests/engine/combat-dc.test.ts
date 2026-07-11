import { describe, it, expect } from 'vitest';
import {
  resolveCombatRound,
  deriveEnemyMaxHp,
  dangerTier,
  COMBAT_BAND_TABLE,
  ENEMY_BONUS_MAX,
  ENEMY_HP_MIN,
  ENEMY_HP_MAX,
  CRIT_AMPLIFY_BONUS,
} from '../../src/engine/action/combat-dc.js';

describe('Combat band constants', () => {
  it('exposes the tunable constants T1 specifies', () => {
    expect(ENEMY_BONUS_MAX).toBe(10);
    expect(ENEMY_HP_MIN).toBe(6);
    expect(ENEMY_HP_MAX).toBe(40);
    expect(CRIT_AMPLIFY_BONUS).toBe(2);
    expect(COMBAT_BAND_TABLE.map(b => b.band)).toEqual(['clean', 'glanced', 'trade', 'heavy']);
  });
});

describe('resolveCombatRound — band selection by margin', () => {
  it('clean: margin >= +8', () => {
    // player 15+5=20, enemy 5+7=12, margin=8 (boundary)
    const outcome = resolveCombatRound(15, 5, 5, 7);
    expect(outcome.margin).toBe(8);
    expect(outcome.band).toBe('clean');
    expect(outcome.enemyHpDelta).toBe(-6);
    expect(outcome.playerHpDelta).toBe(0);
  });

  it('clean: comfortably above +8', () => {
    const outcome = resolveCombatRound(18, 5, 3, 0);
    expect(outcome.margin).toBe(20);
    expect(outcome.band).toBe('clean');
  });

  it('glanced: margin at +2 boundary lands in glanced, not clean', () => {
    // player total 12, enemy total 10, margin=2
    const outcome = resolveCombatRound(12, 0, 10, 0);
    expect(outcome.margin).toBe(2);
    expect(outcome.band).toBe('glanced');
    expect(outcome.enemyHpDelta).toBe(-3);
    expect(outcome.playerHpDelta).toBe(0);
  });

  it('glanced: just below the clean boundary (+7)', () => {
    const outcome = resolveCombatRound(17, 0, 10, 0);
    expect(outcome.margin).toBe(7);
    expect(outcome.band).toBe('glanced');
  });

  it('trade: margin at -2 boundary lands in trade, not heavy (enemy edged it — asymmetric, POC+ 0.3.2 C2)', () => {
    const outcome = resolveCombatRound(8, 0, 10, 0);
    expect(outcome.margin).toBe(-2);
    expect(outcome.band).toBe('trade');
    expect(outcome.enemyHpDelta).toBe(-1);
    expect(outcome.playerHpDelta).toBe(-2);
  });

  it('trade: margin at 0 (dead even) stays symmetric -2/-2 (POC+ 0.3.2 C2)', () => {
    const outcome = resolveCombatRound(10, 0, 10, 0);
    expect(outcome.margin).toBe(0);
    expect(outcome.band).toBe('trade');
    expect(outcome.enemyHpDelta).toBe(-2);
    expect(outcome.playerHpDelta).toBe(-2);
  });

  it('trade: just below the glanced boundary (+1, player edged it — asymmetric, POC+ 0.3.2 C2)', () => {
    const outcome = resolveCombatRound(11, 0, 10, 0);
    expect(outcome.margin).toBe(1);
    expect(outcome.band).toBe('trade');
    expect(outcome.enemyHpDelta).toBe(-2);
    expect(outcome.playerHpDelta).toBe(-1);
  });

  it('heavy: margin below -2', () => {
    const outcome = resolveCombatRound(5, 0, 15, 0);
    expect(outcome.margin).toBe(-10);
    expect(outcome.band).toBe('heavy');
    expect(outcome.enemyHpDelta).toBe(-1);
    expect(outcome.playerHpDelta).toBe(-3);
  });

  it('heavy: just below the trade boundary (-3)', () => {
    const outcome = resolveCombatRound(7, 0, 10, 0);
    expect(outcome.margin).toBe(-3);
    expect(outcome.band).toBe('heavy');
  });
});

describe('resolveCombatRound — trade band asymmetric HP deltas (POC+ 0.3.2 C2)', () => {
  it('margin > 0 (player edged it): player takes the lighter hit, enemy unchanged', () => {
    // player 13+2=15, enemy 12+2=14, margin=+1 -> trade, edge-win
    const outcome = resolveCombatRound(13, 2, 12, 2);
    expect(outcome.margin).toBe(1);
    expect(outcome.band).toBe('trade');
    expect(outcome.playerHpDelta).toBe(-1);
    expect(outcome.enemyHpDelta).toBe(-2);
  });

  it('margin < 0 (enemy edged it): enemy takes the lighter hit, player unchanged', () => {
    // player 12+2=14, enemy 13+2=15, margin=-1 -> trade, edge-loss
    const outcome = resolveCombatRound(12, 2, 13, 2);
    expect(outcome.margin).toBe(-1);
    expect(outcome.band).toBe('trade');
    expect(outcome.playerHpDelta).toBe(-2);
    expect(outcome.enemyHpDelta).toBe(-1);
  });

  it('margin === 0 (dead tie): symmetric -2/-2, untouched', () => {
    const outcome = resolveCombatRound(10, 5, 10, 5);
    expect(outcome.margin).toBe(0);
    expect(outcome.band).toBe('trade');
    expect(outcome.playerHpDelta).toBe(-2);
    expect(outcome.enemyHpDelta).toBe(-2);
  });

  it('scale multiplies the asymmetric override too, without moving the band', () => {
    const outcome = resolveCombatRound(13, 2, 12, 2, 2);
    expect(outcome.margin).toBe(1);
    expect(outcome.band).toBe('trade');
    expect(outcome.playerHpDelta).toBe(-2); // -1 * 2
    expect(outcome.enemyHpDelta).toBe(-4); // -2 * 2
  });

  it('does not touch clean/glanced/heavy deltas — only the trade band is asymmetric', () => {
    const clean = resolveCombatRound(18, 5, 3, 0);
    expect(clean.band).toBe('clean');
    expect(clean.enemyHpDelta).toBe(-6);
    expect(clean.playerHpDelta).toBe(0);

    const glanced = resolveCombatRound(12, 0, 10, 0);
    expect(glanced.band).toBe('glanced');
    expect(glanced.enemyHpDelta).toBe(-3);
    expect(glanced.playerHpDelta).toBe(0);

    const heavy = resolveCombatRound(5, 0, 15, 0);
    expect(heavy.band).toBe('heavy');
    expect(heavy.enemyHpDelta).toBe(-1);
    expect(heavy.playerHpDelta).toBe(-3);
  });
});

describe('resolveCombatRound — crits', () => {
  it('player nat-20 forces clean and amplifies enemy damage', () => {
    // Without the crit this would be a heavy loss (margin very negative).
    const outcome = resolveCombatRound(20, 0, 15, 10);
    expect(outcome.band).toBe('clean');
    expect(outcome.enemyHpDelta).toBe(-6 - CRIT_AMPLIFY_BONUS);
    expect(outcome.enemyHpDelta).toBe(-8);
    expect(outcome.playerHpDelta).toBe(0);
  });

  it('player nat-1 forces heavy and amplifies player damage', () => {
    // Without the crit this would be a clean win (margin very positive).
    const outcome = resolveCombatRound(1, 10, 2, 0);
    expect(outcome.band).toBe('heavy');
    expect(outcome.playerHpDelta).toBe(-3 - CRIT_AMPLIFY_BONUS);
    expect(outcome.playerHpDelta).toBe(-5);
    expect(outcome.enemyHpDelta).toBe(-1);
  });

  it('enemy nat-20 forces heavy with no extra amplification', () => {
    // Without the crit this would be a clean win for the player.
    const outcome = resolveCombatRound(18, 5, 20, 0);
    expect(outcome.band).toBe('heavy');
    expect(outcome.enemyHpDelta).toBe(-1);
    expect(outcome.playerHpDelta).toBe(-3);
  });

  it('enemy nat-1 forces clean with no extra amplification', () => {
    // Without the crit this would be a heavy loss for the player.
    const outcome = resolveCombatRound(2, 0, 1, 10);
    expect(outcome.band).toBe('clean');
    expect(outcome.enemyHpDelta).toBe(-6);
    expect(outcome.playerHpDelta).toBe(0);
  });

  it('both crit, aligned (player nat-1 + enemy nat-20): heavy, player amplified', () => {
    const outcome = resolveCombatRound(1, 0, 20, 0);
    expect(outcome.band).toBe('heavy');
    expect(outcome.playerHpDelta).toBe(-5);
    expect(outcome.enemyHpDelta).toBe(-1);
  });

  it('both crit, aligned (player nat-20 + enemy nat-1): clean, enemy amplified', () => {
    const outcome = resolveCombatRound(20, 0, 1, 0);
    expect(outcome.band).toBe('clean');
    expect(outcome.enemyHpDelta).toBe(-8);
    expect(outcome.playerHpDelta).toBe(0);
  });

  it('both crit, conflicting (player nat-20 + enemy nat-20): player wins -> clean, amplified', () => {
    const outcome = resolveCombatRound(20, 0, 20, 0);
    expect(outcome.band).toBe('clean');
    expect(outcome.enemyHpDelta).toBe(-8);
    expect(outcome.playerHpDelta).toBe(0);
  });

  it('both crit, conflicting (player nat-1 + enemy nat-1): player wins -> heavy, amplified', () => {
    const outcome = resolveCombatRound(1, 0, 1, 0);
    expect(outcome.band).toBe('heavy');
    expect(outcome.playerHpDelta).toBe(-5);
    expect(outcome.enemyHpDelta).toBe(-1);
  });
});

describe('resolveCombatRound — scale seam', () => {
  it('scale=2 doubles all deltas but leaves the chosen band unchanged', () => {
    const base = resolveCombatRound(12, 0, 10, 0);
    const scaled = resolveCombatRound(12, 0, 10, 0, 2);
    expect(scaled.band).toBe(base.band);
    expect(scaled.margin).toBe(base.margin);
    expect(scaled.enemyHpDelta).toBe(base.enemyHpDelta * 2);
    expect(scaled.playerHpDelta).toBe(base.playerHpDelta * 2);
  });

  it('scale doubles amplified crit deltas too', () => {
    const base = resolveCombatRound(20, 0, 15, 10);
    const scaled = resolveCombatRound(20, 0, 15, 10, 2);
    expect(scaled.band).toBe('clean');
    expect(scaled.enemyHpDelta).toBe(base.enemyHpDelta * 2);
    expect(scaled.enemyHpDelta).toBe(-16);
  });

  it('scale does not move thresholds — a boundary margin still bands the same way at scale=2', () => {
    const outcome = resolveCombatRound(12, 0, 10, 0, 2);
    expect(outcome.margin).toBe(2);
    expect(outcome.band).toBe('glanced');
  });

  it('defaults to scale=1 when omitted', () => {
    const outcome = resolveCombatRound(15, 5, 5, 7);
    expect(outcome.enemyHpDelta).toBe(-6);
  });
});

describe('deriveEnemyMaxHp', () => {
  it('clamps to ENEMY_HP_MIN at scale=1 for a low baseDc', () => {
    expect(deriveEnemyMaxHp(1, 1)).toBe(ENEMY_HP_MIN);
    expect(deriveEnemyMaxHp(0, 1)).toBe(ENEMY_HP_MIN);
  });

  it('clamps to ENEMY_HP_MAX at scale=1 for a high baseDc', () => {
    expect(deriveEnemyMaxHp(50, 1)).toBe(ENEMY_HP_MAX);
  });

  it('passes through unclamped values in range at scale=1', () => {
    expect(deriveEnemyMaxHp(12, 1)).toBe(12);
    expect(deriveEnemyMaxHp(10)).toBe(10); // default scale=1
  });

  it('scales in between, still clamped', () => {
    expect(deriveEnemyMaxHp(20, 2)).toBe(ENEMY_HP_MAX); // 40, at the ceiling
    expect(deriveEnemyMaxHp(5, 2)).toBe(10);
    expect(deriveEnemyMaxHp(3, 0.5)).toBe(ENEMY_HP_MIN); // rounds to 2, floored to 6
  });

  it('rounds fractional results', () => {
    expect(deriveEnemyMaxHp(11, 1.05)).toBe(12); // 11.55 -> 12
  });
});

describe('dangerTier — DC to worded encounter-danger tier (POC+ 0.3.2 C1)', () => {
  it('9 -> easy (top of the easy band)', () => {
    expect(dangerTier(9)).toBe('easy');
  });

  it('10 -> medium (bottom of the medium band)', () => {
    expect(dangerTier(10)).toBe('medium');
  });

  it('13 -> medium (top of the medium band, anchors the sim baseline goblin baseDc 12)', () => {
    expect(dangerTier(13)).toBe('medium');
    expect(dangerTier(12)).toBe('medium');
  });

  it('14 -> hard (bottom of the hard band)', () => {
    expect(dangerTier(14)).toBe('hard');
  });

  it('17 -> hard (top of the hard band)', () => {
    expect(dangerTier(17)).toBe('hard');
  });

  it('18 -> risky (bottom of the risky band)', () => {
    expect(dangerTier(18)).toBe('risky');
  });

  it('21 -> risky (top of the risky band)', () => {
    expect(dangerTier(21)).toBe('risky');
  });

  it('22 -> fatal (bottom of the fatal band, and beyond)', () => {
    expect(dangerTier(22)).toBe('fatal');
    expect(dangerTier(100)).toBe('fatal');
  });

  it('very low DC still resolves to easy', () => {
    expect(dangerTier(0)).toBe('easy');
    expect(dangerTier(1)).toBe('easy');
  });
});

describe('purity', () => {
  it('imports nothing from the machine, repos, or DB', async () => {
    const fs = await import('node:fs/promises');
    const source = await fs.readFile(
      new URL('../../src/engine/action/combat-dc.ts', import.meta.url),
      'utf-8',
    );
    const importLines = source.split('\n').filter(line => /^\s*import\s/.test(line));
    expect(importLines).toEqual([]);
  });
});
