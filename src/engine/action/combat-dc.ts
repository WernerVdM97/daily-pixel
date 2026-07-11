/**
 * Combat's contested-roll -> severity-band math (Stage 3 Thread C, T1).
 *
 * Pure math only: no machine/repo/DB imports, no relations, no I/O. The
 * engine rolls both dice (decision 6, stage-3-combat-spine-plan.md) so the
 * signed margin stays fully deterministic for the sim's seeded roll source.
 * `resolveRoll` in `dc.ts` stays untouched and binary — combat bands are a
 * separate layer on top, not a replacement.
 */

export type CombatBand = 'clean' | 'glanced' | 'trade' | 'heavy';

export interface CombatRoundOutcome {
  band: CombatBand;
  enemyHpDelta: number;
  playerHpDelta: number;
  playerD20: number;
  enemyD20: number;
  margin: number;
}

/**
 * One combat round's telemetry beat — the data that later settles the parked prose-critic
 * trigger (prompt-v12-pipeline §D7): the trigger question is whether a "material-change-only"
 * heuristic collapses into "always" in combat. `materialMutationFired` is computed semantically
 * (did enemyHp/player-HP actually move, or loot drop) — NOT `ops.length > 0` — so the telemetry
 * can genuinely answer that, rather than being trivially true.
 */
export interface CombatBeatLog {
  /** 1-based in-fight round this beat fought (the floor beat + its last-stand retry can share a round number — see the machine note). */
  round: number;
  band: CombatBand;
  enemyHpBefore: number;
  enemyHpAfter: number;
  /** ACTUAL applied signed player-HP delta this round (floored/clamped to real HP where a
   *  nominal band delta would overshoot 0 or the floor-save's 1 HP) — symmetric with the
   *  enemy's `enemyHpAfter - enemyHpBefore`. NOT the raw band nominal from `CombatRoundOutcome`;
   *  those diverge on lethal blows and the desperate-choice floor. */
  playerHpDelta: number;
  /** Player's raw d20 this round (ANSI-D) — lifted from the transient `CombatRoundOutcome`
   *  the round already computed, never re-rolled or re-derived. */
  playerD20: number;
  /** Player's total ability-check bonus applied to `playerD20` this round. */
  playerBonus: number;
  /** The base DC this round's `enemyBonus` was derived from (`clamp(dc - 10, 0, ENEMY_BONUS_MAX)`)
   *  — NOT a pass/fail threshold; a combat round is a contested roll (`resolveCombatRound`),
   *  not a `resolveRoll` check against a DC. Carried for the maths-visibility card only. */
  dc: number;
  /** Enemy's raw d20 this round — lifted alongside `playerD20`, same source. */
  enemyD20: number;
  /** Enemy's total bonus applied to `enemyD20` this round. */
  enemyBonus: number;
  /** `(playerD20 + playerBonus) - (enemyD20 + enemyBonus)` — lifted from `CombatRoundOutcome`,
   *  the same margin that picked this round's `band`. */
  margin: number;
  /** Did a state-changing (narratable) mutation fire this beat? enemyHp always moves in combat, so this is expected ~always true — that IS the §D7 signal. */
  materialMutationFired: boolean;
  /** The mutation op `type` names emitted this beat, in emission order (e.g. ['set_relation', 'modify_health']). */
  ops: string[];
  /** Combat-round beat marker — distinct from a generic CONTINUE beat (which carries no combatBeat). */
  marker: 'combat_round';
  /** Set only on the beat where the once-per-day survive-at-1 floor fired (the desperate-choice beat). */
  floorSave?: boolean;
  /** Set only on the beat where the combat empty-decision backstop fired (decide-scene-narration
   *  spec): the fresh continue-decide returned zero real options and the engine injected the two
   *  deterministic fallback options, so a flee-only screen never reaches the player. Telemetry. */
  emptyDecisionFallback?: boolean;
}

/** Enemy `d20` bonus ceiling: `clamp(baseDc - 10, 0, ENEMY_BONUS_MAX)`. */
export const ENEMY_BONUS_MAX = 10;

/** `enemyMaxHp` derivation bounds (no world tier yet — decision 7's `scale` seam). */
export const ENEMY_HP_MIN = 6;
export const ENEMY_HP_MAX = 40;

/** Extra magnitude a crit die adds on top of its forced band, before `scale`. */
export const CRIT_AMPLIFY_BONUS = 2;

/** Combat sub-mode cap: max rounds fought after the initiating decision (decision 6).
 *  A fight at the cap derives its winner from the HP fraction instead of another roll.
 *  Non-combat actions keep `MAX_DECISIONS_PER_ACTION = 2`. */
export const MAX_COMBAT_ROUNDS = 4;

interface CombatBandDef {
  band: CombatBand;
  /** Inclusive lower bound on margin; `-Infinity` for the catch-all band. */
  minMargin: number;
  enemyHpDelta: number;
  playerHpDelta: number;
}

