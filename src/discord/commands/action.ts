/**
 * /action — take an action in the world.
 *
 * Slash command starts the action state machine and shows the first decision;
 * each button click steps the machine to the next decision or final outcome.
 * Button routing lives in index.ts (Events.InteractionCreate), keyed off the
 * `action:` custom ID prefix.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
  type MessageComponentInteraction,
} from 'discord.js';
import type { WorldEngine, ActionDecision, ActionOutcome, ActionKind, CharacterData, CombatStatusData, ClassifiedActionType } from '../../engine/WorldEngine.js';
import type { ActionStepResult } from '../../engine/WorldEngine.js';
import type { CombatBeatLog } from '../../engine/action/combat-dc.js';
import { formatOutcome, distilledActionEmoji, type OutcomeRenderContext } from '../../engine/OutcomeRenderer.js';
import { STAT_LABELS } from '../../engine/stat-format.js';
import { randomIdleMessage } from '../../engine/IdleMessageSelector.js';
import { getDayJobActions, type DayJobDef } from './hi.js';
import { getNavButtons, getOutcomeServiceButtons, getPublicOutcomeButtons, classEmoji, dayJobEmoji } from '../format.js';
import { announceCollapse } from '../collapse.js';
import { broadcastOutcome, META_RECAP_THREAD_ID } from '../weekly-recap.js';
import { BORDERS, PALETTES, type BorderStyle } from '../../render/AnsiRenderer.js';
import { renderOpeningFrame, type OpeningFrameSlots } from '../../render/OpeningFrameRenderer.js';
import { renderCombatContinueCard, renderCombatTerminalCard, type ContinueCardInput, type CombatTerminalCard } from '../../render/CombatCardRenderer.js';

// ── Custom IDs ──

const CID_PREFIX = 'action:choice:';
const CID_BAIL = 'action:bail';
export const CID_DAYJOB = 'action:dayjob:';
export const CID_DAYJOB_CUSTOM = 'action:dayjob:custom';
export const CID_CUSTOM_MODAL = 'action:custom:modal';
export const CID_CUSTOM_INPUT = 'action:custom:input';

function choiceCid(decisionIdx: number, optionIdx: number): string {
  return `${CID_PREFIX}${decisionIdx}:${optionIdx}`;
}

// ── /action hints ──

export interface ActionHintContext {
  rollsRemaining: number;
  stamina: number;
  maxStamina: number;
  isSafe: boolean;
}

// "Running on fumes" at 25% of max stamina, floored at 2 so low-max characters
// still get the warning at very low absolute stamina rather than never triggering.
const LOW_STAMINA_RATIO = 0.25;
const LOW_STAMINA_FLOOR = 2;

/** Contextual hints for the bare `/action` day-job menu — shared by the slash
 *  path (action.ts) and the `nav:action` button path (index.ts) so they can't drift. */
export function buildActionHints({ rollsRemaining, stamina, maxStamina, isSafe }: ActionHintContext): string[] {
  const hints: string[] = [];

  if (rollsRemaining === 1) {
    hints.push('🎲 Last action of the day — make it count.');
  }

  const lowStaminaThreshold = Math.max(LOW_STAMINA_FLOOR, Math.round(maxStamina * LOW_STAMINA_RATIO));
  // stamina < maxStamina guards a character at full stamina (e.g. 1/1 or 2/2) from seeing
  // the warning purely because their max is tiny — "fumes" implies having spent some.
  if (stamina <= lowStaminaThreshold && stamina < maxStamina) {
    hints.push(`😮‍💨 You're running on fumes (${stamina}/${maxStamina} stamina).`);
  }

  if (!isSafe) {
    hints.push("⚠️ This place isn't safe — trouble may find you.");
  }

  return hints;
}

// Most recent pending decision per user, so button clicks can resolve the
// option label from its index.
const pendingDecisions = new Map<string, ActionDecision>();

// Day-job menu ephemeral messages, keyed by userId, so the custom modal submit
// can delete them via webhook.
const _menuMessages = new Map<string, { applicationId: string; token: string; messageId: string }>();

export function stashMenuMessage(userId: string, info: { applicationId: string; token: string; messageId: string }): void {
  _menuMessages.set(userId, info);
}

