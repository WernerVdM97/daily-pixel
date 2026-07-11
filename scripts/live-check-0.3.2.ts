// Consolidated operator live-check for the 0.3.2 combat-correctness release.
//
// Batches ALL pending visual verifications in one Discord session. The operator
// runs `npx tsx scripts/live-check-0.3.2.ts`, then verifies each delivered frame
// on desktop (colour) AND mobile (monochrome) against the checklist printed to
// stdout (mirrored in the final DM as a self-contained legend).
//
// Categories:
//   A — Continue card: contested roll, danger tier, band-led HP deltas (C1, C2)
//   B — Terminal card: verdict coherence, asymmetric trade, kill-blow frame (C2, P2)
//   C — Opening frame: re-entry banded condition, foe naming (C4)
//   D — Presentation: right-edge padding, word clipping, label fit (P1)
//   E — Danger-tier flicker: same foe, different DCs across rounds (regression watch)
//   F — Enemy-HP stability: last-stand re-entry with persisted damage (C3, C4)

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
  type ContinueCardInput,
  type CombatTerminalCard,
} from "../src/render/CombatCardRenderer.js";
import { BORDERS, PALETTES } from "../src/render/AnsiRenderer.js";
import { renderOpeningFrame } from "../src/render/OpeningFrameRenderer.js";
import { dangerTier } from "../src/engine/action/combat-dc.js";

// ── Frame generators ───────────────────────────────────────────────

// A — Continue card variants

/** C1 + C2: standard continue — contested roll shown, danger tier on nameplate,
 *  band-led HP deltas (TRADE band, edge-win → you −1, foe −2). */
function continueStandard(): string {
  const input: ContinueCardInput = {
    enemyName: "SHADOW STAG",
    woundWord: "BRUISED",
    pips: { filled: 3, total: 5 },
    playerHp: 18,
    playerMaxHp: 24,
    playerHpDelta: -1,
    lastRound: {
      d20: 14, bonus: 3, dc: 15,
      enemyD20: 10, enemyBonus: 5,
      margin: 2, band: "trade",
      playerHpDelta: -1,
      enemyHpDelta: -2,
    },
    dangerTier: dangerTier(15), // medium
  };
  return renderCombatContinueCard(input, PALETTES.house, BORDERS.standard);
}

/** C1: hard encounter — danger tier reads "hard" on the nameplate. */
function continueHard(): string {
  const input: ContinueCardInput = {
    enemyName: "GLOOMFANG",
    woundWord: "WOUNDED",
    pips: { filled: 2, total: 5 },
    playerHp: 10,
    playerMaxHp: 24,
    playerHpDelta: -3,
    lastRound: {
      d20: 8, bonus: 3, dc: 17,
      enemyD20: 16, enemyBonus: 7,
      margin: -3, band: "heavy",
      playerHpDelta: -4,
      enemyHpDelta: -1,
    },
    dangerTier: dangerTier(17), // hard
  };
  return renderCombatContinueCard(input, PALETTES.house, BORDERS.heavy);
}

/** C1: fatal encounter — top danger tier. */
function continueFatal(): string {
  const input: ContinueCardInput = {
    enemyName: "ELDER WYRM",
    woundWord: "BLOODIED",
    pips: { filled: 1, total: 5 },
    playerHp: 4,
    playerMaxHp: 24,
    playerHpDelta: -8,
    lastRound: {
      d20: 5, bonus: 3, dc: 20,
      enemyD20: 18, enemyBonus: 10,
      margin: -10, band: "heavy",
      playerHpDelta: -12,
      enemyHpDelta: -2,
    },
    dangerTier: dangerTier(20), // fatal
  };
  return renderCombatContinueCard(input, PALETTES.house, BORDERS.heavy);
}

