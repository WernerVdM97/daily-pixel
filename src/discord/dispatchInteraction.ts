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
 * Everything `dispatchInteraction` used to reach into `main()`'s closure scope for,
 * plus the self-executing `index.ts` module-level bindings it referenced
 * (`notifyAdmin`/`safeErrorReply`/`VERBOSE`/`ADMIN_USER_ID`).
 * `index.ts` stays the owner of every one of these — this module only holds references.
 */
export interface DispatchDeps {
  engine: WorldEngine;
  registry: CommandRegistry;
  joinWizards: WizardSession;
  controller: SessionController;
  router: GameRouter;
  // The nav:sleep loading beat's flavour line — mirrors `GameRouterDeps.idle` (DC-M9.6):
  // injected the same way, so this file never imports the engine's selector directly.
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

    // Reroute character-gated surfaces to the join wizard when the player has no character yet,
    // instead of dead-ending on a "type /join" string. The join handler owns its own
    // defer/editReply flow, so the early-return below (replied/deferred) takes over from here.
    let activeHandler = handler;
    if (controller.needsCharacterGate(interaction.user.id, commandName)) {
      const joinHandler = registry.get("join");
      if (joinHandler) activeHandler = joinHandler;
    }

    try {
      // DC-M9.6: the handler hands its `facts.nav` back through this closure — a local, so
      // it cannot outlive the call or reach another user's command. A handler that never
      // calls it leaves `nav` undefined, which is the pre-port `!char` no-nav-bar path.
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
          // Goodnight message: nav buttons + a Feedback button row. DC-M9.6: the facts come
          // from makeSleepCommand's own `rest.begin` dispatch (its guard arms carry `nav`
          // too), not from a second engine read here.
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
        // DC-M9.6: same closure, every other slash command. `/ping` is the one registered
        // command with no seam event of its own, so index.ts wraps it to supply the fact.
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
        // DC-M9.6: the nav fact rides makeHiCommand's own `hi.open` dispatch.
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
  // Crosses as action.custom (M9.3.2b): the router owns the profanity guard (DC-M9.7/8/9,
  // ahead of the character guard, dropping this leaf's own now-redundant checkProfanity
  // call), the character/resume/resume-stale/no-rolls guards and the LLM call. Beat-phase
  // signal (DC-M9.3.3, mirrors commands/action.ts): `beatPaint` is set only once the
  // router's thinking beat fires, so a guard rejection that returns before it never pays
  // for a defer it doesn't need.
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

    // Delete the stale day-job menu — skipped only on the profanity rejection (illegal-move,
    // which always precedes any beat), matching today's pre-defer guard which never
    // reaches this line either.
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
          // Pre-beat guard rejections — no-character/no-rolls/illegal-move (profanity,
          // DC-M9.3.8/9) all paint as a single plain ephemeral reply, matching the
          // pre-port top guard's shape.
          if (
            response.error.code === "no-character" ||
            response.error.code === "no-rolls" ||
            response.error.code === "illegal-move"
          ) {
            await interaction.reply({ content: response.error.message, flags: MessageFlags.Ephemeral });
            return;
          }
          // resume-stale (DC-M9.3.7) — deferReply then the Stale Action embed. Latent
          // defect #2 preserved (recorded against nav:action in M9.2, pinned here too):
          // unlike the slash arm, this never prepends narration even when supplied.
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
          // Anything else pre-beat — beginCustomAction itself threw, surfacing as
          // 'internal'. Defer now (nothing has acked yet) then fall into the shared catch
          // below, exactly as the pre-port single outer try/catch would.
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          throw new Error(response.error.message);
        }
        // Post-beat: the interstitial already deferred, so every arm here edits.
        if (response.error.code === "divine-intervention") {
          // DC-M9.3: a refunded roll is a system fault, not a real outcome — paint the
          // distinct grey ⚠️ System embed and stop, no broadcast/collapse.
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

      // Outcome — the RA-6 identical viewPrivate/viewPublic pair crosses as ONE view.
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
      // Omitted (rather than null-char args) when the character is gone — the router's
      // own doc records this as lossless, since a null `next` makes collapseNotice a no-op.
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

  // ── Sleep feedback modal submission ── crosses as feedback.submit (M9.3.2a). A throwing
  // persist no longer reaches this leaf directly: the router swallows it into a
  // `persistFailed` fact (DC-M9.3.10) so notifyAdmin still fires from here.
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

  // ── Release-notes feedback modal submission ── crosses as feedback.submit (M9.3.2a),
  // same persistFailed handling as the sleep leaf above (DC-M9.3.10).
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

  // ── Outcome feedback modal submission ── crosses as feedback.submit (M9.3.2a), same
  // persistFailed handling as the sleep leaf above (DC-M9.3.10).
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

  // ── Outcome bug-report modal submission ── crosses as bug.submit (M9.3.2a), surface
  // passed explicitly to keep today's attribution rather than relying on the controller's
  // default; same persistFailed handling as the sleep leaf above (DC-M9.3.10).
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
  // Crosses as dayjob.start (M9.3.2b): the router owns the character/invalid-job/unsafe
  // guards, the commute + loading beats and the LLM call. The catch below picks its paint
  // channel on the interaction's ack state (M10.0/DC-M10.1), because a throw that lands
  // before anything acked leaves `webhook.editMessage` rejected AND shows the player "This
  // interaction failed" — the action-choices leaf's phase split, one leaf over.
  if (customId && customId.startsWith("action:dayjob:")) {
    if (!interaction.isButton()) return;
    try {
      let beatPaint: Promise<void> | undefined;
      const idx = parseInt(customId.slice("action:dayjob:".length), 10);
      if (!Number.isInteger(idx) || idx < 0) {
        // A malformed suffix parses to NaN, which the event validator rejects as
        // 'invalid-event' — but dispatching it first would fabricate a protocol event
        // claiming a jobIndex of NaN, which the M8.5 corpus would record (M9.3.2b's review
        // blocker, on the choice leaf's identical parse failure). Ack and leave the message
        // alone instead: bot-authored customIds only, so this is a defect to fix at the
        // source, not an engine fault to page an operator about.
        await interaction.deferUpdate();
        return;
      }

      // Defer + blank buttons to show loading, once the router's loading beat fires — the
      // three guard arms (no-character/invalid-job/unsafe) all return before it, so they
      // never pay for a defer they don't need (DC-M9.3.3).
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
          // Guard rejections — no defer, plain ephemeral reply (DC-M9.3.3).
          await interaction.reply({ content: response.error.message, flags: MessageFlags.Ephemeral });
          return;
        }
        if (response.error.code === "divine-intervention") {
          // DC-M9.3: a refunded roll is a system fault, not a real outcome.
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
        // Any other failure ('internal') — beginDayJob itself threw, or anything deeper
        // did. Throwing here reuses the shared catch below verbatim (same message shape,
        // same notifyAdmin call) regardless of whether a beat ever fired.
        throw new Error(response.error.message);
      }

      const view = response.view;
      if (view?.screen === "decision") {
        await interaction.webhook.editMessage(interaction.message.id, decisionViewToDiscord(view as DecisionViewState));
        return;
      }

      // Outcome — the RA-6 identical viewPrivate/viewPublic pair crosses as ONE view.
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
      // The channel is chosen on the interaction's REAL ack state, not on whether a beat
      // fired (M10.0 review, finding 1). `beatPaint` is assigned synchronously the moment
      // the loading beat fires, so it is truthy even when the `deferUpdate` inside it
      // rejected — a live case, since a slow pre-beat guard can push that call past the
      // 3-second window into a 10062. Branching on `beatPaint` there would pick the webhook
      // and reproduce this slice's own fault. discord.js sets `deferred`/`replied` only
      // after the ack call resolves, which makes them the honest signal, and it is the same
      // predicate the followup webhook itself requires.
      if (!interaction.deferred && !interaction.replied) {
        // Un-acked: the followup webhook has no response to edit, so Discord rejects the
        // PATCH — which the `.catch` below then swallows, leaving the player with an
        // unpainted screen AND "This interaction failed". Reply plainly instead, the same
        // ack the leaf's own guard rejections use.
        await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
        return;
      }
      await interaction.webhook
        .editMessage(interaction.message.id, { content, components: [], embeds: [] })
        .catch(() => {});
    }
    return;
  }

