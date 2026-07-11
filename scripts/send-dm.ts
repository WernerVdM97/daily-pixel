// Send an arbitrary message to the admin's Discord DM for manual validation.
//
// Two ways to use it:
//   1. CLI — quick ad-hoc text (see usage below), e.g. eyeballing a probe block.
//   2. Import — `sendToAdmin(payload)` is exported so a throwaway tsx script can
//      pull a real builder out of `src/` (AnsiRenderer, a decision-message builder,
//      an embed) and post its actual output for a manual look, no bespoke harness.
//
// Unlike scripts/send-ansi.ts this resolves `.env` relative to the repo, so it runs
// on this dev Mac and on the Linux deploy host unchanged.

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Client,
  Events,
  GatewayIntentBits,
  type MessageCreateOptions,
} from "discord.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Parse the repo-root .env into process.env without clobbering vars already set
// (systemd on the host injects them directly, so there is no file to read there).
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

/** A DM message: either raw content or full discord.js message options (embeds, files, …). */
export type DmPayload = string | MessageCreateOptions;

/**
 * Log in, DM one or more payloads to the admin (or `toUserId`), then tear down.
 * Import this from a one-off script to send real rendered `src/` output for a manual look.
 */
export async function sendToAdmin(
  payloads: DmPayload | DmPayload[],
  toUserId?: string,
): Promise<void> {
  loadEnv();
  const token = process.env.DISCORD_TOKEN;
  const recipient = toUserId ?? process.env.ADMIN_USER_ID;
  if (!token) throw new Error("DISCORD_TOKEN is not set (repo .env or environment).");
  if (!recipient) throw new Error("No recipient: set ADMIN_USER_ID or pass toUserId.");

  const list = Array.isArray(payloads) ? payloads : [payloads];
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
  });

  await new Promise<void>((resolvePromise, reject) => {
    client.once(Events.ClientReady, async () => {
      try {
        console.log(`Logged in as ${client.user?.tag}`);
        const user = await client.users.fetch(recipient);
        const dm = await user.createDM();
        for (const [i, payload] of list.entries()) {
          await dm.send(payload as MessageCreateOptions | string);
          console.log(`Sent message ${i + 1}/${list.length}`);
        }
        resolvePromise();
      } catch (err) {
        reject(err);
      } finally {
        client.destroy();
      }
    });
    client.login(token).catch(reject);
  });
}

// ── CLI ────────────────────────────────────────────────────────────────────

interface CliArgs {
  text?: string;
  file?: string;
  fence?: string;
  title?: string;
  to?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-t": case "--text": out.text = argv[++i]; break;
      case "-f": case "--file": out.file = argv[++i]; break;
      case "--fence": out.fence = argv[++i]; break;
      case "--title": out.title = argv[++i]; break;
      case "--to": out.to = argv[++i]; break;
      default: positional.push(a);
    }
  }
  if (out.text === undefined && positional.length) out.text = positional.join(" ");
  return out;
}

function readStdin(): Promise<string> {
  return new Promise((resolvePromise) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolvePromise(data));
  });
}

async function runCli(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Body source precedence: --file, then --text/positional, then piped stdin.
  let body: string | undefined;
  if (args.file) body = readFileSync(resolve(process.cwd(), args.file), "utf-8");
  else if (args.text !== undefined) body = args.text;
  else if (!process.stdin.isTTY) body = await readStdin();

  if (!body || !body.trim()) {
    console.error(
      [
        "Usage: tsx scripts/send-dm.ts [options] [message]",
        "",
        "  message            positional message text",
        "  -t, --text <s>     message text",
        "  -f, --file <path>  read the body from a file",
        "  (stdin)            piped input when no text/file given",
        "",
        "  --fence <lang>     wrap the body in a ```<lang> code fence (e.g. ansi)",
        "  --title <s>        bold title line above the body",
        "  --to <userId>      recipient (default: ADMIN_USER_ID from .env)",
        "",
        "Examples:",
        '  tsx scripts/send-dm.ts "quick note to myself"',
        "  tsx scripts/send-dm.ts --fence ansi -f docs/assets/ansi/test/frame.ansi",
        '  echo "$RENDERED" | tsx scripts/send-dm.ts --title "Terminal card" --fence ansi',
      ].join("\n"),
    );
    process.exit(1);
  }

  let content = args.fence ? `\`\`\`${args.fence}\n${body}\n\`\`\`` : body;
  if (args.title) content = `**${args.title}**\n${content}`;

  await sendToAdmin(content, args.to);
  console.log("Done.");
  process.exit(0);
}

// Run the CLI only when invoked directly, so importers get just the helper.
if (import.meta.url === `file://${process.argv[1]}`) {
  runCli().catch((err) => {
    console.error("Send error:", err);
    process.exit(1);
  });
}
