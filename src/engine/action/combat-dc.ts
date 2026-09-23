/** Combat's contested-roll -> severity-band math. Pure math: no machine/repo/DB imports, no I/O. The engine rolls
 *  both dice, so the margin stays deterministic; `dc.ts`'s `resolveRoll` stays binary — bands are a layer on top, not a replacement. */

export type CombatBand = 'clean' | 'glanced' | 'trade' | 'heavy';

export interface CombatRoundOutcome {
  band: CombatBand;
  enemyHpDelta: number;
  playerHpDelta: number;
  playerD20: number;
  enemyD20: number;
  margin: number;
}

/** One combat round's telemetry beat. */
export interface CombatBeatLog {
  /** 1-based in-fight round this beat fought; the floor beat and its last-stand retry can share one. */
  round: number;
  band: CombatBand;
  enemyHpBefore: number;
  enemyHpAfter: number;
  /** ACTUAL applied signed player-HP delta (floored/clamped where a band nominal would overshoot
   *  0 or the floor save's 1 HP), symmetric with `enemyHpAfter - enemyHpBefore`; never the nominal. */
  playerHpDelta: number;
  /** Player's raw d20 this round — lifted from the `CombatRoundOutcome` the round already computed,
   *  never re-rolled or re-derived. */
  playerD20: number;
  /** Player's total ability-check bonus applied to `playerD20` this round. */
  playerBonus: number;
  /** The base this round's `enemyBonus` was derived from (`clamp(dc - 10, 0, ENEMY_BONUS_MAX)`), NOT
   *  a pass/fail threshold — a combat round is a contested roll, not a `resolveRoll` check. */
  dc: number;
  /** Enemy's raw d20 this round — lifted alongside `playerD20`, same source. */
  enemyD20: number;
  /** Enemy's total bonus applied to `enemyD20` this round. */
  enemyBonus: number;
  /** `(playerD20 + playerBonus) - (enemyD20 + enemyBonus)`, the same margin that picked this
   *  round's `band`. */
  margin: number;
  /** Computed semantically (did HP move, or did an op beyond the always-present `set_relation` fire)
   *  rather than as `ops.length > 0`, so the telemetry can answer whether a material-change-only critic trigger collapses into "always". */
  materialMutationFired: boolean;
  /** The mutation op `type` names emitted this beat, in emission order (e.g. ['set_relation', 'modify_health']). */
  ops: string[];
  /** Combat-round beat marker — distinct from a generic CONTINUE beat (which carries no combatBeat). */
  marker: 'combat_round';
  /** Set only on the beat where the once-per-day survive-at-1 floor fired (the desperate-choice beat). */
  floorSave?: boolean;
  /** Set on the beat where the combat empty-decision backstop fired: the fresh continue-decide
   *  returned no real options and the engine injected two deterministic ones. */
  emptyDecisionFallback?: boolean;
  /** Set on the terminal beat after a WIN's fatal-blow interstitial: which way the player resolved
   *  it. The smallest signal the render needs to label the two identical-verdict endings. */
  fatalBlow?: 'finish' | 'spare';
}

/** Enemy `d20` bonus ceiling: `clamp(baseDc - 10, 0, ENEMY_BONUS_MAX)`. */
export const ENEMY_BONUS_MAX = 10;

/** `enemyMaxHp` derivation bounds. */
export const ENEMY_HP_MIN = 6;
export const ENEMY_HP_MAX = 40;

/** Extra magnitude a crit die adds on top of its forced band, before `scale`. */
export const CRIT_AMPLIFY_BONUS = 2;

/** Max rounds fought after the initiating decision. At the cap the winner derives from the HP
 *  fraction instead of another roll; non-combat actions keep `MAX_DECISIONS_PER_ACTION = 2`. */
export const MAX_COMBAT_ROUNDS = 4;

interface CombatBandDef {
  band: CombatBand;
  minMargin: number;
  enemyHpDelta: number;
  playerHpDelta: number;
}

/** Starting magnitudes, one constant so they retune without touching resolution logic. Ordered
 *  highest-margin-first with an `-Infinity` catch-all; `find` picks the first band the margin clears. */
