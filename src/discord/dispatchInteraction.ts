/**
 * Every interaction the bot receives is routed from here, reaching the engine only through the
 * injected `deps`; `index.ts` remains the owner of those bindings.
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
import type { CommandRegistry, NavFacts } from "./CommandRegistry.js";
import type { WizardSession } from "../controller/WizardSession.js";
import type { SessionController } from "../controller/SessionController.js";
import type { GameRouter } from "../protocol/router.js";
import type { NoticeViewState, DecisionViewState, OutcomeViewState, MenuViewState } from "../view/viewState.js";
import { noticeViewToDiscord, decisionViewToDiscord, outcomeViewToDiscord, menuViewToDiscord, loadingViewToDiscord, commuteViewToDiscord } from "./viewToDiscord.js";
import { c } from "../util/colors.js";
import { trackPaint } from "./beatPaint.js";
import {
  buildComponentPayload,
  getNavButtons,
  getOutcomeServiceButtons,
  getPublicOutcomeButtons,
  navResponseMode,
  parseOutcomeActionId,
} from "./format.js";
import { classEmoji } from "../render/format.js";
import { announceCollapse } from "./collapse.js";
import { BANNER_IMAGE, imageFiles } from "./images.js";
import { handleInteraction as handleJoinInteraction } from "./commands/join.js";
import { CID_BAIL, parseActionCid } from "../view/actionViewState.js";
import {
  consumeMenuMessage,
  stashMenuMessage,
} from "./commands/action.js";
import {
  broadcastOutcome,
  META_RECAP_THREAD_ID,
} from "./weekly-recap.js";

/**
 * The bindings `index.ts` owns and hands in; this module only holds references to them.
 */
export interface DispatchDeps {
  engine: WorldEngine;
  registry: CommandRegistry;
  joinWizards: WizardSession;
  controller: SessionController;
  router: GameRouter;
  // The nav:sleep loading beat's flavour line, injected so this file imports no engine selector.
  idle: () => string;
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
    router,
    idle,
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

    let activeHandler = handler;
    if (controller.needsCharacterGate(interaction.user.id, commandName)) {
      const joinHandler = registry.get("join");
      if (joinHandler) activeHandler = joinHandler;
    }

