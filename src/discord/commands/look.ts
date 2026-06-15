import type { WorldEngine } from "../../engine/WorldEngine.js";

export type SceneLookupFn = (tags: string[]) => {
  sceneName: string;
  ascii: string;
};

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
    lines.push("─".repeat(30));
    lines.push(location.description);

    if (location.isSafe) {
      lines.push("");
      lines.push("🛡️ This is a **safe** location. Rest and recover.");
    }

    return lines.join("\n");
  };
}
