/**
 * Medium step (JSON-seam M2, see docs/engine/json-seam-build-plans.md) — the sole place that
 * knows about `discord.js`. Takes a semantic `ViewState` (from `src/view/viewState.ts`,
 * assembled by `buildDecisionView`/`buildOutcomeView` in `action.ts`) and produces Discord
 * embed/component JSON: the block join, the embed-length degradation ladder, all
 * `EmbedBuilder`/`ButtonBuilder`/`ActionRowBuilder` construction, and the colour-intent→hex
 * mapping. Behaviour must stay byte-identical to the pre-M2 `buildDecisionMessage`/
 * `buildOutcomeEmbed` bodies this was ported from.
 */

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import type { DecisionViewState, OutcomeViewState, ViewColorIntent } from '../view/viewState.js';
import { clip, MAX_EMBED_DESC, outcomeColor } from './commands/action.js';

/** Opening-frame chrome — medium chrome, never a semantic choice (M2 design call), so it stays
 *  internal to this step rather than living in `ViewColorIntent`. */
const OPENING_FRAME_COLOR = 0x2c2f33;

/** Decision embeds always use this fixed hex — the constant `outcomeColor` has no case for. */
const DECISION_COLOR = 0xdaa520;

/** Colour-intent→hex mapping: the decision constant plus `outcomeColor`'s exact switch for
 *  every outcome-derived intent (including 'default', which falls through `outcomeColor`'s
 *  own `default:` case to the same 0x3498db). */
function colorIntentToHex(intent: ViewColorIntent): number {
  if (intent === 'decision') return DECISION_COLOR;
  return outcomeColor(intent);
}

export function decisionViewToDiscord(view: DecisionViewState): {
  embeds: ReturnType<EmbedBuilder['toJSON']>[];
  components: ReturnType<ActionRowBuilder<ButtonBuilder>['toJSON']>[];
} {
  const blocks: string[] = [];
  if (view.storyThread) blocks.push(view.storyThread.full);
  if (view.narration) blocks.push(view.narration);
  if (view.combatStatus) blocks.push(view.combatStatus);
  blocks.push(view.prompt);

  // Fit the embed cap, degrading gracefully: full gamebook → collapse history to
  // a breadcrumb → hard clip. Buttons live in `components` (always present), so a
  // hard clip of the option text never disables the choices.
  const optionsTail = view.optionLines.length > 0 ? `\n\n${view.optionLines.join('\n')}` : '';
  let truncated = blocks.join('\n\n') + optionsTail;
  if (truncated.length > MAX_EMBED_DESC && view.storyThread) {
    truncated = [view.storyThread.collapsed, view.prompt].join('\n\n') + optionsTail;
  }
  if (truncated.length > MAX_EMBED_DESC) truncated = clip(truncated, MAX_EMBED_DESC);

  const embed = new EmbedBuilder()
    .setTitle(`${view.title.emoji} ${view.title.text}`)
    .setDescription(truncated)
    .setColor(colorIntentToHex(view.colorIntent))
    .setFooter({ text: view.footer });

  // Buttons — max 5 per row.
  const buttons: ButtonBuilder[] = view.buttons.map(item => item.kind === 'bail'
    ? new ButtonBuilder()
      .setCustomId(item.customId)
      .setLabel(item.label)
      .setStyle(ButtonStyle.Danger)
    : new ButtonBuilder()
      .setCustomId(item.customId)
      .setLabel(item.letter)
      // Passive insight tints the one route it senses is clearly safest.
      .setStyle(item.favoured ? ButtonStyle.Success : ButtonStyle.Secondary));

  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < buttons.length; i += 5) {
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons.slice(i, i + 5)),
    );
  }

  const openingFrameEmbed = view.openingFrame
    ? new EmbedBuilder()
      .setDescription(view.openingFrame)
      .setColor(OPENING_FRAME_COLOR)
      .toJSON()
    : undefined;

  return {
    embeds: openingFrameEmbed ? [openingFrameEmbed, embed.toJSON()] : [embed.toJSON()],
    components: components.map(r => r.toJSON()),
  };
}

export function outcomeViewToDiscord(view: OutcomeViewState): ReturnType<EmbedBuilder['toJSON']> {
  // Full gamebook recap: breadcrumb, destination scene, story thread, then the resolution as
  // focal unquoted text. Degrade to fit the embed cap: full → collapse history → drop the
  // decorative scene → hard clip.
  const assemble = (collapseHistory: boolean, includeScene: boolean): string => {
    const parts: string[] = [];
    if (view.locationLine) parts.push(view.locationLine);
    if (view.breadcrumb) parts.push(view.breadcrumb);
    // Combat outcomes show the combat opening frame (enemy nameplate + HP bars) instead of
    // the plain location scene — the terminal card already covers the dice reveal, so the
    // combat frame provides visual context without duplicating information. (0.3.2 P2)
    if (includeScene) {
      if (view.isCombat) {
        if (view.combatSceneBlock) parts.push(view.combatSceneBlock);
      } else if (view.sceneBlock) {
        parts.push(view.sceneBlock);
      }
    }
    if (view.storyThread) {
      parts.push(collapseHistory ? view.storyThread.collapsed : view.storyThread.full);
    }
    parts.push(view.outcomeBlock);
    return parts.join('\n\n');
  };

  let description = assemble(false, true);
  if (description.length > MAX_EMBED_DESC) description = assemble(true, true);
  if (description.length > MAX_EMBED_DESC) description = assemble(true, false);
  if (description.length > MAX_EMBED_DESC) description = clip(description, MAX_EMBED_DESC);

  return new EmbedBuilder()
    .setTitle(`${view.title.emoji} ${view.title.text}`)
    .setDescription(description)
    .setColor(colorIntentToHex(view.colorIntent))
    .toJSON();
}
