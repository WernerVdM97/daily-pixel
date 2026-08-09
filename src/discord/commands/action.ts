/**
 * /action — take an action in the world. Crosses the JSON seam as `menu.open` (bare
 * `/action`) or `action.custom` (`/action <text>`) (M9.2, DC-M9.4): the router owns the
 * guards, the day-job menu, the resume/stale screens and every player-facing copy string.
 * This handler is translate + paint only — the medium chrome DC-M9.2's checklist named as
 * transport stays here: the distinct grey embed chromes with no ViewState painter (the
 * interstitial, the stale-resume embed, the divine ⚠️ System embed, both ❌ catches), the
 * nav + service button welding from `facts.nav`/`facts.actionId`, the public broadcast +
 * collapse announce (fed from `facts.collapse`), and the day-job menu-message stash.
 *
 * `engine` survives as a second constructor dep for exactly one read —
 * `engine.getMeta(META_RECAP_THREAD_ID)` — which has no seam equivalent (no facts key, no
 * `RouterBackend` method) and would otherwise silently stop the auto-finish broadcast from
 * reaching the weekly-recap thread. Every other engine-direct call (`startAction`,
 * `resumeAction`, `getCharacter`, `composeActionMenu`) is gone.
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

// Day-job menu ephemeral messages, keyed by userId, so the custom modal submit
// can delete them via webhook. Transport with no ViewState representation — stays here,
// stays exported (the dispatcher imports both).
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

export function makeActionCommand(router: GameRouter, engine: WorldEngine) {
  return async (interaction: ChatInputCommandInteraction): Promise<string> => {
    const description = interaction.options.getString('description');

    // Bare /action — the day-job menu / resume-in-progress arms (DC-P6's menu.open flow,
    // which stamps FIRST on every arm including the guard rejections).
    if (!description) {
      const response = await router.dispatch({ type: 'menu.open', playerId: interaction.user.id });

      if (response.ok) {
        const view = response.view;
        if (view?.screen === 'menu') {
          const m = menuViewToDiscord(view as MenuViewState);
          await interaction.reply({ embeds: m.embeds, components: m.components, flags: MessageFlags.Ephemeral });
          // Stash this menu so the Custom… handler can delete it.
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
          // DC-M9.2.3: composeActionMenu threw — the byte-identical day-job fallback copy.
          await interaction.reply(noticeViewToDiscord(view as NoticeViewState));
          return 'action_no_description';
        }
        await interaction.reply({ content: 'Something went wrong.', flags: MessageFlags.Ephemeral });
        return 'action_error';
      }

      // Guard rejections — no defer, a single ephemeral reply (DC-M9.2.6: the dead inner
      // rolls guard is not reproduced; these two are the only reachable guard arms).
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

    // /action <text> — action.custom. Deferred LAZILY, on the router's first beat (DC-M9.2
    // fix): the beat fires immediately before the slow runCustomAction call, so riding it
    // preserves the pre-port timing guarantee (beat Discord's 3s window) while every arm
    // that returns before any beat — the guard rejections and the resume arm — never pays
    // for a defer it doesn't need.
    // `onBeat` is `(beat) => void` and the router does NOT await it (DC-P5: beats are advisory,
    // the envelope is authoritative), so the defer+paint cannot be awaited inline. Holding its
    // promise and awaiting it below serialises interstitial-then-final exactly as the pre-port
    // sequential code did. Without that, a fast resolve could issue the final `editReply`
    // before the defer landed — which throws, and repaints a SUCCESSFUL action as an error.
    let beatPaint: Promise<void> | undefined;
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
    // Awaited outside any try, so an interstitial paint failure reaches the dispatcher's error
    // net (notifyAdmin + safeErrorReply) exactly as pre-port, never the `❌` branch below.
    if (beatPaint) await beatPaint;

    if (response.ok) {
      const view = response.view;
      if (view?.screen === 'decision') {
        // The resume arm (mid-action, any text) lands here too — ok:true, no beat, so
        // no beat fired, so `beatPaint` is undefined. Defer now, matching the pre-port block;
        // safe because no slow call has run yet on this arm.
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
        // through and repaint a successful action as "❌ Could not act" (transcript 9).
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

    // `beatPaint` is the phase signal: no beat fired means the error came from the pre-beat
    // half (beginCustomAction — no-character/no-rolls/resume-stale/a resume throw), a beat
    // means it came from the post-beat half (runCustomAction). M9.2 review fix: this used to
    // fall through unconditionally to the ❌ **Could not act.** catch below on an interaction
    // that was NEVER deferred (a resume throw on the ordinary D2 30-minute timeout has no
    // beat), which threw a raw discord.js error at the player and paged the admin for a
    // normal game event.
    if (!beatPaint) {
      // Guard rejections — no defer, a single plain ephemeral reply (DC-M9.2 fix: this used
      // to arrive here wrapped in the ❌ catch below, with an extra defer-then-edit round
      // trip; both were undeclared regressions since the pre-port top guard was a single
      // plain reply), matching the bare /action arm's own guard-rejection shape.
      // `illegal-move` joins this group at M9.3 (DC-M9.3.8/9): the profanity guard moved
      // into the router and now rejects on this same pre-beat path, so it paints identically
      // to the modal leaf's rejection rather than as a "Could not resume" failure.
      if (response.error.code === 'no-character' || response.error.code === 'no-rolls' || response.error.code === 'illegal-move') {
        await interaction.reply({ content: response.error.message, flags: MessageFlags.Ephemeral });
        if (response.error.code === 'no-character') return 'action_guard_no_character';
        if (response.error.code === 'no-rolls') return 'action_no_rolls';
        return 'action_guard_profanity';
      }

      // Everything else on this half (stale-session, a resume throw surfacing as 'internal')
      // defers first, mirroring the pre-port mid-action block's own deferReply-then-editReply
      // order.
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

    // Post-beat: the interstitial already deferred, so every arm here edits. Divine
    // intervention is a system fault, not a real action outcome — the distinct grey
    // ⚠️ System embed, no buttons, no broadcast/collapse (DC-M9.3).
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

    // The empty-action arm (DC-M9.2.4 class 4) and any other engine/router failure — both
    // only reachable after the beat has fired (they come out of runCustomAction).
    await interaction.editReply({ content: `❌ **Could not act.**\n${response.error.message}` });
    return 'action_error';
  };
}
