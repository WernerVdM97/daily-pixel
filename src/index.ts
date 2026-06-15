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

import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client, EmbedBuilder, Events, GatewayIntentBits, REST, Routes, ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';

import { initDb, closeDb } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { UserRepository } from './db/repositories/user.js';
import { CharacterRepository } from './db/repositories/character.js';
import { ItemRepository } from './db/repositories/item.js';
import { ActionRepository } from './db/repositories/action.js';
import { NpcRepository } from './db/repositories/npc.js';
import { MetaRepository } from './db/repositories/meta.js';

import { WorldEngineImpl } from './engine/WorldEngineImpl.js';
import type { ClassDef, ModifierDef } from './engine/StatComputer.js';
import type { LlmDecision, LlmContext } from './llm/LlmGateway.js';
import { DeepseekLlmGateway } from './llm/DeepseekLlmGateway.js';
import { FallbackLlmGateway, DIVINE_MESSAGE } from './llm/FallbackLlmGateway.js';
import { c } from './util/colors.js';

import { loadYamlFile } from './assets/yaml-loader.js';
import { SceneLoader } from './scenes/SceneLoader.js';
import { TagResolver } from './scenes/TagResolver.js';

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
import { makeJoinCommand, handleInteraction as handleJoinInteraction } from './discord/commands/join.js';
import { makeActionCommand, handleActionChoice, setPendingDecision, buildDecisionMessage } from './discord/commands/action.js';

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
  const oakScene = scenes.get('oak')?.body ?? '';
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
  registry.register('hi', asHandler(makeHiCommand(engine, dayJobs, oakScene)));
  const joinWizards = new WizardSession();
  registry.register('join', asHandler(makeJoinCommand(engine, joinWizards)));

  registry.register('action', asHandler(makeActionCommand(engine, getCurrentScene, dayJobs)));

  // 8. Discord client
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  // Register slash commands with Discord API on ready
  client.once(Events.ClientReady, async (readyClient) => {
    console.log(c.blue(`[discord] Logged in as ${readyClient.user.tag}`));

    const commands = [
      { name: 'ping', description: 'Check if the bot is alive' },
      { name: 'help', description: 'Command list and roll economy' },
      { name: 'join', description: 'Create your character (6-step wizard)' },
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
      { name: 'sleep', description: 'Rest by the Oak (admin: advance the world)' },
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
    } catch (err) {
      console.error(c.red(`[discord] Failed to register slash commands:`) , err);
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

        const ephemeralCommands = ['stats', 'backpack', 'journal', 'bug', 'feedback', 'help', 'hi'];
        await interaction.reply({
          content: result,
          ephemeral: ephemeralCommands.includes(commandName),
        });
        if (VERBOSE) {
          console.log(c.grey(`[verbose] /${commandName} → ${result.slice(0, 200)}`));
        }
      } catch (err) {
        console.error(c.red(`[discord] Error handling /${commandName}:`), err);
        const msg = err instanceof Error ? err.message : String(err);
        await interaction.reply({
          content: `⚠️ **Something went wrong.**\n\`\`\`${msg}\`\`\``,
          ephemeral: true,
        });
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
        await handleJoinInteraction(interaction, engine, joinWizards);
        if (VERBOSE) console.log(c.grey('[verbose] join: done'));
      } catch (err) {
        console.error(c.red('[join] Error handling interaction:'), err);
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
      await interaction.deferReply({ ephemeral: true });
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
          await interaction.editReply(buildDecisionMessage(resumeResult.nextDecision, decisionIdx, resumeResult.state, getCurrentScene(interaction.user.id)));
          return;
        }
        const result = await engine.startAction(char.id, description);
        if (result.firstDecision.options.length === 0) {
          await interaction.editReply({
            embeds: [new EmbedBuilder().setTitle('⚔️ Action').setDescription(result.firstDecision.prompt).setColor(0x95a5a6).toJSON()],
            components: [],
          });
        } else {
          setPendingDecision(interaction.user.id, result.firstDecision);
          await interaction.editReply(buildDecisionMessage(result.firstDecision, 0, result.state, getCurrentScene(interaction.user.id)));
        }
      } catch (err) {
        console.error(c.red('[action:custom] Error:'), err);
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
        const jobActions = getDayJobActions(char.dayJob, dayJobs);
        const hook = jobActions[idx]?.hook;
        if (!hook) {
          await interaction.reply({ content: 'Invalid job action.', ephemeral: true });
          return;
        }
        await interaction.deferReply({ ephemeral: true });
        const result = await engine.startAction(char.id, hook);
        if (result.firstDecision.options.length === 0) {
          await interaction.editReply({
            embeds: [new EmbedBuilder().setTitle('⚔️ Action').setDescription(result.firstDecision.prompt).setColor(0x95a5a6).toJSON()],
            components: [],
          });
        } else {
          setPendingDecision(interaction.user.id, result.firstDecision);
          await interaction.editReply(buildDecisionMessage(result.firstDecision, 0, result.state, getCurrentScene(interaction.user.id)));
        }
      } catch (err) {
        console.error(c.red('[action:dayjob] Error:'), err);
        const msg = err instanceof Error ? err.message : String(err);
        await interaction.editReply({ content: `❌ **Could not act.**\n${msg}` }).catch(() => {});
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
        console.error(c.red('[action] Error handling choice:'), err);
        if ('reply' in interaction) {
          await (interaction as { reply: Function }).reply({
            content: 'Something went wrong with your action. Try `/action` again.',
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
  console.error('FATAL startup error:', err);
  closeDb();
  process.exit(1);
});