  // ── Action choices ──
  // Crosses as action.choose (M9.3.2b). DC-M9.3.4 revisited: the selector must be built
  // before `router.dispatch` can be called at all, which moves parsing ahead of the
  // character guard — the opposite of today's order (guard, then deferUpdate
  // unconditionally, then parse). The prior fix dispatched unconditionally with a
  // guaranteed-out-of-range sentinel selector when the customId didn't parse — dropped
  // (M9.3.2b review, blocker): that sentinel crosses the seam as a real `action.choose`
  // claiming the player picked option Number.MAX_SAFE_INTEGER, a fabricated protocol
  // event the M8.5 replay corpus would record and DC-S5's sequence sanity would then
  // reject on replay; it also changes the player-visible outcome, resolving to
  // `session-expired` (destructive edit, false copy) where today a with-character
  // malformed click leaves the action message untouched. Fix: parse first, and when the
  // customId doesn't parse (and isn't CID_BAIL), ack with `deferUpdate` and return WITHOUT
  // dispatching anything — no protocol event, message left alone, matching today's
  // with-character behaviour exactly. Declared consequence: the charless-plus-malformed
  // cross (M9.3.0 transcript G) now hits the parse failure before the router's own
  // character guard ever runs, so it flips from the plain no-character reply to
  // deferUpdate-then-silence. That cross is unreachable in practice — a charless player
  // has no action message to click, and the character gate reroutes slash commands first
  // — so protocol honesty wins over preserving an unreachable order.
  if (customId && customId.startsWith("action:")) {
    if (!interaction.isButton()) return;
    if (VERBOSE)
      console.log(
        c.grey(
          `[verbose] action:button from ${interaction.user.tag} cid=${customId}`,
        ),
      );

    // The OUTER try is the pre-port leaf's own (it spanned the whole body): the router no
    // longer throws, but every ack and paint below still can — a dead interaction, a rate
    // limit, a 10062 — and without this the rejection escapes dispatchInteraction, whose
    // caller in index.ts has a `finally` and no `catch`, so it would surface as a generic
    // unhandled-rejection DM and the player would lose the fallback reply.
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

    // The router's only beat on this flow is the resolved-choice "thinking" screen, fired
    // after `resolveChoice` succeeds — there is no earlier beat matching today's
    // unconditional post-guard `deferUpdate`, so that ack is triggered off the response
    // itself below rather than off a beat (DC-M9.3.3/DC-M9.3.5).
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
        // Everything here is the PRE-beat half — the router returns no-character and
        // session-expired only before the beat fires, and the post-beat half below is the
        // one arm ('internal' from stepChoice) that can reach a deferred interaction.
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
          // 'internal' — beginChoice/resolveChoice threw before any beat (DC-M9.3.3).
          // Mirrors the pre-port OUTER catch exactly: notifyAdmin + a plain reply, its own
          // failure swallowed (the interaction may already be in a state that rejects it).
          void notifyAdmin("Action choice failed", new Error(response.error.message));
          await interaction
            .reply({
              content: "Something went wrong with your action. Try `/action` again.",
              flags: MessageFlags.Ephemeral,
            })
            .catch(() => {});
          return;
        }
        // Post-beat failure ('internal', from stepChoice) — mirrors the pre-port INNER
        // catch: console.error only, no notifyAdmin, repaint Action Failed. The pinned
        // broadcastOutcome-throws transcript below proves this must not reach the outer
        // funnel, and a stepChoice throw gets the identical treatment by construction —
        // both come back from the router as the same 'internal' code.
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

