/** The /hi greeting screen composition (M7.2, DC-M7.2.1) — lifted byte-for-byte from the
 *  pre-seam src/discord/commands/hi.ts handler: same branch placement (greeting pieces
 *  built, then the lastActionState short-circuit to the resume screen), same engine reads,
 *  same try/catch fallback around the day-job actions block, same join("\n") outputs.
 *  Composition lives in the controller layer, not the router: the router's Home rule
 *  (DC-P8) forbids src/discord/ imports, and the M3–M6 pattern composes views in the
 *  backend's view layer (composeActionMenu → MenuViewState, buildDecisionView,
 *  buildOutcomeView). It imports classEmoji/dayJobEmoji/SEPARATOR from src/discord/format.js
 *  — the exact dayJob.ts precedent (that module imports nothing from discord.js). */

import type { WorldEngine, CharacterData } from "../engine/WorldEngine.js";
import { SEPARATOR, classEmoji, dayJobEmoji } from "../discord/format.js";
import { getDayJobActions, getWorkplaceLocation, type DayJobDef } from "./dayJob.js";
import type { NoticeViewState } from "../view/viewState.js";

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

// ── Screen composition ──

/** The full /hi screen — both view arms (unfinished-action resume, weekday/weekend
 *  greeting) as NoticeViewState. The old handler returned plain strings; the seam wraps
 *  them in the notice view with ephemeral: true (informational on this path — the
 *  dispatcher's ephemeralCommands list drives the actual paint until M9; M7.0 transcript 9
 *  pins flags 32768|64 from the dispatcher, not the view). */
export function composeHiScreen(
  engine: WorldEngine,
  dayJobs: DayJobDef[],
  character: CharacterData,
): { kind: "resume"; view: NoticeViewState } | { kind: "greeting"; view: NoticeViewState } {
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
    const text = [
      "⏳ **Unfinished Action**",
      SEPARATOR,
      "",
      ...(narration ? [narration, ""] : []),
      prompt,
      "",
      "Press the **Action** button to continue.",
    ].join("\n");
    return { kind: "resume", view: { screen: "notice", text, ephemeral: true } };
  }

  const text = [locationLine, "", header, "", SEPARATOR, ...actionLines].join("\n");
  return { kind: "greeting", view: { screen: "notice", text, ephemeral: true } };
}
