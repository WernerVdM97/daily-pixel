// DM every ANSI colour test block to the admin for a manual look on real Discord.
//
// Resolves paths relative to the repo root (like send-dm.ts) so it runs unchanged
// on this dev Mac and on the Linux deploy host.
//
// Before sending, it validates every frame against the single-width hard rule
// (see the ansi-frames skill §1): each line must display at the frame's border
// width, counting emoji / Miscellaneous-Symbols / Dingbats glyphs as two cells.
// A frame with a double-width glyph aborts the whole send — those glyphs push the
// border out of line in Discord and on mobile.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Events, GatewayIntentBits } from "discord.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ANSI_DIR = resolve(REPO_ROOT, "docs/assets/ansi/test/colour");

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

// Display width of a char. Emoji / Misc-Symbols / Dingbats and the CJK/emoji
// planes render double-width; everything in our tested-safe set is single-width.
function charWidth(cp: number): number {
  if (cp === 0xfe0f) return 0; // VS16 (combines with the previous glyph)
  if (cp === 0x00a7 || cp === 0x2192) return 2; // § and → — East-Asian-Ambiguous, Discord renders them wide (use # / >)
  if (cp >= 0x2600 && cp <= 0x27bf) return 2; // misc symbols + dingbats (⚠ ☺ ✦ ❖ ✓ ✗)
  if (cp >= 0x1f000) return 2; // emoji planes
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3)) return 2;
  return 1;
}

function displayWidth(line: string): number {
  const noAnsi = line.replace(/\x1b\[[0-9;]*m/g, "");
  let w = 0;
  for (const ch of noAnsi) w += charWidth(ch.codePointAt(0)!);
  return w;
}

/** Returns a per-file list of offending rows; empty means the frame is aligned. */
function validate(file: string, content: string): string[] {
  const lines = content.replace(/\n$/, "").split("\n");
  const border = displayWidth(lines[0]);
  const bad: string[] = [];
  lines.forEach((l, i) => {
    const w = displayWidth(l);
    if (w !== border) bad.push(`  line ${i + 1}: width ${w}, expected ${border}`);
  });
  return bad;
}

loadEnv();
const TOKEN = process.env.DISCORD_TOKEN;
const ADMIN_ID = process.env.ADMIN_USER_ID;
if (!TOKEN) throw new Error("DISCORD_TOKEN is not set (repo .env or environment).");
if (!ADMIN_ID) throw new Error("ADMIN_USER_ID is not set (repo .env or environment).");

const files = readdirSync(ANSI_DIR)
  .filter((f) => f.endsWith(".ansi"))
  .sort();

// Enforce the single-width rule up front; refuse to send a misaligned batch.
const failures = files
  .map((f) => ({ f, bad: validate(f, readFileSync(resolve(ANSI_DIR, f), "utf-8")) }))
  .filter((r) => r.bad.length);
if (failures.length) {
  console.error("Refusing to send — frames violate the single-width rule (ansi-frames skill §1):\n");
  for (const { f, bad } of failures) console.error(`${f}\n${bad.join("\n")}`);
  process.exit(1);
}
console.log(`Validated ${files.length} frames: all rows single-width and aligned.`);

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages] });

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user?.tag}`);
  try {
    const admin = await client.users.fetch(ADMIN_ID);
    const dm = await admin.createDM();

    await dm.send(`**ANSI colour test blocks** (${files.length} files):`);
    for (const file of files) {
      const content = readFileSync(resolve(ANSI_DIR, file), "utf-8");
      await dm.send({ content: `**${file}**\n\`\`\`ansi\n${content}\`\`\`` });
      console.log(`Sent: ${file}`);
    }
    await dm.send("Done. All ANSI blocks sent.");
    console.log("All done.");
  } catch (err) {
    console.error("Send error:", err);
  }

  client.destroy();
  process.exit(0);
});

client.login(TOKEN);
