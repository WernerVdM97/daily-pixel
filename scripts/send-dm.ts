// Send an arbitrary message to the admin's Discord DM for manual validation.
//
// Two ways to use it:
//   1. CLI — quick ad-hoc text (see usage below), e.g. eyeballing a probe block.
//   2. Import — `sendToAdmin(payload)` is exported so a throwaway tsx script can
//      pull a real builder out of `src/` (AnsiRenderer, a decision-message builder,
//      an embed) and post its actual output for a manual look, no bespoke harness.
//
// The CLI sends one plain-text body, or an embed with `--embed <file>` (a JSON embed, or an
// array of them), or both. The embed exists because a plain body has one hard 2000-character
// budget for everything, so a digest that must carry a per-item card either loses its items or
// loses its links: content becomes the index, the embed carries the cards, and each keeps its
// own limit. Validation mirrors `contentLengthError`, because the API's over-long error names
// neither the embed nor the field it tripped on.
//
// Unlike scripts/send-ansi.ts this resolves `.env` relative to the repo, so it runs
// on this dev Mac and on the Linux deploy host unchanged.

import { readFileSync, existsSync, fstatSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  Client,
  Events,
  GatewayIntentBits,
  type APIEmbed,
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

/** Discord rejects message content past this, and its API error does not say which message. */
export const DM_CONTENT_LIMIT = 2000;

/**
 * Why this content cannot be sent, or null. A digest that grew past the limit used to fail at
 * the API with a form error that named neither the message nor the length, which reads as a
 * broken DM path rather than an over-long one.
 */
export function contentLengthError(content: string): string | null {
  if (content.length <= DM_CONTENT_LIMIT) return null;
  return (
    `message is ${content.length} characters; Discord's limit is ${DM_CONTENT_LIMIT}. ` +
    'Shorten it (drop a bullet, keep every link) and send again.'
  );
}

/** Discord's documented embed limits. Exceeding one fails the whole send with a form error. */
export const EMBED_LIMITS = {
  embeds: 10,
  title: 256,
  description: 4096,
  fields: 25,
  fieldName: 256,
  fieldValue: 1024,
  footerText: 2048,
  authorName: 256,
  /** Summed over every embed in the message: title, description, fields, footer, author. */
  total: 6000,
};

function over(what: string, length: number, limit: number): string {
  return `${what} is ${length} characters; Discord's limit is ${limit}`;
}

/**
 * Why these embeds cannot be sent, or null. The API rejects the whole message for one over-long
 * field value and its error names neither the embed nor the field, which is the same dead-end
 * `contentLengthError` exists to close for plain content.
 *
 * Exported for tests: the limits are the contract, and a digest that violates one silently
 * loses the proposals it was carrying.
 */
export function embedError(embeds: unknown): string | null {
  if (!Array.isArray(embeds)) return "embeds must be an array of embed objects";
  if (embeds.length === 0) return null;
  if (embeds.length > EMBED_LIMITS.embeds) {
    return over("the message's embed count", embeds.length, EMBED_LIMITS.embeds);
  }

  let total = 0;
  for (const [i, raw] of embeds.entries()) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return `embed ${i + 1} is not an object`;
    }
    const scan = scanEmbed(raw as APIEmbed, `embed ${i + 1}`);
    if (scan.error) return scan.error;
    total += scan.size;
  }

  if (total > EMBED_LIMITS.total) {
    return over("the message's embeds in total", total, EMBED_LIMITS.total);
  }
  return null;
}

