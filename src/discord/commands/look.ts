import type { WorldEngine, NearbyEntity } from "../../engine/WorldEngine.js";
import { SEPARATOR } from "../format.js";

export type SceneLookupFn = (tags: string[]) => {
  sceneName: string;
  ascii: string;
};

/** Effort glyph by terrain difficulty band (matches /map): 🚶 road · 🏃 trail · 🧗 harsh. */
const EFFORT = ["", "🚶", "🏃", "🧗"] as const;

/** Compass arrow per direction, and a clockwise order (N, NE, E … NW) to sort by. */
const DIR_ARROW: Record<string, string> = {
  N: "⬆️", NE: "↗️", E: "➡️", SE: "↘️", S: "⬇️", SW: "↙️", W: "⬅️", NW: "↖️",
};
const DIR_ORDER = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const dirRank = (d: string): number => {
  const i = DIR_ORDER.indexOf(d);
  return i === -1 ? DIR_ORDER.length : i;
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
  if (t.includes('warden')) return '🔥';
  return '🗣️';
}

/** Format the entities section of the /look output. */
function formatEntities(entities: NearbyEntity[]): string {
  if (entities.length === 0) {
    return ['', '_Silence. You are alone here._'].join('\n');
  }

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
    lines.push(`${location.emoji ?? '📍'} **${location.name}**`);
    lines.push(SEPARATOR);
    lines.push(location.description);

    if (location.isSafe) {
      lines.push("");
      lines.push("🛡️ This is a **safe** location. Rest and recover.");
    } else {
      lines.push("");
      lines.push("⚠️ This location is **unsafe**. Danger may be near.");
    }

    // Paths — the roads you can see from where you stand (charted + frontier),
    // ordered clockwise from north so the compass reads naturally.
    const exits = engine.getExits(character.location);
    const paths = [
      ...exits.neighbours.map((n) => ({ direction: n.direction, difficulty: n.difficulty, dest: n.name })),
      ...exits.frontiers.map((f) => ({
        direction: f.direction,
        difficulty: f.difficulty,
        dest: f.teaser ? `*uncharted* — _${f.teaser}_` : "*uncharted*",
      })),
    ].sort((a, b) => dirRank(a.direction) - dirRank(b.direction));

    if (paths.length > 0) {
      lines.push("");
      lines.push(SEPARATOR);
      lines.push("**🧭 Paths**");
      for (const p of paths) {
        const arrow = DIR_ARROW[p.direction] ?? "🧭";
        lines.push(`  ${arrow} ${p.direction} → ${p.dest} ${EFFORT[p.difficulty] ?? ""}`.trimEnd());
      }
    }

    // Nearby entities
    const entities = engine.getNearbyEntities(character.id);
    const entityBlock = formatEntities(entities);
    if (entityBlock) lines.push(entityBlock);

    return lines.join("\n");
  };
}
