import type { WorldEngine, CharacterData } from "../../engine/WorldEngine.js";
import { formatStatLabel } from "../../engine/stat-format.js";
import { SEPARATOR } from "../format.js";

// ── Day job types (from day-jobs.yml shape) ──

export interface DayJobDef {
  name: string;
  depends_on: string[];
  base_income: number;
  description: string;
  /** The job's action pool. `getDayJobActions` surfaces 3 at random (job pool + COMMON_ACTIONS). */
  actions: DayJobAction[];
}

export interface DayJobAction {
  label: string;
  income: number;
  hook: string;
}

/**
 * Generic, cross-job "hybrid" actions mixed into every day-job's pool so the 3
 * surfaced each day vary and don't read as a fixed, over-specific rota.
 */
export const COMMON_ACTIONS: DayJobAction[] = [
  { label: 'Help at the market', income: 3, hook: 'A stall-keeper could use an extra pair of hands through the morning rush.' },
  { label: 'Lend a neighbour a hand', income: 2, hook: 'Someone nearby is wrestling with a task too big for one person.' },
  { label: 'Run an errand', income: 3, hook: 'A message needs carrying across town before midday.' },
  { label: 'Share a meal at the inn', income: 0, hook: 'The common room is warm and loud — a good place to take the measure of the town.' },
  { label: 'See to chores', income: 2, hook: 'There is always work to be done: wood to split, water to haul, a fence to mend.' },
  { label: 'Listen for news', income: 1, hook: 'Travellers pass through with rumours from the road. Some of it might even be true.' },
  { label: 'Haul and load', income: 3, hook: 'Crates and sacks need moving before the carts leave. Honest sweat for honest coin.' },
  { label: 'Mind a child', income: 2, hook: 'A harried parent presses a coin into your hand and a restless toddler into your care.' },
];

/** Deterministic PRNG (mulberry32) so a given seed always yields the same picks. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Pure formatters (tested in isolation) ──

export function formatCharacterHeader(char: CharacterData): string {
const lines: string[] = [];
lines.push(`⚔️  **${char.name}** — ${char.class}`);
lines.push(SEPARATOR);

  // Stats line
  const stat = (abbr: string, val: number): string => {
    const sign = val >= 0 ? "+" : "";
    return `${abbr} ${sign}${val}`;
  };
  lines.push(
    `${stat(formatStatLabel('physical'), char.stats.physical)}  ${stat(formatStatLabel('wisdom'), char.stats.wisdom)}  ` +
      `${stat(formatStatLabel('intelligence'), char.stats.intelligence)}  ${stat(formatStatLabel('charisma'), char.stats.charisma)}`,
  );

  // Vitals
  const hpPct = char.health / char.maxHealth;
  const hpWarn = hpPct < 0.34 ? " ⚠️ **low health!**" : "";
  lines.push(`❤️ HP: ${char.health}/${char.maxHealth}${hpWarn}`);
  lines.push(
    `⚡ Stamina: ${char.stamina}/${char.maxStamina}  |  🎲 Rolls: ${char.rollsRemaining} remaining`,
  );

  return lines.join("\n");
}

/**
 * Surface 3 daily-work actions, sampled from the job's pool + COMMON_ACTIONS.
 * The pick is seeded by (characterId, dayNumber) so /hi, the /action buttons, and
 * the button-click handler all agree within a day, and refresh each game day.
 * With no opts the seed is 0 (deterministic) — handy for tests.
 */
export function getDayJobActions(
  dayJobName: string,
  dayJobs: DayJobDef[],
  opts: { characterId?: number; dayNumber?: number } = {},
): DayJobAction[] {
  const job = dayJobs.find((j) => j.name === dayJobName);
  if (!job) {
    throw new Error(`Unknown day job "${dayJobName}"`);
  }

  const pool = [...job.actions, ...COMMON_ACTIONS];
  const seed = (opts.characterId ?? 0) * 1000 + (opts.dayNumber ?? 0);
  const rng = mulberry32(seed);

  // Sample up to 3 distinct actions (Fisher-Yates partial draw).
  const remaining = [...pool];
  const picked: DayJobAction[] = [];
  while (picked.length < 3 && remaining.length > 0) {
    const idx = Math.floor(rng() * remaining.length);
    picked.push(remaining.splice(idx, 1)[0]);
  }
  return picked;
}

export function isWeekend(): boolean {
  const day = new Date().getDay(); // 0 = Sunday, 6 = Saturday
  return day === 0 || day === 6;
}

// ── Command factory ──

export function makeHiCommand(
  engine: WorldEngine,
  dayJobs: DayJobDef[],
) {
  return async (interaction: { user: { id: string } }): Promise<string> => {
    const character = engine.getCharacter(interaction.user.id);
    if (!character) {
      return "You don't have a character yet. Type `/join` to create one.";
    }

    // Character + location header
    const header = formatCharacterHeader(character);
    const location = engine.getLocation(character.location);
    const locEmoji = location?.isSafe ? '🛡️' : '⚠️';
    const locationLine = location
      ? `🏠 ${locEmoji} **${location.name}** — Use \`look\` for the full scene.`
      : `🏠 **${character.location}** — Use \`look\` for the full scene.`;

    // Determine day-job actions or weekend hooks
    const weekend = isWeekend();
    let actionLines: string[] = [];
    if (weekend) {
      actionLines = [
        "🌅 **Weekend — The world is yours.**",
        "",
        "Adventure hooks:",
        "  • **Travel** — Head east, west, or into the wilds.",
        "  • **Scout** — Survey the area for threats or resources.",
        "  • **Hunt** — Track game in the forest.",
        "  • **Talk** — Seek out NPCs and learn their stories.",
        "  • **Explore** — Go where no one has yet.",
      ];
    } else {
      try {
        const dayNumber = Number(engine.getMeta('day_number') ?? '1');
        const actions = getDayJobActions(character.dayJob, dayJobs, { characterId: character.id, dayNumber });
        actionLines = [
          `🔨 **${character.dayJob} — Daily Work**`,
          "",
          ...actions.map(
            (a, i) => `  ${["🎯", "🔧", "📋"][i]} **${a.label}** — ${a.hook}`,
          ),
          "",
          "📦 Press the **Action** button or type `action <what you do>` to start.",
        ];
      } catch {
        actionLines = [
          `🔨 **${character.dayJob}**`,
          "",
          "📦 Press the **Action** button or type `action <what you do>` to start.",
        ];
      }
    }

    // Resumption — show the pending decision prompt instead of the greeting
    if (character.lastActionState) {
      const resumeResult = engine.resumeAction(character.id);
      const prompt = resumeResult.nextDecision.prompt;
      return [
        '⏳ **Unfinished Action**',
        SEPARATOR,
        '',
        prompt,
        '',
        'Press the **Action** button or type `action <what you do>` to continue.',
      ].join('\n');
    }

    return [locationLine, '', header, '', SEPARATOR, ...actionLines].join('\n');
  };
}
