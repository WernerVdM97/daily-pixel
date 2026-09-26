/**
 * /action crosses the JSON seam as `menu.open` (bare) or `action.custom` (`/action <text>`): the router owns the guards, the day-job menu, the resume/stale screens and their copy; the ❌/⚠️ catches and the stale panel paint here.
 */

import {
  EmbedBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { WorldEngine } from '../../engine/WorldEngine.js';
import { getNavButtons, getOutcomeServiceButtons, getPublicOutcomeButtons } from '../format.js';
import { classEmoji } from '../../render/format.js';
import { announceCollapse } from '../collapse.js';
import { broadcastOutcome, META_RECAP_THREAD_ID } from '../weekly-recap.js';
import { decisionViewToDiscord, outcomeViewToDiscord, menuViewToDiscord, noticeViewToDiscord } from '../viewToDiscord.js';
import { trackPaint } from '../beatPaint.js';
import type { GameRouter } from '../../protocol/router.js';
import type { DecisionViewState, MenuViewState, NoticeViewState, OutcomeViewState } from '../../view/viewState.js';

// ── Custom IDs ──

export const CID_CUSTOM_MODAL = 'action:custom:modal';
export const CID_CUSTOM_INPUT = 'action:custom:input';

// Ephemeral day-job menus, keyed by userId so the custom modal submit can delete them via
// webhook — transport with no ViewState representation, hence here rather than the view seam.
const _menuMessages = new Map<string, { applicationId: string; token: string; messageId: string }>();

export function stashMenuMessage(userId: string, info: { applicationId: string; token: string; messageId: string }): void {
  _menuMessages.set(userId, info);
}

export function consumeMenuMessage(userId: string): { applicationId: string; token: string; messageId: string } | undefined {
  const entry = _menuMessages.get(userId);
  _menuMessages.delete(userId);
  return entry;
}

/** Compose the narration block above a prompt-only surface (the stale-action panel) —
 *  `prompt` alone is a contentless "what do you do?" once narration carries the scene. */
function withNarration(narration: string | undefined, prompt: string): string {
  return narration ? `${narration}\n\n${prompt}` : prompt;
}

// ── Factory ──

/** `engine`'s only read is `getMeta(META_RECAP_THREAD_ID)`, which has no seam equivalent: drop the
 *  dep and the auto-finish broadcast silently stops reaching the weekly-recap thread. */
export function makeActionCommand(router: GameRouter, engine: WorldEngine) {
  return async (interaction: ChatInputCommandInteraction): Promise<string> => {
    const description = interaction.options.getString('description');

    // Bare /action — the day-job menu / resume-in-progress arms; `menu.open` stamps FIRST on
    // every arm including the guard rejections.
    if (!description) {
      const response = await router.dispatch({ type: 'menu.open', playerId: interaction.user.id });

      if (response.ok) {
        const view = response.view;
        if (view?.screen === 'menu') {
          const m = menuViewToDiscord(view as MenuViewState);
          await interaction.reply({ embeds: m.embeds, components: m.components, flags: MessageFlags.Ephemeral });
          const menuMsg = await interaction.fetchReply();
          stashMenuMessage(interaction.user.id, {
            applicationId: interaction.applicationId,
            token: interaction.token,
            messageId: menuMsg.id,
          });
          return 'action_dayjob_menu';
        }
        if (view?.screen === 'decision') {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          await interaction.editReply(decisionViewToDiscord(view as DecisionViewState));
          return 'action_resumed';
        }
        if (view?.screen === 'notice') {
          // The router's fallback copy for a `composeActionMenu` throw.
          await interaction.reply(noticeViewToDiscord(view as NoticeViewState));
          return 'action_no_description';
        }
        await interaction.reply({ content: 'Something went wrong.', flags: MessageFlags.Ephemeral });
        return 'action_error';
      }

      // Guard rejections — no defer, a single ephemeral reply.
      if (response.error.code === 'no-character' || response.error.code === 'no-rolls') {
        await interaction.reply({ content: response.error.message, flags: MessageFlags.Ephemeral });
        return response.error.code === 'no-character' ? 'action_guard_no_character' : 'action_no_rolls';
      }

      // Resume outcomes (stale / a resume that failed) — both defer first, mirroring the
      // pre-port mid-action block's own deferReply-then-editReply order.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (response.error.code === 'stale-session') {
        const narration = response.facts?.narration as string | undefined;
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle('⏳ Stale Action')
              .setDescription(withNarration(narration, response.error.message))
              .setColor(0x95a5a6)
              .toJSON(),
          ],
          components: [],
        });
        return 'action_resume_empty';
      }
      await interaction.editReply({ content: `❌ **Could not resume.**\n${response.error.message}` });
      return 'action_error';
    }

    // Deferred LAZILY, on the router's first beat — which fires immediately before the slow
    // runCustomAction call, so it still beats Discord's 3s window; pre-beat arms pay nothing.
    let beatPaint: Promise<void> | undefined;
    // The router does not await `onBeat`, so the paint promise is held and awaited below:
    // issuing the final `editReply` before the defer lands throws and repaints a success as an error.
    const response = await router.dispatch(
      { type: 'action.custom', playerId: interaction.user.id, text: description },
      (beat) => {
        if (beat.ok && beat.view?.screen === 'loading' && !beatPaint) {
          const body = beat.view.body;
          beatPaint = trackPaint((async () => {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            await interaction.editReply({
              embeds: [new EmbedBuilder().setDescription(body).setColor(0x95a5a6).toJSON()],
            });
          })());
        }
      },
    );
    // Awaited outside any try, so a paint failure reaches the dispatcher's error net rather
    // than the `❌` branch below.
    if (beatPaint) await beatPaint;

    if (response.ok) {
      const view = response.view;
      if (view?.screen === 'decision') {
        // The resume arm lands here too: ok, but no beat fired, so `beatPaint` is undefined and
        // deferring now is safe — no slow call has run on this arm yet.
        if (!beatPaint) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await interaction.editReply(decisionViewToDiscord(view as DecisionViewState));
        return 'action_started';
      }
      if (view?.screen === 'outcome') {
        const outcomeView = view as OutcomeViewState;
        const embed = outcomeViewToDiscord(outcomeView);
        const facts = response.facts ?? {};
        const nav = facts.nav as { rollsRemaining: number; hasPendingAction: boolean; hasRestedToday: boolean } | undefined;
        const actionId = facts.actionId as number | undefined;
        const navButtons = nav ? getNavButtons(nav) : [];
        const serviceButtons = getOutcomeServiceButtons(actionId);
        await interaction.editReply({
          embeds: [embed],
          components: [...navButtons, ...serviceButtons],
        });

        const characterName = facts.characterName as string | undefined;
        const characterClass = facts.characterClass as string | null | undefined;
        const distilledType = facts.distilledType as string | undefined;
        const payload = {
          content: `${classEmoji(characterClass)} **${characterName ?? 'Unknown'}** <@${interaction.user.id}> — ${distilledType}`,
          embeds: [embed],
          components: getPublicOutcomeButtons(actionId),
          allowedMentions: { users: [] },
        };
        // Isolate the public broadcast + collapse announce so a failure here can't fall
        // through and repaint a successful action as "❌ Could not act".
        try {
          await broadcastOutcome({
            client: interaction.client,
            threadId: engine.getMeta(META_RECAP_THREAD_ID),
            payload,
            fallback: () => interaction.followUp(payload),
            subscribeUserIds: [interaction.user.id],
          });
          const collapse = facts.collapse as { name: string; prev: { health: number; stamina: number }; updated: { health: number; stamina: number } } | undefined;
          if (collapse) await announceCollapse(collapse.name, collapse.prev, collapse.updated);
        } catch (broadcastErr) {
          console.warn(
            '[action] outcome resolved but broadcast/announce failed:',
            broadcastErr instanceof Error ? broadcastErr.message : String(broadcastErr),
          );
        }
        return 'action_autofinished';
      }
      await interaction.editReply({ content: 'Something went wrong.' });
      return 'action_error';
    }

    // `beatPaint` is the phase signal: no beat means the error came from the pre-beat half
    // (`beginCustomAction`, or a guard ahead of it), a beat the post-beat half. A resume throw arrives undeferred with no beat, so it belongs in this branch, never at the `❌ Could not act.` catch below.
    if (!beatPaint) {
      // Guard rejections — no defer, a single plain ephemeral reply, matching the bare /action
      // arm's shape. `illegal-move` joins them: the profanity guard rejects on this same pre-beat path.
      if (response.error.code === 'no-character' || response.error.code === 'no-rolls' || response.error.code === 'illegal-move') {
        await interaction.reply({ content: response.error.message, flags: MessageFlags.Ephemeral });
        if (response.error.code === 'no-character') return 'action_guard_no_character';
        if (response.error.code === 'no-rolls') return 'action_no_rolls';
        return 'action_guard_profanity';
      }

      // Everything else on this half (stale-session, a resume throw surfacing as 'internal')
      // defers first, then edits.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (response.error.code === 'stale-session') {
        const narration = response.facts?.narration as string | undefined;
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle('⏳ Stale Action')
              .setDescription(withNarration(narration, response.error.message))
              .setColor(0x95a5a6)
              .toJSON(),
          ],
          components: [],
        });
        return 'action_resume_empty';
      }
      await interaction.editReply({ content: `❌ **Could not resume.**\n${response.error.message}` });
      return 'action_error';
    }

    // Post-beat: the interstitial already deferred, so every arm here edits. Divine intervention is
    // a system fault, not an outcome — hence the distinct grey ⚠️ System embed, no buttons, no broadcast.
    if (response.error.code === 'divine-intervention') {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle('⚠️ System')
            .setDescription(response.error.message)
            .setColor(0x95a5a6)
            .toJSON(),
        ],
        components: [],
      });
      return 'action_divine';
    }

    // The empty-action arm and any other failure reaching here come out of runCustomAction, so
    // the reply is already deferred.
    await interaction.editReply({ content: `❌ **Could not act.**\n${response.error.message}` });
    return 'action_error';
  };
}
