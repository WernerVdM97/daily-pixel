/**
 * The Warden's Oak — Discord bot entry point.
 *
 * Startup sequence:
 *   1. Load config from .env
 *   2. Init SQLite + run migrations
 *   3. Load YAML assets (classes, races, backgrounds, alignments, day-jobs, item-sets)
 *   4. Load ASCII scene files
 *   5. Init LLM gateway (with fallback chain)
 *   6. Init WorldEngine
 *   7. Init command handlers + register slash commands
 *   8. Login to Discord, attach interaction listener
 */

import { execSync } from 'node:child_process';
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client, EmbedBuilder, Events, GatewayIntentBits, REST, Routes, ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import type { ChatInputCommandInteraction, RepliableInteraction } from 'discord.js';

import { APP_VERSION } from './version.js';
import { initDb, closeDb } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { UserRepository } from './db/repositories/user.js';
import { CharacterRepository } from './db/repositories/character.js';
import { ItemRepository } from './db/repositories/item.js';
import { ActionRepository } from './db/repositories/action.js';
import { NpcRepository } from './db/repositories/npc.js';
import { MetaRepository } from './db/repositories/meta.js';
import { LlmCallRepository } from './db/repositories/llm-call.js';

import { WorldEngineImpl } from './engine/WorldEngineImpl.js';
import type { WorldEngine } from './engine/WorldEngine.js';
import type { ClassDef, ModifierDef } from './engine/StatComputer.js';
import type { LlmDecision, LlmContext } from './llm/LlmGateway.js';
import { DeepseekLlmGateway } from './llm/DeepseekLlmGateway.js';
import { FallbackLlmGateway, DIVINE_MESSAGE } from './llm/FallbackLlmGateway.js';
import { c } from './util/colors.js';

import { loadYamlFile } from './assets/yaml-loader.js';
import { SceneLoader } from './scenes/SceneLoader.js';
import { TagResolver } from './scenes/TagResolver.js';

import { randomIdleMessage } from './engine/IdleMessageSelector.js';
import { CommandRegistry, type CommandHandler } from './discord/CommandRegistry.js';
import { WizardSession } from './discord/WizardSession.js';
import { makeStatsCommand } from './discord/commands/stats.js';
import { makeBackpackCommand } from './discord/commands/backpack.js';
import { makeHelpCommand } from './discord/commands/help.js';
import { makeLookCommand } from './discord/commands/look.js';
import { makeJournalCommand } from './discord/commands/journal.js';
import { makeFeedbackCommand } from './discord/commands/feedback.js';
import { makeBugCommand } from './discord/commands/bug.js';
import { makeSleepCommand } from './discord/commands/sleep.js';
import { makeHiCommand, getDayJobActions, type DayJobDef } from './discord/commands/hi.js';
import { buildComponentPayload, getNavButtons } from './discord/format.js';
import { BANNER_IMAGE, imageFiles } from './discord/images.js';
import { makeJoinCommand, handleInteraction as handleJoinInteraction, type CharDefs } from './discord/commands/join.js';
import { makeActionCommand, handleActionChoice, setPendingDecision, buildDecisionMessage, buildOutcomeEmbed, consumeMenuMessage, CID_DAYJOB, CID_DAYJOB_CUSTOM } from './discord/commands/action.js';
import { checkProfanity } from './discord/profanity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const SCENES_DIR = path.join(ASSETS_DIR, 'scenes');
const CHAR_CREATION_DIR = path.join(ASSETS_DIR, 'char-creation');

// ── Config ──

const DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? '';
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY ?? '';
const ADMIN_USER_ID = process.env.ADMIN_USER_ID ?? '';

if (!DISCORD_TOKEN) {
  console.error('FATAL: DISCORD_TOKEN is not set. Set it in .env');
  process.exit(1);
}

if (!ADMIN_USER_ID) {
  console.warn('WARNING: ADMIN_USER_ID is not set. Admin `/sleep` will be unreachable.');
}

const VERBOSE = process.env.VERBOSE === 'true';
const TICK_CHANNEL_ID = process.env.TICK_CHANNEL_ID ?? '';

// ── Version ──

const VERSION = APP_VERSION;

