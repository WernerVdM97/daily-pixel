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
  EmbedBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { WorldEngine, ActionOutcome, ActionKind, CharacterData, CombatStatusData, ClassifiedActionType } from '../../engine/WorldEngine.js';
import type { CombatBeatLog } from '../../engine/action/combat-dc.js';
import { randomIdleMessage } from '../../engine/IdleMessageSelector.js';
import { getNavButtons, getOutcomeServiceButtons, getPublicOutcomeButtons, classEmoji, dayJobEmoji } from '../format.js';
import { announceCollapse } from '../collapse.js';
import { broadcastOutcome, META_RECAP_THREAD_ID } from '../weekly-recap.js';
import { decisionViewToDiscord, outcomeViewToDiscord, menuViewToDiscord } from '../viewToDiscord.js';
import { buildDecisionView, buildOutcomeView } from '../../view/actionViewState.js';
import { composeActionMenu, type DayJobDef } from '../../controller/dayJob.js';

// Builders relocated to view/actionViewState.ts (M3.2b); re-exported here since
// action-decision/view-state tests import them from this module's path.
export { buildDecisionView, buildOutcomeView };

// ── Custom IDs ──

export const CID_CUSTOM_MODAL = 'action:custom:modal';
export const CID_CUSTOM_INPUT = 'action:custom:input';

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

// ── Factory ──

export function makeActionCommand(engine: WorldEngine, getCurrentScene: (userId: string) => string, dayJobs: DayJobDef[]) {
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
        const m = menuViewToDiscord(composeActionMenu(engine, dayJobs, character));
        await interaction.reply({
          embeds: m.embeds,
          components: m.components,
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
        // Same embed for both private and public — the player sees the full outcome.
        const embed = buildOutcomeEmbed(result.outcome, resolvedChar, scene, result.state, undefined, engine);
        const serviceButtons = getOutcomeServiceButtons(result.outcome.actionId);
        await interaction.editReply({
          embeds: [embed],
          components: resolvedChar
            ? [...getNavButtons(resolvedChar), ...serviceButtons]
            : serviceButtons,
        });
        const payload = {
          content: `${classEmoji(resolvedChar?.class)} **${resolvedChar?.name ?? 'Unknown'}** <@${interaction.user.id}> — ${result.outcome.distilledType}`,
          embeds: [embed],
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

      await interaction.editReply(buildDecisionMessage(result.firstDecision, 0, result.state, character, result.actionType, result.combatEnemyName, result.combatEnemyCondition));
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

// ── Helpers ──

/** Compose the narration block above a prompt-only surface (unfinished-action
 *  panel, stale-action embed, divine-intervention embed) — `prompt` alone is a
 *  contentless "what do you do?" once narration carries the scene. */
function withNarration(narration: string | undefined, prompt: string): string {
  return narration ? `${narration}\n\n${prompt}` : prompt;
}

export function buildDecisionMessage(
  decision: {
    prompt: string;
    narration?: string;
    combatStatus?: CombatStatusData | string;
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
  actionType?: ClassifiedActionType,
  combatEnemyName?: string,
  combatEnemyCondition?: { woundWord: string; filled: number; total: number },
): {
  embeds: ReturnType<EmbedBuilder['toJSON']>[];
  components: ReturnType<ActionRowBuilder<ButtonBuilder>['toJSON']>[];
} {
  return decisionViewToDiscord(
    buildDecisionView(decision, decisionIdx, state, char, actionType, combatEnemyName, combatEnemyCondition),
  );
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
  return outcomeViewToDiscord(buildOutcomeView(outcome, character, scene, state, opts, engine));
}
