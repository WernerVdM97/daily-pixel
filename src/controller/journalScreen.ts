/** The /journal composition (M8.1, DC-M8.3) — the chronicle + NPC-list screen lifted
 *  byte-for-byte from the pre-seam src/discord/commands/journal.ts handler body after the
 *  character guard (the controller's `openJournal` owns the guard). Same composition, same
 *  engine reads (getJournal), same join("\n") output — /journal owns TIME, /map owns SPACE. */

import type { WorldEngine, CharacterData } from "../engine/WorldEngine.js";
import { SEPARATOR } from "../discord/format.js";

export function composeJournalScreen(engine: WorldEngine, character: CharacterData): string {
  const journal = engine.getJournal(character.id);
  const lines: string[] = [];

  // /journal owns TIME (a chronicle of what you did, where); /map owns SPACE.
  lines.push(`📖 **${character.name}'s Journal**`);
  lines.push(SEPARATOR);

  // Chronicle — recent actions, each tagged with the place it happened in. Outcomes get a
  // bold, colour-coded tag (not a bare ✓/✗) so a run of failures reads at a glance; any intel
  // the action turned up (a place revealed, an NPC met) hangs off it as a rail, matching the
  // /backpack box-drawing convention.
  lines.push("**📜 Chronicle**");
  if (journal.recentActions.length === 0) {
    lines.push("*No actions recorded yet — your story is unwritten.*");
  } else {
    for (const action of journal.recentActions) {
      const outcomeTag =
        action.outcome === "success" ? " — ✅ **Success**"
        : action.outcome === "failure" ? " — ❌ **Failed**"
        : "";
      const where = action.location ? `${action.locationEmoji ?? "📍"} ${action.location}` : "🧭 (on the road)";
      const what = action.narrative
        ? (action.narrative.length > 140 ? action.narrative.slice(0, 137) + "…" : action.narrative)
        : action.type;
      lines.push(`${where} · ${what}${outcomeTag}`);
      for (const discovery of action.discoveries ?? []) {
        lines.push(`    └─ ${discovery}`);
      }
    }
  }

  // NPCs encountered — who you've crossed paths with.
  lines.push("");
  lines.push(SEPARATOR);
  lines.push("**🧑‍🤝‍🧑 NPCs Encountered**");
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
}