      // Resolved successfully — decision or outcome. Both stay inside one INNER try,
      // mirroring the pre-port leaf's inner try spanning stepChoice AND its own render, so
      // an adapter-side paint/broadcast/collapse failure repaints Action Failed too
      // (pinned: "broadcastOutcome throwing repaints Action Failed, not the outer funnel").
      try {
        const view = response.view;
        if (view?.screen === "decision") {
          await interaction.webhook.editMessage(interaction.message.id, decisionViewToDiscord(view as DecisionViewState));
          if (VERBOSE) console.log(c.grey("[verbose] action: done"));
          return;
        }

        // Resolved — reproduce the pre-M3.2 outcome-render branch verbatim.
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
        // Omitted (rather than a null-char fallback name) when the character is gone — the
        // router's own doc records this as lossless, since a null `next` makes
        // collapseNotice a no-op (matches commands/action.ts's identical precedent).
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

    // M2: stamp on nav clicks (before any handler logic) — except nav:action, whose
    // menu.open dispatch below stamps internally (router.ts's dispatchMenuOpen, matching
    // this leaf's own pre-M9.3 order). Stamping here TOO would double-stamp that one
    // target; every other nav target still gets exactly the stamp it had before
    // (DC-M9.3.12 — stamping semantics do not change).
    if (navTarget !== "action") controller.stampLastPlayed(interaction.user.id);

    // /action shows the day-job menu — can't route through the registry, whose
    // handler expects a ChatInputCommandInteraction with options. Crosses as menu.open
    // (DC-M9.6): the router owns the character/rolls/resume-in-progress guards.
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
            // Two sources land here and the pre-port leaf treated them oppositely. The
            // controller's `resume-error` arm is the ORDINARY 30-minute action timeout
            // (resumeAction throws the player-facing text) and paged nobody; a genuine
            // backend throw was caught below and paged. The router never throws now, so
            // the catch cannot tell them apart — `facts.internalFault` does, and pages
            // exactly where the pre-port catch did. Paging on both would reproduce M9.2's
            // blocker 1: an operator woken by a player walking away from their screen.
            if (response.facts?.internalFault === true) {
              void notifyAdmin("Nav (action) failed", new Error(response.error.message));
            }
            await interaction.reply({
              content: `❌ **Could not resume.**\n${response.error.message}`,
              flags: MessageFlags.Ephemeral,
            });
          } else {
            // no-character / no-rolls — the router's copy is byte-identical to this
            // leaf's own pre-port literals (NO_CHARACTER_MENU_COPY, NO_ROLLS_COPY).
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
        // menu-fallback (DC-M9.2.3): composeActionMenu threw — the byte-identical day-job
        // fallback copy crosses as an ok:true notice view rather than dropping the reply.
        await interaction.reply(noticeViewToDiscord(view as NoticeViewState));
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
        // DC-M9.6: the idle flavour line is an injected dep, mirroring `GameRouterDeps.idle`
        // — this file no longer imports the engine's selector directly (its last runtime
        // engine import).
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
      // DC-M9.6: the nav fact rides the handler's own router dispatch rather than a separate
      // engine read — absent when the handler found no character, which reproduces today's
      // `!char` no-nav-bar fallback (the charless `nav:hi` edge is reachable and pinned,
      // settling the M9.0-recorded `resolvedChar === null` question).
      let nav: NavFacts | undefined;
      const result = await navHandler({ user: { id: interaction.user.id } } as never, (n) => {
        nav = n;
      });

      // No nav bar on /action (own buttons); /sleep has its own early-return branch
      // above and never reaches here. Otherwise exclude the current command's own button.
      const noNav = navTarget === "action";
      const navButtons = noNav || !nav ? undefined : getNavButtons(nav, navTarget);
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
