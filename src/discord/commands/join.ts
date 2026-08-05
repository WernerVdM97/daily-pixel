import {
  ActionRowBuilder,
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
import type { CharCreateData } from "../../engine/WorldEngine.js";
import type { WizardSession } from "../WizardSession.js";
import { OAK_IMAGE, imageFiles, hasImage } from "../images.js";
import { wizardViewToDiscord } from "../viewToDiscord.js";
import type { WizardViewState } from "../../view/viewState.js";
import { titleCase } from "../../controller/joinWizard.js";
import type { GameRouter } from "../../protocol/router.js";

// ── Custom IDs ──

const CID_NAME_BUTTON = "join:name";
const CID_NAME_MODAL = "join:name:modal";
const CID_NAME_INPUT = "join:name:input";
const CID_PREFIX = "join:choice:";
const CID_CONFIRM = "join:confirm";
const CID_START_OVER = "join:restart";

/** Double-click guard — user ID locked while an interaction processes; concurrent ones return early. */
const _userInFlight = new Set<string>();

/** The seam router this adapter dispatches through (M7.3, DC-M7.3.8). Set by
 *  `makeJoinCommand(router)`; read by `handleInteraction` for the button/modal walk. The
 *  module-level setter is a documented M9 casualty — the dispatcher's join branch is frozen
 *  (dispatchInteraction.ts:238) and passes the handler the dead compat params below. */
let _router: GameRouter | null = null;

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

/** M7.3 (DC-M7.3.8): the defs and the wizard store drop — the controller owns both now.
 *  The slash arm is translate + paint: defer (transcript 1), dispatch `join.open`, paint
 *  the router's copy/`wizardViewToDiscord` payload. */
export function makeJoinCommand(router: GameRouter) {
  _router = router;
  return async (interaction: ChatInputCommandInteraction): Promise<string> => {
    // Defer immediately: the first screen's Oak PNG can blow past Discord's 3s ack
    // window (→ 10062) on slow hosts. A payload-free defer acks fast; editReply then
    // has a 15-minute window for the heavy payload.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const response = await router.dispatch({
      type: "join.open",
      playerId: interaction.user.id,
    });

    if (!response.ok) {
      // HAS_CHARACTER_COPY — painted via editReply without ❌ (transcript 2's byte path).
      await interaction.editReply({ content: response.error.message });
      return "join_guard_has_character";
    }

    await interaction.editReply(wizardViewToDiscord(response.view as WizardViewState));
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

/**
 * M7.3 (DC-M7.3.8): the button/modal walk is translate + paint through the module-level
 * `_router`. `engine` and `wizards` KEEP their signature slots — the frozen dispatcher's
 * join branch (dispatchInteraction.ts:238) passes `engine` + `joinWizards` — and are now
 * documented dead-until-M9 compat params; the handler never reads them.
 */
export async function handleInteraction(
  i: MessageComponentInteraction | ModalSubmitInteraction,
  _engine: WorldEngine,
  _wizards: WizardSession,
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
      const response = await _router!.dispatch({
        type: "wizard.answer",
        playerId: userId,
        text: name,
      });
      if (!response.ok) {
        // The router's message IS the store's validation copy — safeNotify welds the ❌
        // (transcript 4's byte path).
        await safeNotify(i, `❌ ${response.error.message}`);
      } else {
        await i.deferUpdate();
        await i.editReply(wizardViewToDiscord(response.view as WizardViewState));
      }
      return;
    }

    // Other modals — none yet, ignore
    if (i.isModalSubmit()) return;

    // Button: open name modal
    if (i.customId === CID_NAME_BUTTON) {
      try {
        // join.open is idempotent — a resumed session yields the same step-1 screen.
        const response = await _router!.dispatch({ type: "join.open", playerId: userId });
        if (response.ok) {
          await i.showModal(buildNameModal(response.view as WizardViewState));
        }
      } catch {
        /* stale (10062) or already acked (40060) — ignore */
      }
      return;
    }

    // Button: choice (steps 2-7)
    const parsed = parseChoiceCid(i.customId);
    if (parsed) {
      const response = await _router!.dispatch({
        type: "wizard.choose",
        playerId: userId,
        step: parsed.step,
        value: parsed.value,
      });
      if (!response.ok) {
        await safeNotify(i, `❌ ${response.error.message}`);
      } else {
        await i.deferUpdate();
        await i.editReply(wizardViewToDiscord(response.view as WizardViewState));
      }
      return;
    }

    // Button: confirm
    if (i.customId === CID_CONFIRM) {
      // Release the in-flight lock early so follow-ups don't block other wizard clicks.
      const release = () => { _userInFlight.delete(userId); };
      try {
        await i.deferUpdate();
        const response = await _router!.dispatch({
          type: "character.create",
          playerId: userId,
        });
        if (!response.ok) {
          await safeNotify(i, `❌ ${response.error.message}`);
          return;
        }
        const created = response.facts?.createdCharacter as CharCreateData | undefined;
        // The created arm always carries the fact — its absence is an internal breach.
        if (!created) throw new Error("character.create returned ok:true without createdCharacter");

        // Public channel announcement (the wizard itself ran ephemeral). Welded from the
        // `createdCharacter` fact (DC-M7.3.7) — the exact pre-seam embed.
        const createdEmbed = new EmbedBuilder()
          .setTitle("✨ A new hero joins the Oak")
          .setDescription(
            `**${created.name}** the ${created.race} ${created.class}\n` +
              `${titleCase(created.alignment)} • ${created.upbringing} upbringing • ${created.dayJob}`,
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
            content: `✨ **${created.name}** steps into the world. Type \`/hi\` to begin.`,
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
      const response = await _router!.dispatch({
        type: "wizard.restart",
        playerId: userId,
      });
      if (!response.ok) {
        await safeNotify(i, `❌ ${response.error.message}`);
      } else {
        await i.deferUpdate();
        await i.editReply(wizardViewToDiscord(response.view as WizardViewState));
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

/** Weld the step-1 name modal from the view's `nameField` (DC-M7.3.3) — the customIds
 *  (`join:name:modal`/`join:name:input`) and the title are medium chrome; the label,
 *  placeholder and length bounds are the view's. */
function buildNameModal(view: WizardViewState): ModalBuilder {
  const field = view.nameField;
  const input = new TextInputBuilder()
    .setCustomId(CID_NAME_INPUT)
    .setLabel(field?.label ?? "Character Name")
    .setPlaceholder(field?.placeholder ?? "Enter a name (2-30 characters)")
    .setMinLength(field?.minLength ?? 2)
    .setMaxLength(field?.maxLength ?? 30)
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  return new ModalBuilder()
    .setCustomId(CID_NAME_MODAL)
    .setTitle("Name Your Character")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(input),
    );
}
