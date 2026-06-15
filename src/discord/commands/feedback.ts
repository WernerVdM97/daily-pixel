import type { WorldEngine } from "../../engine/WorldEngine.js";

export function makeFeedbackCommand(engine: WorldEngine) {
	return async (interaction: {
		user: { id: string };
		text: string;
	}): Promise<string> => {
		const character = engine.getCharacter(interaction.user.id);
		if (!character) {
			return "You don't have a character yet. Type `/join` to create one.";
		}
		engine.submitFeedback(character.id, interaction.text);
		return "🙏 Thanks. The warden listens.";
	};
}
