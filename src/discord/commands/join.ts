import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
} from "discord.js";
import type { WorldEngine } from "../../engine/WorldEngine.js";
import type { WizardSession, WizardState } from "../WizardSession.js";

// ── Custom IDs ──

const CID_NAME_BUTTON = "join:name";
const CID_NAME_MODAL = "join:name:modal";
const CID_NAME_INPUT = "join:name:input";
const CID_PREFIX = "join:choice:";
const CID_CONFIRM = "join:confirm";
const CID_START_OVER = "join:restart";

function choiceCid(step: number, value: string): string {
  return `${CID_PREFIX}${step}:${value}`;
}

function parseChoiceCid(
  customId: string,
): { step: number; value: string } | null {
  if (!customId.startsWith(CID_PREFIX)) return null;
  const rest = customId.slice(CID_PREFIX.length);
  const colonIdx = rest.indexOf(":");
  if (colonIdx === -1) return null;
  return {
    step: parseInt(rest.slice(0, colonIdx), 10),
    value: rest.slice(colonIdx + 1),
  };
}

// ── Factory ──

export function makeJoinCommand(engine: WorldEngine, wizards: WizardSession) {
  return async (interaction: ChatInputCommandInteraction): Promise<string> => {
    // Guard: already has a character?
    if (engine.characterExists(interaction.user.id)) {
      await interaction.reply({
        content: "You already have a character. Type `/stats` to see it.",
        ephemeral: true,
      });
      return "join_guard_has_character";
    }

    // Start or resume wizard
    let state: WizardState;
    try {
      state = wizards.start(interaction.user.id);
    } catch {
      // Already in a wizard — resume
      const existing = wizards.getSession(interaction.user.id);
      if (!existing || wizards.isExpired(interaction.user.id)) {
        wizards.reset(interaction.user.id);
        state = wizards.start(interaction.user.id);
      } else {
        state = existing;
      }
    }

    // Show current step
    await interaction.reply(buildStepMessage(state));

    // Collector for button/modal interactions
    const collector = interaction.channel!.createMessageComponentCollector({
      filter: (i: MessageComponentInteraction) =>
        i.user.id === interaction.user.id,
      time: 10 * 60 * 1000, // 10 min
    });

    collector.on(
      "collect",
      async (i: MessageComponentInteraction | ModalSubmitInteraction) => {
        try {
          await handleInteraction(i, engine, wizards, interaction);
        } catch (e) {
          console.error(e);
          // If the session expired or was deleted, tell the user
          if (i.isRepliable()) {
            await i
              .reply({
                content: "Something went wrong. Try `/join` again.",
                ephemeral: true,
              })
              .catch(() => {});
          }
        }
      },
    );

    collector.on("end", async (_, reason) => {
      if (reason === "time") {
        wizards.reset(interaction.user.id);
        await interaction
          .editReply({
            content:
              "⏰ Character creation timed out. Type `/join` to start over.",
            components: [],
            embeds: [],
          })
          .catch(() => {});
      }
    });

    return "join_wizard_started";
  };
}

// ── Interaction handler ──

async function handleInteraction(
  i: MessageComponentInteraction | ModalSubmitInteraction,
  engine: WorldEngine,
  wizards: WizardSession,
  original: ChatInputCommandInteraction,
): Promise<void> {
  const userId = i.user.id;

  // Modal submission for name
  if (i.isModalSubmit() && i.customId === CID_NAME_MODAL) {
    const name = i.fields.getTextInputValue(CID_NAME_INPUT);
    try {
      const state = wizards.setName(userId, name);
      await i.deferUpdate();
      await original.editReply(buildStepMessage(state));
    } catch (e) {
      if (i.isRepliable() && !i.replied && !i.deferred) {
        await i.reply({
          content: `❌ ${(e as Error).message}`,
          ephemeral: true,
        });
      }
    }
    return;
  }

  // Modal submission for other modals (none yet, but safe to ignore)
  if (i.isModalSubmit()) return;

  // Button: open name modal
  if (i.customId === CID_NAME_BUTTON) {
    await i.showModal(buildNameModal());
    return;
  }

  // Button: choice (steps 2-6)
  const parsed = parseChoiceCid(i.customId);
  if (parsed) {
    const fieldMap: Record<
      number,
      "class" | "upbringing" | "race" | "alignment" | "dayJob"
    > = {
      2: "class",
      3: "upbringing",
      4: "race",
      5: "alignment",
      6: "dayJob",
    };
    const field = fieldMap[parsed.step];
    if (field) {
      try {
        const state = wizards.choose(userId, parsed.step, field, parsed.value);
        await i.update(buildStepMessage(state));
      } catch (e) {
        await i.reply({
          content: `❌ ${(e as Error).message}`,
          ephemeral: true,
        });
      }
    }
    return;
  }

  // Button: confirm
  if (i.customId === CID_CONFIRM) {
    try {
      const data = wizards.confirm(userId);
      engine.createCharacter(userId, data);

      await i.update({
        embeds: [
          new EmbedBuilder()
            .setTitle("✨ Character Created!")
            .setDescription(
              `**${data.name}** the ${data.race} ${data.class}\n` +
                `${data.alignment} • ${data.upbringing} upbringing • ${data.dayJob}\n\n` +
                `Type \`/stats\` to see your character sheet.\n` +
                `Type \`/hi\` to begin your adventure.`,
            )
            .setColor(0x2ecc71)
            .toJSON(),
        ],
        components: [],
      });
    } catch (e) {
      await i.reply({ content: `❌ ${(e as Error).message}`, ephemeral: true });
    }
    return;
  }

  // Button: start over
  if (i.customId === CID_START_OVER) {
    wizards.reset(userId);
    const state = wizards.start(userId);
    await i.update(buildStepMessage(state));
    return;
  }
}

