/**
 * View-state builders for the /action decision + outcome screens: `discord.js`-free by
 * construction, so all Discord assembly stays in `src/discord/`.
 */

import type { WorldEngine, ActionOutcome, ActionKind, CharacterData, CombatStatusData, ClassifiedActionType } from '../engine/WorldEngine.js';
import type { CombatBeatLog } from '../engine/action/combat-dc.js';
import { dangerTier } from '../engine/action/combat-dc.js';
import { formatOutcome, distilledActionEmoji, type OutcomeRenderContext } from '../engine/OutcomeRenderer.js';
import { STAT_LABELS } from '../engine/stat-format.js';
import { dayJobEmoji } from '../render/format.js';
import { BORDERS, PALETTES, type BorderStyle } from '../render/AnsiRenderer.js';
import { renderOpeningFrame, type OpeningFrameSlots } from '../render/OpeningFrameRenderer.js';
import { renderCombatContinueCard, renderCombatTerminalCard, type ContinueCardInput, type CombatTerminalCard } from '../render/CombatCardRenderer.js';
import { enemyConditionBand } from '../engine/action/PipelineActionStateMachine.js';
import type { DecisionViewState, OutcomeViewState, ViewColorIntent } from './viewState.js';

// ── Custom IDs ──

const CID_PREFIX = 'action:choice:';
export const CID_BAIL = 'action:bail';

function choiceCid(decisionIdx: number, optionIdx: number): string {
  return `${CID_PREFIX}${decisionIdx}:${optionIdx}`;
}

export function parseActionCid(customId: string): { decisionIdx: number; optionIdx: number } | null {
  if (!customId.startsWith(CID_PREFIX)) return null;
  const rest = customId.slice(CID_PREFIX.length);
  const colonIdx = rest.indexOf(':');
  if (colonIdx === -1) return null;
  return {
    decisionIdx: parseInt(rest.slice(0, colonIdx), 10),
    optionIdx: parseInt(rest.slice(colonIdx + 1), 10),
  };
}

// ── Helpers ──

/** How much easier the safest option must be than the next-best before passive
 *  insight flags it — keeps the green hint a rare, earned tell. */
const INSIGHT_MARGIN = 2;

/** Quote every line of `text` as a Discord blockquote (blank lines keep the bar). */
function quoteLines(text: string): string {
  return text
    .split('\n')
    .map(line => (line.length > 0 ? `> ${line}` : '>'))
    .join('\n');
}

/** Qualitative, never a raw number: down is easier, up is harder, zero shows nothing. */
function dcArrow(mod: number | null | undefined): string {
  if (mod == null || mod === 0) return '';
  return mod < 0 ? '⬇️' : '⬆️';
}

/** Stat emoji for an option's `stat`, degrading gracefully (no icon) when the
 *  stat is missing or unrecognised — never a crash, never a placeholder glyph. */
function statEmoji(stat: string | undefined): string {
  if (!stat) return '';
  const info = STAT_LABELS[stat];
  return info ? info.emoji : '';
}

/** Renders the "story so far" gamebook thread. The first beat authors no narration, so it
 *  renders choice-only; `collapse` drops narration to a breadcrumb — the overflow degrade form. */
function buildStoryThread(
  rawInput: string,
  decisions: Array<{ prompt: string; chosen: string; dcModifier?: number; narration?: string }>,
  collapse = false,
  kind: ActionKind = 'quest',
  workEmoji = '🛠️',
): string {
  // Preset daily-work reads as "Work:" (profession emoji); freeform as "Quest:".
  const header = kind === 'work' ? `${workEmoji} **Work:**` : '🧭 **Quest:**';
  const out = [`> ${header} ${rawInput}`];
  for (const d of decisions) {
    const arrow = dcArrow(d.dcModifier);
    const choice = `${d.chosen}${arrow ? ` ${arrow}` : ''}`;
    if (collapse) {
      out.push(`> ↳ *${choice}*`);
    } else {
      out.push('');
      if (d.narration) out.push(quoteLines(d.narration));
      out.push(`↪ **${choice}**`);
    }
  }
  return out.join('\n');
}

/** Border escalation for the continue card — heavy when the last round's band was HEAVY or the
 *  player is bloodied (≤25% HP), standard otherwise. */
