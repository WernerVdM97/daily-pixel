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
      "`/join`   — Create your character (6-step wizard)",
      "`/hi`     — Begin your day. The Oak awaits.",
      "",
      "**Your Character**",
      "`/stats`    — Full character sheet.",
      "`/backpack` — Inventory emoji grid.",
      "",
      "**The World**",
      "`/look`    — Survey your surroundings (ASCII + description).",
      "`/journal` — Browse your journal: locations, NPCs, recent actions.",
      "",
      "**Actions**",
      "`/action` — Take an action. Describe what you want to do.",
      "             The warden presents decisions; each one modifies",
      "             the difficulty check (DC) before you roll a d20.",
      "             Choose wisely — bail if the odds turn against you.",
      "",
      "**Action types:** hunt, travel, talk, craft, scout, trade,",
      "investigate, pray, perform, heal, train, sneak, and more.",
      "",
      "**Economy**",
      "You have **2 rolls per day**.",
      "Each `/action` consumes 1 roll.",
      "Your rolls reset at nightfall, when the world turns to the",
      "next day (admin `/sleep` or nightly cron).",
      "Optional actions can be skipped (Bail or Skip button).",
      "Required actions (attacked, cornered) cannot be skipped.",
      "",
      "**Rest**",
      "`/sleep`   — Make camp by the Oak and rest. The world turns",
      "             at nightfall — only the warden can turn the hourglass.",
      "",
      "**Report**",
      "`/feedback` — Share your thoughts.",
      "`/bug`      — Report a bug.",
      "`/help`     — This list.",
    ].join("\n");
  };
}
