// Dark Factory owner inbox — the inbound half of the loop.
//
// The factory can talk to the owner (`scripts/send-dm.ts`) but until now nothing could
// hear back. This drains the owner's answers from three places, in order of reliability:
//
//   1. `.pi/factory/inbox/*.md|txt` — files the owner or a session drops. Always works,
//      no Discord, no intents. Consumed files move to `inbox/done/`.
//   2. Reactions on the last digest DM. Reactions are plain REST data on a message the
//      bot sent, so a one-shot script can read them *retroactively* with no listener
//      process and no privileged intent. This is why the factory answers by reaction
//      rather than by button: a button click is an event that is lost forever if the
//      bot is not connected at the moment of the click.
//   3. DM message text from the owner. Needs no privileged intent: the MessageContent intent
//      gates *guild* messages, and Discord delivers DM content to a bot holding only the
//      DirectMessages intent (verified against this repo's own bot). It would only matter if
//      the intake later moved to a channel.
//
// A third tier that is only load-bearing if the intake moves to a guild channel:
//   `MessageContent` is the privileged intent for guild message text. DM text does not need it.
//
// Usage:
//   tsx scripts/factory-inbox.ts                  # drain, print the brief
//   tsx scripts/factory-inbox.ts --json           # machine-readable
//   tsx scripts/factory-inbox.ts --peek           # report without consuming anything
//   tsx scripts/factory-inbox.ts --record <id>    # remember the digest message to watch
//
// Reaction vocabulary (the digest's own footer repeats it):
//   1️⃣…5️⃣  approve that numbered proposal      ✅  approve every pending proposal
//   ❌      reject every pending proposal        🔁  re-run the analysis
//   ⏸      hold, change nothing

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { resolve, dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type DMChannel,
  type Message,
} from "discord.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INBOX_DIR = join(REPO_ROOT, ".pi", "factory", "inbox");
const DONE_DIR = join(INBOX_DIR, "done");
const STATE_PATH = join(INBOX_DIR, "state.json");
const MAX_FILE_CHARS = 4000;
const LOGIN_TIMEOUT_MS = 30_000;

/** Same repo-relative `.env` load as send-dm.ts: works on the dev box and on the host. */
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

// ── Reaction vocabulary ────────────────────────────────────────────────────

interface Vote {
  intent: "approve" | "reject" | "rerun" | "hold";
  proposal: number | null;
}

// Discord keycaps carry a variation selector that nobody types consistently, so emoji are
// compared with it stripped. Without that, a reaction to "1️⃣" misses a "1⃣" lookup.
function normaliseEmoji(raw: string): string {
  return raw.replace(/\uFE0F/g, "");
}

/**
 * The whole vocabulary in click order. Seeded onto every digest by `--seed`, so the owner
 * clicks a reaction Discord already drew instead of hunting through the emoji picker, and
 * the order itself documents the protocol: the proposals first, then the bulk verbs.
 *
 * `emoji` is the form sent to the API (keycaps keep their variation selector); matching
 * always goes through `normaliseEmoji`, so a hand-added reaction is recognised too.
 */
const VOTE_ORDER: { emoji: string; vote: Vote }[] = [
  { emoji: "1️⃣", vote: { intent: "approve", proposal: 1 } },
  { emoji: "2️⃣", vote: { intent: "approve", proposal: 2 } },
  { emoji: "3️⃣", vote: { intent: "approve", proposal: 3 } },
  { emoji: "4️⃣", vote: { intent: "approve", proposal: 4 } },
  { emoji: "5️⃣", vote: { intent: "approve", proposal: 5 } },
  { emoji: "✅", vote: { intent: "approve", proposal: null } },
  { emoji: "❌", vote: { intent: "reject", proposal: null } },
  { emoji: "🔁", vote: { intent: "rerun", proposal: null } },
  { emoji: "⏸", vote: { intent: "hold", proposal: null } },
];

const BULK_VOTES = VOTE_ORDER.length - 5;

/** The seed set for a digest carrying `proposals` proposals: its keycaps, then the verbs. */
function seedSet(proposals: number): { emoji: string; vote: Vote }[] {
  const wanted = Math.max(1, Math.min(5, proposals));
  return [...VOTE_ORDER.slice(0, wanted), ...VOTE_ORDER.slice(VOTE_ORDER.length - BULK_VOTES)];
}

const VOTES: Record<string, Vote> = Object.fromEntries(
  VOTE_ORDER.map((entry) => [normaliseEmoji(entry.emoji), entry.vote]),
);

interface ReactionVote extends Vote {
  emoji: string;
  count: number;
  fresh: number;
  from: string[];
}

interface OwnerMessage {
  at: string;
  text: string;
}

interface FileInstruction {
  file: string;
  text: string;
}

interface Drained {
  drainedAt: string;
  consumed: boolean;
  digestMessageId: string | null;
  votes: ReactionVote[];
  messages: OwnerMessage[];
  files: FileInstruction[];
  notes: string[];
}

interface State {
  digestMessageId?: string;
  digestRecordedAt?: string;
  drainedAt?: string;
  reactionBaseline?: Record<string, number>;
}

