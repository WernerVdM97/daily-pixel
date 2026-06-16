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
import { OAK_IMAGE, imageFiles, hasImage } from "../images.js";

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

// Item sets loaded from YAML — used to build dynamic step 7 options
let _joinItemSets: Array<{ name: string; description: string; for_classes: string[] }> = [];

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

export function makeJoinCommand(engine: WorldEngine, wizards: WizardSession, itemSets: Array<{ name: string; description: string; for_classes: string[] }>) {
  // Store for use in dynamic step 7 (item sets filtered by class)
  _joinItemSets = itemSets;
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
    await interaction.reply({ ...buildStepMessage(state), ephemeral: true });
    return "join_wizard_started";
  };
}

// ── Interaction handler ──

export async function handleInteraction(
  i: MessageComponentInteraction | ModalSubmitInteraction,
  engine: WorldEngine,
  wizards: WizardSession,
): Promise<void> {
  const userId = i.user.id;

  // Modal submission for name
  if (i.isModalSubmit() && i.customId === CID_NAME_MODAL) {
    const name = i.fields.getTextInputValue(CID_NAME_INPUT);
    try {
      const state = wizards.setName(userId, name);
      await i.deferUpdate();
      await i.editReply(buildStepMessage(state));
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
      "class" | "upbringing" | "race" | "alignment" | "dayJob" | "itemSet"
    > = {
      2: "class",
      3: "upbringing",
      4: "race",
      5: "alignment",
      6: "dayJob",
      7: "itemSet",
    };
    const field = fieldMap[parsed.step];
    if (field) {
      try {
        await i.deferUpdate();
        const state = wizards.choose(userId, parsed.step, field, parsed.value);
        await i.editReply(buildStepMessage(state));
      } catch (e) {
        if (i.deferred) {
          await i.editReply({ content: `❌ ${(e as Error).message}` });
        } else {
          await i.reply({ content: `❌ ${(e as Error).message}`, ephemeral: true });
        }
      }
    }
    return;
  }

  // Button: confirm
  if (i.customId === CID_CONFIRM) {
    try {
      await i.deferUpdate();
      const data = wizards.confirm(userId);
      engine.createCharacter(userId, data);

      const createdEmbed = new EmbedBuilder()
        .setTitle("✨ Character Created!")
        .setDescription(
          `**${data.name}** the ${data.race} ${data.class}\n` +
            `${titleCase(data.alignment)} • ${data.upbringing} upbringing • ${data.dayJob}\n\n` +
            `Type \`/stats\` to see your character sheet.\n` +
            `Type \`/hi\` to begin your adventure.`,
        )
        .setColor(0x2ecc71);
      if (hasImage(OAK_IMAGE)) createdEmbed.setImage(`attachment://${OAK_IMAGE}`);

      await i.editReply({
        embeds: [createdEmbed.toJSON()],
        components: [],
        files: imageFiles(OAK_IMAGE),
      });
    } catch (e) {
      if (i.deferred) {
        await i.editReply({ content: `❌ ${(e as Error).message}` });
      } else {
        await i.reply({ content: `❌ ${(e as Error).message}`, ephemeral: true });
      }
    }
    return;
  }

  // Button: start over
  if (i.customId === CID_START_OVER) {
    await i.deferUpdate();
    wizards.reset(userId);
    const state = wizards.start(userId);
    await i.editReply(buildStepMessage(state));
    return;
  }
}

// ── Message builders ──

// Step → emoji shown on its progress line.
const STEP_ICONS: Record<number, string> = {
  1: "📝", 2: "🛡️", 3: "🌱", 4: "🧬", 5: "⚖️", 6: "🔧", 7: "🎒",
};

function buildStepMessage(state: WizardState): {
  embeds: ReturnType<EmbedBuilder["toJSON"]>[];
  components: ReturnType<ActionRowBuilder<ButtonBuilder>["toJSON"]>[];
  files: ReturnType<typeof imageFiles>;
} {
  const embed = new EmbedBuilder()
    .setTitle("⚔️  Forge Your Hero")
    .setColor(0xdaa520); // goldenrod
  if (hasImage(OAK_IMAGE)) embed.setThumbnail(`attachment://${OAK_IMAGE}`);

  // ── Progress ledger — emoji per step, ▶ marks the current one, chosen values shown ──
  const chosen: Record<number, string | undefined> = {
    1: state.name, 2: state.class, 3: state.upbringing, 4: state.race,
    5: titleCase(state.alignment), 6: state.dayJob, 7: state.itemSet,
  };
  const stepLine = (n: number, label: string) => {
    const icon = STEP_ICONS[n] ?? "•";
    const value = chosen[n];
    if (state.step === n) return `${icon} **${label}** ◀`;
    if (value) return `${icon} ~~${label}~~ → **${value}**`;
    return `${icon} ${label}`;
  };

  const ledger = [
    stepLine(1, "Name"), stepLine(2, "Class"), stepLine(3, "Upbringing"),
    stepLine(4, "Race"), stepLine(5, "Alignment"), stepLine(6, "Day Job"),
    stepLine(7, "Starting Kit"),
  ].join("\n");

  const blocks: string[] = [ledger];
  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  const totalSteps = 7;

  if (state.step === 1) {
    blocks.push("__**Name**__\nWhat shall the songs call you?");
    embed.setFooter({ text: `Step 1 of ${totalSteps} — 2-30 characters, no @ or #` });
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(CID_NAME_BUTTON)
          .setLabel("Enter Name")
          .setEmoji("📝")
          .setStyle(ButtonStyle.Primary),
      ),
    );
  }

  if (state.step >= 2 && state.step <= 7) {
    let opts: OptionDef[];
    let heading: string;

    if (state.step === 7) {
      // Dynamic: starting kits filtered by the chosen class.
      opts = _joinItemSets
        .filter(kit => kit.for_classes.includes(state.class ?? ''))
        .map(kit => ({ label: kit.name, value: kit.name, emoji: "🎒", description: kit.description }));
      heading = "Starting Kit";
    } else {
      const stepData = STEP_DEFS[state.step];
      opts = stepData?.options ?? [];
      heading = stepData?.heading ?? "";
    }

    // Options block: emoji + bold name + its description, one per line.
    const list = opts
      .map(o => `${o.emoji} **${o.label}** — ${o.description}`)
      .join("\n");
    blocks.push(`__**${heading}**__\n${list}`);
    embed.setFooter({ text: `Step ${state.step} of ${totalSteps} — ${heading}` });

    // Buttons: emoji + short label only (descriptions are in the body above).
    // Max 5 buttons per action row — chunk into multiple rows.
    for (let i = 0; i < opts.length; i += 5) {
      const row = new ActionRowBuilder<ButtonBuilder>();
      for (const opt of opts.slice(i, i + 5)) {
        const btn = new ButtonBuilder()
          .setCustomId(choiceCid(state.step, opt.value))
          .setLabel(opt.label)
          .setStyle(ButtonStyle.Secondary);
        if (opt.emoji) btn.setEmoji(opt.emoji);
        row.addComponents(btn);
      }
      components.push(row);
    }
  }

  if (state.step === 8) {
    blocks.push("__**Ready**__\nYour hero stands ready. Confirm to step into the world — or start over.");
    embed.setFooter({ text: "Review your choices and confirm" });
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(CID_CONFIRM)
          .setLabel("Confirm")
          .setEmoji("✅")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(CID_START_OVER)
          .setLabel("Start Over")
          .setEmoji("🔄")
          .setStyle(ButtonStyle.Danger),
      ),
    );
  }

  embed.setDescription(blocks.join("\n\n"));

  return {
    embeds: [embed.toJSON()],
    components: components.map((r) => r.toJSON()),
    files: imageFiles(OAK_IMAGE),
  };
}