export function consumeMenuMessage(userId: string): { applicationId: string; token: string; messageId: string } | undefined {
  const entry = _menuMessages.get(userId);
  _menuMessages.delete(userId);
  return entry;
}

// Scene lookup — set by makeActionCommand, used by button handlers.
let _sceneLookup: ((userId: string) => string) | null = null;

export function setPendingDecision(userId: string, decision: ActionDecision): void {
  // No options → store a Continue fallback so this matches buildDecisionMessage's render.
  const options = decision.options.length > 0
    ? decision.options
    : [{ label: 'Continue', dcModifier: 0 }];
  pendingDecisions.set(userId, { ...decision, options });
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

export function getChoiceLabel(userId: string, optionIdx: number): string | null {
  const decision = pendingDecisions.get(userId);
  if (!decision) return null;
  const opt = decision.options[optionIdx];
  return opt?.label ?? null;
}

// ── Factory ──

export function makeActionCommand(engine: WorldEngine, getCurrentScene: (userId: string) => string, dayJobs: DayJobDef[]) {
  _sceneLookup = getCurrentScene;
  return async (interaction: ChatInputCommandInteraction): Promise<string> => {
    const description = interaction.options.getString('description');

    // Guard: must have a character.
    const character = engine.getCharacter(interaction.user.id);
    if (!character) {
      await interaction.reply({
        content: "You don't have a character yet. Type `/join` to create one.",
        flags: MessageFlags.Ephemeral,
      });
      return 'action_guard_no_character';
    }

    // Guard: no rolls left (except to resume a mid-action state).
    if (character.rollsRemaining <= 0 && !character.lastActionState) {
      await interaction.reply({
        content: '🛌 **Out of actions for today.**\nRest by the Oak (`/sleep`) and try again tomorrow.',
        flags: MessageFlags.Ephemeral,
      });
      return 'action_no_rolls';
    }

    // If mid-action, resume regardless of description
    if (character.lastActionState !== null) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const resumeResult = engine.resumeAction(character.id);

        // No options → stale/broken state: show the prompt with a warning, no buttons.
        if (resumeResult.nextDecision.options.length === 0) {
          const staleBody = resumeResult.nextDecision.prompt || 'Your previous action could not be recovered.';
          await interaction.editReply({
            embeds: [
              new EmbedBuilder()
                .setTitle('⏳ Stale Action')
                .setDescription(withNarration(resumeResult.nextDecision.narration, staleBody))
                .setColor(0x95a5a6)
                .toJSON(),
            ],
            components: [],
          });
          return 'action_resume_empty';
        }

        setPendingDecision(interaction.user.id, resumeResult.nextDecision);
        const decisionIdx = resumeResult.state.decisions.length;
        await interaction.editReply(buildDecisionMessage(resumeResult.nextDecision, decisionIdx, resumeResult.state, character));
        return 'action_resumed';
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await interaction.editReply({ content: `❌ **Could not resume.**\n${msg}` });
        return 'action_error';
      }
    }

    // No description and not mid-action — show the daily work list as buttons.
    if (!description) {
      if (character.rollsRemaining <= 0) {
        await interaction.reply({
          content: '🛌 **Out of actions for today.**\nRest by the Oak (`/sleep`) and try again tomorrow.',
          flags: MessageFlags.Ephemeral,
        });
        return 'action_no_rolls';
      }

      try {
        const dayNumber = Number(engine.getMeta('day_number') ?? '1');
        const jobActions = getDayJobActions(character.dayJob, dayJobs, { characterId: character.id, dayNumber });
        const hints = buildActionHints({
          rollsRemaining: character.rollsRemaining,
          stamina: character.stamina,
          maxStamina: character.maxStamina,
          isSafe: engine.getLocation(character.location)?.isSafe ?? true,
        });
        const description = hints.length > 0
          ? `Pick a task to start:\n\n${hints.join('\n')}`
          : 'Pick a task to start:';
        const embed = new EmbedBuilder()
          .setTitle(`${dayJobEmoji(character.dayJob)} ${character.dayJob} — Daily Work`)
          .setDescription(description)
          .setColor(0xdaa520);

        const row = new ActionRowBuilder<ButtonBuilder>();
        for (let i = 0; i < jobActions.length; i++) {
          row.addComponents(
            new ButtonBuilder()
              .setCustomId(CID_DAYJOB + i)
              .setLabel(jobActions[i].label)
              .setStyle(ButtonStyle.Secondary),
          );
        }
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(CID_DAYJOB_CUSTOM)
            .setLabel('Custom…')
            .setStyle(ButtonStyle.Primary),
        );

        await interaction.reply({
          embeds: [embed.toJSON()],
          components: [row.toJSON()],
          flags: MessageFlags.Ephemeral,
        });
        const menuMsg = await interaction.fetchReply();
        stashMenuMessage(interaction.user.id, {
          applicationId: interaction.applicationId,
          token: interaction.token,
          messageId: menuMsg.id,
        });
        return 'action_dayjob_menu';
      } catch {
        await interaction.reply({
          content: `${dayJobEmoji(character.dayJob)} **${character.dayJob}**\n\nUse \`/action <what you do>\` to start an action.`,
          flags: MessageFlags.Ephemeral,
        });
        return 'action_no_description';
      }
    }

    // Defer (LLM can take >3s), then show an idle message so the player isn't
    // staring at a blank spinner.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setDescription(`**You:** ${description}\n\n⏳ **Starting…**\n_${randomIdleMessage()}_`)
          .setColor(0x95a5a6)
          .toJSON(),
      ],
    });

    try {
      const result = await engine.startAction(character.id, description);

      // Divine intervention is a system fault, not a real action outcome — render the distinct
      // grey ⚠️ System embed and stop, BEFORE the generic auto-finish branch below (which would
      // otherwise repaint it as a normal ✅ DONE outcome and misreport the refunded roll).
      if (result.outcome?.isDivineIntervention) {
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle('⚠️ System')
              .setDescription(result.outcome.outcomeText)
              .setColor(0x95a5a6)
              .toJSON(),
          ],
          components: [],
        });
        return 'action_divine';
      }

      // Auto-finish: the LLM resolved the action outright (travel/rest) — render
      // the outcome directly, no buttons.
      if (result.outcome) {
        const resolvedChar = engine.getCharacter(interaction.user.id);
        const scene = getCurrentScene(interaction.user.id);
        // Compact embed for private reply (no story thread — the player just saw it in
        // the decision embed). Full embed for the public thread copy (F#19c).
        const privateEmbed = buildOutcomeEmbed(result.outcome, resolvedChar, scene, result.state, { compact: true }, engine);
        const publicEmbed = buildOutcomeEmbed(result.outcome, resolvedChar, scene, result.state, undefined, engine);
        const serviceButtons = getOutcomeServiceButtons(result.outcome.actionId);
        await interaction.editReply({
          embeds: [privateEmbed],
          components: resolvedChar
            ? [...getNavButtons(resolvedChar), ...serviceButtons]
            : serviceButtons,
        });
        const payload = {
          content: `${classEmoji(resolvedChar?.class)} **${resolvedChar?.name ?? 'Unknown'}** <@${interaction.user.id}> — ${result.outcome.distilledType}`,
          embeds: [publicEmbed],
          components: getPublicOutcomeButtons(result.outcome.actionId),
          allowedMentions: { users: [] },
        };
        // The action already resolved and persisted, and the outcome is shown above. Isolate the
        // public broadcast + collapse announce so a failure here can't fall through to the outer
        // catch and repaint a successful action as "❌ Could not act".
        try {
          await broadcastOutcome({
            client: interaction.client,
            threadId: engine.getMeta(META_RECAP_THREAD_ID),
            payload,
            fallback: () => interaction.followUp(payload),
            subscribeUserIds: [interaction.user.id],
          });
          await announceCollapse(resolvedChar?.name ?? 'A soul', character, resolvedChar);
        } catch (broadcastErr) {
          console.warn(
            '[action] outcome resolved but broadcast/announce failed:',
            broadcastErr instanceof Error ? broadcastErr.message : String(broadcastErr),
          );
        }
        return 'action_autofinished';
      }

      setPendingDecision(interaction.user.id, result.firstDecision);
      await interaction.editReply(buildDecisionMessage(result.firstDecision, 0, result.state, character, result.actionType, result.combatEnemyName));
      return 'action_started';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await interaction.editReply({
        content: `❌ **Could not act.**\n${msg}`,
      });
      return 'action_error';
    }
  };
}

