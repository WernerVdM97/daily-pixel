/**
 * The Warden's Oak — Discord bot entry point.
 *
 * Startup: load config → init DB + migrate → load YAML assets + scenes →
 * init LLM gateway (fallback chain) → init WorldEngine → register slash
 * commands → login + attach interaction listener.
 */

import { execSync } from "node:child_process";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  Client,
  Events,
  GatewayIntentBits,
  ThreadAutoArchiveDuration,
  REST,
  Routes,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from "discord.js";
import type {
  ChatInputCommandInteraction,
  Interaction,
  RepliableInteraction,
  Message,
} from "discord.js";

import { APP_VERSION } from "./version.js";
import { initDb, closeDb } from "./db/connection.js";
import { migrate } from "./db/migrate.js";
import { UserRepository } from "./db/repositories/user.js";
import { CharacterRepository } from "./db/repositories/character.js";
import { ItemRepository } from "./db/repositories/item.js";
import { ActionRepository } from "./db/repositories/action.js";
import { NpcRepository } from "./db/repositories/npc.js";
import { MetaRepository } from "./db/repositories/meta.js";
import { LlmCallRepository } from "./db/repositories/llm-call.js";

import { WorldEngineImpl } from "./engine/WorldEngineImpl.js";
import type { WorldEngine } from "./engine/WorldEngine.js";
import type { ClassDef, ModifierDef } from "./engine/StatComputer.js";
import type { LlmDecision, LlmContext, RecapGateway, CriticGateway } from "./llm/LlmGateway.js";
import { parseCriticGateMode, type CriticGateMode } from "./engine/action/critic-gate.js";
import { DeepseekLlmGateway } from "./llm/DeepseekLlmGateway.js";
import { DeepCapturePolicy } from "./llm/capture-policy.js";
import { readLoggingEnv, staleLoggingEnv } from "./config/env.js";
import {
  FallbackLlmGateway,
  DIVINE_MESSAGE,
} from "./llm/FallbackLlmGateway.js";
import { c } from "./util/colors.js";

import {
  loadAndValidate,
  validateStatDef,
  validateAlignment,
  validateDayJob,
  validateItemSet,
} from "./assets/asset-schemas.js";
import { SceneLoader } from "./scenes/SceneLoader.js";
import { TagResolver } from "./scenes/TagResolver.js";

import {
  CommandRegistry,
  type CommandHandler,
  type NavFacts,
} from "./discord/CommandRegistry.js";
import { WizardSession } from "./discord/WizardSession.js";
import { withEngineNav } from "./discord/navSupply.js";
import { makeStatsCommand } from "./discord/commands/stats.js";
import { makeBackpackCommand } from "./discord/commands/backpack.js";
import { makeHelpCommand } from "./discord/commands/help.js";
import { makeLookCommand } from "./discord/commands/look.js";
import { makeJournalCommand } from "./discord/commands/journal.js";
import { makeMapCommand } from "./discord/commands/map.js";
import { makeFeedbackCommand } from "./discord/commands/feedback.js";
import { makeBugCommand } from "./discord/commands/bug.js";
import { makeSleepCommand } from "./discord/commands/sleep.js";
import { makeHiCommand } from "./discord/commands/hi.js";
import type { DayJobDef } from "./controller/dayJob.js";
import { registerEmoji } from "./discord/format.js";
import { setCollapseBroadcaster } from "./discord/collapse.js";
import {
  pickWeeklyThreat,
  buildThreatAnnouncement,
  buildThreatHeadsUp,
  buildLeaderboardAnnouncement,
  LEADERBOARD_MARKER,
} from "./discord/afternoon.js";
import {
  buildMorningAnnouncement,
  buildEveningAnnouncement,
} from "./discord/announcements.js";
import { pinMessage, pinReplacing, pinKeepingNewest } from "./discord/pin.js";
import {
  buildPlaceholderHeader,
  buildRecapHeader,
  generateWeeklyDigest,
  isThreadDeleted,
  META_RECAP_THREAD_ID,
  META_RECAP_HEADER_ID,
  META_RECAP_WEEK_START,
  META_RECAP_WEEK_NUMBER,
  META_LAST_RECAP_DATE,
} from "./discord/weekly-recap.js";
import {
  loadReleaseNotes,
  buildReleaseNotesMessage,
} from "./discord/release-notes.js";
import {
  makeJoinCommand,
} from "./discord/commands/join.js";
import type { CharDefs } from "./controller/joinWizard.js";
import {
  makeActionCommand,
} from "./discord/commands/action.js";
import { dispatchInteraction, type DispatchDeps } from "./discord/dispatchInteraction.js";
import { SessionController } from "./controller/SessionController.js";
import { GameRouter } from "./protocol/router.js";
import { randomIdleMessage } from "./engine/IdleMessageSelector.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(__dirname, "..", "assets");
const SCENES_DIR = path.join(ASSETS_DIR, "scenes");
const CHAR_CREATION_DIR = path.join(ASSETS_DIR, "char-creation");
const RELEASE_NOTES_DIR = path.join(ASSETS_DIR, "release-notes");

// ── Config ──

const DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? "";
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY ?? "";
const ADMIN_USER_ID = process.env.ADMIN_USER_ID ?? "";
// A/B testing: override the LLM model without a code change. Empty → gateway default.
const LLM_MODEL = process.env.LLM_MODEL?.trim() || undefined;

if (!DISCORD_TOKEN) {
  console.error("FATAL: DISCORD_TOKEN is not set. Set it in .env");
  process.exit(1);
}

if (!ADMIN_USER_ID) {
  console.warn(
    "WARNING: ADMIN_USER_ID is not set. Admin `/sleep` will be unreachable.",
  );
}

const loggingEnv = readLoggingEnv();
const VERBOSE = loggingEnv.verbose;
const TICK_CHANNEL_ID = process.env.TICK_CHANNEL_ID ?? "";

// Boot must warn loudly on any removed logging env var so a stale local `.env` doesn't
// silently regress to defaults.
for (const warning of staleLoggingEnv()) {
  console.warn(c.yellow(`[env] ${warning}`));
}

const capturePolicy = new DeepCapturePolicy(loggingEnv.llmLogThinking, loggingEnv.llmSpiralChars);

/** Commands that need a character; running one without one reroutes to the join wizard. */
const CHARACTER_GATED_COMMANDS = new Set([
  "hi", "look", "action", "stats", "backpack", "journal", "map", "sleep",
]);

// ── Version ──

const VERSION = APP_VERSION;

// ── YAML asset loading (fail-fast) ──

// Each file is validated against its schema at load time, so a malformed asset
// crashes boot with a file+entry+field message instead of a NaN/null downstream.
function loadCharCreationAssets() {
  return {
    classes: loadAndValidate(path.join(CHAR_CREATION_DIR, "classes.yml"), validateStatDef),
    backgrounds: loadAndValidate(path.join(CHAR_CREATION_DIR, "backgrounds.yml"), validateStatDef),
    races: loadAndValidate(path.join(CHAR_CREATION_DIR, "races.yml"), validateStatDef),
    alignments: loadAndValidate(path.join(CHAR_CREATION_DIR, "alignments.yml"), validateAlignment),
    dayJobs: loadAndValidate(path.join(CHAR_CREATION_DIR, "day-jobs.yml"), validateDayJob),
    itemSets: loadAndValidate(path.join(CHAR_CREATION_DIR, "item-sets.yml"), validateItemSet),
  };
}