/** One embed's over-long part, and its contribution to the aggregate the message is capped at. */
function scanEmbed(embed: APIEmbed, at: string): { error: string | null; size: number } {
  const parts: [string, string | undefined, number][] = [
    [`${at} title`, embed.title, EMBED_LIMITS.title],
    [`${at} description`, embed.description, EMBED_LIMITS.description],
    [`${at} author name`, embed.author?.name, EMBED_LIMITS.authorName],
    [`${at} footer`, embed.footer?.text, EMBED_LIMITS.footerText],
  ];
  let size = 0;
  for (const [what, text, limit] of parts) {
    if (text === undefined) continue;
    size += text.length;
    if (text.length > limit) return { error: over(what, text.length, limit), size };
  }

  const fields = embed.fields ?? [];
  if (fields.length > EMBED_LIMITS.fields) {
    return { error: over(`${at} field count`, fields.length, EMBED_LIMITS.fields), size };
  }
  for (const [n, field] of fields.entries()) {
    size += field.name.length + field.value.length;
    if (field.name.length > EMBED_LIMITS.fieldName) {
      return { error: over(`${at} field ${n + 1} name`, field.name.length, EMBED_LIMITS.fieldName), size };
    }
    if (field.value.length > EMBED_LIMITS.fieldValue) {
      return { error: over(`${at} field ${n + 1} value`, field.value.length, EMBED_LIMITS.fieldValue), size };
    }
  }
  return { error: null, size };
}

/** Parse the `--embed` file: one embed object, or an array of them. */
export function parseEmbeds(raw: string, source: string): APIEmbed[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${source} is not valid JSON: ${(err as Error).message}`);
  }
  const embeds = Array.isArray(parsed) ? parsed : [parsed];
  // An empty list is a mistake in the file rather than a message: `[]` is truthy, so it would
  // clear the "nothing to send" guard and reach Discord as "Cannot send an empty message".
  if (embeds.length === 0) throw new Error(`${source} carries no embeds, so there is nothing to send.`);
  const problem = embedError(embeds);
  if (problem) throw new Error(`${source}: ${problem}`);
  return embeds as APIEmbed[];
}

/**
 * The message to send: a bare string when there is no embed, so a plain-text caller is unchanged,
 * and message options when there is one. `content` stays optional, because an embed is a complete
 * message on its own.
 */
export function composeMessage(
  content: string | undefined,
  embeds: APIEmbed[] | undefined,
): string | MessageCreateOptions {
  if (!embeds || embeds.length === 0) return content ?? "";
  return { content: content ?? "", embeds };
}

/** A DM message: either raw content or full discord.js message options (embeds, files, …). */
export type DmPayload = string | MessageCreateOptions;

/**
 * Log in, DM one or more payloads to the admin (or `toUserId`), then tear down.
 * Import this from a one-off script to send real rendered `src/` output for a manual look.
 *
 * Returns the sent message ids in order, so a caller that needs the owner to *answer*
 * (the factory's inbox watcher polls reactions on the digest it sent) has something to
 * watch. Callers that only want the side effect can ignore the return value.
 */
export async function sendToAdmin(
  payloads: DmPayload | DmPayload[],
  toUserId?: string,
): Promise<string[]> {
  loadEnv();
  const token = process.env.DISCORD_TOKEN;
  const recipient = toUserId ?? process.env.ADMIN_USER_ID;
  if (!token) throw new Error("DISCORD_TOKEN is not set (repo .env or environment).");
  if (!recipient) throw new Error("No recipient: set ADMIN_USER_ID or pass toUserId.");

  const list = Array.isArray(payloads) ? payloads : [payloads];
  const sentIds: string[] = [];
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
  });

  return await new Promise<string[]>((resolvePromise, reject) => {
    client.once(Events.ClientReady, async () => {
      try {
        console.log(`Logged in as ${client.user?.tag}`);
        const user = await client.users.fetch(recipient);
        const dm = await user.createDM();
        for (const [i, payload] of list.entries()) {
          const sent = await dm.send(payload as MessageCreateOptions | string);
          sentIds.push(sent.id);
          console.log(`Sent message ${i + 1}/${list.length}`);
        }
        resolvePromise(sentIds);
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

function usage(): string {
  return [
    "Usage: tsx scripts/send-dm.ts [options] [message]",
    "",
    "  message            positional message text",
    "  -t, --text <s>     message text",
    "  -f, --file <path>  read the body from a file",
    "  (stdin)            piped input when no text/file given",
    "",
    "  -e, --embed <path> JSON embed for the message: one object, or an array of them",
    "                     (fields: title, description, fields[{name,value}], footer, author, color)",
    "  --fence <lang>     wrap the body in a ```<lang> code fence (e.g. ansi)",
    "  --title <s>        bold title line above the body",
    "  --to <userId>      recipient (default: ADMIN_USER_ID from .env)",
    "",
    "Examples:",
    '  tsx scripts/send-dm.ts "quick note to myself"',
    "  tsx scripts/send-dm.ts --fence ansi -f docs/assets/ansi/test/frame.ansi",
    '  echo "$RENDERED" | tsx scripts/send-dm.ts --title "Terminal card" --fence ansi',
    "  tsx scripts/send-dm.ts -f digest.txt --embed digest-embed.json",
  ].join("\n");
}