/** C2: dead-tie trade (margin == 0) — symmetric −2/−2. */
function continueDeadTie(): string {
  const input: ContinueCardInput = {
    enemyName: "RAIDER",
    woundWord: "SCUFFED",
    pips: { filled: 4, total: 5 },
    playerHp: 16,
    playerMaxHp: 22,
    playerHpDelta: -2,
    lastRound: {
      d20: 11, bonus: 4, dc: 14,
      enemyD20: 11, enemyBonus: 4,
      margin: 0, band: "trade",
      playerHpDelta: -2,
      enemyHpDelta: -2,
    },
    dangerTier: dangerTier(14), // medium
  };
  return renderCombatContinueCard(input, PALETTES.house, BORDERS.standard);
}

/** C2: edge-loss trade — foe rolled higher, you −2, foe −1. */
function continueEdgeLoss(): string {
  const input: ContinueCardInput = {
    enemyName: "OUTLAW",
    woundWord: "SCUFFED",
    pips: { filled: 4, total: 5 },
    playerHp: 14,
    playerMaxHp: 22,
    playerHpDelta: -2,
    lastRound: {
      d20: 10, bonus: 3, dc: 14,
      enemyD20: 14, enemyBonus: 4,
      margin: -2, band: "trade",
      playerHpDelta: -2,
      enemyHpDelta: -1,
    },
    dangerTier: dangerTier(14), // medium
  };
  return renderCombatContinueCard(input, PALETTES.house, BORDERS.standard);
}

// B — Terminal card variants

/** C2 + P2: kill-blow terminal — band-led HP deltas, no unqualified WON/LOST
 *  except here (enemy dead). */
function terminalWon(): string {
  const card: CombatTerminalCard = {
    label: "COMBAT WON",
    playerD20: 16, bonus: 4, total: 20,
    enemyD20: 10, enemyBonus: 5,
    marker: "+", verdict: "WON",
    margin: 5, band: "trade",
    playerHpDelta: -1,
    enemyHpDelta: -2,
  };
  return renderCombatTerminalCard(card, PALETTES.house, BORDERS.standard);
}

/** C2: trade-band victory — the margin +1 resolves edge-win with credible HP deltas. */
function terminalTradeWin(): string {
  const card: CombatTerminalCard = {
    label: "COMBAT WON",
    playerD20: 13, bonus: 3, total: 16,
    enemyD20: 11, enemyBonus: 4,
    marker: "+", verdict: "WON",
    margin: 1, band: "trade",
    playerHpDelta: -1,
    enemyHpDelta: -2,
  };
  return renderCombatTerminalCard(card, PALETTES.house, BORDERS.standard);
}

/** Heavy-band loss — player down, unambiguous fight-lost verdict. */
function terminalLost(): string {
  const card: CombatTerminalCard = {
    label: "COMBAT LOST",
    playerD20: 4, bonus: 2, total: 6,
    enemyD20: 17, enemyBonus: 6,
    marker: "x", verdict: "LOST",
    margin: -11, band: "heavy",
    playerHpDelta: -8,
    enemyHpDelta: -1,
  };
  return renderCombatTerminalCard(card, PALETTES.house, BORDERS.heavy);
}

// C — Opening frame variants (C4 re-entry)

/** C4: combat re-entry with persisted damage — banded condition shown. */
function openingCombatReentry(): string {
  return renderOpeningFrame(
    "combat",
    {
      pcName: "Kael",
      pcHp: 14, pcMaxHp: 24,
      enemyName: "SHADOW STAG",
      enemyCondition: { woundWord: "BLOODIED", filled: 2, total: 5 },
    },
    PALETTES.house,
    BORDERS.standard,
  );
}

/** C4: fresh combat, no prior damage — "Unknown foe" placeholder + ?/? bar. */
function openingCombatFresh(): string {
  return renderOpeningFrame(
    "combat",
    { pcName: "Kael", pcHp: 24, pcMaxHp: 24 },
    PALETTES.house,
    BORDERS.standard,
  );
}