function buildDayJobIncomeMap(dayJobs: DayJobDef[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const job of dayJobs) {
    map[job.name] = job.base_income;
  }
  return map;
}

/** Adapt a `{ user: { id }, text }` handler to extract `text` from slash command options. */
function withTextOption(
  fn: (
    i: { user: { id: string }; text: string },
    onNav?: (nav: NavFacts | undefined) => void,
  ) => Promise<string>,
): CommandHandler {
  // onNav must be forwarded, or /feedback and /bug silently supply no nav facts (DC-M9.6).
  return async (interaction: unknown, onNav) => {
    const cmd = interaction as ChatInputCommandInteraction;
    const text = cmd.options.getString("text", true);
    return fn({ user: { id: cmd.user.id }, text }, onNav);
  };
}

// ── Timestamp all console output ──
const _origLog = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origError = console.error.bind(console);
const _ts = () => new Date().toISOString().replace("T", " ").slice(0, 23);
console.log = (...args: unknown[]) => _origLog(`[${_ts()}]`, ...args);
console.warn = (...args: unknown[]) => _origWarn(`[${_ts()}]`, ...args);
console.error = (...args: unknown[]) => _origError(`[${_ts()}]`, ...args);

// ── Admin error reporting ──
// Set once the client exists so the process-level handlers below can DM the admin.
let _client: Client | null = null;

/**
 * True for a Discord interaction that can no longer be responded to:
 *   10062 = Unknown interaction (token expired, never acked within 3s, or already consumed),
 *   40060 = Interaction already acknowledged.
 * Both are expected on double-clicks and slow hosts — not incidents. These codes are
 * interaction-response-only (channel sends raise 10003/10008/50001 instead), so they're
 * safe to treat as benign everywhere.
 */
function isDeadInteraction(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 10062 || code === 40060;
}

/**
 * Log an error and best-effort DM it to the admin. Always safe to call — no client,
 * no ADMIN_USER_ID, or a failed DM just degrades to a console log.
 */
async function notifyAdmin(label: string, err: unknown): Promise<void> {
  // Dead interactions are expected — don't log red or DM. Quiet VERBOSE trace only.
  if (isDeadInteraction(err)) {
    if (VERBOSE) console.log(c.grey(`[verbose] ${label}: dead interaction — ignored`));
    return;
  }
  console.error(c.red(`[error] ${label}:`), err);
  if (!ADMIN_USER_ID) return;
  const detail =
    err instanceof Error ? (err.stack ?? err.message) : String(err);
  // Discord messages cap at 2000 chars; leave room for the code fence + label.
  const body = `⚠️ **${label}**  ·  v${VERSION}\n\`\`\`\n${detail.slice(0, 1800)}\n\`\`\``;

  // Prefer the live gateway client; fall back to a REST DM when it isn't ready.
  // Boot-time failures happen before login, where the gateway path would silently
  // degrade to a log and the admin would never hear.
  if (_client) {
    try {
      const admin = await _client.users.fetch(ADMIN_USER_ID);
      await admin.send(body);
      return;
    } catch (e) {
      console.warn(c.yellow("[error] gateway DM failed, trying REST:"), e);
    }
  }

  if (!DISCORD_TOKEN) return;
  try {
    const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
    const dm = (await rest.post(Routes.userChannels(), {
      body: { recipient_id: ADMIN_USER_ID },
    })) as { id: string };
    await rest.post(Routes.channelMessages(dm.id), { body: { content: body } });
  } catch (e) {
    console.warn(c.yellow("[error] could not DM admin (REST fallback):"), e);
  }
}

/** In-character warning DMed to a player who has been absent for 5 days. */
const ABSENCE_WARNING =
  "⚠️ **The Oak stirs without you.**\n\n" +
  "Five days gone, and the wilds have grown bold — something circles where " +
  "your fire used to burn. Return to the Warden's Oak before the danger finds " +
  "you. Type `/hi` to step back in.";

/**
 * Best-effort DM to a user via the gateway client. Swallows every failure (closed
 * DMs, unknown user, client not ready) so one bad recipient never derails a batch.
 */
async function dmUser(discordUserId: string, content: string): Promise<void> {
  if (!_client) return;
  try {
    const user = await _client.users.fetch(discordUserId);
    await user.send(content);
  } catch (e) {
    console.warn(
      c.yellow(`[cron] could not DM ${discordUserId}:`),
      e instanceof Error ? e.message : e,
    );
  }
}

/** Post a plain public message to the tick/announcement channel. Best-effort. */
async function postToTickChannel(content: string): Promise<void> {
  if (!_client || !TICK_CHANNEL_ID) return;
  try {
    const channel = await _client.channels.fetch(TICK_CHANNEL_ID);
    if (channel?.isTextBased() && "send" in channel) {
      await (
        channel as { send: (o: { content: string }) => Promise<unknown> }
      ).send({ content });
    }
  } catch (e) {
    console.warn(
      c.yellow("[cron] could not post to tick channel:"),
      e instanceof Error ? e.message : e,
    );
  }
}

/**
 * Surface an error to the user without ever throwing. `reply()` on an
 * already-replied/deferred interaction throws 40060 ("already acknowledged") —
 * which is what crashed the bot — so we `followUp()` in that case, and swallow
 * any failure (a dead interaction must not take the process down).
 */
async function safeErrorReply(
  interaction: RepliableInteraction,
  content: string,
): Promise<void> {
  try {
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  } catch (e) {
    // Interaction already gone (the thing we were reporting on) — expected. Anything else is a surprise.
    if (isDeadInteraction(e)) return;
    console.warn(c.yellow("[error] could not surface error to user:"), e);
  }
}

/**
 * In-flight guard against double-clicks — the main cause of 10062 across buttons.
 * A second interaction whose key is still processing is a duplicate (double-click
 * or host lag); the source message is often already edited/deleted, so handling it
 * would throw "Unknown interaction". Keyed per (user, source-message) for buttons
 * so unrelated buttons don't block each other, and per (user, customId) for modals.
 */
const _interactionInFlight = new Set<string>();

function interactionGuardKey(interaction: Interaction): string | null {
  if (interaction.isButton()) {
    return `${interaction.user.id}:${interaction.message.id}`;
  }
  if (interaction.isModalSubmit()) {
    return `${interaction.user.id}:${interaction.customId}`;
  }
  return null; // slash commands & autocomplete are inherently unique — not guarded
}

// Catch what per-handler try/catches miss. An uncaught exception is fatal
// (systemd restarts us), so DM first, then exit.
process.on("unhandledRejection", (reason) => {
  void notifyAdmin("Unhandled promise rejection", reason);
});
process.on("uncaughtException", (err) => {
  // Hard backstop in case the DM hangs on the network.
  setTimeout(() => process.exit(1), 4000).unref();
  void notifyAdmin("Uncaught exception — restarting", err).finally(() => {
    closeDb();
    process.exit(1);
  });
});

// ── Nightly tick scheduler ──

/**
 * Schedule the world tick at 3:30 UTC daily: advances the game day (rolls,
 * stamina, health, wealth, NPC movement) and DMs five-day absence warnings.
 * On Mondays it also rolls the weekly recap right after the tick, so the week
 * boundary lines up with the daily action refresh (rather than noon).
 */
