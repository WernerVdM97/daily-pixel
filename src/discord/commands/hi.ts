import type { WorldEngine, CharacterData } from "../../engine/WorldEngine.js";
import { SEPARATOR, classEmoji, dayJobEmoji } from "../format.js";
import { getDayJobActions, getWorkplaceLocation, type DayJobDef } from "../../controller/dayJob.js";

// ── Pure formatters (tested in isolation) ──

export function formatCharacterHeader(char: CharacterData): string {
  const lines: string[] = [];
  lines.push(`${classEmoji(char.class)}  **${char.name}** — ${char.class}`);
  lines.push(SEPARATOR);

  // Vitals (not ability scores): HP, Stamina, Rolls, Wealth — emoji-only, no labels.
  lines.push(
    `❤️ ${char.health}/${char.maxHealth}  ┃  ⚡ ${char.stamina}/${char.maxStamina}  ┃  ` +
      `🎲 ${char.rollsRemaining}  ┃  💰 ${char.wealth}`,
  );
  if (char.health / char.maxHealth < 0.34) {
    lines.push("⚠️ **low health!**");
  }

  return lines.join("\n");
}

export function isWeekend(): boolean {
  const day = new Date().getDay(); // 0 = Sunday, 6 = Saturday
  return day === 0 || day === 6;
}

// ── Command factory ──

export function makeHiCommand(engine: WorldEngine, dayJobs: DayJobDef[]) {
  return async (interaction: { user: { id: string } }): Promise<string> => {
    const character = engine.getCharacter(interaction.user.id);
    if (!character) {
      return "You don't have a character yet. Type `/join` to create one.";
    }

    const header = formatCharacterHeader(character);
    const location = engine.getLocation(character.location);
    // Resolve the place's own map glyph (📍 fallback) + safety, mirroring /look and the map
    // tree — not a hardcoded 🏠 (which lied at every location that wasn't the Oak).
    const placeGlyph = location
      ? `${location.emoji ?? "📍"} ${location.isSafe ? "🛡️" : "⚠️"}`
      : "📍";
    const locationLine = location
      ? `${placeGlyph} **${location.name}** — Use \`look\` for the full scene.`
      : `📍 **${character.location}** — Use \`look\` for the full scene.`;

    // Weekend hooks, otherwise day-job actions
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
        const dayNumber = Number(engine.getMeta("day_number") ?? "1");
        const actions = getDayJobActions(character.dayJob, dayJobs, {
          characterId: character.id,
          dayNumber,
        });
        const workplace = getWorkplaceLocation(character.dayJob, dayJobs, {
          characterId: character.id,
          dayNumber,
        });
        const workplaceSuffix = workplace ? ` — ${workplace}` : "";
        actionLines = [
          `${dayJobEmoji(character.dayJob)} **${character.dayJob}${workplaceSuffix} — Daily Work**`,
          "",
          ...actions.map(
            (a, i) => `  ${["🎯", "🔧", "📋"][i]} **${a.label}** — ${a.hook}`,
          ),
          "",
          "📦 Press the **Action** button or type `action <what you do>` to start.",
        ];
      } catch {
        actionLines = [
          `${dayJobEmoji(character.dayJob)} **${character.dayJob}**`,
          "",
          "📦 Press the **Action** button or type `action <what you do>` to start.",
        ];
      }
    }

    // Pending action: show its decision prompt instead of the greeting
    if (character.lastActionState) {
      const resumeResult = engine.resumeAction(character.id);
      const { prompt, narration } = resumeResult.nextDecision;
      // `prompt` is now the bare CTA — narration (the scene) sits above it,
      // else this panel would show a contentless "what do you do?".
      return [
        "⏳ **Unfinished Action**",
        SEPARATOR,
        "",
        ...(narration ? [narration, ""] : []),
        prompt,
        "",
        "Press the **Action** button to continue.",
      ].join("\n");
    }

    return [locationLine, "", header, "", SEPARATOR, ...actionLines].join("\n");
  };
}