// ── YAML asset loading (fail-fast) ──

function loadCharCreationAssets() {
  return {
    classes: loadYamlFile(path.join(CHAR_CREATION_DIR, 'classes.yml')),
    backgrounds: loadYamlFile(path.join(CHAR_CREATION_DIR, 'backgrounds.yml')),
    races: loadYamlFile(path.join(CHAR_CREATION_DIR, 'races.yml')),
    alignments: loadYamlFile(path.join(CHAR_CREATION_DIR, 'alignments.yml')),
    dayJobs: loadYamlFile(path.join(CHAR_CREATION_DIR, 'day-jobs.yml')),
    itemSets: loadYamlFile(path.join(CHAR_CREATION_DIR, 'item-sets.yml')),
  };
}

function buildDayJobIncomeMap(dayJobs: DayJobDef[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const job of dayJobs) {
    map[job.name] = job.base_income;
  }
  return map;
}

/**
 * Wrap a handler that expects a plain { user: { id }, text } object
 * into one that extracts `text` from Discord's slash command options.
 */
function withTextOption(
  fn: (i: { user: { id: string }; text: string }) => Promise<string>,
): CommandHandler {
  return async (interaction: unknown) => {
    const cmd = interaction as ChatInputCommandInteraction;
    const text = cmd.options.getString('text', true);
    return fn({ user: { id: cmd.user.id }, text });
  };
}

// ── Startup ──

// ── Timestamp all console output ──
const _origLog = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origError = console.error.bind(console);
const _ts = () => new Date().toISOString().replace('T', ' ').slice(0, 23);
console.log = (...args: unknown[]) => _origLog(`[${_ts()}]`, ...args);
console.warn = (...args: unknown[]) => _origWarn(`[${_ts()}]`, ...args);
console.error = (...args: unknown[]) => _origError(`[${_ts()}]`, ...args);

// ── Admin error reporting ──
// Set once the client exists so the process-level handlers below can DM the admin.
let _client: Client | null = null;

/**
 * Log an error and best-effort DM it to the admin. Always safe to call — no client,
 * no ADMIN_USER_ID, or a failed DM just degrades to a console log.
 */
async function notifyAdmin(label: string, err: unknown): Promise<void> {
  console.error(c.red(`[error] ${label}:`), err);
  if (!_client || !ADMIN_USER_ID) return;
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  // Discord messages cap at 2000 chars; leave room for the code fence + label.
  const body = `⚠️ **${label}**  ·  v${VERSION}\n\`\`\`\n${detail.slice(0, 1800)}\n\`\`\``;
  try {
    const admin = await _client.users.fetch(ADMIN_USER_ID);
    await admin.send(body);
  } catch (e) {
    console.warn(c.yellow('[error] could not DM admin the error:'), e);
  }
}

/**
 * Surface an error message to the user without ever throwing. Respects the
 * interaction's acknowledged state — `reply()` on an already-replied/deferred
 * interaction throws DiscordAPIError 40060 ("already acknowledged"), which is
 * exactly what crashed the bot, so we `followUp()` in that case and swallow any
 * failure (a dead interaction must not take the process down).
 */
async function safeErrorReply(interaction: RepliableInteraction, content: string): Promise<void> {
  try {
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content, ephemeral: true });
    } else {
      await interaction.reply({ content, ephemeral: true });
    }
  } catch (e) {
    console.warn(c.yellow('[error] could not surface error to user:'), e);
  }
}

// Catch what the per-handler try/catches miss. A rejected promise in an async
// interaction listener lands here; an uncaught exception is fatal (systemd
// restarts us), so DM first, then exit.
process.on('unhandledRejection', (reason) => {
  void notifyAdmin('Unhandled promise rejection', reason);
});
process.on('uncaughtException', (err) => {
  // Hard backstop in case the DM hangs on the network.
  setTimeout(() => process.exit(1), 4000).unref();
  void notifyAdmin('Uncaught exception — restarting', err).finally(() => {
    closeDb();
    process.exit(1);
  });
});

// ── Nightly tick scheduler ──

/**
 * Schedule the world tick to fire at 3:30 UTC daily.
 * On each tick it advances the game day, posts the day transition to the
 * configured channel, then schedules the next tick.
 */
