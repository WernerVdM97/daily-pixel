/** The /stats composition (M8.1, DC-M8.3) — `formatStats` + its helpers lifted byte-for-byte
 *  from the pre-seam src/discord/commands/stats.ts, with `composeStatsScreen` the thin
 *  engine-read wrapper the controller's `openStats` calls. Same imports as the old file:
 *  stat-format.js / action/dc.js (engine side) and format.js (pure display helpers). */

import type { WorldEngine, CharacterData, ItemData } from "../engine/WorldEngine.js";
import { formatStatLabel } from "../engine/stat-format.js";
import { itemStatModifier } from "../engine/action/dc.js";
import { SEPARATOR, classEmoji } from "../render/format.js";

export function composeStatsScreen(engine: WorldEngine, character: CharacterData): string {
  return formatStats(character, engine.getItems(character.id));
}

export function formatStats(char: CharacterData, items: ItemData[] = []): string {
  const lines: string[] = [];

  // Header
  lines.push(`${classEmoji(char.class)}  **${char.name}** — ${char.class}`);
  lines.push(SEPARATOR);
  lines.push(`**Upbringing:** ${char.upbringing}  |  **Race:** ${char.race}`);
  lines.push(`**Alignment:** ${char.alignment}`);
  lines.push(`**Day Job:** ${char.dayJob}`);
  lines.push("");

  // Stats — show the effective score (base + gear); break out the gear bonus
  // when items contribute, since that's the number that actually drives rolls.
  // Labels (formatStatLabel) are all equal width, so a single separator aligns them —
  // and Discord renders this as proportional text anyway, so space-padding is moot.
  lines.push("**Stats:**");
  for (const stat of ["physical", "wisdom", "intelligence", "charisma"] as const) {
    lines.push(`  ${formatStatLabel(stat)}  ${formatStatWithGear(char.stats[stat], itemStatModifier(items, stat))}`);
  }
  lines.push("");

  // Vitals
  lines.push(
    `**Health:** ${char.health}/${char.maxHealth}  |  **Stamina:** ${char.stamina}/${char.maxStamina}`,
  );
  lines.push(`**Location:** ${char.location}`);
  lines.push(
    `**Wealth:** ${char.wealth} copper  |  **Rolls:** ${char.rollsRemaining}`,
  );

  return lines.join("\n");
}

function formatStat(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value}`;
}

/**
 * Render a stat as its effective score (base + gear). When gear contributes a
 * nonzero modifier, append a breakdown so the player can see the bonus their
 * items grant, e.g. `+3  (+2 base, +1 🎒)`.
 */
function formatStatWithGear(base: number, gear: number): string {
  const effective = formatStat(base + gear);
  if (gear === 0) return effective;
  return `${effective}  (${formatStat(base)} base, ${formatStat(gear)} 🎒)`;
}
