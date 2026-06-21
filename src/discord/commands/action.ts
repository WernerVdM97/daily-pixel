/**
 * /action — take an action in the world.
 *
 * Flow:
 *   1. Slash command `/action <description>` → starts the action state machine
 *      → shows the first decision prompt with option buttons
 *   2. Button click → steps the machine → next decision or final outcome
 *
 * Interaction routing handled by main Events.InteractionCreate in index.ts
 * via the `action:` custom ID prefix.
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
import type { WorldEngine, ActionDecision, ActionOutcome, CharacterData } from '../../engine/WorldEngine.js';
import type { ActionStepResult } from '../../engine/WorldEngine.js';
import { formatOutcome, distilledActionEmoji, type OutcomeRenderContext } from '../../engine/OutcomeRenderer.js';
import { randomIdleMessage } from '../../engine/IdleMessageSelector.js';
import { getDayJobActions, dayJobEmoji, type DayJobDef } from './hi.js';
import { getNavButtons, getOutcomeServiceButtons, classEmoji } from '../format.js';
import { announceCollapse } from '../collapse.js';

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

// Track the most recent pending decision per user, so button clicks
// can look up the option label from the option index.
const pendingDecisions = new Map<string, ActionDecision>();

// Track day-job menu ephemeral messages so the custom modal submit can delete them.
// Keyed by userId → { interaction token info needed for webhook delete }
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
  // If the LLM returned no options, use a fallback so the stored
  // decision matches what buildDecisionMessage renders.
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

    // Guard: must have a character
    const character = engine.getCharacter(interaction.user.id);
    if (!character) {
      await interaction.reply({
        content: "You don't have a character yet. Type `/join` to create one.",
        flags: MessageFlags.Ephemeral,
      });
      return 'action_guard_no_character';
    }

    // Guard: no rolls left (except for resume)
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

        // If the pending decision has no options (stale/broken state), show prompt + warn
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

    // No description provided and not mid-action — show daily work list as buttons
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

    // Defer first — LLM call can take >3 seconds.
    // Immediately edit with an idle message so the player isn't staring at a blank spinner.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setDescription(`**You:** ${description}\n\n⏳ **Starting…**\n_${randomIdleMessage()}_`)
          .setColor(0x95a5a6)
          .toJSON(),
      ],
    });

    // Start the action
    try {
      const result = await engine.startAction(character.id, description);

      // Auto-finish: the LLM resolved the action outright (travel/rest). Render the
      // outcome directly — no buttons, no red "Step back".
      if (result.outcome) {
        const resolvedChar = engine.getCharacter(interaction.user.id);
        const scene = getCurrentScene(interaction.user.id);
        const embed = buildOutcomeEmbed(result.outcome, resolvedChar, scene, result.state);
        await interaction.editReply({ embeds: [embed], components: [] });
        await interaction.followUp({
          content: `${classEmoji(resolvedChar?.class)} **${resolvedChar?.name ?? 'Unknown'}** — ${result.outcome.distilledType}`,
          embeds: [embed],
          ...(resolvedChar
            ? { components: [...getNavButtons(resolvedChar), ...getOutcomeServiceButtons()] }
            : { components: getOutcomeServiceButtons() }),
        });
        await announceCollapse(resolvedChar?.name ?? 'A soul', character, resolvedChar);
        return 'action_autofinished';
      }

      // If the LLM returned done: true immediately (divine intervention), show the prompt as a grey embed
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
  // Look up character ID from Discord user
  const character = engine.getCharacter(i.user.id);
  if (!character) {
    await i.reply({
      content: "You don't have a character. Type `/join` first.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const charId = character.id;

  // Defer immediately — stepAction calls the LLM, which can take >3 seconds.
  // Resolve which option the player picked first so the loading screen can echo
  // their choice instead of a bare "Thinking…".
  await i.deferUpdate();

  let label: string | null;
  if (i.customId === CID_BAIL) {
    // Bail — the real label comes from the pending decision's bail option.
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

  // Blank the buttons and show the player's choice with a "Thinking…" line below it.
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

    // Show the destination scene when the character moved
    const scene = _sceneLookup?.(i.user.id);
    const outcomeEmbed = buildOutcomeEmbed(outcome, character, scene, result.state);

    // Update the private message
    await i.webhook.editMessage(i.message.id, {
      embeds: [outcomeEmbed],
      components: [],
    });

    // Post a public copy to the channel — with nav buttons that spawn a fresh
    // ephemeral screen for whoever clicks (handled in the nav: dispatcher).
    const charName = character?.name ?? 'Unknown';
    await i.followUp({
      content: `${classEmoji(character?.class)} **${charName}** — ${outcome.distilledType}`,
      embeds: [outcomeEmbed],
      ...(character
        ? { components: [...getNavButtons(character), ...getOutcomeServiceButtons()] }
        : { components: getOutcomeServiceButtons() }),
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
 *  insight will flag it — keeps the green hint a rare, earned tell. */
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
 * Qualitative difficulty arrow for a choice's DC modifier — no raw numbers.
 * A negative modifier lowered the DC (easier → green down); a positive one
 * raised it (harder → red up); zero shows nothing. (Flip the two glyphs here to
 * reverse the convention.)
 */
function dcArrow(mod: number | null | undefined): string {
  if (mod == null || mod === 0) return '';
  return mod < 0 ? '🟢⬇️' : '🔴⬆️';
}