function scheduleNightlyTick(engine: WorldEngine, client: Client, channelId: string): void {
  const now = Date.now();
  const next = new Date();
  next.setUTCHours(3, 30, 0, 0);
  next.setUTCMinutes(30, 0, 0);
  if (next.getTime() <= now) {
    next.setUTCDate(next.getUTCDate() + 1);
  }

  const delay = next.getTime() - now;
  console.log(c.grey(`[cron] Next tick scheduled for ${next.toISOString()} (in ${Math.round(delay / 60000)} min)`));

  setTimeout(async () => {
    try {
      const result = engine.tick(false);

      const flavor = result.dayNumber <= 3
        ? 'The warden watches the horizon. The fire crackles, steady and low.'
        : 'The smoke on the eastern horizon has thickened. The warden hasn\'t spoken since yesterday.';

      const lines: string[] = [
        `🌅 **Day ${result.dayNumber} begins.**`,
        '',
        flavor,
        '',
        'The Oak awaits. `/hi` to begin.',
      ];

      if (result.playersAffected > 0 || result.npcMovements.length > 0) {
        lines.push('');
        lines.push(`─ ${result.playersAffected} soul(s) stirred, ${result.npcMovements.length} NPC(s) on the move.`);
      }

      const channel = await client.channels.fetch(channelId);
      if (channel?.isTextBased() && 'send' in channel) {
        await (channel as { send: (content: string) => Promise<unknown> }).send(lines.join('\n'));
      } else {
        console.error(c.red(`[cron] Channel ${channelId} is not a text channel or not found`));
      }

      console.log(c.green(`[cron] Day ${result.dayNumber} tick completed. ${result.playersAffected} players affected.`));
    } catch (err) {
      console.error(c.red('[cron] Tick failed:'), err);
    }

    scheduleNightlyTick(engine, client, channelId);
  }, delay);
}

