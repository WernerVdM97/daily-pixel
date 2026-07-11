// Consolidated operator live-check script for the 0.3.1 polish release.
//
// Batches ALL pending visual verifications in one Discord session. The operator
// runs `npx tsx scripts/live-check-0.3.1.ts`, then verifies each delivered frame
// on desktop (colour) AND mobile (monochrome) against the checklist printed to
// stdout (mirrored in the final DM as a self-contained legend).
//
// Categories:
//   A — Combat-frame redesign (standard/heavy/crit continue + terminal cards)
//   B — Opening frames (all 7 classified types)
//   C — UX polish (manual in-app checks, listed as a checklist)

import { Client, Events, GatewayIntentBits } from "discord.js";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Bootstrap ──────────────────────────────────────────────────────

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnv(): void {
  const envPath = resolve(REPO_ROOT, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] === undefined) process.env[key] = trimmed.slice(eq + 1).trim();
  }
}

loadEnv();

// ── Renderers (real src/, not mocks) ───────────────────────────────

import {
  renderCombatContinueCard,
  renderCombatTerminalCard,
  bandColor,
  type ContinueCardInput,
  type CombatTerminalCard,
} from "../src/render/CombatCardRenderer.js";
import { BORDERS, PALETTES } from "../src/render/AnsiRenderer.js";
import { renderOpeningFrame, type OpeningActionType } from "../src/render/OpeningFrameRenderer.js";

// ── Frame generators ───────────────────────────────────────────────

function continueStandard(): string {
  const input: ContinueCardInput = {
    enemyName: "GLOOMFANG",
    woundWord: "BRUISED",
    pips: { filled: 3, total: 5 },
    playerHp: 18,
    playerMaxHp: 24,
    playerHpDelta: -3,
    lastRound: { d20: 14, bonus: 3, dc: 15, margin: 2, band: "trade" },
  };
  return renderCombatContinueCard(input, PALETTES.house, BORDERS.standard);
}

function continueHeavy(): string {
  const input: ContinueCardInput = {
    enemyName: "GLOOMFANG",
    woundWord: "BLOODIED",
    pips: { filled: 1, total: 5 },
    playerHp: 5,
    playerMaxHp: 24,
    playerHpDelta: -8,
    lastRound: { d20: 8, bonus: 3, dc: 16, margin: -3, band: "heavy" },
  };
  return renderCombatContinueCard(input, PALETTES.house, BORDERS.heavy);
}

function terminalStandard(): string {
  const card: CombatTerminalCard = {
    label: "COMBAT WON",
    playerD20: 16,
    bonus: 4,
    total: 20,
    dc: 15,
    marker: "+",
    verdict: "WIN",
    margin: 5,
    flavour: "The GLOOMFANG collapses.",
  };
  return renderCombatTerminalCard(card, PALETTES.house, BORDERS.standard);
}

function terminalCrit(): string {
  const card: CombatTerminalCard = {
    label: "CRITICAL HIT",
    playerD20: 20,
    bonus: 4,
    total: 24,
    dc: 15,
    marker: "+",
    verdict: "CLEAN",
    margin: 9,
    flavour: "The GLOOMFANG is felled!",
  };
  return renderCombatTerminalCard(card, PALETTES.house, BORDERS.crit);
}

function openingFrames(): Record<string, string> {
  const types: OpeningActionType[] = ["combat", "travel", "social", "skill", "search", "rest", "other"];
  const result: Record<string, string> = {};
  for (const type of types) {
    const slots = type === "combat"
      ? { pcName: "Kael", pcHp: 22, pcMaxHp: 30, enemyName: "GLOOMFANG" }
      : type === "travel"
        ? { pcName: "Kael", locationName: "The Warden's Oak" }
        : { pcName: "Kael" };
    result[type] = renderOpeningFrame(type, slots, PALETTES.house, BORDERS.standard);
  }
  return result;
}

// ── Main ───────────────────────────────────────────────────────────

async function main() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error("DISCORD_BOT_TOKEN not set in .env or environment.");
    process.exit(1);
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages] });

  const messages: { label: string; title: string; content: string }[] = [];

  // A — Combat-frame redesign
  messages.push({ label: "A.1", title: "Continue — standard (TRADE band, border=standard)", content: continueStandard() });
  messages.push({ label: "A.2", title: "Continue — heavy (HEAVY band, bloodied, border=heavy)", content: continueHeavy() });
  messages.push({ label: "A.3", title: "Terminal — standard (WIN, border=standard)", content: terminalStandard() });
  messages.push({ label: "A.4", title: "Terminal — crit (nat-20 CRITICAL HIT, border=crit)", content: terminalCrit() });

  // B — Opening frames
  const openings = openingFrames();
  for (const [type, frame] of Object.entries(openings)) {
    messages.push({ label: `B.${type}`, title: `Opening — ${type}`, content: frame });
  }

  // Legend / checklist for UX items
  const manualChecks = [
    "C.1 Join screen: inline skills readable? chosen-option emoji shown?",
    "C.2 Morning/evening prose: carries custom day-keyed flavour? (wait for next cron tick or `/sleep`)",
    "C.3 Rest button: 'Bedding down…' beat + sectioned body?",
    "C.4 Journal /chronicle: sections distinct? success/failure tags bold? intel rails present?",
    "C.5 /action hints: '1 action remaining' / low stamina / unsafe location shown?",
    "C.6 Decision emojis: only stakes arrows, no redundant green/red emoji?",
    "C.7 Custom-action thinking screen: ⏳ Thinking beat shown before engine.startAction?",
  ];

  client.once(Events.ClientReady, async (ready) => {
    console.log(`Connected as ${ready.user.tag}. Fetching admin DM channel…`);

    const adminId = process.env.ADMIN_USER_ID;
    if (!adminId) {
      console.error("ADMIN_USER_ID not set.");
      client.destroy();
      process.exit(1);
    }

    const admin = await client.users.fetch(adminId);
    if (!admin) {
      console.error("Could not fetch admin user.");
      client.destroy();
      process.exit(1);
    }

    console.log(`Sending ${messages.length} frames to ${admin.tag}…`);

    // Send header
    await admin.send("# 🧪 0.3.1 live-check\n\nVerify each frame below on **desktop** (colour) **AND mobile** (monochrome).\nCheck the legend at the bottom for manual in-app items.");

    for (const { label, title, content } of messages) {
      const header = `### ${label} — ${title}\n`;
      await admin.send(header + content);
      // Small delay to avoid rate limits
      await new Promise((r) => setTimeout(r, 500));
    }

    // Send manual checklist
    const checklist = "## C — Manual in-app checks\n\n" + manualChecks.map((c) => `- [ ] ${c}`).join("\n");
    await admin.send(checklist);

    console.log("All frames sent. Operator checklist:");
    console.log("  Desktop: verify colour roles on each frame.");
    console.log("  Mobile: strip colour — verify sign (+/−/x), band word, boxed [DC N], marker carry meaning.");
    console.log("  Border: verify single/double/crest glyphs are single-width and the right edge aligns on mobile.");
    console.log("  Manual: run through the 7 in-app checks listed in the final DM.");

    client.destroy();
    process.exit(0);
  });

  await client.login(token);
}

main();