/**
 * Band table — starting values, sim-tuned later (T5). Kept as one constant
 * so magnitudes are trivially retunable without touching the resolution
 * logic. Ordered highest-margin-first; `resolveCombatRound` picks the first
 * band whose `minMargin` the actual margin clears.
 */
export const COMBAT_BAND_TABLE: readonly CombatBandDef[] = [
  { band: 'clean', minMargin: 8, enemyHpDelta: -6, playerHpDelta: 0 },
  { band: 'glanced', minMargin: 2, enemyHpDelta: -3, playerHpDelta: 0 },
  { band: 'trade', minMargin: -2, enemyHpDelta: -2, playerHpDelta: -2 },
  { band: 'heavy', minMargin: -Infinity, enemyHpDelta: -1, playerHpDelta: -3 },
];

function bandForMargin(margin: number): CombatBandDef {
  // COMBAT_BAND_TABLE is ordered highest-threshold-first with a -Infinity
  // catch-all, so `find` always resolves.
  return COMBAT_BAND_TABLE.find(def => margin >= def.minMargin) as CombatBandDef;
}

function bandDef(band: CombatBand): CombatBandDef {
  return COMBAT_BAND_TABLE.find(def => def.band === band) as CombatBandDef;
}

/**
 * Contested combat roll -> severity band -> signed HP deltas.
 *
 * `margin = (playerD20 + playerBonus) - (enemyD20 + enemyBonus)` maps to a
 * band via `COMBAT_BAND_TABLE`. Crits override the band outright (they do
 * not shift the margin's own thresholds):
 *  - player nat-20 forces `clean` and amplifies `enemyHpDelta` by another
 *    `-CRIT_AMPLIFY_BONUS`.
 *  - player nat-1 forces `heavy` and amplifies `playerHpDelta` by another
 *    `-CRIT_AMPLIFY_BONUS`.
 *  - enemy nat-20 forces `heavy` (no extra amplification — the player's own
 *    nat-1 already covers the "extra bad" case).
 *  - enemy nat-1 forces `clean` (symmetric, no extra amplification).
 *
 * Precedence when both dice crit and disagree (e.g. player nat-20 AND enemy
 * nat-20): the player's own die always wins the band, so player crits are
 * checked before enemy crits below. This also means a player nat-1 beats an
 * opposing enemy nat-1 for the same reason (heavy, amplified, not clean).
 *
 * `scale` (default 1) multiplies the final deltas only — including crit
 * amplification — and never changes which band is chosen (decision 7).
 */
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

    // POC+ 0.3.2 C2 — signed-off, bounded exception to the "no combat re-tune" fence
    // (scope-lock section of the 0.3.2 plan): the `trade` band's flat -2/-2 read as
    // "I rolled higher yet we both lost 2 HP" (grievance, not a display bug), so the margin's
    // own sign now decides who takes the lighter hit. Contained to this margin-decided branch
    // and the `trade` band only — no crit path routes here (they all force `clean`/`heavy`
    // above), and `clean`/`glanced`/`heavy` deltas are untouched.
    if (band === 'trade') {
      if (margin > 0) {
        playerHpDelta = -1; // player edged the contest — takes the lighter hit
      } else if (margin < 0) {
        enemyHpDelta = -1; // enemy edged the contest — takes the lighter hit
      }
      // margin === 0: dead tie, symmetric -2/-2 stands (keeps combatCapScenario green).
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

/**
 * `enemyMaxHp` derivation from the encounter's existing `baseDc` (no world
 * tier — decision 7). `scale` is the seam Thread B later multiplies through;
 * starting rule: `clamp(Math.round(baseDc * scale), ENEMY_HP_MIN, ENEMY_HP_MAX)`.
 */
export function deriveEnemyMaxHp(baseDc: number, scale = 1): number {
  const raw = Math.round(baseDc * scale);
  return Math.max(ENEMY_HP_MIN, Math.min(ENEMY_HP_MAX, raw));
}

export type DangerTier = 'easy' | 'medium' | 'hard' | 'risky' | 'fatal';

/**
 * Map a combat DC to a worded encounter-danger tier (POC+ 0.3.2 C1; pulls in
 * the TODO.md "map DC to easy/medium/hard/fatal" item). This is a first-cut,
 * tunable ladder — thresholds anchored so the sim's baseline goblin (baseDc
 * 12) reads "medium". This labels the foe's overall danger for display only;
 * it must never be read as a per-beat pass/fail threshold (that's the margin's
 * job, not the DC's — see `resolveCombatRound`'s doc comment).
 */
export function dangerTier(dc: number): DangerTier {
  if (dc <= 9) return 'easy';
  if (dc <= 13) return 'medium';
  if (dc <= 17) return 'hard';
  if (dc <= 21) return 'risky';
  return 'fatal';
}
