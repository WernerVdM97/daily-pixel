import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
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
import { CLASS_EMOJI } from "../format.js";

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

/** A YAML char-creation entry — only the fields the wizard renders. */
export interface NamedDef {
  name: string;
  description?: string;
}
/** A starting-kit entry from item-sets.yml. */
export interface ItemSetDef {
  name: string;
  description: string;
  for_classes: string[];
}
/** All char-creation option data from assets/char-creation/*.yml. */
export interface CharDefs {
  classes: NamedDef[];
  backgrounds: NamedDef[];
  races: NamedDef[];
  alignments: NamedDef[];
  dayJobs: NamedDef[];
  itemSets: ItemSetDef[];
}

// Source of truth for which options exist; set by makeJoinCommand, read per step.
let _defs: CharDefs = { classes: [], backgrounds: [], races: [], alignments: [], dayJobs: [], itemSets: [] };

/** Double-click guard — user ID locked while an interaction processes; concurrent ones return early. */
const _userInFlight = new Set<string>();

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

export function makeJoinCommand(engine: WorldEngine, wizards: WizardSession, defs: CharDefs) {
  _defs = defs;
  return async (interaction: ChatInputCommandInteraction): Promise<string> => {
    // Defer immediately: the first screen's Oak PNG can blow past Discord's 3s ack
    // window (→ 10062) on slow hosts. A payload-free defer acks fast; editReply then
    // has a 15-minute window for the heavy payload.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Guard: already has a character?
    if (engine.characterExists(interaction.user.id)) {
      await interaction.editReply({
        content: "You already have a character. Type `/stats` to see it.",
      });
      return "join_guard_has_character";
    }

    // Start or resume wizard
    let state: WizardState;
    try {
      state = wizards.start(interaction.user.id);
    } catch {
      // Already in a wizard — resume (or restart if expired)
      const existing = wizards.getSession(interaction.user.id);
      if (!existing || wizards.isExpired(interaction.user.id)) {
        wizards.reset(interaction.user.id);
        state = wizards.start(interaction.user.id);
      } else {
        state = existing;
      }
    }

    await interaction.editReply(buildStepMessage(state));
    return "join_wizard_started";
  };
}

// ── Interaction handler ──

/**
 * Builds the ephemeral `/hi` first-day screen for a new character. Injected from
 * index.ts so `join` can show the opening view without importing the registry/builder.
 * Returns a ready-to-send reply payload (Components V2, ephemeral).
 */
export type RenderHiScreen = (userId: string) => unknown | Promise<unknown>;

export async function handleInteraction(
  i: MessageComponentInteraction | ModalSubmitInteraction,
  engine: WorldEngine,
  wizards: WizardSession,
  renderHiScreen?: RenderHiScreen,
): Promise<void> {
  const userId = i.user.id;

  // Per-user in-flight guard — drop duplicate clicks silently.
  if (_userInFlight.has(userId)) return;
  _userInFlight.add(userId);

  try {
    // Modal submission for name
    if (i.isModalSubmit() && i.customId === CID_NAME_MODAL) {
      const name = i.fields.getTextInputValue(CID_NAME_INPUT);
      try {
        const state = wizards.setName(userId, name);
        await i.deferUpdate();
        await i.editReply(buildStepMessage(state));
      } catch (e) {
        await safeNotify(i, `❌ ${(e as Error).message}`);
      }
      return;
    }

    // Other modals — none yet, ignore
    if (i.isModalSubmit()) return;

    // Button: open name modal
    if (i.customId === CID_NAME_BUTTON) {
      try {
        await i.showModal(buildNameModal());
      } catch {
        /* stale (10062) or already acked (40060) — ignore */
      }
      return;
    }

    // Button: choice (steps 2-7)
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
          await safeNotify(i, `❌ ${(e as Error).message}`);
        }
      }
      return;
    }

    // Button: confirm
    if (i.customId === CID_CONFIRM) {
      // Release the in-flight lock early so follow-ups don't block other wizard clicks.
      const release = () => { _userInFlight.delete(userId); };
      try {
        await i.deferUpdate();
      const data = wizards.confirm(userId);
      engine.createCharacter(userId, data);

      // Public channel announcement (the wizard itself ran ephemeral).
      const createdEmbed = new EmbedBuilder()
        .setTitle("✨ A new hero joins the Oak")
        .setDescription(
          `**${data.name}** the ${data.race} ${data.class}\n` +
            `${titleCase(data.alignment)} • ${data.upbringing} upbringing • ${data.dayJob}`,
        )
        .setColor(0x2ecc71);
      if (hasImage(OAK_IMAGE)) createdEmbed.setImage(`attachment://${OAK_IMAGE}`);

      release();

      await i.followUp({ embeds: [createdEmbed.toJSON()], files: imageFiles(OAK_IMAGE) }).catch(() => {});

      // Replace the finished wizard with the player's ephemeral /hi screen.
      const hiPayload = renderHiScreen ? await renderHiScreen(userId) : undefined;
      if (hiPayload) {
        // Wizard is a classic embed but /hi is Components V2, which can't be edited
        // in — so drop the wizard and follow up instead.
        await i.deleteReply().catch(() => {});
        await i.followUp(hiPayload as Parameters<typeof i.followUp>[0]).catch(() => {});
      } else {
        // No /hi renderer — collapse the wizard to a short pointer.
        await i.editReply({
          content: `✨ **${data.name}** steps into the world. Type \`/hi\` to begin.`,
          embeds: [],
          components: [],
        }).catch(() => {});
      }
    } catch (e) {
      await safeNotify(i, `❌ ${(e as Error).message}`);
    }
    return;
  }

    // Button: start over
    if (i.customId === CID_START_OVER) {
      try {
        await i.deferUpdate();
        wizards.reset(userId);
        const state = wizards.start(userId);
        await i.editReply(buildStepMessage(state));
      } catch (e) {
        await safeNotify(i, `❌ ${(e as Error).message}`);
      }
      return;
    }
  } finally {
    _userInFlight.delete(userId);
  }
}