function readState(): State {
  if (!existsSync(STATE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf-8")) as State;
  } catch {
    return {};
  }
}

function writeState(state: State): void {
  mkdirSync(INBOX_DIR, { recursive: true });
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

// ── Source 1: files ────────────────────────────────────────────────────────

function drainFiles(consume: boolean): FileInstruction[] {
  if (!existsSync(INBOX_DIR)) return [];
  const names = readdirSync(INBOX_DIR).filter(
    (n) => !n.startsWith(".") && (n.endsWith(".md") || n.endsWith(".txt")),
  );
  const out: FileInstruction[] = [];
  for (const name of names) {
    const full = join(INBOX_DIR, name);
    let text: string;
    try {
      text = readFileSync(full, "utf-8").trim();
    } catch {
      continue;
    }
    if (text) out.push({ file: name, text: text.slice(0, MAX_FILE_CHARS) });
    // Consumed instructions move aside rather than being deleted or re-read: a scheduled
    // run that re-applies yesterday's instruction is worse than a lost one.
    if (consume) {
      mkdirSync(DONE_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      renameSync(full, join(DONE_DIR, `${stamp}__${basename(name)}`));
    }
  }
  return out;
}

// ── Sources 2 and 3: the admin DM ──────────────────────────────────────────

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const token = process.env.DISCORD_TOKEN;
  const recipient = process.env.ADMIN_USER_ID;
  if (!token) throw new Error("DISCORD_TOKEN is not set (repo .env or environment).");
  if (!recipient) throw new Error("ADMIN_USER_ID is not set (repo .env or environment).");

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
    partials: [Partials.Channel],
  });
  try {
    return await Promise.race([
      (async () => {
        await client.login(token);
        if (!client.isReady()) {
          await new Promise<void>((res) => client.once(Events.ClientReady, () => res()));
        }
        return await fn(client);
      })(),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error(`Discord login timed out after ${LOGIN_TIMEOUT_MS}ms`)), LOGIN_TIMEOUT_MS),
      ),
    ]);
  } finally {
    client.destroy();
  }
}

async function readDm(
  client: Client,
  state: State,
  digestMessageId: string | null,
): Promise<{ votes: ReactionVote[]; messages: OwnerMessage[]; notes: string[] }> {
  const notes: string[] = [];
  const recipient = process.env.ADMIN_USER_ID as string;
  const dm: DMChannel = await (await client.users.fetch(recipient)).createDM();

  const votes: ReactionVote[] = [];
  if (digestMessageId) {
    try {
      const message: Message = await dm.messages.fetch(digestMessageId);
      const baseline = state.reactionBaseline ?? {};
      for (const reaction of message.reactions.cache.values()) {
        const key = normaliseEmoji(reaction.emoji.name ?? "");
        const vote = VOTES[key];
        if (!vote) continue;
        const users = await reaction.users.fetch();
        // The count includes the bot's own reaction when it seeded one; only the owner counts.
        const ownerIds = users.filter((u) => !u.bot).map((u) => u.id);
        const total = ownerIds.length;
        const fresh = Math.max(0, total - (baseline[key] ?? 0));
        votes.push({ ...vote, emoji: key, count: total, fresh, from: ownerIds });
      }
      if (!votes.length) notes.push("Digest message has no reaction yet.");
    } catch {
      notes.push(`Digest message ${digestMessageId} is gone or unreadable; re-record it after the next digest.`);
    }
  } else {
    notes.push("No digest message recorded, so owner reactions could not be read. Record it with: tsx scripts/factory-inbox.ts --record <message-id>");
  }

  // Text replies need no privileged intent: MessageContent gates guild messages, while DM
  // content arrives for a bot holding only DirectMessages (verified against this bot).
  const since = state.drainedAt ? Date.parse(state.drainedAt) : 0;
  const messages: OwnerMessage[] = [];
  let blank = 0;
  const recent = await dm.messages.fetch({ limit: 30 });
  for (const msg of recent.values()) {
    if (msg.author.id !== recipient) continue;
    const at = msg.createdTimestamp;
    if (since && at <= since) continue;
    const text = (msg.content ?? "").trim();
    if (!text) {
      blank++;
      continue;
    }
    messages.push({ at: new Date(at).toISOString(), text: text.slice(0, MAX_FILE_CHARS) });
  }
  if (blank > 0) {
    notes.push(
      `${blank} DM message(s) since the last drain arrived with empty content. This is not the privileged ` +
        `MessageContent intent: Discord delivers DM content without it (verified here), so treat empty DM content ` +
        `as a delivery fault worth investigating before trusting this channel.`,
    );
  }
  return { votes, messages, notes };
}

// ── CLI ────────────────────────────────────────────────────────────────────