interface CliArgs {
  text?: string;
  file?: string;
  fence?: string;
  title?: string;
  embed?: string;
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
      case "-e": case "--embed": out.embed = argv[++i]; break;
      case "--fence": out.fence = argv[++i]; break;
      case "--title": out.title = argv[++i]; break;
      case "--to": out.to = argv[++i]; break;
      // Without this `--help` is read as a positional and DMed to the owner verbatim.
      case "-h": case "--help": console.log(usage()); process.exit(0); break;
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

/**
 * True when stdin is something that could be carrying a body: a pipe, a socket or a redirected
 * file, as opposed to a terminal or `/dev/null`, both of which are character devices and are what
 * a headless or interactive caller gets. Read from the descriptor rather than `isTTY`, because a
 * scheduled run has no TTY either and warning on every one of those would be noise.
 */
function stdinCouldCarryBody(): boolean {
  try {
    return !fstatSync(0).isCharacterDevice();
  } catch {
    return false;
  }
}

async function runCli(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Body source precedence: --file, then --text/positional, then piped stdin, and stdin only when
  // nothing else could carry the body. Reading it would block on a pipe with no writer, so an
  // embed-only send skips it and says so: a body that silently vanished is the one outcome a
  // digest cannot report on its own.
  if (args.embed && stdinCouldCarryBody()) {
    console.error("note: --embed is set, so stdin is not read as the body; pass -f/--text to send both.");
  }

  let body: string | undefined;
  if (args.file) body = readFileSync(resolve(process.cwd(), args.file), "utf-8");
  else if (args.text !== undefined) body = args.text;
  else if (!args.embed && !process.stdin.isTTY) body = await readStdin();

  // A bad embed file is a refusal with a reason, not a crash: the stack trace that an uncaught
  // throw prints reads as a broken DM path rather than as an over-long field.
  let embeds: APIEmbed[] | undefined;
  if (args.embed) {
    try {
      embeds = parseEmbeds(readFileSync(resolve(process.cwd(), args.embed), "utf-8"), args.embed);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  }

  // A body is only required when there is no embed: an embed is a complete message.
  if (!embeds && !body?.trim()) {
    console.error(usage());
    process.exit(1);
  }

  let content: string | undefined = body;
  if (args.fence) {
    if (!body) {
      console.error("--fence needs a body (--text, --file or stdin).");
      process.exit(1);
    }
    content = `\`\`\`${args.fence}\n${body}\n\`\`\``;
  }
  if (args.title) content = content ? `**${args.title}**\n${content}` : `**${args.title}**`;

  if (content !== undefined) {
    const tooLong = contentLengthError(content);
    if (tooLong) {
      console.error(tooLong);
      process.exit(1);
    }
  }

  const ids = await sendToAdmin(composeMessage(content, embeds), args.to);
  // Printed, not just logged: the factory's inbox watcher records this id and polls
  // reactions on it, which is how the owner answers a digest without a button handler.
  for (const id of ids) console.log(`message-id: ${id}`);
  console.log("Done.");
  process.exit(0);
}

// Run the CLI only when invoked directly, so importers get just the helper.
// Through pathToFileURL, not `file://${argv[1]}`: a path holding a space is percent-encoded in
// import.meta.url, so that comparison never matches and the CLI silently does nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((err) => {
    console.error("Send error:", err);
    process.exit(1);
  });
}
