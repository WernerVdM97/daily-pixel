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
import type { WorldEngine, ActionDecision, ActionOutcome, ActionKind, CharacterData } from '../../engine/WorldEngine.js';
import type { ActionStepResult } from '../../engine/WorldEngine.js';
import { formatOutcome, distilledActionEmoji, type OutcomeRenderContext } from '../../engine/OutcomeRenderer.js';
import { randomIdleMessage } from '../../engine/IdleMessageSelector.js';
import { getDayJobActions, type DayJobDef } from './hi.js';
import { getNavButtons, getOutcomeServiceButtons, getPublicOutcomeButtons, classEmoji, dayJobEmoji } from '../format.js';
import { announceCollapse } from '../collapse.js';
import { broadcastOutcome, META_RECAP_THREAD_ID } from '../weekly-recap.js';

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
          await interaction.editReply({
            embeds: [
              new EmbedBuilder()
                .setTitle('⏳ Stale Action')
                .setDescription(resumeResult.nextDecision.prompt || 'Your previous action could not be recovered.')
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
        const embed = new EmbedBuilder()
          .setTitle(`${dayJobEmoji(character.dayJob)} ${character.dayJob} — Daily Work`)
          .setDescription('Pick a task to start:')
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

      // done:true immediately (divine intervention) — show the prompt as a grey embed.
      if (result.firstDecision.options.length === 0) {
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle('⚔️ Action')
              .setDescription(result.firstDecision.prompt)
              .setColor(0x95a5a6)
              .toJSON(),
          ],
          components: [],
        });
        return 'action_divine';
      }

      setPendingDecision(interaction.user.id, result.firstDecision);
      await interaction.editReply(buildDecisionMessage(result.firstDecision, 0, result.state, character));
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
 * lowered the DC (easier → green down), positive raised it (harder → red up),
 * zero shows nothing.
 */
function dcArrow(mod: number | null | undefined): string {
  if (mod == null || mod === 0) return '';
  return mod < 0 ? '🟢⬇️' : '🔴⬆️';
}

/**
 * Render the "story so far" as a gamebook thread: the quest line, then each
 * prior beat as the DM's prompt (quoted) plus the player's choice (bold).
 * `collapse` drops prompt bodies to a choice-only breadcrumb — the
 * graceful-degradation form for when the full thread overflows the embed cap.
 */
function buildStoryThread(
  rawInput: string,
  decisions: Array<{ prompt: string; chosen: string; dcModifier?: number }>,
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
      out.push(quoteLines(d.prompt));
      out.push(`↪ **${choice}**`);
    }
  }
  return out.join('\n');
}

export function buildDecisionMessage(
  decision: { prompt: string; options: Array<{ label: string; dcModifier: number | null }> },
  decisionIdx: number,
  state?: { rawInput: string; decisions: Array<{ prompt: string; chosen: string; dcModifier: number }>; accumulatedDc?: number; kind?: ActionKind },
  char?: { stats: { physical: number; wisdom: number; intelligence: number; charisma: number }; dayJob?: string },
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
      optionLines.push(`**${letter}.** ${opt.label}${favoured ? ' 🟢' : ''}`);
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
    ? '🟢 a safer path catches your eye'
    : (decisionIdx === 0 ? 'Choose your approach' : `Decision ${decisionIdx + 1}`);

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

  return {
    embeds: [embed.toJSON()],
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
  state: { rawInput: string; decisions: Array<{ prompt: string; chosen: string; dcModifier: number; distilledType?: string }>; kind?: ActionKind },
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
  const outcomeBlock = formatOutcome(outcome, ctx);
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
    if (includeScene && sceneBlock) parts.push(sceneBlock);
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