function scheduleTick(
  engine: WorldEngine,
  client: Client,
  channelId: string,
  recap?: RecapGateway,
): void {
  const now = Date.now();
  const next = new Date();
  next.setUTCHours(3, 30, 0, 0);
  if (next.getTime() <= now) {
    next.setUTCDate(next.getUTCDate() + 1);
  }

  const delay = next.getTime() - now;
  console.log(
    c.grey(
      `[cron] Next tick scheduled for ${next.toISOString()} (in ${Math.round(delay / 60000)} min)`,
    ),
  );

  setTimeout(async () => {
    try {
      const result = engine.tick(false);
      console.log(
        c.green(
          `[cron] Day ${result.dayNumber} tick completed. ${result.playersAffected} players affected.`,
        ),
      );

      // Five-day absence nudge: DM each player who just crossed the mark.
      // (Empty on the idempotent no-op tick, so naturally safe.)
      if (result.absentWarnings.length > 0) {
        console.log(
          c.grey(
            `[cron] Sending ${result.absentWarnings.length} absence warning DM(s).`,
          ),
        );
        for (const userId of result.absentWarnings) {
          await dmUser(userId, ABSENCE_WARNING);
        }
      }

      // Announce who the wild drained to 0 stamina overnight.
      if (result.collapsedNames.length > 0) {
        console.log(
          c.grey(
            `[cron] Announcing ${result.collapsedNames.length} overnight collapse(s).`,
          ),
        );
        const who = result.collapsedNames.map((n) => `**${n}**`).join(", ");
        await postToTickChannel(
          `🥵 **The wild takes its toll.** Overnight, ${who} collapsed to **0 stamina** out beyond the safe paths — they wake leaden. Return to the Oak and rest to recover.`,
        );
      }

      // Monday — roll the weekly recap at the same instant the day refreshed, so
      // the week boundary aligns with the action reset. Idempotent per UTC day.
      // Stamp set AFTER runWeeklyRecap (which swallows its own errors), so a failed
      // recap still stamps and won't retry-loop within the day. Only non-idempotent
      // path: a crash BETWEEN startNewWeek and this setMeta would re-roll the week on
      // a same-Monday restart. Accepted — rare, and stamp-first would skip the recap
      // entirely on any mid-run restart.
      const todayStr = new Date().toISOString().slice(0, 10);
      if (new Date().getUTCDay() === 1 && engine.getMeta(META_LAST_RECAP_DATE) !== todayStr) {
        await runWeeklyRecap(engine, client, channelId, recap);
        engine.setMeta(META_LAST_RECAP_DATE, todayStr);
      }
    } catch (err) {
      console.error(c.red("[cron] Tick failed:"), err);
      void notifyAdmin("Nightly tick failed", err);
    }

    scheduleTick(engine, client, channelId, recap);
  }, delay);
}

/**
 * Post the public "goodnight" announcement. Reads the unsafe-soul count LIVE (who's
 * still out as night falls), not the tick snapshot. Idempotent per UTC day; never
 * throws. Returns true if posted, false if skipped.
 */
async function runGoodnightAnnouncement(
  engine: WorldEngine,
  client: Client,
  channelId: string,
): Promise<boolean> {
  const today = new Date().toISOString().slice(0, 10);

  if (engine.getMeta("last_goodnight_date") === today) {
    console.log(c.grey("[cron] Goodnight already posted today — skipping."));
    return false;
  }

  try {
    const soulsInUnsafe = engine.countSoulsInUnsafe();
    const day = Number(engine.getMeta("day_number") ?? "1");
    const content = buildEveningAnnouncement({ day, soulsInUnsafe });

    const channel = await client.channels.fetch(channelId);
    if (channel?.isTextBased() && "send" in channel) {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("nav:hi")
          .setLabel("Hi")
          .setStyle(ButtonStyle.Secondary)
          .setEmoji("🌅"),
      );
      await (
        channel as {
          send: (opts: {
            content: string;
            components: unknown[];
          }) => Promise<unknown>;
        }
      ).send({ content, components: [row] });

      engine.setMeta("last_goodnight_date", today);
      console.log(
        c.green(`[cron] Goodnight posted (${soulsInUnsafe} soul(s) in the wild).`),
      );
      return true;
    } else {
      console.error(
        c.red(`[cron] Channel ${channelId} is not a text channel or not found`),
      );
      return false;
    }
  } catch (err) {
    console.error(c.red("[cron] Goodnight announcement failed:"), err);
    void notifyAdmin("Goodnight announcement failed", err);
    return false;
  }
}

/**
 * Schedule the goodnight announcement at 18:30 UTC daily. On boot, if we're past
 * today's 18:30 and it hasn't posted, fires immediately.
 */
function scheduleGoodnightAnnouncement(
  engine: WorldEngine,
  client: Client,
  channelId: string,
): void {
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);

  const next = new Date();
  next.setUTCHours(18, 30, 0, 0);
  next.setUTCMinutes(30, 0, 0);
  if (next.getTime() <= now) {
    if (engine.getMeta("last_goodnight_date") !== today) {
      console.log(
        c.yellow("[cron] Boot-time catch-up: posting missed goodnight now."),
      );
      void runGoodnightAnnouncement(engine, client, channelId);
    }
    next.setUTCDate(next.getUTCDate() + 1);
  }

  const delay = next.getTime() - now;
  console.log(
    c.grey(
      `[cron] Next goodnight scheduled for ${next.toISOString()} (in ${Math.round(delay / 60000)} min)`,
    ),
  );

  setTimeout(async () => {
    await runGoodnightAnnouncement(engine, client, channelId);
    scheduleGoodnightAnnouncement(engine, client, channelId);
  }, delay);
}

/**
 * Post the day-transition message with a "/hi" button. Gates on the tick having
 * completed today. Idempotent per UTC day. Returns true if posted, false if skipped.
 */