function chooseContinueBorder(status: CombatStatusData, lastRound?: CombatBeatLog): BorderStyle {
  const playerFrac = status.playerMaxHp > 0 ? status.playerHp / status.playerMaxHp : 0;
  if (lastRound?.band === 'heavy' || playerFrac <= 0.25) return BORDERS.heavy;
  return BORDERS.standard;
}

/** Frame for a combat continue-screen, border chosen by escalation rules. */
function renderCombatStatusFrame(status: CombatStatusData, lastRound?: CombatBeatLog): string {
  const input: ContinueCardInput = {
    enemyName: status.enemyName,
    woundWord: status.woundWord,
    pips: status.pips,
    playerHp: status.playerHp,
    playerMaxHp: status.playerMaxHp,
    playerHpDelta: status.playerHpDelta,
    lastRound: lastRound
      ? {
          d20: lastRound.playerD20,
          bonus: lastRound.playerBonus,
          dc: lastRound.dc,
          enemyD20: lastRound.enemyD20,
          enemyBonus: lastRound.enemyBonus,
          margin: lastRound.margin,
          band: lastRound.band,
          playerHpDelta: lastRound.playerHpDelta,
          enemyHpDelta: lastRound.enemyHpAfter - lastRound.enemyHpBefore,
        }
      : undefined,
    // CombatStatusData carries no DC (only the round log does), so the tag simply doesn't
    // show on the pre-first-round beat — fine, there's no encounter danger to report yet.
    dangerTier: lastRound ? dangerTier(lastRound.dc) : undefined,
  };
  return renderCombatContinueCard(input, PALETTES.house, chooseContinueBorder(status, lastRound));
}

/** Tolerant read: an action saved before `combatRounds` still carries an engine-composed string
 *  in `combatStatus`, so render either shape and ignore `lastRound` on that branch. */
function renderCombatStatus(combatStatus: CombatStatusData | string, lastRound?: CombatBeatLog): string {
  return typeof combatStatus === 'string' ? combatStatus : renderCombatStatusFrame(combatStatus, lastRound);
}

/** Assembles the decision screen's semantic view-state. The medium step (`decisionViewToDiscord`)
 *  owns the block join and the embed-length degrade ladder. */
