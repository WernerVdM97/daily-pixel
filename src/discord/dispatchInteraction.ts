/**
 * The Warden's Oak — Discord interaction dispatcher.
 *
 * Hoisted verbatim out of `main()`'s `dispatchInteraction` closure in
 * `src/index.ts` (M1.1). The body below is a byte-identical copy of the
 * closure body, only dedented — everything it used to capture from
 * `main()`'s scope, or from the self-executing `index.ts` module scope,
 * now arrives via `deps` instead. No branch logic changed.
 */

import {
  EmbedBuilder,
  MessageFlags,
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import type { Interaction, RepliableInteraction } from "discord.js";

import type { WorldEngine, PendingChoiceSelector } from "../engine/WorldEngine.js";
import type { CommandRegistry } from "./CommandRegistry.js";
import type { WizardSession } from "./WizardSession.js";
import type { SessionController } from "../controller/SessionController.js";
import { noticeViewToDiscord, decisionViewToDiscord, outcomeViewToDiscord, menuViewToDiscord, loadingViewToDiscord, commuteViewToDiscord } from "./viewToDiscord.js";
import { c } from "../util/colors.js";
import { randomIdleMessage } from "../engine/IdleMessageSelector.js";
import {
  buildComponentPayload,
  getNavButtons,
  getOutcomeServiceButtons,
  getPublicOutcomeButtons,
  navResponseMode,
  parseOutcomeActionId,
  classEmoji,
} from "./format.js";
import { announceCollapse } from "./collapse.js";
import { BANNER_IMAGE, imageFiles } from "./images.js";
import { handleInteraction as handleJoinInteraction } from "./commands/join.js";
import { CID_BAIL, parseActionCid } from "../view/actionViewState.js";
import {
  consumeMenuMessage,
  stashMenuMessage,
} from "./commands/action.js";
import { checkProfanity } from "../protocol/profanity.js";
import type { DayJobDef } from "../controller/dayJob.js";
import {
  broadcastOutcome,
  META_RECAP_THREAD_ID,
} from "./weekly-recap.js";

/**
 * Everything `dispatchInteraction` used to reach into `main()`'s closure scope for,
 * plus the self-executing `index.ts` module-level bindings it referenced
 * (`notifyAdmin`/`safeErrorReply`/`VERBOSE`/`ADMIN_USER_ID`).
 * `index.ts` stays the owner of every one of these — this module only holds references.
 */
export interface DispatchDeps {
  engine: WorldEngine;
  registry: CommandRegistry;
  getCurrentScene: (discordUserId: string) => string;
  dayJobs: DayJobDef[];
  joinWizards: WizardSession;
  controller: SessionController;
  notifyAdmin: (label: string, err: unknown) => Promise<void>;
  safeErrorReply: (
    interaction: RepliableInteraction,
    content: string,
  ) => Promise<void>;
  VERBOSE: boolean;
  ADMIN_USER_ID: string;
}

export async function dispatchInteraction(
  interaction: Interaction,
  deps: DispatchDeps,
): Promise<void> {
  const {
    engine,
    registry,
    joinWizards,
    controller,
    notifyAdmin,
    safeErrorReply,
    VERBOSE,
    ADMIN_USER_ID,
  } = deps;

  // ── Slash commands ──
  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;

    if (VERBOSE) {
      const user = interaction.user.tag;
      const options = interaction.options.data
        .map((o) => `${o.name}=${o.value}`)
        .join(", ");
      console.log(
        c.grey(
          `[verbose] /${commandName} from ${user} options: ${options || "(none)"}`,
        ),
      );
    }

    const handler = registry.get(commandName);
    if (!handler) {
      await interaction.reply({
        content: `Unknown command \`/${commandName}\`. Try \`/help\`.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Reroute character-gated surfaces to the join wizard when the player has no character yet,
    // instead of dead-ending on a "type /join" string. The join handler owns its own
    // defer/editReply flow, so the early-return below (replied/deferred) takes over from here.
    let activeHandler = handler;
    if (controller.needsCharacterGate(interaction.user.id, commandName)) {
      const joinHandler = registry.get("join");
      if (joinHandler) activeHandler = joinHandler;
    }

    try {
      const result = await activeHandler(interaction);
      // join/action manage their own flow — skip if already replied.
      if (interaction.replied || interaction.deferred) return;

      // Stamp last interaction time (not join — no char yet).
      if (commandName !== "join") controller.stampLastPlayed(interaction.user.id);

      const ephemeralCommands = [
        "stats",
        "backpack",
        "journal",
        "map",
        "bug",
        "feedback",
        "help",
        "hi",
        "look",
      ];
      const isEphemeral = ephemeralCommands.includes(commandName);

      let isAdminTick = false;
      let navButtons: ReturnType<typeof getNavButtons> | undefined;

      if (commandName === "action") {
        // /action manages its own buttons
      } else if (commandName === "sleep") {
        isAdminTick =
          interaction.user.id === ADMIN_USER_ID &&
          process.env.SLEEP_ADMIN_TICK === "true";
        if (!isAdminTick) {
          // Goodnight message: nav buttons + a Feedback button row.
          const char = engine.getCharacter(interaction.user.id);
          if (char) {
            navButtons = getNavButtons(char, "sleep");
            if (navButtons && navButtons.length > 0) {
              navButtons = [
                ...navButtons,
                {
                  type: 1,
                  components: [
                    {
                      type: 2,
                      custom_id: "sleep:feedback",
                      label: "Feedback",
                      emoji: { name: "💬" },
                      style: 2,
                    },
                  ],
                },
              ];
            }
          }
        }
      } else {
        const char = engine.getCharacter(interaction.user.id);
        if (char) navButtons = getNavButtons(char, commandName);
      }

      const bannerFiles = isAdminTick ? imageFiles(BANNER_IMAGE) : [];
      const payload = buildComponentPayload(result, {
        ephemeral: isEphemeral,
        navButtons,
        ...(isAdminTick && bannerFiles.length > 0
          ? { image: BANNER_IMAGE }
          : {}),
      });
      await interaction.reply(
        bannerFiles.length > 0 ? { ...payload, files: bannerFiles } : payload,
      );
      if (VERBOSE) {
        console.log(
          c.grey(`[verbose] /${commandName} → ${result.slice(0, 200)}`),
        );
      }
    } catch (err) {
      void notifyAdmin(
        `/${commandName} failed (user ${interaction.user.tag})`,
        err,
      );
      const msg = err instanceof Error ? err.message : String(err);
      await safeErrorReply(
        interaction,
        `⚠️ **Something went wrong.**\n\`\`\`${msg}\`\`\``,
      );
    }
    return;
  }

  // ── Button clicks and modal submissions (join wizard) ──
  const customId =
    "customId" in interaction
      ? (interaction as { customId: string }).customId
      : null;

  if (customId && customId.startsWith("join:")) {
    if (!interaction.isButton() && !interaction.isModalSubmit()) return;
    if (VERBOSE)
      console.log(
        c.grey(
          `[verbose] join:${interaction.isButton() ? "button" : "modal"} from ${interaction.user.tag} cid=${customId}`,
        ),
      );
    try {
      // After confirm, join shows the first-day /hi view — built here where the
      // registry + payload builder live, then handed back.
      const renderHiScreen = async (userId: string) => {
        const hiHandler = registry.get("hi");
        const result = hiHandler
          ? await hiHandler({ user: { id: userId } } as never)
          : "Welcome to the Oak. Type `/hi` to begin.";
        const char = engine.getCharacter(userId);
        const navButtons = char ? getNavButtons(char, "hi") : undefined;
        return buildComponentPayload(result, { ephemeral: true, navButtons });
      };
      await handleJoinInteraction(
        interaction,
        engine,
        joinWizards,
        renderHiScreen,
      );
      if (VERBOSE) console.log(c.grey("[verbose] join: done"));
    } catch (err) {
      // notifyAdmin already ignores dead interactions (double-clicks etc.).
      void notifyAdmin("Join interaction failed", err);
      if ("reply" in interaction) {
        await (interaction as { reply: Function })
          .reply({
            content: "Something went wrong. Try `/join` again.",
            flags: MessageFlags.Ephemeral,
          })
          .catch(() => {});
      }
    }
    return;
  }

  // ── Custom action button — opens a modal for free-text input ──
  if (customId && customId === "action:dayjob:custom") {
    if (!interaction.isButton()) return;
    const modal = new ModalBuilder()
      .setCustomId("action:custom:modal")
      .setTitle("Custom Action")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("action:custom:input")
            .setLabel("What do you want to do?")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(300)
            .setPlaceholder("e.g. scout the northern ridge"),
        ),
      );
    // showModal must be the first (and only) ack of this interaction — send it first.
    await interaction.showModal(modal);

    // Dismiss the stale day-job menu now (don't wait for the modal submit). The
    // modal overlay survives its source message being deleted; consuming the entry
    // also stops the submit handler from deleting it a second time.
    const menuInfo = consumeMenuMessage(interaction.user.id);
    if (menuInfo) {
      const { WebhookClient } = await import("discord.js");
      const wh = new WebhookClient({
        id: menuInfo.applicationId,
        token: menuInfo.token,
      });
      await wh.deleteMessage(menuInfo.messageId).catch(() => {});
    }
    return;
  }

  // ── Custom action modal submission — starts the action with typed text ──
  if (customId && customId === "action:custom:modal") {
    if (!interaction.isModalSubmit()) return;
    const description = interaction.fields.getTextInputValue(
      "action:custom:input",
    );

    // Block profane custom actions before they reach the engine.
    const blocked = checkProfanity(description);
    if (blocked !== null) {
      await interaction.reply({
        content:
          "❌ That action contains language the warden won't tolerate. Try something else.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Delete the stale day-job menu so only the action scene shows.
    const menuInfo = consumeMenuMessage(interaction.user.id);
    if (menuInfo) {
      const { WebhookClient } = await import("discord.js");
      const wh = new WebhookClient({
        id: menuInfo.applicationId,
        token: menuInfo.token,
      });
      await wh.deleteMessage(menuInfo.messageId).catch(() => {});
    }

    try {
      const begin = controller.beginCustomAction(interaction.user.id);
      if (begin.kind === "no-character") {
        await interaction.editReply({
          content: "You don't have a character. Type `/join` first.",
        });
        return;
      }
      if (begin.kind === "resume") {
        await interaction.editReply(decisionViewToDiscord(begin.view));
        return;
      }
      if (begin.kind === "resume-stale") {
        // M9.2 review fix: this leaf's if-chain ignored the new arm and would fall through
        // to the "start" path below on a stale pending action — the same defect
        // `nav:action`'s stale embed (below, ~:809-822) already guards against. Copied
        // rather than inventing new chrome; already deferred above, so this edits.
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle("⏳ Stale Action")
              .setDescription(begin.prompt)
              .setColor(0x95a5a6)
              .toJSON(),
          ],
          components: [],
        });
        return;
      }

      // Thinking screen — matches the ⏳ envelope /action and the day-job button
      // path already show, so the player isn't staring at a blank spinner during
      // the LLM call that runCustomAction below makes.
      const clippedDescription =
        description.length > 280
          ? description.slice(0, 279).trimEnd() + "…"
          : description;
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setDescription(
              `**You:** ${clippedDescription}\n\n⏳ **Thinking…**\n_${randomIdleMessage()}_`,
            )
            .setColor(0x95a5a6)
            .toJSON(),
        ],
      });

      const run = await controller.runCustomAction(interaction.user.id, description);
      if (run.kind === "outcome") {
        const priv = outcomeViewToDiscord(run.viewPrivate);
        await interaction.editReply({
          embeds: [priv],
          components: [...getNavButtons(run.char), ...getOutcomeServiceButtons(run.actionId)],
        });
        const payload = {
          content: `**${run.characterName}** <@${interaction.user.id}> — ${run.distilledType}`,
          embeds: [outcomeViewToDiscord(run.viewPublic)],
          components: getPublicOutcomeButtons(run.actionId),
          allowedMentions: { users: [] },
        };
        await broadcastOutcome({
          client: interaction.client,
          threadId: engine.getMeta(META_RECAP_THREAD_ID),
          payload,
          fallback: () => interaction.followUp(payload),
          subscribeUserIds: [interaction.user.id],
        });
        await announceCollapse(run.char.name, run.prevChar, run.char);
      } else if (run.kind === "empty-action") {
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle("⚔️ Action")
              .setDescription(run.prompt)
              .setColor(0x95a5a6)
              .toJSON(),
          ],
          components: [],
        });
      } else if (run.kind === "divine") {
        // DC-M9.3: a refunded roll is a system fault, not a real outcome — paint the
        // distinct grey ⚠️ System embed (modelled on commands/action.ts:158-170) and stop,
        // without broadcasting or announcing a collapse.
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle("⚠️ System")
              .setDescription(run.text)
              .setColor(0x95a5a6)
              .toJSON(),
          ],
          components: [],
        });
      } else {
        await interaction.editReply(decisionViewToDiscord(run.view));
      }
    } catch (err) {
      void notifyAdmin("Action (custom modal) failed", err);
      const msg = err instanceof Error ? err.message : String(err);
      await interaction
        // Discord's edit-message endpoint leaves omitted fields untouched, so the
        // thinking-page embed would otherwise persist alongside this error content.
        .editReply({ content: `❌ **Could not act.**\n${msg}`, embeds: [] })
        .catch(() => {});
    }
    return;
  }

  // ── Sleep feedback button ── opens a modal for feedback text
  if (customId && customId === "sleep:feedback") {
    if (!interaction.isButton()) return;
    const modal = new ModalBuilder()
      .setCustomId("sleep:feedback:modal")
      .setTitle("Share Feedback")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("sleep:feedback:input")
            .setLabel("Your thoughts for the warden")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setPlaceholder("What did you enjoy? What could be better?"),
        ),
      );
    await interaction.showModal(modal);
    return;
  }

  // ── Sleep feedback modal submission ──
  if (customId && customId === "sleep:feedback:modal") {
    if (!interaction.isModalSubmit()) return;
    const text = interaction.fields.getTextInputValue("sleep:feedback:input");
    await interaction.reply(noticeViewToDiscord(controller.feedbackConfirmation("sleep")));
    try {
      controller.recordFeedback("sleep", interaction.user.id, text);
    } catch (err) {
      void notifyAdmin("Sleep feedback submission failed", err);
    }
    return;
  }

  // ── Release-notes feedback button ── opens a modal for requests/feedback
  if (customId && customId === "release:feedback") {
    if (!interaction.isButton()) return;
    const modal = new ModalBuilder()
      .setCustomId("release:feedback:modal")
      .setTitle("Request / Feedback")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("release:feedback:input")
            .setLabel("What would you like to see, or tell us?")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setPlaceholder("A feature you'd love, or what you think of the latest update…"),
        ),
      );
    await interaction.showModal(modal);
    return;
  }

  // ── Release-notes feedback modal submission ──
  if (customId && customId === "release:feedback:modal") {
    if (!interaction.isModalSubmit()) return;
    const text = interaction.fields.getTextInputValue("release:feedback:input");
    await interaction.reply(noticeViewToDiscord(controller.feedbackConfirmation("release")));
    try {
      controller.recordFeedback("release", interaction.user.id, text);
    } catch (err) {
      void notifyAdmin("Release feedback submission failed", err);
    }
    return;
  }

  // ── Outcome feedback button ── opens a modal, carrying the action id through so the
  // submission can attribute the feedback to the action whose outcome the button was on.
  if (customId && interaction.isButton() && (customId === "outcome:feedback" || customId.startsWith("outcome:feedback:"))) {
    const actionId = parseOutcomeActionId(customId);
    const modal = new ModalBuilder()
      .setCustomId(`outcome:feedback:modal${actionId !== undefined ? `:${actionId}` : ""}`)
      .setTitle("Share Feedback")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("outcome:feedback:input")
            .setLabel("Your thoughts for the warden")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setPlaceholder("What did you enjoy? What could be better?"),
        ),
      );
    await interaction.showModal(modal);
    return;
  }

  // ── Outcome feedback modal submission ──
  if (customId && interaction.isModalSubmit() && (customId === "outcome:feedback:modal" || customId.startsWith("outcome:feedback:modal:"))) {
    const text = interaction.fields.getTextInputValue(
      "outcome:feedback:input",
    );
    const actionId = parseOutcomeActionId(customId);
    await interaction.reply(noticeViewToDiscord(controller.feedbackConfirmation("outcome-feedback")));
    try {
      controller.recordFeedback("outcome-feedback", interaction.user.id, text, actionId);
    } catch (err) {
      void notifyAdmin("Outcome feedback failed", err);
    }
    return;
  }

  // ── Outcome bug-report button ── opens a modal, carrying the action id through.
  if (customId && interaction.isButton() && (customId === "outcome:bug" || customId.startsWith("outcome:bug:"))) {
    const actionId = parseOutcomeActionId(customId);
    const modal = new ModalBuilder()
      .setCustomId(`outcome:bug:modal${actionId !== undefined ? `:${actionId}` : ""}`)
      .setTitle("Report a Bug")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("outcome:bug:input")
            .setLabel("Describe the bug")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setPlaceholder("What went wrong?"),
        ),
      );
    await interaction.showModal(modal);
    return;
  }

  // ── Outcome bug-report modal submission ──
  if (customId && interaction.isModalSubmit() && (customId === "outcome:bug:modal" || customId.startsWith("outcome:bug:modal:"))) {
    const text = interaction.fields.getTextInputValue("outcome:bug:input");
    const actionId = parseOutcomeActionId(customId);
    await interaction.reply(noticeViewToDiscord(controller.feedbackConfirmation("outcome-bug")));
    try {
      controller.recordFeedback("outcome-bug", interaction.user.id, text, actionId);
    } catch (err) {
      void notifyAdmin("Outcome bug report failed", err);
    }
    return;
  }

  // ── Day-job quick action buttons ──
  if (customId && customId.startsWith("action:dayjob:")) {
    if (!interaction.isButton()) return;
    try {
      const idx = parseInt(customId.slice("action:dayjob:".length), 10);
      const begin = controller.beginDayJob(interaction.user.id, idx);
      if (begin.kind === "no-character") {
        await interaction.reply({
          content: "You don't have a character. Type `/join` first.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (begin.kind === "invalid-job") {
        await interaction.reply({
          content: "Invalid job action.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (begin.kind === "unsafe") {
        await interaction.reply({
          content: `⚠️ **It's no place for honest work here.**\nThe ${begin.location} is too dangerous — make for safer ground before you set to your trade.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      // Defer + blank buttons to show loading.
      const idle = randomIdleMessage();
      await interaction.deferUpdate();
      await interaction.editReply(
        loadingViewToDiscord({ screen: "loading", body: `⏳ **Starting…**\n_${idle}_` }),
      );

      const commute = controller.commuteForWork(interaction.user.id, begin.workplace);
      if (commute.kind === "commuted") {
        // Merge the commute INTO the loading page (don't replace it): the LLM call
        // below takes seconds, so keep the "thinking" indicator visible — the bot
        // hasn't stalled, work is being generated.
        await interaction.editReply(
          commuteViewToDiscord({ screen: "commute", destination: commute.destination, idle }),
        );
      }

      const run = await controller.runWork(interaction.user.id, begin.workPrompt, begin.wage);

      if (run.kind === "outcome") {
        const priv = outcomeViewToDiscord(run.viewPrivate);
        await interaction.webhook.editMessage(interaction.message.id, {
          embeds: [priv],
          components: [...getNavButtons(run.char), ...getOutcomeServiceButtons(run.actionId)],
        });
        const payload = {
          content: `**${run.characterName}** <@${interaction.user.id}> — ${run.distilledType}`,
          embeds: [outcomeViewToDiscord(run.viewPublic)],
          components: getPublicOutcomeButtons(run.actionId),
          allowedMentions: { users: [] },
        };
        await broadcastOutcome({
          client: interaction.client,
          threadId: engine.getMeta(META_RECAP_THREAD_ID),
          payload,
          fallback: () => interaction.followUp(payload),
          subscribeUserIds: [interaction.user.id],
        });
        await announceCollapse(run.char.name, run.prevChar, run.char);
      } else if (run.kind === "empty-action") {
        await interaction.webhook.editMessage(interaction.message.id, {
          embeds: [
            new EmbedBuilder()
              .setTitle("⚔️ Action")
              .setDescription(run.prompt)
              .setColor(0x95a5a6)
              .toJSON(),
          ],
          components: [],
        });
      } else if (run.kind === "divine") {
        // DC-M9.3: a refunded roll is a system fault, not a real outcome — paint the
        // distinct grey ⚠️ System embed (modelled on commands/action.ts:158-170) and stop,
        // without broadcasting or announcing a collapse.
        await interaction.webhook.editMessage(interaction.message.id, {
          embeds: [
            new EmbedBuilder()
              .setTitle("⚠️ System")
              .setDescription(run.text)
              .setColor(0x95a5a6)
              .toJSON(),
          ],
          components: [],
        });
      } else {
        await interaction.webhook.editMessage(interaction.message.id, decisionViewToDiscord(run.view));
      }
    } catch (err) {
      void notifyAdmin("Action (day-job) failed", err);
      const msg = err instanceof Error ? err.message : String(err);
      await interaction.webhook
        .editMessage(interaction.message.id, {
          content: `❌ **Could not act.**\n${msg}`,
          components: [],
          embeds: [],
        })
        .catch(() => {});
    }
    return;
  }

  // ── Action choices ──
  if (customId && customId.startsWith("action:")) {
    if (!interaction.isButton()) return;
    if (VERBOSE)
      console.log(
        c.grey(
          `[verbose] action:button from ${interaction.user.tag} cid=${customId}`,
        ),
      );
    try {
      // Old ordering (pre-M3.2 `handleActionChoice`): getCharacter guard (reply, no
      // defer) → deferUpdate UNCONDITIONALLY → THEN parse the customId. A malformed
      // `action:`-prefixed id still gets acked even though it resolves to nothing.
      const begin = controller.beginChoice(interaction.user.id);

      if (begin.kind === "no-character") {
        await interaction.reply({
          content: "You don't have a character. Type `/join` first.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.deferUpdate();

      let selector: PendingChoiceSelector;
      if (customId === CID_BAIL) {
        selector = { kind: "bail" };
      } else {
        const parsed = parseActionCid(customId);
        if (!parsed) return;
        selector = { kind: "option", index: parsed.optionIdx };
      }

      const label = controller.resolveChoice(begin.character, selector);

      if (!label) {
        await interaction.webhook.editMessage(interaction.message.id, {
          content: "❌ Your action session expired. Try `/action` again.",
          components: [],
          embeds: [],
        });
        return;
      }

      // Blank the buttons; echo the choice with a "Thinking…" line below.
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setDescription(`**You:** ${label}\n\n⏳ **Thinking…**\n_${randomIdleMessage()}_`)
            .setColor(0x95a5a6)
            .toJSON(),
        ],
        components: [],
      });

      try {
        const step = await controller.stepChoice(interaction.user.id, label, begin.character);

        if (step.kind === "decision") {
          await interaction.webhook.editMessage(interaction.message.id, decisionViewToDiscord(step.view));
          if (VERBOSE) console.log(c.grey("[verbose] action: done"));
          return;
        }

        // Resolved — reproduce the pre-M3.2 outcome-render branch verbatim.
        const embed = outcomeViewToDiscord(step.view);
        const serviceButtons = getOutcomeServiceButtons(step.actionId);
        await interaction.webhook.editMessage(interaction.message.id, {
          embeds: [embed],
          components: step.char ? [...getNavButtons(step.char), ...serviceButtons] : serviceButtons,
        });

        const payload = {
          content: `${classEmoji(step.characterClass)} **${step.characterName}** <@${interaction.user.id}> — ${step.distilledType}`,
          embeds: [embed],
          components: getPublicOutcomeButtons(step.actionId),
          allowedMentions: { users: [] },
        };
        await broadcastOutcome({
          client: interaction.client,
          threadId: engine.getMeta(META_RECAP_THREAD_ID),
          payload,
          fallback: () => interaction.followUp(payload),
          subscribeUserIds: [interaction.user.id],
        });
        // Faithful old fallback chain (`character?.name ?? prevChar?.name ?? "A soul"`) —
        // `step.characterName` is pre-defaulted to 'Unknown', which would hide it.
        await announceCollapse(step.char?.name ?? step.prevChar?.name ?? "A soul", step.prevChar, step.char);
        if (VERBOSE) console.log(c.grey("[verbose] action: done"));
      } catch (err) {
        console.error("[action] stepAction error:", err);
        await interaction.webhook.editMessage(interaction.message.id, {
          embeds: [
            new EmbedBuilder()
              .setTitle("⚔️ Action Failed")
              .setDescription(`❌ ${(err as Error).message}\n\nTry \`/action\` again.`)
              .setColor(0xe74c3c)
              .toJSON(),
          ],
          components: [],
        });
      }
    } catch (err) {
      void notifyAdmin("Action choice failed", err);
      if ("reply" in interaction) {
        await (interaction as { reply: Function })
          .reply({
            content:
              "Something went wrong with your action. Try `/action` again.",
            flags: MessageFlags.Ephemeral,
          })
          .catch(() => {});
      }
    }
    return;
  }

  // ── Navigation buttons ──
  if (customId && customId.startsWith("nav:")) {
    if (!interaction.isButton()) return;

    const navTarget = customId.slice(4); // 'hi', 'look', etc.

    // M2: stamp on nav clicks (before any handler logic).
    controller.stampLastPlayed(interaction.user.id);

    // /action shows the day-job menu — can't route through the registry, whose
    // handler expects a ChatInputCommandInteraction with options.
    if (navTarget === "action") {
      try {
        const result = controller.openActionMenu(interaction.user.id);
        switch (result.kind) {
          case "no-character":
            await interaction.reply({
              content:
                "You don't have a character yet. Type `/join` to create one.",
              flags: MessageFlags.Ephemeral,
            });
            break;
          case "no-rolls":
            await interaction.reply({
              content:
                "🛌 **Out of actions for today.**\nRest by the Oak (`/sleep`) and try again tomorrow.",
              flags: MessageFlags.Ephemeral,
            });
            break;
          case "resume-stale":
            // The nav:action stale embed does NOT prepend narration — description is
            // just the prompt, unlike the slash /action stale embed (withNarration).
            await interaction.reply({
              embeds: [
                new EmbedBuilder()
                  .setTitle("⏳ Stale Action")
                  .setDescription(result.prompt)
                  .setColor(0x95a5a6)
                  .toJSON(),
              ],
              components: [],
              flags: MessageFlags.Ephemeral,
            });
            break;
          case "resume-decision": {
            const m = decisionViewToDiscord(result.view);
            await interaction.reply({
              embeds: m.embeds,
              components: m.components,
              flags: MessageFlags.Ephemeral,
            });
            break;
          }
          case "resume-error":
            await interaction.reply({
              content: `❌ **Could not resume.**\n${result.message}`,
              flags: MessageFlags.Ephemeral,
            });
            break;
          case "menu": {
            // New ephemeral message — the old menu used Components V2 flags, so
            // editing it can't use embeds.
            const m = menuViewToDiscord(result.view);
            await interaction.reply({
              embeds: m.embeds,
              components: m.components,
              flags: MessageFlags.Ephemeral,
            });
            // Stash this menu so the Custom… handler can delete it (as in the /action
            // slash path); otherwise the stale menu hangs on screen.
            const menuMsg = await interaction.fetchReply();
            stashMenuMessage(interaction.user.id, {
              applicationId: interaction.applicationId,
              token: interaction.token,
              messageId: menuMsg.id,
            });
            break;
          }
          case "menu-fallback":
            // DC-M9.2.3: composeActionMenu threw — the byte-identical day-job fallback
            // copy (consistent with the ported slash handler's noticeViewToDiscord paint
            // of this same arm). Without this case the switch silently drops the reply.
            await interaction.reply({
              content: result.text,
              flags: MessageFlags.Ephemeral,
            });
            break;
        }
      } catch (err) {
        void notifyAdmin("Nav (action) failed", err);
      }
      return;
    }

    // /sleep (Rest) gets an immediate acknowledging beat before the result lands — mirrors
    // the ⏳ day-job envelope (action.ts:2050-2062) so the click reads as having weight, even
    // though restAtOak resolves synchronously with nothing to actually wait on.
    if (navTarget === "sleep") {
      try {
        const msgFlags = interaction.message?.flags;
        const mode = navResponseMode({
          ephemeral: msgFlags?.has(MessageFlags.Ephemeral) ?? false,
          componentsV2: msgFlags?.has(MessageFlags.IsComponentsV2) ?? false,
        });
        const loadingPayload = buildComponentPayload(
          `🏕️ **Bedding down…**\n_${randomIdleMessage()}_`,
          { ephemeral: true },
        );
        if (mode === "update") {
          await interaction.update(loadingPayload);
        } else {
          await interaction.reply(loadingPayload);
        }

        const sleepHandler = registry.get("sleep");
        const result = sleepHandler
          ? await sleepHandler({ user: { id: interaction.user.id } } as never)
          : "Something went wrong.";

        // No nav bar on /sleep (global message) — matches the generic nav path below.
        const payload = buildComponentPayload(result, { ephemeral: true });
        await interaction.editReply(payload);
      } catch (err) {
        void notifyAdmin("Nav (sleep) failed", err);
        // The loading beat is already showing — land an error over it so the
        // player isn't stuck on "Bedding down…" forever (review of e426bc4).
        try {
          await interaction.editReply(
            buildComponentPayload("Something went wrong. Try again in a moment.", {
              ephemeral: true,
            }),
          );
        } catch {
          // reply itself failed (e.g. interaction expired) — admin is already notified.
        }
      }
      return;
    }

    const navHandler = registry.get(navTarget);
    if (!navHandler) return;

    try {
      const char = engine.getCharacter(interaction.user.id);
      const result = await navHandler({
        user: { id: interaction.user.id },
      } as never);

      // No nav bar on /action (own buttons); /sleep has its own early-return branch
      // above and never reaches here. Otherwise exclude the current command's own button.
      const noNav = navTarget === "action";
      const navButtons =
        noNav || !char ? undefined : getNavButtons(char, navTarget);
      const payload = buildComponentPayload(result, {
        ephemeral: true,
        navButtons,
      });

      // Nav buttons live on V2 ephemeral views, the legacy-embed action outcome, and
      // the public /action outcome — see navResponseMode for why only the first edits
      // in place and the rest spawn a fresh per-clicker ephemeral.
      const msgFlags = interaction.message?.flags;
      const mode = navResponseMode({
        ephemeral: msgFlags?.has(MessageFlags.Ephemeral) ?? false,
        componentsV2: msgFlags?.has(MessageFlags.IsComponentsV2) ?? false,
      });
      if (mode === 'update') {
        await interaction.update(payload);
      } else {
        await interaction.reply(payload);
      }
    } catch (err) {
      void notifyAdmin(`Nav (${navTarget}) failed`, err);
      if ("reply" in interaction) {
        await (interaction as { reply: Function })
          .reply({
            content: "Something went wrong.",
            flags: MessageFlags.Ephemeral,
          })
          .catch(() => {});
      }
    }
    return;
  }
}
