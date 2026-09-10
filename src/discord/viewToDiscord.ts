/**
 * Medium step (JSON-seam M2, see docs/engine/json-seam-build-plans.md) — the sole place that
 * knows about `discord.js`. Takes a semantic `ViewState` (from `src/view/viewState.ts`,
 * assembled by `buildDecisionView`/`buildOutcomeView` in `action.ts`) and produces Discord
 * embed/component JSON: the block join, the embed-length degradation ladder, all
 * `EmbedBuilder`/`ButtonBuilder`/`ActionRowBuilder` construction, and the colour-intent→hex
 * mapping. Behaviour must stay byte-identical to the pre-M2 `buildDecisionMessage`/
 * `buildOutcomeEmbed` bodies this was ported from.
 */

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } from 'discord.js';
import type { CommuteViewState, DecisionViewState, LoadingViewState, MenuViewState, NoticeViewState, OutcomeViewState, ViewColorIntent, WizardViewState } from '../view/viewState.js';
import { clip, MAX_EMBED_DESC, outcomeColor } from '../render/embedText.js';
import { OAK_IMAGE, imageFiles, hasImage } from './images.js';

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

/** Maps the day-job menu to the exact embed+button-row JSON both the `nav:action` leaf and
 *  the slash `/action` no-description path built inline before M3.3b. */
export function menuViewToDiscord(view: MenuViewState): {
  embeds: ReturnType<EmbedBuilder['toJSON']>[];
  components: ReturnType<ActionRowBuilder<ButtonBuilder>['toJSON']>[];
} {
  const embed = new EmbedBuilder()
    .setTitle(`${view.title.emoji} ${view.title.text}`)
    .setDescription(view.description)
    .setColor(0xdaa520)
    .toJSON();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...view.buttons.map(b => new ButtonBuilder()
      .setCustomId(b.customId)
      .setLabel(b.label)
      .setStyle(b.style === 'primary' ? ButtonStyle.Primary : ButtonStyle.Secondary)),
  );

  return { embeds: [embed], components: [row.toJSON()] };
}

/** Maps a notice view to the exact `interaction.reply(...)` payload shape the four
 *  feedback/bug modal-submit leaves used inline before M3.1. */
export function noticeViewToDiscord(view: NoticeViewState): { content: string; flags?: MessageFlags.Ephemeral } {
  return view.ephemeral
    ? { content: view.text, flags: MessageFlags.Ephemeral }
    : { content: view.text };
}

/** Maps a loading view to the plain grey "please wait" embed the day-job work flow's
 *  "Starting…" beat used inline before M3.4. */
export function loadingViewToDiscord(view: LoadingViewState): {
  embeds: ReturnType<EmbedBuilder['toJSON']>[];
  components: ReturnType<ActionRowBuilder<ButtonBuilder>['toJSON']>[];
} {
  return {
    embeds: [new EmbedBuilder().setDescription(view.body).setColor(0x95a5a6).toJSON()],
    components: [],
  };
}

/** Maps the day-job work flow's transient commute beat to the exact "🚶 Daily Commute" embed
 *  used inline before M3.4 — note the two trailing spaces after the first sentence (a
 *  deliberate Discord hard-line-break, not a typo). */
export function commuteViewToDiscord(view: CommuteViewState): {
  embeds: ReturnType<EmbedBuilder['toJSON']>[];
  components: ReturnType<ActionRowBuilder<ButtonBuilder>['toJSON']>[];
} {
  return {
    embeds: [
      new EmbedBuilder()
        .setTitle('🚶 Daily Commute')
        .setDescription(
          `**You head to the ${view.destination}.**  \n⚡ -1 stamina\n\n⏳ **Setting to work…**\n_${view.idle}_`,
        )
        .setColor(0x95a5a6)
        .toJSON(),
    ],
    components: [],
  };
}

/** Wizard-screen button chrome (M7.3, DC-M7.3.3): the customIds and styles the semantic
 *  `WizardViewState.buttons` weld to — join:name Primary, join:choice:<step>:<value>
 *  Secondary, join:confirm Success, join:restart Danger. */
function wizardButton(b: WizardViewState['buttons'][number]): ButtonBuilder {
  switch (b.kind) {
    case 'name':
      return new ButtonBuilder()
        .setCustomId('join:name')
        .setLabel(b.label)
        .setEmoji(b.emoji)
        .setStyle(ButtonStyle.Primary);
    case 'choice': {
      const btn = new ButtonBuilder()
        .setCustomId(`join:choice:${b.step}:${b.value}`)
        .setLabel(b.label)
        .setStyle(ButtonStyle.Secondary);
      if (b.emoji) btn.setEmoji(b.emoji);
      return btn;
    }
    case 'confirm':
      return new ButtonBuilder()
        .setCustomId('join:confirm')
        .setLabel(b.label)
        .setEmoji(b.emoji)
        .setStyle(ButtonStyle.Success);
    case 'restart':
      return new ButtonBuilder()
        .setCustomId('join:restart')
        .setLabel(b.label)
        .setEmoji(b.emoji)
        .setStyle(ButtonStyle.Danger);
  }
}

/** Maps the wizard view to the exact embed+button-row JSON the pre-seam `buildStepMessage`
 *  produced (M7.3, DC-M7.3.3) — title "⚔️  Forge Your Hero" with the DOUBLE SPACE pinned
 *  verbatim (M7.0 transcript 1 asserts it), goldenrod 0xdaa520, Oak thumbnail + files. The
 *  ledger + body rejoin with the same `\n\n` the old description used; choice buttons chunk
 *  ≤5/row with the restart button in its OWN final row (transcripts 1-8 pin the layout
 *  byte-for-byte — the walk steps' Start Over was always a separate row). */
export function wizardViewToDiscord(view: WizardViewState): {
  embeds: ReturnType<EmbedBuilder['toJSON']>[];
  components: ReturnType<ActionRowBuilder<ButtonBuilder>['toJSON']>[];
  files: ReturnType<typeof imageFiles>;
} {
  const embed = new EmbedBuilder()
    .setTitle('⚔️  Forge Your Hero')
    .setColor(0xdaa520); // goldenrod
  if (hasImage(OAK_IMAGE)) embed.setThumbnail(`attachment://${OAK_IMAGE}`);
  embed.setDescription([view.ledger, view.body].join('\n\n'));
  embed.setFooter({ text: view.footer });

  // Choice buttons chunked ≤5/row (Discord's cap); the non-choice buttons (name on step 1,
  // confirm+restart on step 8, restart alone on steps 2-7) sit in ONE final row — exactly
  // the old builder's layout (transcripts 1-8 pin it byte-for-byte).
  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  const choices = view.buttons.filter(b => b.kind === 'choice');
  const others = view.buttons.filter(b => b.kind !== 'choice');
  for (let i = 0; i < choices.length; i += 5) {
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...choices.slice(i, i + 5).map(wizardButton)));
  }
  if (others.length > 0) {
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...others.map(wizardButton)));
  }

  return {
    embeds: [embed.toJSON()],
    components: components.map(r => r.toJSON()),
    files: imageFiles(OAK_IMAGE),
  };
}