export function buildDecisionView(
  decision: {
    prompt: string;
    narration?: string;
    combatStatus?: CombatStatusData | string;
    /** This beat's accumulated round log; the continue frame splices the last round's dice maths from it. */
    combatRounds?: CombatBeatLog[];
    options: Array<{ label: string; dcModifier: number | null; stat?: string }>;
  },
  decisionIdx: number,
  state?: { rawInput: string; decisions: Array<{ prompt: string; chosen: string; dcModifier: number; narration?: string }>; accumulatedDc?: number; kind?: ActionKind },
  char?: {
    stats: { physical: number; wisdom: number; intelligence: number; charisma: number };
    dayJob?: string;
    name?: string;
    health?: number;
    maxHealth?: number;
    location?: string;
  },
  /** The type `classify` routed this action to — set only on the first decision screen, the sole
   *  post-classify moment the opening frame belongs to; CONTINUE beats never carry it. */
  actionType?: ClassifiedActionType,
  /** Combat enemy name for the opening frame's nameplate; set only on the first decision of a
   *  combat action. */
  combatEnemyName?: string,
  /** The foe's banded condition (wound word + pip fill, never exact HP) when an `in_combat` edge
   *  from a prior bail against the same foe exists; first combat decision only, undefined otherwise. */
  combatEnemyCondition?: { woundWord: string; filled: number; total: number },
): DecisionViewState {
  // Raw DCs stay hidden while deciding; passive insight (10 + WIS) instead lets a perceptive
  // character occasionally spot the single safest route — earned (see INSIGHT_MARGIN), not a readout.
  const runningDc = state?.accumulatedDc;
  const passiveInsight = char ? 10 + char.stats.wisdom : undefined;

  // ── Gamebook layout: the story so far (narration quoted, choices bold) sits above the quoted
  // prompt; the lettered options are the only unquoted, actionable text. ──
  const workEmoji = char?.dayJob ? dayJobEmoji(char.dayJob) : '🛠️';
  // Both story-thread variants are pre-rendered here so the medium step can re-run the exact
  // same degrade decision (full → collapsed) against pre-rendered strings, byte-identically.
  const storyThread = state
    ? {
      full: buildStoryThread(state.rawInput, state.decisions, false, state.kind, workEmoji),
      collapsed: buildStoryThread(state.rawInput, state.decisions, true, state.kind, workEmoji),
    }
    : undefined;
  // Narration sits quoted above the CTA, with combatStatus a plain (unquoted) line between
  // them on combat continue-screens; both absent on the first beat, leaving just quest line + CTA.
  const narration = decision.narration ? quoteLines(decision.narration) : undefined;
  const combatStatus = decision.combatStatus
    ? renderCombatStatus(decision.combatStatus, decision.combatRounds?.at(-1))
    : undefined;
  const prompt = quoteLines(decision.prompt);

  // List real (non-bail) options in the body as A./B./C. so button captions can
  // be just the letter — nothing truncates on mobile. No options → Continue fallback.
  const options = decision.options.length > 0
    ? decision.options
    : [{ label: 'Continue', dcModifier: 0 }];

  // Hint fires only when ALL hold: two or more real options, DCs known, passive insight ≥ the
  // easiest option's DC, and that option ≥ INSIGHT_MARGIN safer than the next-best. Rare and earned.
  let favouredIdx = -1;
  if (passiveInsight != null && runningDc != null) {
    const real = options
      .map((opt, i) => ({ i, effDc: runningDc + (opt.dcModifier ?? 0), bail: opt.dcModifier === null }))
      .filter(o => !o.bail)
      .sort((a, b) => a.effDc - b.effDc);
    if (real.length >= 2) {
      const [best, second] = real;
      if (passiveInsight >= best.effDc && second.effDc - best.effDc >= INSIGHT_MARGIN) {
        favouredIdx = best.i;
      }
    }
  }

  const LETTERS = ['A', 'B', 'C', 'D', 'E'];
  const optionLines: string[] = [];
  const buttons: DecisionViewState['buttons'] = [];
  let letterIdx = 0;

  // customId carries each option's original index — the controller's `beginChoice`
  // resolves the label back from that index via `engine.resolvePendingChoice`.
  options.forEach((opt, origIdx) => {
    if (opt.dcModifier === null) {
      // Terminal (bail) — keeps a worded button, not lettered in the body.
      buttons.push({ kind: 'bail', label: shortLabel(opt.label, 80), customId: CID_BAIL });
    } else {
      const letter = LETTERS[letterIdx++] ?? String(origIdx + 1);
      const favoured = origIdx === favouredIdx;
      // Emoji and difficulty arrow are render-only decorations on this line —
      // `opt.label` itself (used for the button and for `chosen`) stays raw.
      const icon = statEmoji(opt.stat);
      const arrow = dcArrow(opt.dcModifier);
      const prefix = icon ? `${icon} ` : '';
      const suffix = arrow ? ` ${arrow}` : '';
      optionLines.push(`**${letter}.** ${prefix}${opt.label}${suffix}`);
      buttons.push({ kind: 'choice', letter, customId: choiceCid(decisionIdx, origIdx), favoured });
    }
  });

  const footer = favouredIdx >= 0
    ? 'a safer path catches your eye'
    : (decisionIdx === 0 ? 'What do you do?' : `Decision ${decisionIdx + 1}`);

  // Deliberate deviation: the opening frame leads as an embed in the same message rather than a
  // separate message the body replies to, because an ephemeral /action response cannot be a reply's target.
  const openingFrameSlots: OpeningFrameSlots = {
    pcName: char?.name,
    pcHp: char?.health,
    pcMaxHp: char?.maxHealth,
    locationName: char?.location,
  };
  if (combatEnemyName) openingFrameSlots.enemyName = combatEnemyName;
  if (combatEnemyCondition) openingFrameSlots.enemyCondition = combatEnemyCondition;
  const openingFrame = actionType && decisionIdx === 0
    ? renderOpeningFrame(actionType, openingFrameSlots)
    : undefined;

  return {
    screen: 'decision',
    title: { emoji: '🤔', text: 'Decision' },
    colorIntent: 'decision',
    storyThread,
    narration,
    combatStatus,
    prompt,
    optionLines,
    buttons,
    footer,
    openingFrame,
  };
}

function shortLabel(label: string, maxLen: number): string {
  return label.length > maxLen ? label.slice(0, maxLen - 1) + '…' : label;
}

/** Assembles the outcome screen's semantic view-state; the medium step (`outcomeViewToDiscord`)
 *  owns the assemble/degrade ladder. */