/** Title-case an alignment like "lawful good" → "Lawful Good" (passthrough for undefined). */
function titleCase(s: string | undefined): string | undefined {
  return s ? s.replace(/\b\w/g, c => c.toUpperCase()) : s;
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

// ── Step definitions ──
// Curated option set for the wizard. Emoji + short label drive the buttons;
// the description (lore mirrored from assets/char-creation/*.yml) is shown in
// the embed body so players see what each choice means, not just its name.

interface OptionDef {
  /** Short, human-readable name — used as the button label and the bold body name. */
  label: string;
  /** The value persisted to the character (must match the YAML `name`). */
  value: string;
  /** Emoji rendered on the button and beside the body description. */
  emoji: string;
  /** One-line flavour shown in the embed body. */
  description: string;
}

interface StepDef {
  heading: string;
  options: OptionDef[];
}

const STEP_DEFS: Record<number, StepDef> = {
  2: {
    heading: "Class",
    options: [
      { label: "Warrior", value: "Warrior", emoji: "⚔️", description: "Blade and shield. Front line. The first in and the last out." },
      { label: "Ranger", value: "Ranger", emoji: "🏹", description: "Bow and beast. The wilds are home. You read tracks like others read letters." },
      { label: "Wizard", value: "Wizard", emoji: "🔮", description: "Arcane and ancient. The old words still work — if you dare speak them." },
      { label: "Bard", value: "Bard", emoji: "🎵", description: "Song and story. A well-told tale opens more doors than any key." },
      { label: "Priest", value: "Priest", emoji: "✝️", description: "Faith and flame. The old gods are quiet — but not gone." },
    ],
  },
  3: {
    heading: "Upbringing",
    options: [
      { label: "Soldier", value: "Soldier", emoji: "🎖️", description: "Raised in a military family. Discipline was your first language." },
      { label: "Merchant", value: "Merchant", emoji: "⚖️", description: "Grew up behind a counter. You read a ledger before you read a story." },
      { label: "Scholar", value: "Scholar", emoji: "📚", description: "Books over breakfast. Your parents taught you the old tongues." },
      { label: "Folk Hero", value: "Folk Hero", emoji: "🌟", description: "Common blood, uncommon courage. Your village still tells your story." },
      { label: "Outcast", value: "Outcast", emoji: "🏚️", description: "You grew up on the edge of things. The forest taught you what people wouldn't." },
      { label: "Noble", value: "Noble", emoji: "👑", description: "Manor-born. You learned poise, politics, and how to make a room listen." },
    ],
  },
  4: {
    heading: "Race",
    options: [
      { label: "Human", value: "Human", emoji: "🧑", description: "The most common folk. Adaptable, ambitious, everywhere." },
      { label: "Dwarf", value: "Dwarf", emoji: "🪓", description: "Stone and steel. Stocky, stubborn, unshakeable." },
      { label: "Elf", value: "Elf", emoji: "🧝", description: "Grace and age. The Oak was a sapling when you were young." },
      { label: "Halfling", value: "Halfling", emoji: "🍀", description: "Small and lucky. You've learned to slip through the cracks." },
    ],
  },
  5: {
    heading: "Alignment",
    options: [
      { label: "Lawful Good", value: "lawful good", emoji: "😇", description: "Order and compassion. The code is the shield." },
      { label: "Neutral Good", value: "neutral good", emoji: "🕊️", description: "Kindness above all. Rules are tools, not masters." },
      { label: "Chaotic Good", value: "chaotic good", emoji: "🔥", description: "Freedom and mercy. Break the law to save the innocent." },
      { label: "Lawful Neutral", value: "lawful neutral", emoji: "📏", description: "Order is its own virtue. The code, always." },
      { label: "True Neutral", value: "true neutral", emoji: "⚖️", description: "Balance. You walk the middle road." },
      { label: "Chaotic Neutral", value: "chaotic neutral", emoji: "🎲", description: "Impulse and instinct. No master, no chain." },
      { label: "Lawful Evil", value: "lawful evil", emoji: "🗡️", description: "Cruelty within the rules. The system serves you." },
      { label: "Neutral Evil", value: "neutral evil", emoji: "🐍", description: "Selfishness without restraint. You take what you want." },
      { label: "Chaotic Evil", value: "chaotic evil", emoji: "💀", description: "Destruction for its own sake. The world burns." },
    ],
  },
  6: {
    heading: "Day Job",
    options: [
      { label: "Town Guard", value: "Town Guard", emoji: "🛡️", description: "Patrol the walls. Break up tavern brawls. The town sleeps safer." },
      { label: "Blacksmith", value: "Blacksmith", emoji: "🔨", description: "Hammer and anvil. Every blade remembers your name." },
      { label: "Hunter", value: "Hunter", emoji: "🏹", description: "Track game in the eastern woods. The Oak's larder depends on you." },
      { label: "Scribe", value: "Scribe", emoji: "📜", description: "Copy manuscripts. Translate old tongues. The warden's library is yours." },
      { label: "Herbalist", value: "Herbalist", emoji: "🌿", description: "Gather roots and remedies. The sick come to you before the priest." },
      { label: "Minstrel", value: "Minstrel", emoji: "🎶", description: "Play the taverns. Carry news between towns. Every song is a secret." },
      { label: "Merchant", value: "Merchant", emoji: "💰", description: "Buy low in Stonebridge, sell high at the Oak. Coin before creed." },
      { label: "Acolyte", value: "Acolyte", emoji: "🕯️", description: "Tend the shrine. Bless the harvest. The people need someone to believe in." },
    ],
  },
};