/** C4: known foe, fresh fight — enemy named but no condition band. */
function openingCombatNamed(): string {
  return renderOpeningFrame(
    "combat",
    {
      pcName: "Kael",
      pcHp: 24, pcMaxHp: 24,
      enemyName: "GLOOMFANG",
    },
    PALETTES.house,
    BORDERS.standard,
  );
}

// D — Presentation edge cases (P1)

/** P1: long enemy name — must clip to fit the danger-tag slot, not truncate mid-glyph. */
function continueLongName(): string {
  const input: ContinueCardInput = {
    enemyName: "THE DREAD LORD MALAKAR OF THE SEVEN SPIRES",
    woundWord: "UNSCATHED",
    pips: { filled: 5, total: 5 },
    playerHp: 24, playerMaxHp: 24, playerHpDelta: 0,
    dangerTier: dangerTier(18), // risky
  };
  return renderCombatContinueCard(input, PALETTES.house, BORDERS.standard);
}

/** P1: wide HP numbers — N/MM must keep one space inside the right border. */
function continueWideHp(): string {
  const input: ContinueCardInput = {
    enemyName: "RAT",
    woundWord: "SCUFFED",
    pips: { filled: 4, total: 5 },
    playerHp: 124, playerMaxHp: 140, playerHpDelta: -3,
    lastRound: {
      d20: 14, bonus: 3, dc: 12,
      enemyD20: 10, enemyBonus: 2,
      margin: 2, band: "clean",
      playerHpDelta: 0,
      enemyHpDelta: -1,
    },
    dangerTier: dangerTier(12), // easy
  };
  return renderCombatContinueCard(input, PALETTES.house, BORDERS.standard);
}

/** P1: terminal label must clip on word boundary, never mid-glyph. */
function terminalLongLabel(): string {
  const card: CombatTerminalCard = {
    label: "WITH A FINAL DESPERATE BLOW THE BEAST FALTERS AND COLLAPSES INTO THE DUST",
    playerD20: 18, bonus: 4, total: 22,
    enemyD20: 8, enemyBonus: 5,
    marker: "+", verdict: "WON",
    margin: 7, band: "clean",
    playerHpDelta: 0,
    enemyHpDelta: -3,
  };
  return renderCombatTerminalCard(card, PALETTES.house, BORDERS.standard);
}

// E — Danger-tier flicker across rounds (regression watch)

/** Same foe SHADOW STAG, same HP state, three different DCs — the danger word
 *  must change but the layout must not break. */
function dangerFlickerFrames(): Record<string, string> {
  const base: Omit<ContinueCardInput, "dangerTier" | "lastRound"> = {
    enemyName: "SHADOW STAG",
    woundWord: "BRUISED",
    pips: { filled: 3, total: 5 },
    playerHp: 18, playerMaxHp: 24, playerHpDelta: -1,
  };
  const dcs = [10, 14, 16, 19, 21];
  const result: Record<string, string> = {};
  for (const dc of dcs) {
    const tier = dangerTier(dc);
    const input: ContinueCardInput = {
      ...base,
      dangerTier: tier,
      lastRound: {
        d20: 12, bonus: 3, dc,
        enemyD20: 10, enemyBonus: dc - 10,
        margin: 5 - (dc - 10), band: "trade",
        playerHpDelta: -1, enemyHpDelta: -2,
      },
    };
    result[`DC ${dc} → ${tier}`] = renderCombatContinueCard(input, PALETTES.house, BORDERS.standard);
  }
  return result;
}

// F — Enemy-HP stability across last-stand re-entry (C3, C4)

/** Simulates what a last-stand re-entry looks like: the foe is damaged, the opening
 *  frame shows the banded condition, and the continue card shows enemy pips at the
 *  persisted level — NOT full or reset. */
