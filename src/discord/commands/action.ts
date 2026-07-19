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
import { randomIdleMessage } from '../../engine/IdleMessageSelector.js';
import { getDayJobActions, type DayJobDef } from './hi.js';
import { getNavButtons, getOutcomeServiceButtons, getPublicOutcomeButtons, classEmoji, dayJobEmoji } from '../format.js';
import { announceCollapse } from '../collapse.js';
import { broadcastOutcome, META_RECAP_THREAD_ID } from '../weekly-recap.js';
import { decisionViewToDiscord, outcomeViewToDiscord } from '../viewToDiscord.js';
import { buildDecisionView, buildOutcomeView, CID_BAIL, parseActionCid } from '../../view/actionViewState.js';

// Builders relocated to view/actionViewState.ts (M3.2b); re-exported here since
// action-decision/view-state tests import them from this module's path.
export { buildDecisionView, buildOutcomeView };

// ── Custom IDs ──

export const CID_DAYJOB = 'action:dayjob:';
export const CID_DAYJOB_CUSTOM = 'action:dayjob:custom';
export const CID_CUSTOM_MODAL = 'action:custom:modal';
export const CID_CUSTOM_INPUT = 'action:custom:input';

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

  // Keys off rolls *remaining*, not the day's allowance, so it fires on the genuine last roll
  // whatever that allowance is: exactly one left is always the last action, whether the day
  // grants 3 or Saturday's bonus 4 (N3 — no premature warning a roll early on Saturday).
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

      setPendingDecision(interaction.user.id, result.firstDecision);
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
    // Same embed for both private and public — the player sees the full outcome.
    const embed = buildOutcomeEmbed(outcome, character, scene, result.state, undefined, engine);

    const serviceButtons = getOutcomeServiceButtons(outcome.actionId);
    await i.webhook.editMessage(i.message.id, {
      embeds: [embed],
      components: character
        ? [...getNavButtons(character), ...serviceButtons]
        : serviceButtons,
    });

    // Public copy carries a "Hi" re-entry button alongside the feedback/bug-report buttons.
    const charName = character?.name ?? 'Unknown';
    const payload = {
      content: `${classEmoji(character?.class)} **${charName}** <@${i.user.id}> — ${outcome.distilledType}`,
      embeds: [embed],
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
