import type { WorldEngine, NearbyEntity } from "../../engine/WorldEngine.js";
import { SEPARATOR } from "../format.js";

export type SceneLookupFn = (tags: string[]) => {
  sceneName: string;
  ascii: string;
};

/** Emoji for an NPC based on their class/type. */
function npcEmoji(classOrType: string): string {
  const t = (classOrType ?? '').toLowerCase();
  if (t.includes('merchant') || t.includes('trader')) return '📦';
  if (t.includes('blacksmith') || t.includes('smith')) return '🔨';
  if (t.includes('hunter') || t.includes('ranger')) return '🏹';
  if (t.includes('beast') || t.includes('wolf') || t.includes('stag')) return '🐾';
  if (t.includes('herbalist') || t.includes('alchemist')) return '🌿';
  if (t.includes('acolyte') || t.includes('priest')) return '🙏';
  if (t.includes('wanderer') || t.includes('vagrant')) return '🗝️';
  if (t.includes('rogue') || t.includes('thief')) return '🗡️';
  if (t.includes('scout')) return '🧭';
  if (t.includes('guard') || t.includes('soldier')) return '🛡️';
  return '🗣️';
}

/** Format the entities section of the /look output. */
function formatEntities(entities: NearbyEntity[]): string {
  if (entities.length === 0) return '';

  const lines: string[] = [];
  lines.push('');
  lines.push(SEPARATOR);

  const pcs = entities.filter(e => e.isPlayer);
  const npcs = entities.filter(e => !e.isPlayer);

  if (pcs.length > 0) {
    lines.push('**🌟 Nearby Adventurers**');
    for (const pc of pcs) {
      lines.push(`  **${pc.name}** — ${pc.classOrType}`);
    }
  }

  if (npcs.length > 0) {
    if (pcs.length > 0) lines.push('');
    lines.push('**Other Figures**');
    for (const npc of npcs) {
      const emoji = npcEmoji(npc.classOrType);
      const desc = npc.description ? ` — _${npc.description.slice(0, 100)}${npc.description.length > 100 ? '…' : ''}_` : '';
      lines.push(`  ${emoji} **${npc.name}**${desc}`);
    }
  }

  return lines.join('\n');
}

export function makeLookCommand(
  engine: WorldEngine,
  resolveScene: SceneLookupFn,
) {
  return async (interaction: { user: { id: string } }): Promise<string> => {
    const character = engine.getCharacter(interaction.user.id);
    if (!character) {
      return "You don't have a character yet. Type `/join` to create one.";
    }

    const location = engine.getLocation(character.location);
    if (!location) {
      return `You are at **${character.location}**, but something feels off. The location is lost to the warden's sight.`;
    }

    const { ascii } = resolveScene(location.tags);

    // Wrap ASCII in a code block so Discord renders it monospace
    const lines: string[] = [];
    lines.push('```');
    lines.push(ascii);
    lines.push('```');
    lines.push("");
    lines.push(`🏠 **${location.name}**`);
    lines.push(SEPARATOR);
    lines.push(location.description);

    if (location.isSafe) {
      lines.push("");
      lines.push("🛡️ This is a **safe** location. Rest and recover.");
    } else {
      lines.push("");
      lines.push("⚠️ This location is **unsafe**. Danger may be near.");
    }

    // Nearby entities
    const entities = engine.getNearbyEntities(character.id);
    const entityBlock = formatEntities(entities);
    if (entityBlock) lines.push(entityBlock);

    return lines.join("\n");
  };
}