async function main() {
  console.log('The Warden\'s Oak — starting up...');

  // 1. DB
  migrate(initDb());
  console.log(c.green('[db] SQLite initialized + migrated'));

  // 2. YAML assets (fail-fast before any runtime code)
  const assets = loadCharCreationAssets();
  console.log(c.green(`[assets] Loaded ${assets.classes.length} classes, ` +
    `${assets.backgrounds.length} backgrounds, ${assets.races.length} races`));

  // 3. Scene files
  const sceneLoader = new SceneLoader(SCENES_DIR);
  const scenes = sceneLoader.loadAll();
  const tagResolver = new TagResolver(scenes);
  console.log(c.green(`[scenes] Loaded ${scenes.size} ASCII scene files`));

  // 4. LLM gateway
  let llm: FallbackLlmGateway;
  if (DEEPSEEK_API_KEY) {
    const deepseek = new DeepseekLlmGateway({
      apiKey: DEEPSEEK_API_KEY,
      verbose: process.env.VERBOSE_LLM === 'true',
      recorder: new LlmCallRepository(initDb()),
      // POC: failures always log thinking; set this to also log it on every call.
      logThinkingAll: process.env.LOG_LLM_THINKING_ALL === 'true',
    });
    llm = new FallbackLlmGateway(deepseek, {
      onTier2Fallback: () => {
        const metaRepo = new MetaRepository(initDb());
        const count = metaRepo.get('llm_fallback_count');
        metaRepo.set('llm_fallback_count', String(Number(count ?? '0') + 1));
      },
    });
    console.log(c.cyan('[llm] DeepSeek gateway initialized with fallback chain'));
  } else {
    llm = new FallbackLlmGateway({
      decide: async (_ctx: LlmContext): Promise<LlmDecision> => ({
        distilledType: '__divine__',
        stat: 'physical',
        baseDc: 10,
        required: false,
        done: true,
        decision: [],
        outcomeText: DIVINE_MESSAGE,
      }),
    });
    console.warn(c.yellow('[llm] No DEEPSEEK_API_KEY — using divine-intervention mock. `/action` will auto-succeed.'));
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
    classDefs: assets.classes as ClassDef[],
    upbringingDefs: assets.backgrounds as ModifierDef[],
    raceDefs: assets.races as ModifierDef[],
    dayJobIncome: buildDayJobIncomeMap(assets.dayJobs as DayJobDef[]),
    itemSets: assets.itemSets as Array<{ name: string; for_classes: string[]; items: Array<{ name: string; emoji: string; stat: string; modifier: number; quantity?: number }> }>,
  });
  console.log(c.green('[engine] WorldEngine initialized'));

  // 7. Command handlers
  const dayJobs = assets.dayJobs as DayJobDef[];
  const registry = new CommandRegistry();

  // Cast through unknown — handlers have stricter parameter types than
  // CommandHandler expects ({ user: { id: string } } vs unknown).
  // At runtime the interaction object always matches the expected shape.
  const asHandler = (fn: unknown): CommandHandler => fn as CommandHandler;

  registry.register('ping', asHandler(async () => 'pong'));
  registry.register('help', asHandler(makeHelpCommand()));
  registry.register('stats', asHandler(makeStatsCommand(engine)));
  registry.register('backpack', asHandler(makeBackpackCommand(engine)));

  // Scene helpers
  const getCurrentScene = (discordUserId: string): string => {
    const char = engine.getCharacter(discordUserId);
    if (!char) return '';
    const loc = engine.getLocation(char.location);
    const tags = loc?.tags ?? [];
    const sceneName = tagResolver.resolve(tags);
    return scenes.get(sceneName)?.body ?? '';
  };

  registry.register('look', asHandler(makeLookCommand(engine, (tags) => {
    const sceneName = tagResolver.resolve(tags);
    const scene = scenes.get(sceneName);
    return { sceneName, ascii: scene?.body ?? '...' };
  })));
  registry.register('journal', asHandler(makeJournalCommand(engine)));
  registry.register('feedback', withTextOption(makeFeedbackCommand(engine)));
  registry.register('bug', withTextOption(makeBugCommand(engine)));
  registry.register('sleep', asHandler(makeSleepCommand(engine)));
  registry.register('hi', asHandler(makeHiCommand(engine, dayJobs, getCurrentScene)));
  const joinWizards = new WizardSession();
  registry.register('join', asHandler(makeJoinCommand(engine, joinWizards, {
    classes: assets.classes as CharDefs['classes'],
    backgrounds: assets.backgrounds as CharDefs['backgrounds'],
    races: assets.races as CharDefs['races'],
    alignments: assets.alignments as CharDefs['alignments'],
    dayJobs: assets.dayJobs as CharDefs['dayJobs'],
    itemSets: assets.itemSets as CharDefs['itemSets'],
  })));

  registry.register('action', asHandler(makeActionCommand(engine, getCurrentScene, dayJobs)));

  // 8. Discord client
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  _client = client; // expose for the process-level error handlers (admin DMs)

  // An 'error' event with no listener makes EventEmitter throw → process crash.
  // Listen so client/REST errors are reported, not fatal.
  client.on('error', (err) => { void notifyAdmin('Discord client error', err); });
  client.on('shardError', (err) => { void notifyAdmin('Discord shard error', err); });

  // Register slash commands with Discord API on ready
  client.once(Events.ClientReady, async (readyClient) => {
    console.log(c.blue(`[discord] Logged in as ${readyClient.user.tag}`));

    const commands = [
      { name: 'ping', description: 'Check if the bot is alive' },
      { name: 'help', description: 'Command list and roll economy' },
      { name: 'join', description: 'Create your character (7-step wizard)' },
      { name: 'hi', description: 'Begin your day at the Oak' },
      { name: 'stats', description: 'Full character sheet' },
      { name: 'backpack', description: 'Inventory emoji grid' },
      { name: 'look', description: 'Survey your surroundings' },
      { name: 'journal', description: 'Browse known locations, NPCs, and recent actions' },
      {
        name: 'action',
        description: 'Take an action — describe what you want to do',
        options: [
          {
            type: 3, // STRING
            name: 'description',
            description: 'What do you want to do? (Leave blank to resume mid-action)',
            required: false,
          },
        ],
      },
      { name: 'sleep', description: 'Rest by the Oak (admin: advance the world with SLEEP_ADMIN_TICK=true)' },
      {
        name: 'feedback',
        description: 'Share your thoughts with the warden',
        options: [
          {
            type: 3, // STRING
            name: 'text',
            description: 'Your feedback',
            required: true,
          },
        ],
      },
      {
        name: 'bug',
        description: 'Report a bug to the warden',
        options: [
          {
            type: 3, // STRING
            name: 'text',
            description: 'Describe the bug',
            required: true,
          },
        ],
      },
    ];

    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

    try {
      await rest.put(Routes.applicationCommands(readyClient.user.id), { body: commands });
      console.log(c.blue(`[discord] Registered ${commands.length} slash commands`));
      console.log(c.yellow(`[version] ${VERSION}`));

      // DM admin on startup with the deployed commit
      if (ADMIN_USER_ID) {
        let headInfo: string;
        try {
          const hash = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
          const msg = execSync('git log -1 --pretty=format:%s', { encoding: 'utf-8' }).trim();
          headInfo = `\`${hash}\` — ${msg}`;
        } catch {
          headInfo = 'unknown (no git repo)';
        }
        try {
          const admin = await readyClient.users.fetch(ADMIN_USER_ID);
          await admin.send(`🌳 **The Warden's Oak** is online  |  v${VERSION}
${headInfo}`);
        } catch {
          console.warn(c.yellow('[startup] Could not DM admin — cannot fetch user or DMs disabled'));
        }
      }
    } catch (err) {
      console.error(c.red(`[discord] Failed to register slash commands:`) , err);
    }

    // ── Nightly tick scheduler (3:30 UTC) ──
    if (TICK_CHANNEL_ID) {
      scheduleNightlyTick(engine, readyClient, TICK_CHANNEL_ID);
    } else {
      console.warn(c.yellow('[cron] TICK_CHANNEL_ID not set — nightly tick will not post announcements. Use admin `/sleep` to advance the world.'));
    }
  });

  // Handle all interactions
  client.on(Events.InteractionCreate, async (interaction) => {
    // ── Slash commands ──
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;

      if (VERBOSE) {
        const user = interaction.user.tag;
        const options = interaction.options.data.map(o => `${o.name}=${o.value}`).join(', ');
        console.log(c.grey(`[verbose] /${commandName} from ${user} options: ${options || '(none)'}`));
      }

      const handler = registry.get(commandName);
      if (!handler) {
        await interaction.reply({
          content: `Unknown command \`/${commandName}\`. Try \`/help\`.`,
          ephemeral: true,
        });
        return;
      }

      try {
        const result = await handler(interaction);
        // If the handler already replied (join/hi manage their own flow), skip
        if (interaction.replied || interaction.deferred) return;

        const ephemeralCommands = ['stats', 'backpack', 'journal', 'bug', 'feedback', 'help', 'hi', 'look'];
        const isEphemeral = ephemeralCommands.includes(commandName);

        // Nav buttons on all commands except /action (own buttons) and /sleep (global message)
        let navButtons: ReturnType<typeof getNavButtons> | undefined;
        if (commandName !== 'action' && commandName !== 'sleep') {
          const char = engine.getCharacter(interaction.user.id);
          if (char) navButtons = getNavButtons(char, commandName);
        }

        // Admin /sleep shows the world-tick banner only when ticking.
        const isAdminTick = commandName === 'sleep' && interaction.user.id === ADMIN_USER_ID && process.env.SLEEP_ADMIN_TICK === 'true';
        const bannerFiles = isAdminTick ? imageFiles(BANNER_IMAGE) : [];
        const payload = buildComponentPayload(result, {
          ephemeral: isEphemeral,
          navButtons,
          ...(isAdminTick && bannerFiles.length > 0 ? { image: BANNER_IMAGE } : {}),
        });
        await interaction.reply(
          bannerFiles.length > 0 ? { ...payload, files: bannerFiles } : payload,
        );
        if (VERBOSE) {
          console.log(c.grey(`[verbose] /${commandName} → ${result.slice(0, 200)}`));
        }
      } catch (err) {
        void notifyAdmin(`/${commandName} failed (user ${interaction.user.tag})`, err);
        const msg = err instanceof Error ? err.message : String(err);
        await safeErrorReply(interaction, `⚠️ **Something went wrong.**\n\`\`\`${msg}\`\`\``);
      }
      return;
    }

    // ── Button clicks and modal submissions (join wizard) ──
    const customId = 'customId' in interaction
      ? (interaction as { customId: string }).customId
      : null;

    if (customId && customId.startsWith('join:')) {
      if (!interaction.isButton() && !interaction.isModalSubmit()) return;
      if (VERBOSE) console.log(c.grey(`[verbose] join:${interaction.isButton() ? 'button' : 'modal'} from ${interaction.user.tag} cid=${customId}`));
      try {
        // After confirm, join shows the player their first-day /hi view. Build it
        // here where the registry + payload builder live, then hand it back.
        const renderHiScreen = async (userId: string) => {
          const hiHandler = registry.get('hi');
          const result = hiHandler ? await hiHandler({ user: { id: userId } } as never) : 'Welcome to the Oak. Type `/hi` to begin.';
          const char = engine.getCharacter(userId);
          const navButtons = char ? getNavButtons(char, 'hi') : undefined;
          return buildComponentPayload(result, { ephemeral: true, navButtons });
        };
        await handleJoinInteraction(interaction, engine, joinWizards, renderHiScreen);
        if (VERBOSE) console.log(c.grey('[verbose] join: done'));
      } catch (err) {
        // 10062 (Unknown interaction) happens on double-clicks — not a real failure.
        if ((err as Record<string, unknown>)?.code !== 10062) {
          void notifyAdmin('Join interaction failed', err);
        }
        if ('reply' in interaction) {
          await (interaction as { reply: Function }).reply({
            content: 'Something went wrong. Try `/join` again.',
            ephemeral: true,
          }).catch(() => {});
        }
      }
      return;
    }

    // ── Custom action button ── opens a modal for free-text input
    if (customId && customId === 'action:dayjob:custom') {
      if (!interaction.isButton()) return;
      const modal = new ModalBuilder()
        .setCustomId('action:custom:modal')
        .setTitle('Custom Action')
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId('action:custom:input')
              .setLabel('What do you want to do?')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setPlaceholder('e.g. scout the northern ridge'),
          ),
        );
      await interaction.showModal(modal);
      return;
    }

    // ── Custom action modal submission ── starts the action with typed text
    if (customId && customId === 'action:custom:modal') {
      if (!interaction.isModalSubmit()) return;
      const description = interaction.fields.getTextInputValue('action:custom:input');

      // Profanity filter check — blocks matching custom actions before they reach the engine.
      const blocked = checkProfanity(description);
      if (blocked !== null) {
        await interaction.reply({
          content: '❌ That action contains language the warden won\'t tolerate. Try something else.',
          ephemeral: true,
        });
        return;
      }

      await interaction.deferReply({ ephemeral: true });

      // Delete the stale day-job menu message so only the action scene shows
      const menuInfo = consumeMenuMessage(interaction.user.id);
      if (menuInfo) {
        const { WebhookClient } = await import('discord.js');
        const wh = new WebhookClient({ id: menuInfo.applicationId, token: menuInfo.token });
        await wh.deleteMessage(menuInfo.messageId).catch(() => {});
      }

      try {
        const char = engine.getCharacter(interaction.user.id);
        if (!char) {
          await interaction.editReply({ content: "You don't have a character. Type `/join` first." });
          return;
        }
        if (char.lastActionState !== null) {
          const resumeResult = engine.resumeAction(char.id);
          setPendingDecision(interaction.user.id, resumeResult.nextDecision);
          const decisionIdx = resumeResult.state.decisions.length;
          await interaction.editReply(buildDecisionMessage(resumeResult.nextDecision, decisionIdx, resumeResult.state, char));
          return;
        }
        const result = await engine.startAction(char.id, description);
        if (result.outcome) {
          const embed = buildOutcomeEmbed(result.outcome, char, getCurrentScene(interaction.user.id), result.state);
          await interaction.editReply({ embeds: [embed], components: [] });
          await interaction.followUp({ content: `**${char.name}** — ${result.outcome.distilledType}`, embeds: [embed], components: getNavButtons(char) });
        } else if (result.firstDecision.options.length === 0) {
          await interaction.editReply({
            embeds: [new EmbedBuilder().setTitle('⚔️ Action').setDescription(result.firstDecision.prompt).setColor(0x95a5a6).toJSON()],
            components: [],
          });
        } else {
          setPendingDecision(interaction.user.id, result.firstDecision);
          await interaction.editReply(buildDecisionMessage(result.firstDecision, 0, result.state, char));
        }
      } catch (err) {
        void notifyAdmin('Action (custom modal) failed', err);
        const msg = err instanceof Error ? err.message : String(err);
        await interaction.editReply({ content: `❌ **Could not act.**\n${msg}` }).catch(() => {});
      }
      return;
    }

    // ── Day-job quick action buttons ──
    if (customId && customId.startsWith('action:dayjob:')) {
      if (!interaction.isButton()) return;
      const idx = parseInt(customId.slice('action:dayjob:'.length), 10);
      try {
        const char = engine.getCharacter(interaction.user.id);
        if (!char) {
          await interaction.reply({ content: "You don't have a character. Type `/join` first.", ephemeral: true });
          return;
        }
        const dayNumber = Number(engine.getMeta('day_number') ?? '1');
        const jobActions = getDayJobActions(char.dayJob, dayJobs, { characterId: char.id, dayNumber });
        const hook = jobActions[idx]?.hook;
        if (!hook) {
          await interaction.reply({ content: 'Invalid job action.', ephemeral: true });
          return;
        }
        // Defer + immediately blank buttons to show loading
        const idleMsg = randomIdleMessage();
        await interaction.deferUpdate();
        await interaction.editReply({
          embeds: [new EmbedBuilder().setDescription(`⏳ **Starting…**
_${idleMsg}_`).setColor(0x95a5a6).toJSON()],
          components: [],
        });

        const result = await engine.startAction(char.id, hook);
        if (result.outcome) {
          const embed = buildOutcomeEmbed(result.outcome, char, getCurrentScene(interaction.user.id), result.state);
          await interaction.webhook.editMessage(interaction.message.id, { embeds: [embed], components: [] });
          await interaction.followUp({ content: `**${char.name}** — ${result.outcome.distilledType}`, embeds: [embed], components: getNavButtons(char) });
        } else if (result.firstDecision.options.length === 0) {
          await interaction.webhook.editMessage(interaction.message.id, {
            embeds: [new EmbedBuilder().setTitle('⚔️ Action').setDescription(result.firstDecision.prompt).setColor(0x95a5a6).toJSON()],
            components: [],
          });
        } else {
          setPendingDecision(interaction.user.id, result.firstDecision);
          await interaction.webhook.editMessage(interaction.message.id, buildDecisionMessage(result.firstDecision, 0, result.state, char));
        }
      } catch (err) {
        void notifyAdmin('Action (day-job) failed', err);
        const msg = err instanceof Error ? err.message : String(err);
        await interaction.webhook.editMessage(interaction.message.id, { content: `❌ **Could not act.**\n${msg}`, components: [], embeds: [] }).catch(() => {});
      }
      return;
    }

    // ── Action choices ──
    if (customId && customId.startsWith('action:')) {
      if (!interaction.isButton()) return;
      if (VERBOSE) console.log(c.grey(`[verbose] action:button from ${interaction.user.tag} cid=${customId}`));
      try {
        await handleActionChoice(interaction, engine);
        if (VERBOSE) console.log(c.grey('[verbose] action: done'));
      } catch (err) {
        void notifyAdmin('Action choice failed', err);
        if ('reply' in interaction) {
          await (interaction as { reply: Function }).reply({
            content: 'Something went wrong with your action. Try `/action` again.',
            ephemeral: true,
          }).catch(() => {});
        }
      }
      return;
    }

    // ── Navigation buttons ──
    if (customId && customId.startsWith('nav:')) {
      if (!interaction.isButton()) return;

      const navTarget = customId.slice(4); // 'hi', 'look', etc.

      // /action shows the day-job menu instead — can't route through the registry
      // because the handler expects a ChatInputCommandInteraction with options.
      if (navTarget === 'action') {
        try {
          const char = engine.getCharacter(interaction.user.id);
          if (!char) {
            await interaction.reply({
              content: "You don't have a character yet. Type `/join` to create one.",
              ephemeral: true,
            });
            return;
          }
          if (char.rollsRemaining <= 0 && !char.lastActionState) {
            await interaction.reply({
              content: '🛌 **Out of actions for today.**\nRest by the Oak (`/sleep`) and try again tomorrow.',
              ephemeral: true,
            });
            return;
          }

          // Resume if mid-action — send a new ephemeral message (the old one
          // was sent with Components V2 flags, so editing it can't use embeds).
          if (char.lastActionState) {
            try {
              const resumeResult = engine.resumeAction(char.id);
              if (resumeResult.nextDecision.options.length === 0) {
                await interaction.reply({
                  embeds: [new EmbedBuilder().setTitle('⏳ Stale Action').setDescription(resumeResult.nextDecision.prompt || 'Could not recover.').setColor(0x95a5a6).toJSON()],
                  components: [],
                  ephemeral: true,
                });
              } else {
                setPendingDecision(interaction.user.id, resumeResult.nextDecision);
                const decisionMsg = buildDecisionMessage(resumeResult.nextDecision, resumeResult.state.decisions.length, resumeResult.state, char);
                await interaction.reply({
                  embeds: decisionMsg.embeds,
                  components: decisionMsg.components,
                  ephemeral: true,
                });
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              await interaction.reply({
                content: `❌ **Could not resume.**\n${msg}`,
                ephemeral: true,
              });
            }
            return;
          }

          // Show day-job menu — new ephemeral message (same reason: V2 flags)
          const dayNumber = Number(engine.getMeta('day_number') ?? '1');
          const jobActions = getDayJobActions(char.dayJob, dayJobs, { characterId: char.id, dayNumber });
          const embed = new EmbedBuilder()
            .setTitle(`🔨 ${char.dayJob} — Daily Work`)
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
          row.addComponents(
            new ButtonBuilder()
              .setCustomId(CID_DAYJOB_CUSTOM)
              .setLabel('Custom…')
              .setStyle(ButtonStyle.Primary),
          );

          await interaction.reply({
            embeds: [embed.toJSON()],
            components: [row.toJSON()],
            ephemeral: true,
          });
        } catch (err) {
          void notifyAdmin('Nav (action) failed', err);
        }
        return;
      }

      const navHandler = registry.get(navTarget);
      if (!navHandler) return;

      try {
        const char = engine.getCharacter(interaction.user.id);
        const result = await navHandler({ user: { id: interaction.user.id } } as never);

        // No nav bar on /action (own buttons) or /sleep (global message);
        // otherwise exclude the current command's own button
        const noNav = navTarget === 'action' || navTarget === 'sleep';
        const navButtons = noNav || !char ? undefined : getNavButtons(char, navTarget);
        const payload = buildComponentPayload(result, { ephemeral: true, navButtons });

        // Nav buttons live on both ephemeral views and the public /action outcome.
        // From an ephemeral message we edit in place; from a public message we must
        // NOT overwrite it — spawn a fresh ephemeral screen for the clicker instead.
        const fromEphemeral = interaction.message?.flags?.has(MessageFlags.Ephemeral) ?? false;
        if (fromEphemeral) {
          await interaction.update(payload);
        } else {
          await interaction.reply(payload);
        }
      } catch (err) {
        void notifyAdmin(`Nav (${navTarget}) failed`, err);
        if ('reply' in interaction) {
          await (interaction as { reply: Function }).reply({
            content: 'Something went wrong.',
            ephemeral: true,
          }).catch(() => {});
        }
      }
      return;
    }
  });

  // 9. Login
  await client.login(DISCORD_TOKEN);
  console.log(c.blue('[discord] Bot is online'));
}

main().catch((err) => {
  // Best-effort DM (only lands if the client got far enough to log in), then exit.
  setTimeout(() => process.exit(1), 4000).unref();
  void notifyAdmin('FATAL startup error', err).finally(() => {
    closeDb();
    process.exit(1);
  });
});
