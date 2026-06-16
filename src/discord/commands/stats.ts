import type { WorldEngine, CharacterData } from "../../engine/WorldEngine.js";
import { formatStatLabel } from "../../engine/stat-format.js";
import { SEPARATOR } from "../format.js";

export function makeStatsCommand(engine: WorldEngine) {
  return async (interaction: { user: { id: string } }) => {
    const character = engine.getCharacter(interaction.user.id);
    if (!character) {
      return "You don't have a character yet. Type `/join` to create one.";
    }
    return formatStats(character);
  };
}

export function formatStats(char: CharacterData): string {
  const lines: string[] = [];

  // Header
  lines.push(`⚔️  **${char.name}** — ${char.class}`);
  lines.push(SEPARATOR);
  lines.push(`**Upbringing:** ${char.upbringing}  |  **Race:** ${char.race}`);
  lines.push(`**Alignment:** ${char.alignment}`);
  lines.push(`**Day Job:** ${char.dayJob}`);
  lines.push("");

  // Stats
  lines.push("**Stats:**");
  lines.push(`  ${formatStatLabel('physical')}  ${formatStat(char.stats.physical)}`);
  lines.push(`  ${formatStatLabel('wisdom')}       ${formatStat(char.stats.wisdom)}`);
  lines.push(`  ${formatStatLabel('intelligence')}  ${formatStat(char.stats.intelligence)}`);
  lines.push(`  ${formatStatLabel('charisma')}     ${formatStat(char.stats.charisma)}`);
  lines.push("");

  // Vitals
  lines.push(
    `**Health:** ${char.health}/${char.maxHealth}  |  **Stamina:** ${char.stamina}`,
  );
  lines.push(`**Location:** ${char.location}`);
  lines.push(
    `**Wealth:** ${char.wealth} copper  |  **Rolls:** ${char.rollsRemaining} remaining`,
  );

  return lines.join("\n");
}

function formatStat(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value}`;
}
