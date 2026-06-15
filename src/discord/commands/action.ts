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
  type ChatInputCommandInteraction,
  type MessageComponentInteraction,
} from 'discord.js';
import type { WorldEngine, ActionDecision } from '../../engine/WorldEngine.js';
import type { ActionStepResult } from '../../engine/WorldEngine.js';
import { formatOutcome, type OutcomeRenderContext } from '../../engine/OutcomeRenderer.js';
import { getDayJobActions, type DayJobDef } from './hi.js';

// ── Custom IDs ──

const CID_PREFIX = 'action:choice:';
const CID_BAIL = 'action:bail';
const CID_DAYJOB = 'action:dayjob:';

function choiceCid(decisionIdx: number, optionIdx: number): string {
  return `${CID_PREFIX}${decisionIdx}:${optionIdx}`;
}

// Track the most recent pending decision per user, so button clicks
// can look up the option label from the option index.
const pendingDecisions = new Map<string, ActionDecision>();

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
        ephemeral: true,
      });
      return 'action_guard_no_character';
    }

    // If mid-action, resume regardless of description
    if (character.lastActionState !== null) {
      await interaction.deferReply({ ephemeral: true });
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
        const scene = _sceneLookup?.(interaction.user.id);
        await interaction.editReply(buildDecisionMessage(resumeResult.nextDecision, decisionIdx, resumeResult.state, scene));
        return 'action_resumed';
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await interaction.editReply({ content: `❌ **Could not resume.**\n${msg}` });
        return 'action_error';
      }
    }

    // No description provided and not mid-action — show daily work list as buttons
    if (!description) {
      try {
        const jobActions = getDayJobActions(character.dayJob, dayJobs);
        const embed = new EmbedBuilder()
          .setTitle(`🔨 ${character.dayJob} — Daily Work`)
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

        await interaction.reply({
          embeds: [embed.toJSON()],
          components: [row.toJSON()],
          ephemeral: true,
        });
        return 'action_dayjob_menu';
      } catch {
        await interaction.reply({
          content: `🔨 **${character.dayJob}**\n\nUse \`/action <what you do>\` to start an action.`,
          ephemeral: true,
        });
        return 'action_no_description';
      }
    }

    // Defer first — LLM call can take >3 seconds
    await interaction.deferReply({ ephemeral: true });

    // Start the action
    try {
      const result = await engine.startAction(character.id, description);

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
      const scene = _sceneLookup?.(interaction.user.id);
      await interaction.editReply(buildDecisionMessage(result.firstDecision, 0, result.state, scene));
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
      ephemeral: true,
    });
    return;
  }
  const charId = character.id;

  // Defer the button click — stepAction calls LLM which can take >3 seconds.
  // Then immediately blank buttons to show "Thinking..." loading state.
  await i.deferUpdate();
  await i.editReply({
    embeds: [
      new EmbedBuilder()
        .setDescription('⏳ **Thinking…**')
        .setColor(0x95a5a6)
        .toJSON(),
    ],
    components: [],
  });

  // Bail — look up the actual bail option label from the pending decision
  if (i.customId === CID_BAIL) {
    try {
      const decision = pendingDecisions.get(i.user.id);
      const bailOption = decision?.options.find(o => o.dcModifier === null);
      const bailLabel = bailOption?.label ?? 'Bail';
      const result = await engine.stepAction(charId, bailLabel);
      await applyActionResult(i, result, engine);
    } catch (err) {
      await i.webhook.editMessage(i.message.id, {
        content: `❌ ${(err as Error).message}`,
        components: [],
        embeds: [],
      });
    }
    return;
  }

  // Choice — look up the option label from the stored pending decision
  const parsed = parseActionCid(i.customId);
  if (!parsed) return;

  const label = getChoiceLabel(i.user.id, parsed.optionIdx);
  if (!label) {
    await i.webhook.editMessage(i.message.id, {
      content: '❌ Your action session expired. Try `/action` again.',
      components: [],
      embeds: [],
    });
    return;
  }

  try {
    const result = await engine.stepAction(charId, label);
    await applyActionResult(i, result, engine);
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
): Promise<void> {
  if (result.resolved) {
    const character = engine.getCharacter(i.user.id);
    const outcome = result.outcome;

    const ctx: OutcomeRenderContext = {
      stamina: character?.stamina ?? 10,
      rollsRemaining: character?.rollsRemaining ?? 2,
      health: character?.health ?? 10,
      maxHealth: character?.maxHealth ?? 10,
      wealth: character?.wealth ?? 0,
    };

    const trail: string[] = [];
    trail.push(`**You:** ${result.state.rawInput}`);
    for (const d of result.state.decisions) {
      trail.push(`**Decision:** ${d.prompt}`);
      trail.push(`→ *${d.chosen}* (DC ${d.dcModifier >= 0 ? '+' : ''}${d.dcModifier})`);
    }
    trail.push('');
    trail.push(formatOutcome(outcome, ctx));

    await i.webhook.editMessage(i.message.id, {
      embeds: [
        new EmbedBuilder()
          .setTitle(`⚔️ ${capitalize(outcome.distilledType)}`)
          .setDescription(trail.join('\n'))
          .setColor(outcomeColor(outcome.outcome))
          .toJSON(),
      ],
      components: [],
    });
  } else {
    setPendingDecision(i.user.id, result.nextDecision);
    const decisionIdx = result.state.decisions.length;
    const scene = _sceneLookup?.(i.user.id);
    await i.webhook.editMessage(i.message.id, buildDecisionMessage(result.nextDecision, decisionIdx, result.state, scene));
  }
}