function lastStandReentryFrames(): Record<string, string> {
  // Opening frame: re-entry with banded condition (bloodied, 1/5 pips)
  const opener = renderOpeningFrame(
    "combat",
    {
      pcName: "Kael",
      pcHp: 6, pcMaxHp: 24,
      enemyName: "SHADOW STAG",
      enemyCondition: { woundWord: "BLOODIED", filled: 1, total: 5 },
    },
    PALETTES.house,
    BORDERS.heavy,
  );

  // Continue card after one round: enemy still at 1/5 pips (NOT grown)
  const continueCard: ContinueCardInput = {
    enemyName: "SHADOW STAG",
    woundWord: "BLOODIED",
    pips: { filled: 1, total: 5 },
    playerHp: 4, playerMaxHp: 24, playerHpDelta: -2,
    lastRound: {
      d20: 9, bonus: 3, dc: 16,
      enemyD20: 14, enemyBonus: 6,
      margin: -6, band: "heavy",
      playerHpDelta: -6, enemyHpDelta: -1,
    },
    dangerTier: dangerTier(16),
  };
  const afterRound = renderCombatContinueCard(continueCard, PALETTES.house, BORDERS.heavy);

  return {
    "Opening (re-entry, 1/5 pips)": opener,
    "After 1st round (still 1/5, NOT grown)": afterRound,
  };
}

// ── Main ───────────────────────────────────────────────────────────