async function runMorningAnnouncement(
  engine: WorldEngine,
  client: Client,
  channelId: string,
): Promise<boolean> {
  const today = new Date().toISOString().slice(0, 10);

  const lastAnnouncement = engine.getMeta("last_announcement_date");
  if (lastAnnouncement === today) {
    console.log(c.grey("[cron] Announcement already sent today — skipping."));
    return false;
  }

  // H3: gate on tick success — don't post stale stats if the tick hasn't completed today.
  const lastCron = engine.getMeta("last_cron_date");
  if (lastCron !== today) {
    console.log(
      c.grey("[cron] Tick did not complete today — skipping announcement."),
    );
    // World stalled: the tick failed/never ran, so no day advanced. Alert the
    // admin so it doesn't sit silently (recoverable via admin `/sleep`).
    void notifyAdmin(
      "World stalled — announcement skipped",
      new Error(
        `Nightly tick did not complete for ${today} (last_cron_date=${lastCron ?? "none"}). ` +
          "No day advanced. Run admin `/sleep` to catch up.",
      ),
    );
    return false;
  }

  try {
    const dayNumber = engine.getMeta("day_number") ?? "1";
    const playersAffected = Number(
      engine.getMeta("last_tick_players_affected") ?? "0",
    );
    const npcMovementCount = Number(
      engine.getMeta("last_tick_npc_movement_count") ?? "0",
    );

    // Saturday: fold an early heads-up of the day's wilderness threat into the dawn message, so the
    // warning lands at 05:30 — not only at the 12:00 reveal (which names + spawns the foe).
    const now = new Date();
    const threatHeadsUp =
      now.getUTCDay() === 6 ? buildThreatHeadsUp(pickWeeklyThreat(now)) : undefined;

    const content = buildMorningAnnouncement({
      day: Number(dayNumber),
      playersAffected,
      npcMovementCount,
      threatHeadsUp,
    });

    const channel = await client.channels.fetch(channelId);
    if (channel?.isTextBased() && "send" in channel) {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("nav:hi")
          .setLabel("Hi")
          .setStyle(ButtonStyle.Secondary)
          .setEmoji("🌅"),
      );

      await (
        channel as {
          send: (opts: {
            content: string;
            components: unknown[];
          }) => Promise<unknown>;
        }
      ).send({
        content,
        components: [row],
      });

      engine.setMeta("last_announcement_date", today);
      console.log(c.green(`[cron] Day ${dayNumber} announcement posted.`));
      return true;
    } else {
      console.error(
        c.red(`[cron] Channel ${channelId} is not a text channel or not found`),
      );
      return false;
    }
  } catch (err) {
    console.error(c.red("[cron] Morning announcement failed:"), err);
    void notifyAdmin("Morning announcement failed", err);
    return false;
  }
}

/**
 * Schedule the morning announcement at 5:30 UTC daily.
 * M1: on boot, if the tick already ran today but the announcement was missed
 * (e.g. restart between 03:30 and 05:30 UTC), runs it immediately.
 */
function scheduleMorningAnnouncement(
  engine: WorldEngine,
  client: Client,
  channelId: string,
): void {
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);

  // M1: boot-time catch-up — past today's 05:30, announcement not fired, tick ran → fire now.
  const next = new Date();
  next.setUTCHours(5, 30, 0, 0);
  next.setUTCMinutes(30, 0, 0);
  if (next.getTime() <= now) {
    const lastAnnouncement = engine.getMeta("last_announcement_date");
    const lastCron = engine.getMeta("last_cron_date");
    if (lastAnnouncement !== today && lastCron === today) {
      console.log(
        c.yellow("[cron] Boot-time catch-up: running missed announcement now."),
      );
      void runMorningAnnouncement(engine, client, channelId);
    }
    next.setUTCDate(next.getUTCDate() + 1);
  }

  const delay = next.getTime() - now;
  console.log(
    c.grey(
      `[cron] Next morning announcement scheduled for ${next.toISOString()} (in ${Math.round(delay / 60000)} min)`,
    ),
  );

  setTimeout(async () => {
    await runMorningAnnouncement(engine, client, channelId);
    scheduleMorningAnnouncement(engine, client, channelId);
  }, delay);
}

// ── Afternoon beats (12:00 UTC) ──

/** Post a channel announcement with a single "Hi" button. Returns the sent
 *  message (so the caller can pin it), or null if the channel wasn't usable. */
async function postAnnouncement(
  client: Client,
  channelId: string,
  content: string,
): Promise<Message | null> {
  const channel = await client.channels.fetch(channelId);
  if (channel?.isTextBased() && "send" in channel) {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("nav:hi")
        .setLabel("Hi")
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("🌅"),
    );
    return await (
      channel as {
        send: (opts: {
          content: string;
          components: unknown[];
        }) => Promise<Message>;
      }
    ).send({ content, components: [row] });
  }
  console.error(
    c.red(`[cron] Channel ${channelId} is not a text channel or not found`),
  );
  return null;
}

/**
 * The midday beat, dispatched by UTC weekday:
 *   - Saturday  → spawn a rotating wilderness threat NPC + post the hint.
 *   - Wed & Sun → post the wealth + might leaderboards.
 * Other days are no-ops. Each beat is idempotent per UTC day via a meta key.
 * (The Monday weekly-recap rollover runs with the nightly tick, not here.)
 */
async function runAfternoonBeat(
  engine: WorldEngine,
  client: Client,
  channelId: string,
): Promise<void> {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const weekday = now.getUTCDay(); // 0 = Sunday … 6 = Saturday

  try {
    if (weekday === 6) {
      // Saturday — wilderness threat.
      if (engine.getMeta("last_threat_date") === dateStr) {
        console.log(c.grey("[cron] Saturday threat already posted today — skipping."));
        return;
      }
      const threat = pickWeeklyThreat(now);
      engine.spawnNpc({
        name: threat.npc.name,
        class: threat.npc.class,
        race: threat.npc.race,
        description: threat.npc.description,
        location: threat.location,
      });
      // Stamp the idempotency meta on the irreversible side effect (the spawn),
      // not on announcement success — else a failed post lets a later run pass the
      // guard and spawn a duplicate NPC. Failed post = no message, never a dupe mob.
      engine.setMeta("last_threat_date", dateStr);
      const threatMsg = await postAnnouncement(client, channelId, buildThreatAnnouncement(threat));
      if (threatMsg) {
        await pinReplacing(threatMsg, '⚔️ **A threat stirs in the wild.**', 'Saturday threat');
        console.log(
          c.green(`[cron] Saturday threat posted: ${threat.npc.name} at ${threat.location}.`),
        );
      } else {
        console.warn(
          c.yellow(`[cron] Saturday threat spawned (${threat.npc.name} at ${threat.location}) but announcement failed to post.`),
        );
      }
    } else if (weekday === 3 || weekday === 0) {
      // Wednesday & Sunday — leaderboards.
      if (engine.getMeta("last_leaderboard_date") === dateStr) {
        console.log(c.grey("[cron] Leaderboards already posted today — skipping."));
        return;
      }
      const boards = engine.getLeaderboards(5);
      const boardMsg = await postAnnouncement(client, channelId, buildLeaderboardAnnouncement(boards));
      if (boardMsg) {
        engine.setMeta("last_leaderboard_date", dateStr);
        // Pin the latest board, unpin older ones (only the newest stays).
        await pinReplacing(boardMsg, LEADERBOARD_MARKER, "leaderboard");
        console.log(c.green("[cron] Leaderboards posted."));
      }
    }
  } catch (err) {
    console.error(c.red("[cron] Afternoon beat failed:"), err);
    void notifyAdmin("Afternoon beat failed", err);
  }
}

/** Schedule the afternoon beat to fire at 12:00 UTC daily. */
function scheduleAfternoonBeat(
  engine: WorldEngine,
  client: Client,
  channelId: string,
): void {
  const now = Date.now();
  const next = new Date();
  next.setUTCHours(12, 0, 0, 0);
  if (next.getTime() <= now) {
    next.setUTCDate(next.getUTCDate() + 1);
  }

  const delay = next.getTime() - now;
  console.log(
    c.grey(
      `[cron] Next afternoon beat scheduled for ${next.toISOString()} (in ${Math.round(delay / 60000)} min)`,
    ),
  );

  setTimeout(async () => {
    await runAfternoonBeat(engine, client, channelId);
    scheduleAfternoonBeat(engine, client, channelId);
  }, delay);
}

// ── Weekly recap (Monday rollover) ──