    try {
      // The handler hands its `facts.nav` back through this closure: a local, so it cannot outlive
      // the call; never calling it leaves `nav` undefined, the no-nav-bar path.
      let nav: NavFacts | undefined;
      const result = await activeHandler(interaction, (n) => {
        nav = n;
      });
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
          // Nav buttons plus a Feedback button row; the facts come from makeSleepCommand's own
          // `rest.begin` dispatch, not a second engine read here.
          if (nav) {
            navButtons = getNavButtons(nav, "sleep");
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
        // Same closure for every other slash command; `/ping` has no seam event of its own, so
        // index.ts wraps it to supply the fact.
        if (nav) navButtons = getNavButtons(nav, commandName);
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
        // The nav fact rides makeHiCommand's own `hi.open` dispatch.
        let nav: NavFacts | undefined;
        const result = hiHandler
          ? await hiHandler({ user: { id: userId } } as never, (n) => {
              nav = n;
            })
          : "Welcome to the Oak. Type `/hi` to begin.";
        const navButtons = nav ? getNavButtons(nav, "hi") : undefined;
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

    // Dismiss the stale day-job menu now: the modal overlay survives its source message being
    // deleted, and consuming the entry stops the submit handler deleting it a second time.
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
  // `beatPaint` is set only once the thinking beat fires, so a pre-beat guard rejection pays no defer.
  if (customId && customId === "action:custom:modal") {
    if (!interaction.isModalSubmit()) return;
    const description = interaction.fields.getTextInputValue(
      "action:custom:input",
    );

    let beatPaint: Promise<void> | undefined;
    const response = await router.dispatch(
      { type: "action.custom", playerId: interaction.user.id, text: description },
      (beat) => {
        if (beat.ok && beat.view?.screen === "loading" && !beatPaint) {
          const body = beat.view.body;
          beatPaint = trackPaint((async () => {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            await interaction.editReply({
              embeds: [new EmbedBuilder().setDescription(body).setColor(0x95a5a6).toJSON()],
            });
          })());
        }
      },
    );
    if (beatPaint) await beatPaint;

    // Delete the stale day-job menu; skipped only on the profanity rejection (illegal-move),
    // which always precedes any beat.
    if (response.ok || response.error.code !== "illegal-move") {
      const menuInfo = consumeMenuMessage(interaction.user.id);
      if (menuInfo) {
        const { WebhookClient } = await import("discord.js");
        const wh = new WebhookClient({
          id: menuInfo.applicationId,
          token: menuInfo.token,
        });
        await wh.deleteMessage(menuInfo.messageId).catch(() => {});
      }
    }

    try {
      if (!response.ok) {
        if (!beatPaint) {
          // Pre-beat guards paint as one plain ephemeral reply.
          if (
            response.error.code === "no-character" ||
            response.error.code === "no-rolls" ||
            response.error.code === "illegal-move"
          ) {
            await interaction.reply({ content: response.error.message, flags: MessageFlags.Ephemeral });
            return;
          }
          // resume-stale: deferReply then the Stale Action embed. Unlike the slash arm, this never
          // prepends narration even when one is supplied.
          if (response.error.code === "stale-session") {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            await interaction.editReply({
              embeds: [
                new EmbedBuilder()
                  .setTitle("⏳ Stale Action")
                  .setDescription(response.error.message)
                  .setColor(0x95a5a6)
                  .toJSON(),
              ],
              components: [],
            });
            return;
          }
          // Anything else pre-beat is 'internal': defer now (nothing has acked yet) then fall into
          // the shared catch below.
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          throw new Error(response.error.message);
        }
        // Post-beat: the interstitial already deferred, so every arm here edits.
        if (response.error.code === "divine-intervention") {
          // A refunded roll is a system fault, not a real outcome: no broadcast, no collapse notice.
          await interaction.editReply({
            embeds: [
              new EmbedBuilder()
                .setTitle("⚠️ System")
                .setDescription(response.error.message)
                .setColor(0x95a5a6)
                .toJSON(),
            ],
            components: [],
          });
          return;
        }
        if (response.error.code === "empty-action") {
          await interaction.editReply({
            embeds: [
              new EmbedBuilder()
                .setTitle("⚔️ Action")
                .setDescription(response.error.message)
                .setColor(0x95a5a6)
                .toJSON(),
            ],
            components: [],
          });
          return;
        }
        // Any other post-beat failure ('internal', from runCustomAction) — shared catch.
        throw new Error(response.error.message);
      }

      const view = response.view;
      if (view?.screen === "decision") {
        // The resume arm (mid-action, any text) lands here too — ok:true, no beat.
        if (!beatPaint) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await interaction.editReply(decisionViewToDiscord(view as DecisionViewState));
        return;
      }

      // Outcome: the router crosses the identical viewPrivate/viewPublic pair as ONE view.
      const embed = outcomeViewToDiscord(view as OutcomeViewState);
      const facts = response.facts ?? {};
      const nav = facts.nav as NavFacts | undefined;
      const actionId = facts.actionId as number | undefined;
      await interaction.editReply({
        embeds: [embed],
        components: [...(nav ? getNavButtons(nav) : []), ...getOutcomeServiceButtons(actionId)],
      });
      const characterName = facts.characterName as string;
      const distilledType = facts.distilledType as string;
      const payload = {
        content: `**${characterName}** <@${interaction.user.id}> — ${distilledType}`,
        embeds: [embed],
        components: getPublicOutcomeButtons(actionId),
        allowedMentions: { users: [] },
      };
      await broadcastOutcome({
        client: interaction.client,
        threadId: engine.getMeta(META_RECAP_THREAD_ID),
        payload,
        fallback: () => interaction.followUp(payload),
        subscribeUserIds: [interaction.user.id],
      });
      const collapse = facts.collapse as
        | { name: string; prev: { health: number; stamina: number }; updated: { health: number; stamina: number } }
        | undefined;
      // Omitted rather than null-filled when the character is gone: a null `next` makes collapseNotice
      // a no-op.
      if (collapse) await announceCollapse(collapse.name, collapse.prev, collapse.updated);
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

  // ── Sleep feedback modal submission ── a throwing persist comes back as a `persistFailed` fact,
  // not a throw, so notifyAdmin still fires from here.
  if (customId && customId === "sleep:feedback:modal") {
    if (!interaction.isModalSubmit()) return;
    const text = interaction.fields.getTextInputValue("sleep:feedback:input");
    const response = await router.dispatch({
      type: "feedback.submit",
      playerId: interaction.user.id,
      surface: "sleep",
      text,
    });
    if (!response.ok) {
      await interaction.reply({ content: response.error.message, flags: MessageFlags.Ephemeral });
      return;
    }
    const view = response.view;
    if (view?.screen === "notice") {
      await interaction.reply(noticeViewToDiscord(view as NoticeViewState));
    }
    if (response.facts?.persistFailed) {
      void notifyAdmin("Sleep feedback submission failed", new Error("recordFeedback failed"));
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

  // ── Release-notes feedback modal submission ── same persistFailed handling as the sleep leaf.
  if (customId && customId === "release:feedback:modal") {
    if (!interaction.isModalSubmit()) return;
    const text = interaction.fields.getTextInputValue("release:feedback:input");
    const response = await router.dispatch({
      type: "feedback.submit",
      playerId: interaction.user.id,
      surface: "release",
      text,
    });
    if (!response.ok) {
      await interaction.reply({ content: response.error.message, flags: MessageFlags.Ephemeral });
      return;
    }
    const view = response.view;
    if (view?.screen === "notice") {
      await interaction.reply(noticeViewToDiscord(view as NoticeViewState));
    }
    if (response.facts?.persistFailed) {
      void notifyAdmin("Release feedback submission failed", new Error("recordFeedback failed"));
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

  // ── Outcome feedback modal submission ── same persistFailed handling as the sleep leaf.
  if (customId && interaction.isModalSubmit() && (customId === "outcome:feedback:modal" || customId.startsWith("outcome:feedback:modal:"))) {
    const text = interaction.fields.getTextInputValue(
      "outcome:feedback:input",
    );
    const actionId = parseOutcomeActionId(customId);
    const response = await router.dispatch({
      type: "feedback.submit",
      playerId: interaction.user.id,
      surface: "outcome-feedback",
      text,
      actionId,
    });
    if (!response.ok) {
      await interaction.reply({ content: response.error.message, flags: MessageFlags.Ephemeral });
      return;
    }
    const view = response.view;
    if (view?.screen === "notice") {
      await interaction.reply(noticeViewToDiscord(view as NoticeViewState));
    }
    if (response.facts?.persistFailed) {
      void notifyAdmin("Outcome feedback failed", new Error("recordFeedback failed"));
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

  // ── Outcome bug-report modal submission ── the surface is passed explicitly rather than
  // relying on the controller's default; same persistFailed handling as the sleep leaf.
  if (customId && interaction.isModalSubmit() && (customId === "outcome:bug:modal" || customId.startsWith("outcome:bug:modal:"))) {
    const text = interaction.fields.getTextInputValue("outcome:bug:input");
    const actionId = parseOutcomeActionId(customId);
    const response = await router.dispatch({
      type: "bug.submit",
      playerId: interaction.user.id,
      surface: "outcome-bug",
      text,
      actionId,
    });
    if (!response.ok) {
      await interaction.reply({ content: response.error.message, flags: MessageFlags.Ephemeral });
      return;
    }
    const view = response.view;
    if (view?.screen === "notice") {
      await interaction.reply(noticeViewToDiscord(view as NoticeViewState));
    }
    if (response.facts?.persistFailed) {
      void notifyAdmin("Outcome bug report failed", new Error("recordFeedback failed"));
    }
    return;
  }

  // ── Day-job quick action buttons ──
  if (customId && customId.startsWith("action:dayjob:")) {
    if (!interaction.isButton()) return;
    try {
      let beatPaint: Promise<void> | undefined;
      const idx = parseInt(customId.slice("action:dayjob:".length), 10);
      if (!Number.isInteger(idx) || idx < 0) {
        // A malformed suffix parses to NaN, which the event validator rejects as `invalid-event`;
        // dispatching it would page an operator for a bot-side defect, so ack and leave it alone.
        await interaction.deferUpdate();
        return;
      }

      // Defer + blank buttons once the loading beat fires; the guard arms return before it, so they
      // never pay for a defer they don't need.
      const response = await router.dispatch(
        { type: "dayjob.start", playerId: interaction.user.id, jobIndex: idx },
        (beat) => {
          if (!beat.ok) return;
          if (beat.view?.screen === "loading" && !beatPaint) {
            const body = beat.view.body;
            beatPaint = trackPaint((async () => {
              await interaction.deferUpdate();
              await interaction.editReply(loadingViewToDiscord({ screen: "loading", body }));
            })());
          } else if (beat.view?.screen === "commute") {
            // Merge the commute INTO the loading page (don't replace it): chained onto the
            // loading beat's own promise, since it can only paint once that ack has landed.
            const { destination, idle } = beat.view;
            beatPaint = trackPaint((beatPaint ?? Promise.resolve()).then(async () => {
              await interaction.editReply(commuteViewToDiscord({ screen: "commute", destination, idle }));
            }));
          }
        },
      );
      if (beatPaint) await beatPaint;

      if (!response.ok) {
        if (
          response.error.code === "no-character" ||
          response.error.code === "illegal-move" ||
          response.error.code === "unsafe"
        ) {
          // Guard rejections: no defer, plain ephemeral reply.
          await interaction.reply({ content: response.error.message, flags: MessageFlags.Ephemeral });
          return;
        }
        if (response.error.code === "divine-intervention") {
          await interaction.webhook.editMessage(interaction.message.id, {
            embeds: [
              new EmbedBuilder()
                .setTitle("⚠️ System")
                .setDescription(response.error.message)
                .setColor(0x95a5a6)
                .toJSON(),
            ],
            components: [],
          });
          return;
        }
        if (response.error.code === "empty-action") {
          await interaction.webhook.editMessage(interaction.message.id, {
            embeds: [
              new EmbedBuilder()
                .setTitle("⚔️ Action")
                .setDescription(response.error.message)
                .setColor(0x95a5a6)
                .toJSON(),
            ],
            components: [],
          });
          return;
        }
        // Any other failure is 'internal': throwing reuses the shared catch below regardless of
        // whether a beat ever fired.
        throw new Error(response.error.message);
      }

      const view = response.view;
      if (view?.screen === "decision") {
        await interaction.webhook.editMessage(interaction.message.id, decisionViewToDiscord(view as DecisionViewState));
        return;
      }

      // Outcome: the router crosses the identical viewPrivate/viewPublic pair as ONE view.
      const embed = outcomeViewToDiscord(view as OutcomeViewState);
      const facts = response.facts ?? {};
      const nav = facts.nav as NavFacts | undefined;
      const actionId = facts.actionId as number | undefined;
      await interaction.webhook.editMessage(interaction.message.id, {
        embeds: [embed],
        components: [...(nav ? getNavButtons(nav) : []), ...getOutcomeServiceButtons(actionId)],
      });
      const characterName = facts.characterName as string;
      const distilledType = facts.distilledType as string;
      const payload = {
        content: `**${characterName}** <@${interaction.user.id}> — ${distilledType}`,
        embeds: [embed],
        components: getPublicOutcomeButtons(actionId),
        allowedMentions: { users: [] },
      };
      await broadcastOutcome({
        client: interaction.client,
        threadId: engine.getMeta(META_RECAP_THREAD_ID),
        payload,
        fallback: () => interaction.followUp(payload),
        subscribeUserIds: [interaction.user.id],
      });
      const collapse = facts.collapse as
        | { name: string; prev: { health: number; stamina: number }; updated: { health: number; stamina: number } }
        | undefined;
      if (collapse) await announceCollapse(collapse.name, collapse.prev, collapse.updated);
    } catch (err) {
      void notifyAdmin("Action (day-job) failed", err);
      const msg = err instanceof Error ? err.message : String(err);
      const content = `❌ **Could not act.**\n${msg}`;
      // Branch on the real ack state, not on `beatPaint`, which is truthy even when its `deferUpdate`
      // rejected; discord.js sets `deferred`/`replied` only once the ack call resolves.
      if (!interaction.deferred && !interaction.replied) {
        // Un-acked: the webhook has no response to edit, so a PATCH would be rejected and swallowed,
        // leaving the player with no paint and "This interaction failed". Reply plainly instead.
        await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
        return;
      }
      await interaction.webhook
        .editMessage(interaction.message.id, { content, components: [], embeds: [] })
        .catch(() => {});
    }
    return;
  }

  // ── Action choices ── parse first: an unparseable customId acks with `deferUpdate` and returns
  // without dispatching, so no fabricated `action.choose` reaches the wire and the message is untouched.
  if (customId && customId.startsWith("action:")) {
    if (!interaction.isButton()) return;
    if (VERBOSE)
      console.log(
        c.grey(
          `[verbose] action:button from ${interaction.user.tag} cid=${customId}`,
        ),
      );

    // The OUTER try guards every ack and paint below (a dead interaction, a rate limit, a 10062):
    // without it the rejection escapes to index.ts, whose caller has no `catch`.
    try {
      let selector: PendingChoiceSelector;
      if (customId === CID_BAIL) {
        selector = { kind: "bail" };
      } else {
        const parsed = parseActionCid(customId);
        if (!parsed) {
          await interaction.deferUpdate();
          return;
        }
        selector = { kind: "option", index: parsed.optionIdx };
      }

      // The resolved-choice "thinking" screen is the only beat here and it fires after the guards,
      // so the guard-path acks come off the response below, not off a beat.
      let beatPaint: Promise<void> | undefined;
      const response = await router.dispatch(
        { type: "action.choose", playerId: interaction.user.id, selector },
        (beat) => {
          if (beat.ok && beat.view?.screen === "loading" && !beatPaint) {
            const body = beat.view.body;
            beatPaint = trackPaint((async () => {
              await interaction.deferUpdate();
              await interaction.editReply({
                embeds: [new EmbedBuilder().setDescription(body).setColor(0x95a5a6).toJSON()],
                components: [],
              });
            })());
          }
        },
      );
      if (beatPaint) await beatPaint;

      if (!response.ok) {
        // The PRE-beat half: no-character and session-expired come back only before the beat fires;
        // only the post-beat 'internal' below can reach a deferred interaction.
        if (!beatPaint) {
          if (response.error.code === "no-character") {
            await interaction.reply({ content: response.error.message, flags: MessageFlags.Ephemeral });
            return;
          }
          if (response.error.code === "session-expired") {
            // The guard has already passed but no beat has fired on this path — defer
            // now, still inside the ack window since nothing slow ran before this point.
            await interaction.deferUpdate();
            await interaction.webhook.editMessage(interaction.message.id, {
              content: response.error.message,
              components: [],
              embeds: [],
            });
            return;
          }
          // 'internal' before any beat: notifyAdmin plus a plain reply, its own failure swallowed
          // (the interaction may already be in a state that rejects it).
          void notifyAdmin("Action choice failed", new Error(response.error.message));
          await interaction
            .reply({
              content: "Something went wrong with your action. Try `/action` again.",
              flags: MessageFlags.Ephemeral,
            })
            .catch(() => {});
          return;
        }
        // Post-beat 'internal': console.error only, no notifyAdmin, repaint Action Failed. A
        // stepChoice throw lands on the same code, so it must not reach the outer funnel.
        console.error("[action] stepAction error:", new Error(response.error.message));
        await interaction.webhook.editMessage(interaction.message.id, {
          embeds: [
            new EmbedBuilder()
              .setTitle("⚔️ Action Failed")
              .setDescription(`❌ ${response.error.message}\n\nTry \`/action\` again.`)
              .setColor(0xe74c3c)
              .toJSON(),
          ],
          components: [],
        });
        return;
      }

      // Both screens stay inside one INNER try, so an adapter-side paint/broadcast/collapse failure
      // repaints Action Failed rather than reaching the outer funnel.
      try {
        const view = response.view;
        if (view?.screen === "decision") {
          await interaction.webhook.editMessage(interaction.message.id, decisionViewToDiscord(view as DecisionViewState));
          if (VERBOSE) console.log(c.grey("[verbose] action: done"));
          return;
        }

        const embed = outcomeViewToDiscord(view as OutcomeViewState);
        const facts = response.facts ?? {};
        const nav = facts.nav as NavFacts | undefined;
        const actionId = facts.actionId as number | undefined;
        const serviceButtons = getOutcomeServiceButtons(actionId);
        await interaction.webhook.editMessage(interaction.message.id, {
          embeds: [embed],
          components: nav ? [...getNavButtons(nav), ...serviceButtons] : serviceButtons,
        });

        const characterClass = facts.characterClass as string | null | undefined;
        const characterName = facts.characterName as string;
        const distilledType = facts.distilledType as string;
        const payload = {
          content: `${classEmoji(characterClass)} **${characterName}** <@${interaction.user.id}> — ${distilledType}`,
          embeds: [embed],
          components: getPublicOutcomeButtons(actionId),
          allowedMentions: { users: [] },
        };
        await broadcastOutcome({
          client: interaction.client,
          threadId: engine.getMeta(META_RECAP_THREAD_ID),
          payload,
          fallback: () => interaction.followUp(payload),
          subscribeUserIds: [interaction.user.id],
        });
        const collapse = facts.collapse as
          | { name: string; prev: { health: number; stamina: number }; updated: { health: number; stamina: number } }
          | undefined;
        if (collapse) await announceCollapse(collapse.name, collapse.prev, collapse.updated);
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
      // The pre-port outer catch, verbatim: an ack or paint that failed outright pages the
      // admin and tries one plain ephemeral, its own failure swallowed.
      void notifyAdmin("Action choice failed", err);
      await interaction
        .reply({
          content: "Something went wrong with your action. Try `/action` again.",
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
    }
    return;
  }

  // ── Navigation buttons ──
  if (customId && customId.startsWith("nav:")) {
    if (!interaction.isButton()) return;

    const navTarget = customId.slice(4); // 'hi', 'look', etc.

    // Stamp before any handler logic, except nav:action: its menu.open dispatch stamps internally,
    // so stamping here too would double-stamp that one target.
    if (navTarget !== "action") controller.stampLastPlayed(interaction.user.id);

    // /action shows the day-job menu: it can't route through the registry, whose handler expects a
    // ChatInputCommandInteraction with options.
    if (navTarget === "action") {
      try {
        const response = await router.dispatch({ type: "menu.open", playerId: interaction.user.id });
        if (!response.ok) {
          if (response.error.code === "stale-session") {
            // The nav:action stale embed does NOT prepend narration — description is
            // just the prompt, unlike the slash /action stale embed (withNarration).
            await interaction.reply({
              embeds: [
                new EmbedBuilder()
                  .setTitle("⏳ Stale Action")
                  .setDescription(response.error.message)
                  .setColor(0x95a5a6)
                  .toJSON(),
              ],
              components: [],
              flags: MessageFlags.Ephemeral,
            });
          } else if (response.error.code === "internal") {
            // Two sources land here: the ordinary 30-minute action timeout, which paged nobody, and
            // a genuine backend throw, which did. `facts.internalFault` is what tells them apart.
            if (response.facts?.internalFault === true) {
              void notifyAdmin("Nav (action) failed", new Error(response.error.message));
            }
            await interaction.reply({
              content: `❌ **Could not resume.**\n${response.error.message}`,
              flags: MessageFlags.Ephemeral,
            });
          } else {
            // no-character / no-rolls: the router owns this copy (NO_CHARACTER_MENU_COPY /
            // NO_ROLLS_COPY).
            await interaction.reply({ content: response.error.message, flags: MessageFlags.Ephemeral });
          }
          return;
        }

        const view = response.view;
        if (view?.screen === "decision") {
          const m = decisionViewToDiscord(view as DecisionViewState);
          await interaction.reply({
            embeds: m.embeds,
            components: m.components,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        if (view?.screen === "menu") {
          // New ephemeral message — the old menu used Components V2 flags, so
          // editing it can't use embeds.
          const m = menuViewToDiscord(view as MenuViewState);
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
          return;
        }
        // menu-fallback: composeActionMenu threw, so the day-job fallback copy crosses as an
        // ok:true notice view rather than dropping the reply.
        await interaction.reply(noticeViewToDiscord(view as NoticeViewState));
      } catch (err) {
        void notifyAdmin("Nav (action) failed", err);
      }
      return;
    }

    // /sleep gets an immediate acknowledging beat, mirroring the day-job leaf's ⏳ envelope, so the
    // click reads as having weight even though restAtOak resolves synchronously with nothing to wait on.
    if (navTarget === "sleep") {
      try {
        const msgFlags = interaction.message?.flags;
        const mode = navResponseMode({
          ephemeral: msgFlags?.has(MessageFlags.Ephemeral) ?? false,
          componentsV2: msgFlags?.has(MessageFlags.IsComponentsV2) ?? false,
        });
        const loadingPayload = buildComponentPayload(
          `🏕️ **Bedding down…**\n_${idle()}_`,
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
        // The loading beat is already showing, so land an error over it rather than leaving the
        // player stuck on "Bedding down…".
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
      // The nav fact rides the handler's own router dispatch, not a separate engine read: absent
      // when the handler found no character, which is the no-nav-bar fallback.
      let nav: NavFacts | undefined;
      const result = await navHandler({ user: { id: interaction.user.id } } as never, (n) => {
        nav = n;
      });

      // No nav bar on /action (own buttons); /sleep returns above. Otherwise the render drops the
      // button for the page being shown.
      const noNav = navTarget === "action";
      const navButtons = noNav || !nav ? undefined : getNavButtons(nav, navTarget);
      const payload = buildComponentPayload(result, {
        ephemeral: true,
        navButtons,
      });

      // See navResponseMode: a V2 ephemeral view edits in place, while the embed-based outcomes
      // spawn a fresh per-clicker ephemeral instead.
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