async function main() {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    console.error("DISCORD_TOKEN not set in .env or environment.");
    process.exit(1);
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages] });

  const messages: { label: string; title: string; content: string; checklist?: string[] }[] = [];

  // A — Continue card variants
  messages.push({ label: "A.1", title: "Continue — standard (TRADE, edge-win, medium)", content: continueStandard() });
  messages.push({ label: "A.2", title: "Continue — hard encounter, HEAVY band", content: continueHard() });
  messages.push({ label: "A.3", title: "Continue — fatal encounter, ELDER WYRM", content: continueFatal() });
  messages.push({ label: "A.4", title: "Continue — dead tie (margin 0, −2/−2)", content: continueDeadTie() });
  messages.push({ label: "A.5", title: "Continue — edge-loss trade (margin −2, you −2, foe −1)", content: continueEdgeLoss() });

  // B — Terminal card variants
  messages.push({ label: "B.1", title: "Terminal — WON, trade band, HP deltas shown", content: terminalWon() });
  messages.push({ label: "B.2", title: "Terminal — trade-band victory (margin +1)", content: terminalTradeWin() });
  messages.push({ label: "B.3", title: "Terminal — LOST, heavy band", content: terminalLost() });

  // C — Opening frame variants
  messages.push({ label: "C.1", title: "Opening — re-entry, bloodied stag (banded condition)", content: openingCombatReentry() });
  messages.push({ label: "C.2", title: "Opening — fresh fight, unknown foe", content: openingCombatFresh() });
  messages.push({ label: "C.3", title: "Opening — named foe, fresh (no condition band)", content: openingCombatNamed() });

  // D — Presentation edge cases
  messages.push({ label: "D.1", title: "Continue — long enemy name + danger tag (clip guard)", content: continueLongName() });
  messages.push({ label: "D.2", title: "Continue — wide HP (124/140), right-edge padding", content: continueWideHp() });
  messages.push({ label: "D.3", title: "Terminal — long label (clipWord guard)", content: terminalLongLabel() });

  // E — Danger-tier flicker
  const flickerFrames = dangerFlickerFrames();
  for (const [desc, frame] of Object.entries(flickerFrames)) {
    messages.push({ label: "E", title: `Danger flicker — ${desc}`, content: frame });
  }
  messages[messages.length - 1].checklist = [
    "Verify danger word changes (easy → medium → hard → risky → fatal) without breaking layout.",
    "Verify the word fits the nameplate line — no truncation, no orphaned `]`.",
    "Verify the tag colour changes: easy/medium = warmth (gold), hard/risky/fatal = threat (red).",
  ];

  // F — Last-stand re-entry stability
  const reentryFrames = lastStandReentryFrames();
  for (const [desc, frame] of Object.entries(reentryFrames)) {
    messages.push({ label: "F", title: `HP stability — ${desc}`, content: frame });
  }
  messages[messages.length - 1].checklist = [
    "The opening frame shows 1/5 enemy pips + BLOODIED — NOT ?/? or full.",
    "After the first round, the enemy still shows 1/5 pips — the bar Shrunk (or stayed), never grew.",
    "Player HP fell from 6 → 4 as expected.",
  ];

  // Manual checks
  const manualChecks = [
    "In-app: start a real combat against a named NPC (e.g. Shadow Stag). Verify the continue card shows the NPC's real name (C3).",
    "In-app: bail out of a fight mid-way, then re-engage. The opening frame must show banded condition, not ?/? (C4).",
    "In-app: fight to last-stand. The desperate-choice screen must show the contested-roll readout + banded condition (C5).",
    "In-app: land the killing blow. The outcome must show the combat opening frame + terminal card (P2), not a bare location scene.",
    "In-app: verify the /action 'last action' hint fires only on the genuine last roll (Saturday = 4th, weekday = 3rd). (N3 verified by tests; sanity-check.)",
    "In-app: cross a frontier to a new location. Verify the description resolves (not perpetual placeholder) within ~15s. (N2)",
    "In-app: on a Saturday, verify the threat NPC is at its announced location on /look and stays there (doesn't wander off). (N1)",
    "In-app: on the unfinished-action screen (/hi), verify the free-text 'or type action <what you do>' line is gone. (N5)",
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
    await admin.send(
      "# 🧪 0.3.2 live-check — combat correctness\n\n" +
      "Verify each frame below on **desktop** (colour) AND **mobile** (monochrome).\n" +
      "Check the legend at the bottom for manual in-app items.\n\n" +
      "## What to watch (every frame)\n" +
      "- Desktop: colour roles render. Mobile: strip colour — verify signs (+/−/x), band words, danger tags carry meaning without colour.\n" +
      "- Border glyphs are single-width and right edge aligns on mobile.\n" +
      "- Danger tier on nameplate: easy/medium = gold, hard/risky/fatal = red.\n" +
      "- Band-led HP deltas: `you −N  foe −M` beside the band word, consistent with the margin sign.\n" +
      "- No `+ WIN / x LOSS` on a continue card — reserved for the terminal (fight-over) card only.",
    );

    for (const { label, title, content, checklist } of messages) {
      let header = `### ${label} — ${title}\n`;
      if (checklist) {
        header += "\n**Verify:**\n" + checklist.map((c) => `- [ ] ${c}`).join("\n") + "\n";
      }
      await admin.send(header + content);
      await new Promise((r) => setTimeout(r, 500));
    }

    // Send manual checklist
    const checklist = "## G — Manual in-app checks\n\n" + manualChecks.map((c) => `- [ ] ${c}`).join("\n");
    await admin.send(checklist);

    console.log("\nAll frames sent. Operator checklist:");
    console.log("  A.1–A.5: Continue cards — contested roll, danger tier, band-led HP deltas, asymmetric trade.");
    console.log("  B.1–B.3: Terminal cards — verdict coherence, HP deltas on every card.");
    console.log("  C.1–C.3: Opening frames — re-entry banded condition, unknown vs named foe.");
    console.log("  D.1–D.3: Presentation edge cases — name clipping, HP padding, label clipWord.");
    console.log("  E:     Danger-tier flicker — same foe, 5 DC levels, verify words + colours.");
    console.log("  F:     Last-stand HP stability — verify enemy bar never grows on re-entry.");
    console.log("  G:     Manual in-app checks — real combat, bail, last-stand, kill-blow, frontier, Saturday threat, unfinished-action copy.");

    client.destroy();
    process.exit(0);
  });

  await client.login(token);
}

main();