export function buildOutcomeView(
  outcome: ActionOutcome,
  character: CharacterData | null | undefined,
  scene: string | null | undefined,
  state: { rawInput: string; decisions: Array<{ prompt: string; chosen: string; dcModifier: number; distilledType?: string; narration?: string }>; kind?: ActionKind },
  engine?: WorldEngine,
): OutcomeViewState {
  const ctx: OutcomeRenderContext = {
    stamina: character?.stamina ?? 10,
    maxStamina: character?.maxStamina ?? 10,
    rollsRemaining: character?.rollsRemaining ?? 2,
    health: character?.health ?? 10,
    maxHealth: character?.maxHealth ?? 10,
    wealth: character?.wealth ?? 0,
    name: character?.name ?? 'You',
  };

  // Location header — emoji prefix from the geography seed, name from character.
  const locName = character?.location;
  const locEmoji = locName ? (engine?.getLocation(locName)?.emoji ?? '📍') : null;
  const locationLine = locName ? `${locEmoji} ${locName}` : undefined;

  // Breadcrumb of the distilled actions the player moved through, e.g. 🔍 → 🗣️ → ⚔️.
  const types = state.decisions.length > 0
    ? state.decisions.map(d => d.distilledType).filter((t): t is string => !!t)
    : [outcome.distilledType];
  const breadcrumb = types.map(distilledActionEmoji).join(' → ');

  const sceneBlock = scene ? '```\n' + scene + '\n```' : undefined;
  // Combat outcomes show the combat opening frame (nameplate + HP bars) instead of the bare
  // location scene; the terminal card already covers the dice reveal, so the pair reads scene-to-dice.
  let combatSceneBlock: string | undefined;
  if (outcome.combatBeat && character) {
    const lastBeat = outcome.combatRounds?.at(-1) ?? outcome.combatBeat;
    // Band against the foe's max HP, not the round-opening `enemyHpBefore` — the latter reads a
    // worn-down foe healthier than it is. Fall back to the round-opening fraction only with no usable max.
    const enemyMaxHp = outcome.combatFrame?.enemyMaxHp;
    const enemyFraction = enemyMaxHp != null && enemyMaxHp > 0
      ? lastBeat.enemyHpAfter / enemyMaxHp
      : lastBeat.enemyHpBefore > 0 ? lastBeat.enemyHpAfter / lastBeat.enemyHpBefore : 0;
    const { filled, woundWord } = enemyConditionBand(enemyFraction);
    combatSceneBlock = renderOpeningFrame('combat', {
      pcName: character.name,
      pcHp: character.health,
      pcMaxHp: character.maxHealth,
      enemyName: outcome.combatFrame?.enemyName,
      enemyCondition: { filled, total: 5, woundWord },
    });
  }
  // Terminal-card escalation: crit border for nat-20, heavy for nat-1.
  const terminalRenderer = (card: CombatTerminalCard) => {
    const style = card.playerD20 === 20 ? BORDERS.crit
      : card.playerD20 === 1 ? BORDERS.heavy
      : BORDERS.standard;
    return renderCombatTerminalCard(card, PALETTES.house, style);
  };
  const outcomeBlock = formatOutcome(outcome, ctx, terminalRenderer);
  const workEmoji = character?.dayJob ? dayJobEmoji(character.dayJob) : '🛠️';

  // Both story-thread variants are pre-rendered here so the medium step can re-run the exact
  // same degrade ladder (full → collapsed → drop scene → hard clip) against pre-rendered strings.
  const storyThread = {
    full: buildStoryThread(state.rawInput, state.decisions, false, state.kind, workEmoji),
    collapsed: buildStoryThread(state.rawInput, state.decisions, true, state.kind, workEmoji),
  };

  return {
    screen: 'outcome',
    title: { emoji: distilledActionEmoji(outcome.distilledType), text: capitalize(outcome.distilledType) },
    colorIntent: outcomeColorIntent(outcome.outcome),
    locationLine,
    breadcrumb,
    sceneBlock,
    combatSceneBlock,
    isCombat: !!outcome.combatBeat,
    storyThread,
    outcomeBlock,
  };
}

/** Maps an outcome string to its semantic colour intent — identity for the known outcome
 *  values (mirroring `outcomeColor`'s case labels), 'default' for anything else. */
function outcomeColorIntent(outcome: string): ViewColorIntent {
  switch (outcome) {
    case 'success':
    case 'failure':
    case 'skipped':
    case 'bailed':
    case 'done':
    case 'timed_out':
      return outcome;
    default:
      return 'default';
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
