import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
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
import { STAT_LABELS } from "../../engine/stat-format.js";

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
  emoji: string;
  /** Per-stat bonuses (classes/backgrounds/races); absent on entries that grant none. */
  modifiers?: Record<string, number>;
}
/** A starting-kit entry from item-sets.yml. */
export interface ItemSetDef {
  name: string;
  description: string;
  for_classes: string[];
  /** Items the kit grants, each carrying the stat + d20 modifier it boosts. */
  items?: Array<{ stat: string; modifier: number; quantity?: number }>;
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

      await i.followUp({
  content: `<@${userId}>`,
  embeds: [createdEmbed.toJSON()],
  files: imageFiles(OAK_IMAGE),
  allowedMentions: { users: [] },
  components: [{ type: ComponentType.ActionRow, components: [{ type: ComponentType.Button, custom_id: 'nav:hi', label: 'Hi', emoji: { name: '🌅' }, style: ButtonStyle.Secondary }] }],
}).catch(() => {});

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

// Per-step metadata: progress-ledger icon + section heading. Single source for both
// the ledger lines and the option-block heading (steps 2-7; step 1 is the name modal).
const STEPS: Record<number, { icon: string; heading: string }> = {
  1: { icon: "📝", heading: "Name" },
  2: { icon: "🛡️", heading: "Class" },
  3: { icon: "🌱", heading: "Upbringing" },
  4: { icon: "🧬", heading: "Race" },
  5: { icon: "⚖️", heading: "Alignment" },
  6: { icon: "🔧", heading: "Day Job" },
  7: { icon: "🎒", heading: "Starting Kit" },
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
  // Raw (pre-titleCase) persisted values — these are what each option's `value` matches,
  // so they're the lookup key for the chosen option's own emoji.
  const rawChosen: Record<number, string | undefined> = {
    2: state.class, 3: state.upbringing, 4: state.race,
    5: state.alignment, 6: state.dayJob, 7: state.itemSet,
  };
  // Graceful miss: a custom/renamed value with no matching def yields "" — never "undefined".
  const chosenEmoji = (n: number): string => {
    const raw = rawChosen[n];
    if (!raw) return "";
    const match = buildStepOptions(n, _defs, state.class).find(o => o.value === raw);
    return match ? `${match.emoji} ` : "";
  };
  const stepLine = (n: number) => {
    const { icon, heading } = STEPS[n];
    const value = chosen[n];
    if (state.step === n) return `${icon} **${heading}** ◀`;
    if (value) return `${icon} ~~${heading}~~ → ${chosenEmoji(n)}**${value}**`;
    return `${icon} ${heading}`;
  };

  const ledger = [1, 2, 3, 4, 5, 6, 7].map(stepLine).join("\n");

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
    const heading = STEPS[state.step]?.heading ?? "";

    // Options block: emoji + bold name on their own line, stat bonuses (if any) set off
    // as a blockquote, description on its own line — crowds less than one long dashed line.
    const list = opts
      .map(o => {
        const lines = [`${o.emoji} **${o.label}**`];
        if (o.statBonuses) lines.push(`> ${o.statBonuses}`);
        if (o.description) lines.push(o.description);
        return lines.join("\n");
      })
      .join("\n\n");
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
// The wizard renders whatever assets/char-creation/*.yml contains, emoji and all.

interface OptionDef {
  /** Button label and bold body name. */
  label: string;
  /** Value persisted to the character. */
  value: string;
  emoji: string;
  /** One-line flavour in the embed body (YAML `description`). */
  description: string;
  /** Pre-rendered stat-bonus run, e.g. `💪+3 🧠-1` — "" when the option grants none. */
  statBonuses: string;
}

const FALLBACK_EMOJI = "🔹";

/** Render nonzero per-stat bonuses as emoji + signed amount, in canonical stat order. */
function formatStatBonuses(mods: Record<string, number> | undefined): string {
  if (!mods) return "";
  return Object.keys(STAT_LABELS)
    .filter(stat => (mods[stat] ?? 0) !== 0)
    .map(stat => {
      const v = mods[stat];
      return `${STAT_LABELS[stat].emoji}${v > 0 ? `+${v}` : `${v}`}`;
    })
    .join(" ");
}

/** Sum a kit's per-item modifiers into a per-stat total. */
function sumItemModifiers(items: ItemSetDef["items"]): Record<string, number> {
  const mods: Record<string, number> = {};
  for (const it of items ?? []) mods[it.stat] = (mods[it.stat] ?? 0) + it.modifier;
  return mods;
}

/** Options for a step, built from the YAML defs (emoji read straight off each entry). Exported for tests. */
export function buildStepOptions(step: number, defs: CharDefs, chosenClass?: string): OptionDef[] {
  const toOption = (d: NamedDef, value?: string): OptionDef => ({
    label: d.name,
    value: value ?? d.name,
    emoji: d.emoji || FALLBACK_EMOJI,
    description: d.description ?? "",
    statBonuses: formatStatBonuses(d.modifiers),
  });

  switch (step) {
    case 2: return defs.classes.map(d => toOption(d));
    case 3: return defs.backgrounds.map(d => toOption(d));
    case 4: return defs.races.map(d => toOption(d));
    // Alignment value stays lowercase ("lawful good") — the format stored & sent to the LLM.
    case 5: return defs.alignments.map(d => toOption(d, d.name.toLowerCase()));
    case 6: return defs.dayJobs.map(d => toOption(d));
    case 7: return defs.itemSets
      .filter(kit => kit.for_classes.includes(chosenClass ?? ""))
      .map(kit => ({
        label: kit.name, value: kit.name, emoji: "🎒", description: kit.description,
        statBonuses: formatStatBonuses(sumItemModifiers(kit.items)),
      }));
    default: return [];
  }
}