interface Options {
  json: boolean;
  peek: boolean;
  record: string | null;
  seed: number | null;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { json: false, peek: false, record: null, seed: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") opts.json = true;
    else if (a === "--peek") opts.peek = true;
    else if (a === "--record") opts.record = argv[++i];
    else if (a === "--seed") {
      // Bare `--seed` means the full five; `--seed 3` matches a digest with three proposals.
      const next = argv[i + 1];
      const count = next && /^\d+$/.test(next) ? Number.parseInt(argv[++i], 10) : 5;
      opts.seed = count;
    } else if (a === "--help" || a === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}\n${usage()}`);
      process.exit(1);
    }
  }
  return opts;
}

function usage(): string {
  return [
    "Usage: tsx scripts/factory-inbox.ts [options]",
    "",
    "  --record <messageId>  remember which DM to watch for owner reactions",
    "  --seed [n]            react on that DM with the vote vocabulary (n proposal keycaps, default 5)",
    "  --peek                report without consuming files or moving the baseline",
    "  --json                machine-readable drain instead of the brief",
    "",
    "  --record alone exits after arming; --seed alone exits after reacting.",
  ].join("\n");
}

function renderText(d: Drained): string {
  const lines: string[] = [];
  lines.push(`Factory inbox — drained ${d.drainedAt}`);
  lines.push(d.digestMessageId ? `Watching digest message ${d.digestMessageId}` : "Watching: nothing recorded");
  lines.push("");

  const active = d.votes.filter((v) => v.count > 0);
  lines.push(`## Decisions (${active.length})`);
  if (!active.length) lines.push("  none");
  for (const v of active) {
    const what =
      v.intent === "approve"
        ? v.proposal
          ? `approve proposal ${v.proposal}`
          : "approve every pending proposal"
        : v.intent === "reject"
          ? "reject every pending proposal"
          : v.intent === "rerun"
            ? "re-run the analysis"
            : "hold, change nothing";
    lines.push(`  ${v.emoji} ${what}${v.fresh === 0 ? "  (already counted last drain)" : v.fresh > 1 ? `  (${v.fresh}x new)` : ""}`);
  }
  lines.push("");

  lines.push(`## Owner messages (${d.messages.length})`);
  if (!d.messages.length) lines.push("  none");
  for (const m of d.messages) lines.push(`  ${m.at}: ${m.text.replace(/\n/g, " / ")}`);
  lines.push("");

  lines.push(`## Instruction files (${d.files.length})`);
  if (!d.files.length) lines.push("  none");
  for (const f of d.files) lines.push(`  ${f.file}: ${f.text.replace(/\n/g, " / ")}`);
  if (d.files.length && d.consumed) lines.push(`  (moved to ${basename(DONE_DIR)}/)`);

  if (d.notes.length) {
    lines.push("");
    lines.push("## Notes");
    for (const n of d.notes) lines.push(`  - ${n}`);
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  loadEnv();

  if (opts.record) {
    const state = readState();
    state.digestMessageId = opts.record;
    state.digestRecordedAt = new Date().toISOString();
    writeState(state);
    console.log(`Recorded digest message ${opts.record}`);
    if (opts.seed === null) return;
  }

  if (opts.seed !== null) {
    const state = readState();
    const target = opts.record ?? state.digestMessageId;
    if (!target) {
      console.error("No message to seed: pass --record <messageId> first, or seed a message id directly.");
      process.exit(1);
    }
    const emojis = seedSet(opts.seed);
    await withClient(async (client) => {
      const dm = await (await client.users.fetch(process.env.ADMIN_USER_ID as string)).createDM();
      const message = await dm.messages.fetch(target);
      // Sequential, not parallel: Discord draws the reactions in the order they were added,
      // and the order is half the documentation (proposals first, then the bulk verbs).
      for (const entry of emojis) {
        await message.react(entry.emoji);
      }
      console.log(`Seeded ${emojis.length} reactions on ${target}: ${emojis.map((e) => e.emoji).join(" ")}`);
    });
    return;
  }

  const state = readState();
  let readOk = false;
  const drain: Drained = {
    drainedAt: new Date().toISOString(),
    consumed: !opts.peek,
    digestMessageId: state.digestMessageId ?? null,
    votes: [],
    messages: [],
    files: drainFiles(!opts.peek),
    notes: [],
  };

  try {
    const dm = await withClient((client) => readDm(client, state, drain.digestMessageId));
    // Every field readDm returns must be copied out by hand. A forgotten one does not fail
    // loudly; it reports an empty channel forever, which is how the DM-text path silently
    // no-op'd once already.
    drain.votes = dm.votes;
    drain.messages = dm.messages;
    drain.notes.push(...dm.notes);
    readOk = true;
  } catch (err) {
    // A dead Discord must not cost the owner their file instructions, so this degrades.
    drain.notes.push(`Discord unreadable: ${(err as Error).message}`);
  }

  if (opts.json) {
    console.log(JSON.stringify(drain, null, 2));
  } else {
    console.log(renderText(drain));
  }

  if (!opts.peek) {
    const baseline: Record<string, number> = {};
    for (const v of drain.votes) baseline[v.emoji] = v.count;
    writeState({
      ...state,
      // Only move the watermark when Discord actually answered. Advancing it through an
      // outage would silently swallow every DM the owner sent while the bot was down.
      ...(readOk ? { drainedAt: drain.drainedAt } : {}),
      reactionBaseline: baseline,
    });
  }
}

main().catch((err) => {
  console.error("Inbox drain failed:", err);
  process.exit(1);
});