// ── Handle button clicks ──

export async function handleActionChoice(
  i: MessageComponentInteraction,
  engine: WorldEngine,
): Promise<void> {
  const character = engine.getCharacter(i.user.id);
  if (!character) {
    await i.reply({
      content: "You don't have a character. Type `/join` first.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const charId = character.id;

  // Defer (stepAction calls the LLM, >3s), then resolve the picked option first
  // so the loading screen can echo the choice rather than a bare "Thinking…".
  await i.deferUpdate();

  let label: string | null;
  if (i.customId === CID_BAIL) {
    // Bail label comes from the pending decision's bail option.
    const decision = pendingDecisions.get(i.user.id);
    label = decision?.options.find(o => o.dcModifier === null)?.label ?? 'Bail';
  } else {
    const parsed = parseActionCid(i.customId);
    if (!parsed) return;
    label = getChoiceLabel(i.user.id, parsed.optionIdx);
  }

  if (!label) {
    await i.webhook.editMessage(i.message.id, {
      content: '❌ Your action session expired. Try `/action` again.',
      components: [],
      embeds: [],
    });
    return;
  }

  // Blank the buttons; echo the choice with a "Thinking…" line below.
  await i.editReply({
    embeds: [
      new EmbedBuilder()
        .setDescription(`**You:** ${label}\n\n⏳ **Thinking…**\n_${randomIdleMessage()}_`)
        .setColor(0x95a5a6)
        .toJSON(),
    ],
    components: [],
  });

  try {
    const result = await engine.stepAction(charId, label);
    await applyActionResult(i, result, engine, character);
  } catch (err) {
    console.error('[action] stepAction error:', err);
    await i.webhook.editMessage(i.message.id, {
      embeds: [
        new EmbedBuilder()
          .setTitle('⚔️ Action Failed')
          .setDescription(`❌ ${(err as Error).message}\n\nTry \`/action\` again.`)
          .setColor(0xe74c3c)
          .toJSON(),
      ],
      components: [],
    });
  }
}

async function applyActionResult(
  i: MessageComponentInteraction,
  result: ActionStepResult,
  engine: WorldEngine,
  prevChar?: CharacterData | null,
): Promise<void> {
  if (result.resolved) {
    const character = engine.getCharacter(i.user.id);
    const outcome = result.outcome;

    // Destination scene shown when the character moved.
    const scene = _sceneLookup?.(i.user.id);
    // Compact for private reply (no story thread — the player just saw it in the
    // decision embed). Full for the public thread copy (F#19c).
    const privateEmbed = buildOutcomeEmbed(outcome, character, scene, result.state, { compact: true }, engine);
    const publicEmbed = buildOutcomeEmbed(outcome, character, scene, result.state, undefined, engine);

    const serviceButtons = getOutcomeServiceButtons(outcome.actionId);
    await i.webhook.editMessage(i.message.id, {
      embeds: [privateEmbed],
      components: character
        ? [...getNavButtons(character), ...serviceButtons]
        : serviceButtons,
    });

    // Public copy carries a "Hi" re-entry button alongside the feedback/bug-report buttons.
    const charName = character?.name ?? 'Unknown';
    const payload = {
      content: `${classEmoji(character?.class)} **${charName}** <@${i.user.id}> — ${outcome.distilledType}`,
      embeds: [publicEmbed],
      components: getPublicOutcomeButtons(outcome.actionId),
      allowedMentions: { users: [] },
    };
    await broadcastOutcome({
      client: i.client,
      threadId: engine.getMeta(META_RECAP_THREAD_ID),
      payload,
      fallback: () => i.followUp(payload),
      subscribeUserIds: [i.user.id],
    });
    await announceCollapse(character?.name ?? prevChar?.name ?? 'A soul', prevChar, character);
  } else {
    setPendingDecision(i.user.id, result.nextDecision);
    const decisionIdx = result.state.decisions.length;
    const character = engine.getCharacter(i.user.id);
    await i.webhook.editMessage(i.message.id, buildDecisionMessage(result.nextDecision, decisionIdx, result.state, character ?? undefined));
  }
}

// ── Helpers ──

/** How much easier the safest option must be than the next-best before passive
 *  insight flags it — keeps the green hint a rare, earned tell. */
const INSIGHT_MARGIN = 2;

/** Discord caps an embed description at 4096 chars. */
const MAX_EMBED_DESC = 4096;

/** Quote every line of `text` as a Discord blockquote (blank lines keep the bar). */
function quoteLines(text: string): string {
  return text
    .split('\n')
    .map(line => (line.length > 0 ? `> ${line}` : '>'))
    .join('\n');
}

/** Clip to `max` chars with a trailing ellipsis. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
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

/** Compose the narration block above a prompt-only surface (unfinished-action
 *  panel, stale-action embed, divine-intervention embed) — `prompt` alone is a
 *  contentless "what do you do?" once narration carries the scene. */
function withNarration(narration: string | undefined, prompt: string): string {
  return narration ? `${narration}\n\n${prompt}` : prompt;
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
      ? { d20: lastRound.playerD20, bonus: lastRound.playerBonus, dc: lastRound.dc, margin: lastRound.margin, band: lastRound.band }
      : undefined,
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

export function buildDecisionMessage(
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
): {
  embeds: ReturnType<EmbedBuilder['toJSON']>[];
  components: ReturnType<ActionRowBuilder<ButtonBuilder>['toJSON']>[];
} {
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
  const blocks: string[] = [];
  if (state) {
    blocks.push(buildStoryThread(state.rawInput, state.decisions, false, state.kind, workEmoji));
  }
  // Narration (the consequence of the last choice) sits quoted above the CTA;
  // combatStatus is a plain (unquoted) status line between the two on combat
  // continue-screens. Absent on the first beat — just the quest line + CTA.
  if (decision.narration) blocks.push(quoteLines(decision.narration));
  if (decision.combatStatus) blocks.push(renderCombatStatus(decision.combatStatus, decision.combatRounds?.at(-1)));
  blocks.push(quoteLines(decision.prompt));

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
  const buttons: ButtonBuilder[] = [];
  let letterIdx = 0;

  // customId carries each option's original index — handleActionChoice looks the
  // label up by index against the stored pending decision.
  options.forEach((opt, origIdx) => {
    if (opt.dcModifier === null) {
      // Terminal (bail) — keeps a worded button, not lettered in the body.
      buttons.push(
        new ButtonBuilder()
          .setCustomId(CID_BAIL)
          .setLabel(shortLabel(opt.label, 80))
          .setStyle(ButtonStyle.Danger),
      );
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
      buttons.push(
        new ButtonBuilder()
          .setCustomId(choiceCid(decisionIdx, origIdx))
          .setLabel(letter)
          // Passive insight tints the one route it senses is clearly safest.
          .setStyle(favoured ? ButtonStyle.Success : ButtonStyle.Secondary),
      );
    }
  });

  // Fit the embed cap, degrading gracefully: full gamebook → collapse history to
  // a breadcrumb → hard clip. Buttons live in `components` (always present), so a
  // hard clip of the option text never disables the choices.
  const optionsTail = optionLines.length > 0 ? `\n\n${optionLines.join('\n')}` : '';
  let truncated = blocks.join('\n\n') + optionsTail;
  if (truncated.length > MAX_EMBED_DESC && state) {
    truncated = [buildStoryThread(state.rawInput, state.decisions, true, state.kind, workEmoji), quoteLines(decision.prompt)]
      .join('\n\n') + optionsTail;
  }
  if (truncated.length > MAX_EMBED_DESC) truncated = clip(truncated, MAX_EMBED_DESC);

  const footerText = favouredIdx >= 0
    ? 'a safer path catches your eye'
    : (decisionIdx === 0 ? 'What do you do?' : `Decision ${decisionIdx + 1}`);

  const embed = new EmbedBuilder()
    .setTitle('🤔 Decision')
    .setDescription(truncated)
    .setColor(0xdaa520)
    .setFooter({ text: footerText });

  // Buttons — max 5 per row.
  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < buttons.length; i += 5) {
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons.slice(i, i + 5)),
    );
  }

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
  const openingFrameEmbed = actionType && decisionIdx === 0
    ? new EmbedBuilder()
      .setDescription(renderOpeningFrame(actionType, openingFrameSlots))
      .setColor(0x2c2f33)
      .toJSON()
    : undefined;

  return {
    embeds: openingFrameEmbed ? [openingFrameEmbed, embed.toJSON()] : [embed.toJSON()],
    components: components.map(r => r.toJSON()),
  };
}

function shortLabel(label: string, maxLen: number): string {
  return label.length > maxLen ? label.slice(0, maxLen - 1) + '…' : label;
}

/** Build the outcome embed (trail + formatted outcome). Shared by the button
 *  resolution and start-time auto-finish paths. */
export function buildOutcomeEmbed(
  outcome: ActionOutcome,
  character: CharacterData | null | undefined,
  scene: string | null | undefined,
  state: { rawInput: string; decisions: Array<{ prompt: string; chosen: string; dcModifier: number; distilledType?: string; narration?: string }>; kind?: ActionKind },
  opts?: { compact?: boolean },
  engine?: WorldEngine,
): ReturnType<EmbedBuilder['toJSON']> {
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
  const locationLine = locName ? `${locEmoji} ${locName}` : null;

  // Breadcrumb of the distilled actions the player moved through, e.g. 🔍 → 🗣️ → ⚔️.
  const types = state.decisions.length > 0
    ? state.decisions.map(d => d.distilledType).filter((t): t is string => !!t)
    : [outcome.distilledType];
  const breadcrumb = types.map(distilledActionEmoji).join(' → ');

  const sceneBlock = scene ? '```\n' + scene + '\n```' : '';
  // Terminal-card escalation ([[visual-craft]]): crit border for nat-20, heavy for nat-1.
  const terminalRenderer = (card: CombatTerminalCard) => {
    const style = card.playerD20 === 20 ? BORDERS.crit
      : card.playerD20 === 1 ? BORDERS.heavy
      : BORDERS.standard;
    return renderCombatTerminalCard(card, PALETTES.house, style);
  };
  const outcomeBlock = formatOutcome(outcome, ctx, terminalRenderer);
  const workEmoji = character?.dayJob ? dayJobEmoji(character.dayJob) : '🛠️';

  // Full gamebook recap: breadcrumb, destination scene, story thread, then the
  // resolution as focal unquoted text. Compact mode (private reply) skips the
  // story thread — the player just saw it in the decision embed, so repeating
  // it here is the double-showing the player flagged (F#19c). Degrade to fit
  // the embed cap: full → collapse history → drop the decorative scene → hard
  // clip.
  const assemble = (collapseHistory: boolean, includeScene: boolean): string => {
    const parts: string[] = [];
    if (locationLine) parts.push(locationLine);
    if (breadcrumb) parts.push(breadcrumb);
    // Combat outcomes show the AnsiRenderer combat frame (built into outcomeBlock) instead of
    // the decorative scene art — showing both would be redundant and burn embed-length budget.
    if (includeScene && sceneBlock && !outcome.combatBeat) parts.push(sceneBlock);
    if (!opts?.compact) {
      parts.push(buildStoryThread(state.rawInput, state.decisions, collapseHistory, state.kind, workEmoji));
    }
    parts.push(outcomeBlock);
    return parts.join('\n\n');
  };

  let description = assemble(false, true);
  if (description.length > MAX_EMBED_DESC) description = assemble(true, true);
  if (description.length > MAX_EMBED_DESC) description = assemble(true, false);
  if (description.length > MAX_EMBED_DESC) description = clip(description, MAX_EMBED_DESC);

  return new EmbedBuilder()
    .setTitle(`${distilledActionEmoji(outcome.distilledType)} ${capitalize(outcome.distilledType)}`)
    .setDescription(description)
    .setColor(outcomeColor(outcome.outcome))
    .toJSON();
}

function outcomeColor(outcome: string): number {
  switch (outcome) {
    case 'success': return 0x2ecc71; // green
    case 'failure': return 0xe74c3c; // red
    case 'skipped': return 0xf39c12; // amber
    case 'bailed': return 0xf39c12;  // amber — neutral retreat, not a failure
    case 'done': return 0x95a5a6;    // grey — neutral finish (travel/rest resolved)
    case 'timed_out': return 0x95a5a6;
    default: return 0x3498db;
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