/** How many weekly headers stay pinned as an archive (older ones are unpinned, but their
 *  messages + threads persist). Bounded to leave headroom under Discord's 50-pin channel cap. */
const WEEKLY_HEADER_PINS_KEPT = 12;

/**
 * Current UTC time as a 'YYYY-MM-DD HH:MM:SS' string — the same format SQLite's
 * `datetime('now')` stamps on `actions.created_at`, so it compares lexically as the
 * recap window boundary. The boundary is this exact rollover instant (not a calendar
 * date): outcomes route on `recap_thread_id`, which flips only when the new week
 * starts, so one shared timestamp keeps the closing week's window aligned with what
 * landed in its thread — no gap, no double-count across the Monday rollover.
 */
function nowDbTimestamp(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

type GuildTextChannel = {
  send: (opts: { content: string }) => Promise<Message>;
  messages: { fetch: (id: string) => Promise<Message> };
};

function isGuildTextChannel(channel: unknown): channel is GuildTextChannel {
  return (
    !!channel &&
    typeof (channel as { send?: unknown }).send === "function" &&
    typeof (channel as { messages?: { fetch?: unknown } }).messages?.fetch === "function"
  );
}

/**
 * Edit the previous week's placeholder header into its finalized chronicle
 * (digest + highlights) from that week's actions. A missing header/week (first
 * run) or an unreachable message is a no-op.
 */
async function finalizePreviousWeek(
  engine: WorldEngine,
  client: Client,
  channelId: string,
  recap: RecapGateway | undefined,
  boundaryTs: string,
): Promise<void> {
  const headerId = engine.getMeta(META_RECAP_HEADER_ID);
  const threadId = engine.getMeta(META_RECAP_THREAD_ID);
  const weekStart = engine.getMeta(META_RECAP_WEEK_START);
  if (!headerId || !weekStart) return; // nothing to finalize yet

  const weekNumber = Number(engine.getMeta(META_RECAP_WEEK_NUMBER) ?? "1");

  const channel = await client.channels.fetch(channelId);
  if (!isGuildTextChannel(channel)) return;

  // Fetch the header BEFORE the (paid, multi-second) digest call — a deleted header means
  // there's nothing to finalize, so don't spend an LLM call building a chronicle we'd discard.
  let headerMsg: Message;
  try {
    headerMsg = await channel.messages.fetch(headerId);
  } catch (err) {
    console.warn(
      c.yellow(`[recap] Could not fetch Week ${weekNumber} header (${headerId}) — skipping finalize:`),
      err instanceof Error ? err.message : String(err),
    );
    return;
  }

  // Half-open [weekStart, boundaryTs): exactly the actions that landed in this
  // week's thread (the boundary is when the thread id flips below).
  const actions = engine.getActionsBetween(weekStart, boundaryTs);
  const recapResult = await generateWeeklyDigest(actions, recap);

  // Post the chronicle to the thread, lock it, then edit the header to a minimal anchor.
  if (threadId) {
    try {
      const thread = await client.channels.fetch(threadId);
      if (thread && typeof (thread as unknown as Record<string, unknown>).send === 'function') {
        const chronicle = buildRecapHeader(weekNumber, weekStart.slice(0, 10), recapResult);
        await (thread as { send: (c: string) => Promise<unknown> }).send(chronicle);
        // Lock best-effort; a missing Manage Threads permission shouldn't block.
        await (thread as { setLocked: (l: boolean) => Promise<unknown> }).setLocked(true).catch(() => {});
      }
    } catch (err) {
      console.warn(
        c.yellow(`[recap] Could not finalize Week ${weekNumber} thread (${threadId}):`),
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  const headerText = `📜 **Week ${weekNumber}** — the tale is told. Scroll down to the last message in the thread for the chronicle.`;
  try {
    await headerMsg.edit(headerText);
    console.log(c.green(`[recap] Finalized Week ${weekNumber} chronicle (${actions.length} actions).`));
  } catch (err) {
    console.warn(
      c.yellow(`[recap] Could not edit Week ${weekNumber} header (${headerId}):`),
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Start a new week: post a placeholder header in the channel, pin it, open a
 * public thread on it, and persist the thread/header ids + week start + number.
 */
async function startNewWeek(
  engine: WorldEngine,
  client: Client,
  channelId: string,
  startTs: string,
): Promise<void> {
  const weekNumber = Number(engine.getMeta(META_RECAP_WEEK_NUMBER) ?? "0") + 1;

  const channel = await client.channels.fetch(channelId);
  if (!isGuildTextChannel(channel)) {
    console.error(c.red(`[recap] Channel ${channelId} not usable for the weekly header.`));
    return;
  }

  const header = await channel.send({ content: buildPlaceholderHeader(weekNumber, startTs.slice(0, 10)) });
  // Both placeholder and finalized headers start with "📜 **Week"; keep the newest few pinned as a
  // browsable archive and trim older ones so the channel never hits Discord's 50-pin cap.
  await pinKeepingNewest(header, "📜 **Week", WEEKLY_HEADER_PINS_KEPT, `Week ${weekNumber} header`);
  // OneWeek so the thread doesn't auto-archive mid-week on a quiet day (which would bounce
  // outcomes back to the channel); the guild may downgrade it if its boost tier is too low.
  const thread = await header.startThread({
    name: `Week ${weekNumber} — the Oak's log`,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
  });

  engine.setMeta(META_RECAP_THREAD_ID, thread.id);
  engine.setMeta(META_RECAP_HEADER_ID, header.id);
  // Full rollover timestamp (the window lower bound), not just the date.
  engine.setMeta(META_RECAP_WEEK_START, startTs);
  engine.setMeta(META_RECAP_WEEK_NUMBER, String(weekNumber));
  console.log(c.green(`[recap] Started Week ${weekNumber} (thread ${thread.id}).`));
}

/** The Monday rollover: finalize last week, then begin this week — sharing one
 *  boundary timestamp so the two windows meet with no gap or overlap.
 *
 *  Micro-race (accepted): `boundaryTs` is captured up front but the thread id only
 *  flips at the END of startNewWeek, and finalizePreviousWeek between them makes a
 *  multi-second LLM call. An action resolving in that gap routes to the OLD thread
 *  yet has created_at >= boundaryTs, so it's counted in next week's window instead.
 *  Self-healing (it still appears, just in the following digest); finalize-before-flip
 *  is what keeps the windows touching, so we accept the seam over a rollover-wide lock. */
async function runWeeklyRecap(
  engine: WorldEngine,
  client: Client,
  channelId: string,
  recap: RecapGateway | undefined,
): Promise<void> {
  try {
    const boundaryTs = nowDbTimestamp();
    await finalizePreviousWeek(engine, client, channelId, recap, boundaryTs);
    await startNewWeek(engine, client, channelId, boundaryTs);
  } catch (err) {
    console.error(c.red("[recap] Weekly recap failed:"), err);
    void notifyAdmin("Weekly recap failed", err);
  }
}

/** UTC date (YYYY-MM-DD) of the most recent Monday at or before today. */
function mostRecentMondayUtc(): string {
  const d = new Date();
  const daysSinceMonday = (d.getUTCDay() + 6) % 7; // Sun=0→6, Mon=1→0, …
  d.setUTCDate(d.getUTCDate() - daysSinceMonday);
  return d.toISOString().slice(0, 10);
}

/**
 * Boot-time catch-up for a MISSED Monday rollover. The rollover normally fires inside the
 * 03:30 UTC tick (scheduleTick), but if the bot is down across that window — the most common
 * failure mode, deploys and restarts — the week would otherwise never finalize: the placeholder
 * header stays a placeholder forever and the week counter never advances until the *next* Monday
 * (which then folds two weeks into one chronicle and skips a number).
 *
 * On boot, if a week is in progress and the most recent Monday hasn't been recapped yet, roll it
 * now and stamp `META_LAST_RECAP_DATE` with that Monday — so the same-day scheduled trigger (which
 * checks `!== todayStr`) won't double-fire. No week started yet → nothing to catch up
 * (ensureWeeklyThread bootstraps Week 1). Never throws (runWeeklyRecap swallows its own errors).
 * Returns true if it rolled the week.
 */
async function catchUpWeeklyRecap(
  engine: WorldEngine,
  client: Client,
  channelId: string,
  recap: RecapGateway | undefined,
): Promise<boolean> {
  const weekStart = engine.getMeta(META_RECAP_WEEK_START);
  if (!weekStart) return false; // no week in progress
  const monday = mostRecentMondayUtc();
  // The current week must PREDATE this Monday for a rollover to have been due. A week that began
  // on/after this Monday (e.g. bootstrapped mid-week) hasn't missed anything — don't roll it early.
  if (weekStart.slice(0, 10) >= monday) return false;
  const lastRecap = engine.getMeta(META_LAST_RECAP_DATE);
  if (lastRecap && lastRecap >= monday) return false; // already recapped this week
  console.log(
    c.yellow(`[recap] Boot catch-up: missed Monday rollover (weekStart=${weekStart.slice(0, 10)}, last=${lastRecap ?? "never"}, monday=${monday}) — rolling now.`),
  );
  await runWeeklyRecap(engine, client, channelId, recap);
  engine.setMeta(META_LAST_RECAP_DATE, monday);
  return true;
}

/**
 * Boot-time guarantee that a current-week thread exists, so action outcomes have
 * somewhere to post before the first Monday.
 *
 * Recreates the week ONLY when the stored thread is truly gone — no id was ever set,
 * or Discord answers Unknown Channel (10003). A TRANSIENT fetch failure (rate limit,
 * 5xx, boot network blip) is left alone: rolling the week on a hiccup would bump the
 * counter, overwrite the header/start metadata, and orphan the in-progress chronicle.
 * On a transient error we keep the current week and retry next boot. Never throws.
 */
async function ensureWeeklyThread(
  engine: WorldEngine,
  client: Client,
  channelId: string,
): Promise<void> {
  try {
    const threadId = engine.getMeta(META_RECAP_THREAD_ID);
    if (threadId) {
      try {
        await client.channels.fetch(threadId);
        return; // reachable → keep the week
      } catch (err) {
        if (!isThreadDeleted(err)) {
          // Transient failure — do NOT roll the week on a boot-time hiccup.
          console.warn(
            c.yellow(`[recap] thread ${threadId} unreachable (transient, code=${String((err as { code?: unknown }).code)}) — keeping current week:`),
            err instanceof Error ? err.message : String(err),
          );
          return;
        }
        // Unknown Channel → deleted; fall through to recreate.
        console.warn(c.yellow(`[recap] thread ${threadId} is gone (Unknown Channel) — starting a fresh week.`));
      }
    }
    await startNewWeek(engine, client, channelId, nowDbTimestamp());
  } catch (err) {
    console.warn(
      c.yellow("[recap] ensureWeeklyThread failed:"),
      err instanceof Error ? err.message : String(err),
    );
  }
}

// ── Release notes (on version bump) ──

/**
 * On boot, if the running tag (`v<VERSION>`) hasn't been announced and a notes file
 * exists for it, post the player-facing release notes (with a feedback button) to
 * the announcement channel, then stamp the meta so it fires once per tag. Never throws.
 */
async function runReleaseAnnouncement(
  engine: WorldEngine,
  client: Client,
  channelId: string,
): Promise<void> {
  const currentTag = `v${APP_VERSION}`;
  if (engine.getMeta("last_release_announced") === currentTag) return;

  const notes = loadReleaseNotes(currentTag, RELEASE_NOTES_DIR);
  if (!notes) {
    // No notes for this tag — don't stamp, so adding a file later still fires.
    console.log(c.grey(`[release] No notes file for ${currentTag} — skipping.`));
    return;
  }

  try {
    const channel = await client.channels.fetch(channelId);
    if (!(channel?.isTextBased() && "send" in channel)) {
      console.error(c.red(`[release] Channel ${channelId} not usable for release notes.`));
      return;
    }
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("release:feedback")
        .setLabel("Request / Feedback")
        .setStyle(ButtonStyle.Primary)
        .setEmoji("💬"),
    );
    const sent = await (
      channel as {
        send: (opts: {
          content: string;
          components: unknown[];
        }) => Promise<Message>;
      }
    ).send({ content: buildReleaseNotesMessage(notes), components: [row] });
    await pinMessage(sent, `release notes ${currentTag}`);

    engine.setMeta("last_release_announced", currentTag);
    console.log(c.green(`[release] Announced release notes for ${currentTag}.`));
  } catch (err) {
    console.error(c.red("[release] Release announcement failed:"), err);
    void notifyAdmin("Release announcement failed", err);
  }
}

async function main() {
  console.log("The Warden's Oak — starting up...");

  // 1. DB
  migrate(initDb());
  console.log(c.green("[db] SQLite initialized + migrated"));

  // 2. YAML assets (fail-fast before any runtime code)
  const assets = loadCharCreationAssets();
  // Seed the name→emoji lookups read by /stats, /hi, /action and outcome broadcasts
  // (surfaces that hold only a class/job name, not the loaded defs).
  registerEmoji("class", assets.classes as Array<{ name: string; emoji?: string }>);
  registerEmoji("dayJob", assets.dayJobs as Array<{ name: string; emoji?: string }>);
  console.log(
    c.green(
      `[assets] Loaded ${assets.classes.length} classes, ` +
        `${assets.backgrounds.length} backgrounds, ${assets.races.length} races`,
    ),
  );

  // 3. Scene files
  const sceneLoader = new SceneLoader(SCENES_DIR);
  const scenes = sceneLoader.loadAll();
  const tagResolver = new TagResolver(scenes);
  console.log(c.green(`[scenes] Loaded ${scenes.size} ASCII scene files`));

  // 4. LLM gateway
  let llm: FallbackLlmGateway;
  // D3 cartographer — same DeepSeek transport, for async location enrichment.
  // Undefined on the mock path; the engine then leaves provisional rows unenriched.
  let cartographer: DeepseekLlmGateway | undefined;
  // Weekly recap chronicler. Undefined on the mock path (recap falls back to a count summary).
  let recapGateway: RecapGateway | undefined;
  // Coherence critic (Thread 2). On by default; ENABLE_COHERENCE_CRITIC=false opts out.
  const criticEnabled = process.env.ENABLE_COHERENCE_CRITIC !== "false";
  // RA-4c: defaults to "narrate-gated" per decision SL-3 — the decide critic fires on every beat,
  // the narrate critic only on anomaly-flagged ones. "always" restores the pre-RA-4 behaviour and
  // "anomaly" gates both; see `critic-gate.ts` for the A/B evidence behind the default.
  const criticGateMode: CriticGateMode = parseCriticGateMode(process.env.CRITIC_GATE_MODE);
  let criticGateway: CriticGateway | undefined;
  if (DEEPSEEK_API_KEY) {
    const deepseek = new DeepseekLlmGateway({
      apiKey: DEEPSEEK_API_KEY,
      ...(LLM_MODEL ? { model: LLM_MODEL } : {}),
      verbose: loggingEnv.verboseLlm,
      recorder: new LlmCallRepository(initDb()),
      capturePolicy,
    });
    llm = new FallbackLlmGateway(deepseek, {
      onTier2Fallback: () => {
        const metaRepo = new MetaRepository(initDb());
        const count = metaRepo.get("llm_fallback_count");
        metaRepo.set("llm_fallback_count", String(Number(count ?? "0") + 1));
      },
    });
    cartographer = deepseek;
    recapGateway = deepseek;
    criticGateway = deepseek;
    console.log(
      c.cyan(
        `[llm] DeepSeek gateway initialized with fallback chain (model: ${LLM_MODEL ?? "default"})`,
      ),
    );
  } else {
    llm = new FallbackLlmGateway({
      decide: async (_ctx: LlmContext): Promise<LlmDecision> => ({
        distilledType: "__divine__",
        stat: "physical",
        baseDc: 10,
        required: false,
        done: true,
        decision: [],
        outcomeText: DIVINE_MESSAGE,
      }),
    });
    console.warn(
      c.yellow(
        "[llm] No DEEPSEEK_API_KEY — using divine-intervention mock. `/action` will auto-succeed.",
      ),
    );
  }

  // 5. Repositories
  const db = initDb();
  const userRepo = new UserRepository(db);
  const charRepo = new CharacterRepository(db);
  const itemRepo = new ItemRepository(db);
  const actionRepo = new ActionRepository(db);
  const npcRepo = new NpcRepository(db);

  // 6. WorldEngine
  const engine = new WorldEngineImpl({
    db,
    llm,
    userRepo,
    charRepo,
    itemRepo,
    actionRepo,
    npcRepo,
    ...(cartographer ? { cartographer } : {}),
    ...(criticEnabled && criticGateway ? { critic: criticGateway, criticGateMode } : {}),
    // v12 pipeline config (required). Always provided — the legacy v11 machine is gone.
    pipelineLlm: DEEPSEEK_API_KEY ? {
      apiKey: DEEPSEEK_API_KEY,
      ...(LLM_MODEL ? { model: LLM_MODEL } : {}),
      recorder: new LlmCallRepository(initDb()),
      verbose: loggingEnv.verboseLlm,
      capturePolicy,
    } : { apiKey: 'no-key', model: 'fallback' },
    classDefs: assets.classes as ClassDef[],
    upbringingDefs: assets.backgrounds as ModifierDef[],
    raceDefs: assets.races as ModifierDef[],
    dayJobIncome: buildDayJobIncomeMap(assets.dayJobs as DayJobDef[]),
    itemSets: assets.itemSets as Array<{
      name: string;
      for_classes: string[];
      items: Array<{
        name: string;
        emoji: string;
        stat: string;
        modifier: number;
        quantity?: number;
      }>;
    }>,
  });
  console.log(c.green("[engine] WorldEngine initialized"));
  if (criticEnabled && criticGateway) {
    console.log(
      c.cyan(
        `[llm] coherence critic ENABLED, gate=${criticGateMode} (decision + resolution beats; logged as call_kind=critic)`,
      ),
    );
  } else if (!criticEnabled) {
    console.log(c.grey("[llm] coherence critic disabled (ENABLE_COHERENCE_CRITIC=false)"));
  }

  // 7. Command handlers
  const dayJobs = assets.dayJobs as DayJobDef[];

  // Cast through unknown — handlers take stricter param types than CommandHandler
  // ({ user: { id } } vs unknown); at runtime the interaction matches the shape.
  const asHandler = (fn: unknown): CommandHandler => fn as CommandHandler;

  // Scene helpers
  const getCurrentScene = (discordUserId: string): string => {
    const char = engine.getCharacter(discordUserId);
    if (!char) return "";
    const loc = engine.getLocation(char.location);
    const tags = loc?.tags ?? [];
    const sceneName = tagResolver.resolve(tags);
    return scenes.get(sceneName)?.body ?? "";
  };

  // M8.1 (DC-M8.5): look's tag→scene resolver — now a SessionController constructor dep
  // (the type moved with the composer into src/controller/lookScreen.ts). Previously passed
  // per-call to makeLookCommand; the controller owns it and openLook feeds it to the composer.
  const resolveScene = (tags: string[]): { sceneName: string; ascii: string } => {
    const sceneName = tagResolver.resolve(tags);
    const scene = scenes.get(sceneName);
    return { sceneName, ascii: scene?.body ?? "..." };
  };

  // The JSON seam router (M5.1) — every game mechanic crosses it; the controller is its real
  // backend. Created here (before the registry) because the /sleep handler needs the router
  // (M7.1 DC-M7.1.7); the dispatcher's deps reuse the same instance below. rest.begin draws no
  // idle today — the real source keeps production parity for future beats. The wizard store is
  // ONE instance shared by the controller and the dispatcher's `joinWizards` dep (M7.3
  // DC-M7.3.1/10 — docs/decisions/wizard-session-ownership.md), so the bookend oracle's
  // direct store reads stay valid.
  const joinWizards = new WizardSession();
  const controller = new SessionController(
    engine,
    getCurrentScene,
    dayJobs,
    CHARACTER_GATED_COMMANDS,
    joinWizards,
    {
      classes: assets.classes as CharDefs["classes"],
      backgrounds: assets.backgrounds as CharDefs["backgrounds"],
      races: assets.races as CharDefs["races"],
      alignments: assets.alignments as CharDefs["alignments"],
      dayJobs: assets.dayJobs as CharDefs["dayJobs"],
      itemSets: assets.itemSets as CharDefs["itemSets"],
    },
    resolveScene,
  );
  const router = new GameRouter(controller, { idle: () => randomIdleMessage() });

  const registry = new CommandRegistry();

  // DC-M9.6: `/ping` has no seam event to ride, so its nav facts come from the shared
  // wiring wrapper the harness registers too (see navSupply.ts).
  registry.register(
    "ping",
    withEngineNav(engine, asHandler(async () => "pong")),
  );
  registry.register("help", asHandler(makeHelpCommand(router)));
  registry.register("stats", asHandler(makeStatsCommand(router)));
  registry.register("backpack", asHandler(makeBackpackCommand(router)));

  registry.register("look", asHandler(makeLookCommand(router)));
  registry.register("journal", asHandler(makeJournalCommand(router)));
  const mapCommand = makeMapCommand(router);
  registry.register("map", async (interaction: unknown, onNav) => {
    const cmd = interaction as ChatInputCommandInteraction;
    // Reads `place` from the slash command; a nav-button click has no options
    // (the dispatcher passes a bare `{ user }`), so default to the full map.
    const focus =
      typeof cmd.options?.getString === "function"
        ? cmd.options.getString("place") ?? undefined
        : undefined;
    // onNav must be forwarded here too — this wrapper is /map's only registration.
    return mapCommand({ user: { id: cmd.user.id }, focus }, onNav);
  });
  registry.register("feedback", withTextOption(makeFeedbackCommand(router)));
  registry.register("bug", withTextOption(makeBugCommand(router)));
  registry.register("sleep", asHandler(makeSleepCommand(engine, router)));
  registry.register("hi", asHandler(makeHiCommand(router)));
  registry.register(
    "join",
    asHandler(
      makeJoinCommand(router),
    ),
  );

  registry.register(
    "action",
    asHandler(makeActionCommand(router, engine)),
  );

  // 8. Discord client
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  _client = client; // expose for the process-level error handlers (admin DMs)

  // Collapse notices broadcast to the announcement channel. No-op until TICK_CHANNEL_ID is set.
  setCollapseBroadcaster((content) => postToTickChannel(content));

  // An 'error' event with no listener makes EventEmitter throw → crash. Listen so it's reported, not fatal.
  client.on("error", (err) => {
    void notifyAdmin("Discord client error", err);
  });
  client.on("shardError", (err) => {
    void notifyAdmin("Discord shard error", err);
  });

  // Register slash commands with Discord API on ready
  client.once(Events.ClientReady, async (readyClient) => {
    console.log(c.blue(`[discord] Logged in as ${readyClient.user.tag}`));

    const commands = [
      { name: "ping", description: "Check if the bot is alive" },
      { name: "help", description: "Command list and roll economy" },
      { name: "join", description: "Create your character (7-step wizard)" },
      { name: "hi", description: "Begin your day at the Oak" },
      { name: "stats", description: "Full character sheet" },
      { name: "backpack", description: "Inventory emoji grid" },
      { name: "look", description: "Survey your surroundings" },
      {
        name: "journal",
        description: "Browse known locations, NPCs, and recent actions",
      },
      {
        name: "map",
        description: "Your map of the world — charted places and roads yet unwalked",
        options: [
          {
            type: 3, // STRING
            name: "place",
            description: "Zoom to a region or place — fuzzy, e.g. town, vale, the forge",
            required: false,
            max_length: 60,
          },
        ],
      },
      {
        name: "action",
        description: "Take an action — describe what you want to do",
        options: [
          {
            type: 3, // STRING
            name: "description",
            description:
              "What do you want to do? (Leave blank to resume mid-action)",
            required: false,
            max_length: 300, // cap free-text — one action intent, also bounds prompt-injection surface
          },
        ],
      },
      {
        name: "sleep",
        description:
          "Rest by the Oak (admin: advance the world with SLEEP_ADMIN_TICK=true)",
      },
      {
        name: "feedback",
        description: "Share your thoughts with the warden",
        options: [
          {
            type: 3, // STRING
            name: "text",
            description: "Your feedback",
            required: true,
          },
        ],
      },
      {
        name: "bug",
        description: "Report a bug to the warden",
        options: [
          {
            type: 3, // STRING
            name: "text",
            description: "Describe the bug",
            required: true,
          },
        ],
      },
    ];

    const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

    try {
      await rest.put(Routes.applicationCommands(readyClient.user.id), {
        body: commands,
      });
      console.log(
        c.blue(`[discord] Registered ${commands.length} slash commands`),
      );
      console.log(c.yellow(`[version] ${VERSION}`));

      // DM admin on startup with the deployed commit
      if (ADMIN_USER_ID) {
        let headInfo: string;
        try {
          const hash = execSync("git rev-parse --short HEAD", {
            encoding: "utf-8",
          }).trim();
          const msg = execSync("git log -1 --pretty=format:%s", {
            encoding: "utf-8",
          }).trim();
          headInfo = `\`${hash}\` — ${msg}`;
        } catch {
          headInfo = "unknown (no git repo)";
        }
        try {
          const admin = await readyClient.users.fetch(ADMIN_USER_ID);
          await admin.send(`🌳 **The Warden's Oak** is online  |  v${VERSION}
${headInfo}`);
        } catch {
          console.warn(
            c.yellow(
              "[startup] Could not DM admin — cannot fetch user or DMs disabled",
            ),
          );
        }
      }
    } catch (err) {
      console.error(c.red(`[discord] Failed to register slash commands:`), err);
    }

    // ── Scheduled beats (require TICK_CHANNEL_ID) ──
    if (TICK_CHANNEL_ID) {
      scheduleTick(engine, readyClient, TICK_CHANNEL_ID, recapGateway);
      scheduleMorningAnnouncement(engine, readyClient, TICK_CHANNEL_ID);
      scheduleGoodnightAnnouncement(engine, readyClient, TICK_CHANNEL_ID);
      scheduleAfternoonBeat(engine, readyClient, TICK_CHANNEL_ID);
      // Boot catch-up: first finalize a Monday rollover missed while the bot was down, then
      // ensure a current-week thread exists (a no-op if the catch-up just started a fresh week).
      void (async () => {
        await catchUpWeeklyRecap(engine, readyClient, TICK_CHANNEL_ID, recapGateway);
        await ensureWeeklyThread(engine, readyClient, TICK_CHANNEL_ID);
      })();
      // Announce release notes once if the bot just booted on a new tag.
      void runReleaseAnnouncement(engine, readyClient, TICK_CHANNEL_ID);
    } else {
      console.warn(
        c.yellow(
          "[cron] TICK_CHANNEL_ID not set — tick and morning announcements are disabled. Use admin `/sleep` to advance the world.",
        ),
      );
    }
  });

  // Handle all interactions — dispatch is hoisted to ./discord/dispatchInteraction.ts
  // (M1.1); wire the main()-scope bindings + the self-executing index.ts module
  // state the closure used to capture into `deps`. The controller is the seam instance
  // created above (M7.1 DC-M7.1.7 — moved up so the registry's /sleep handler could use
  // the router).
  const dispatchDeps: DispatchDeps = {
    engine,
    registry,
    getCurrentScene,
    dayJobs,
    joinWizards,
    controller,
    router,
    idle: () => randomIdleMessage(),
    notifyAdmin,
    safeErrorReply,
    VERBOSE,
    ADMIN_USER_ID,
  };

  // Single entry point for every interaction — the in-flight guard lives here so
  // no individual handler can forget it.
  client.on(Events.InteractionCreate, async (interaction) => {
    const guardKey = interactionGuardKey(interaction);
    if (guardKey !== null) {
      if (_interactionInFlight.has(guardKey)) {
        // Duplicate click while the first is in flight: silently ack (so Discord
        // doesn't surface "interaction failed") and drop it.
        if (interaction.isButton()) await interaction.deferUpdate().catch(() => {});
        return;
      }
      _interactionInFlight.add(guardKey);
    }
    try {
      await dispatchInteraction(interaction, dispatchDeps);
    } finally {
      if (guardKey !== null) _interactionInFlight.delete(guardKey);
    }
  });

  // 9. Login
  await client.login(DISCORD_TOKEN);
  console.log(c.blue("[discord] Bot is online"));
}

main().catch((err) => {
  // Best-effort DM (only lands if the client logged in), then exit.
  setTimeout(() => process.exit(1), 4000).unref();
  void notifyAdmin("FATAL startup error", err).finally(() => {
    closeDb();
    process.exit(1);
  });
});
