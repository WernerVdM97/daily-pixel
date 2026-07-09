import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { Client, Events, GatewayIntentBits } from "discord.js";

// Parse .env manually
const env: Record<string, string> = {};
const envRaw = readFileSync("/home/werner/projects/daily-pixel/.env", "utf-8");
for (const line of envRaw.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq === -1) continue;
  env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
}

const TOKEN = env.DISCORD_TOKEN;
const ADMIN_ID = env.ADMIN_USER_ID;
const ANSI_DIR = "/home/werner/projects/daily-pixel/docs/assets/ansi/test/colour";

const files = readdirSync(ANSI_DIR)
  .filter(f => f.endsWith(".ansi"))
  .sort();

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages] });

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user?.tag}`);

  try {
    const admin = await client.users.fetch(ADMIN_ID);
    const dm = await admin.createDM();

    await dm.send(`**ANSI colour test blocks** (${files.length} files):`);

    for (const file of files) {
      const content = readFileSync(resolve(ANSI_DIR, file), "utf-8");
      await dm.send({
        content: `**${file}**\n\`\`\`ansi\n${content}\`\`\``,
      });
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