/**
 * Render the encounter "story so far" as a gamebook thread: the quest line,
 * then each prior beat as the DM's prompt (quoted) followed by the player's
 * choice (bold). `collapse` drops the prompt bodies down to a choice-only
 * breadcrumb — the graceful-degradation form used when the full thread would
 * overflow the embed description cap.
 */
function buildStoryThread(
  rawInput: string,
  decisions: Array<{ prompt: string; chosen: string; dcModifier?: number }>,
  collapse = false,
): string {
  const out = [`> 🧭 **Quest:** ${rawInput}`];
  for (const d of decisions) {
    // A green/red arrow flags whether the choice was easier or harder (no raw DC).
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
  state?: { rawInput: string; decisions: Array<{ prompt: string; chosen: string; dcModifier: number }>; accumulatedDc?: number },
  char?: { stats: { physical: number; wisdom: number; intelligence: number; charisma: number } },
): {
  embeds: ReturnType<EmbedBuilder['toJSON']>[];
  components: ReturnType<ActionRowBuilder<ButtonBuilder>['toJSON']>[];
} {
  // Raw DCs stay hidden — the player shouldn't read the dice while deciding.
  // Instead, passive insight (10 + WIS, a D&D-style passive check) occasionally
  // lets a perceptive character spot the single safest route. The hint must be
  // earned (see INSIGHT_MARGIN below), not a constant readout.
  const runningDc = state?.accumulatedDc;
  const passiveInsight = char ? 10 + char.stats.wisdom : undefined;

  // ── Gamebook layout — the story so far (quest + prior beats, DM prompts
  // quoted, player choices bold) above the current scene, also quoted as DM
  // narration. The lettered options below are the only unquoted, actionable
  // text. Mirrors the outcome recap so the whole /action flow reads as one
  // continuous gamebook page. ──
  const blocks: string[] = [];
  if (state) {
    blocks.push(buildStoryThread(state.rawInput, state.decisions));
  }
  blocks.push(quoteLines(decision.prompt));

  // List the real (non-bail) options in the body as A. / B. / C. so button
  // captions can be just the letter — nothing truncates on mobile.
  // If the LLM returned no options, fall back to a single Continue option.
  const options = decision.options.length > 0
    ? decision.options
    : [{ label: 'Continue', dcModifier: 0 }];

  // Decide whether insight warrants a hint, and on which single option. It only
  // fires when ALL hold: we know the DCs, the character is perceptive enough to
  // reach the easiest option (passive insight ≥ its DC), and that option is
  // clearly safer than the next-best (≥ INSIGHT_MARGIN). Otherwise no hint — so
  // it's a rare, earned tell, never an always-on DC reveal.
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

  // Preserve each option's original index for the customId — handleActionChoice
  // looks the label up by index against the stored pending decision.
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

  // Fit the embed description cap, degrading gracefully: full gamebook →
  // collapse the history to a choice breadcrumb → hard clip. The clickable
  // buttons live in `components` (always present), so even a hard clip of the
  // option text below never disables the choices.
  const optionsTail = optionLines.length > 0 ? `\n\n${optionLines.join('\n')}` : '';
  let truncated = blocks.join('\n\n') + optionsTail;
  if (truncated.length > MAX_EMBED_DESC && state) {
    truncated = [buildStoryThread(state.rawInput, state.decisions, true), quoteLines(decision.prompt)]
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
 *  resolution path and the start-time auto-finish path. */
export function buildOutcomeEmbed(
  outcome: ActionOutcome,
  character: CharacterData | null | undefined,
  scene: string | null | undefined,
  state: { rawInput: string; decisions: Array<{ prompt: string; chosen: string; dcModifier: number; distilledType?: string }> },
): ReturnType<EmbedBuilder['toJSON']> {
  const ctx: OutcomeRenderContext = {
    stamina: character?.stamina ?? 10,
    maxStamina: character?.maxStamina ?? 10,
    rollsRemaining: character?.rollsRemaining ?? 2,
    health: character?.health ?? 10,
    maxHealth: character?.maxHealth ?? 10,
    wealth: character?.wealth ?? 0,
  };

  // Breadcrumb of the distilled actions the player moved through, e.g. 🔍 → 🗣️ → ⚔️.
  const types = state.decisions.length > 0
    ? state.decisions.map(d => d.distilledType).filter((t): t is string => !!t)
    : [outcome.distilledType];
  const breadcrumb = types.map(distilledActionEmoji).join(' → ');

  const sceneBlock = scene ? '```\n' + scene + '\n```' : '';
  const outcomeBlock = formatOutcome(outcome, ctx);

  // Full gamebook recap: the action-type breadcrumb, the destination scene, then
  // the story thread (quest + each beat's DM prompt quoted, player choice bold),
  // and finally the resolution as the focal unquoted text. Degrade gracefully to
  // fit the 4096-char embed cap: full → collapse history to a choice breadcrumb →
  // drop the decorative scene → hard clip.
  const assemble = (collapseHistory: boolean, includeScene: boolean): string => {
    const parts: string[] = [];
    if (breadcrumb) parts.push(breadcrumb);
    if (includeScene && sceneBlock) parts.push(sceneBlock);
    parts.push(buildStoryThread(state.rawInput, state.decisions, collapseHistory));
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
