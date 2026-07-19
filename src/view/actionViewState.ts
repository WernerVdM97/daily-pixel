/**
 * View-state builders for the /action decision + outcome screens (JSON-seam M2/M3.2b).
 * `discord.js`-free by construction — only `render/*`, `engine/*`, `view/viewState`, and
 * `discord/format` (for `dayJobEmoji`, itself `discord.js`-free) are imported. Relocated out
 * of `discord/commands/action.ts` (which keeps the medium wrappers `buildDecisionMessage`/
 * `buildOutcomeEmbed` — they weld `discord.js`) — same mechanical, byte-identical move as
 * M3.0's `render/embedText.ts` relocation.
 */

import type { WorldEngine, ActionOutcome, ActionKind, CharacterData, CombatStatusData, ClassifiedActionType } from '../engine/WorldEngine.js';
import type { CombatBeatLog } from '../engine/action/combat-dc.js';
import { dangerTier } from '../engine/action/combat-dc.js';
import { formatOutcome, distilledActionEmoji, type OutcomeRenderContext } from '../engine/OutcomeRenderer.js';
import { STAT_LABELS } from '../engine/stat-format.js';
import { dayJobEmoji } from '../discord/format.js';
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

/**
 * Qualitative difficulty arrow for a DC modifier — no raw numbers. Negative
 * lowered the DC (easier → down), positive raised it (harder → up), zero
 * shows nothing.
 */
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

/**
 * Render the "story so far" as a gamebook thread: the quest line, then each
 * prior beat as its narration — the consequence of the choice before it,
 * quoted — plus the player's choice (bold). The first beat authors no
 * narration (lean, framed by the player's own input), so that beat renders
 * as choice-only. `collapse` drops narration to a choice-only breadcrumb —
 * the graceful-degradation form for when the full thread overflows the
 * embed cap.
 */
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

/** Border-escalation rules for the continue card ([[visual-craft]]):
 *  - heavy if the last round's band was HEAVY or the player is bloodied (≤25%)
 *  - standard otherwise */
function chooseContinueBorder(status: CombatStatusData, lastRound?: CombatBeatLog): BorderStyle {
  const playerFrac = status.playerMaxHp > 0 ? status.playerHp / status.playerMaxHp : 0;
  if (lastRound?.band === 'heavy' || playerFrac <= 0.25) return BORDERS.heavy;
  return BORDERS.standard;
}

/** Frame assembly for a combat continue-screen's status (ANSI-C, redesigned ANSI-D+):
 *  delegates to `renderCombatContinueCard` from CombatCardRenderer, with the border
 *  style chosen by escalation rules. */
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

/** Tolerant read (ANSI-C): a pre-existing in-flight action's saved state still carries the old
 *  engine-composed ANSI string in `combatStatus` — render either shape without throwing. A
 *  legacy string never carries a round log either (it predates `combatRounds`), so `lastRound`
 *  is simply ignored on that branch rather than threaded through. */
function renderCombatStatus(combatStatus: CombatStatusData | string, lastRound?: CombatBeatLog): string {
  return typeof combatStatus === 'string' ? combatStatus : renderCombatStatusFrame(combatStatus, lastRound);
}

/** Assemble the decision screen's semantic view-state (JSON-seam M2). Same parameter list as
 *  `buildDecisionMessage`; the medium step (`decisionViewToDiscord`) owns the block join, the
 *  embed-length degradation ladder, and all `discord.js` construction. */
