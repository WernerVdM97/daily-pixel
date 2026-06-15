/**
 * /help — command list, action types, roll economy.
 * Pure text. No engine dependency.
 */
export function makeHelpCommand() {
	return async (): Promise<string> => {
		return [
			"📜 **The Warden's Oak — Command List**",
			"═".repeat(30),
			"",
			"**Getting Started**",
			"`/join` — Create your character (6-step wizard)",
			"`/hi`   — Opening scene, day-job actions, adventure hooks",
			"",
			"**Your Character**",
			"`/stats`    — Full character sheet",
			"`/backpack` — Inventory emoji grid",
			"",
			"**The World**",
			"`/look`    — Scry your current location (ASCII + description)",
			"`/journal` — Known locations, NPCs, recent actions",
			"",
			"**Actions**",
			"`/action` — Perform a free-form action. The warden responds with ",
			"decisions. Each decision modifies the DC (difficulty check)",
			"before you roll a d20. Choose wisely — bail if the odds",
			"turn against you.",
			"",
			"**Action types:** hunt, travel, talk, craft, scout, trade,",
			"investigate, pray, perform, heal, train, sneak, and more.",
			"",
			"**Roll Economy**",
			"You get **2 rolls per day**. Rolls refresh on the daily tick",
			"(admin `/sleep` or nightly cron). Some actions may not consume",
			"a roll (required actions, bail, skip).",
			"",
			"**Misc**",
			"`/feedback` — Send feedback to the warden",
			"`/bug`      — Report a bug",
			"`/help`     — This list",
		].join("\n");
	};
}