// ── Helpers ──

export function buildDecisionMessage(
  decision: { prompt: string; options: Array<{ label: string; dcModifier: number | null }> },
  decisionIdx: number,
  state?: { rawInput: string; decisions: Array<{ prompt: string; chosen: string; dcModifier: number }> },
  sceneBody?: string,
): {
  embeds: ReturnType<EmbedBuilder['toJSON']>[];
  components: ReturnType<ActionRowBuilder<ButtonBuilder>['toJSON']>[];
} {
  // Discord embed descriptions are capped at 4096 characters
  let description = decision.prompt;

  // Show action trail above the current decision
  if (state) {
    const trail: string[] = [];

    // Scene block at the very top
    if (sceneBody) {
      trail.push('```');
      trail.push(sceneBody);
      trail.push('```');
      trail.push('');
    }

    trail.push(`**You:** ${state.rawInput}`);
    for (const d of state.decisions) {
      trail.push(`→ *${d.chosen}* (DC ${d.dcModifier >= 0 ? '+' : ''}${d.dcModifier})`);
    }
    trail.push('');
    description = [...trail, decision.prompt].join('\n');
  }

  const truncated = description.length > 4000
    ? description.slice(0, 3997) + '...'
    : description;

  const embed = new EmbedBuilder()
    .setTitle('🤔 Decision')
    .setDescription(truncated)
    .setColor(0xdaa520)
    .setFooter({ text: decisionIdx === 0 ? 'Choose your approach' : `Decision ${decisionIdx + 1}` });

  const components: ActionRowBuilder<ButtonBuilder>[] = [];

  // Options as buttons (max 5 per row)
  // If LLM returned no options, fall back to a single Continue button
  const options = decision.options.length > 0 ? decision.options : [
    { label: 'Continue', dcModifier: 0 },
  ];

  for (let i = 0; i < options.length; i += 5) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (const opt of options.slice(i, i + 5)) {
      const isBail = opt.dcModifier === null;
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(isBail ? CID_BAIL : choiceCid(decisionIdx, i + options.indexOf(opt)))
          .setLabel(shortLabel(opt.label, 80))
          .setStyle(isBail ? ButtonStyle.Danger : ButtonStyle.Secondary),
      );
    }
    components.push(row);
  }

  return {
    embeds: [embed.toJSON()],
    components: components.map(r => r.toJSON()),
  };
}

function shortLabel(label: string, maxLen: number): string {
  return label.length > maxLen ? label.slice(0, maxLen - 1) + '…' : label;
}

function outcomeColor(outcome: string): number {
  switch (outcome) {
    case 'success': return 0x2ecc71;
    case 'failure': return 0xe74c3c;
    case 'skipped': return 0xf39c12;
    case 'timed_out': return 0x95a5a6;
    default: return 0x3498db;
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