export function buildDecisionView(
  decision: {
    prompt: string;
    narration?: string;
    combatStatus?: CombatStatusData | string;
    /** ANSI-D: this beat's round log (accumulated so far), so the continue frame can splice in
     *  the last round's dice maths — see `renderCombatStatusFrame`'s `lastRound` param. */
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
  /** ANSI-F: the type `classify` routed this action to. Only present on the very first decision
   *  screen (`decisionIdx === 0`) — that's the sole "post-classify, pre-first-decision" moment
   *  the OPENING frame belongs to (classification framework §2c); CONTINUE beats never carry it. */
  actionType?: ClassifiedActionType,
  /** ANSI-F: combat enemy name for the opening frame's enemy nameplate. Only passed on the first
   *  decision of a combat action (surfaced from the pipeline's `combatEnemy` hint). */
  combatEnemyName?: string,
  /** ANSI-F re-entry (0.3.2 C4): the foe's BANDED condition (wound word + pip fill, never exact
   *  HP) when a persisted `in_combat` edge from a prior bail against this same foe exists. Only
   *  passed on the first decision of a combat action; undefined for a fresh fight. */
  combatEnemyCondition?: { woundWord: string; filled: number; total: number },
): DecisionViewState {
  // Raw DCs stay hidden while deciding. Instead, passive insight (10 + WIS,
  // D&D-style) occasionally lets a perceptive character spot the single safest
  // route — earned (see INSIGHT_MARGIN), not a constant readout.
  const runningDc = state?.accumulatedDc;
  const passiveInsight = char ? 10 + char.stats.wisdom : undefined;

  // ── Gamebook layout: story so far (quest + prior beats, prompts quoted,
  // choices bold) above the current prompt, also quoted. The lettered options
  // below are the only unquoted, actionable text — mirrors the outcome recap so
  // the whole /action flow reads as one continuous gamebook page. ──
  const workEmoji = char?.dayJob ? dayJobEmoji(char.dayJob) : '🛠️';
  // Both story-thread variants are pre-rendered here so the medium step can re-run the exact
  // same degrade decision (full → collapsed) against pre-rendered strings, byte-identically.
  const storyThread = state
    ? {
      full: buildStoryThread(state.rawInput, state.decisions, false, state.kind, workEmoji),
      collapsed: buildStoryThread(state.rawInput, state.decisions, true, state.kind, workEmoji),
    }
    : undefined;
  // Narration (the consequence of the last choice) sits quoted above the CTA;
  // combatStatus is a plain (unquoted) status line between the two on combat
  // continue-screens. Absent on the first beat — just the quest line + CTA.
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

  // Hint fires only when ALL hold: DCs known, passive insight ≥ the easiest
  // option's DC, and that option is clearly safer than the next-best
  // (≥ INSIGHT_MARGIN). Otherwise no hint — rare and earned, never always-on.
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

  // ANSI-F: the OPENING frame (art post) leads the message, the decision embed above IS the
  // "reply" body (§2b) — narration, options, and the interactive buttons. The delivery convention
  // calls for the frame as its OWN Discord message with the body as a genuine reply beneath it,
  // but every /action call site defers/replies ephemeral, and an ephemeral interaction response
  // cannot be the target of a separate message's reply (Discord never exposes it as a normal,
  // referenceable channel message). Leading embed in the SAME message is the sanctioned fallback
  // for that case — a deliberate deviation from the literal two-message convention, flagged for
  // lead review rather than expanding this task into an ephemeral->public flow redesign.
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

/** Assemble the outcome screen's semantic view-state (JSON-seam M2). Same parameter list as
 *  `buildOutcomeEmbed`; the medium step (`outcomeViewToDiscord`) owns the assemble/degrade
 *  ladder and all `discord.js` construction. */
export function buildOutcomeView(
  outcome: ActionOutcome,
  character: CharacterData | null | undefined,
  scene: string | null | undefined,
  state: { rawInput: string; decisions: Array<{ prompt: string; chosen: string; dcModifier: number; distilledType?: string; narration?: string }>; kind?: ActionKind },
  opts?: { compact?: boolean },
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
  // 0.3.2 P2: combat outcomes show the combat opening frame (with enemy nameplate + HP bars)
  // instead of the bare location scene — the terminal card already covers the dice reveal,
  // so pairing it with the combat frame gives a coherent visual story: scene-to-dice.
  let combatSceneBlock: string | undefined;
  if (outcome.combatBeat && character) {
    const lastBeat = outcome.combatRounds?.at(-1) ?? outcome.combatBeat;
    const enemyFraction = lastBeat.enemyHpBefore > 0 ? lastBeat.enemyHpAfter / lastBeat.enemyHpBefore : 0;
    const { filled, woundWord } = enemyConditionBand(enemyFraction);
    combatSceneBlock = renderOpeningFrame('combat', {
      pcName: character.name,
      pcHp: character.health,
      pcMaxHp: character.maxHealth,
      enemyName: outcome.combatFrame?.enemyName,
      enemyCondition: { filled, total: 5, woundWord },
    });
  }
  // Terminal-card escalation ([[visual-craft]]): crit border for nat-20, heavy for nat-1.
  const terminalRenderer = (card: CombatTerminalCard) => {
    const style = card.playerD20 === 20 ? BORDERS.crit
      : card.playerD20 === 1 ? BORDERS.heavy
      : BORDERS.standard;
    return renderCombatTerminalCard(card, PALETTES.house, style);
  };
  const outcomeBlock = formatOutcome(outcome, ctx, terminalRenderer);
  const workEmoji = character?.dayJob ? dayJobEmoji(character.dayJob) : '🛠️';

  // Both story-thread variants are pre-rendered here (compact mode carries neither — the
  // player just saw the thread in the decision embed, so repeating it here is the
  // double-showing the player flagged, F#19c) so the medium step can re-run the exact same
  // degrade ladder (full → collapsed → drop scene → hard clip) against pre-rendered strings.
  const storyThread = !opts?.compact
    ? {
      full: buildStoryThread(state.rawInput, state.decisions, false, state.kind, workEmoji),
      collapsed: buildStoryThread(state.rawInput, state.decisions, true, state.kind, workEmoji),
    }
    : undefined;

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
