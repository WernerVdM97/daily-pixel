/** The /help composition (M8.1, DC-M8.3) — the command-list + Economy copy lifted
 *  byte-for-byte from the pre-seam src/discord/commands/help.ts. Pure text, no engine reads
 *  and NO character guard (help works charless today — the DC-M8.3 pin that `screen.help`
 *  has no no-character arm; gating it would be a behaviour change). */

import { SEPARATOR } from "../render/format.js";

export function composeHelpScreen(): string {
  return [
    "📜 **The Warden's Oak — Command List**",
    SEPARATOR,
    "",
    "**Getting Started**",
    "`/join` — Create your character (6-step wizard)",
    "`/hi`   — Begin your day. The Oak awaits.",
    "",
    "**Your Character**",
    "`/stats`    — Full character sheet",
    "`/backpack` — Inventory emoji grid",
    "",
    "**The World**",
    "`/look`    — Survey your surroundings",
    "`/journal` — Browse your journal (locations, NPCs, actions)",
    "",
    "**Actions**",
    "`/action` — Take an action. Describe what you want to do.",
    "",
    "The warden presents decisions, each one modifying the",
    "difficulty check (DC). Choose wisely — bail if the odds",
    "turn against you.",
    "",
    "**Action types:** hunt, travel, talk, craft, scout, trade,",
    "investigate, pray, perform, heal, train, sneak, and more.",
    SEPARATOR,
    "",
    "**Economy**",
    "You have **2 rolls per day**. Each `/action` consumes 1 roll.",
    "Rolls reset at nightfall (admin `/sleep` or nightly cron).",
    "Optional actions can be skipped (Bail or Skip button).",
    "Required actions (attacked, cornered) cannot be skipped.",
    "",
    "**Rest**",
    "`/sleep` — Make camp by the Oak and rest. The world turns at",
    "nightfall — only the warden can turn the hourglass.",
    SEPARATOR,
    "",
    "**Report**",
    "`/feedback` — Share your thoughts",
    "`/bug`      — Report a bug",
    "`/help`     — This list",
  ].join("\n");
}