export const COMBAT_BAND_TABLE: readonly CombatBandDef[] = [
  { band: 'clean', minMargin: 8, enemyHpDelta: -6, playerHpDelta: 0 },
  { band: 'glanced', minMargin: 2, enemyHpDelta: -3, playerHpDelta: 0 },
  { band: 'trade', minMargin: -2, enemyHpDelta: -2, playerHpDelta: -2 },
  { band: 'heavy', minMargin: -Infinity, enemyHpDelta: -1, playerHpDelta: -3 },
];

function bandForMargin(margin: number): CombatBandDef {
  return COMBAT_BAND_TABLE.find(def => margin >= def.minMargin) as CombatBandDef;
}

function bandDef(band: CombatBand): CombatBandDef {
  return COMBAT_BAND_TABLE.find(def => def.band === band) as CombatBandDef;
}

/** A crit overrides the band without shifting the margin's thresholds: a player's natural 20 amplifies the enemy delta, a natural 1
 *  the player's own; an enemy crit amplifies nothing, and on a double crit the player's die wins. `scale` multiplies the final deltas only. */
export function resolveCombatRound(
  playerD20: number,
  playerBonus: number,
  enemyD20: number,
  enemyBonus: number,
  scale = 1,
): CombatRoundOutcome {
  const playerTotal = playerD20 + playerBonus;
  const enemyTotal = enemyD20 + enemyBonus;
  const margin = playerTotal - enemyTotal;

  let band: CombatBand;
  let enemyHpDelta: number;
  let playerHpDelta: number;

  if (playerD20 === 20) {
    const clean = bandDef('clean');
    band = clean.band;
    enemyHpDelta = clean.enemyHpDelta - CRIT_AMPLIFY_BONUS;
    playerHpDelta = clean.playerHpDelta;
  } else if (playerD20 === 1) {
    const heavy = bandDef('heavy');
    band = heavy.band;
    enemyHpDelta = heavy.enemyHpDelta;
    playerHpDelta = heavy.playerHpDelta - CRIT_AMPLIFY_BONUS;
  } else if (enemyD20 === 20) {
    const heavy = bandDef('heavy');
    band = heavy.band;
    enemyHpDelta = heavy.enemyHpDelta;
    playerHpDelta = heavy.playerHpDelta;
  } else if (enemyD20 === 1) {
    const clean = bandDef('clean');
    band = clean.band;
    enemyHpDelta = clean.enemyHpDelta;
    playerHpDelta = clean.playerHpDelta;
  } else {
    const def = bandForMargin(margin);
    band = def.band;
    enemyHpDelta = def.enemyHpDelta;
    playerHpDelta = def.playerHpDelta;

    // Bounded exception to the flat trade band, whose -2/-2 read as "I rolled higher yet we both
    // lost 2 HP": the margin's sign decides who takes the lighter hit, and no crit path routes here.
    if (band === 'trade') {
      if (margin > 0) {
        playerHpDelta = -1; // player edged the contest — takes the lighter hit
      } else if (margin < 0) {
        enemyHpDelta = -1; // enemy edged the contest — takes the lighter hit
      }
      // margin === 0: dead tie, symmetric -2/-2 stands.
    }
  }

  return {
    band,
    enemyHpDelta: enemyHpDelta * scale,
    playerHpDelta: playerHpDelta * scale,
    playerD20,
    enemyD20,
    margin,
  };
}

/** `enemyMaxHp` from the encounter's `baseDc`; `scale` is the seam a world tier multiplies through. */
export function deriveEnemyMaxHp(baseDc: number, scale = 1): number {
  const raw = Math.round(baseDc * scale);
  return Math.max(ENEMY_HP_MIN, Math.min(ENEMY_HP_MAX, raw));
}

export type DangerTier = 'easy' | 'medium' | 'hard' | 'risky' | 'fatal';

/** Worded encounter-danger tier for display only — a first-cut, tunable ladder anchored so the
 *  baseline goblin (baseDc 12) reads "medium"; never a per-beat pass/fail threshold. */
export function dangerTier(dc: number): DangerTier {
  if (dc <= 9) return 'easy';
  if (dc <= 13) return 'medium';
  if (dc <= 17) return 'hard';
  if (dc <= 21) return 'risky';
  return 'fatal';
}
