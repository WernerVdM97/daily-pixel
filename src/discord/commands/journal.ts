import type { WorldEngine } from "../../engine/WorldEngine.js";
import { SEPARATOR } from "../format.js";

export function makeJournalCommand(engine: WorldEngine) {
  return async (interaction: { user: { id: string } }): Promise<string> => {
    const character = engine.getCharacter(interaction.user.id);
    if (!character) {
      return "You don't have a character yet. Type `/join` to create one.";
    }

    const journal = engine.getJournal(character.id);
    const lines: string[] = [];

    // /journal owns TIME (a chronicle of what you did, where); /map owns SPACE.
    lines.push(`📖 **${character.name}'s Journal**`);
    lines.push(SEPARATOR);

    // Chronicle — recent actions, each tagged with the place it happened in.
    lines.push("");
    if (journal.recentActions.length === 0) {
      lines.push("*No actions recorded yet — your story is unwritten.*");
    } else {
      for (const action of journal.recentActions) {
        const glyph = action.outcome === "success" ? " ✓" : action.outcome === "failure" ? " ✗" : "";
        const where = action.location ? `${action.locationEmoji ?? "📍"} ${action.location}` : "🧭 (on the road)";
        const what = action.narrative
          ? (action.narrative.length > 140 ? action.narrative.slice(0, 137) + "…" : action.narrative)
          : action.type;
        lines.push(`${where} · ${what}${glyph}`);
      }
    }

    // NPCs encountered — who you've crossed paths with.
    lines.push("");
    lines.push("**NPCs Encountered:**");
    if (journal.npcsEncountered.length === 0) {
      lines.push("  *You have met no NPCs yet.*");
    } else {
      for (const npc of journal.npcsEncountered) {
        const detail = npc.class ? `the ${npc.class}` : "";
        const where = npc.location ? ` (at ${npc.location})` : "";
        lines.push(`  • **${npc.name}** ${detail}${where}`.trim());
      }
    }

    lines.push("");
    lines.push("*Use `/map` to see where you've been.*");

    return lines.join("\n");
  };
}