// ── Message builders ──

function buildStepMessage(state: WizardState): {
  embeds: ReturnType<EmbedBuilder["toJSON"]>[];
  components: ReturnType<ActionRowBuilder<ButtonBuilder>["toJSON"]>[];
} {
  const embed = new EmbedBuilder()
    .setTitle("Character Creation")
    .setColor(0xdaa520); // goldenrod

  let description = "";
  const stepLabel = (n: number, label: string) =>
    state.step === n ? `**▶ ${label}**` : `✓ ${label}`;

  description += `${stepLabel(1, "Name")}${state.name ? ` — ${state.name}` : ""}\n`;
  description += `${stepLabel(2, "Class")}${state.class ? ` — ${state.class}` : ""}\n`;
  description += `${stepLabel(3, "Upbringing")}${state.upbringing ? ` — ${state.upbringing}` : ""}\n`;
  description += `${stepLabel(4, "Race")}${state.race ? ` — ${state.race}` : ""}\n`;
  description += `${stepLabel(5, "Alignment")}${state.alignment ? ` — ${state.alignment}` : ""}\n`;
  description += `${stepLabel(6, "Day Job")}${state.dayJob ? ` — ${state.dayJob}` : ""}\n`;

  embed.setDescription(description + "\n───────────────");

  const components: ActionRowBuilder<ButtonBuilder>[] = [];

  if (state.step === 1) {
    embed.setFooter({
      text: "Step 1 of 6 — Choose a name (2-30 characters, no @ or #)",
    });
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(CID_NAME_BUTTON)
          .setLabel("Enter Name")
          .setStyle(ButtonStyle.Primary),
      ),
    );
  }

  if (state.step >= 2 && state.step <= 6) {
    const stepData = STEP_DEFS[state.step];
    if (stepData) {
      embed.setFooter({ text: `Step ${state.step} of 6 — ${stepData.label}` });
      const row = new ActionRowBuilder<ButtonBuilder>();
      for (const opt of stepData.options) {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(choiceCid(state.step, opt.value))
            .setLabel(opt.label)
            .setStyle(ButtonStyle.Secondary),
        );
      }
      components.push(row);
    }
  }

  if (state.step === 7) {
    embed.setFooter({ text: "Review your choices and confirm" });
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(CID_CONFIRM)
          .setLabel("✅ Confirm")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(CID_START_OVER)
          .setLabel("🔄 Start Over")
          .setStyle(ButtonStyle.Danger),
      ),
    );
  }

  return {
    embeds: [embed.toJSON()],
    components: components.map((r) => r.toJSON()),
  };
}

function buildNameModal(): ModalBuilder {
  const input = new TextInputBuilder()
    .setCustomId(CID_NAME_INPUT)
    .setLabel("Character Name")
    .setPlaceholder("Enter a name (2-30 characters)")
    .setMinLength(2)
    .setMaxLength(30)
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  return new ModalBuilder()
    .setCustomId(CID_NAME_MODAL)
    .setTitle("Name Your Character")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(input),
    );
}

// ── Step definitions — hardcoded for S1 (YAML loading deferred to S2) ──

interface StepDef {
  label: string;
  options: { label: string; value: string }[];
}

const STEP_DEFS: Record<number, StepDef> = {
  2: {
    label: "Choose your class",
    options: [
      { label: "⚔️ Warrior", value: "Warrior" },
      { label: "🏹 Ranger", value: "Ranger" },
      { label: "🔮 Wizard", value: "Wizard" },
      { label: "🎵 Bard", value: "Bard" },
      { label: "✝️ Priest", value: "Priest" },
    ],
  },
  3: {
    label: "Choose your upbringing",
    options: [
      { label: "Soldier", value: "Soldier" },
      { label: "Merchant", value: "Merchant" },
      { label: "Scholar", value: "Scholar" },
      { label: "Folk Hero", value: "Folk Hero" },
      { label: "Outcast", value: "Outcast" },
      { label: "Noble", value: "Noble" },
    ],
  },
  4: {
    label: "Choose your race",
    options: [
      { label: "Human", value: "Human" },
      { label: "Dwarf", value: "Dwarf" },
      { label: "Elf", value: "Elf" },
      { label: "Halfling", value: "Halfling" },
    ],
  },
  5: {
    label: "Choose your alignment",
    options: [
      { label: "Lawful Good", value: "lawful good" },
      { label: "Neutral Good", value: "neutral good" },
      { label: "Chaotic Good", value: "chaotic good" },
      { label: "Lawful Neutral", value: "lawful neutral" },
      { label: "True Neutral", value: "true neutral" },
      { label: "Chaotic Neutral", value: "chaotic neutral" },
      { label: "Lawful Evil", value: "lawful evil" },
      { label: "Neutral Evil", value: "neutral evil" },
      { label: "Chaotic Evil", value: "chaotic evil" },
    ],
  },
  6: {
    label: "Choose your day job",
    options: [
      { label: "🛡️ Town Guard", value: "Town Guard" },
      { label: "🔨 Blacksmith", value: "Blacksmith" },
      { label: "🏹 Hunter", value: "Hunter" },
      { label: "📜 Scribe", value: "Scribe" },
      { label: "🌿 Herbalist", value: "Herbalist" },
      { label: "🎶 Minstrel", value: "Minstrel" },
      { label: "💰 Merchant", value: "Merchant" },
      { label: "🕯️ Acolyte", value: "Acolyte" },
    ],
  },
};