/**
 * Notify the user of an error without ever throwing. The interaction may be dead
 * (10062 expired / 40060 acked); swallow it — a wizard button must never crash the handler.
 */
async function safeNotify(
  i: MessageComponentInteraction | ModalSubmitInteraction,
  message: string,
): Promise<void> {
  try {
    if (i.deferred || i.replied) {
      await i.followUp({ content: message, flags: MessageFlags.Ephemeral });
    } else {
      await i.reply({ content: message, flags: MessageFlags.Ephemeral });
    }
  } catch {
    /* interaction gone — nothing more we can do */
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

  // ── Progress ledger: emoji per step, ◀ marks current, chosen values shown ──
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
    const opts = buildStepOptions(state.step, _defs, state.class);
    const heading = STEP_HEADINGS[state.step] ?? "";

    // Options block: emoji + bold name + description, one per line.
    const list = opts
      .map(o => `${o.emoji} **${o.label}** — ${o.description}`)
      .join("\n");
    blocks.push(`__**${heading}**__\n${list}`);
    embed.setFooter({ text: `Step ${state.step} of ${totalSteps} — ${heading}` });

    // Buttons carry emoji + label only (descriptions are in the body).
    // Max 5 buttons per row — chunk into multiple rows.
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

  // Steps 2-7 get a Start Over button (step 1 has nothing to reset; step 8 pairs
  // its own with Confirm). Option steps use ≤3 rows, so +1 stays within Discord's 5.
  if (state.step >= 2 && state.step <= 7) {
    components.push(buildStartOverRow());
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

/** Red "Start Over" button row, shown on every step before the review. */
function buildStartOverRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(CID_START_OVER)
      .setLabel("Start Over")
      .setEmoji("🔄")
      .setStyle(ButtonStyle.Danger),
  );
}

/** Title-case "lawful good" → "Lawful Good"; passthrough for undefined. */
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

// ── Step option building (data-driven from YAML) ──
// The wizard renders whatever assets/char-creation/*.yml contains. Only emoji are
// mapped here (per step, since names like "Merchant" recur across steps); unmapped
// names fall back to a neutral bullet.

interface OptionDef {
  /** Button label and bold body name. */
  label: string;
  /** Value persisted to the character. */
  value: string;
  emoji: string;
  /** One-line flavour in the embed body (YAML `description`). */
  description: string;
}

const STEP_HEADINGS: Record<number, string> = {
  2: "Class", 3: "Upbringing", 4: "Race", 5: "Alignment", 6: "Day Job", 7: "Starting Kit",
};

const FALLBACK_EMOJI = "🔹";

const UPBRINGING_EMOJI: Record<string, string> = {
  Soldier: "🎖️", Merchant: "⚖️", Scholar: "📚", "Folk Hero": "🌟", Outcast: "🏚️", Noble: "👑",
  Artisan: "🪚", Farmstead: "🌾", "Temple-Raised": "⛪", Urchin: "🗝️", Entertainer: "🎭", Scout: "🧭",
};
const RACE_EMOJI: Record<string, string> = {
  Human: "🧑", Dwarf: "🪓", Elf: "🧝", Halfling: "🍀", "Half-Elf": "🌗", "Half-Orc": "💪", "Dúnedain": "🏔️",
};
const ALIGNMENT_EMOJI: Record<string, string> = {
  "Lawful Good": "😇", "Neutral Good": "🕊️", "Chaotic Good": "🔥",
  "Lawful Neutral": "📏", "True Neutral": "⚖️", "Chaotic Neutral": "🎲",
  "Lawful Evil": "🗡️", "Neutral Evil": "🐍", "Chaotic Evil": "💀",
};
/** Single source of day-job → emoji (fallback 🔨), reused by /hi and the /action
 *  day-job menu so those surfaces don't hardcode a glyph. */
export const DAYJOB_EMOJI: Record<string, string> = {
  "Town Guard": "🛡️", Blacksmith: "🔨", Hunter: "🏹", Scribe: "📜", Herbalist: "🌿",
  Minstrel: "🎶", Merchant: "💰", Acolyte: "🕯️", Wanderer: "🚶",
};

/** Options for a step, built from the YAML defs (emoji mapped here). Exported for tests. */
export function buildStepOptions(step: number, defs: CharDefs, chosenClass?: string): OptionDef[] {
  const toOption = (d: NamedDef, emoji: Record<string, string>, value?: string): OptionDef => ({
    label: d.name,
    value: value ?? d.name,
    emoji: emoji[d.name] ?? FALLBACK_EMOJI,
    description: d.description ?? "",
  });

  switch (step) {
    case 2: return defs.classes.map(d => toOption(d, CLASS_EMOJI));
    case 3: return defs.backgrounds.map(d => toOption(d, UPBRINGING_EMOJI));
    case 4: return defs.races.map(d => toOption(d, RACE_EMOJI));
    // Alignment value stays lowercase ("lawful good") — the format stored & sent to the LLM.
    case 5: return defs.alignments.map(d => toOption(d, ALIGNMENT_EMOJI, d.name.toLowerCase()));
    case 6: return defs.dayJobs.map(d => toOption(d, DAYJOB_EMOJI));
    case 7: return defs.itemSets
      .filter(kit => kit.for_classes.includes(chosenClass ?? ""))
      .map(kit => ({ label: kit.name, value: kit.name, emoji: "🎒", description: kit.description }));
    default: return [];
  }
}
